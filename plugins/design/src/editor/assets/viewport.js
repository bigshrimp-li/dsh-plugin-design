import { worldToView, viewToWorld, zoomAt as zoomAround, sceneBounds, fitView, constrainView, visibleBoards } from './viewport-math.js';

export function install(editor) {
  const { state, el, events } = editor;
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet'; stylesheet.href = '/viewport.css'; document.head.appendChild(stylesheet);
  el.wrap.classList.add('spatial-viewport');
  const cards = new Map(), memory = new Map();
  const layer = document.createElement('div'); layer.className = 'spatial-overlay-layer'; el.inner.appendChild(layer);
  let view = { k: 1, x: 40, y: 40 }, page = '*', lastCanvas = null, lastBoard = null, activeKey = null;
  let drag = null, space = false, switching = false, saveTimer, refreshFrame, disposed = false, suppressClickUntil = 0;
  const budget = 4;
  const pageSelect = document.createElement('select'); pageSelect.className = 'pick'; pageSelect.setAttribute('aria-label', '画布页面');
  pageSelect.title = '按页面分组浏览'; document.querySelector('.bar').appendChild(pageSelect);
  const percent = document.createElement('input'); percent.type = 'number'; percent.min = '10'; percent.max = '400'; percent.step = '5';
  percent.className = 'spatial-percent'; percent.setAttribute('aria-label', '缩放百分比'); percent.title = '缩放百分比，范围 10–400%';
  document.querySelector('.bar').appendChild(percent);
  for (const [id, label, fn] of [
    ['zoomOut', '−', () => zoomAt(view.k / 1.2)], ['zoomIn', '+', () => zoomAt(view.k * 1.2)],
    ['zoomActual', '100%', () => zoomAt(1)], ['zoomFit', '适应全部', () => fit()],
  ]) editor.addButton(id, label, fn);
  for (const amount of [0.1, 0.25, 2, 4]) if (!Array.from(el.zoom.options).some(o => Number(o.value) === amount)) {
    const option = new Option(`${amount * 100}%`, String(amount)); el.zoom.appendChild(option);
  }
  const inputTarget = target => !!target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const allBoards = () => Object.entries(state.canvasIndex?.boards || {}).map(([path, r]) => ({ path, ...r }));
  const boards = () => allBoards().filter(b => page === '*' || (b.page || '') === page);
  const boardRect = (path = state.board) => allBoards().find(b => b.path === path) || { x: 0, y: 0, w: state.declared.w || 1, h: state.declared.h || 1, path };
  const bounds = () => sceneBounds([...boards(), ...Object.values(state.canvasIndex?.notes || {})
    .filter(n => (n.kind === undefined || n.kind === 'title1') && (page === '*' || (n.page || '') === page))
    .map(n => ({ x: n.x, y: n.y, w: n.kind === 'title1' ? n.maxW : n.w, h: n.maxH ?? (n.kind === 'title1' ? 90 : n.w * 4 / 3) }))]);
  const memoryKey = () => JSON.stringify([state.root, state.canvas, page, state.board]);
  function remember() {
    if (!activeKey) return;
    memory.set(activeKey, { ...view });
    clearTimeout(saveTimer);
    const key = activeKey, snapshot = { ...view };
    saveTimer = setTimeout(() => { try { localStorage.setItem(`dsh-design-view:${key}`, JSON.stringify(snapshot)); } catch {} }, 180);
  }
  function restore() {
    activeKey = memoryKey();
    let saved = memory.get(activeKey);
    if (!saved) try { saved = JSON.parse(localStorage.getItem(`dsh-design-view:${activeKey}`)); } catch {}
    if (saved && [saved.x, saved.y, saved.k].every(Number.isFinite)) view = saved;
    else view = fitView(boardRect(), el.wrap.clientWidth, el.wrap.clientHeight);
  }
  function clientToWorld(point) {
    const rect = el.wrap.getBoundingClientRect();
    return viewToWorld({ x: point.x - rect.left, y: point.y - rect.top }, view);
  }
  function worldToClient(point) {
    const rect = el.wrap.getBoundingClientRect(), p = worldToView(point, view);
    return { x: p.x + rect.left, y: p.y + rect.top };
  }
  function syncFrame() {
    const b = boardRect();
    Object.assign(el.board.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, transform: 'none' });
    editor.bridge()?.setViewportScale?.(view.k);
  }
  function draw() {
    if (disposed) return;
    view = constrainView(view, bounds(), el.wrap.clientWidth, el.wrap.clientHeight);
    el.inner.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
    el.inner.style.width = '0px'; el.inner.style.height = '0px';
    el.wrap.style.setProperty('--scaled', String(view.k));
    percent.value = String(Math.round(view.k * 100));
    syncFrame(); remember();
    events.dispatchEvent(new CustomEvent('viewport', { detail: { view: { ...view }, page, board: state.board } }));
    cancelAnimationFrame(refreshFrame); refreshFrame = requestAnimationFrame(refreshFrames);
  }
  function zoomAt(amount, anchor = { x: el.wrap.clientWidth / 2, y: el.wrap.clientHeight / 2 }) {
    view = zoomAround(view, amount, anchor); draw();
  }
  function fit() { view = fitView(bounds(), el.wrap.clientWidth, el.wrap.clientHeight); draw(); }
  function applyZoom() {
    syncFrame();
    if (state.canvas === lastCanvas && state.board === lastBoard) draw();
  }
  el.zoom.addEventListener('change', event => {
    event.stopImmediatePropagation();
    if (el.zoom.value === 'fit') fit(); else zoomAt(Number(el.zoom.value));
  }, true);
  function removePreview(card) {
    if (!card.frame) return;
    // Detached browsing contexts release runtime intervals/listeners with the DOM.
    card.frame.contentWindow?.__designEditor?.dispose?.();
    card.frame.remove(); card.frame = null;
  }
  function refreshFrames() {
    const wanted = new Set(visibleBoards(boards(), view, el.wrap.clientWidth, el.wrap.clientHeight, state.board, budget));
    // Release first, so the instantaneous count never exceeds the budget.
    for (const [path, card] of cards) if (!wanted.has(path)) removePreview(card);
    for (const path of wanted) {
      const card = cards.get(path);
      if (!card || card.frame) continue;
      const frame = document.createElement('iframe'); frame.dataset.dcPreview = 'true'; frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true'); frame.title = `${path} 只读预览`;
      frame.src = `/board/${state.canvas.split('/').map(encodeURIComponent).join('/')}/${path.split('/').map(encodeURIComponent).join('/')}`;
      card.frame = frame; card.element.insertBefore(frame, card.hit);
    }
  }
  async function activate(path) {
    if (switching || path === state.board) return;
    switching = true;
    try {
      // The sole editable iframe is never reclaimed by viewport eviction.
      await editor.beforeAction();
      if (editor.bridge()?.isInteracting) throw new Error('请先结束当前拖动');
      remember(); await editor.loadBoard(state.canvas, path);
    } catch (error) { editor.toast(error.message, true); }
    finally { switching = false; }
  }
  function refreshCards() {
    const wanted = new Set(boards().map(b => b.path));
    for (const [path, card] of cards) if (!wanted.has(path)) { removePreview(card); card.element.remove(); cards.delete(path); }
    for (const b of boards()) {
      let card = cards.get(b.path);
      if (!card) {
        const element = document.createElement('div'); element.className = 'spatial-board'; element.dataset.board = b.path;
        const placeholder = document.createElement('div'); placeholder.className = 'spatial-board-placeholder'; placeholder.textContent = `${b.w} × ${b.h}`;
        const hit = document.createElement('button'); hit.type = 'button'; hit.className = 'spatial-board-hit'; hit.setAttribute('aria-label', `编辑画板 ${b.title || b.path}`);
        const title = document.createElement('button'); title.type = 'button'; title.className = 'spatial-board-title';
        hit.addEventListener('click', () => { if (!space && !drag && Date.now() > suppressClickUntil) activate(b.path); }); title.addEventListener('click', () => activate(b.path));
        element.append(placeholder, hit, title); el.inner.insertBefore(element, el.board);
        card = { element, placeholder, hit, title, frame: null }; cards.set(b.path, card);
      }
      Object.assign(card.element.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
      const active = b.path === state.board;
      card.element.classList.toggle('active', active); card.hit.hidden = active; card.placeholder.hidden = active;
      card.title.textContent = b.title || b.path.replace(/\.dc\.html$/, '');
      if (active) removePreview(card);
    }
    el.board.hidden = !wanted.has(state.board);
  }
  function pages() {
    pageSelect.replaceChildren(new Option('全部页面', '*'), new Option('未分组', ''));
    for (const p of state.canvasIndex?.pages || []) pageSelect.appendChild(new Option(p.name, p.id));
    pageSelect.value = page; pageSelect.hidden = !(state.canvasIndex?.pages?.length);
  }
  function refresh() { pages(); refreshCards(); draw(); }
  events.addEventListener('board', () => {
    const changed = state.canvas !== lastCanvas || state.board !== lastBoard;
    if (state.canvas !== lastCanvas) { for (const card of cards.values()) { removePreview(card); card.element.remove(); } cards.clear(); }
    if (changed) {
      page = boardRect().page || '*';
      lastCanvas = state.canvas; lastBoard = state.board;
      restore();
    }
    refresh();
  });
  events.addEventListener('bridge-ready', ({ detail }) => {
    if (detail.canvas !== state.canvas || detail.board !== state.board) return;
    detail.bridge.setViewportScale?.(view.k);
    detail.bridge.setNavigation?.(event => {
      if (detail.canvas !== state.canvas || detail.board !== state.board) return false;
      const board = boardRect(), point = worldToView({ x: board.x + event.x, y: board.y + event.y }, view);
      return navigate({ ...event, x: point.x, y: point.y });
    });
  });
  events.addEventListener('saved', () => { refreshCards(); draw(); });
  pageSelect.addEventListener('change', async () => {
    try {
      await editor.beforeAction(); remember(); page = pageSelect.value; activeKey = memoryKey();
      refreshCards(); fit();
    } catch (error) { pageSelect.value = page; editor.toast(error.message, true); }
  });
  percent.addEventListener('change', () => zoomAt(Number(percent.value) / 100));
  function navigate(event) {
    if (event.type === 'space') { space = event.down; el.wrap.dataset.space = String(space); return true; }
    if (event.type === 'cancel') { drag = null; space = false; el.wrap.dataset.panning = 'false'; el.wrap.dataset.space = 'false'; return false; }
    if (event.type === 'wheel') {
      if (event.ctrl || event.meta) zoomAt(view.k * Math.exp(-event.dy * 0.002), { x: event.x, y: event.y });
      else {
        view.x -= event.shift ? (event.dy || event.dx) : event.dx;
        view.y -= event.shift ? 0 : event.dy;
        draw();
      }
      return true;
    }
    if (event.type === 'down' && (event.button === 1 || (event.button === 0 && space))) {
      drag = { x: event.screenX, y: event.screenY, view: { ...view } }; el.wrap.dataset.panning = 'true'; return true;
    }
    if (event.type === 'move' && drag) {
      view = { ...drag.view, x: drag.view.x + event.screenX - drag.x, y: drag.view.y + event.screenY - drag.y }; draw(); return true;
    }
    if (event.type === 'up' && drag) { suppressClickUntil = Date.now() + 150; drag = null; el.wrap.dataset.panning = 'false'; return true; }
    return false;
  }
  function outer(event) {
    if (inputTarget(event.target) || event.isComposing) return;
    const rect = el.wrap.getBoundingClientRect();
    const type = { pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel', wheel: 'wheel' }[event.type];
    const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.wrap.clientHeight : 1;
    if (navigate({ type, x: event.clientX - rect.left, y: event.clientY - rect.top, screenX: event.screenX, screenY: event.screenY,
      dx: (event.deltaX || 0) * factor, dy: (event.deltaY || 0) * factor, button: event.button, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey })) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (type === 'down') el.wrap.setPointerCapture(event.pointerId);
    }
  }
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) el.wrap.addEventListener(type, outer, { capture: true, passive: false });
  document.addEventListener('keydown', event => {
    if (inputTarget(event.target) || event.isComposing) return;
    if (event.code === 'Space') { navigate({ type: 'space', down: true }); event.preventDefault(); }
    if (event.key === 'Escape') navigate({ type: 'cancel' });
  }, true);
  document.addEventListener('keyup', event => { if (event.code === 'Space') navigate({ type: 'space', down: false }); }, true);
  window.addEventListener('blur', () => navigate({ type: 'cancel' }));
  const observer = new ResizeObserver(() => draw()); observer.observe(el.wrap);
  editor.features.viewport = {
    applyZoom, fit, zoomAt, clientToWorld, worldToClient, layer, boardRect, activate, refresh,
    restore(value){if(value && [value.k,value.x,value.y].every(Number.isFinite)){view={...value,k:Math.max(.1,Math.min(4,value.k))};refresh();}},
    get view() { return { ...view }; }, get page() { return page; }, get frameCount() { return 1 + [...cards.values()].filter(c => c.frame).length; },
    get budget() { return budget; }, get isPanning() { return !!drag; },
  };
  window.addEventListener('pagehide', () => { disposed = true; observer.disconnect(); cancelAnimationFrame(refreshFrame); for (const card of cards.values()) removePreview(card); });
}
