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
  function setupDivider(id, paneId, variable, direction) {
    const divider = $(id), pane = $(paneId), key = `select-reader:${variable}`;
    const stored = Number(localStorage.getItem(key));
    const setWidth = width => document.documentElement.style.setProperty(variable, `${width}px`);
    if (Number.isFinite(stored) && stored > 0) setWidth(stored);
    const width = () => Math.round(pane.getBoundingClientRect().width);
    const resize = next => {
      setWidth(Math.max(1,next));
      setWidth(width()); // Use the responsive CSS limits, including after a viewport resize.
    };
    new ResizeObserver(() => {
      const w=width(), available=divider.parentElement.clientWidth;
      if (!w) return;
      divider.setAttribute('aria-valuemin', String(direction===1 ? 180 : Math.round(Math.min(160,available*.45))));
      divider.setAttribute('aria-valuemax', String(Math.round(available*(direction===1 ? .55 : .65))));
      divider.setAttribute('aria-valuenow',String(w));
      divider.setAttribute('aria-valuetext',`${w} px`);
    }).observe(pane);
    let drag;
    divider.addEventListener('pointerdown', e => {
      if (e.button!==0 || !e.isPrimary) return;
      drag={id:e.pointerId,x:e.clientX,width:width()};
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    divider.addEventListener('pointermove', e => {
      if (drag?.id===e.pointerId) resize(drag.width+direction*(e.clientX-drag.x));
    });
    divider.addEventListener('lostpointercapture', () => {
      if (drag) localStorage.setItem(key,String(width()));
      drag=null;
    });
    divider.addEventListener('keydown', e => {
      if (!['ArrowLeft','ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      resize(width() + direction*(e.key==='ArrowLeft' ? -16 : 16));
      localStorage.setItem(key,String(width()));
    });
  }
  setupDivider('catalog-divider','catalog','--catalog-width',1);
  setupDivider('inspector-divider','class-inspector','--inspector-width',-1);
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
let inspectedElement = null;
let inspectorSequence = 0;
const diagram = new Diagram($('diagram'), $('diagram-notice'), (id, link) => {
  if (['sequence', 'class'].includes(diagram.data?.uml?.kind))
    return inspectDiagramElement(link === 'callers' ? selectedId : id, link);
  return openDetail(id);
});

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

let presence, leaving = false;
function trackPresence() {
  if (presence) return;
  if (typeof SharedWorker !== 'undefined') presence = new SharedWorker('/presence.js');
  else presence = new EventSource('/api/presence');
}
$('reader-controls').onclick = () => $('reader-dialog').showModal();
$('reader-close').onclick = () => $('reader-dialog').close();
for (const command of ['stop','restart']) {
  $(`reader-${command}`).onclick = async () => {
    if (!confirm(command==='restart' ? 'Reštartovať Reader pre všetky karty? Model bude potrebné znovu otvoriť.' : 'Vypnúť lokálny Reader pre všetky karty?')) return;
    try {
      await api(`/api/reader/${command}`,{});
    } catch (error) { setText('reader-status',error.message); return; }
    leaving=true;
    clearTimeout(pollTimer);
    for(const id of ['reader-close','reader-restart','reader-stop']) $(id).disabled=true;
    $('reader-dialog').oncancel=e=>e.preventDefault();
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
    const next = await api('/api/state');
    const changed = !state || state.count !== next.count || state.detailCount !== next.detailCount ||
      state.status.phase !== next.status.phase;
    const modelChanged = JSON.stringify(state?.selection) !== JSON.stringify(next.selection) || state?.offline !== next.offline;
    state = next;
    if (modelChanged) {
      diagramTrail.length = 0;
      diagramTabs.clear();
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
  $('reader-controls').hidden = !state.lifecycle;
  if(state.lifecycle)trackPresence();
  $('welcome').hidden = Boolean(selection);
  const indexing = !!selection && !state.offline && status.phase === 'loading';
  $('catalog-loading').hidden = !indexing;
  if (indexing) setText('catalog-progress', `Načítavam katalóg${status.current ? ` · ${status.current}` : '…'}`);
  $('retry-index').hidden = !selection || state.offline || !['partial','error'].includes(status.phase);
  $('retry-missing').hidden = !(state.missingTypeCount > 0);
  if (state.missingTypeCount) setText('retry-missing', `Dočítať chýbajúce typy (${state.missingTypeCount})`);
  renderExport(state.markdownExport ?? {phase:'idle'});
  setText('model-name', selection?.model ?? 'Žiadny otvorený model');
  setText('model-location', selection ? `${selection.server} / ${selection.repository}` : 'Pripoj server alebo otvor lokálnu kópiu');
  setText('snapshot', selection ? `${state.offline ? 'Offline · ' : ''}${state.catalogComplete ? 'Úplný katalóg' : 'Čiastočný katalóg'} · ${state.count.toLocaleString('sk')} objektov${state.updatedAt ? ` · kópia ${formatTime(state.updatedAt)}` : ''}` : '');
  if (status.error && status.phase !== 'partial') showError(new Error(status.error));
  $('search-scope-note').hidden = !selection || state.catalogComplete;
  $('search-scope-note').title = status.phase === 'partial' ? status.error : state.searchScope;
  setText('coverage', selection ? `${state.searchScope} ${state.catalogComplete ? '' : 'Katalóg nie je úplný.'} ${state.detailCount} uložených detailov.` : 'Vyber model zo servera alebo otvor lokálnu kópiu.');
  let diagrams = 0, dictionary = 0;
  for (const [type, count] of Object.entries(state.types)) {
    if (/\bdiagram\b/i.test(type)) diagrams += count; else dictionary += count;
  }

  renderCatalogControls(diagrams, dictionary);
}

let pickingExportFolder = false;
let exportClock;
let detailStartedAt;
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
  if (detailStartedAt != null && !$('detail').hidden) setText('detail-clock',formatElapsed(performance.now()-detailStartedAt));
}, 1000);
function renderExport(job) {
    const online = state?.selection && !state.offline;
    $('export-md').disabled = !online && job.phase === 'idle';
    $('export-start').disabled = !online || !!job.active || pickingExportFolder;
    $('export-browse').disabled = !!job.active || pickingExportFolder;
    $('export-default').hidden = !$('export-folder').value || !!job.active || pickingExportFolder;
    $('export-stop').hidden = !job.active;
    $('export-resume').hidden = !online || !job.run || !['failed','cancelled'].includes(job.phase);
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
      const job = await api(`/api/export/${command}`,{
        resume, ...(command === 'start' && !resume ? { folder: $('export-folder').value } : {})
      });
      renderExport(job);
      if (command === 'start') $('export-dialog').close();
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
    if (entry.type === 'Class Diagram' || entry.type === 'Object Sequence Diagram') {
      const mark = document.createElement('span'), cld = entry.type === 'Class Diagram';
      mark.className = cld ? 'result-class' : 'result-sequence';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = cld ? '▤' : '⇄';
      button.append(mark);
    }
    button.append(name);
    button.setAttribute('aria-label', `${name.textContent}, ${entry.type}`);
    button.title = entry.path;
    button.addEventListener('click', () => openDetail(entry.id, entry));
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

async function followDiagram(id) {
  closeInspector();
  const sequence = ++detailSequence, panel = $('diagram-links');
  panel.hidden = false;
  panel.textContent = 'Hľadám súvisiaci diagram…';
  const read = async key => (await api(`/api/item/${encodeURIComponent(key)}`)).detail.relations;
  const navigate = entry => {
    if (sequence !== detailSequence) return;
    diagramTrail.push(selectedEntry);
    return openDetail(entry.id, entry, true);
  };
  try {
    const relations = await read(id), targets = new Map();
    const collect = (relations, role, type) => {
      for (const r of relations) if (r.role === role && r.item.nativeClass === type) targets.set(r.item.id, r.item);
    };
    for (const r of relations) {
      if (sequence !== detailSequence) return;
      if (r.role === '_Ent2_Class_To_CDClass' && r.item.nativeClass === '_Ent2_CDClass')
        collect(await read(r.item.id), '_Ent2_Symbol_To_Diagram', '_Ent2_ClassDiagram');
    }
    if (sequence !== detailSequence) return;
    const choices = [...targets.values()].sort((a, b) => a.name.localeCompare(b.name, 'sk'));
    if (choices.length === 1) return navigate(choices[0]);
    panel.textContent = choices.length ? 'Vyber cieľový diagram: ' : 'Prvok nemá priradený diagram tohto typu.';
    for (const entry of choices) {
      const button = document.createElement('button');
      button.textContent = entry.name;
      button.title = entry.path;
      button.addEventListener('click', () => navigate(entry));
      panel.append(button);
    }
  } catch (error) {
    if (sequence === detailSequence) panel.textContent = `Súvisiaci diagram sa nepodarilo načítať: ${error.message}`;
  }
}

$('diagram-back').addEventListener('click', () => {
  const entry = diagramTrail.pop();
  if (entry) openDetail(entry.id, entry, true);
});

$('refresh-diagram').addEventListener('click', () => openDetail(selectedId, selectedEntry, true, true));

function renderDiagramTabs(focus = false) {
  const bar = $('diagram-tabs');
  bar.hidden = !diagramTabs.size;
  bar.replaceChildren();
  for (const [id, tab] of diagramTabs) {
    const group = document.createElement('span'), button = document.createElement('button'), close = document.createElement('button');
    group.className = 'diagram-tab';
    button.setAttribute('role','tab');
    button.setAttribute('aria-controls','detail');
    button.setAttribute('aria-selected',String(id === selectedId));
    button.tabIndex = id === selectedId || (!diagramTabs.has(selectedId) && !bar.childElementCount) ? 0 : -1;
    button.title = button.textContent = tab.entry.name;
    const activate = () => {
      if (id !== selectedId) openDetail(id, tab.entry);
      bar.querySelector('[aria-selected=true]')?.focus();
    };
    button.addEventListener('click', activate);
    close.textContent = '×';
    close.setAttribute('aria-label',`Zavrieť kartu: ${tab.entry.name}`);
    close.title = 'Zavrieť kartu';
    close.addEventListener('click', () => closeDiagramTab(id));
    group.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); closeDiagramTab(id); } });
    button.addEventListener('keydown', e => {
      const ids = [...diagramTabs.keys()], i = ids.indexOf(id);
      if (e.key === 'Delete') { e.preventDefault(); closeDiagramTab(id); return; }
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
  detailStartedAt = null;
  selectedEntry = selectedId = null;
  diagramTrail.length = 0;
  closeInspector();
  $('detail').hidden = true;
  renderDiagramTabs();
  renderResults();
  $('search').focus();
}

async function openDetail(id, entry = null, linked = false, refresh = false) {
  const old = diagramTabs.get(selectedId);
  if (old && selectedId === id && !refresh && old.loaded) return;
  if (old?.loaded && !$('diagram-panel').hidden) {
    old.box = diagram.box ? [...diagram.box] : null;
    old.query = $('diagram-search').value;
    old.inspector = inspectedElement;
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
  $('welcome').hidden = true;
  $('detail').hidden = false;
  detailStartedAt = performance.now();
  setText('detail-clock',formatElapsed(0));
  $('detail-loading').hidden = false;
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
  $('object-relations').open = false;
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
      warnings.unshift('Táto stará offline kópia ešte neobsahuje UML význam tried a správ. Otvor model online pre nové načítanie.');
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
      if (tab?.inspector) inspectDiagramElement(tab.inspector.id, tab.inspector.link);
    }
  } catch (error) {
    if (sequence === detailSequence) showError(error, 'detail-error');
  } finally {
    if (sequence === detailSequence) {
      $('detail-loading').hidden = true;
      detailStartedAt = null;
      $('refresh-diagram').disabled = false;
    }
  }
}

function setDetailType(type) {
  $('refresh-diagram').hidden = state?.offline || !/\bdiagram$/i.test(type);
  $('detail-type').textContent = type;
  $('detail').classList.toggle('sequence-detail', type === 'Object Sequence Diagram');
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

function closeInspector() {
  inspectorSequence++;
  inspectedElement = null;
  $('class-inspector').hidden = true;
}
$('close-inspector').addEventListener('click', closeInspector);

async function inspectDiagramElement(id, link) {
  inspectedElement = {id,link};
  const sequence = ++inspectorSequence, owner = detailSequence;
  const current = () => sequence === inspectorSequence && owner === detailSequence;
  const panel = $('inspector-fields');
  $('class-inspector').hidden = false;
  $('inspector-name').textContent = 'Detail prvku';
  panel.textContent = 'Načítavam…';
  try {
    const { entry, detail } = await api(`/api/item/${encodeURIComponent(id)}`);
    if (!current()) return;
    $('inspector-name').textContent = entry.name;
    panel.replaceChildren();
    const diagramLink = target => {
      const link = document.createElement('a');
      link.href = '#diagram';
      link.className = 'sqd-link';
      link.setAttribute('aria-label', `Otvoriť SQD: ${target.name}`);
      const arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↗';
      link.append(arrow, target.name);
      link.addEventListener('click', event => {
        event.preventDefault();
        diagramTrail.push(selectedEntry);
        openDetail(target.id, target, true);
      });
      return link;
    };
    if (link === 'class') {
      const button = document.createElement('button');
      button.textContent = 'Otvoriť súvisiaci CLD';
      button.addEventListener('click', () => followDiagram(id));
      panel.append(button);
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
    label.textContent = `Súvislosti (${detail.relations.length})`;
    relations.append(label);
    relations.addEventListener('toggle', () => {
      if (relations.open && relations.childElementCount === 1 && !relations.dataset.rendered) {
        renderRelations(detail.relations, relations, related => inspectDiagramElement(related.id));
        relations.dataset.rendered = 'true';
      }
    });
    panel.append(relations);
    if (link === 'sequence' || link === 'callers') {
      const section=document.createElement('section'), heading=document.createElement('h3'), list=document.createElement('div');
      heading.textContent='Volané z SQD';
      list.textContent='Načítavam prepojenia…';
      section.append(heading,list);
      panel.insertBefore(section,properties);
      const readRelations=async key=>(await api(`/api/item/${encodeURIComponent(key)}`)).detail.relations;
      try {
        const ownerRelations=[];
        if(link==='sequence') ownerRelations.push(detail.relations);
        else for(const r of detail.relations.filter(r=>r.role==='_Ent2_ObjectSequenceDiagram_To_ParentOSD')) {
          if(!current())return;
          ownerRelations.push(await readRelations(r.item.id));
        }
        const callers=new Map();
        const probes=new Set(ownerRelations.flat().filter(r=>r.item.nativeClass==='_Ent2_OSDProbe' && r.role.endsWith('_To_OSDProbe')).map(r=>r.item.id));
        for(const probe of probes) {
          if(!current())return;
          for(const r of await readRelations(probe))
            if(r.role==='_Ent2_Symbol_To_Diagram' && r.item.nativeClass==='_Ent2_ObjectSequenceDiagram') callers.set(r.item.id,r.item);
        }
        if(!current())return;
        list.replaceChildren(...[...callers.values()].sort((a,b)=>a.name.localeCompare(b.name,'sk')).map(diagramLink));
        if(!callers.size)list.textContent='Žiadny SQD na tento cieľ neodkazuje cez probe.';
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
  const storageKey = 'select-reader:pinned-properties';
  const pinned = new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
  const fixed = new Map([['Description','Description'], ['Popis','Popis'], ['AttributeDeclarations','Attribute declaration'],
    ['AttributeDeclaration','Attribute declaration'], ['Attribute declaration','Attribute declaration']]);
  function draw(focusKey) {
    visible.replaceChildren();
    other.replaceChildren();
    let remaining = 0;
    for (const [key,label] of fixed) {
      if (Object.hasOwn(attributes, key)) renderAttributes({ [label]: attributes[key] || 'Nevyplnené' }, visible);
    }
    for (const key of Object.keys(attributes).filter(key => !fixed.has(key)).sort((a,b) => a.localeCompare(b,'sk'))) {
      const active = pinned.has(key), parent = active ? visible : other;
      if (!active) remaining++;
      renderAttributes({ [key]: attributes[key] }, parent);
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'property-star';
      star.textContent = active ? '★' : '☆';
      star.setAttribute('aria-pressed', String(active));
      star.title = `${active ? 'Odobrať z predvolených' : 'Pridať medzi predvolené'}: ${key}`;
      star.setAttribute('aria-label', star.title);
      star.addEventListener('click', () => {
        const next = new Set(pinned);
        if (active) next.delete(key); else next.add(key);
        try { localStorage.setItem(storageKey, JSON.stringify([...next])); }
        catch (error) { showError(error); return; }
        if (active) { pinned.delete(key); more.open = true; } else pinned.add(key);
        draw(key);
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

function renderRelations(relations, panel = $('relations-panel'), inspect = entry => openDetail(entry.id, entry)) {
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
  if (!relations.length) panel.append('Pre tento objekt neboli načítané žiadne súvislosti.');
}

function updateFavorite() {
  const enabled = favorites.has(selectedId);
  $('favorite').textContent = enabled ? '★' : '☆';
  $('favorite').setAttribute('aria-pressed', String(enabled));
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
$('welcome-choose').addEventListener('click', showPicker);
$('close-picker').addEventListener('click', closePicker);
$('server').addEventListener('input', () => {
  repositoryGeneration++;
  $('windows-status').textContent = '';
  $('auth-plaintext').checked = false;
  $('auth-port').value = '';
  updateAuthenticationMode();
  populateRepositories();
});
$('server').addEventListener('change', () => { if ($('server').value.trim()) discoverRepositories(); });
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
  $('picker-status').textContent = 'Priame TCP spojenie s databázovým brokerom…';
  try {
    const result = await api('/api/repositories', { server });
    if (generation !== repositoryGeneration) return;
    repositories = result.repositories;
    discoveredServer = server.toLowerCase();
    const servers = [...new Set(repositories.map(repository => repository.server))];
    $('servers').replaceChildren(...servers.map(server => new Option(server, server)));
    if (!$('server').value && servers.length) $('server').value = servers[0];
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
$('favorite').addEventListener('click', handle(async () => {
  if (favorites.has(selectedId)) favorites.delete(selectedId); else favorites.add(selectedId);
  localStorage.setItem(favoriteKey(), JSON.stringify([...favorites]));
  updateFavorite();
  renderResults();
}));
$('zoom-in').addEventListener('click', () => diagram.zoom(1 / 1.25));
$('zoom-out').addEventListener('click', () => diagram.zoom(1.25));
$('fit').addEventListener('click', () => diagram.fit());
$('diagram-search').addEventListener('input', () => {
  const count = diagram.find($('diagram-search').value);
  $('diagram-matches').textContent = $('diagram-search').value ? `${count} zhôd` : '';
});
document.addEventListener('keydown', event => {
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.defaultPrevented &&
      !$('detail').hidden && !$('diagram-panel').hidden && !document.querySelector('dialog[open]')) {
    const zoomIn = ['+', '='].includes(event.key) || event.code === 'NumpadAdd';
    const zoomOut = event.key === '-' || event.code === 'NumpadSubtract';
    if (zoomIn || zoomOut) {
      event.preventDefault();
      $(zoomIn ? 'zoom-in' : 'zoom-out').click();
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('search').focus();
    $('search').select();
  }
});
poll();
