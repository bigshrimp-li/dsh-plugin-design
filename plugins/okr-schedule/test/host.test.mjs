import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apply, registerLegacyTools, createLegacyStore } from '../index.js';

const now = () => new Date('2026-10-26T17:30:00Z');
const hasCode = code => error => error.code === code;
async function fixture(t, objectives = [{ id: 'O_fixture', timezone: 'Asia/Shanghai' }]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-plugin-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const baseDir = path.join(home, '.dsh_okr');
  await fs.mkdir(baseDir);
  await fs.writeFile(path.join(baseDir, 'global_index.json'), JSON.stringify({ objectives }));
  for (const objective of objectives) {
    await fs.mkdir(path.join(baseDir, objective.id), { recursive: true });
    await fs.writeFile(path.join(baseDir, objective.id, 'meta.json'), JSON.stringify(objective));
  }
  const store = createLegacyStore({ baseDir, now });
  const tools = new Map();
  registerLegacyTools({ tools: { register(tool) { tools.set(tool.name, tool); } } }, store);
  return { home, baseDir, store, tools,
    write: (id, file, value) => fs.writeFile(path.join(baseDir, id, file), JSON.stringify(value)),
    load: async (id, file) => JSON.parse(await fs.readFile(path.join(baseDir, id, file), 'utf8')) };
}

test('compatibility tools use temporary HOME and render only actual saved receipts', async t => {
  const f = await fixture(t);
  await f.write('O_fixture', 'schedules.json', [{ id: 'SCH_fixture', date: '2026-10-27', status: 'pending' }]);
  const tools = new Map();
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = f.home;
    apply({ tools: { register(tool) { tools.set(tool.name, tool); } } });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.deepEqual([...tools.keys()], ['okr_schedule_query', 'okr_schedule_checkin', 'okr_inspiration_capture']);
  const query = await tools.get('okr_schedule_query').execute({ date: '2026-10-27', objective_id: 'O_fixture' });
  assert.equal(query.success, true);
  assert.equal(query.schedules.length, 1);
  const checked = await tools.get('okr_schedule_checkin').execute({ schedule_id: 'SCH_fixture', note: 'Fixture note' });
  assert.equal(checked.success, true);
  assert.equal((await f.load('O_fixture', 'schedules.json'))[0].status, 'completed');
  assert.match(tools.get('okr_schedule_checkin').output.render({}, checked)[0].text, /^打卡成功/);
  const captured = await tools.get('okr_inspiration_capture').execute({ objective_id: 'O_fixture', inspiration: 'Fixture thought' });
  assert.equal(captured.success, true);
  assert.equal((await f.load('O_fixture', 'inspirations.json'))[0].id, captured.inspiration.id);
  assert.match(tools.get('okr_inspiration_capture').output.render({}, captured)[0].text, new RegExp(captured.inspiration.id));
  for (const name of ['okr_schedule_checkin', 'okr_inspiration_capture']) {
    const failed = await tools.get(name).execute({ schedule_id: 'missing', objective_id: 'missing', inspiration: 'text' });
    assert.equal(failed.success, false);
    assert.doesNotMatch(tools.get(name).output.render({}, failed)[0].text, /打卡成功|灵感已记录/);
  }
});

test('scoped query reads only requested O; today respects each space timezone', async t => {
  const f = await fixture(t, [{ id: 'O_east', timezone: 'Asia/Shanghai' }, { id: 'O_west', timezone: 'America/Los_Angeles' }]);
  await f.write('O_east', 'keypoints.json', [{ id: 'K_east' }]);
  await f.write('O_east', 'schedules.json', [{ id: 'east_today', date: '2026-10-27' }, { id: 'east_yesterday', date: '2026-10-26' }]);
  await f.write('O_west', 'keypoints.json', [{ id: 'K_west' }]);
  await f.write('O_west', 'schedules.json', [{ id: 'west_today', date: '2026-10-26' }]);
  const east = await f.store.query({ objectiveId: 'O_east' });
  assert.deepEqual(east.objectives.map(item => item.id), ['O_east']);
  assert.deepEqual(east.key_points.map(item => item.id), ['K_east']);
  assert.deepEqual(east.schedules.map(item => item.id), ['east_today']);
  assert.deepEqual((await f.store.query()).schedules.map(item => item.id), ['east_today', 'west_today']);
  assert.equal((await f.store.query({ objectiveId: 'O_east', allDates: true })).schedules.length, 2);
  await fs.writeFile(path.join(f.baseDir, 'O_west', 'meta.json'), '{bad');
  assert.equal((await f.store.query({ objectiveId: 'O_east' })).success, true);
  await assert.rejects(f.store.query({ date: '2026-02-30' }), hasCode('INVALID_DATE'));
  await assert.rejects(f.store.query({ date: '2026-10-27', allDates: true }), hasCode('INVALID_ARGUMENT'));
});

test('damaged O is explicit and isolated instead of erasing all data', async t => {
  const f = await fixture(t, [{ id: 'O_good' }, { id: 'O_bad' }]);
  await f.write('O_good', 'schedules.json', [{ id: 'good', date: '2026-10-27' }]);
  await fs.writeFile(path.join(f.baseDir, 'O_bad', 'schedules.json'), 'not-json');
  const all = await f.store.query({ allDates: true });
  assert.equal(all.success, false);
  assert.deepEqual(all.objectives.map(item => item.id), ['O_good']);
  assert.deepEqual(all.errors, [{ objective_id: 'O_bad', code: 'INVALID_JSON', message: 'schedules.json 不是有效 JSON' }]);
  await assert.rejects(f.store.read({ objectiveId: 'O_bad' }), hasCode('INVALID_JSON'));
  await assert.rejects(f.store.checkin({ scheduleId: 'good' }), hasCode('INCOMPLETE_DATA'));
  assert.equal((await f.store.checkin({ scheduleId: 'good', objectiveId: 'O_good' })).success, true);
});

test('invalid timezone is isolated globally and explicit when scoped', async t => {
  const f = await fixture(t, [{ id: 'O_good', timezone: 'Asia/Shanghai' }, { id: 'O_bad', timezone: 'not-a-zone' }]);
  await f.write('O_good', 'schedules.json', [{ id: 'good', date: '2026-10-27' }]);
  await f.write('O_bad', 'schedules.json', [{ id: 'bad', date: '2026-10-27' }]);
  const result = await f.store.query();
  assert.equal(result.success, false);
  assert.deepEqual(result.schedules.map(item => item.id), ['good']);
  assert.equal(result.errors[0].code, 'INVALID_TIMEZONE');
  await assert.rejects(f.store.query({ objectiveId: 'O_bad' }), hasCode('INVALID_TIMEZONE'));
});

test('traversal and symlinks cannot read or modify destination data', async t => {
  const f = await fixture(t);
  const external = path.join(f.home, 'outside');
  await fs.mkdir(external);
  const destination = path.join(external, 'schedules.json');
  const raw = JSON.stringify([{ id: 'outside', status: 'pending' }]);
  await fs.writeFile(destination, raw);
  await assert.rejects(f.store.read({ objectiveId: '../outside' }), hasCode('INVALID_ID'));
  await fs.symlink(destination, path.join(f.baseDir, 'O_fixture', 'schedules.json'));
  await assert.rejects(f.store.checkin({ scheduleId: 'outside', objectiveId: 'O_fixture' }), hasCode('UNSAFE_PATH'));
  assert.equal(await fs.readFile(destination, 'utf8'), raw);
  await fs.unlink(path.join(f.baseDir, 'O_fixture', 'schedules.json'));
  await fs.rm(path.join(f.baseDir, 'O_fixture'), { recursive: true });
  await fs.symlink(external, path.join(f.baseDir, 'O_fixture'));
  await assert.rejects(f.store.capture({ objectiveId: 'O_fixture', inspiration: 'blocked' }), hasCode('UNSAFE_PATH'));
  assert.deepEqual(await fs.readdir(external), ['schedules.json']);
});

test('archived O/K and recurring schedules reject writes with no changes', async t => {
  const f = await fixture(t, [{ id: 'O_archived', is_archived: true }, { id: 'O_active' }]);
  await f.write('O_archived', 'schedules.json', [{ id: 'archived' }]);
  await f.write('O_active', 'keypoints.json', [{ id: 'K_archived', is_archived: true }]);
  const schedules = [
    { id: 'archived_k', key_point_id: 'K_archived', status: 'pending' },
    { id: 'SCH_REC_legacy', date: '2026-10-27', status: 'pending' },
    { id: 'repeating', repeat_rule: 'daily', date: '2026-10-27', status: 'pending' },
    { id: 'single', date: '2026-10-27', status: 'pending' },
  ];
  await f.write('O_active', 'schedules.json', schedules);
  await assert.rejects(f.store.checkin({ scheduleId: 'archived' }), hasCode('ARCHIVED'));
  await assert.rejects(f.store.capture({ objectiveId: 'O_archived', inspiration: 'blocked' }), hasCode('ARCHIVED'));
  await assert.rejects(f.store.checkin({ scheduleId: 'archived_k' }), hasCode('ARCHIVED'));
  for (const scheduleId of ['SCH_REC_legacy', 'repeating']) await assert.rejects(f.store.checkin({ scheduleId, date: '2026-10-27' }), hasCode('OCCURRENCE_REQUIRED'));
  await assert.rejects(f.store.checkin({ scheduleId: 'single', date: '2026-10-26' }), hasCode('OCCURRENCE_MISMATCH'));
  await assert.rejects(f.store.checkin({ scheduleId: 'single', status: 'invented' }), hasCode('INVALID_ARGUMENT'));
  assert.deepEqual(await f.load('O_active', 'schedules.json'), schedules);
  assert.equal((await fs.readdir(path.join(f.baseDir, 'O_archived'))).includes('inspirations.json'), false);
});

test('duplicate IDs require disambiguation and never choose first matching data', async t => {
  const f = await fixture(t, [{ id: 'O_one' }, { id: 'O_two' }]);
  await f.write('O_one', 'schedules.json', [{ id: 'shared', status: 'pending' }]);
  await f.write('O_two', 'schedules.json', [{ id: 'shared', status: 'pending' }]);
  await assert.rejects(f.store.checkin({ scheduleId: 'shared' }), hasCode('AMBIGUOUS_ID'));
  await f.store.checkin({ scheduleId: 'shared', objectiveId: 'O_one' });
  assert.equal((await f.load('O_two', 'schedules.json'))[0].status, 'pending');
  await f.write('O_one', 'schedules.json', [{ id: 'shared' }, { id: 'shared' }]);
  await assert.rejects(f.store.checkin({ scheduleId: 'shared', objectiveId: 'O_one' }), hasCode('AMBIGUOUS_ID'));
  await fs.writeFile(path.join(f.baseDir, 'global_index.json'), JSON.stringify({ objectives: [{ id: 'O_two' }, { id: 'O_two' }] }));
  await assert.rejects(f.store.read({ objectiveId: 'O_two' }), hasCode('AMBIGUOUS_ID'));
});

test('concurrent store instances serialize atomic writes without lost records or temporary files', async t => {
  const f = await fixture(t);
  const other = createLegacyStore({ baseDir: f.baseDir, now });
  const captures = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? f.store : other).capture({ objectiveId: 'O_fixture', inspiration: `Thought ${index}` })));
  const saved = await f.load('O_fixture', 'inspirations.json');
  assert.equal(saved.length, 24);
  assert.equal(new Set(saved.map(item => item.id)).size, 24);
  assert.deepEqual(new Set(saved.map(item => item.id)), new Set(captures.map(result => result.inspiration.id)));
  assert.ok(saved.every(item => item.date === '2026-10-27'));
  assert.equal((await fs.readdir(path.join(f.baseDir, 'O_fixture'))).some(name => name.endsWith('.tmp')), false);
  await f.write('O_fixture', 'schedules.json', [{ id: 'one', status: 'pending' }, { id: 'two', status: 'pending' }]);
  await Promise.all([f.store.checkin({ scheduleId: 'one', note: 'one' }), other.checkin({ scheduleId: 'two', note: 'two' })]);
  assert.deepEqual((await f.load('O_fixture', 'schedules.json')).map(item => item.status), ['completed', 'completed']);
});

test('migration lock and installed SQLite prevent any further legacy JSON write', async t => {
  const f = await fixture(t);
  await f.write('O_fixture', 'schedules.json', [{ id: 'single', status: 'pending' }]);
  const lock = path.join(f.baseDir, 'O_fixture', '.migration.lock');
  await fs.writeFile(lock, 'locked');
  await assert.rejects(f.store.checkin({ scheduleId: 'single' }), hasCode('MIGRATION_BUSY'));
  await fs.rm(lock);
  await fs.writeFile(path.join(f.baseDir, 'O_fixture', 'space.sqlite'), 'installed');
  await assert.rejects(f.store.capture({ objectiveId: 'O_fixture', inspiration: 'blocked' }), hasCode('MIGRATED'));
  assert.equal((await f.load('O_fixture', 'schedules.json'))[0].status, 'pending');
  assert.equal((await fs.readdir(path.join(f.baseDir, 'O_fixture'))).some(name => name.endsWith('.tmp') || name === 'inspirations.json'), false);
});

test('migration and legacy writes share one exclusive queue', async t => {
  const f = await fixture(t);
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const migration = f.store.withExclusive('O_fixture', async () => {
    start();
    await gate;
    await fs.writeFile(path.join(f.baseDir, 'O_fixture', 'space.sqlite'), 'installed');
  });
  await started;
  const writing = f.store.capture({ objectiveId: 'O_fixture', inspiration: 'must not race migration' });
  release();
  await migration;
  await assert.rejects(writing, hasCode('MIGRATED'));
  assert.equal((await fs.readdir(path.join(f.baseDir, 'O_fixture'))).includes('inspirations.json'), false);
});
