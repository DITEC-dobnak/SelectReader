import { requestFrame, frameBody, fields, clientVersionFields, withBroker, loginContextsRequest, parseLoginContexts, readCatalog, validateEndpoint } from './direct-broker.mjs';

export class AuthenticationError extends Error {
  constructor(code, message, status = 400, serverCode) {
    super(message);
    this.code = code;
    this.status = status;
    if (Number.isInteger(serverCode)) this.serverCode = serverCode;
  }
}

function field(value, name, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f-\u009f]/.test(value) || Buffer.byteLength(value, 'utf8') > 255)
    throw new AuthenticationError('AUTH_INPUT', `Neplatné pole ${name}; podporovaný limit je 255 bajtov.`);
  if ([...value].some(character => {
    const point = character.codePointAt(0);
    return point >= 0xd800 && point <= 0xdfff;
  }))
    throw new AuthenticationError('AUTH_ENCODING', 'Prihlasovacie pole obsahuje neplatný Unicode znak. Údaje sa nenahrádzajú a neodošlú.');
  return value;
}

export function loginTarget(input) {
  if (!input || typeof input !== 'object') throw new AuthenticationError('AUTH_INPUT', 'Chýbajú parametre pripojenia.');
  try { validateEndpoint(input.server, input.port); }
  catch { throw new AuthenticationError('AUTH_INPUT', 'Zadajte platný server a port brokera.'); }
  if (input.allowPlaintext !== undefined && typeof input.allowPlaintext !== 'boolean')
    throw new AuthenticationError('AUTH_INPUT', 'Súhlas s nešifrovaným prenosom musí byť výslovný.');
  const repository = field(input.repository, 'repozitár');
  if (/[\\/]/.test(repository)) throw new AuthenticationError('AUTH_INPUT', 'Neplatný názov repozitára.');
  return { server: input.server, port: input.port, repository, ...(input.allowPlaintext === true ? { allowPlaintext: true } : {}) };
}

export function credentials(input) {
  const target = loginTarget(input);
  let username = field(input.username, 'meno'), domain = field(input.domain, 'doména', { optional: true });
  const password = field(input.password, 'heslo', { optional: true });
  if (username.includes('\\')) {
    const parts = username.split('\\');
    if (parts.length !== 2 || !parts[0] || !parts[1] || (domain && domain !== parts[0]))
      throw new AuthenticationError('AUTH_INPUT', 'Zadajte meno a doménu samostatne alebo použite tvar DOMENA\\meno.');
    [domain, username] = parts;
  }
  if (domain.includes('\\')) throw new AuthenticationError('AUTH_INPUT', 'Neplatný tvar domény.');
  return { ...target, username, domain, password };
}

export function userIdentRequest(input, { operatingSystem } = {}) {
  if (!['windows', 'unix'].includes(operatingSystem))
    throw new AuthenticationError('AUTH_PLATFORM', 'Broker neoznámil podporovaný operačný systém servera; prihlasovacie údaje sa neodošlú.', 501);
  const repository = field(input.repository, 'repozitár'), username = field(input.username, 'meno');
  const domain = field(input.domain, 'doména', { optional: true });
  const qualifiedUser = field(operatingSystem === 'windows' && domain ? `${domain}\\${username}` : username, 'úplné meno účtu');
  const repositoryLength = Buffer.byteLength(repository, 'utf8');
  const parts = [qualifiedUser, field(input.password, 'heslo', { optional: true }), username, domain];
  const lengths = parts.map(value => Buffer.byteLength(value, 'utf8'));
  if (repositoryLength > 255 || lengths.some(length => length > 255)) throw new AuthenticationError('AUTH_INPUT', 'Prekročený limit prihlasovacieho protokolu.');
  const prefixSize = length => length < 255 ? 1 : 3;
  const listLength = 2 + lengths.reduce((sum, length) => sum + prefixSize(length) + length, 0);
  const version = clientVersionFields();
  const bodyLength = version.length + 1 + prefixSize(repositoryLength) + repositoryLength + 3 + listLength;
  const header = requestFrame(0x0102, Buffer.alloc(0));
  const packet = Buffer.alloc(header.length + bodyLength);
  header.copy(packet);
  packet.writeUInt16BE(packet.length, 4);
  let offset = header.length;
  const writeLength = length => {
    if (length < 255) packet[offset++] = length;
    else { packet[offset++] = 0xff; packet.writeUInt16BE(length, offset); offset += 2; }
  };
  version.copy(packet, offset);
  offset += version.length;
  packet[offset++] = 0x5e;
  writeLength(repositoryLength);
  offset += packet.write(repository, offset, repositoryLength, 'utf8');
  packet[offset++] = 0xc3;
  packet.writeUInt16BE(listLength, offset);
  offset += 2;
  packet.writeUInt16BE(4, offset);
  offset += 2;
  parts.forEach((value, index) => {
    writeLength(lengths[index]);
    offset += packet.write(value, offset, lengths[index], 'utf8');
  });
  parts.fill('');
  return packet;
}

async function profile(exchange, repository, operatingSystem, server) {
  const info = parseLoginContexts(await exchange(loginContextsRequest()));
  const record = (await readCatalog(exchange, server)).find(entry => entry.name === repository);
  if (!record) throw new AuthenticationError('AUTH_REPOSITORY', 'Repozitár sa na tomto brokeri nenašiel.', 404);
  if (info.mode !== 'client' || !['default', 'user_ident_by_file'].includes(record.authenticationContext) ||
      !info.contexts.includes(record.authenticationContext))
    throw new AuthenticationError('AUTH_MECHANISM', 'Tento autentifikačný profil zatiaľ nie je podporovaný. Klient podporuje iba overenie UserIdent; ADS/Windows SSO nie je implementované.', 501);
  if (!['windows', 'unix'].includes(operatingSystem))
    throw new AuthenticationError('AUTH_PLATFORM', 'Broker neoznámil podporovaný operačný systém servera; prihlasovacie údaje sa neodošlú.', 501);
  return { context: record.authenticationContext, mechanism: 'UserIdent', operatingSystem };
}

export function publicAuthenticationError(error) {
  if (error instanceof AuthenticationError) return error;
  if (error?.code === 'BROKER_PLATFORM')
    return new AuthenticationError('AUTH_PLATFORM', 'Operačný systém servera nezodpovedá overenému profilu. Prihlasovacie údaje sa neodošlú.', 501);
  if (error?.serverCode === 7942)
    return new AuthenticationError('AUTH_USER_NOT_FOUND',
      'Server nenašiel účet v UserIdent (kód 7942). Pri účte s doménou skontroluj tvar DOMENA\\meno a jeho registráciu na serveri podľa návodu. Táto chyba nepotvrdzuje nesprávne heslo. Údaje neboli uložené.',
      401, 7942);
  if (error?.serverCode === 7943)
    return new AuthenticationError('AUTH_BAD_PASSWORD',
      'Server odmietol heslo pre účet v UserIdent (kód 7943). Údaje neboli uložené.',
      401, 7943);
  if (Number.isInteger(error?.serverCode))
    return new AuthenticationError('AUTH_REJECTED', `Server odmietol overenie účtu (kód ${error.serverCode}). Údaje neboli uložené.`, 401, error.serverCode);
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(String(error?.code ?? '')))
    return new AuthenticationError('AUTH_TLS', 'Zabezpečené spojenie sa nepodarilo overiť. Skontrolujte TLS port a dôveryhodnosť certifikátu; heslo nebolo odoslané nešifrovane.', 502);
  return new AuthenticationError('AUTH_CONNECTION', 'Priame overenie sa nepodarilo. Skontrolujte server, port a zvolený spôsob pripojenia. Automatické prepnutie spojenia ani náhradný konektor sa nepoužili.', 502);
}

export async function prepareAuthentication(input, { ca, timeoutMs = 5000 } = {}) {
  try {
    const target = loginTarget(input);
    return await withBroker(target.server, { port: target.port, secure: !target.allowPlaintext, ca, timeoutMs }, async ({ exchange, protocol, encrypted }) => ({
      ...await profile(exchange, target.repository, protocol.operatingSystem, target.server), encrypted, credentialsRequired: true, modelAccessVerified: false,
    }));
  } catch (error) { throw publicAuthenticationError(error); }
}

export async function verifyCredentials(input, { ca, timeoutMs = 5000 } = {}) {
  let packet, value;
  try {
    value = credentials(input);
    return await withBroker(value.server, { port: value.port, secure: !value.allowPlaintext, ca, timeoutMs }, async ({ exchange, protocol, encrypted }) => {
      const authProfile = await profile(exchange, value.repository, protocol.operatingSystem, value.server);
      packet = userIdentRequest(value, authProfile);
      const reply = fields(frameBody(await exchange(packet), 0x0102));
      const user = reply.get(0x02);
      if (!Buffer.isBuffer(user) || !user.length || user.some(byte => byte < 0x20 || byte === 0x7f))
        throw new AuthenticationError('AUTH_RESPONSE', 'Server nevrátil platné potvrdenie overeného účtu.', 502);
      return { ...authProfile, encrypted, credentialsVerified: true, modelAccessVerified: false, modelReadingSupported: false };
    });
  } catch (error) { throw publicAuthenticationError(error); }
  finally {
    packet?.fill(0);
    if (value) value.password = '';
    if (input && typeof input === 'object') input.password = '';
  }
}
