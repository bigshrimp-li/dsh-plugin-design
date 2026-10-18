// Deliberately mocked Host contract: no model calls. The real editor/server are used by the runner.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
const h = React.createElement,
  registrations = new Map(),
  subscribers = new Set(),
  root = createRoot(document.getElementById('root'));
// Host workspace stores use receiver-bound methods. Keep that contract here.
const source = (value) => ({
  value,
  listeners: new Set(),
  set(value) {
    this.value = value;
    for (const fn of this.listeners) fn();
  },
  getSnapshot() {
    return this.value;
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
});
const savedMock = JSON.parse(sessionStorage.getItem('design-space-fixture') || '{}');
const sessionState = new Map(),
  Session = React.createContext(null);
let panel = null,
  created = savedMock.created || 0,
  sends = savedMock.sends || 0,
  retains = 0,
  releases = 0,
  failCreate = false,
  failArchive = false;
const workspace = {
  workspaceId: 'test-workspace',
  path: window.TEST_WORKSPACE,
  title: '测试工作区',
  sessionIds: [],
};
const catalog = savedMock.catalog || { ids: [], byId: {} };
function persistMock() {
  sessionStorage.setItem(
    'design-space-fixture',
    JSON.stringify({
      created,
      sends,
      archived: contexts.workspaces.list.getSnapshot().archivedSessionIds,
      catalog,
      sessions: {
        ...savedMock.sessions,
        ...Object.fromEntries(
          [...sessionState].map(([id, d]) => [id, { draft: d.draft, messages: d.messages }]),
        ),
      },
    }),
  );
}
const useStore = () =>
  React.useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => panel,
  );
function data(sid) {
  if (!sessionState.has(sid))
    sessionState.set(sid, {
      draft: '',
      messages: [],
      ...savedMock.sessions?.[sid],
      listeners: new Set(),
    });
  return sessionState.get(sid);
}
const inputFor = (sid) => {
  const d = data(sid);
  return (d.actions ??= {
    captureInsertion: () => ({ start: d.draft.length, end: d.draft.length }),
    insertText: (text, span) => {
      d.draft = d.draft.slice(0, span.start) + text + d.draft.slice(span.end);
      persistMock();
      for (const fn of d.listeners) fn();
      return true;
    },
    setDraft: (text) => {
      d.draft = text;
      persistMock();
      for (const fn of d.listeners) fn();
    },
    submit: () => {
      sends++;
      d.messages.push(d.draft);
      if (catalog.byId[sid].blank) {
        catalog.byId[sid] = {
          ...catalog.byId[sid],
          blank: false,
          title: '测试对话 ' + sid.split('-').at(-1),
        };
        contexts.sessions.list.set({ ...catalog });
      }
      d.draft = '';
      persistMock();
      for (const fn of d.listeners) fn();
    },
  });
};
const contexts = {
  layout: {
    selectPanel: (id) => {
      panel = id;
      for (const fn of subscribers) fn();
    },
  },
  workspaces: {
    list: source({
      items: [
        workspace,
        {
          workspaceId: 'nested-workspace',
          path: workspace.path + '/independent',
          title: '嵌套测试工作区',
          sessionIds: [],
        },
      ],
      archivedSessionIds: savedMock.archived || [],
      phase: 'ready',
    }),
  },
  sessions: {
    list: source(catalog),
    create: async (options) => {
      if (failCreate) {
        failCreate = false;
        throw new Error('测试：会话创建暂时失败');
      }
      created++;
      const id = 'fixture-session-' + created;
      if (!options?.cwd || options.workspaceId) throw new Error('设计对话必须直接指定空间目录');
      await fetch('/fixture/session', { method: 'POST', body: JSON.stringify({ id, cwd: options.cwd }) });
      catalog.ids.push(id);
      catalog.byId[id] = { id, cwd: options.cwd, title: '', blank: true };
      data(id);
      persistMock();
      return id;
    },
    retain: (id) => {
      retains++;
      let released = false;
      return {
        sessionId: id,
        ready: Promise.resolve({ session: { getSnapshot: () => ({ openState: 'open' }) } }),
        release: () => {
          if (!released) {
            released = true;
            releases++;
          }
        },
      };
    },
  },
  uiWorkspace: {
    archiveSession: async (sid) => {
      if (failArchive) {
        failArchive = false;
        throw new Error('会话任务正在运行');
      }
      const store = contexts.workspaces.list;
      store.set({
        ...store.getSnapshot(),
        archivedSessionIds: [...store.getSnapshot().archivedSessionIds, sid],
      });
      persistMock();
      contexts.layout.selectPanel(null); // Host archive clears a matching ordinary-chat selection.
    },
    openSession: () => contexts.layout.selectPanel(null),
    listDirectory: async () => ({ path: workspace.path, entries: [] }),
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (options, component) => {
      registrations.set(options.name + (options.key || ''), component);
      return () => {};
    },
    entriesOfSlot: () => [{}],
  },
  effect: (fn) => fn(),
  inject: (names, fn) => fn(contexts),
  sidebarRightTabs: { register: () => () => {} },
};
function Conversation({ phase }) {
  const sid = React.useContext(Session),
    d = data(sid);
  const draft = React.useSyncExternalStore(
    (fn) => {
      d.listeners.add(fn);
      return () => d.listeners.delete(fn);
    },
    () => d.draft,
  );
  return h(
    'div',
    {
      'data-native-factory-fixture': true,
      'data-conversation-content': '',
      'data-conversation-session': sid,
      'data-content-phase': phase,
      style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
    },
    h(
      'div',
      {
        'data-conversation-scroll': '',
        style: {
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
        },
      },
      h(
        'div',
        { 'aria-label': '测试消息流', style: { flex: phase === 'active' ? '1 0 auto' : 'none' } },
        ...d.messages.map((text, i) => h('p', { key: i }, text)),
      ),
      h(
        'div',
        {
          'data-composer-seat': '',
          style: {
            padding: 12,
            flexShrink: 0,
            position: phase === 'active' ? 'sticky' : 'static',
            bottom: 0,
            background: 'white',
          },
        },
        h('button', { onClick: () => inputFor(sid).submit() }, '测试发送'),
        h('textarea', {
          'aria-label': '测试会话草稿',
          value: draft,
          onChange: (e) => inputFor(sid).setDraft(e.target.value),
        }),
      ),
    ),
  );
}
function Surface(props) {
  const sid = React.useContext(Session),
    Body = registrations.get('design.space.session');
  return h(Body, {
    ...props,
    useSession: (fn) => fn({ openState: 'open' }),
    inputActions: inputFor(sid),
    renderFactorySlot: (name, options) => {
      if (
        name !== 'conversation.content' ||
        options.variant !== 'embedded' ||
        options.phase !== 'active' ||
        options.hero !== false
      )
        throw new Error('Invalid factory contract');
      return h(Conversation, { phase: options.phase });
    },
  });
}
function SessionProvider({ session, children }) {
  return h(Session.Provider, { value: session.sessionId }, children);
}
function App() {
  const panel = useStore(),
    Side = registrations.get('sidebar.footer.action'),
    Main = registrations.get('main@local/dsh-plugin-design/space');
  return h(
    React.Fragment,
    {},
    h(
      'aside',
      {
        style: {
          width: 280,
          background: '#f5f6f7',
          paddingTop: 48,
          display: 'flex',
          flexDirection: 'column',
        },
      },
      h(
        'button',
        { onClick: () => contexts.layout.selectPanel('@local/dsh-plugin-design/space') },
        'Design 空间',
      ),
      h('button', { onClick: () => contexts.layout.selectPanel(null) }, '普通对话'),
      h(
        'div',
        {
          className: 'fixture_regionArea',
          style: { display: 'flex', flexDirection: 'column', flex: 1 },
        },
        h(
          'div',
          { className: 'fixture_root', style: { display: 'flex', flexDirection: 'column' } },
          h(
            'div',
            {
              className: 'fixture_sectionHeader',
              style: { display: 'flex', alignItems: 'center', minHeight: 36 },
            },
            h('span', { className: 'fixture_sectionLabel' }, '工作区'),
            h('input', {
              'aria-label': '搜索会话名称',
              placeholder: '搜索',
              style: { minWidth: 0, width: 75 },
            }),
          ),
          h(
            'div',
            { className: 'fixture_listArea', role: 'tree', 'aria-label': '工作区列表' },
            h('div', { style: { height: 90 } }, '测试工作区'),
          ),
        ),
      ),
      h(
        'div',
        { className: 'fixture_footArea', style: { display: 'flex', flexDirection: 'column' } },
        h('div', { className: 'fixture_footerActions' }, h(Side, { wide: true })),
        h('div', { className: 'fixture_settingsArea' }, h('button', {}, '账号菜单')),
      ),
    ),
    h(
      'div',
      { style: { flex: 1, minWidth: 0 } },
      panel
        ? h(Main, {
            SessionProvider,
            renderSlot: (name, props) => h(Surface, props),
            useSessionStatus: (fn) => fn(new Map()),
          })
        : h('p', {}, '普通对话测试占位'),
    ),
  );
}
window.__ModuleLoader__ = {
  load: ({ factory }) => {
    const plugin = factory((name) => {
      if (name === 'react') return React;
      if (name === 'react-dom') return { createPortal };
      if (name === '@deepseek-ai/dsh-client-ui-primitives')
        return {
          IconProjectAddOutlineRegular: ({ size }) =>
            h('svg', { width: size, height: size, 'aria-hidden': true }),
        };
      throw new Error(name);
    });
    plugin.apply(contexts);
    root.render(h(App));
  },
};
window.fixture = {
  rename: (sid, title) => {
    catalog.byId[sid] = { ...catalog.byId[sid], title };
    contexts.sessions.list.set({ ...catalog });
    persistMock();
  },
  failNextArchive: () => {
    failArchive = true;
  },
  restore: (sid) => {
    const store = contexts.workspaces.list;
    store.set({
      ...store.getSnapshot(),
      archivedSessionIds: store.getSnapshot().archivedSessionIds.filter((id) => id !== sid),
    });
    persistMock();
  },
  failNextCreate: () => {
    failCreate = true;
  },
  open: () => contexts.layout.selectPanel('@local/dsh-plugin-design/space'),
  ordinary: () => contexts.layout.selectPanel(null),
  counts: () => ({ created, sends, retains, releases }),
  workspaceSnapshot: () => contexts.workspaces.list.getSnapshot(),
  removeWorkspaces: () => contexts.workspaces.list.set({ ...contexts.workspaces.list.getSnapshot(), items: [] }),
  data,
};
