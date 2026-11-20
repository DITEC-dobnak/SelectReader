const NS = 'http://www.w3.org/2000/svg';
export function descriptionText(value) {
  if (typeof value !== 'string' || !/<(?:html|body|p|div|font|span|br|b|strong|i|em|u|ul|ol|li|table|h[1-6])(?:\s|\/?>)/i.test(value)) return value;
  // Template contents remain inert; only their text is used in the visible UI.
  const template = document.createElement('template');
  template.innerHTML = value.replace(/^\s*˛\s*(?=<)/, '');
  const fragment = template.content;
  fragment.querySelectorAll('script,style,template,title,iframe,object').forEach(el => el.remove());
  fragment.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  fragment.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6').forEach(el => {
    el.prepend('\n'); el.append('\n');
  });
  return fragment.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}
const normalize = text => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const element = (tag, attributes = {}) => {
  const result = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, value);
  return result;
};

function text(parent, value, x, y, attributes = {}) {
  const node = element('text', { x, y, 'font-size': 14, ...attributes });
  node.textContent = value;
  parent.append(node);
  return node;
}

function interactive(node, target, onOpen, diagramLink) {
  if (!target) return;
  node.dataset.target = target.id;
  if (diagramLink) {
    node.dataset.diagramLink = diagramLink;
    const title = element('title');
    title.textContent = diagramLink === 'message' ? 'Zobraziť celé znenie a detail správy' :
      diagramLink === 'sequence' ? 'Zobraziť detail odkazu na SQD' : diagramLink === 'callers' ? 'Zobraziť prepojenia SQD' : 'Zobraziť detail triedy';
    node.append(title);
  }
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onOpen(target.id, diagramLink); }
  });
}

function lines(value, width = 48) {
  const result = [];
  for (const paragraph of String(value).split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && line.length + word.length + 1 > width) { result.push(line); line = ''; }
      line += `${line ? ' ' : ''}${word}`;
    }
    result.push(line);
  }
  return result;
}

export function classLayout(data, measure = value => String(value).length * 9) {
  const nodes = [], groups = [];
  const namespaces = [...new Set(data.classes.map(item => item.namespace))].sort();
  const columnWidths = [340,340];
  const sections = namespaces.map(namespace => ({
    namespace, members: data.classes.filter(item => item.namespace === namespace).sort((a,b)=>a.name.localeCompare(b.name))
  }));
  for (const {members} of sections) members.forEach((item,i)=>{
    const column = i % 2;
    const fit = (value,font) => {
      columnWidths[column] = Math.max(columnWidths[column], Math.ceil(measure(value,font)) + 24);
    };
    fit(item.name,`${item.isAbstract?'italic ':''}600 16px Arial`);
    if (item.stereotype) fit(`«${item.stereotype}»`,'13px Arial');
    for (const m of item.attributes) fit(memberLabel(m,false),'14px Arial');
    for (const m of item.operations) fit(memberLabel(m,true,item.signature),`${m.isAbstract?'italic ':''}14px Arial`);
  });
  let y = 55;
  for (const {namespace,members} of sections) {
    const top = y;
    for (let start = 0; start < members.length; start += 2) {
      const row = members.slice(start, start + 2);
      let rowHeight = 0;
      for (const [column, item] of row.entries()) {
        const height = 88 + Math.max(1, item.attributes.length) * 21 + Math.max(1, item.operations.length) * 21;
        nodes.push({ ...item, x: 45 + column * (columnWidths[0]+100), y, width: columnWidths[column], height });
        rowHeight = Math.max(rowHeight, height);
      }
      y += rowHeight + 130;
    }
    if (namespace) groups.push({ name: namespace, x: 20, y: top - 35, width: 50 + columnWidths[0] + (members.length>1 ? 100+columnWidths[1] : 0), height: y - top - 65 });
  }
  return { nodes, groups, width: Math.max(500, ...nodes.map(node => node.x + node.width + 90)), height: y + 40 };
}

export function sequenceLayout(data, { detailedSteps = false } = {}) {
  const first = data.participants[0]?.x ?? 0;
  const position = value => 700 + (value - first) * .3;
  const participants = data.participants.map((participant, index) => ({ ...participant,
    x: Number.isFinite(participant.x) ? position(participant.x) : 700 + index * 160 }));
  const boundaries = (data.boundaries ?? []).map(position);
  let y = 96, step, stepY;
  const rows = data.rows.map(row => {
    const indent = Math.min(row.depth ?? 0, 10) * 18;
    const label = row.kind === 'probe' ? `↗ ${row.label.replace(/^«probe»\s*/, '')}` : row.label;
    let labelLines = lines(row.kind === 'note' ? row.text : label, row.kind === 'note' ? Math.floor((550 - indent) / 6.4) : 72);
    if (row.kind === 'note' && !detailedSteps && labelLines.length > 3) labelLines = [...labelLines.slice(0, 2), '… celý text v detaile kroku'];
    const height = Math.max(19, labelLines.length * 15 + (row.kind === 'note' ? 4 : 12));
    const shared = row.kind !== 'note' && row.stepId && row.stepId === step;
    const top = shared ? stepY : y;
    const result = { ...row, indent, y: top, height, lines: labelLines };
    if (row.kind === 'note') { step = row.stepId; stepY = y; }
    if (shared) stepY += height;
    y = Math.max(y, top + height);
    return result;
  });
  return { participants, rows, boundaries, width: Math.max(800, ...participants.map(p => p.x + 185), ...boundaries.map(x => x + 20)), height: y + 40 };
}

function memberLabel(member, operation, signature) {
  if (!operation) return `${member.name}${member.type ? `: ${member.type}` : ''}${member.initial ? ` = ${member.initial}` : ''}`;
  return `${member.name}${signature ? `(${member.parameters.join(', ')})${member.type ? `: ${member.type}` : ''}` : '()'}`;
}

function classDiagram(svg, data, onOpen) {
  const ctx = document.createElement('canvas').getContext('2d');
  const measure = (value,font) => { ctx.font=font; return ctx.measureText(value).width; };
  const layout = classLayout(data,measure), missing = [], occupied = [];
  const defs = element('defs');
  for (const [id, path, fill] of [
    ['uml-inheritance', 'M 0 0 L 12 6 L 0 12 Z', '#fff'],
    ['uml-dependency', 'M 0 0 L 12 6 L 0 12', 'none'],
  ]) {
    const marker = element('marker', { id, viewBox: '0 0 12 12', refX: 12, refY: 6, markerWidth: 12, markerHeight: 12, orient: 'auto', markerUnits: 'userSpaceOnUse' });
    marker.append(element('path', { d: path, fill, stroke: '#315b73', 'stroke-width': 1.4 }));
    defs.append(marker);
  }
  svg.append(defs);
  for (const group of layout.groups) {
    svg.append(element('rect', { x: group.x, y: group.y, width: group.width, height: group.height, fill: '#f2f7fa', stroke: '#9ab3c1', rx: 8 }));
    text(svg, group.name, group.x + 12, group.y + 24, { 'font-weight': 600, 'text-anchor': 'start' });
  }
  for (const edge of data.edges) {
    let ends;
    if (edge.ends) ends = edge.ends.map(end => layout.nodes.find(node => node.target.id === end.classId &&
      (!edge.symbolIds || edge.symbolIds.includes(node.id))));
    else ends = edge.symbolIds.map(id => layout.nodes.find(node => node.id === id));
    if (ends.length !== 2 || ends.some(end => !end)) { missing.push(edge.id); continue; }
    const [a, b] = ends, right = b.x >= a.x, vertical = a.x === b.x, self = a.id === b.id;
    const start = self ? [a.x + a.width, a.y + a.height / 3] : vertical ? [a.x + a.width / 2, a.y + (b.y > a.y ? a.height : 0)] : [a.x + (right ? a.width : 0), a.y + a.height / 2];
    const finish = self ? [a.x + a.width, a.y + a.height * 2 / 3] : vertical ? [b.x + b.width / 2, b.y + (b.y > a.y ? 0 : b.height)] : [b.x + (right ? 0 : b.width), b.y + b.height / 2];
    const mid = (start[0] + finish[0]) / 2;
    const group = element('g', { class: 'symbol uml-association' });
    group.dataset.text = normalize([edge.label, ...(edge.ends ?? []).map(end => `${end.name} ${end.multiplicity}`)].join(' '));
    interactive(group, edge.target, onOpen);
    group.append(element('polyline', { points: (self ? [start, [start[0] + 70, start[1]], [finish[0] + 70, finish[1]], finish] :
      vertical ? [start, finish] : [start, [mid, start[1]], [mid, finish[1]], finish]).map(point => point.join(',')).join(' '),
      fill: 'none', stroke: '#315b73', 'stroke-width': 1.5,
      ...(edge.type === 'dependency' ? { 'stroke-dasharray': '6 4', 'marker-end': 'url(#uml-dependency)' } :
        edge.type === 'generalization' ? { 'marker-end': 'url(#uml-inheritance)' } : {}) }));
    if (edge.label) {
      const onVertical = self || start[1] !== finish[1];
      const x = (self ? start[0]+70 : mid) + (onVertical ? 8 : 0);
      let y = (start[1]+finish[1])/2 - (onVertical ? 0 : 7);
      const width = measure(edge.label,'14px Arial'), left = onVertical ? x : x-width/2;
      while (occupied.some(b=>left < b.right+2 && left+width > b.left-2 && Math.abs(y-b.y)<18)) y-=18;
      occupied.push({left,right:left+width,y});
      text(group,edge.label,x,y,{'text-anchor':onVertical?'start':'middle'});
    }
    for (const [index, end] of (edge.ends ?? []).entries()) {
      const point = index ? finish : start;
      const side = self || vertical || (index ? !right : right) ? 1 : -1;
      const dy = vertical && !self ? ((index===0)===(finish[1]>start[1]) ? 18 : -10) : -8;
      text(group, [end.name, end.multiplicity].filter(Boolean).join(' '), point[0] + side*8, point[1] + dy,
        { 'text-anchor': side>0 ? 'start' : 'end', 'font-size': 12 });
    }
    svg.append(group);
  }
  for (const node of layout.nodes) {
    const group = element('g', { class: 'symbol uml-class', 'aria-label': node.name });
    group.dataset.text = normalize([node.name, ...node.attributes.map(item => memberLabel(item, false)), ...node.operations.map(item => memberLabel(item, true, true))].join(' '));
    interactive(group, node.target, onOpen);
    const palette = stereotypePalette(node.stereotype);
    group.append(element('rect', { x: node.x, y: node.y, width: node.width, height: node.height, fill: palette.fill, stroke: '#111', 'stroke-width': 1.5 }));
    if (node.stereotype === 'interface') group.classList.add('interface-class');
    if (node.stereotype) text(group, `«${node.stereotype}»`, node.x + node.width / 2, node.y + 16, { 'font-size': 13 });
    text(group, node.name, node.x + node.width / 2, node.y + (node.stereotype ? 37 : 28), { 'font-size': 16, 'font-weight': 600, 'font-style': node.isAbstract ? 'italic' : 'normal' });
    let y = node.y + 49;
    group.append(element('line', { x1: node.x, y1: y, x2: node.x + node.width, y2: y, stroke: '#8fa7b4' }));
    for (const member of node.attributes) {
      const label = text(group, memberLabel(member, false), node.x + 10, y += 21, { 'text-anchor': 'start', 'text-decoration': member.isStatic ? 'underline' : 'none' });
      interactive(label, member.target, onOpen);
    }
    y += node.attributes.length ? 15 : 30;
    group.append(element('line', { x1: node.x, y1: y, x2: node.x + node.width, y2: y, stroke: '#8fa7b4' }));
    for (const member of node.operations) {
      const label = text(group, memberLabel(member, true, node.signature), node.x + 10, y += 21,
        { 'text-anchor': 'start', 'font-style': member.isAbstract ? 'italic' : 'normal', 'text-decoration': member.isStatic ? 'underline' : 'none' });
      interactive(label, member.target, onOpen);
    }
    svg.append(group);
  }
  let y = layout.height;
  for (const note of data.notes) {
    const wrapped = lines(note.text, 110);
    svg.append(element('rect', { x: 25, y, width: layout.width - 50, height: wrapped.length * 20 + 30, fill: '#fffbe8', stroke: '#c4b878' }));
    wrapped.forEach((line, index) => text(svg, line, 40, y + 24 + index * 20, { 'text-anchor': 'start' }));
    y += wrapped.length * 20 + 55;
  }
  return { box: [0, 0, layout.width, y + 20],
    notice: `${data.classes.length} tried · ${data.edges.length} vzťahov · atribúty, operácie, roly a kardinality čítané priamo z diagramu.${missing.length ? ` ${missing.length} spojení nemá zobrazené oba konce.` : ''}` };
}

function stereotypePalette(stereotype) {
  return { fill: stereotype === 'interface' ? '#0000c0' : stereotype === 'user' ? '#00df00' : 'white' };
}

function sequenceDiagram(svg, data, onOpen, options) {
  const layout = sequenceLayout(data, options), positions = new Map(layout.participants.map(participant => [participant.id, participant.x]));
  const defs = element('defs');
  const marker = element('marker', { id: 'uml-message-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.append(element('path', { d: 'M 0 0 L 10 5 L 0 10 Z', fill: '#111' }));
  defs.append(marker);
  const eventMarker = element('marker', { id: 'uml-event-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  eventMarker.append(element('path', { d: 'M 0 0 L 10 5 L 0 10', fill: 'none', stroke: '#315b73' }));
  defs.append(eventMarker);
  svg.append(defs);
  const heading = text(svg, data.title ?? '', 12, 19, { 'text-anchor': 'start', 'text-decoration': 'underline', 'font-weight': 'bold' });
  interactive(heading, { id: 'current' }, onOpen, 'callers');
  svg.append(element('rect', { x: 112, y: 58, width: 76, height: 18, fill: 'white', stroke: '#222' }));
  text(svg, 'Description', 150, 72, { 'font-size': 12 });
  for (const x of layout.boundaries)
    svg.append(element('line', { x1: x, x2: x, y1: 76, y2: layout.height, stroke: '#555', 'stroke-dasharray': '16 7' }));
  for (const [index, participant] of layout.participants.entries()) {
    svg.append(element('line', { x1: participant.x, y1: 76, x2: participant.x, y2: layout.height - 12, stroke: '#222' }));
    if (participant.systemBoundary) {
      svg.append(element('rect', { x: participant.x - 3, y: 76, width: 6, height: layout.height - 88, fill: '#ccc', stroke: '#222' }));
      continue;
    }
    const group = element('g', { class: 'symbol uml-lifeline', 'aria-label': participant.name });
    group.dataset.text = normalize(participant.name);
    interactive(group, participant.target, onOpen, participant.target?.nativeClass === '_Ent2_Class' ? 'class' : undefined);
    const labels = [...[participant.stereotype, ...(participant.custom ?? [])].filter(Boolean).map(s => `«${s}»`),
      ...(participant.instance ? [participant.instance] : []), `:${participant.name}`];
    const gap = Math.min(participant.x - (layout.participants[index - 1]?.x ?? -Infinity),
      (layout.participants[index + 1]?.x ?? Infinity) - participant.x);
    const width = Math.max(28, Math.min(gap - 4, Math.max(...labels.map(s => s.length * 7 + 10))));
    const height = labels.length * 14 + 4, top = 76 - height;
    const { fill } = stereotypePalette(participant.stereotype);
    group.append(element('rect', { x: participant.x - width / 2, y: top, width, height, fill, stroke: '#111' }));
    labels.forEach((line, i) => text(group, line, participant.x, top + 13 + i * 14, {
      class: participant.stereotype === 'interface' ? 'interface-label' : 'participant-label', 'font-size': 12,
      'text-decoration': i >= labels.length - 2 ? 'underline' : 'none',
      ...(line.length * 6.5 > width - 4 ? { textLength: width - 4, lengthAdjust: 'spacingAndGlyphs' } : {}) }));
    svg.append(group);
  }
  for (const row of layout.rows) {
    const group = element('g', { class: `symbol uml-sequence-${row.kind}` });
    group.dataset.text = normalize(row.kind === 'note' ? row.text : row.label);
    if (row.kind === 'note') {
      interactive(group, { id: row.id }, onOpen);
      const title = element('title');
      title.textContent = row.text;
      group.append(title);
      const x = 112 + row.indent;
      text(group, row.number ?? '', 12, row.y, { 'text-anchor': 'start', 'font-size': 12 });
      for (let offset = 18; offset <= row.indent; offset += 18)
        group.append(element('line', { x1: 102 + offset, x2: 102 + offset, y1: row.y - 12, y2: row.y - 12 + row.height, stroke: '#333' }));
      row.lines.forEach((line, index) => text(group, line, x, row.y + index * 15, { 'text-anchor': 'start', 'font-size': 12 }));
    } else if (row.kind === 'probe') {
      const x = positions.get(row.participant);
      if (x === undefined) throw new Error('Missing verified probe participant.');
      interactive(group, row.target, onOpen, 'sequence');
      group.append(element('line', { x1: x, y1: row.y - 6, x2: x + 145, y2: row.y - 6, stroke: '#111' }),
        element('circle', { cx: x + 145, cy: row.y - 6, r: 4, fill: 'white', stroke: '#111' }));
      row.lines.forEach((line, index) => text(group, line, x + 35, row.y + 8 + index * 15, { 'text-anchor': 'start', 'font-size': 12 }));
    } else {
      const source = positions.get(row.source), destination = positions.get(row.destination);
      if (source === undefined || destination === undefined) throw new Error('Missing verified sequence participant.');
      interactive(group, row.target, onOpen, 'message');
      const arrow = row.event ? 'url(#uml-event-arrow)' : 'url(#uml-message-arrow)';
      if (source === destination) group.append(element('polyline', { points: `${source},${row.y} ${source + 90},${row.y} ${source + 90},${row.y + 28} ${source},${row.y + 28}`,
        stroke: '#315b73', fill: 'none', 'marker-end': arrow, 'stroke-width': 1.5 }));
      else group.append(element('line', { x1: source, y1: row.y, x2: destination, y2: row.y, stroke: '#111',
        'marker-end': arrow, 'stroke-width': 1.5 }));
      if (!row.event) group.append(element('rect', { x: destination - 3, y: row.y, width: 6, height: 10, fill: '#ccc', stroke: '#222' }));
      row.lines.forEach((line, index) => text(group, line,
        (source + destination) / 2, row.y + 13 + index * 15, { 'font-size': 12 }));
    }
    svg.append(group);
  }
  return { box: [0, 0, layout.width, layout.height],
    notice: '' };
}

export function renderUml(svg, data, onOpen, options = {}) {
  if (data.kind === 'class') return classDiagram(svg, data, onOpen);
  if (data.kind === 'sequence') return sequenceDiagram(svg, data, onOpen, options);
  throw new Error('Unsupported UML diagram representation.');
}
