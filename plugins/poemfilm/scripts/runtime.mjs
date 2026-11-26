import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only dependencies live in this environment. Each DSH bundle executes its own src/.
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = readFileSync(join(root, 'uv.lock'));
const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
const revision = createHash('sha256').update(lock).digest('hex').slice(0, 24);
const envPath = join(cache, 'dsh-poemfilm', process.platform + '-' + process.arch, revision);
const python = join(envPath, 'bin', 'python');

switch (process.argv[2]) {
  case 'setup': {
    const result = spawnSync('uv', ['sync', '--frozen', '--project', root, '--no-install-project',
      '--no-dev', '--extra', 'agent'], {
      stdio: 'inherit',
      env: { ...process.env, UV_PROJECT_ENVIRONMENT: envPath },
    });
    if (result.error) console.error('初始化 Python 运行环境需要 uv：' + result.error.message);
    process.exitCode = result.status ?? 1;
    break;
  }
  case 'python':
    if (existsSync(python)) {
      process.stdout.write(python);
    } else {
      console.error('poemfilm 的 Python 依赖尚未安装，请先运行该插件的 bin/poemfilm --setup。');
      process.exitCode = 1;
    }
    break;
  default:
    console.error('用法：runtime.mjs setup | python');
    process.exitCode = 2;
}
