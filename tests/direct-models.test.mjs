import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { datastoreNegotiation, readModelCatalog, listModels } from '../direct-models.mjs';
import { fields, requestFrame, scalar } from '../direct-broker.mjs';
import { WindowsShareError } from '../windows-smb.mjs';
import { string, integer, list, reply, negotiation } from './protocol-fixture.mjs';

const identity = 'TEST\\reader';
const model = { id: '0001000200000001', name: 'Test model', version: '0' };
const authentication = { method: 'windows-smb', server: 'data-server', verifiedUserId: identity,
  shareReadable: true, networkIdentityVerified: true, credentialsRequested: false, persistentMapping: false };
const dependencies = {
  repositories: async () => ({ repositories: [{ name: 'Example', server: 'data-server', port: 6200 }] }),
  windowsConnect: async () => ({ ...authentication }),
};

function modelPage(models = [model], { end = 'Y', user = identity, className = '_Ent2_Model', cursor = 'cursor' } = {}) {
  const prefix = Buffer.concat([
    string(7, className), string(2, user), string(0x3d, 'V'), string(0x3e, 'X'),
    string(0x46, end), string(8, cursor), integer(0x56, 0, 2),
  ]);
  prefix.writeUInt16BE(40 + prefix.length, prefix.length - 2);
  const frame = reply(0x37, Buffer.concat([prefix, list(0xc9, models.map(item => Buffer.concat([
    string(8, item.name), string(9, item.version), scalar(10, Buffer.from(item.id, 'hex')),
  ])))]));
  frame.fill(0, 8, 24);
  return frame;
}

test('datastore negotiation and model requests use a zero context, not a broker marker or application ID', async () => {
  const packet = datastoreNegotiation('Example', identity, 60);
  assert.equal(packet.readUInt16BE(6), 0x93);
  assert.ok(packet.subarray(8, 24).equals(Buffer.alloc(16)));
  const body = fields(packet.subarray(40));
  assert.equal(body.get(2).toString(), identity);
  assert.equal(body.get(0x5e).toString(), 'Example');
  assert.equal(body.get(0x9f)[0].toString(), '8.1');
  assert.equal(body.get(0x38).toString(), '60');
  assert.equal(body.get(0x5c).readUInt32BE(), 8511);
  let actual;
  assert.deepEqual(await readModelCatalog(async request => { actual = request; return modelPage(); }, identity), [model]);
  // Complete observed OSOLST shape, with only a synthetic network principal.
  assert.equal(actual.toString('hex'),
    '32ff2806004800370000000000000000000000000000000000000000373030300000000c00000000' +
    '020b544553545c726561646572070b5f456e74325f4d6f64656c3d01563e0158');
  assert.throws(() => requestFrame(0xc6, Buffer.alloc(0)), /read-only/);
  assert.throws(() => requestFrame(0x93, Buffer.alloc(0), Buffer.alloc(16)), /context/);
});

test('reads every model page using the exact response restart prefix, with UTF-8 and canonical Windows identity', async () => {
  const next = { ...model, id: '0001000200000002', name: 'Analýza služby', version: '2' };
  const pages = [modelPage([model], { end: 'N', user: identity.toUpperCase() }), modelPage([next])];
  const first = Buffer.from(pages[0]);
  first.fill(0x5a, 16, 28);
  pages[0] = first;
  let calls = 0;
  const models = await readModelCatalog(async packet => {
    if (calls === 1) {
      const length = fields(first.subarray(40)).get(0x56).readUInt16BE();
      assert.deepEqual(packet.subarray(40), first.subarray(40, length));
      assert.ok(packet.subarray(8, 16).equals(Buffer.alloc(8)));
      assert.ok(packet.subarray(16, 28).equals(Buffer.alloc(12, 0x5a)));
    }
    return pages[calls++];
  }, identity);
  assert.deepEqual(models, [model, next]);
  assert.equal(calls, 2);
  assert.deepEqual(await readModelCatalog(async () => modelPage([]), identity), []);
});

test('rejects mismatched identity/class, duplicate objects, repeated cursors, invalid UTF-8 and failed continuation', async () => {
  for (const options of [{ user: 'OTHER\\account' }, { className: 'Context' }, { end: '?' }])
    await assert.rejects(readModelCatalog(async () => modelPage([model], options), identity));
  await assert.rejects(readModelCatalog(async () => modelPage([model, model]), identity), /Duplicate/);
  await assert.rejects(readModelCatalog(async () => modelPage([], { end: 'N' }), identity), /Repeated/);
  const badName = modelPage();
  const name = fields(badName.subarray(40)).get(0xc9)[0].get(8);
  name[0] = 0xff;
  await assert.rejects(readModelCatalog(async () => badName, identity), /encoded data/);
  const badRestart = modelPage([], { end: 'N' });
  fields(badRestart.subarray(40)).get(0x56).fill(0);
  await assert.rejects(readModelCatalog(async () => badRestart, identity), /restart/);
  let count = 0;
  await assert.rejects(readModelCatalog(async () => {
    if (count++) throw new Error('Continuation disconnected');
    return modelPage([model], { end: 'N' });
  }, identity), /Continuation disconnected/);
});

test('binds Windows authentication and TCP to the selected catalog endpoint, never to a supplied identity or port', async () => {
  const requests = [];
  const result = await listModels('broker-server', 'Example', {
    ...dependencies,
    windowsConnect: async server => {
      assert.equal(server, 'data-server');
      return authentication;
    },
    connect: async (server, options, action) => {
      assert.equal(server, 'data-server');
      assert.equal(options.port, 6200);
      return action({ exchange: async packet => {
        requests.push(packet.readUInt16BE(6));
        return requests.length === 1 ? negotiation('8.1') : modelPage();
      } });
    },
  });
  assert.deepEqual(requests, [0x93, 0x37]);
  assert.deepEqual(result.models, [model]);
  assert.equal(result.complete, true);
  assert.equal(result.modelReadingSupported, true);
  assert.ok(!JSON.stringify(result).includes(identity));
});

test('unknown repositories, denied Windows access and protocol failures cannot fall back or leak a principal', async () => {
  let connections = 0;
  const connect = async () => { connections++; throw new Error(identity); };
  await assert.rejects(listModels('broker-server', 'Missing', { ...dependencies, connect }),
    error => error.code === 'MODEL_REPOSITORY');
  await assert.rejects(listModels('broker-server', 'Example', { ...dependencies, connect,
    windowsConnect: async () => { throw new WindowsShareError('WINDOWS_ACCESS', 'Access denied.', 403); } }),
  error => error.code === 'WINDOWS_ACCESS' && error.status === 403);
  assert.equal(connections, 0);
  await assert.rejects(listModels('broker-server', 'Example', { ...dependencies, connect }),
    error => error.code === 'MODEL_CONNECTION' && !JSON.stringify(error).includes(identity) && !error.message.includes(identity));
  assert.equal(connections, 1);
  const source = await readFile(new URL('../direct-models.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process|jena\.jar|Enabler70|\.dll|verifyCredentials/);
});

test('native model transport handles fragmented TCP, negotiates once and closes after the complete catalog', async t => {
  const sockets = new Set(), operations = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 6 && buffer.length >= buffer.readUInt16BE(4)) {
        const request = buffer.subarray(0, buffer.readUInt16BE(4));
        buffer = buffer.subarray(request.length);
        const op = request.readUInt16BE(6);
        operations.push(op);
        assert.ok(request.subarray(8, 24).equals(Buffer.alloc(16)));
        const response = op === 0x93 ? negotiation('8.1') : modelPage();
        socket.write(response.subarray(0, 11));
        setImmediate(() => socket.write(response.subarray(11)));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const result = await listModels('broker-server', 'Example', {
    ...dependencies, repositories: async () => ({ repositories: [{ name: 'Example', server: '127.0.0.1', port: server.address().port }] }),
  });
  assert.deepEqual(result.models, [model]);
  assert.deepEqual(operations, [0x93, 0x37]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.size, 0);
});

test('live native model list contains distinct server-backed models without revealing authentication metadata', {
  skip: !process.env.SELECT_MODEL_SERVER || !process.env.SELECT_MODEL_REPOSITORY,
}, async () => {
  const result = await listModels(process.env.SELECT_MODEL_SERVER, process.env.SELECT_MODEL_REPOSITORY);
  assert.equal(result.complete, true);
  assert.ok(result.models.length > 0);
  assert.equal(new Set(result.models.map(item => item.id)).size, result.models.length);
  assert.ok(result.models.every(item => /^[a-f0-9]{16}$/.test(item.id) && item.name && item.version));
  assert.equal(Object.hasOwn(result, 'verifiedUserId'), false);
  if (process.env.SELECT_MODEL_EXPECTED)
    assert.deepEqual(result.models.map(item => item.name).sort(), process.env.SELECT_MODEL_EXPECTED.split('|').sort());
});
