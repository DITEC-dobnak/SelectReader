import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('sk');
}

export function identity(selection) {
  return createHash('sha256').update(JSON.stringify([
    selection.server.toLowerCase(), selection.repository, selection.model,
    ...(selection.modelId ? [selection.modelId] : []),
  ])).digest('hex');
}

export function isDiagram(type) {
  return /\bdiagram\b/i.test(type);
}

const textIndex = new WeakMap();

export function searchable(entry, detail) {
  const cached = textIndex.get(entry);
  if (cached && cached.detail === detail) return cached.text;
  const text = normalize([entry.name, entry.path, entry.type,
    ...(isDiagram(entry.type) ? [entry.name.replace(/\s+/g, '')] : []),
    ...Object.values(detail?.attributes ?? {}),
  ].join('\n'));
  textIndex.set(entry, { detail, text });
  return text;
}

export function search(entries, details, { query = '', kind = '', type = '', offset = 0, limit = 80 } = {}) {
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches = [];
  for (const entry of entries.values()) {
    if (kind === 'diagrams' && !isDiagram(entry.type)) continue;
    if (kind === 'dictionary' && isDiagram(entry.type)) continue;
    if (type && entry.type !== type) continue;
    if (words.length && !words.every(word => searchable(entry, details.get(entry.id)).includes(word))) continue;
    matches.push(entry);
  }
  matches.sort((a, b) => a.name.localeCompare(b.name, 'sk') || a.id.localeCompare(b.id));
  return { total: matches.length, items: matches.slice(offset, offset + limit) };
}

export class Cache {
  constructor(directory) {
    this.directory = directory;
    this.writes = Promise.resolve();
  }
  filename(selection) { return path.join(this.directory, `${identity(selection)}.json`); }
  remove(selection) {
    const operation = this.writes.then(() => unlink(this.filename(selection)));
    this.writes = operation.catch(() => {});
    return operation;
  }
  async load(selection) {
    try {
      const data = JSON.parse(await readFile(this.filename(selection), 'utf8'));
      if (data.version !== 1 || identity(data.selection) !== identity(selection) || !Array.isArray(data.entries) ||
          !Array.isArray(data.details)) throw new Error('Neplatný formát lokálnej kópie modelu.');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Lokálnu kópiu nemožno načítať: ${error.message}`, { cause: error });
    }
  }
  save(data) {
    const body = JSON.stringify(data);
    const filename = this.filename(data.selection);
    const operation = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await writeFile(`${filename}.tmp`, body, { encoding: 'utf8', mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
    });
    // Keep the queue usable after an error; return the failed write to its caller.
    this.writes = operation.catch(() => {});
    return operation;
  }
  async history() {
    let files;
    try { files = await readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      const data = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
      if (data.version !== 1) throw new Error(`Nepodporovaná verzia lokálnej kópie: ${file}`);
      result.push({ selection: data.selection, updatedAt: data.updatedAt, count: data.entries.length, complete: data.complete });
    }
    return result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}

export function validateSelection(input) {
  if (!input || typeof input !== 'object') throw new Error('Chýba výber modelu.');
  const result = {};
  for (const field of ['server', 'repository', 'model']) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\\/]/.test(value)) {
      throw new Error(`Neplatný parameter ${field}.`);
    }
    if (input.modelId !== undefined) {
      if (typeof input.modelId !== 'string' || !/^[a-f0-9]{16}$/i.test(input.modelId)) throw new Error('Neplatný parameter modelId.');
      result.modelId = input.modelId.toLowerCase();
    }
    result[field] = value.trim();
  }
  return result;
}

export function validateId(id) {
  if (!/^[a-f0-9-]{1,80}$/i.test(id)) throw new Error('Neplatný identifikátor objektu.');
  return id;
}
