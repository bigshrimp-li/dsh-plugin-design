import { access } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const executable = process.env.DSH_ELECTRON || '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
await access(executable);
const root = process.env.DSH_INSTALL_ROOT || path.resolve(path.dirname(executable), '../Resources/app.asar/dsh');
const env = { ...process.env, DSH_ELECTRON: executable, DSH_INSTALL_ROOT: root, ELECTRON_RUN_AS_NODE: '1' };
execFileSync(executable, ['--input-type=module', '-e', `
  import fs from 'node:fs';
  import { createRequire } from 'node:module';
  const root = process.env.DSH_INSTALL_ROOT;
  if (!fs.existsSync(root + '/node_modules/@deepseek-ai/dsh-session/lib/index.js')) throw new Error('DSH_INSTALL_ROOT must contain the actual DSH runtime');
  const require = createRequire(root + '/package.json');
  const version = JSON.parse(fs.readFileSync(root + '/package.json')).version;
  for (const name of ['dsh-session', 'dsh-scope', 'dsh-agent']) require.resolve('@deepseek-ai/' + name);
  console.log('Actual DSH Host:', version);
`], { env, stdio: 'inherit' });
const require = createRequire(import.meta.url);
const manifestPath = require.resolve('vitest/package.json');
const vitest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const cli = path.resolve(path.dirname(manifestPath), typeof vitest.bin === 'string' ? vitest.bin : vitest.bin.vitest);
const result = spawnSync(executable, ['--expose-internals', cli, 'run',
  'test/host/packed-runtime.test.mjs', 'test/host/agent-scope.test.mjs',
  'test/host/agent-cancellation.test.mjs', 'test/host/assistant-settlement.test.mjs',
  'test/host/core-events.test.mjs'], {
  stdio: 'inherit', env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
