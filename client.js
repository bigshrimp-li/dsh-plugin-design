/** Session-scoped adapter for the public Harness draft API. Never submits a message. */
function setupComposerBridge({ frame, sessionId, url, channel, inputActions, targetWindow = window }) {
  const origin = new URL(url).origin;
  const captures = new Map();
  const receive = event => {
    const data = event.data;
    if (event.source !== frame.current?.contentWindow || event.origin !== origin || !data ||
        data.type !== 'dsh-design:composer' || data.sessionId !== sessionId || data.channel !== channel ||
        typeof data.requestId !== 'string' || data.requestId.length > 100) return;
    const reply = result => event.source.postMessage({ type:'dsh-design:composer-result', requestId:data.requestId, sessionId, channel, ...result }, origin);
    try {
      if (!inputActions?.captureInsertion || !inputActions?.insertText) throw new Error('当前 Harness 没有提供草稿接口，请复制标注后手动粘贴');
      if (data.action === 'capture') {
        const span = inputActions.captureInsertion();
        if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)) throw new Error('草稿暂时不可编辑，请稍后重试');
        const token = crypto.randomUUID();
        captures.set(token, { span:{...span,start:span.end}, at:Date.now() });
        while(captures.size>10) captures.delete(captures.keys().next().value);
        reply({ok:true,token});
      } else if (data.action === 'insert') {
        const entry = captures.get(data.token); captures.delete(data.token);
        if (!entry || Date.now()-entry.at>30000) throw new Error('插入位置已失效，请重新点击插入草稿');
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length>200000) throw new Error('标注内容为空或过长');
        if (!inputActions.insertText(data.text,entry.span)) throw new Error('草稿已变化或暂时不可编辑，请重试；标注仍保留');
        reply({ok:true});
      } else reply({ok:false,error:'不支持的草稿操作'});
    } catch(error) { reply({ok:false,error:error.message || '草稿插入失败'}); }
  };
  targetWindow.addEventListener('message',receive);
  return () => { captures.clear(); targetWindow.removeEventListener('message',receive); };
}

/** Design Space owns navigation; the host continues to own conversations and input roots. */
function installDesignSpace(React, ctx, createPortal, IconProjectAddOutlineRegular) {
  const h = React.createElement,
    ID = '@local/dsh-plugin-design/space',
    SESSION = 'design.space.session',
    KEY = 'dsh.design-space.view.v1';
  const persisted = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      return v?.version === 1 && Array.isArray(v.tabs) ? v : {};
    } catch {
      return {};
    }
  };
  const saved = persisted();
  let state = {
    directories: [],
    tabs: saved.tabs || [],
    active: saved.active || null,
    ratio: Math.min(0.75, Math.max(0.35, saved.sidebarRatio || 0.64)),
    error: '',
    busy: false,
    newForm: false,
    loaded: false,
    workspaceCollapsed: saved.workspaceCollapsed === true,
    designCollapsed: saved.designCollapsed === true,
  };
  const listeners = new Set(),
    references = new Map(),
    frameStates = new Map();
  const RECOVERY = KEY + '.recovery';
  let recoveries = {};
  try {
    recoveries = JSON.parse(localStorage.getItem(RECOVERY)) || {};
  } catch {}
  let activeFrame = null,
    sequence = 0,
    disposed = false;
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          version: 1,
          tabs: state.tabs.map(
            ({
              id,
              rel,
              identity,
              title,
              sessionId,
              sessionIds,
              linkPending,
              initialText,
              pendingDescription,
            }) => ({
              id,
              rel,
              identity,
              title,
              sessionId,
              sessionIds,
              linkPending,
              initialText,
              pendingDescription,
              initialSend: false,
            }),
          ),
          active: state.active,
          sidebarRatio: state.ratio,
          workspaceCollapsed: state.workspaceCollapsed,
          designCollapsed: state.designCollapsed,
        }),
      );
    } catch {
      /* memory state remains usable */
    }
  };
  const api = async (action, body = {}) => {
    const base = new URL(document.baseURI);
    base.search = '';
    base.hash = '';
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const response = await fetch(new URL('design-space/api', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(
        'Design 空间服务未就绪。请在插件页停用后重新启用设计插件；若仍失败，请重启 Harness。',
      );
    }
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  };
  const subscribeWorkspaces = (fn) => ctx.workspaces.list.subscribe(fn);
  const readWorkspaces = () => ctx.workspaces.list.getSnapshot();
  const subscribeSessions = (fn) => ctx.sessions.list.subscribe(fn);
  const readSessions = () => ctx.sessions.list.getSnapshot();
  const workspaces = () => ctx.workspaces.list.getSnapshot().items || [];
  const sessions = () => ctx.sessions.list.getSnapshot();
  const ownerFor = (directory) =>
    workspaces()
      .filter((w) => directory === w.path || directory.startsWith(w.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0];
  const refresh = async () => {
    const result = await api('list');
    if (!disposed) set({ directories: result.directories, loaded: true });
  };
  const run = async (fn) => {
    if (state.busy) return;
    set({ busy: true, error: '' });
    try {
      await fn();
    } catch (e) {
      set({ error: e.message });
    } finally {
      set({ busy: false });
    }
  };
  const reveal = () => ctx.layout.selectPanel(ID);
  const frameRequest = async (action, extra = {}) => {
    const current = activeFrame;
    if (!current) return {};
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', receive);
        reject(new Error('编辑器尚未完成保存，请等待后再切换'));
      }, 8000);
      const receive = (event) => {
        if (
          event.source !== current.element.contentWindow ||
          event.origin !== current.origin ||
          event.data?.type !== 'dsh-design:space-result' ||
          event.data.channel !== current.channel ||
          event.data.requestId !== requestId
        )
          return;
        clearTimeout(timer);
        window.removeEventListener('message', receive);
        event.data.ok
          ? resolve(event.data)
          : reject(new Error(event.data.error || '编辑器操作失败'));
      };
      window.addEventListener('message', receive);
      current.element.contentWindow.postMessage(
        { type: 'dsh-design:space', channel: current.channel, requestId, action, ...extra },
        current.origin,
      );
    });
  };
  const prepare = async () => {
    if (activeFrame) {
      const result = await frameRequest('prepare');
      frameStates.set(state.active, result.view);
    }
  };
  const open = async (id, rel = '.') => {
    await prepare();
    const seq = ++sequence;
    const info = await api('open', { id, rel });
    if (seq !== sequence) return;
    const existing = state.tabs.find((t) => t.identity === info.identity);
    if (!existing && state.tabs.length >= 30)
      throw new Error('最多打开30份设计稿，请先关闭不用的页签');
    const tab = { ...existing, ...info, id, rel };
    if (existing?.sessionId && info.sessionIds?.includes(existing.sessionId))
      tab.sessionId = existing.sessionId;
    if (existing?.linkPending) {
      tab.sessionIds = existing.sessionIds;
      tab.sessionId = existing.sessionId;
      tab.linkPending = true;
    }
    set({
      tabs: existing
        ? state.tabs.map((t) => (t.identity === tab.identity ? tab : t))
        : [...state.tabs, tab],
      active: tab.identity,
      newForm: false,
      browse: null,
    });
    reveal();
  };
  const activate = async (tab) => {
    if (tab.identity === state.active) {
      reveal();
      return;
    }
    await open(tab.id, tab.rel);
  };
  const close = async (tab) => {
    await prepare();
    const index = state.tabs.indexOf(tab),
      tabs = state.tabs.filter((t) => t.identity !== tab.identity);
    for (const [key, ref] of references) {
      if (key.startsWith(tab.identity + ':')) {
        ref.release();
        references.delete(key);
      }
    }
    frameStates.delete(tab.identity);
    set({
      tabs,
      active:
        state.active === tab.identity
          ? tabs[Math.min(index, tabs.length - 1)]?.identity || null
          : state.active,
    });
  };
  const addDirectory = async () => {
    const entries = ctx.slots.entriesOfSlot('sidebar.workspaces.directoryFlow');
    if (!entries.length) throw new Error('Harness 未安装目录选择器，暂时无法添加目录');
    const native = globalThis.__DSH_DIRECTORY_PICKER__;
    if (native) {
      const selected = await native.pick();
      if (selected) await acceptDirectory(selected);
      return;
    }
    const listing = await ctx.uiWorkspace.listDirectory(workspaces()[0]?.path);
    set({ picker: listing });
    reveal();
  };
  const acceptDirectory = async (selected) => {
    if (!selected) return;
    const directory = typeof selected === 'string' ? selected : selected.path;
    if (!directory) throw new Error('目录选择器没有返回路径');
    const owner = ownerFor(directory);
    const entry = await api('register', { path: directory, workspace: owner?.path });
    await refresh();
    await selectDirectory(entry);
  };
  const selectDirectory = async (entry) => {
    await prepare();
    const info = await api('describe', { id: entry.id });
    if (info.status === 'ready') return open(entry.id);
    const found = await api('discover', { id: entry.id });
    set({ browse: { entry, items: found.items, truncated: found.truncated }, newForm: false });
    reveal();
  };
  const link = async (tab, choice) => {
    await prepare();
    const info = await api('open', { id: tab.id, rel: tab.rel });
    if (info.linkError) throw new Error(info.linkError);
    let sid = choice;
    if (choice === 'new') {
      if (tab.sessionId && !Array.isArray(info.sessionIds))
        throw new Error('请重启 Harness 加载多会话服务后再添加对话');
      const owner = workspaces().find((w) => w.path === info.directory.workspace);
      if (!owner) throw new Error('请先在 Harness 添加此工作区，再创建对话。设计稿可以继续编辑');
      sid = await ctx.sessions.create({ workspaceId: owner.workspaceId });
    }
    const sessionIds = [
      ...new Set([
        ...(info.sessionIds || []),
        ...(tab.sessionIds || []),
        ...(tab.sessionId ? [tab.sessionId] : []),
        sid,
      ]),
    ];
    // Keep the selected/created session visible even when persisting its link fails; retry never creates another session.
    set({
      tabs: state.tabs.map((t) =>
        t.identity === tab.identity ? { ...t, sessionId: sid, sessionIds, linkPending: true } : t,
      ),
    });
    const bound = await api('bind', {
      id: tab.id,
      rel: tab.rel,
      sessionId: sid,
      expectedRevision: info.linkRevision,
    });
    set({
      tabs: state.tabs.map((t) =>
        t.identity === tab.identity
          ? {
              ...t,
              sessionId: sid,
              sessionIds: bound.sessions?.[info.canvas] || sessionIds,
              linkPending: false,
            }
          : t,
      ),
    });
    await refresh();
  };
  const visibleSessions = (tab) =>
    [...new Set([...(tab.sessionIds || []), ...(tab.sessionId ? [tab.sessionId] : [])])].filter(
      (sid) => !readWorkspaces().archivedSessionIds?.includes(sid),
    );
  const archiveConversation = async (sid) => {
    await prepare();
    try {
      await ctx.uiWorkspace.archiveSession(sid);
      // The host clears its main panel when archiving its selected session. Keep this design open.
      reveal();
    } catch (error) {
      throw new Error(
        '关闭会话失败：' +
          (error.message || '请重试') +
          '。若任务仍在运行，请在工作区侧栏归档并确认停止任务。',
      );
    }
  };
  const style = document.createElement('style');
  style.textContent = `
.ds-space{height:100%;min-height:0;display:flex;flex-direction:column;padding-top:var(--dsh-frame-top-clearance,0px);box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:13px system-ui,sans-serif;--dss-line:var(--dsw-alias-border-l3,#e1e5ee);--dss-muted:var(--dsw-alias-label-secondary,#61666b);--dss-card:var(--dsw-alias-bg-layer-1,#f5f6f7)}
.ds-space button,.ds-space select,.ds-directory button{font:inherit;cursor:pointer}.ds-space button:disabled,.ds-directory button:disabled{opacity:.5;cursor:default}.ds-btn{min-height:32px;border:1px solid var(--dss-line,#dce0e5);border-radius:7px;padding:5px 10px;background:transparent;color:inherit}.ds-btn:hover{background:var(--dsw-alias-bg-hover,#edf3fe)}.ds-btn.primary{background:#0f1115;color:#fff;border-color:transparent}.ds-bar{flex:none;min-height:44px;display:flex;align-items:center;gap:6px;padding:4px 12px;border-bottom:1px solid var(--dss-line);overflow:auto}.ds-tab{display:flex;align-items:center;flex:none;border-radius:7px}.ds-tab[aria-selected=true]{background:var(--dsw-alias-bg-selected,#e9ecf2)}.ds-tab button{border:0;background:none;color:inherit;min-height:32px;min-width:28px;padding:4px 8px}.ds-tab-title{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ds-spacer{flex:1}.ds-error{padding:8px 12px;background:#fff3e0;color:#754000;border-bottom:1px solid #efcf9b;white-space:pre-wrap;display:flex;gap:8px;flex:none}.ds-stage{flex:1;min-height:0;min-width:0;display:flex;flex-direction:row;overflow:hidden}.ds-editor{min-height:0;min-width:0;position:relative;flex-shrink:1;overflow:hidden}.ds-editor iframe{width:100%;height:100%;border:0;display:block}.ds-divider{width:8px;min-width:8px;flex:none;border:0;background:var(--dss-card);cursor:col-resize;touch-action:none;position:relative}.ds-divider:after{content:'';position:absolute;width:2px;height:40px;left:3px;top:calc(50% - 20px);background:#adb2b8}.ds-chat{flex:1;min-width:280px;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid var(--dss-line);background:var(--dsw-alias-bg-base,#fff)}.ds-chat-head{padding:4px 8px;min-height:36px;display:flex;align-items:center;gap:4px;flex:none;border-bottom:1px solid var(--dss-line);min-width:0}.ds-chat-head .ds-chip{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ds-session-tabs{display:flex;gap:4px;flex:0 1 auto;min-width:0;overflow-x:auto}.ds-session-tabs:empty{display:none}.ds-new-session[aria-current=page]{background:var(--dsw-alias-bg-selected,#e9ecf2)}.ds-session-tab{max-width:180px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ds-session-tab[aria-selected=true]{background:var(--dsw-alias-bg-selected,#e9ecf2);border-color:var(--dsw-alias-state-business-primary,#4176e6)}.ds-chip{background:#edf3fe;color:#315fbe;border-radius:12px;padding:2px 8px;font-size:12px}.ds-conversation{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}.ds-conversation>[data-conversation-content]{flex:1;min-height:0}
.ds-conversation [data-conversation-scroll]{display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto}
.ds-conversation [data-composer-seat]{margin-top:auto;flex-shrink:0}
.ds-chat-area{display:flex;flex-direction:column;flex:1;min-width:280px;min-height:0;overflow:hidden}
.ds-chat-area>.ds-chat,.ds-chat-area>.ds-stage{flex:1;min-height:0}
.ds-chat-area[data-split=true]>.ds-stage{border-top:1px solid var(--dss-line)}
.ds-session-item{display:flex;align-items:center;flex:none;min-width:0}
.ds-session-close{opacity:0}.ds-session-item:hover .ds-session-close,.ds-session-item:focus-within .ds-session-close{opacity:1}
.ds-panel-actions{display:flex;align-items:center;gap:4px;flex:none;margin-left:auto}
.ds-icon-button{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dss-muted);cursor:pointer}
.ds-icon-button:hover,.ds-icon-button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#edf3fe);color:inherit}
.ds-icon-button:focus-visible{outline:2px solid #4176e6;outline-offset:-2px}.ds-empty{flex:1;min-height:0;overflow:auto;padding:clamp(24px,5vw,64px);display:flex;flex-direction:column;gap:16px}.ds-empty h1{font-size:24px;margin:0}.ds-muted{color:var(--dss-muted);font-size:12px}.ds-list{border:1px solid var(--dss-line);border-radius:10px;max-width:900px;overflow:hidden}.ds-list>button{display:flex;width:100%;align-items:center;gap:12px;padding:14px;text-align:left;border:0;border-bottom:1px solid var(--dss-line);background:transparent;color:inherit}.ds-list>button:hover{background:var(--dss-card)}.ds-thumb{width:60px;height:42px;object-fit:contain;background:var(--dss-card);border-radius:4px}.ds-form-wrap{flex:1;min-height:0;overflow:auto;padding:24px;background:var(--dss-card)}.ds-form{max-width:680px;margin:auto;border:1px solid var(--dss-line);border-radius:12px;background:var(--dsw-alias-bg-base,#fff)}.ds-form h2{margin:0}.ds-form-body{padding:24px;display:grid;gap:14px}.ds-form label{display:grid;gap:6px}.ds-form input,.ds-form textarea,.ds-form select,.ds-chat select{width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--dss-line);border-radius:7px;color:inherit;background:transparent;font:inherit}.ds-presets{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.ds-presets button{min-height:78px;text-align:left}.ds-presets button[aria-pressed=true]{background:#edf3fe;border-color:#4176e6;color:#244d9f}.ds-form-footer{position:sticky;bottom:0;padding:14px 24px;border-top:1px solid var(--dss-line);background:var(--dsw-alias-bg-base,#fff);display:flex;gap:10px;justify-content:flex-end}.ds-directory{width:100%;min-width:0;padding:6px 8px;box-sizing:border-box;font:13px system-ui;color:var(--dsw-alias-label-primary,#0f1115)}.ds-directory header{display:flex;align-items:center;justify-content:space-between;padding:4px 6px;color:var(--dsw-alias-label-secondary,#61666b)}.ds-directory-list{max-height:min(28vh,260px);overflow:auto}.ds-directory-row{display:flex;align-items:center;border-radius:6px}.ds-directory-row[data-active=true]{background:var(--dsw-alias-bg-selected,#e9ecf2)}.ds-directory-row>button{border:0;background:none;color:inherit;text-align:left;padding:7px 6px;min-width:28px}.ds-directory-open{flex:1;min-width:0;display:flex;gap:6px;align-items:center}.ds-directory-open span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.ds-directory-status{color:var(--dsw-alias-label-secondary,#61666b);font-size:11px;white-space:nowrap}.ds-directory-menu{padding:6px;display:flex;flex-wrap:wrap;gap:4px}.ds-directory-add-icon{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;border:0;border-radius:var(--dsw-radius-sm,5px);background:transparent;color:var(--dsw-alias-label-secondary,#61666b)}.ds-directory-add-icon:hover{background:var(--dsw-alias-interactive-bg-hover,#edf3fe)}.ds-directory-add-icon:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4176e6);outline-offset:-2px}.ds-picker-fallback{padding:20px;border:1px solid var(--dss-line)}
.ds-section-toggle{display:flex;align-items:center;gap:6px;min-height:32px;padding:4px 2px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}.ds-section-toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4176e6);outline-offset:1px;border-radius:5px}.ds-section-toggle:hover{color:var(--dsw-alias-label-primary,#0f1115)}.ds-section-chevron{width:12px;display:inline-flex;justify-content:center}.ds-directory header{min-height:36px;padding:0 6px}.ds-directory header>.ds-section-toggle{flex:1}.ds-directory [hidden]{display:none!important}
[data-ds-sidebar-sections] [data-ds-workspace-region]{flex:0 1 auto;max-height:52%;min-height:38px;overflow:hidden}
[data-ds-sidebar-sections] [data-ds-workspace-root]{flex:0 1 auto;min-height:0}
[data-ds-sidebar-sections] [data-ds-workspace-list]{flex:0 1 auto;min-height:0;overflow:auto}
[data-ds-sidebar-sections] [data-ds-workspace-list]>div{flex:0 1 auto}
[data-ds-sidebar-sections] [data-ds-workspace-label]{display:none}
[data-ds-sidebar-sections] [data-ds-workspace-toggle]{flex:none;order:-1;margin-right:auto}
[data-ds-sidebar-sections] [data-ds-workspace-root][data-ds-collapsed=true]>[data-ds-workspace-list]{display:none}
[data-ds-sidebar-sections] [data-ds-sidebar-foot]{flex:1;min-height:0}
[data-ds-sidebar-sections] [data-ds-sidebar-actions]{flex:0 1 auto;min-height:0;overflow:auto}
[data-ds-sidebar-sections] [data-ds-sidebar-settings]{margin-top:auto;flex:none}
@media(max-height:700px){.ds-chat,.ds-editor{min-height:0}.ds-form-wrap{padding:10px}}@media(max-width:800px){.ds-presets{grid-template-columns:repeat(2,1fr)}.ds-form-body{padding:16px}.ds-tab-title{max-width:130px}}`;
  document.head.appendChild(style);
  ctx.effect(() => () => style.remove());
  const useState = () =>
    React.useSyncExternalStore(
      subscribe,
      () => state,
      () => state,
    );
  const button = (text, onClick, props = {}) =>
    h('button', { type: 'button', className: 'ds-btn', onClick, ...props }, text);
  const errorView = (s) =>
    s.error &&
    h(
      'div',
      { className: 'ds-error', role: 'alert' },
      h('span', {}, s.error),
      button('关闭', () => set({ error: '' })),
    );
  // Host 0.2 exposes no workspace-header slot. Adapt only the verified shell shape;
  // leave host nodes mounted, and restore every marker/portal on plugin disposal.
  function useWorkspaceSection(anchor, wide, collapsed) {
    const [target, setTarget] = React.useState(null);
    React.useLayoutEffect(() => {
      if (!wide || !createPortal) return;
      let current = null;
      const detach = () => {
        if (!current) return;
        current.mount.remove();
        for (const [node, name] of current.markers) node.removeAttribute(name);
        current.root.removeAttribute('data-ds-collapsed');
        current.header.removeEventListener('focusin', current.expand);
        current = null;
      };
      const attach = () => {
        if (current?.mount.isConnected) return;
        detach();
        let shell = anchor.current?.parentElement;
        while (shell && !shell.querySelector(':scope > [class*="_regionArea"]'))
          shell = shell.parentElement;
        const region = shell?.querySelector(':scope > [class*="_regionArea"]');
        const header = region?.querySelector('[class*="_sectionHeader"]');
        const root = header?.parentElement;
        const list = root?.querySelector(':scope > [class*="_listArea"]');
        const label = header?.querySelector('[class*="_sectionLabel"]');
        const foot = shell?.querySelector(':scope > [class*="_footArea"]');
        const actions = foot?.querySelector(':scope > [class*="_footerActions"]');
        const settings = foot?.querySelector(':scope > [class*="_settingsArea"]');
        if (!list || !label || !actions || !settings) {
          setTarget(null);
          return;
        }
        const markers = [
          [shell, 'data-ds-sidebar-sections'],
          [region, 'data-ds-workspace-region'],
          [root, 'data-ds-workspace-root'],
          [list, 'data-ds-workspace-list'],
          [label, 'data-ds-workspace-label'],
          [foot, 'data-ds-sidebar-foot'],
          [actions, 'data-ds-sidebar-actions'],
          [settings, 'data-ds-sidebar-settings'],
        ];
        for (const [node, name] of markers) node.setAttribute(name, '');
        const mount = document.createElement('span');
        mount.setAttribute('data-ds-workspace-toggle', '');
        header.prepend(mount);
        const expand = (event) => {
          if (!mount.contains(event.target) && state.workspaceCollapsed)
            set({ workspaceCollapsed: false });
        };
        header.addEventListener('focusin', expand);
        current = { root, header, mount, markers, expand };
        root.setAttribute('data-ds-collapsed', String(state.workspaceCollapsed));
        setTarget(current);
      };
      attach();
      const observer = new MutationObserver(attach);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        detach();
      };
    }, [wide]);
    React.useLayoutEffect(() => {
      target?.root.setAttribute('data-ds-collapsed', String(collapsed));
    }, [target, collapsed]);
    return wide && target?.mount.isConnected
      ? createPortal(
          button(
            h(
              React.Fragment,
              {},
              h(
                'span',
                { className: 'ds-section-chevron', 'aria-hidden': true },
                collapsed ? '▸' : '▾',
              ),
              '工作区',
            ),
            () => set({ workspaceCollapsed: !state.workspaceCollapsed }),
            {
              className: 'ds-section-toggle',
              'aria-label': collapsed ? '展开工作区' : '收起工作区',
              'aria-expanded': !collapsed,
            },
          ),
          target.mount,
        )
      : null;
  }
  function DirectorySection({ wide = true }) {
    const s = useState(),
      [menu, setMenu] = React.useState(null),
      [label, setLabel] = React.useState('');
    const anchor = React.useRef(null);
    const workspaceToggle = useWorkspaceSection(anchor, wide, s.workspaceCollapsed);
    React.useEffect(() => {
      if (!state.loaded) refresh().catch((e) => set({ error: e.message }));
      const timer = setInterval(() => {
        if (!document.hidden) refresh().catch(() => {});
      }, 10000);
      return () => clearInterval(timer);
    }, []);
    if (!wide) return button('设计', reveal, { 'aria-label': '打开设计空间' });
    return h(
      'section',
      { ref: anchor, className: 'ds-directory', 'aria-label': '设计区' },
      workspaceToggle,
      h(
        'header',
        {},
        button(
          h(
            React.Fragment,
            {},
            h(
              'span',
              { className: 'ds-section-chevron', 'aria-hidden': true },
              s.designCollapsed ? '▸' : '▾',
            ),
            '设计区',
          ),
          () => set({ designCollapsed: !s.designCollapsed }),
          {
            className: 'ds-section-toggle',
            'aria-label': s.designCollapsed ? '展开设计区' : '收起设计区',
            'aria-expanded': !s.designCollapsed,
          },
        ),
        button(h(IconProjectAddOutlineRegular, { size: 16 }), () => run(addDirectory), {
          className: 'ds-directory-add-icon',
          'aria-label': '添加设计目录',
          title: '添加设计目录',
          disabled: s.busy,
        }),
      ),
      h(
        'div',
        { className: 'ds-directory-list', hidden: s.designCollapsed },
        ...s.directories.map((d) =>
          h(
            'div',
            { key: d.id },
            h(
              'div',
              {
                className: 'ds-directory-row',
                'data-active': s.tabs.find((t) => t.identity === s.active)?.id === d.id,
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ds-directory-open',
                  title: d.path,
                  onClick: () => run(() => selectDirectory(d)),
                },
                h('span', {}, d.label),
                h(
                  'span',
                  { className: 'ds-directory-status' },
                  d.info?.status === 'ready'
                    ? `${d.info.count} 张`
                    : d.info?.status === 'empty'
                      ? '还没画'
                      : d.info?.status === 'container'
                        ? '待选择'
                        : d.info?.status === 'invalid'
                          ? '需要修复'
                          : '不可访问',
                ),
              ),
              button(
                '⋯',
                () => {
                  setMenu(menu === d.id ? null : d.id);
                  setLabel(d.label);
                },
                { 'aria-label': `管理 ${d.label}` },
              ),
            ),
            menu === d.id &&
              h(
                'div',
                { className: 'ds-directory-menu' },
                h('input', {
                  'aria-label': '目录显示名称',
                  value: label,
                  onChange: (e) => setLabel(e.target.value),
                  style: { width: '100%' },
                }),
                button('保存名称', () =>
                  run(async () => {
                    await api('rename', { id: d.id, label });
                    await refresh();
                    setMenu(null);
                  }),
                ),
                button('移除入口', () =>
                  run(async () => {
                    await api('remove', { id: d.id });
                    await refresh();
                    setMenu(null);
                  }),
                ),
                button('在访达中显示', () => run(() => api('reveal', { id: d.id }))),
              ),
          ),
        ),
      ),
    );
  }
  function EditorFrame({ tab, inputActions }) {
    const ref = React.useRef(null),
      channel = React.useRef(crypto.randomUUID());
    const [url, setURL] = React.useState(null),
      [canvas, setCanvas] = React.useState(null),
      [error, setError] = React.useState('');
    React.useEffect(() => {
      let alive = true;
      api('open', { id: tab.id, rel: tab.rel })
        .then((info) => {
          if (alive) {
            setCanvas(info.canvas);
            setURL(info.url);
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
      return () => {
        alive = false;
      };
    }, [tab.identity]);
    React.useEffect(() => {
      if (!url || !ref.current) return;
      const target = {
        element: ref.current,
        origin: new URL(url).origin,
        channel: channel.current,
      };
      activeFrame = target;
      const cleanup = setupComposerBridge({
        frame: ref,
        sessionId: tab.sessionId || '',
        url,
        channel: channel.current,
        inputActions,
      });
      const sendTheme = () => {
        const css = getComputedStyle(document.body);
        ref.current?.contentWindow?.postMessage(
          {
            type: 'dsh-design:space',
            channel: channel.current,
            action: 'theme',
            dark: !!document.querySelector('[data-ds-dark-theme]'),
            colors: {
              bg: css.getPropertyValue('--dsw-alias-bg-base'),
              text: css.getPropertyValue('--dsw-alias-label-primary'),
              line: css.getPropertyValue('--dsw-alias-border-l3'),
            },
          },
          target.origin,
        );
      };
      const receive = (e) => {
        if (
          e.source !== ref.current?.contentWindow ||
          e.origin !== target.origin ||
          e.data?.channel !== channel.current
        )
          return;
        if (e.data.type === 'dsh-design:space-state') {
          frameStates.set(tab.identity, e.data.view);
          return;
        }
        if (e.data.type === 'dsh-design:space-recovery') {
          recoveries[tab.identity] = e.data.items;
          try {
            localStorage.setItem(RECOVERY, JSON.stringify(recoveries));
          } catch {
            set({ error: '未保存输入的恢复记录无法写入本地存储，请保存后再离开' });
          }
          return;
        }
        if (e.data.type !== 'dsh-design:space-ready') return;
        sendTheme();
        if (recoveries[tab.identity]?.length)
          ref.current.contentWindow.postMessage(
            {
              type: 'dsh-design:space',
              channel: channel.current,
              action: 'recovery',
              items: recoveries[tab.identity],
            },
            target.origin,
          );
        const view = frameStates.get(tab.identity);
        if (view)
          ref.current.contentWindow.postMessage(
            { type: 'dsh-design:space', channel: channel.current, action: 'restore', view },
            target.origin,
          );
      };
      window.addEventListener('message', receive);
      const observer = new MutationObserver(sendTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-ds-dark-theme'],
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['style', 'data-ds-dark-theme'],
      });
      return () => {
        cleanup();
        observer.disconnect();
        window.removeEventListener('message', receive);
        if (activeFrame === target) activeFrame = null;
      };
    }, [url, tab.sessionId, inputActions]);
    if (error) return h('div', { role: 'alert', style: { padding: 20 } }, error);
    if (!url) return h('div', { role: 'status', style: { padding: 20 } }, '正在打开设计稿…');
    const src = new URL(url);
    src.searchParams.set('canvas', canvas);
    src.searchParams.set('embedded', '1');
    src.hash = new URLSearchParams({
      session: tab.sessionId || '',
      channel: channel.current,
      hostOrigin: location.origin,
    }).toString();
    return h('iframe', {
      ref,
      src: src.href,
      title: `设计稿：${tab.title}`,
      key: tab.identity + ':' + (tab.sessionId || ''),
    });
  }
  function ChatAndEditor({
    tab,
    inputActions,
    renderFactorySlot,
    full,
    chatOnly,
    sessionError,
    secondaryView,
    secondary = false,
    onSelectSession,
  }) {
    const s = useState(),
      [choice, setChoice] = React.useState('new'),
      [draftNotice, setDraftNotice] = React.useState('');
    const catalog = React.useSyncExternalStore(subscribeSessions, readSessions);
    React.useSyncExternalStore(subscribeWorkspaces, readWorkspaces);
    React.useEffect(() => {
      if (secondary || !tab.initialText || !inputActions) return;
      // Mark consumed before any side effect: remount/replay must never send twice.
      const current = state.tabs.find((t) => t.identity === tab.identity);
      if (!current?.initialText) return;
      const text = current.initialText;
      set({
        tabs: state.tabs.map((t) =>
          t.identity === tab.identity ? { ...t, initialText: null } : t,
        ),
      });
      let inserted = false;
      try {
        const span = inputActions.captureInsertion();
        if (!span || !inputActions.insertText(text, { ...span, start: span.end }))
          throw new Error('草稿暂不可编辑');
        inserted = true;
        if (current.initialSend) {
          inputActions.submit();
          setDraftNotice('已提交首次描述；若发送失败，宿主会保留草稿并显示原因。');
        } else setDraftNotice('描述已加入现有会话草稿，请核对后发送。');
      } catch (error) {
        if (!inserted)
          set({
            tabs: state.tabs.map((t) =>
              t.identity === tab.identity ? { ...t, pendingDescription: text } : t,
            ),
          });
        setDraftNotice('首次描述未提交：' + error.message + '。请核对草稿后手动发送。');
      }
    }, [tab.identity, tab.initialText, inputActions]);
    // Match the workspace's sessionTitle projection; the host owns title generation.
    const sessionTitle = (sid) =>
      catalog.byId[sid]?.blank ? '' : catalog.byId[sid]?.title?.trim() || '';
    const shared =
      tab.sessionId &&
      s.tabs.filter((t) => t.sessionId === tab.sessionId || t.sessionIds?.includes(tab.sessionId))
        .length > 1;
    const ids = visibleSessions(tab);
    const activeBlank = !!tab.sessionId && !sessionTitle(tab.sessionId);
    const closeSessionButton = (sid, index) =>
      button('×', () => run(() => archiveConversation(sid)), {
        className: 'ds-icon-button ds-session-close',
        'aria-label': `关闭会话 ${sessionTitle(sid) || index + 1}`,
        title: '关闭会话（归档，可在工作区恢复）',
        disabled: s.busy || tab.linkPending,
      });

    return h(
      'div',
      { className: 'ds-stage' },
      !chatOnly &&
        h(
          'div',
          {
            className: 'ds-editor',
            style: { flexBasis: full ? '100%' : `${s.ratio * 100}%`, flexGrow: full ? 1 : 0 },
          },
          h(EditorFrame, { key: tab.identity, tab, inputActions }),
        ),
      !full &&
        !chatOnly &&
        h('div', {
          className: 'ds-divider',
          role: 'separator',
          tabIndex: 0,
          'aria-label': '调整画布和右侧对话栏宽度',
          'aria-orientation': 'vertical',
          'aria-valuenow': Math.round(s.ratio * 100),
          'aria-valuemin': 35,
          'aria-valuemax': 75,
          onKeyDown: (e) => {
            if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
              e.preventDefault();
              set({
                ratio: Math.max(
                  0.35,
                  Math.min(0.75, s.ratio + (e.key === 'ArrowLeft' ? -0.03 : 0.03)),
                ),
              });
            }
          },
          onPointerDown: (e) => {
            const element = e.currentTarget;
            const rect = element.parentElement.getBoundingClientRect();
            element.setPointerCapture(e.pointerId);
            const move = (ev) =>
              set({ ratio: Math.max(0.35, Math.min(0.75, (ev.clientX - rect.left) / rect.width)) });
            const end = () => {
              element.removeEventListener('pointermove', move);
              element.removeEventListener('pointerup', end);
              element.removeEventListener('pointercancel', end);
            };
            element.addEventListener('pointermove', move);
            element.addEventListener('pointerup', end);
            element.addEventListener('pointercancel', end);
          },
        }),
      !full &&
        h(
          'div',
          { className: 'ds-chat-area', 'data-split': !!secondaryView },
          h(
            'aside',
            { className: 'ds-chat', 'aria-label': secondary ? '第二栏设计对话' : '设计对话' },
            h(
              'div',
              {
                className: 'ds-chat-head',
                title: shared ? '共用这段对话：其他设计稿也关联了此会话' : undefined,
              },
              h(
                'div',
                { className: 'ds-session-tabs', role: 'tablist', 'aria-label': '设计稿关联会话' },
                ...ids
                  .filter((sid) => secondary || sid !== tab.sessionId || !activeBlank)
                  .map((sid) => {
                    const index = ids.indexOf(sid),
                      title = sessionTitle(sid);
                    return h(
                      'div',
                      {
                        className: 'ds-session-item',
                        key: sid,
                        role: 'presentation',
                        'data-session-id': sid,
                      },
                      button(
                        title || '＋',
                        () =>
                          run(async () => {
                            if (sid === tab.sessionId) return;
                            await prepare();
                            onSelectSession(sid);
                          }),
                        {
                          role: 'tab',
                          className: 'ds-btn ds-session-tab',
                          'aria-label': title || `未命名对话 ${index + 1}`,
                          'aria-selected': sid === tab.sessionId,
                          title: title || `未命名对话 ${index + 1}`,
                          disabled: s.busy || tab.linkPending,
                        },
                      ),
                      closeSessionButton(sid, index),
                    );
                  }),
              ),
              !secondary &&
                h(
                  'div',
                  {
                    className: 'ds-session-item',
                    'data-session-id': activeBlank ? tab.sessionId : undefined,
                  },
                  button('＋', () => run(() => link(tab, 'new')), {
                    className: 'ds-icon-button ds-new-session',
                    'aria-label': '为当前设计稿新建对话',
                    'aria-current': activeBlank ? 'page' : undefined,
                    title: activeBlank ? '新建独立对话（当前会话尚未命名）' : '新建独立对话',
                    disabled: s.busy || tab.linkPending,
                  }),
                  activeBlank && closeSessionButton(tab.sessionId, ids.indexOf(tab.sessionId)),
                ),
              h('span', { className: 'ds-spacer' }),
              tab.sessionId &&
                !activeBlank &&
                button(
                  h(
                    'svg',
                    {
                      width: 16,
                      height: 16,
                      viewBox: '0 0 16 16',
                      fill: 'none',
                      stroke: 'currentColor',
                      'aria-hidden': true,
                    },
                    h('path', { d: 'M9 2h5v5 M14 2L7 9 M6 3H2v11h11v-4', strokeWidth: 1.2 }),
                  ),
                  () =>
                    run(async () => {
                      await prepare();
                      ctx.uiWorkspace.openSession(tab.sessionId);
                    }),
                  {
                    className: 'ds-icon-button',
                    'aria-label': '在普通对话打开',
                    title: '在普通对话打开',
                  },
                ),
            ),
            tab.linkError && h('div', { role: 'alert' }, tab.linkError),
            tab.linkPending &&
              h(
                'div',
                { role: 'alert' },
                '会话已创建，关联尚未保存。',
                button('重试保存关联', () => run(() => link(tab, tab.sessionId))),
              ),
            tab.pendingDescription &&
              h(
                'textarea',
                {
                  'aria-label': '未填入的首次描述',
                  readOnly: true,
                  value: tab.pendingDescription,
                  style: { margin: 12 },
                },
                null,
              ),
            draftNotice &&
              h('p', { className: 'ds-muted', style: { padding: '4px 12px' } }, draftNotice),
            sessionError
              ? h(
                  'div',
                  { role: 'alert', style: { padding: 16 } },
                  '会话暂不可用：' + sessionError + '。可切换其他会话或新建对话。',
                )
              : tab.sessionId
                ? h(
                    'div',
                    { className: 'ds-conversation' },
                    renderFactorySlot('conversation.content', {
                      variant: 'embedded',
                      phase: 'active',
                      hero: false,
                    }),
                  )
                : h(
                    'div',
                    { style: { padding: 20, display: 'grid', gap: 10 } },
                    h('p', {}, '选择用于继续设计的对话。设计稿仍可独立编辑。'),
                    h(
                      'select',
                      {
                        'aria-label': '选择关联对话',
                        value: choice,
                        onChange: (e) => setChoice(e.target.value),
                      },
                      h('option', { value: 'new' }, '新开一段对话'),
                      ...(catalog.ids || [])
                        .filter(
                          (id) =>
                            catalog.byId[id]?.cwd === tab.directory?.workspace &&
                            !readWorkspaces().archivedSessionIds?.includes(id),
                        )
                        .map((id) =>
                          h('option', { key: id, value: id }, catalog.byId[id].title || id),
                        ),
                    ),
                    button('连接对话', () => run(() => link(tab, choice)), { disabled: s.busy }),
                  ),
          ),
          secondaryView,
        ),
    );
  }
  function SessionSurface(props) {
    const session = props.useSession((s) => s);
    if (session.openState === 'error')
      return h(ChatAndEditor, { ...props, inputActions: null, sessionError: '会话加载失败' });
    return h(ChatAndEditor, props);
  }
  function ActiveTab({ tab, SessionProvider, renderSlot, ...viewProps }) {
    const [reference, setReference] = React.useState(null),
      [error, setError] = React.useState('');
    React.useEffect(() => {
      setError('');
      setReference(null);
      if (!tab.sessionId) return;
      let ref,
        alive = true;
      try {
        if (ctx.workspaces.list.getSnapshot().archivedSessionIds?.includes(tab.sessionId))
          throw new Error('会话已归档，请先在普通对话中恢复或重新关联');
        const referenceKey = tab.identity + ':' + tab.sessionId;
        ref =
          references.get(referenceKey) ||
          ctx.sessions.retain(tab.sessionId, { source: 'designSpace' });
        references.set(referenceKey, ref);
        ref.ready
          .then((binding) => {
            if (!alive) return;
            const status = binding.session.getSnapshot();
            if (status.openState === 'error') setError(status.error?.message || '加载失败');
            else setReference(ref);
          })
          .catch((e) => {
            if (alive) setError(e.message);
          });
      } catch (e) {
        setError(e.message);
      }
      // Retain drafts and attachments while the design is open; each visible session has one input occurrence.
      return () => {
        alive = false;
      };
    }, [tab.identity, tab.sessionId]);
    if (error)
      return h(ChatAndEditor, {
        tab,
        ...viewProps,
        sessionError: error,
        renderFactorySlot: () => null,
      });
    if (!tab.sessionId)
      return h(ChatAndEditor, { tab, ...viewProps, renderFactorySlot: () => null });
    if (!reference) return h('div', { role: 'status' }, '正在连接会话…');
    return h(SessionProvider, { session: reference }, renderSlot(SESSION, { tab, ...viewProps }));
  }
  function NewDesign() {
    const s = useState(),
      ws = React.useSyncExternalStore(subscribeWorkspaces, readWorkspaces),
      catalog = React.useSyncExternalStore(subscribeSessions, readSessions);
    const [title, setTitle] = React.useState(''),
      [name, setName] = React.useState(''),
      [workspaceId, setWorkspaceId] = React.useState(ws.items?.[0]?.workspaceId || ''),
      [preset, setPreset] = React.useState('blank'),
      [sid, setSid] = React.useState('new'),
      [description, setDescription] = React.useState('');
    const operation = React.useRef(crypto.randomUUID()),
      created = React.useRef(null),
      createdSession = React.useRef(null);
    const owner = ws.items?.find((w) => w.workspaceId === workspaceId);
    const submit = () =>
      run(async () => {
        await prepare();
        if (!owner) throw new Error('请先在 Harness 中添加一个工作区');
        if (!created.current) {
          const root = await api('register', {
            path: owner.path,
            workspace: owner.path,
            hidden: true,
          });
          created.current = {
            ...(await api('create', {
              id: root.id,
              name,
              title,
              preset,
              operationId: operation.current,
            })),
            id: root.id,
          };
        }
        if (!created.current.pinned) {
          const pinned = await api('register', {
            path: created.current.target,
            workspace: created.current.directory.workspace,
          });
          created.current.id = pinned.id;
          created.current.rel = '.';
          created.current.pinned = true;
        }
        const item = created.current;
        if (!createdSession.current)
          createdSession.current = sid === 'new' ? await ctx.sessions.create({ workspaceId }) : sid;
        const current = await api('describe', { id: item.id, rel: item.rel });
        await api('bind', {
          id: item.id,
          rel: item.rel,
          sessionId: createdSession.current,
          expectedRevision: current.linkRevision,
        });
        await open(item.id, item.rel);
        if (description.trim())
          set({
            tabs: state.tabs.map((t) =>
              t.identity === item.identity
                ? {
                    ...t,
                    initialText: `当前设计稿：${item.canvas}\n${description.trim()}`,
                    initialSend: sid === 'new',
                  }
                : t,
            ),
          });
        await refresh();
      });
    const field = (label, control) =>
      h(
        'label',
        {},
        h('strong', {}, label),
        React.cloneElement(control, { 'aria-label': label, disabled: s.busy || !!created.current }),
      );
    return h(
      'div',
      { className: 'ds-form-wrap' },
      h(
        'form',
        {
          className: 'ds-form',
          onSubmit: (e) => {
            e.preventDefault();
            submit();
          },
        },
        h(
          'div',
          { className: 'ds-form-body' },
          h('h2', {}, '新建设计稿'),
          h('p', { className: 'ds-muted' }, '创建一份设计稿，并选择用于继续设计的对话。'),
          field(
            '标题',
            h('input', {
              required: true,
              maxLength: 120,
              value: title,
              onChange: (e) => setTitle(e.target.value),
              autoFocus: true,
            }),
          ),
          field(
            '目录名',
            h('input', {
              required: true,
              pattern: '[a-zA-Z0-9](?:[a-zA-Z0-9_]|-){0,63}',
              value: name,
              onChange: (e) => setName(e.target.value),
              placeholder: 'checkout-flow',
            }),
          ),
          h(
            'span',
            { className: 'ds-muted' },
            `${owner?.path || '请选择工作区'}/${name || '目录名'}/`,
          ),
          field(
            '放在哪个工作区',
            h(
              'select',
              {
                value: workspaceId,
                onChange: (e) => {
                  setWorkspaceId(e.target.value);
                  setSid('new');
                },
              },
              ...(ws.items || []).map((w) =>
                h(
                  'option',
                  { key: w.workspaceId, value: w.workspaceId },
                  `${w.title || w.path} — ${w.path}`,
                ),
              ),
            ),
          ),
          h('strong', {}, '从哪儿开始'),
          h(
            'div',
            { className: 'ds-presets' },
            ...[
              ['blank', '空白', '880 × 560'],
              ['mobile', '手机界面', '390 × 844'],
              ['web', '网页 / 落地页', '1440 × 1000'],
              ['a4', '印刷品', 'A4 / A3 版式'],
            ].map(([id, label, detail]) =>
              button(
                h(
                  React.Fragment,
                  {},
                  h('strong', {}, label),
                  h('div', { className: 'ds-muted' }, detail),
                ),
                () => setPreset(id),
                {
                  disabled: s.busy || !!created.current,
                  'aria-pressed': preset === id || (id === 'a4' && preset === 'a3'),
                  key: id,
                },
              ),
            ),
          ),
          ['a4', 'a3'].includes(preset) &&
            field(
              '纸张规格',
              h(
                'select',
                { value: preset, onChange: (e) => setPreset(e.target.value) },
                h('option', { value: 'a4' }, 'A4 竖版'),
                h('option', { value: 'a3' }, 'A3 竖版'),
              ),
            ),
          field(
            '这段对话',
            h(
              'select',
              { value: sid, onChange: (e) => setSid(e.target.value) },
              h('option', { value: 'new' }, '新开一段对话'),
              ...(catalog.ids || [])
                .filter((id) => catalog.byId[id]?.cwd === owner?.path)
                .map((id) =>
                  h(
                    'option',
                    { value: id, key: id },
                    `接到已有对话：${catalog.byId[id].title || id}`,
                  ),
                ),
            ),
          ),
          sid !== 'new' &&
            h('p', { className: 'ds-muted' }, '将共用这段对话的消息和草稿，仍可修改其他设计稿。'),
          field(
            '先描述一句（可选）',
            h('textarea', {
              rows: 3,
              value: description,
              onChange: (e) => setDescription(e.target.value),
            }),
          ),
          h(
            'p',
            { className: 'ds-muted' },
            sid === 'new'
              ? '填写描述后，创建并发送给所选模型；不填写则只创建。'
              : '描述会追加到已有会话草稿，请核对后自行发送。',
          ),
          created.current &&
            h('p', { role: 'status' }, '设计稿已创建；重试只继续连接会话，不重新创建目录。'),
        ),
        h(
          'footer',
          { className: 'ds-form-footer' },
          button('取消', () => set({ newForm: false })),
          h(
            'button',
            { type: 'submit', className: 'ds-btn primary', disabled: s.busy },
            created.current
              ? '继续连接'
              : description.trim()
                ? sid === 'new'
                  ? '创建并发送'
                  : '创建并填入草稿'
                : '创建设计稿',
          ),
        ),
      ),
    );
  }
  const previewSlots = new Set(),
    previewWaiters = new Set();
  function Thumbnail({ item }) {
    const ref = React.useRef(null),
      token = React.useRef({}),
      [url, setURL] = React.useState('');
    React.useEffect(() => {
      let visible = false,
        alive = true;
      const reconcile = () => {
        if (!alive) return;
        if (!visible) {
          if (previewSlots.delete(token.current)) {
            setURL('');
            for (const notify of previewWaiters) notify();
          }
          return;
        }
        if (previewSlots.has(token.current) || previewSlots.size >= 4) return;
        previewSlots.add(token.current);
        api('open', { id: item.id, rel: item.rel || '.' })
          .then((info) => {
            if (!alive || !previewSlots.has(token.current) || !info.preview) return;
            const u = new URL(
              'board/' +
                info.canvas.split('/').map(encodeURIComponent).join('/') +
                '/' +
                info.preview.board.split('/').map(encodeURIComponent).join('/'),
              info.url,
            );
            u.searchParams.set('preview', '1');
            setURL(u.href);
          })
          .catch(() => {});
      };
      previewWaiters.add(reconcile);
      const observer = new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        reconcile();
      });
      observer.observe(ref.current);
      return () => {
        alive = false;
        observer.disconnect();
        previewWaiters.delete(reconcile);
        previewSlots.delete(token.current);
        for (const notify of previewWaiters) notify();
      };
    }, [item.identity]);
    const w = item.preview?.w || 880,
      hgt = item.preview?.h || 560,
      k = Math.min(80 / w, 52 / hgt);
    return h(
      'span',
      {
        ref,
        'aria-hidden': true,
        style: {
          width: 80,
          height: 52,
          overflow: 'hidden',
          position: 'relative',
          flexShrink: 0,
          background: 'var(--dss-card)',
          borderRadius: 4,
        },
      },
      url
        ? h('iframe', {
            title: '设计稿缩略图',
            src: url,
            sandbox: 'allow-scripts allow-same-origin',
            tabIndex: -1,
            style: {
              width: w,
              height: hgt,
              border: 0,
              pointerEvents: 'none',
              transform: `scale(${k})`,
              transformOrigin: 'top left',
              position: 'absolute',
              left: (80 - w * k) / 2,
              top: (52 - hgt * k) / 2,
            },
          })
        : '▣',
    );
  }
  function SpaceRoot({ SessionProvider, renderSlot, useSessionStatus }) {
    const s = useState(),
      [full, setFull] = React.useState(false),
      [chatOnly, setChatOnly] = React.useState(false),
      [splitSid, setSplitSid] = React.useState(null);
    const workspaceState = React.useSyncExternalStore(subscribeWorkspaces, readWorkspaces);
    const catalog = React.useSyncExternalStore(subscribeSessions, readSessions);
    const statuses = useSessionStatus((s) => s);
    const [found, setFound] = React.useState([]);
    const reorder = (id, target) => {
      const tabs = state.tabs.slice(),
        from = tabs.findIndex((t) => t.identity === id),
        to = tabs.findIndex((t) => t.identity === target);
      if (from < 0 || to < 0 || from === to) return;
      const [item] = tabs.splice(from, 1);
      tabs.splice(to, 0, item);
      set({ tabs });
    };
    React.useEffect(() => {
      run(async () => {
        await refresh();
        const current = state.tabs.find((t) => t.identity === state.active);
        if (current) await open(current.id, current.rel);
      });
    }, []);
    React.useEffect(() => {
      if (s.active || s.newForm) return;
      let live = true;
      // A nested workspace owns its designs before an ancestor workspace does.
      const roots = [...workspaces()].sort((a, b) => b.path.length - a.path.length);
      Promise.all(
        roots.map(async (w) => {
          const d = await api('register', { path: w.path, workspace: w.path, hidden: true });
          const list = await api('discover', { id: d.id });
          return list.items.map((i) => ({ ...i, id: d.id }));
        }),
      )
        .then((lists) => {
          if (live) {
            const unique = new Map();
            for (const item of lists.flat()) {
              if (!unique.has(item.identity)) unique.set(item.identity, item);
            }
            setFound([...unique.values()]);
          }
        })
        .catch((e) => {
          if (live) set({ error: e.message });
        });
      return () => {
        live = false;
      };
    }, [s.active, s.newForm]);
    const active = s.tabs.find((t) => t.identity === s.active);
    React.useEffect(() => {
      setSplitSid(null);
    }, [s.active]);
    React.useEffect(() => {
      const archived = new Set(workspaceState.archivedSessionIds || []);
      if (splitSid && archived.has(splitSid)) setSplitSid(null);
      for (const [key, ref] of references) {
        if (archived.has(ref.sessionId)) {
          ref.release();
          references.delete(key);
        }
      }
      if (!s.tabs.some((t) => archived.has(t.sessionId))) return;
      set({
        tabs: state.tabs.map((t) =>
          archived.has(t.sessionId) ? { ...t, sessionId: visibleSessions(t)[0] || null } : t,
        ),
      });
    }, [workspaceState, s.tabs, splitSid]);
    const selectSession = (sid, secondary = false) => {
      if (secondary) {
        if (sid === active.sessionId) {
          set({
            tabs: state.tabs.map((t) =>
              t.identity === active.identity ? { ...t, sessionId: splitSid } : t,
            ),
          });
        }
        setSplitSid(sid);
      } else {
        if (sid === splitSid) setSplitSid(active.sessionId);
        set({
          tabs: state.tabs.map((t) =>
            t.identity === active.identity ? { ...t, sessionId: sid } : t,
          ),
        });
      }
    };
    const splitActive =
      splitSid &&
      splitSid !== active?.sessionId &&
      visibleSessions(active || {}).includes(splitSid);
    const glyph = (kind) =>
      h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          'aria-hidden': true,
        },
        h('path', {
          d:
            kind === 'split'
              ? 'M2 2.5h12v11H2z M2 8h12'
              : kind === 'restore'
                ? 'M9 2v5h5 M7 14V9H2'
                : kind === 'fullscreen'
                  ? 'M2 6V2h4 M10 2h4v4 M14 10v4h-4 M6 14H2v-4'
                  : 'M2 2.5h12v11H2z M10 2.5v11',
          strokeWidth: 1.2,
        }),
      );
    const control = (label, icon, onClick, extra = {}) =>
      button(glyph(icon), onClick, {
        className: 'ds-icon-button',
        'aria-label': label,
        title: label,
        disabled: s.busy,
        ...extra,
      });
    const row = (item) =>
      h(
        'button',
        {
          type: 'button',
          key: item.identity || item.rel,
          onClick: () => run(() => open(item.id || s.browse.entry.id, item.rel)),
        },
        h(Thumbnail, { item: { ...item, id: item.id || s.browse?.entry.id } }),
        h(
          'span',
          {},
          h('strong', {}, item.title),
          h('div', { className: 'ds-muted' }, `${item.canvas} · ${item.count} 张画板`),
        ),
        h('span', { className: 'ds-spacer' }),
        h(
          'span',
          { className: 'ds-muted' },
          item.sessionId ? '有对话' : new Date(item.updatedAt || Date.now()).toLocaleDateString(),
        ),
      );
    return h(
      'main',
      { className: 'ds-space', 'aria-label': 'Design 空间' },
      h(
        'div',
        { className: 'ds-bar', role: 'tablist', 'aria-label': '设计稿页签' },
        ...s.tabs.map((t) =>
          h(
            'div',
            {
              key: t.identity,
              draggable: true,
              onDragStart: (e) => e.dataTransfer.setData('application/x-design-tab', t.identity),
              onDragOver: (e) => e.preventDefault(),
              onDrop: (e) => {
                e.preventDefault();
                reorder(e.dataTransfer.getData('application/x-design-tab'), t.identity);
              },
              className: 'ds-tab',
              role: 'presentation',
              'aria-selected': t.identity === s.active,
            },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': t.identity === s.active,
                className: 'ds-tab-title',
                tabIndex: t.identity === s.active ? 0 : -1,
                onKeyDown: (e) => {
                  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
                  e.preventDefault();
                  const at = s.tabs.indexOf(t),
                    next =
                      s.tabs[
                        (at + (e.key === 'ArrowLeft' ? -1 : 1) + s.tabs.length) % s.tabs.length
                      ];
                  if (e.altKey) reorder(t.identity, next.identity);
                  else run(() => activate(next));
                },
                title: (t.canvas || t.title) + ' · Alt + 方向键调整顺序',
                onClick: () => run(() => activate(t)),
              },
              t.title,
              statuses.get(t.sessionId)?.running ? ' ●' : '',
            ),
            button('×', () => run(() => close(t)), { 'aria-label': `关闭 ${t.title}` }),
          ),
        ),
        button(
          '＋',
          () =>
            run(async () => {
              await prepare();
              set({ newForm: true, browse: null });
            }),
          { 'aria-label': '新建设计稿', disabled: s.busy },
        ),
        h('span', { className: 'ds-spacer' }),
        active &&
          h(
            'div',
            { className: 'ds-panel-actions', role: 'toolbar', 'aria-label': '对话栏操作' },
            control(
              splitActive ? '取消分栏' : '分栏',
              'split',
              () =>
                run(async () => {
                  await prepare();
                  if (splitActive) {
                    setSplitSid(null);
                    return;
                  }
                  const other = visibleSessions(active).find((sid) => sid !== active.sessionId);
                  if (other) setSplitSid(other);
                  else {
                    const previous = active.sessionId;
                    await link(active, 'new');
                    setSplitSid(previous);
                  }
                  setFull(false);
                }),
              {
                'aria-pressed': !!splitActive,
                disabled: s.busy || active.linkPending || !active.sessionId,
              },
            ),
            control(
              chatOnly ? '退出全屏' : '全屏',
              chatOnly ? 'restore' : 'fullscreen',
              () =>
                run(async () => {
                  await prepare();
                  setChatOnly(!chatOnly);
                  setFull(false);
                }),
              { 'aria-pressed': chatOnly },
            ),
            control(
              full ? '打开对话侧栏' : '收起对话侧栏',
              'panel',
              () =>
                run(async () => {
                  await prepare();
                  setFull(!full);
                }),
              { 'aria-expanded': !full },
            ),
          ),
      ),
      errorView(s),
      s.picker &&
        h(
          'div',
          { className: 'ds-empty', role: 'dialog', 'aria-label': '选择设计目录' },
          h('strong', {}, s.picker.path),
          button('上一级', () =>
            run(async () =>
              set({
                picker: await ctx.uiWorkspace.listDirectory(
                  s.picker.path.replace(/[\\/][^\\/]+[\\/]?$/, '') || '/',
                ),
              }),
            ),
          ),
          ...(s.picker.entries || [])
            .filter((e) => !e.hidden)
            .map((e) =>
              button(
                e.name || e.path,
                () => run(async () => set({ picker: await ctx.uiWorkspace.listDirectory(e.path) })),
                { key: e.path },
              ),
            ),
          button('选择此目录', () =>
            run(async () => {
              const chosen = s.picker.path;
              set({ picker: false });
              await acceptDirectory(chosen);
            }),
          ),
          button('取消', () => set({ picker: false })),
        ),
      s.newForm
        ? h(NewDesign)
        : s.browse
          ? h(
              'div',
              { className: 'ds-empty' },
              h('h1', {}, s.browse.entry.label),
              h(
                'p',
                {},
                s.browse.items.length
                  ? '请选择此目录中的设计稿'
                  : '此目录还没有设计稿。新建功能会在所选工作区中创建目录，不会覆盖现有内容。',
              ),
              button('新建设计稿', () => set({ newForm: true, browse: null }), {
                className: 'ds-btn primary',
              }),
              h('div', { className: 'ds-list' }, ...s.browse.items.map(row)),
              s.browse.truncated && h('p', {}, '只显示前60份设计稿，请添加更具体的目录。'),
            )
          : active
            ? h(ActiveTab, {
                key: active.identity + ':' + (active.sessionId || ''),
                tab: active,
                SessionProvider,
                renderSlot,
                full,
                chatOnly: chatOnly && !full,
                onSelectSession: (sid) => selectSession(sid),
                secondaryView:
                  splitActive && !full
                    ? h(ActiveTab, {
                        key: active.identity + ':secondary:' + splitSid,
                        tab: {
                          ...active,
                          sessionId: splitSid,
                          initialText: null,
                          initialSend: false,
                        },
                        SessionProvider,
                        renderSlot,
                        chatOnly: true,
                        secondary: true,
                        onSelectSession: (sid) => selectSession(sid, true),
                      })
                    : null,
              })
            : h(
                'div',
                { className: 'ds-empty' },
                h('h1', {}, '还没有打开的设计稿'),
                h('p', {}, '设计稿是包含 canvas.json 的目录。新建一份，或打开已有的设计稿。'),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  button('新建设计稿', () => set({ newForm: true }), {
                    className: 'ds-btn primary',
                  }),
                  button('添加设计目录…', () => run(addDirectory)),
                ),
                h('h3', {}, '工作区里的设计稿'),
                h('div', { className: 'ds-list' }, ...found.map(row)),
                !found.length &&
                  h('p', { className: 'ds-muted' }, '尚未发现设计稿。也可以添加一个设计目录。'),
              ),
    );
  }
  class SpaceBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
      return { error };
    }
    render() {
      if (this.state.error) {
        return h(
          'div',
          { className: 'ds-empty', role: 'alert' },
          '设计空间暂不可用：' + this.state.error.message,
          button('返回设计空间', () => {
            set({ newForm: false });
            this.setState({ error: null });
          }),
        );
      }
      return h(SpaceRoot, this.props);
    }
  }
  // Own only our panel and session child. Native/browse picking uses the installed host backend.
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: ID, children: { [SESSION]: { kind: 'single', scope: 'session' } } },
      SpaceBoundary,
    ),
  );
  ctx.slots.inject(SESSION, () => ctx.slots.register({ name: SESSION }, SessionSurface));
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: ID, label: 'Design 空间', order: 90 }, () =>
      h('span', { 'aria-hidden': true }, '▧'),
    ),
  );
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: ID, order: 90 }, DirectorySection),
  );
  ctx.effect(() => () => {
    disposed = true;
    for (const ref of references.values()) ref.release();
    listeners.clear();
  });
}

window.__ModuleLoader__.load({
	id: '@local/dsh-plugin-design',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		function DesignEditor({ sessionId, useSessions, inputActions }) {
			const frame = React.useRef(null);
			const channel = React.useRef(null);
			if (!channel.current) channel.current = crypto.randomUUID();
			const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd);
			const [attempt, retry] = React.useState(0);
			const [state, setState] = React.useState({});
			React.useEffect(() => {
				const controller = new AbortController();
				setState({});
				const base = new URL(document.baseURI);
				base.search = ''; base.hash = '';
				if (!base.pathname.endsWith('/')) base.pathname += '/';
				const endpoint = new URL('design-editor/open', base);
				endpoint.searchParams.set('sessionId', sessionId);
				fetch(endpoint, { method: 'POST', signal: controller.signal })
					.then(async response => {
						const value = await response.json();
						if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
						if (!controller.signal.aborted) setState({ ...value, sessionId, cwd });
					})
					.catch(error => {
						if (!controller.signal.aborted) setState({ error: error.message, sessionId, cwd });
					});
				return () => controller.abort();
			}, [sessionId, cwd, attempt]);
			// A session change must never briefly display the previous workspace.
			const current = state.sessionId === sessionId && state.cwd === cwd ? state : {};
			React.useEffect(() => {
				if (!current.url) return;
				return setupComposerBridge({frame,sessionId,url:current.url,channel:channel.current,inputActions});
			}, [sessionId,cwd,current.url,inputActions]);
			if (!current.url) return h('div', { role: 'status', style: { padding: 20 } },
				h('p', null, current.error || '正在连接当前工作区…'),
				current.error && h('button', { type: 'button', onClick: () => retry(value => value + 1) }, '重新连接'));
			const editorURL = new URL(current.url);
			editorURL.hash = new URLSearchParams({session:sessionId,channel:channel.current,hostOrigin:window.location.origin}).toString();
			return h('iframe', {
				key: sessionId + ':' + current.url,
				ref: frame,
				src: editorURL.href,
				title: '设计稿编辑器',
				style: { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent' },
			});
		}

		return {
			inject: ['slots', 'sidebarRightTabs'],
			apply(ctx) {
                ctx.inject?.(['layout', 'sessions', 'workspaces', 'uiWorkspace'], scoped => installDesignSpace(React, scoped, require('react-dom').createPortal, require('@deepseek-ai/dsh-client-ui-primitives').IconProjectAddOutlineRegular));
				// rightbar.session 是宿主独占槽位；插件只能注册其中的标签页。
				const id = '@local/dsh-plugin-design/editor';
				ctx.effect(() => ctx.sidebarRightTabs.register({
					id,
					kind: 'design-editor',
					title: () => '设计稿编辑器',
					guide: [{
						id: 'design-editor',
						order: 50,
						title: () => '设计稿编辑器',
						description: () => '直接编辑当前会话工作区中的设计稿',
					}],
				}));
				ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
					ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, DesignEditor),
				));
			},
		};
	},
});
