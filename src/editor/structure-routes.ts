import fs from 'node:fs/promises';
import path from 'node:path';
import { planStructure } from './structure.ts';
import type { StructureRequest } from './structure.ts';
import { revisionOf, TransactionError } from './transactions.ts';
import type { EditorTransactions } from './transactions.ts';

export interface StructureContext {
  workspace: string;
  canvasDir(canvas: string): string;
  boardPath(dir: string, board: string): Promise<string> | string;
  transactions: EditorTransactions;
  broadcast(event: unknown): void;
  origin: unknown;
}
const bad = (message: string): never => { throw new TransactionError(400,'invalid_structure_request',message); };
async function imageAssets(dir: string) {
  const directory=path.join(dir,'assets');
  const stat=await fs.lstat(directory).catch(()=>null);
  if(!stat || !stat.isDirectory() || stat.isSymbolicLink()) return [];
  const names=await fs.readdir(directory,{withFileTypes:true});
  return names.filter(e=>e.isFile() && /^[0-9a-f]{32}\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(e.name)).map(e=>({id:e.name.slice(0,e.name.lastIndexOf('.')),file:e.name}));
}
export async function handleStructure(route: string, body: Record<string,unknown>, ctx: StructureContext): Promise<object|undefined> {
  if(!['/api/structure','/api/structure/preview','/api/structure/assets'].includes(route)) return undefined;
  if(typeof body.canvas!=='string' || typeof body.board!=='string') bad('必须指定设计稿与画板');
  const canvas=body.canvas as string, board=body.board as string;
  const dir=ctx.canvasDir(canvas), abs=await ctx.boardPath(dir,board);
  if(route==='/api/structure/assets') return {assets:await imageAssets(dir)};
  if(typeof body.revision!=='string' || !body.revision) bad('结构操作必须提供画板版本');
  if(typeof body.text!=='undefined' && (typeof body.text!=='string' || body.text.length>10000)) bad('插入文字必须少于 10000 字符');
  const request=body as unknown as StructureRequest;
  const index=await fs.readFile(path.join(dir,'canvas.json'));
  const dependencies:Record<string,string|null> = {[board]:body.revision as string,'canvas.json':revisionOf(index)};
  if(request.action==='insert' && request.kind==='image') {
    const found=(await imageAssets(dir)).find(asset=>asset.id===request.asset);
    if(!found) bad('图片素材不存在，请重新选择');
    const rel='assets/'+found!.file;
    dependencies[rel]=revisionOf(await fs.readFile(path.join(dir,rel)));
  }
  if(route==='/api/structure/preview') {
    const source=await fs.readFile(abs,'utf8');
    if(revisionOf(source)!==body.revision) throw new TransactionError(409,'revision_conflict','画板已变更，请刷新后重试');
    return {...planStructure(source,request),revision:body.revision};
  }
  let plan:ReturnType<typeof planStructure>|undefined;
  const result=await ctx.transactions.mutate(dir,{label:'结构编辑：'+String(body.action),origin:ctx.origin,revisions:dependencies,build(snapshot) {
    const source=snapshot[board]; if(!source) bad('画板不存在');
    plan=planStructure(source!.toString('utf8'),request);
    if(plan.changed && (typeof body.confirmation!=='string' || body.confirmation!==plan.confirmation)) throw new TransactionError(409,'preview_required','请先查看本次结构操作的预览并确认');
    return {[board]:plan.source};
  }});
  if(result.changed) ctx.broadcast({type:'edited',canvas,board,files:result.files,origin:ctx.origin});
  return {...result,canvas,board,focusTid:plan?.focusTid??null,revision:result.revisions[board]??body.revision};
}
