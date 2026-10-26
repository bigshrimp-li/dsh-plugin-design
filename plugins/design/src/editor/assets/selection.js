/** Instance selection stays in the iframe; mutations are deduplicated by source tid. */
export function commonValues(infos, property) {
  const values = infos.map(info => Object.prototype.hasOwnProperty.call(info.inline || {}, property) ? info.inline[property] : null);
  if (!values.length || values.every(value => value === null)) return { kind: 'unset', value: '' };
  if (values.every(value => value === values[0])) return { kind: 'same', value: values[0] };
  return { kind: 'mixed', value: '' };
}
export function install(editor) {
  const { el, state, events } = editor;
  let anchor = null, queue = Promise.resolve(), pending = 0, regionMode = false, generation = 0;
  const properties = ['display','position','left','top','width','height','gap','flex','align-self','margin','margin-top','margin-left','padding','padding-top','padding-left','font-size','font-family','font-weight','line-height','letter-spacing','color','text-align','background-color','background','border','border-radius','box-shadow','opacity','transform'];
  const style = document.createElement('style');
  style.textContent = '.inspector.multiselection > .group:not(:first-child){display:none}.multiselect-controls[hidden]{display:none}.multiselect-controls{margin-top:10px}.multiselect-controls .row{grid-template-columns:90px 1fr}.multiselection .structure-controls{display:none}.multiselect-summary{color:var(--accent);font-weight:600;margin-bottom:8px}';
  document.head.appendChild(style);
  const selection = () => editor.bridge()?.getSelection?.() || [];
  const refs = () => selection().map(info => ({ tid: info.tid, instance: info.instance }));
  const button = editor.addButton('regionSelect', '框选', () => {
    regionMode = !regionMode; button.setAttribute('aria-pressed', String(regionMode)); editor.bridge()?.setRegionMode?.(regionMode);
    if (regionMode) editor.toast('在画板内拖框：选中与选框相交的最深层元素');
  }, '框选采用相交规则；父子同时命中时保留最深层');
  function update() {
    const infos = selection(), multi = infos.length > 1;
    state.selectedTids = [...new Set(infos.map(info => info.tid))];
    el.inspector.classList.toggle('multiselection', multi);
    el.textBtn.disabled = multi || infos.some(info => !info.writable);
    el.textBtn.title = multi ? '多选时不能原地改文字，请只选一个元素' : '原地改选中元素的文字';
    const controls = el.inspector.querySelector('.multiselect-controls');
    if (controls) {
      controls.hidden = !multi;
      controls.querySelector('.multiselect-summary').textContent = `${infos.length} 个实例 · ${state.selectedTids.length} 个源码节点`;
      for (const input of controls.querySelectorAll('[data-batch-prop]')) {
        const common = commonValues(infos, input.dataset.batchProp);
        if (document.activeElement !== input) input.value = common.value;
        input.placeholder = common.kind === 'mixed' ? '多个值' : common.kind === 'unset' ? '未设置' : '';
        input.dataset.valueKind = common.kind;
        input.disabled = pending > 0 || infos.some(info => !info.writable);
      }
    }
    Array.from(el.layers.querySelectorAll('.layer')).forEach((node, index) => node.setAttribute('aria-selected', String(state.selectedTids.includes(state.elements[index]?.tid))));
    events.dispatchEvent(new CustomEvent('multiselection', { detail: infos }));
  }
  editor.registerInspector(container => {
    const controls = document.createElement('div'); controls.className = 'multiselect-controls'; controls.hidden = true;
    const summary = document.createElement('div'); summary.className = 'multiselect-summary'; controls.append(summary);
    for (const property of properties) {
      const row = document.createElement('div'); row.className = 'row';
      const label = document.createElement('label'); label.textContent = property;
      const input = document.createElement('input'); input.dataset.batchProp = property; input.setAttribute('aria-label', `批量 ${property}`);
      input.addEventListener('change', () => {
        const value = input.value.trim();
        if (value && !CSS.supports(property, value.replace(/\s*!important\s*$/, ''))) { input.setAttribute('aria-invalid','true'); editor.toast('CSS 属性值无效，尚未保存', true); return; }
        input.removeAttribute('aria-invalid'); applyProperty(property, value);
      });
      row.append(label,input);controls.append(row);
    }
    const hint=document.createElement('p');hint.className='hint';hint.textContent='空值移除该行内属性；每个元素保留自己的其他属性。整组拖动不支持重复模板、旋转和缩放。';controls.append(hint);
    container.append(controls);
  });
  function enqueue(build, kind) {
    const target = { canvas: state.canvas, board: state.board }, epoch = generation;
    pending++; editor.bridge()?.setBusy?.(true); update();
    queue = queue.then(async () => {
      await editor.flushWrites();
      if (epoch !== generation || state.canvas !== target.canvas || state.board !== target.board) throw new Error('画板已切换，批量操作已取消');
      const edits = build();
      if (!edits.length) return;
      const revision = editor.revision(target.canvas,target.board);
      for (const edit of edits) edit.sourceRef = { ...edit.sourceRef, ...target, revision };
      const out = await editor.post('/api/edit-batch', { ...target, revision, edits, kind });
      if (epoch !== generation || state.canvas !== target.canvas || state.board !== target.board) return;
      for (const edit of edits) {
        const source = state.elements.find(item => item.tid === edit.tid); if (source) source.style = edit.style;
        editor.bridge()?.acceptCommitted(edit.tid, edit.style, {revision:out.revision});
      }
      // No reload: preserve instance selection and all current interaction state.
      await editor.acceptMutation(out, {reload:false,focusTid:editor.bridge()?.selectedTid});
      editor.toast(out.changed ? `已修改 ${out.applied} 个源码节点，可一次撤销` : '样式没有变化');
    }).catch(error => {
      editor.toast(error.message, true);
      // Reload after this queue has settled; loadBoard itself waits for the queue.
      setTimeout(() => editor.reloadBoard(false).catch(e => editor.toast(e.message,true)), 0);
    }).finally(() => { pending--; editor.bridge()?.setBusy?.(pending>0); update(); });
    return queue;
  }
  function applyProperty(property,value) {
    const targets = refs();
    return enqueue(() => {
      const b=editor.bridge(), unique=new Map();
      for(const ref of targets) {
        const info=b.describe(ref.tid);
        if(!info?.writable) throw new Error(info?.readonlyReason||'无法确认选区来源');
        const decls={...info.inline}; if(value==='') delete decls[property]; else decls[property]=value;
        b.preview(ref.tid,decls);
        unique.set(ref.tid,{tid:ref.tid,style:b.currentStyle(ref.tid),sourceRef:info.sourceRef});
      }
      return [...unique.values()];
    },'style');
  }
  editor.host.onMultiSelect = update;
  editor.host.onRegionCancel = () => {regionMode=false;button.setAttribute('aria-pressed','false');};
  editor.host.onBatchCommit = (edits,kind) => enqueue(() => edits,kind);
  events.addEventListener('selection', update);
  events.addEventListener('board', () => { generation++; anchor=null; regionMode=false; button.setAttribute('aria-pressed','false'); });
  events.addEventListener('bridge-ready', () => { bindKeys(el.board.contentDocument); update(); });
  events.addEventListener('saved', update);
  events.addEventListener('mode', () => { regionMode=false; button.setAttribute('aria-pressed','false');editor.bridge()?.setRegionMode?.(false); });
  el.layers.addEventListener('click', event => {
    const row=event.target.closest('.layer');if(!row)return;
    const index=Array.from(el.layers.querySelectorAll('.layer')).indexOf(row),tid=state.elements[index]?.tid;
    if(tid===undefined)return;
    if(!event.shiftKey&&!event.ctrlKey&&!event.metaKey){anchor=index;return;}
    event.preventDefault();event.stopImmediatePropagation();
    let selected=refs();
    if(event.shiftKey) {
      const first=anchor??index, range=state.elements.slice(Math.min(first,index),Math.max(first,index)+1).map(info=>info.tid);
      selected=range.map(tid=>({tid,instance:{index:0}}));
    } else {
      const found=selected.findIndex(info=>info.tid===tid);
      if(found>=0)selected=selected.filter(info=>info.tid!==tid);else selected.push({tid,instance:{index:0}});
      anchor=index;
    }
    editor.bridge()?.selectMany(selected,true);update();
  },true);
  function bindKeys(doc) {
    if(!doc||doc.__multiKeys)return;doc.__multiKeys=true;
    doc.addEventListener('keydown',event=>{
      if(event.isComposing||event.target?.closest?.('input,textarea,select,[contenteditable]'))return;
      if(selection().length<2)return;
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();editor.bridge()?.selectMany([],true);return;}
      if(event.key==='Delete'||event.key==='Backspace'||(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'||event.altKey&&event.key.startsWith('Arrow')) {
        event.preventDefault();event.stopImmediatePropagation();editor.toast('结构操作请只选一个元素');
      }
    },true);
  }
  bindKeys(document);
  editor.features.selection = {
    getSelection:selection, getRefs:refs, applyProperty,
    selectMany:(values,notify=true)=>editor.bridge()?.selectMany(values,notify),
    selectRegion:rect=>editor.bridge()?.selectRegion(rect),
    queryRegion:rect=>editor.bridge()?.elementsInRegion(rect)||[],
    captureRegion(callback) { regionMode=true;button.setAttribute('aria-pressed','true');editor.bridge()?.setRegionMode(true,(infos,rect)=>{regionMode=false;button.setAttribute('aria-pressed','false');callback(infos,rect);}); },
    cancelRegion() {regionMode=false;button.setAttribute('aria-pressed','false');editor.bridge()?.setRegionMode(false);},
    waitPending:()=>queue, get busy(){return pending>0;},
  };
}
