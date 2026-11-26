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

function edgeNodes(edge, nodes) {
  return edge.ends ? edge.ends.map(end => nodes.find(node => node.target?.id === end.classId &&
    (!edge.symbolIds || edge.symbolIds.includes(node.id)))) : edge.symbolIds.map(id => nodes.find(node => node.id === id));
}

const memberLineWidth = 700, continuationIndent = 24;
function memberLines(label, font, measure) {
  if (measure(label,font) <= memberLineWidth) return [label];
  const chars = Array.from(label), result = [];
  for (let start = 0; start < chars.length;) {
    const limit = memberLineWidth - (start ? continuationIndent : 0);
    let end = start, lastBreak = start, line = '';
    while (end < chars.length) {
      const next = line + chars[end];
      if (end > start && measure(next,font) > limit) break;
      line = next;
      end++;
      if (/[\s,]/u.test(chars[end-1])) lastBreak = end;
    }
    if (end < chars.length && lastBreak > start) end = lastBreak;
    result.push(chars.slice(start,end).join(''));
    start = end;
  }
  return result;
}

const branchNumber = edge => /^\d+$/.test(edge.label) ? Number(edge.label) : Infinity;
const endCaption = end => [end.name,end.multiplicity].filter(Boolean).join(' ');

function branchTrees(rows, edges) {
  const members = rows.flat(), order = new Map(members.map((m,i) => [m,i]));
  const children = new Map(members.map(m => [m,new Map()])), incoming = new Set();
  for (const edge of edges) {
    let [parent,child] = edgeNodes(edge,members);
    if (edge.type === 'generalization') [parent,child] = [child,parent];
    if (!parent || !child || parent === child) continue;
    const siblings = children.get(parent);
    siblings.set(child, Math.min(siblings.get(child) ?? Infinity, branchNumber(edge)));
    incoming.add(child);
  }
  const seen = new Set(), trees = [];
  for (const root of [...members.filter(m => !incoming.has(m)), ...members]) {
    if (seen.has(root)) continue;
    seen.add(root);
    const levels = [[root]], spans = new Map(), branches = new Map();
    let branched = false;
    for (const level of levels) {
      const next = [];
      for (const parent of level) {
        const siblings = children.get(parent);
        const kids = [...siblings.keys()].filter(m => !seen.has(m)).sort((a,b) =>
          siblings.get(a)-siblings.get(b) || order.get(a)-order.get(b));
        for (const m of kids) seen.add(m);
        branches.set(parent,kids);
        next.push(...kids);
        if (kids.length > 1) branched = true;
      }
      if (next.length) levels.push(next);
    }
    if (!branched) continue;
    // Reserve one slot per leaf, then center each parent over its own children.
    for (const level of [...levels].reverse()) for (const m of level)
      spans.set(m, Math.max(1, branches.get(m).reduce((sum,kid) => sum + spans.get(kid), 0)));
    const starts = new Map([[root,0]]), slots = new Map();
    for (const level of levels) for (const m of level) {
      let offset = starts.get(m);
      slots.set(m, offset + (spans.get(m)-1)/2);
      for (const kid of branches.get(m)) { starts.set(kid,offset); offset += spans.get(kid); }
    }
    // Ancestors of a wide fan need not reserve a whole descendant subtree
    // on their own (much narrower) level.
    const widestCount = Math.max(...levels.map(r => r.length));
    const widest = levels.findIndex(level => level.length === widestCount);
    for (let i = widest-1; i >= 0; i--) {
      const level = levels[i], next = levels[i+1];
      if (next.length < 3 && level.every(m => spans.get(m) <= 2)) continue;
      const center = (Math.min(...next.map(m=>slots.get(m))) + Math.max(...next.map(m=>slots.get(m))))/2;
      level.forEach((m,j) => slots.set(m,center + j - (level.length-1)/2));
    }
    const leaves = members.filter(m => branches.has(m) && !branches.get(m).length)
      .sort((a,b)=>starts.get(a)-starts.get(b));
    trees.push({levels,slots,leaves});
  }
  return trees;
}

export function classLayout(data, measure = value => String(value).length * 9, symbols = []) {
  const nodes = [], groups = [];
  const fanRoutes = new Map();
  const positions = new Map();
  for (const symbol of symbols) {
    const xy = symbol.fields?.Position?.trim().split(/\s+/).map(Number);
    if (xy?.length === 2 && xy.every(Number.isFinite)) positions.set(symbol.id, xy);
  }
  const fields = new Map(symbols.map(s=>[s.id,s.fields]));
  const classes = data.classes.map(item => {
    const f = fields.get(item.id) ?? {};
    // Older offline snapshots encoded the default business class as an empty stereotype.
    const kind = item.stereotype || (item.stereotype === '' && f.Type === 'CD::Class' && f.ViewShowStereotype === 'true' ? 'business' : '');
    return {...item, kind, stereotype:[f.ViewShowStereotype !== 'false' && kind,
      ...(f.ViewShowCustomStereotype === 'true' ? item.custom ?? [] : [])].filter(Boolean).join('», «')};
  });
  const namespaces = [...new Set(classes.map(item => item.namespace))].sort();
  const minWidth = 340, widths = new Map(), memberRows = new Map(), heights = new Map();
  const sections = namespaces.map(namespace => ({
    namespace, members: classes.filter(item => item.namespace === namespace).sort((a,b)=>a.name.localeCompare(b.name))
  }));
  const nativeScale = .4;
  const hasFrames = classes.length && classes.every(m=>positions.has(m.id) && Number(fields.get(m.id)?.Width)>0 && Number(fields.get(m.id)?.Height)>0);
  for (const item of classes) {
    let width = hasFrames ? Math.max(140,Number(fields.get(item.id).Width)*nativeScale*.75) : minWidth;
    const fit = (value,font) => {
      width = Math.max(width, Math.ceil(measure(value,font)) + 24);
    };
    fit(item.name,`${item.isAbstract?'italic ':''}600 16px Arial`);
    if (item.stereotype) fit(`«${item.stereotype}»`,'13px Arial');
    let extraLines = 0;
    const rowsFor = (members,operation) => members.map(m => {
      const font = `${operation && m.isAbstract?'italic ':''}14px Arial`;
      const rows = memberLines(memberLabel(m,operation,item.signature),font,measure);
      rows.forEach((line,i) => {
        width = Math.max(width, Math.ceil(measure(line,font)) + 24 + (i ? continuationIndent : 0));
      });
      extraLines += rows.length-1;
      return rows;
    });
    memberRows.set(item,{attributes:rowsFor(item.attributes,false), operations:rowsFor(item.operations,true)});
    heights.set(item,hasFrames ? 50 + (item.attributes.length+item.operations.length)*21 + extraLines*18 +
      (item.attributes.length && item.operations.length ? 15 : 0) + 8 :
      88 + (Math.max(1,item.attributes.length) + Math.max(1,item.operations.length))*21 + extraLines*18);
    widths.set(item,width);
  }
  let y = 55;
  const columnGap = 48, rowGap = 56;
  if (hasFrames) {
    const minX = Math.min(...classes.map(m=>positions.get(m.id)[0])), minY = Math.min(...classes.map(m=>positions.get(m.id)[1]));
    const degree = new Map(), numberedSources = new Set();
    let numberedFan = false;
    for (const edge of data.edges ?? []) {
      const ends = edgeNodes(edge,classes);
      for (const end of ends) if (end) degree.set(end,(degree.get(end) ?? 0)+1);
      const [source,target] = ends;
      if (source && target && source !== target && Number.isFinite(branchNumber(edge))) {
        if (numberedSources.has(source)) numberedFan = true;
        numberedSources.add(source);
      }
    }
    if (!numberedFan && Math.max(0,...degree.values()) < 8 && namespaces.length === 1) {
      const project = ([x,y]) => [30+(x-minX)*nativeScale,30+(y-minY)*nativeScale];
      const placed = classes.map(m=>{
        const [x,y] = project(positions.get(m.id));
        return {...m,x,y,width:widths.get(m),height:heights.get(m),memberRows:memberRows.get(m)};
      });
      // Make room locally rather than multiplying every native gap by the height of one class.
      const byX = [...placed].sort((a,b)=>a.x-b.x), byY = [...placed].sort((a,b)=>a.y-b.y);
      for (const [i,b] of byX.entries()) for (let j=0;j<i;j++) {
        const a = byX[j], [ax,ay] = positions.get(a.id), [bx,by] = positions.get(b.id);
        if (bx-ax >= Number(fields.get(a.id).Width) && bx-ax >= Math.abs(by-ay) &&
            a.y < b.y+b.height+16 && b.y < a.y+a.height+16)
          b.x = Math.max(b.x,a.x+a.width+columnGap);
      }
      for (const [i,b] of byY.entries()) for (let j=0;j<i;j++) {
        const a = byY[j];
        if (a.x < b.x+b.width+16 && b.x < a.x+a.width+16 && b.y < a.y+a.height+16)
          b.y = a.y+a.height+rowGap;
      }
      const width = Math.max(...placed.map(n=>n.x+n.width))+30, height = Math.max(...placed.map(n=>n.y+n.height))+30;
      if (width*height <= 12*placed.reduce((a,n)=>a+n.width*n.height,0))
        return {nodes:placed,groups,fanRoutes,width,height,project};
    }
  }
  for (const {namespace,members} of sections) {
    const top = y;
    const positioned = members.every(item => positions.has(item.id));
    const rows = [];
    let minX = 0, xScale = 0;
    if (positioned) {
      minX = Math.min(...members.map(item => positions.get(item.id)[0]));
      let rowY = -Infinity;
      for (const item of [...members].sort((a,b) => positions.get(a.id)[1] - positions.get(b.id)[1])) {
        const itemY = positions.get(item.id)[1];
        // Slight native offsets are common even for classes on the same row.
        if (itemY - rowY > 96) { rows.push([]); rowY = itemY; }
        rows.at(-1).push(item);
      }
      for (const row of rows) row.sort((a,b) => positions.get(a.id)[0] - positions.get(b.id)[0]);
      const span = Math.max(...members.map(item => positions.get(item.id)[0])) - minX;
      // Keep relative branch positions, but don't reserve empty native columns.
      const slots = Math.max(2, ...rows.map(row => row.length));
      xScale = span ? Math.min(.32, (slots - 1) * (minWidth + columnGap) / span) : 0;
    } else {
      for (let start = 0; start < members.length; start += 2) rows.push(members.slice(start, start + 2));
    }
    const heightOf = item => heights.get(item);
    const sectionHeight = rows.reduce((sum, row) => sum + Math.max(...row.map(heightOf)) + rowGap, 0);
    const rowWidth = row => row.reduce((sum,item) => sum + widths.get(item) + columnGap, 0);
    const wrap = rows.length >= 6 && sectionHeight > Math.max(2 * (minWidth + columnGap), ...rows.map(rowWidth)) * 1.3;
    let displayRows = rows;
    if (wrap) {
      // Keep the opening branch intact; fold the remaining levels across the page.
      const count = Math.min(5, Math.max(3, Math.ceil(Math.sqrt(members.length / 1.5))));
      displayRows = rows.slice(0, 2);
      const tail = rows.slice(2).flat();
      for (let i = 0; i < tail.length; i += count) {
        const band = tail.slice(i, i + count);
        displayRows.push(i / count % 2 ? band.reverse() : band);
      }
    }
    const treeX = new Map();
    const treeRows = [];
    for (const {levels,slots,leaves} of branchTrees(rows,data.edges ?? [])) {
      treeRows.push(...levels);
      // Pack leaf columns by their own widths; one wide box must not stretch every gap.
      const centers = [];
      let right = 0;
      for (const m of leaves) {
        centers.push(right+widths.get(m)/2);
        right += widths.get(m)+columnGap;
      }
      const left = item => {
        const slot = slots.get(item), lo = Math.max(0,Math.min(centers.length-2,Math.floor(slot)));
        return centers[lo] + (slot-lo)*(centers[lo+1]-centers[lo]) - widths.get(item)/2;
      };
      const origin = Math.min(...Array.from(slots.keys(),left));
      for (const item of slots.keys()) treeX.set(item,45 + left(item) - origin);
    }
    if (treeRows.length) displayRows = [...treeRows,
      ...displayRows.map(row => row.filter(m => !treeX.has(m))).filter(row => row.length)];
    const rowOf = new Map(displayRows.flatMap((row,i) => row.map(m => [m,i])));
    const fans = new Map(), arrivals = new Map(), trackStep = 24;
    for (const edge of data.edges ?? []) {
      const [a,b] = edgeNodes(edge,members);
      if (!a || !b || Math.abs(rowOf.get(a)-rowOf.get(b)) !== 1) continue;
      const [parent,child] = rowOf.get(a)<rowOf.get(b) ? [a,b] : [b,a];
      if (!fans.has(parent)) fans.set(parent,[]);
      const link = {edge,parent,child,reverse:parent!==a};
      fans.get(parent).push(link);
      if (!arrivals.has(child)) arrivals.set(child,[]);
      arrivals.get(child).push(link);
    }
    let sectionRight = 0;
    const placed = new Map();
    for (const [rowIndex, row] of displayRows.entries()) {
      let rowHeight = 0;
      let nextX = 45;
      for (const item of row) {
        const height = heightOf(item);
        const baseWidth = widths.get(item);
        const links = fans.get(item) ?? [];
        // Even unlabeled branches need distinct, easy-to-follow exits.
        const portSpacing = Math.max(40,...links.map(({edge,reverse}) => {
          const end = edge.ends?.[reverse ? 1 : 0];
          return end ? Math.ceil(measure(endCaption(end),'13px Arial')) + 20 : 0;
        }));
        const width = Math.max(baseWidth,(links.length+1)*portSpacing);
        const desiredX = treeX.has(item) ? treeX.get(item) :
          positioned && !(wrap && rowIndex >= 2) ? Math.max(nextX, 45 + (positions.get(item.id)[0] - minX) * xScale) : nextX;
        const x = Math.max(nextX, desiredX - (width-baseWidth)/2);
        const node = { ...item, x, y, width, height, memberRows:memberRows.get(item) };
        nodes.push(node);
        placed.set(item,node);
        sectionRight = Math.max(sectionRight, x + width);
        nextX = x + width + columnGap;
        rowHeight = Math.max(rowHeight, height);
      }
      const count = Math.max(...row.map(item => fans.get(item)?.length ?? 0),
        ...(displayRows[rowIndex+1] ?? []).map(item => arrivals.get(item)?.length ?? 0));
      y += rowHeight + rowGap + Math.max(0,count-1)*trackStep;
    }
    for (const list of arrivals.values()) list.sort((a,b) =>
      placed.get(a.parent).x-placed.get(b.parent).x || branchNumber(a.edge)-branchNumber(b.edge));
    for (const [parent,links] of fans) {
      const p = placed.get(parent);
      links.sort((a,b) => branchNumber(a.edge)-branchNumber(b.edge) || placed.get(a.child).x - placed.get(b.child).x);
      const routes = links.map((link,i) => {
        const {edge,child,reverse} = link, c = placed.get(child);
        const incoming = arrivals.get(child), j = incoming.indexOf(link);
        const start = [p.x+p.width*(i+1)/(links.length+1), p.y+p.height];
        const end = [c.x+c.width*(j+1)/(incoming.length+1), c.y];
        return {edge,reverse,start,end,arrivalLane: incoming.length-1-j, crowded:incoming.length>1};
      });
      // The outermost links turn first, so inner links do not cross them.
      routes.sort((a,b) => Math.abs(b.end[0]-b.start[0])-Math.abs(a.end[0]-a.start[0]));
      routes.forEach(({edge,reverse,start,end,arrivalLane,crowded},i) => {
        const rank = crowded && links.length < 3 ? arrivalLane : routes.length-1-i;
        const lane = Math.max(start[1]+12, end[1]-rowGap/2-rank*trackStep);
        const path = [start,[start[0],lane],[end[0],lane],end];
        fanRoutes.set(edge,reverse ? path.reverse() : path);
      });
    }
    if (namespace) groups.push({ name: namespace, x: 20, y: top - 35, width: sectionRight + 5, height: y - top - rowGap + 48 });
  }
  return { nodes, groups, fanRoutes, width: Math.max(500, ...nodes.map(node => node.x + node.width + 90)), height: y + 40 };
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
  if (!operation) return `${member.name}${member.type ? `: ${member.type}` : ''}${member.initial || member.defaultValue ? ` = ${member.initial || member.defaultValue}` : ''}${member.optional ? ' {optional}' : ''}`;
  return `${member.name}${signature ? `(${member.parameters.join(', ')})${member.type ? `: ${member.type}` : ''}` : '()'}`;
}

// A shared vertical span allows side-to-side ports, even when the tops differ.
// A stored bend can also join the side of one class to the top/bottom of another.
function nativeRoute(a,b,waypoints,project) {
  if (a===b) return;
  const coords = waypoints?.trim().split(/\s+/).map(Number);
  const bend = coords?.length===2 && coords.every(Number.isFinite) ? project(coords) : [];
  const [x,y] = bend;
  const within = (v,start,size) => v >= start+4 && v <= start+size-4;
  const port = n => within(y,n.y,n.height) && (x<n.x || x>n.x+n.width) ? [x<n.x?n.x:n.x+n.width,y] :
    within(x,n.x,n.width) && (y<n.y || y>n.y+n.height) ? [x,y<n.y?n.y:n.y+n.height] : null;
  const p = port(a), q = port(b);
  if (p && q) return [p,bend,q];
  const top = Math.max(a.y,b.y), bottom = Math.min(a.y+a.height,b.y+b.height);
  if (bottom-top >= 8 && (a.x+a.width <= b.x || b.x+b.width <= a.x)) {
    const lane = (top+bottom)/2;
    return [[a.x<b.x?a.x+a.width:a.x,lane],[a.x<b.x?b.x:b.x+b.width,lane]];
  }
  const left = Math.max(a.x,b.x), right = Math.min(a.x+a.width,b.x+b.width);
  if (right-left >= 8 && (a.y+a.height <= b.y || b.y+b.height <= a.y)) {
    const lane = (left+right)/2;
    return [[lane,a.y<b.y?a.y+a.height:a.y],[lane,a.y<b.y?b.y:b.y+b.height]];
  }
}

export function classRoute(a, b, boxes, used = [], gutters = [], preferred, keepPorts = false) {
  let best, bestCost = Infinity, bestConflicts = Infinity;
  const cx = n => n.x + n.width / 2, cy = n => n.y + n.height / 2;
  const length = (p,q) => Math.abs(p[0]-q[0]) + Math.abs(p[1]-q[1]);
  const consider = (...raw) => {
    const path = [];
    for (const point of raw) {
      const last = path.at(-1), prev = path.at(-2);
      if (last && !length(last,point)) continue;
      if (prev && length(prev,point) === length(prev,last)+length(last,point) &&
          (prev[0]===point[0] || prev[1]===point[1])) path.pop();
      path.push(point);
    }
    let cost = 12 * path.length, conflicts = 0;
    for (let i=1; i<path.length; i++) {
      const p = path[i-1], q = path[i];
      const x = Math.min(p[0],q[0]), X = Math.max(p[0],q[0]);
      const y = Math.min(p[1],q[1]), Y = Math.max(p[1],q[1]);
      // Only the first/last segment may touch its port; never enter a box.
      for (const box of boxes) {
        const pad = (box === a && i === 1) || (box === b && i === path.length-1) ? 0 : 4;
        if (X > box.x-pad && x < box.x+box.width+pad &&
            Y > box.y-pad && y < box.y+box.height+pad) return;
      }
      for (const [r,s] of used) {
        const loX = Math.min(r[0],s[0]), hiX = Math.max(r[0],s[0]);
        const loY = Math.min(r[1],s[1]), hiY = Math.max(r[1],s[1]);
        if (x===X && loX===hiX ? x===loX && Math.min(Y,hiY)>Math.max(y,loY) :
            y===Y && loY===hiY ? y===loY && Math.min(X,hiX)>Math.max(x,loX) :
            X>=loX && x<=hiX && Y>=loY && y<=hiY &&
              ![p,q].some(t => !length(t,r) || !length(t,s))) conflicts++;
      }
      if (conflicts > bestConflicts) return;
      cost += length(p,q);
    }
    if (conflicts < bestConflicts || (conflicts === bestConflicts && cost < bestCost)) {
      best = path; bestCost = cost; bestConflicts = conflicts;
    }
  };
  if (preferred) consider(...preferred);
  if (best && (keepPorts || !bestConflicts || (a !== b && a.y === b.y && preferred?.[0][1] === a.y+a.height))) {
    // Keep reserved tracks even when a shorter generic path exists.
  } else if (a === b) {
    for (const sign of [1,-1]) {
      const x = a.x + (sign===1 ? a.width : 0), y = a.y+a.height/3, Y = a.y+a.height*2/3;
      consider([x,y],[x+20*sign,y],[x+20*sign,Y],[x,Y]);
    }
  } else {
    const right = cx(b) >= cx(a), down = cy(b) >= cy(a);
    const sideA = [a.x+(right?a.width:0),cy(a)], sideB = [b.x+(right?0:b.width),cy(b)];
    const midX = (sideA[0]+sideB[0])/2;
    consider(sideA,[midX,sideA[1]],[midX,sideB[1]],sideB);
    const port = (n,other) => cx(n) + Math.max(-n.width/4,Math.min(n.width/4,(cx(other)-cx(n))/2));
    const x = port(a,b), X = port(b,a);
    const y = a.y+(down?a.height:0), Y = b.y+(down?0:b.height);
    for (const lane of [(y+Y)/2,y+(down?16:-16),Y+(down?-16:16)]) {
      consider([x,y],[x,lane],[X,lane],[X,Y]);
    }
    consider([x,y],[x,sideB[1]],sideB);
    // Every class row has a free gutter above it. Join two such gutters via
    // a nearby column gap, or via the outside of the diagram for long edges.
    const lanes = new Set([a.x-16,a.x+a.width+16,b.x-16,b.x+b.width+16,...gutters,
      Math.min(...boxes.map(n=>n.x))-16,Math.max(...boxes.map(n=>n.x+n.width))+16]);
    for (const gap of [12,24]) {
      const topA = a.y-gap, topB = b.y-gap;
      if (topA === topB) consider([x,a.y],[x,topA],[X,topB],[X,b.y]);
      for (const lane of lanes) {
        consider([x,a.y],[x,topA],[lane,topA],[lane,topB],[X,topB],[X,b.y]);
        consider([x,a.y],[x,topA],[lane,topA],[lane,sideB[1]],sideB);
      }
    }
  }
  if (!best && a !== b) {
    // A tall class between the endpoints may block every route through their row gutters.
    for (const obstacle of boxes) for (const lane of [obstacle.y-16,obstacle.y+obstacle.height+16]) {
      const yA = lane<cy(a) ? a.y : a.y+a.height, yB = lane<cy(b) ? b.y : b.y+b.height;
      consider([cx(a),yA],[cx(a),lane],[cx(b),lane],[cx(b),yB]);
    }
  }
  if (!best) throw new Error('Medzi prvkami diagramu sa nenašla voľná trasa.');
  best.slice(1).forEach((q,i) => used.push([best[i],q]));
  return best;
}

// Leave a short break at a transverse crossing, never at a port or a bend.
export function crossingPath(points, previous) {
  let d = `M${points[0]}`;
  for (let i=1;i<points.length;i++) {
    const a=points[i-1], b=points[i], axis=a[0]===b[0]?1:0, fixed=1-axis;
    const sign=Math.sign(b[axis]-a[axis]), length=Math.abs(b[axis]-a[axis]);
    const cuts=[];
    for (const [p,q] of previous) {
      const t=sign*(p[axis]-a[axis]);
      if (p[axis]===q[axis] && t>6 && t<length-6 &&
          Math.min(p[fixed],q[fixed])<a[fixed] && a[fixed]<Math.max(p[fixed],q[fixed])) cuts.push(t);
    }
    const point=t=>axis===0?[a[0]+sign*t,a[1]]:[a[0],a[1]+sign*t];
    let resume=0;
    for (const t of cuts.sort((u,v)=>u-v)) {
      if (t-4>resume) d+=` L${point(t-4)}`;
      resume=t+4;
      d+=` M${point(resume)}`;
    }
    d+=` L${b}`;
  }
  return d;
}

function classDiagram(svg, data, onOpen, symbols) {
  const ctx = document.createElement('canvas').getContext('2d');
  const measure = (value,font) => { ctx.font=font; return ctx.measureText(value).width; };
  // SA displays StartMultiplicityUML at the target and EndMultiplicityUML at the source.
  // Keep class identities, role names and route direction unchanged, including in offline copies.
  data = {...data, edges:data.edges.map(edge => {
    const [start,end] = edge.ends ?? [];
    if (start?.end !== 0 || end?.end !== 1) return edge;
    return {...edge,ends:[{...start,multiplicity:end.multiplicity},{...end,multiplicity:start.multiplicity}]};
  })};
  const layout = classLayout(data,measure,symbols), missing = [], occupied = [];
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
  const used = [], captions = [], associations = new Map();
  const edgeFields = new Map(symbols.map(s=>[s.id,s.fields]));
  const gutters = [Math.min(...layout.nodes.map(n=>n.x))-16,Math.max(...layout.nodes.map(n=>n.x+n.width))+16];
  function drawEdge(edge, boxes) {
    const ends = edgeNodes(edge, layout.nodes);
    if (ends.length !== 2 || ends.some(end => !end)) { missing.push(edge.id); return; }
    const fields = edgeFields.get(edge.id) ?? {};
    let preferred = layout.project ? nativeRoute(...ends,fields.Waypoints,layout.project) : layout.fanRoutes.get(edge);
    if (!layout.project && !preferred && edge.ends && ends[0] !== ends[1] && ends[0].y === ends[1].y) {
      const [a,b] = ends, right = b.x > a.x;
      const x = a.x+a.width*(right ? .85 : .15), side = right ? b.x : b.x+b.width;
      const lane = Math.max(...layout.nodes.filter(n => n.y===a.y &&
        n.x>=Math.min(a.x,b.x) && n.x<=Math.max(a.x,b.x)).map(n=>n.y+n.height)) + 24;
      const endY = b.y + b.height/2, bend = side + (right ? -16 : 16);
      preferred = [[x,a.y+a.height],[x,lane],[bend,lane],[bend,endY],[side,endY]];
    }
    const previous = used.length;
    const path = classRoute(...ends, boxes, used, gutters, preferred,
      layout.fanRoutes.has(edge) && Number.isFinite(branchNumber(edge)));
    const group = element('g', { class: 'symbol uml-association',role:'button',tabindex:0,
      'aria-label':[ends[0].name,edge.label,ends[1].name].filter(Boolean).join(' → ') });
    if (edge.type === 'association') associations.set(edge.id,{group,path});
    group.dataset.text = normalize([edge.label, ...(edge.ends ?? []).map(end => `${end.name} ${end.multiplicity}`)].join(' '));
    interactive(group, edge.target, onOpen);
    group.append(element('path', { class:'association-line', d: crossingPath(path,used.slice(0,previous)),
      fill: 'none', stroke: '#315b73', 'stroke-width': 1.5,
      ...(edge.type === 'dependency' ? { 'stroke-dasharray': '6 4', 'marker-end': 'url(#uml-dependency)' } :
        edge.type === 'generalization' ? { 'marker-end': 'url(#uml-inheritance)' } : {}) }));
    group.append(element('path',{class:'association-hit',d:path.map(([x,y],i)=>`${i?'L':'M'}${x},${y}`).join(' '),
      fill:'none','aria-hidden':'true'}));
    if (edge.ends) {
      const [a,b] = edge.ends;
      const title = element('title');
      title.textContent = `${ends[0].name} (${endCaption(a)||'–'}) → ${ends[1].name} (${endCaption(b)||'–'})` +
        (edge.label ? ` · ${edge.label}` : '');
      group.append(title);
      for (const [i,end] of edge.ends.entries()) {
        if (!endCaption(end)) continue;
        const [x,y] = i ? path.at(-1) : path[0], [u,v] = i ? path.at(-2) : path[1];
        const value = endCaption(end), width = measure(value,'13px Arial');
        const candidates = [];
        for (const distance of [0,6,12]) {
          if (x===u) {
            const baseline = y+(v>y ? 16+distance : -6-distance);
            candidates.push([x+6,baseline],[x-6-width,baseline]);
          } else {
            const left = x+(u<x ? -6-width-distance : 6+distance);
            candidates.push([left,y-6],[left,y+16]);
          }
        }
        captions.push({group,value,width,candidates,end:true});
      }
    }
    if (edge.label && (!layout.project || fields.ViewShowName !== 'false')) {
      const label = edge.label === 'Aggregates' ? 'agregácia' : edge.label;
      const segments = path.slice(1).map((p,i)=>[path[i],p]).sort(([a,b],[c,d])=>
        Math.hypot(c[0]-d[0],c[1]-d[1])-Math.hypot(a[0]-b[0],a[1]-b[1]));
      const width = measure(label,'600 14px Arial'), candidates = [];
      for (const [[x1,y1],[x2,y2]] of segments) for (const t of [.5,.35,.65,.2,.8]) {
        const x=x1+(x2-x1)*t, y=y1+(y2-y1)*t;
        if (x1===x2) candidates.push([x+8,y+4],[x-width-8,y+4]);
        else candidates.push([x-width/2,y-7],[x-width/2,y+18]);
      }
      captions.push({group,value:label,width,candidates,end:false});
    }
    svg.append(group);
  }
  const nodesById = new Map(layout.nodes.map(node => [node.id, node]));
  const noteTargets = new Map();
  for (const symbol of symbols) {
    if (symbol.nativeClass !== '_Ent2_NoteLink') continue;
    const note = symbol.relations.find(r => r.role === '_Ent2_NoteLink_To_Note')?.item;
    const target = symbol.relations.find(r => r.role === '_Ent2_AttachedNoteLink_To_Symbol')?.item;
    const node = nodesById.get(target?.id);
    if (!note || !node) continue;
    if (!noteTargets.has(note.id)) noteTargets.set(note.id, new Set());
    noteTargets.get(note.id).add(node);
  }
  const noteBoxes = [];
  let nextY = 25, left = 0, right = layout.width;
  const firstColumn = Math.min(...layout.nodes.map(node => node.x));
  const centerY = node => node.y + node.height / 2;
  const attached = data.notes.filter(note => noteTargets.has(note.id)).map(note => ({
    note, nodes: [...noteTargets.get(note.id)],
    preferredY: Math.min(...[...noteTargets.get(note.id)].map(centerY)),
  })).sort((a, b) => a.preferredY - b.preferredY);
  for (const { note, nodes, preferredY } of attached) {
    const wrapped = lines(note.text, 48), height = wrapped.length * 20 + 30;
    const y = Math.max(nextY, preferredY - height / 2);
    const boxWidth = Math.max(100, ...wrapped.map(line => measure(line, '14px Arial') + 30));
    const onLeft = nodes.every(node => node.x === firstColumn);
    const x = onLeft ? -boxWidth - 25 : layout.width;
    noteBoxes.push({ x, y, width: boxWidth, height, wrapped, nodes });
    nextY = y + height + 25;
    left = Math.min(left, x - 25);
    right = Math.max(right, x + boxWidth + 25);
  }
  const boxes = [...layout.nodes,...noteBoxes];
  for (const edge of layout.fanRoutes.keys()) drawEdge(edge, boxes);
  for (const edge of data.edges) if (!layout.fanRoutes.has(edge)) drawEdge(edge, boxes);
  for (const symbol of symbols) {
    if (symbol.nativeClass !== '_Ent2_CDAssociationLink') continue;
    const target = suffix => symbol.relations?.find(r=>r.role===`_Ent2_CDAssociationLink_To_${suffix}`)?.item.id;
    const association = associations.get(target('CDAssociation')), node = nodesById.get(target('CDClass'));
    if (!association || !node) { missing.push(symbol.id); continue; }
    // Attach to a segment interior, not a class endpoint or a corner.
    const {group,path} = association, cx = node.x+node.width/2, cy = node.y+node.height/2;
    const anchors = path.slice(1).map(([x,y],i)=>[(x+path[i][0])/2,(y+path[i][1])/2]);
    const distance = ([x,y]) => Math.hypot(x-cx,y-cy);
    const [x,y] = anchors.sort((a,b)=>distance(a)-distance(b))[0];
    const port = x>=node.x && x<=node.x+node.width ? [x,y<cy?node.y:node.y+node.height] :
      y>=node.y && y<=node.y+node.height ? [x<cx?node.x:node.x+node.width,y] : null;
    const previous = used.length;
    const route = classRoute(node,{x,y,width:0,height:0},boxes,used,gutters,port && [port,[x,y]]);
    const d = crossingPath(route,used.slice(0,previous));
    group.append(element('path',{class:'association-line',d,fill:'none',stroke:'#315b73','stroke-width':1.5,'stroke-dasharray':'8 5'}));
    group.append(element('path',{class:'association-hit',d,fill:'none','aria-hidden':'true'}));
  }
  for (const box of noteBoxes) {
    for (const node of box.nodes) svg.append(element('polyline', {
      points: classRoute(node,box,boxes,used,gutters).map(p=>p.join(',')).join(' '), fill:'none',
      stroke: '#738796', 'stroke-width': 1.5, 'stroke-dasharray': '6 4', 'pointer-events': 'none',
    }));
  }
  // Place end labels first, after all connector geometry is known.
  for (const {group,value,width,candidates,end} of captions.sort((a,b)=>Number(b.end)-Number(a.end))) {
    let best, min = Infinity;
    for (const [x,y] of candidates) {
      const l=x-2, r=x+width+2, t=y-15, b=y+4;
      const intersects = (x1,y1,x2,y2) => x1<r && x2>l && y1<b && y2>t;
      const score = boxes.filter(n=>intersects(n.x,n.y,n.x+n.width,n.y+n.height)).length*1000 +
        occupied.filter(n=>intersects(...n)).length*100 +
        used.filter(([p,q])=>intersects(Math.min(p[0],q[0]),Math.min(p[1],q[1]),
          Math.max(p[0],q[0]),Math.max(p[1],q[1]))).length;
      if (score<min) { min=score; best=[x,y]; }
      if (!score) break;
    }
    const [x,y]=best;
    occupied.push([x-2,y-15,x+width+2,y+4]);
    text(group,value,x,y,{'text-anchor':'start',...(end ? {'font-size':13,class:'association-caption'} : {'font-weight':600})});
  }
  for (const node of layout.nodes) {
    const group = element('g', { class: 'symbol uml-class', 'aria-label': node.name });
    group.dataset.text = normalize([node.name, ...node.attributes.map(item => memberLabel(item, false)), ...node.operations.map(item => memberLabel(item, true, true))].join(' '));
    interactive(group, node.target, onOpen);
    const palette = stereotypePalette(node.kind);
    group.append(element('rect', { x: node.x, y: node.y, width: node.width, height: node.height, fill: node.kind==='business' ? '#00d6dc' : palette.fill, stroke: node.kind==='business' ? '#315cce' : '#111', 'stroke-width': 1.5 }));
    if (node.kind === 'interface') group.classList.add('interface-class');
    if (node.stereotype) text(group, `«${node.stereotype}»`, node.x + node.width / 2, node.y + 16, { 'font-size': 13 });
    text(group, node.name, node.x + node.width / 2, node.y + (node.stereotype ? 37 : 28), { 'font-size': 16, 'font-weight': 600, 'font-style': node.isAbstract ? 'italic' : 'normal' });
    let y = node.y + 49;
    if (node.attributes.length || node.operations.length) group.append(element('line', { x1: node.x, y1: y, x2: node.x + node.width, y2: y, stroke: '#8fa7b4' }));
    const drawMembers = section => node[section].forEach((member,i) => {
      const x = node.x + 10, rows = node.memberRows[section][i];
      const label = text(group, rows.length === 1 ? rows[0] : '', x, y += 21, {
        'text-anchor':'start', 'font-style':section === 'operations' && member.isAbstract ? 'italic' : 'normal',
        'text-decoration':member.isStatic ? 'underline' : 'none' });
      if (rows.length > 1) {
        label.dataset.wrapped = 'true';
        label.setAttribute('style','white-space:pre');
        rows.forEach((line,j) => {
          if (j) {
            y += 18;
            group.append(element('path',{d:`M${x+7} ${y-12} v7 h10`,fill:'none',stroke:'#8fa7b4','pointer-events':'none','aria-hidden':'true'}));
          }
          const span = element('tspan',{x:x+(j ? continuationIndent : 0),y});
          span.textContent = line;
          label.append(span);
        });
      }
      interactive(label, member.target, onOpen);
    });
    drawMembers('attributes');
    if (node.attributes.length && node.operations.length) {
      y += 15;
      group.append(element('line', { x1: node.x, y1: y, x2: node.x + node.width, y2: y, stroke: '#8fa7b4' }));
    }
    drawMembers('operations');
    svg.append(group);
  }
  let y = Math.max(layout.height, nextY);
  for (const note of data.notes) {
    if (noteTargets.has(note.id)) continue;
    const wrapped = lines(note.text, 110);
    noteBoxes.push({ x: 25, y, width: layout.width - 50, height: wrapped.length * 20 + 30, wrapped });
    y += wrapped.length * 20 + 55;
  }
  for (const { x, y, width, height, wrapped } of noteBoxes) {
    svg.append(element('rect', { x, y, width, height, fill: '#fffbe8', stroke: '#c4b878' }));
    wrapped.forEach((line, index) => text(svg, line, x + 15, y + 24 + index * 20, { 'text-anchor': 'start' }));
  }
  return { box: [left, 0, right - left, y + 20],
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
  if (data.kind === 'class') {
    const visible = options.showOperations === false ? {...data,classes:data.classes.map(c=>({...c,operations:[]}))} : data;
    return classDiagram(svg, visible, onOpen, options.symbols ?? []);
  }
  if (data.kind === 'sequence') return sequenceDiagram(svg, data, onOpen, options);
  throw new Error('Unsupported UML diagram representation.');
}
