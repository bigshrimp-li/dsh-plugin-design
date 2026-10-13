import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { captureClipboard, pasteClipboard, validateCutClipboard } from './clipboard.ts';
import type { ClipboardSnapshot } from './clipboard.ts';
import { planStructure } from './structure.ts';
import { revisionOf, TransactionError } from './transactions.ts';
import type { EditorTransactions, FileChanges } from './transactions.ts';
import type { StructureContext } from './structure-routes.ts';
import { listElements } from './source.ts';
import type { SourceRef } from './source.ts';
import { DESIGN_ASSET_MAX_BYTES, contentTypeOf } from '../shared.ts';
interface Entry {snapshot:ClipboardSnapshot;payload:Record<string,unknown>;cutRevision?:string;bytes:number}
interface Store {secret:Buffer;entries:Map<string,Entry>;bytes:number}
const stores=new WeakMap<EditorTransactions,Store>();
function storeFor(tx:EditorTransactions) {let store=stores.get(tx);if(!store){store={secret:randomBytes(32),entries:new Map(),bytes:0};stores.set(tx,store);}return store;}
function bad(message:string,code='clipboard_invalid'):never {throw new TransactionError(422,code,message);}
function sign(store:Store,payload:Record<string,unknown>) {return createHmac('sha256',store.secret).update(JSON.stringify(payload)).digest('hex');}
function entryFor(store:Store,input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input))bad('系统剪贴板不是编辑器源码片段；不接受外部 HTML');
  const payload=input as Record<string,unknown>, entry=store.entries.get(String(payload.token));
  if(!entry)bad('剪贴板片段已过期或来自另一个编辑器服务，请重新复制');
  const {signature,...unsigned}=payload;
  if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(sign(store,unsigned),'hex'))||JSON.stringify(payload)!==JSON.stringify(entry.payload))bad('剪贴板内容已被修改，请重新复制');
  return entry;
}
async function maybeRead(file:string) {try{return await fs.readFile(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function safeAssets(dir:string) {
  const folder=path.join(dir,'assets'),stat=await fs.lstat(folder).catch(()=>null);
  if(!stat)return [];
  if(!stat.isDirectory()||stat.isSymbolicLink())bad('素材目录不是普通目录');
  const names=await fs.readdir(folder,{withFileTypes:true});
  if(names.some(e=>e.isSymbolicLink()))bad('素材目录含符号链接，不能安全搬运');
  return names.filter(e=>e.isFile()).map(e=>e.name);
}
function validType(name:string,bytes:Buffer) {
  const extension=path.extname(name).toLowerCase();const text=bytes.toString('utf8');
  let okay=false;
  if(extension==='.png')okay=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(extension==='.jpg'||extension==='.jpeg')okay=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(extension==='.gif')okay=/^GIF8[79]a/.test(bytes.subarray(0,6).toString());
  if(extension==='.webp')okay=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(extension==='.avif')okay=bytes.subarray(4,8).toString()==='ftyp'&&/avif|avis/.test(bytes.subarray(8,32).toString());
  if(extension==='.svg')okay=/<svg\b/i.test(text)&&!/<(?:script|foreignObject|iframe|image|use)\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*['"](?!#)|url\(|<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text);
  if(!okay)bad(`素材 ${name} 的类型不匹配或含动态内容，只支持静态图片`);
  return contentTypeOf(name);
}
async function prepareAssets(snapshot:ClipboardSnapshot,sourceDir:string,destDir:string) {
  const ids=[...new Set([...snapshot.fragment.matchAll(/\/_blob\/([a-f0-9]{32})(?![a-f0-9])/g)].map(m=>m[1]!))];
  const revisions:Record<string,string|null>={}, changes:FileChanges={};
  if(!ids.length)return {revisions,changes};
  const sourceNames=await safeAssets(sourceDir),destNames=sourceDir===destDir?sourceNames:await safeAssets(destDir);
  const sourceChecks:{file:string;revision:string|null}[]=[];
  const indexRel='assets/index.json', indexBytes=await maybeRead(path.join(destDir,indexRel));
  let index:Record<string,string>={};
  if(indexBytes){try{index=JSON.parse(indexBytes.toString());}catch{bad('目标素材索引格式损坏');}if(!index||typeof index!=='object'||Array.isArray(index))bad('目标素材索引格式损坏');}
  let changedIndex=false;
  for(const id of ids) {
    const matches=sourceNames.filter(name=>name.startsWith(id+'.')&&!name.endsWith('.json'));
    if(matches.length!==1)bad(`来源素材 ${id} 缺失或有多个同名版本`);
    const name=matches[0]!,file=path.join(sourceDir,'assets',name),bytes=await fs.readFile(file);
    if(!bytes.length||bytes.length>DESIGN_ASSET_MAX_BYTES)bad(`素材 ${id} 超过 20 MiB 或为空`);
    if(createHash('sha256').update(bytes).digest('hex').slice(0,32)!==id)bad(`素材 ${id} 的内容标识校验失败`);
    const type=validType(name,bytes);sourceChecks.push({file,revision:revisionOf(bytes)});
    const existing=destNames.filter(file=>file.startsWith(id+'.')&&!file.endsWith('.json'));
    if(existing.length>1)bad(`目标素材 ${id} 存在冲突`);
    if(existing.length) {
      const rel='assets/'+existing[0]!,current=await fs.readFile(path.join(destDir,rel));
      if(!current.equals(bytes)||validType(existing[0]!,current)!==type)bad(`目标素材 ${id} 内容或类型冲突`);
      revisions[rel]=revisionOf(current);
    } else {
      const rel='assets/'+name;revisions[rel]=null;changes[rel]=bytes;
    }
    if(index[id]&&index[id]!==type)bad(`目标素材 ${id} 的索引类型冲突`);
    if(index[id]!==type){index[id]=type;changedIndex=true;}
  }
  // Index is a read dependency even when existing files can be reused.
  revisions[indexRel]=revisionOf(indexBytes);
  if(changedIndex)changes[indexRel]=JSON.stringify(index,null,2)+'\n';
  return {revisions,changes,async verifySources(){for(const check of sourceChecks)if(revisionOf(await fs.readFile(check.file))!==check.revision)bad('来源素材在粘贴期间发生变化，请重新复制');}};
}
export async function handleClipboard(route:string,body:Record<string,unknown>,ctx:StructureContext):Promise<object|undefined> {
  if(!['/api/clipboard/copy','/api/clipboard/cut','/api/clipboard/paste'].includes(route))return undefined;
  if(typeof body.canvas!=='string'||typeof body.board!=='string'||typeof body.revision!=='string')bad('剪贴板操作必须提供画板及读取版本');
  const canvas=body.canvas,board=body.board,dir=ctx.canvasDir(canvas),abs=await ctx.boardPath(dir,board);
  const store=storeFor(ctx.transactions);
  if(route==='/api/clipboard/copy') {
    const source=await fs.readFile(abs,'utf8');if(revisionOf(source)!==body.revision)bad('来源画板已修改，请刷新后复制','revision_conflict');
    const snapshot=captureClipboard(source,body.sourceRef as SourceRef);
    if(snapshot.ref.canvas!==canvas||snapshot.ref.board!==board||snapshot.ref.revision!==body.revision)bad('复制来源与当前画板不一致');
    let cut:object|undefined;
    if(body.cut===true){
      const plan=planStructure(source,{canvas,board,revision:body.revision,sourceRef:snapshot.ref,action:'delete'});
      validateCutClipboard(snapshot);
      await prepareAssets(snapshot,dir,dir);
      const boards=Object.keys(JSON.parse(await fs.readFile(path.join(dir,'canvas.json'),'utf8')).boards??{});
      pasteClipboard(source,snapshot,{canvas,board,sourceRef:snapshot.ref,boards});
      cut={confirmation:plan.confirmation,warnings:plan.warnings};
    }
    const unsigned={kind:'deepseek-design-fragment',version:1,token:randomUUID(),canvas,board,revision:body.revision,fragment:snapshot.fragment,createdAt:snapshot.createdAt};
    const payload={...unsigned,signature:sign(store,unsigned)},bytes=Buffer.byteLength(source)+Buffer.byteLength(snapshot.fragment);
    store.entries.set(unsigned.token,{snapshot,payload,bytes});store.bytes+=bytes;
    while(store.entries.size>20||store.bytes>64*1024*1024){const oldest=store.entries.entries().next().value!;store.entries.delete(oldest[0]);store.bytes-=oldest[1].bytes;}
    return {payload,cut,sourceLabel:`${canvas}/${board}`,createdAt:snapshot.createdAt};
  }
  const entry=entryFor(store,body.payload),snapshot=entry.snapshot;
  if(route==='/api/clipboard/cut') {
    if(canvas!==snapshot.ref.canvas||board!==snapshot.ref.board||body.revision!==snapshot.ref.revision)bad('剪切来源已变更，请重新复制');
    validateCutClipboard(snapshot);
    const cutAssets=await prepareAssets(snapshot,dir,dir);
    const cutBoards=Object.keys(JSON.parse(await fs.readFile(path.join(dir,'canvas.json'),'utf8')).boards??{});
    pasteClipboard(snapshot.source,snapshot,{canvas,board,sourceRef:snapshot.ref,boards:cutBoards});
    let focusTid:number|null=null;
    const result=await ctx.transactions.mutate(dir,{label:'剪切元素',origin:ctx.origin,revisions:{[board]:body.revision,...cutAssets.revisions},build(files){
      const source=files[board]?.toString();if(!source)bad('来源画板不存在');
      const plan=planStructure(source,{canvas,board,revision:body.revision as string,sourceRef:snapshot.ref,action:'delete'});
      if(body.confirmation!==plan.confirmation)bad('剪切前必须确认删除范围');focusTid=plan.focusTid;return {[board]:plan.source};
    }});
    entry.cutRevision=result.revisions[board]??undefined;
    ctx.broadcast({type:'edited',canvas,board,files:result.files,origin:ctx.origin});
    return {...result,canvas,board,focusTid,revision:result.revisions[board]};
  }
  const sourceDir=ctx.canvasDir(snapshot.ref.canvas),sourceAbs=await ctx.boardPath(sourceDir,snapshot.ref.board);
  if(canvas!==snapshot.ref.canvas||board!==snapshot.ref.board) {
    const current=revisionOf(await fs.readFile(sourceAbs));
    if(current!==snapshot.ref.revision&&current!==entry.cutRevision)bad('来源画板在复制后已修改，跨画板粘贴请重新复制');
  }
  const index=await fs.readFile(path.join(dir,'canvas.json')), boards=Object.keys(JSON.parse(index.toString()).boards??{});
  const assets=await prepareAssets(snapshot,sourceDir,dir);
  const dependencies:Record<string,string|null>={};
  // Navigation fragments name a board and optional id; both are read dependencies.
  for(const el of listElements('<x-dc>'+snapshot.fragment+'</x-dc>')) for(const attribute of el.attrs) {
    if(attribute.name.toLowerCase()!=='href'||!attribute.value||attribute.value.startsWith('#'))continue;
    const [file,anchor]=attribute.value.split('#');
    const target=path.posix.normalize(path.posix.join(path.posix.dirname(snapshot.ref.board),file!));
    if(!boards.includes(target))continue; // The pure policy returns the detailed refusal.
    const content=await fs.readFile(await ctx.boardPath(dir,target));
    if(anchor&&!listElements(content.toString()).some(element=>element.attrs.some(a=>a.name.toLowerCase()==='id'&&a.value===anchor)))bad(`导航画板 ${target} 中没有 #${anchor}`);
    if(target!==board)dependencies[target]=revisionOf(content);
  }
  if(sourceDir===dir&&snapshot.ref.board!==board) dependencies[snapshot.ref.board]=revisionOf(await fs.readFile(sourceAbs));
  let focusTid:number|null=null;
  const result=await ctx.transactions.mutate(dir,{label:'粘贴元素',origin:ctx.origin,revisions:{[board]:body.revision,'canvas.json':revisionOf(index),...dependencies,...assets.revisions},build:async files=>{
    if(canvas!==snapshot.ref.canvas||board!==snapshot.ref.board){const current=revisionOf(await fs.readFile(sourceAbs));if(current!==snapshot.ref.revision&&current!==entry.cutRevision)bad('来源画板在粘贴期间发生变化，请重新复制');}
    await assets.verifySources?.();const destination=files[board]?.toString();if(!destination)bad('目标画板不存在');
    const plan=pasteClipboard(destination,snapshot,{canvas,board,sourceRef:body.sourceRef as SourceRef|null|undefined,boards});focusTid=plan.focusTid;
    return {[board]:plan.source,...assets.changes};
  }});
  ctx.broadcast({type:'edited',canvas,board,files:result.files,origin:ctx.origin});
  return {...result,canvas,board,focusTid,revision:result.revisions[board]};
}
