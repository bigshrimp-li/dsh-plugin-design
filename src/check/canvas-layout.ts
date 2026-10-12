/**
 * 设计稿目录的文件布局与识别（docs/design/canvas §2.1、§2.2）。
 *
 *   <canvas>/canvas.json        索引（v3）
 *   <canvas>/<路径>.dc.html      画板，可以在子目录里
 *   <canvas>/ds/<folder>/…      装进来的设计系统
 *   <canvas>/<支持文件>           画板按相对路径引用的 css、js、json
 *   <canvas>/assets/<id>.<ext>  上传的素材（由 DeckStore 管，不进清单）
 *
 * 编辑器看得到、能写的是目录里所有普通文件，除了 `assets/` 下的、以点开头的、符号链接与段名不合规则的。
 * 存储与路由沿用 `@baocut/slides` 的 DeckStore / SlidesServer，这里只给出布局（`CANVAS_LAYOUT`）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR, type DeckLayout } from '../shared.ts';
import type { DesignCanvasInfo } from '../shared.ts';

/** 设计稿目录的入口文件。 */
export const CANVAS_FILE = 'canvas.json';
/** 画板文件的后缀。 */
export const BOARD_SUFFIX = '.dc.html';
/** 装进来的设计系统所在的目录；里面的 `.dc.html` 不是画板。 */
export const DESIGN_SYSTEMS_DIR = 'ds';

/** 原格式的上限（§2.1）：一份设计稿至多 512 个文件、合计 256 MB，一次发布 16 MB。 */
export const CANVAS_LIMITS = {
  files: 512,
  totalBytes: 256 * 1024 * 1024,
  publishBytes: 16 * 1024 * 1024,
} as const;

/** 路径的每一段：以字母、数字或 `_` 开头，只含这些与 `.` `-`。 */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function isCanvasSegment(segment: string): boolean {
  return SEGMENT.test(segment);
}

/** 设计稿目录里的相对路径（`/` 分隔）是否属于编辑器可见、可写的文件。 */
export function isCanvasFile(rel: string): boolean {
  const parts = rel.split('/');
  if (parts[0] === ASSETS_DIR) return false;
  return parts.every(isCanvasSegment);
}

/** 是不是画板文件（以 `.dc.html` 结尾、不在 `ds/` 里）。 */
export function isBoardPath(rel: string): boolean {
  return rel.endsWith(BOARD_SUFFIX) && rel.split('/')[0] !== DESIGN_SYSTEMS_DIR;
}

/** 编辑器服务里设计稿的布局：整棵目录树（不含 `assets/` 与隐藏目录），按名字排序后至多列 512 个文件。 */
export const CANVAS_LAYOUT: DeckLayout = {
  isFile: isCanvasFile,
  roots: [{ rel: '', descend: true }],
  descendInto: rel => isCanvasFile(rel),
  watches: rel => isCanvasFile(rel),
  maxFiles: CANVAS_LIMITS.files,
  maxPublishBytes: CANVAS_LIMITS.publishBytes,
  readOnlyMessage: p =>
    `${p}: files under assets/, hidden paths and path segments outside [A-Za-z0-9_][A-Za-z0-9_.-]* can't be written`,
};

/** 认设计稿的条件（§2.1）：`v` 为 3、`boards` 是对象。其余字段由 `checkCanvas` 检查。 */
export function isCanvasMetadata(value: unknown): value is { v: 3; boards: Record<string, unknown>; title?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const canvas = value as { v?: unknown; boards?: unknown };
  return canvas.v === 3 && typeof canvas.boards === 'object' && canvas.boards !== null && !Array.isArray(canvas.boards);
}

/** canvas.json 读入的上限：比这大的不当设计稿（防止读一个巨大的 JSON）。 */
const MAX_CANVAS_JSON_BYTES = 4 * 1024 * 1024;

/** 读 canvas.json 并解析；没有、读不了、太大或不是 JSON 时 null。不跟随符号链接。 */
export async function readCanvasJson(dir: string): Promise<unknown> {
  const file = path.join(dir, CANVAS_FILE);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_CANVAS_JSON_BYTES) return null;
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** 设计稿的标题：`canvas.json` 的 `title` 去掉首尾空白，没有时用目录名。 */
export function canvasTitle(canvas: object, dir: string): string {
  const raw = (canvas as { title?: unknown }).title;
  const title = typeof raw === 'string' ? raw.trim() : '';
  return title || path.basename(dir);
}

/** 读一个目录的设计稿概况；不是设计稿（没有、读不了、不合 §2.1）时返回 null。不跟随符号链接。 */
export async function readCanvasInfo(dir: string): Promise<DesignCanvasInfo | null> {
  const parsed = await readCanvasJson(dir);
  if (!isCanvasMetadata(parsed)) return null;
  return { title: canvasTitle(parsed, dir), boardCount: Object.keys(parsed.boards).length };
}

/** Space 扫描用的设计稿目录概况：大小与时间的取法与 deck 相同（目录与第一层子目录里的普通文件）。 */
export interface CanvasDirStat extends DesignCanvasInfo {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

/** 目录是设计稿时返回它的概况，否则 null。不跟随符号链接，跳过以点开头的文件与目录。 */
export async function inspectCanvas(dir: string): Promise<CanvasDirStat | null> {
  const info = await readCanvasInfo(dir);
  if (!info) return null;
  const canvasFile = await fs.lstat(path.join(dir, CANVAS_FILE)).catch(() => null);
  if (!canvasFile) return null;
  let size = 0;
  let mtimeMs = canvasFile.mtimeMs;
  const add = async (folder: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0) await add(full, 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat) continue;
      size += stat.size;
      mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    }
  };
  await add(dir, 0);
  return { ...info, size, mtimeMs, birthtimeMs: canvasFile.birthtimeMs };
}
