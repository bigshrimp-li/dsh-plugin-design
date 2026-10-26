/** Design-level undo and redo; text editors retain their own native history. */
export function historyShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const target = event.target;
  if (target?.isContentEditable || target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return null;
  const key = String(event.key).toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !event.shiftKey) return 'redo';
  return null;
}

export function install(editor) {
  if (editor.features.history) return editor.features.history;
  let busy = false;
  let disposed = false;
  let undoLabel = '';
  let redoLabel = '';
  const undo = editor.el.undo;
  const redo = editor.addButton('redo', '重做', () => run('redo'), '重做上一次撤销（Ctrl/Cmd+Shift+Z 或 Ctrl/Cmd+Y）');
  // Keep the two history controls together in the native panel toolbar.
  undo.insertAdjacentElement?.('afterend', redo);
  redo.setAttribute('aria-keyshortcuts', 'Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y');
  undo.setAttribute('aria-keyshortcuts', 'Control+Z Meta+Z');
  function refresh(event) {
    const out = event?.detail;
    if (out) {
      undoLabel = out.history?.undoLabel ?? out.undoLabel ?? '';
      redoLabel = out.history?.redoLabel ?? out.redoLabel ?? '';
    }
    undo.disabled = busy || !editor.state.canvas || !editor.state.canUndo;
    redo.disabled = busy || !editor.state.canvas || !editor.state.canRedo;
    undo.title = undoLabel ? `撤销：${undoLabel}` : '撤销上一次设计稿操作（Ctrl/Cmd+Z）';
    redo.title = redoLabel ? `重做：${redoLabel}` : '重做上一次撤销（Ctrl/Cmd+Shift+Z 或 Ctrl/Cmd+Y）';
    undo.setAttribute('aria-busy', String(busy));
    redo.setAttribute('aria-busy', String(busy));
  }
  async function run(kind) {
    if (disposed || busy || !editor.state.canvas) return;
    busy = true;
    refresh();
    try {
      // historyAction must finish text edits and await beforeAction first. Its
      // rejection on a failed pending save prevents jumping over that failure.
      await editor.historyAction(kind);
    } catch (error) {
      editor.toast(error.message || String(error), true);
    } finally { busy = false; if (!disposed) refresh(); }
  }
  function onUndo(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void run('undo');
  }
  undo.addEventListener('click', onUndo, true);
  const unregister = editor.registerShortcut(event => {
    const kind = historyShortcut(event);
    if (!kind || !editor.state.canvas) return false;
    if (!event.repeat) void run(kind);
    return true;
  });
  editor.events.addEventListener('history', refresh);
  editor.events.addEventListener('board', refresh);
  refresh();
  const feature = {
    run, refresh,
    dispose() {
      disposed = true;
      unregister();
      undo.removeEventListener('click', onUndo, true);
      editor.events.removeEventListener('history', refresh);
      editor.events.removeEventListener('board', refresh);
      redo.remove();
      if (editor.features.history === feature) delete editor.features.history;
    },
  };
  editor.features.history = feature;
  return feature;
}
