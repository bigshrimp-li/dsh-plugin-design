/** Conservative source-range structural edits. Unchanged bytes never pass through a serializer. */
import { createHash, randomUUID } from 'node:crypto';
import { listElements, validateSourceRef, parseInlineStyle } from './source.ts';
import type { SourceElement, SourceRef } from './source.ts';
import { TransactionError } from './transactions.ts';

export type StructureAction = 'delete' | 'duplicate' | 'insert' | 'up' | 'down' | 'indent' | 'outdent' | 'wrap-flex' | 'wrap-grid';
export interface StructureRequest {
  canvas: string; board: string; revision: string; sourceRef: SourceRef; action: StructureAction;
  kind?: 'text' | 'rect' | 'image' | 'divider'; text?: string; asset?: string;
}
export interface StructurePlan { source: string; focusTid: number | null; warnings: string[]; confirmation: string; changed: boolean }
function fail(message: string): never { throw new TransactionError(422, 'unsafe_structure', message); }
const forbidden = new Set(['helmet', 'script', 'style', 'dc-import', 'x-import', 'template', 'svg', 'math']);
const phrasing = new Set(['a','abbr','b','bdi','bdo','br','button','cite','code','data','del','dfn','em','i','img','input','ins','kbd','label','mark','q','s','samp','small','span','strong','sub','sup','time','u','var','wbr']);
const phraseParents = new Set(['p','span','a','abbr','b','button','cite','code','em','h1','h2','h3','h4','h5','h6','i','label','small','strong']);
const constrained: Record<string,string[]> = {ul:['li'],ol:['li'],menu:['li'],table:['caption','colgroup','thead','tbody','tfoot'],thead:['tr'],tbody:['tr'],tfoot:['tr'],tr:['td','th'],colgroup:['col'],select:['option','optgroup'],optgroup:['option'],dl:['dt','dd']};
const onlyParents: Record<string,string[]> = {li:['ul','ol','menu'],td:['tr'],th:['tr'],tr:['tbody','thead','tfoot'],thead:['table'],tbody:['table'],tfoot:['table'],caption:['table'],colgroup:['table'],col:['colgroup'],option:['select','optgroup'],optgroup:['select'],dt:['dl'],dd:['dl']};
const scopeTag = (el: SourceElement) => ['sc-for','sc-if'].includes(el.tag) || el.attrs.some(a => /^(?:sc-|x-)(?:for|if)$/.test(a.name));
const encode = (value: string) => value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const attr = (el: SourceElement, name: string) => el.attrs.find(a => a.name.toLowerCase() === name)?.value;
function ancestors(el: SourceElement, elements: SourceElement[]): SourceElement[] {
  const chain: SourceElement[] = []; let next = el.parentTid;
  while(next !== null) { const parent = elements[next]; if(!parent) fail('父级关系无法确认'); chain.push(parent!); next = parent!.parentTid; }
  return chain;
}
function effectiveParent(el: SourceElement, elements: SourceElement[]) { return ancestors(el,elements).find(p => !['sc-for','sc-if'].includes(p.tag)) ?? null; }
export function canContain(parent: SourceElement, childTag: string) {
  if(parent.isVoid || parent.selfClosing || forbidden.has(parent.tag) || ['textarea','title','option'].includes(parent.tag)) fail(`<${parent.tag}> 不能作为插入容器`);
  if(constrained[parent.tag] && !constrained[parent.tag]!.includes(childTag)) fail(`<${parent.tag}> 不能直接包含 <${childTag}>`);
  if(onlyParents[childTag] && !onlyParents[childTag]!.includes(parent.tag)) fail(`<${childTag}> 不能移入 <${parent.tag}>`);
  if(phraseParents.has(parent.tag) && !phrasing.has(childTag)) fail(`<${parent.tag}> 只允许行内内容，不能包含 <${childTag}>`);
  if((parent.tag === 'a' && childTag === 'a') || (parent.tag === 'button' && ['button','a','input','select','textarea'].includes(childTag))) fail('此操作会产生嵌套交互控件');
}
export function validateNesting(source: string) {
  const elements = listElements(source);
  for(const el of elements) {
    if(forbidden.has(el.tag) || ['sc-for','sc-if'].includes(el.tag)) continue;
    const parent = effectiveParent(el,elements);
    if(parent && !forbidden.has(parent.tag)) canContain(parent,el.tag);
    const chain=ancestors(el,elements);
    if(el.tag==='a' && chain.some(p=>p.tag==='a')) fail('链接不能嵌套链接');
    if(['button','a','input','select','textarea'].includes(el.tag) && chain.some(p=>p.tag==='button')) fail('按钮不能包含交互控件');
  }
}
function protect(el: SourceElement, elements: SourceElement[], allowRoot: boolean) {
  if(!allowRoot && !effectiveParent(el,elements)) fail('画板实际根元素不能删除、复制、移动或包裹');
  if(forbidden.has(el.tag) || ancestors(el,elements).some(p=>forbidden.has(p.tag))) fail('元数据或导入组件内部不能做结构编辑');
  if(elements.some(e=>e.full[0]>=el.inner[0] && e.full[1]<=el.inner[1] && forbidden.has(e.tag))) fail('所选子树包含元数据、脚本或组件，暂不支持安全结构编辑');
}
/** Duplicate local IDs plus fragment/ARIA/SVG references. Script/event bindings are intentionally refused. */
export function duplicateFragment(source: string, el: SourceElement, occupiedIds: Iterable<string> = []): string {
  let fragment = source.slice(...el.full);
  const all = listElements(source), sub = all.filter(e=>e.full[0]>=el.full[0] && e.full[1]<=el.full[1]);
  if(sub.some(e=>e.attrs.some(a=>/^on/i.test(a.name))) || /<(?:script|dc-import|x-import)\b/i.test(fragment)) fail('副本包含事件或脚本组件，无法证明引用安全');
  const used = new Set([...all.map(e=>attr(e,'id')).filter(Boolean) as string[], ...occupiedIds]), remap = new Map<string,string>();
  for(const e of sub) {
    const id = attr(e,'id'); if(!id) continue;
    if(/\{\{|[&\s]/.test(id) || remap.has(id) || all.filter(n=>attr(n,'id')===id).length!==1) fail('原有 id 重复或动态，无法安全复制');
    let next = `${id}-copy`, n=2; while(used.has(next)) next=`${id}-copy-${n++}`;
    used.add(next); remap.set(id,next);
  }
  // A script or stylesheet can refer to an id indirectly; conservative refusal avoids silent breakage.
  if(remap.size && /<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi.test(source)) {
    const blocks = [...source.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
    for(const id of remap.keys()) {
      const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const selector=new RegExp('#'+escaped+'(?![a-zA-Z0-9_-])');
      for(const block of blocks) {
        const body=block[2]??'';
        if(selector.test(body) || (block[1]!.toLowerCase()==='script' && (/getElementById|querySelector|closest\s*\(|matches\s*\(/.test(body) || new RegExp('[\"\'`]' + escaped + '[\"\'`]').test(body)))) fail(`脚本或样式引用了 #${id}，不能安全重写副本`);
      }
    }
  }
  const replacements: {from:number;to:number;text:string}[]=[];
  for(const e of sub) for(const a of e.attrs) {
    if(a.value===null || !a.valueSpan) continue;
    let value=a.value;
    if(a.name.toLowerCase()==='id') value=remap.get(value) ?? value;
    else if(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','headers','list','form'].includes(a.name.toLowerCase())) value=value.split(/(\s+)/).map(v=>remap.get(v)??v).join('');
    else if(['href','xlink:href'].includes(a.name.toLowerCase()) && value.startsWith('#')) value='#'+(remap.get(value.slice(1))??value.slice(1));
    value=value.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g,(whole,quote,id)=>remap.has(id)?`url(${quote}#${remap.get(id)}${quote})`:whole);
    if(value!==a.value) replacements.push({from:a.valueSpan[0]-el.full[0],to:a.valueSpan[1]-el.full[0],text:value});
  }
  for(const r of replacements.sort((a,b)=>b.from-a.from)) fragment=fragment.slice(0,r.from)+r.text+fragment.slice(r.to);
  return fragment;
}
function checkScope(el: SourceElement, parent: SourceElement, elements: SourceElement[]) {
  const from=ancestors(el,elements).filter(scopeTag).map(e=>e.tid);
  const to=[parent,...ancestors(parent,elements)].filter(scopeTag).map(e=>e.tid);
  if(JSON.stringify(from)!==JSON.stringify(to)) fail('移动会跨越循环或条件绑定作用域，暂不支持');
}
function edits(source: string, changes: {from:number;to:number;text:string}[]) {
  for(const item of changes.sort((a,b)=>b.from-a.from)) source=source.slice(0,item.from)+item.text+source.slice(item.to);
  return source;
}
export function planStructure(source: string, request: StructureRequest): StructurePlan {
  if(!request.revision || request.sourceRef?.revision!==request.revision) fail('结构操作必须提供一致的源码版本');
  const el=validateSourceRef(source,request.sourceRef,{canvas:request.canvas,board:request.board});
  const elements=listElements(source), parent=el.parentTid===null?null:elements[el.parentTid]!;
  const action=request.action; protect(el,elements,action==='insert');
  const marker='dsh-'+randomUUID(); const markerAttr=` data-dsh-structure-focus="${marker}"`;
  const mark=(fragment:string)=>fragment.replace(/^<([A-Za-z][\w:-]*)/,`<$1${markerAttr}`);
  const piece=source.slice(...el.full); const warnings:string[]=[];
  const scoped=[el,...ancestors(el,elements)].filter(scopeTag);
  if(scoped.length) warnings.push('所选元素属于循环或条件模板：修改影响该模板的全部实例，而非仅当前可见实例。');
  const sub=elements.filter(e=>e.full[0]>=el.full[0] && e.full[1]<=el.full[1]);
  if(sub.some(scopeTag)) warnings.push('所选子树包含循环或条件模板，操作会影响整个子树及全部渲染实例。');
  let candidate=source;
  if(action==='delete') {
    candidate=source.slice(0,el.full[0])+source.slice(el.full[1]);
    if(parent) { const offset=parent.startTag[0]; candidate=candidate.slice(0,offset)+mark(candidate.slice(offset)); }
  } else if(action==='duplicate') {
    const gap=/\n([ \t]*)$/.exec(source.slice(0,el.full[0])); const separator=gap?'\n'+gap[1]:'';
    candidate=source.slice(0,el.full[1])+separator+mark(duplicateFragment(source,el))+source.slice(el.full[1]);
  } else if(action==='insert') {
    const snippets:Record<string,string>={text:`<p style="margin: 0; font-size: 16px">${encode(request.text??'新文字')}</p>`,rect:'<div style="width: 120px; height: 80px; background: #dbeafe"></div>',divider:'<hr style="border: 0; border-top: 1px solid #cbd5e1; margin: 12px 0">'};
    if(request.kind==='image') { if(!request.asset || !/^[A-Za-z0-9_-]+$/.test(request.asset)) fail('必须选择设计稿中已有的图片素材'); snippets.image=`<img src="/_blob/${request.asset}" alt="" style="width: 160px; height: auto">`; }
    const snippet=snippets[request.kind??'']; if(!snippet) fail('不支持的插入类型');
    const tag=/^<(\w+)/.exec(snippet)![1]!; canContain(el,tag);
    const indent=/\n([ \t]*)$/.exec(source.slice(0,el.full[0]))?.[1]??'';
    candidate=source.slice(0,el.inner[1])+'\n'+indent+'  '+mark(snippet)+'\n'+indent+source.slice(el.inner[1]);
  } else if(action==='up'||action==='down') {
    if(!parent) fail('根元素不能重排');
    const siblings=elements.filter(e=>e.parentTid===el.parentTid), index=siblings.findIndex(item=>item.tid===el.tid), other=siblings[index+(action==='up'?-1:1)];
    if(!other) return {source,focusTid:el.tid,warnings:[],confirmation:'',changed:false};
    protect(other!,elements,false);
    const a=action==='up'?other:el,b=action==='up'?el:other;
    const gap=source.slice(a!.full[1],b!.full[0]); if(gap.trim()) fail('相邻元素间包含文字或注释，移动归属不明确，已停止');
    candidate=source.slice(0,a!.full[0])+(action==='up'?mark(piece):source.slice(...other!.full))+gap+(action==='up'?source.slice(...other!.full):mark(piece))+source.slice(b!.full[1]);
  } else if(action==='indent') {
    const siblings=elements.filter(e=>e.parentTid===el.parentTid), previous=siblings[siblings.findIndex(item=>item.tid===el.tid)-1];
    if(!previous) fail('前面没有可移入的兄弟容器');
    protect(previous,elements,true); canContain(previous,el.tag); checkScope(el,previous,elements);
    if(source.slice(previous.full[1],el.full[0]).trim()) fail('相邻内容有文字或注释，移入归属不明确');
    candidate=edits(source,[{from:el.full[0],to:el.full[1],text:''},{from:previous.inner[1],to:previous.inner[1],text:mark(piece)}]);
  } else if(action==='outdent') {
    if(!parent) fail('没有可移出的父级');
    const grand=parent.parentTid===null?null:elements[parent.parentTid]; if(!grand) fail('不能移出画板实际根元素');
    protect(parent,elements,false); canContain(grand!,el.tag); checkScope(el,grand!,elements);
    // Moving a non-last child out after its parent changes reading order; make the impact explicit.
    warnings.push('移出后，元素位于原父级之后，可能改变布局与阅读顺序。');
    candidate=edits(source,[{from:el.full[0],to:el.full[1],text:''},{from:parent.full[1],to:parent.full[1],text:mark(piece)}]);
  } else if(action==='wrap-flex'||action==='wrap-grid') {
    if(!parent) fail('不能包裹画板根元素'); canContain(effectiveParent(el,elements)!, 'div');
    for(const item of sub) {
      const style=parseInlineStyle(item.style);
      if((style.position && style.position!=='static') || (style.transform && style.transform!=='none') || (style['z-index'] && style['z-index']!=='auto') || style.perspective || style.filter || style.contain) fail('元素含定位、变换或层叠上下文，无法安全包裹');
    }
    const parentStyle=parseInlineStyle(parent.style), ownStyle=parseInlineStyle(el.style);
    if(/flex|grid/.test(parentStyle.display??'')) warnings.push('父级使用 flex/grid：包裹层会成为新的布局项。');
    if(Object.entries(ownStyle).some(([key,value])=>/width|height|margin|flex|grid|align|order/.test(key) && value)) warnings.push('尺寸、margin 和布局项属性可能改变包裹后的大小与间距。');
    warnings.push('请对比包裹预览；确认后保存，取消不会写入文件。');
    candidate=source.slice(0,el.full[0])+`<div${markerAttr} style="display: ${action==='wrap-flex'?'flex; flex-direction: column':'grid; grid-template-columns: 1fr'}">`+piece+'</div>'+source.slice(el.full[1]);
  } else fail('未知结构操作');
  validateNesting(candidate);
  const focus=listElements(candidate).find(e=>attr(e,'data-dsh-structure-focus')===marker)?.tid??null;
  candidate=candidate.replace(markerAttr,'');
  return {source:candidate,focusTid:focus,warnings,changed:candidate!==source,confirmation:createHash('sha256').update(request.revision+'\n'+candidate).digest('hex')};
}
