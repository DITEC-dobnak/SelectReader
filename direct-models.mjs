import { performance } from 'node:perf_hooks';
import {
  clientVersionFields, scalar, requestFrame, frameBody, fields, parseNegotiation,
  listDatastores, validateEndpoint, withConnection,
} from './direct-broker.mjs';
import { authenticateWindowsShare, WindowsShareError } from './windows-smb.mjs';
import { validateSelection } from './reader.mjs';
import { datastoreTextCodec } from './native-text.mjs';

const MODEL_CLASS = '_Ent2_Model';
const LIST = 0x37;
const decoder = new TextDecoder('utf-8', { fatal: true });

export const isTransientRead = code => ['TCP_TIMEOUT','ECONNRESET','ETIMEDOUT','EPIPE'].includes(code);

export class ModelReadError extends Error {
  constructor(code, message, status = 502, serverCode) {
    super(message);
    this.code = code;
    this.status = status;
    if (Number.isInteger(serverCode)) this.serverCode = serverCode;
  }
}

function text(value) {
  if (!Buffer.isBuffer(value) || !value.length) throw new Error('Missing model metadata.');
  const result = decoder.decode(value);
  if (!result.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(result)) throw new Error('Invalid model metadata.');
  return result;
}

function identityBytes(identity) {
  if (typeof identity !== 'string' || !/^[^\\\u0000-\u001f\u007f]+\\[^\\\u0000-\u001f\u007f]+$/.test(identity))
    throw new Error('Missing Windows-verified network identity.');
  const bytes = Buffer.from(identity, 'utf8');
  if (bytes.length > 255 || decoder.decode(bytes) !== identity) throw new Error('Unsupported Windows identity encoding.');
  return bytes;
}

export function datastoreNegotiation(repository, identity, timezoneMinutes = -new Date().getTimezoneOffset()) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8511);
  return requestFrame(0x93, Buffer.concat([
    scalar(2, identityBytes(identity)), clientVersionFields(),
    scalar(0x58, Buffer.from([0, 6])), scalar(0x5c, size),
    scalar(0x5e, Buffer.from(repository, 'utf8')), scalar(0x38, Buffer.from(String(timezoneMinutes), 'ascii')),
  ]), Buffer.alloc(8));
}

export async function readObjectCatalog(exchange, identity, {
  className = MODEL_CLASS, contextId = Buffer.alloc(8), decodeValue = text, onPage = () => {},
} = {}) {
  const user = identityBytes(identity);
  let packet = requestFrame(LIST, Buffer.concat([
    scalar(2, user), scalar(7, Buffer.from(className, 'utf8')),
    scalar(0x3d, Buffer.from('V')), scalar(0x3e, Buffer.from('X')),
  ]), contextId);
  const models = [], ids = new Set(), cursors = new Set();
  for (let page = 0; page < 2000; page++) {
    const response = await exchange(packet);
    const body = frameBody(response, LIST);
    const root = fields(body);
    if (text(root.get(7)) !== className || text(root.get(2)).toLowerCase() !== identity.toLowerCase() ||
        text(root.get(0x3d)) !== 'V' || text(root.get(0x3e)) !== 'X')
      throw new Error('Model-list class, identity or selection mode did not match.');
    const end = text(root.get(0x46)), rows = root.get(0xc9);
    if (!['Y', 'N'].includes(end) || !Array.isArray(rows)) throw new Error('Missing model-list completion metadata.');
    for (const row of rows) {
      if (!(row instanceof Map)) throw new Error('Invalid model-list row.');
      const objectId = row.get(0x0a);
      if (!Buffer.isBuffer(objectId) || objectId.length !== 8 || objectId.equals(Buffer.alloc(8)))
        throw new Error('Invalid model object identifier.');
      const id = objectId.toString('hex');
      if (ids.has(id)) throw new Error('Duplicate model identifier; incomplete catalog rejected.');
      ids.add(id);
      models.push({ id, name: decodeValue(row.get(8)), version: row.has(9) ? decodeValue(row.get(9)) : null });
      if (models.length > 100000) throw new Error('Object catalog exceeds the supported size.');
    }
    onPage({ page: page + 1, count: models.length });
    if (end === 'Y') return models;
    // Keep the entire server restart prefix, including opaque header state.
    const length = root.get(0x56);
    if (!Buffer.isBuffer(length) || length.length !== 2) throw new Error('Missing model-list restart length.');
    const restart = length.readUInt16BE() - 40;
    if (restart <= 0 || restart >= body.length) throw new Error('Invalid model-list restart length.');
    const cursor = body.subarray(0, restart);
    const prefix = fields(cursor);
    const allowed = new Set([2, 3, 7, 8, 9, 10, 0x3d, 0x3e, 0x46, 0x47, 0x56, 0x5f]);
    if (prefix.size !== root.size - 1 || [...prefix.keys()].some(tag => !allowed.has(tag)))
      throw new Error('Unsupported model-list restart prefix.');
    const key = cursor.toString('hex');
    if (cursors.has(key)) throw new Error('Repeated model-list cursor; incomplete catalog rejected.');
    cursors.add(key);
    packet = Buffer.from(response.subarray(0, restart + 40));
    packet.writeUInt16BE(packet.length, 4);
  }
  throw new Error('Model-list paging did not terminate.');
}

export async function readModelCatalog(exchange, identity, options = {}) {
  const models = await readObjectCatalog(exchange, identity, options);
  if (models.some(model => !model.version)) throw new Error('Missing model version.');
  return models;
}

export async function withDatastore(server, repository, action, {
  brokerPort = 9700, timeoutMs = 5000, idleTimeout = false, signal, repositories = listDatastores,
  windowsConnect = authenticateWindowsShare, connect = withConnection,
} = {}) {
  validateSelection({ server, repository, model: '_' });
  validateEndpoint(server, brokerPort);
  let stage = 'broker';
  try {
    const catalog = await repositories(server, { port: brokerPort });
    const matches = catalog.repositories.filter(entry => entry.name === repository);
    if (matches.length !== 1) throw new ModelReadError('MODEL_REPOSITORY',
      matches.length ? 'Repozitár nie je jednoznačný na zvolenom serveri.' : 'Repozitár sa už v katalógu servera nenachádza.', 409);
    const target = matches[0];
    validateEndpoint(target.server, target.port);
    stage = 'windows';
    const authentication = await windowsConnect(target.server);
    if (authentication.method !== 'windows-smb' || authentication.shareReadable !== true ||
        authentication.networkIdentityVerified !== true || authentication.credentialsRequested !== false ||
        authentication.persistentMapping !== false)
      throw new ModelReadError('MODEL_WINDOWS', 'Windows sieťové pripojenie nebolo overené.', 403);
    const identity = authentication.verifiedUserId;
    identityBytes(identity);
    stage = 'datastore';
    return await connect(target.server, { port: target.port, timeoutMs, idleTimeout, signal, assignRequestNumber: false }, async ({ exchange }) => {
      stage = 'negotiate';
      const negotiated = await exchange(datastoreNegotiation(repository, identity));
      parseNegotiation(negotiated);
      const codePage = fields(frameBody(negotiated, 0x93)).get(4)?.toString('ascii');
      const decodeText = datastoreTextCodec(codePage);
      stage = 'read';
      return action({ exchange, identity, target, decodeText, codePage });
    });
  } catch (error) {
    if (error instanceof ModelReadError) throw error;
    if (error instanceof WindowsShareError)
      throw new ModelReadError(error.code, error.message, error.status);
    if (isTransientRead(error.code))
      throw new ModelReadError(error.code, `Spojenie pri čítaní bolo prerušené (krok ${stage}, ${error.code}).`);
    const code = Number.isInteger(error.serverCode) ? error.serverCode : undefined;
    throw new ModelReadError('MODEL_CONNECTION',
      `Priame načítanie modelov zlyhalo (krok ${stage}${code ? `, kód ${code}` : ''}). Žiadny alternatívny konektor ani UserIdent sa nespustil.`,
      502, code);
  }

}

export async function listModels(server, repository, options = {}) {
  const start = performance.now();
  return withDatastore(server, repository, async ({ exchange, identity, target, decodeText }) => {
    const models = await readModelCatalog(exchange, identity, { decodeValue: decodeText });
    return { server, repository, port: target.port, transport: 'direct-tcp', authentication: 'windows-smb',
      models, complete: true, elapsedMs: Math.round(performance.now() - start),
      modelListingSupported: true, modelReadingSupported: true };
  }, options);
}
