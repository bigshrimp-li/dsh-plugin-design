// tsc 只搬 .ts：编辑器界面那几个 .html/.js/.css 要自己拷进 dist。
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/editor/assets/', import.meta.url));
const to = fileURLToPath(new URL('../dist/editor/assets/', import.meta.url));
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log('editor assets ->', to);
