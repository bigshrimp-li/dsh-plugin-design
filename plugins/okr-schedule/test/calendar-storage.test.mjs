import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDomainService } from '../src/host/domain.js';

const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const later = '2099-11-05';
function draft(id) {
  return { id, goal:{ name:'同名空间', about:'合成验收', id:'preview', bookkeeping:true, assistantRule:'只引用当前空间。', ks:[
    { id:'k1', name:'完成复测', standard:'独立完成三项', from:today, to:today }
  ] }, events:[{ id:'e1', oid:'preview', title:'第一项', kind:'练习', date:later, time:'19:30', duration:30 }] };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-calendar-'));
  const domain = createDomainService({ baseDir:root });
  t.after(async () => { await domain.close(); await fs.rm(root, { recursive:true, force:true }); });
  const call = (command, input = {}, oid, extra = {}) => domain.execute(command, input, { trusted:true, userInitiated:true, global:!oid, objectiveId:oid, ...extra });
  async function ok(command, input, oid) {
    const receipt = await call(command, input, oid);
    assert.ok(['read', 'saved'].includes(receipt.kind), JSON.stringify(receipt));
    return receipt.data;
  }
  const create = async id => (await ok('calendar.confirm', { draft:draft(id), confirm:true })).objectiveId;
  async function edit(oid) {
    const { goal, events } = await ok('calendar.space', {}, oid);
    const editable = events.filter(e => e.status === 'plan' && e.date >= today);
    return { id:'edit-' + oid, baseGoal:goal, baseEvents:editable, goal:structuredClone(goal), events:structuredClone(editable) };
  }
  return { root, call, ok, create, edit };
}

test('atomic confirmed drafts, same-name isolation, overlap, idempotency and stale configuration', async t => {
  const { root, call, ok, create, edit } = await fixture(t);
  const broken = draft('bad'); broken.events[0].duration = 0;
  assert.equal((await call('calendar.confirm', { draft:broken, confirm:true })).error.code, 'INVALID_INPUT');
  assert.deepEqual((await ok('calendar.catalog')).spaces, []);
  const oid = await create('first'), other = await create('second');
  assert.notEqual(other, oid);
  assert.equal(await create('first'), oid);
  const baseline = await edit(oid), e = baseline.events[0];
  const layout = { ...baseline.goal.layout, style:'cards', filters:{ ...baseline.goal.layout.filters, query:'藏起来' } };
  await ok('calendar.layout.save', { layout, expectedRevision:baseline.goal.revision }, oid);
  baseline.goal.layout.group = 'week';
  assert.equal((await call('calendar.confirm', { draft:baseline, confirm:true }, oid)).error.code, 'REVISION_CONFLICT');
  const change = await edit(oid);
  change.goal.name = '改名后的空间'; change.goal.ks[0].name = '修正标准';
  change.events.push({ ...e, id:'backToBack', time:'20:00' }, { ...e, id:'overlap', time:'19:45' });
  const k = change.goal.ks[0];
  await ok('calendar.feedback.save', { kid:k.id, r:'第一次反馈', expectedRevision:k.rRevision }, oid);
  await ok('calendar.achievement.save', { kid:k.id, achieved:true, expectedRevision:k.revision }, oid);
  await ok('calendar.execution.save', { event:{ ...e, note:'已完成', measure:'独立答对两题' } }, oid);
  change.events[0].time = '11:00';
  await ok('calendar.confirm', { draft:change, confirm:true, requestId:'commit' }, oid);
  await ok('calendar.confirm', { draft:change, confirm:true, requestId:'commit' }, oid);
  const { goal, events } = await ok('calendar.space', {}, oid);
  assert.equal(goal.name, '改名后的空间');
  assert.equal(goal.ks[0].r, '第一次反馈'); assert.equal(goal.ks[0].achievedOn, today);
  assert.equal(events.length, 3); assert.equal(events.find(v => v.id === 'e1').time, '19:30');
  assert.equal((await ok('calendar.range', { from:later, to:later })).events.length, 4);
  const slots = (await ok('calendar.busy', { dates:[later], excludeIds:['e1', 'overlap', 'backToBack'] }, oid)).slots;
  assert.equal(slots.length, 2); assert.deepEqual(Object.keys(slots[0]).sort(), ['date','duration','time']);
  assert.equal((await ok('calendar.space', {}, other)).goal.name, '同名空间');
  assert.equal((await fs.stat(path.join(root, oid, 'space.sqlite'))).isFile(), true);
  assert.equal((await fs.readFile(path.join(root, oid, 'AGENTS.md'), 'utf8')), '只引用当前空间。');
  assert.equal((await call('calendar.feedback.save', { kid:k.id, r:'无权限', expectedRevision:1 }, oid, { userInitiated:false })).error.code, 'FORBIDDEN');
});

test('single execution, canonical feedback, ledger corrections, export failure and retry', async t => {
  const { root, call, ok, create } = await fixture(t), oid = await create('ledger');
  const posting = { flow:'expense', cents:12000, currency:'CNY' };
  const event = { id:'grocery', oid, title:'买菜', kind:'餐饮', date:today, time:'10:00', posting };
  assert.equal((await call('calendar.ledger.save', { event:{ ...event, date:later } }, oid)).error.code, 'INVALID_INPUT');
  assert.equal((await call('calendar.ledger.save', { event:{ ...event, posting:{ ...posting, cents:0 } } }, oid)).error.code, 'INVALID_INPUT');
  for (const duration of [0, 1441]) assert.equal((await call('calendar.event.save', { event:{ ...event, duration } }, oid)).error.code, 'INVALID_INPUT');
  for (const duration of [1, 1440]) await ok('calendar.event.save', { event:{ ...event, id:'plan' + duration, duration } }, oid);
  const saved = (await ok('calendar.ledger.save', { event, requestId:'receipt-one' }, oid)).event;
  assert.equal(saved.duration, null); assert.equal(saved.occurredAt, saved.start);
  assert.equal(saved.status, 'done'); assert.equal(saved.posting.cents, 12000); assert.equal(saved.kind, '餐饮');
  assert.equal((await ok('calendar.ledger.save', { event, requestId:'receipt-one' }, oid)).event.id, saved.id);
  const corrected = { ...saved, posting:{ flow:'income', cents:600000, currency:'USD' }, note:'合成修订' };
  await ok('calendar.execution.save', { event:corrected }, oid);
  assert.equal((await call('calendar.execution.save', { event:corrected }, oid)).kind, 'conflict');
  let data = await ok('calendar.space', {}, oid);
  assert.equal(data.events.filter(v => v.id === saved.id).length, 1);
  const k = data.goal.ks[0], file = path.join(root, oid, '空间概览.md');
  await fs.rm(file); await fs.mkdir(file);
  const receipt = await ok('calendar.feedback.save', { kid:k.id, r:'第一稿', expectedRevision:k.rRevision }, oid);
  assert.ok(receipt.documentWarning);
  assert.equal((await call('calendar.export', { filename:'空间概览.md' }, oid)).error.code, 'EXPORT_FAILED');
  await fs.rm(file, { recursive:true });
  const updated = await ok('calendar.feedback.save', { kid:k.id, r:'修订', expectedRevision:receipt.rRevision }, oid);
  assert.equal(updated.rId, k.rId);
  const doc = (await ok('calendar.export', { filename:'空间概览.md' }, oid)).content;
  assert.match(doc, /修订/); assert.match(doc, /收入 USD 6000\.00/);
  await fs.writeFile(file, '外部修改');
  assert.equal((await ok('calendar.export', { filename:'空间概览.md' }, oid)).content, doc);
  data = await ok('space.read', {}, oid);
  assert.equal(data.results.length, 1); assert.equal(data.executions.length, 1);
});

test('whole-space deletion is scoped and retryable; confirmed and late drafts cannot resurrect it', async t => {
  const { root, call, ok, create, edit } = await fixture(t), oid = await create('deleted'), other = await create('kept');
  const stale = await edit(oid);
  await fs.writeFile(path.join(root, 'global_index.json'), JSON.stringify({ objectives:[{ id:oid },{ id:other }] }));
  const outside = path.join(root, 'saved-copy.md');
  await fs.copyFile(path.join(root, oid, '空间概览.md'), outside);
  assert.equal((await call('calendar.delete', {}, oid)).kind, 'failed');
  assert.equal((await call('calendar.delete', { confirm:true }, oid, { userInitiated:false })).kind, 'failed');
  await fs.writeFile(path.join(root, 'global_index.json'), '{}');
  assert.equal((await call('calendar.delete', { confirm:true }, oid)).error.code, 'DELETE_PENDING');
  assert.deepEqual((await ok('calendar.catalog')).pendingDeletes, [{ id:oid, name:'同名空间' }]);
  assert.equal((await fs.readdir(root)).includes(oid), false);
  // A neighbor or symlink substituted after a failed cleanup must never be removed.
  await fs.symlink(path.join(root, other), path.join(root, oid));
  assert.equal((await call('calendar.delete', { confirm:true }, oid)).kind, 'failed');
  assert.equal((await ok('calendar.space', {}, other)).goal.name, '同名空间');
  await fs.unlink(path.join(root, oid));
  await fs.writeFile(path.join(root, 'global_index.json'), JSON.stringify({ objectives:[{ id:oid },{ id:other }] }));
  await ok('calendar.delete', { confirm:true }, oid); await ok('calendar.delete', { confirm:true }, oid);
  assert.equal((await call('calendar.confirm', { draft:stale, confirm:true }, oid)).kind, 'failed');
  assert.equal((await call('calendar.confirm', { draft:draft('deleted'), confirm:true })).error.code, 'DELETED');
  assert.deepEqual((await ok('calendar.catalog')).spaces.map(s => s.id), [other]);
  assert.deepEqual((await ok('calendar.catalog')).pendingDeletes, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'global_index.json'), 'utf8')).objectives, [{ id:other }]);
  assert.equal((await fs.stat(outside)).isFile(), true);
  assert.equal((await fs.readdir(root)).includes(oid), false);
  await ok('calendar.delete', { confirm:true }, other);
  assert.deepEqual((await ok('calendar.catalog')).spaces, []);
});

test('legacy calendar is read-only, migration reports incomplete K/R and keeps original files and facts', async t => {
  const { root, call, ok } = await fixture(t);
  const oid = 'O_legacy', dir = path.join(root, oid);
  await fs.mkdir(dir);
  const seed = {
    'meta.json': { id:oid, title:'旧英语空间', timezone:'Asia/Shanghai' },
    'keypoints.json': [{ id:'K_old', title:'英语复习' }],
    'schedules.json': [
      { id:'single', title:'以前的练习', date:'2026-11-01', start_time:'19:30', duration:20, status:'completed', checkin_note:'私密的执行回顾' },
      { id:'recur', title:'每周复测', date:'2026-11-01', start_time:'20:30', duration:15, repeat:'weekly', status:'completed', checkin_note:'无法定位发生日' }
    ],
    'results.json': [{ id:'r1', target_id:'K_old', body:'首份旧成果' }, { id:'r2', target_id:'K_old', body:'另一份旧成果' }, { id:'r3', target_id:oid, body:'旧空间成果' }]
  };
  for (const [name, value] of Object.entries(seed)) await fs.writeFile(path.join(dir, name), JSON.stringify(value));
  const period = { from:'2026-11-01', to:'2026-11-08' };
  let data = await ok('calendar.range', period);
  assert.equal(data.events.length, 3); assert.deepEqual(data.errors, []);
  assert.equal(data.events[0].time, '19:30'); assert.equal(data.events[0].duration, 20);
  assert.equal(data.events.filter(e => e.id === 'recur').every(e => e.status === 'plan'), true);
  assert.doesNotMatch(JSON.stringify(data), /私密|无法定位/);
  assert.deepEqual((await fs.readdir(dir)).sort(), Object.keys(seed).sort());
  const inspection = await ok('space.inspect', {}, oid);
  assert.equal((await call('space.migrate', {}, oid)).error.code, 'MIGRATION_CONFIRMATION_REQUIRED');
  const migration = await ok('space.migrate', { confirmed:true, inspectionHash:inspection.inspectionHash }, oid);
  assert.match(migration.calendarWarnings.join(' '), /缺少期限.*2 条历史反馈.*1 条旧成果/);
  const snapshot = await ok('calendar.space', {}, oid);
  assert.equal(snapshot.goal.ks[0].r, '');
  assert.equal(snapshot.goal.ks[0].from, '');
  const original = await ok('space.read', {}, oid);
  assert.equal(original.executions.length, 2);
  assert.deepEqual(original.results.map(r => r.id), ['r1','r2','r3']);
  for (const [name, value] of Object.entries(seed)) {
    assert.equal(await fs.readFile(path.join(dir, 'migrations', migration.migrationId, name), 'utf8'), JSON.stringify(value));
    assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), JSON.stringify(value));
  }
  data = await ok('calendar.range', period);
  assert.equal(data.events.length, 3); assert.doesNotMatch(JSON.stringify(data), /私密|无法定位/);
  const occurrence = await ok('calendar.event.get', { id:'recur', occurrenceKey:'2026-11-08' }, oid);
  assert.equal(occurrence.event.status, 'plan');
  await ok('calendar.execution.save', { event:{ ...occurrence.event, note:'本次执行' } }, oid);
  assert.equal((await ok('calendar.event.get', { id:'recur', occurrenceKey:'2026-11-01' }, oid)).event.status, 'plan');
  assert.equal((await call('calendar.event.get', { id:'recur', occurrenceKey:'2026-11-03' }, oid)).error.code, 'NOT_FOUND');
  assert.equal((await ok('calendar.catalog')).spaces[0].eventCount, 2);
  const config = { id:'fix-view', goal:{ ...snapshot.goal, assistantRule:'仅本 O' }, baseGoal:snapshot.goal, events:[], baseEvents:[] };
  await ok('calendar.confirm', { draft:config, confirm:true }, oid);
  assert.equal((await ok('space.read', {}, oid)).results.length, 3);
});

test('partial legacy failures leave other goals usable and identify missing schedule data', async t => {
  const { root, call, ok, create } = await fixture(t), oid = await create('good');
  await fs.mkdir(path.join(root, 'O_bad'));
  await fs.writeFile(path.join(root,'O_bad','meta.json'), JSON.stringify({ id:'O_bad',title:'坏日程' }));
  await fs.writeFile(path.join(root,'O_bad','schedules.json'), '{broken');
  await fs.mkdir(path.join(root, 'O_meta'));
  await fs.writeFile(path.join(root,'O_meta','meta.json'), '{broken');
  const data = await ok('calendar.range', { from:later, to:later });
  assert.equal(data.events[0].oid, oid); assert.equal(data.events.length, 1);
  assert.deepEqual(data.errors.map(e => e.objectiveId).sort(), ['O_bad','O_meta']);
  assert.deepEqual((await ok('calendar.range', { from:later, to:later, objectiveIds:[oid] })).errors, []);
  await ok('calendar.delete', { confirm:true }, oid);
  assert.equal((await call('space.create', {}, oid)).error.code, 'DELETED');
});

test('independent workers serialize racing creation, feedback edits, export and a stale post-delete write', async t => {
  const { root, call, ok } = await fixture(t);
  const second = createDomainService({ baseDir:root });
  t.after(() => second.close());
  const concurrent = (command, input, oid) => second.execute(command, input, { trusted:true, userInitiated:true, objectiveId:oid, global:!oid });
  const createInput = { draft:draft('doubleclick'), confirm:true };
  const created = await Promise.all([call('calendar.confirm', createInput), concurrent('calendar.confirm', createInput)]);
  assert.ok(created.every(r => r.kind === 'saved'), JSON.stringify(created));
  const oid = created[0].data.objectiveId;
  assert.equal(created[1].data.objectiveId, oid);
  const k = (await ok('calendar.space', {}, oid)).goal.ks[0];
  const saved = await Promise.all([call('calendar.feedback.save', { kid:k.id, r:'窗口一', expectedRevision:k.rRevision }, oid),
    concurrent('calendar.feedback.save', { kid:k.id, r:'窗口二', expectedRevision:k.rRevision }, oid)]);
  assert.deepEqual(saved.map(r => r.kind).sort(), ['conflict', 'saved']);
  const winner = saved.find(r => r.kind === 'saved').data;
  const doc = await concurrent('calendar.export', { filename:'空间概览.md' }, oid);
  assert.match(doc.data.content, new RegExp(winner.r));
  assert.equal((await ok('calendar.space', {}, oid)).goal.dataRevision, 2);
  const expected = k.revision;
  await ok('calendar.achievement.save', { kid:k.id, achieved:true, expectedRevision:expected, timeZone:'Pacific/Kiritimati' }, oid);
  const marked = (await ok('calendar.space', {}, oid)).goal.ks[0];
  const day = new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit', timeZone:'Pacific/Kiritimati' }).format(new Date());
  assert.equal(marked.achievedOn, day);
  await ok('calendar.achievement.save', { kid:k.id, achieved:false, expectedRevision:marked.revision }, oid);
  assert.equal((await ok('calendar.space', {}, oid)).goal.ks[0].r, winner.r);
  await ok('calendar.delete', { confirm:true }, oid);
  assert.equal((await concurrent('host.state.set', { namespace:'calendar-assistant', key:'sessions', value:{}, expectedRevision:0 }, oid)).error.code, 'DELETED');
  assert.equal((await concurrent('calendar.execution.save', { event:{ id:'e1', note:'迟到回执' } }, oid)).error.code, 'DELETED');
  assert.deepEqual((await ok('calendar.catalog')).spaces, []);
});
