import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { calendarFault, compareEvents } from './calendar-records.js';
import { readLegacyRange } from './calendar-legacy.js';

const documents = ['空间概览.md', 'AGENTS.md'];
function writeAtomic(directory, name, content) {
  const temporary = path.join(directory, '.calendar-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, content, { flag:'wx', mode:0o600 });
    fs.renameSync(temporary, path.join(directory, name));
  } finally { fs.rmSync(temporary, { force:true }); }
}
function markdown(records, db, filename) {
  const { goal, warnings } = records.readGoal(db);
  if (filename === 'AGENTS.md') return goal.assistantRule;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone:goal.timezone, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  const lines = ['# ' + goal.name, '', goal.about, '', '## 过程目标与反馈', ''];
  for (const k of goal.ks) {
    const status = k.achievedOn ? '已实现（' + k.achievedOn + '）' : !k.to ? '缺少期限' : k.to < today ? '已过期' : '待实现';
    lines.push('- ' + k.name + '（' + (k.from || '未记录') + ' 至 ' + (k.to || '未记录') + '）', '  - 状态：' + status,
      '  - 标准：' + (k.standard || '未记录'), '  - 反馈：' + (k.r || '待反馈'));
  }
  lines.push('', '## 事项与执行', '');
  for (const event of records.allEvents(db)) {
    const amount = event.posting ? ' · ' + (event.posting.flow === 'income' ? '收入' : '支出') + ' ' + event.posting.currency + ' ' + (event.posting.cents / 100).toFixed(2) : '';
    lines.push('- ' + [event.date, event.time, event.title].filter(Boolean).join(' ') + '（' + (event.status === 'done' ? '已完成' : '待执行') + '）' + amount);
    if (event.note) lines.push('  - 执行情况：' + event.note);
    if (event.measure) lines.push('  - 实测结果：' + event.measure);
  }
  if (warnings.length) lines.push('', '## 历史记录说明', '', ...warnings.map(warning => '- ' + warning));
  return lines.join('\n') + '\n';
}
export function exportCalendarDocument(context, records, db, oid, filename) {
  if (!documents.includes(filename)) calendarFault('INVALID_INPUT', '请选择空间概览或助手规则');
  const directory = context.safeSpace(oid);
  context.safeFile(directory, filename);
  const content = markdown(records, db, filename);
  try { writeAtomic(directory, filename, content); }
  catch { calendarFault('EXPORT_FAILED', '最新阅读稿写入失败，可从空间资料重试'); }
  return { filename, content };
}
export function refreshCalendarDocuments(context, records, db, oid) {
  try {
    for (const name of documents) exportCalendarDocument(context, records, db, oid, name);
    return null;
  } catch { return '正式记录已保存，阅读稿尚未刷新。请在空间资料中重新导出。'; }
}

export function createCalendarFiles(records, core) {
  const { runDomainCommand, validId, validDate, initialSpace, setMeta, space, stable, hash, meta, output, createStorageContext } = core;
  function registryExists(context) {
    return fs.existsSync(path.join(context.root, 'groups', 'calendar-index', 'group.sqlite'));
  }
  function pendingDeletes(context) {
    if (!registryExists(context)) return [];
    const registry = context.openGroup('calendar-index');
    return registry.prepare("SELECT key,value FROM meta WHERE key LIKE 'removed:%' AND json_extract(value,'$.state')='pending'").all()
      .map(row => ({ id:row.key.slice(8), name:JSON.parse(row.value).name }));
  }
  function lockSpace(context, oid, createRegistry) {
    if (!createRegistry && !registryExists(context)) return null;
    const registry = context.openGroup('calendar-index');
    registry.exec('BEGIN IMMEDIATE');
    if (meta(registry, 'removed:' + oid)) {
      registry.exec('ROLLBACK');
      calendarFault('DELETED', '此空间已删除或正在清理');
    }
    return registry;
  }
  function catalog(context) {
    const result = runDomainCommand(context, 'spaces.list', {}, { trusted:true, global:true });
    if (result.kind !== 'read') calendarFault(result.error.code, result.error.message);
    const pending = pendingDeletes(context);
    const hidden = new Set(pending.map(entry => entry.id));
    const errors = result.data.errors.filter(error => !hidden.has(error.objectiveId)), spaces = [];
    for (const s of result.data.spaces) {
      if (s.lifecycle !== 'formal' || hidden.has(s.id)) continue;
      try {
        spaces.push(s.migrated ? records.goalMetadata(context.open(s.id)) : {
          id:s.id, name:s.title, about:s.purpose, migrated:false, timezone:s.timezone, archivedAt:s.archivedAt,
          color:s.legacy_payload?.color || '#64748b'
        });
      } catch (error) {
        errors.push({ objectiveId:s.id, code:error.code || 'STORAGE_ERROR', message:'无法核对目标目录' });
      }
    }
    return { spaces, errors, pendingDeletes:pending };
  }
  function globalRange(context, input, binding, busy = false) {
    const { spaces, errors } = catalog(context);
    const periods = [];
    if (busy) {
      if (!Array.isArray(input.dates) || input.dates.length > 366 || input.dates.some(date => !validDate(date))) calendarFault('INVALID_INPUT', '请按有效日期查询占用时段');
      // Include the previous local day. A time block may straddle midnight.
      const days = new Set(input.dates);
      for (const date of input.dates) {
        days.add(new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10));
        days.add(new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10));
      }
      for (const day of [...days].sort()) {
        const last = periods.at(-1);
        if (last && Date.parse(day) - Date.parse(last.to) === 86400000 && Date.parse(day) - Date.parse(last.from) < 366 * 86400000) last.to = day;
        else periods.push({ from:day, to:day });
      }
    } else {
      if (!validDate(input.from) || !validDate(input.to) || input.to < input.from || Date.parse(input.to) - Date.parse(input.from) >= 366 * 86400000) calendarFault('INVALID_INPUT', '日历查询须在 1 至 366 天内');
      periods.push({ from:input.from, to:input.to });
    }
    const wanted = input.objectiveIds;
    if (wanted !== undefined && (!Array.isArray(wanted) || wanted.some(oid => !validId(oid)))) calendarFault('INVALID_INPUT', '目标列表格式不正确');
    const visible = new Set(spaces.map(s => s.id));
    if (wanted && !busy) {
      for (let i = errors.length - 1; i >= 0; i--) if (!wanted.includes(errors[i].objectiveId)) errors.splice(i, 1);
    }
    if (!busy) for (const oid of wanted || []) if (!visible.has(oid) && !errors.some(error => error.objectiveId === oid)) errors.push({ objectiveId:oid, code:'NOT_FOUND' });
    const events = [];
    for (const s of spaces) {
      if (s.archivedAt || !busy && wanted && !wanted.includes(s.id)) continue;
      try {
        for (const period of periods) {
          const result = s.migrated ? records.range(context.open(s.id), period, true) : readLegacyRange(context, s, period, core);
          for (const event of result.events) {
            const replaced = busy && event.oid === binding.objectiveId && input.excludeIds?.includes(event.id) && event.status !== 'done';
            if (!replaced) events.push(event);
          }
          errors.push(...result.errors);
        }
      } catch (error) {
        errors.push({ objectiveId:s.id, code:error.code || 'STORAGE_ERROR', message:error.public ? error.message : '此空间的排期读取不完整' });
      }
    }
    if (busy) {
      const timezone = input.timeZone || (binding.objectiveId ? space(context.open(binding.objectiveId)).timezone : Intl.DateTimeFormat().resolvedOptions().timeZone);
      let date, time;
      try {
        date = new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit', timeZone:timezone });
        time = new Intl.DateTimeFormat('en-GB', { hour:'2-digit', minute:'2-digit', hourCycle:'h23', timeZone:timezone });
      } catch { calendarFault('INVALID_INPUT', '时区无效'); }
      const slots = events.filter(e => e.start && e.duration > 0).map(e => {
        const instant = new Date(e.start);
        return { date:date.format(instant), time:time.format(instant), duration:e.duration };
      });
      return { slots, errors:errors.length ? [{ code:'PARTIAL_AVAILABILITY' }] : [] };
    }
    return { events:events.sort(compareEvents), errors };
  }
  function create(context, input, binding, operationId) {
    if (input.confirm !== true || !validId(input.draft?.id)) calendarFault('CONFIRMATION_REQUIRED', '请核对方案后确认创建');
    const oid = 'O_' + hash(input.draft.id).slice(0, 32);
    const requestHash = hash({ goal:input.draft.goal, events:input.draft.events });
    const registry = context.openGroup('calendar-index');
    registry.exec('BEGIN IMMEDIATE');
    let stagingRoot;
    try {
      if (meta(registry, 'removed:' + oid)) calendarFault('DELETED', '此草稿对应的空间已经删除', 'conflict');
      const target = path.join(fs.realpathSync(context.root), oid);
      if (fs.existsSync(target)) {
        const db = context.open(oid);
        if (meta(db, 'creationHash') !== requestHash) calendarFault('REVISION_CONFLICT', '这个草稿已经确认，请打开现有空间', 'conflict');
        registry.exec('COMMIT');
        return output('saved', { objectiveId:oid, revision:space(db).revision, alreadyCreated:true }, operationId);
      }
      stagingRoot = fs.mkdtempSync(path.join(context.root, '.calendar-create-'));
      const isolated = createStorageContext({ baseDir:stagingRoot, DatabaseSync:context.DatabaseSync });
      let data;
      try {
        const db = isolated.open(oid, { create:true });
        db.exec('BEGIN IMMEDIATE');
        try {
          const timezone = input.draft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
          try { new Intl.DateTimeFormat('en-CA', { timeZone:timezone }); } catch { calendarFault('INVALID_INPUT', '空间时区无效'); }
          setMeta(db, 'space', initialSpace(oid, { timezone }));
          setMeta(db, 'calendarDataRevision', 1);
          data = records.apply(db, input, { ...binding, objectiveId:oid }, operationId, true);
          setMeta(db, 'creationHash', requestHash);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        for (const filename of documents) exportCalendarDocument(isolated, records, db, oid, filename);
      } finally { isolated.close(); }
      fs.renameSync(path.join(stagingRoot, oid), target);
      registry.exec('COMMIT');
      return output('saved', data, operationId);
    } catch (error) { registry.exec('ROLLBACK'); throw error; }
    finally { if (stagingRoot) fs.rmSync(stagingRoot, { recursive:true, force:true }); }
  }
  function remove(context, input, binding, operationId) {
    const oid = binding.objectiveId;
    if (input.confirm !== true || !validId(oid)) calendarFault('CONFIRMATION_REQUIRED', '请选择一个空间并确认删除');
    const registry = context.openGroup('calendar-index'), key = 'removed:' + oid;
    const directory = path.join(fs.realpathSync(context.root), oid);
    const trash = path.join(fs.realpathSync(context.root), '.calendar-delete-' + oid);
    // Commit the intent first. After any filesystem error or process exit the next
    // window can resume with the same O and directory identity.
    const identity = directory => {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) calendarFault('INVALID_SPACE', '清理目录的身份不符');
      return stat.dev + ':' + stat.ino;
    };
    registry.exec('BEGIN IMMEDIATE');
    try {
      if (!meta(registry, key)) {
        const db = context.open(oid);
        const target = space(db);
        if (target.id !== oid || target.lifecycle !== 'formal') calendarFault('INVALID_SPACE', '删除目标与空间标识不符');
        if (binding.bundleId != null && binding.bundleId !== target.activeBundleId) calendarFault('BUNDLE_CONFLICT', '空间版本已改变，请重新核对');
        setMeta(registry, key, { state:'pending', name:target.title, identity:identity(directory) });
      }
      registry.exec('COMMIT');
    } catch (error) { registry.exec('ROLLBACK'); throw error; }
    registry.exec('BEGIN IMMEDIATE');
    try {
      const planned = meta(registry, key);
      if (planned.state !== 'done') {
        if (fs.lstatSync(directory, { throwIfNoEntry:false })) {
          if (identity(directory) !== planned.identity || space(context.open(oid)).id !== oid) calendarFault('DELETE_PENDING', '空间目录的身份已变，停止清理');
          context.closeOne(oid);
          if (fs.lstatSync(trash, { throwIfNoEntry:false })) calendarFault('DELETE_PENDING', '目录仍被占用，请重试删除');
          fs.renameSync(directory, trash);
        }
        if (fs.lstatSync(trash, { throwIfNoEntry:false }) && identity(trash) !== planned.identity)
          calendarFault('DELETE_PENDING', '待清理目录的身份已变，停止清理');
        const index = context.safeFile(fs.realpathSync(context.root), 'global_index.json');
        if (fs.existsSync(index)) {
          const json = JSON.parse(fs.readFileSync(index, 'utf8'));
          if (!Array.isArray(json.objectives)) calendarFault('DELETE_PENDING', '旧索引格式无效，尚待清理');
          const rest = json.objectives.filter(entry => entry?.id !== oid);
          if (rest.length !== json.objectives.length) writeAtomic(path.dirname(index), path.basename(index), stable({ ...json, objectives:rest }));
        }
        fs.rmSync(trash, { recursive:true, force:true });
        setMeta(registry, key, { state:'done' });
      }
      registry.exec('COMMIT');
      return output('saved', { objectiveId:oid, deleted:true }, operationId);
    } catch (error) {
      registry.exec('ROLLBACK');
      if (error.public) throw error;
      calendarFault('DELETE_PENDING', '空间文件或全局索引尚待清理，请按原空间标识重试');
    }
  }
  return { catalog, globalRange, create, remove, lockSpace };
}
