const western = new TextDecoder('windows-1250', { fatal: true });

export function datastoreTextCodec(codePage) {
  const decoder = codePage === 'WESTERN' ? western :
    codePage === 'UNICODE' ? new TextDecoder('utf-8', { fatal: true }) : null;
  if (!decoder) throw new Error('Unsupported Select datastore code page.');
  return value => {
    if (!Buffer.isBuffer(value)) throw new Error('Missing native text value.');
    return decoder.decode(value);
  };
}

export function rtfText(source) {
  const stack = [];
  let state = { skip: false, fallback: 1 }, output = '', fallback = 0;
  for (let index = 0; index < source.length;) {
    const character = source[index++];
    if (character === '{') { stack.push(state); state = { ...state }; continue; }
    if (character === '}') {
      if (!stack.length) throw new Error('Unbalanced RTF group.');
      state = stack.pop();
      continue;
    }
    if (character !== '\\') {
      if (fallback) { fallback--; continue; }
      if (!state.skip && !/[\r\n]/.test(character)) output += character;
      continue;
    }
    const symbol = source[index++];
    if (symbol === '*') { state.skip = true; continue; }
    if (symbol === "'") {
      const hex = source.slice(index, index + 2);
      if (!/^[a-f0-9]{2}$/i.test(hex)) throw new Error('Invalid RTF byte escape.');
      index += 2;
      if (fallback) fallback--;
      else if (!state.skip) output += western.decode(Buffer.from(hex, 'hex'));
      continue;
    }
    if (['\\', '{', '}'].includes(symbol)) {
      if (fallback) fallback--; else if (!state.skip) output += symbol;
      continue;
    }
    if (!/[a-z]/i.test(symbol ?? '')) {
      if (!state.skip && symbol === '~') output += '\u00a0';
      continue;
    }
    const token = /^[a-z]+(-?\d+)? ?/i.exec(source.slice(index - 1));
    if (!token) throw new Error('Invalid RTF control word.');
    index = index - 1 + token[0].length;
    const word = /^[a-z]+/i.exec(token[0])[0], value = token[1] === undefined ? undefined : Number(token[1]);
    if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'fldinst'].includes(word)) state.skip = true;
    if (word === 'bin') {
      if (!Number.isInteger(value) || value < 0 || index + value > source.length) throw new Error('Invalid RTF binary section.');
      index += value;
    }
    if (word === 'uc' && Number.isInteger(value) && value >= 0 && value <= 16) state.fallback = value;
    if (word === 'u' && Number.isInteger(value)) {
      if (!state.skip) output += String.fromCharCode(value & 0xffff);
      fallback = state.fallback;
    }
    if (!state.skip) {
      if (word === 'par' || word === 'line') output += '\n';
      if (word === 'tab') output += '\t';
      if (word === 'emdash') output += '\u2014';
      if (word === 'endash') output += '\u2013';
      if (word === 'bullet') output += '\u2022';
    }
  }
  if (stack.length) throw new Error('Unbalanced RTF document.');
  return output.trim();
}

export function documentText(buffer, decode = value => western.decode(value)) {
  let text;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(3));
  else if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) text = new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
  else if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) text = new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
  else text = decode(buffer);
  text = text.replace(/\0+$/, '');
  if (text.startsWith('{\\rtf')) return rtfText(text);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null;
  return text;
}
