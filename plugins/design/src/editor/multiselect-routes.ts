import { setInlineStyle, validateSourceRef } from './source.ts';
import { TransactionError } from './transactions.ts';
import type { StructureContext } from './structure-routes.ts';

/** One board revision, one candidate validation and one undo record per batch. */
export async function handleMultiSelect(route: string, body: Record<string, unknown>, ctx: StructureContext): Promise<object | undefined> {
  if (route !== '/api/edit-batch') return undefined;
  if (typeof body.canvas !== 'string' || typeof body.board !== 'string' || typeof body.revision !== 'string' || !body.revision) {
    throw new TransactionError(400, 'invalid_batch', '批量操作必须包含设计稿、画板和版本');
  }
  if (!Array.isArray(body.edits) || body.edits.length < 1 || body.edits.length > 200) throw new TransactionError(400, 'invalid_batch', '一次批量操作需包含 1–200 个模板节点');
  const canvas = body.canvas, board = body.board, dir = ctx.canvasDir(canvas);
  await ctx.boardPath(dir, board);
  const edits = new Map<number, { style: string; sourceRef: unknown }>();
  for (const item of body.edits) {
    if (!item || !Number.isSafeInteger(item.tid) || item.tid < 0 || typeof item.style !== 'string' || item.style.length > 100000) {
      throw new TransactionError(400, 'invalid_batch', '批量样式或节点编号不合法');
    }
    if (edits.has(item.tid) && edits.get(item.tid)!.style !== item.style) throw new TransactionError(400, 'ambiguous_batch', '同一模板的多个实例不能写入不同样式');
    edits.set(item.tid, { style: item.style, sourceRef: item.sourceRef });
  }
  const out = await ctx.transactions.mutate(dir, {
    label: body.kind === 'move' ? '批量移动' : '批量修改样式', origin: ctx.origin,
    revisions: { [board]: body.revision },
    build(snapshot) {
      const original = snapshot[board]?.toString('utf8');
      if (original === undefined) throw new TransactionError(404, 'board_missing', '画板不存在');
      for (const [tid, edit] of edits) {
        let source;
        try { source = validateSourceRef(original, edit.sourceRef, { canvas, board }); }
        catch (error) { throw new TransactionError(409, 'source_conflict', (error as Error).message); }
        if (source.tid !== tid) throw new TransactionError(400, 'invalid_batch', '元素来源编号与修改目标不一致');
      }
      let source = original;
      // Styles do not add/remove nodes: template IDs remain stable as offsets change.
      for (const [tid, edit] of edits) source = setInlineStyle(source, tid, edit.style);
      return { [board]: source };
    },
  });
  if (out.changed) ctx.broadcast({ type: 'edited', canvas, board, files: out.files, origin: ctx.origin });
  return { ...out, canvas, board, applied: edits.size, revision: out.revisions[board] || body.revision };
}
