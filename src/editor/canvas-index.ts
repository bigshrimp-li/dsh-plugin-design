/** Validation and immutable planning for editor-only canvas annotations. */
export type CanvasIndex = Record<string, any>;
export const NOTE_COLORS = ['gray','red','orange','green','teal','blue','purple','pink'];
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const own = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export class CanvasIndexError extends Error { status = 422; code = 'invalid_canvas_annotation'; }
const fail = (message: string): never => { throw new CanvasIndexError(message); };
const number = (v: unknown, min: number, max = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function validateGuide(guide: unknown, board: {w:number;h:number}) {
  if (!own(guide) || !['columns','rows','grid'].includes(guide.kind)) fail('参考线类型必须是 columns、rows 或 grid');
  const g = guide as Record<string,any>;
  for (const field of ['size','gutter','margin','offset']) if (g[field] !== undefined && !number(g[field], field === 'size' ? Number.MIN_VALUE : 0)) fail(`参考线 ${field} 必须是有效的${field==='size'?'正':'非负'}数`);
  if (g.count !== undefined && g.count !== 'auto' && !(Number.isSafeInteger(g.count) && g.count >= 1)) fail('参考线 count 必须是 auto 或正整数');
  if (g.align !== undefined && !['stretch','start','center','end'].includes(g.align)) fail('参考线 align 无效');
  if (g.hidden !== undefined && typeof g.hidden !== 'boolean') fail('参考线 hidden 必须是布尔值');
  if (g.color !== undefined && (typeof g.color !== 'string' || !/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgb|hsl)a?\([\d\s.,%+\-/]+\))$/i.test(g.color))) fail('参考线颜色必须是 hex、rgb() 或 hsl()');
  if (g.color && g.color[0] !== '#') {
    const parts=g.color.slice(g.color.indexOf('(')+1,-1).trim().split(/[\s,/]+/).filter(Boolean);
    if (parts.length<3 || parts.length>4 || parts.some((v:string)=>!Number.isFinite(Number(v.replace('%',''))))) fail('参考线颜色分量无效');
  }
  if (g.kind !== 'grid') {
    const length = g.kind === 'columns' ? board.w : board.h;
    const inner = length - 2*(g.margin ?? 0), gutter=g.gutter ?? 0, size=g.size ?? 8;
    const count=g.count ?? (g.kind==='rows'?'auto':12);
    const n=count==='auto'?Math.floor((inner+gutter)/(size+gutter)):count;
    if (inner<=0 || n<1 || ((g.align??'stretch')==='stretch' && inner-(n-1)*gutter<=0)) fail('参考线边距或间距过大，无法容纳轨道');
    if ((g.align??'stretch')!=='stretch' && n*size+(n-1)*gutter+(g.offset??0)>inner) fail('固定参考线超出可用范围');
  }
}
export function validateCanvasAnnotations(index: CanvasIndex) {
  const pages=new Set((index.pages??[]).map((p:any)=>p.id));
  for (const [name,b] of Object.entries(index.boards??{}) as [string,any][]) {
    if (b.guides===undefined) continue;
    if (!Array.isArray(b.guides) || b.guides.length>6) fail(`${name} 最多设置 6 条参考线`);
    for (const g of b.guides) validateGuide(g,b);
  }
  if (index.notes!==undefined && !own(index.notes)) fail('notes 必须是对象');
  const entries=Object.entries(index.notes??{}) as [string,any][];
  if(entries.length>200) fail('便签和画布图形总数不能超过 200');
  for(const [id,n] of entries) {
    if(!ID.test(id) || !own(n)) fail('便签 id 或对象格式无效');
    if(n.kind!==undefined && n.kind!=='title1') continue; // User drawings are opaque and never edited here.
    if(!number(n.x,-Infinity)||!number(n.y,-Infinity)||typeof n.text!=='string') fail('便签需要有限坐标和纯文本');
    const width=n.kind==='title1'?'maxW':'w';
    if(!number(n[width],Number.MIN_VALUE)) fail(`便签 ${width} 必须为正数`);
    if(n.maxH!==undefined&&!number(n.maxH,Number.MIN_VALUE)) fail('便签 maxH 必须为正数');
    if(n.page!==undefined&&(typeof n.page!=='string'||!pages.has(n.page))) fail('便签页面不存在');
    for(const key of ['color','fill']) if(n[key]!==undefined&&!NOTE_COLORS.includes(n[key])) fail(`便签 ${key} 颜色无效`);
    for(const key of ['bold','italic']) if(n[key]!==undefined&&typeof n[key]!=='boolean') fail(`便签 ${key} 必须为布尔值`);
    if(n.size!==undefined && !(number(n.size,Number.MIN_VALUE)||['s','m','l','xl','xxl'].includes(n.size)||(typeof n.size==='string'&&/^\d+(?:\.\d+)?px$/.test(n.size)&&number(parseFloat(n.size),Number.MIN_VALUE)))) fail('便签字号必须是 正数 px 或 s/m/l/xl/xxl');
    if(n.kind==='title1'&&Object.values(index.boards??{}).filter((b:any)=>(b.page??'')===(n.page??'')).length<2) fail('分组标题只能用于同一页面的多块画板');
  }
}
export function planCanvasIndex(index: CanvasIndex, request: Record<string, any>): CanvasIndex {
  const next=structuredClone(index);
  const board=next.boards?.[request.board];
  if(!board||!Object.hasOwn(next.boards,request.board)) fail('目标画板不存在');
  if(request.action==='set-guides') {
    if(!Array.isArray(request.guides)) fail('缺少参考线列表');
    board.guides=structuredClone(request.guides);
  } else {
    const notes=next.notes??(next.notes={});
    const id=request.id;
    if(typeof id!=='string'||!ID.test(id)) fail('便签 id 无效');
    if(request.action==='add-note') {
      if(Object.hasOwn(notes,id)) fail('便签 id 已存在');
      const n=own(request.note)?structuredClone(request.note):{};
      if(n.kind!==undefined&&n.kind!=='title1') fail('不能新增用户绘制的图形');
      if(n.kind==='title1') {
        const targets=Object.values(next.boards).filter((b:any)=>(b.page??'')===(n.page??'')) as any[];
        if(targets.length<2) fail('分组标题需要同一页面至少两块画板');
        n.x=Math.min(...targets.map(b=>b.x)); n.y=Math.min(...targets.map(b=>b.y))-223;
        n.maxW??=Math.max(...targets.map(b=>b.x+b.w))-n.x;
        const obstacles=[...Object.values(next.boards).filter((b:any)=>(b.page??'')===(n.page??'')),...Object.values(notes).filter((v:any)=>(v.page??'')===(n.page??''))] as any[];
        let available=false;
        for(let attempt=0;attempt<100;attempt++,n.y-=120) {
          const height=n.maxH??90;
          if(!obstacles.some(o=>n.x<(o.x+(o.w??o.maxW??240)) && n.x+n.maxW>o.x && n.y<(o.y+(o.h??o.maxH??((o.w??240)*4/3))) && n.y+height>o.y)){available=true;break;}
        }
        if(!available) fail('标题上方没有合适空位，请先移动已有便签');
      }
      Object.defineProperty(notes,id,{value:n,enumerable:true,writable:true,configurable:true});
    } else {
      if(!Object.hasOwn(notes,id)) fail('便签不存在');
      if(notes[id].kind!==undefined&&notes[id].kind!=='title1') fail('不能修改或删除用户绘制的图形');
      if(request.action==='delete-note') delete notes[id];
      else if(request.action==='update-note') {
        if(!own(request.patch)) fail('缺少便签修改字段');
        for(const [key,value] of Object.entries(request.patch)) {
          if(!['x','y','text','w','maxW','maxH','page','color','fill','size','bold','italic'].includes(key)) fail(`不支持修改便签字段：${key}`);
          if(value===null) delete notes[id][key]; else notes[id][key]=value;
        }
      } else fail('未知画布辅助操作');
    }
  }
  validateCanvasAnnotations(next);
  return next;
}
