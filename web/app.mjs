import { Diagram } from './diagram.mjs';
import { descriptionText } from './uml.mjs';

const $ = id => document.getElementById(id);
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = (localStorage.getItem('select-reader:theme') ?? (systemTheme.matches ? 'dark' : 'light')) === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-toggle').setAttribute('aria-pressed', String(dark));
}
$('theme-toggle').addEventListener('click', () => {
  localStorage.setItem('select-reader:theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  applyTheme();
});
systemTheme.addEventListener('change', applyTheme);
applyTheme();
  function setupDivider(id, paneId, variable, direction, scope=document.documentElement, suffix='') {
    const divider = $(id), pane = $(paneId);
    const bottom = () => divider.getAttribute('aria-orientation') === 'horizontal';
    const sizeVar = () => bottom() ? '--inspector-height' : variable;
    const key = name => `select-reader:${name}${suffix}`;
    for (const name of direction === 1 ? [variable] : [variable,'--inspector-height']) {
      const saved = Number(localStorage.getItem(key(name)));
      if (Number.isFinite(saved) && saved > 0) scope.style.setProperty(name,`${saved}px`);
    }
    const setWidth = width => scope.style.setProperty(sizeVar(), `${width}px`);
    const width = () => Math.round(pane.getBoundingClientRect()[bottom()?'height':'width']);
    const coordinate = event => bottom() ? event.clientY : event.clientX;
    const resize = next => {
      setWidth(Math.max(1,next));
      setWidth(width()); // Use the responsive CSS limits, including after a viewport resize.
    };
    new ResizeObserver(() => {
      const w=width(), available=divider.parentElement[bottom()?'clientHeight':'clientWidth'];
      if (!w) return;
      divider.setAttribute('aria-valuemin', String(direction===1 ? 180 : Math.round(Math.min(bottom()?100:160,available*.45))));
      divider.setAttribute('aria-valuemax', String(Math.round(available*(direction===1 ? .55 : .65))));
      divider.setAttribute('aria-valuenow',String(w));
      divider.setAttribute('aria-valuetext',`${w} px`);
    }).observe(pane);
    let drag;
    divider.addEventListener('pointerdown', e => {
      if (e.button!==0 || !e.isPrimary) return;
      drag={id:e.pointerId,x:coordinate(e),width:width()};
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    divider.addEventListener('pointermove', e => {
      if (drag?.id===e.pointerId) resize(drag.width+direction*(coordinate(e)-drag.x));
    });
    divider.addEventListener('lostpointercapture', () => {
      if (drag) localStorage.setItem(key(sizeVar()),String(width()));
      drag=null;
    });
    divider.addEventListener('keydown', e => {
      const keys=bottom()?['ArrowUp','ArrowDown']:['ArrowLeft','ArrowRight'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      resize(width() + direction*(e.key===keys[0] ? -16 : 16));
      localStorage.setItem(key(sizeVar()),String(width()));
    });
  }
  setupDivider('catalog-divider','catalog','--catalog-width',1);
function collapseCatalog(collapsed) {
  $('catalog').classList.toggle('collapsed', collapsed);
  const toggle = $('catalog-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.title = collapsed ? 'Rozbaliť katalóg' : 'Zbaliť katalóg';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.textContent = collapsed ? '»' : '«';
}
$('catalog-toggle').addEventListener('click', () => collapseCatalog(!$('catalog').classList.contains('collapsed')));
function setText(id, value) {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
}
// Drag-selecting a button label must not activate the button on release.
let press;
document.addEventListener('pointerdown', event => { press = [event.clientX, event.clientY]; }, true);
document.addEventListener('click', event => {
  const selection = document.getSelection();
  if (press && event.detail && event.target.closest('button, summary, a') &&
      Math.hypot(event.clientX - press[0], event.clientY - press[1]) > 3 && !selection.isCollapsed) {
    event.preventDefault();
    event.stopPropagation();
  }
  press = null;
}, true);
const defaultDiagramType = 'Object Sequence Diagram';
let state = null, kind = 'diagrams', preferredType = defaultDiagramType, selectedId = null, selectedEntry = null;
let repositories = [], discoveredServer = '', searchSequence = 0, detailSequence = 0, favoriteOnly = false;
let items = [], favorites = new Set(), pollTimer, searchTimer;
let preparedAuthentication = null, authenticationGeneration = 0, authenticationBusy = false;
let windowsConnectionBusy = false;
let modelListGeneration = 0;
let modelChoices = [];
const diagramTrail = [];
const diagramTabs = new Map();
const mainStage = $('diagram').parentElement;
const inspectors = new Map();
const sqdLinks = new WeakMap();
let linksGeneration = 0;
function setupInspector(stage, number) {
  const suffix = number === 1 ? '' : `-${number}`;
  if (suffix) {
    for (const id of ['inspector-divider','class-inspector']) {
      const copy = $(id).cloneNode(true);
      for (const node of [copy,...copy.querySelectorAll('[id]')]) node.id += suffix;
      stage.append(copy);
    }
  }
  const elements = Object.fromEntries(['class-inspector','inspector-fields','inspector-name','inspector-divider','close-inspector']
    .map(id => { const el=$(id+suffix); el.classList.add(id); return [id,el]; }));
  elements['inspector-divider'].setAttribute('aria-controls',elements['class-inspector'].id);
  const dock = stage.querySelector('.dock-inspector'), divider = elements['inspector-divider'];
  const dockKey = `select-reader:inspector-dock${suffix}`;
  const visibilityKey = `select-reader:inspector-visibility${suffix}`;
  const place = bottom => {
    stage.dataset.dock = bottom ? 'bottom' : 'right';
    for (const button of dock.querySelectorAll('button'))
      button.setAttribute('aria-pressed',String(button.dataset.position===stage.dataset.dock));
    divider.setAttribute('aria-orientation',bottom?'horizontal':'vertical');
    const label = bottom ? 'Výška detailu' : 'Šírka detailu';
    divider.setAttribute('aria-label',label);
    divider.title = `${label}: potiahni alebo použi šípky`;
  };
  place(localStorage.getItem(dockKey)==='bottom');
  for (const button of dock.querySelectorAll('button')) button.addEventListener('click',()=>{
    place(button.dataset.position==='bottom');
    localStorage.setItem(dockKey,stage.dataset.dock);
    localStorage.setItem(visibilityKey,'open');
  });
  setupDivider(elements['inspector-divider'].id,elements['class-inspector'].id,'--inspector-width',-1,stage,suffix);
  elements['close-inspector'].addEventListener('click',()=>{
    localStorage.setItem(visibilityKey,'closed');
    closeInspector(stage);
  });
  inspectors.set(stage,{aside:elements['class-inspector'],panel:elements['inspector-fields'],name:elements['inspector-name'],sequence:0,element:null,visibilityKey});
  stage.querySelector('.inspector-back').addEventListener('click',()=>{
    const previous=inspectors.get(stage).element?.previous;
    if(previous)inspectDiagramElement(previous.id,previous.link,stage,null,true,previous);
  });
}
setupInspector(mainStage,1);
const diagram = new Diagram($('diagram'), $('diagram-notice'), (id, link) => {
  if (['sequence', 'class'].includes(diagram.data?.uml?.kind))
    return inspectDiagramElement(link === 'callers' ? selectedId : id, link);
  return openLinkedDetail(id);
});
let dragEntry = null;
let dropTarget = null;
function setDropTarget(root) {
  if (root === dropTarget) return;
  dropTarget?.classList.remove('diagram-drop-target');
  dropTarget = root;
  root?.classList.add('diagram-drop-target');
}
const loadingClocks = new Map();
function startLoading(element, label='Načítavam diagram…') {
  const timer = element.querySelector('[role=timer]');
  element.querySelector('.loading-label').textContent = label;
  timer.textContent = formatElapsed(0);
  loadingClocks.set(element,{timer,start:performance.now()});
  element.hidden = false;
}
function stopLoading(element) {
  loadingClocks.delete(element);
  element.hidden = true;
}
const extraPanes = [2,3,4].map(createPane);
function createPane(number) {
  const root = $('compare-template').content.firstElementChild.cloneNode(true);
  $('diagram-pair').append(root);
  root.setAttribute('aria-label',`Okno ${number}`);
  const find = selector => root.querySelector(selector);
  const stage = find('.diagram-stage'), bar = find('.window-tabs'), notice = find('.diagram-notice');
  const heading = find('.pane-heading'), favorite = find('[data-command=favorite]'), refresh = find('[data-command=refresh]');
  const loading = $('detail-loading').cloneNode(true);
  loading.removeAttribute('id');
  stage.append(loading);
  stage.id = `pane-content-${number}`;
  setupInspector(stage,number);
  bar.setAttribute('aria-label',`Karty okna ${number}`);
  const tabs = new Map();
  let active = null, version = 0;
  const inspect = (id,link) => inspectDiagramElement(link === 'callers' ? active : id,link,stage);
  const view = new Diagram(find('.diagram'),notice,inspect);
  const search = find('input[type=search]'), matches = find('.pane-matches');
  setupDiagramSearch(view,search,matches);
  search.addEventListener('input', () => {
    if (tabs.has(active)) tabs.get(active).query = search.value;
    updateDiagramSearch(view,search,matches);
  });
  const showFavorite = () => {
    favorite.textContent = favorites.has(active) ? '★' : '☆';
    favorite.setAttribute('aria-pressed',String(favorites.has(active)));
  };
  function draw() {
    drawTabs(bar,tabs,active,open,close,stage.id);
    heading.hidden = find('.diagram-toolbar').hidden = !active;
    if (!active) notice.textContent = '';
    refresh.hidden = !!state?.offline && !state.selection?.modelId;
    showFavorite();
  }
  function clearView() {
    inspectors.get(stage).diagramResult = null;
    closeInspector(stage);
    clearTimeout(view.pendingTextClick);
    view.clearLabels();
    view.matches = [];
    view.matchIndex = -1;
    for (const button of root.querySelectorAll('[data-search-direction]')) button.disabled = true;
    view.data = view.box = view.initial = null;
    view.svg.replaceChildren();
    view.svg.removeAttribute('viewBox');
  }
  function reset() { ++version; stopLoading(loading); tabs.clear(); active=null; clearView(); draw(); }
  function close(id) {
    const ids=[...tabs.keys()], i=ids.indexOf(id);
    tabs.delete(id);
    if(id!==active) { draw(); return; }
    const next=tabs.get(ids[i+1] ?? ids[i-1]);
    if(next) open(next.entry); else reset();
  }
  async function open(entry, fresh=false) {
    if (active===entry.id && view.data && !fresh) return;
    if (tabs.has(active) && view.box) {
      tabs.get(active).box=[...view.box];
      tabs.get(active).inspector=inspectors.get(stage).element;
    }
    const seq=++version;
    active=entry.id;
    const tab=tabs.get(active) ?? {entry};
    tabs.set(active,tab);
    clearView(); draw();
    search.value = tab.query ?? '';
    matches.textContent = '';
    renderTypeLabel(find('[data-pane-type]'),entry.type);
    find('.pane-name').textContent=entry.name;
    notice.textContent='';
    startLoading(loading);
    refresh.disabled=true;
    try {
      if (fresh || !tab.request) tab.request=(!fresh && diagramTabs.get(entry.id)?.request) ||
        api(`/api/item/${encodeURIComponent(entry.id)}${fresh?'?refresh=1':''}`);
      const result=await tab.request;
      const {detail}=result;
      if (seq!==version) return;
      if (!detail.diagram) throw new Error('Pre tento prvok nie je dostupný diagram.');
      view.render(detail.diagram);
      restoreDiagramInspector(tab,result,stage);
      updateDiagramSearch(view,search,matches);
      if (tab.box) {view.box=[...tab.box];view.update();}
      for (const marker of view.svg.querySelectorAll('marker[id]')) {
        const old=marker.id;
        marker.id=`pane-${number}-${old}`;
        for(const edge of view.svg.querySelectorAll(`[marker-end="url(#${old})"]`)) edge.setAttribute('marker-end',`url(#${marker.id})`);
      }
    } catch(error) {
      if (seq===version) {tab.request=null; notice.textContent=`Diagram sa nepodarilo načítať: ${error.message}`;}
    } finally { if(seq===version) { stopLoading(loading); refresh.disabled=false; } }
  }
  find('.pane-name').onclick=()=>inspect(active,tabs.get(active).entry.type==='Object Sequence Diagram'?'callers':'diagram');
  refresh.onclick=()=>open(tabs.get(active).entry,true);
  favorite.onclick=()=>toggleFavorite(active);
  find('[data-command=in]').onclick=()=>view.zoom(1/1.25);
  find('[data-command=out]').onclick=()=>view.zoom(1.25);
  find('[data-command=fit]').onclick=()=>view.fit();
  bindDrop(root,tabs,open);
  draw();
  return {root,view,reset,showFavorite};
}
function setLayout(count) {
  $('diagram-pair').dataset.count=String(count);
  extraPanes.forEach(({root},i)=>{root.hidden=i+2>count;});
  const radio=document.querySelector(`input[name=pane-count][value="${count}"]`);
  radio.checked=true;
}
const settings=$('layout-settings');
settings.addEventListener('change',event=>{
  setLayout(Number(event.target.value));
  localStorage.setItem('select-reader:pane-count',event.target.value);
  settings.open=false; settings.querySelector('summary').focus();
});
document.addEventListener('pointerdown',event=>{ if (!settings.contains(event.target)) settings.open=false; });
settings.addEventListener('keydown',event=>{if(event.key==='Escape'){settings.open=false;settings.querySelector('summary').focus();}});
const savedCount=Number(localStorage.getItem('select-reader:pane-count'));
setLayout([2,4].includes(savedCount)?savedCount:1);
function setupSplitDivider(axis) {
  const grid=$('diagram-pair'), handle=$(`split-${axis}`), key=`select-reader:split-${axis}`;
  const horizontal=axis==='x', position=horizontal?'clientX':'clientY', size=horizontal?'width':'height';
  const stored=Number(localStorage.getItem(key));
  let ratio, drag;
  const set=value=>{
    ratio=Math.max(15,Math.min(85,value));
    grid.style.setProperty(`--split-${axis}`,`${ratio}%`);
    handle.setAttribute('aria-valuenow',String(Math.round(ratio)));
    handle.setAttribute('aria-valuetext',`${Math.round(ratio)} %`);
  };
  handle.setAttribute('aria-valuemin','15');
  handle.setAttribute('aria-valuemax','85');
  set(stored>=15 && stored<=85 ? stored : 50);
  for (const grip of [handle,$('split-center')]) bindDrag(grip);
  function bindDrag(grip) {
    grip.addEventListener('pointerdown',e=>{
    if (e.button!==0 || !e.isPrimary) return;
    drag={id:e.pointerId,start:e[position],ratio,size:grid.getBoundingClientRect()[size]};
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
    grip.addEventListener('pointermove',e=>{
    if (drag?.id===e.pointerId) set(drag.ratio+100*(e[position]-drag.start)/drag.size);
  });
    grip.addEventListener('lostpointercapture',()=>{
    if (drag) localStorage.setItem(key,String(ratio));
    drag=null;
  });
  }
  handle.addEventListener('keydown',e=>{
    const keys=horizontal?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    set(ratio+(e.key===keys[0]?-2:2));
    localStorage.setItem(key,String(ratio));
  });
}
setupSplitDivider('x');
setupSplitDivider('y');
function bindDrop(root,tabs,open) {
  const hover = e=>{
    if (!dragEntry || dragEntry.source?.root === root) return;
    e.preventDefault();
    e.dataTransfer.dropEffect=dragEntry.source?'move':'copy';
    setDropTarget(root);
  };
  root.addEventListener('dragenter',hover);
  root.addEventListener('dragover',hover);
  root.addEventListener('dragleave',e=>{
    if (dropTarget===root && !root.contains(e.relatedTarget)) setDropTarget(null);
  });
  root.addEventListener('drop',e=>{
    if (!dragEntry) return;
    e.preventDefault();
    const {entry,source} = dragEntry;
    clearDiagramDrag();
    if (source?.root === root) return;
    if (source && !tabs.has(entry.id)) {
      const tab = {...source.tab};
      if (source.active) {
        const view = source.root === $('main-pane') ? diagram : extraPanes.find(p=>p.root===source.root).view;
        if (view.box) tab.box = [...view.box];
        tab.query = source.root.querySelector('.diagram-toolbar input[type=search]').value;
        tab.inspector = inspectors.get(view.container.parentElement).element;
      }
      tabs.set(entry.id,tab);
    }
    open(entry);
    if (source) {
      source.close(entry.id);
      root.querySelector('[role=tab][aria-selected=true]')?.focus();
    }
  });
}
bindDrop($('main-pane'),diagramTabs,entry=>openDetail(entry.id,entry));
function clearDiagramDrag() {
  dragEntry = null;
  setDropTarget(null);
}
function dragToCompare(button, entry, source=null) {
  button.draggable = true;
  button.addEventListener('dragstart', event => {
    dragEntry = {entry,source};
    event.dataTransfer.setData('text/plain',entry.name);
    event.dataTransfer.effectAllowed = source ? 'move' : 'copy';
  });
  button.addEventListener('dragend',clearDiagramDrag);
}

async function api(url, data) {
  const response = await fetch(url, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

function showError(error, target = 'error') {
  $(target).textContent = error.message;
  $(target).hidden = false;
}

function handle(action, target = 'error') {
  return async event => {
    $(target).hidden = true;
    try { await action(event); } catch (error) { showError(error, target); }
  };
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString('sk-SK') : '';
}

function favoriteKey() { return `select-reader:favorites:${JSON.stringify(state?.selection)}`; }
function loadFavorites() {
  const stored = localStorage.getItem(favoriteKey());
  const values = stored ? JSON.parse(stored) : [];
  if (!Array.isArray(values)) throw new Error('Lokálny zoznam obľúbených má neplatný formát.');
  favorites = new Set(values);
}

const viewId = crypto.randomUUID();
let leaving = false;
let exportActive = false, exportStarting = false;
window.addEventListener('beforeunload', event => {
  if (!state?.desktop || !(exportActive || exportStarting) || leaving) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('pagehide', event => {
  if (event.persisted || leaving) return;
  leaving = true;
  clearTimeout(pollTimer);
  navigator.sendBeacon('/api/reader/leave', new Blob([JSON.stringify({
    view:viewId, desktopClose:!!state?.desktop, confirmedExport:exportActive || exportStarting
  })], {type:'application/json'}));
});
for (const command of ['stop','restart']) {
  $(`reader-${command}`).onclick = async () => {
    $('reader-restart').disabled = $('reader-stop').disabled = true;
    try {
      await api(`/api/reader/${command}`,{});
    } catch (error) {
      $('reader-restart').disabled = $('reader-stop').disabled = false;
      setText('reader-status',error.message);
      return;
    }
    leaving=true;
    clearTimeout(pollTimer);
    setText('reader-status', command==='stop' ? 'Reader sa vypína. Kartu môžeš zavrieť. Nabudúce spusti Start.cmd.' : 'Reader sa reštartuje…');
    if(command==='restart') {
      for(let attempt=0;attempt<30;attempt++){
        await new Promise(resolve=>setTimeout(resolve,1000));
        try { const next=await api('/api/state'); if(next.lifecycle){location.reload();return;} }
        catch(error){ if(attempt===29)setText('reader-status',`Reader ešte neodpovedá. Obnov stránku alebo spusti Start.cmd. ${error.message}`); }
      }
    }
  };
}
async function poll() {
  if(leaving)return;
  clearTimeout(pollTimer);
  try {
    const next = await api(`/api/state?view=${viewId}`);
    const changed = !state || state.count !== next.count || state.detailCount !== next.detailCount ||
      state.status.phase !== next.status.phase;
    const modelChanged = JSON.stringify(state?.selection) !== JSON.stringify(next.selection) || state?.offline !== next.offline;
    state = next;
    if (modelChanged) {
      linksGeneration++;
      inspectors.get(mainStage).diagramResult = null;
      diagramTrail.length = 0;
      diagramTabs.clear();
      stopLoading($('detail-loading'));
      clearDiagramDrag();
      extraPanes.forEach(pane=>pane.reset());
      closeInspector();
      kind = 'diagrams';
      preferredType = defaultDiagramType;
      loadFavorites();
      selectedId = selectedEntry = null;
      renderDiagramTabs();
      detailSequence++;
      $('detail').hidden = true;
    }
    const previousType = activeCatalogType();
    renderState();
    if (changed || modelChanged || previousType !== activeCatalogType()) await runSearch();
  } catch (error) { showError(error); }
  finally { if(!leaving)pollTimer = setTimeout(poll, 1800); }
}

function renderState() {
  const selection = state.selection, status = state.status;
  $('reader-restart').hidden = $('reader-stop').hidden = !state.lifecycle;
  const indexing = !!selection && !state.offline && status.phase === 'loading';
  $('catalog-loading').hidden = !indexing;
  if (indexing) setText('catalog-progress', `Načítavam katalóg${status.current ? ` · ${status.current}` : '…'}`);
  $('retry-index').hidden = !selection || state.offline || !['partial','error'].includes(status.phase);
  $('retry-missing').hidden = !(state.missingTypeCount > 0);
  if (state.missingTypeCount) setText('retry-missing', `Dočítať chýbajúce typy (${state.missingTypeCount})`);
  renderExport(state.markdownExport ?? {phase:'idle'});
  setText('model-name', selection?.model ?? 'Žiadny otvorený model');
  setText('model-location', selection ? `${selection.server} / ${selection.repository}` : 'Pripoj server alebo otvor lokálnu kópiu');
  setText('snapshot', selection ? `${state.offline ? 'Lokálna kópia · ' : ''}${state.catalogComplete ? 'Úplný katalóg' : 'Čiastočný katalóg'} · ${state.count.toLocaleString('sk')} objektov${state.updatedAt ? ` · kópia ${formatTime(state.updatedAt)}` : ''}` : '');
  if (status.error && status.phase !== 'partial') showError(new Error(status.error));
  $('search-scope-note').hidden = !selection || state.catalogComplete;
  $('search-scope-note').title = status.phase === 'partial' ? status.error : state.searchScope;
  setText('coverage', selection ? `${state.searchScope} ${state.catalogComplete ? '' : 'Katalóg nie je úplný.'} ${state.missingTypeCount ? 'Chýbajúce typy sa automaticky dočítajú o 5 sekúnd.' : ''} ${state.detailCount} uložených detailov.` : 'Vyber model zo servera alebo otvor lokálnu kópiu.');
  let diagrams = 0, dictionary = 0;
  for (const [type, count] of Object.entries(state.types)) {
    if (/\bdiagram\b/i.test(type)) diagrams += count; else dictionary += count;
  }

  renderCatalogControls(diagrams, dictionary);
}

let pickingExportFolder = false;
let exportClock;
function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds/3600), Math.floor(seconds/60)%60, seconds%60]
    .map(n => String(n).padStart(2,'0')).join(':');
}
function updateExportClock() {
  if (!exportClock) return;
  const {job, toolbarLabel, status} = exportClock;
  const clock = formatElapsed(job.elapsedMs + (job.active ? Math.max(0, Date.now()-job.startedAt) : 0));
  setText('export-md', `${toolbarLabel} · ${clock}`);
  setText('export-status', `${status} · Čas exportu: ${clock}`);
}
setInterval(() => {
  updateExportClock();
  for (const {timer,start} of loadingClocks.values()) timer.textContent=formatElapsed(performance.now()-start);
}, 1000);
function renderExport(job) {
    exportActive = !!job.active;
    const canExport = !!state?.selection?.modelId;
    $('export-md').disabled = !canExport && job.phase === 'idle';
    $('export-start').disabled = !canExport || !!job.active || pickingExportFolder;
    $('export-browse').disabled = !!job.active || pickingExportFolder;
    $('export-open-folder').disabled = pickingExportFolder;
    $('export-default').hidden = !$('export-folder').value || !!job.active || pickingExportFolder;
    $('export-stop').hidden = !job.active;
    $('export-resume').hidden = !canExport || !job.run || !['failed','cancelled'].includes(job.phase);
    const phases = {index:'Indexovanie',read:'Čítanie diagramov',references:'Referencie',write:'Zápis stránok',retry:'Čakám na automatický pokus'};
    const toolbarLabel = job.active ? `Export: ${phases[job.phase]}${job.total ? ` · ${job.done}/${job.total}` : '…'}`
      : ({complete:'Export: hotovo',failed:'Export: chyba',cancelled:'Export: zastavený'})[job.phase] ?? 'Export modelu do .md';
    $('export-md').dataset.phase = job.phase;
    const status = job.phase === 'retry' ? `Export sa skúsi znova po 10 sekundách · ${job.current ?? ''}: ${job.error}`
      : job.active ? `${phases[job.phase]} · ${job.done ?? 0}/${job.total || '…'} · ${job.current ?? ''}`
      : job.phase === 'complete' ? `Hotovo: ${job.count} diagramov. Otvor ${job.path}\\index.md`
      : job.phase === 'failed' ? `Export sa nedokončil (${job.current || 'index'}): ${job.error}`
      : job.phase === 'cancelled' ? 'Export bol zastavený.' : `Model: ${state?.selection?.model ?? '—'}`;
    exportClock = Number.isFinite(job.elapsedMs) ? {job,toolbarLabel,status} : null;
    if (exportClock) updateExportClock();
    else { setText('export-md',toolbarLabel); setText('export-status',status); }
    $('export-md').title = status;
  }
  $('export-md').addEventListener('click', () => $('export-dialog').showModal());
  $('export-close').addEventListener('click', () => $('export-dialog').close());
  $('export-open-folder').addEventListener('click',handle(async () => {
    await api('/api/export/open-folder',{folder:$('export-folder').value});
  }, 'export-error'));
  $('export-browse').addEventListener('click',handle(async () => {
    pickingExportFolder = true;
    renderExport(state.markdownExport);
    try {
      const {folder} = await api('/api/export/folder',{});
      if (folder) $('export-folder').value = folder;
    } finally { pickingExportFolder = false; renderExport(state.markdownExport); }
  }, 'export-error'));
  $('export-default').addEventListener('click',() => {
    $('export-folder').value = '';
    renderExport(state.markdownExport);
  });
  for (const [id, command, resume] of [['export-start','start',false],['export-resume','start',true],['export-stop','cancel',false]])
    $(id).addEventListener('click',handle(async () => {
      exportStarting = command === 'start';
      try {
        const job = await api(`/api/export/${command}`,{
          resume, ...(command === 'start' && !resume ? { folder: $('export-folder').value } : {})
        });
        renderExport(job);
        if (command === 'start') $('export-dialog').close();
      } finally { exportStarting = false; }
    }, 'export-error'));

const diagramPriority = ['Object Sequence Diagram', 'Class Diagram', 'Use Case Diagram'];
const diagramRank = type => diagramPriority.includes(type) ? diagramPriority.indexOf(type) : diagramPriority.length;
function activeCatalogType() {
  return kind === 'diagrams' ? $('diagram-types').querySelector('[aria-pressed=true]')?.value ?? '' : $('type-filter').value;
}

function renderCatalogControls(diagrams, dictionary) {
  setText('diagrams-count', diagrams.toLocaleString('sk'));
  setText('dictionary-count', dictionary.toLocaleString('sk'));
  document.querySelectorAll('[data-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === kind)));
  const group = $('diagram-types');
  group.hidden = kind !== 'diagrams';
  $('type-filter').hidden = kind === 'diagrams';
  if (kind === 'diagrams') {
    const types = Object.entries(state.types).filter(([type]) => /\bdiagram\b/i.test(type))
      .sort(([a],[b]) => diagramRank(a) - diagramRank(b) || a.localeCompare(b, 'sk'));
    const selected = types.some(([type]) => type === preferredType) ? preferredType : types[0]?.[0];
    const key = JSON.stringify(types);
    if (group.dataset.key !== key) {
      group.replaceChildren(...types.map(([type,count]) => {
        const button = document.createElement('button'), badge = document.createElement('small');
        button.type = 'button';
        button.value = button.title = type;
        button.textContent = type.replace(/^Object Sequence Diagram$/, 'Sequence').replace(/ Diagram$/, '') + ' ';
        badge.textContent = count.toLocaleString('sk');
        button.append(badge);
        return button;
      }));
      group.dataset.key = key;
    }
    for (const button of group.children) button.setAttribute('aria-pressed', String(button.value === selected));
    return;
  }
  const options = [];
  for (const [type, count] of Object.entries(state.types).sort(([a], [b]) => a.localeCompare(b))) {
    if (/\bdiagram\b/i.test(type)) continue;
    options.push(new Option(`${type} (${count})`, type));
  }
  $('type-filter').replaceChildren(...options);
  $('type-filter').disabled = options.length === 0;
  if (options.some(option => option.value === preferredType)) $('type-filter').value = preferredType;
}

async function runSearch() {
  const sequence = ++searchSequence;
  const started = performance.now();
  const type = activeCatalogType();
  const params = new URLSearchParams({ q: $('search').value, kind, type });
  const result = type ? await api(`/api/search?${params}`) : { total: 0, items: [] };
  if (sequence !== searchSequence) return;
  items = result.items;
  $('result-count').textContent = state?.selection ? `${result.total.toLocaleString('sk')} výsledkov` : 'Vyber model';
  $('search-time').textContent = state?.selection ? `${Math.round(performance.now() - started)} ms` : '';
  renderResults();
}

function renderResults() {
  const fragment = document.createDocumentFragment();
  const visible = favoriteOnly ? items.filter(item => favorites.has(item.id)) : items;
  for (const entry of visible) {
    const button = document.createElement('button');
    button.className = 'result';
    button.setAttribute('aria-current', String(entry.id === selectedId));
    const name = document.createElement('span');
    name.className = 'result-text';
    name.textContent = `${favorites.has(entry.id) ? '★ ' : ''}${entry.name || '(bez názvu)'}`;
    const mark = diagramTypeIcon(entry.type);
    if (mark) {
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark);
    }
    button.append(name);
    button.setAttribute('aria-label', `${name.textContent}, ${entry.type}`);
    button.title = entry.path;
    button.addEventListener('click', () => openDetail(entry.id, entry));
    if (/\bdiagram$/i.test(entry.type)) dragToCompare(button,entry);
    fragment.append(button);
  }
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = favoriteOnly ? 'V zobrazených výsledkoch nie sú obľúbené.'
      : state?.selection ? 'Žiadne výsledky v uloženej kópii.' : 'Vyber lokálnu kópiu v dialógu alebo načítaj zoznam repozitárov.';
    fragment.append(empty);
  }
  $('results').replaceChildren(fragment);
}

async function relatedClassDiagrams(relations,current) {
  const targets = new Map();
  const symbols = new Set(relations.filter(r=>r.role==='_Ent2_Class_To_CDClass' && r.item.nativeClass==='_Ent2_CDClass').map(r=>r.item.id));
  for (const id of symbols) {
    if (!current()) break;
    const {detail} = await api(`/api/item/${encodeURIComponent(id)}`);
    for (const r of detail.relations)
      if (r.role==='_Ent2_Symbol_To_Diagram' && r.item.nativeClass==='_Ent2_ClassDiagram') targets.set(r.item.id,r.item);
  }
  return [...targets.values()].sort((a,b)=>a.name.localeCompare(b.name,'sk'));
}

$('diagram-back').addEventListener('click', () => {
  const previous = diagramTrail.pop();
  if (previous) openDetail(previous.entry.id, previous.entry, true, false, previous.relationsOpen);
});

function openLinkedDetail(id,entry=null) {
  if(selectedEntry && selectedId!==id)
    diagramTrail.push({entry:selectedEntry,relationsOpen:$('object-relations').open});
  return openDetail(id,entry,true);
}

$('refresh-diagram').addEventListener('click', () => openDetail(selectedId, selectedEntry, true, true));

function renderDiagramTabs(focus = false) {
  drawTabs($('diagram-tabs'),diagramTabs,selectedId,entry=>openDetail(entry.id,entry),closeDiagramTab,'detail',focus);
}
function drawTabs(bar,diagramTabs,selectedId,open,closeTab,controls,focus=false) {
  bar.hidden = !diagramTabs.size;
  bar.replaceChildren();
  for (const [id, tab] of diagramTabs) {
    const group = document.createElement('span'), button = document.createElement('button'), close = document.createElement('button');
    group.className = 'diagram-tab';
    button.setAttribute('role','tab');
    button.setAttribute('aria-controls',controls);
    button.setAttribute('aria-selected',String(id === selectedId));
    button.tabIndex = id === selectedId || (!diagramTabs.has(selectedId) && !bar.childElementCount) ? 0 : -1;
    button.title = button.textContent = tab.entry.name;
    const activate = () => {
      if (id !== selectedId) open(tab.entry);
      bar.querySelector('[aria-selected=true]')?.focus();
    };
    button.addEventListener('click', activate);
    dragToCompare(button,tab.entry,{tab,active:id===selectedId,root:bar.closest('.window-pane'),close:closeTab});
    close.textContent = '×';
    close.setAttribute('aria-label',`Zavrieť kartu: ${tab.entry.name}`);
    close.title = 'Zavrieť kartu';
    close.addEventListener('click', () => closeTab(id));
    group.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); closeTab(id); } });
    button.addEventListener('keydown', e => {
      const ids = [...diagramTabs.keys()], i = ids.indexOf(id);
      if (e.key === 'Delete') { e.preventDefault(); closeTab(id); return; }
      const next = {ArrowLeft:(i+ids.length-1)%ids.length,ArrowRight:(i+1)%ids.length,Home:0,End:ids.length-1}[e.key];
      if (next === undefined) return;
      e.preventDefault();
      bar.querySelectorAll('[role=tab]')[next].click();
    });
    group.append(button, close);
    bar.append(group);
  }
  const active = bar.querySelector('[aria-selected=true]');
  active?.scrollIntoView({block:'nearest',inline:'nearest'});
  if (focus) active?.focus();
}

function closeDiagramTab(id) {
  const ids = [...diagramTabs.keys()], i = ids.indexOf(id);
  diagramTabs.delete(id);
  if (id !== selectedId) { renderDiagramTabs(true); return; }
  const next = ids[i+1] ?? ids[i-1];
  if (next) { openDetail(next, diagramTabs.get(next).entry); renderDiagramTabs(true); return; }
  ++detailSequence;
  stopLoading($('detail-loading'));
  selectedEntry = selectedId = null;
  diagramTrail.length = 0;
  closeInspector();
  $('detail').hidden = true;
  renderDiagramTabs();
  renderResults();
  ($('catalog').classList.contains('collapsed') ? $('catalog-toggle') : $('search')).focus();
}

async function openDetail(id, entry = null, linked = false, refresh = false, relationsOpen = false) {
  const old = diagramTabs.get(selectedId);
  if (old && selectedId === id && !refresh && old.loaded) return;
  inspectors.get(mainStage).diagramResult = null;
  if (old?.loaded && !$('diagram-panel').hidden) {
    old.box = diagram.box ? [...diagram.box] : null;
    old.query = $('diagram-search').value;
    old.inspector = inspectors.get(mainStage).element;
  }
  closeInspector();
  if (!linked) diagramTrail.length = 0;
  $('diagram-back').hidden = !diagramTrail.length;
  $('diagram-links').hidden = true;
  const sequence = ++detailSequence;
  selectedId = id;
  selectedEntry = entry ?? diagramTabs.get(id)?.entry ?? items.find(item => item.id === id) ?? { id, name: 'Načítavanie…', type: 'Objekt', path: '' };
  let tab = diagramTabs.get(id);
  if (!tab && /\bdiagram$/i.test(selectedEntry.type)) {
    tab = {entry:selectedEntry};
    diagramTabs.set(id,tab);
  }
  renderDiagramTabs();
  $('detail').hidden = false;
  startLoading($('detail-loading'), tab ? 'Načítavam diagram…' : 'Načítavam detail…');
  $('detail-error').hidden = true;
  $('detail-warnings').hidden = true;
  $('attributes-panel').replaceChildren();
  $('relations-panel').replaceChildren();
  $('diagram').replaceChildren(diagram.svg);
  diagram.svg.replaceChildren();
  $('detail-name').textContent = selectedEntry.name || '(bez názvu)';
  setDetailType(selectedEntry.type);
  $('refresh-diagram').disabled = true;
  $('detail-path').textContent = selectedEntry.path;
  $('detail-source').textContent = '';
  $('relations-count').textContent = '';
  $('diagram-panel').hidden = $('attributes-panel').hidden = $('object-relations').hidden = true;
  $('object-relations').open = relationsOpen;
  updateFavorite();
  renderResults();
  try {
    let request = tab?.request;
    if (!request || refresh) {
      request = api(`/api/item/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`);
      if (tab) {
        tab.request = request;
        tab.loaded = false;
        request.catch(() => { if (tab.request === request) tab.request = null; });
      }
    }
    const result = await request;
    if (sequence !== detailSequence) return;
    selectedEntry = result.entry;
    $('detail-name').textContent = result.entry.name || '(bez názvu)';
    setDetailType(result.entry.type);
    $('detail-path').textContent = result.entry.path;
    const detail = result.detail;
    if (!tab && (detail.diagram || /\bdiagram$/i.test(result.entry.type))) {
      tab = {entry:result.entry, request};
      diagramTabs.set(id,tab);
      renderDiagramTabs();
    }
    if (tab) { tab.entry = result.entry; tab.loaded = true; }
    $('detail-source').textContent = `${detail.cached ? 'Z lokálnej kópie' : `Priamo zo servera · ${detail.sourceMs} ms`} · načítané ${formatTime(detail.loadedAt)}`;
    if (!detail.diagram) {
      $('attributes-panel').hidden = $('object-relations').hidden = false;
      renderAttributes(detail.attributes);
      renderRelations(detail.relations);
    }
    const warnings = (detail.warnings ?? []).filter(message =>
      !message.endsWith(': príloha nie je textový dokument; jej bajty sa nevykresľujú ako text.'));
    if (state.offline && ['Class Diagram', 'Object Sequence Diagram'].includes(result.entry.type) && !detail.diagram?.uml)
      warnings.unshift(`Táto kópia ešte neobsahuje UML význam tried a správ. ${state.selection?.modelId ? 'Použi Obnoviť pre nové načítanie.' : 'Otvor model online pre nové načítanie.'}`);
    if (detail.textOnly) warnings.unshift('Táto offline kópia obsahuje len textové vlastnosti. Pre nové načítanie otvor model online.');
    if (warnings.length) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = `Upozornenia a obmedzenia (${warnings.length})`;
      details.append(summary);
      for (const warning of warnings) {
        const paragraph = document.createElement('p');
        paragraph.textContent = warning;
        details.append(paragraph);
      }
      $('detail-warnings').replaceChildren(details);
      $('detail-warnings').hidden = false;
    }
    if (detail.diagram) {
      $('diagram-panel').hidden = false;
      const heading = $('detail-name');
      heading.tabIndex = 0;
      heading.setAttribute('role','button');
      heading.title = 'Zobraziť detail diagramu';
      diagram.render(detail.diagram);
      if (tab?.box) { diagram.box = [...tab.box]; diagram.update(); }
      $('diagram-search').value = tab?.query ?? '';
      $('diagram-search').dispatchEvent(new Event('input'));
      restoreDiagramInspector(tab,result,mainStage);
    }
  } catch (error) {
    if (sequence === detailSequence) showError(error, 'detail-error');
  } finally {
    if (sequence === detailSequence) {
      stopLoading($('detail-loading'));
      $('refresh-diagram').disabled = false;
    }
  }
}

function diagramTypeIcon(type) {
  if (type !== 'Class Diagram' && type !== 'Object Sequence Diagram') return null;
  const icon = document.createElement('span'), cld = type === 'Class Diagram';
  icon.className = cld ? 'result-class' : 'result-sequence';
  icon.textContent = cld ? '▤' : '⇄';
  return icon;
}
function renderTypeLabel(label,type) {
  const icon = diagramTypeIcon(type);
  label.classList.toggle('type-badge',!icon);
  if (!icon) { label.textContent = type; return; }
  icon.title = type;
  icon.setAttribute('role','img');
  icon.setAttribute('aria-label',type);
  label.replaceChildren(icon);
}
function setDetailType(type) {
  $('refresh-diagram').hidden = (state?.offline && !state.selection?.modelId) || !/\bdiagram$/i.test(type);
  renderTypeLabel($('detail-type'),type);
  $('detail').classList.toggle('diagram-detail', /\bdiagram$/i.test(type));
  const heading=$('detail-name');
  for(const attr of ['role','tabindex','title']) heading.removeAttribute(attr);
}
$('detail-name').addEventListener('click', () => {
  if (document.getSelection().isCollapsed && $('detail-loading').hidden && !$('diagram-panel').hidden) {
    inspectDiagramElement(selectedId,selectedEntry.type==='Object Sequence Diagram' ? 'callers' : 'diagram');
  }
});
$('detail-name').addEventListener('keydown', event=>{
  if (event.currentTarget.getAttribute('role')==='button' && ['Enter',' '].includes(event.key)) {
    event.preventDefault(); event.currentTarget.click();
  }
});

function closeInspector(stage=mainStage) {
  const inspector = inspectors.get(stage);
  inspector.sequence++;
  inspector.element = null;
  inspector.aside.hidden = true;
}

function restoreDiagramInspector(tab, result, stage) {
  const {entry} = result;
  inspectors.get(stage).diagramResult = result;
  if (entry.type === 'Object Sequence Diagram') diagramLinks(result);
  if (tab.inspector === undefined && localStorage.getItem(inspectors.get(stage).visibilityKey)==='closed') return;
  const target = tab.inspector === undefined
    ? {id:entry.id, link:entry.type === 'Object Sequence Diagram' ? 'callers' : 'diagram'}
    : tab.inspector;
  if (target) inspectDiagramElement(target.id, target.link, stage, target.id === entry.id ? result : null, false,target);
}

async function loadLinks(detail, isProbe, current) {
  const readRelations = async id => {
    if (!current()) throw new Error('Výber diagramu sa zmenil.');
    return (await api(`/api/item/${encodeURIComponent(id)}`)).detail.relations;
  };
  const owners = [];
  if (isProbe) owners.push(detail.relations);
  else for (const id of new Set(detail.relations.filter(r=>r.role==='_Ent2_ObjectSequenceDiagram_To_ParentOSD').map(r=>r.item.id)))
    owners.push(await readRelations(id));
  const callers = new Map();
  for (const id of new Set(owners.flat().filter(r=>r.item.nativeClass==='_Ent2_OSDProbe' && r.role.endsWith('_To_OSDProbe')).map(r=>r.item.id)))
    for (const r of await readRelations(id))
      if (r.role==='_Ent2_Symbol_To_Diagram' && r.item.nativeClass==='_Ent2_ObjectSequenceDiagram') callers.set(r.item.id,r.item);
  return [...callers.values()].sort((a,b)=>a.name.localeCompare(b.name,'sk'));
}

function diagramLinks(result) {
  if (!sqdLinks.has(result)) {
    const generation = linksGeneration;
    const request = loadLinks(result.detail,false,()=>generation===linksGeneration);
    sqdLinks.set(result,request);
    // Keep successful reads with this diagram version; allow a failed prefetch to retry on open.
    request.catch(()=>sqdLinks.delete(result));
  }
  return sqdLinks.get(result);
}

async function inspectDiagramElement(id, link, stage=mainStage, loaded=null, rememberOpen=true, location={id,link}) {
  const inspector = inspectors.get(stage);
  if (rememberOpen) localStorage.setItem(inspector.visibilityKey,'open');
  inspector.element = location;
  stage.querySelector('.inspector-back').hidden = !location.previous;
  const sequence = ++inspector.sequence;
  const current = () => sequence === inspector.sequence;
  const panel = inspector.panel;
  inspector.aside.hidden = false;
  inspector.name.textContent = 'Detail prvku';
  panel.textContent = 'Načítavam…';
  try {
    const result = loaded ?? (inspector.diagramResult?.entry.id === id ? inspector.diagramResult : await api(`/api/item/${encodeURIComponent(id)}`));
    const { entry, detail } = result;
    if (!current()) return;
    inspector.name.textContent = entry.name;
    panel.replaceChildren();
    const diagramLink = target => {
      const link = document.createElement('a');
      link.href = '#diagram';
      link.className = 'sqd-link';
      link.setAttribute('aria-label', `Otvoriť ${target.nativeClass==='_Ent2_ClassDiagram'?'CLD':'SQD'}: ${target.name}`);
      const arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↗';
      link.append(arrow, target.name);
      link.addEventListener('click', event => {
        event.preventDefault();
        openLinkedDetail(target.id,target);
      });
      return link;
    };
    const classLinks = link === 'class' ? document.createElement('div') : null;
    if (classLinks) {
      classLinks.textContent = 'Hľadám súvisiace CLD…';
      panel.append(classLinks);
    }
    if (link === 'sequence') {
      const targets = new Map(detail.relations
        .filter(r => r.role === '_Ent2_ParentOSD_To_ObjectSequenceDiagram' && r.item.nativeClass === '_Ent2_ObjectSequenceDiagram')
        .map(r => [r.item.id, r.item]));
      if (!targets.size) panel.append('Odkaz nemá priradený sekvenčný diagram.');
      for (const target of targets.values()) {
        panel.append(diagramLink(target));
      }
    }
    const properties = inspectorProperties(detail.attributes);
    panel.append(properties);
    const relations = document.createElement('details'), label = document.createElement('summary');
    label.textContent = `Všetky prepojenia (${detail.relations.length})`;
    relations.append(label);
    relations.addEventListener('toggle', () => {
      if (relations.open && relations.childElementCount === 1 && !relations.dataset.rendered) {
        renderRelations(detail.relations, relations, related => {
          if(related.id===id)return;
          location.relationsOpen=relations.open;
          location.propertiesOpen=properties.querySelector('details').open;
          inspectDiagramElement(related.id,undefined,stage,null,true,{id:related.id,previous:location});
        });
        relations.dataset.rendered = 'true';
      }
    });
    panel.append(relations);
    if(location.relationsOpen)relations.open=true;
    if(location.propertiesOpen)properties.querySelector('details').open=true;
    if (classLinks) {
      try {
        const targets = await relatedClassDiagrams(detail.relations,current);
        if (!current()) return;
        classLinks.replaceChildren(...targets.map(diagramLink));
        if (!targets.length) classLinks.textContent = 'Trieda nemá priradený CLD.';
      } catch (error) {
        if (current()) classLinks.textContent = `Súvisiace CLD sa nepodarilo načítať: ${error.message}`;
      }
    }
    if (link === 'sequence' || link === 'callers') {
      const section=document.createElement('section'), heading=document.createElement('h3'), list=document.createElement('div');
      heading.textContent='Prepojenia';
      list.textContent='Načítavam prepojenia…';
      section.append(heading,list);
      panel.insertBefore(section,properties);
      try {
        const callers = await (link==='callers' ? diagramLinks(result) : loadLinks(detail,true,current));
        if(!current())return;
        list.replaceChildren(...callers.map(diagramLink));
        if(!callers.length)list.textContent='Žiadny SQD na tento cieľ neodkazuje cez probe.';
      } catch(error) {
        if(current())list.textContent=`Prepojenia sa nepodarilo načítať: ${error.message}`;
      }
    }
  } catch (error) {
    if (current()) panel.textContent = `Detail prvku sa nepodarilo načítať: ${error.message}`;
  }
}

function inspectorProperties(attributes) {
  const section = document.createElement('section'), heading = document.createElement('h3');
  heading.textContent = 'Vlastnosti';
  const visible = document.createElement('div'), more = document.createElement('details');
  const summary = document.createElement('summary'), other = document.createElement('div');
  section.append(heading, visible, more);
  more.append(summary, other);
  const storageKey = 'select-reader:pinned-properties:v2';
  const defaults = new Map([['Description','Description'], ['Popis','Popis'], ['AttributeDeclarations','Attribute declaration'],
    ['AttributeDeclaration','Attribute declaration'], ['Attribute declaration','Attribute declaration']]);
  const stored = localStorage.getItem(storageKey);
  const pinned = new Set(stored === null
    ? [...defaults.values(), ...JSON.parse(localStorage.getItem('select-reader:pinned-properties') ?? '[]')]
    : JSON.parse(stored));
  function draw(focusKey) {
    visible.replaceChildren();
    other.replaceChildren();
    let remaining = 0;
    const keys = [...defaults.keys()].filter(key => Object.hasOwn(attributes,key))
      .concat(Object.keys(attributes).filter(key => !defaults.has(key)).sort((a,b) => a.localeCompare(b,'sk')));
    for (const key of keys) {
      const label = defaults.get(key) ?? key;
      const active = pinned.has(label), parent = active ? visible : other;
      if (!active) remaining++;
      renderAttributes({ [label]: defaults.has(key) ? attributes[key] || 'Nevyplnené' : attributes[key] }, parent);
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'property-star';
      star.textContent = active ? '★' : '☆';
      star.setAttribute('aria-pressed', String(active));
      star.title = `${active ? 'Odobrať z predvolených' : 'Pridať medzi predvolené'}: ${label}`;
      star.setAttribute('aria-label', star.title);
      star.addEventListener('click', () => {
        const next = new Set(pinned);
        if (active) next.delete(label); else next.add(label);
        try { localStorage.setItem(storageKey, JSON.stringify([...next])); }
        catch (error) { showError(error); return; }
        if (active) { pinned.delete(label); more.open = true; } else pinned.add(label);
        draw(label);
      });
      parent.lastElementChild.querySelector('dt').append(star);
    }
    summary.textContent = `Ďalšie vlastnosti (${remaining})`;
    more.hidden = !remaining;
    if (!Object.keys(attributes).length) visible.append('Objekt nemá vyplnené textové vlastnosti.');
    if (focusKey) [...section.querySelectorAll('.property-star')].find(star => star.closest('dt').firstChild.textContent === focusKey)?.focus();
  }
  draw();
  return section;
}

function renderAttributes(attributes, panel = $('attributes-panel')) {
  const entries = Object.entries(attributes);
  const preferred = ['Description', 'Popis', 'Objective', 'Scenarios', 'Preconditions', 'Postconditions'];
  entries.sort(([a], [b]) => {
    const x = preferred.indexOf(a), y = preferred.indexOf(b);
    return (x < 0 ? 100 : x) - (y < 0 ? 100 : y) || a.localeCompare(b);
  });
  for (const [key, value] of entries) {
    const list = document.createElement('dl'), name = document.createElement('dt'), content = document.createElement('dd');
    list.className = 'attribute';
    name.textContent = key;
    content.textContent = preferred.includes(key) || key === 'Celé znenie (Description)' ? descriptionText(value) : value;
    list.append(name, content);
    panel.append(list);
  }
  if (!entries.length) panel.append('Objekt nemá vyplnené textové vlastnosti.');
}

function renderRelations(relations, panel = $('relations-panel'), inspect = entry => openLinkedDetail(entry.id, entry)) {
  if (panel === $('relations-panel')) $('relations-count').textContent = `(${relations.length})`;
  const groups = new Map();
  for (const relation of relations) {
    if (!groups.has(relation.role)) groups.set(relation.role, []);
    groups.get(relation.role).push(relation.item);
  }
  for (const [role, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const group = document.createElement('div'), title = document.createElement('h3');
    group.className = 'relation-group';
    title.textContent = `${role} · ${entries.length}`;
    group.append(title);
    for (const entry of entries) {
      const button = document.createElement('button'), type = document.createElement('small');
      button.className = 'relation';
      button.textContent = entry.name || '(bez názvu)';
      type.textContent = entry.type;
      button.append(type);
      button.addEventListener('click', () => inspect(entry));
      group.append(button);
    }
    panel.append(group);
  }
  if (!relations.length) panel.append('Pre tento objekt neboli načítané žiadne prepojenia.');
}

function updateFavorite() {
  const enabled = favorites.has(selectedId);
  $('favorite').textContent = enabled ? '★' : '☆';
  $('favorite').setAttribute('aria-pressed', String(enabled));
  extraPanes.forEach(pane=>pane.showFavorite());
}

const recentKey = 'select-reader:recent-models';
const selectionKey = s => JSON.stringify([s.server.toLowerCase(), s.repository, s.model, s.modelId ?? '']);
function recentModels() { return JSON.parse(localStorage.getItem(recentKey) ?? '[]'); }
function rememberModel(s) {
  if (s?.modelId) localStorage.setItem(recentKey, JSON.stringify([s, ...recentModels().filter(other => selectionKey(other) !== selectionKey(s))].slice(0, 10)));
}
let repositoryGeneration = 0;
function showPicker() {
  $('picker-error').hidden = true;
  $('picker').showModal();
  discoverRepositories();
  refreshHistory();
}
async function refreshHistory() {
  try {
    if (!localStorage.getItem(recentKey)) rememberModel(state?.selection);
    const recent = recentModels();
    const seen = new Set();
    const servers = recent.map(model => model.server.trim()).filter(server => {
      const key = server.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    $('servers').replaceChildren(...servers.map(server => new Option(server, server)));
    $('recent-section').hidden = !recent.length;
    $('recent-models').replaceChildren();
    for (const selection of recent) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${selection.model} · ${selection.server} / ${selection.repository}`;
      button.addEventListener('click', handle(async () => {
        button.disabled = true;
        try {
          await api('/api/open', selection);
          rememberModel(selection);
          closePicker();
          await poll();
        } finally { button.disabled = false; }
      }, 'picker-error'));
      $('recent-models').append(button);
    }
    const history = await api('/api/history');
    $('history-section').hidden = history.length === 0;
    $('history').replaceChildren();
    for (const item of history) {
      const button = document.createElement('button'), description = document.createElement('small');
      button.type = 'button';
      button.textContent = item.selection.model;
      description.textContent = `${item.selection.server} / ${item.selection.repository} · ${item.count} objektov · ${item.complete ? 'úplný' : 'čiastočný'} katalóg · ${formatTime(item.updatedAt)}`;
      button.append(description);
      button.addEventListener('click', handle(async () => {
        await api('/api/open', { ...item.selection, offline: true });
        rememberModel(item.selection);
        closePicker();
        await poll();
      }, 'picker-error'));
      const row = document.createElement('div'), remove = document.createElement('button');
      row.className = 'history-row';
      remove.type = 'button';
      remove.textContent = 'Zmazať kópiu';
      remove.addEventListener('click', handle(async () => {
        const active = state?.selection && selectionKey(state.selection) === selectionKey(item.selection);
        if (!confirm(`Zmazať lokálnu kópiu ${item.selection.server} / ${item.selection.repository} / ${item.selection.model}?${active ? ' Otvorený model sa zatvorí.' : ''} Model na serveri sa nezmení.`)) return;
        await api('/api/cache/remove', { ...item.selection, closeActive: !!active });
        await poll();
        await refreshHistory();
      }, 'picker-error'));
      row.append(button, remove);
      $('history').append(row);
    }
  } catch (error) { showError(error, 'picker-error'); }
}

function populateRepositories() {
  resetAuthentication();
  const server = $('server').value.trim().toLowerCase();
  const matches = server === discoveredServer ? repositories : [];
  $('repository').replaceChildren(new Option(matches.length ? 'Vyber repozitár' : 'Najprv načítaj repozitáre zo servera', ''),
    ...matches.map(repository => new Option(`${repository.name} (${repository.port})`, repository.name)));
  $('repository').disabled = !matches.length;
  resetModelList();
  updateAuthenticationControls();
}

function resetModelList() {
  modelListGeneration++;
  modelChoices = [];
  $('open-model').disabled = true;
  $('picker-status').textContent = '';
  $('model').replaceChildren(new Option('Najprv načítaj modely repozitára', ''));
  $('model').disabled = true;
}

async function loadModels() {
  const server = $('server').value.trim(), repository = $('repository').value;
  if (!repository || discoveredServer !== server.toLowerCase()) throw new Error('Najprv vyber repozitár zo zvoleného servera.');
  const generation = ++modelListGeneration;
  $('model').disabled = true;
  $('model').replaceChildren(new Option('Načítavam modely…', ''));
  $('picker-status').textContent = 'Windows pripojenie a priame čítanie modelov z databázy…';
  try {
    const result = await api('/api/models', { server, repository });
    if (generation !== modelListGeneration) return;
    if (result.complete !== true || !Array.isArray(result.models)) throw new Error('Server nevrátil úplný zoznam modelov.');
    modelChoices = result.models;
    $('model').replaceChildren(new Option(result.models.length ? 'Vyber model' : 'Repozitár neobsahuje modely', ''),
      ...result.models.map(model => new Option(`${model.name} · verzia ${model.version}`, model.id)));
    $('model').disabled = !result.models.length;
    $('windows-status').textContent = 'Windows pripojenie je overené; zoznam modelov sa prečítal priamo z databázy bez UserIdent.';
    $('picker-status').textContent = `${result.models.length} modelov za ${result.elapsedMs} ms · ${server} / ${repository} · TCP ${result.port}. Vyber model a klikni Otvoriť model.`;
  } catch (error) {
    if (generation !== modelListGeneration) return;
    $('model').replaceChildren(new Option('Načítanie modelov zlyhalo', ''));
    $('picker-status').textContent = 'Zoznam modelov sa nepodarilo načítať.';
    throw error;
  }
}

$('choose-model').addEventListener('click', showPicker);
for (const [id, route] of [['retry-index','/api/open'], ['retry-missing','/api/catalog/missing']]) {
  $(id).addEventListener('click', handle(async () => {
    $('retry-index').disabled = $('retry-missing').disabled = true;
    try { await api(route, state.selection); await poll(); }
    finally { $('retry-index').disabled = $('retry-missing').disabled = false; }
  }));
}
$('close-picker').addEventListener('click', closePicker);
$('server').addEventListener('input', () => {
  repositoryGeneration++;
  $('windows-status').textContent = '';
  $('auth-plaintext').checked = false;
  $('auth-port').value = '';
  updateAuthenticationMode();
  populateRepositories();
});
$('server').addEventListener('change', () => discoverRepositories());
$('windows-connect').addEventListener('click', async () => {
  if (windowsConnectionBusy) return;
  const target = $('server').value.trim();
  windowsConnectionBusy = true;
  $('windows-connect').disabled = true;
  $('windows-status').textContent = 'Windows overuje prístup k zdieľaniu enabler existujúcim sieťovým prihlásením…';
  try {
    const result = await api('/api/windows-connection', { server: target });
    if (target !== $('server').value.trim()) return;
    if (!result.shareReadable || !result.networkIdentityVerified) throw new Error('Windows pripojenie nebolo potvrdené.');
    $('windows-status').textContent = 'Windows prístup k zdieľaniu enabler aj jeho sieťová identita sú overené. Meno ani heslo aplikácia nepýtala. Toto overenie samo o sebe neoveruje prístup k modelom.';
  } catch (error) {
    if (target === $('server').value.trim()) $('windows-status').textContent = error.message;
  } finally {
    windowsConnectionBusy = false;
    $('windows-connect').disabled = false;
  }
});
$('picker').addEventListener('close', resetAuthentication);
$('picker').addEventListener('close', () => {
  repositoryGeneration++;
  modelListGeneration++;
});
$('picker').addEventListener('cancel', resetAuthentication);
globalThis.addEventListener('pagehide', resetAuthentication);
$('auth-port').addEventListener('input', resetAuthentication);
$('auth-plaintext').addEventListener('change', () => {
  $('auth-port').value = $('auth-plaintext').checked ? '9700' : '';
  updateAuthenticationMode();
  resetAuthentication();
});

function updateAuthenticationMode() {
  const plain = $('auth-plaintext').checked;
  $('auth-plaintext-warning').hidden = !plain;
  $('auth-port-label').textContent = plain ? 'Port brokera' : 'Port TLS vstupu brokera';
  $('auth-port').placeholder = plain ? '9700' : 'TLS port od správcu';
  $('auth-prepare').textContent = plain ? 'Pripraviť bežné pripojenie' : 'Overiť zabezpečené spojenie';
}

function updateAuthenticationControls() {
  const port = Number($('auth-port').value);
  const targetReady = !!$('repository').value && discoveredServer === $('server').value.trim().toLowerCase() &&
    Number.isInteger(port) && port > 0 && port <= 65535;
  $('auth-prepare').disabled = authenticationBusy || !targetReady;
  $('auth-credentials').disabled = authenticationBusy || !preparedAuthentication;
  $('auth-check').disabled = authenticationBusy || !preparedAuthentication || !$('auth-username').value;
}

function clearCredentials() {
  $('auth-password').value = '';
  $('auth-username').value = '';
  $('auth-domain').value = '';
}

function closePicker() {
  resetAuthentication();
  $('picker').close();
}

function resetAuthentication() {
  authenticationGeneration++;
  preparedAuthentication = null;
  clearCredentials();
  $('auth-status').textContent = '';
  updateAuthenticationControls();
}

for (const id of ['auth-username', 'auth-domain', 'auth-password'])
  $(id).addEventListener('input', updateAuthenticationControls);

$('auth-current-identity').addEventListener('click', async () => {
  if (authenticationBusy || !preparedAuthentication) return;
  const generation = authenticationGeneration;
  clearCredentials();
  authenticationBusy = true;
  updateAuthenticationControls();
  $('auth-status').textContent = 'Zisťovanie Windows účtu procesu aplikácie…';
  try {
    const identity = await api('/api/current-identity');
    if (generation !== authenticationGeneration) return;
    $('auth-username').value = identity.username;
    $('auth-domain').value = identity.domain;
    $('auth-status').textContent = `Windows účet je predvyplnený. ${identity.isLocalAccount === true ? 'Ide o lokálny účet počítača, nie automaticky o firemné doménové konto. ' : ''}Porovnaj ho s tým, ktorý si už skúšal. Žiadny prihlasovací pokus neprebehol; účet musí byť povolený v UserIdent na cieľovom serveri.`;
  } catch (error) {
    if (generation === authenticationGeneration) $('auth-status').textContent = error.message;
  } finally {
    authenticationBusy = false;
    updateAuthenticationControls();
  }
});

$('auth-prepare').addEventListener('click', async () => {
  resetAuthentication();
  const generation = authenticationGeneration;
  const target = { server: $('server').value.trim(), repository: $('repository').value, port: Number($('auth-port').value),
    allowPlaintext: $('auth-plaintext').checked };
  authenticationBusy = true;
  updateAuthenticationControls();
  $('auth-status').textContent = target.allowPlaintext ? 'Príprava bežného TCP pripojenia bez šifrovania…' : 'Overovanie certifikátu a prihlasovacieho profilu cez TLS…';
  try {
    const result = await api('/api/authentication/prepare', target);
    if (generation !== authenticationGeneration) return;
    if (result.encrypted !== !target.allowPlaintext || (target.allowPlaintext && result.plaintextAcknowledged !== true))
      throw new Error('Server nepotvrdil zvolený spôsob pripojenia.');
    preparedAuthentication = target;
    $('auth-status').textContent = `${target.allowPlaintext ? 'Nešifrované TCP pripojenie je pripravené; heslo pôjde čitateľne.' : 'TLS spojenie je overené.'} Prihlasovací profil: ${result.context} / ${result.mechanism}. Môžeš zadať účet; overenie neotvorí model.`;
  } catch (error) {
    if (generation === authenticationGeneration) $('auth-status').textContent = error.message;
  } finally {
    authenticationBusy = false;
    updateAuthenticationControls();
  }
});

$('auth-check').addEventListener('click', async () => {
  if (!preparedAuthentication || authenticationBusy) return;
  const generation = authenticationGeneration;
  const input = { ...preparedAuthentication, username: $('auth-username').value, domain: $('auth-domain').value, password: $('auth-password').value };
  clearCredentials();
  authenticationBusy = true;
  updateAuthenticationControls();
  $('auth-status').textContent = input.allowPlaintext ? 'Jednorazové overenie účtu cez nešifrované TCP…' : 'Jednorazové overenie účtu cez TLS…';
  try {
    const result = await api('/api/authentication/check', input);
    if (generation !== authenticationGeneration) return;
    $('auth-status').textContent = result.credentialsVerified
      ? 'Účet bol overený. Údaje neboli uložené. Prístup k modelom ani databázová relácia ešte nie sú potvrdené.'
      : 'Server nepotvrdil overenie účtu.';
  } catch (error) {
    if (generation === authenticationGeneration) $('auth-status').textContent = error.message;
  } finally {
    input.password = '';
    authenticationBusy = false;
    updateAuthenticationControls();
  }
});
const discoverRepositories = handle(async () => {
  const generation = ++repositoryGeneration;
  const server = $('server').value.trim();
  discoveredServer = '';
  populateRepositories();
  $('picker-error').hidden = true;
  if (!server) {
    $('picker-status').textContent = 'Zadaj názov servera alebo vyber uložený model.';
    return;
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,252}$/i.test(server))
    throw new Error('Zadaj názov servera alebo IPv4 adresu, nie URL či cestu.');
  $('picker-status').textContent = 'Priame TCP spojenie s databázovým brokerom…';
  try {
    const result = await api('/api/repositories', { server });
    if (generation !== repositoryGeneration) return;
    repositories = result.repositories;
    discoveredServer = server.toLowerCase();
    populateRepositories();
    $('picker-status').textContent = `${repositories.length} repozitárov za ${result.elapsedMs} ms · TCP ${server}:${result.port} · protokol ${result.protocol}. Výber repozitára načíta jeho modely.`;
  } catch (error) {
    if (generation !== repositoryGeneration) return;
    $('picker-status').textContent = 'Načítanie zoznamu repozitárov zlyhalo.';
    throw error;
  }
}, 'picker-error');
$('repository').addEventListener('change', handle(async () => {
  resetAuthentication();
  resetModelList();
  if ($('repository').value) await loadModels();
}, 'picker-error'));
$('model').addEventListener('change', () => { $('open-model').disabled = !$('model').value; });
$('picker-form').addEventListener('submit', handle(async event => {
  event.preventDefault();
  const model = modelChoices.find(item => item.id === $('model').value);
  if (!model) throw new Error('Vyber model z načítaného zoznamu.');
  const generation = modelListGeneration;
  $('open-model').disabled = true;
  $('picker-status').textContent = 'Otváram model cez Windows pripojenie…';
  try {
    const opened = await api('/api/open', { server: $('server').value.trim(), repository: $('repository').value, model: model.name, modelId: model.id });
    rememberModel(opened.selection);
    if (generation !== modelListGeneration) return;
    closePicker();
    await poll();
  } finally {
    if (generation === modelListGeneration) $('open-model').disabled = !$('model').value;
  }
}, 'picker-error'));

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(handle(() => runSearch()), 120);
});
$('type-filter').addEventListener('change', handle(() => {
  preferredType = $('type-filter').value;
  return runSearch();
}));
$('diagram-types').addEventListener('click', handle(event => {
  const button = event.target.closest('button');
  if (!button || button.value === activeCatalogType()) return;
  preferredType = button.value;
  for (const item of $('diagram-types').children) item.setAttribute('aria-pressed', String(item === button));
  return runSearch();
}));
for (const button of document.querySelectorAll('[data-kind]')) {
  button.addEventListener('click', handle(async () => {
    kind = button.dataset.kind;
    preferredType = kind === 'diagrams' ? defaultDiagramType : '';
    renderState();
    await runSearch();
  }));
}
$('favorites-filter').addEventListener('click', () => {
  favoriteOnly = !favoriteOnly;
  $('favorites-filter').setAttribute('aria-pressed', String(favoriteOnly));
  renderResults();
});
function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
  localStorage.setItem(favoriteKey(), JSON.stringify([...favorites]));
  updateFavorite();
  renderResults();
}
$('favorite').addEventListener('click', handle(async () => toggleFavorite(selectedId)));
$('zoom-in').addEventListener('click', () => diagram.zoom(1 / 1.25));
$('cursor-switch').addEventListener('click', ({currentTarget: toggle}) => {
  const hand = toggle.getAttribute('aria-checked') !== 'true';
  diagram.setHand(hand);
  extraPanes.forEach(pane=>pane.view.setHand(hand));
  toggle.setAttribute('aria-checked', String(hand));
  toggle.title = hand ? 'Posúvanie rukou · prepnúť na výber textu' : 'Výber textu · prepnúť na posúvanie rukou';
});
$('zoom-out').addEventListener('click', () => diagram.zoom(1.25));
$('fit').addEventListener('click', () => diagram.fit());
function updateDiagramSearch(view, input, matches) {
  const count = view.find(input.value);
  matches.textContent = input.value ? `${count} zhôd` : '';
  for (const button of input.closest('.diagram-toolbar').querySelectorAll('[data-search-direction]')) button.disabled = !count;
}
function setupDiagramSearch(view, input, matches) {
  const move = direction => {
    const result = view.nextMatch(direction);
    if (result) matches.textContent = `${result.index} / ${result.total}`;
  };
  for (const button of input.closest('.diagram-toolbar').querySelectorAll('[data-search-direction]'))
    button.addEventListener('click', () => move(Number(button.dataset.searchDirection)));
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    move(event.shiftKey ? -1 : 1);
  });
}
setupDiagramSearch(diagram,$('diagram-search'),$('diagram-matches'));
$('diagram-search').addEventListener('input', () => updateDiagramSearch(diagram,$('diagram-search'),$('diagram-matches')));
document.addEventListener('keydown', event => {
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.defaultPrevented &&
      ((!$('detail').hidden && !$('diagram-panel').hidden) || document.activeElement?.closest('.extra-pane')) && !document.querySelector('dialog[open]')) {
    const zoomIn = ['+', '='].includes(event.key) || event.code === 'NumpadAdd';
    const zoomOut = event.key === '-' || event.code === 'NumpadSubtract';
    if (zoomIn || zoomOut) {
      event.preventDefault();
      const pane = extraPanes.find(p=>p.root.contains(document.activeElement));
      (pane?.view ?? diagram).zoom(zoomIn ? 1/1.25 : 1.25);
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    collapseCatalog(false);
    event.preventDefault();
    $('search').focus();
    $('search').select();
  }
});
poll();
