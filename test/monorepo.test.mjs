import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositoryRoot, loadPlugins, selectPlugins } from '../scripts/plugins.mjs';
import { checkPlugins } from '../scripts/check-plugins.mjs';

const installer = path.join(repositoryRoot, 'scripts/install-plugins.mjs');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugins-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profileDir = path.join(directory, 'profiles', 'desktop');
  await fs.mkdir(profileDir, { recursive: true });
  const manifest = { name: 'test-profile', private: true, dependencies: { other: '1.0.0' }, dsh: { profile: { bundles: ['other'], custom: true } } };
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(profileDir, 'pnpm-lock.yaml'), 'original lock\n');
  const binary = path.join(directory, 'fake-dsh.mjs');
  await fs.writeFile(binary, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.DSH_HOME, 'calls.jsonl'), JSON.stringify(args)+'\\n');
if (args[3] === 'add') {
  const file = path.join(process.env.DSH_HOME,'profiles',args[2],'package.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  for (const dir of args.slice(4)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
    manifest.dependencies[pkg.name] = 'link:'+dir;
  }
  fs.writeFileSync(file,JSON.stringify(manifest));
  if (process.env.FAIL_ADD === '1') process.exit(7);
}
`, { mode: 0o755 });
  return { directory, profileDir, manifest, binary };
}
function install(f, args = [], env = {}) {
  return spawnSync(process.execPath, [installer, '--skip-build', ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: f.directory, DSH_BIN: f.binary, ...env } });
}

test('the three plugins have independent, complete DSH entrypoints', async () => {
  const plugins = await checkPlugins({ built: true });
  assert.deepEqual(plugins.map(p => p.id), ['design', 'okr-schedule', 'agent-session-visualizer']);
  assert.throws(() => selectPlugins(plugins, ['missing']), /未知插件/);
});

test('dry-run changes no profile and default install still selects Design', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.profileDir, 'package.json'), 'utf8');
  const result = install(f, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /design: @local\/dsh-plugin-design/);
  assert.doesNotMatch(result.stdout, /okr-schedule:/);
  assert.equal(await fs.readFile(path.join(f.profileDir, 'package.json'), 'utf8'), before);
  await assert.rejects(fs.access(path.join(f.directory, 'calls.jsonl')));
});

test('all plugins install repeatedly without replacing other bundles or duplicating entries', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = install(f, ['--all']);
    assert.equal(result.status, 0, result.stderr);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(f.profileDir, 'package.json')));
  assert.equal(manifest.dependencies.other, '1.0.0');
  assert.equal(manifest.dsh.profile.custom, true);
  assert.deepEqual(manifest.dsh.profile.bundles, ['other', '@local/dsh-plugin-design', '@local/okr-schedule', '@local/agent-session-visualizer']);
  for (const plugin of await loadPlugins()) assert.equal(manifest.dependencies[plugin.manifest.name], `link:${plugin.directory}`);
  assert.ok((await fs.readFile(path.join(f.directory, 'skills/design/SKILL.md'), 'utf8')).length > 0);
});

test('failed package installation restores profile bytes and does not leave new skills', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.profileDir, 'package.json'), 'utf8');
  const result = install(f, ['--all'], { FAIL_ADD: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /配置与 skills 已恢复/);
  assert.equal(await fs.readFile(path.join(f.profileDir, 'package.json'), 'utf8'), before);
  assert.equal(await fs.readFile(path.join(f.profileDir, 'pnpm-lock.yaml'), 'utf8'), 'original lock\n');
  await assert.rejects(fs.access(path.join(f.directory, 'skills/design')));
});

test('unknown selection and edited skills fail before any DSH call', async t => {
  const f = await fixture(t);
  assert.notEqual(install(f, ['--plugin', 'missing']).status, 0);
  const skill = path.join(f.directory, 'skills/design');
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'user edited skill');
  const result = install(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /本机修改/);
  assert.equal(await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8'), 'user edited skill');
  await assert.rejects(fs.access(path.join(f.directory, 'calls.jsonl')));
});

test('migration can retain locally edited skills without claiming ownership', async t => {
  const f = await fixture(t);
  const skill = path.join(f.directory, 'skills/design');
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'local skill content');
  const result = install(f, ['--all', '--keep-skills']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8'), 'local skill content');
  const owners = JSON.parse(await fs.readFile(path.join(f.directory, 'plugin-skill-owners.json')));
  assert.equal(owners.design, undefined);
});
