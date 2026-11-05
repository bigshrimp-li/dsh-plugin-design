import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createSqliteStorage } from './storage.js';
import { createCalendarRecords } from './calendar-records.js';
import { legacySchedule } from './calendar-legacy.js';
import { createCalendarFiles, exportCalendarDocument, refreshCalendarDocuments } from './calendar-files.js';

export function createDomainService(options) { return createSqliteStorage(options); }

const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${randomUUID()}`;
const stable = value => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
const parse = (value, fallback = null) => value == null ? fallback : JSON.parse(value);
function fault(code, message, kind = 'failed') { const error = new Error(message); Object.assign(error, { code, kind, public: true }); throw error; }
function requireHost(binding) { if (binding.trusted !== true) fault('FORBIDDEN', 'This operation requires a trusted Host binding'); }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !['.', '..', 'groups', 'migrations'].includes(value); }
function object(value, message = 'Expected an object') { if (!value || Array.isArray(value) || typeof value !== 'object') fault('INVALID_INPUT', message); return value; }
const output = (kind, data, operationId = null, error = null) => ({ kind, operationId, data, error });

const schema = `
 PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS dimensions(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS types(id TEXT NOT NULL,version TEXT NOT NULL,value TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(id,version));
 CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,type_id TEXT NOT NULL,type_version TEXT NOT NULL,main_k_id TEXT REFERENCES dimensions(id),title TEXT NOT NULL,fields_json TEXT NOT NULL,body TEXT NOT NULL,source_json TEXT,legacy_json TEXT,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(type_id,type_version) REFERENCES types(id,version));
 CREATE TABLE IF NOT EXISTS item_changes(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS item_field_versions(item_id TEXT NOT NULL REFERENCES items(id),field_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(item_id,field_id));
 CREATE TABLE IF NOT EXISTS pending_materials(id TEXT PRIMARY KEY,type_id TEXT NOT NULL,value TEXT NOT NULL,status TEXT NOT NULL,item_id TEXT,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS categories(table_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(table_id,id,version));
 CREATE TABLE IF NOT EXISTS actions(item_id TEXT PRIMARY KEY REFERENCES items(id),value TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),occurrence_key TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,UNIQUE(item_id,occurrence_key));
 CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,target_id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS operations(request_id TEXT PRIMARY KEY,command TEXT NOT NULL,input_hash TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,receipt_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migrations(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS hosted_state(namespace TEXT NOT NULL,key TEXT NOT NULL,scope TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(namespace,key,scope));
 CREATE TABLE IF NOT EXISTS trial_records(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,provenance TEXT NOT NULL,value TEXT NOT NULL,item_id TEXT,revision INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS items_type ON items(type_id);
 CREATE VIRTUAL TABLE IF NOT EXISTS item_search USING fts5(item_id UNINDEXED,title,body);
`;

export function createStorageContext({ baseDir, DatabaseSync }) {
  const databases = new Map();
  const root = path.resolve(baseDir);
  function safeSpace(objectiveId, create = false) {
    if (!validId(objectiveId)) fault('INVALID_SPACE', 'Invalid objective identifier');
    if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(root)) fault('NOT_FOUND', 'Storage directory does not exist');
    const realRoot = fs.realpathSync(root);
    const directory = path.join(realRoot, objectiveId);
    if (fs.lstatSync(directory, { throwIfNoEntry:false })?.isSymbolicLink()) fault('INVALID_PATH', 'Symbolic space directories are not allowed');
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(directory)) fault('NOT_FOUND', 'Space does not exist');
    if (fs.realpathSync(directory) !== directory) fault('INVALID_PATH', 'Space directory escapes its storage root');
    return directory;
  }
  function safeFile(directory, name) {
    const file = path.join(directory, name);
    if (fs.lstatSync(file, { throwIfNoEntry:false })?.isSymbolicLink()) fault('INVALID_PATH', 'Symbolic storage files are not allowed');
    return file;
  }
  function connection(file) {
    let stat = fs.lstatSync(file, { throwIfNoEntry:false });
    if (!stat) {
      try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(file);
    }
    if (!stat.isFile()) fault('INVALID_PATH', 'Storage file must be a regular file');
    const identity = stat.dev + ':' + stat.ino;
    const existing = databases.get(file);
    if (existing?.identity === identity) return existing.db;
    if (existing) { existing.db.close(); databases.delete(file); }
    const db = new DatabaseSync(file);
    // Changing the initial journal mode can return SQLITE_BUSY immediately even
    // with busy_timeout set. Only retry the idempotent schema in the storage Worker.
    const deadline = Date.now() + 5000;
    for (;;) {
      try { db.exec(schema); break; }
      catch (error) {
        if ((error.errcode & 255) !== 5 || Date.now() >= deadline) { db.close(); throw error; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
    databases.set(file, { db, identity });
    return db;
  }
  function open(objectiveId, { create = false, filename = 'space.sqlite' } = {}) {
    const directory = safeSpace(objectiveId, create);
    const file = safeFile(directory, filename);
    if (!create && !fs.existsSync(file)) fault('MIGRATION_REQUIRED', 'This space has no SQLite database; inspect and migrate it explicitly');
    return connection(file);
  }
  return { root, safeSpace, safeFile, open, DatabaseSync,
    openGroup(groupId) {
      if (!validId(groupId)) fault('INVALID_GROUP', 'Invalid group identifier');
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const parent = safeFile(fs.realpathSync(root), 'groups');
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const directory = safeFile(parent, groupId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(directory) !== directory) fault('INVALID_PATH', 'Group directory escapes its storage root');
      const file = safeFile(directory, 'group.sqlite');
      return connection(file);
    },
    closeOne(objectiveId, filename = 'space.sqlite') { const file = path.join(fs.realpathSync(root), objectiveId, filename); databases.get(file)?.db.close(); databases.delete(file); },
    close() { for (const { db } of databases.values()) db.close(); databases.clear(); }
  };
}

function meta(db, key) { return parse(db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value); }
function setMeta(db, key, value) { db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, stable(value)); }
function space(db) { const value = meta(db, 'space'); if (!value) fault('NOT_FOUND', 'Space metadata is missing'); return value; }
function typeRows(db) { return db.prepare('SELECT value FROM types WHERE active=1 ORDER BY id').all().map(row => parse(row.value)); }
function typeFor(db, typeId, version) { return parse((version ? db.prepare('SELECT value FROM types WHERE id=? AND version=?').get(typeId, String(version)) : db.prepare('SELECT value FROM types WHERE id=? AND active=1 ORDER BY rowid DESC LIMIT 1').get(typeId))?.value); }
function itemValue(row) {
  if (!row) return null;
  return { id: row.id, itemId: row.id, typeId: row.type_id, typeVersion: row.type_version, mainKId: row.main_k_id, title: row.title, fields: parse(row.fields_json, {}), body: row.body, source: parse(row.source_json), legacy_payload: parse(row.legacy_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}
function detailedItem(db, row) { const value = itemValue(row); if (value) value.fieldVersions = Object.fromEntries(db.prepare('SELECT field_id,value FROM item_field_versions WHERE item_id=?').all(value.id).map(entry => [entry.field_id, parse(entry.value)])); return value; }
function getItem(db, itemId) { const value = detailedItem(db, db.prepare('SELECT * FROM items WHERE id=?').get(itemId)); if (!value) fault('NOT_FOUND', 'Item does not exist in this space'); return value; }
function dimension(db, dimensionId) { return dimensionId ? parse(db.prepare('SELECT value FROM dimensions WHERE id=?').get(dimensionId)?.value) : null; }
function archived(db, mainKId) { return !!(space(db).archivedAt || (mainKId && dimension(db, mainKId)?.archivedAt)); }
function requireActive(db, mainKId) { if (archived(db, mainKId)) fault('ARCHIVED', 'Archived facts and configuration are read-only'); }
function requireRevision(actual, expected) { if (expected !== actual) fault('REVISION_CONFLICT', 'The object changed; refresh before retrying', 'conflict'); }
function checkBundle(db, binding) {
  const expected = binding.bundleId ?? binding.bundleVersion ?? binding.bundle_id;
  if (expected != null && expected !== space(db).activeBundleId) fault('BUNDLE_CONFLICT', 'The active space version changed', 'conflict');
}
function checkContextFence(db, binding) {
  const fence = binding.contextFence;
  if (!fence) return;
  const runtime = parse(db.prepare("SELECT value FROM hosted_state WHERE namespace='runtime' AND key='bot' AND scope='bot'").get()?.value);
  const task = runtime?.tasks?.[fence.taskId];
  if (!task || task.runId !== fence.runId || task.contextGeneration !== fence.contextGeneration || task.phase !== 'running' || !task.lease || task.lease.expiresAt <= Date.now()) fault('STALE_CONTEXT', 'The task execution context is no longer current', 'conflict');
}
function setTypes(db, types) {
  if (!Array.isArray(types)) fault('INVALID_TYPES', 'Types must be an array');
  const ids = new Set();
  for (const raw of types) {
    object(raw);
    if (!validId(raw.id) || ids.has(raw.id)) fault('INVALID_TYPES', 'Type identifiers must be unique');
    ids.add(raw.id);
    const fields = raw.fields || [];
    const fieldIds = new Set();
    for (const field of fields) {
      if (!validId(field.id) || fieldIds.has(field.id)) fault('INVALID_TYPES', 'Field identifiers must be unique');
      fieldIds.add(field.id);
      if (!['text', 'string', 'boolean', 'integer', 'decimal', 'date', 'datetime', 'category', 'reference', 'item', 'url'].includes(field.kind)) fault('INVALID_TYPES', 'Unsupported field kind');
      if (field.kind === 'decimal' && (!Number.isInteger(field.precision ?? 2) || (field.precision ?? 2) < 0 || (field.precision ?? 2) > 12)) fault('INVALID_TYPES', 'Decimal precision must be between 0 and 12');
    }
    const value = { ...raw, version: String(raw.version ?? '1'), fields };
    const existing = typeFor(db, value.id, value.version);
    if (existing && stable(existing) !== stable(value)) fault('IMMUTABLE_TYPE', 'A type version cannot be overwritten', 'conflict');
  }
  db.prepare('UPDATE types SET active=0').run();
  for (const raw of types) {
    const value = { ...raw, version: String(raw.version ?? '1'), fields: raw.fields || [] };
    db.prepare('INSERT INTO types(id,version,value,active) VALUES(?,?,?,1) ON CONFLICT(id,version) DO UPDATE SET active=1').run(value.id, value.version, stable(value));
  }
}
function decimal(value, precision) {
  if (typeof value !== 'string' && typeof value !== 'number') fault('INVALID_FIELD', 'Decimal fields require a decimal value');
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[3]?.length || 0) > precision) fault('INVALID_FIELD', 'Invalid decimal value or precision');
  return `${match[1]}${BigInt(match[2])}${precision ? `.${(match[3] || '').padEnd(precision, '0')}` : ''}`;
}
function decimalInteger(value, precision) { const result = decimal(value, precision); return BigInt(result.replace('.', '')); }
function decimalString(value, precision) { const sign = value < 0n ? '-' : ''; const text = (value < 0n ? -value : value).toString().padStart(precision + 1, '0'); return `${sign}${precision ? `${text.slice(0, -precision)}.${text.slice(-precision)}` : text}`; }
function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
function validateFields(db, type, rawFields, mainKId) {
  object(rawFields);
  if (mainKId && !dimension(db, mainKId)) fault('INVALID_REFERENCE', 'Dimension must belong to the current space');
  const fields = {};
  const missing = [];
  const definitions = new Map(type.fields.map(field => [field.id, field]));
  for (const key of Object.keys(rawFields)) if (!definitions.has(key)) fault('UNKNOWN_FIELD', `Unknown field: ${key}`);
  for (const field of type.fields) {
    let value = rawFields[field.id];
    if (value == null || value === '') {
      if (field.required) missing.push(field.id);
      if (value !== undefined) fields[field.id] = value;
      continue;
    }
    const values = field.list ? value : [value];
    if (!Array.isArray(values)) fault('INVALID_FIELD', `Field requires a list: ${field.id}`);
    const checked = values.map(entry => {
      const kind = field.kind;
      if (['text', 'string', 'url', 'date', 'datetime', 'category', 'reference', 'item'].includes(kind) && typeof entry !== 'string') fault('INVALID_FIELD', `Invalid value: ${field.id}`);
      if (kind === 'boolean' && typeof entry !== 'boolean') fault('INVALID_FIELD', `Invalid boolean: ${field.id}`);
      if (kind === 'integer' && !Number.isSafeInteger(entry)) fault('INVALID_FIELD', `Invalid integer: ${field.id}`);
      if (kind === 'decimal') entry = decimal(entry, field.precision ?? 2);
      if (kind === 'date' && !validDate(entry)) fault('INVALID_FIELD', `Invalid calendar date: ${field.id}`);
      if (kind === 'datetime' && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(entry) || Number.isNaN(Date.parse(entry)))) fault('INVALID_FIELD', `Timestamp requires a timezone: ${field.id}`);
      if (kind === 'url' && !/^https?:\/\//i.test(entry)) fault('INVALID_FIELD', `Unsupported URL: ${field.id}`);
      if (kind === 'category' && !db.prepare('SELECT id FROM categories WHERE table_id=? AND id=? AND active=1').get(field.categoryTableId || field.category_table_id || 'default', entry)) fault('INVALID_REFERENCE', 'Category must belong to the declared category table');
      if (['reference', 'item'].includes(kind) && !db.prepare('SELECT id FROM items WHERE id=?').get(entry)) fault('INVALID_REFERENCE', 'Item reference must belong to the current space');
      if (field.enum && !field.enum.includes(entry)) fault('INVALID_FIELD', `Value is outside the allowed choices: ${field.id}`);
      if (typeof entry === 'number' && ((field.min != null && entry < field.min) || (field.max != null && entry > field.max))) fault('INVALID_FIELD', `Value is outside the allowed range: ${field.id}`);
      return entry;
    });
    fields[field.id] = field.list ? checked : checked[0];
  }
  return { fields, missing };
}

function saveItem(db, input, binding, operationId, { existing, materialId } = {}) {
  const typeId = input.typeId ?? input.type_id;
  const type = typeFor(db, typeId);
  if (!type) return output('unsupported', { reason: 'The active space has no matching item type', typeId }, operationId);
  const mainKId = input.mainKId ?? input.main_k_id ?? null;
  const validated = validateFields(db, type, input.fields || {}, mainKId);
  const title = input.title == null ? '' : String(input.title);
  const body = input.body ?? input.body_md ?? '';
  if (typeof body !== 'string') fault('INVALID_INPUT', 'Item body must be text');
  const candidate = { typeId, title, fields: validated.fields, body, mainKId, source: binding.source || (binding.trusted ? input.source : null) || null };
  if (archived(db, mainKId) || validated.missing.length) {
    if (existing) fault('ARCHIVED_OR_INCOMPLETE', 'The archived or incomplete item cannot be modified');
    const current = materialId && db.prepare('SELECT * FROM pending_materials WHERE id=?').get(materialId);
    const pendingId = materialId || id('MAT');
    const reason = archived(db, mainKId) ? 'archived' : 'missing_fields';
    const value = { ...candidate, missing: validated.missing, reason, sourceScope: binding.sourceScope || null };
    if (current) db.prepare('UPDATE pending_materials SET value=?,revision=revision+1 WHERE id=?').run(stable(value), pendingId);
    else db.prepare('INSERT INTO pending_materials VALUES(?,?,?,\'pending\',NULL,1)').run(pendingId, typeId, stable(value));
    return output('pending', { materialId: pendingId, ...value, revision: (current?.revision || 0) + 1 }, operationId);
  }
  const itemId = existing?.id || input.id || id('ITEM');
  if (!validId(itemId)) fault('INVALID_INPUT', 'Invalid item identifier');
  const revision = (existing?.revision || 0) + 1;
  const timestamp = now();
  if (existing) {
    requireRevision(existing.revision, input.expectedRevision);
    db.prepare('UPDATE items SET type_version=?,main_k_id=?,title=?,fields_json=?,body=?,source_json=?,revision=?,updated_at=? WHERE id=?').run(type.version, mainKId, title, stable(validated.fields), body, stable(candidate.source), revision, timestamp, itemId);
    db.prepare('INSERT INTO item_changes VALUES(?,?,?)').run(id('CHANGE'), itemId, stable({ before: existing, afterRevision: revision, operationId, source: candidate.source }));
  } else {
    if (db.prepare('SELECT id FROM items WHERE id=?').get(itemId)) fault('ITEM_CONFLICT', 'Item identifier already exists', 'conflict');
    db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(itemId, type.id, type.version, mainKId, title, stable(validated.fields), body, stable(candidate.source), null, revision, timestamp, timestamp);
  }
  db.prepare('DELETE FROM item_search WHERE item_id=?').run(itemId);
  db.prepare('INSERT INTO item_search(item_id,title,body) VALUES(?,?,?)').run(itemId, title, body);
  for (const field of type.fields.filter(entry => entry.kind === 'category')) {
    if (existing && stable(existing.fields[field.id]) === stable(validated.fields[field.id]) && existing.fieldVersions?.[field.id]) continue;
    const values = field.list ? validated.fields[field.id] || [] : [validated.fields[field.id]];
    const versions = values.filter(Boolean).map(categoryId => parse(db.prepare('SELECT value FROM categories WHERE table_id=? AND id=? AND active=1').get(field.categoryTableId || field.category_table_id || 'default', categoryId)?.value));
    db.prepare('INSERT INTO item_field_versions VALUES(?,?,?) ON CONFLICT(item_id,field_id) DO UPDATE SET value=excluded.value').run(itemId, field.id, stable(field.list ? versions : versions[0] || null));
  }
  if (materialId) {
    const material = parse(db.prepare('SELECT value FROM pending_materials WHERE id=?').get(materialId)?.value);
    db.prepare("UPDATE pending_materials SET status='completed',item_id=?,revision=revision+1 WHERE id=?").run(itemId, materialId);
    if (material?.trialId) db.prepare('UPDATE trial_records SET item_id=?,revision=revision+1 WHERE id=? AND item_id IS NULL').run(itemId, material.trialId);
  }
  return output('saved', { itemId, revision, item: getItem(db, itemId) }, operationId);
}

function snapshot(db) {
  const data = { space: space(db), types: typeRows(db), dimensions: db.prepare('SELECT value FROM dimensions ORDER BY id').all().map(row => parse(row.value)), items: db.prepare('SELECT * FROM items ORDER BY created_at,id').all().map(row => detailedItem(db, row)), materials: db.prepare("SELECT * FROM pending_materials WHERE status='pending' ORDER BY rowid").all().map(row => ({ id: row.id, materialId: row.id, ...parse(row.value), revision: row.revision })), categories: db.prepare('SELECT value FROM categories WHERE active=1 ORDER BY table_id,id').all().map(row => parse(row.value)), actions: db.prepare('SELECT item_id,value,revision FROM actions').all().map(row => ({ itemId: row.item_id, ...parse(row.value), revision: row.revision })), executions: db.prepare('SELECT * FROM executions ORDER BY rowid').all().map(row => ({ id: row.id, itemId: row.item_id, occurrenceKey: row.occurrence_key, ...parse(row.value), revision: row.revision })), results: db.prepare('SELECT * FROM results ORDER BY rowid').all().map(row => ({ id: row.id, targetId: row.target_id, ...parse(row.value), revision: row.revision })) };
  data.key_points = data.dimensions;
  data.pending_materials = data.materials;
  data.schedules = data.actions.map(action => { const item = data.items.find(value => value.id === action.itemId); return { ...(item.legacy_payload || {}), id: item.id, itemId: item.id, objective_id: data.space.objectiveId, title: item.title, date: action.schedule?.date || null, status: action.state, ...action }; });
  data.inspirations = data.items.filter(item => ['legacy-inspiration', 'inspiration'].includes(item.typeId)).map(item => ({ ...(item.legacy_payload || {}), ...item, text: item.fields.text || item.body }));
  return data;
}

const legacyFiles = ['meta.json', 'keypoints.json', 'schedules.json', 'inspirations.json', 'results.json'];
function readLegacy(context, objectiveId) {
  const directory = context.safeSpace(objectiveId);
  const files = {};
  const data = {};
  for (const name of legacyFiles) {
    const file = context.safeFile(directory, name);
    if (!fs.existsSync(file)) { data[name] = name === 'meta.json' ? null : []; continue; }
    const content = fs.readFileSync(file);
    files[name] = { sha256: hash(content), bytes: content.length };
    try { data[name] = JSON.parse(content); } catch { fault('CORRUPT_JSON', `Invalid legacy JSON: ${name}`); }
    if (name === 'meta.json') object(data[name], 'Invalid legacy space metadata');
    else if (!Array.isArray(data[name])) fault('CORRUPT_JSON', `Legacy collection must be an array: ${name}`);
  }
  if (!data['meta.json']) {
    const file = context.safeFile(path.dirname(directory), 'global_index.json');
    if (fs.existsSync(file)) {
      let index;
      try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fault('CORRUPT_INDEX', 'Invalid global space index'); }
      data['meta.json'] = index.objectives?.find(entry => entry.id === objectiveId) || null;
    }
  }
  if (!data['meta.json']) fault('NOT_FOUND', 'Legacy space metadata does not exist');
  if (data['meta.json'].id && data['meta.json'].id !== objectiveId) fault('INVALID_REFERENCE', 'Legacy metadata identifier does not match the selected space');
  const allItemIds = new Set();
  for (const name of legacyFiles.slice(1)) {
    const ids = new Set();
    for (const entry of data[name]) {
      if (!validId(entry.id) || ids.has(entry.id)) fault('INVALID_REFERENCE', `Invalid or duplicate legacy identifier: ${name}`);
      if (entry.objective_id && entry.objective_id !== objectiveId) fault('INVALID_REFERENCE', 'Legacy record references another space');
      ids.add(entry.id);
      if (['schedules.json', 'inspirations.json'].includes(name)) {
        if (allItemIds.has(entry.id)) fault('INVALID_REFERENCE', 'Legacy items have colliding identifiers');
        allItemIds.add(entry.id);
      }
    }
  }
  const dimensions = new Set(data['keypoints.json'].map(entry => entry.id));
  for (const entry of data['schedules.json']) { const mainKId = entry.keypoint_id || entry.key_point_id || entry.main_k_id; if (mainKId && !dimensions.has(mainKId)) fault('INVALID_REFERENCE', 'Legacy schedule references an unknown dimension'); }
  for (const entry of data['results.json']) { const target = entry.target_id || objectiveId; if (target !== objectiveId && !dimensions.has(target)) fault('INVALID_REFERENCE', 'Legacy result references an unknown target'); }
  return { directory, files, data, inspectionHash: hash({ files, meta: data['meta.json'] }), counts: Object.fromEntries(legacyFiles.slice(1).map(name => [name.replace('.json', ''), data[name].length])) };
}
function readLegacyMetadata(context, objectiveId) {
  const directory = context.safeSpace(objectiveId);
  const file = context.safeFile(directory, 'meta.json');
  let metadata;
  if (fs.existsSync(file)) {
    try { metadata = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fault('CORRUPT_JSON', 'Invalid legacy JSON: meta.json'); }
  } else {
    const index = context.safeFile(path.dirname(directory), 'global_index.json');
    if (fs.existsSync(index)) { try { metadata = JSON.parse(fs.readFileSync(index, 'utf8')).objectives?.find(entry => entry.id === objectiveId); } catch { fault('CORRUPT_INDEX', 'Invalid global space index'); } }
  }
  if (!metadata) fault('NOT_FOUND', 'Legacy space metadata does not exist');
  object(metadata);
  if (metadata.id && metadata.id !== objectiveId) fault('INVALID_REFERENCE', 'Legacy metadata identifier does not match the selected space');
  return metadata;
}
function backupLegacy(context, objectiveId, inspection) {
  const migrationId = `migration_${inspection.inspectionHash.slice(0, 20)}`;
  const parent = context.safeFile(inspection.directory, 'migrations');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = context.safeFile(parent, migrationId);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(inspection.files)) {
    const content = fs.readFileSync(context.safeFile(inspection.directory, name));
    if (hash(content) !== value.sha256) fault('LEGACY_CHANGED', 'Legacy data changed after inspection', 'conflict');
    const file = context.safeFile(target, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    if (hash(fs.readFileSync(file)) !== value.sha256) fault('BACKUP_MISMATCH', 'Migration backup does not match the inspected input');
  }
  const manifest = { migrationId, objectiveId, inspectionHash: inspection.inspectionHash, files: inspection.files, counts: inspection.counts };
  fs.writeFileSync(context.safeFile(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}
function initialSpace(objectiveId, input = {}) { return { objectiveId, id: objectiveId, title: input.title || input.name || objectiveId, purpose: input.purpose || input.about || input.description || '', timezone: input.timezone || 'Asia/Shanghai', lifecycle: input.lifecycle || 'formal', activeBundleId: input.activeBundleId || null, archivedAt: input.archivedAt || null, revision: 1, storageVersion: 1, legacy_payload: input.legacy_payload || null }; }
function migrate(context, objectiveId, input, binding) {
  requireHost(binding);
  const directory = context.safeSpace(objectiveId);
  const existing = context.safeFile(directory, 'space.sqlite');
  if (fs.existsSync(existing)) {
    const db = context.open(objectiveId);
    if (meta(db, 'migration')) return output('saved', { ...meta(db, 'migration'), alreadyMigrated: true, space: space(db) });
    fault('SPACE_EXISTS', 'A SQLite space already exists', 'conflict');
  }
  const inspection = readLegacy(context, objectiveId);
  if (input.confirmed !== true || input.inspectionHash !== inspection.inspectionHash) fault('MIGRATION_CONFIRMATION_REQUIRED', 'Confirm the current inspection hash before migration', 'conflict');
  const manifest = backupLegacy(context, objectiveId, inspection);
  const lock = context.safeFile(directory, '.migration.lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { fault('MIGRATION_BUSY', 'Migration lock needs manual inspection', 'conflict'); }
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) fault('MIGRATION_BUSY', 'Another migration is in progress', 'conflict');
    fs.rmSync(lock);
    try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch { fault('MIGRATION_BUSY', 'Another migration is in progress', 'conflict'); }
  }
  fs.writeFileSync(lockFd, stable({ pid: process.pid, createdAt: now(), inspectionHash: inspection.inspectionHash }));
  const staging = 'space.staging.sqlite';
  try {
    if (readLegacy(context, objectiveId).inspectionHash !== inspection.inspectionHash) fault('LEGACY_CHANGED', 'Legacy data changed before the migration lock was acquired', 'conflict');
    context.closeOne(objectiveId, staging);
    for (const suffix of ['', '-wal', '-shm']) { const file = context.safeFile(directory, staging + suffix); if (fs.existsSync(file)) fs.rmSync(file); }
    const db = context.open(objectiveId, { create: true, filename: staging });
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = inspection.data;
      const metadata = old['meta.json'];
      const archivedAt = metadata.archived_at || (metadata.status === 'archived' || metadata.archived || metadata.is_archived ? now() : null);
      setMeta(db, 'space', initialSpace(objectiveId, { ...metadata, archivedAt, activeBundleId: 'compatibility-v1', legacy_payload: metadata }));
      setTypes(db, [{ id: 'legacy-schedule', fields: [] }, { id: 'legacy-inspiration', fields: [{ id: 'text', kind: 'text', required: true }, { id: 'date', kind: 'date' }] }]);
      for (const raw of old['keypoints.json']) db.prepare('INSERT INTO dimensions VALUES(?,?)').run(raw.id, stable({ ...raw, objectiveId, revision: 1, archivedAt: raw.archived_at || (raw.status === 'archived' || raw.archived || raw.is_archived ? now() : null), legacy_payload: raw }));
      for (const [filename, typeId] of [['schedules.json', 'legacy-schedule'], ['inspirations.json', 'legacy-inspiration']]) {
        for (const raw of old[filename]) {
          const timestamp = raw.created_at || now();
          const fields = typeId === 'legacy-inspiration' ? { text: raw.text || raw.content || '', ...(validDate(raw.date) ? { date: raw.date } : {}) } : {};
          const mainKId = raw.keypoint_id || raw.key_point_id || raw.main_k_id || null;
          db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(raw.id, typeId, '1', mainKId, raw.title || raw.text || '', stable(fields), raw.content || raw.description || '', null, stable(raw), 1, timestamp, timestamp);
          db.prepare('INSERT INTO item_search VALUES(?,?,?)').run(raw.id, raw.title || raw.text || '', raw.content || raw.description || '');
          if (typeId === 'legacy-schedule') {
            const schedule = legacySchedule(raw, metadata.timezone || 'Asia/Shanghai', zonedTimestamp);
            schedule.enabled = schedule.enabled && !archivedAt;
            db.prepare('INSERT INTO actions VALUES(?,?,1)').run(raw.id, stable({ state: raw.status || 'pending', schedule, legacy_payload: raw }));
            if (raw.checkin_note || ['completed', 'skipped'].includes(raw.status)) db.prepare('INSERT INTO executions VALUES(?,?,?,?,1)').run(`LEGACY_${raw.id}`, raw.id, `legacy:${raw.id}`, stable({ state: raw.status || 'completed', note: raw.checkin_note || '', occurredAt: raw.actual_time || null, legacy: true, legacy_payload: raw }));
          }
        }
      }
      for (const raw of old['results.json']) db.prepare('INSERT INTO results VALUES(?,?,?,1)').run(raw.id, raw.target_id || objectiveId, stable({ ...raw, legacy_payload: raw }));
      const result = { ...manifest, completedAt: now(), storageVersion: 1, calendarWarnings: calendarRecords.readGoal(db).warnings };
      setMeta(db, 'migration', result);
      db.prepare('INSERT INTO migrations VALUES(?,?)').run(manifest.migrationId, stable(result));
      db.exec('COMMIT');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    context.closeOne(objectiveId, staging);
    fs.renameSync(context.safeFile(directory, staging), existing);
    const report = meta(context.open(objectiveId), 'migration');
    return output('saved', { ...report, space: space(context.open(objectiveId)), alreadyMigrated: false });
  } finally {
    context.closeOne(objectiveId, staging);
    if (lockFd != null) fs.closeSync(lockFd);
    fs.rmSync(lock, { force: true });
  }
}

function hosted(db, command, input, binding) {
  requireHost(binding);
  const runtime = command.startsWith('runtime.');
  const group = command.startsWith('group.state.');
  const namespace = runtime ? 'runtime' : group ? 'group' : input.namespace || 'default';
  const scope = runtime ? binding.sourceScope || 'bot' : 'host';
  const key = input.key;
  const read = currentKey => { const row = db.prepare('SELECT value,revision FROM hosted_state WHERE namespace=? AND key=? AND scope=?').get(namespace, currentKey, scope); return row ? { key: currentKey, namespace, value: parse(row.value), revision: row.revision } : { key: currentKey, namespace, value: null, revision: 0 }; };
  if (command.endsWith('.list')) return output('read', { states: db.prepare('SELECT key,value,revision FROM hosted_state WHERE namespace=? AND scope=? ORDER BY key').all(namespace, scope).map(row => ({ key: row.key, namespace, value: parse(row.value), revision: row.revision })) });
  if (command.endsWith('.load') || command.endsWith('.get')) return output('read', read(key));
  if (command === 'host.state.commit' || command === 'group.state.commit') {
    if (group && (input.types || input.activeBundleId || input.lifecycle)) fault('FORBIDDEN', 'Group state cannot activate a space scheme');
    if (!group) requireActive(db);
    const current = group ? null : space(db);
    if (!group && input.expectedBundleId !== undefined && current.activeBundleId !== input.expectedBundleId) fault('BUNDLE_CONFLICT', 'The active version changed', 'conflict');
    for (const update of input.updates || []) {
      const row = db.prepare("SELECT revision FROM hosted_state WHERE namespace=? AND key=? AND scope='host'").get(group ? 'group' : update.namespace || 'default', update.key);
      requireRevision(row?.revision || 0, update.expectedRevision);
    }
    if (input.types) setTypes(db, input.types);
    if (!group && (input.activeBundleId !== undefined || input.lifecycle)) setMeta(db, 'space', { ...current, activeBundleId: input.activeBundleId ?? current.activeBundleId, lifecycle: input.lifecycle || current.lifecycle, revision: current.revision + 1 });
    const states = [];
    for (const update of input.updates || []) {
      const revision = update.expectedRevision + 1;
      db.prepare("INSERT INTO hosted_state VALUES(?,?,'host',?,?) ON CONFLICT(namespace,key,scope) DO UPDATE SET value=excluded.value,revision=excluded.revision").run(group ? 'group' : update.namespace || 'default', update.key, stable(update.value), revision);
      states.push({ key: update.key, namespace: group ? 'group' : update.namespace || 'default', revision });
    }
    return output('saved', { states, ...(group ? {} : { space: space(db) }) });
  }
  if (command.endsWith('.set') || command.endsWith('.store')) {
    const current = read(key);
    requireRevision(current.revision, input.expectedRevision);
    const revision = current.revision + 1;
    db.prepare('INSERT INTO hosted_state VALUES(?,?,?,?,?) ON CONFLICT(namespace,key,scope) DO UPDATE SET value=excluded.value,revision=excluded.revision').run(namespace, key, scope, stable(input.value), revision);
    return output('saved', { key, namespace, ...(runtime || group || input.returnValue === false ? {} : { value: input.value }), revision });
  }
  fault('UNKNOWN_COMMAND', 'Unknown hosted state operation');
}

const calendarRecords = createCalendarRecords({
  space, meta, setMeta, dimension, validDate, validId, requireRevision, requireActive, queryCalendar, zonedTimestamp,
  saveItem, saveExecution, setTypes, typeRows, getItem, stable
});
const calendarFiles = createCalendarFiles(calendarRecords, {
  runDomainCommand, validId, validDate, initialSpace, setMeta, space, stable, hash, meta, output, createStorageContext, projectCalendar, zonedTimestamp
});
const calendarReads = new Set(['calendar.space', 'calendar.range', 'calendar.event.get', 'calendar.export', 'calendar.catalog', 'calendar.busy']);
const calendarRelatedWrites = new Set(['action.save', 'execution.save', 'legacy.checkin', 'result.save', 'item.update',
  'dimension.save', 'dimension.archive', 'dimension.restore', 'space.archive', 'space.restore']);
const calendarMutations = new Set(['calendar.event.save', 'calendar.execution.save', 'calendar.ledger.save', 'calendar.k.save',
  'calendar.feedback.save', 'calendar.achievement.save', 'calendar.layout.save', 'calendar.confirm', 'calendar.delete']);

function runDatabaseCommand(db, command, input, binding, operationId) {
  if (command.startsWith('runtime.') || command.startsWith('host.state.') || command.startsWith('group.state.')) return hosted(db, command, input, binding);
  if (command === 'space.create') {
    requireHost(binding);
    if (meta(db, 'space')) fault('SPACE_EXISTS', 'Space already exists', 'conflict');
    const value = initialSpace(binding.objectiveId, input);
    if (!['formal', 'draft'].includes(value.lifecycle)) fault('INVALID_INPUT', 'Invalid space lifecycle');
    setMeta(db, 'space', value);
    setTypes(db, input.types || []);
    for (const raw of input.dimensions || []) { if (!validId(raw.id)) fault('INVALID_INPUT', 'Invalid dimension identifier'); db.prepare('INSERT INTO dimensions VALUES(?,?)').run(raw.id, stable({ ...raw, objectiveId: binding.objectiveId, revision: 1 })); }
    return output('saved', { space: value });
  }
  const currentSpace = space(db);
  checkBundle(db, binding);
  if (calendarReads.has(command) || calendarMutations.has(command)) {
    return output(calendarReads.has(command) ? 'read' : 'saved', calendarRecords.run(db, command, input, binding, operationId));
  }
  if (command === 'space.read') return output('read', snapshot(db));
  if (command === 'operation.get') { const row = db.prepare('SELECT receipt_json FROM operations WHERE operation_id=? OR request_id=?').get(input.operationId || '', input.requestId || ''); return row ? parse(row.receipt_json) : output('failed', null, null, { code: 'NOT_FOUND', message: 'Operation does not exist in this space' }); }
  if (command === 'types.set') { requireHost(binding); requireActive(db); setTypes(db, input.types); return output('saved', { types: typeRows(db) }); }
  if (command === 'dimension.save') {
    requireActive(db);
    const previous = input.id && dimension(db, input.id);
    if (previous) requireActive(db, previous.id);
    if (previous) requireRevision(previous.revision, input.expectedRevision);
    const value = { ...previous, ...input, id: input.id || id('K'), objectiveId: binding.objectiveId, revision: (previous?.revision || 0) + 1 };
    if (!validId(value.id)) fault('INVALID_INPUT', 'Invalid dimension identifier');
    db.prepare('INSERT INTO dimensions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, stable(value));
    return output('saved', { dimension: value });
  }
  if (['space.archive', 'space.restore', 'dimension.archive', 'dimension.restore'].includes(command)) {
    const restoring = command.endsWith('restore');
    if (command.startsWith('dimension.')) {
      const previous = dimension(db, input.id);
      if (!previous) fault('NOT_FOUND', 'Dimension does not exist');
      if (currentSpace.archivedAt) fault('ARCHIVED', 'Restore the space before changing its dimensions');
      if (input.expectedRevision != null) requireRevision(previous.revision, input.expectedRevision);
      const value = { ...previous, archivedAt: restoring ? null : now(), revision: (previous.revision || 1) + 1 };
      db.prepare('UPDATE dimensions SET value=? WHERE id=?').run(stable(value), input.id);
      for (const row of db.prepare('SELECT a.* FROM actions a JOIN items i ON i.id=a.item_id WHERE i.main_k_id=?').all(input.id)) db.prepare('UPDATE actions SET value=?,revision=revision+1 WHERE item_id=?').run(stable({ ...parse(row.value), schedule: { ...parse(row.value).schedule, enabled: false } }), row.item_id);
      return output('saved', { dimension: value });
    }
    if (input.expectedRevision != null) requireRevision(currentSpace.revision, input.expectedRevision);
    const value = { ...currentSpace, archivedAt: restoring ? null : now(), revision: currentSpace.revision + 1 };
    setMeta(db, 'space', value);
    for (const row of db.prepare('SELECT * FROM actions').all()) { const action = parse(row.value); db.prepare('UPDATE actions SET value=?,revision=revision+1 WHERE item_id=?').run(stable({ ...action, schedule: { ...action.schedule, enabled: false } }), row.item_id); }
    return output('saved', { space: value });
  }
  if (command === 'item.save' && binding.executionScope !== 'trial') {
    if (currentSpace.lifecycle !== 'formal') fault('DRAFT_SPACE', 'Draft spaces only accept trial records');
    return saveItem(db, input, binding, operationId);
  }
  if (command === 'item.update') {
    const previous = getItem(db, input.itemId || input.id);
    requireActive(db, previous.mainKId);
    requireRevision(previous.revision, input.expectedRevision);
    return saveItem(db, { ...previous, ...input, typeId: previous.typeId, fields: { ...previous.fields, ...(input.fields || {}) } }, binding, operationId, { existing: previous });
  }
  if (command === 'items.batch') {
    requireHost(binding);
    if (!input.planHash || binding.confirmationPlanHash !== input.planHash) fault('CONFIRMATION_REQUIRED', 'The Host must bind the approved batch plan');
    if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 500) fault('INVALID_INPUT', 'A batch requires between 1 and 500 changes');
    if (new Set(input.changes.map(change => change.itemId)).size !== input.changes.length) fault('INVALID_INPUT', 'Each item can occur only once in a batch');
    const changes = input.changes.map(change => { const previous = getItem(db, change.itemId); requireActive(db, previous.mainKId); requireRevision(previous.revision, change.expectedRevision); return { previous, change }; });
    const results = [];
    for (const { previous, change } of changes) {
      const result = saveItem(db, { ...previous, ...change, typeId: previous.typeId, fields: { ...previous.fields, ...(change.fields || {}) } }, binding, operationId, { existing: previous });
      if (result.kind !== 'saved') fault('INVALID_BATCH', 'Every change must produce a complete valid item');
      results.push(result.data);
    }
    return output('saved', { changes: results, planHash: input.planHash });
  }
  if (command === 'material.complete') {
    const row = db.prepare('SELECT * FROM pending_materials WHERE id=?').get(input.materialId);
    if (!row) fault('NOT_FOUND', 'Pending material does not exist');
    if (row.status === 'completed') return output('saved', { materialId: row.id, itemId: row.item_id, item: getItem(db, row.item_id), alreadyCompleted: true });
    if (input.expectedRevision != null) requireRevision(row.revision, input.expectedRevision);
    const previous = parse(row.value);
    if (previous.sourceScope && binding.sourceScope && stable(previous.sourceScope) !== stable(binding.sourceScope) && !binding.allowedMaterialIds?.includes(row.id)) fault('FORBIDDEN', 'Pending material belongs to another source scope');
    return saveItem(db, { ...previous, ...input, typeId: previous.typeId, fields: { ...previous.fields, ...(input.fields || {}) } }, binding, operationId, { materialId: row.id });
  }
  if (command === 'categories.save') {
    requireActive(db);
    const tableId = input.tableId || input.table_id || 'default';
    const values = input.categories || (input.id ? [input] : []);
    if (!Array.isArray(values)) fault('INVALID_INPUT', 'Categories must be an array');
    const ids = new Set(values.map(value => value.id));
    if (ids.size !== values.length) fault('INVALID_INPUT', 'Category identifiers must be unique');
    const hierarchy = new Map(db.prepare('SELECT id,value FROM categories WHERE table_id=? AND active=1').all(tableId).map(row => [row.id, parse(row.value).parentId || null]));
    for (const raw of values) hierarchy.set(raw.id, raw.parentId || null);
    for (const start of hierarchy.keys()) {
      const visited = new Set(); let current = start;
      while (current) { if (visited.has(current)) fault('INVALID_REFERENCE', 'Category hierarchy cannot contain cycles'); visited.add(current); current = hierarchy.get(current); }
    }
    for (const raw of values) {
      if (!validId(raw.id) || !validId(tableId)) fault('INVALID_INPUT', 'Invalid category identifier');
      if (raw.parentId && !ids.has(raw.parentId) && !db.prepare('SELECT id FROM categories WHERE table_id=? AND id=? AND active=1').get(tableId, raw.parentId)) fault('INVALID_REFERENCE', 'Category parent must belong to its table');
      const previous = db.prepare('SELECT version FROM categories WHERE table_id=? AND id=? ORDER BY version DESC LIMIT 1').get(tableId, raw.id);
      if (raw.expectedRevision != null) requireRevision(previous?.version || 0, raw.expectedRevision);
      const version = (previous?.version || 0) + 1;
      db.prepare('UPDATE categories SET active=0 WHERE table_id=? AND id=?').run(tableId, raw.id);
      db.prepare('INSERT INTO categories VALUES(?,?,?,?,?)').run(tableId, raw.id, version, stable({ ...raw, tableId, version }), raw.active === false ? 0 : 1);
    }
    return output('saved', { categories: db.prepare('SELECT value FROM categories WHERE table_id=? AND active=1').all(tableId).map(row => parse(row.value)) });
  }
  if (command === 'items.query') return queryItems(db, input);
  if (command === 'calendar.query') return queryCalendar(db, input);
  if (command === 'action.save') {
    const item = getItem(db, input.itemId);
    requireActive(db, item.mainKId);
    const old = db.prepare('SELECT * FROM actions WHERE item_id=?').get(item.id);
    if (old) requireRevision(old.revision, input.expectedRevision);
    const schedule = input.schedule ?? parse(old?.value)?.schedule ?? null;
    if (schedule) {
      object(schedule);
      const timezone = schedule.timezone || currentSpace.timezone;
      try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(); } catch { fault('INVALID_INPUT', 'Invalid schedule timezone'); }
      if (Object.hasOwn(schedule, 'recurrence') && schedule.recurrence != null && !recurrenceRule(schedule.recurrence)) fault('UNSUPPORTED_RECURRENCE', 'Recurrence must be daily, weekly or monthly');
      if (schedule.date != null && !validDate(schedule.date)) fault('INVALID_INPUT', 'Invalid scheduled date');
      if (schedule.start && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(schedule.start) || Number.isNaN(Date.parse(schedule.start)))) fault('INVALID_INPUT', 'Schedule timestamps require a timezone');
      if (schedule.end && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(schedule.end) || !schedule.start || Number.isNaN(Date.parse(schedule.end)) || Date.parse(schedule.end) <= Date.parse(schedule.start))) fault('INVALID_INPUT', 'Schedule end must follow its start and include a timezone');
      if (schedule.start && schedule.end && schedule.enabled !== false) {
        for (const row of db.prepare('SELECT item_id,value FROM actions WHERE item_id<>?').all(item.id)) {
          const other = parse(row.value).schedule;
          if (other?.enabled !== false && other?.start && other?.end && Date.parse(schedule.start) < Date.parse(other.end) && Date.parse(schedule.end) > Date.parse(other.start)) fault('SCHEDULE_CONFLICT', 'The requested time overlaps an existing action', 'conflict');
        }
      }
    }
    const value = { ...parse(old?.value), state: input.state || parse(old?.value)?.state || 'pending', schedule: schedule ? { ...schedule, timezone: schedule.timezone || currentSpace.timezone, enabled: schedule.enabled !== false } : null };
    const revision = (old?.revision || 0) + 1;
    db.prepare('INSERT INTO actions VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET value=excluded.value,revision=excluded.revision').run(item.id, stable(value), revision);
    return output('saved', { itemId: item.id, action: value, revision });
  }
  if (command === 'execution.save') return saveExecution(db, input);
  if (command === 'result.save') {
    const targetId = input.targetId || currentSpace.objectiveId;
    if (targetId !== currentSpace.objectiveId && !dimension(db, targetId)) fault('INVALID_REFERENCE', 'Result target must belong to this space');
    for (const evidenceId of input.evidence || []) {
      if (!db.prepare('SELECT id FROM items WHERE id=?').get(evidenceId) && !db.prepare('SELECT id FROM executions WHERE id=?').get(evidenceId)) fault('INVALID_REFERENCE', 'Result evidence must be an item or execution in this space');
    }
    const pairedId = dimension(db, targetId)?.feedbackId;
    if (pairedId && input.id && input.id !== pairedId) fault('INVALID_REFERENCE', '此 K 已有唯一的阶段反馈');
    const resultId = pairedId || input.id || id('R');
    const previous = db.prepare('SELECT revision,target_id FROM results WHERE id=?').get(resultId);
    if (previous && previous.target_id !== targetId) fault('INVALID_REFERENCE', '不能改变既有反馈的所属对象');
    if (previous) requireRevision(previous.revision, input.expectedRevision);
    const value = { title: input.title || '', body: input.body || '', evidence: input.evidence || [], updatedAt: now() };
    const revision = (previous?.revision || 0) + 1;
    db.prepare('INSERT INTO results VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET target_id=excluded.target_id,value=excluded.value,revision=excluded.revision').run(resultId, targetId, stable(value), revision);
    return output('saved', { resultId, result: { id: resultId, targetId, ...value, revision }, revision });
  }
  if (command === 'trial.save' || (command === 'item.save' && binding.executionScope === 'trial')) {
    requireHost(binding);
    if (binding.executionScope !== 'trial' || !['real', 'demo'].includes(binding.provenance)) fault('FORBIDDEN', 'Trial scope and provenance must be supplied by the Host');
    const type = (binding.types || []).find(value => value.id === (input.typeId || input.type_id));
    if (!type) return output('unsupported', { reason: 'No matching draft type' });
    const checked = validateFields(db, { ...type, fields: type.fields || [] }, input.fields || {}, input.mainKId);
    const trialId = id('TRIAL');
    const value = { typeId: type.id, title: input.title || '', fields: checked.fields, body: input.body || '', mainKId: input.mainKId || null, source: binding.source || null, missing: checked.missing };
    db.prepare('INSERT INTO trial_records VALUES(?,?,?,?,NULL,1)').run(trialId, input.draftId || binding.draftId, binding.provenance, stable(value));
    return output('trial', { trialId, trialRecordId: trialId, provenance: binding.provenance, ...value });
  }
  if (command === 'trial.list') return output('read', { trials: input.draftId ? db.prepare('SELECT * FROM trial_records WHERE draft_id=? ORDER BY rowid').all(input.draftId).map(row => ({ id: row.id, trialId: row.id, provenance: row.provenance, ...parse(row.value), itemId: row.item_id, revision: row.revision })) : [] });
  if (command === 'trial.promote') {
    requireHost(binding);
    const trial = db.prepare('SELECT * FROM trial_records WHERE id=?').get(input.trialId);
    if (!trial) fault('NOT_FOUND', 'Trial record does not exist');
    if (trial.provenance !== 'real') fault('DEMO_NOT_TRANSFERABLE', 'Demo records cannot become formal items');
    if (trial.item_id) return output('saved', { itemId: trial.item_id, alreadyPromoted: true });
    if (currentSpace.lifecycle !== 'formal') fault('DRAFT_SPACE', 'Activate the confirmed scheme before transferring records');
    const materialId = `MAT_${trial.id}`;
    const existingMaterial = db.prepare('SELECT id FROM pending_materials WHERE id=?').get(materialId);
    const result = saveItem(db, parse(trial.value), binding, operationId, { ...(existingMaterial ? { materialId } : {}) });
    if (result.kind === 'saved') db.prepare('UPDATE trial_records SET item_id=?,revision=revision+1 WHERE id=?').run(result.data.itemId, trial.id);
    return result;
  }
  if (command === 'trial.finalize') {
    requireHost(binding);
    if (currentSpace.lifecycle !== 'formal') fault('DRAFT_SPACE', 'Activate the confirmed scheme before finalizing trial records');
    const selected = new Set(input.selectedTrialIds || []);
    const materials = [];
    for (const trial of db.prepare("SELECT * FROM trial_records WHERE draft_id=? AND provenance='real' AND item_id IS NULL").all(input.draftId)) {
      const materialId = `MAT_${trial.id}`;
      const candidate = parse(trial.value);
      const value = { ...candidate, reason: selected.has(trial.id) ? 'transfer_incomplete' : 'trial_not_selected', trialId: trial.id, draftId: trial.draft_id, sourceScope: binding.sourceScope || null };
      const existing = db.prepare('SELECT id FROM pending_materials WHERE id=?').get(materialId);
      if (!existing) db.prepare("INSERT INTO pending_materials VALUES(?,?,?,'pending',NULL,1)").run(materialId, candidate.typeId, stable(value));
      materials.push({ materialId, trialId: trial.id });
    }
    return output('saved', { materials });
  }
  if (command === 'legacy.query') {
    const data = snapshot(db);
    let schedules = data.actions.map(action => { const item = data.items.find(entry => entry.id === action.itemId); return { ...(item.legacy_payload || {}), id: item.id, title: item.title, objective_id: currentSpace.objectiveId, date: action.schedule?.date, status: action.state, execution_records: data.executions.filter(entry => entry.itemId === item.id) }; });
    if (!input.all_dates) {
      const date = input.date || new Intl.DateTimeFormat('en-CA', { timeZone: currentSpace.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      schedules = schedules.filter(entry => entry.date === date);
    }
    return output('read', { objectives: [{ ...(currentSpace.legacy_payload || {}), ...currentSpace }], key_points: data.dimensions, schedules });
  }
  if (command === 'legacy.checkin') return saveExecution(db, { itemId: input.schedule_id, occurrenceKey: input.occurrence_key || input.date, state: input.status || 'completed', note: input.note || '' });
  if (command === 'legacy.capture') return saveItem(db, { typeId: typeFor(db, 'legacy-inspiration') ? 'legacy-inspiration' : 'inspiration', title: input.inspiration, fields: { text: input.inspiration, date: new Intl.DateTimeFormat('en-CA', { timeZone: currentSpace.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) } }, binding, operationId);
  fault('UNKNOWN_COMMAND', 'Unknown domain operation');
}

function saveExecution(db, input) {
  const item = getItem(db, input.itemId);
  requireActive(db, item.mainKId);
  const row = db.prepare('SELECT value FROM actions WHERE item_id=?').get(item.id);
  if (!row) fault('NOT_ACTION', 'The item has no action capability');
  const action = parse(row.value);
  let occurrenceKey = input.occurrenceKey;
  if (!occurrenceKey) {
    if (action.schedule?.recurrence || action.schedule?.recurring) return output('pending', { reason: 'Choose the specific recurring occurrence', missing: ['occurrenceKey'], itemId: item.id });
    occurrenceKey = 'single';
  }
  if (typeof occurrenceKey !== 'string' || occurrenceKey.length > 200) fault('INVALID_INPUT', 'Invalid occurrence key');
  if (!['completed', 'in_progress', 'skipped'].includes(input.state || 'completed')) fault('INVALID_INPUT', 'Invalid execution state');
  const previous = db.prepare('SELECT * FROM executions WHERE item_id=? AND occurrence_key=?').get(item.id, occurrenceKey);
  if (previous) {
    if (input.expectedRevision == null) return output('saved', { executionId: previous.id, itemId: item.id, occurrenceKey, ...parse(previous.value), revision: previous.revision, alreadyRecorded: true });
    requireRevision(previous.revision, input.expectedRevision);
  }
  const executionId = previous?.id || id('EXEC');
  const value = { ...parse(previous?.value), state: input.state || 'completed', note: input.note || '', occurredAt: input.occurredAt || null };
  const revision = (previous?.revision || 0) + 1;
  db.prepare('INSERT INTO executions VALUES(?,?,?,?,?) ON CONFLICT(item_id,occurrence_key) DO UPDATE SET value=excluded.value,revision=excluded.revision').run(executionId, item.id, occurrenceKey, stable(value), revision);
  if (!action.schedule?.recurrence && !action.schedule?.recurring) db.prepare('UPDATE actions SET value=?,revision=revision+1 WHERE item_id=?').run(stable({ ...action, state: value.state }), item.id);
  return output('saved', { executionId, itemId: item.id, occurrenceKey, ...value, revision });
}

function queryItems(db, input) {
  let values = db.prepare('SELECT * FROM items ORDER BY created_at,id').all().map(row => detailedItem(db, row));
  if (input.typeId) values = values.filter(item => item.typeId === input.typeId);
  if (input.mainKId) values = values.filter(item => item.mainKId === input.mainKId);
  if (input.search) { const needle = String(input.search).toLocaleLowerCase(); values = values.filter(item => `${item.title}\n${item.body}`.toLocaleLowerCase().includes(needle)); }
  for (const [fieldId, expected] of Object.entries(input.filters || {})) values = values.filter(item => stable(item.fields[fieldId]) === stable(expected));
  let excludedCount = 0;
  const dateField = input.dateField;
  const timezone = input.timezone || space(db).timezone;
  let calendar;
  try { calendar = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { fault('INVALID_INPUT', 'Invalid statistics timezone'); }
  const businessDate = value => validDate(value) ? value : typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? calendar.format(new Date(value)) : null;
  if (input.from && !validDate(input.from) || input.to && !validDate(input.to)) fault('INVALID_INPUT', 'Date ranges require calendar dates');
  if (dateField) {
    values = values.filter(item => {
      const date = businessDate(item.fields[dateField]);
      if (!date) { excludedCount++; return false; }
      if (input.from && date < input.from) return false;
      if (input.to && date > input.to) return false;
      return true;
    });
  } else if (input.from || input.to || input.granularity) fault('DATE_FIELD_REQUIRED', 'Choose a business date field for date filtering and grouping');
  const total = values.length;
  let aggregate = null;
  if (input.aggregate) {
    const fieldId = input.aggregate.field;
    const operation = input.aggregate.operation || 'sum';
    if (!['sum', 'count'].includes(operation)) fault('INVALID_INPUT', 'Unsupported aggregate');
    const groups = new Map();
    const definitions = values.map(item => typeFor(db, item.typeId, item.typeVersion)?.fields.find(field => field.id === fieldId)).filter(Boolean);
    const units = new Set(definitions.map(field => field.unit || ''));
    if (units.size > 1) fault('INCOMPATIBLE_UNIT', 'Values with different units cannot be aggregated');
    const precision = Math.max(0, ...definitions.map(field => field.kind === 'decimal' ? field.precision ?? 2 : 0));
    for (const item of values) {
      const definition = typeFor(db, item.typeId, item.typeVersion)?.fields.find(field => field.id === fieldId);
      let group = input.groupBy ? item.fields[input.groupBy] ?? '(missing)' : 'all';
      if (input.granularity) {
        const date = businessDate(item.fields[dateField]);
        if (input.granularity === 'day') group = date.slice(0, 10);
        else if (input.granularity === 'month') group = date.slice(0, 7);
        else if (input.granularity === 'year') group = date.slice(0, 4);
        else if (input.granularity === 'quarter') group = `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
        else if (input.granularity === 'week') { const day = new Date(`${date.slice(0, 10)}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); group = day.toISOString().slice(0, 10); }
        else fault('INVALID_INPUT', 'Unsupported grouping granularity');
      }
      if (operation === 'count') groups.set(String(group), (groups.get(String(group)) || 0n) + 1n);
      else {
        if (!definition || !['decimal', 'integer'].includes(definition.kind)) fault('INVALID_FIELD', 'Sum requires a declared numeric field');
        const value = item.fields[fieldId];
        if (value == null) { excludedCount++; continue; }
        groups.set(String(group), (groups.get(String(group)) || 0n) + decimalInteger(value, precision));
      }
    }
    aggregate = { operation, field: fieldId || null, unit: [...units][0] || null, groups: [...groups].map(([group, value]) => ({ group, value: decimalString(value, operation === 'count' ? 0 : precision) })) };
  }
  const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const limit = Math.min(500, Number.isSafeInteger(input.limit) && input.limit > 0 ? input.limit : 50);
  return output('read', { items: values.slice(offset, offset + limit), total, excludedCount, aggregate, offset, limit, hasMore: offset + limit < total, scope: { typeId: input.typeId || null, dateField: dateField || null, from: input.from || null, to: input.to || null, granularity: input.granularity || null, timezone, nulls: 'excluded and counted' } });
}

function recurrenceRule(value) {
  if (value == null || value === '') return null;
  const rule = typeof value === 'string' ? { freq: value } : value;
  if (!rule || !['daily', 'weekly', 'monthly'].includes(rule.freq)) return null;
  const interval = rule.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365 || (rule.until != null && !validDate(rule.until)) || (rule.count != null && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 10000))) return null;
  return { freq: rule.freq, interval, until: rule.until || null, count: rule.count || null };
}
function zonedParts(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { ...values, millisecond: new Date(timestamp).getUTCMilliseconds(), date: `${values.year}-${String(values.month).padStart(2, '0')}-${String(values.day).padStart(2, '0')}` };
}
function zonedTimestamp(date, clock, timezone) {
  const [year, month, day] = date.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, clock.hour, clock.minute, clock.second, clock.millisecond || 0);
  let timestamp = desired;
  for (let attempt = 0; attempt < 4; attempt++) {
    const visible = zonedParts(timestamp, timezone);
    const projected = Date.UTC(visible.year, visible.month - 1, visible.day, visible.hour, visible.minute, visible.second, visible.millisecond);
    const correction = desired - projected;
    if (!correction) return new Date(timestamp).toISOString();
    timestamp += correction;
  }
  return null; // A skipped local clock time at a DST transition is not invented.
}
function queryCalendar(db, input) {
  const state = space(db);
  const rows = db.prepare('SELECT a.item_id,a.value,i.title,i.main_k_id FROM actions a JOIN items i ON i.id=a.item_id ORDER BY a.item_id').all()
    .filter(row => !state.archivedAt && !dimension(db, row.main_k_id)?.archivedAt)
    .map(row => ({ id:row.item_id, title:row.title, schedule:parse(row.value).schedule }));
  return projectCalendar(state, rows, input);
}

function projectCalendar(state, rows, input) {
  if (!validDate(input.from) || !validDate(input.to)) fault('INVALID_INPUT', 'Calendar queries require from and to calendar dates');
  const firstDay = Date.parse(`${input.from}T00:00:00Z`), lastDay = Date.parse(`${input.to}T00:00:00Z`);
  const dayCount = Math.round((lastDay - firstDay) / 86400000) + 1;
  if (dayCount < 1 || dayCount > 366) fault('INVALID_INPUT', 'Calendar queries support at most 366 days');
  const occurrences = [], unsupported = [];
  for (const row of rows) {
    const schedule = row.schedule;
    if (!schedule || schedule.enabled === false) continue;
    const timezone = schedule.timezone || state.timezone;
    let startClock, endClock, anchorDate;
    try {
      startClock = schedule.start ? zonedParts(schedule.start, timezone) : null;
      endClock = schedule.end ? zonedParts(schedule.end, timezone) : null;
      anchorDate = startClock?.date || schedule.date;
    } catch { unsupported.push({ itemId: row.id, reason: 'invalid_legacy_time' }); continue; }
    if (!validDate(anchorDate)) { unsupported.push({ itemId: row.id, reason: 'missing_calendar_date' }); continue; }
    const recurrence = schedule.recurrence || (schedule.recurring ? '__unknown_legacy_recurrence' : null);
    const rule = recurrenceRule(recurrence);
    if (recurrence && !rule) { unsupported.push({ itemId: row.id, reason: 'unsupported_recurrence', recurrence }); continue; }
    const anchorDay = Date.parse(`${anchorDate}T00:00:00Z`);
    const [anchorYear, anchorMonth, anchorMonthDay] = anchorDate.split('-').map(Number);
    const endDayOffset = startClock && endClock ? Math.round((Date.parse(`${endClock.date}T00:00:00Z`) - anchorDay) / 86400000) : 0;
    for (let timestamp = firstDay; timestamp <= lastDay; timestamp += 86400000) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      if (timestamp < anchorDay || rule?.until && date > rule.until) continue;
      const difference = Math.round((timestamp - anchorDay) / 86400000);
      let index = 0;
      if (!rule) { if (date !== anchorDate) continue; }
      else if (rule.freq === 'daily') { if (difference % rule.interval) continue; index = difference / rule.interval; }
      else if (rule.freq === 'weekly') { if (difference % (7 * rule.interval)) continue; index = difference / (7 * rule.interval); }
      else {
        const [year, month, day] = date.split('-').map(Number);
        const months = (year - anchorYear) * 12 + month - anchorMonth;
        if (day !== anchorMonthDay || months % rule.interval) continue;
        index = 0;
        if (rule.count) for (let step = 0; step < months; step += rule.interval) { const candidate = new Date(Date.UTC(anchorYear, anchorMonth - 1 + step, anchorMonthDay)); if (candidate.getUTCDate() === anchorMonthDay) index++; }
      }
      if (rule?.count && index >= rule.count) continue;
      const start = startClock ? zonedTimestamp(date, startClock, timezone) : null;
      const endDate = endClock ? new Date(timestamp + endDayOffset * 86400000).toISOString().slice(0, 10) : null;
      const end = endClock ? zonedTimestamp(endDate, endClock, timezone) : null;
      if (startClock && !start || endClock && !end) { unsupported.push({ itemId: row.id, date, reason: 'nonexistent_local_time' }); continue; }
      occurrences.push({ id: `${row.id}:${date}`, itemId: row.id, objectiveId: state.id, occurrenceKey: rule ? date : 'single', date, title: row.title, start, end, timezone, recurring: !!rule, kind: end ? 'time_block' : start ? 'reminder' : 'date', projection: true });
    }
  }
  occurrences.sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || '') || a.itemId.localeCompare(b.itemId));
  const limit = Math.min(2000, Number.isSafeInteger(input.limit) && input.limit > 0 ? input.limit : 500);
  const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  return output('read', { occurrences: occurrences.slice(offset, offset + limit), total: occurrences.length, offset, limit, hasMore: offset + limit < occurrences.length, unsupported, scope: { from: input.from, to: input.to, maxDays: 366, monthlyPolicy: 'same calendar day; months without that day are skipped', factsCreated: false } });
}

export function runDomainCommand(context, command, input = {}, binding = {}) {
  let db;
  let transaction = false, lifecycleLock;
  const operationId = id('OP');
  try {
    object(input); object(binding);
    if (binding.executionScope === 'trial' && !['item.save', 'trial.save', 'trial.list', 'items.query', 'calendar.query', 'space.read', 'legacy.query'].includes(command)) fault('TRIAL_WRITE_FORBIDDEN', 'Trial execution cannot modify formal facts or configuration');
    if (calendarReads.has(command) || calendarMutations.has(command)) {
      requireHost(binding);
      if (calendarMutations.has(command) && (!binding.userInitiated || binding.taskId || binding.executionScope)) fault('FORBIDDEN', '此操作需要用户在工作台确认');
      if (!binding.objectiveId && !binding.global) fault('FORBIDDEN', '缺少工作台授权');
      if (binding.objectiveId && (!validId(binding.objectiveId) || input.objectiveId && input.objectiveId !== binding.objectiveId)) fault('FORBIDDEN', '空间授权不符');
      if (command === 'calendar.catalog') {
        if (binding.objectiveId || !binding.global) fault('FORBIDDEN', '目标列表仅供全局工作台读取');
        return output('read', calendarFiles.catalog(context), operationId);
      }
      if (command === 'calendar.busy' || command === 'calendar.range' && !binding.objectiveId) return output('read', calendarFiles.globalRange(context, input, binding, command === 'calendar.busy'), operationId);
      if (command === 'calendar.confirm' && !binding.objectiveId) return calendarFiles.create(context, input, binding, operationId);
      if (command === 'calendar.delete') return calendarFiles.remove(context, input, binding, operationId);
    }
    if (command === 'spaces.list') {
      requireHost(binding);
      if (binding.global !== true) fault('FORBIDDEN', 'A global Host binding is required');
      if (!fs.existsSync(context.root)) return output('read', { spaces: [], errors: [] });
      const spaces = []; const errors = [];
      for (const entry of fs.readdirSync(context.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validId(entry.name)) continue;
        try {
          const directory = context.safeSpace(entry.name);
          if (fs.existsSync(context.safeFile(directory, 'space.sqlite'))) spaces.push({ ...space(context.open(entry.name)), migrated: true });
          else { const metadata = readLegacyMetadata(context, entry.name); spaces.push({ ...initialSpace(entry.name, { ...metadata, archivedAt: metadata.archived_at || (metadata.is_archived || metadata.archived || metadata.status === 'archived' ? 'legacy' : null) }), migrated: false }); }
        } catch (error) { errors.push({ objectiveId: entry.name, code: error.code || 'STORAGE_ERROR', message: error.public ? error.message : 'Unable to read space' }); }
      }
      return output('read', { spaces, errors });
    }
    const objectiveId = binding.objectiveId;
    const groupCommand = command.startsWith('group.state.');
    if (!groupCommand && !validId(objectiveId)) fault('FORBIDDEN', 'The Host must bind a valid objectiveId');
    if (!groupCommand) for (const field of ['objectiveId', 'objective_id']) if (input[field] != null && input[field] !== objectiveId) fault('FORBIDDEN', 'Input cannot override the bound space');
    if (command === 'space.inspect' || command === 'space.backup') {
      requireHost(binding);
      const inspection = readLegacy(context, objectiveId);
      if (command === 'space.backup') return output('saved', backupLegacy(context, objectiveId, inspection), operationId);
      return output('read', { objectiveId, files: inspection.files, counts: inspection.counts, inspectionHash: inspection.inspectionHash, valid: true });
    }
    if (command === 'space.migrate') return { ...migrate(context, objectiveId, input, binding), operationId };
    const readOnly = calendarReads.has(command) || ['space.read', 'items.query', 'calendar.query', 'operation.get', 'trial.list', 'legacy.query', 'runtime.load', 'runtime.list', 'host.state.get', 'host.state.list', 'group.state.get', 'group.state.list'].includes(command);
    if (!groupCommand && (!readOnly || command === 'calendar.export')) lifecycleLock = calendarFiles.lockSpace(context, objectiveId, calendarMutations.has(command));
    if (groupCommand) { requireHost(binding); db = context.openGroup(binding.groupId); }
    else {
      if (command === 'space.create') {
        requireHost(binding);
        const directory = context.safeSpace(objectiveId, true);
        if (!fs.existsSync(context.safeFile(directory, 'space.sqlite')) && legacyFiles.some(name => fs.existsSync(context.safeFile(directory, name)))) fault('MIGRATION_REQUIRED', 'Existing JSON data must be migrated explicitly');
      }
      db = context.open(objectiveId, { create: command === 'space.create' });
    }
    if (command === 'calendar.export') {
      checkContextFence(db, binding); checkBundle(db, binding);
      return output('read', exportCalendarDocument(context, calendarRecords, db, objectiveId, input.filename), operationId);
    }
    if (readOnly) { checkContextFence(db, binding); return { ...runDatabaseCommand(db, command, input, binding, operationId), operationId }; }
    const requestId = binding.requestId || input.requestId || operationId;
    if (typeof requestId !== 'string' || requestId.length > 250) fault('INVALID_REQUEST', 'Invalid request identifier');
    const inputHash = hash({ command, input, scope: binding.sourceScope || null, bundle: binding.bundleId || binding.bundleVersion || null });
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    const previous = db.prepare('SELECT * FROM operations WHERE request_id=?').get(requestId);
    if (previous) {
      if (previous.command !== command || previous.input_hash !== inputHash) fault('REQUEST_CONFLICT', 'Request identifier was already used with different input', 'conflict');
      db.exec('ROLLBACK'); transaction = false;
      return parse(previous.receipt_json);
    }
    checkContextFence(db, binding);
    const result = { ...runDatabaseCommand(db, command, input, binding, operationId), operationId };
    const calendarChanged = !groupCommand && result.kind === 'saved' && (calendarMutations.has(command) || calendarRelatedWrites.has(command));
    if (calendarChanged) setMeta(db, 'calendarDataRevision', (meta(db, 'calendarDataRevision') || 0) + 1);
    if (Buffer.byteLength(stable(result)) > 256 * 1024) fault('RESULT_TOO_LARGE', 'Result exceeds the configured response budget');
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(requestId, command, inputHash, operationId, stable(result));
    db.exec('COMMIT'); transaction = false;
    if (calendarChanged && space(db).calendarVersion) {
      const warning = refreshCalendarDocuments(context, calendarRecords, db, objectiveId);
      if (warning) result.data.documentWarning = warning;
    }
    return result;
  } catch (error) {
    if (transaction) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } }
    const code = (error.errcode & 255) === 5 ? 'SQLITE_BUSY' : error.code || 'STORAGE_ERROR';
    return output(error.kind || 'failed', null, operationId, { code, message: error.public ? error.message : 'Storage operation failed', retryable: ['SQLITE_BUSY', 'MIGRATION_BUSY', 'DELETE_PENDING', 'EXPORT_FAILED'].includes(code) });
  } finally {
    if (lifecycleLock) lifecycleLock.exec('COMMIT');
  }
}
