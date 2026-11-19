import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fields, authenticationInfo, clientVersionFields } from '../direct-broker.mjs';
import { credentials, userIdentRequest, prepareAuthentication, verifyCredentials, publicAuthenticationError } from '../native-auth.mjs';
import { reply, negotiation, catalog, record, contexts, string } from './protocol-fixture.mjs';

let directory, certificate, key;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'select-auth-tls-'));
  const openssl = process.env.OPENSSL_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'certificate.pem')], { windowsHide: true });
  [certificate, key] = await Promise.all([readFile(path.join(directory, 'certificate.pem')), readFile(path.join(directory, 'key.pem'))]);
});
after(async () => { if (directory) await rm(directory, { recursive: true }); });

async function broker(t, { onAuth, context = 'default', secure = true, operatingSystemId = 19, paged = false } = {}) {
  const operations = [], sockets = new Set();
  const handler = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 6 && buffer.length >= buffer.readUInt16BE(4)) {
        const size = buffer.readUInt16BE(4), packet = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        const opcode = packet.readUInt16BE(6);
        operations.push(opcode);
        if (opcode === 0x93) {
          const response = negotiation('8.1');
          response.writeUInt32BE(operatingSystemId, 32);
          socket.write(response);
        }
        else if (opcode === 0xce) socket.write(contexts());
        else if (opcode === 0xfe) {
          if (paged && !fields(packet.subarray(40)).has(0x5e)) {
            const cursor = Buffer.alloc(15);
            cursor.write('NEXT_PAGE');
            socket.write(catalog([record('Other', 6201, context, { omitServer: true })], 0, cursor));
          } else socket.write(catalog([record('Example', 6200, context, { omitServer: true })]));
        }
        else if (opcode === 0x102) socket.write(onAuth?.(packet) ?? reply(0x102, string(0x02, 'verified-test-user')));
        else socket.destroy();
      }
    });
  };
  const server = secure ? tls.createServer({ cert: certificate, key, minVersion: 'TLSv1.2' }, handler) : net.createServer(handler);
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, operations };
}
const input = port => ({ server: '127.0.0.1', port, repository: 'Example', username: 'test-user', domain: 'TEST', password: 'synthetic-only-password' });

test('validates qualified usernames and preserves valid UTF-8 without lossy substitution', () => {
  assert.deepEqual(credentials({ ...input(9700), username: 'TEST\\test-user', domain: '' }), input(9700));
  assert.throws(() => credentials({ ...input(9700), username: 'OTHER\\test-user' }), /samostatne/);
  assert.equal(credentials({ ...input(9700), password: 'Unicode-á€č' }).password, 'Unicode-á€č');
  assert.throws(() => credentials({ ...input(9700), password: 'invalid-\ud800' }), /Unicode/);
  assert.throws(() => credentials({ ...input(9700), password: 'x'.repeat(256) }), /255/);
  assert.throws(() => credentials({ ...input(9700), password: '€'.repeat(86) }), /255/);
});

test('encodes the complete 8.1 version, qualified identity and UTF-8 credential layout', () => {
  const packet = userIdentRequest({ ...input(9700), password: 'synthetic-á' }, { operatingSystem: 'windows' });
  const body = fields(packet.subarray(40));
  assert.equal(packet.readUInt16BE(6), 0x102);
  assert.equal(body.get(0x5e).toString('ascii'), 'Example');
  const parts = body.get(0xc3);
  assert.deepEqual(body.get(0x9f).map(value => value.toString('utf8')), ['8.1', '8', '1', '1', '0', '31', 'Release 8.1']);
  assert.deepEqual(parts.map(value => value.toString('utf8')), ['TEST\\test-user', 'synthetic-á', 'test-user', 'TEST']);
  assert.equal(parts[1].subarray(-2).toString('hex'), 'c3a1');
  packet.fill(0);
  const longest = userIdentRequest({ ...input(9700), password: 'x'.repeat(255) }, { operatingSystem: 'windows' });
  const passwordOffset = 40 + clientVersionFields().length + 2 + 'Example'.length + 5 + 1 + 'TEST\\test-user'.length;
  assert.equal(longest.subarray(passwordOffset, passwordOffset + 3).toString('hex'), 'ff00ff');
  assert.equal(fields(longest.subarray(40)).get(0xc3)[1].length, 255);
  longest.fill(0);
  const multibyte = userIdentRequest({ ...input(9700), password: '€'.repeat(85) }, { operatingSystem: 'windows' });
  const password = fields(multibyte.subarray(40)).get(0xc3)[1];
  assert.equal(password.length, 255);
  assert.equal(password.toString('utf8'), '€'.repeat(85));
  multibyte.fill(0);
});

test('preserves non-ASCII names, domains and passwords exactly as UTF-8', () => {
  const packet = userIdentRequest({ repository: 'Example', username: 'používateľ', domain: 'DÓMENA', password: 'heslo-€🙂' },
    { operatingSystem: 'windows' });
  assert.deepEqual(fields(packet.subarray(40)).get(0xc3).map(value => value.toString('utf8')),
    ['DÓMENA\\používateľ', 'heslo-€🙂', 'používateľ', 'DÓMENA']);
  packet.fill(0);
});

test('matches a blocked official 8.1 synthetic request byte-for-byte, not just individual fields', () => {
  // Synthetic SDK capture: repository and request counter normalized; no real credentials.
  const expected = Buffer.from(
    '32ff2806009d01021234567890000000000000000000000000000000373030300000000c00000000' +
    '9f001d000703382e3101380131013101300233310b52656c6561736520382e31' +
    '5e074578616d706c65c3004900041c4558414d504c455c6e61746976652d696e7465726f702d70726f6265' +
    '0c73796e7468657469632dc3a1146e61746976652d696e7465726f702d70726f6265074558414d504c45', 'hex');
  const packet = userIdentRequest({ repository: 'Example', username: 'native-interop-probe', domain: 'EXAMPLE', password: 'synthetic-á' },
    { operatingSystem: 'windows' });
  assert.ok(packet.equals(expected), 'The complete request must match the independent SDK reference');
  packet.fill(0); expected.fill(0);
});

test('Windows uses the qualified identity; Unix and domain-free accounts retain their exact names', () => {
  for (const [operatingSystem, domain, expected] of [['windows', 'TEST', 'TEST\\test-user'], ['unix', 'TEST', 'test-user'], ['windows', '', 'test-user']]) {
    const packet = userIdentRequest({ ...input(9700), domain, password: '' }, { operatingSystem });
    const author = fields(packet.subarray(40)).get(0xc3);
    assert.equal(author[0].toString('latin1'), expected);
    assert.equal(author[1].length, 0);
    assert.equal(author[2].toString('latin1'), 'test-user');
    packet.fill(0);
  }
  assert.throws(() => userIdentRequest(input(9700)), error => error.code === 'AUTH_PLATFORM');
});

test('both UI account formats produce the same qualified Windows login', () => {
  const separate = credentials(input(9700));
  const combined = credentials({ ...input(9700), domain: '', username: 'TEST\\test-user' });
  const first = userIdentRequest(separate, { operatingSystem: 'windows' });
  const second = userIdentRequest(combined, { operatingSystem: 'windows' });
  assert.ok(first.equals(second));
  first.fill(0); second.fill(0);
  assert.equal(credentials({ ...input(9700), password: '' }).password, '');
});
test('preflight validates real TLS and advertised context without sending credentials', async t => {
  const fake = await broker(t);
  const result = await prepareAuthentication(input(fake.port), { ca: certificate });
  assert.equal(result.encrypted, true);
  assert.equal(result.mechanism, 'UserIdent');
  assert.equal(result.modelAccessVerified, false);
  assert.deepEqual(fake.operations, [0x93, 0xce, 0xfe]);
});

test('credential verification sends one TLS-protected request and clears the provided password', async t => {
  let observed;
  const fake = await broker(t, { onAuth: packet => {
    observed = fields(packet.subarray(40)).get(0xc3).map(value => value.toString('latin1'));
    return reply(0x102, string(0x02, 'verified-test-user'));
  } });
  const value = input(fake.port), secret = value.password;
  const result = await verifyCredentials(value, { ca: certificate });
  assert.deepEqual(fake.operations, [0x93, 0xce, 0xfe, 0x102]);
  assert.equal(observed[1], secret);
  assert.equal(observed[0], 'TEST\\test-user');
  assert.equal(result.credentialsVerified, true);
  assert.equal(result.modelAccessVerified, false);
  assert.equal(value.password, '');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('finds the selected repository beyond the first 8.1 page before sending a single credential request', async t => {
  const fake = await broker(t, { paged: true });
  const result = await verifyCredentials(input(fake.port), { ca: certificate });
  assert.equal(result.credentialsVerified, true);
  assert.deepEqual(fake.operations, [0x93, 0xce, 0xfe, 0xfe, 0x102]);
});

test('allows an intentionally blank UserIdent password without inventing or retrying credentials', async t => {
  let observed;
  const fake = await broker(t, { onAuth: packet => {
    observed = fields(packet.subarray(40)).get(0xc3);
    return reply(0x102, string(0x02, 'verified-test-user'));
  } });
  const result = await verifyCredentials({ ...input(fake.port), password: '' }, { ca: certificate });
  assert.equal(result.credentialsVerified, true);
  assert.equal(observed[0].toString('latin1'), 'TEST\\test-user');
  assert.equal(observed[1].length, 0);
  assert.equal(fake.operations.filter(code => code === 0x102).length, 1);
});

test('untrusted certificates and an ADS profile never receive a password request', async t => {
  const untrusted = await broker(t);
  const value = input(untrusted.port);
  await assert.rejects(verifyCredentials(value), error => error.code === 'AUTH_TLS');
  assert.equal(value.password, '');
  assert.deepEqual(untrusted.operations, []);
  const ads = await broker(t, { context: 'ads' });
  await assert.rejects(verifyCredentials(input(ads.port), { ca: certificate }), error => error.code === 'AUTH_MECHANISM');
  assert.ok(!ads.operations.includes(0x102));
  const unknown = await broker(t, { operatingSystemId: 0 });
  await assert.rejects(verifyCredentials(input(unknown.port), { ca: certificate }), error => error.code === 'AUTH_PLATFORM');
  assert.ok(!unknown.operations.includes(0x102));
});

test('native authentication refuses a plain TCP endpoint without leaking or retrying credentials', async t => {
  let observed = Buffer.alloc(0);
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('data', data => { observed = Buffer.concat([observed, data]); socket.end('plain endpoint'); });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const value = input(server.address().port), secret = value.password;
  await assert.rejects(verifyCredentials(value), error => error.code === 'AUTH_TLS' || error.code === 'AUTH_CONNECTION');
  assert.ok(!observed.includes(Buffer.from(secret)));
  assert.equal(value.password, '');
});

test('explicit plaintext consent enables native TCP verification without changing the secure default', async t => {
  const fake = await broker(t, { secure: false });
  const target = { ...input(fake.port), allowPlaintext: true };
  const prepared = await prepareAuthentication(target);
  assert.equal(prepared.encrypted, false);
  assert.ok(!fake.operations.includes(0x102));
  const result = await verifyCredentials(target);
  assert.equal(result.encrypted, false);
  assert.equal(result.credentialsVerified, true);
  assert.equal(target.password, '');
  assert.equal(fake.operations.filter(opcode => opcode === 0x102).length, 1);
});

test('a string or omitted consent cannot select plaintext authentication', async () => {
  await assert.rejects(verifyCredentials({ ...input(9700), allowPlaintext: 'true' }), error => error.code === 'AUTH_INPUT');
  assert.ok(!Object.hasOwn(credentials(input(9700)), 'allowPlaintext'));
});

test('server rejection and malformed success do not echo server payloads or become authenticated', async t => {
  const secret = 'synthetic-secret-not-for-logs';
  const rejected = await broker(t, { onAuth: () => {
    const frame = reply(0x102, string(0x02, secret));
    frame.write('7945', 28, 'ascii');
    return frame;
  } });
  await assert.rejects(verifyCredentials(input(rejected.port), { ca: certificate }),
    error => error.code === 'AUTH_REJECTED' && error.serverCode === 7945 && !error.message.includes(secret));
  assert.equal(rejected.operations.filter(code => code === 0x102).length, 1);
  const malformed = await broker(t, { onAuth: () => reply(0x102, Buffer.alloc(0)) });
  await assert.rejects(verifyCredentials(input(malformed.port), { ca: certificate }), error => error.code === 'AUTH_RESPONSE');
  assert.ok(!publicAuthenticationError(new Error(secret)).message.includes(secret));
});

test('distinguishes an unknown UserIdent account from a rejected password without echoing either', async t => {
  for (const [serverCode, expectedCode] of [[7942, 'AUTH_USER_NOT_FOUND'], [7943, 'AUTH_BAD_PASSWORD']]) {
    const secret = 'synthetic-response-not-for-display';
    const rejected = await broker(t, { onAuth: () => {
      const frame = reply(0x102, string(0x02, secret));
      frame.write(String(serverCode), 28, 'ascii');
      return frame;
    } });
    const value = input(rejected.port);
    await assert.rejects(verifyCredentials(value, { ca: certificate }), error =>
      error.code === expectedCode && error.serverCode === serverCode && error.status === 401 &&
      error.message.includes('UserIdent') && !error.message.includes(secret));
    assert.equal(value.password, '');
    assert.equal(rejected.operations.filter(code => code === 0x102).length, 1);
  }
});

test('login-context discovery is independently readable without credentials', async t => {
  const fake = await broker(t, { secure: false });
  const result = await authenticationInfo('127.0.0.1', { port: fake.port });
  assert.deepEqual(result.contexts, ['default', 'user_ident_by_file', 'ads']);
  assert.equal(result.mode, 'client');
  assert.equal(result.encrypted, false);
  assert.deepEqual(fake.operations, [0x93, 0xce]);
});
