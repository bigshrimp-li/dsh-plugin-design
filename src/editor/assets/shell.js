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
  declared: { w: 0, h: 0 }, elements: [], selectedTid: null, canUndo: false,
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
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { body });
  return body;
};

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
  return Math.min(1, avail / state.declared.w, availH / state.declared.h);
}

function applyZoom() {
  const k = fitZoom();
  const w = state.declared.w || 0;
  const h = state.declared.h || 0;
  el.board.style.width = w + 'px';
  el.board.style.height = h + 'px';
  el.inner.style.transform = `scale(${k})`;
  el.inner.style.width = w + 'px';
  el.inner.style.height = h + 'px';
  el.wrap.style.setProperty('--scaled', String(k));
}

async function loadBoard(canvasRel, boardRel, keepSelection = false) {
  const data = await api(`/api/board?canvas=${encodeURIComponent(canvasRel)}&board=${encodeURIComponent(boardRel)}`);
  state.canvas = canvasRel;
  state.board = boardRel;
  state.declared = data.declared ?? { w: 0, h: 0 };
  state.elements = data.elements ?? [];
  state.canUndo = data.canUndo === true;
  if (!keepSelection) state.selectedTid = null;
  renderTabs();
  renderLayers();
  applyZoom();
  el.empty.style.display = 'none';
  el.board.src = boardUrl();
  el.undo.disabled = !state.canUndo;
}

el.board.addEventListener('load', () => {
  // 桥挂载可能比 load 稍晚（要等画板运行时把 #dc-root 建出来）
  let tries = 0;
  const timer = setInterval(() => {
    const b = bridge();
    if (b && b.ready) {
      clearInterval(timer);
      // 把源码里的行内样式原文交给桥当基准（DOM 里那份已被 CSSOM 规范化过）
      b.registerSources(Object.fromEntries(state.elements.map((e) => [e.tid, e.style])));
      b.setMode(el.mode.getAttribute('aria-pressed') === 'true' ? 'select' : 'browse');
      if (state.selectedTid !== null) b.select(state.selectedTid, false);
      renderInspector();
    } else if (++tries > 60) clearInterval(timer);
  }, 100);
});

// 桥回调（桥在 iframe 里，通过 window.parent 调过来）
window.__editorHost = {
  onSelect(info) {
    state.selectedTid = info ? info.tid : null;
    renderLayers();
    renderInspector(info);
  },
  onPreview(info) {
    if (info) {
      state.selectedTid = info.tid;
      renderInspector(info, { previewOnly: true });
    }
  },
  async onCommit(tid, style, kind) {
    if (kind === 'move' || kind === 'resize') toast('已改尺寸/位置，正在写回…');
    await commit(tid, style);
  },
  async onTextCommit(tid, text) {
    try {
      await api('/api/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvas: state.canvas, board: state.board, tid, text, origin: CLIENT_ID }),
      });
      toast('文字已写回源码');
      await reloadBoard(true);
    } catch (e) {
      toast(e.message, true);
      await reloadBoard(true);
    }
  },
  onNotice(message) { toast(message); },
};

// ---------------------------------------------------------------- 写入

let commitTimer = null;
async function commit(tid, style, delay = 0) {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(async () => {
    try {
      const out = await api('/api/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvas: state.canvas, board: state.board, tid, style, origin: CLIENT_ID }),
      });
      state.canUndo = out.canUndo === true;
      el.undo.disabled = !state.canUndo;
      // 写回成功了：源码现在就是这一串，把它接成新基准（不整页重载，免得丢焦点）
      if (typeof out.style === 'string') bridge()?.acceptCommitted(tid, out.style);
      const fresh = await api(`/api/board?canvas=${encodeURIComponent(state.canvas)}&board=${encodeURIComponent(state.board)}`);
      state.elements = fresh.elements ?? [];
      renderLayers();
      return out;
    } catch (e) {
      toast(e.message + (e.body?.problems ? `（${e.body.problems.length} 个问题）` : ''), true);
      await reloadBoard(true);
    }
  }, delay);
  return commitTimer;
}

async function reloadBoard(keepSelection) {
  const tid = keepSelection ? state.selectedTid : null;
  state.selectedTid = tid;
  await loadBoard(state.canvas, state.board, true);
}

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
      const i = document.createElement('input'); i.readOnly = true; i.value = comp[k];
      r.append(l, i);
      gComp.appendChild(r);
    }
    const gBox = group('盒子');
    const b = live?.box;
    if (b) gBox.appendChild(div('hint', `${Math.round(b.w)} × ${Math.round(b.h)} px，位于 (${Math.round(b.x)}, ${Math.round(b.y)})`));
  }

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
  if (b) b.preview(tid, decls);
  // 让桥来序列化：它按**原始写法**重建，没动过的声明一个字符都不变
  const style = b?.styleString(tid)
    ?? Object.entries(decls).map(([k, v]) => `${k}: ${v}`).join('; ');
  commit(tid, style, 450);
}

const INHERITED = new Set(['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'text-align']);

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
  toast(on ? '编辑模式：点击只用来选中元素' : '浏览模式：画板自己的按钮可以点');
});

el.textBtn.addEventListener('click', () => {
  const r = bridge()?.startTextEdit();
  if (!r) { toast('画板还没准备好'); return; }
  if (!r.ok) { toast(r.reason, true); return; }
  toast('直接改画板里的字，按 Esc 或点别处结束');
});

el.undo.addEventListener('click', async () => {
  try {
    const out = await api('/api/undo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvas: state.canvas, board: state.board, origin: CLIENT_ID }),
    });
    if (!out.changed) { toast('没有可撤销的改动了'); return; }
    toast('已撤销');
    await reloadBoard(true);
  } catch (e) { toast(e.message, true); }
});

el.reload.addEventListener('click', () => reloadBoard(true));

// 外部改动（agent 或别处）→ 提示并重载
const events = new EventSource('/api/events');
events.addEventListener('message', (ev) => {
  let data = null;
  try { data = JSON.parse(ev.data); } catch { return; }
  if (data?.origin === CLIENT_ID) return; // 自己改的：不用提示，也不用重载
  if (data?.type === 'edited' && data.canvas === state.canvas && data.board === state.board) {
    toast('这份画板在别处被改过（可能是 agent），已重新加载');
    reloadBoard(true);
  }
});

boot().catch((e) => toast(`启动失败：${e.message}`, true));
