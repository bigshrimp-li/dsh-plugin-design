// Watch all maintained sources, including runtime JavaScript and editor assets.
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
let current, pending = false, timer;
function rebuild() {
  if (current) { pending = true; return; }
  current = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { stdio: 'inherit' });
  current.once('exit', () => { current = null; if (pending) { pending = false; rebuild(); } });
}
const watcher = watch(new URL('../src/', import.meta.url), { recursive: true }, () => {
  clearTimeout(timer); timer = setTimeout(rebuild, 150);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { watcher.close(); clearTimeout(timer); current?.kill(signal); process.exit(); });
rebuild();
