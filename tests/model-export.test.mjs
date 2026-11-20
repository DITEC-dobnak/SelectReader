import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportModel, ExportJob } from '../model-export.mjs';
import { planPages } from '../export-markdown.mjs';

const selection={server:'mock', model:'Model',modelId:'m',repository:'Repo'};
const entries=['A','B'].map((name,i)=>({name,id:`d${i}`,type:'State Diagram'}));
const catalog=async(s,options)=>{
  assert.equal(options.diagramsOnly,true);
  return {complete:true,entries,modelId:s.modelId,contextId:'context'};
};
const detail=e=>({attributes:{Description:'Test'},relations:e.id==='d0'?[{item:entries[1]}]:[],
  diagram:{symbols:[{id:'one',fields:{Type:'SD::State',Name:'State'},relations:[]}]}});

test('local copy can start a server export without reopening the model',async ()=>{
  const reader={offline:true,selection};
  const job=new ExportJob('base',async target=>{
    assert.deepEqual(target,selection);
    return {count:2};
  });
  assert.throws(()=>job.start({offline:true,selection:{...selection,modelId:null}}),{status:409});
  job.start(reader);
  assert.throws(()=>job.start(reader),{status:409});
  await job.finished;
  assert.equal(job.state.phase,'complete');
  assert.equal(reader.offline,true);
});

test('job automatically resumes the same checkpoint once and remains stoppable during backoff',async ()=>{
  for(const outcome of ['success','fail','cancel']){
    const calls=[];
    const job=new ExportJob('base',async(_s,_b,{resume,progress})=>{
      calls.push(resume);
      progress({run:'base/run',current:'A',done:1,total:2});
      if(calls.length===1 || outcome==='fail')throw new Error('test failure');
      return {count:2};
    },async(ms,_value,{signal})=>{
      assert.equal(ms,10000);
      assert.equal(job.state.phase,'retry');
      assert.equal(job.state.active,true);
      if(outcome==='cancel'){job.cancel();signal.throwIfAborted();}
    });
    job.start({selection});await job.finished;
    assert.deepEqual(calls,outcome==='cancel'?[undefined]:[undefined,'base/run']);
    assert.equal(job.state.phase,{success:'complete',fail:'failed',cancel:'cancelled'}[outcome]);
  }
});

test('export clock excludes pauses, survives resume and resets for a new job',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  let finish;
  const job=new ExportJob('base',async(s,b,{progress,signal})=>{
    progress({run:'base/run'});
    await new Promise((ok,fail)=>{finish=ok;signal.addEventListener('abort',()=>fail(signal.reason));});
    return {count:1};
  });
  const reader={selection};
  assert.equal(job.start(reader).startedAt,10000);
  t.mock.timers.tick(2500); job.cancel(); await job.finished;
  assert.equal(job.state.elapsedMs,2500);
  t.mock.timers.tick(10000); assert.equal(job.start(reader,true).elapsedMs,2500);
  t.mock.timers.tick(1800); finish(); await job.finished;
  assert.equal(job.state.elapsedMs,4300);
  assert.equal(job.start(reader).elapsedMs,0);finish();await job.finished;
});

test('whole model uses fresh diagram list, publishes only on success and resumes completed reads',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'reader-export-test-'));
  t.after(()=>rm(base,{recursive:true}));
  let run;
  await assert.rejects(exportModel(selection,base,{catalog,concurrency:1,progress:p=>{if(p.run)run=p.run;},
    session:async(s,ctx,fn)=>fn(async e=>{if(e.id==='d1')throw Error('interrupted');return detail(e);})}),/interrupted/);
  assert.deepEqual(await readdir(run),['.reader-work']);
  const created=(await stat(run)).birthtime;
  const seen=[];
  const result=await exportModel(selection,base,{catalog,resume:run,session:async(s,ctx,fn)=>fn(async e=>{seen.push(e.id);return detail(e);})});
  const date=created.toLocaleDateString('sv-SE');
  assert.equal(result.path,path.join(base,`Model_Repo_${date}`));
  assert.deepEqual(await readdir(base),[path.basename(result.path)]);
  assert.deepEqual(seen,['d1']);
  const get=file=>readFile(path.join(result.path,file),'utf8');
  assert.match(await get('index.md'),/\[State Diagrams \(2\)\]\(<State Diagrams\/index.md>\)/);
  assert.match(await get('State Diagrams/B.md'),/## Referenced by\n\n- \[A\]\(<A.md>\)/);
  assert.match(await get('State Diagrams/A.md'),/```mermaid\nstateDiagram-v2/);
  assert.match(await get('Events.md'),/\| Event \| Description \| Used in \|/);
  assert.match(await get('Other classes.md'),/^# Other classes\n/);
  await assert.rejects(exportModel(selection,base,{catalog:async()=>({complete:false})}),/nie je úplný/);
  const repeat=()=>exportModel(selection,base,{catalog,session:async(s,ctx,fn)=>fn(detail)});
  const copies=await Promise.all([repeat(),repeat()]);
  assert.deepEqual(copies.map(r=>r.path).sort(),[`${result.path}_2`,`${result.path}_3`]);
  assert.deepEqual((await readdir(base)).sort(),[result,...copies].map(r=>path.basename(r.path)).sort());
});

test('page names protect indexes and handle case, reserved names, separators and collisions',()=>{
  const pages=planPages(['index','INDEX','Con','a/b','a:b'].map((name,i)=>({name,type:'Class Diagram',id:String(i)})),'C:\\out');
  const names=pages.map(p=>p.file.toLowerCase());
  assert.equal(new Set(names).size,5);
  assert.ok(names.includes('class diagrams/_con.md'));
  assert.ok(names.includes('class diagrams/a_b (2).md'));
  assert.ok(!names.includes('class diagrams/index.md'));
});

test('default export reads with up to twenty concurrent sessions',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'reader-export-workers-'));
  t.after(()=>rm(base,{recursive:true}));
  const pages=Array.from({length:161},(_,i)=>({id:`d${i}`,name:`Page ${i}`,type:'State Diagram'}));
  let active=0,peak=0;
  const result=await exportModel(selection,base,{
    catalog:async()=>({complete:true,entries:pages,modelId:selection.modelId,contextId:'context'}),
    session:async(_s,_ctx,fn)=>{
      peak=Math.max(peak,++active);
      try { await fn(async e=>detail(e)); } finally { active--; }
    }
  });
  assert.equal(peak,20);
  assert.equal(result.count,pages.length);
  await assert.rejects(exportModel(selection,base,{concurrency:21}),RangeError);
});

test('a reset reopens the session at the failed diagram; persistent resets stop after ten retries',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'reader-reconnect-'));
  t.after(()=>rm(base,{recursive:true}));
  for(const persistent of [false,true]) {
    const seen=[];
    let sessions=0;
    const work=exportModel(selection,base,{catalog,concurrency:1,waitForRetry:async()=>{},session:async(s,ctx,fn)=>{
      sessions++;
      await fn(async e=>{
        seen.push(e.id);
        if(e.id==='d1' && (persistent || sessions===1))throw Object.assign(Error('reset'),{code:'ECONNRESET'});
        return detail(e);
      });
    }});
    if(persistent)await assert.rejects(work,{code:'ECONNRESET'});else assert.equal((await work).count,2);
    assert.equal(sessions,persistent?11:2);
    assert.deepEqual(seen,['d0',...Array(sessions).fill('d1')]);
  }
});
