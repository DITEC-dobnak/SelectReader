import { descriptionText, renderUml } from './uml.mjs';

const NS = 'http://www.w3.org/2000/svg';
const normalized = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function textMatches(text, query) {
  const needle = normalized(query).trim();
  if (!needle) return [];
  let value = '', offsets = [], ends = [], index = 0;
  for (const character of text) {
    const part = normalized(character);
    value += part;
    for (let i = 0; i < part.length; i++) {
      offsets.push(index);
      ends.push(index + character.length - 1);
    }
    index += character.length;
  }
  const matches = [];
  for (let from = 0, index; (index = value.indexOf(needle, from)) !== -1; from = index + needle.length)
    matches.push([offsets[index], ends[index + needle.length - 1]]);
  return matches;
}

export function numbers(value) {
  return (String(value ?? '').match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

export function geometry(symbol) {
  const position = numbers(symbol.fields.Position);
  const width = numbers(symbol.fields.Width)[0];
  const height = numbers(symbol.fields.Height)[0];
  if (position.length < 2) return null;
  const points = [];
  for (let index = 0; index + 1 < position.length; index += 2) points.push([position[index], position[index + 1]]);
  return { x: position[0], y: position[1], width, height, points };
}

export function connectorPoints(symbol, symbols) {
  const stored = geometry(symbol);
  if (stored?.points.length >= 2) return stored.points;
  const endpoints = symbol.endpoints.map(endpoint => symbols.find(candidate => candidate.id === endpoint.id)).filter(Boolean);
  if (endpoints.length < 2) return null;
  const [a, b] = endpoints.slice(0, 2).map(endpoint => geometry(endpoint));
  if (!a || !b || !(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) return null;
  const waypoints = numbers(symbol.fields.Waypoints);
  if (waypoints.length % 2) return null;
  const points = [[a.x + a.width / 2, a.y + a.height / 2]];
  for (let index = 0; index < waypoints.length; index += 2) points.push(waypoints.slice(index, index + 2));
  points.push([b.x + b.width / 2, b.y + b.height / 2]);
  return points;
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

export class Diagram {
  constructor(container, notice, onOpen) {
    this.container = container;
    this.inspectorDivider = container.closest('.diagram-stage')?.querySelector('.inspector-divider');
    this.notice = notice;
    this.onOpen = onOpen;
    this.selectedLabels = [];
    this.labelBackgrounds = new Map();
    this.svg = svgElement('svg', { role: 'img', 'aria-label': 'Diagram modelu' });
    container.replaceChildren(this.svg);
    container.addEventListener('copy', event => {
      if (!this.selectedLabels.length || !document.getSelection().isCollapsed) return;
      event.clipboardData.setData('text/plain', this.selectedLabels.map(node => node.textContent).join('\n'));
      event.preventDefault();
    });
    container.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.clearLabels();
    });
    new ResizeObserver(() => { if (this.box) this.update(); }).observe(this.svg);
    this.svg.addEventListener('wheel', event => {
      event.preventDefault();
      if (!this.box) return;
      if (event.ctrlKey || !['class', 'sequence'].includes(this.data?.uml?.kind)) {
        if (event.deltaY) {
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.svg.clientHeight : 1;
          const factor = event.ctrlKey ? 1.08 ** Math.max(-1, Math.min(1, event.deltaY * unit / 100))
            : event.deltaY > 0 ? 1.15 : 1 / 1.15;
          this.zoom(factor, event.clientX, event.clientY);
        }
      } else {
        const bounds = this.svg.getBoundingClientRect();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
        const scale = unit * Math.max(this.box[2] / bounds.width, this.box[3] / bounds.height);
        const sideways = event.shiftKey && !event.deltaX;
        this.box[0] += (sideways ? event.deltaY : event.deltaX) * scale;
        this.box[1] += (sideways ? 0 : event.deltaY) * scale;
        this.update();
      }
    }, { passive: false });
    let drag, panned = false;
    this.svg.addEventListener('pointerdown', event => {
      clearTimeout(this.pendingTextClick);
      if (!event.isPrimary || event.button !== 0 || !this.box) return;
      panned = false;
      this.clearLabels();
      if (!this.hand && event.target.closest('text')) return;
      event.preventDefault();
      container.focus({preventScroll:true});
      document.getSelection().removeAllRanges();
      drag = { x: event.clientX, y: event.clientY, box: [...this.box], id: event.pointerId };
      event.target.setPointerCapture(event.pointerId);
    });
    this.svg.addEventListener('pointermove', event => {
      if (event.pointerId !== drag?.id) return;
      const rect = this.svg.getBoundingClientRect();
      const scale = Math.max(drag.box[2] / rect.width, drag.box[3] / rect.height);
      const x = event.clientX - drag.x, y = event.clientY - drag.y;
      if (!panned && Math.abs(x) + Math.abs(y) <= 5) return;
      panned = true;
      if (!this.hand) {
        const left = Math.min(drag.x,event.clientX), top = Math.min(drag.y,event.clientY);
        const right = Math.max(drag.x,event.clientX), bottom = Math.max(drag.y,event.clientY);
        if (!drag.frame) {
          drag.frame = document.createElement('div');
          drag.frame.className = 'text-marquee';
          container.append(drag.frame);
          drag.labels = Array.from(this.svg.querySelectorAll('text'), node => ({node, rect:node.getBoundingClientRect()}))
            .filter(({rect:r}) => r.width && r.height && r.right >= rect.left && r.left <= rect.right && r.bottom >= rect.top && r.top <= rect.bottom)
            .sort((a,b) => a.rect.top-b.rect.top || a.rect.left-b.rect.left);
        }
        Object.assign(drag.frame.style, {left:`${left-rect.left}px`,top:`${top-rect.top}px`,width:`${right-left}px`,height:`${bottom-top}px`});
        this.selectLabels(drag.labels.filter(({rect:r}) => r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom).map(({node}) => node));
        return;
      }
      this.svg.classList.add('panning');
      this.box = [drag.box[0] - x * scale, drag.box[1] - y * scale, drag.box[2], drag.box[3]];
      this.update();
    });
    const endDrag = event => {
      if (event.pointerId !== drag?.id) return;
      drag.frame?.remove();
      drag = null;
      this.svg.classList.remove('panning');
    };
    this.svg.addEventListener('lostpointercapture', endDrag);
    this.svg.addEventListener('pointerup', endDrag);
    this.svg.addEventListener('pointercancel', endDrag);
    this.svg.addEventListener('click', event => {
      if (this.hand || panned || event.button !== 0 || (event.target.closest('text') && !document.getSelection().isCollapsed)) return;
      const target = event.target.closest('[data-target]');
      if (!target) return;
      if (['sequence', 'class'].includes(this.data?.uml?.kind) && event.detail && event.target.closest('text')) {
        if (event.detail === 1) this.pendingTextClick = setTimeout(() => {
          if (this.svg.contains(target) && this.container.getClientRects().length && document.getSelection().isCollapsed)
            this.onOpen(target.dataset.target, target.dataset.diagramLink);
        }, 500);
      } else this.onOpen(target.dataset.target, target.dataset.diagramLink);
    });
  }
  clearLabels() {
    this.selectLabels([]);
  }
  selectLabels(labels) {
    const next = new Set(labels);
    for (const [node, background] of this.labelBackgrounds) {
      if (next.has(node)) continue;
      node.classList.remove('area-selected');
      background.remove();
      this.labelBackgrounds.delete(node);
    }
    for (const node of labels) {
      if (this.labelBackgrounds.has(node)) continue;
      const {x,y,width,height} = node.getBBox();
      const background = svgElement('rect', {x,y,width,height,class:'label-selection-bg','aria-hidden':'true'});
      if (node.hasAttribute('transform')) background.setAttribute('transform',node.getAttribute('transform'));
      node.before(background);
      node.classList.add('area-selected');
      this.labelBackgrounds.set(node,background);
    }
    this.selectedLabels = labels;
  }
  setHand(active) {
    clearTimeout(this.pendingTextClick);
    this.clearLabels();
    this.hand = active;
    this.svg.classList.toggle('hand-tool', active);
  }
  render(data) {
    clearTimeout(this.pendingTextClick);
    this.clearLabels();
    this.matches = [];
    this.matchIndex = -1;
    this.data = data;
    this.svg.replaceChildren();
    this.svg.setAttribute('preserveAspectRatio', data.uml ? 'xMinYMin meet' : 'xMidYMid meet');
    this.svg.classList.toggle('select-sequence', data.uml?.kind === 'sequence');
    this.svg.classList.toggle('select-class', data.uml?.kind === 'class');
    if (data.uml) {
      const rendered = renderUml(this.svg, data.uml, this.onOpen, { detailedSteps: true, symbols: data.symbols });
      const [left, top, docWidth, docHeight] = rendered.box;
      const leftGutter = 24;
      this.initial = [left - leftGutter, top, docWidth + leftGutter, docHeight];
      if (data.uml.kind === 'sequence') {
        const { width, height } = this.svg.getBoundingClientRect();
        // SQD step labels are 12 SVG units; 12 CSS points are 16 CSS pixels.
        const unitsPerPixel = 12 / 16;
        this.box = width && height
          ? [this.initial[0], this.initial[1], width * unitsPerPixel, height * unitsPerPixel]
          : [...this.initial];
        this.update();
      } else this.fit();
      this.notice.textContent = rendered.notice;
      return;
    }
    const symbols = data.symbols.map(symbol => ({ ...symbol, geometry: geometry(symbol) }));
    let skipped = 0;
    const bounds = [];
    for (const symbol of symbols) {
      const g = symbol.geometry;
      const fields = symbol.fields, type = fields.Type ?? '';
      const connector = /flow|link|association|generalization|dependency|message|transition/i.test(type) &&
        !/note|instance/i.test(type);
      if (connector) {
        const points = connectorPoints(symbol, symbols);
        if (!points) { skipped++; continue; }
        this.svg.append(svgElement('polyline', { points: points.map(point => point.join(',')).join(' '), class: 'edge' }));
        bounds.push(...points.map(([x, y]) => [x, y, 0, 0]));
        if (fields.Name && !fields.Name.includes('::')) {
          const middle = points.length === 2 ? [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2] : points[Math.floor(points.length / 2)];
          const label = svgElement('text', { x: middle[0], y: middle[1], 'font-size': 40 });
          label.textContent = fields.Name;
          this.svg.append(label);
        }
        continue;
      }
      if (!g) { skipped++; continue; }
      if (!(g.width > 0 && g.height > 0)) { skipped++; continue; }
      const label = fields['Dictionary Item Name'] || fields.Text || descriptionText(fields.Description) ||
        (fields.Name?.includes('::') ? '' : fields.Name) || type;
      const group = svgElement('g', { class: 'symbol', 'aria-label': label });
      group.dataset.text = normalized(label);
      if (symbol.target) {
        group.setAttribute('role', 'button');
        group.setAttribute('tabindex', '0');
        group.dataset.target = symbol.target.id;
        group.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.onOpen(symbol.target.id); }
        });
      }
      // Select's Position is kept intact; no layout or relationship is invented.
      if (/actor/i.test(type)) {
        const x = g.x + g.width / 2, head = Math.min(g.width / 7, g.height / 10);
        group.append(svgElement('circle', { cx: x, cy: g.y + head, r: head, class: 'shape' }));
        group.append(svgElement('path', { d: `M ${x} ${g.y + head * 2} V ${g.y + g.height * .55} M ${g.x + g.width * .15} ${g.y + g.height * .3} H ${g.x + g.width * .85} M ${g.x + g.width * .2} ${g.y + g.height * .8} L ${x} ${g.y + g.height * .55} L ${g.x + g.width * .8} ${g.y + g.height * .8}`, class: 'edge' }));
      }
      else if (/use case/i.test(type)) group.append(svgElement('ellipse', { cx: g.x + g.width / 2, cy: g.y + g.height / 2, rx: g.width / 2, ry: g.height / 2, class: 'shape' }));
      else group.append(svgElement('rect', { x: g.x, y: g.y, width: g.width, height: g.height, rx: /state|activity/i.test(type) ? Math.min(g.width, g.height) * .12 : 0, class: 'shape' }));
      const fontSize = Math.max(Math.min(g.height / 5, g.width / 12), Math.min(g.width, g.height) / 10);
      const lines = wrap(label, Math.max(8, Math.floor(g.width / (fontSize * .55)))).slice(0, 6);
      const text = svgElement('text', { x: g.x + g.width / 2, y: g.y + g.height * (/actor/i.test(type) ? .95 : .5) - (lines.length - 1) * fontSize * .6, 'font-size': fontSize });
      lines.forEach((line, index) => {
        const span = svgElement('tspan', { x: g.x + g.width / 2, dy: index ? fontSize * 1.2 : 0 });
        span.textContent = line;
        text.append(span);
      });
      const title = svgElement('title');
      title.textContent = label;
      group.append(text, title);
      this.svg.append(group);
      bounds.push([g.x, g.y, g.width, g.height]);
    }
    if (bounds.length) {
      const minX = Math.min(...bounds.map(b => b[0])), minY = Math.min(...bounds.map(b => b[1]));
      const width = Math.max(...bounds.map(b => b[0] + b[2])) - minX || 1;
      const height = Math.max(...bounds.map(b => b[1] + b[3])) - minY || 1;
      const padding = Math.max(width, height) * .04;
      const leftPadding = padding * 1.5;
      this.initial = [minX - leftPadding, minY - padding, width + leftPadding + padding, height + padding * 2];
      this.fit();
    } else {
      this.box = this.initial = null;
      this.svg.removeAttribute('viewBox');
    }
    this.notice.textContent = `${symbols.length} symbolov · zjednodušené zobrazenie geometrie UML. ` +
      (skipped ? `${skipped} symbolov bez podporovanej geometrie alebo spojenia nebolo vykreslených; obsah nájdeš v Prepojeniach.` : 'Kliknutím na prvok otvoríš jeho detail.');
  }
  update() {
    if (!this.box) return;
    if (this.data?.uml) {
      const { left: screenLeft, top: screenTop, width, height } = this.svg.getBoundingClientRect();
      if (width > 0 && height > 0) {
        const [left, top, docWidth, docHeight] = this.initial;
        const scale = Math.max(this.box[2] / width, this.box[3] / height);
        const divider = this.inspectorDivider?.getBoundingClientRect();
        const bottom = this.container?.parentElement?.dataset.dock === 'bottom';
        const visibleWidth = !bottom && divider?.width ? Math.max(0, Math.min(width, divider.left - screenLeft)) : width;
        const visibleHeight = bottom && divider?.height ? Math.max(0, Math.min(height, divider.top - screenTop)) : height;
        this.box[0] = Math.max(left, Math.min(this.box[0], left + docWidth - visibleWidth * scale));
        this.box[1] = Math.max(top, Math.min(this.box[1], top + docHeight - visibleHeight * scale));
      }
    }
    this.svg.setAttribute('viewBox', this.box.join(' '));
  }
  fit() { if (this.initial) { this.box = [...this.initial]; this.update(); } }
  zoom(factor, clientX, clientY) {
    if (!this.box || !this.initial) return;
    const width = this.box[2] * factor;
    if (width < this.initial[2] / 100 || width > this.initial[2] * 20) return;
    const rect = this.svg.getBoundingClientRect();
    const ratio = clientX == null ? .5 : Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const vertical = clientY == null ? .5 : Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    this.box = [this.box[0] + this.box[2] * (1 - factor) * ratio, this.box[1] + this.box[3] * (1 - factor) * vertical, width, this.box[3] * factor];
    this.update();
  }
  find(query) {
    for (const rect of this.svg.querySelectorAll('.diagram-search-hit')) rect.remove();
    this.matches = [];
    this.matchIndex = -1;
    if (!normalized(query).trim()) return 0;
    for (const text of this.svg.querySelectorAll('text')) {
      const count = text.getNumberOfChars();
      let offset = 0;
      const ranges = [];
      for (const node of text.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE && node.nodeName.toLowerCase() !== 'tspan') continue;
        const content = node.textContent;
        for (const [start, end] of textMatches(content, query)) ranges.push([start + offset, end + offset]);
        offset += content.length;
      }
      if (!ranges.length) continue;
      const color = getComputedStyle(text).fill.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      const lightText = color?.length === 3 && (color[0] * .2126 + color[1] * .7152 + color[2] * .0722) > 160;
      for (const [start, end] of ranges) {
        if (end >= count) continue;
        const first = text.getExtentOfChar(start), last = text.getExtentOfChar(end);
        const x = Math.min(first.x, last.x), y = Math.min(first.y, last.y);
        const right = Math.max(first.x + first.width, last.x + last.width);
        const bottom = Math.max(first.y + first.height, last.y + last.height);
        const rect = svgElement('rect', { x: x - 1, y: y - 1, width: right - x + 2, height: bottom - y + 2,
          class: `diagram-search-hit${lightText ? ' light-text' : ''}`, 'aria-hidden': 'true' });
        if (text.hasAttribute('transform')) rect.setAttribute('transform', text.getAttribute('transform'));
        text.before(rect);
        this.matches.push(rect);
      }
    }
    return this.matches.length;
  }
  nextMatch(direction) {
    if (!this.matches?.length || !this.box) return null;
    if (this.matchIndex >= 0) this.matches[this.matchIndex].classList.remove('current');
    this.matchIndex = this.matchIndex < 0 ? (direction < 0 ? this.matches.length - 1 : 0)
      : (this.matchIndex + direction + this.matches.length) % this.matches.length;
    const match = this.matches[this.matchIndex];
    match.classList.add('current');
    const bounds = this.svg.getBoundingClientRect(), hit = match.getBoundingClientRect();
    const divider = this.inspectorDivider?.getBoundingClientRect();
    const bottom = this.container?.parentElement?.dataset.dock === 'bottom';
    const width = !bottom && divider?.width ? Math.min(bounds.width, Math.max(0, divider.left - bounds.left)) : bounds.width;
    const height = bottom && divider?.height ? Math.min(bounds.height, Math.max(0, divider.top - bounds.top)) : bounds.height;
    const inverse = this.svg.getScreenCTM().inverse();
    const target = new DOMPoint(bounds.left + width / 2, bounds.top + height / 2).matrixTransform(inverse);
    const center = new DOMPoint(hit.left + hit.width / 2, hit.top + hit.height / 2).matrixTransform(inverse);
    this.box[0] += center.x - target.x;
    this.box[1] += center.y - target.y;
    this.update();
    return { index: this.matchIndex + 1, total: this.matches.length };
  }
}

function wrap(text, length) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && line.length + word.length + 1 > length) { lines.push(line); line = ''; }
      line += (line ? ' ' : '') + word;
    }
    if (line) lines.push(line);
  }
  return lines;
}
