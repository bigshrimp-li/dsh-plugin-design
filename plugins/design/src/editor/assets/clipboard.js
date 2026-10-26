/** A system clipboard failure is always explicit; internal content carries its own provenance. */
export function install(editor) {
  let internal=null,busy=false;
  const describe=()=>editor.state.selectedTid===null?null:editor.bridge()?.describe(editor.state.selectedTid);
  function single() {
    const feature=editor.features.selection;
    const count=editor.bridge()?.getSelection?.()?.length ?? feature?.getSelection?.()?.length ?? editor.state.selectedTids?.length ?? 1;
    if(count>1)throw new Error('复制粘贴首版支持一个子树，请只选择一个元素');
    const info=describe();if(!info?.sourceRef||info.writable===false)throw new Error(info?.readonlyReason||'请先选择可编辑元素');return info;
  }
  const label=entry=>`${entry.sourceLabel}（${new Date(entry.createdAt).toLocaleTimeString()}）`;
  function confirm(message,accept='确认') {
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='structure-dialog';
      const text=document.createElement('p');text.textContent=message;
      const cancel=document.createElement('button'),okay=document.createElement('button');cancel.textContent='取消';okay.textContent=accept;
      const done=value=>{dialog.close();dialog.remove();resolve(value);};cancel.onclick=()=>done(false);okay.onclick=()=>done(true);
      dialog.addEventListener('cancel',e=>{e.preventDefault();done(false);});dialog.append(text,cancel,okay);document.body.append(dialog);dialog.showModal();cancel.focus();
    });
  }
  async function copyOrCut(cut=false) {
    if(busy)return;busy=true;
    try {
      await editor.beforeAction();const info=single();
      const body={canvas:editor.state.canvas,board:editor.state.board,revision:editor.state.revision,sourceRef:info.sourceRef,cut};
      const result=await editor.post('/api/clipboard/copy',body);
      let system=false;
      try{if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(JSON.stringify(result.payload));system=true;}catch{/* explicit internal fallback below */}
      internal={...result,system};
      editor.toast(system?'已复制源码到系统剪贴板':`系统剪贴板不可写；已保存内部备用：${label(internal)}`);
      if(!cut)return result;
      const count=info.instances||info.instance?.count||1;
      const warnings=result.cut?.warnings||[];
      const warning=`源码已保存在${system?'系统剪贴板':'内部备用'}。剪切将删除所选子树${count>1?`，影响 ${count} 个可见实例`:''}。${warnings.join(' ')}`;
      if(!await confirm(warning,'确认剪切'))return result;
      const out=await editor.post('/api/clipboard/cut',{...body,payload:result.payload,confirmation:result.cut.confirmation});
      await editor.acceptMutation(out,{focusTid:out.focusTid});editor.toast('已剪切；撤销仅恢复删除操作');return out;
    }finally{busy=false;}
  }
  async function clipboardPayload(useInternal=false) {
    if(useInternal){if(!internal)throw new Error('没有内部备用内容');editor.toast(`正在使用内部备用：${label(internal)}`);return internal.payload;}
    let text;
    try{if(!navigator.clipboard?.readText)throw new Error('unavailable');text=await navigator.clipboard.readText();}
    catch{
      if(!internal)throw new Error('系统剪贴板不可读，也没有内部备用内容；请先在编辑器中复制');
      if(!await confirm(`系统剪贴板不可读。是否使用内部备用 ${label(internal)}？`,'使用内部备用'))return null;
      return internal.payload;
    }
    let payload;try{payload=JSON.parse(text);}catch{throw new Error('系统剪贴板不是编辑器源码片段。可点击“粘贴内部备用”明确使用先前内容');}
    if(payload?.kind!=='deepseek-design-fragment'||payload?.version!==1)throw new Error('系统剪贴板不是编辑器源码片段；不接受外部 HTML');
    return payload;
  }
  async function paste(options={}) {
    if(busy)return;busy=true;
    try {
      await editor.beforeAction();
      const count=editor.bridge()?.getSelection?.()?.length??editor.features.selection?.getSelection?.()?.length??editor.state.selectedTids?.length??1;
      if(count>1)throw new Error('请只选择一个粘贴目标，或取消选择以插入根末尾');
      const info=describe();if(info?.writable===false)throw new Error(info.readonlyReason||'目标不可编辑');
      const body={canvas:editor.state.canvas,board:editor.state.board,revision:editor.state.revision,sourceRef:info?.sourceRef||null};
      const payload=await clipboardPayload(options.internal===true);if(!payload)return;
      if((info?.instances||1)>1&&!await confirm(`目标有 ${info.instances} 个可见实例。粘贴会修改模板并影响全部实例。`,'继续粘贴'))return;
      const out=await editor.post('/api/clipboard/paste',{...body,payload});await editor.acceptMutation(out,{focusTid:out.focusTid});editor.toast('已粘贴源码'+(out.files.length>1?'及素材':''));return out;
    }finally{busy=false;}
  }
  const run=action=>Promise.resolve().then(action).catch(e=>editor.toast(e.message,true));
  editor.addButton('clipboard-paste','粘贴',()=>paste(),'Ctrl/Cmd+V：作为下一兄弟或插入根末尾');
  editor.addButton('clipboard-internal','粘贴内部备用',()=>paste({internal:true}),'明确使用编辑器内部备用内容');
  editor.registerInspector((container,info)=>{
    const controls=document.createElement('div');controls.className='structure-controls';controls.setAttribute('aria-label','源码剪贴板');
    for(const [action,title,fn] of [['copy','复制源码',()=>copyOrCut()],['cut','剪切',()=>copyOrCut(true)]]) {
      const button=document.createElement('button');button.type='button';button.textContent=title;button.dataset.clipboardAction=action;button.disabled=info.writable===false;button.onclick=()=>run(fn);controls.append(button);
    }container.append(controls);
  });
  editor.registerShortcut(event=>{
    if(busy||event.isComposing||event.keyCode===229||event.shiftKey||event.altKey||!(event.ctrlKey||event.metaKey)||event.target?.closest?.('input,textarea,select,[contenteditable],[role="textbox"],dialog'))return false;
    const key=event.key.toLowerCase();if(!['c','x','v'].includes(key))return false;
    if(key!=='v'&&editor.state.selectedTid===null)return false;
    run(key==='v'?()=>paste():()=>copyOrCut(key==='x'));return true;
  });
  editor.features.clipboard={copy:()=>copyOrCut(false),cut:()=>copyOrCut(true),paste,get internal(){return internal?{sourceLabel:internal.sourceLabel,createdAt:internal.createdAt,system:internal.system}:null;},get busy(){return busy;}};
}
