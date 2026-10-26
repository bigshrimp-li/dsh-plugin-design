import { planCanvasIndex, validateCanvasAnnotations } from './canvas-index.ts';
import { revisionOf, TransactionError } from './transactions.ts';
import type { StructureContext } from './structure-routes.ts';
export async function handleNotes(route:string,body:Record<string,unknown>,ctx:StructureContext):Promise<object|undefined> {
  if(route!=='/api/canvas-index') return undefined;
  if(typeof body.canvas!=='string'||typeof body.board!=='string'||typeof body.revision!=='string') throw new TransactionError(400,'revision_required','画布辅助操作需要设计稿、画板和索引版本');
  const canvas=body.canvas,board=body.board,dir=ctx.canvasDir(canvas);
  await ctx.boardPath(dir,board);
  let index:Record<string,any>={},after='';
  const out=await ctx.transactions.mutate(dir,{label:body.action==='set-guides'?'修改参考线':body.action==='delete-note'?'删除便签':body.action==='add-note'?'新增便签':'修改便签',origin:ctx.origin,revisions:{'canvas.json':body.revision},build(snapshot){
    const before=snapshot['canvas.json']!.toString('utf8');
    const original=JSON.parse(before); validateCanvasAnnotations(original);
    index=planCanvasIndex(original,body);
    after=JSON.stringify(index)===JSON.stringify(original)?before:JSON.stringify(index,null,2)+'\n';
    return {'canvas.json':after};
  }});
  if(out.changed) ctx.broadcast({type:'edited',canvas,files:out.files,origin:ctx.origin});
  return {...out,canvas,board,index,indexRevision:revisionOf(after)};
}
