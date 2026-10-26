/** Canvas v3 file discovery and metadata. */
import path from 'node:path';
import { readJson, record, inspectDirectory } from './files.ts';
export const CANVAS_FILE = 'canvas.json';
export const BOARD_SUFFIX = '.dc.html';
export const DESIGN_SYSTEMS_DIR = 'ds';
export const CANVAS_LIMITS = { files: 512, totalBytes: 256 * 1024 ** 2, publishBytes: 16 * 1024 ** 2 } as const;
export function isCanvasSegment(segment: string): boolean { return /^[\w][\w.-]*$/.test(segment); }
export function isCanvasFile(rel: string): boolean { return !rel.startsWith('assets/') && rel !== 'assets' && rel.split('/').every(isCanvasSegment); }
export function isBoardPath(rel: string): boolean { return isCanvasFile(rel) && !rel.startsWith('ds/') && rel.endsWith(BOARD_SUFFIX); }
export function isCanvasMetadata(value: unknown): value is { v: 3; boards: Record<string, unknown>; title?: unknown } {
  return record(value) && value.v === 3 && record(value.boards);
}
export function readCanvasJson(dir: string): Promise<unknown> { return readJson(dir, CANVAS_FILE); }
export function canvasTitle(value: object, dir: string): string {
  const title = (value as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title.trim() : path.basename(dir);
}
export async function readCanvasInfo(dir: string) {
  const value = await readCanvasJson(dir);
  return isCanvasMetadata(value) ? { title: canvasTitle(value, dir), boardCount: Object.keys(value.boards).length } : null;
}
export async function inspectCanvas(dir: string) {
  const info = await readCanvasInfo(dir);
  return info ? { ...info, ...await inspectDirectory(dir, CANVAS_FILE) } : null;
}
