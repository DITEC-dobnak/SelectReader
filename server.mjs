import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cache, identity, search, validateId, validateSelection } from './reader.mjs';
import { listDatastores } from './direct-broker.mjs';
import { AuthenticationError, prepareAuthentication, verifyCredentials, publicAuthenticationError } from './native-auth.mjs';
import { authenticateWindowsShare, WindowsShareError } from './windows-smb.mjs';
import { listModels, ModelReadError } from './direct-models.mjs';
import { loadNativeCatalog, loadNativeDetail } from './native-content.mjs';
import { ExportJob } from './model-export.mjs';
import { chooseExportFolder, openExportFolder } from './export-folder.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

export function currentWindowsIdentity({
  platform = process.platform, username = os.userInfo().username, domain = process.env.USERDOMAIN, computer = process.env.COMPUTERNAME,
} = {}) {
  if (platform !== 'win32') throw Object.assign(new Error('Predvyplnenie Windows účtu na tomto systéme nie je dostupné.'), { status: 501 });
  if (![username, domain].every(value => typeof value === 'string' && value && !/[\u0000-\u001f\u007f\\]/.test(value)))
    throw Object.assign(new Error('Windows účet procesu sa nepodarilo presne zistiť. Zadajte ho ručne podľa whoami.'), { status: 503 });
  return {
    username, domain, qualifiedUsername: `${domain}\\${username}`, source: 'windows-process',
    isLocalAccount: typeof computer === 'string' && computer ? domain.toLowerCase() === computer.toLowerCase() : null,
  };
}

export class Reader {
  constructor(cache) {
    this.cache = cache;
    this.entries = new Map();
    this.details = new Map();
    this.selection = null;
    this.catalogComplete = false;
    this.detailsComplete = false;
    this.updatedAt = null;
    this.offline = true;
    this.status = { phase: 'idle', current: '', error: null };
    this.generation = 0;
    this.controller = null;
    this.pendingDetails = new Map();
    this.usingCachedIndex = false;
  }
  state() {
    const types = {};
    for (const entry of this.entries.values()) types[entry.type] = (types[entry.type] ?? 0) + 1;
    return {
      selection: this.selection, transport: 'direct-tcp', modelListingSupported: true,
      modelReadingSupported: true,
      defaultAuthentication: 'windows-smb',
      credentialVerificationSupported: true, credentialsRequireTLS: false, plaintextRequiresExplicitConsent: true,
      status: this.status, count: this.entries.size, detailCount: this.details.size,
      catalogComplete: this.catalogComplete, detailsComplete: this.detailsComplete, updatedAt: this.updatedAt,
      missingTypeCount: this.status.phase === 'partial' ? this.retryCatalog?.classes.size ?? 0 : 0,
      types, offline: this.selection !== null && this.offline,
      searchScope: this.offline ? 'Vyhľadáva sa iba v uloženej lokálnej kópii.' :
        `${this.usingCachedIndex ? 'Zahrnuté sú aj názvy z uloženej kópie. ' : ''}Vyhľadáva sa v načítaných názvoch a otvorených detailoch.${this.catalogComplete ? '' : ` Index ešte nie je úplný. ${this.status.current}`}`,
    };
  }
  async openOffline(selection, detailLoader = loadNativeDetail) {
    const cached = await this.cache.load(selection);
    if (!cached) throw Object.assign(new Error('Pre tento model zatiaľ neexistuje lokálna kópia.'), { status: 404 });
    const entries = new Map(cached.entries.map(entry => [entry.id, entry]));
    const details = new Map(cached.details);
    this.controller?.abort();
    this.generation++;
    this.selection = selection;
    this.entries = entries;
    this.details = details;
    this.updatedAt = cached.updatedAt;
    this.catalogComplete = cached.complete;
    this.detailsComplete = cached.detailsComplete;
    this.offline = true;
    this.detailLoader = detailLoader;
    this.nativeContext = null;
    this.status = { phase: 'idle', current: '', error: null };
    this.pendingDetails = new Map();
    this.retryCatalog = null;
  }
  async openNative(selection, catalogLoader, detailLoader, logger, missingOnly = false) {
    const retry = missingOnly ? this.retryCatalog : null;
    if (missingOnly && (!retry || this.offline || this.status.phase !== 'partial' ||
        ['server','repository','model','modelId'].some(key => selection[key] !== this.selection?.[key])))
      throw Object.assign(new Error('Pre tento model nie je dostupný zoznam chýbajúcich typov.'), { status: 409 });
    this.retryCatalog = null;
    this.controller?.abort();
    const controller = new AbortController(), generation = ++this.generation;
    this.controller = controller;
    this.status = { phase: 'connecting', current: 'Windows pripojenie a kontext modelu…', error: null };
    let cached;
    try { cached = !retry && selection.modelId ? await this.cache.load(selection) : null; }
    catch {
      const error = new ModelReadError('MODEL_CACHE', 'Uložený index nemožno načítať. Žiadne dáta sa neprepísali.', 500);
      if (generation === this.generation) this.status = { phase: 'error', current: '', error: error.message };
      logger.error({ event: 'native-model-cache', code: error.code });
      throw error;
    }
    if (generation !== this.generation) throw Object.assign(new Error('Výber modelu sa zmenil.'), { status: 409 });
    const indexed = retry?.indexed ?? new Map();
    let ready = false, accept, decline;
    const opened = new Promise((resolve, reject) => { accept = resolve; decline = reject; });
    const current = () => {
      if (generation !== this.generation || controller.signal.aborted) throw Object.assign(new Error('Výber modelu sa zmenil.'), { status: 409 });
    };
    this.job = catalogLoader(selection, {
      signal: controller.signal,
      retryClasses: retry?.classes, previousSchema: retry?.schemaClasses,
      onReady: metadata => {
        current();
        if (retry && (metadata.modelId !== selection.modelId || metadata.contextId !== this.nativeContext))
          throw new ModelReadError('MODEL_CHANGED', 'Kontext modelu sa zmenil. Načítaj celý katalóg znova.');
        this.selection = { ...selection, modelId: metadata.modelId };
        this.nativeContext = metadata.contextId;
        this.detailLoader = detailLoader;
        const previous = cached?.selection.modelId === metadata.modelId ? cached : null;
        if (!retry) {
          this.entries = new Map((previous?.entries ?? []).map(entry => [entry.id, entry]));
          this.details = new Map(previous?.details ?? []);
          this.usingCachedIndex = !!previous;
        }
        this.pendingDetails = new Map();
        this.catalogComplete = this.detailsComplete = false;
        this.offline = false;
        this.updatedAt = new Date().toISOString();
        this.status = { phase: 'loading', current: 'Načítavam diagramy…', error: null };
        ready = true;
        accept();
      },
      progress: progress => {
        current();
        const type = progress.current.replace(/^_Ent2_/, '');
        this.status.current = progress.attempt > 1
          ? `Odložené typy: ${type} · pokus ${progress.attempt}/${progress.maxAttempts} · ${progress.lastError}`
          : `${progress.completed + 1}/${progress.total}: ${type}`;
      },
      onBatch: batch => {
        current();
        if (retry && indexed.size + batch.length > 200000)
          throw new ModelReadError('MODEL_SIZE', 'Model prekročil podporovaných 200000 objektov. Index nie je úplný.');
        for (const entry of batch) {
          indexed.set(entry.id, entry);
          this.entries.set(entry.id, entry);
        }
      },
      onClassError: failure => {
        current();
        logger.error({ event: 'native-model-class', ...failure });
      },
    }).then(async result => {
      current();
      if (!ready) throw new Error('Native reader did not validate the model context.');
      this.catalogComplete = result.complete;
      if (result.complete) {
        this.entries = indexed;
        this.details = new Map([...this.details].filter(([id]) => indexed.has(id)));
        this.usingCachedIndex = false;
      }
      this.updatedAt = new Date().toISOString();
      await this.persist();
      current();
      if (!result.complete && result.errors?.length && result.schemaClasses)
        this.retryCatalog = { indexed, schemaClasses: result.schemaClasses, classes: new Set(result.errors.map(error => error.className)) };
      this.status = result.complete ? { phase: 'ready', current: '', error: null } : {
        phase: 'partial', current: '', error: `Nedokončené typy po opakovaných pokusoch: ${(result.errors ?? []).map(error => `${error.className.replace(/^_Ent2_/, '')} (${error.code})`).join(', ')}.`,
      };
    }).catch(error => {
      const safe = error instanceof ModelReadError ? error :
        new ModelReadError('MODEL_READ', 'Priame čítanie modelu alebo uloženie jeho kópie zlyhalo. Načítaná časť nie je označená ako úplný model.');
      decline(safe);
      if (generation !== this.generation || controller.signal.aborted) return;
      this.status = { phase: 'error', current: this.status.current, error: safe.message };
      logger.error({ event: 'native-model-content', code: safe.code, ...(safe.serverCode ? { serverCode: safe.serverCode } : {}) });
    });
    await opened;
  }
  persist() {
    return this.cache.save({ version: 1, selection: this.selection, entries: [...this.entries.values()],
      details: [...this.details], complete: this.catalogComplete, detailsComplete: this.detailsComplete, updatedAt: this.updatedAt });
  }
  async detail(id, refresh = false) {
    const detail = this.details.get(id);
    const needsUml = ['_Ent2_ClassDiagram', '_Ent2_ObjectSequenceDiagram'].includes(this.entries.get(id)?.nativeClass) &&
      detail?.diagram?.schemaVersion !== 3;
    if (detail && !refresh && (this.offline || !needsUml)) return { ...detail, cached: true };
    const entry = this.entries.get(id);
    if (this.offline && (!this.selection?.modelId || !entry?.nativeClass || !entry.nativeId))
      throw Object.assign(new Error('Tejto staršej kópii chýbajú identifikátory potrebné na dočítanie detailu. Otvor model online.'), { status: refresh ? 409 : 404 });
    if (this.pendingDetails.has(id)) return this.pendingDetails.get(id);
    const generation = this.generation, selection = this.selection;
    const operation = (async () => {
      const result = await this.detailLoader(selection, entry, this.nativeContext);
      if (generation !== this.generation) throw Object.assign(new Error('Výber modelu sa počas čítania zmenil.'), { status: 409 });
      this.details.set(id, result);
      for (const relation of result.relations ?? []) if (!this.entries.has(relation.item.id)) this.entries.set(relation.item.id, relation.item);
      for (const symbol of result.diagram?.symbols ?? []) {
        if (symbol.target && !this.entries.has(symbol.target.id)) this.entries.set(symbol.target.id, symbol.target);
      }
      for (const item of result.diagram?.uml?.classes ?? []) {
        for (const member of [...item.attributes, ...item.operations])
          if (member.target && !this.entries.has(member.target.id)) this.entries.set(member.target.id, member.target);
      }
      this.updatedAt = new Date().toISOString();
      await this.persist();
      return result;
    })();
    this.pendingDetails.set(id, operation);
    try { return await operation; }
    finally { if (generation === this.generation) this.pendingDetails.delete(id); }
  }
}

async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 16384) throw Object.assign(new Error('Požiadavka je príliš veľká.'), { status: 413 });
  }
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Neplatný JSON.'), { status: 400 }); }
}

export function createServer(reader, cache, {
  port = 4317, directList = listDatastores, prepareLogin = prepareAuthentication, checkLogin = verifyCredentials,
  identityProvider = currentWindowsIdentity, windowsConnect = authenticateWindowsShare, logger = console,
  directModels = listModels,
  nativeCatalog = loadNativeCatalog, nativeDetail = loadNativeDetail,
  markdownExport = new ExportJob(path.join(root, 'exports')),
  folderPicker = chooseExportFolder, folderOpener = openExportFolder,
  onExit, idleMs = 15000,
} = {}) {
  const views = new Set();
  let idleTimer, ending = false;
  const finish = command => {
    ending = true;
    clearTimeout(idleTimer);
    onExit(command);
  };
  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (ending || views.size) return;
    idleTimer = setTimeout(() => {
      if (markdownExport.state.active || pickingFolder) scheduleIdle();
      else finish('stop');
    }, idleMs);
    idleTimer.unref();
  };
  let checkingCredentials = false;
  let selectedExportFolder = null, pickingFolder = false;
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const activePort = server.address()?.port ?? port;
      const origins = [`http://127.0.0.1:${activePort}`, `http://localhost:${activePort}`];
      if (!origins.includes(`http://${request.headers.host}`)) return json(response, 403, { error: 'Nepovolený Host.' });
      if (request.headers.origin && !origins.includes(request.headers.origin))
        return json(response, 403, { error: 'Nepovolený pôvod požiadavky.' });
      const url = new URL(request.url, `http://127.0.0.1:${activePort}`);
      if (ending) return json(response, 503, {error:'Reader sa ukončuje.'});
      if (request.method === 'GET') {
        if (url.pathname === '/api/health') return json(response, 200, { app: 'select-architect-reader', version: 2, transport: 'direct-tcp' });
        if (url.pathname === '/api/state') {
          if (onExit && url.searchParams.has('view')) {
            if (request.headers['sec-fetch-site'] !== 'same-origin') return json(response,403,{error:'Vyžaduje sa lokálne rozhranie.'});
            const view = url.searchParams.get('view');
            if (!/^[0-9a-f-]{36}$/i.test(view)) return json(response,400,{error:'Neplatný identifikátor karty.'});
            views.add(view);
            clearTimeout(idleTimer);
          }
          return json(response, 200, { ...reader.state(), markdownExport: markdownExport.state, lifecycle: !!onExit });
        }
        if (url.pathname === '/api/current-identity') {
          const identity = await identityProvider();
          return json(response, 200, {
            username: identity.username, domain: identity.domain, qualifiedUsername: identity.qualifiedUsername,
            source: 'windows-process', isLocalAccount: identity.isLocalAccount,
          });
        }
        if (url.pathname === '/api/history') return json(response, 200, await cache.history());
        if (url.pathname === '/api/search') {
          const type = url.searchParams.get('type');
          if (!type?.trim()) return json(response, 400, { error: 'Vyber konkrétny typ objektu.' });
          const offset = Number(url.searchParams.get('offset') ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0) return json(response, 400, { error: 'Neplatné stránkovanie.' });
          return json(response, 200, search(reader.entries, reader.details, {
            query: url.searchParams.get('q') ?? '', kind: url.searchParams.get('kind') ?? '',
            type, offset, limit: Infinity,
          }));
        }
        if (url.pathname.startsWith('/api/item/')) {
          const id = validateId(decodeURIComponent(url.pathname.slice('/api/item/'.length)));
          if (!reader.entries.has(id)) return json(response, 404, { error: 'Objekt nie je v lokálnom katalógu.' });
          return json(response, 200, { entry: reader.entries.get(id), detail: await reader.detail(id, url.searchParams.get('refresh') === '1') });
        }
        const assets = {
          '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'],
          '/diagram.mjs': ['diagram.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
          '/uml.mjs': ['uml.mjs', 'text/javascript'],
        };
        const asset = assets[url.pathname];
        if (asset) {
          const data = await readFile(path.join(root, 'web', asset[0]));
          response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
          return response.end(data);
        }
        return json(response, 404, { error: 'Nenájdené.' });
      }
      if (request.method !== 'POST') return json(response, 405, { error: 'Nepodporovaná metóda.' });
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: 'Vyžaduje sa application/json.' });
      const input = await body(request);
      if (onExit && url.pathname === '/api/reader/leave') {
        if (!origins.includes(request.headers.origin)) return json(response,403,{error:'Vyžaduje sa lokálne rozhranie.'});
        if (views.delete(input?.view)) scheduleIdle();
        return json(response,200,{accepted:true});
      }
      if (onExit && ['/api/reader/stop','/api/reader/restart'].includes(url.pathname)) {
        if (!origins.includes(request.headers.origin)) return json(response,403,{error:'Reader ovládajte iba z lokálneho rozhrania.'});
        if (markdownExport.state.active || pickingFolder) return json(response,409,{error:'Najprv dokonči alebo zastav export a zavri výber priečinka.'});
        ending = true;
        response.once('finish', () => finish(url.pathname.endsWith('/restart') ? 'restart' : 'stop'));
        return json(response,202,{accepted:true});
      }
      if (url.pathname === '/api/cache/remove') {
        if (!origins.includes(request.headers.origin)) return json(response, 403, { error: 'Kópiu odstráň z lokálneho rozhrania.' });
        const selection = validateSelection(input);
        if (reader.selection && identity(reader.selection) === identity(selection)) {
          if (!input.closeActive) return json(response, 409, { error: 'Kópia patrí otvorenému modelu. Najprv potvrď jeho zatvorenie.' });
          reader.controller?.abort();
          const generation = reader.generation + 1;
          Object.assign(reader, new Reader(cache), { generation });
        }
        try { await cache.remove(selection); }
        catch (error) {
          if (error.code === 'ENOENT') return json(response, 404, { error: 'Lokálna kópia už neexistuje.' });
          throw error;
        }
        return json(response, 200, { removed: true });
      }
      if (['/api/export/start', '/api/export/cancel', '/api/export/folder', '/api/export/open-folder'].includes(url.pathname)) {
        if (!origins.includes(request.headers.origin)) return json(response, 403, { error: 'Export ovládajte iba z lokálneho rozhrania.' });
        if (url.pathname.endsWith('/folder')) {
          if (pickingFolder || markdownExport.state.active) return json(response, 409, {error:'Výber priečinka teraz nie je dostupný.'});
          pickingFolder = true;
          try {
            const folder = await folderPicker();
            if (folder) selectedExportFolder = folder;
            return json(response, 200, {folder});
          } finally { pickingFolder = false; }
        }
        if (url.pathname.endsWith('/cancel')) markdownExport.cancel();
        else {
          if (input.folder && input.folder !== selectedExportFolder)
            return json(response, 400, {error:'Vyber cieľový priečinok znova.'});
          if (url.pathname.endsWith('/open-folder')) {
            await folderOpener(input.folder || markdownExport.base, !input.folder);
            return json(response, 200, {opened:true});
          }
          markdownExport.start(reader, input.resume === true, input.folder || markdownExport.base);
        }
        return json(response, 202, markdownExport.state);
      }
      if (url.pathname === '/api/windows-connection') {
        try {
          if (!origins.includes(request.headers.origin)) return json(response, 403, { error: 'Windows pripojenie spúšťajte iba z lokálneho rozhrania.' });
          const result = await windowsConnect(input?.server);
          if (result.method !== 'windows-smb' || result.shareReadable !== true || result.networkIdentityVerified !== true ||
              typeof result.verifiedUserId !== 'string' || !result.verifiedUserId ||
              result.credentialsRequested !== false || result.persistentMapping !== false)
            throw new Error('Unverified Windows connection');
          return json(response, 200, {
            method: 'windows-smb', shareReadable: true, networkIdentityVerified: true,
            credentialsRequested: false, persistentMapping: false, modelAccessVerified: false, modelReadingSupported: false,
          });
        } catch (error) {
          const safe = error instanceof WindowsShareError ? error : null;
          logger.error({ event: 'windows-authentication', code: safe?.code ?? 'WINDOWS_CONNECTION' });
          return json(response, safe?.status ?? (error?.status === 400 ? 400 : 502), {
            error: safe?.message ?? 'Windows pripojenie sa nepodarilo overiť; prihlasovacie údaje sa nepýtali ani nelogovali.',
            code: safe?.code ?? 'WINDOWS_CONNECTION',
            ...(safe?.windowsCode !== undefined ? { windowsCode: safe.windowsCode } : {}),
          });
        } finally { if (input && typeof input === 'object') input.password = ''; }
      }
      if (url.pathname === '/api/authentication/prepare' || url.pathname === '/api/authentication/check') {
        const checking = url.pathname.endsWith('/check');
        let ownsCheck = false;
        try {
          if (!origins.includes(request.headers.origin))
            throw new AuthenticationError('AUTH_ORIGIN', 'Overenie účtu je dostupné iba z lokálneho rozhrania aplikácie.', 403);
          if (checking && checkingCredentials) throw new AuthenticationError('AUTH_BUSY', 'Už prebieha jedno overenie účtu. Počkajte na výsledok.', 409);
          if (checking) { checkingCredentials = true; ownsCheck = true; }
          const result = await (checking ? checkLogin(input) : prepareLogin(input));
          const expectedEncryption = input?.allowPlaintext !== true;
          if (result.encrypted !== expectedEncryption || result.mechanism !== 'UserIdent' || !['default', 'user_ident_by_file'].includes(result.context) ||
              (checking ? result.credentialsVerified !== true : result.credentialsRequired !== true))
            throw new AuthenticationError('AUTH_RESPONSE', 'Pripojenie nevrátilo potvrdenie zodpovedajúce zvolenému režimu.', 502);
          return json(response, 200, {
            encrypted: result.encrypted, plaintextAcknowledged: !expectedEncryption, context: result.context, mechanism: result.mechanism,
            credentialsVerified: checking, credentialsRequired: !checking, modelAccessVerified: false, modelReadingSupported: false,
          });
        } catch (error) {
          const safe = publicAuthenticationError(error);
          logger.error({ event: 'native-authentication', code: safe.code, ...(safe.serverCode ? { serverCode: safe.serverCode } : {}) });
          return json(response, safe.status, { error: safe.message, code: safe.code, ...(safe.serverCode ? { serverCode: safe.serverCode } : {}) });
        } finally {
          if (ownsCheck) checkingCredentials = false;
          if (input && typeof input === 'object') input.password = '';
        }
      }
      if (url.pathname === '/api/repositories' || url.pathname === '/api/direct-repositories')
        return json(response, 200, await directList(input?.server, { port: input?.port ?? 9700 }));
      if (url.pathname === '/api/models') {
        if (!origins.includes(request.headers.origin))
          return json(response, 403, { error: 'Modely načítavajte iba z lokálneho rozhrania.' });
        const selection = validateSelection({ ...input, model: '_' });
        try {
          const result = await directModels(selection.server, selection.repository);
          if (result.complete !== true || !Array.isArray(result.models)) throw new Error('Incomplete model catalog.');
          return json(response, 200, {
            server: selection.server, repository: selection.repository, port: result.port,
            transport: 'direct-tcp', authentication: 'windows-smb', complete: true, elapsedMs: result.elapsedMs,
            models: result.models.map(({ id, name, version }) => ({ id, name, version })),
            modelListingSupported: true, modelReadingSupported: true,
          });
        } catch (error) {
          const safe = error instanceof ModelReadError ? error :
            new ModelReadError('MODEL_CONNECTION', 'Priame načítanie modelov zlyhalo. Podrobnosti pripojenia sa z dôvodu ochrany údajov nezverejňujú.');
          logger.error({ event: 'native-model-list', code: safe.code, ...(safe.serverCode ? { serverCode: safe.serverCode } : {}) });
          return json(response, safe.status, { error: safe.message, code: safe.code, ...(safe.serverCode ? { serverCode: safe.serverCode } : {}) });
        }
      }
      if (url.pathname === '/api/open' || url.pathname === '/api/catalog/missing') {
        const selection = validateSelection(input);
        const missingOnly = url.pathname === '/api/catalog/missing';
        if (!missingOnly && input.offline === true) {
          if (selection.modelId && !origins.includes(request.headers.origin)) return json(response, 403, { error: 'Model otvárajte iba z lokálneho rozhrania.' });
          await reader.openOffline(selection, nativeDetail);
        }
        else {
          if (!origins.includes(request.headers.origin)) return json(response, 403, { error: 'Model otvárajte iba z lokálneho rozhrania.' });
          await reader.openNative(selection, nativeCatalog, nativeDetail, logger, missingOnly);
        }
        return json(response, 200, reader.state());
      }
      return json(response, 404, { error: 'Nenájdené.' });
    } catch (error) {
      console.error(error);
      json(response, error.status ?? (/^(Neplatný|Chýba)/.test(error.message) ? 400 : 500), { error: error.message });
    }
  });
  server.once('close', () => clearTimeout(idleTimer));
  return server;
}

async function main() {
  const cache = new Cache(path.join(root, '.cache'));
  const reader = new Reader(cache);
  const server = createServer(reader, cache, {onExit(command) {
    reader.controller?.abort();
    server.close(async () => {
      await cache.writes;
      process.exitCode = command === 'restart' ? 75 : 0;
    });
  }});
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
      try {
        const response = await fetch('http://127.0.0.1:4317/api/health');
        const health = await response.json();
        if (health.app === 'select-architect-reader' && health.version === 2) {
          console.log('Prehliadač už beží: http://127.0.0.1:4317');
          if (process.argv.includes('--open')) openBrowser();
          return;
        }
      } catch (probeError) { console.error(probeError.message); }
    }
    console.error(`Server nemožno spustiť: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(4317, '127.0.0.1', () => {
    console.log('Select Reader: http://127.0.0.1:4317 · iba priamy TCP prístup');
    console.log('Priame čítanie modelov, vlastností, súvislostí a geometrie diagramov; Windows pripojenie bez hesla v aplikácii.');
    if (process.argv.includes('--open')) openBrowser();
  });
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}

function openBrowser() {
  const child = spawn('explorer.exe', ['http://127.0.0.1:4317'], { windowsHide: true, stdio: 'ignore' });
  child.on('error', error => console.error(`Otvorte adresu ručne: ${error.message}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--serve')) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
  } else {
    // Keep the original Start.cmd console attached across deliberate restarts.
    const launch = open => {
      const child = spawn(process.execPath,[process.argv[1],'--serve',...(open ? ['--open'] : [])],{stdio:'inherit'});
      child.once('error', error => { console.error(error.message); process.exitCode=1; });
      child.once('exit', code => { if(code===75) launch(false); else process.exitCode=code ?? 1; });
    };
    launch(process.argv.includes('--open'));
  }
}
