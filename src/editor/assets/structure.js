/** Structural controls run in the editor shell, including when embedded in Harness. */
export function install(editor) {
  let busy=false, pendingDialog=null;
  const labels={delete:'删除',duplicate:'复制副本',up:'上移',down:'下移',indent:'移入前一个容器',outdent:'移出父级','wrap-flex':'Flex 包裹','wrap-grid':'Grid 包裹'};
  const style=document.createElement('style');
  style.textContent='.structure-controls{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}.structure-controls button,.structure-controls select{font:inherit;padding:5px 7px}.structure-dialog{max-width:1000px;width:85vw;border:1px solid #cbd5e1;border-radius:10px;padding:18px;color:#16324f}.structure-dialog::backdrop{background:#14233388}.structure-previews{display:grid;grid-template-columns:1fr 1fr;gap:12px}.structure-previews iframe{width:100%;height:300px;border:1px solid #cbd5e1;background:white}.structure-dialog footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.structure-dialog h3{margin:0 0 12px}.structure-dialog li{margin:6px 0}';
  document.head.appendChild(style);
  function selected() {
    const info=editor.bridge()?.describe(editor.state.selectedTid);
    if(!info || info.writable===false || !info.sourceRef) throw new Error(info?.readonlyReason||'请先选择可编辑元素');
    return info;
  }
  function staticPreview(action) {
    const frame=editor.el.board, doc=frame.contentDocument;
    const original=doc.documentElement.cloneNode(true);
    original.querySelectorAll('script,[data-dc-editor]').forEach(e=>e.remove());
    original.querySelectorAll('[contenteditable]').forEach(e=>e.removeAttribute('contenteditable'));
    original.querySelectorAll('*').forEach(e=>{for(const a of [...e.attributes]) if(/^on/i.test(a.name)) e.removeAttribute(a.name);});
    original.removeAttribute('data-dc-editor-mode');
    const base=doc.createElement('base');base.href=frame.src;original.querySelector('head').prepend(base);
    const before='<!doctype html>'+original.outerHTML;
    const info=selected();
    const live=[...doc.querySelectorAll(`[data-dc-tpl="${info.tid}"]`)].filter(e=>editor.bridge()?.provenance(e).writable);
    // Computed CSS is checked as well as source declarations because stylesheets may supply layout.
    for(const item of live) for(const node of [item,...item.querySelectorAll('*')]) {
      const css=doc.defaultView.getComputedStyle(node);
      if(css.position!=='static' || css.transform!=='none' || css.perspective!=='none' || css.filter!=='none' || css.zIndex!=='auto' || (css.contain && css.contain!=='none')) throw new Error('所选子树的计算样式包含定位、变换或层叠上下文，暂不支持安全包裹');
    }
    const allLive=[...doc.querySelectorAll(`[data-dc-tpl="${info.tid}"]`)];
    const clones=[...original.querySelectorAll(`[data-dc-tpl="${info.tid}"]`)];
    for(const item of live) {
      const target=clones[allLive.indexOf(item)]; if(!target) continue;
      const wrapper=doc.createElement('div');wrapper.style.cssText=action==='wrap-flex'?'display:flex;flex-direction:column':'display:grid;grid-template-columns:1fr';
      target.replaceWith(wrapper);wrapper.append(target);
    }
    return {before,after:'<!doctype html>'+original.outerHTML};
  }
  function confirmPlan(plan,info,action) {
    return new Promise((resolve,reject)=>{
      const dialog=document.createElement('dialog');dialog.className='structure-dialog';pendingDialog=dialog;
      const title=document.createElement('h3');title.textContent=`确认${labels[action]||'插入'}元素`;dialog.append(title);
      const list=document.createElement('ul');
      const notices=[...plan.warnings];
      if(info.instances>1 || info.instance?.count>1) notices.unshift(`当前模板有 ${info.instances||info.instance.count} 个可见实例，本次修改影响所有实例。`);
      if(action==='delete') notices.unshift('将删除所选元素及其全部子元素。保存后可一次撤销。');
      if(!notices.length) notices.push('修改会作为一条操作记录保存，可一次撤销。');
      for(const text of notices){const li=document.createElement('li');li.textContent=text;list.append(li);} dialog.append(list);
      if(action.startsWith('wrap-')) {
        let preview;try{preview=staticPreview(action);}catch(e){reject(e);pendingDialog=null;return;}
        const area=document.createElement('div');area.className='structure-previews';
        for(const [label,html] of [['包裹前',preview.before],['包裹后（静态预览）',preview.after]]) {
          const section=document.createElement('section'),caption=document.createElement('p'),frame=document.createElement('iframe');
          caption.textContent=label;frame.title=label;frame.setAttribute('sandbox','');frame.srcdoc=html;section.append(caption,frame);area.append(section);
        } dialog.append(area);
      }
      const footer=document.createElement('footer'),cancel=document.createElement('button'),accept=document.createElement('button');
      cancel.textContent='取消';accept.textContent='确认保存';cancel.type=accept.type='button';footer.append(cancel,accept);dialog.append(footer);
      const done=value=>{dialog.close();dialog.remove();pendingDialog=null;resolve(value);};
      cancel.onclick=()=>done(false);accept.onclick=()=>done(true);dialog.addEventListener('cancel',e=>{e.preventDefault();done(false);});
      document.body.append(dialog);dialog.showModal();cancel.focus();
    });
  }
  async function run(action,options={}) {
    if(busy)return;busy=true;
    try {
      await editor.beforeAction();const info=selected();
      const body={canvas:editor.state.canvas,board:editor.state.board,revision:editor.state.revision,sourceRef:info.sourceRef,action,...options};
      const plan=await editor.post('/api/structure/preview',body);
      if(!plan.changed){editor.toast('已在边界，没有改动');return;}
      if((plan.warnings.length || action==='delete' || action.startsWith('wrap-') || info.instances>1) && !await confirmPlan(plan,info,action)) return;
      const out=await editor.post('/api/structure',{...body,confirmation:plan.confirmation});
      await editor.acceptMutation(out,{focusTid:out.focusTid});editor.toast('已'+(labels[action]||'插入'));
    } finally {busy=false;}
  }
  function guard(action,options){return run(action,options).catch(e=>editor.toast(e.message,true));}
  editor.registerInspector((container,info)=>{
    const controls=document.createElement('div');controls.className='structure-controls';controls.setAttribute('aria-label','结构编辑');
    for(const [action,label] of Object.entries(labels)) {const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.structureAction=action;button.disabled=info.writable===false;button.onclick=()=>guard(action);controls.append(button);}
    const type=document.createElement('select');type.setAttribute('aria-label','插入元素类型');
    for(const [value,label] of [['text','文字'],['rect','矩形'],['image','已有图片'],['divider','分隔线']]){const option=document.createElement('option');option.value=value;option.textContent=label;type.append(option);}
    const insert=document.createElement('button');insert.type='button';insert.textContent='插入子元素';insert.dataset.structureAction='insert';insert.disabled=info.writable===false;
    insert.onclick=async()=>{
      try {
        if(type.value!=='image'){await guard('insert',{kind:type.value});return;}
        const data=await editor.post('/api/structure/assets',{canvas:editor.state.canvas,board:editor.state.board});
        if(!data.assets.length){editor.toast('设计稿中没有可用图片素材',true);return;}
        const dialog=document.createElement('dialog');dialog.className='structure-dialog';const select=document.createElement('select');select.setAttribute('aria-label','已有图片素材');
        for(const asset of data.assets){const option=document.createElement('option');option.value=asset.id;option.textContent=asset.file;select.append(option);}
        const ok=document.createElement('button'),cancel=document.createElement('button');ok.textContent='插入图片';cancel.textContent='取消';dialog.append(select,ok,cancel);document.body.append(dialog);
        ok.onclick=()=>{const asset=select.value;dialog.close();dialog.remove();guard('insert',{kind:'image',asset});};cancel.onclick=()=>{dialog.close();dialog.remove();};dialog.addEventListener('cancel',()=>dialog.remove());dialog.showModal();
      }catch(e){editor.toast(e.message,true);}
    };
    controls.append(type,insert);container.append(controls);
  });
  editor.registerShortcut(e=>{
    if(busy || pendingDialog || e.altKey && (e.ctrlKey||e.metaKey) || e.target?.closest?.('button,select,[role="dialog"],[contenteditable]'))return false;
    let action;
    if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&(e.key==='Delete'||e.key==='Backspace')) action='delete';
    else if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='d') action='duplicate';
    else if(e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey) action={ArrowUp:'up',ArrowDown:'down',ArrowRight:'indent',ArrowLeft:'outdent'}[e.key];
    if(!action || editor.state.selectedTid===null)return false;guard(action);return true;
  });
  editor.features.structure={run,preview:(action,options={})=>editor.post('/api/structure/preview',{canvas:editor.state.canvas,board:editor.state.board,revision:editor.state.revision,sourceRef:selected().sourceRef,action,...options}),get busy(){return busy;}};
}
