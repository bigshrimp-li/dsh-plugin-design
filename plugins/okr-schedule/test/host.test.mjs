import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('query, checkin and inspiration keep using the same home data after relocation', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-plugin-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const data = path.join(temporary, '.dsh_okr');
  const objective = path.join(data, 'O_fixture');
  await fs.mkdir(objective, { recursive: true });
  await fs.writeFile(path.join(data, 'global_index.json'), JSON.stringify({ objectives: [{ id: 'O_fixture' }] }));
  await fs.writeFile(path.join(objective, 'meta.json'), JSON.stringify({ id: 'O_fixture', title: 'Fixture' }));
  await fs.writeFile(path.join(objective, 'schedules.json'), JSON.stringify([{ id: 'SCH_fixture', date: '2026-10-26', status: 'pending' }]));
  const originalHome = process.env.HOME;
  let host;
  try { process.env.HOME = temporary; host = await import('../index.js'); }
  finally { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; }
  const tools = new Map();
  host.apply({ tools: { register(tool) { tools.set(tool.name, tool); } } });
  assert.deepEqual([...tools.keys()], ['okr_schedule_query', 'okr_schedule_checkin', 'okr_inspiration_capture']);
  const query = await tools.get('okr_schedule_query').execute({ date: '2026-10-26', objective_id: 'O_fixture' });
  assert.equal(query.schedules.length, 1);
  const checked = await tools.get('okr_schedule_checkin').execute({ schedule_id: 'SCH_fixture', status: 'completed', note: 'Fixture note' });
  assert.equal(checked.success, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(objective, 'schedules.json')))[0].status, 'completed');
  const captured = await tools.get('okr_inspiration_capture').execute({ objective_id: 'O_fixture', inspiration: 'Fixture thought' });
  assert.equal(captured.success, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(objective, 'inspirations.json')))[0].text, 'Fixture thought');
});
