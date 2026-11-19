import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authenticateWindowsShare } from '../windows-smb.mjs';

test('Windows authentication uses the exact share identity, not a local-process or caller-supplied replacement', async () => {
  const calls = [];
  const result = await authenticateWindowsShare('test-server', { platform: 'win32', runHelper: async server => {
    calls.push(server);
    return { ok: true, shareReadable: true, identity: 'NETWORK\\verified-user', password: 'synthetic-extra' };
  } });
  assert.deepEqual(calls, ['test-server']);
  assert.equal(result.verifiedUserId, 'NETWORK\\verified-user');
  assert.equal(result.method, 'windows-smb');
  assert.equal(result.share, '\\\\test-server\\enabler');
  assert.equal(result.credentialsRequested, false);
  assert.equal(result.persistentMapping, false);
  assert.equal(Object.hasOwn(result, 'password'), false);
});

test('unsupported platforms and invalid server paths never invoke the Windows helper', async () => {
  let calls = 0;
  const runHelper = async () => { calls++; throw new Error('Unexpected'); };
  await assert.rejects(authenticateWindowsShare('test-server', { platform: 'linux', runHelper }), error => error.code === 'WINDOWS_REQUIRED');
  await assert.rejects(authenticateWindowsShare('server\\other-share', { platform: 'win32', runHelper }), error => error.status === 400);
  assert.equal(calls, 0);
});

test('access denial, mapping conflicts and unresolved identity do not become anonymous success or UserIdent fallback', async () => {
  for (const [windowsCode, expected] of [[5, 'WINDOWS_ACCESS'], [1219, 'WINDOWS_CONFLICT'], [2250, 'WINDOWS_ACCESS']])
    await assert.rejects(authenticateWindowsShare('test-server', { platform: 'win32',
      runHelper: async () => ({ ok: false, windowsCode }) }), error => error.code === expected && error.windowsCode === windowsCode);
  for (const identity of ['', 'unqualified-user', 'DOMAIN\\user\\extra'])
    await assert.rejects(authenticateWindowsShare('test-server', { platform: 'win32',
      runHelper: async () => ({ ok: true, shareReadable: true, identity }) }), error => error.code === 'WINDOWS_IDENTITY');
});

test('unexpected helper failures cannot expose captured identity or process output', async () => {
  await assert.rejects(authenticateWindowsShare('test-server', { platform: 'win32',
    runHelper: async () => { throw new Error('private-user-value'); } }),
  error => error.code === 'WINDOWS_RUNTIME' && !error.message.includes('private-user-value'));
});

test('Windows helper requests no password, saved mapping, prompt, disconnection or vendor component', async () => {
  const source = await readFile(new URL('../windows-smb.mjs', import.meta.url), 'utf8');
  assert.match(source, /WNetAddConnection2\(ref resource,null,null,0\)/);
  assert.doesNotMatch(source, /WNetCancelConnection|CONNECT_UPDATE_PROFILE|CONNECT_PROMPT|CONNECT_INTERACTIVE|ComObject|Cna36|SFC36|ExecutionPolicy/i);
});

test('live Windows authentication works with the existing OS credentials without revealing identity values', {
  skip: !process.env.SELECT_WINDOWS_SERVER || process.platform !== 'win32', timeout: 20000,
}, async () => {
  const result = await authenticateWindowsShare(process.env.SELECT_WINDOWS_SERVER);
  assert.equal(result.method, 'windows-smb');
  assert.equal(result.shareReadable, true);
  assert.equal(result.networkIdentityVerified, true);
  assert.equal(result.credentialsRequested, false);
  assert.equal(result.persistentMapping, false);
  assert.ok(result.verifiedUserId.includes('\\'));
});
