import { requestFrame } from '../direct-broker.mjs';

export const scalar = (tag, buffer) => Buffer.concat([Buffer.from([tag, buffer.length]), buffer]);
export const string = (tag, value) => scalar(tag, Buffer.from(value));
export const integer = (tag, value, width = 4) => {
  const buffer = Buffer.alloc(width);
  buffer.writeUIntBE(value, 0, width);
  return scalar(tag, buffer);
};
export const list = (tag, elements) => {
  const contents = Buffer.concat(elements.map(element => {
    const header = Buffer.alloc(tag === 0xc9 || tag === 0xc1 ? 2 : 1);
    header.writeUIntBE(element.length, 0, header.length);
    return Buffer.concat([header, element]);
  }));
  const header = Buffer.alloc(5);
  header[0] = tag;
  header.writeUInt16BE(contents.length + 2, 1);
  header.writeUInt16BE(elements.length, 3);
  return Buffer.concat([header, contents]);
};
export const record = (name = 'Example', port = 6123, context, { omitServer = false } = {}) => Buffer.concat([
  ...(omitServer ? [] : [string(0x5d, 'test-server')]), string(0x5e, name), integer(0x62, port, 2), ...(context ? [string(0x32, context)] : []),
]);
export const reply = (opcode, body) => {
  const frame = requestFrame(opcode, body);
  frame.writeUInt32BE(19, 32);
  return frame;
};
export const negotiation = version => reply(0x93, Buffer.concat([list(0x9f, [Buffer.from(version)]), string(4, 'UNICODE')]));
export const catalog = (rows = [record()], mode = 0, cursor = Buffer.alloc(15, 0x20)) => reply(0xfe,
  Buffer.concat([scalar(0x5e, cursor), list(0xc9, rows), integer(0x6b, mode), string(0x66, 'n'), string(0x66, 'n')]));
export const contexts = (names = ['default', 'user_ident_by_file', 'ads']) =>
  reply(0xce, Buffer.concat([list(0xb2, names.map(name => Buffer.from(name))), list(0xc3, [Buffer.from('client')])]));
