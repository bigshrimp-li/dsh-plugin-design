import { isAbsolute } from 'node:path';
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = process.env.SUPER_AGENT_SOURCE_ROOT;
if (!root || !isAbsolute(root)) {
  console.error('Set SUPER_AGENT_SOURCE_ROOT to an absolute agent-loop-core checkout with installed dependencies.');
  process.exit(2);
}
await access(root + '/packages/server/src/index.ts');
const result = spawnSync('vitest', ['run'], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
