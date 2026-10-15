/** Bounded, symlink-free reads shared by design validators. */
import fs from 'node:fs/promises';
import path from 'node:path';
export const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export async function readJson(dir: string, name: string, limit = 4 * 1024 ** 2): Promise<unknown> {
  try {
    const file = path.join(dir, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > limit) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}
export interface FileIssue { file: string; message: string }
export async function inventory(dir: string, issues: FileIssue[], limit = 20000) {
  const files = new Map<string, number>(); let seen = 0, bytes = 0;
  const folders = [''];
  while (folders.length) {
    const rel = folders.pop()!;
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      if (++seen > limit) { issues.push({ file: '.', message: `Directory scan exceeds ${limit} entries` }); return { files, bytes }; }
      if (entry.name.startsWith('.')) continue;
      const name = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) { issues.push({ file: name, message: 'Symbolic links are not supported' }); continue; }
      if (entry.isDirectory()) folders.push(name);
      else if (entry.isFile()) { const stat = await fs.lstat(path.join(dir, name)); files.set(name, stat.size); bytes += stat.size; }
    }
  }
  return { files, bytes };
}
export async function inspectDirectory(dir: string, indexName: string) {
  const index = await fs.lstat(path.join(dir, indexName));
  const tree = await inventory(dir, []);
  return { size: tree.bytes, birthtimeMs: index.birthtimeMs, mtimeMs: index.mtimeMs };
}
export function safeRelative(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 300 && Buffer.byteLength(value) <= 512 &&
    !/[\\:%;\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(value) &&
    value.split('/').every(s => !!s && s !== '.' && s !== '..' && !s.startsWith('.') && !['node_modules','__proto__','constructor','prototype'].includes(s) && s.trim() === s);
}
