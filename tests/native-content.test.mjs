import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNativeAttributes, decodeNativeRelationships, readGroups, readNativeLongValue, loadNativeDetail, loadNativeCatalog, modelContext } from '../native-content.mjs';
import { datastoreTextCodec, documentText, rtfText } from '../native-text.mjs';
import { fields, scalar } from '../direct-broker.mjs';
import { list, string, integer, reply, negotiation } from './protocol-fixture.mjs';
import { withDatastore, readObjectCatalog } from '../direct-models.mjs';
import { geometry, connectorPoints } from '../web/diagram.mjs';
import { identity, validateSelection } from '../reader.mjs';

const user = 'TEST\\reader';
const context = Buffer.from('0001000300000001', 'hex');
const entry = { nativeClass: '_Ent2_UCDUseCase', nativeName: '00000000-0000-0000-0000-000000000001', nativeId: '0001000200000001' };
const row = parts => fields(Buffer.concat(parts));
const attribute = (name, type, value) => row([string(6, name), string(0x25, `ON${type}U`), ...(value ? [scalar(0x1e, value)] : [])]);
const long = value => { const buffer = Buffer.alloc(4); buffer.writeInt32BE(value); return buffer; };

test('decodes actual numeric symbol arrays without mistaking the coordinate count for a point', () => {
  const rows = [
    attribute('_Ent2_Position', 'l', long(2)),
    row([string(0x2f, 'l'), scalar(0x1e, long(525))]),
    row([string(0x2f, 'l'), scalar(0x1e, long(258))]),
    attribute('_Ent2_Height', 'l', long(300)),
    attribute('_Ent2_Width', 'l', long(600)),
    attribute('_Ent2_Uses3D', 'B', Buffer.from('T')),
  ];
  const result = decodeNativeAttributes(rows);
  assert.equal(result.attributes.Position, '525 258');
  assert.equal(result.attributes.Uses3D, 'true');
  assert.deepEqual(geometry({ fields: result.attributes }), {
    x: 525, y: 258, width: 600, height: 300, points: [[525, 258]],
  });
  assert.throws(() => decodeNativeAttributes([attribute('_Ent2_Position', 'l', long(5))]), /position array/);
  assert.throws(() => decodeNativeAttributes([attribute('_Ent2_Width', 'C', Buffer.from('bogus 100'))]), /geometry/);
  const capacity = decodeNativeAttributes([
    attribute('_Ent2_Waypoints', 'l', long(0)),
    row([string(0x2f, 'l'), scalar(0x1e, long(528))]),
    row([string(0x2f, 'l'), scalar(0x1e, long(739))]),
  ]);
  assert.equal(capacity.attributes.Waypoints, '');
});

test('preserves Windows-1250 Slovak labels and requires a negotiated supported code page', () => {
  const decode = datastoreTextCodec('WESTERN');
  assert.equal(decode(Buffer.from('8a61626cf36e61','hex')), 'Šablóna');
  assert.equal(datastoreTextCodec('UNICODE')(Buffer.from('Žiadosť')), 'Žiadosť');
  assert.throws(() => datastoreTextCodec('unknown'), /code page/);
  const attributes = decodeNativeAttributes([attribute('_Ent2_Text', 'C', Buffer.from('8a61626cf36e61', 'hex'))]);
  assert.equal(attributes.attributes.Text, 'Šablóna');
});

test('reads text documents and RTF as inert text, including escaped accents and Unicode', () => {
  assert.equal(documentText(Buffer.from('plain <script>text</script>')), 'plain <script>text</script>');
  assert.equal(rtfText(String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}Text \'8aabl\'f3na\par \u381?iados\u357?.}`),
    'Text Šablóna\nŽiadosť.');
  assert.equal(documentText(Buffer.from([0, 1, 2])), null);
  assert.equal(documentText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Žiadosť')])), 'Žiadosť');
  assert.throws(() => rtfText('{\\rtf1 broken'), /Unbalanced/);
});

test('keeps opaque continuation header bytes and rejects incomplete or repeated native pages', async () => {
  const prefix = Buffer.concat([string(0x46, 'N'), integer(0x56, 49, 2), string(7, 'X')]);
  prefix.writeUInt16BE(prefix.length + 40, 5);
  const first = reply(0x16, Buffer.concat([prefix, list(0xc9, [string(7, '_Ent2_UseCase')])]));
  first.fill(0x5a, 16, 28);
  let calls = 0;
  const rows = await readGroups(async packet => {
    if (calls++ === 0) return first;
    assert.deepEqual(packet.subarray(16, 28), first.subarray(16, 28));
    assert.deepEqual(packet.subarray(40), prefix);
    return reply(0x16, Buffer.concat([string(0x46, 'Y'), list(0xc9, [])]));
  }, user, 0x16, scalar(2, Buffer.from(user)), context);
  assert.equal(rows[0].get(7).toString(), '_Ent2_UseCase');
  await assert.rejects(readGroups(async () => first, user, 0x16, Buffer.alloc(0), context), /Repeated/);
});

test('streams exact binary attribute chunks using read-only OSOAGET and rejects truncated data', async () => {
  let calls = 0;
  const result = await readNativeLongValue(async packet => {
    assert.equal(packet.readUInt16BE(6), 0x3c);
    const request = fields(packet.subarray(40));
    assert.equal(request.get(6).toString(), '_Ent2_Description');
    assert.equal(request.get(8).length, 0);
    assert.equal(request.get(9).length, 0);
    assert.equal(request.get(10).toString('hex'), entry.nativeId);
    assert.equal(request.get(0x6b).readUInt32BE(), calls * 3);
    return reply(0x3c, list(0xc1, [Buffer.concat([
      string(0x25, 'ONcU'), scalar(0x1e, Buffer.from(calls++ ? 'def' : 'abc')),
    ])]));
  }, user, entry, context, { wireName: '_Ent2_Description', size: 6 });
  assert.equal(result.toString(), 'abcdef');
  await assert.rejects(readNativeLongValue(async () => reply(0x3c, list(0xc1, [
    Buffer.concat([string(0x25, 'ONcU'), scalar(0x1e, Buffer.alloc(0))]),
  ])), user, entry, context, { wireName: '_Ent2_Description', size: 1 }), /truncated/);
});

test('maps actual relationship fields to read-only dictionary targets with stable datastore IDs', () => {
  const relations = decodeNativeRelationships([row([
    string(0x11, '_Ent2_UCDUseCase_To_UseCase'), string(0x0d, '_Ent2_UseCase'),
    string(0x0e, '00000000-0000-0000-0000-000000000002'), string(0x0f, '000000Example'),
    scalar(0x10, Buffer.from('0001000200000002', 'hex')),
  ])]);
  assert.equal(relations[0].item.name, 'Example');
  assert.match(relations[0].item.id, /^[a-f0-9]{32}$/);
  assert.equal(relations[0].item.nativeId, '0001000200000002');
  assert.equal(relations[0].item.nativeClass, '_Ent2_UseCase');
});

test('native model copies do not overwrite a preexisting legacy offline copy', () => {
  const selection = { server: 'test-server', repository: 'Example', model: 'Model' };
  assert.notEqual(identity(selection), identity({ ...selection, modelId: '0001000200000001' }));
  assert.equal(validateSelection({ ...selection, modelId: '00010002000000AA' }).modelId, '00010002000000aa');
  assert.throws(() => validateSelection({ ...selection, modelId: '../invalid' }), /modelId/);
});

test('reads low-tag single parameter groups without treating their 16-bit length as a scalar length', () => {
  const contents = string(7, 'Configuration'), header = Buffer.alloc(3);
  header[0] = 0x2a;
  header.writeUInt16BE(contents.length, 1);
  const decoded = fields(Buffer.concat([string(0x31, 'N'), header, contents]));
  assert.equal(decoded.get(0x31).toString(), 'N');
  assert.equal(decoded.get(0x2a).get(7).toString(), 'Configuration');
});

test('full catalog selects the working context, streams diagrams first and reports timed-out classes explicitly', async () => {
  const modelId = '00010002000000ff';
  const selection = { server: 'test-server', repository: 'Example', model: 'Model' };
  const object = (name, id, version) => Buffer.concat([
    string(8, name), scalar(10, Buffer.from(id, 'hex')), ...(version === undefined ? [] : [string(9, version)]),
  ]);
  const page = (className, rows) => reply(55, Buffer.concat([
    string(7, className), string(2, user), string(0x3d, 'V'), string(0x3e, 'X'), string(0x46, 'Y'), list(0xc9, rows),
  ]));
  for (const failure of [null, 'TCP_TIMEOUT', 'ECONNRESET', 'recover']) {
    let attempts = 0;
    const timeout = !!failure && failure !== 'recover';
    const batches = [], errors = [], operations = [], timeouts = [], attempted = [];
    const exchange = async packet => {
      const op = packet.readUInt16BE(6), body = fields(packet.subarray(40));
      operations.push(op);
      if (op === 0x93) return negotiation('8.1');
      if (op === 55) {
        const name = body.get(7).toString();
        if (name === '_Ent2_Model') return page(name, [object('Model', modelId, '0')]);
        if (name === 'Context') return page(name, [object(modelId.toUpperCase(), context.toString('hex'))]);
        attempted.push(name);
        if (name === '_Ent2_UseCaseDiagram' && ++attempts && failure && (timeout || attempts <= 2))
          throw Object.assign(new Error('Interrupted'), { code: timeout ? failure : 'ECONNRESET' });
        return page(name, [object(entry.nativeName, entry.nativeId, `000000${name.endsWith('Diagram') ? 'Diagram' : 'Item'}`)]);
      }
      if (op === 136) return reply(op, string(0x31, 'N'));
      if (op === 137) {
        assert.equal(body.get(0x31).toString(), 'N');
        const response = reply(op, Buffer.alloc(0));
        context.copy(response, 8);
        return response;
      }
      if (op === 22) return reply(op, Buffer.concat([string(0x46, 'Y'),
        list(0xc9, [string(7, '_Ent2_Class'), string(7, '_Ent2_UseCaseDiagram')])]));
      throw new Error('Unexpected non-read operation.');
    };
    const options = {
      waitForRetry: async () => {},
      repositories: async () => ({ repositories: [{ name: 'Example', server: 'test-server', port: 6200 }] }),
      windowsConnect: async () => ({ method: 'windows-smb', verifiedUserId: user, shareReadable: true,
        networkIdentityVerified: true, credentialsRequested: false, persistentMapping: false }),
      connect: async (_server, options, action) => {
        assert.equal(options.idleTimeout, true);
        timeouts.push(options.timeoutMs);
        return action({ exchange });
      },
      onBatch: batch => batches.push(batch), onClassError: error => errors.push(error),
    };
    const result = await loadNativeCatalog(selection, options);
    assert.equal(attempts, failure ? 3 : 1);
    assert.deepEqual(attempted, ['_Ent2_UseCaseDiagram','_Ent2_Class',...(failure ? Array(2).fill('_Ent2_UseCaseDiagram') : [])]);
    assert.deepEqual(timeouts, failure ? [60000,15000,15000,60000,60000] : [60000,15000]);
    assert.ok(operations.includes(136) && operations.includes(137));
    assert.equal(result.complete, !timeout);
    if (timeout) {
      assert.equal(errors[0].className, '_Ent2_UseCaseDiagram');
      assert.equal(result.entries.length, 1);
      assert.equal(result.errors[0].code, failure);
      attempted.length = 0;
      timeouts.length = 0;
      await loadNativeCatalog(selection, { ...options, retryClasses: new Set(['_Ent2_UseCaseDiagram']), previousSchema: result.schemaClasses });
      assert.deepEqual(attempted, Array(3).fill('_Ent2_UseCaseDiagram'));
      assert.deepEqual(timeouts, [60000,60000,60000,60000]);
    } else {
      assert.equal(batches[0][0].name, failure ? 'Item' : 'Diagram');
      assert.equal(result.entries.length, 2);
      assert.equal(new Set(result.entries.map(item => item.id)).size, 2);
    }
    assert.ok(!JSON.stringify(result).includes(user));
  }
});

test('configured live use case diagram contains geometry and dictionary links without an SDK', {
  skip: !process.env.SELECT_CONTENT_SERVER,
}, async () => {
  const selection = { server: process.env.SELECT_CONTENT_SERVER, repository: process.env.SELECT_CONTENT_REPOSITORY, model: process.env.SELECT_CONTENT_MODEL };
  assert.ok(selection.repository && selection.model && process.env.SELECT_CONTENT_DIAGRAM, 'Configure repository, model and diagram before running the live test.');
  const {selected, context} = await withDatastore(selection.server, selection.repository, async ({ exchange, identity, decodeText }) => {
    const {contextId} = await modelContext(exchange, identity, selection, decodeText);
    const diagrams = await readObjectCatalog(exchange, identity, {
      className: '_Ent2_UseCaseDiagram', contextId, decodeValue: decodeText,
    });
    const diagram = diagrams.find(item => item.version === `000000${process.env.SELECT_CONTENT_DIAGRAM}`);
    assert.ok(diagram);
    return { context:contextId.toString('hex'), selected:{ id: diagram.id, nativeId: diagram.id, nativeName: diagram.name, nativeClass: '_Ent2_UseCaseDiagram' } };
  }, { timeoutMs: 15000, idleTimeout: true });
  const detail = await loadNativeDetail(selection, selected, context);
  assert.ok(detail.diagram.symbols.length > 0);
  assert.ok(detail.diagram.symbols.some(symbol => symbol.target?.name));
  assert.ok(detail.diagram.symbols.every(symbol => geometry(symbol)?.points.length > 0 ||
    connectorPoints(symbol, detail.diagram.symbols)?.length >= 2));
  assert.ok(detail.diagram.symbols.some(symbol => /Flow/.test(symbol.fields.Type)));
  assert.equal(detail.cached, false);
});
