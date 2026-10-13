/**
 * 编辑器桥：跑在画板 iframe **里面**，只负责画板这一侧的 DOM。
 *
 * 分工：
 *   桥（这里）—— 悬停/选中的轮廓、命中测试、拖动与缩放手势、实时预览、原地改字
 *   外壳（shell.js）—— 界面、状态、撤销、跟服务端往返
 *
 * 两者同源，所以直接互相调用，不走 postMessage。
 *
 * 坐标：外壳可能给 iframe 套了 `transform: scale()` 来适应面板宽度，但**沙箱内部的鼠标坐标
 * 已经是自然坐标**（浏览器替我们换算过了），所以这里一律按画板自身的 CSS px 工作。
 */
(function () {
  'use strict';

  var HOST = window.parent !== window ? window.parent : null;
  var root = null;
  var overlay = null;
  var hoverBox = null;
  var selBox = null;
  var handles = [];
  var selected = null;
  var mode = 'select'; // select | text
  var drag = null;
  var pending = null;

  var HANDLE_SIZE = 9;
  var MIN_SIZE = 8;

  // ---------- 工具 ----------

  function tidOf(el) {
    while (el && el !== document.documentElement) {
      if (el.hasAttribute && el.hasAttribute('data-dc-tpl')) return Number(el.getAttribute('data-dc-tpl'));
      el = el.parentElement;
    }
    return null;
  }

  function elOf(tid) {
    if (selected && selected.isConnected && tidOf(selected) === tid) return selected;
    return document.querySelector('[data-dc-tpl="' + tid + '"]');
  }

  /** 画板根元素：运行时刻挂出来的第一层内容。 */
  function artboardRoot() {
    var host = document.querySelector('#dc-root .sc-host');
    return (host && host.firstElementChild) || document.querySelector('#dc-root') || null;
  }

  function boxOf(el) {
    var r = el.getBoundingClientRect();
    var s = window.scrollX;
    var t = window.scrollY;
    return { x: r.left + s, y: r.top + t, w: r.width, h: r.height };
  }

  /** 原始 style 文本 → 有序的 [键, 值]，保留原有写法与顺序。 */
  function parseDeclsRaw(raw) {
    var out = [];
    raw.split(';').forEach(function (part) {
      var at = part.indexOf(':');
      if (at < 0) return;
      var k = part.slice(0, at).trim();
      if (k) out.push([k, part.slice(at + 1).trim()]);
    });
    return out;
  }

  function declsToObject(pairs) {
    var out = {};
    pairs.forEach(function (kv) { out[kv[0]] = kv[1]; });
    return out;
  }

  /** 按**原始写法**重建 style 文本：没动过的声明一个字符都不变。 */
  function serialize(baseRaw, decls) {
    var parts = [];
    var seen = {};
    parseDeclsRaw(baseRaw).forEach(function (kv) {
      if (!(kv[0] in decls)) return; // 被删掉了
      seen[kv[0]] = 1;
      parts.push(kv[0] + ': ' + decls[kv[0]]);
    });
    Object.keys(decls).forEach(function (k) {
      if (!seen[k]) parts.push(k + ': ' + decls[k]);
    });
    return parts.join('; ');
  }

  /**
   * 行内样式的**真源**是源码文本，不是 DOM。
   * 画板是 React 挂出来的，React 走 CSSOM 应用 style，读回来已经被规范化了
   * （`margin: 8px 0 0` 会变成 `8px 0px 0px`）。拿它当基准，改一个 font-size 会把整个
   * style 属性的写法改掉。所以外壳把源码里的原文注册进来，以它为准。
   */
  var sources = {};

  function registerSources(map) {
    sources = map || {};
    // 重新注册 = 源码变了，丢弃缓存
    var all = document.querySelectorAll('[data-dc-tpl]');
    for (var i = 0; i < all.length; i++) {
      delete all[i].__dcBaseStyle;
      delete all[i].__dcDecls;
      delete all[i].__dcRenderedStyle;
    }
  }

  /** 写回成功后：源码现在就是这一串，把它接成新的基准，不必整页重载。 */
  function acceptCommitted(tid, style) {
    var list = document.querySelectorAll('[data-dc-tpl="' + tid + '"]');
    for (var i = 0; i < list.length; i++) {
      var committed = currentStyle(list[i]) === style;
      list[i].__dcBaseStyle = style;
      if (committed) delete list[i].__dcDecls;
      if (committed) list[i].__dcRenderedStyle = list[i].getAttribute('style') || '';
    }
    sources[tid] = Object.assign({}, sources[tid], { style: style });
  }

  function baseStyleOf(el) {
    if (el.__dcBaseStyle === undefined) {
      var tid = tidOf(el);
      var fromSource = tid !== null && Object.prototype.hasOwnProperty.call(sources, tid) ? sources[tid].style : null;
      el.__dcBaseStyle = fromSource !== null ? fromSource : (el.getAttribute('style') || '');
    }
    return el.__dcBaseStyle;
  }

  /** 行内 style → 对象。只读行内，继承来的值不在这里。 */
  function inlineDecls(el) {
    return Object.assign({}, el.__dcDecls || declsToObject(parseDeclsRaw(baseStyleOf(el))));
  }

  function setPreview(el, decls) {
    // Repeated instances share source styles, but retain their own resolved bindings.
    var list = document.querySelectorAll('[data-dc-tpl="' + tidOf(el) + '"]');
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var base = declsToObject(parseDeclsRaw(baseStyleOf(item)));
      if (item.__dcRenderedStyle === undefined) item.__dcRenderedStyle = item.getAttribute('style') || '';
      item.__dcDecls = Object.assign({}, decls);
      item.setAttribute('style', item.__dcRenderedStyle);
      Object.keys(base).forEach(function (key) { if (!(key in decls)) item.style.removeProperty(key); });
      Object.keys(decls).forEach(function (key) {
        if (decls[key] === base[key]) return;
        var value = decls[key];
        item.style.setProperty(key, value.replace(/\s*!important\s*$/, ''), /!important\s*$/.test(value) ? 'important' : '');
      });
    }
  }

  function clearPreview(el) {
    if (!el || el.__dcBaseStyle === undefined) return;
    el.setAttribute('style', el.__dcRenderedStyle || el.__dcBaseStyle);
    delete el.__dcBaseStyle;
    delete el.__dcDecls;
  }

  /** 待写回的样式串；用工作时的那份声明，而不是从 CSSOM 读回来的。 */
  function currentStyle(el) {
    if (el.__dcDecls !== undefined) return serialize(baseStyleOf(el), el.__dcDecls);
    return baseStyleOf(el);
  }

  // ---------- 覆盖层 ----------

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.setAttribute('data-dc-editor', 'overlay');
    overlay.style.cssText =
      'position:absolute;inset:0;z-index:2147483000;pointer-events:none;' +
      'font:11px/1.4 ui-sans-serif,system-ui,sans-serif';

    hoverBox = document.createElement('div');
    hoverBox.style.cssText =
      'position:absolute;border:1px solid rgba(37,99,235,.7);background:rgba(37,99,235,.06);' +
      'pointer-events:none;display:none;box-sizing:border-box';
    overlay.appendChild(hoverBox);

    selBox = document.createElement('div');
    selBox.style.cssText = 'position:absolute;pointer-events:none;display:none;box-sizing:border-box';
    overlay.appendChild(selBox);

    for (var i = 0; i < 8; i++) {
      var h = document.createElement('div');
      h.setAttribute('data-handle', String(i));
      h.style.cssText =
        'position:absolute;width:' + HANDLE_SIZE + 'px;height:' + HANDLE_SIZE + 'px;margin:' +
        -HANDLE_SIZE / 2 + 'px 0 0 ' + -HANDLE_SIZE / 2 + 'px;background:#fff;border:1px solid #2563eb;' +
        'border-radius:2px;pointer-events:auto;display:none;box-sizing:border-box';
      h.style.cursor = ['nwse-resize','ns-resize','nesw-resize','ew-resize','nwse-resize','ns-resize','nesw-resize','ew-resize'][i];
      overlay.appendChild(h);
      handles.push(h);
    }

    var label = document.createElement('div');
    label.setAttribute('data-dc-editor', 'label');
    label.style.cssText =
      'position:absolute;background:#2563eb;color:#fff;padding:2px 6px;border-radius:3px;' +
      'white-space:nowrap;pointer-events:none;display:none;font-weight:600;letter-spacing:.02em';
    overlay.appendChild(label);
    overlay.__label = label;

    // 编辑模式下禁掉浏览器的原生文字选择：拖手柄时会拖出一片蓝色选区
    var noSelect = document.createElement('style');
    noSelect.textContent =
      'html[data-dc-editor-mode="select"] *{user-select:none !important;-webkit-user-select:none !important}' +
      'html[data-dc-editor-mode="text"] [contenteditable]{user-select:text !important;-webkit-user-select:text !important}';
    document.head.appendChild(noSelect);

    document.body.appendChild(overlay);
    layoutOverlay();
  }

  /** 覆盖层铺在文档坐标上：画板可能比视口高，要用绝对定位跟着走。 */
  function layoutOverlay() {
    if (!overlay) return;
    var w = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    overlay.style.width = w + 'px';
    overlay.style.height = h + 'px';
  }

  var HANDLE_POS = [
    ['left', 'top'], ['50%', 'top'], ['right', 'top'], ['right', '50%'],
    ['right', 'bottom'], ['50%', 'bottom'], ['left', 'bottom'], ['left', '50%'],
  ];

  function place(el, box) {
    el.style.left = box.x + 'px';
    el.style.top = box.y + 'px';
    el.style.width = box.w + 'px';
    el.style.height = box.h + 'px';
  }

  function showSelection() {
    if (!selected) {
      selBox.style.display = 'none';
      handles.forEach(function (h) { h.style.display = 'none'; });
      overlay.__label.style.display = 'none';
      return;
    }
    var box = boxOf(selected);
    selBox.style.display = 'block';
    selBox.style.border = '1px solid #2563eb';
    selBox.style.boxShadow = '0 0 0 1px rgba(255,255,255,.9)';
    place(selBox, box);
    handles.forEach(function (h, i) {
      h.style.display = mode === 'select' ? 'block' : 'none';
      h.style.left = (box.x + (HANDLE_POS[i][0] === 'left' ? 0 : HANDLE_POS[i][0] === 'right' ? box.w : box.w / 2)) + 'px';
      h.style.top = (box.y + (HANDLE_POS[i][1] === 'top' ? 0 : HANDLE_POS[i][1] === 'bottom' ? box.h : box.h / 2)) + 'px';
    });
    var label = overlay.__label;
    label.style.display = 'block';
    label.textContent = selected.tagName.toLowerCase() + '  ' + Math.round(box.w) + '×' + Math.round(box.h);
    label.style.left = box.x + 'px';
    label.style.top = Math.max(0, box.y - 20) + 'px';
  }

  function showHover(el) {
    if (!hoverBox) return;
    if (!el || el === selected || el === overlay || overlay.contains(el)) {
      hoverBox.style.display = 'none';
      return;
    }
    hoverBox.style.display = 'block';
    place(hoverBox, boxOf(el));
  }

  // ---------- 描述 ----------

  function describe(tid) {
    var el = elOf(tid);
    if (!el) return null;
    var parent = el.parentElement;
    var parentTid = parent ? tidOf(parent) : null;
    var cs = getComputedStyle(el);
    return {
      tid: tid,
      tag: el.tagName.toLowerCase(),
      classes: el.getAttribute('class') || '',
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      // 行内声明 = 可以改的；计算值 = 只读参考
      inline: inlineDecls(el),
      computed: {
        'font-size': cs.fontSize,
        'font-family': cs.fontFamily.split(',')[0].replace(/["']/g, ''),
        'font-weight': cs.fontWeight,
        color: cs.color,
        'background-color': cs.backgroundColor,
        display: cs.display,
        position: cs.position,
      },
      box: boxOf(el),
      /** 有没有子元素：有的话不能原地改字 */
      hasChildren: el.children.length > 0,
      /** 内容是不是纯文字（没有子元素、也不是 void） */
      editableText: sources[tid]?.editableText === true,
      /** 内容里有没有 {{hole}}：有就不能原地改字 */
      hasHole: sources[tid]?.hasHole === true,
      parentTid: parentTid,
      /** sc-for 展开出来的实例数：改一个 = 改全部 */
      instances: document.querySelectorAll('[data-dc-tpl="' + tid + '"]').length,
    };
  }

  // ---------- 手势 ----------

  function hitTest(clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    if (!el || el === overlay || (overlay && overlay.contains(el))) return null;
    return tidOf(el);
  }

  function onMouseMove(e) {
    // 按下之后移动超过阈值才算拖动：不这样的话，要么点一下就会挪动元素，
    // 要么得先点选、再按住拖 —— 后者不是设计工具的习惯
    if (!drag && pending) {
      var dx = e.clientX - pending.startX;
      var dy = e.clientY - pending.startY;
      if (!pending.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      pending.moved = true;
      drag = { kind: 'move', el: pending.el, startX: pending.startX, startY: pending.startY,
               base: pending.base, absolute: pending.absolute, left: pending.left, top: pending.top };
    }
    if (drag) return onDragMove(e);
    if (mode !== 'select') return;
    var tid = hitTest(e.clientX, e.clientY);
    showHover(tid === null ? null : elOf(tid));
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (mode === 'text') {
      // 正在原地改字：点到自己身上就继续编辑，点到别处就提交并退出
      if (selected && (e.target === selected || selected.contains(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
      finishTextEdit();
      return;
    }
    if (mode !== 'select') return;
    var handleIdx = e.target && e.target.getAttribute && e.target.getAttribute('data-handle');
    if (handleIdx !== null && handleIdx !== undefined && selected) {
      e.preventDefault();
      e.stopPropagation();
      drag = {
        kind: 'resize', index: Number(handleIdx), el: selected,
        startX: e.clientX, startY: e.clientY,
        base: inlineDecls(selected), box: boxOf(selected),
        absolute: getComputedStyle(selected).position === 'absolute',
        css: getComputedStyle(selected),
        left: parseFloat(getComputedStyle(selected).left) || 0,
        top: parseFloat(getComputedStyle(selected).top) || 0,
      };
      selected.setPointerCapture(e.pointerId);
      return;
    }
    var tid = hitTest(e.clientX, e.clientY);
    if (tid === null) return;
    // 编辑模式下，按下只用来选中：不让画板自己的按钮/链接响应
    e.preventDefault();
    e.stopPropagation();
    var target = e.target.closest('[data-dc-tpl]');
    select(tid, true, target);
    // 选中之后把拖动挂上，移动超过阈值才真的拖
    var el = elOf(tid);
    pending = {
      el: el, startX: e.clientX, startY: e.clientY, base: inlineDecls(el),
      absolute: getComputedStyle(el).position === 'absolute', moved: false,
      css: getComputedStyle(el),
      left: parseFloat(getComputedStyle(el).left) || 0,
      top: parseFloat(getComputedStyle(el).top) || 0,
    };
    el.setPointerCapture(e.pointerId);
  }

  function onDragMove(e) {
    var dx = Math.round(e.clientX - drag.startX);
    var dy = Math.round(e.clientY - drag.startY);
    var decls = Object.assign({}, drag.base);
    if (drag.kind === 'move') {
      if (drag.absolute) {
        var left = drag.left;
        var top = drag.top;
        decls.left = Math.round(left + dx) + 'px';
        decls.top = Math.round(top + dy) + 'px';
        delete decls.right; delete decls.bottom;
      } else {
        // 流式布局里直接改坐标会重排兄弟元素，所以用 transform 做纯视觉偏移
        decls.transform = 'translate(' + dx + 'px, ' + dy + 'px)' +
          (drag.base.transform && drag.base.transform !== 'none' ? ' ' + drag.base.transform : '');
      }
    } else {
      var i = drag.index;
      var west = i === 0 || i === 6 || i === 7;
      var east = i === 2 || i === 3 || i === 4;
      var north = i === 0 || i === 1 || i === 2;
      var south = i === 4 || i === 5 || i === 6;
      var w = drag.box.w + (east ? dx : west ? -dx : 0);
      var h = drag.box.h + (south ? dy : north ? -dy : 0);
      w = Math.max(MIN_SIZE, Math.round(w));
      h = Math.max(MIN_SIZE, Math.round(h));
      var cs = drag.css;
      var extraW = cs.boxSizing === 'border-box' ? 0 : parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      var extraH = cs.boxSizing === 'border-box' ? 0 : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      if (east || west) decls.width = Math.max(0, w - extraW) + 'px';
      if (north || south) decls.height = Math.max(0, h - extraH) + 'px';
      if (drag.absolute) {
        if (east || west) { decls.left = Math.round(drag.left + (west ? drag.box.w - w : 0)) + 'px'; delete decls.right; }
        if (north || south) { decls.top = Math.round(drag.top + (north ? drag.box.h - h : 0)) + 'px'; delete decls.bottom; }
      }
    }
    drag.decls = decls;
    setPreview(drag.el, decls);
    showSelection();
    if (HOST && HOST.__editorHost) HOST.__editorHost.onPreview(describe(tidOf(drag.el)), decls);
  }

  function onMouseUp() {
    var wasClick = pending !== null && !pending.moved;
    pending = null;
    if (wasClick) return; // 只是点了一下：选中已经在 mousedown 里做完了
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.decls) {
      // 定稿：用工作声明拼出待写回的样式串（保住没动过的声明的原始写法）
      var style = currentStyle(d.el);
      if (HOST && HOST.__editorHost) HOST.__editorHost.onCommit(tidOf(d.el), style, d.kind);
    }
    // Keep the preview until the host acknowledges the write; a failed write reloads it.
    showSelection();
  }

  /** 从当前选中往上找一层带 tid 的祖先。 */
  function selectParent() {
    if (!selected) return;
    var p = selected.parentElement;
    while (p && p !== document.body) {
      if (p.hasAttribute && p.hasAttribute('data-dc-tpl')) {
        select(Number(p.getAttribute('data-dc-tpl')), true);
        return;
      }
      p = p.parentElement;
    }
    if (HOST && HOST.__editorHost) HOST.__editorHost.onNotice('已经到画板根元素了');
  }

  function onDoubleClick(e) {
    if (mode !== 'select') return;
    e.preventDefault();
    e.stopPropagation();
    selectParent();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (mode === 'text') setMode('select');
      else select(null, true);
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && selected && mode === 'select' &&
        !/^(input|textarea)$/i.test(document.activeElement.tagName)) {
      // 删除元素属于结构编辑，P2 不做 —— 只提示
      if (HOST && HOST.__editorHost) HOST.__editorHost.onNotice('删除元素要改结构，这一版还不支持；可以在属性面板里把它隐藏。');
    }
  }

  // ---------- 对外 ----------

  function select(tid, notify, target) {
    if (mode === 'text') finishTextEdit();
    selected = tid === null || tid === undefined ? null : target || elOf(tid);
    showSelection();
    if (notify && HOST && HOST.__editorHost) {
      HOST.__editorHost.onSelect(tid === null || tid === undefined ? null : describe(tid));
    }
  }

  function setMode(next) {
    if (mode === 'text' && next !== 'text') finishTextEdit();
    mode = next;
    document.documentElement.setAttribute('data-dc-editor-mode', mode);
    if (mode === 'text') {
      selected?.setAttribute?.('contenteditable', 'plaintext-only');
      selected?.focus?.();
    } else if (selected) {
      selected.removeAttribute('contenteditable');
    }
    showSelection();
  }

  function startTextEdit() {
    if (!selected) return { ok: false, reason: '先选中一个元素' };
    var d = describe(tidOf(selected));
    if (d.hasHole) return { ok: false, reason: '这段文字是 {{…}} 数据绑定，要改得改它的 prop' };
    if (!d.editableText) return { ok: false, reason: '这个元素里还有子元素，原地改字只支持纯文字节点' };
    selected.__dcOriginalText = selected.textContent || '';
    setMode('text');
    return { ok: true };
  }

  function finishTextEdit() {
    if (!selected || mode !== 'text') return null;
    var el = selected;
    var tid = tidOf(el);
    var text = el.textContent || '';
    mode = 'select';
    el.removeAttribute('contenteditable');
    setMode('select');
    if (text !== el.__dcOriginalText && HOST && HOST.__editorHost) HOST.__editorHost.onTextCommit(tid, text);
    return text;
  }

  function init() {
    root = artboardRoot();
    if (!root) return false;
    buildOverlay();
    // 捕获阶段：编辑模式下属画板自己的交互让位给选中
    document.addEventListener('pointermove', onMouseMove, true);
    document.addEventListener('pointerdown', onMouseDown, true);
    document.addEventListener('pointerup', onMouseUp, true);
    document.addEventListener('click', function (e) {
      if (mode !== 'browse') { e.preventDefault(); e.stopImmediatePropagation(); return; }
      var a = e.target.closest('a[href]');
      if (!a || !HOST?.__editorHost) return;
      var target = new URL(a.href, location.href);
      if (target.origin === location.origin && target.pathname.startsWith('/board/') && target.pathname.endsWith('.dc.html')) {
        e.preventDefault(); e.stopImmediatePropagation();
        HOST.__editorHost.onNavigate(target.pathname);
      }
    }, true);
    document.addEventListener('focusout', function () { if (mode === 'text') finishTextEdit(); }, true);
    window.addEventListener('blur', function () { if (mode === 'text') finishTextEdit(); });
    document.addEventListener('dblclick', onDoubleClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mouseleave', function () { showHover(null); }, true);
    window.addEventListener('resize', function () { layoutOverlay(); showSelection(); });
    // 画板自己的滚动/动画会让位置漂移，跟着刷新
    setInterval(function () { layoutOverlay(); showSelection(); }, 600);
    return true;
  }

  window.__designEditor = {
    get ready() { return root !== null; },
    describe: describe,
    select: select,
    startTextEdit: startTextEdit,
    selectParent: selectParent,
    finishTextEdit: finishTextEdit,
    setMode: setMode,
    get mode() { return mode; },
    get selectedTid() { return selected ? tidOf(selected) : null; },
    refresh: function () { layoutOverlay(); showSelection(); },
    artboardRoot: artboardRoot,
    inlineDecls: function (tid) { var el = elOf(tid); return el ? inlineDecls(el) : null; },
    currentStyle: function (tid) { var el = elOf(tid); return el ? currentStyle(el) : null; },
    boxOf: function (tid) { var el = elOf(tid); return el ? boxOf(el) : null; },
    registerSources: registerSources,
    acceptCommitted: acceptCommitted,
    /** 直接改行内样式（外壳改字段时用），不写文件 */
    preview: function (tid, decls) { var el = elOf(tid); if (el) { setPreview(el, decls); showSelection(); } },
    styleString: function (tid) { var el = elOf(tid); return el ? currentStyle(el) : null; },
  };

  if (!init()) {
    var tries = 0;
    var timer = setInterval(function () {
      if (init() || ++tries > 100) clearInterval(timer);
    }, 50);
  }
})();
