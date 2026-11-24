import path from 'node:path';

const types = ['Process Hierarchy', 'Process Thread', 'BPMN', 'BMM', 'Use Case', 'Class', 'Object Collaboration',
  'Object Sequence', 'Activity', 'State', 'Entity Relationships', 'Table Relationships', 'General Graphics', 'Text'];
export const folders = new Map(types.map(type => [`${type} Diagram`, `${type === 'BMM' ? 'Business Motivation' : type} Diagrams`]));
export function safeName(name) {
  const value = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '') || '_';
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value) ? `_${value}` : value;
}
export function planPages(entries, root) {
  const used = new Set(), pages = [];
  for (const entry of [...entries].sort((a,b) => a.name.localeCompare(b.name, 'sk') || a.id.localeCompare(b.id))) {
    const folder = folders.get(entry.type) ?? `${safeName(entry.type)}s`;
    const limit = Math.min(180, 240 - path.join(root, folder, 'x.md').length);
    if (limit < 12) throw new Error('Výstupná cesta je príliš dlhá.');
    let file;
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? '' : ` (${n})`;
      file = `${folder}/${safeName(entry.name).slice(0, limit - suffix.length).replace(/[. ]+$/, '')}${suffix}.md`;
      if (!file.toLowerCase().endsWith('/index.md') && !used.has(file.toLowerCase())) break;
    }
    used.add(file.toLowerCase());
    pages.push({ ...entry, folder, file, refs: new Set(), back: new Set() });
  }
  return pages;
}
const escape = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const md = s => escape(s).replace(/([\\[\]*_`])/g,'\\$1');
const cell = s => escape(s).trim().replaceAll('|','\\|').replace(/\r\n?|\n/g,'<br>');
const mm = s => String(s ?? '').replace(/[\r\n]/g,' ').replace(/[^ \p{L}\p{N}.,:_-]/gu, c=>`#${c.codePointAt(0)};`);
const signature = o => `${o.name}(${o.parameters.length ? ` ${o.parameters.join(', ')} ` : ''})${o.type ? ` : ${o.type}` : ''}`;
const stereotypes = c => [c.stereotype,...(c.custom ?? [])].filter(Boolean);
const member = s => s.replace(/\r\n?|\n/g,' ').trim().replace(/[#{}()[\]~$*"%<>;]/g,ch=>`#${ch.charCodeAt(0)};`);
export function displayedClasses(classes) {
  const counts=new Map(), distinct=new Map();
  for(const c of classes) {
    counts.set(c.namespace,(counts.get(c.namespace)??0)+1);
    if(!distinct.has(c.target.id))distinct.set(c.target.id,c);
  }
  const home=[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];
  return [...distinct.values()].map(c=>({...c,display:c.namespace && c.namespace!==(c.home||home) ?
    `${c.namespace.replaceAll('::','.')}.${c.name}` : c.name}));
}
export function operationAnchors(classes) {
  const part=(s,max)=>s.normalize('NFD').replace(/\p{Mn}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-')
    .replace(/^-|-$/g,'').slice(0,max).replace(/-$/,'')||'x';
  const anchors=new Map(),used=new Set();
  for(const c of classes)for(const o of c.operations){
    const base=`op-${part(c.display??c.name,45)}-${part(o.name,50)}`;
    let id=base;
    for(let i=2;used.has(id);i++)id=`${base}-${i}`;
    used.add(id);anchors.set(o.id,id);
  }
  return anchors;
}
function numberedRows(rows,symbols) {
  const steps=new Map(symbols.map(s=>[s.id,String(s.fields.StepType)]));
  const levels=[{prefix:'',counter:0,depth:0}],placed=new Map();
  return rows.map(r=>{
    if(r.kind!=='note')return {...r,depth:placed.get(r.stepId)??r.depth};
    const level=levels[r.depth],type=steps.get(r.id);
    const branch=type==='4', end=['2','5','7'].includes(type);
    const number=branch||end?'':`${level.prefix}${++level.counter}`;
    const depth=number?level.depth:Math.max(0,level.depth-1);
    levels[r.depth+1]=branch?level:{prefix:number?`${number}.`:level.prefix,counter:0,depth:depth+1};
    placed.set(r.id,depth);
    return {...r,depth,number};
  });
}
const meta = s => [`- Model: ${md(s.model)}`, `- Repository: ${md(s.repository)}`];
const anchor = (type,id) => `${type}-${id}`;
function link(from, file, label, fragment = '') {
  const relative = path.posix.relative(path.posix.dirname(from),file).replace(/[%#<>]/g,encodeURIComponent);
  return `[${md(label)}](<${relative}${fragment ? `#${fragment}` : ''}>)`;
}
export function indexes(selection, pages, eventCount, otherCount) {
  const result = new Map(), root = [`# ${md(selection.model)}`, '', ...meta(selection), `- Diagrams: ${pages.length}`, ''];
  for (const folder of new Set([...folders.values(), ...pages.map(p=>p.folder)])) {
    const entries = pages.filter(p=>p.folder === folder), file = `${folder}/index.md`;
    root.push(`- ${entries.length ? link('index.md',file,`${folder} (${entries.length})`) : `${folder} (0)`}`);
    if (entries.length) result.set(file,[`# ${folder}`, '', ...meta(selection), `- Diagrams: ${entries.length}`, '',
      link(file,'index.md','All diagram types'), '', ...entries.map(p=>`- ${link(file,p.file,p.name)}`)]);
  }
  root.push('', `- ${link('index.md','Events.md',`Events (${eventCount})`)}`, `- ${link('index.md','Other classes.md',`Other classes (${otherCount})`)}`);
  const warnings=pages.filter(p=>p.unplacedCount);
  if(warnings.length)root.push('','## Upozornenia – kroky bez overeného poradia','',
    ...warnings.map(p=>`- ${link('index.md',p.file,p.name)}: ${p.unplacedCount}`));
  result.set('index.md',root);
  return result;
}

export function classSection(lines,c,from,usage,lookup,anchors) {
  lines.push('', `### ${md(c.display??c.name)}`, '');
  const tags=stereotypes(c);
  if(tags.length) lines.push(`- Stereotypes: ${tags.map(t=>`«${md(t)}»`).join(' ')}`);
  if(c.namespace) lines.push(`- Package: ${md(c.namespace)}`);
  if(c.description) lines.push(`- Description: ${cell(c.description)}`);
  lines.push('');
  if(c.attributes.length) {
    lines.push('| Attribute | Type | Optional | Default | Description |','|---|---|---|---|---|');
    for(const a of c.attributes) lines.push(`| ${cell(a.name)} | ${cell(a.type)} | ${a.optional?'yes':''} | ${cell(a.defaultValue || a.initial)} | ${cell(a.description)} |`);
  } else lines.push('No attributes.');
  if(c.operations.length) {
    lines.push('','| Operation | Description | Used in |','|---|---|---|');
    for(const o of c.operations) lines.push(`| <a id="${anchors.get(o.id)}" class="code-line" data-line="${lines.length}"></a>${cell(signature(o))} | ${cell(o.description)} | ${usedIn(from,usage.get(o.id),lookup)} |`);
  }
}
function usedIn(from,ids,lookup) { return [...(ids ?? [])].map(id=>lookup.get(id)).map(p=>link(from,p.file,p.name)).join(', '); }
export function auxiliary(selection,events,others,usage,lookup) {
  const ev=['# Events','',...meta(selection),`- Events: ${events.size} (raised by event messages in sequence diagrams)`,'',link('Events.md','index.md','All diagram types'),'','| Event | Description | Used in |','|---|---|---|'];
  for(const [id,e] of events) ev.push(`| <a id="${anchor('event',id)}" class="code-line" data-line="${ev.length}"></a>${cell(e.name)} | ${cell(e.description)} | ${usedIn('Events.md',usage.get(id),lookup)} |`);
  const oc=['# Other classes','',...meta(selection),`- Classes: ${others.size} (their operations are called in sequence diagrams, but they appear on no class diagram)`,'',link('Other classes.md','index.md','All diagram types')];
  const anchors=operationAnchors(others.values());
  for(const c of others.values()) classSection(oc,c,'Other classes.md',usage,lookup,anchors);
  return new Map([['Events.md',ev],['Other classes.md',oc]]);
}
export function renderPage(p,d,ctx) {
  const {selection,lookup,usage,operations,byName,mentions} = ctx;
  const ref = (target,label=target.name,fragment='') => {
    if(target.id && target.id !== p.id) { p.refs.add(target.id); target.back.add(p.id); }
    return link(p.file,target.file,label,fragment);
  };
  const mention = value => {
    const s=String(value ?? ''); let out='', last=0;
    if(mentions) for(const m of s.matchAll(mentions)) {
      const candidates=byName.get(m[0]).filter(v=>v.id!==p.id);
      const t=candidates.find(v=>v.folder===p.folder)??candidates[0];
      out+=md(s.slice(last,m.index))+(t?ref(t,m[0]):md(m[0]));last=m.index+m[0].length;
    }
    return out+md(s.slice(last));
  };
  const u=d.diagram.uml,symbols=d.diagram.symbols;
  const lines=[`# ${md(p.name)}`,'',...meta(selection)];
  if(u?.kind==='sequence') {
    if(u.participants.length) lines.push(`- Participants: ${u.participants.map(a=>md(a.systemBoundary?'Systém':a.name)).join(', ')}`);
    lines.push(`- Statements: ${u.stepCount}, messages: ${u.messageCount}`);
  } else lines.push(`- Type: ${p.type}`);
  for(const key of ['Description','Notes','Documentation','PreConditions','PostConditions']) if(d.attributes[key]?.trim())
    lines.push('',`## ${key.replace('Conditions',' Conditions')}`,'',mention(d.attributes[key]));
  if(u?.kind==='class') {
    const classes=displayedClasses(u.classes), anchors=operationAnchors(classes);
    const nodes=new Map(classes.map((c,i)=>[c.target.id,{...c,node:`n${i+1}`}]));
    const sections=new Map(),code=['classDiagram'];
    const add=(group,text)=>{
      if(!sections.has(group))sections.set(group,new Set());
      sections.get(group).add(text);
    };
    for(const c of nodes.values()) {
      add('Classes',md(c.display));
      const tags=stereotypes(c),body=[];
      if(tags.length)body.push(`<<${member(tags.join(', '))}>>`);
      for(const a of c.attributes) {
        const value=a.defaultValue||a.initial;
        body.push(member(`${a.name}${a.type?` : ${a.type}`:''}${value?` = ${value}`:''}${a.optional?' {optional}':''}`));
      }
      code.push(`    class ${c.node}["${mm(c.display)}"]${body.length?' {':''}`);
      if(body.length)code.push(...body.map(s=>`        ${s}`),'    }');
    }
    const symbolClasses=new Map(u.classes.map(c=>[c.id,c.target.id]));
    const edges=new Map(u.edges.map(e=>[e.id,e]));
    for(const s of symbols) {
      if(s.fields.Type==='CD::Package' && s.target)add('Packages',md(s.target.name));
      const e=edges.get(s.id);
      if(!e)continue;
      const ends=e.ends?.map(r=>r.classId)??e.symbolIds.map(id=>symbolClasses.get(id));
      const group={generalization:'Generalizations',dependency:'Dependencies',association:'Associations'}[e.type];
      if(ends.length!==2||ends.some(id=>!nodes.has(id))) {add(group,`${md(e.label||s.fields.Type)} (ends not available)`);continue;}
      const [a,b]=ends.map(id=>nodes.get(id));
      const arrow={generalization:'▷',dependency:'⇢',association:'—'}[e.type];
      add(group,`${md(a.display)} ${arrow} ${md(b.display)}${e.label?`: ${md(e.label)}`:''}`);
      code.push(e.ends ? `    ${a.node} "${mm(e.ends[0].multiplicity)}" -- "${mm(e.ends[1].multiplicity)}" ${b.node}${e.label?` : ${mm(e.label)}`:''}` :
        e.type==='generalization'?`    ${b.node} <|-- ${a.node}`:`    ${a.node} ..> ${b.node}`);
    }
    if(sections.size)lines.push('','## Elements');
    for(const [group,items] of sections)lines.push('',`### ${group}`,'',...[...items].map(item=>`- ${item}`));
    if(classes.length)lines.push('','## Classes');
    for(const c of classes) classSection(lines,c,p.file,usage,lookup,anchors);
    if(u.notes?.length)lines.push('','## Notes','',...u.notes.filter(n=>n.text?.trim()).map(n=>`- ${mention(n.text.trim())}`));
    if(classes.length)lines.push('','## Diagram','','```mermaid',...code,'```');
  } else if(u?.kind==='sequence') {
    lines.push('','## Specification','');
    const code=['sequenceDiagram'];
    for(const a of u.participants) code.push(`  participant p${a.id} as ${mm(a.systemBoundary?'Systém':a.name)}`);
    if(u.unplacedCount) lines.push(`> Upozornenie: ${u.unplacedCount} z ${u.stepCount} krokov nemá overené poradie. Sú uvedené samostatne a nie sú zakreslené v časovej osi.`, '');
    for(const r of [...numberedRows(u.rows,symbols),...(u.unplaced??[])]) {
      if(r===u.unplaced?.[0])lines.push('','### Kroky bez overeného poradia','');
      const indent='  '.repeat(r.depth??0);
      if(r.kind==='note') lines.push(`${indent}- ${r.number?`${r.number} `:''}${mention(r.text).replace(/\r?\n/g,`\n${indent}  `)}`);
      else if(r.kind==='probe') {
        const targets=byName.get(r.target?.name)?.filter(t=>t.type==='Object Sequence Diagram')??[];
        lines.push(`${indent}  - → OSD: ${targets.length?targets.map(t=>ref(t)).join(', '):md(r.target?.name??r.label)}`);
      } else {
        const target=r.event?{file:'Events.md'}:operations.get(r.target?.id);
        lines.push(`${indent}  - → ${r.event?'Event':'Operation'}: ${target && r.target ? ref(target,r.target.name,r.event?anchor('event',r.target.id):target.fragment):md(r.label)}`);
        if(r.depth!==undefined)code.push(`  p${r.source}${r.event?'--)':'->>'}p${r.destination}: ${mm(r.label)}`);
      }
    }
    lines.push('','## Sequence diagram','','```mermaid',...code,'```');
  } else {
    lines.push('','## Elements');
    const groups=Map.groupBy(symbols,s=>s.fields.Type??'Other symbols');
    for(const [type,items] of groups) {
      lines.push('',`### ${md(type)}`,'');
      for(const s of items) {
        const name=s.target?.name||s.fields.Text||s.fields.Name||type;
        const target=byName.get(name)?.find(t=>t.id!==p.id);
        lines.push(`- ${target?ref(target):md(name)}`);
      }
    }
    const graph=genericGraph(p.type,symbols);
    if(graph) lines.push('','## Diagram','','```mermaid',...graph,'```');
  }
  const notes=symbols.filter(s=>s.fields.Type==='Note'&&s.fields.Text);
  if(notes.length && u?.kind!=='class') lines.push('','## Notes','',...notes.map(n=>`- ${mention(n.fields.Text)}`));
  const related=d.relations.map(r=>lookup.get(r.item.id)).filter(t=>t&&t.id!==p.id);
  if(related.length) lines.push('','## Related diagrams','',...[...new Set(related)].map(t=>`- ${ref(t)}`));
  return lines;
}
function genericGraph(type,symbols) {
  const kind=({'State Diagram':'stateDiagram-v2','Use Case Diagram':'flowchart LR','BPMN Diagram':'flowchart LR','Table Relationships Diagram':'erDiagram'})[type];
  if(!kind)return null;
  const nodes=symbols.filter(s=>/^(?:SD::.*State|UCD::(?:Actor|Use Case)|BPMN::(?:.*Event|Task|Gateway|Subprocess)|TRD::Table)$/i.test(s.fields.Type));
  const ids=new Set(nodes.map(n=>n.id)), code=[kind];
  for(const n of nodes) {
    const name=mm(n.target?.name??n.fields.Name);
    code.push(kind==='stateDiagram-v2'?`  state "${name}" as n${n.id}`:kind==='erDiagram'?`  n${n.id}["${name}"] {`:`  n${n.id}["${name}"]`);
    if(kind==='erDiagram')code.push('  }');
  }
  for(const s of symbols) {
    const ends=s.relations.filter(r=>ids.has(r.item.id));
    const start=ends.find(r=>/_To_(Start|Source|Using|Including|Extending|UCDActor)/i.test(r.role));
    const end=ends.find(r=>/_To_(End|Target|Used|Included|Extended|UCDUseCase)/i.test(r.role));
    if(start&&end&&kind!=='erDiagram')code.push(`  n${start.item.id} --> n${end.item.id}`);
  }
  return nodes.length?code:null;
}
export function backlinks(p,lookup) {
  return p.back.size?['','## Referenced by','',...[...p.back].map(id=>lookup.get(id)).sort((a,b)=>a.name.localeCompare(b.name)).map(t=>`- ${link(p.file,t.file,t.name)}`)]:[];
}
