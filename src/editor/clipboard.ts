/** Source-only clipboard policy; never accepts browser DOM or arbitrary HTML as source. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listElements, validateSourceRef } from './source.ts';
import type { SourceElement, SourceRef } from './source.ts';
import { duplicateFragment, canContain, validateNesting } from './structure.ts';
import { TransactionError } from './transactions.ts';
export interface ClipboardSnapshot { source: string; ref: SourceRef; fragment: string; createdAt: string }
export interface PasteTarget {canvas:string;board:string;sourceRef?:SourceRef|null;boards:string[]}
const value=(e:SourceElement,name:string)=>e.attrs.find(a=>a.name.toLowerCase()===name)?.value;
const denied=new Set(['script','style','helmet','dc-import','x-import','iframe','object','embed','link','meta','base','template','svg','math']);
function fail(reasons:string[]):never {throw new TransactionError(422,'clipboard_dependency','无法粘贴：'+reasons.join('；'));}
function chain(el:SourceElement,all:SourceElement[]) {const out:SourceElement[]=[];let id=el.parentTid;while(id!==null){const parent=all[id];if(!parent)fail(['父级关系无法确认']);out.push(parent);id=parent.parentTid;}return out;}
function scope(el:SourceElement,all:SourceElement[],include=false) {return (include?[el,...chain(el,all)]:chain(el,all)).filter(e=>['sc-for','sc-if'].includes(e.tag)).map(e=>e.tag+JSON.stringify(e.attrs.map(a=>[a.name,a.value]))).reverse().join('/');}
const scripts=(source:string)=>[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m=>m[0]).join('\n');
const styles=(source:string)=>[...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>|<link\b[^>]*>/gi)].map(m=>m[0].trim()).join('\n');
export function captureClipboard(source:string,ref:SourceRef):ClipboardSnapshot {
  const element=validateSourceRef(source,ref,{canvas:ref.canvas,board:ref.board});
  const fragment=source.slice(...element.full), all=listElements(source);
  const subtree=all.filter(e=>e.full[0]>=element.full[0] && e.full[1]<=element.full[1]);
  if(subtree.some(e=>denied.has(e.tag))) fail(['包含组件、元数据、脚本或嵌入内容，不允许作为外部片段搬运']);
  if(Buffer.byteLength(fragment)>1024*1024) fail(['源码片段超过 1 MiB']);
  return {source,ref,fragment,createdAt:new Date().toISOString()};
}
/** Cut must not strand references outside the removed subtree. */
export function validateCutClipboard(snapshot:ClipboardSnapshot) {
  const elements=listElements(snapshot.source),root=elements[snapshot.ref.tid];
  if(!root)fail(['剪切来源不存在']);
  const inside=(element:SourceElement)=>element.full[0]>=root.full[0]&&element.full[1]<=root.full[1];
  const ids=new Set(elements.filter(inside).map(e=>value(e,'id')).filter(Boolean));
  for(const element of elements.filter(e=>!inside(e))) for(const attribute of element.attrs) {
    if(!attribute.value)continue;
    const name=attribute.name.toLowerCase();
    const references=['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','headers','list','form'].includes(name)?attribute.value.split(/\s+/):name==='href'&&attribute.value.startsWith('#')?[attribute.value.slice(1)]:[];
    if(references.some(id=>ids.has(id)))fail(['子树外仍有元素引用待剪切的 id；粘贴会重新分配 id，请先解除引用']);
  }
}
export function pasteClipboard(destination:string,snapshot:ClipboardSnapshot,target:PasteTarget) {
  const sourceEls=listElements(snapshot.source), src=sourceEls[snapshot.ref.tid];
  if(!src || snapshot.source.slice(...src.full)!==snapshot.fragment) fail(['复制快照损坏']);
  const destinationEls=listElements(destination);
  const selected=target.sourceRef?validateSourceRef(destination,target.sourceRef,target):null;
  // A selected root means append inside it; no selection uses the unique visible root.
  const roots=destinationEls.filter(e=>e.parentTid===null&&!['helmet','script','style'].includes(e.tag));
  const parent=selected?.parentTid!==null&&selected?.parentTid!==undefined?destinationEls[selected.parentTid]:selected??(roots.length===1?roots[0]:null);
  if(!parent) fail(['没有唯一的目标根容器，请选择一个元素']);
  const at=selected&&selected.parentTid!==null?selected.full[1]:parent.inner[1];
  canContain(parent,src.tag);
  if(denied.has(parent.tag)||chain(parent,destinationEls).some(e=>denied.has(e.tag))) fail(['目标容器不允许结构编辑']);
  const sameBoard=target.canvas===snapshot.ref.canvas&&target.board===snapshot.ref.board;
  const subtree=sourceEls.filter(e=>e.full[0]>=src.full[0]&&e.full[1]<=src.full[1]);
  const reasons:string[]=[];
  if(!sameBoard) {
    if(/\{\{/.test(snapshot.fragment)) reasons.push('包含 props、循环变量或其他数据绑定');
    if(subtree.some(e=>e.attrs.some(a=>/^on/i.test(a.name)))) reasons.push('包含事件依赖');
    if(subtree.some(e=>['sc-for','sc-if'].includes(e.tag))) reasons.push('包含循环或条件组件');
    if(scope(src,sourceEls)) reasons.push('来源位于循环或条件作用域');
    if(subtree.some(e=>value(e,'class'))) {
      if(styles(snapshot.source)!==styles(destination)) reasons.push('CSS 类的样式定义与目标画板不一致');
      const linkedStyles=/<link\b(?=[^>]*\brel\s*=\s*['"]?stylesheet\b)[^>]*>/i;
      if(linkedStyles.test(snapshot.source)||linkedStyles.test(destination)) reasons.push('CSS 类依赖外部样式表，无法确认跨画板样式及其传递依赖一致');
    }
    for(const variable of snapshot.fragment.matchAll(/var\(\s*(--[\w-]+)/g)) if(!styles(destination).includes(variable[1]+':')&&!destination.includes(variable[1]+':')) reasons.push(`缺少 CSS 变量 ${variable[1]}`);
  } else {
    if(scope(src,sourceEls)!==scope(parent,destinationEls,true)) reasons.push('目标与来源的循环/条件作用域不同');
    if(/\{\{/.test(snapshot.fragment)&&scripts(snapshot.source)!==scripts(destination)) reasons.push('复制后数据绑定脚本已变更，请重新复制');
  }
  const subtreeIds=new Set(subtree.map(e=>value(e,'id')).filter(Boolean));
  const destinationIds=new Set(destinationEls.map(e=>value(e,'id')).filter(Boolean));
  for(const e of subtree) for(const a of e.attrs) {
    if(!a.value)continue;
    if(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','headers','list','form'].includes(a.name.toLowerCase())) for(const id of a.value.split(/\s+/)) if(!subtreeIds.has(id)&&!destinationIds.has(id)) reasons.push(`缺少被引用的元素 #${id}`);
    if(a.name.toLowerCase()==='href'&&a.value.startsWith('#')&&!subtreeIds.has(a.value.slice(1))&&!destinationIds.has(a.value.slice(1))) reasons.push(`缺少导航目标 ${a.value}`);
  }
  if(reasons.length)fail([...new Set(reasons)]);
  let fragment=duplicateFragment(snapshot.source,src,[...destinationIds].filter((id):id is string=>typeof id==='string'));
  // Relative board links are resolved from the original board's directory, then rebased.
  const links=listElements('<x-dc>'+fragment+'</x-dc>');const changes:{from:number;to:number;text:string}[]=[];
  for(const e of links) for(const a of e.attrs) {
    if(!a.value || !a.valueSpan)continue;
    if(a.name.toLowerCase()==='href' && !a.value.startsWith('#') && !a.value.startsWith('/_blob/')) {
      const href=a.value;
      if(/^[a-z][a-z\d+.-]*:/i.test(href)||href.startsWith('//')||href.startsWith('/')||href.includes('\\')||href.includes('?')) fail([`不能证明导航依赖安全：${href}`]);
      const [file,hash]=href.split('#');
      const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(snapshot.ref.board),file!));
      if(!resolved.endsWith('.dc.html')||!target.boards.includes(resolved))fail([`目标设计稿缺少导航画板 ${resolved}`]);
      const relative=path.posix.relative(path.posix.dirname(target.board),resolved)||path.posix.basename(resolved);
      changes.push({from:a.valueSpan[0]-6,to:a.valueSpan[1]-6,text:relative+(hash?'#'+hash:'')});
    }
    if(a.name.toLowerCase()==='srcset') fail(['暂不支持搬运 srcset 多候选资源']);
    if(a.name.toLowerCase()==='src' && !/^\/_blob\/[a-f0-9]{32}$/.test(a.value)) fail(['图片来源必须是设计稿素材']);
    if(/(?:javascript:|data:text\/html|vbscript:)/i.test(a.value))fail(['片段含不允许的可执行属性']);
  }
  for(const c of changes.sort((a,b)=>b.from-a.from))fragment=fragment.slice(0,c.from)+c.text+fragment.slice(c.to);
  const marker='dsh-paste-'+randomUUID(),markerAttr=` data-dsh-paste-focus="${marker}"`;
  fragment=fragment.replace(/^<([A-Za-z][\w:-]*)/,`<$1${markerAttr}`);
  let candidate=destination.slice(0,at)+'\n'+fragment+destination.slice(at);
  validateNesting(candidate);
  const focusTid=listElements(candidate).find(e=>value(e,'data-dsh-paste-focus')===marker)?.tid??null;
  candidate=candidate.replace(markerAttr,'');
  return {source:candidate,focusTid};
}
