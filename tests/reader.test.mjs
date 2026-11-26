import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Cache, identity, normalize, search, validateId, validateSelection } from '../reader.mjs';
import { Diagram, geometry, numbers } from '../web/diagram.mjs';

test('background drag pans by default, Shift selects rows, and text keeps native selection', t => {
  const handlers = new Map(), rect = {left:0,top:0,right:100,bottom:100,width:100,height:100};
  const svg = { setAttribute(){}, classList:{toggle(){},add(){},remove(){}}, closest:()=>null,
    setPointerCapture(){}, getBoundingClientRect:()=>rect, querySelectorAll:()=>[],
    addEventListener:(name,handler)=>handlers.set(name,handler) };
  const frame = {style:{},remove(){}};
  const doc = {createElementNS:()=>svg,createElement:()=>frame,getSelection:()=>({removeAllRanges(){}})};
  globalThis.document = doc;
  globalThis.ResizeObserver = class {observe(){}};
  t.after(()=>{delete globalThis.document; delete globalThis.ResizeObserver;});
  const frames = [];
  const view = new Diagram({closest:()=>null,replaceChildren(){},addEventListener(){},focus(){},append:f=>frames.push(f)});
  view.box=[40,40,100,100];
  view.update=()=>{};
  const press = {pointerId:1,isPrimary:true,button:0,clientX:10,clientY:10,target:svg,preventDefault(){}};
  const move = {...press,clientX:30,clientY:20};
  handlers.get('pointerdown')(press);
  handlers.get('pointermove')({...move,shiftKey:true});
  handlers.get('pointerup')(move);
  assert.deepEqual(view.box,[20,30,100,100]);
  handlers.get('pointerdown')({...press,shiftKey:true});
  handlers.get('pointermove')(move);
  handlers.get('pointerup')(move);
  assert.deepEqual(frames,[frame]);
  assert.deepEqual(view.box,[20,30,100,100]);
  handlers.get('pointerdown')({...press,target:{closest:()=>true},preventDefault:assert.fail});
  handlers.get('pointermove')(move);
  assert.deepEqual(view.box,[20,30,100,100]);
});

test('SQD and CLD scrolling stops at document edges, accounting for the visible SVG area', () => {
  for (const kind of ['sequence', 'class']) {
    const diagram = { data: { uml: { kind } }, initial: [0, 0, 960, 2000],
      svg: { getBoundingClientRect: () => ({ width: 800, height: 500 }), setAttribute() {} } };
    for (const [box, expected] of [
      [[-200, -900, 400, 200], [0, 0]],
      [[2000, 3000, 400, 200], [560, 1750]],
      [[50, 80, 400, 200], [50, 80]],
      [[200, 300, 2400, 2000], [0, 0]],
    ]) {
      diagram.box = box;
      Diagram.prototype.update.call(diagram);
      assert.deepEqual(diagram.box.slice(0, 2), expected);
    }
    diagram.svg.getBoundingClientRect = () => ({left:300,width:800,height:500});
    for (const [dividerWidth, dividerLeft, expectedX] of [[6,900,660],[6,740,740],[0,0,560]]) {
      diagram.inspectorDivider = {getBoundingClientRect:()=>({width:dividerWidth,left:dividerLeft})};
      diagram.box = [2000,3000,400,200];
      Diagram.prototype.update.call(diagram);
      assert.deepEqual(diagram.box,[expectedX,1750,400,200]);
    }
  }
});

const selection = { server: 'server', repository: 'repository', model: 'model' };
const first = { id: 'a', name: 'Prihlásenie používateľa', path: 'Portál/Prihlásenie', type: 'Use Case Diagram' };
const second = { id: 'b', name: 'Žiadosť', path: 'Portál/Žiadosť', type: 'Class' };

test('search ignores case/accents and matches all words across names, paths and loaded text', () => {
  const entries = new Map([[first.id, first], [second.id, second]]);
  const details = new Map([['b', { attributes: { Popis: 'Odoslanie potvrdeného formulára' } }]]);
  assert.equal(normalize('PRIHLÁSENIE'), 'prihlasenie');
  assert.deepEqual(search(entries, details, { query: 'PRIHLASENIE pouzivatela' }).items, [first]);
  assert.deepEqual(search(entries, details, { query: 'potvrdeneho formulara' }).items, [second]);
  assert.equal(search(entries, details, { query: 'portal', kind: 'diagrams' }).total, 1);
  assert.equal(search(entries, details, { kind: 'dictionary', type: 'Class' }).total, 1);
  assert.equal(search(entries, details, { query: 'neexistuje' }).total, 0);
  assert.equal(search(entries, details, { offset: 1, limit: 1 }).items.length, 1);
});

test('a compact query finds adjacent words in a diagram name without joining separate fields', () => {
  const diagram = { id: 'd', name: 'Pr2 Portál WS Rozhodnutie Export rozhodnutí', type: 'Class Diagram' };
  const other = { ...diagram, id: 'e', name: 'Export', path: 'Rozhodnutí' };
  const entries = new Map([[diagram.id, diagram], [other.id, other]]);
  assert.deepEqual(search(entries, new Map(), { kind: 'diagrams', query: 'exportrozhodnuti' }).items, [diagram]);
});

test('selection identity isolates server, repository and model and prevents invalid inputs', () => {
  assert.equal(identity(selection), identity({ ...selection, server: 'SERVER' }));
  assert.notEqual(identity(selection), identity({ ...selection, repository: 'other' }));
  assert.deepEqual(validateSelection(selection), selection);
  assert.throws(() => validateSelection({ ...selection, server: '../../test' }));
  assert.throws(() => validateSelection({ ...selection, model: '' }));
  assert.equal(validateId('a123-b456'), 'a123-b456');
  assert.throws(() => validateId('../secret'));
});

test('cache persists complete and partial copies atomically and reports corruption', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'select-reader-test-'));
  try {
    const cache = new Cache(directory);
    assert.equal(await cache.load(selection), null);
    assert.deepEqual(await cache.history(), []);
    const data = { version: 1, selection, entries: [first], details: [], complete: false, updatedAt: new Date().toISOString() };
    await Promise.all([cache.save(data), cache.save({ ...data, complete: true, entries: [first, second] })]);
    assert.equal((await cache.load(selection)).entries.length, 2);
    assert.equal((await cache.history())[0].complete, true);
    assert.equal(JSON.parse(await readFile(cache.filename(selection), 'utf8')).version, 1);
    await writeFile(cache.filename(selection), '{bad', 'utf8');
    await assert.rejects(cache.load(selection), /nemožno načítať/);
    await assert.rejects(cache.history());
  } finally { await rm(directory, { recursive: true }); }
});

test('diagram geometry preserves coordinates and rejects missing positions rather than inventing layout', () => {
  assert.deepEqual(numbers('(120.5, -40.25)'), [120.5, -40.25]);
  assert.deepEqual(numbers('1e3 5e-2'), [1000, .05]);
  assert.deepEqual(geometry({ fields: { Position: '20 40', Width: '100', Height: '60' } }),
    { x: 20, y: 40, width: 100, height: 60, points: [[20, 40]] });
  assert.equal(geometry({ fields: { Width: '100' } }), null);
});

test('warm local name/text search over 20000 objects stays under 200 ms', t => {
  const entries = new Map(), details = new Map();
  for (let index = 0; index < 20000; index++) {
    const id = String(index);
    entries.set(id, { id, name: `Objekt ${index}`, path: `Portál/Balík ${index % 50}`, type: 'Class' });
    details.set(id, { attributes: { Popis: `${index % 10 === 0 ? 'Potvrdenie žiadosti' : 'Spracovanie formulára'} ${'text '.repeat(60)}` } });
  }
  search(entries, details, { query: 'potvrdenie' });
  const started = performance.now();
  const result = search(entries, details, { query: 'potvrdenie ziadosti' });
  const elapsed = performance.now() - started;
  assert.equal(result.total, 2000);
  assert.ok(elapsed < 200, `Search took ${elapsed.toFixed(1)} ms`);
  t.diagnostic(`20000 objects, 2000 text matches: ${elapsed.toFixed(1)} ms`);
  details.set('1', { attributes: { Popis: 'Nový opis so zmenou' } });
  assert.equal(search(entries, details, { query: 'novy opis' }).total, 1);
});
