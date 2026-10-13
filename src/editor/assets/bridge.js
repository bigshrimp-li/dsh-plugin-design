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

  var HOST = window.parent !== window && !window.frameElement?.hasAttribute('data-dc-preview') ? window.parent : null;
  var root = null;
  var overlay = null;
  var hoverBox = null;
  var selBox = null;
  var handles = [];
  var selected = null;
  var selectedElements = [], marquee = null, regionDrag = null, regionMode = false, regionCallback = null;
  var mode = 'select'; // select | text
  var drag = null;
  var pending = null;
  var annotationMode = false;
  var externalBusy = false;
  var navigation = null, navigationDrag = false, viewportScale = 1;
  var listeners = new AbortController(), layoutTimer = null, timer = null;
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, Object.assign({}, typeof options === 'boolean' ? { capture: options } : options, { signal: listeners.signal }));
  }
  function isInput(target) { return !!target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'); }
  function routeNavigation(e) {
    if (!navigation || e.isComposing || isInput(e.target) || mode === 'text') return;
    var type = { pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel', wheel: 'wheel' }[e.type];
    var factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    if (navigation({ type: type, x: e.clientX, y: e.clientY, screenX: e.screenX, screenY: e.screenY,
      dx: (e.deltaX || 0) * factor, dy: (e.deltaY || 0) * factor, button: e.button, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey })) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (type === 'down') { navigationDrag = true; e.target.setPointerCapture?.(e.pointerId); }
      if (type === 'up' || type === 'cancel') navigationDrag = false;
    }
  }
  function cancelGesture() {
    if (drag?.group) drag.group.forEach(function (item) { sameSourceInstances(tidOf(item.el)).forEach(clearPreview); });
    else if (drag?.el) sameSourceInstances(tidOf(drag.el)).forEach(clearPreview);
    drag = null; pending = null; navigationDrag = false;
    regionDrag = null; if (marquee) marquee.style.display = 'none';
    if (regionCallback) { regionMode = false; regionCallback = null; HOST?.__editorHost?.onRegionCancel?.(); }
    navigation?.({ type: 'cancel' });
    if (overlay) showSelection();
  }
  function dispose() {
    cancelGesture(); listeners.abort(); clearInterval(layoutTimer); clearInterval(timer);
    overlay?.remove(); document.querySelector('[data-dc-editor="selection-style"]')?.remove();
    selected = null; root = null; navigation = null;
  }

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
    var candidates = document.querySelectorAll('[data-dc-tpl="' + tid + '"]');
    for (var i = 0; i < candidates.length; i++) if (provenance(candidates[i]).writable) return candidates[i];
    return candidates[0] || null;
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
  var sourceContext = null;

  // Runtime evidence: compileDesignImport creates a nested .sc-host with its own
  // annotation sequence; compileExternalImport uses .sc-host-x. A tid is local
  // to ONE template and cannot identify nodes across either boundary.
  function provenance(el) {
    var blocked = function (reason) { return { writable: false, readonlyReason: reason, sourceRef: null }; };
    if (!el || !el.isConnected) return blocked('元素已离开画板，请重新选择');
    var host = document.querySelector('#dc-root > .sc-host');
    if (!host || !host.contains(el)) return blocked('无法确认元素所属画板');
    var cursor = el;
    while (cursor && cursor !== host) {
      if (cursor.matches('.sc-host, .sc-host-x')) return blocked('导入组件的源码来源尚未确认，请在组件源画板编辑');
      cursor = cursor.parentElement;
    }
    var tid = tidOf(el), source = sources[tid];
    if (!source) return blocked('当前源码中找不到元素，请刷新画板');
    if (source.tag !== el.tagName.toLowerCase()) return blocked('渲染结构与源码不一致，请刷新或修正画板');
    var expected = source.parentTid;
    var visited = {};
    while (expected !== null && expected !== undefined && sources[expected] && /^(sc-for|sc-if)$/.test(sources[expected].tag)) {
      if (visited[expected]) return blocked('源码父级关系不合法');
      visited[expected] = true;
      expected = sources[expected].parentTid;
    }
    cursor = el.parentElement;
    // Runtime-only binding spans do not own a template ID. All real source
    // ancestors must agree; implicit browser nodes (e.g. tbody) are not guessed.
    if (cursor !== host && (!cursor || !cursor.hasAttribute('data-dc-tpl'))) return blocked('渲染结构与源码不一致，请检查隐式容器');
    var actual = cursor === host ? null : tidOf(cursor);
    if (expected !== actual) return blocked('渲染父级与源码不一致，已禁止写入');
    if (cursor !== host) {
      var parentSource = provenance(cursor);
      if (!parentSource.writable) return parentSource;
    }
    if (!sourceContext || typeof sourceContext.canvas !== 'string' || !sourceContext.board || !sourceContext.revision) return blocked('源码版本尚未就绪，请刷新画板');
    return { writable: true, readonlyReason: null, sourceRef: {
      canvas: sourceContext.canvas, board: sourceContext.board,
      revision: sourceContext.revision, tid: tid
    } };
  }

  function sameSourceInstances(tid) {
    return Array.from(document.querySelectorAll('[data-dc-tpl="' + tid + '"]')).filter(function (el) { return provenance(el).writable; });
  }

  function instanceOf(el) {
    var list = sameSourceInstances(tidOf(el));
    var path = [], cursor = el;
    var host = document.querySelector('#dc-root > .sc-host');
    // Helmet styles are deliberately mounted in <head> by the runtime, and
    // still carry template IDs. They are readable metadata, not board instances.
    if (!host || !host.contains(el)) return { index: -1, count: 0, path: [] };
    while (cursor && cursor !== host) {
      if (!cursor.parentElement) return { index: -1, count: 0, path: [] };
      path.unshift(Array.prototype.indexOf.call(cursor.parentElement.children, cursor));
      cursor = cursor.parentElement;
    }
    return { index: list.indexOf(el), count: list.length, path: path };
  }

  function requireWritable(el) {
    var result = provenance(el);
    if (!result.writable && HOST && HOST.__editorHost) HOST.__editorHost.onNotice(result.readonlyReason);
    return result.writable;
  }

  function registerSources(map, context) {
    sources = map || {};
    sourceContext = context || null;
    // 重新注册 = 源码变了，丢弃缓存
    var all = document.querySelectorAll('[data-dc-tpl]');
    for (var i = 0; i < all.length; i++) {
      delete all[i].__dcBaseStyle;
      delete all[i].__dcDecls;
      delete all[i].__dcRenderedStyle;
    }
  }

  /** 写回成功后：源码现在就是这一串，把它接成新的基准，不必整页重载。 */
  function acceptCommitted(tid, style, context) {
    if (context) sourceContext = Object.assign({}, sourceContext, context);
    var list = sameSourceInstances(tid);
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
    if (!requireWritable(el)) return;
    var list = sameSourceInstances(tidOf(el));
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
    noSelect.setAttribute('data-dc-editor', 'selection-style');
    noSelect.textContent =
      'html[data-dc-editor-mode="select"] *{user-select:none !important;-webkit-user-select:none !important}' +
      'html[data-dc-editor-mode="text"] [contenteditable]{user-select:text !important;-webkit-user-select:text !important}';
    document.head.appendChild(noSelect);

    marquee = document.createElement('div');
    marquee.style.cssText = 'position:absolute;display:none;border:1px solid #2563eb;background:rgba(37,99,235,.1);pointer-events:none';
    overlay.appendChild(marquee);
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
    var box = selectionRect();
    selBox.style.display = 'block';
    selBox.style.border = '1px solid #2563eb';
    selBox.style.boxShadow = '0 0 0 1px rgba(255,255,255,.9)';
    place(selBox, box);
    handles.forEach(function (h, i) {
      h.style.display = mode === 'select' && selectedElements.length === 1 && provenance(selected).writable ? 'block' : 'none';
      h.style.width = h.style.height = HANDLE_SIZE / viewportScale + 'px';
      h.style.margin = -HANDLE_SIZE / (2 * viewportScale) + 'px 0 0 ' + -HANDLE_SIZE / (2 * viewportScale) + 'px';
      h.style.left = (box.x + (HANDLE_POS[i][0] === 'left' ? 0 : HANDLE_POS[i][0] === 'right' ? box.w : box.w / 2)) + 'px';
      h.style.top = (box.y + (HANDLE_POS[i][1] === 'top' ? 0 : HANDLE_POS[i][1] === 'bottom' ? box.h : box.h / 2)) + 'px';
    });
    var label = overlay.__label;
    label.style.display = 'block';
    label.textContent = (selectedElements.length > 1 ? selectedElements.length + ' 个元素' : selected.tagName.toLowerCase()) + '  ' + Math.round(box.w) + '×' + Math.round(box.h);
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

  function describe(tid, target) {
    var el = target || elOf(tid);
    if (!el) return null;
    var parent = el.parentElement;
    var parentTid = parent ? tidOf(parent) : null;
    var cs = getComputedStyle(el);
    return {
      tid: tid,
      sourceRef: provenance(el).sourceRef,
      writable: provenance(el).writable,
      readonlyReason: provenance(el).readonlyReason,
      instance: instanceOf(el),
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
      editableText: provenance(el).writable && sources[tid]?.editableText === true,
      /** 内容里有没有 {{hole}}：有就不能原地改字 */
      hasHole: sources[tid]?.hasHole === true,
      parentTid: parentTid,
      /** sc-for 展开出来的实例数：改一个 = 改全部 */
      instances: sameSourceInstances(tid).length,
    };
  }

  // ---------- 手势 ----------

  function hitTest(clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    if (!el || el === overlay || (overlay && overlay.contains(el))) return null;
    return tidOf(el);
  }

  function onMouseMove(e) {
    if (regionDrag) {
      regionDrag.endX = e.clientX; regionDrag.endY = e.clientY;
      var rect = normalizedRect(regionDrag.startX, regionDrag.startY, e.clientX, e.clientY);
      marquee.style.display = 'block'; place(marquee, rect); return;
    }
    // 按下之后移动超过阈值才算拖动：不这样的话，要么点一下就会挪动元素，
    // 要么得先点选、再按住拖 —— 后者不是设计工具的习惯
    if (!drag && pending) {
      var dx = e.clientX - pending.startX;
      var dy = e.clientY - pending.startY;
      if (!pending.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      pending.moved = true;
      drag = { kind: 'move', el: pending.el, startX: pending.startX, startY: pending.startY,
               base: pending.base, absolute: pending.absolute, left: pending.left, top: pending.top, group: pending.group };
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
    var hit = e.target?.closest?.('[data-dc-tpl]');
    if ((annotationMode || (e.altKey && !e.ctrlKey && !e.metaKey)) && !isInput(e.target)) {
      e.preventDefault(); e.stopPropagation();
      regionDrag = {startX:e.clientX,startY:e.clientY,endX:e.clientX,endY:e.clientY,annotation:true,target:hit};
      e.target.setPointerCapture?.(e.pointerId); return;
    }
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && (regionMode || ((!hit || hit === root) && !e.target?.hasAttribute?.('data-handle')))) {
      e.preventDefault(); e.stopPropagation();
      regionDrag = {startX:e.clientX,startY:e.clientY,endX:e.clientX,endY:e.clientY};
      e.target.setPointerCapture?.(e.pointerId); return;
    }
    var handleIdx = e.target && e.target.getAttribute && e.target.getAttribute('data-handle');
    if (handleIdx !== null && handleIdx !== undefined && selected && !externalBusy && requireWritable(selected)) {
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
    if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSelection(target); return; }
    if (!selectedElements.includes(target)) select(tid, true, target);
    // 选中之后把拖动挂上，移动超过阈值才真的拖
    var el = elOf(tid);
    if (!requireWritable(el) || externalBusy) return;
    var group = null;
    if (selectedElements.length > 1) {
      try { group = groupMovement(); } catch (error) { HOST?.__editorHost?.onNotice(error.message); return; }
    }
    pending = {
      el: el, startX: e.clientX, startY: e.clientY, base: inlineDecls(el),
      absolute: getComputedStyle(el).position === 'absolute', moved: false,
      css: getComputedStyle(el), group: group,
      left: parseFloat(getComputedStyle(el).left) || 0,
      top: parseFloat(getComputedStyle(el).top) || 0,
    };
    el.setPointerCapture(e.pointerId);
  }

  function onDragMove(e) {
    var dx = Math.round(e.clientX - drag.startX);
    var dy = Math.round(e.clientY - drag.startY);
    var decls = Object.assign({}, drag.base);
    if (drag.group) {
      drag.group.forEach(function (item) {
        var next = Object.assign({}, item.base);
        if (item.absolute) { next.left = Math.round(item.left + dx) + 'px'; next.top = Math.round(item.top + dy) + 'px'; delete next.right; delete next.bottom; }
        else next.transform = 'translate(' + dx + 'px, ' + dy + 'px)' + (item.transform && item.transform !== 'none' ? ' ' + item.transform : '');
        item.decls = next; setPreview(item.el, next);
      });
      drag.moved = true; showSelection(); return;
    }
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
    if (regionDrag) {
      var region = normalizedRect(regionDrag.startX,regionDrag.startY,regionDrag.endX,regionDrag.endY);
      var annotate = regionDrag.annotation, clicked = regionDrag.target;
      regionDrag = null; marquee.style.display = 'none';
      var hits = region.w > 2 || region.h > 2 ? elementsInRegion(region) : [];
      if (annotate && region.w <= 2 && region.h <= 2) hits = clicked && provenance(clicked).writable ? [clicked] : [];
      setSelection(hits, true);
      if (annotate) HOST?.__editorHost?.onAnnotationSelect?.(getSelection());
      if (regionCallback) { var callback = regionCallback; regionCallback = null; regionMode = false; callback(getSelection(), region); }
      return;
    }
    var wasClick = pending !== null && !pending.moved;
    pending = null;
    if (wasClick) return; // 只是点了一下：选中已经在 mousedown 里做完了
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.group && d.moved) {
      var edits = d.group.map(function (item) { return {tid:tidOf(item.el),style:currentStyle(item.el),sourceRef:provenance(item.el).sourceRef}; });
      HOST?.__editorHost?.onBatchCommit?.(edits, 'move');
    } else if (d.decls) {
      // 定稿：用工作声明拼出待写回的样式串（保住没动过的声明的原始写法）
      var style = currentStyle(d.el);
      if (HOST && HOST.__editorHost) HOST.__editorHost.onCommit(tidOf(d.el), style, d.kind, provenance(d.el).sourceRef);
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
        select(Number(p.getAttribute('data-dc-tpl')), true, p);
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

  }

  // ---------- 对外 ----------

  function normalizedRect(x1,y1,x2,y2) { return {x:Math.min(x1,x2),y:Math.min(y1,y2),w:Math.abs(x1-x2),h:Math.abs(y1-y2)}; }
  function getSelection() { return selectedElements.filter(function(el){return el.isConnected;}).map(function(el){return describe(tidOf(el),el);}); }
  function selectionRect() {
    var boxes = selectedElements.filter(function(el){return el.isConnected;}).map(boxOf);
    if (!boxes.length) return {x:0,y:0,w:0,h:0};
    var x = Math.min.apply(null,boxes.map(function(b){return b.x;})), y = Math.min.apply(null,boxes.map(function(b){return b.y;}));
    return {x:x,y:y,w:Math.max.apply(null,boxes.map(function(b){return b.x+b.w;}))-x,h:Math.max.apply(null,boxes.map(function(b){return b.y+b.h;}))-y};
  }
  function setSelection(elements, notify) {
    selectedElements = Array.from(new Set(elements)).filter(function(el){return el && el.isConnected;});
    selected = selectedElements[selectedElements.length-1] || null;
    showSelection();
    if (notify && HOST?.__editorHost) {
      HOST.__editorHost.onSelect(selected ? describe(tidOf(selected),selected) : null);
      HOST.__editorHost.onMultiSelect?.(getSelection());
    }
  }
  function toggleSelection(el) {
    if (!el || !requireWritable(el)) return;
    var next=selectedElements.slice(), at=next.indexOf(el);
    if(at<0) next.push(el); else next.splice(at,1);
    setSelection(next,true);
  }
  function selectMany(refs, notify) {
    if(mode==='text') finishTextEdit();
    var elements=refs.map(function(ref){
      var tid=typeof ref==='number'?ref:ref.tid;
      var list=sameSourceInstances(tid);
      return list[typeof ref==='number'?0:(ref.instance?.index??0)] || null;
    });
    setSelection(elements,notify!==false); return getSelection();
  }
  // Intersection is the fixed hit rule. Avoid selecting enclosing containers as
  // well as their children: retain the deepest intersecting editable nodes.
  function elementsInRegion(rect) {
    var hits=Array.from(document.querySelectorAll('[data-dc-tpl]')).filter(function(el){
      if(!provenance(el).writable) return false;
      var b=boxOf(el); return b.w>0 && b.h>0 && b.x<rect.x+rect.w && b.y<rect.y+rect.h && b.x+b.w>rect.x && b.y+b.h>rect.y;
    });
    return hits.filter(function(el){return !hits.some(function(other){return other!==el && el.contains(other);});});
  }
  function groupMovement() {
    var top=selectedElements.filter(function(el){return !selectedElements.some(function(parent){return parent!==el&&parent.contains(el);});});
    return top.map(function(el){
      if(!provenance(el).writable) throw new Error('选区包含来源不明的元素');
      if(sameSourceInstances(tidOf(el)).length>1) throw new Error('重复模板实例不支持整组拖动；请先使用批量属性');
      for(var parent=el;parent && parent!==root.parentElement;parent=parent.parentElement) {
        var transform=getComputedStyle(parent).transform;
        if(transform && transform!=='none') {
          var matrix=new DOMMatrixReadOnly(transform);
          if(!matrix.is2D || Math.abs(matrix.a-1)>0.0001 || Math.abs(matrix.d-1)>0.0001 || Math.abs(matrix.b)>0.0001 || Math.abs(matrix.c)>0.0001) throw new Error('旋转、缩放或三维变换元素暂不支持整组拖动');
        }
      }
      var css=getComputedStyle(el), base=inlineDecls(el);
      if(/\{\{/.test(base.transform||'')) throw new Error('绑定变换不能直接整组拖动');
      return {el:el,base:base,absolute:css.position==='absolute',left:parseFloat(css.left)||0,top:parseFloat(css.top)||0,transform:base.transform||css.transform};
    });
  }

  function select(tid, notify, target) {
    if (mode === 'text') finishTextEdit();
    var targetEl = tid === null || tid === undefined ? null : target || elOf(tid);
    setSelection(targetEl ? [targetEl] : [], notify);
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
    if (externalBusy) return {ok:false,reason:'正在保存，请稍后改文字'};
    if (selectedElements.length > 1) return { ok:false, reason:'多选时不能原地改文字，请只选一个元素' };
    var d = describe(tidOf(selected));
    if (!d.writable) return { ok: false, reason: d.readonlyReason };
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
    if (text !== el.__dcOriginalText && HOST && HOST.__editorHost) HOST.__editorHost.onTextCommit(tid, text, provenance(el).sourceRef);
    return text;
  }

  function init() {
    root = artboardRoot();
    if (!root) return false;
    buildOverlay();
    // Navigation is captured before editing gestures, including across iframe edges.
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel'].forEach(function (type) {
      listen(document, type, routeNavigation, { capture: true, passive: false });
    });
    listen(document, 'keydown', function (e) {
      if (!navigation || e.isComposing || isInput(e.target) || mode === 'text') return;
      if (e.code === 'Space') { navigation({ type: 'space', down: true }); e.preventDefault(); e.stopImmediatePropagation(); }
      if (e.key === 'Escape') cancelGesture();
    }, true);
    listen(document, 'keyup', function (e) { if (e.code === 'Space') navigation?.({ type: 'space', down: false }); }, true);
    listen(document, 'pointercancel', cancelGesture, true);
    listen(window, 'blur', cancelGesture);
    listen(window, 'pagehide', dispose);
    // 捕获阶段：编辑模式下属画板自己的交互让位给选中
    listen(document, 'pointermove', onMouseMove, true);
    listen(document, 'pointerdown', onMouseDown, true);
    listen(document, 'pointerup', onMouseUp, true);
    listen(document, 'click', function (e) {
      if (mode !== 'browse') { e.preventDefault(); e.stopImmediatePropagation(); return; }
      var a = e.target.closest('a[href]');
      if (!a || !HOST?.__editorHost) return;
      var target = new URL(a.href, location.href);
      if (target.origin === location.origin && target.pathname.startsWith('/board/') && target.pathname.endsWith('.dc.html')) {
        e.preventDefault(); e.stopImmediatePropagation();
        HOST.__editorHost.onNavigate(target.pathname);
      }
    }, true);
    listen(document, 'focusout', function () { if (mode === 'text') finishTextEdit(); }, true);
    listen(window, 'blur', function () { if (mode === 'text') finishTextEdit(); });
    listen(document, 'dblclick', onDoubleClick, true);
    listen(document, 'keydown', onKeyDown, true);
    listen(document, 'mouseleave', function () { showHover(null); }, true);
    listen(window, 'resize', function () { layoutOverlay(); showSelection(); });
    // 画板自己的滚动/动画会让位置漂移，跟着刷新
    layoutTimer = setInterval(function () { layoutOverlay(); showSelection(); }, 600);
    return true;
  }

  window.__designEditor = {
    get ready() { return root !== null; },
    get sourceContext() { return sourceContext ? Object.assign({},sourceContext) : null; },
    describe: describe,
    provenance: provenance,
    dispose: dispose,
    setNavigation: function (handler) { navigation = handler; },
    setViewportScale: function (scale) { viewportScale = Math.max(0.1, Math.min(4, scale || 1)); if (overlay) showSelection(); },
    get isInteracting() { return !!(drag || pending || navigationDrag || regionDrag); },
    setAnnotationMode: function (on) { annotationMode = !!on; },
    resolveInstance: function (ref) {
      var list = sameSourceInstances(ref.tid), item = list[ref.instance?.index ?? 0];
      if (!item || (ref.instance && (list.length !== ref.instance.count || JSON.stringify(instanceOf(item).path) !== JSON.stringify(ref.instance.path)))) return null;
      return item;
    },
    setBusy: function (busy) { externalBusy = !!busy; },
    getSelection: getSelection,
    selectMany: selectMany,
    selectionRect: selectionRect,
    elementsInRegion: function (rect) { return elementsInRegion(rect).map(function (el) { return describe(tidOf(el),el); }); },
    selectRegion: function (rect) { setSelection(elementsInRegion(rect),true); return getSelection(); },
    setRegionMode: function (on, callback) { regionMode = !!on; regionCallback = callback || null; },
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
    updateSourceContext: function (context) { sourceContext = Object.assign({}, sourceContext, context); },
    acceptCommitted: acceptCommitted,
    /** 直接改行内样式（外壳改字段时用），不写文件 */
    preview: function (tid, decls) { var el = elOf(tid); if (el) { setPreview(el, decls); showSelection(); } },
    styleString: function (tid) { var el = elOf(tid); return el ? currentStyle(el) : null; },
  };

  if (!init()) {
    var tries = 0;
    timer = setInterval(function () {
      if (init() || ++tries > 100) clearInterval(timer);
    }, 50);
  }
})();
