/**
 * 编辑器外壳：界面、状态、跟服务端往返。
 * 画板那一侧的一切在 bridge.js 里，同源，直接调 `iframe.contentWindow.__designEditor`。
 */

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('canvas'), boards: $('boards'), layers: $('layers'), layerCount: $('layerCount'),
  inspector: $('inspector'), board: $('board'), wrap: $('canvaswrap'), inner: $('canvasinner'),
  empty: $('empty'), toast: $('toast'), undo: $('undo'), reload: $('reload'),
  mode: $('mode'), textBtn: $('textBtn'), zoom: $('zoom'),
};

/** 本标签页的 id：用来忽略自己发出去的编辑事件。 */
const CLIENT_ID = Math.random().toString(36).slice(2);

const state = {
  root: '', canvases: [], canvas: null, board: null,
  declared: { w: 0, h: 0 }, elements: [], selectedTid: null, canUndo: false, canRedo: false,
  revision: null, canvasIndex: null, indexRevision: null, selectionInfo: null,
};

/** 属性面板上的字段。分组的顺序就是面板上的顺序。 */
const FIELDS = [
  ['布局', ['display', 'position', 'left', 'top', 'width', 'height', 'gap', 'flex', 'align-self']],
  ['间距', ['margin', 'margin-top', 'margin-left', 'padding', 'padding-top', 'padding-left']],
  ['文字', ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'text-align']],
  ['外观', ['background-color', 'background', 'border', 'border-radius', 'box-shadow', 'opacity', 'transform']],
];
const ALL_PROPS = FIELDS.flatMap(([, list]) => list);

let toastTimer = null;
function toast(message, bad) {
  el.toast.textContent = message;
  el.toast.className = 'toast on' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.className = 'toast'; }, bad ? 6000 : 2600);
}

const api = async (route, options) => {
  const res = await fetch(route, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { body, status:res.status });
  return body;
};

const editorEvents = new EventTarget();
const emit = (type, detail) => editorEvents.dispatchEvent(new CustomEvent(type, { detail }));
const inspectorExtensions = [];
const shortcutHandlers = [];

const bridge = () => el.board.contentWindow?.__designEditor ?? null;

// ---------------------------------------------------------------- 画板

function boardUrl() {
  return `/board/${state.canvas}/${state.board}`;
}

function fitZoom() {
  const choice = el.zoom.value;
  if (choice !== 'fit') return Number(choice);
  const avail = el.wrap.clientWidth - 48;
  const availH = el.wrap.clientHeight - 48;
  if (!state.declared.w || !state.declared.h) return 1;
  return Math.max(0.05, Math.min(1, avail / state.declared.w, availH / state.declared.h));
}

function applyZoom() {
  if (window.designEditor?.features.viewport) return window.designEditor.features.viewport.applyZoom();
  const k = fitZoom();
  const w = state.declared.w || 0;
  const h = state.declared.h || 0;
  el.board.style.width = w + 'px';
  el.board.style.height = h + 'px';
  el.board.style.transform = `scale(${k})`;
  el.inner.style.width = w * k + 'px';
  el.inner.style.height = h * k + 'px';
  el.wrap.style.setProperty('--scaled', String(k));
}

let loadGeneration = 0;
async function loadBoard(canvasRel, boardRel, keepSelection = false, skipFlush = false) {
  if ((canvasRel !== state.canvas || boardRel !== state.board) && bridge()?.isInteracting) throw new Error('请先结束当前拖动');
  const generation = ++loadGeneration;
  if (!skipFlush) {
    bridge()?.finishTextEdit();
    await editor.features.selection?.waitPending?.();
    await flushWrites();
  }
  const data = await api(`/api/board?canvas=${encodeURIComponent(canvasRel)}&board=${encodeURIComponent(boardRel)}`);
  if (generation !== loadGeneration) return;
  if (keepSelection && revisions.get(boardKey(canvasRel, boardRel)) !== data.revision) keepSelection=false;
  revisions.set(boardKey(canvasRel, boardRel), data.revision);
  state.canvas = canvasRel;
  state.board = boardRel;
  state.declared = data.declared ?? { w: 0, h: 0 };
  state.elements = data.elements ?? [];
  state.revision = data.revision;
  state.canvasIndex = data.canvasIndex;
  state.indexRevision = data.indexRevision;
  state.source = data.source;
  state.selectionInfo = null;
  applyHistory(data);
  if (!keepSelection) state.selectedTid = null;
  delete el.inspector.dataset.built;
  renderInspector();
  renderTabs();
  renderLayers();
  applyZoom();
  el.empty.style.display = 'none';
  el.board.src = boardUrl();
  el.undo.disabled = !state.canUndo;
  emit('board', data);
}

el.board.addEventListener('load', () => {
  // 桥挂载可能比 load 稍晚（要等画板运行时把 #dc-root 建出来）
  let tries = 0;
  const loadedDocument = el.board.contentDocument;
  const generation = loadGeneration;
  const timer = setInterval(() => {
    if (generation !== loadGeneration || loadedDocument !== el.board.contentDocument) { clearInterval(timer); return; }
    const b = bridge();
    if (b && b.ready) {
      clearInterval(timer);
      // 把源码里的行内样式原文交给桥当基准（DOM 里那份已被 CSSOM 规范化过）
      b.registerSources(Object.fromEntries(state.elements.map((e) => [e.tid, e])), {canvas:state.canvas,board:state.board,revision:state.revision});
      renderLayers();
      b.setMode(el.mode.getAttribute('aria-pressed') === 'true' ? 'select' : 'browse');
      if (state.selectedTid !== null) b.select(state.selectedTid, false);
      delete el.inspector.dataset.built;
      renderInspector();
      emit('bridge-ready', {bridge:b,canvas:state.canvas,board:state.board});
      bindShortcuts(el.board.contentDocument);
    } else if (++tries > 60) clearInterval(timer);
  }, 100);
});

// 桥回调（桥在 iframe 里，通过 window.parent 调过来）
window.__editorHost = {
  onNavigate(pathname) {
    const rel = decodeURIComponent(pathname).replace(/^\/board\//, '');
    const canvas = state.canvases.find(c => c.boards.some(b => `${c.path}/${b.path}` === rel));
    const target = canvas?.boards.find(b => `${canvas.path}/${b.path}` === rel);
    if (target) loadBoard(canvas.path, target.path).catch(e => toast(e.message, true));
    else toast('目标画板不在当前设计稿清单中', true);
  },
  onSelect(info) {
    if (info?.sourceRef && (info.sourceRef.canvas !== state.canvas || info.sourceRef.board !== state.board)) return;
    state.selectionInfo = info;
    state.selectedTid = info ? info.tid : null;
    renderLayers();
    renderInspector(info);
    emit('selection', info);
  },
  onPreview(info) {
    if (info) {
      state.selectedTid = info.tid;
      renderInspector(info, { previewOnly: true });
      emit('preview', info);
    }
  },
  async onCommit(tid, style, kind, sourceRef) {
    if (sourceRef && (sourceRef.canvas !== state.canvas || sourceRef.board !== state.board || sourceRef.revision !== state.revision)) return;
    if (kind === 'move' || kind === 'resize') toast('已改尺寸/位置，正在写回…');
    await commit(tid, style);
  },
  onTextCommit(tid, text, sourceRef) {
    if (sourceRef && (sourceRef.canvas !== state.canvas || sourceRef.board !== state.board || sourceRef.revision !== state.revision)) return;
    const target = { canvas: state.canvas, board: state.board };
    flushPending();
    enqueueWrite({ ...target, tid, text, sourceRef:bridge()?.describe(tid)?.sourceRef });
    return writeChain.then(async () => {
      if (sameBoard(target)) await reloadBoard(true, true);
    });
  },
  onNotice(message) { toast(message); },
};

// ---------------------------------------------------------------- 写入

const pendingWrites = new Map();
const revisions = new Map();
const epochs = new Map();
let writeChain = Promise.resolve();
let writing = 0;
let saveError = false;
const boardKey = (canvas, board) => JSON.stringify([canvas, board]);
const sameBoard = target => target.canvas === state.canvas && target.board === state.board;

function updateSaveState() {
  $('saveState').textContent = pendingWrites.size || writing ? '保存中…' : saveError ? '保存失败，请重试' : '已保存';
}
function enqueueWrite(job) {
  const key = boardKey(job.canvas, job.board);
  job.epoch ??= epochs.get(key) ?? 0;
  writing++;
  updateSaveState();
  writeChain = writeChain.then(async () => {
    try {
      if (job.epoch !== (epochs.get(key) ?? 0)) return;
      const currentRevision = revisions.get(key);
      const sourceRef = job.sourceRef ? {...job.sourceRef, revision:currentRevision} : undefined;
      const out = await api('/api/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...job, sourceRef, revision: currentRevision, origin: CLIENT_ID }),
      });
      revisions.set(key, out.revision);
      if (sameBoard(job)) {
        state.revision = out.revision;
        applyHistory(out);
        if (typeof job.style === 'string') bridge()?.acceptCommitted(job.tid, out.style, {canvas:job.canvas,board:job.board,revision:out.revision});
        const element = state.elements.find(e => e.tid === job.tid);
        if (element && typeof out.style === 'string') element.style = out.style;
        renderLayers();
        renderInspector();
      }
      emit('saved', {...out, canvas:job.canvas,board:job.board});
    } catch (e) {
      saveError = true;
      epochs.set(key, (epochs.get(key) ?? 0) + 1);
      for (const [pendingKey, pending] of pendingWrites) {
        if (boardKey(pending.job.canvas, pending.job.board) === key) {
          clearTimeout(pending.timer);
          pendingWrites.delete(pendingKey);
        }
      }
      toast(e.message + (e.body?.problems ? `（${e.body.problems.length} 个问题）` : ''), true);
      if (sameBoard(job)) await loadBoard(job.canvas, job.board, true, true);
    } finally {
      writing--;
      updateSaveState();
    }
  });
  return writeChain;
}
function flushPending() {
  for (const [key, pending] of pendingWrites) {
    clearTimeout(pending.timer);
    pendingWrites.delete(key);
    enqueueWrite(pending.job);
  }
}
async function flushWrites() {
  flushPending();
  await writeChain;
}
function commit(tid, style, delay = 0) {
  saveError = false;
  // Capture the board now: navigation must never redirect a pending write.
  if (bridge()?.describe(tid)?.writable === false) { toast('该元素来源不能安全确认，已停止保存', true); return; }
  const job = { canvas: state.canvas, board: state.board, tid, style, sourceRef:bridge()?.describe(tid)?.sourceRef, epoch: epochs.get(boardKey(state.canvas, state.board)) ?? 0 };
  const key = JSON.stringify([job.canvas, job.board, tid]);
  clearTimeout(pendingWrites.get(key)?.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    enqueueWrite(job);
  }, delay);
  pendingWrites.set(key, { job, timer });
  updateSaveState();
}
async function reloadBoard(keepSelection, skipFlush = false) {
  if (!state.canvas || !state.board) return;
  await loadBoard(state.canvas, state.board, keepSelection, skipFlush);
}
window.addEventListener('beforeunload', e => {
  if (!pendingWrites.size && !writing) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---------------------------------------------------------------- 图层树

function renderLayers() {
  el.layers.textContent = '';
  el.layerCount.textContent = ` ${state.elements.length}`;
  const counts = new Map();
  for (const e of state.elements) counts.set(e.tid, 1);
  for (const e of state.elements) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer' + (e.isVoid || e.selfClosing ? ' void' : '');
    btn.setAttribute('aria-selected', String(e.tid === state.selectedTid));
    btn.style.paddingLeft = `${8 + e.depth * 11}px`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `<${e.tag}>`;
    btn.appendChild(tag);
    if (e.text) {
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = e.text;
      btn.appendChild(txt);
    }
    const n = bridge()?.describe(e.tid)?.instances ?? counts.get(e.tid) ?? 1;
    if (n > 1) {
      const rep = document.createElement('span');
      rep.className = 'rep';
      rep.textContent = `×${n}`;
      rep.title = '这是 <sc-for> 展开出来的实例：改一处等于改全部';
      btn.appendChild(rep);
    }
    btn.addEventListener('click', () => {
      state.selectedTid = e.tid;
      bridge()?.select(e.tid, true);
      renderLayers();
      renderInspector();
    });
    el.layers.appendChild(btn);
  }
}

// ---------------------------------------------------------------- 属性面板

function renderInspector(info, opts = {}) {
  const tid = state.selectedTid;
  if (tid === null || tid === undefined) {
    delete el.inspector.dataset.built;
    el.inspector.innerHTML = '<p class="dim pad">在画板里点一个元素</p>';
    return;
  }
  const src = state.elements.find((e) => e.tid === tid);
  const live = info ?? bridge()?.describe(tid) ?? null;
  const inline = live?.inline ?? parseStyle(src?.style ?? '');
  if (!el.inspector.dataset.built || el.inspector.dataset.tid !== String(tid)) {
    el.inspector.textContent = '';
    el.inspector.dataset.built = '1';
    el.inspector.dataset.tid = String(tid);

    // 谁
    const g0 = group('选中');
    g0.appendChild(div('who', `<${src?.tag ?? '?'}>  #${tid}`));
    if (src?.text) g0.appendChild(div('snippet', src.text));
    const source = document.createElement('small'); source.dataset.sourceRef = '1'; g0.appendChild(source);
    for (const render of inspectorExtensions) { const seat = document.createElement('div'); g0.appendChild(seat); render(seat,live || {tid, writable:false, readonlyReason:"画板正在加载"}); }
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'btn';
    up.textContent = '↑ 选上一层';
    up.title = '点击落在最深的元素上；双击画板里的元素也是这个效果';
    up.style.marginTop = '8px';
    up.addEventListener('click', () => bridge()?.selectParent());
    g0.appendChild(up);
    if (live && live.instances > 1) {
      g0.appendChild(div('hint', `这是 <sc-for> 展开的 ${live.instances} 个实例之一：改一处等于改全部。`));
    }
    if (live && !live.editableText) g0.appendChild(div('hint', '里面还有子元素：只能改样式，不能原地改字。'));
    if (live && live.hasHole) g0.appendChild(div('hint', '内容里有 {{…}} 数据绑定：改字要改它的 prop。'));

    for (const [title, props] of FIELDS) {
      const g = group(title);
      for (const prop of props) g.appendChild(field(tid, prop));
    }

    const gAdd = group('加一条');
    const wrap = document.createElement('div');
    wrap.className = 'add';
    const sel = document.createElement('select');
    for (const p of ALL_PROPS) {
      const o = document.createElement('option');
      o.value = p; o.textContent = p;
      sel.appendChild(o);
    }
    const val = document.createElement('input');
    val.placeholder = '值，例如 12px';
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'btn'; add.textContent = '加';
    add.addEventListener('click', () => {
      if (!val.value.trim()) return;
      if (!validCss(sel.value, val.value.trim())) { toast('CSS 属性值无效，尚未保存', true); return; }
      const decls = { ...currentDecls(tid) };
      decls[sel.value] = val.value.trim();
      push(tid, decls);
      renderInspector();
    });
    wrap.append(sel, val, add);
    gAdd.appendChild(wrap);
    el.inspector.appendChild(gAdd);

    const gComp = group('计算值（只读）');
    const comp = live?.computed ?? {};
    for (const k of Object.keys(comp)) {
      const r = document.createElement('div');
      r.className = 'row';
      const l = document.createElement('label'); l.textContent = k;
      const i = document.createElement('input'); i.readOnly = true; i.dataset.computed = k; i.value = comp[k];
      r.append(l, i);
      gComp.appendChild(r);
    }
    const gBox = group('盒子');
    const box = div('hint', '');
    box.dataset.box = '1';
    gBox.appendChild(box);
  }

  const provenance = el.inspector.querySelector('[data-source-ref]');
  if (provenance) provenance.textContent = live?.readonlyReason || `${state.board} · #${tid}${live?.instance ? ` · 实例 ${live.instance.index + 1}/${live.instance.count}` : ''}`;
  const readonly = live?.writable === false;
  el.textBtn.disabled = readonly;
  for (const control of el.inspector.querySelectorAll('input:not([readonly]), select, .add button')) control.disabled = readonly;

  // Computed styles and geometry must refresh after preview and iframe reload too.
  for (const input of el.inspector.querySelectorAll('input[data-computed]')) {
    input.value = live?.computed?.[input.dataset.computed] ?? '';
  }
  const box = el.inspector.querySelector('[data-box]');
  const b = live?.box;
  if (box) box.textContent = b
    ? `${Math.round(b.w)} × ${Math.round(b.h)} px，位于 (${Math.round(b.x)}, ${Math.round(b.y)})` : '';

  // 值随时刷新
  for (const input of el.inspector.querySelectorAll('input[data-prop]')) {
    const prop = input.dataset.prop;
    if (document.activeElement !== input) input.value = inline[prop] ?? '';
    input.placeholder = live?.computed?.[prop] ?? '未设置';
  }
}

function currentDecls(tid) {
  return { ...(bridge()?.describe(tid)?.inline ?? {}) };
}

/** 改一条 → 画板里立刻预览 → 防抖写回源码。 */
function push(tid, decls) {
  const b = bridge();
  if (b) { b.preview(tid, decls); renderInspector(b.describe(tid)); }
  // 让桥来序列化：它按**原始写法**重建，没动过的声明一个字符都不变
  const style = b?.styleString(tid)
    ?? Object.entries(decls).map(([k, v]) => `${k}: ${v}`).join('; ');
  commit(tid, style, 450);
}

const INHERITED = new Set(['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'text-align']);
const validCss = (prop, value) => !value || CSS.supports(prop, value.replace(/\s*!important\s*$/, ''));

function field(tid, prop) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = prop;
  label.title = INHERITED.has(prop)
    ? `${prop} 会被子元素继承：这里只改当前这一层，下面没自己声明的会跟着变`
    : prop;
  const input = document.createElement('input');
  input.dataset.prop = prop;
  input.spellcheck = false;
  input.placeholder = '未设置';
  input.addEventListener('input', () => {
    const valid = validCss(prop, input.value.trim());
    input.setCustomValidity(valid ? '' : 'CSS 属性值无效，尚未保存');
    input.setAttribute('aria-invalid', String(!valid));
    if (!valid) return;
    const decls = currentDecls(tid);
    if (input.value.trim() === '') delete decls[prop];
    else decls[prop] = input.value.trim();
    push(tid, decls);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  row.append(label, input);
  return row;
}

function group(title) {
  const g = document.createElement('div');
  g.className = 'group';
  const h = document.createElement('h3');
  h.textContent = title;
  g.appendChild(h);
  el.inspector.appendChild(g);
  return g;
}
function div(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}
function parseStyle(raw) {
  const out = {};
  for (const part of raw.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------- 顶栏

function renderTabs() {
  el.boards.textContent = '';
  const canvas = state.canvases.find((c) => c.path === state.canvas);
  for (const b of canvas?.boards ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(b.path === state.board));
    btn.textContent = b.title ?? b.path.replace(/\.dc\.html$/, '');
    btn.title = `${b.path} · ${b.w}×${b.h}`;
    btn.addEventListener('click', () => loadBoard(state.canvas, b.path));
    el.boards.appendChild(btn);
  }
}

async function boot() {
  const ws = await api('/api/workspace');
  state.root = ws.root;
  state.canvases = ws.canvases;
  emit('workspace', ws);
  el.canvas.textContent = '';
  for (const c of ws.canvases) {
    const o = document.createElement('option');
    o.value = c.path;
    o.textContent = `${c.title}  (${c.path})`;
    el.canvas.appendChild(o);
  }
  if (ws.canvases.length === 0) {
    el.empty.textContent = '这个工作目录里还没有设计稿（没找到 canvas.json）';
    return;
  }
  const first = ws.canvases[0];
  el.canvas.value = first.path;
  await loadBoard(first.path, first.boards[0]?.path ?? 'Main.dc.html');
}

el.canvas.addEventListener('change', async () => {
  const c = state.canvases.find((x) => x.path === el.canvas.value);
  if (c) await loadBoard(c.path, c.boards[0]?.path ?? 'Main.dc.html');
});

el.zoom.addEventListener('change', applyZoom);
window.addEventListener('resize', applyZoom);

el.mode.setAttribute('aria-pressed', 'true');
el.mode.addEventListener('click', () => {
  const on = el.mode.getAttribute('aria-pressed') !== 'true';
  el.mode.setAttribute('aria-pressed', String(on));
  bridge()?.setMode(on ? 'select' : 'browse');
  emit('mode', on ? 'select' : 'browse');
  toast(on ? '编辑模式：点击只用来选中元素' : '浏览模式：画板自己的按钮可以点');
});

el.textBtn.addEventListener('click', () => {
  const r = bridge()?.startTextEdit();
  if (!r) { toast('画板还没准备好'); return; }
  if (!r.ok) { toast(r.reason, true); return; }
  toast('直接改画板里的字，按 Esc 或点别处结束');
});

el.undo.addEventListener('click', () => historyAction('undo').catch(e => toast(e.message,true)));

el.reload.addEventListener('click', async () => { try { await reloadBoard(true); saveError=false; updateSaveState(); } catch(e) {toast(e.message,true);} });

// 外部改动（agent 或别处）→ 提示并重载
const events = new EventSource('/api/events');
events.addEventListener('message', (ev) => {
  let data = null;
  try { data = JSON.parse(ev.data); } catch { return; }
  emit('external-change', data);
  if (data?.origin === CLIENT_ID) return; // 自己改的：不用提示，也不用重载
  if (data?.type === 'edited' && data.canvas === state.canvas && (data.board === state.board || !data.board || data.files?.includes(state.board)) && !pendingWrites.size && !writing) {
    toast('这份画板在别处被改过（可能是 agent），已重新加载');
    reloadBoard(true);
  }
});

function applyHistory(out) {
  state.canUndo = out.canUndo === true;
  state.canRedo = out.canRedo === true;
  el.undo.disabled = !state.canUndo;
  el.undo.title = out.history?.undoLabel || out.undoLabel || '撤销上一次设计稿操作';
  emit('history', out);
}
async function beforeAction() {
  bridge()?.finishTextEdit();
  await editor.features.selection?.waitPending?.();
  await flushWrites();
  if (saveError) throw new Error('存在保存失败，请重新加载并确认后再操作');
}
async function historyAction(kind) {
  const target={canvas:state.canvas,board:state.board};
  await beforeAction();
  if (!sameBoard(target)) throw new Error('画板已切换，请在目标设计稿重新操作');
  const out = await editor.post('/api/' + kind, target);
  for(const [file,rev] of Object.entries(out.revisions || {})) {
    const key=boardKey(target.canvas,file); epochs.set(key,(epochs.get(key)||0)+1); revisions.set(key,rev);
  }
  if (state.canvas !== target.canvas) return;
  applyHistory(out);
  if (!out.changed) { toast(kind === 'undo' ? '没有可撤销的改动了' : '没有可重做的改动了'); return; }
  if (!sameBoard(target)) {
    if (out.files?.includes(state.board) || out.files?.includes('canvas.json')) await loadBoard(state.canvas,state.board,false);
    emit('saved',{...out,...target});return;
  }
  const affected = out.files?.find(file => file.endsWith('.dc.html'));
  toast((kind === 'undo' ? '已撤销' : '已重做') + (out.label ? '：' + out.label : ''));
  const keepSelection = sameBoard(target) && (!affected || affected===target.board) && ['修改样式','修改文字','批量修改样式','批量移动'].includes(out.label);
  await loadBoard(target.canvas, affected || target.board, keepSelection);
  emit('saved', {...out,...target,board:affected || target.board});
}
function bindShortcuts(doc) {
  if (!doc || doc.__editorKeys) return;
  doc.__editorKeys = true;
  doc.addEventListener('keydown', event => {
    if (event.isComposing || event.defaultPrevented || el.mode.getAttribute('aria-pressed') !== 'true') return;
    const target = event.target;
    if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    for (const handler of shortcutHandlers) if (handler(event)) {event.preventDefault();event.stopPropagation();break;}
  });
}
const editor = {
  state, el, events:editorEvents, features:{}, host:window.__editorHost,
  bridge,api,toast,flushWrites,beforeAction,loadBoard,reloadBoard,applyHistory,historyAction,
  renderLayers,renderInspector,applyZoom,
  revision:(canvas=state.canvas,board=state.board)=>revisions.get(boardKey(canvas,board)),
  post:(url,body)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,origin:CLIENT_ID})}),
  addButton(id,label,handler,title='') {
    const button=document.createElement('button');button.type='button';button.id=id;button.className='btn';button.textContent=label;button.title=title;
    button.addEventListener('click',()=>Promise.resolve().then(handler).catch(e=>toast(e.message,true)));
    document.querySelector('.bar').appendChild(button);return button;
  },
  registerShortcut(handler){shortcutHandlers.push(handler);return()=>{const i=shortcutHandlers.indexOf(handler);if(i>=0)shortcutHandlers.splice(i,1);};},
  registerInspector(render){inspectorExtensions.push(render);delete el.inspector.dataset.built;},
  async acceptMutation(out,{reload=true,focusTid,canvas=out.canvas || state.canvas,board=out.board || state.board}={}) {
    for(const [file,rev] of Object.entries(out.revisions || {})) {
      const key=boardKey(canvas,file);epochs.set(key,(epochs.get(key)||0)+1);revisions.set(key,rev);
    }
    if(canvas===state.canvas) applyHistory(out);
    if(canvas===state.canvas && board===state.board) {
      const rev=out.revision || out.revisions?.[board];
      if(rev){state.revision=rev;revisions.set(boardKey(canvas,board),rev);}
      state.selectedTid=focusTid ?? null;
      if(reload)await reloadBoard(true);
    }
    emit('saved',{...out,canvas,board});
  },
};
window.designEditor = editor;
bindShortcuts(document);
// Modules are installed before boot so every module sees the initial board.
const featureModules = ['/composer.js', '/redo.js', '/viewport.js', '/structure.js', '/selection.js', '/clipboard.js', '/notes.js', '/annotations.js'];
for (const module of featureModules) (await import(module)).install(editor);
boot().catch((e) => toast(`启动失败：${e.message}`, true));
