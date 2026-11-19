import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { catalogRequest, negotiationRequest, requestFrame, frameBody, fields, parseNegotiation, parseCatalog, readCatalog, listDatastores } from '../direct-broker.mjs';
import { string, integer, list, record, reply, negotiation, catalog } from './protocol-fixture.mjs';

const exec = promisify(execFile);

async function tcp(t, onSocket) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onSocket(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('direct client only constructs the two observed read-only operations', () => {
  assert.equal(negotiationRequest().length, 86);
  assert.equal(catalogRequest().length, 46);
  assert.equal(negotiationRequest().readUInt16BE(6), 0x93);
  assert.equal(catalogRequest().readUInt16BE(6), 0xfe);
  assert.throws(() => requestFrame(0x1234, Buffer.alloc(0)), /read-only/);
});

test('reads every 8.1 catalog page using its opaque cursor and the observed next-page fields', async () => {
  const cursor = Buffer.alloc(15);
  cursor.write('NEXT_PAGE');
  const responses = [
    catalog([record('One', 6001, 'default', { omitServer: true })], 0, cursor),
    catalog([record('Two', 6002, 'default', { omitServer: true })]),
  ];
  const requests = [];
  const result = await readCatalog(async packet => { requests.push(Buffer.from(packet)); return responses.shift(); }, 'queried-server');
  assert.deepEqual(result.map(entry => entry.name), ['One', 'Two']);
  assert.equal(requests[0].subarray(40).toString('hex'), '6b0400000000');
  const next = fields(requests[1].subarray(40));
  assert.ok(next.get(0x5e).equals(cursor));
  assert.equal(next.get(0x46).toString('ascii'), 'N');
  assert.equal(next.get(0x56).toString('hex'), '0040');
  assert.throws(() => parseCatalog(catalog([record()], 0, cursor)), /partial list/);
});

test('never publishes a repeated cursor, duplicate page or failed continuation as a complete list', async () => {
  const cursor = Buffer.alloc(15, 0x41);
  await assert.rejects(readCatalog(async () => catalog([], 0, cursor), 'queried-server'), /Repeated catalog cursor/);
  await assert.rejects(readCatalog(async () => catalog([record()], 0, cursor), 'queried-server'), /Duplicate datastore/);
  let calls = 0;
  await assert.rejects(readCatalog(async () => {
    if (++calls === 1) return catalog([record()], 0, cursor);
    throw new Error('Continuation connection failed');
  }, 'queried-server'), /Continuation connection failed/);
});

test('parses catalog records and optional status rows without hardcoded repository names', () => {
  const status = Buffer.concat([integer(0x68, 1), integer(0x61, 156, 2)]);
  assert.deepEqual(parseCatalog(catalog([record('One', 6001), status, record('Two', 6002)])),
    [{ server: 'test-server', name: 'One', port: 6001 }, { server: 'test-server', name: 'Two', port: 6002 }]);
  assert.deepEqual(parseCatalog(catalog([])), []);
  assert.deepEqual(parseNegotiation(negotiation('8.1')), { version: '8.1', operatingSystem: 'windows' });
});

test('8.1 local records inherit only the explicitly known query endpoint and retain UTF-8 names', () => {
  const frame = catalog([record('Analýza', 6200, 'default', { omitServer: true }), record('Remote', 6201)]);
  assert.deepEqual(parseCatalog(frame, 'queried-server'), [
    { server: 'queried-server', name: 'Analýza', port: 6200, authenticationContext: 'default' },
    { server: 'test-server', name: 'Remote', port: 6201 },
  ]);
  assert.throws(() => parseCatalog(frame), /queried endpoint/);
  assert.throws(() => parseCatalog(frame, 'http://invalid/'), /nie URL/);
});

test('rejects unknown profiles, wrong operations, incomplete framing and invalid rows', () => {
  assert.throws(() => parseNegotiation(negotiation('9.9')), /not been verified/);
  assert.throws(() => frameBody(catalog(), 0x93), /operation/);
  const badMagic = catalog();
  badMagic[0] = 0;
  assert.throws(() => parseCatalog(badMagic), /signature/);
  const badMarker = catalog();
  badMarker[28] = 0;
  assert.throws(() => parseCatalog(badMarker), /profile/);
  const badFlags = catalog();
  badFlags.writeUInt32BE(0, 32);
  assert.throws(() => parseCatalog(badFlags), /partial catalog/);
  assert.throws(() => parseCatalog(catalog().subarray(0, -1)), /Truncated/);
  assert.throws(() => parseCatalog(catalog([record()], 1)), /partial list/);
  assert.throws(() => parseCatalog(catalog([record(), record()])), /Duplicate datastore/);
  assert.throws(() => parseCatalog(catalog([record('bad', 0)])), /invalid datastore port/);
  assert.throws(() => parseCatalog(catalog([string(0x5d, 'test-server')])) , /missing datastore name/);
  assert.throws(() => parseCatalog(catalog([integer(0x68, 1)])), /incomplete list/);
});

test('rejects inconsistent list counts and conflicting scalar duplicates', () => {
  const malformed = catalog();
  malformed.writeUInt16BE(50, 60);
  assert.throws(() => parseCatalog(malformed), /Truncated/);
  const conflict = reply(0xfe, Buffer.concat([string(0x5e, ' '.repeat(15)), list(0xc9, []), integer(0x6b, 0), string(0x66, 'n'), string(0x66, 'y')]));
  assert.throws(() => parseCatalog(conflict), /Conflicting/);
  const badLength = reply(0xfe, Buffer.from([0xc9, 0, 1, 0, 0]));
  assert.throws(() => parseCatalog(badLength), /list length/);
});

test('handles arbitrarily split TCP frames with no SDK, subprocesses or native libraries', async t => {
  const operations = [];
  const requestNumbers = [];
  const port = await tcp(t, socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 6 && buffer.length >= buffer.readUInt16BE(4)) {
        const size = buffer.readUInt16BE(4), request = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        const opcode = request.readUInt16BE(6);
        operations.push(opcode);
        requestNumbers.push(request.readUInt32BE(36));
        assert.equal(request.subarray(8, 24).toString('hex'), '12345678900000000000000000000000');
        const reply = opcode === 0x93 ? negotiation('8.1') : catalog([record('Independent', 6200)]);
        socket.write(reply.subarray(0, 3));
        setImmediate(() => { socket.write(reply.subarray(3, 17)); socket.write(reply.subarray(17)); });
      }
    });
  });
  const result = await listDatastores('127.0.0.1', { port });
  assert.deepEqual(operations, [0x93, 0xfe]);
  assert.ok(requestNumbers[0] > 0 && requestNumbers[1] > requestNumbers[0]);
  assert.equal(result.repositories[0].name, 'Independent');
  assert.equal(result.transport, 'direct-tcp');
  assert.equal(result.modelReadingSupported, false);
});

test('EOF, timeouts and non-Enabler endpoints are explicit errors, not empty success', async t => {
  const closed = await tcp(t, socket => socket.end());
  await assert.rejects(listDatastores('127.0.0.1', { port: closed }), /closed/);
  const stalled = await tcp(t, () => {});
  await assert.rejects(listDatastores('127.0.0.1', { port: stalled, timeoutMs: 30 }), /neodpovedalo/);
  const http = await tcp(t, socket => socket.end('HTTP/1.1 200 OK\r\n\r\n'));
  await assert.rejects(listDatastores('127.0.0.1', { port: http }), /Enabler/);
  await assert.rejects(listDatastores('http://server/'), /nie URL/);
  await assert.rejects(listDatastores('server', { port: -1 }), /port/);
});

test('live direct catalog works even with vendor-program lookup paths removed', {
  skip: !process.env.SELECT_DIRECT_SERVER, timeout: 15000,
}, async () => {
  const module = fileURLToPath(new URL('../direct-broker.mjs', import.meta.url));
  const { stdout } = await exec(process.execPath, [module, process.env.SELECT_DIRECT_SERVER], {
    env: { ...process.env, PATH: '', CLASSPATH: '', JAVA_HOME: '', NODE_OPTIONS: '' },
    timeout: 10000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.transport, 'direct-tcp');
  assert.ok(result.repositories.length > 0);
  assert.equal(result.modelReadingSupported, false);
});
