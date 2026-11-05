import { randomUUID } from 'node:crypto';

const uid = prefix => prefix + '_' + randomUUID();
const defaults = () => ({
  filters: { query: '', kind: 'all', status: 'all', range: 'all', flow: 'all' },
  group: 'kind', metric: 'count', style: 'list', dense: false, highlight: false
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function calendarFault(code, message, kind = 'failed') {
  throw Object.assign(new Error(message), { code, kind, public: true });
}
const invalid = message => calendarFault('INVALID_INPUT', message);
function required(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > limit) invalid(label + '不能为空且最多 ' + limit + ' 字');
  return value.trim();
}
function optional(value, limit, label) {
  if (value == null) return '';
  if (typeof value !== 'string' || [...value].length > limit) invalid(label + '过长或格式错误');
  return value;
}
function option(value, allowed, label) {
  if (!allowed.includes(value)) invalid(label + '选项无效');
  return value;
}
function layoutOf(raw, bookkeeping) {
  const value = { ...defaults(), ...raw }, f = { ...defaults().filters, ...value.filters };
  return {
    filters: {
      query: optional(f.query, 300, '关键词'), kind: optional(f.kind, 80, '类型') || 'all',
      status: option(f.status, ['all', 'done', 'plan'], '执行状态'),
      range: option(f.range, ['all', 'week', 'month', 'thisWeek', 'thisMonth', 'upcoming'], '日期'),
      flow: option(f.flow, bookkeeping ? ['all', 'income', 'expense'] : ['all'], '收支方向')
    },
    group: option(value.group, ['kind', 'month', 'week', 'date', 'status', 'none'], '分组'),
    metric: option(value.metric, bookkeeping ? ['count', 'minutes', 'rate', 'cash'] : ['count', 'minutes', 'rate'], '统计'),
    style: option(value.style, ['list', 'cards'], '布局'),
    dense: value.dense === true, highlight: value.highlight === true
  };
}
function localDay(timezone) {
  try { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone }).format(new Date()); }
  catch { invalid('时区无效'); }
}
function clockOf(timestamp, timezone) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(new Date(timestamp));
}
function ledgerPosting(value) {
  if (!value || !Number.isSafeInteger(value.cents) || value.cents <= 0 || value.cents > 99999999999) invalid('金额必须大于零，最多九位整数、两位小数');
  const flow = option(value.flow, ['income', 'expense'], '收支方向');
  const currency = value.currency || 'CNY';
  if (!/^[A-Z]{3}$/.test(currency)) invalid('请选择三字母币种');
  return { flow, cents: value.cents, currency };
}
const planFields = e => ({ id: e.id, title: e.title, kind: e.kind, date: e.date, time: e.time, duration: e.duration });
const kFields = k => ({ id: k.id, name: k.name, kind: k.kind || '', standard: k.standard, from: k.from, to: k.to });
function requireMatch(actual, base, label) {
  if (!same(actual, base)) calendarFault('REVISION_CONFLICT', label + '已更改，请重新核对后提交', 'conflict');
}
function keyedList(values, validId, label) {
  if (!Array.isArray(values) || values.length > 2000 || values.some(v => !v || !validId(v.id)) || new Set(values.map(v => v.id)).size !== values.length) invalid(label + '标识缺失或重复');
  return new Map(values.map(v => [v.id, v]));
}

export function createCalendarRecords(core) {
  const { space, meta, setMeta, dimension, validDate, validId, requireRevision, requireActive, queryCalendar, zonedTimestamp, saveItem, saveExecution, setTypes, typeRows, getItem, stable } = core;
  function goalMetadata(db) {
    const s = space(db);
    return { id: s.id, name: s.title, about: s.purpose || '', color: s.color || s.legacy_payload?.color || '#0e7490',
      icon: s.icon || 'target', code: s.code || '', bookkeeping: !!s.bookkeeping, archivedAt: s.archivedAt, revision: s.revision,
      timezone: s.timezone, migrated: true,
      kCount:db.prepare('SELECT count(*) AS n FROM dimensions').get().n,
      eventCount:db.prepare("SELECT count(*) AS n FROM actions WHERE json_extract(value,'$.schedule') IS NOT NULL AND json_extract(value,'$.removedFromPlan') IS NOT 1").get().n };
  }
  function readGoal(db) {
    const warnings = [], s = space(db);
    const results = db.prepare('SELECT * FROM results ORDER BY rowid').all();
    const dimensions = db.prepare('SELECT value FROM dimensions ORDER BY rowid').all().map(row => JSON.parse(row.value));
    const ks = dimensions.map(k => {
      const rows = results.filter(row => row.target_id === k.id);
      const paired = k.feedbackId ? rows.find(row => row.id === k.feedbackId) : rows.length === 1 ? rows[0] : null;
      if (!k.from || !k.to) warnings.push('K「' + (k.name || k.title || k.id) + '」缺少期限');
      if (!paired || rows.length > 1) warnings.push('K「' + (k.name || k.title || k.id) + '」有 ' + rows.length + ' 条历史反馈，原文已保留');
      const r = paired ? JSON.parse(paired.value) : {};
      return { id:k.id, name:k.name || k.title || '', standard:k.standard || '', from:k.from || '', to:k.to || '', kind:k.kind || '',
        r:r.body || r.content || r.text || r.description || '', rId:paired?.id || null, rRevision:paired?.revision || 0,
        achievedOn:k.achievedOn || null, revision:k.revision || 1, archivedAt:k.archivedAt || null };
    });
    const unpaired = results.filter(row => !ks.some(k => k.id === row.target_id)).length;
    if (unpaired) warnings.push(unpaired + ' 条旧成果未配对 K，仍可在原工作台查看');
    return { goal: { ...goalMetadata(db), dataRevision:meta(db, 'calendarDataRevision') || 0, ks, layout: s.layout || defaults(), assistantRule:s.assistantRule || '' }, warnings };
  }
  function eventIndex(db, scheduleOnly = false) {
    const actionValue = scheduleOnly ? "json_object('schedule', json_extract(a.value,'$.schedule'),'kind',json_extract(a.value,'$.kind'))" : 'a.value';
    const rows = db.prepare('SELECT a.item_id,' + actionValue + ' AS value,a.revision,i.title,i.type_id,i.main_k_id FROM actions a JOIN items i ON i.id=a.item_id').all();
    const actions = new Map(rows.map(row => [row.item_id, { ...JSON.parse(row.value), revision:row.revision, title:row.title, typeId:row.type_id, k:row.main_k_id }]));
    const executions = new Map();
    const executionValue = scheduleOnly ? "json_object('state',json_extract(value,'$.state'),'legacy',json_extract(value,'$.legacy'))" : 'value';
    for (const row of db.prepare('SELECT id,item_id,occurrence_key,revision,' + executionValue + ' AS value FROM executions').all()) {
      let byKey = executions.get(row.item_id);
      if (!byKey) executions.set(row.item_id, byKey = new Map());
      byKey.set(row.occurrence_key, { ...JSON.parse(row.value), revision:row.revision, id:row.id });
    }
    return { s:space(db), actions, executions };
  }
  function asEvent(index, itemId, occurrence, occurrenceKey) {
    const action = index.actions.get(itemId);
    if (!action?.schedule || action.removedFromPlan) return null;
    const schedule = action.schedule, recurring = !!(schedule.recurrence || schedule.recurring);
    const timezone = schedule.timezone || index.s.timezone;
    const date = occurrence?.date || schedule.date;
    const key = occurrenceKey || occurrence?.occurrenceKey || (recurring ? date : 'single');
    const executions = index.executions.get(itemId);
    const execution = executions?.get(key) || (!recurring && executions?.get('legacy:' + itemId));
    const start = occurrence?.start || schedule.start;
    const end = occurrence?.end || schedule.end;
    const validTime = start && Number.isFinite(Date.parse(start));
    return { id:itemId, oid:index.s.id, occurrenceKey:execution?.legacy ? 'legacy:' + itemId : key, recurring,
      title:action.title, readOnly:recurring || schedule.enabled === false || !validTime || !end, date, time:validTime ? clockOf(start, timezone) : '', duration:validTime && end ? Math.round((Date.parse(end) - Date.parse(start)) / 60000) : null,
      kind:action.kind || action.typeId, status:execution?.state === 'completed' ? 'done' : 'plan', note:execution?.note || '', measure:execution?.measure || '',
      start:validTime ? start : null, occurredAt:execution?.occurredAt || null,
      ...(execution?.posting ? { posting:execution.posting } : {}), revision:action.revision, executionRevision:execution?.revision || 0 };
  }
  function allEvents(db) {
    const index = eventIndex(db), events = [];
    for (const id of index.actions.keys()) {
      const initial = asEvent(index, id);
      if (!initial) continue;
      events.push(initial);
      if (!initial.recurring) continue;
      for (const key of index.executions.get(id)?.keys() || []) {
        if (key === initial.occurrenceKey || !validDate(key)) continue;
        events.push(asEvent(index, id, { date:key }, key));
      }
    }
    return events.sort(compareEvents);
  }
  function range(db, input, scheduleOnly = false) {
    const index = eventIndex(db, scheduleOnly), events = [];
    let result;
    do {
      result = queryCalendar(db, { ...input, offset:events.length, limit:2000 }).data;
      for (const o of result.occurrences) {
        const event = asEvent(index, o.itemId, o);
        if (scheduleOnly) { delete event.measure; delete event.note; delete event.occurredAt; }
        events.push(event);
      }
    } while (result.hasMore);
    return { events, errors:result.unsupported.map(error => ({ ...error, objectiveId:index.s.id })) };
  }
  function exactEvent(db, input) {
    const index = eventIndex(db), e = asEvent(index, input.id);
    if (!e) calendarFault('NOT_FOUND', '这条事项已失效');
    if (!e.recurring || !input.occurrenceKey) {
      if (input.occurrenceKey && e.occurrenceKey !== input.occurrenceKey) calendarFault('NOT_FOUND', '这次执行不存在');
      return e;
    }
    if (!validDate(input.occurrenceKey)) invalid('周期事项需要有效的发生日期');
    const found = range(db, { from:input.occurrenceKey, to:input.occurrenceKey }).events.find(row => row.id === input.id);
    if (!found) calendarFault('NOT_FOUND', '原排期在这一天没有发生');
    return found;
  }
  function validateK(k) {
    const name = required(k.name, 120, 'K 名称'), standard = required(k.standard, 2000, '达标标准');
    if (!validDate(k.from) || !validDate(k.to) || k.to < k.from) invalid('K 起止日期无效');
    return { name, title:name, standard, from:k.from, to:k.to, kind:optional(k.kind, 80, 'K 类别') };
  }
  function saveK(db, k, existing) {
    const fields = validateK(k);
    if (!validId(k.id)) invalid('K 标识无效');
    const oldRows = db.prepare('SELECT id FROM results WHERE target_id=?').all(k.id);
    let feedbackId = existing?.feedbackId || (oldRows.length === 1 && oldRows[0].id);
    if (!feedbackId) {
      feedbackId = uid('R');
      db.prepare('INSERT INTO results VALUES(?,?,?,1)').run(feedbackId, k.id, stable({ body:'', evidence:[] }));
    }
    const value = { ...existing, ...fields, id:k.id, objectiveId:space(db).id, feedbackId, revision:(existing?.revision || 0) + 1 };
    db.prepare('INSERT INTO dimensions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(k.id, stable(value));
    return value;
  }
  function validatePlan(event, oid) {
    if (!event || (event.oid && oid && event.oid !== oid)) calendarFault('FORBIDDEN', '事项归属与当前空间不一致');
    const title = required(event.title, 80, '事项名称');
    if (!validDate(event.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(event.time)) invalid('事项日期或开始时间无效');
    if (!Number.isInteger(event.duration) || event.duration < 1 || event.duration > 1440) invalid('时长须为 1 至 1440 分钟的整数');
    return { title, kind:optional(event.kind, 80, '事项类型').trim() || '实践' };
  }
  function savePlan(db, event, binding, operationId, existing, actualOnly = false) {
    const { title, kind } = validatePlan(event, binding.objectiveId), timezone = space(db).timezone;
    const [hour, minute] = event.time.split(':').map(Number);
    const start = zonedTimestamp(event.date, { hour, minute, second:0 }, timezone);
    if (!start) invalid('所在时区没有这个开始时刻');
    const end = actualOnly ? null : new Date(Date.parse(start) + event.duration * 60000).toISOString();
    let id;
    if (existing) {
      id = existing.id;
      if (existing.recurring) invalid('请在原周期排期中修改周期规则');
      db.prepare('UPDATE items SET title=?,revision=revision+1,updated_at=? WHERE id=?').run(title, new Date().toISOString(), id);
      db.prepare('UPDATE item_search SET title=? WHERE item_id=?').run(title, id);
    } else {
      const types = typeRows(db);
      if (!types.some(type => type.id === 'calendar-event')) setTypes(db, [...types, { id:'calendar-event', title:'日程事项', fields:[] }]);
      const result = saveItem(db, { id:event.id || uid('EV'), title, typeId:'calendar-event' }, binding, operationId);
      if (result.kind !== 'saved') invalid('事项未写入');
      id = result.data.itemId;
    }
    const action = { kind, actualOnly, state:'pending', schedule:{ date:event.date, start, end, timezone, enabled:true } };
    db.prepare('INSERT INTO actions VALUES(?,?,1) ON CONFLICT(item_id) DO UPDATE SET value=excluded.value,revision=actions.revision+1').run(id, stable(action));
    return id;
  }
  function recordExecution(db, event, postingEntry = false, timezone = space(db).timezone) {
    const current = exactEvent(db, event);
    requireActive(db, getItem(db, current.id).mainKId);
    if (event.oid !== undefined && event.oid !== current.oid) calendarFault('FORBIDDEN', '事项归属与当前空间不一致');
    if (event.revision !== undefined) requireRevision(current.revision, event.revision);
    requireRevision(current.executionRevision, event.executionRevision ?? 0);
    const note = optional(event.note, 8000, '执行情况'), measure = optional(event.measure, 2000, '实测结果');
    let posting;
    if (current.posting || event.posting) {
      if (!current.posting && !postingEntry) invalid('请通过「记一笔」确认已发生的账目');
      if (!space(db).bookkeeping || current.date > localDay(timezone)) invalid('只能在记账空间记录已发生的交易');
      posting = ledgerPosting(event.posting || current.posting);
    }
    const data = saveExecution(db, { itemId:current.id, occurrenceKey:current.occurrenceKey, state:'completed', note,
      expectedRevision:current.executionRevision || undefined, occurredAt:current.occurredAt || (posting ? current.start : new Date().toISOString()) }).data;
    const row = db.prepare('SELECT value FROM executions WHERE id=?').get(data.executionId);
    db.prepare('UPDATE executions SET value=? WHERE id=?').run(stable({ ...JSON.parse(row.value), measure, ...(posting ? { posting } : {}) }), data.executionId);
    return exactEvent(db, current);
  }
  function apply(db, input, binding, operationId, creating = false) {
    const { draft } = input;
    if (input.confirm !== true || !draft?.goal || !validId(draft.id)) invalid('必须核对当前草稿并确认');
    const { goal, baseGoal, baseEvents = [], events } = draft;
    const oid = binding.objectiveId;
    if (!creating && (!baseGoal || baseGoal.id !== oid || goal.id !== oid)) calendarFault('FORBIDDEN', '草稿缺少当前空间的基线');
    if (creating && (baseGoal || draft.mode === 'edit')) calendarFault('FORBIDDEN', '调整草稿不能创建另一个空间');
    const normalizedOid = creating ? goal.id : oid;
    const current = readGoal(db).goal;
    const name = required(goal.name, 40, '空间名称'), about = optional(goal.about, 8000, '目标说明');
    const bookkeeping = goal.bookkeeping === true;
    const layout = layoutOf(goal.layout, bookkeeping), assistantRule = optional(goal.assistantRule, 16000, '助手规则');
    const ks = keyedList(goal.ks, validId, 'K'), proposals = keyedList(events, validId, '拟排事项');
    const originalKs = keyedList(baseGoal?.ks || [], validId, '原有 K');
    const originalPlans = keyedList(baseEvents, validId, '原排期');
    for (const kid of originalKs.keys()) if (!ks.has(kid)) invalid('调整不能移除已保存 K 或反馈');
    const planChanged = name !== baseGoal?.name || about !== (baseGoal?.about || '') || !same([...ks.values()].map(kFields), [...originalKs.values()].map(kFields)) ||
      !same(events.map(planFields), baseEvents.map(planFields));
    if (creating || planChanged) {
      if (!ks.size) invalid('至少需要一个 K');
      if (!events.length) invalid('新增或调整计划至少需要一件拟排事项');
      for (const k of ks.values()) validateK(k);
    }
    for (const e of proposals.values()) validatePlan(e, normalizedOid);

    const changes = { name, about, bookkeeping, layout, assistantRule };
    const next = { ...space(db) };
    for (const [key, value] of Object.entries(changes)) {
      const base = baseGoal?.[key];
      if (!creating && stable(value) === stable(base)) continue;
      if (!creating && stable(current[key]) !== stable(base)) calendarFault('REVISION_CONFLICT', ({ layout:'事项展示规则', assistantRule:'助手规则', name:'空间名称',about:'空间说明',bookkeeping:'记账选项' })[key] + '已变更，请对照当前版本后重新确认', 'conflict');
      next[({name:'title', about:'purpose'})[key] || key] = value;
    }
    if (creating) {
      next.color = /^#[0-9a-f]{6}$/i.test(goal.color) ? goal.color : '#0e7490';
      next.code = optional(goal.code, 12, '空间简称');
      next.icon = optional(goal.icon, 30, '图标') || 'target';
    }
    next.calendarVersion = 1;
    next.revision += creating ? 0 : 1;
    setMeta(db, 'space', next);
    for (const [kid, k] of ks) {
      const baseline = originalKs.get(kid);
      if (baseline && same(kFields(k), kFields(baseline))) continue;
      const existing = dimension(db, kid);
      if (baseline) {
        const live = current.ks.find(entry => entry.id === kid);
        requireMatch(live && kFields(live), kFields(baseline), 'K');
        requireActive(db, kid);
      } else if (existing) calendarFault('REVISION_CONFLICT', '新增 K 标识已被使用', 'conflict');
      saveK(db, k, existing);
    }
    const liveEvents = new Map(allEvents(db).filter(e => !e.recurring).map(e => [e.id, e]));
    for (const [eventId, before] of originalPlans) {
      const e = proposals.get(eventId);
      if (e && same(planFields(e), planFields(before))) continue;
      const live = liveEvents.get(eventId);
      if (!live) calendarFault('REVISION_CONFLICT', '原排期已移除或属于周期事项，请重新核对', 'conflict');
      if (live.status === 'done') continue;
      if (live.date < localDay(current.timezone)) invalid('历史排期只供核对');
      requireMatch(planFields(live), planFields(before), '事项');
      if (e) savePlan(db, { ...e, oid }, binding, operationId, live);
      else {
        const row = db.prepare('SELECT value FROM actions WHERE item_id=?').get(eventId);
        const action = JSON.parse(row.value);
        action.schedule.enabled = false;
        action.removedFromPlan = true;
        db.prepare('UPDATE actions SET value=?,revision=revision+1 WHERE item_id=?').run(stable(action), eventId);
      }
    }
    for (const e of proposals.values()) if (!originalPlans.has(e.id)) savePlan(db, { ...e, oid }, binding, operationId);
    return { objectiveId:oid, revision:next.revision };
  }
  function run(db, command, input, binding, operationId) {
    if (space(db).lifecycle !== 'formal') calendarFault('DRAFT_SPACE', '此空间尚未确认');
    if (command === 'calendar.space') {
      const state = db.prepare("SELECT value FROM hosted_state WHERE namespace='calendar-assistant' AND key='sessions' AND scope='host'").get();
      return { ...readGoal(db), events:allEvents(db), sessionCount:state ? (JSON.parse(state.value)?.sessions?.length || 0) : 0 };
    }
    if (command === 'calendar.range') return range(db, input);
    if (command === 'calendar.event.get') return { event:exactEvent(db, input) };
    if (command !== 'calendar.feedback.save') requireActive(db);
    if (command === 'calendar.confirm') return apply(db, input, binding, operationId);
    if (command === 'calendar.event.save' || command === 'calendar.ledger.save') {
      const ledger = command === 'calendar.ledger.save', event = input.event;
      if (ledger && (!space(db).bookkeeping || event?.date > localDay(input.timeZone || space(db).timezone))) invalid('只可在记账空间登记已发生的交易');
      if (ledger) ledgerPosting(event?.posting);
      const id = savePlan(db, ledger ? { ...event, kind:event.kind || '其他', duration:1 } : event, binding, operationId, null, ledger);
      return { event:ledger ? recordExecution(db, { ...event, id, executionRevision:0 }, true, input.timeZone || space(db).timezone) : exactEvent(db, { id }) };
    }
    if (command === 'calendar.execution.save') return { event:recordExecution(db, input.event) };
    if (command === 'calendar.k.save') {
      const k = { ...input.k, id:input.k?.id || uid('K') }, existing = dimension(db, k.id);
      if (existing) { requireActive(db, k.id); requireRevision(existing.revision, input.expectedRevision); }
      saveK(db, k, existing);
      return { kid:k.id };
    }
    if (command === 'calendar.feedback.save' || command === 'calendar.achievement.save') {
      const k = dimension(db, input.kid);
      if (!k) calendarFault('NOT_FOUND', '此 K 不属于当前空间');
      if (command === 'calendar.achievement.save') {
        requireActive(db, k.id); requireRevision(k.revision, input.expectedRevision);
        if (typeof input.achieved !== 'boolean') invalid('请确认实现状态');
        const value = { ...k, achievedOn:input.achieved ? localDay(input.timeZone || space(db).timezone) : null, revision:k.revision + 1 };
        db.prepare('UPDATE dimensions SET value=? WHERE id=?').run(stable(value), k.id);
        return { kid:k.id, achievedOn:value.achievedOn, revision:value.revision };
      }
      const body = required(input.r, 8000, '阶段反馈');
      const live = readGoal(db).goal.ks.find(row => row.id === k.id);
      requireRevision(live.rRevision, input.expectedRevision);
      const rid = live.rId || uid('R');
      for (const evidenceId of input.evidence || []) getItem(db, evidenceId);
      db.prepare('INSERT INTO results VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET value=excluded.value,revision=results.revision+1')
        .run(rid, k.id, stable({ body, evidence:input.evidence || [], updatedAt:new Date().toISOString() }));
      if (!k.feedbackId) db.prepare('UPDATE dimensions SET value=? WHERE id=?').run(stable({ ...k, feedbackId:rid }), k.id);
      return { kid:k.id, rId:rid, r:body, rRevision:live.rRevision + 1 };
    }
    if (command === 'calendar.layout.save') {
      const s = space(db);
      requireRevision(s.revision, input.expectedRevision);
      const inputLayout = input.layout;
      const layout = layoutOf(input.styleOnly ? { ...(s.layout || defaults()), style:inputLayout.style, dense:inputLayout.dense, highlight:inputLayout.highlight } : inputLayout, s.bookkeeping);
      setMeta(db, 'space', { ...s, layout, revision:s.revision + 1 });
      return { layout, revision:s.revision + 1 };
    }
    calendarFault('UNKNOWN_COMMAND', '未知日程操作');
  }
  return { run, apply, goalMetadata, readGoal, allEvents, range };
}
export function compareEvents(a, b) {
  return (a.date || '').localeCompare(b.date || '') || a.time.localeCompare(b.time) || a.id.localeCompare(b.id);
}
