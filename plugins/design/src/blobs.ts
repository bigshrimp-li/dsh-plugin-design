/** Content-addressed assets, implemented with Node's filesystem and crypto APIs. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assetExtensionOf, BLOB_ID_PATTERN } from './shared.ts';
export function sha256(data: Uint8Array | string): string { return createHash('sha256').update(data).digest('hex'); }
export async function findBlobFile(dir: string, id: string): Promise<string | null> {
  if (!BLOB_ID_PATTERN.test(id)) return null;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.startsWith(id + '.') && !entry.name.endsWith('.tmp')) return path.join(dir, entry.name);
  }
  return null;
}
async function atomic(file: string, data: Uint8Array | string) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, data, { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
export interface UploadResult { id: string; url: string; sizeBytes: number }
const writers = new Map<string, Promise<unknown>>();
export async function putBlob(dir: string, bytes: Uint8Array, contentType: string): Promise<UploadResult> {
  dir = path.resolve(dir);
  const previous = writers.get(dir) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await fs.mkdir(dir, { recursive: true });
    const id = sha256(bytes).substring(0, 32);
    const type = contentType.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    if (!await findBlobFile(dir, id)) await atomic(path.join(dir, id + '.' + assetExtensionOf(type)), bytes);
    const file = path.join(dir, 'index.json');
    const index = Object.create(null);
    const stat = await fs.lstat(file).catch(() => null);
    if (stat && !stat.isFile()) throw new Error('Asset index must be a regular file');
    if (stat) {
      const existing = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!existing || Array.isArray(existing) || typeof existing !== 'object') throw new Error('Invalid asset index');
      for (const [key, value] of Object.entries(existing)) if (BLOB_ID_PATTERN.test(key) && typeof value === 'string') index[key] = value;
    }
    index[id] = type;
    await atomic(file, JSON.stringify(index, null, 2) + '\n');
    return { id, url: '/_blob/' + id, sizeBytes: bytes.byteLength };
  });
  writers.set(dir, task);
  try { return await task; } finally { if (writers.get(dir) === task) writers.delete(dir); }
}
