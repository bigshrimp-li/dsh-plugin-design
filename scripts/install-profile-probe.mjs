#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-install-profile-'));
const home = path.join(temporary, 'home');
const dshHome = path.join(temporary, 'dsh');
const profile = path.join(dshHome, 'profiles', 'okr-test');
await fs.mkdir(home, { recursive: true });
const npmConfig = path.join(home, '.npmrc');
await fs.writeFile(npmConfig, 'registry=https://registry.npmjs.org/\nprefer-offline=true\n', { mode: 0o600 });
const env = { ...process.env, HOME: home, DSH_HOME: dshHome,
  NPM_CONFIG_USERCONFIG: npmConfig, NPM_CONFIG_CACHE: path.join(temporary, 'npm-cache'), npm_config_userconfig: npmConfig,
  npm_config_cache: path.join(temporary, 'npm-cache'), npm_config_prefer_offline: 'true' };
const installer = path.join(root, 'install.sh');
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
let summary;
function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 180_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${path.basename(command)} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}
async function install(plugin) {
  process.stdout.write(`Installing ${plugin} in isolated profile okr-test\n`);
  await run(installer, ['--plugin', plugin, '--profile', 'okr-test']);
}
try {
  await install('agent-session-visualizer');
  const seeded = await readJSON(path.join(profile, 'package.json'));
  seeded.dsh.profile.probeSentinel = 'preserve-other-profile-settings';
  await fs.writeFile(path.join(profile, 'package.json'), `${JSON.stringify(seeded, null, 2)}\n`);
  await install('okr-schedule');
  const first = await readJSON(path.join(profile, 'package.json'));
  await install('okr-schedule');
  const repeated = await readJSON(path.join(profile, 'package.json'));
  const expected = ['@local/agent-session-visualizer', '@local/okr-schedule'];
  for (const name of expected) {
    assert.ok(repeated.dependencies[name], `Missing dependency ${name}`);
    assert.equal(repeated.dsh.profile.bundles.filter(value => value === name).length, 1, `Repeated bundle ${name}`);
  }
  assert.deepEqual(first.dsh.profile.bundles, repeated.dsh.profile.bundles);
  assert.equal(repeated.dsh.profile.probeSentinel, 'preserve-other-profile-settings');
  assert.equal(repeated.dependencies['@local/agent-session-visualizer'], seeded.dependencies['@local/agent-session-visualizer']);
  for (const [name, directory] of [['agent-session-visualizer', 'agent-session-visualizer'], ['okr-schedule', 'okr-schedule']]) {
    const linked = await fs.realpath(path.join(profile, 'node_modules', '@local', name));
    assert.equal(linked, await fs.realpath(path.join(root, 'plugins', directory)));
  }
  const receipts = [];
  for (const directory of await fs.readdir(path.join(dshHome, 'plugin-backups'))) receipts.push(await readJSON(path.join(dshHome, 'plugin-backups', directory, 'receipt.json')));
  assert.equal(receipts.length, 3);
  assert.equal(receipts.filter(receipt => receipt.profile === 'okr-test' && receipt.plugins.includes('okr-schedule')).length, 2);
  assert.ok(receipts.some(receipt => receipt.present['package.json'] === true));
  process.stdout.write('Checking npm package contents\n');
  const packed = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], path.join(root, 'plugins/okr-schedule'));
  const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);
  for (const name of ['index.js', 'client.js', 'cordis.patch.yml', 'src/host/service.js', 'src/host/storage-worker.js', 'src/host/group.js', 'src/host/legacy.js', 'bin/okr-space.mjs']) assert.ok(files.includes(name), `Missing package file ${name}`);
  const forbidden = /(^|\/)(?:data|cache|caches|\.scratch|\.dsh_okr|node_modules|test|tests|screenshots)(\/|$)|\.(?:png|jpe?g|webp|sqlite(?:-(?:wal|shm))?|db|log|tgz)$/i;
  assert.deepEqual(files.filter(name => forbidden.test(name)), [], 'Distribution contains data, caches, tests or screenshots');
  summary = { passed: true, profile: 'okr-test', realDshCli: true,
    okrInstallations: 2, coexistence: expected, bundlesUnique: true, backupReceipts: receipts.length,
    packageFiles: files.length, packageIncludesHostAndCli: true, packageHasNoLocalData: true,
    userProfilesModified: false };
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
if (summary) process.stdout.write(JSON.stringify({ ...summary, temporaryCleaned: true }) + '\n');
