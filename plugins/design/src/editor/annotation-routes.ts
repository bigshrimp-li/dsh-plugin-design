import fs from 'node:fs/promises';
import path from 'node:path';
import { buildAnnotationBlock, resolveAnnotationTarget } from './annotation.ts';
import type { AnnotationItem, AnnotationTarget } from './annotation.ts';
import { TransactionError } from './transactions.ts';
import type { StructureContext } from './structure-routes.ts';

export async function handleAnnotations(route: string, body: Record<string, unknown>, ctx: StructureContext): Promise<object | undefined> {
  if (route !== '/api/annotations/resolve' && route !== '/api/annotations/format') return undefined;
  if (typeof body.canvas !== 'string') throw new TransactionError(400, 'invalid_annotation', '必须指定设计稿');
  const canvas = body.canvas, dir = ctx.canvasDir(canvas), cache = new Map<string, string>();
  const index = JSON.parse(await fs.readFile(path.join(dir, 'canvas.json'), 'utf8'));
  async function resolve(value: unknown): Promise<AnnotationTarget> {
    const target = value as { sourceRef?: { canvas?: string; board?: string }; instance?: unknown };
    if (!target?.sourceRef || target.sourceRef.canvas !== canvas || typeof target.sourceRef.board !== 'string') throw new TransactionError(400, 'invalid_annotation', '标注的设计稿或画板来源不一致');
    const board = target.sourceRef.board;
    if (!cache.has(board)) cache.set(board, await fs.readFile(await ctx.boardPath(dir, board), 'utf8'));
    try { return resolveAnnotationTarget(cache.get(board)!, { canvas, board }, target.sourceRef, target.instance, index.boards?.[board]?.title); }
    catch (error) { throw new TransactionError(409, 'stale_annotation', (error as Error).message); }
  }
  if (route === '/api/annotations/resolve') {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 200) throw new TransactionError(400, 'invalid_annotation', '一次标注请选择 1–200 个实例');
    return { canvas, board: body.board, targets: await Promise.all(body.targets.map(resolve)) };
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) throw new TransactionError(400, 'invalid_annotation', '输出需包含 1–100 条标注');
  const items: AnnotationItem[] = [], ids = new Set<number>();
  for (const value of body.items) {
    if (!value || !Number.isSafeInteger(value.id) || value.id < 1 || ids.has(value.id) || typeof value.note !== 'string' || !value.note.trim() || value.note.length > 10000 || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > 200) throw new TransactionError(400, 'invalid_annotation', '标注编号、批注或选区不合法');
    ids.add(value.id);
    items.push({ id: value.id, note: value.note, targets: await Promise.all(value.targets.map(resolve)) });
  }
  for (const [board, source] of cache) {
    if (await fs.readFile(await ctx.boardPath(dir, board), 'utf8') !== source) throw new TransactionError(409, 'stale_annotation', '输出期间源码已变化，请重新选择');
  }
  return { canvas, block: buildAnnotationBlock(canvas, items), count: items.length };
}
