import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDomainService } from '../src/host/domain.js';

const host = objectiveId => ({ objectiveId, trusted: true, sourceScope: 'private' });
const noteType = { id: 'note', fields: [{ id: 'content', kind: 'text', required: true }, { id: 'date', kind: 'date' }] };
const trainingType = { id: 'training', fields: [{ id: 'distance', kind: 'decimal', precision: 2, unit: 'km', required: true }, { id: 'duration', kind: 'integer', min: 1, required: true }, { id: 'date', kind: 'date' }] };
async function fixture(t) {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-storage-home-'));
  const baseDir = path.join(temporaryHome, '.dsh_okr');
  const domain = createDomainService({ baseDir });
  t.after(async () => { await domain.close(); await fs.rm(temporaryHome, { recursive: true, force: true }); });
  assert.equal((await domain.capabilities()).worker, true);
  return { domain, baseDir };
}
async function run(domain, command, input, objectiveId = 'O_learning', extra = {}) {
  const result = await domain.execute(command, input, { ...host(objectiveId), ...extra });
  assert.notEqual(result.error?.code, 'STORAGE_ERROR', JSON.stringify(result));
  return result;
}
async function create(domain, objectiveId = 'O_learning', types = [noteType, trainingType]) { const result = await run(domain, 'space.create', { title: '合成空间', types }, objectiveId); assert.equal(result.kind, 'saved', JSON.stringify(result)); }

test('SQLite worker persists records, scopes every operation, and deduplicates committed requests', async t => {
  const { domain, baseDir } = await fixture(t);
  await create(domain);
  await create(domain, 'O_other');
  const input = { typeId: 'note', title: '学习笔记', fields: { content: '真实合成内容' }, requestId: 'record-one' };
  const saved = await run(domain, 'item.save', input);
  assert.equal(saved.kind, 'saved');
  assert.deepEqual(await run(domain, 'item.save', input), saved);
  assert.equal((await run(domain, 'item.save', { ...input, title: '不同输入' })).kind, 'conflict');
  assert.equal((await run(domain, 'item.save', { ...input, requestId: 'record-two' })).kind, 'saved');
  assert.equal((await run(domain, 'item.save', { typeId: 'note', objectiveId: 'O_other', fields: { content: '越界' } })).error.code, 'FORBIDDEN');
  assert.equal((await run(domain, 'space.read', {}, 'O_other')).data.items.length, 0);
  assert.equal((await run(domain, 'space.read', {}, '../escape')).error.code, 'FORBIDDEN');
  const second = createDomainService({ baseDir });
  try { assert.equal((await second.execute('space.read', {}, host('O_learning'))).data.items.length, 2); } finally { await second.close(); }
  assert.ok((await fs.stat(path.join(baseDir, 'O_learning', 'space.sqlite'))).isFile());
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(baseDir, 'O_learning', 'space.sqlite'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(baseDir, 'O_learning'))).mode & 0o777, 0o700);
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-storage-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(baseDir, 'O_link'));
  assert.equal((await run(domain, 'space.create', {}, 'O_link')).error.code, 'INVALID_PATH');
});

test('learning and training follow declared rules, pending completion, exact statistics and optimistic revisions', async t => {
  const { domain } = await fixture(t);
  await create(domain);
  const pending = await run(domain, 'item.save', { typeId: 'training', title: '跑步', fields: { distance: '5.00' } });
  assert.equal(pending.kind, 'pending');
  assert.deepEqual(pending.data.missing, ['duration']);
  const unsupported = await run(domain, 'item.save', { typeId: 'not-enabled', fields: {} });
  assert.equal(unsupported.kind, 'unsupported');
  assert.equal((await run(domain, 'space.read', {})).data.items.length, 0);
  const completed = await run(domain, 'material.complete', { materialId: pending.data.materialId, fields: { duration: 35 } });
  assert.equal(completed.kind, 'saved');
  const again = await run(domain, 'material.complete', { materialId: pending.data.materialId, fields: { duration: 35 } });
  assert.equal(again.data.itemId, completed.data.itemId);
  await run(domain, 'item.save', { typeId: 'training', fields: { distance: '0.10', duration: 2, date: '2026-10-01' } });
  await run(domain, 'item.save', { typeId: 'training', fields: { distance: '0.20', duration: 3, date: '2026-10-02' } });
  const stats = await run(domain, 'items.query', { typeId: 'training', dateField: 'date', granularity: 'month', aggregate: { field: 'distance', operation: 'sum' } });
  assert.equal(stats.data.aggregate.groups[0].value, '0.30');
  assert.equal(stats.data.excludedCount, 1);
  assert.equal((await run(domain, 'items.query', { typeId: 'training' })).data.total, 3);
  assert.equal((await run(domain, 'item.save', { typeId: 'note', fields: { content: '日期可空' } })).kind, 'saved');
  assert.equal((await run(domain, 'item.save', { typeId: 'note', fields: { content: '坏日期', date: '2026-02-30' } })).error.code, 'INVALID_FIELD');
  const updates = await Promise.all([1, 2].map(value => run(domain, 'item.update', { itemId: completed.data.itemId, expectedRevision: 1, title: `更新${value}` })));
  assert.deepEqual(updates.map(value => value.kind).sort(), ['conflict', 'saved']);
  assert.equal((await run(domain, 'space.read', {})).data.pending_materials.length, 0);
});

test('category references remain separate from dimensions and old type versions remain immutable', async t => {
  const { domain } = await fixture(t);
  const type = { id: 'material', fields: [{ id: 'category', kind: 'category', categoryTableId: 'topics' }, { id: 'related', kind: 'reference' }] };
  await create(domain, 'O_learning', [noteType, type]);
  await run(domain, 'dimension.save', { id: 'K_reading', title: '阅读' });
  await run(domain, 'categories.save', { tableId: 'topics', categories: [{ id: 'paper', title: '论文' }] });
  const note = await run(domain, 'item.save', { typeId: 'note', fields: { content: '同空间引用' } });
  const saved = await run(domain, 'item.save', { typeId: 'material', mainKId: 'K_reading', fields: { category: 'paper', related: note.data.itemId } });
  assert.equal(saved.kind, 'saved');
  await run(domain, 'categories.save', { tableId: 'topics', categories: [{ id: 'paper', title: '研究论文' }] });
  assert.equal((await run(domain, 'space.read', {})).data.items.find(item => item.id === saved.data.itemId).fieldVersions.category.title, '论文');
  assert.equal((await run(domain, 'categories.save', { tableId: 'topics', categories: [{ id: 'cycle', parentId: 'cycle' }] })).error.code, 'INVALID_REFERENCE');
  assert.equal((await run(domain, 'item.save', { typeId: 'material', fields: { category: 'K_reading' } })).error.code, 'INVALID_REFERENCE');
  const changed = { ...type, fields: [...type.fields, { id: 'content', kind: 'text', required: true }] };
  assert.equal((await run(domain, 'types.set', { types: [noteType, changed] })).error.code, 'IMMUTABLE_TYPE');
  assert.equal((await run(domain, 'types.set', { types: [noteType, { ...changed, version: '2' }] })).kind, 'saved');
  const after = await run(domain, 'space.read', {});
  assert.equal(after.data.items.find(item => item.id === saved.data.itemId).typeVersion, '1');
  assert.equal(after.data.items.find(item => item.id === saved.data.itemId).fields.category, 'paper');
});

test('actions distinguish scheduled time, recurring executions and archived facts from R reassessment', async t => {
  const { domain } = await fixture(t);
  await create(domain);
  const item = await run(domain, 'item.save', { typeId: 'note', title: '阅读行动', fields: { content: '每周阅读' } });
  const itemId = item.data.itemId;
  await run(domain, 'action.save', { itemId, schedule: { date: '2026-10-27', recurrence: 'weekly' } });
  assert.equal((await run(domain, 'execution.save', { itemId })).kind, 'pending');
  const first = await run(domain, 'execution.save', { itemId, occurrenceKey: '2026-10-27', state: 'completed', note: '已读' });
  const replay = await run(domain, 'execution.save', { itemId, occurrenceKey: '2026-10-27', state: 'completed', note: '已读' });
  assert.equal(first.data.executionId, replay.data.executionId);
  await run(domain, 'execution.save', { itemId, occurrenceKey: '2026-11-03', state: 'skipped' });
  assert.equal((await run(domain, 'space.read', {})).data.executions.length, 2);
  assert.equal((await run(domain, 'space.read', {})).data.actions[0].state, 'pending');
  await run(domain, 'space.archive', {});
  assert.equal((await run(domain, 'item.update', { itemId, title: '不得修改', expectedRevision: 1 })).error.code, 'ARCHIVED');
  assert.equal((await run(domain, 'item.save', { typeId: 'note', fields: { content: '归档新输入' } })).kind, 'pending');
  assert.equal((await run(domain, 'item.save', { typeId: 'not-enabled' })).kind, 'unsupported');
  assert.equal((await run(domain, 'result.save', { body: '阶段追评', evidence: [itemId] })).kind, 'saved');
  assert.equal((await run(domain, 'result.save', { body: '执行依据', evidence: [first.data.executionId] })).kind, 'saved');
  await run(domain, 'space.restore', {});
  assert.equal((await run(domain, 'space.read', {})).data.actions[0].schedule.enabled, false);
  assert.equal((await run(domain, 'space.read', {})).data.results.length, 2);
});

test('calendar projects bounded daily, weekly and monthly schedules with timezone clocks without creating facts', async t => {
  const { domain } = await fixture(t);
  await create(domain);
  const addAction = async (title, schedule) => {
    const item = await run(domain, 'item.save', { typeId: 'note', title, fields: { content: title } });
    assert.equal((await run(domain, 'action.save', { itemId: item.data.itemId, schedule })).kind, 'saved');
    return item.data.itemId;
  };
  const daily = await addAction('每日行动', { date: '2026-10-27', recurrence: 'daily' });
  const weekly = await addAction('每周行动', { date: '2026-10-27', recurrence: 'weekly' });
  const monthly = await addAction('月底行动', { date: '2026-01-31', recurrence: { freq: 'monthly', count: 2 } });
  const timed = await addAction('跨夏令时行动', { start: '2026-03-07T09:00:00-05:00', end: '2026-03-07T10:00:00-05:00', timezone: 'America/New_York', recurrence: 'daily' });
  await run(domain, 'item.save', { typeId: 'note', title: '普通记录不进入日历', fields: { content: '事实', date: '2026-10-28' } });
  const future = await run(domain, 'calendar.query', { from: '2026-10-28', to: '2026-10-30' });
  assert.deepEqual(future.data.occurrences.filter(value => value.itemId === daily).map(value => value.date), ['2026-10-28', '2026-10-29', '2026-10-30']);
  const weeks = await run(domain, 'calendar.query', { from: '2026-11-01', to: '2026-11-15' });
  assert.deepEqual(weeks.data.occurrences.filter(value => value.itemId === weekly).map(value => value.date), ['2026-11-03', '2026-11-10']);
  const months = await run(domain, 'calendar.query', { from: '2026-01-01', to: '2026-05-31' });
  assert.deepEqual(months.data.occurrences.filter(value => value.itemId === monthly).map(value => value.date), ['2026-01-31', '2026-03-31']);
  const clocks = await run(domain, 'calendar.query', { from: '2026-03-07', to: '2026-03-09' });
  assert.deepEqual(clocks.data.occurrences.filter(value => value.itemId === timed).map(value => value.start), ['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z']);
  assert.equal((await run(domain, 'space.read', {})).data.executions.length, 0);
  assert.equal((await run(domain, 'calendar.query', { from: '2026-01-01', to: '2027-01-02' })).error.code, 'INVALID_INPUT');
  assert.equal((await run(domain, 'action.save', { itemId: daily, expectedRevision: 1, schedule: { date: '2026-10-27', recurrence: 'unsupported' } })).error.code, 'UNSUPPORTED_RECURRENCE');
  await run(domain, 'space.archive', {});
  assert.equal((await run(domain, 'calendar.query', { from: '2026-10-27', to: '2026-11-10' })).data.occurrences.length, 0);
  await run(domain, 'space.restore', {});
  assert.equal((await run(domain, 'calendar.query', { from: '2026-10-27', to: '2026-11-10' })).data.occurrences.length, 0);
});

test('selected-space migration preserves old IDs and unknown values with hashed backups, isolated corruption and re-entry', async t => {
  const { domain, baseDir } = await fixture(t);
  const directory = path.join(baseDir, 'O_legacy');
  await fs.mkdir(directory, { recursive: true });
  const files = {
    'meta.json': { id: 'O_legacy', title: '旧合成空间', is_archived: true, custom: { untouched: 7 } },
    'keypoints.json': [{ id: 'K_old', title: '旧方向', is_archived: true }],
    'schedules.json': [{ id: 'SCH_old', keypoint_id: 'K_old', title: '周期行动', date: '2026-10-27', repeat: 'daily', status: 'completed', checkin_note: '仅有一次已知结果', extension: '保留' }],
    'inspirations.json': [{ id: 'INS_old', text: '想法', date: '2026-10-26' }],
    'results.json': [{ id: 'R_old', target_id: 'K_old', body: '阶段结果' }]
  };
  const originals = {};
  for (const [name, value] of Object.entries(files)) { originals[name] = JSON.stringify(value); await fs.writeFile(path.join(directory, name), originals[name]); }
  const inspect = await run(domain, 'space.inspect', {}, 'O_legacy');
  assert.equal(inspect.kind, 'read');
  await assert.rejects(fs.stat(path.join(directory, 'space.sqlite')), { code: 'ENOENT' });
  assert.equal((await run(domain, 'space.create', {}, 'O_legacy')).error.code, 'MIGRATION_REQUIRED');
  assert.equal((await run(domain, 'space.migrate', {}, 'O_legacy')).error.code, 'MIGRATION_CONFIRMATION_REQUIRED');
  const migrated = await run(domain, 'space.migrate', { confirmed: true, inspectionHash: inspect.data.inspectionHash }, 'O_legacy');
  assert.equal(migrated.kind, 'saved', JSON.stringify(migrated));
  assert.equal((await run(domain, 'space.migrate', {}, 'O_legacy')).data.alreadyMigrated, true);
  const read = await run(domain, 'space.read', {}, 'O_legacy');
  assert.equal(read.data.space.lifecycle, 'formal');
  assert.ok(read.data.space.archivedAt);
  assert.ok(read.data.key_points[0].archivedAt);
  assert.equal(read.data.items.find(item => item.id === 'SCH_old').legacy_payload.extension, '保留');
  assert.equal(read.data.executions.length, 1);
  assert.equal(read.data.results[0].id, 'R_old');
  for (const [name, original] of Object.entries(originals)) {
    assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), original);
    const backup = await fs.readFile(path.join(directory, 'migrations', migrated.data.migrationId, name));
    assert.equal(createHash('sha256').update(backup).digest('hex'), inspect.data.files[name].sha256);
  }
  await fs.mkdir(path.join(baseDir, 'O_broken'));
  await fs.writeFile(path.join(baseDir, 'O_broken', 'meta.json'), '{broken');
  const listed = await domain.execute('spaces.list', {}, { trusted: true, global: true });
  assert.equal(listed.data.spaces.some(space => space.objectiveId === 'O_legacy'), true);
  assert.equal(listed.data.errors.find(error => error.objectiveId === 'O_broken').code, 'CORRUPT_JSON');
  assert.equal((await run(domain, 'space.read', {}, 'O_legacy')).data.items.length, 2);
  await fs.mkdir(path.join(baseDir, 'O_metadata_only'));
  await fs.writeFile(path.join(baseDir, 'O_metadata_only', 'meta.json'), JSON.stringify({ id: 'O_metadata_only', title: '仅元数据目录' }));
  await fs.writeFile(path.join(baseDir, 'O_metadata_only', 'schedules.json'), '{broken business file');
  assert.equal((await domain.execute('spaces.list', {}, { trusted: true, global: true })).data.spaces.some(value => value.objectiveId === 'O_metadata_only'), true);
});

test('host activation and state CAS are atomic, stale contexts cannot commit, and groups have their own database', async t => {
  const { domain, baseDir } = await fixture(t);
  await create(domain);
  await run(domain, 'host.state.set', { namespace: 'drafts', key: 'first', value: { status: 'draft' }, expectedRevision: 0 });
  const conflict = await run(domain, 'host.state.commit', { activeBundleId: 'v1', types: [noteType], updates: [{ namespace: 'drafts', key: 'first', value: { status: 'confirmed' }, expectedRevision: 0 }] });
  assert.equal(conflict.kind, 'conflict');
  assert.equal((await run(domain, 'space.read', {})).data.space.activeBundleId, null);
  assert.equal((await run(domain, 'host.state.commit', { expectedBundleId: null, activeBundleId: 'v1', types: [noteType], updates: [{ namespace: 'drafts', key: 'first', value: { status: 'confirmed' }, expectedRevision: 1 }] })).kind, 'saved');
  assert.equal((await run(domain, 'item.save', { typeId: 'note', fields: { content: '旧版本禁止写' } }, 'O_learning', { bundleId: 'old' })).kind, 'conflict');
  const task = { runId: 'run-one', contextGeneration: 1, phase: 'running', lease: { expiresAt: Date.now() + 60_000 } };
  await run(domain, 'runtime.store', { key: 'bot', expectedRevision: 0, value: { tasks: { task: task } } }, 'O_learning', { sourceScope: 'bot' });
  const fence = { taskId: 'task', runId: 'run-one', contextGeneration: 1 };
  assert.equal((await run(domain, 'item.save', { typeId: 'note', fields: { content: '有效上下文' } }, 'O_learning', { contextFence: fence })).kind, 'saved');
  await run(domain, 'runtime.store', { key: 'bot', expectedRevision: 1, value: { tasks: { task: { ...task, contextGeneration: 2 } } } }, 'O_learning', { sourceScope: 'bot' });
  assert.equal((await run(domain, 'item.save', { typeId: 'note', fields: { content: '旧上下文不能写' } }, 'O_learning', { contextFence: fence })).error.code, 'STALE_CONTEXT');
  const longState = await run(domain, 'runtime.store', { key: 'long-history', expectedRevision: 0, value: { transcript: '长'.repeat(100_000) } }, 'O_learning', { sourceScope: 'bot' });
  assert.equal(longState.kind, 'saved');
  assert.equal(longState.data.value, undefined);
  const groupBinding = { trusted: true, groupId: 'general' };
  assert.equal((await domain.execute('group.state.set', { key: 'conversation', expectedRevision: 0, value: { messages: [] } }, groupBinding)).kind, 'saved');
  assert.equal((await domain.execute('group.state.get', { key: 'conversation' }, groupBinding)).data.revision, 1);
  assert.ok((await fs.stat(path.join(baseDir, 'groups', 'general', 'group.sqlite'))).isFile());
  assert.equal((await domain.execute('spaces.list', {}, { trusted: true, global: true })).data.spaces.length, 1);
});

test('trial provenance cannot become formal implicitly and batch changes require an exact confirmed plan', async t => {
  const { domain } = await fixture(t);
  await create(domain);
  const trialBinding = { executionScope: 'trial', types: [noteType], provenance: 'real' };
  const formal = await run(domain, 'item.save', { typeId: 'note', fields: { content: '正式事实不受试用影响' } });
  for (const [command, input] of [['item.update', { itemId: formal.data.itemId, expectedRevision: 1, title: '试用不能改标题' }], ['action.save', { itemId: formal.data.itemId }], ['execution.save', { itemId: formal.data.itemId }], ['result.save', { body: '试用不能写R' }], ['space.archive', {}], ['categories.save', { categories: [{ id: 'unsafe' }] }]]) assert.equal((await run(domain, command, input, 'O_learning', trialBinding)).error.code, 'TRIAL_WRITE_FORBIDDEN');
  const unchanged = (await run(domain, 'space.read', {})).data;
  assert.equal(unchanged.items[0].revision, 1);
  assert.equal(unchanged.space.archivedAt, null);
  assert.equal(unchanged.actions.length + unchanged.results.length + unchanged.categories.length, 0);
  const real = await run(domain, 'trial.save', { draftId: 'draft', typeId: 'note', fields: { content: '真实试用' } }, 'O_learning', trialBinding);
  const demo = await run(domain, 'trial.save', { draftId: 'draft', typeId: 'note', fields: { content: '演示' } }, 'O_learning', { ...trialBinding, provenance: 'demo' });
  assert.equal(real.kind, 'trial');
  assert.equal(real.data.trialRecordId, real.data.trialId);
  assert.equal(demo.kind, 'trial');
  const routedTrial = await run(domain, 'item.save', { draftId: 'other-draft', typeId: 'note', fields: { content: '统一记录入口的草稿试用' } }, 'O_learning', { ...trialBinding, provenance: 'demo' });
  assert.equal(routedTrial.kind, 'trial');
  assert.equal(routedTrial.data.provenance, 'demo');
  assert.equal((await run(domain, 'space.read', {})).data.items.length, 1);
  assert.equal((await run(domain, 'trial.promote', { trialId: demo.data.trialId })).error.code, 'DEMO_NOT_TRANSFERABLE');
  const promoted = await run(domain, 'trial.promote', { trialId: real.data.trialId });
  assert.equal(promoted.kind, 'saved');
  assert.equal((await run(domain, 'trial.promote', { trialId: real.data.trialId })).data.itemId, promoted.data.itemId);
  const unselected = await run(domain, 'trial.save', { draftId: 'draft', typeId: 'note', fields: { content: '未选中真实试用' } }, 'O_learning', trialBinding);
  await run(domain, 'trial.finalize', { draftId: 'draft', selectedTrialIds: [real.data.trialId] });
  await run(domain, 'trial.finalize', { draftId: 'draft', selectedTrialIds: [real.data.trialId] });
  const pending = (await run(domain, 'space.read', {})).data.pending_materials;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].trialId, unselected.data.trialId);
  const complete = await run(domain, 'material.complete', { materialId: pending[0].id });
  assert.equal((await run(domain, 'trial.promote', { trialId: unselected.data.trialId })).data.itemId, complete.data.itemId);
  const second = await run(domain, 'item.save', { typeId: 'note', fields: { content: '另一个事项' } });
  const changes = [{ itemId: promoted.data.itemId, expectedRevision: 1, title: '修改1' }, { itemId: second.data.itemId, expectedRevision: 2, title: '修改2' }];
  assert.equal((await run(domain, 'items.batch', { changes, planHash: 'approved' })).error.code, 'CONFIRMATION_REQUIRED');
  assert.equal((await run(domain, 'items.batch', { changes, planHash: 'approved' }, 'O_learning', { confirmationPlanHash: 'approved' })).kind, 'conflict');
  assert.equal((await run(domain, 'space.read', {})).data.items.find(item => item.id === promoted.data.itemId).revision, 1);
  changes[1].expectedRevision = 1;
  assert.equal((await run(domain, 'items.batch', { changes, planHash: 'approved' }, 'O_learning', { confirmationPlanHash: 'approved' })).kind, 'saved');
  assert.equal((await run(domain, 'space.read', {})).data.items.filter(item => changes.some(change => change.itemId === item.id)).every(item => item.revision === 2), true);
});
