/**
 * 素材库：内容寻址，写进 `<canvas>/assets/<id>.<ext>`，对外地址是 `/_blob/<id>`。
 *
 * 搬运自 BaoCut @ 7aa049e8 的 `packages/slides/src/deck-store.ts`（DeckStore.putBlobNow / findBlobFile /
 * assetExtensionOf / sha256），去掉了编辑器路由与发布那部分，只留导入素材需要的最小子集。
 *
 * 与原实现的一处差别：这里直接用 `node:fs`，不走宿主注入的文件接缝，因为 DSH 的 `ctx.fs` 只有
 * `writeText`（没有 `writeBytes`），写不了二进制。代价是绕过了沙箱与 fs 观察策略。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assetExtensionOf } from './shared.ts';

/** 素材类型索引。 */
const ASSET_INDEX = 'index.json';

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 按 id 找已存的素材文件（扩展名未知，按 `<id>.` 前缀找）。 */
export async function findBlobFile(dir: string, id: string): Promise<string | null> {
  try {
    const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${id}.`) && !n.endsWith('.tmp'));
    if (name === undefined) return null;
    const file = path.join(dir, name);
    return (await fs.lstat(file).catch(() => null))?.isFile() ? file : null;
  } catch {
    return null;
  }
}

/** 原子写：先写 `.tmp` 再改名，避免半个文件被读到。 */
async function writeFileAtomic(file: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, file);
}

export interface UploadResult {
  /** 素材 id（sha256 十六进制前 32 位）。 */
  id: string;
  /** 写进画板的地址，形如 `/_blob/<id>`。 */
  url: string;
  sizeBytes: number;
}

/**
 * 把字节存进素材目录。按内容寻址，同一份只存一份。
 * @param dir 素材目录（设计稿是 `<canvas>/assets/`，设计系统是 `<system>/_blobs/`）
 */
export async function putBlob(dir: string, bytes: Uint8Array, contentType: string): Promise<UploadResult> {
  await fs.mkdir(dir, { recursive: true });
  const id = sha256(bytes).slice(0, 32);
  const type = contentType.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
  if ((await findBlobFile(dir, id)) === null) {
    await writeFileAtomic(path.join(dir, `${id}.${assetExtensionOf(type)}`), bytes);
  }
  const indexFile = path.join(dir, ASSET_INDEX);
  let index: Record<string, string> = {};
  try {
    index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as Record<string, string>;
  } catch {
    // 没有索引或索引坏了：重建。
  }
  if (index[id] !== type) {
    index[id] = type;
    await writeFileAtomic(indexFile, Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
  }
  return { id, url: `/_blob/${id}`, sizeBytes: bytes.byteLength };
}
