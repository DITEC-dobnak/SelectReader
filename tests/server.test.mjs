import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cache } from '../reader.mjs';
import { createServer, Reader, currentWindowsIdentity } from '../server.mjs';
import { selection, diagram, item, snapshot } from './fixture.mjs';

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'select-reader-api-test-'));
  const cache = new Cache(directory), reader = new Reader(cache);
  const server = createServer(reader, cache, { port: 0, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, data, headers = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await cache.writes;
    await rm(directory, { recursive: true });
  });
  return { reader, cache, server, base, post };
}

test('missing-only retries preserve fresh entries and narrow the next retry after partial success', async t => {
  const keys = ['_Ent2_A','_Ent2_B','_Ent2_C'], modelId = '00010002000000ff';
  const seen = [];
  const { reader, base, post } = await setup(t, { nativeCatalog: async (_, {onReady,onBatch,retryClasses}) => {
    const i = seen.length;
    seen.push(retryClasses ? [...retryClasses] : null);
    onReady({ modelId, contextId: '0001000200000011' });
    onBatch([[diagram], [item], []][i]);
    return { complete: i === 2, schemaClasses: keys, errors: keys.slice(i+1).map(className => ({className,code:'TCP_TIMEOUT'})) };
  } });
  const target = {...selection, modelId}, headers = {Origin:base};
  for (let i=0;i<3;i++) {
    assert.equal((await post(i ? '/api/catalog/missing' : '/api/open', target, headers)).status,200);
    await reader.job;
    assert.equal(reader.state().missingTypeCount, 2-i);
  }
  assert.deepEqual(seen,[null,keys.slice(1),keys.slice(2)]);
  assert.deepEqual([...reader.entries.keys()], [diagram.id,item.id]);
  assert.equal(reader.catalogComplete,true);
  assert.equal((await post('/api/catalog/missing', target, headers)).status,409);
});

test('startup is native-only, opens no model and exposes its actual capability', async t => {
  let calls = 0;
  const { base } = await setup(t, { directList: async () => { calls++; throw new Error('Unexpected request'); } });
  assert.equal((await fetch(base)).status, 200);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.version, 2);
  assert.equal(health.transport, 'direct-tcp');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.selection, null);
  assert.equal(state.modelReadingSupported, true);
  assert.equal(state.modelListingSupported, true);
  assert.equal(calls, 0);
});

test('Reader controls require local Origin and protect an active export',async t=>{
  const exits=[], job={state:{active:true}};
  const {post,base}=await setup(t,{onExit:cmd=>exits.push(cmd),markdownExport:job});
  for(const cmd of ['stop','restart']) {
    assert.equal((await post(`/api/reader/${cmd}`,{})).status,403);
    assert.equal((await post(`/api/reader/${cmd}`,{},{Origin:base})).status,409);
  }
  job.state.active=false;
  assert.equal((await post('/api/reader/restart',{},{Origin:base})).status,202);
  assert.deepEqual(exits,['restart']);
});

test('last presence disconnect waits through export and reconnect cancels idle shutdown',async t=>{
  const exits=[],job={state:{active:true}};
  const {base}=await setup(t,{idleMs:80,onExit:cmd=>exits.push(cmd),markdownExport:job});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const connect=async()=>{
    const res=await fetch(`${base}/api/presence`,{headers:{'Sec-Fetch-Site':'same-origin'}});
    assert.equal(res.status,200);
    return ()=>res.body.cancel();
  };
  const a=await connect(), b=await connect();
  await a();await wait(120);assert.deepEqual(exits,[]);
  await b();await wait(120);assert.deepEqual(exits,[]);
  const c=await connect();job.state.active=false;
  await wait(120);assert.deepEqual(exits,[]);
  await c();await wait(160);assert.deepEqual(exits,['stop']);
});

test('catalog lists all matches of one required type without an 80-item cutoff', async t => {
  const { base, reader } = await setup(t);
  reader.entries.set(item.id, item);
  for (let n = 0; n < 101; n++) reader.entries.set(String(n), { ...diagram, id: String(n) });
  const result = await (await fetch(`${base}/api/search?type=${encodeURIComponent(diagram.type)}`)).json();
  assert.equal(result.total, 101);
  assert.equal(result.items.length, 101);
  assert.ok(result.items.every(entry => entry.type === diagram.type));
  for (const query of ['', '?type=', '?kind=diagrams'])
    assert.equal((await fetch(`${base}/api/search${query}`)).status, 400);
});

test('removing a local copy requires origin and explicit closure of the active model; other copies survive', async t => {
  const { base, post, cache, reader } = await setup(t);
  const other = { ...selection, model: 'Other' };
  await cache.save(snapshot);
  await cache.save({ ...snapshot, selection: other });
  await reader.openOffline(selection);
  assert.equal((await post('/api/cache/remove', selection)).status, 403);
  assert.equal((await post('/api/cache/remove', selection, { Origin: base })).status, 409);
  assert.equal((await post('/api/cache/remove', { ...selection, closeActive: true }, { Origin: base })).status, 200);
  assert.equal(reader.selection, null);
  assert.deepEqual((await cache.history()).map(h => h.selection), [other]);
});

test('only a locally chosen export destination can override the default; cancelling keeps the choice', async t => {
  const chosen = 'D:\\Výstupy modelov', calls = [], choices = [chosen, null];
  const { base, post } = await setup(t, {
    folderPicker: async () => choices.shift(),
    markdownExport: { base: 'default', state: { phase: 'idle' }, start: (_, resume, folder) => calls.push(folder) },
  });
  const origin = { Origin: base };
  assert.equal((await post('/api/export/folder', {})).status, 403);
  assert.equal((await post('/api/export/start', { folder: chosen }, origin)).status, 400);
  assert.deepEqual(await (await post('/api/export/folder', {}, origin)).json(), { folder: chosen });
  assert.deepEqual(await (await post('/api/export/folder', {}, origin)).json(), { folder: null });
  assert.equal((await post('/api/export/start', { folder: chosen }, origin)).status, 202);
  assert.equal((await post('/api/export/start', {}, origin)).status, 202);
  assert.deepEqual(calls, [chosen, 'default']);
});

test('Windows identity metadata is explicit about process ownership and local versus domain accounts', () => {
  const local = currentWindowsIdentity({ platform: 'win32', username: 'test-user', domain: 'TEST-PC', computer: 'test-pc' });
  assert.equal(local.qualifiedUsername, 'TEST-PC\\test-user');
  assert.equal(local.isLocalAccount, true);
  assert.equal(local.source, 'windows-process');
  assert.equal(currentWindowsIdentity({ platform: 'win32', username: 'test-user', domain: 'EXAMPLE', computer: 'TEST-PC' }).isLocalAccount, false);
  assert.equal(currentWindowsIdentity({ platform: 'win32', username: 'test-user', domain: 'EXAMPLE', computer: null }).isLocalAccount, null);
  assert.throws(() => currentWindowsIdentity({ platform: 'linux' }), error => error.status === 501);
  assert.throws(() => currentWindowsIdentity({ platform: 'win32', username: 'test-user', domain: '' }), error => error.status === 503);
});

test('identity lookup neither authenticates nor stores data or returns unrelated provider fields', async t => {
  let lookups = 0, authenticationCalls = 0;
  const { base, cache } = await setup(t, {
    identityProvider: () => {
      lookups++;
      return { ...currentWindowsIdentity({ platform: 'win32', username: 'test-user', domain: 'TEST-PC', computer: 'TEST-PC' }), password: 'synthetic-extra' };
    },
    prepareLogin: async () => { authenticationCalls++; throw new Error('Must not prepare authentication'); },
    checkLogin: async () => { authenticationCalls++; throw new Error('Must not authenticate'); },
  });
  const response = await fetch(`${base}/api/current-identity`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const identity = await response.json();
  assert.equal(identity.qualifiedUsername, 'TEST-PC\\test-user');
  assert.equal(Object.hasOwn(identity, 'password'), false);
  assert.equal(lookups, 1);
  assert.equal(authenticationCalls, 0);
  assert.deepEqual(await cache.history(), []);
});

test('normal Windows connection never calls JAAS or returns the OS principal as a credential', async t => {
  let calls = 0;
  const { base, post } = await setup(t, {
    windowsConnect: async server => {
      assert.equal(server, 'test-server');
      calls++;
      return { method: 'windows-smb', verifiedUserId: 'NETWORK\\private-principal', shareReadable: true,
        networkIdentityVerified: true, credentialsRequested: false, persistentMapping: false };
    },
    prepareLogin: async () => { throw new Error('UserIdent must not be used'); },
    checkLogin: async () => { throw new Error('UserIdent must not be used'); },
  });
  assert.equal((await post('/api/windows-connection', { server: 'test-server' })).status, 403);
  assert.equal(calls, 0);
  const response = await post('/api/windows-connection', { server: 'test-server', verifiedUserId: 'ignored-client-value' }, { Origin: base });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.method, 'windows-smb');
  assert.equal(result.credentialsRequested, false);
  assert.equal(result.modelAccessVerified, false);
  assert.ok(!JSON.stringify(result).includes('private-principal'));
  assert.equal(calls, 1);
});

test('repository discovery always uses the native client with the explicit server', async t => {
  const requests = [];
  const metadata = { transport: 'direct-tcp', repositories: [{ name: 'Native', server: 'test-server', port: 6200 }],
    elapsedMs: 12, modelReadingSupported: false };
  const { post, reader } = await setup(t, { directList: async (server, options) => {
    requests.push({ server, ...options });
    return metadata;
  } });
  for (const route of ['/api/repositories', '/api/direct-repositories']) {
    const response = await post(route, { server: 'test-server' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), metadata);
  }
  assert.deepEqual(requests, [{ server: 'test-server', port: 9700 }, { server: 'test-server', port: 9700 }]);
  assert.equal(reader.selection, null);
});

test('model enumeration requires local Origin and strips private provider metadata without opening content', async t => {
  let calls = 0;
  const { base, post, reader, cache } = await setup(t, {
    directModels: async (server, repository) => {
      assert.equal(server, selection.server);
      assert.equal(repository, selection.repository);
      calls++;
      return { complete: true, port: 6200, elapsedMs: 8, verifiedUserId: 'PRIVATE\\principal',
        models: [{ id: '0001000200000001', name: 'Example', version: '0', privateValue: 'not-for-browser' }] };
    },
    checkLogin: () => { throw new Error('UserIdent must not run'); },
  });
  assert.equal((await post('/api/models', selection)).status, 403);
  assert.equal(calls, 0);
  const response = await post('/api/models', { ...selection, verifiedUserId: 'ignored-client-principal', port: 123 }, { Origin: base });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.models, [{ id: '0001000200000001', name: 'Example', version: '0' }]);
  assert.equal(result.modelReadingSupported, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|principal|not-for-browser/);
  assert.equal(reader.selection, null);
  assert.deepEqual(await cache.history(), []);
});

test('model enumeration failures and incomplete results are explicit and cannot expose process output', async t => {
  const logs = [];
  let incomplete = false;
  const { base, post } = await setup(t, {
    directModels: async () => {
      if (incomplete) return { complete: false, models: [] };
      throw new Error('PRIVATE\\principal synthetic-sensitive-output');
    },
    logger: { error: value => logs.push(value) },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await post('/api/models', selection, { Origin: base });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.doesNotMatch(text, /principal|sensitive-output/);
    incomplete = true;
  }
  assert.doesNotMatch(JSON.stringify(logs), /principal|sensitive-output/);
});

test('online model opening streams native entries, reads details lazily and keeps a distinct offline copy', async t => {
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const modelId = '0001000200000001';
  const { base, post, reader, cache } = await setup(t, {
    nativeCatalog: async (target, { onReady, onBatch, progress }) => {
      calls++;
      assert.deepEqual(target, selection);
      onReady({ modelId, contextId: '0001000300000001' });
      onBatch([diagram, item]);
      progress({ completed: 0, total: 2, current: '_Ent2_UseCaseDiagram' });
      await pending;
      return { complete: true };
    },
    nativeDetail: async (target, entry, context) => {
      assert.equal(target.modelId, modelId);
      assert.equal(entry.id, diagram.id);
      assert.equal(context, '0001000300000001');
      return { ...snapshot.details[0][1], cached: false };
    },
  });
  assert.equal((await post('/api/open', selection)).status, 403);
  assert.equal(calls, 0);
  assert.equal((await post('/api/open', selection, { Origin: base })).status, 200);
  assert.equal(reader.state().status.phase, 'loading');
  assert.equal(reader.state().count, 2);
  assert.equal(reader.state().catalogComplete, false);
  assert.equal(reader.state().offline, false);
  const response = await fetch(`${base}/api/item/${diagram.id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).detail.diagram.symbols.length, 1);
  finish();
  await reader.job;
  assert.equal(reader.state().catalogComplete, true);
  assert.equal(reader.state().status.phase, 'ready');
  assert.ok(await cache.load({ ...selection, modelId }));
  assert.equal(await cache.load(selection), null);
  for (const route of ['/api/fulltext', '/api/stop'])
    assert.equal((await post(route, {})).status, 404);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).count, 2);
});

test('online refresh keeps the prior native copy until a complete replacement is available', async t => {
  const modelId = '0001000200000001', nativeSelection = { ...selection, modelId };
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const { base, post, reader, cache } = await setup(t, {
    nativeCatalog: async (_selection, { onReady, onBatch }) => {
      onReady({ modelId, contextId: '0001000300000001' });
      onBatch([diagram]);
      await waiting;
      return { complete: true };
    },
  });

  test('old cached class diagrams are upgraded online and semantic members remain navigable', async t => {
    const modelId = '0001000200000001', nativeSelection = { ...selection, modelId };
    const classDiagram = { ...diagram, type: 'Class Diagram', nativeClass: '_Ent2_ClassDiagram' };
    const member = { ...item, id: 'cccccccccccccccccccccccccccccccc', type: 'Attribute' };
    let detailCalls = 0;
    const { base, post, reader, cache } = await setup(t, {
      nativeCatalog: async (_selection, { onReady, onBatch }) => {
        onReady({ modelId, contextId: '0001000300000001' });
        onBatch([classDiagram]);
        return { complete: true };
      },
      nativeDetail: async () => {
        detailCalls++;
        return { id: classDiagram.id, attributes: {}, relations: [], warnings: [], diagram: {
          schemaVersion: 3, symbols: [], uml: { kind: 'class', classes: [
            { attributes: [{ target: member }], operations: [] },
          ] },
        } };
      },
    });
    await cache.save({ ...snapshot, selection: nativeSelection, entries: [classDiagram] });
    await post('/api/open', nativeSelection, { Origin: base });
    await reader.job;
    const response = await fetch(`${base}/api/item/${diagram.id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).detail.diagram.uml.kind, 'class');
    assert.equal(detailCalls, 1);
    assert.ok(reader.entries.has(member.id));
  });
  await cache.save({ ...snapshot, selection: nativeSelection });
  assert.equal((await post('/api/open', nativeSelection, { Origin: base })).status, 200);
  assert.equal(reader.entries.size, 2);
  assert.equal(reader.state().catalogComplete, false);
  assert.match(reader.state().searchScope, /uloženej kópie/);
  finish();
  await reader.job;
  assert.equal(reader.entries.size, 1);
  assert.equal(reader.entries.has(item.id), false);
  assert.equal(reader.state().catalogComplete, true);
});

test('keeps existing offline copies, search and stored diagrams usable without any network reader', async t => {
  const { base, post, cache } = await setup(t, { directList: async () => { throw new Error('Must not contact server'); } });
  await cache.save(snapshot);
  assert.equal((await post('/api/open', { ...selection, offline: true })).status, 200);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.offline, true);
  assert.equal(state.count, 2);
  const results = await (await fetch(`${base}/api/search?type=${encodeURIComponent(diagram.type)}&q=pristupovych`)).json();
  assert.equal(results.total, 1);
  let response = await fetch(`${base}/api/item/${diagram.id}`);
  const detail = (await response.json()).detail;
  assert.equal(detail.cached, true);
  assert.equal(detail.diagram.symbols.length, 1);
  response = await fetch(`${base}/api/item/${item.id}`);
  assert.equal(response.status, 404);
  response = await fetch(`${base}/api/item/${diagram.id}?refresh=1`);
  assert.equal(response.status, 409);
  assert.deepEqual(await cache.load(selection), snapshot);
});

test('failed offline selection preserves the previously opened copy', async t => {
  const { reader, cache } = await setup(t);
  await cache.save(snapshot);
  await reader.openOffline(selection);
  await assert.rejects(reader.openOffline({ ...selection, model: 'MissingCache' }), /neexistuje/);
  assert.deepEqual(reader.selection, selection);
  assert.equal(reader.entries.size, 2);
});

test('rejects invalid requests, cross-origin access, DNS rebinding and arbitrary file paths', async t => {
  const { base, post, server } = await setup(t);
  const crossOrigin = await fetch(`${base}/api/open`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await post('/api/open', { ...selection, model: '../other' })).status, 400);
  assert.equal((await post('/api/repositories', { server: 'http://invalid/' })).status, 400);
  assert.equal((await fetch(`${base}/.cache/test.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/search?type=Class&offset=-1`)).status, 400);
  const status = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/api/state', headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(status, 403);
});

test('removed vendor connector sources and compiled executable cannot return unnoticed', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const removed of ['Bridge.cs', 'bin/SelectBridge.exe', 'tests/BridgeCursorTests.cs', 'tests/bridge.test.mjs'])
    await assert.rejects(access(path.join(root, ...removed.split('/'))), { code: 'ENOENT' });
  const source = await readFile(path.join(root, 'server.mjs'), 'utf8');
  assert.doesNotMatch(source, /buildBridge|BridgeClient|csc\.exe|New-Object|ComObject|powershell/i);
});

test('browser code references existing controls and has no removed online/fallback UI', async () => {
  const root = fileURLToPath(new URL('../web/', import.meta.url));
  const [html, script] = await Promise.all([readFile(path.join(root, 'index.html'), 'utf8'), readFile(path.join(root, 'app.mjs'), 'utf8')]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const match of script.matchAll(/\$\('([^']+)'\)/g))
    assert.ok(ids.has(match[1]), `Missing control: ${match[1]}`);
  assert.doesNotMatch(html, /Select COM|compatibility-note|direct-discover|reload-detail/);
  assert.doesNotMatch(script, /Select automation|\/api\/fulltext|\/api\/stop/);
  assert.match(script, /\/api\/models/);
});

test('credential routes require the local Origin and never expose, cache or retain submitted secrets', async t => {
  const secret = 'synthetic-only-http-secret';
  let submitted, calls = 0;
  const logs = [];
  const { base, post, cache } = await setup(t, {
    logger: { error: event => logs.push(event) },
    prepareLogin: async () => ({ encrypted: true, context: 'default', mechanism: 'UserIdent', credentialsRequired: true }),
    checkLogin: async input => {
      submitted = input;
      calls++;
      return { encrypted: true, context: 'default', mechanism: 'UserIdent', credentialsVerified: true, password: input.password };
    },
  });
  const input = { ...selection, port: 9701, username: 'test-user', password: secret };
  assert.equal((await post('/api/authentication/check', input)).status, 403);
  assert.equal(calls, 0);
  let response = await post('/api/authentication/prepare', { ...selection, port: 9701 }, { Origin: base });
  assert.equal(response.status, 200);
  response = await post('/api/authentication/check', input, { Origin: base });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.credentialsVerified, true);
  assert.equal(result.modelAccessVerified, false);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(submitted.password, '');
  assert.deepEqual(await cache.history(), []);
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.ok(!JSON.stringify(await (await fetch(`${base}/api/state`)).json()).includes(secret));
});

test('unexpected credential errors are sanitized before logging or responding', async t => {
  const secret = 'synthetic-error-value';
  const logs = [];
  let submitted;
  const { base, post } = await setup(t, {
    logger: { error: event => logs.push(event) },
    checkLogin: async input => { submitted = input; throw new Error(`unexpected ${input.password}`); },
  });
  const response = await post('/api/authentication/check', { ...selection, port: 9701, username: 'test-user', password: secret }, { Origin: base });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(secret));
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.equal(submitted.password, '');
});

test('HTTP accepts an unencrypted result only with explicit plaintext consent', async t => {
  const result = { encrypted: false, context: 'default', mechanism: 'UserIdent' };
  const { base, post } = await setup(t, {
    logger: { error() {} },
    prepareLogin: async () => ({ ...result, credentialsRequired: true }),
    checkLogin: async () => ({ ...result, credentialsVerified: true }),
  });
  const input = { ...selection, port: 9700, username: 'test-user', password: 'synthetic-only' };
  assert.equal((await post('/api/authentication/check', input, { Origin: base })).status, 502);
  const prepared = await post('/api/authentication/prepare', { ...input, allowPlaintext: true }, { Origin: base });
  assert.equal(prepared.status, 200);
  assert.equal((await prepared.json()).plaintextAcknowledged, true);
  const response = await post('/api/authentication/check', { ...input, allowPlaintext: true }, { Origin: base });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.encrypted, false);
  assert.equal(body.plaintextAcknowledged, true);
  assert.equal(body.credentialsVerified, true);
  assert.equal(body.modelAccessVerified, false);
});

test('credential checks are never retried automatically or run concurrently', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const { base, post } = await setup(t, {
    logger: { error() {} },
    checkLogin: async () => {
      calls++;
      started();
      await gate;
      return { encrypted: true, context: 'default', mechanism: 'UserIdent', credentialsVerified: true };
    },
  });
  const input = { ...selection, port: 9701, username: 'test-user', password: 'synthetic-only' };
  const first = post('/api/authentication/check', input, { Origin: base });
  await entered;
  try { assert.equal((await post('/api/authentication/check', input, { Origin: base })).status, 409); }
  finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});
