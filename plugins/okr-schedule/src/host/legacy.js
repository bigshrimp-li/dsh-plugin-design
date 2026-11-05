import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const writeQueues = new Map();
const collectionFiles = { key_points: 'keypoints.json', schedules: 'schedules.json', inspirations: 'inspirations.json', results: 'results.json' };

export class LegacyStoreError extends Error {
  constructor(code, message, objectiveId) {
    super(message);
    this.name = 'LegacyStoreError';
    this.code = code;
    if (objectiveId) this.objectiveId = objectiveId;
  }
}

function fail(code, message, objectiveId) { throw new LegacyStoreError(code, message, objectiveId); }
function validId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
    && !['.', '..'].includes(value) && !/[\\/\0]/.test(value);
}
function assertId(value, label = '目标 ID') { if (!validId(value)) fail('INVALID_ID', `${label}无效`); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isArchived(value) {
  return value.is_archived === true || value.archived === true || Boolean(value.archived_at) || value.status === 'archived';
}
function isRecurring(schedule) {
  return /^SCH_REC_/i.test(schedule.id)
    || [schedule.recurrence, schedule.recurrence_rule, schedule.repeat, schedule.repeat_rule,
      schedule.rrule, schedule.is_recurring, schedule.recurring].some(value =>
      value !== undefined && value !== null && value !== false && value !== '' && value !== 'none')
    || ['recurring', 'repeat', 'periodic'].includes(schedule.kind)
    || ['recurring', 'repeat', 'periodic'].includes(schedule.type)
    || ['recurring', 'repeat', 'periodic'].includes(schedule.schedule_kind);
}
function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    fail('INVALID_DATE', '日期必须是有效的 YYYY-MM-DD');
  }
}
function dateInZone(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch { fail('INVALID_TIMEZONE', '空间时区无效，无法确定今天'); }
}
async function serialWrite(key, work) {
  const previous = writeQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  writeQueues.set(key, current);
  try { return await current; }
  finally { if (writeQueues.get(key) === current) writeQueues.delete(key); }
}

/** Async legacy JSON access. A scoped read never opens another O directory. */
export function createLegacyStore({ baseDir, now = () => new Date() }) {
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) throw new TypeError('baseDir must be an absolute path');
  const root = path.resolve(baseDir);

  async function safePath(parts, { optional = false, directory = false } = {}) {
    let target = root;
    const segments = [null, ...parts];
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index] !== null) target = path.join(target, segments[index]);
      let stat;
      try { stat = await fs.lstat(target); }
      catch (error) {
        if (error.code === 'ENOENT' && optional) return null;
        fail('STORAGE_UNAVAILABLE', '目标存储不存在或无法访问');
      }
      if (stat.isSymbolicLink()) fail('UNSAFE_PATH', '拒绝通过符号链接访问目标存储');
      const mustBeDirectory = index < segments.length - 1 || directory;
      if (mustBeDirectory ? !stat.isDirectory() : !stat.isFile()) fail('INVALID_STORAGE', '目标存储类型无效');
    }
    return target;
  }
  async function readJson(parts, fallback) {
    const filename = await safePath(parts, { optional: fallback !== undefined });
    if (!filename) return structuredClone(fallback);
    let text;
    try { text = await fs.readFile(filename, 'utf8'); }
    catch { fail('STORAGE_UNAVAILABLE', '目标文件无法读取'); }
    try { return JSON.parse(text); }
    catch { fail('INVALID_JSON', `${parts.at(-1)} 不是有效 JSON`); }
  }
  async function indexEntries() {
    const index = await readJson(['global_index.json'], { objectives: [] });
    if (!isObject(index) || !Array.isArray(index.objectives)) fail('INVALID_INDEX', '全局索引必须包含 objectives 列表');
    return index.objectives;
  }
  function validateCollection(items, name, objectiveId) {
    if (!Array.isArray(items) || items.some(item => !isObject(item) || !validId(item.id))) {
      fail('INVALID_DATA', `${name} 必须是含有效 ID 的对象列表`, objectiveId);
    }
    if (new Set(items.map(item => item.id)).size !== items.length) fail('AMBIGUOUS_ID', `${name} 存在重复 ID`, objectiveId);
    return items;
  }
  async function readObjective(entry) {
    if (!isObject(entry) || !validId(entry.id)) fail('INVALID_ID', '索引中的目标 ID 无效');
    const objectiveId = entry.id;
    await safePath([objectiveId], { directory: true });
    const meta = await readJson([objectiveId, 'meta.json'], entry);
    if (!isObject(meta) || meta.id !== objectiveId) fail('INVALID_DATA', '目标元数据 ID 与索引不一致', objectiveId);
    const data = { objectives: [meta] };
    for (const [name, filename] of Object.entries(collectionFiles)) {
      const items = validateCollection(await readJson([objectiveId, filename], []), filename, objectiveId);
      data[name] = items.map(item => name === 'results'
        ? { ...item, target_id: item.target_id || objectiveId, objective_id: objectiveId }
        : { ...item, objective_id: objectiveId });
    }
    return data;
  }
  async function read({ objectiveId } = {}) {
    if (objectiveId !== undefined) assertId(objectiveId);
    const entries = await indexEntries();
    const selected = objectiveId === undefined ? entries : entries.filter(entry => entry?.id === objectiveId);
    if (objectiveId !== undefined && selected.length === 0) fail('NOT_FOUND', '未找到指定目标', objectiveId);
    const data = { objectives: [], key_points: [], schedules: [], inspirations: [], results: [], errors: [] };
    const visited = new Set();
    for (const entry of selected) {
      try {
        if (visited.has(entry?.id)) continue;
        visited.add(entry?.id);
        if (selected.filter(candidate => candidate?.id === entry?.id).length !== 1) {
          fail('AMBIGUOUS_ID', '全局索引存在重复目标 ID', validId(entry?.id) ? entry.id : undefined);
        }
        const objective = await readObjective(entry);
        for (const name of Object.keys(objective)) data[name].push(...objective[name]);
      } catch (error) {
        if (!(error instanceof LegacyStoreError) || objectiveId !== undefined) throw error;
        data.errors.push({ ...(validId(entry?.id) ? { objective_id: entry.id } : {}), code: error.code, message: error.message });
      }
    }
    return data;
  }
  async function query({ objectiveId, date, allDates = false } = {}) {
    if (date !== undefined) validateDate(date);
    if (typeof allDates !== 'boolean' || (allDates && date !== undefined)) fail('INVALID_ARGUMENT', 'all_dates 必须为布尔值，且不能与 date 同时指定');
    const data = await read({ objectiveId });
    const dates = new Map();
    if (!allDates) {
      for (const objective of data.objectives) {
        try { dates.set(objective.id, date ?? dateInZone(now(), objective.timezone || objective.time_zone)); }
        catch (error) {
          if (!(error instanceof LegacyStoreError) || objectiveId !== undefined) throw error;
          data.errors.push({ objective_id: objective.id, code: error.code, message: error.message });
        }
      }
    }
    return { ...data, success: data.errors.length === 0,
      schedules: allDates ? data.schedules : data.schedules.filter(item => item.date === dates.get(item.objective_id)) };
  }
  async function atomicWrite(objectiveId, filename, data) {
    if (await safePath([objectiveId, '.migration.lock'], { optional: true })) fail('MIGRATION_BUSY', '目标正在迁移，旧存储暂不能写入', objectiveId);
    if (await safePath([objectiveId, 'space.sqlite'], { optional: true })) fail('MIGRATED', '目标已使用新存储，拒绝继续写入旧 JSON', objectiveId);
    const directory = await safePath([objectiveId], { directory: true });
    const target = await safePath([objectiveId, filename], { optional: true }) || path.join(directory, filename);
    const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await safePath([objectiveId], { directory: true });
      if (await safePath([objectiveId, '.migration.lock'], { optional: true })) fail('MIGRATION_BUSY', '目标正在迁移，旧存储暂不能写入', objectiveId);
      if (await safePath([objectiveId, 'space.sqlite'], { optional: true })) fail('MIGRATED', '目标已使用新存储，拒绝继续写入旧 JSON', objectiveId);
      await safePath([objectiveId, filename], { optional: true });
      await fs.rename(temporary, target);
    } catch (error) {
      if (error instanceof LegacyStoreError) throw error;
      fail('WRITE_FAILED', '目标文件未能原子保存', objectiveId);
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  async function checkin({ scheduleId, objectiveId, status = 'completed', note, date, occurrenceKey } = {}) {
    assertId(scheduleId, '日程 ID');
    if (!['completed', 'in_progress', 'skipped'].includes(status) || (note !== undefined && typeof note !== 'string')) fail('INVALID_ARGUMENT', '打卡状态或心得无效');
    if (date !== undefined) validateDate(date);
    return serialWrite(root, async () => {
      const data = await read({ objectiveId });
      if (data.errors.length) fail('INCOMPLETE_DATA', '部分目标无法读取，不能确定日程唯一归属');
      const matches = data.schedules.filter(item => item.id === scheduleId);
      if (matches.length === 0) fail('NOT_FOUND', '未找到指定日程');
      if (matches.length !== 1) fail('AMBIGUOUS_ID', '日程 ID 不唯一，请指定目标');
      const schedule = matches[0];
      const objective = data.objectives.find(item => item.id === schedule.objective_id);
      const keypoint = schedule.key_point_id && data.key_points.find(item => item.id === schedule.key_point_id && item.objective_id === schedule.objective_id);
      if (schedule.key_point_id && !keypoint) fail('INVALID_REFERENCE', '日程引用的核心支撑点不存在');
      if (isArchived(objective) || (keypoint && isArchived(keypoint))) fail('ARCHIVED', '目标或核心支撑点已归档，不能打卡');
      if (isRecurring(schedule)) fail('OCCURRENCE_REQUIRED', '周期日程需要独立的分次执行记录，请迁移后按日期或 occurrence_key 打卡');
      if ((date !== undefined && schedule.date !== date)
        || (occurrenceKey !== undefined && occurrenceKey !== schedule.id && occurrenceKey !== schedule.occurrence_key)) fail('OCCURRENCE_MISMATCH', '指定执行与该单次日程不匹配');
      const ownSchedules = await readJson([schedule.objective_id, 'schedules.json'], []);
      const updated = { ...ownSchedules.find(item => item.id === scheduleId), status };
      if (note !== undefined) updated.checkin_note = note;
      await atomicWrite(schedule.objective_id, 'schedules.json', ownSchedules.map(item => item.id === scheduleId ? updated : item));
      return { success: true, schedule: { ...updated, objective_id: schedule.objective_id } };
    });
  }
  async function capture({ objectiveId, inspiration } = {}) {
    assertId(objectiveId);
    if (typeof inspiration !== 'string' || !inspiration.trim()) fail('INVALID_ARGUMENT', '灵感内容不能为空');
    return serialWrite(root, async () => {
      const data = await read({ objectiveId });
      const objective = data.objectives[0];
      if (isArchived(objective)) fail('ARCHIVED', '目标已归档，不能保存灵感');
      const inspirations = await readJson([objectiveId, 'inspirations.json'], []);
      const item = { id: `INS_${randomUUID()}`, date: dateInZone(now(), objective.timezone || objective.time_zone), text: inspiration };
      await atomicWrite(objectiveId, 'inspirations.json', [item, ...inspirations]);
      return { success: true, inspiration: { ...item, objective_id: objectiveId } };
    });
  }
  // Migration uses the same process-local queue as legacy writes. The callback
  // must not call checkin/capture or recursively acquire this non-reentrant lock.
  async function withExclusive(objectiveId, callback) {
    assertId(objectiveId);
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    return serialWrite(root, callback);
  }
  return { read, query, checkin, capture, withExclusive };
}
