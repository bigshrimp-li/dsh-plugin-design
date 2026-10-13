const COLORS={gray:'#374151',red:'#b91c1c',orange:'#c2410c',green:'#15803d',teal:'#0f766e',blue:'#1d4ed8',purple:'#7e22ce',pink:'#be185d'};
const FILLS={gray:'#f3f4f6',red:'#fee2e2',orange:'#ffedd5',green:'#dcfce7',teal:'#ccfbf1',blue:'#dbeafe',purple:'#f3e8ff',pink:'#fce7f3'};
const SIZES={s:14,m:18,l:24,xl:36,xxl:48};
const fontSize=n=>typeof n.size==='number'?n.size:SIZES[n.size]||parseFloat(n.size)||(n.kind==='title1'?72:18);
const inputTarget=t=>t?.closest?.('input,textarea,select,button,[contenteditable]');
export function guideGeometry(g,b) {
  if(g.hidden) return null;
  const color=g.color||'rgba(255,0,0,0.1)';
  if(g.kind==='grid'){const size=g.size??8;if(!(size>0))return null;return {backgroundImage:`linear-gradient(${color} 1px, transparent 1px),linear-gradient(90deg, ${color} 1px, transparent 1px)`,backgroundSize:`${size}px ${size}px`,left:0,top:0,width:b.w,height:b.h};}
  const vertical=g.kind==='columns',length=vertical?b.w:b.h,margin=g.margin??0,gutter=g.gutter??0,inner=length-2*margin;
  let count=g.count??(vertical?12:'auto'),size=g.size??8; if(count==='auto')count=Math.floor((inner+gutter)/(size+gutter));
  if(!(count>0&&inner>0))return null;
  const align=g.align??'stretch'; if(align==='stretch')size=(inner-(count-1)*gutter)/count;
  if(!(size>0))return null;
  const extent=count*size+(count-1)*gutter,offset=g.offset??0;
  const start=margin+(align==='center'?(inner-extent)/2+offset:align==='end'?inner-extent-offset:offset);
  return {left:vertical?start:0,top:vertical?0:start,width:vertical?extent:b.w,height:vertical?b.h:extent,backgroundImage:`repeating-linear-gradient(${vertical?'90deg':'180deg'},${color} 0px,${color} ${size}px,transparent ${size}px,transparent ${size+gutter}px)`};
}
export function install(editor) {
  const {state,el,events}=editor,viewport=editor.features.viewport;
  const css=document.createElement('link');css.rel='stylesheet';css.href='/notes.css';document.head.appendChild(css);
  const layer=document.createElement('div');layer.className='annotation-layer';viewport.layer.appendChild(layer);
  const panel=document.createElement('section');panel.className='annotation-panel';panel.setAttribute('aria-label','画布辅助');panel.hidden=true;document.body.appendChild(panel);
  let selected=null,busy=false,drag=null,choosing=false,mode='select',lastPage=viewport.page;
  function chooseNote(id){choosing=true;try{editor.bridge()?.selectMany?.([],true);}finally{choosing=false;}selected=id;}
  const controls=editor.addButton('canvasAnnotations','便签与参考线',()=>{panel.hidden=!panel.hidden;if(!panel.hidden)renderPanel();});
  const add=editor.addButton('addNote','加便签',()=>addNote(false));
  const title=editor.addButton('addGroupTitle','加分组标题',()=>addNote(true));
  const pageForBoard=()=>state.canvasIndex?.boards?.[state.board]?.page;
  const editable=n=>n&&(n.kind===undefined||n.kind==='title1');
  const selectedNote=()=>state.canvasIndex?.notes?.[selected];
  const visible=n=>viewport.page==='*'||(n.page||'')===viewport.page;
  function refreshButtons(){const notes=Object.keys(state.canvasIndex?.notes||{});add.disabled=busy||!state.canvas||notes.length>=200;title.hidden=Object.values(state.canvasIndex?.boards||{}).filter(b=>(b.page||'')===(pageForBoard()||'')).length<2;title.disabled=add.disabled;for(const b of [add,title,controls])b.hidden=mode!=='select'||(b===title&&title.hidden);layer.hidden=mode!=='select';if(mode!=='select')panel.hidden=true;}
  async function mutate(request,target={canvas:state.canvas,board:state.board},revision=state.indexRevision) {
    if(busy)return;
    busy=true;refreshButtons();
    try {
      await editor.beforeAction();
      if(state.canvas!==target.canvas||state.board!==target.board)throw new Error('画板已切换，请重新操作');
      const out=await editor.post('/api/canvas-index',{...target,revision,...request});
      if(state.canvas===target.canvas){state.canvasIndex=out.index;state.indexRevision=out.indexRevision;await editor.acceptMutation(out,{reload:false});viewport.refresh();render();renderPanel();}
      return out;
    } catch(error){editor.toast(error.message,true);render();throw error;}
    finally{busy=false;refreshButtons();renderPanel();}
  }
  async function addNote(isTitle) {
    const b=viewport.boardRect(),id='note_'+Math.random().toString(36).slice(2,12);
    const note={x:b.x+b.w+40,y:b.y,text:isTitle?'画板分组':'新便签',...(pageForBoard()?{page:pageForBoard()}:{}),...(isTitle?{kind:'title1',maxW:b.w}:{w:240,fill:'orange'})};
    if(isTitle)delete note.maxW;
    chooseNote(id);await mutate({action:'add-note',id,note});panel.hidden=false;renderPanel();
  }
  function render(){
    if(drag)return;
    layer.replaceChildren();
    for(const [name,b] of Object.entries(state.canvasIndex?.boards||{})) if(visible(b)) for(const g of b.guides||[]) {
      const geometry=guideGeometry(g,b);if(!geometry)continue;
      const node=document.createElement('div');node.className='canvas-guide';node.dataset.board=name;
      Object.assign(node.style,{...geometry,left:(b.x+geometry.left)+'px',top:(b.y+geometry.top)+'px',width:geometry.width+'px',height:geometry.height+'px'});layer.appendChild(node);
    }
    for(const [id,n] of Object.entries(state.canvasIndex?.notes||{}))if(editable(n)&&visible(n)){
      const node=document.createElement('div');node.className='canvas-note'+(n.kind==='title1'?' group-title':'');node.dataset.note=id;node.tabIndex=0;node.setAttribute('aria-label',n.kind==='title1'?'分组标题':'便签');node.setAttribute('aria-selected',String(id===selected));
      const width=n.kind==='title1'?n.maxW:n.w,maxH=n.maxH??(n.kind==='title1'?90:width*4/3);
      let size=fontSize(n);if(n.kind==='title1'){const measure=document.createElement('canvas').getContext('2d');measure.font=`${n.bold===false?'normal':'bold'} ${size}px sans-serif`;size=Math.min(size,size*(width/Math.max(1,measure.measureText(n.text).width)),maxH/1.2);}
      Object.assign(node.style,{left:n.x+'px',top:n.y+'px',width:width+'px',maxHeight:maxH+'px',fontSize:size+'px',fontWeight:(n.bold??n.kind==='title1')?'bold':'normal',fontStyle:n.italic?'italic':'normal',color:COLORS[n.color||'gray'],background:n.kind==='title1'?'transparent':FILLS[n.fill||'orange']});
      const text=document.createElement('div');text.className='note-text';text.textContent=n.text;node.appendChild(text);
      const handle=document.createElement('span');handle.className='note-resize';handle.title='拖动调整宽度和最大高度';handle.setAttribute('aria-label','调整便签尺寸');node.appendChild(handle);
      node.addEventListener('pointerdown',event=>startDrag(event,node,id,n,event.target===handle));
      node.addEventListener('dblclick',()=>{chooseNote(id);panel.hidden=false;renderPanel();panel.querySelector('textarea')?.focus();});
      node.addEventListener('keydown',event=>{if(event.key==='Enter'){chooseNote(id);panel.hidden=false;renderPanel();}});
      layer.appendChild(node);
    }
    refreshButtons();
  }
  function startDrag(event,node,id,n,resize){
    if(mode!=='select'||busy||event.button!==0||el.wrap.dataset.space==='true'||inputTarget(event.target))return;
    event.preventDefault();event.stopPropagation();chooseNote(id);for(const el of layer.querySelectorAll('[data-note]'))el.setAttribute('aria-selected',String(el.dataset.note===id));panel.hidden=false;renderPanel();
    const start=viewport.clientToWorld({x:event.clientX,y:event.clientY}),target={canvas:state.canvas,board:state.board};
    drag={node,id,n,start,resize,target,revision:state.indexRevision,patch:{}};node.setPointerCapture(event.pointerId);
    const move=e=>{if(!drag)return;const at=viewport.clientToWorld({x:e.clientX,y:e.clientY}),dx=at.x-start.x,dy=at.y-start.y;
      drag.patch=resize?{[n.kind==='title1'?'maxW':'w']:Math.max(20,(n.maxW??n.w)+dx),maxH:Math.max(20,(n.maxH??(n.w?n.w*4/3:90))+dy)}:{x:n.x+dx,y:n.y+dy};
      if(resize){node.style.width=drag.patch[n.kind==='title1'?'maxW':'w']+'px';node.style.maxHeight=drag.patch.maxH+'px';}else{node.style.left=drag.patch.x+'px';node.style.top=drag.patch.y+'px';}};
    const end=e=>{const active=drag;drag=null;node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',end);node.removeEventListener('pointercancel',end);if(e.type==='pointercancel'||!Object.keys(active?.patch||{}).length){render();return;}mutate({action:'update-note',id,patch:active.patch},target,active.revision).catch(()=>{});};
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',end);node.addEventListener('pointercancel',end);
  }
  const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.className='btn';b.textContent=text;b.addEventListener('click',()=>Promise.resolve().then(fn).catch(e=>editor.toast(e.message,true)));return b;};
  function field(parent,label,value,options){const row=document.createElement('label');row.textContent=label;let input;
    if(options){input=document.createElement('select');for(const [v,t] of options)input.appendChild(new Option(t,v));}
    else input=document.createElement(label==='文字'?'textarea':'input');input.value=value??'';input.setAttribute('aria-label',label);row.appendChild(input);parent.appendChild(row);return input;}
  function renderPanel(){if(panel.hidden)return;panel.replaceChildren();const heading=document.createElement('strong');heading.textContent='画布辅助';panel.append(heading,button('关闭',()=>panel.hidden=true));
    const note=selectedNote();
    if(editable(note)){
      const group=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent=note.kind==='title1'?'分组标题':'便签';group.appendChild(legend);panel.appendChild(group);
      const inputs={};for(const key of ['text',note.kind==='title1'?'maxW':'w','maxH','size'])inputs[key]=field(group,({text:'文字',w:'宽度',maxW:'最大宽度',maxH:'最大高度',size:'字号'})[key],note[key]);
      inputs.page=field(group,'页面',note.page||'',[['','未分组'],...(state.canvasIndex.pages||[]).map(p=>[p.id,p.name])]);
      for(const key of note.kind==='title1'?['color']:['color','fill'])inputs[key]=field(group,key==='color'?'文字颜色':'底色',note[key]||(key==='fill'?'orange':'gray'),Object.keys(COLORS).map(k=>[k,k]));
      for(const key of ['bold','italic']){inputs[key]=field(group,key==='bold'?'粗体':'斜体',String(note[key]??(key==='bold'&&note.kind==='title1')),[['false','否'],['true','是']]);}
      const id=selected,target={canvas:state.canvas,board:state.board},revision=state.indexRevision;
      const save=()=>{const patch={};for(const [key,input]of Object.entries(inputs)){patch[key]=input.value===''?(key==='text'?'':null):['bold','italic'].includes(key)?input.value==='true':['w','maxW','maxH'].includes(key)?Number(input.value):key==='size'&&/^\d+(\.\d+)?$/.test(input.value)?Number(input.value):input.value;}return mutate({action:'update-note',id,patch},target,revision);};
      group.append(button('保存便签',save),button('取消',renderPanel),button('删除便签',async()=>{await mutate({action:'delete-note',id},target,revision);selected=null;renderPanel();}));
      inputs.text.addEventListener('keydown',e=>{if(e.isComposing)return;if(e.key==='Escape'){e.preventDefault();renderPanel();}if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();save().catch(()=>{});}});
    }
    const title=document.createElement('h4');title.textContent='当前画板参考线';panel.appendChild(title);
    const b=state.canvasIndex?.boards?.[state.board];if(!b)return;
    const guides=structuredClone(b.guides||[]),target={canvas:state.canvas,board:state.board},revision=state.indexRevision;
    guides.forEach((guide,index)=>{
      const group=document.createElement('fieldset');panel.appendChild(group);const inputs={};
      inputs.kind=field(group,'参考线类型',guide.kind,['columns','rows','grid'].map(k=>[k,k]));
      for(const key of ['count','size','gutter','margin','offset','color'])inputs[key]=field(group,key,guide[key]);
      inputs.align=field(group,'对齐',guide.align||'stretch',['stretch','start','center','end'].map(k=>[k,k]));
      inputs.hidden=field(group,'隐藏',String(guide.hidden||false),[['false','否'],['true','是']]);
      group.append(button('保存参考线',()=>{const next={...guide};for(const [key,input]of Object.entries(inputs)){if(input.value===''){delete next[key];continue;}next[key]=key==='hidden'?input.value==='true':['size','gutter','margin','offset'].includes(key)?Number(input.value):key==='count'&&input.value!=='auto'?Number(input.value):input.value;}const list=[...guides];list[index]=next;return mutate({action:'set-guides',guides:list},target,revision);}),button('删除参考线',()=>mutate({action:'set-guides',guides:guides.filter((_,i)=>i!==index)},target,revision)));
    });
    const addGuide=button('新增参考线',()=>mutate({action:'set-guides',guides:[...guides,{kind:'columns',count:12,gutter:0,margin:0}]},target,revision));addGuide.disabled=guides.length>=6||busy;panel.appendChild(addGuide);
  }
  editor.registerShortcut(event=>{if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&(event.key==='Delete'||event.key==='Backspace')&&selected&&editable(selectedNote())&&!inputTarget(event.target)){mutate({action:'delete-note',id:selected}).then(()=>{selected=null;renderPanel();}).catch(()=>{});return true;}return false;});
  events.addEventListener('selection',()=>{if(choosing)return;selected=null;render();renderPanel();});
  events.addEventListener('board',()=>{selected=null;render();renderPanel();});
  events.addEventListener('saved',()=>{render();renderPanel();});
  events.addEventListener('mode',event=>{mode=event.detail;refreshButtons();});
  events.addEventListener('viewport',()=>{if(lastPage!==viewport.page){lastPage=viewport.page;render();renderPanel();}});
  window.addEventListener('blur',()=>{if(drag){drag=null;render();}});
  editor.features.notes={render,mutate,select(id){chooseNote(id);panel.hidden=false;render();renderPanel();},get selected(){return selected;}};
  render();
}
