import test from 'node:test';
import assert from 'node:assert/strict';
import { classDiagramData, sequenceDiagramData } from '../uml-data.mjs';
import { classLayout, classRoute, crossingPath, renderUml, sequenceLayout } from '../web/uml.mjs';
import { textMatches } from '../web/diagram.mjs';

test('diagram search finds each visible occurrence case-insensitively and without accents', () => {
  assert.deepEqual(textMatches('Rozhodnutie a ROZHODNUTIE', 'rozhod'), [[0,5],[14,19]]);
  assert.deepEqual(textMatches('PÔŽIČKA pôžička', 'pozicka'), [[0,6],[8,14]]);
  assert.deepEqual(textMatches('😀 Rozhodnutie', 'rozhod'), [[3,8]]);
  assert.deepEqual(textMatches('abcd', '  '), []);
  assert.deepEqual(textMatches('ababa', 'aba'), [[0,2]]);
});

const item = (id, name, nativeClass) => ({ id, name, nativeClass, nativeId: id });
const relation = (role, item) => ({ role, item });
const data = (attributes = {}, relations = []) => ({ attributes, relations });

function mockSvg(t) {
  const svgNode = tag => ({ tag, attrs: {}, children: [], dataset: {}, addEventListener() {},
    append(child) { this.children.push(child); }, setAttribute(k, v) { this.attrs[k] = v; } });
  t.after(() => { delete globalThis.document; });
  globalThis.document = { createElementNS: (_, tag) => svgNode(tag),
    createElement: () => ({ getContext: () => ({ measureText: s => ({ width: s.length * 8 }) }) }) };
  return svgNode('svg');
}

test('confirmation diagram places all relationship captions outside class boxes, lines and other captions', t => {
  const svg = mockSvg(t);
  const classes = ['VratenieUdajovPrePotvrdenieNastupu','Vstup','Vystup','SaSZ','Dieta'].map((name,i)=>({
    id:String(i),name,attributes:Array.from({length:[0,1,2,6,3][i]},()=>({name:'field'})),operations:[]}));
  const edges = [['0','1'],['0','2'],['2','3'],['2','4']].map(([a,b],i)=>({
    ends:[{classId:a,multiplicity:'0..1'},{classId:b,multiplicity:'1'}],label:String(i%2+1)}));
  for (const c of classes) c.target={id:c.id};
  renderUml(svg,{kind:'class',classes,edges,notes:[]},null);
  const obstacles=svg.children.filter(g=>g.attrs.class==='symbol uml-class').map(g=>{
    const {x,y,width,height}=g.children.find(c=>c.tag==='rect').attrs;
    return [x,y,x+width,y+height];
  });
  const groups=svg.children.filter(g=>g.attrs.class==='symbol uml-association');
  for (const group of groups) {
    const points=group.children.find(c=>c.tag==='path').attrs.d.matchAll(/([ML])([-\d.]+),([-\d.]+)/g);
    let x,y;
    for (const [,cmd,u,v] of points) {
      if (cmd==='L') obstacles.push([Math.min(x,+u),Math.min(y,+v),Math.max(x,+u),Math.max(y,+v)]);
      x=+u; y=+v;
    }
  }
  const captions=groups.flatMap(g=>g.children.filter(c=>c.tag==='text'));
  assert.equal(captions.length,12);
  for (const c of captions) {
    const {x,y}=c.attrs, right=x+8*c.textContent.length;
    assert.ok(obstacles.every(([l,t,r,b])=>r<=x || l>=right || b<=y-13 || t>=y+2),c.textContent);
    obstacles.push([x,y-13,right,y+2]);
  }
});

test('a stored note link connects the note box to the referenced class symbol only', t => {
  const svg = mockSvg(t);
  const uml = { kind: 'class', classes: ['A', 'B'].map(id => ({ id, name: id, attributes: [], operations: [] })),
    edges: [], notes: [{ id: 'n', text: 'attached' }, { id: 'u', text: 'B' }] };
  const link = (note, target) => ({ nativeClass: '_Ent2_NoteLink', relations: [
    relation('_Ent2_NoteLink_To_Note', { id: note }), relation('_Ent2_AttachedNoteLink_To_Symbol', { id: target })] });
  renderUml(svg, uml, null, { symbols: [link('n', 'B'), link('u', 'absent')] });
  const connectors = svg.children.filter(n => n.tag === 'polyline' && n.attrs['stroke-dasharray']);
  assert.equal(connectors.length, 1);
  const points = connectors[0].attrs.points.split(' ').map(pair=>pair.split(',').map(Number));
  const cls = svg.children.find(n => n.attrs['aria-label'] === 'B').children[0].attrs;
  const [attached, unbound] = svg.children.filter(n => n.tag === 'rect').map(n => n.attrs);
  assert.deepEqual(points[0], [cls.x + cls.width, cls.y + cls.height / 2]);
  assert.deepEqual(points.at(-1), [attached.x, attached.y + attached.height / 2]);
  assert.ok(unbound.y > attached.y + attached.height);
});

test('class routes bypass intervening boxes and avoid a previously drawn crossing when possible', () => {
  const box = x => ({x,y:60,width:80,height:60});
  const a = box(20), b = box(340), obstacle = box(180);
  const clear = (path, rect) => path.slice(1).every(([x,y],i) => {
    const [u,v] = path[i];
    return (x===u || y===v) && (Math.max(x,u)<=rect.x || Math.min(x,u)>=rect.x+rect.width ||
      Math.max(y,v)<=rect.y || Math.min(y,v)>=rect.y+rect.height);
  });
  assert.ok(clear(classRoute(a,b,[a,obstacle,b]), obstacle));
  const crossing = [[220,70],[220,110]];
  const detour = classRoute(a,b,[a,b],[crossing]);
  assert.ok(clear(detour,{x:219,y:70,width:2,height:40}));
  assert.ok(classRoute(a,a,[a,b]).length>=4);
});

test('class UML reads members and both semantic association ends without a global association/role index', async () => {
  const a = item('class-a', 'Account', '_Ent2_Class'), b = item('class-b', 'Owner', '_Ent2_Class');
  const attribute = item('attribute', 'name', '_Ent2_Attribute'), operation = item('operation', 'change', '_Ent2_Operation');
  const p1 = item('param-a', 'first', '_Ent2_Parameter'), p2 = item('param-b', 'second', '_Ent2_Parameter');
  const type = item('string', 'String', '_Ent2_BasicType');
  const association = item('association', 'owned by', '_Ent2_Association');
  const start = item('start', 'accounts', '_Ent2_Role'), end = item('end', 'owner', '_Ent2_Role');
  const source = new Map([
    [a.id, data({}, [relation('_Ent2_Class_To_Attribute', attribute), relation('_Ent2_Class_To_Operation', operation)])],
    [b.id, data()],
    [attribute.id, data({ IsStatic: 'true' }, [relation('_Ent2_TypedAttribute_To_DataType', type)])],
    [operation.id, data({}, [relation('_Ent2_Operation_To_Parameter', p1), relation('_Ent2_Operation_To_Parameter', p2)])],
    [p1.id, data({}, [relation('_Ent2_TypedParameter_To_DataType', type)])],
    [p2.id, data({}, [relation('_Ent2_TypedParameter_To_DataType', type)])],
    [association.id, data({ StartMultiplicityUML: '*', EndMultiplicityUML: '1' },
      [relation('_Ent2_Association_To_Role', end), relation('_Ent2_Association_To_Role', start)])],
    [start.id, data({ AssociationEnd: '0' }, [relation('_Ent2_Role_To_Class', a)])],
    [end.id, data({ AssociationEnd: '1' }, [relation('_Ent2_Role_To_Class', b)])],
  ]);
  const result = await classDiagramData([
    { id: 'a', target: a, fields: { Type: 'CD::Class' }, endpoints: [] },
    { id: 'b', target: b, fields: { Type: 'CD::Class' }, endpoints: [] },
    { id: 'ab', target: association, fields: { Type: 'CD::Association' }, endpoints: [{ id: 'a' }, { id: 'b' }] },
  ], async item => {
    assert.ok(source.has(item.id), `Unexpected global lookup ${item.id}`);
    return source.get(item.id);
  }, async () => [p2, p1]);
  assert.equal(result.classes.length, 2);
  assert.equal(result.classes[0].attributes[0].type, 'String');
  assert.equal(result.classes[0].attributes[0].target.id, 'attribute');
  assert.deepEqual(result.classes[0].operations[0].parameters, ['second: String', 'first: String']);
  assert.deepEqual(result.edges[0].ends.map(end => [end.classId, end.name, end.multiplicity]),
    [['class-a', 'accounts', '*'], ['class-b', 'owner', '1']]);
  const layout = classLayout(result);
  assert.ok(layout.nodes.every(node => node.height > 100 && node.width >= 300));
  assert.ok(layout.width >= Math.max(...layout.nodes.map(node => node.x + node.width)));
});

test('stored CLD positions preserve the input/output branches and place SaSZ below the input', () => {
  const positions = { AktualizaciaNadPrihlaskou: '855 48', SaSZ: '9 711', Vstup: '129 246', Vystup: '1623 240' };
  const classes = Object.keys(positions).map(id => ({ id, name: id, attributes: [], operations: [] }));
  const symbols = classes.map(({id}) => ({ id, fields: { Position: positions[id] } }));
  const { nodes } = classLayout({classes}, undefined, symbols);
  const [root, child, input, output] = classes.map(c => nodes.find(node => node.id === c.id));
  assert.ok(root.y + root.height < input.y);
  assert.equal(input.y, output.y);
  assert.ok(input.x < root.x && root.x < output.x);
  assert.ok(input.x + input.width < output.x);
  assert.ok(child.y > input.y + input.height && child.x + child.width / 2 > input.x &&
    child.x + child.width / 2 < input.x + input.width);
});

test('sparse native coordinates do not leave whole empty columns or rows between siblings', () => {
  const classes = ['root','left','right'].map(id => ({id, name:id, attributes:[], operations:[]}));
  const symbols = classes.map(({id}, i) => ({id, fields:{Position:['50000 0','0 600','100000 665'][i]}}));
  const { nodes: [root,left,right] } = classLayout({classes}, undefined, symbols);
  const gap = right.x - (left.x + left.width);
  assert.equal(left.y, right.y);
  assert.ok(gap > 0 && gap < left.width / 4);
  assert.ok(left.y > root.y + root.height && left.y - root.y - root.height < root.height / 2);
  assert.ok(root.x > left.x && root.x < right.x);
});

test('a tall chain folds across several columns without breaking the opening or overlapping classes', () => {
  const classes = Array.from({length:32}, (_,i) => ({id:`n${i}`, name:`class${i}`, attributes:[], operations:[]}));
  const symbols = classes.map(({id},i) => ({id, fields:{Position:`0 ${300*i}`}}));
  const {nodes,height,width} = classLayout({classes}, undefined, symbols);
  const byId = new Map(nodes.map(n => [n.id,n]));
  assert.equal(byId.size,classes.length);
  assert.ok(byId.get('n0').y < byId.get('n1').y);
  const horizontal = classes.slice(1).filter((c,i) => byId.get(c.id).y === byId.get(classes[i].id).y);
  assert.ok(horizontal.length > classes.length / 2);
  assert.ok(height < 2 * width);
  for (const a of nodes) for (const b of nodes.filter(b => b !== a && b.y === a.y))
    assert.ok(a.x + a.width < b.x || b.x + b.width < a.x);
});

test('a branch keeps its three children side by side even with staggered source positions and a shared target', () => {
  const classes = ['root','A','B','C','grandchild'].map(id => ({id,name:id,target:{id},attributes:[],operations:[]}));
  const edges = [['root','A'],['root','B'],['root','C'],['B','grandchild'],['C','grandchild']]
    .map(ids => ({type:'association', symbolIds:ids, ends:ids.map(classId => ({classId}))}));
  const symbols = classes.map(({id},i) => ({id,fields:{Position:`0 ${i*300}`}}));
  const {nodes} = classLayout({classes,edges},undefined,symbols);
  const [root,a,b,c,g] = classes.map(m => nodes.find(n => n.id === m.id));
  assert.equal(nodes.length,5);
  assert.equal(a.y,b.y); assert.equal(b.y,c.y);
  assert.ok(a.x+a.width < b.x && b.x+b.width < c.x);
  assert.equal(root.x,(a.x+c.x)/2);
  assert.ok(root.y+root.height < a.y && b.y+b.height < g.y);
});

test('dense fan-out leaves readable tracks and separate ports even for repeated links to one child', () => {
  const classes = ['Prihlaska','A','B','C','D','E'].map(id=>({id,name:id,attributes:[],operations:[]}));
  const edges = ['A','B','B','C','D','E'].map(id=>({symbolIds:['Prihlaska',id]}));
  const {nodes,fanRoutes} = classLayout({classes,edges});
  const p = nodes.find(n=>n.id==='Prihlaska'), used = [];
  const paths = [...fanRoutes].map(([e,preferred]) =>
    classRoute(p,nodes.find(n=>n.id===e.symbolIds[1]),nodes,used,[],preferred));
  assert.equal(paths.length,6);
  assert.equal(new Set(paths.map(path=>path[0][0])).size,6);
  assert.equal(new Set(paths.map(path=>path.at(-1)[0])).size,6);
  const lanes = paths.map(path=>path[1][1]).sort((a,b)=>a-b);
  assert.ok(lanes.every((lane,i)=>i===0 || lane-lanes[i-1]>=20));
});

test('sibling boxes and parallel tracks follow numeric association names before unnumbered links', () => {
  const classes = ['parent','A','B','C','D'].map(id=>({id,name:id,attributes:[],operations:[]}));
  const edges = [['A','Aggregates'],['B','10'],['C','03'],['D','01'],['C','2']]
    .map(([id,label])=>({symbolIds:['parent',id],label}));
  const {nodes,fanRoutes} = classLayout({classes,edges});
  assert.deepEqual(nodes.slice(1).sort((a,b)=>a.x-b.x).map(n=>n.id),['D','C','B','A']);
  assert.deepEqual([...fanRoutes].sort((a,b)=>a[1][0][0]-b[1][0][0]).map(([e])=>e.label),
    ['01','2','03','10','Aggregates']);
});

test('wide branches leave enough space for each actual source multiplicity', () => {
  const classes = Array.from({length:20},(_,i)=>({id:String(i),name:`C${i}`,target:{id:String(i)},attributes:[],operations:[]}));
  const edges = classes.slice(1).map(c=>({ends:[{classId:'0',multiplicity:'0..10'},{classId:c.id,multiplicity:'1'}]}));
  const {nodes,fanRoutes} = classLayout({classes,edges},s=>s.length*8);
  assert.ok(nodes[0].width > nodes[1].width);
  const ports = [...fanRoutes.values()].map(path=>path[0][0]).sort((a,b)=>a-b);
  assert.equal(ports.length,19);
  assert.ok(ports.slice(1).every((x,i)=>x-ports[i] > '0..10'.length*8));
});

test('converging links to Adresa have separate arrivals beside the direct SaSZ–Odbor link', () => {
  const classes = ['Prihlaska','Dieta','SaSZ','ZZ','Adresa','Odbor'].map(id=>({id,name:id,attributes:[],operations:[]}));
  const edges = [['Prihlaska','Dieta'],['Prihlaska','SaSZ'],['Prihlaska','ZZ'],['Dieta','Adresa'],
    ['Dieta','Adresa'],['SaSZ','Odbor'],['ZZ','Adresa']].map((symbolIds,i)=>({symbolIds,label:String(i)}));
  const {nodes,fanRoutes} = classLayout({classes,edges});
  const used = [], paths = new Map();
  for (const [edge,preferred] of fanRoutes) {
    const [a,b] = edge.symbolIds.map(id=>nodes.find(n=>n.id===id));
    paths.set(edge,classRoute(a,b,nodes,used,[],preferred));
  }
  assert.equal(new Set(edges.filter(e=>e.symbolIds[1]==='Adresa').map(e=>paths.get(e).at(-1)[0])).size,3);
  const direct = paths.get(edges[5]);
  assert.equal(direct.length,2);
  assert.equal(direct[0][0],direct[1][0]);
  assert.equal(crossingPath([[10,0],[10,60]],[[[0,30],[50,30]]]),'M10,0 L10,26 M10,34 L10,60');
});

test('the output-to-automat branch clears the bottom of the taller adjacent input', () => {
  const classes = ['root','Vstup','Vystup','Automat','Prihlaska','A','B','C'].map(id=>({id,name:id,
    attributes:id==='Vstup'?[{name:'a'},{name:'b'},{name:'c'}]:[], operations:[]}));
  const edges = [['root','Vstup'],['root','Vystup'],['Vystup','Automat'],['Vystup','Prihlaska'],
    ['Prihlaska','A'],['Prihlaska','B'],['Prihlaska','C']]
    .map((symbolIds,i)=>({symbolIds,label:String(i)}));
  const {nodes,fanRoutes} = classLayout({classes,edges});
  const used = [], input = nodes.find(n=>n.id==='Vstup');
  for (const [edge,preferred] of fanRoutes) {
    const [a,b] = edge.symbolIds.map(id=>nodes.find(n=>n.id===id));
    const path = classRoute(a,b,nodes,used,[],preferred);
    if (edge === edges[2]) {
      const underInput = path.slice(1).filter(([x,y],i)=>y===path[i][1] &&
        Math.min(x,path[i][0])<input.x+input.width && Math.max(x,path[i][0])>input.x);
      assert.ok(underInput.length && underInput.every(([,y])=>y-input.y-input.height>=24));
    }
  }
  assert.ok(fanRoutes.has(edges[2]));
});

test('a repeated class costs no additional semantic reads and retains its local symbol', async () => {
  const cache = new Map(), target = item('class', 'Account', '_Ent2_Class');
  const first = { id: 'one', target, fields: { Type: 'CD::Class' } };
  const second = { ...first, id: 'two', fields: { ...first.fields, ViewShowSignature: 'false' } };
  const read = async () => data({ Description: 'Shared definition' });
  await classDiagramData([first], read, null, cache);
  const expected = await classDiagramData([second], read, null);
  assert.deepEqual(await classDiagramData([second], assert.fail, null, cache), expected);
});

function sequence() {
  const left = item('left', 'Sender', '_Ent2_OSDInstance'), right = item('right', 'Receiver', '_Ent2_OSDInstance');
  const root = item('root', 'root', '_Ent2_OSDStep'), first = item('z-first', 'first', '_Ent2_OSDStep'), second = item('a-second', 'second', '_Ent2_OSDStep');
  const symbols = [
    { ...right, fields: { Type: 'OSD Instance', Position: '2000 0' }, target: right, relations: [] },
    { ...left, fields: { Type: 'OSD Instance', Position: '300 0' }, target: left, relations: [] },
    { ...root, fields: { Type: 'OSD Step', Text: 'Condition from model' }, relations: [
      relation('_Ent2_ParentStep_To_ChildStep', second), relation('_Ent2_ParentStep_To_ChildStep', first),
    ] },
    ...[first, second].map(step => ({ ...step, fields: { Type: 'OSD Step' }, relations: [] })),
    ...[first, second].map((step, index) => ({
      id: `m${index}`, fields: { Type: 'OSD Operation Message', ActualParameters: `${index}` },
      target: item(`operation${index}`, `Call${index}`, '_Ent2_Operation'),
      relations: [relation('_Ent2_OSDOperationMessage_To_OSDStep', step),
        relation('_Ent2_MessageSymbolStart_To_SendingObjectLine', index ? right : left),
        relation('_Ent2_MessageSymbolEnd_To_ReceivingObjectLine', index ? left : right)],
    })),
  ];
  return { symbols, first, second };
}

test('sequence UML uses stored child order, actual senders and receivers, never GUID sorting or placeholder positions', async () => {
  const { symbols, first, second } = sequence();
  const result = await sequenceDiagramData(symbols, async () => [first, second]);
  assert.deepEqual(result.participants.map(participant => participant.id), ['left', 'right']);
  assert.deepEqual(result.rows.filter(row => row.kind === 'message').map(row => [row.label, row.source, row.destination]),
    [['Call0(0)', 'left', 'right'], ['Call1(1)', 'right', 'left']]);
  assert.equal(result.stepCount, 3);
  assert.equal(result.messageCount, 2);
  const layout = sequenceLayout(result);
  assert.ok(layout.rows.every((row, index) => !index || row.y >= layout.rows[index - 1].y));
  assert.ok(layout.height > layout.rows.at(-1).y);
});

test('sequence UML reads top-level steps in the order stored on the description heading', async () => {
  const { symbols, first, second } = sequence();
  const heading = symbols[2], role = '_Ent2_OSDStructuredDescriptionHeading_To_OSDStep';
  Object.assign(heading, { nativeClass: '_Ent2_OSDStructuredDescriptionHeading', fields: { Type: 'Heading' },
    relations: [relation(role, first), relation(role, second)] });
  const result = await sequenceDiagramData(symbols, async (owner, members, orderingRole) => {
    assert.equal(owner, heading);
    assert.equal(orderingRole, role);
    assert.deepEqual(members, [first, second]);
    return [second, first];
  });
  assert.deepEqual(result.rows.filter(row => row.kind === 'message').map(row => row.id), ['m1', 'm0']);
  assert.deepEqual(result.rows.filter(row => row.kind === 'note').map(row => row.number), ['1', '2']);
  const layout = sequenceLayout(result);
  assert.equal(layout.rows[0].y, layout.rows[1].y);
  assert.equal(layout.rows[2].y, layout.rows[3].y);
  await assert.rejects(sequenceDiagramData(symbols, async () => [second, second]), /root ordering/);
});

test('sequence UML rejects ambiguous hierarchy or missing endpoints instead of inventing an order', async () => {
  const { symbols, first } = sequence();
  await assert.rejects(sequenceDiagramData(symbols, async () => [first, first]), /ordering/);
  const missingSender = structuredClone(symbols);
  missingSender.find(symbol => symbol.id === 'm0').relations = missingSender.find(symbol => symbol.id === 'm0').relations.slice(0, 1);
  await assert.rejects(sequenceDiagramData(missingSender, async () => symbols[2].relations.map(relation => relation.item)), /sender/);
});

test('only export preserves disconnected steps separately without inventing their order',async()=>{
  const {symbols,first,second}=sequence();
  const detached={id:'detached',fields:{Type:'OSD Step',Text:'Unplaced'},relations:[]};
  detached.relations.push(relation('_Ent2_ParentStep_To_ChildStep',{id:detached.id}));
  symbols.push(detached);
  const order=async()=>[first,second];
  await assert.rejects(sequenceDiagramData(symbols,order),{code:'SQD_INCOMPLETE_ORDER'});
  const u=await sequenceDiagramData(symbols,order,{allowUnplaced:true});
  assert.equal(u.unplacedCount,1);
  assert.deepEqual(u.unplaced.map(r=>r.text),['Unplaced']);
  assert.ok(!u.rows.some(r=>r.id===detached.id));
});

test('inheritance points from the stored subclass to superclass, not from link start to end', async () => {
  const sub = item('sub', 'Child', '_Ent2_Class'), base = item('base', 'Base', '_Ent2_Class');
  const symbols = [
    { id: 'sub-symbol', fields: { Type: 'CD::Class' }, target: sub, endpoints: [] },
    { id: 'base-symbol', fields: { Type: 'CD::Class' }, target: base, endpoints: [] },
    { id: 'inheritance', fields: { Type: 'CD::Generalization' }, endpoints: [], relations: [
      relation('_Ent2_GeneralizationSymbolStart_To_SuperClassSymbol', { id: 'base-symbol' }),
      relation('_Ent2_GeneralizationSymbolEnd_To_SubClassSymbol', { id: 'sub-symbol' }),
    ] },
  ];
  const result = await classDiagramData(symbols, async () => data());
  assert.equal(result.edges[0].type, 'generalization');
  assert.deepEqual(result.edges[0].symbolIds, ['sub-symbol', 'base-symbol']);
});

test('long sequence descriptions can be expanded without dropping stored text or message order', () => {
  const source = { participants: [{ id: 'a', name: 'A' }], rows: [
    { kind: 'note', text: 'Complete model description '.repeat(60) },
    { kind: 'message', label: 'Call', source: 'a', destination: 'a' },
  ] };
  const compact = sequenceLayout(source), expanded = sequenceLayout(source, { detailedSteps: true });
  assert.equal(compact.rows[0].text, source.rows[0].text);
  assert.ok(expanded.rows[0].lines.length > compact.rows[0].lines.length);
  assert.ok(expanded.rows[1].y > compact.rows[1].y);
});
