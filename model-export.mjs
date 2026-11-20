import { mkdir, mkdtemp, readFile, writeFile, rename, appendFile, stat, lstat, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isTransientRead } from './direct-models.mjs';
import { loadNativeCatalog, withNativeDetails } from './native-content.mjs';
import { planPages, renderPage, indexes, auxiliary, backlinks, safeName } from './export-markdown.mjs';

async function exists(file) {
  try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function publishPages(staging, base, name) {
  for (let n=1; ; n++) {
    const target=path.join(base,n===1 ? name : `${name}_${n}`);
    if (await exists(target)) continue;
    try { await rename(staging,target); return target; }
    catch (error) {
      if (!['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes(error.code) || !await exists(target)) throw error;
    }
  }
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const sortedKey = s => [s.server,s.repository,s.model,s.modelId];
const maxConcurrentReads = 20;
export async function exportModel(selection, base, {
  signal: externalSignal, progress = () => {}, catalog = loadNativeCatalog, session = withNativeDetails, resume, waitForRetry = delay, concurrency = maxConcurrentReads,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maxConcurrentReads) throw new RangeError(`Počet súbežných čítaní musí byť 1 až ${maxConcurrentReads}.`);
  const stop = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, stop.signal]) : stop.signal;
  const check = () => signal?.throwIfAborted();
  check();
  progress({ phase:'index', current:'Načítavam úplný zoznam diagramov', done:0, total:0 });
  const index = await catalog(selection, { diagramsOnly:true, signal });
  if (!index.complete || index.modelId !== selection.modelId) throw new Error('Zoznam diagramov nie je úplný alebo sa zmenil model. Export sa nepublikoval.');
  await mkdir(base,{recursive:true});
  const run = resume ?? await mkdtemp(path.join(base,'.reader-export-'));
  const created = (await stat(run)).birthtime;
  const date = [created.getFullYear(), String(created.getMonth()+1).padStart(2,'0'), String(created.getDate()).padStart(2,'0')].join('-');
  const modelName = `${safeName(selection.model)}_${safeName(selection.repository)}_${date}`;
  const work=path.join(run, '.reader-work'), staging=path.join(work,'pages'), snapshot=path.join(work,'data');
  await mkdir(snapshot,{recursive:true});
  const pages=planPages(index.entries,path.join(staging,modelName));
  const fingerprint=createHash('sha256').update(JSON.stringify([1,sortedKey(selection),index.contextId,pages.map(p=>[p.id,p.name,p.type])])).digest('hex');
  const manifest=path.join(work,'manifest.json');
  if(resume && (await json(manifest)).fingerprint!==fingerprint) throw new Error('Model alebo zoznam diagramov sa zmenil. Spusť nový export.');
  if(!resume) await writeFile(manifest,JSON.stringify({fingerprint}),{flag:'wx'});
  const lookup=new Map(pages.map(p=>[p.id,p])), byName=Map.groupBy(pages,p=>p.name);
  const usage=new Map(), operations=new Map(), messages=new Map(), events=new Map(), others=new Map();
  const options={signal,exportMode:true,timeoutMs:30000,classCache:new Map()};
  const dataFile=p=>path.join(snapshot,`${p.id}.json`);
  const notify=(phase,current,done,total)=>progress({phase,current,done,total,run});
  let saved = 0;
  const readBatch = async (rows, phase, offset, total, consume) => {
    let cursor = 0, retries = 0;
    while (cursor < rows.length) {
      check();
      const report = () => notify(phase, rows[cursor].name + (retries ? ` · pokus ${retries+1}/11` : ''), phase==='read' ? saved : offset+cursor, total);
      report();
      try {
        await session(selection,index.contextId,async read=>{
          while (cursor < rows.length) {
            check(); report();
            await consume(rows[cursor], read);
            cursor++; retries = 0;
          }
        },options);
      } catch (error) {
        check();
        if (!isTransientRead(error.code) || cursor === rows.length || retries >= 10) {
          if (rows[cursor]) error.exportItem = rows[cursor].name;
          throw error;
        }
        retries++; report();
        await waitForRetry(Math.min(5000,500 * 2 ** (retries-1)),undefined,{signal});
      }
    }
  };
  const compact = d => ({attributes:d.attributes,relations:d.relations.filter(r=>lookup.has(r.item.id)),
    diagram:{uml:d.diagram.uml,symbols:d.diagram.symbols.map(s=>({id:s.id,target:s.target,
      fields:{Type:s.fields.Type,Text:s.fields.Text,Name:s.fields.Name,StepType:s.fields.StepType},
      relations:d.diagram.uml?[]:s.relations.filter(r=>d.diagram.symbols.some(x=>x.id===r.item.id))}))}});
  const missing=[];
  for (const p of pages) {
    check();
    if (resume && await exists(dataFile(p))) saved++; else missing.push(p);
  }
  let next=0;
  const batchSize=Math.max(1,Math.min(8,Math.ceil(missing.length/concurrency)));
  const worker=async()=>{
    try {
      while(next<missing.length) {
        check();
        const batch=missing.slice(next,next+batchSize);
        next+=batchSize;
        await readBatch(batch,'read',0,pages.length,async (p,read)=>{
        const detail=await read(p);
        check();
        if(!detail.diagram) throw new Error(`Chýba obsah diagramu ${p.name}.`);
        await writeFile(`${dataFile(p)}.tmp`,JSON.stringify(compact(detail)));
        await rename(`${dataFile(p)}.tmp`,dataFile(p));
        saved++;
        notify('read',p.name,saved,pages.length);
        });
      }
    } catch (error) { stop.abort(error); throw error; }
  };
  await Promise.allSettled(Array.from({length:Math.min(concurrency,missing.length)},worker));
  check();
  // Collect references in catalog order, independent of which worker finished first.
  for(const p of pages) {
      check();
      const {uml}= (await json(dataFile(p))).diagram;
      for(const c of uml?.classes??[]) for(const op of c.operations) if(!operations.has(op.id)) operations.set(op.id,p);
      if(uml?.unplacedCount)p.unplacedCount=uml.unplacedCount;
      for(const r of [...(uml?.rows??[]),...(uml?.unplaced??[])]) if(r.kind==='message' && r.target) {
        messages.set(r.target.id,r.target);
        if(!usage.has(r.target.id))usage.set(r.target.id,new Set());
        usage.get(r.target.id).add(p.id);
    }
  }
  const pending=[...messages.values()].filter(e=>!operations.has(e.id));
  for(let i=0;i<pending.length;i+=16) {
    check();
    await readBatch(pending.slice(i,i+16),'references',i,pending.length,async (e,read)=>{
        if(operations.has(e.id))return;
        const d=await read(e);
        if(e.nativeClass==='_Ent2_Event') events.set(e.id,{name:e.name,description:d.attributes.Description});
        else if(e.nativeClass==='_Ent2_Operation') {
          if(d.owners?.length!==1) throw new Error(`Nejednoznačná trieda operácie: ${e.name}`);
          const owner=d.owners[0], c=others.get(owner.id)??(await read(owner)).exportClass;
          if(!c.operations.some(op=>op.id===e.id))throw new Error(`Operácia sa nenašla na triede: ${e.name}`);
          others.set(owner.id,c);
          for(const op of c.operations)operations.set(op.id,{file:'Other classes.md'});
        } else throw new Error(`Nepodporovaný cieľ správy: ${e.type}`);
    });
  }
  const names=[...byName.keys()].filter(n=>n.length>=12).sort((a,b)=>b.length-a.length);
  const mentions=names.length?new RegExp(names.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g'):null;
  const ctx={selection,lookup,usage,operations,byName,mentions};
  const write=async(file,lines)=>{
    const target=path.join(staging,file);
    await mkdir(path.dirname(target),{recursive:true});
    await writeFile(target,lines.join('\n').replace(/\r\n?/g,'\n')+'\n','utf8');
  };
  await mkdir(staging,{recursive:true});
  for(const [i,p] of pages.entries()) {
    check();notify('write',p.name,i,pages.length);
    await write(p.file,renderPage(p,await json(dataFile(p)),ctx));
  }
  for(const p of pages) {
    check();
    const lines=backlinks(p,lookup);
    if(lines.length) await appendFile(path.join(staging,p.file),lines.join('\n')+'\n');
  }
  for(const [file,lines] of [...auxiliary(selection,events,others,usage,lookup),...indexes(selection,pages,events.size,others.size)]) await write(file,lines);
  check();
  const result=await publishPages(staging,base,modelName);
  await rm(work,{recursive:true});
  await rmdir(run);
  return {path:result,count:pages.length};
}

export class ExportJob {
  constructor(base, execute=exportModel, wait=delay) { this.base=base; this.execute=execute; this.wait=wait; this.state={phase:'idle'}; }
  start(reader,resume=false,base=this.base) {
    if(this.controller || !reader.selection?.modelId)
      throw Object.assign(new Error('Export vyžaduje otvorený model s identifikátorom a voľný exportér.'),{status:409});
    const selection={...reader.selection}, key=JSON.stringify(sortedKey(selection));
    const run=resume && this.key===key ? this.state.run : undefined;
    if(resume&&!run)throw Object.assign(new Error('Pre tento model nie je rozpracovaný export.'),{status:409});
    this.key=key;
    const controller=this.controller=new AbortController();
    const startedAt=Date.now(), elapsedMs=resume ? this.state.elapsedMs : 0;
    const duration=()=>elapsedMs+Math.max(0,Date.now()-startedAt);
    this.state={phase:'index',active:true,model:selection.model,run:run || undefined,startedAt,elapsedMs};
    const attempt=()=>this.execute(selection,this.state.run ? path.dirname(this.state.run) : base,{
      signal:controller.signal,resume:this.state.run,progress:p=>Object.assign(this.state,p)});
    this.finished=attempt().catch(async error=>{
      controller.signal.throwIfAborted();
      Object.assign(this.state,{phase:'retry',current:error.exportItem ?? this.state.current,error:error.message});
      await this.wait(10000,undefined,{signal:controller.signal});
      controller.signal.throwIfAborted();
      return attempt();
    }).then(result=>{
      this.state={phase:'complete',model:selection.model,...result,elapsedMs:duration()};
    }).catch(error=>{
      this.state={...this.state,current:error.exportItem ?? this.state.current,active:false,phase:controller.signal.aborted?'cancelled':'failed',error:error.message,elapsedMs:duration()};
    }).finally(()=>{this.controller=null;});
    return this.state;
  }
  cancel() { this.controller?.abort(new Error('Export bol zastavený.')); }
}
