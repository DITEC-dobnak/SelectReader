import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// Experimental, read-only broker catalog profile observed with Enabler 8.1.
// This module deliberately has no Select/COM/JEna/native-library dependencies.
const MAGIC = Buffer.from([0x32, 0xff, 0x28, 0x06]);
const HEADER_SIZE = 40;
const NEGOTIATE = 0x0093;
const CATALOG = 0x00fe;
const LOGIN_CONTEXTS = 0x00ce;
const USER_IDENT = 0x0102;
const MODEL_LIST = 0x0037;
const CLASS_LIST = 0x0016;
const ATTRIBUTE_LIST = 0x003d;
const ATTRIBUTE_GET = 0x003c;
const RELATIONSHIP_LIST = 0x0045;
const ORDERED_RELATIONSHIP_LIST = 0x0047;
const CLASS_RELATIONSHIP_LIST = 0x0026;
const CONTEXT_GET = 0x0088;
const CONTEXT_SELECT = 0x0089;
const RECORD_GROUPS = new Set([0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xc1, 0xc9]);
const SINGLE_GROUPS = new Set([0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x41, 0x49, 0x4e, 0x53, 0x54, 0x55]);
const CATALOG_GROUP = 0xc9;
const INITIAL_BROKER_CONTEXT = Buffer.from('12345678900000000000000000000000', 'hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });
let requestNumber = 1;

export function scalar(tag, data) {
  return Buffer.concat([Buffer.from([tag]), valueLength(data.length), data]);
}

function valueLength(length) {
  if (length > 65535) throw new Error('Broker value is too long.');
  if (length < 255) return Buffer.from([length]);
  const result = Buffer.alloc(3);
  result[0] = 0xff;
  result.writeUInt16BE(length, 1);
  return result;
}

export function values(tag, parts) {
  const contents = Buffer.concat(parts.map(part => Buffer.concat([valueLength(part.length), part])));
  if (contents.length + 2 > 65535 || parts.length > 65535) throw new Error('Broker list is too long.');
  const header = Buffer.alloc(5);
  header[0] = tag;
  header.writeUInt16BE(contents.length + 2, 1);
  header.writeUInt16BE(parts.length, 3);
  return Buffer.concat([header, contents]);
}

export function requestFrame(opcode, body, contextId) {
  if (![NEGOTIATE, CATALOG, LOGIN_CONTEXTS, USER_IDENT, MODEL_LIST, CLASS_LIST, ATTRIBUTE_LIST, ATTRIBUTE_GET, RELATIONSHIP_LIST, ORDERED_RELATIONSHIP_LIST, CLASS_RELATIONSHIP_LIST, CONTEXT_GET, CONTEXT_SELECT].includes(opcode))
    throw new Error('Only explicit read-only metadata and credential-verification operations are allowed.');
  if (HEADER_SIZE + body.length > 65535) throw new Error('Broker request exceeds the supported frame size.');
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header);
  header.writeUInt16BE(HEADER_SIZE + body.length, 4);
  header.writeUInt16BE(opcode, 6);
  INITIAL_BROKER_CONTEXT.copy(header, 8);
  if (contextId !== undefined) {
    if (!Buffer.isBuffer(contextId) || contextId.length !== 8) throw new Error('Invalid Enabler context identifier.');
    header.fill(0, 8, 24);
    contextId.copy(header, 8);
  }
  header.write('7000', 28, 'ascii');
  header.writeUInt32BE(12, 32);
  return Buffer.concat([header, body]);
}

export function clientVersionFields() {
  return values(0x9f, ['8.1', '8', '1', '1', '0', '31', 'Release 8.1'].map(text => Buffer.from(text, 'utf8')));
}

export function negotiationRequest() {
  return requestFrame(NEGOTIATE, Buffer.concat([
    clientVersionFields(),
    scalar(0x58, Buffer.from([0, 6])),
    scalar(0x5c, Buffer.from([0, 0, 0x21, 0x3f])),
    scalar(0x38, Buffer.from('60', 'ascii')),
  ]));
}

export function catalogRequest(cursor) {
  if (cursor === undefined) return requestFrame(CATALOG, scalar(0x6b, Buffer.alloc(4)));
  if (!Buffer.isBuffer(cursor) || cursor.length !== 15) throw new Error('Unsupported broker catalog cursor.');
  return requestFrame(CATALOG, Buffer.concat([
    scalar(0x5e, cursor), scalar(0x46, Buffer.from('N', 'ascii')), scalar(0x56, Buffer.from([0, 0x40])),
  ]));
}

export function frameBody(frame, opcode) {
  if (frame.length < HEADER_SIZE || !frame.subarray(0, 4).equals(MAGIC)) throw new Error('Unsupported Enabler frame signature.');
  if (frame.readUInt16BE(4) !== frame.length) throw new Error('Truncated or oversized Enabler frame.');
  if (frame.readUInt16BE(6) !== opcode) throw new Error('Unexpected Enabler response operation.');
  const status = frame.toString('ascii', 28, 32);
  if (!/^\d{4}$/.test(status)) throw new Error('Unsupported Enabler status/profile.');
  if (status !== '7000') throw Object.assign(new Error(`Databázový server odmietol požiadavku (kód ${Number(status)}).`),
    { code: 'BROKER_REJECTED', serverCode: Number(status) });
  // The supported 8.1 profile advertises Windows Server 2012 (OS id 19).
  if (frame.readUInt32BE(32) !== 19) throw Object.assign(
    new Error('Unsupported Enabler server operating system; no partial catalog was accepted.'), { code: 'BROKER_PLATFORM' });
  return frame.subarray(HEADER_SIZE);
}

export function fields(buffer, depth = 0, { skipGroups = false } = {}) {
  if (depth > 4) throw new Error('Broker response nesting exceeds the supported catalog profile.');
  const result = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const tag = buffer[offset++];
    if (SINGLE_GROUPS.has(tag)) {
      if (result.has(tag) || offset + 2 > buffer.length) throw new Error('Invalid or duplicate native parameter group.');
      const length = buffer.readUInt16BE(offset);
      offset += 2;
      if (offset + length > buffer.length) throw new Error('Truncated native parameter group.');
      const value = buffer.subarray(offset, offset + length);
      result.set(tag, skipGroups ? value : fields(value, depth + 1));
      offset += length;
      continue;
    }
    if (tag < 0x80) {
      if (offset >= buffer.length) throw new Error('Missing broker scalar length.');
      let length = buffer[offset++];
      if (length === 0xff) {
        if (offset + 2 > buffer.length) throw new Error('Truncated extended scalar length.');
        length = buffer.readUInt16BE(offset);
        offset += 2;
      }
      if (offset + length > buffer.length) throw new Error('Truncated broker scalar.');
      const value = buffer.subarray(offset, offset + length);
      const previous = result.get(tag);
      // The observed 8.1 catalog footer repeats scalar 0x66 with the same value.
      if (previous && !(tag === 0x66 && Buffer.isBuffer(previous) && previous.equals(value)))
        throw new Error(`Conflicting or duplicate broker field 0x${tag.toString(16)}.`);
      result.set(tag, value);
      offset += length;
      continue;
    }
    if (result.has(tag)) throw new Error(`Duplicate broker list 0x${tag.toString(16)}.`);
    if (offset + 4 > buffer.length) throw new Error('Truncated broker list header.');
    const length = buffer.readUInt16BE(offset);
    const count = buffer.readUInt16BE(offset + 2);
    offset += 4;
    const end = offset + length - 2;
    if (length < 2 || end > buffer.length) throw new Error('Invalid broker list length.');
    if (skipGroups) {
      result.set(tag, buffer.subarray(offset, end));
      offset = end;
      continue;
    }
    const entries = [];
    for (let index = 0; index < count; index++) {
      const recordGroup = RECORD_GROUPS.has(tag);
      const width = recordGroup ? 2 : 1;
      if (offset + width > end) throw new Error('Truncated broker list entry length.');
      let size = width === 2 ? buffer.readUInt16BE(offset) : buffer[offset];
      offset += width;
      if (width === 1 && size === 0xff) {
        if (offset + 2 > end) throw new Error('Truncated extended list entry length.');
        size = buffer.readUInt16BE(offset);
        offset += 2;
      }
      if (offset + size > end) throw new Error('Truncated broker list entry.');
      const value = buffer.subarray(offset, offset + size);
      entries.push(recordGroup ? fields(value, depth + 1) : value);
      offset += size;
    }
    if (offset !== end) throw new Error('Broker list count does not match its length.');
    result.set(tag, entries);
  }
  return result;
}

function text(value, label) {
  if (!Buffer.isBuffer(value) || !value.length)
    throw new Error(`Unsupported or missing ${label} in broker catalog.`);
  let decoded;
  try { decoded = utf8.decode(value); }
  catch { throw new Error(`Invalid UTF-8 ${label} in broker response.`); }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(decoded)) throw new Error(`Invalid ${label} in broker response.`);
  return decoded;
}

export function parseNegotiation(frame) {
  const reply = fields(frameBody(frame, NEGOTIATE));
  const parts = reply.get(0x9f);
  if (!Array.isArray(parts) || parts.length < 1) throw new Error('Broker did not return protocol version information.');
  const version = text(parts[0], 'broker version');
  if (version !== '8.1') throw new Error(`Broker ${version} has not been verified by this experimental direct reader.`);
  return { version, operatingSystem: 'windows' };
}

function catalogPage(frame, queriedServer) {
  const reply = fields(frameBody(frame, CATALOG));
  const mode = reply.get(0x6b);
  if (!Buffer.isBuffer(mode) || mode.length !== 4 || mode.readUInt32BE() !== 0)
    throw new Error('Unrecognized broker catalog mode; no partial list was returned.');
  const cursor = reply.get(0x5e);
  if (!Buffer.isBuffer(cursor) || cursor.length !== 15) throw new Error('Missing or unsupported broker catalog cursor.');
  const rows = reply.get(CATALOG_GROUP);
  if (!Array.isArray(rows)) throw new Error('Broker response contains no datastore catalog.');
  const entries = [];
  const unique = new Set();
  for (const row of rows) {
    if (row.has(0x5d) || row.has(0x5e) || row.has(0x62)) {
      let server;
      if (row.has(0x5d)) server = text(row.get(0x5d), 'datastore server');
      else {
        // 8.1 omits the hostname for datastores on the queried broker's server.
        if (typeof queriedServer !== 'string') throw new Error('Broker omitted the local datastore server; the queried endpoint is required.');
        validateEndpoint(queriedServer, 9700);
        server = queriedServer;
      }
      const name = text(row.get(0x5e), 'datastore name');
      const portValue = row.get(0x62);
      if (!Buffer.isBuffer(portValue) || portValue.length !== 2) throw new Error('Invalid datastore port.');
      const port = portValue.readUInt16BE();
      if (!port) throw new Error('Broker returned an invalid datastore port.');
      const key = `${server.toLowerCase()}\0${name}`;
      if (unique.has(key)) throw new Error('Duplicate datastore identity in broker response.');
      unique.add(key);
      const entry = { name, server, port };
      if (row.has(0x32)) entry.authenticationContext = text(row.get(0x32), 'authentication context');
      entries.push(entry);
    } else if (!row.has(0x68) || !row.has(0x61)) {
      throw new Error('Unsupported record in broker catalog; refusing to publish an incomplete list.');
    }
  }
  return { entries, cursor: cursor.every(byte => byte === 0x20) ? null : Buffer.from(cursor) };
}

export function parseCatalog(frame, queriedServer) {
  const page = catalogPage(frame, queriedServer);
  if (page.cursor) throw new Error('Continued broker catalog requires readCatalog; no partial list was returned.');
  return page.entries;
}

export async function readCatalog(exchange, server) {
  const result = [], identities = new Set(), cursors = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = catalogPage(await exchange(catalogRequest(cursor)), server);
    for (const entry of page.entries) {
      const key = `${entry.server.toLowerCase()}\0${entry.name}`;
      if (identities.has(key)) throw new Error('Duplicate datastore across catalog pages; no partial list was returned.');
      identities.add(key);
      result.push(entry);
    }
    if (!page.cursor) return result;
    const key = page.cursor.toString('hex');
    if (cursors.has(key)) throw new Error('Repeated catalog cursor; no partial list was returned.');
    cursors.add(key);
    cursor = page.cursor;
  }
  throw new Error('Broker catalog exceeded the supported page limit; no partial list was returned.');
}

class Frames {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.error = null;
    socket.on('data', data => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 131070) return this.fail(new Error('Broker response exceeded the size limit.'));
      this.deliver();
    });
    socket.on('error', error => this.fail(error));
    socket.on('end', () => this.fail(new Error('Broker closed the connection before completing its response.')));
    socket.on('close', () => this.fail(new Error('Broker connection is closed.')));
  }
  fail(error) {
    this.error = error;
    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
    }
    this.socket.destroy();
  }
  deliver() {
    if (!this.pending || this.buffer.length < 6) return;
    if (!this.buffer.subarray(0, 4).equals(MAGIC)) return this.fail(new Error('Endpoint did not return an Enabler broker frame.'));
    const size = this.buffer.readUInt16BE(4);
    if (size < HEADER_SIZE) return this.fail(new Error('Invalid broker frame length.'));
    if (this.buffer.length < size) return;
    const frame = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    const pending = this.pending;
    this.pending = null;
    pending.resolve(frame);
  }
  next() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.deliver();
    });
  }
}

export function validateEndpoint(server, port) {
  if (typeof server !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,252}$/i.test(server))
    throw Object.assign(new Error('Zadajte názov servera alebo IPv4 adresu, nie URL či cestu.'), { status: 400 });
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Object.assign(new Error('Neplatný port brokera.'), { status: 400 });
}

export async function withConnection(server, { port = 9700, timeoutMs = 5000, secure = false, ca, idleTimeout = false, signal, assignRequestNumber = true } = {}, action) {
  validateEndpoint(server, port);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid direct broker timeout.');
  signal?.throwIfAborted();
  const trusted = secure ? ca ?? (typeof tls.getCACertificates === 'function'
    ? [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])] : undefined) : undefined;
  const socket = secure ? tls.connect({
    host: server, port, servername: net.isIP(server) ? undefined : server, rejectUnauthorized: true,
    minVersion: 'TLSv1.2', ca: trusted,
  }) : net.createConnection({ host: server, port });
  const frames = new Frames(socket);
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => frames.fail(Object.assign(new Error(`Priame TCP pripojenie neodpovedalo do ${timeoutMs} ms.`), { code: 'TCP_TIMEOUT' })), timeoutMs);
  };
  const abort = () => frames.fail(Object.assign(new Error('Čítanie bolo zrušené.'), { code: 'ABORT_ERR' }));
  signal?.addEventListener('abort', abort, { once: true });
  arm();
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off(secure ? 'secureConnect' : 'connect', ready);
        socket.off('error', failed);
        socket.off('close', closed);
      };
      const failed = error => { cleanup(); reject(error); };
      const closed = () => failed(frames.error ?? new Error('Broker connection closed during setup.'));
      const ready = () => { cleanup(); resolve(); };
      socket.once(secure ? 'secureConnect' : 'connect', ready);
      socket.once('error', failed);
      socket.once('close', closed);
    });
    if (secure && !socket.authorized) throw Object.assign(new Error('TLS certificate was not verified.'), { code: 'TLS_NOT_AUTHORIZED' });
    const exchange = async packet => {
      if (frames.error) throw frames.error;
      signal?.throwIfAborted();
      if (idleTimeout) arm();
      if (assignRequestNumber) {
        packet.writeUInt32BE(requestNumber, 36);
        requestNumber = requestNumber === 0xffffffff ? 1 : requestNumber + 1;
      }
      await new Promise((resolve, reject) => socket.write(packet, error => error ? reject(error) : resolve()));
      return frames.next();
    };
    return await action({ exchange, encrypted: secure && socket.authorized });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    socket.destroy();
  }
}

export async function withBroker(server, options = {}, action) {
  return withConnection(server, options, async connection => {
    const protocol = parseNegotiation(await connection.exchange(negotiationRequest()));
    return action({ ...connection, protocol });
  });
}

export async function listDatastores(server, options = {}) {
  const start = performance.now();
  return withBroker(server, options, async ({ exchange, protocol }) => {
    const repositories = await readCatalog(exchange, server);
    return { transport: 'direct-tcp', server, port: options.port ?? 9700, protocol: protocol.version,
      elapsedMs: Math.round(performance.now() - start), repositories, modelReadingSupported: false };
  });
}

export function loginContextsRequest() {
  return requestFrame(LOGIN_CONTEXTS, scalar(0x5e, Buffer.alloc(0)));
}

export function parseLoginContexts(frame) {
  const reply = fields(frameBody(frame, LOGIN_CONTEXTS));
  const contexts = reply.get(0xb2), mode = reply.get(0xc3);
  if (!Array.isArray(contexts) || !Array.isArray(mode) || mode.length !== 1)
    throw new Error('Broker did not return recognizable login context information.');
  return { contexts: contexts.map(value => text(value, 'login context')), mode: text(mode[0], 'login mode') };
}

export async function authenticationInfo(server, options = {}) {
  return withBroker(server, options, async ({ exchange, protocol, encrypted }) => ({
    ...parseLoginContexts(await exchange(loginContextsRequest())), protocol: protocol.version, encrypted,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('Použitie: node direct-broker.mjs <server>'); process.exitCode = 1; }
  else listDatastores(process.argv[2]).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
