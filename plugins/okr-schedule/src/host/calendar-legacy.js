import fs from 'node:fs';
import { calendarFault } from './calendar-records.js';

// A time-only legacy field refers to the schedule date in the owning O's time zone.
function legacyTimestamp(value, date, timezone, zonedTimestamp) {
  if (!value) return null;
  if (typeof value !== 'string') return 'invalid';
  if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const midnight = new Date(date + 'T00:00:00Z');
    if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) return 'invalid';
    const [hour, minute, second = 0] = value.split(':').map(Number);
    return zonedTimestamp(date, { hour, minute, second }, timezone) || 'invalid';
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) return value;
  return 'invalid';
}
export function legacySchedule(row, timezone, zonedTimestamp) {
  const start = legacyTimestamp(row.start_time || row.start, row.date, timezone, zonedTimestamp);
  let end = legacyTimestamp(row.end_time || row.end, row.date, timezone, zonedTimestamp);
  const duration = row.duration_minutes ?? row.duration;
  if (!end && start && start !== 'invalid' && Number.isInteger(duration) && duration > 0) end = new Date(Date.parse(start) + duration * 60000).toISOString();
  const recurrence = row.repeat || row.recurrence || row.recurrence_rule || row.repeat_rule || null;
  return { date:row.date || null, start, end, timezone, recurrence: recurrence === 'none' ? null : recurrence,
    recurring:!!(row.is_recurring || row.type === 'recurring' || /^SCH_REC_/i.test(row.id)), enabled:!row.archived_at && !row.is_archived && !row.archived };
}

// Only the schedule file is read here. Private notes, results and old backup directories
// are unnecessary to render the calendar. Viewing never creates or migrates a database.
export function readLegacyRange(context, s, period, core) {
  const file = context.safeFile(context.safeSpace(s.id), 'schedules.json');
  let rows = [];
  if (fs.existsSync(file)) {
    try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { calendarFault('CORRUPT_JSON', '旧空间的日程文件无法读取'); }
  }
  if (!Array.isArray(rows)) calendarFault('CORRUPT_JSON', '旧空间的日程列表格式无效');
  const byId = new Map();
  const schedules = rows.map(row => {
    if (!row || !core.validId(row.id) || byId.has(row.id) || (row.objective_id && row.objective_id !== s.id)) calendarFault('INVALID_REFERENCE', '旧日程标识重复或归属不符');
    byId.set(row.id, row);
    return { id:row.id, title:row.title || row.name || row.id, schedule:legacySchedule(row, s.timezone, core.zonedTimestamp) };
  });
  const events = [];
  let data;
  do {
    data = core.projectCalendar(s, schedules, { ...period, offset:events.length, limit:2000 }).data;
    for (const occurrence of data.occurrences) {
      const row = byId.get(occurrence.itemId);
      events.push({ id:row.id, oid:s.id, date:occurrence.date, title:occurrence.title,
        start:occurrence.start, time:occurrence.start ? new Intl.DateTimeFormat('en-GB', { hour:'2-digit', minute:'2-digit', hourCycle:'h23', timeZone:s.timezone }).format(new Date(occurrence.start)) : '',
        duration:occurrence.end && occurrence.start ? (Date.parse(occurrence.end) - Date.parse(occurrence.start)) / 60000 : null,
        status:!occurrence.recurring && row.status === 'completed' ? 'done' : 'plan', kind:row.kind || '日程',
        occurrenceKey:occurrence.occurrenceKey, recurring:occurrence.recurring, legacy:true, readOnly:true });
    }
  } while (data.hasMore);
  return { events, errors:data.unsupported.map(e => ({ ...e, objectiveId:s.id })) };
}
