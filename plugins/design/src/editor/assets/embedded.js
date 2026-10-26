/** The Design Space bridge is a narrow, scoped lifecycle protocol. */
export function install(editor) {
  const query = new URLSearchParams(location.search),
    params = new URLSearchParams(location.hash.slice(1));
  if (query.get('embedded') !== '1') return;
  document.body.classList.add('embedded');
  const channel = params.get('channel'),
    origin = params.get('hostOrigin');
  let composing = false;
  document.addEventListener('compositionstart', () => (composing = true), true);
  document.addEventListener('compositionend', () => (composing = false), true);
  const intents = new Map();
  const intentKey = (value) => JSON.stringify([value.canvas, value.board, value.tid, typeof value.text==='string'?'text':'style']);
  const publish = () => reply('dsh-design:space-recovery', { items: [...intents.values()] });
  const remember = (value) => {
    if (value?.tid == null || !value.revision) return;
    intents.set(intentKey(value), value);
    publish();
  };
  editor.events.addEventListener('edit-intent', (e) => remember(e.detail));
  editor.events.addEventListener('saved', (e) => {
    const job = e.detail.committedJob;
    if (!job) return;
    const key = intentKey(job),
      current = intents.get(key);
    if (current && current.text === job.text && current.style === job.style) {
      intents.delete(key);
      publish();
    }
  });
  const attach = () => {
    const doc = editor.el.board.contentDocument;
    if (doc && !doc.__spaceIME) {
      doc.__spaceIME = true;
      doc.addEventListener('compositionstart', () => (composing = true), true);
      doc.addEventListener('compositionend', () => (composing = false), true);
      doc.addEventListener(
        'input',
        (event) => {
          const node = event.target.closest?.('[contenteditable="true"]');
          if (!node) return;
          const info = editor.features.selection?.getSelection()?.[0];
          if (info?.sourceRef)
            remember({ ...info.sourceRef, text: node.textContent, sourceRef: info.sourceRef });
        },
        true
      );
    }
  };
  editor.events.addEventListener('bridge-ready', attach);
  const reply = (type, extra) => window.parent.postMessage({ type, channel, ...extra }, origin);
  const snapshot = () => ({
    board: editor.state.board,
    revision: editor.state.revision,
    selection: editor.features.selection?.getSelection(),
    annotations: editor.features.annotations?.snapshot(),
    viewport: editor.features.viewport?.view,
  });
  let viewTimer;
  const rememberView = () => {
    if (!sent) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      if (editor.state.board) reply('dsh-design:space-state', { view: snapshot() });
    }, 40);
  };
  for (const name of ['annotations-changed', 'multiselection', 'viewport', 'saved'])
    editor.events.addEventListener(name, rememberView);
  window.addEventListener('pagehide', () => clearTimeout(viewTimer));
  window.addEventListener('message', async (event) => {
    const d = event.data;
    if (
      event.source !== window.parent ||
      event.origin !== origin ||
      !channel ||
      d?.channel !== channel ||
      d.type !== 'dsh-design:space'
    )
      return;
    try {
      if (d.action === 'prepare') {
        if (composing) throw new Error('请先完成输入法输入，再切换设计稿');
        await editor.beforeAction();
        reply('dsh-design:space-result', { requestId: d.requestId, ok: true, view: snapshot() });
      } else if (d.action === 'restore' && d.view) {
        if (d.view.board && editor.state.board !== d.view.board)
          await editor.loadBoard(editor.state.canvas, d.view.board);
        editor.features.annotations?.restore(d.view.annotations);
        editor.features.viewport?.restore(d.view.viewport);
        if (d.view.revision === editor.state.revision && d.view.selection)
          editor.features.selection?.selectMany(d.view.selection);
      } else if (d.action === 'recovery' && Array.isArray(d.items) && d.items.length) {
        const recovered = d.items.filter(
          (item) =>
            item.canvas === editor.state.canvas &&
            (typeof item.tid === 'string' || Number.isInteger(item.tid))
        );
        if (!recovered.length) return;
        const banner = document.createElement('section');
        banner.setAttribute('role', 'alert');
        banner.style.cssText =
          'padding:8px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap';
        const label = document.createElement('span');
        label.textContent = '上次离开时有未确认保存的输入。核对后可恢复；版本冲突时不会覆盖文件。';
        banner.append(label);
        const control = (label, fn) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.onclick = fn;
          banner.append(b);
        };
        control('查看并复制输入', () => {
          const dialog = document.createElement('dialog'),
            text = document.createElement('textarea'),
            close = document.createElement('button');
          text.value = JSON.stringify(recovered, null, 2);
          text.style.cssText = 'width:70vw;height:50vh';
          close.textContent = '关闭';
          close.onclick = () => dialog.remove();
          dialog.append(text, close);
          document.body.append(dialog);
          dialog.showModal();
          text.select();
        });
        control('按原版本恢复', async () => {
          try {
            await editor.beforeAction();
            const revisions = new Map();
            for (const item of recovered) {
              const key = JSON.stringify([item.canvas, item.board]),
                revision = revisions.get(key) || item.revision;
              const out = await editor.post('/api/edit', {
                canvas: item.canvas,
                board: item.board,
                tid: item.tid,
                text: item.text,
                style: item.style,
                revision,
                sourceRef: item.sourceRef ? { ...item.sourceRef, revision } : undefined,
              });
              revisions.set(key, out.revision);
            }
            intents.clear();
            publish();
            await editor.reloadBoard(true);
            banner.remove();
          } catch (error) {
            editor.toast('恢复未完成：' + error.message, true);
          }
        });
        control('已核对，清除记录', () => {
          intents.clear();
          publish();
          banner.remove();
        });
        document.body.prepend(banner);
        for (const item of recovered) intents.set(intentKey(item), item);
      } else if (d.action === 'theme') {
        document.documentElement.style.colorScheme = d.dark ? 'dark' : 'light';
        const colors = d.dark
          ? {
              bg: '#181a20',
              panel: '#20232a',
              ink: '#e7e9ed',
              dim: '#aeb5c0',
              stage: '#15171c',
              line: '#3a3e48',
            }
          : {
              bg: '#ebeef2',
              panel: '#ffffff',
              ink: '#0f1115',
              dim: '#61666b',
              stage: '#e4e8ef',
              line: '#e1e5ee',
            };
        for (const [name, value] of Object.entries(colors))
          document.documentElement.style.setProperty('--' + name, value);
        if (d.colors?.text?.trim()) document.documentElement.style.setProperty('--ink', d.colors.text);
      }
    } catch (e) {
      if (d.requestId)
        reply('dsh-design:space-result', { requestId: d.requestId, ok: false, error: e.message });
    }
  });
  let sent = false;
  editor.events.addEventListener('bridge-ready', () => {
    if (!sent) {
      sent = true;
      reply('dsh-design:space-ready', {});
    }
  });
}
