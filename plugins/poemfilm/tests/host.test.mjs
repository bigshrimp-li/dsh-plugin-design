import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const work = join(tmpdir(), '诗人 的作品');
const edition = '雨中 · 初版';
const binding = { work, edition, job: '', allowEdit: false };
const prefix = [`--work=${work}`, '--json'];
const editionArg = `--edition=${edition}`;

async function host(t, config = binding) {
  // 以替身替换包内同路径启动器。这里测试 DSH → 子进程协议，不读取用户作品或凭据。
  const directory = await mkdtemp(join(tmpdir(), 'poemfilm-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, 'index.mjs');
  await copyFile(new URL('../index.js', import.meta.url), entry);
  await mkdir(join(directory, 'bin'));
  const launcher = join(directory, 'bin', 'poemfilm');
  await writeFile(launcher, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('verify')) {
  console.log(JSON.stringify({ schema_version: 1, ok: false, command: 'verify', error: { code: 'fixture_verification_failed' } }));
  process.exitCode = 2;
} else if (args.includes('render')) {
  console.error('private-fixture-diagnostic'); process.exitCode = 9;
} else {
  console.log(JSON.stringify({ schema_version: 1, ok: true, data: args }));
}
`, { mode: 0o755 });
  const { apply, inject } = await import(pathToFileURL(entry));
  assert.deepEqual(inject, ['tools']);
  const tools = new Map();
  apply({ tools: { register(tool) { tools.set(tool.name, tool); } } }, config);
  return tools;
}

test('default discovery provides local tools, with real argv boundaries and structured CLI errors', async t => {
  const tools = await host(t);
  assert.deepEqual([...tools.keys()].sort(), ['estimate', 'plan', 'show', 'status', 'verify'].map(n => 'poemfilm_' + n));
  for (const name of ['show', 'plan']) {
    const tool = tools.get('poemfilm_' + name);
    assert.deepEqual((await tool.execute()).data, [...prefix, name, editionArg]);
    assert.equal(tool.parameters.additionalProperties, false);
  }
  assert.deepEqual((await tools.get('poemfilm_status').execute()).data, [...prefix, 'auth', 'status']);
  const verify = tools.get('poemfilm_verify');
  const result = await verify.execute({});
  assert.equal(result.error.code, 'fixture_verification_failed');
  assert.deepEqual(JSON.parse(verify.output.render({}, result)[0].text), result);
});

test('offline estimates map targets by asset and treat delivery text literally', async t => {
  const tools = await host(t);
  const estimate = args => tools.get('poemfilm_estimate').execute(args);
  const spoken = '--job=other $(echo 轻雨)；慢一点';
  assert.deepEqual((await estimate({ asset: 'voice', target: '第五句', delivery: spoken })).data,
    [...prefix, 'generate', 'voice', editionArg, '--estimate-only', '--line=第五句', '--delivery=' + spoken]);
  assert.deepEqual((await estimate({ asset: 'art', target: '镜一' })).data,
    [...prefix, 'generate', 'art', editionArg, '--estimate-only', '--shot=镜一']);
  assert.deepEqual((await estimate({ asset: 'script' })).data, [...prefix, 'generate', 'script', editionArg, '--estimate-only']);
  for (const args of [{}, { asset: 'auth' }, { asset: 'art' }, { asset: 'script', target: '镜一' },
    { asset: 'voice', target: '句一' }, { asset: 'art', target: '镜一', delivery: '平静' },
    { asset: 'script', job: 'other' }, { asset: 'script', edition: 'other' }, { asset: 'script', work: '/other' }]) {
    assert.equal((await estimate(args)).error.code, 'invalid_arguments');
  }
});

test('generation and editing are separate host opt-ins', async t => {
  const tools = await host(t, { ...binding, job: '授权-1' });
  assert.equal(tools.has('poemfilm_render'), false);
  assert.deepEqual((await tools.get('poemfilm_job_status').execute()).data, [...prefix, 'job', 'status', '--job=授权-1']);
  const generate = args => tools.get('poemfilm_generate').execute(args);
  assert.equal((await generate({ asset: 'script' })).error.code, 'invalid_arguments');
  assert.equal((await generate({ asset: 'script', max_usd: '0.11', job: 'other' })).error.code, 'invalid_arguments');
  assert.deepEqual((await generate({ asset: 'voice', target: '句一', delivery: '私语', take: '一版', max_usd: '0.11' })).data,
    [...prefix, 'generate', 'voice', editionArg, '--job=授权-1', '--max-usd=0.11', '--line=句一', '--delivery=私语', '--take=一版']);
  const edit = await host(t, { ...binding, allowEdit: true });
  assert.equal(edit.has('poemfilm_generate'), false);
  assert.deepEqual((await edit.get('poemfilm_select').execute({ asset: 'voice', candidate: '--json' })).data,
    [...prefix, 'select', 'voice', editionArg, '--', '--json']);
  const failed = await edit.get('poemfilm_render').execute();
  assert.equal(failed.error.code, 'cli_result_unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /private-fixture-diagnostic/);
});

test('absent binding reports how to configure the host and trusted environment can supply it', async t => {
  const env = { POEMFILM_WORK: work, POEMFILM_EDITION: edition, POEMFILM_JOB: 'env-job', POEMFILM_ALLOW_EDIT: '1' };
  for (const [key, value] of Object.entries(env)) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  }
  const unbound = await host(t, { work: '', edition: '', job: '', allowEdit: false });
  assert.equal((await unbound.get('poemfilm_show').execute()).error.code, 'work_unbound');
  assert.equal(unbound.has('poemfilm_generate'), false);
  assert.equal(unbound.has('poemfilm_select'), false);
  const tools = await host(t, {});
  assert.ok(tools.has('poemfilm_render'));
  assert.deepEqual((await tools.get('poemfilm_show').execute()).data, [...prefix, 'show', editionArg]);
  assert.deepEqual((await tools.get('poemfilm_job_status').execute()).data, [...prefix, 'job', 'status', '--job=env-job']);
});
