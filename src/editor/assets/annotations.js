/** Annotation memory belongs to a Harness session and a canvas, never to a tid alone. */
export function install(editor) {
  const {state,el,events}=editor, memories=new Map();
  let enabled=false, browsing=false, busy=false, editingId=null, draftTargets=[], activeKey='', tick;
  const sessionKey=()=>{
    const value=editor.hostSession;
    return typeof value==='string'?value:JSON.stringify(value||{standalone:true});
  };
  const key=()=>JSON.stringify([sessionKey(),state.canvas]);
  function memory(){const id=key();if(!memories.has(id))memories.set(id,{items:[],nextId:1});return memories.get(id);}
  const style=document.createElement('style');
  style.textContent='.design-annotation-panel{padding:10px 12px;border-top:1px solid var(--line);max-height:48%;overflow:auto;background:var(--panel)}.design-annotation-panel[hidden]{display:none}.design-annotation-panel textarea{width:100%;min-height:60px;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);padding:6px}.annotation-actions{display:flex;gap:4px;flex-wrap:wrap;margin:6px 0}.annotation-actions button{font:inherit}.annotation-item{border-top:1px solid var(--line);padding:8px 0}.annotation-item p{margin:3px 0;white-space:pre-wrap;overflow-wrap:anywhere}.annotation-item[data-stale="true"]{color:var(--danger)}.annotation-outline{position:absolute;border:1px solid #d97706;pointer-events:none!important;box-sizing:border-box}.annotation-number{position:absolute;border:0;border-radius:50%;width:24px;height:24px;padding:0;background:#d97706;color:white;font:bold 12px system-ui;transform-origin:top left;cursor:pointer}.annotation-copy-dialog{width:min(700px,85vw);background:var(--panel);color:var(--ink)}.annotation-copy-dialog textarea{width:100%;height:45vh}';
  document.head.append(style);
  const panel=document.createElement('section');panel.className='design-annotation-panel';panel.hidden=true;panel.setAttribute('aria-label','设计稿标注');
  const title=document.createElement('strong');title.textContent='标注回流';
  const selectionText=document.createElement('p');selectionText.className='hint';selectionText.textContent='选择元素或框选区域，然后写批注。';
  const input=document.createElement('textarea');input.maxLength=10000;input.placeholder='例如：标题增大，改为主色';input.setAttribute('aria-label','用户批注');
  const controls=document.createElement('div');controls.className='annotation-actions';
  const list=document.createElement('div');list.setAttribute('aria-live','polite');
  function control(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',()=>Promise.resolve().then(fn).catch(error=>editor.toast(error.message,true)));return b;}
  const save=control('保存标注',saveNote);save.id='annotationSave';
  const choose=control('使用当前选区',()=>pick(editor.features.selection.getSelection()));
  const region=control('框选区域',()=>editor.features.selection.captureRegion(pick));
  const fresh=control('新建',()=>{editingId=null;input.value='';draftTargets=[];render();});
  controls.append(save,choose,region,fresh);
  const output=document.createElement('div');output.className='annotation-actions';
  const insert=control('插入当前会话草稿',()=>exportNotes('insert'));insert.id='annotationInsert';
  const copy=control('复制全部标注',()=>exportNotes('copy'));copy.id='annotationCopy';output.append(insert,copy);
  panel.append(title,selectionText,input,controls,list,output);el.inspector.parentElement.append(panel);
  const toggle=editor.addButton('annotationsMode','标注',()=>{
    if(browsing)return;
    enabled=!enabled;panel.hidden=!enabled;toggle.setAttribute('aria-pressed',String(enabled));editor.bridge()?.setAnnotationMode?.(enabled);
    if(enabled){pick(editor.features.selection.getSelection());editor.toast('点选或拖框标注；按住 Alt 可临时标注。');}
  });
  const markers=document.createElement('div');markers.style.cssText='position:absolute;left:0;top:0;width:0;height:0;pointer-events:none';
  editor.features.viewport.layer.append(markers);
  function pick(infos){
    if(browsing||!infos.length)return;
    const invalid=infos.find(info=>!info.writable||!info.sourceRef);if(invalid){editor.toast(invalid.readonlyReason||'来源不明，不能标注',true);return;}
    panel.hidden=false;
    draftTargets=infos.map(info=>({sourceRef:{...info.sourceRef},instance:{...info.instance,path:[...info.instance.path]},runtime:runtime(info)}));
    render();input.focus();
  }
  function runtime(info){const node=editor.bridge()?.resolveInstance?.(info);return{node,text:node?.textContent||'',path:JSON.stringify(info.instance.path)};}
  function clearDraft(){editingId=null;draftTargets=[];input.value='';}
  function ensureContext(context){if(context!==key())throw new Error('会话或设计稿已切换，标注操作已取消');}
  async function saveNote(){
    if(busy)return;
    if(!input.value.trim())throw new Error('请填写批注');
    if(!draftTargets.length)throw new Error('请先选择元素或区域');
    const context=key(),note=input.value,targets=draftTargets.slice(),id=editingId;
    busy=true;render();
    try{
      await editor.beforeAction();ensureContext(context);
      const result=await editor.post('/api/annotations/resolve',{canvas:state.canvas,board:state.board,targets:targets.map(({sourceRef,instance})=>({sourceRef,instance}))});ensureContext(context);
      const m=memory(),item={id:id??m.nextId++,note,targets:result.targets,runtime:targets.map(t=>t.runtime),stale:null};
      const at=m.items.findIndex(entry=>entry.id===id);if(at<0)m.items.push(item);else m.items[at]=item;
      clearDraft();render();drawMarkers();events.dispatchEvent(new Event('annotations-changed'));editor.toast('标注已保留，可插入会话草稿');
    }finally{busy=false;render();}
  }
  function openItem(item){editingId=item.id;input.value=item.note;draftTargets=item.targets.map((t,i)=>({...t,runtime:item.runtime[i]}));panel.hidden=false;render();input.focus();}
  function stale(item,reason){if(item.stale)return false;item.stale=reason;return true;}
  function runtimeReady(){const b=editor.bridge(),context=b?.sourceContext;return b?.ready&&context?.canvas===state.canvas&&context?.board===state.board&&context?.revision===state.revision;}
  function validateRuntime(){
    let changed=false;const currentDoc=el.board.contentDocument;
    for(const item of memory().items){
      if(item.stale)continue;
      for(let i=0;i<item.targets.length;i++){
        const t=item.targets[i],r=item.runtime?.[i];if(!r){changed=stale(item,'标注定位已失效，请重新选择')||changed;break;}
        if(t.sourceRef.board!==state.board){if(t.instance.count>1)changed=stale(item,'重复实例已离开当前画板，需要重新选择后确认')||changed;continue;}
        if(t.sourceRef.revision!==state.revision){changed=stale(item,'源码版本已变化，请重新选择')||changed;break;}
        if(!runtimeReady())continue;
        let node=r.node;
        if(node?.ownerDocument!==currentDoc){
          if(t.instance.count>1){changed=stale(item,'重复实例已重建，请重新选择')||changed;break;}
          node=editor.bridge().resolveInstance({tid:t.sourceRef.tid,instance:t.instance});r.node=node;
        }
        const actual=node&&editor.bridge().describe(t.sourceRef.tid,node);
        if(!node?.isConnected||node.textContent!==r.text||!actual?.writable||actual.sourceRef.revision!==t.sourceRef.revision||JSON.stringify(actual.instance.path)!==r.path){changed=stale(item,'渲染实例已变化，已停止精确定位，请重新选择')||changed;break;}
      }
    }
    if(changed)render();return !memory().items.some(item=>item.stale);
  }
  function render(){
    selectionText.textContent=`${editingId===null?'新标注':`编辑 #${editingId}`} · ${draftTargets.length} 个实例`;
    save.disabled=busy;insert.disabled=busy;copy.disabled=busy;
    list.replaceChildren();
    for(const item of memory().items){
      const row=document.createElement('article');row.className='annotation-item';row.dataset.stale=String(!!item.stale);
      const heading=document.createElement('strong');heading.textContent=`#${item.id} · ${item.targets[0]?.title||''} · ${item.targets.length} 个实例`;
      const note=document.createElement('p');note.textContent=item.note;
      const status=document.createElement('p');status.className='hint';status.textContent=item.stale||'定位有效';
      const actions=document.createElement('div');actions.className='annotation-actions';
      actions.append(control('编辑',()=>openItem(item)),control('重新选区',()=>{editingId=item.id;input.value=item.note;draftTargets=[];panel.hidden=false;enabled=true;editor.bridge()?.setAnnotationMode(true);toggle.setAttribute('aria-pressed','true');render();editor.toast('请重新点选或框选目标，再保存标注');}),control('删除',()=>{memory().items=memory().items.filter(entry=>entry!==item);if(editingId===item.id)clearDraft();render();drawMarkers();}));
      row.append(heading,note,status,actions);list.append(row);
    }
  }
  function drawMarkers(){
    markers.replaceChildren();validateRuntime();
    if(browsing||!runtimeReady())return;
    const k=editor.features.viewport.view.k,board=editor.features.viewport.boardRect();
    for(const item of memory().items){
      if(item.stale)continue;let first=null;
      item.targets.forEach((t,i)=>{
        if(t.sourceRef.board!==state.board)return;
        const node=item.runtime[i].node;if(!node?.isConnected)return;
        const info=editor.bridge()?.describe(t.sourceRef.tid,node);if(!info?.writable)return;
        const r=info.box,outline=document.createElement('div');outline.className='annotation-outline';
        Object.assign(outline.style,{left:`${board.x+r.x}px`,top:`${board.y+r.y}px`,width:`${r.w}px`,height:`${r.h}px`,borderWidth:`${1/k}px`});markers.append(outline);first??={x:board.x+r.x,y:board.y+r.y};
      });
      if(first){const bubble=control(String(item.id),()=>openItem(item));bubble.className='annotation-number';bubble.setAttribute('aria-label',`标注 ${item.id}：${item.note}`);bubble.title=item.note;
        Object.assign(bubble.style,{left:`${first.x}px`,top:`${first.y}px`,transform:`scale(${1/k}) translate(-50%,-50%)`,pointerEvents:'auto'});markers.append(bubble);}
    }
  }
  function manualCopy(block){
    const dialog=document.createElement('dialog');dialog.className='annotation-copy-dialog';const caption=document.createElement('p');caption.textContent='系统剪贴板不可用。请选择并复制以下标注。';
    const textarea=document.createElement('textarea');textarea.value=block;textarea.readOnly=true;textarea.setAttribute('aria-label','手动复制标注');
    dialog.append(caption,textarea,control('关闭',()=>{dialog.close();dialog.remove();}));dialog.addEventListener('cancel',()=>dialog.remove());document.body.append(dialog);dialog.showModal();textarea.focus();textarea.select();
  }
  async function exportNotes(kind){
    if(busy)return;
    const context=key(),items=memory().items;if(!items.length)throw new Error('请先保存标注');
    busy=true;render();
    try{
      await editor.beforeAction();ensureContext(context);
      if(!validateRuntime())throw new Error('存在过期标注，请重新选择或删除后再输出');
      let capture;if(kind==='insert'){
        if(!editor.features.composer?.capture||!editor.features.composer?.insert)throw new Error('当前环境没有会话草稿接口，请使用复制标注');
        capture=await editor.features.composer.capture();ensureContext(context);
      }
      const result=await editor.post('/api/annotations/format',{canvas:state.canvas,items:items.map(({id,note,targets})=>({id,note,targets}))});ensureContext(context);
      if(!validateRuntime())throw new Error('输出期间目标实例已变化，请重新选择');
      if(kind==='insert'){await editor.features.composer.insert(capture.token,result.block);ensureContext(context);editor.toast('已插入当前会话草稿，请检查后自行发送');}
      else{try{await navigator.clipboard.writeText(result.block);editor.toast('标注已复制，请粘贴到对话草稿');}catch{ensureContext(context);manualCopy(result.block);}}
      return result.block;
    }catch(error){
      if(error.body?.code==='stale_annotation'||/版本已过期|来源.*不一致/.test(error.message)){for(const item of items)stale(item,'输出前源码校验失败，请重新选择');drawMarkers();}
      throw error;
    }finally{busy=false;render();}
  }
  editor.host.onAnnotationSelect=pick;
  events.addEventListener('viewport',drawMarkers);
  events.addEventListener('saved',()=>{validateRuntime();drawMarkers();});
  events.addEventListener('board',()=>{
    if(activeKey!==key()){activeKey=key();clearDraft();}
    validateRuntime();render();drawMarkers();
  });
  events.addEventListener('bridge-ready',()=>{editor.bridge()?.setAnnotationMode(enabled&&!browsing);drawMarkers();});
  events.addEventListener('mode',({detail})=>{
    browsing=detail==='browse';toggle.disabled=browsing;panel.hidden=browsing||!enabled;
    editor.bridge()?.setAnnotationMode(enabled&&!browsing);
    if(browsing)editor.features.selection.cancelRegion();
    drawMarkers();
  });
  events.addEventListener('session-changed',()=>{activeKey=key();clearDraft();markers.replaceChildren();render();});
  events.addEventListener('external-change',({detail})=>{
    if(detail?.canvas!==state.canvas)return;
    for(const item of memory().items)if(item.targets.some(t=>detail.external||detail.files?.includes(t.sourceRef.board)||detail.board===t.sourceRef.board))stale(item,'画板发生外部或历史修改，请重新选择');
    render();drawMarkers();
  });
  tick=setInterval(drawMarkers,900);window.addEventListener('pagehide',()=>clearInterval(tick));
  editor.features.annotations={snapshot:()=>JSON.parse(JSON.stringify([...memories],(k,v)=>k==='node'?undefined:v)),restore:(entries)=>{if(!Array.isArray(entries))return;for(const [k,v] of entries)memories.set(k,v);validateRuntime();render();drawMarkers();},pick,save:saveNote,export:exportNotes,get items(){return memory().items.map(({runtime,...item})=>item);},get panel(){return panel;},validate:validateRuntime};
}
