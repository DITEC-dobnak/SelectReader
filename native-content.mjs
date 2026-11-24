import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { withDatastore, readModelCatalog, readObjectCatalog, datastoreNegotiation, ModelReadError } from './direct-models.mjs';
import { requestFrame, scalar, fields, frameBody, withConnection, parseNegotiation } from './direct-broker.mjs';
import { documentText } from './native-text.mjs';
import { classDiagramData, classStereotype, sequenceDiagramData } from './uml-data.mjs';

const western = new TextDecoder('windows-1250', { fatal: true });
const displayText = value => {
  if (!Buffer.isBuffer(value)) throw new Error('Missing native text value.');
  return western.decode(value);
};

function objectFields(entry) {
  return Buffer.concat([
    scalar(7, Buffer.from(entry.nativeClass, 'ascii')), scalar(8, Buffer.alloc(0)),
    scalar(9, Buffer.alloc(0)), scalar(10, Buffer.from(entry.nativeId, 'hex')),
  ]);
}

function entryFromNative(className, object) {
  const type = className.replace(/^_Ent2_/, '').replace(/Diagram(?=.+)/g, 'Drawing')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  const name = className === '_Ent2_Model' ? object.name : object.version?.replace(/^[0-9a-f]{6}/i, '') ?? object.name;
  const id = createHash('sha256').update(JSON.stringify([className, object.id])).digest('hex').slice(0, 32);
  return { id, name, type, path: `${type}/${name}`,
    nativeClass: className, nativeId: object.id, nativeName: object.name };
}

export function decodeNativeAttributes(rows, decodeText = displayText) {
  const result = {}, warnings = [], longValues = [];
  let current;
  const flush = () => {
    if (!current) return;
    let values = current.values;
    if (['_Ent2_Position', '_Ent2_Waypoints'].includes(current.wireName) && values.length) {
      const count = values[0];
      if (!Number.isInteger(count) || count < 0 || count % 2 || count > values.length - 1 ||
          !values.slice(1, count + 1).every(Number.isFinite))
        throw new Error('Invalid native diagram position array.');
      values = values.slice(1, count + 1);
    }
    if (['_Ent2_Width', '_Ent2_Height'].includes(current.wireName) && values.length &&
        (values.length !== 1 || !Number.isFinite(values[0]))) throw new Error('Unsupported native diagram geometry value.');
    result[current.name] = values.join(' ');
  };
  for (const row of rows) {
    if (row.has(6)) {
      flush();
      const description = row.get(0x25);
      if (!Buffer.isBuffer(description) || description.length !== 4) throw new Error('Invalid attribute descriptor.');
      current = { name: decodeText(row.get(6)).replace(/^_Ent[12X]_/, ''), wireName: decodeText(row.get(6)),
        type: String.fromCharCode(description[2]), values: [] };
    }
    if (!current) throw new Error('Attribute continuation without its descriptor.');
    const value = row.get(0x1e);
    if (!value) {
      const size = row.get(0x5c);
      if (current.type === 'c' && Buffer.isBuffer(size) && size.readUInt32BE() > 0) {
        longValues.push({ name: current.name, wireName: current.wireName, size: size.readUInt32BE() });
      }
      continue;
    }
    const type = row.has(0x2f) ? row.get(0x2f).toString('ascii') : current.type;
    if (type === 'C') current.values.push(decodeText(value));
    else if (type === 'B' && ['T', 'F'].includes(value.toString('ascii'))) current.values.push(value.toString('ascii') === 'T' ? 'true' : 'false');
    else if (type === 'l' && value.length === 4) current.values.push(value.readInt32BE());
    else if (type === 's' && value.length === 2) current.values.push(value.readInt16BE());
    else if (type === 'f' && value.length === 4) current.values.push(value.readFloatBE());
    else {
      if (['_Ent2_Position', '_Ent2_Width', '_Ent2_Height'].includes(current.wireName))
        throw new Error('Unsupported native diagram geometry value.');
      current.values.push(`[${value.length} B: ${value.toString('hex')}]`);
      warnings.push(`${current.name}: nepodporovaný typ ${type}; zobrazené pôvodné bajty.`);
    }
  }
  flush();
  return { attributes: result, warnings, longValues };
}

export async function readNativeLongValue(exchange, identity, entry, contextId, attribute) {
  if (attribute.size > 4 * 1024 * 1024) throw new ModelReadError('ATTRIBUTE_SIZE', 'Príloha presahuje podporovanú veľkosť 4 MiB.', 413);
  const chunks = [];
  let offset = 0;
  while (offset < attribute.size) {
    const position = Buffer.alloc(4);
    position.writeUInt32BE(offset);
    const packet = requestFrame(0x3c, Buffer.concat([
      scalar(2, Buffer.from(identity, 'utf8')), scalar(6, Buffer.from(attribute.wireName, 'ascii')),
      objectFields(entry), scalar(0x6b, position),
    ]), contextId);
    const root = fields(frameBody(await exchange(packet), 0x3c));
    const group = root.get(0xc1);
    if (!Array.isArray(group) || group.length !== 1) throw new Error('Invalid long-attribute response.');
    const descriptor = group[0].get(0x25), chunk = group[0].get(0x1e);
    if (!Buffer.isBuffer(descriptor) || descriptor[2] !== 0x63 || !Buffer.isBuffer(chunk) ||
        !chunk.length || offset + chunk.length > attribute.size) throw new Error('Invalid or truncated long-attribute chunk.');
    chunks.push(chunk);
    offset += chunk.length;
  }
  return Buffer.concat(chunks, attribute.size);
}

export function decodeNativeRelationships(rows, decodeText = displayText) {
  return rows.map(row => {
    const id = row.get(0x10), className = decodeText(row.get(0x0d));
    if (!Buffer.isBuffer(id) || id.length !== 8 || !/^[\w -]{1,200}$/.test(className)) throw new Error('Invalid native relationship target.');
    return { role: decodeText(row.get(0x11)), item: entryFromNative(className, {
      id: id.toString('hex'), name: decodeText(row.get(0x0e)), version: row.has(0x0f) ? decodeText(row.get(0x0f)) : null,
    }) };
  });
}

export async function readGroups(exchange, identity, opcode, body, contextId, group = 0xc9) {
  let packet = requestFrame(opcode, body, contextId);
  const rows = [], cursors = new Set();
  for (let page = 0; page < 2000; page++) {
    const frame = await exchange(packet);
    const response = frameBody(frame, opcode);
    const root = fields(response);
    if (root.has(2) && root.get(2).toString('utf8').toLowerCase() !== identity.toLowerCase())
      throw new Error('Response network identity changed.');
    const end = root.get(0x46)?.toString('ascii');
    if (!['Y', 'N'].includes(end)) throw new Error('Missing native list completion marker.');
    const records = root.get(group);
    if (!Array.isArray(records)) throw new Error('Missing native record group.');
    rows.push(...records);
    if (rows.length > 200000) throw new Error('Native list exceeds the supported size.');
    if (end === 'Y') return rows;
    const length = root.get(0x56);
    if (!Buffer.isBuffer(length) || length.length !== 2) throw new Error('Missing native restart prefix.');
    const restart = length.readUInt16BE() - 40;
    if (restart <= 0 || restart >= response.length) throw new Error('Invalid native restart length.');
    const prefix = response.subarray(0, restart);
    const parsed = fields(prefix);
    if (parsed.size !== root.size - 1 || parsed.has(group)) throw new Error('Invalid native restart prefix.');
    const key = prefix.toString('hex');
    if (cursors.has(key)) throw new Error('Repeated native list cursor.');
    cursors.add(key);
    packet = Buffer.from(frame.subarray(0, restart + 40));
    packet.writeUInt16BE(packet.length, 4);
  }
  throw new Error('Native paging did not terminate.');
}

export async function modelContext(exchange, identity, selection, decodeText = displayText) {
  const models = await readModelCatalog(exchange, identity, { decodeValue: decodeText });
  const matches = models.filter(model => selection.modelId ? model.id === selection.modelId && model.name === selection.model : model.name === selection.model);
  if (matches.length !== 1) throw new ModelReadError('MODEL_SELECTION', 'Vybraný model už neexistuje alebo jeho výber nie je jednoznačný.', 409);
  const model = matches[0];
  const contexts = await readObjectCatalog(exchange, identity, { className: 'Context' });
  const matching = contexts.filter(context => context.name.toLowerCase() === model.id);
  if (matching.length !== 1) throw new ModelReadError('MODEL_CONTEXT', 'Model nemá jednoznačný čitateľný kontext.', 409);
  const selected = matching[0];
  const identityFields = Buffer.concat([
    scalar(2, Buffer.from(identity, 'utf8')), scalar(7, Buffer.from('Context')),
    scalar(8, Buffer.from(selected.name, 'ascii')), scalar(10, Buffer.from(selected.id, 'hex')),
  ]);
  const definition = fields(frameBody(await exchange(requestFrame(0x88, Buffer.concat([
    identityFields, scalar(0x3d, Buffer.from('V')), scalar(0x3e, Buffer.from('X')),
  ]), Buffer.alloc(8))), 0x88), 0, { skipGroups: true });
  const flag = definition.get(0x31);
  if (!Buffer.isBuffer(flag) || flag.length !== 1) throw new Error('Missing context definition flag.');
  // OSOTXSET selects only this client's working context; it does not change
  // the model, workspace definition, permissions or a user's default context.
  const response = await exchange(requestFrame(0x89, Buffer.concat([identityFields, scalar(0x31, flag)]), Buffer.alloc(8)));
  frameBody(response, 0x89);
  const contextId = Buffer.from(response.subarray(8, 16));
  if (contextId.equals(Buffer.alloc(8))) throw new Error('Server did not select a working model context.');
  return { model, contextId };
}

export async function readNativeAttributes(exchange, identity, entry, contextId) {
  const count = Buffer.alloc(2);
  count.writeUInt16BE(100);
  return readGroups(exchange, identity, 0x3d, Buffer.concat([
    scalar(2, Buffer.from(identity, 'utf8')), objectFields(entry),
    scalar(0x47, count), scalar(0x3d, Buffer.from('V')), scalar(0x3e, Buffer.from('X')),
  ]), contextId, 0xc1);
}

export async function readNativeRelationships(exchange, identity, entry, contextId) {
  return readGroups(exchange, identity, 0x45, Buffer.concat([
    scalar(2, Buffer.from(identity, 'utf8')), objectFields(entry),
    scalar(0x35, Buffer.from('B')), scalar(0x5a, Buffer.from('V')),
    scalar(0x3d, Buffer.from('V')), scalar(0x3e, Buffer.from('X')),
  ]), contextId);
}

export async function readOrderedRelationships(exchange, identity, entry, contextId, role, targetClass) {
  return readGroups(exchange, identity, 0x47, Buffer.concat([
    scalar(2, Buffer.from(identity, 'utf8')), objectFields(entry),
    scalar(0x11, Buffer.from(role, 'ascii')), scalar(0x0d, Buffer.from(targetClass, 'ascii')),
    scalar(0x6e, Buffer.from('U')), scalar(0x5a, Buffer.from('V')),
    scalar(0x3d, Buffer.from('V')), scalar(0x3e, Buffer.from('X')),
  ]), contextId);
}

export async function loadNativeCatalog(selection, {
  progress = () => {}, onReady = () => {}, onBatch = () => {}, onClassError = () => {}, signal,
  connect = withConnection, diagramsOnly = false, retryClasses, previousSchema, waitForRetry = delay, ...options
} = {}) {
  const start = performance.now();
  const prepared = await withDatastore(selection.server, selection.repository, async ({ exchange, identity, decodeText, target, codePage }) => {
    const { model, contextId } = await modelContext(exchange, identity, selection, decodeText);
    onReady({ modelId: model.id, contextId: contextId.toString('hex') });
    const schema = await readGroups(exchange, identity, 22, scalar(2, Buffer.from(identity, 'utf8')), Buffer.alloc(8));
    const classes = schema.map(row => decodeText(row.get(7))).filter(name => name.startsWith('_Ent2_') && (!diagramsOnly || name.endsWith('Diagram')))
      .sort((a, b) => Number(b.endsWith('Diagram')) - Number(a.endsWith('Diagram')) || a.localeCompare(b));
    if (!classes.length || new Set(classes).size !== classes.length) throw new Error('Invalid Select metamodel.');
    return { model, contextId, classes, identity, target, codePage, decodeText };
  }, { timeoutMs: 60000, idleTimeout: true, signal, connect, ...options });
  const { model, contextId, classes: schemaClasses, identity, target, codePage, decodeText } = prepared;
  if (retryClasses && (schemaClasses.length !== previousSchema?.length || schemaClasses.some((name, i) => name !== previousSchema[i])))
    throw new ModelReadError('MODEL_SCHEMA_CHANGED', 'Typy modelu sa zmenili. Načítaj celý katalóg znova.');
  const classes = retryClasses ? schemaClasses.filter(name => retryClasses.has(name)) : schemaClasses;
  const entries = [], ids = new Set(), errors = [];
  const maxRetries = 2, retries = new Map();
  const queue = classes.map((_, i) => i);
  let retryTime = 0;
  let index = 0, activeClass = null;
  while (index < queue.length) {
    signal?.throwIfAborted();
    if (performance.now() - start > Math.min(3600000, 600000 + retryTime))
      throw new ModelReadError('MODEL_TIME_LIMIT', 'Indexovanie prekročilo celkový časový limit. Index nie je úplný.');
    const deferred = index >= classes.length;
    const retryStart = deferred || retryClasses ? performance.now() : null;
    try {
      if (deferred) await waitForRetry(500, undefined, { signal });
      await connect(target.server, { port: target.port, timeoutMs: retryStart === null ? 15000 : 60000, idleTimeout: true, assignRequestNumber: false, signal }, async ({ exchange }) => {
        const negotiated = await exchange(datastoreNegotiation(selection.repository, identity));
        parseNegotiation(negotiated);
        if (fields(frameBody(negotiated, 0x93)).get(4)?.toString('ascii') !== codePage) throw new Error('Datastore encoding changed.');
        const selected = await modelContext(exchange, identity, selection, decodeText);
        if (!selected.contextId.equals(contextId)) throw new Error('Model context changed.');
        for (let count = 0; count < 16 && index < queue.length; count++) {
          const currentIndex = queue[index++];
          const className = classes[currentIndex];
          activeClass = className;
          const attempt = 1 + (retries.get(className)?.used ?? 0);
          const status = { current: className, completed: currentIndex, total: classes.length, count: entries.length, attempt, maxAttempts: maxRetries + 1, lastError: retries.get(className)?.code };
          progress(status);
          const objects = await readObjectCatalog(exchange, identity, { className, contextId, decodeValue: decodeText,
            onPage: page => {
              signal?.throwIfAborted();
              progress({ ...status, page: page.page, classCount: page.count });
            },
          });
          const batch = [];
          for (const object of objects) {
            if (className === '_Ent2_Model' && object.id !== model.id) continue;
            const entry = entryFromNative(className, object);
            if (ids.has(entry.id)) throw new ModelReadError('MODEL_DUPLICATE_OBJECT', 'Server vrátil duplicitnú identitu objektu v rovnakej triede.');
            ids.add(entry.id);
            batch.push({ ...entry, path: `${model.name}/${entry.path}` });
          }
          entries.push(...batch);
          if (entries.length > 200000) throw new ModelReadError('MODEL_SIZE', 'Model prekročil podporovaných 200000 objektov. Index nie je úplný.');
          onBatch(batch);
          activeClass = null;
          if (attempt > 1 || index === classes.length) break;
        }
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (!['TCP_TIMEOUT','ECONNRESET','ETIMEDOUT','EPIPE'].includes(error.code) || !activeClass) throw error;
      const used = retries.get(activeClass)?.used ?? 0;
      if (used < maxRetries) {
        retries.set(activeClass, {used: used + 1, code: error.code});
        queue.push(queue[index - 1]);
        activeClass = null;
        continue;
      }
      const failure = { className: activeClass, code: error.code };
      errors.push(failure);
      onClassError(failure);
      activeClass = null;
      if (errors.length >= 10) throw new ModelReadError('MODEL_TIMEOUTS', 'Server opakovane neodpovedal na čítanie. Index nie je úplný.');
    } finally {
      if (retryStart !== null) retryTime += performance.now() - retryStart;
    }
  }
  return { entries, errors, schemaClasses, modelId: model.id, contextId: contextId.toString('hex'), complete: errors.length === 0, elapsedMs: Math.round(performance.now() - start) };
}

export async function loadNativeDetail(selection, entry, context, options = {}) {
  return withNativeDetails(selection, context, read => read(entry), {
    ...(entry.nativeClass.endsWith('Diagram') ? { timeoutMs: 60000 } : {}),
    ...options,
  });
}

export async function withNativeDetails(selection, context, action, { exportMode = false, classCache, ...options } = {}) {
  return withDatastore(selection.server, selection.repository, async ({ exchange, identity, decodeText }) => {
    const resolved = await modelContext(exchange, identity, selection, decodeText);
    // A snapshot pins the model ID, but has no live session context to compare.
    if (!(context === null && selection.modelId) && resolved.contextId.toString('hex') !== context)
      throw new ModelReadError('MODEL_CONTEXT_CHANGED', 'Kontext modelu sa zmenil. Otvor model znova.', 409);
    const contextId = resolved.contextId;
    const objects = new Map(), valuesByObject = new Map(), relationDefinitions = new Map(), orderedCache = new Map();
    const valuesFor = async (object, semantic = false) => {
      const key = `${object.nativeClass}:${object.nativeId}:${semantic ? 'uml' : 'detail'}`;
      if (valuesByObject.has(key)) return valuesByObject.get(key);
      const values = decodeNativeAttributes(await readNativeAttributes(exchange, identity, object, contextId), decodeText);
      const documents = semantic ? values.longValues.filter(attribute => attribute.wireName === '_Ent2_InitialValue' ||
        (exportMode && /_(Description|DefaultValue)$/.test(attribute.wireName))) :
        exportMode ? values.longValues.filter(attribute =>
          ['Description','Notes','Documentation','PreConditions','PostConditions','Text','ActualParameters','StepType'].includes(attribute.name)) : values.longValues;
      for (const attribute of documents) {
        const bytes = await readNativeLongValue(exchange, identity, object, contextId, attribute);
        const text = documentText(bytes, decodeText);
        if (text === null) {
          values.attributes[attribute.name] = `Binárna príloha (${bytes.length} B)`;
          values.warnings.push(`${attribute.name}: príloha nie je textový dokument; jej bajty sa nevykresľujú ako text.`);
        } else values.attributes[attribute.name] = text;
      }
      valuesByObject.set(key, values);
      return values;
    };
    const read = async object => {
      const key = `${object.nativeClass}:${object.nativeId}`;
      if (objects.has(key)) return objects.get(key);
      const values = await valuesFor(object);
      const relations = decodeNativeRelationships(await readNativeRelationships(exchange, identity, object, contextId), decodeText);
      const result = { attributes: values.attributes, warnings: values.warnings, relations };
      objects.set(key, result);
      return result;
    };
    const orderedItems = async (object, role, targetClass) => {
      const key = `${object.nativeClass}:${object.nativeId}:${role}:${targetClass}`;
      if (orderedCache.has(key)) return orderedCache.get(key);
      const rows = await readOrderedRelationships(exchange, identity, object, contextId, role, targetClass);
      const result = decodeNativeRelationships(rows.map(row => new Map([
        [0x11, Buffer.from(role)], [0x0d, Buffer.from(targetClass)], ...row,
      ])), decodeText).map(relation => relation.item);
      orderedCache.set(key, result);
      return result;
    };
    const semanticRoles = {
      _Ent2_Class: ['_Ent2_Class_To_Attribute', '_Ent2_Class_To_Operation', '_Ent2_Class_To_Namespace',
        ...(exportMode ? ['_Ent2_UserStereotypedItem_To_UserStereotype'] : [])],
      _Ent2_Attribute: ['_Ent2_TypedAttribute_To_DataType'],
      _Ent2_Operation: ['_Ent2_Operation_To_Parameter', '_Ent2_TypedOperation_To_ReturnType'],
      _Ent2_Parameter: ['_Ent2_TypedParameter_To_DataType'],
      _Ent2_Association: ['_Ent2_Association_To_Role'],
      _Ent2_Role: ['_Ent2_Role_To_Class'],
    };
    const semanticObjects = new Map();
    const readSemantic = async object => {
      const key = `${object.nativeClass}:${object.nativeId}`;
      if (semanticObjects.has(key)) return semanticObjects.get(key);
      const roles = semanticRoles[object.nativeClass];
      if (!roles) throw new Error('Unsupported UML semantic object class.');
      // Leaf types don't need ordered member lists. Read their local links in one
      // request instead of querying separately for each possible datatype class.
      if (exportMode && ['_Ent2_Attribute','_Ent2_Parameter','_Ent2_Role'].includes(object.nativeClass)) {
        const values = await valuesFor(object, true);
        const rows = await readNativeRelationships(exchange, identity, object, contextId);
        const result = { attributes: values.attributes, warnings: values.warnings,
          relations: decodeNativeRelationships(rows, decodeText).filter(r => roles.includes(r.role)) };
        semanticObjects.set(key, result);
        return result;
      }
      if (!relationDefinitions.has(object.nativeClass)) {
        const rows = await readGroups(exchange, identity, 0x26, Buffer.concat([
          scalar(2, Buffer.from(identity, 'utf8')), scalar(7, Buffer.from(object.nativeClass, 'ascii')),
          scalar(0x35, Buffer.from('B')),
        ]), contextId);
        relationDefinitions.set(object.nativeClass, rows.map(row => ({
          role: decodeText(row.get(0x11)), targetClass: decodeText(row.get(0x0d)),
        })).filter(definition => roles.includes(definition.role)));
      }
      const values = await valuesFor(object, true), relations = [];
      for (const definition of relationDefinitions.get(object.nativeClass)) {
        const items = await orderedItems(object, definition.role, definition.targetClass);
        relations.push(...items.map(item => ({ role: definition.role, item })));
      }
      const result = { attributes: values.attributes, warnings: values.warnings, relations };
      semanticObjects.set(key, result);
      return result;
    };
    return action(async entry => {
    const start = performance.now();
    if (exportMode && entry.nativeClass === '_Ent2_Class') {
      const result = await classDiagramData([{ id: entry.id, target: entry, nativeClass: '_Ent2_CDClass', fields: {} }], readSemantic, orderedItems, classCache, exportMode);
      return { exportClass: result.classes[0] };
    }
    if (exportMode && entry.nativeClass === '_Ent2_Operation')
      return { owners: await orderedItems(entry, '_Ent2_Operation_To_Class', '_Ent2_Class') };
    const detail = await read(entry);
    let diagram;
    if (entry.nativeClass.endsWith('Diagram')) {
      const symbolEntries = new Map(detail.relations.filter(relation => relation.role === '_Ent2_Diagram_To_Symbol')
        .map(relation => [relation.item.id, relation.item]));
      if (symbolEntries.size > 2000) throw new ModelReadError('DIAGRAM_SIZE', 'Diagram má viac ako 2000 symbolov; nebol zverejnený čiastočný výsledok.', 413);
      const symbols = [];
      for (const symbol of symbolEntries.values()) {
        const data = await read(symbol);
        const target = data.relations.find(relation => relation.role.startsWith(`${symbol.nativeClass}_To_`) &&
          !relation.item.nativeClass.endsWith('Diagram') && !symbolEntries.has(relation.item.id))?.item ?? null;
        const endpoints = data.relations.filter(relation => symbolEntries.has(relation.item.id)).map(relation => relation.item);
        symbols.push({ id: symbol.id, nativeClass: symbol.nativeClass, nativeId: symbol.nativeId,
          fields: { ...data.attributes, Name: symbol.name, Type: symbol.name.includes('::') ? symbol.name : symbol.type,
          ...(target ? { 'Dictionary Item Name': target.name } : {}) }, target, endpoints, relations: data.relations });
        detail.warnings.push(...data.warnings.map(warning => `${symbol.name}: ${warning}`));
      }
      let uml;
      if (entry.nativeClass === '_Ent2_ClassDiagram') uml = await classDiagramData(symbols, readSemantic, orderedItems, classCache, exportMode);
      if (entry.nativeClass === '_Ent2_ObjectSequenceDiagram') {
        try {
          uml = await sequenceDiagramData(symbols, (owner, children, role = '_Ent2_ParentStep_To_ChildStep') =>
            orderedItems(owner, role, '_Ent2_OSDStep'), {allowUnplaced:exportMode});
        } catch (error) {
          if (error.code === 'SQD_INCOMPLETE_ORDER') throw new ModelReadError(error.code,error.message,422);
          throw error;
        }
        uml.title = entry.name;
        const byId = new Map(symbols.map(symbol => [symbol.id, symbol]));
        for (const line of uml.participants) {
          const symbol = byId.get(line.id);
          line.systemBoundary = symbol.nativeClass === '_Ent2_OSDSystemBoundary';
          if (exportMode || symbol.target?.nativeClass !== '_Ent2_Class') continue;
          const fields = (await valuesFor(symbol.target, true)).attributes;
          line.stereotype = classStereotype(fields.Stereotype);
          if (symbol.fields.ViewShowCustomStereotype === 'true')
            line.custom = (await orderedItems(symbol.target, '_Ent2_UserStereotypedItem_To_UserStereotype', '_Ent2_UserStereotype')).map(item => item.name);
          line.instance = symbol.fields.Name;
        }
        uml.boundaries = symbols.filter(symbol => symbol.nativeClass === '_Ent2_OSDArchitecturalBoundary')
          .map(symbol => Number(symbol.fields.Position?.split(/\s+/)[0])).filter(Number.isFinite);
      }
      diagram = { symbols, ...(uml ? { uml, schemaVersion: 3 } : {}) };
    }
    return { id: entry.id, ...detail, ...(diagram ? { diagram } : {}), cached: false,
      loadedAt: new Date().toISOString(), sourceMs: Math.round(performance.now() - start) };
    });
  }, { timeoutMs: 15000, idleTimeout: true, ...options });
}
