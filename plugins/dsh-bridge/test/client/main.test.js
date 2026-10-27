import { describe, expect, it } from "vitest";

/**
 * Unit checks for the panel's "Run & session" tab.
 *
 * The module registers itself into `window.__ModuleLoader__` at module scope, so
 * a fake loader is installed before the dynamic imports. Nothing here needs the
 * dsh runtime: React is a hand-written stand-in and the service facade is the
 * real one, driven through the same entry points the settings surface uses.
 *
 * What matters here is the difference the milestone turns on: with demo off the
 * cards say `unknown` and disable their controls, and with demo on they draw the
 * design's content and carry the demo marker the shell puts on every page.
 */

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.styles.js");
await import("../../src/client/client.services.js");
await import("../../src/client/client.shell.js");
await import("../../src/client/client.run-panel.js");
await import("../../src/client/client.offline.js");
await import("../../src/client/client.main.js");
await import("../../src/client/index.js");

const chunkFactories = new Map();
for (const definition of loaded) chunkFactories.set(definition.chunk ?? "entry", definition.factory);

/** Whether two dependency lists would let React skip the effect. */
function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false;
  return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
}

/**
 * Minimal React stand-in: element descriptors plus the two hooks the bundle
 * uses.
 *
 * The hook store lives at module scope so a re-render can carry it forward: the
 * disclosure below is a `useState`, and a fold that reset the store on every
 * draw would never be observable.
 */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { type, props: merged };
    },
    useState(initial) {
      const index = hookCursor;
      hookCursor += 1;
      if (!Object.hasOwn(hookStates, index)) {
        hookStates[index] = typeof initial === "function" ? initial() : initial;
      }
      return [
        hookStates[index],
        (value) => {
          hookStates[index] = typeof value === "function" ? value(hookStates[index]) : value;
        },
      ];
    },
    useEffect(run, deps) {
      const index = hookCursor;
      hookCursor += 1;
      const previous = hookStates[index];
      if (previous !== undefined && sameDeps(previous.deps, deps)) return;
      if (previous !== undefined && typeof previous.cleanup === "function") previous.cleanup();
      hookStates[index] = { deps, cleanup: run() };
    },
  };
}

/** Concatenate the text a rendered element tree carries, ignoring stylesheets. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node.type === "style") return "";
  if (typeof node.type === "function") return textOf(node.type(node.props));
  return textOf(node.props?.children);
}

/** Every element in a rendered tree, depth first. */
function elementsOf(node, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, found);
    return found;
  }
  found.push(node);
  if (typeof node.type === "function") {
    elementsOf(node.type(node.props), found);
    return found;
  }
  elementsOf(node.props?.children, found);
  return found;
}

/** Hook state the stand-in hands back, in call order. */
let hookStates = [];
let hookCursor = 0;

/** Render one component with a fresh hook store and hand back its element tree. */
function renderTree(component, props) {
  hookStates = [];
  hookCursor = 0;
  return component(props);
}

/** Render one component with a fresh hook store, as text. */
function render(component, props) {
  return textOf(renderTree(component, props));
}

/**
 * Render the tab and hand back what each foldable card offers: the toggle
 * button and the body it controls, both keyed by the card's `id`.
 *
 * The toggle is the button the Card primitive draws in place of a plain title —
 * the one carrying `aria-expanded` and an `aria-controls` pointing at the body.
 * `rerender` draws again over the same hook store, so a click's state change
 * shows up the way React would show it; without it the draw starts fresh.
 */
function disclosureParts(component, props, { rerender = false } = {}) {
  let tree;
  if (rerender) {
    hookCursor = 0;
    tree = component(props);
  } else {
    tree = renderTree(component, props);
  }
  const controls = new Map();
  const bodies = new Map();
  const keyOf = (value) => (typeof value === "string" && value.endsWith("-body") ? value.slice(0, -5) : undefined);
  for (const node of elementsOf(tree)) {
    const controlsId = node.type === "button" ? keyOf(node.props?.["aria-controls"]) : undefined;
    if (controlsId !== undefined) controls.set(controlsId, node);
    const bodyId = node.type === "div" ? keyOf(node.props?.id) : undefined;
    if (bodyId !== undefined) bodies.set(bodyId, node);
  }
  return { tree, controls, bodies };
}

/** The disclosure toggles alone, keyed by card id. */
function disclosureControls(component, props) {
  return disclosureParts(component, props).controls;
}

/** Build the connected module over the real shell, facade and Run card. */
function buildMain() {
  const kernel = chunkFactories.get("entry")(fakeRequire).createKernel({
    CSS: chunkFactories.get("client.styles.js")().CSS,
    STYLE_ID: "@super-agent/dsh-bridge/client.css",
  });
  const services = chunkFactories.get("client.services.js")().createServices();
  const shell = chunkFactories.get("client.shell.js")().createShell({ kernel, services, views: {}, blocks: { set() {} } });
  const parts = { ActionBtn: shell.ActionBtn };
  const runPanel = chunkFactories.get("client.run-panel.js")().createRunPanel({ kernel, services, parts });
  const offline = chunkFactories.get("client.offline.js")().createOffline({ kernel, services, parts });
  const main = chunkFactories.get("client.main.js")().createMainView({ kernel, services, parts });
  Object.assign(parts, {
    RunPanel: runPanel.RunPanel,
    OfflineNotice: offline.OfflineNotice,
    OfflinePanel: offline.OfflinePanel,
    CoreStatusCard: main.CoreStatusCard,
    RecoveryCard: main.RecoveryCard,
  });
  for (const module of [shell, main, runPanel, offline]) services.registerFixtures(module.demoFixture);
  // The real entry merges every module's slice into one namespace; the tab
  // reads shell-owned keys (field.*, value.*, delegation.*) as well as its own.
  const t = translate(mergeDictionaries([shell, main, runPanel, offline]).zh);
  shell.bindTranslate(t);
  return { kernel, services, shell, main, runPanel, offline, parts, t };
}

/** Read the three composer chips registered by the shell. */
function composerElements(shell, t) {
  const registrations = new Map(shell.registrations.map((registration) => [registration.slot, registration.component]));
  const slots = {
    model: "conversation.input.model",
    thinking: "conversation.input.left",
    permission: "conversation.input.permission",
  };
  return Object.fromEntries(
    Object.entries(slots).map(([name, slot]) => {
      const component = registrations.get(slot);
      const tree = renderTree(component, { t });
      const node = elementsOf(tree).find((element) => element.props?.["data-composer"] === name);
      return [name, { node, tree }];
    }),
  );
}

function composerReadouts(shell, t) {
  return Object.fromEntries(
    Object.entries(composerElements(shell, t)).map(([name, { node }]) => [name, node === undefined ? "" : textOf(node)]),
  );
}

/** Merge the modules' dictionary slices the way the entry does. */
function mergeDictionaries(modules) {
  const zh = {};
  const en = {};
  for (const module of modules) {
    Object.assign(zh, { ...module.dictionary.zh, ...zh });
    Object.assign(en, { ...module.dictionary.en, ...en });
  }
  return { zh, en };
}

function fakeRequire(specifier) {
  if (specifier === "react") return fakeReact();
  throw new Error(`unexpected require: ${specifier}`);
}

/** A translator over one dictionary, resolving `{name}` placeholders. */
function translate(dictionary) {
  return (key, params) => {
    const raw = dictionary[key];
    if (raw === undefined) return key;
    return raw.replace(/\{(\w+)\}/g, (match, name) =>
      params && Object.hasOwn(params, name) ? String(params[name]) : match,
    );
  };
}

/** The props the tab receives from its seat. */
function tabProps(t) {
  return { t };
}

describe("the Run & session tab", () => {
  it("keeps the two dictionaries in step", () => {
    const { main } = buildMain();
    expect(Object.keys(main.dictionary.en).sort()).toEqual(Object.keys(main.dictionary.zh).sort());
  });

  it("offers a keyboard-operable disclosure on the Run, snapshot, delegation and recovery areas", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.setDemo(true);
    const controls = disclosureControls(main.RunSessionTab, tabProps(t));
    // The areas the acceptance case names, each foldable from its own title —
    // plus the Threads card, which lists what the Core holds, and the session
    // card, which names which dsh session this panel belongs to — and the Core
    // card, which the case does not name, is not foldable.
    expect([...controls.keys()].sort()).toEqual(["delegations", "run", "session", "snapshot", "threads"]);
    for (const [id, control] of controls) {
      expect(control.props["aria-expanded"], id).toBe(true);
      expect(control.props["aria-controls"], id).toBe(`${id}-body`);
    }
  });

  it("folds an area on the toggle and unfolds it again", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.setDemo(true);
    const { controls, bodies } = disclosureParts(main.RunSessionTab, tabProps(t));
    const snapshot = controls.get("snapshot");
    expect(bodies.get("snapshot").props.hidden).toBe(false);

    snapshot.props.onClick();
    const after = disclosureParts(main.RunSessionTab, tabProps(t), { rerender: true });
    expect(after.controls.get("snapshot").props["aria-expanded"]).toBe(false);
    expect(after.bodies.get("snapshot").props.hidden).toBe(true);
  });

  it("gives the disconnected layout's recovery and Run areas the same disclosure", () => {
    const { main, services, t } = buildMain();
    services.setConnection("offline");
    const controls = disclosureControls(main.RunSessionTab, tabProps(t));
    expect([...controls.keys()].sort()).toEqual(["recovery", "run"]);
  });

  it("shows no Run, snapshot or delegation while demo is off", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("当前 Run");
    expect(text).toContain("无活动 Run");
    // The snapshot card reads the host's state, and this session has no
    // Conversation yet — so that is what it says. An absent demo fixture is not
    // evidence about the link, and the card must not claim the Core is down on
    // the strength of it.
    expect(text).toContain("这个会话还没有 Core Conversation，没有配置快照可读。");
    expect(text).not.toContain("未连接 Core，读不到会话配置快照。");
    // The delegation card has no read to draw from at all, and says that rather
    // than blaming a link that is up.
    expect(text).toContain("还没有可读的子 Agent 委派信息");
    expect(text).not.toContain("未连接 Core，读不到子 Agent 委派。");
    expect(text).not.toContain("go-main");
    expect(text).not.toContain("researcher");
  });

  it("claims the Core is not connected on the delegation card only when it is not", () => {
    const { main, services, t } = buildMain();
    services.setConnection("offline");
    expect(render(main.DelegationsCard, tabProps(t))).toContain("未连接 Core，读不到子 Agent 委派。");
    services.setConnection("ready");
    const text = render(main.DelegationsCard, tabProps(t));
    expect(text).toContain("还没有可读的子 Agent 委派信息");
    expect(text).not.toContain("未连接 Core");
  });

  /**
   * The snapshot card over a state the caller sets.
   *
   * The card is drawn on its own rather than through the tab, because the states
   * it can be in are about this one card: the connection, the session's
   * Conversation and what the host read for it.
   */
  function snapshotOver(patch) {
    const built = buildMain();
    built.services.setConnection("ready");
    built.services.viewState.set(patch);
    return { ...built, text: render(built.main.SnapshotCard, tabProps(built.t)) };
  }

  it("draws the config the host read for this session's Conversation", () => {
    const { text } = snapshotOver({
      sessionId: "dsh-session-5",
      threadId: "thread-7",
      conversationId: "29",
      mainConversationId: "29",
      snapshot: {
        sessionId: "dsh-session-5",
        conversationId: "29",
        agentId: "main",
        agentRevision: "agent-rev-2",
        configRevision: "config-rev-3",
        config: {
          provider: "super-agent",
          modelId: "go-main",
          thinkingLevel: "high",
          permissionMode: "workspace_auto",
          skillRoots: ["/skills/one", "/skills/two"],
        },
      },
    });
    expect(text).toContain("提供方");
    expect(text).toContain("super-agent");
    expect(text).toContain("go-main");
    expect(text).toContain("high");
    expect(text).toContain("workspace_auto");
    expect(text).toContain("/skills/one · /skills/two");
    expect(text).toContain("config-rev-3");
    // The value is the Core's provider, and it is labelled as the provider.
    expect(text).not.toContain("profile");
    expect(text).not.toContain("未连接 Core");
  });

  it("shows persisted model capabilities with their source and untested notice", () => {
    const { text } = snapshotOver({
      sessionId: "dsh-session-capabilities",
      threadId: "thread-capabilities",
      conversationId: "conversation-capabilities",
      snapshot: {
        sessionId: "dsh-session-capabilities",
        conversationId: "conversation-capabilities",
        agentId: "main",
        config: {
          modelId: "fixed-model",
          modelCapabilities: {
            input: ["text", "image"],
            tools: true,
            thinking: true,
            toolResultImages: "native",
            source: "pi-1.3.0-and-protocol",
          },
        },
      },
    });

    expect(text).toContain("声明能力");
    expect(text).toContain("input: text, image · tools: true · thinking: true · toolResultImages: native");
    expect(text).toContain("能力来源");
    expect(text).toContain("pi-1.3.0-and-protocol");
    expect(text).toContain("能力来自固定配置声明，未在本会话中逐项实测。");
  });

  it("leaves capabilities unknown for an older snapshot without a stored declaration", () => {
    const { text } = snapshotOver({
      sessionId: "dsh-session-legacy-capabilities",
      threadId: "thread-legacy-capabilities",
      conversationId: "conversation-legacy-capabilities",
      snapshot: {
        sessionId: "dsh-session-legacy-capabilities",
        conversationId: "conversation-legacy-capabilities",
        agentId: "main",
        config: { modelId: "legacy-model" },
      },
    });

    expect(text).toContain("声明能力");
    expect(text).toContain("能力来源");
    expect(text).toContain("未知");
    expect(text).not.toContain("input:");
    expect(text).not.toContain("pi-1.3.0-and-protocol");
    expect(text).not.toContain("operator_declared");
  });

  it("says it is still reading rather than that the Core is unreachable", () => {
    const { text } = snapshotOver({ sessionId: "dsh-session-5", threadId: "thread-7", conversationId: "29" });
    // The host has not answered with a config yet. That is not a Core that is
    // down, and it is not a session without a Conversation either.
    expect(text).toContain("正在读取这个会话的配置快照");
    expect(text).not.toContain("未连接 Core");
    expect(text).not.toContain("没有配置快照可读");
  });

  it("says this session has no Conversation rather than that the Core is unreachable", () => {
    const { text } = snapshotOver({ sessionId: "dsh-session-5", threadId: null, conversationId: null });
    expect(text).toContain("这个会话还没有 Core Conversation，没有配置快照可读。");
    expect(text).not.toContain("未连接 Core");
  });

  it("names a config read that failed as its own failure, without failing the session's identity", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.viewState.set({
      sessionId: "dsh-session-6",
      threadId: "thread-7",
      conversationId: "29",
      mainConversationId: "29",
      snapshotError: { code: "NOT_FOUND", message: "no such Conversation" },
    });
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("这个会话的配置快照读不到");
    expect(text).toContain("no such Conversation");
    // The link is up, the identity is known and the Threads are listed: one read
    // failing is not the whole answer failing, and it is not the Core being down.
    expect(text).toContain("dsh-session-6");
    expect(text).toContain("thread-7");
    // The snapshot's own offline text is not what this is, whatever the sibling
    // cards say: a config read that failed is named as that.
    expect(text).not.toContain("未连接 Core，读不到会话配置快照。");
  });

  it("shows a config read for another Session as still reading, not as this session's", () => {
    const { text } = snapshotOver({
      sessionId: "dsh-session-7",
      threadId: "thread-7",
      conversationId: "29",
      snapshot: {
        sessionId: "dsh-session-other",
        conversationId: "29",
        agentId: "main",
        config: { provider: "someone-else", modelId: "go-main" },
      },
    });
    // A configuration belongs to the conversation it describes: one read for a
    // session that is no longer on screen is not drawn under this session's name.
    expect(text).not.toContain("someone-else");
    expect(text).toContain("正在读取这个会话的配置快照");
  });

  it("shows a config read for another Conversation as still reading", () => {
    const { text } = snapshotOver({
      sessionId: "dsh-session-7",
      threadId: "thread-7",
      conversationId: "29",
      snapshot: {
        sessionId: "dsh-session-7",
        conversationId: "77",
        agentId: "main",
        config: { provider: "the-branch", modelId: "go-main" },
      },
    });
    expect(text).not.toContain("the-branch");
    expect(text).toContain("正在读取这个会话的配置快照");
  });

  it("claims the Core is not connected only when it really is not", () => {
    const { main, services, t } = buildMain();
    services.setConnection("offline");
    const offline = render(main.SnapshotCard, tabProps(t));
    expect(offline).toContain("未连接 Core，读不到会话配置快照。");

    services.setConnection("ready");
    services.viewState.set({ sessionId: "dsh-session-8", conversationId: "29" });
    const ready = render(main.SnapshotCard, tabProps(t));
    expect(ready).not.toContain("未连接 Core");
  });

  it("supplements the Run on screen, naming it and the Conversation it writes into", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.viewState.set({
      sessionId: "dsh-session-9",
      threadId: "thread-7",
      conversationId: "77",
      mainConversationId: "29",
      run: {
        runId: "run-7",
        threadId: "thread-7",
        conversationId: "77",
        status: "running",
        endReason: null,
        answer: null,
        waitingCount: 0,
        elapsed: "00:12",
        turns: [],
      },
    });
    const props = tabProps(t);
    const sent = [];
    services.run = (id, payload) => {
      // The card also reads the fork boundaries and the Thread's history through
      // the facade; only the supplement is what this check is about.
      if (id === "messages.list" || id === "thread.get" || id === "turns.list") {
        return Promise.resolve({ status: "done", reason: null, result: { items: [] } });
      }
      sent.push({ id, payload });
      return Promise.resolve({ status: "pending", reason: null, result: null });
    };
    // Draw, type, draw again over the same hook store, then click — the way
    // React would, so the button's payload reads the words just typed.
    const first = renderTree(main.RunSessionTab, props);
    const input = elementsOf(first).find((node) => node.type === "input");
    expect(input, "no supplement input").toBeDefined();
    input.props.onChange({ target: { value: "再看一下" } });
    hookCursor = 0;
    const button = elementsOf(main.RunSessionTab(props)).find(
      (node) => node.type === "button" && textOf(node.props.children).includes("补充到 Run"),
    );
    expect(button, "no supplement control").toBeDefined();
    expect(button.props.disabled).not.toBe(true);
    button.props.onClick();
    // The supplement names the Run on screen and the Conversation it shows,
    // read at the click: one sent to "whatever is active" could land on a Run
    // that ended between the draw and the click.
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe("run.supplement");
    expect(sent[0].payload).toMatchObject({
      threadId: "thread-7",
      text: "再看一下",
      targetRunId: "run-7",
      conversationId: "77",
    });
    expect(sent[0].payload.requestId).toMatch(/^sap-run\.supplement-/);
    // A second click with the same words is the *same* supplement — the retry
    // the id exists for — so it carries the id the first click used, and the
    // same target. Drawn again first, the way React redraws after the first
    // click's state change.
    hookCursor = 0;
    const again = elementsOf(main.RunSessionTab(props)).find(
      (node) => node.type === "button" && textOf(node.props.children).includes("补充到 Run"),
    );
    again.props.onClick();
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.requestId).toBe(sent[0].payload.requestId);
    expect(sent[1].payload.targetRunId).toBe("run-7");
  });

  it("does not give a rebuilt panel's first supplement the id an earlier panel's first one used", () => {
    const built = buildMain();
    const { main, kernel, services, parts, t } = built;
    services.setConnection("ready");
    services.viewState.set({
      sessionId: "dsh-session-9",
      threadId: "thread-7",
      conversationId: "77",
      run: {
        runId: "run-7",
        threadId: "thread-7",
        conversationId: "77",
        status: "running",
        endReason: null,
        answer: null,
        waitingCount: 0,
        elapsed: "00:12",
        turns: [],
      },
    });
    const props = tabProps(t);
    const sent = [];
    services.run = (id, payload) => {
      if (id === "messages.list" || id === "thread.get" || id === "turns.list") {
        return Promise.resolve({ status: "done", reason: null, result: { items: [] } });
      }
      sent.push({ id, payload });
      return Promise.resolve({ status: "pending", reason: null, result: null });
    };
    // One click on one panel, over words for one Run. This is the shape the
    // Core's ledger is keyed by — the Thread and the request id — so a second
    // panel whose first supplement minted the same id would not be sending a
    // second supplement at all: it would be asking the Core to repeat the first
    // one's acceptance.
    const click = () => {
      hookCursor = 0;
      const input = elementsOf(main.RunSessionTab(props)).find((node) => node.type === "input");
      expect(input, "no supplement input").toBeDefined();
      input.props.onChange({ target: { value: "同一句话" } });
      hookCursor = 0;
      const button = elementsOf(main.RunSessionTab(props)).find(
        (node) => node.type === "button" && textOf(node.props.children).includes("补充到 Run"),
      );
      expect(button, "no supplement control").toBeDefined();
      expect(button.props.disabled).not.toBe(true);
      button.props.onClick();
    };
    click();
    expect(sent).toHaveLength(1);
    // A *different* panel — the card rebuilt, the way a remount or a second
    // window builds one — over the same words and the same Run. Its id must not
    // be the first panel's: an id counted inside the card restarts at one, and
    // two different supplements would then be one command.
    const rebuilt = chunkFactories
      .get("client.run-panel.js")()
      .createRunPanel({ kernel, services, parts });
    parts.RunPanel = rebuilt.RunPanel;
    // A remount, not a redraw: `renderTree` gives the card a fresh hook store,
    // which is what a rebuilt card really starts from. (Redrawing over the same
    // store would keep the first panel's held id, and the retry rule would hand
    // it back — which is right for a retry and wrong for a new panel.)
    renderTree(main.RunSessionTab, props);
    click();
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.requestId).not.toBe(sent[0].payload.requestId);
    // The same words into a *different* Run are a different supplement too, and
    // the card says so by minting for it rather than by reusing what is held.
    services.viewState.set({
      sessionId: "dsh-session-9",
      threadId: "thread-7",
      conversationId: "77",
      run: {
        runId: "run-8",
        threadId: "thread-7",
        conversationId: "77",
        status: "running",
        endReason: null,
        answer: null,
        waitingCount: 0,
        elapsed: "00:12",
        turns: [],
      },
    });
    click();
    expect(sent).toHaveLength(3);
    expect(sent[2].payload.requestId).not.toBe(sent[1].payload.requestId);
    expect(sent[2].payload.targetRunId).toBe("run-8");
  });

  it("offers no supplement when no Run is on screen, and says why", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("无活动 Run");
    expect(text).toContain("补充必须点名一个活动 Run");
    // There is nothing to press: a supplement with no target is refused by the
    // Core, and sending it as a new Run instead is what the design forbids.
    expect(text).not.toContain("补充到 Run");
  });

  it("shows the supplement's receipt as the ids and the delivery the Core named", () => {
    const built = buildMain();
    const outcomes = {
      "run.supplement": {
        status: "done",
        reason: null,
        result: {
          requestId: "sap-supplement-1",
          resourceId: "input-9",
          state: "accepted",
          receiptSeq: 7,
          inputId: "input-9",
          runId: "run-7",
          delivery: "next_turn",
        },
      },
    };
    // The card reads four things from the facade, so a stand-in with those four
    // draws one outcome the real path reaches only through a transport that
    // answered. The card is rebuilt over it, because a card closes over the
    // facade it was created with.
    const services = {
      viewState: built.services.viewState,
      fixture: () => null,
      outcomeOf: (id) => outcomes[id] ?? { status: "idle", reason: null, result: null },
      subscribeOutcomes: () => () => {},
      run: () => Promise.resolve({ status: "pending", reason: null, result: null }),
    };
    const panel = chunkFactories
      .get("client.run-panel.js")()
      .createRunPanel({ kernel: built.kernel, services, parts: built.parts });
    built.services.viewState.set({
      connection: "ready",
      sessionId: "dsh-session-9",
      threadId: "thread-7",
      conversationId: "77",
      run: {
        runId: "run-7",
        threadId: "thread-7",
        conversationId: "77",
        status: "running",
        waitingCount: 0,
        elapsed: "00:12",
        turns: [],
      },
    });
    const text = render(panel.RunPanel, { t: built.t });
    // The receipt is the Core's own answer: the input the words became, the
    // delivery it actually used and the Run they went to.
    expect(text).toContain("补充回执：inputId input-9 · 投递 next_turn · Run run-7 · 状态 accepted");
  });

  it("offers the Conversation's own persisted entries as the fork boundary, and sends the one chosen", async () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.viewState.set({
      sessionId: "dsh-session-9",
      threadId: "thread-7",
      conversationId: "77",
      run: {
        runId: "run-7",
        threadId: "thread-7",
        conversationId: "77",
        status: "running",
        endReason: null,
        answer: null,
        waitingCount: 0,
        elapsed: "00:12",
        turns: [],
      },
    });
    const props = tabProps(t);
    const sent = [];
    services.run = (id, payload) => {
      sent.push({ id, payload });
      if (id === "messages.list") {
        return Promise.resolve({
          status: "done",
          reason: null,
          result: {
            items: [
              { entryId: 3, role: "user", text: "hello" },
              { entryId: 7, role: "assistant", text: "hi" },
              // No entry: a projection the Core has not placed in the history
              // is not an address a fork can be taken at, so it is not offered.
              { entryId: null, role: "assistant", text: "still arriving" },
            ],
          },
        });
      }
      return Promise.resolve({ status: "pending", reason: null, result: null });
    };
    renderTree(main.RunSessionTab, props);
    // Draw once so the card's effect starts the read — the nested components run
    // when the tree is walked, not when the top one is called — then let the
    // promise settle, which is when the entries arrive.
    const buttonsNow = () => {
      hookCursor = 0;
      return elementsOf(main.RunSessionTab(props)).filter((node) => node.type === "button");
    };
    buttonsNow();
    await Promise.resolve();
    await Promise.resolve();
    const buttons = buttonsNow();
    const forkOf = (found) => found.find((node) => textOf(node.props.children).includes("Fork"));
    // Nothing is chosen, so nothing can be forked: the Core requires the entry,
    // and this card will not pick one for the user.
    expect(forkOf(buttons).props.disabled).toBe(true);
    expect(textOf(main.RunSessionTab(props))).toContain("未选择");
    // The read is the Conversation on screen, and its own entry ids are what is
    // offered — not a count this half keeps.
    expect(sent.find((call) => call.id === "messages.list").payload).toMatchObject({ conversationId: "77" });
    const entry = buttons.find((node) => textOf(node.props.children).includes("entry 7"));
    expect(entry, "no boundary for entry 7").toBeDefined();
    expect(buttons.some((node) => textOf(node.props.children).includes("still arriving"))).toBe(false);

    entry.props.onClick();
    const chosen = buttonsNow();
    expect(forkOf(chosen).props.disabled).not.toBe(true);
    forkOf(chosen).props.onClick();
    // The chosen entry and the Conversation on screen travel with the click.
    expect(sent.find((call) => call.id === "run.fork").payload).toEqual({
      conversationId: "77",
      sourceEntryId: 7,
    });
  });

  it("says a fork's branch point as the Core reported it, beside the one chosen", () => {
    const built = buildMain();
    const outcomes = {
      "run.fork": {
        status: "done",
        reason: null,
        result: { sessionId: "session-2", threadId: "thread-1", conversationId: "77", inheritedThrough: 7 },
      },
    };
    const services = {
      viewState: built.services.viewState,
      fixture: () => null,
      outcomeOf: (id) => outcomes[id] ?? { status: "idle", reason: null, result: null },
      subscribeOutcomes: () => () => {},
      run: () => Promise.resolve({ status: "pending", reason: null, result: null }),
      requestId: () => "sap-run.supplement-x",
    };
    const panel = chunkFactories
      .get("client.run-panel.js")()
      .createRunPanel({ kernel: built.kernel, services, parts: built.parts });
    built.services.viewState.set({
      connection: "ready",
      sessionId: "dsh-session-9",
      threadId: "thread-7",
      conversationId: "77",
      run: {
        runId: "run-7",
        threadId: "thread-7",
        conversationId: "77",
        status: "running",
        waitingCount: 0,
        elapsed: "00:12",
        turns: [],
      },
    });
    const text = render(panel.RunPanel, { t: built.t });
    // The Core's own `inheritedThrough` is drawn next to the fork's ids: the
    // branch point it actually took is visible, rather than assumed to be the
    // one that was asked for.
    expect(text).toContain("分支点 entry 7");
  });

  it("names the session, its Thread and its Conversation as the ids they are", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.viewState.set({
      sessionId: "dsh-session-1",
      threadId: "thread-7",
      conversationId: "29",
      mainConversationId: "29",
    });
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("当前会话归属");
    expect(text).toContain("dsh-session-1");
    expect(text).toContain("thread-7");
    expect(text).toContain("29");
    // The Threads card below is the whole home, and the panel says so rather
    // than letting its rows read as this session's own.
    expect(text).toContain("下面的 Thread 列表是整个 home 的全部 Thread");
  });

  it("says a forked session reads a branch Conversation, not the Thread's own", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.viewState.set({
      sessionId: "dsh-session-2",
      threadId: "thread-7",
      conversationId: "77",
      mainConversationId: "29",
    });
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("77");
    expect(text).toContain("这是 fork 出来的分支会话");
    expect(text).not.toContain("下面的 Thread 列表是整个 home 的全部 Thread");
  });

  it("says a session has no Thread yet instead of borrowing the newest one", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.viewState.set({ sessionId: "dsh-session-3", threadId: null, conversationId: null });
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("dsh-session-3");
    expect(text).toContain("这个会话还没有 Thread");
  });

  it("names an unreadable record as its own failure instead of claiming no Thread", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.viewState.set({
      sessionId: "dsh-session-4",
      threadId: null,
      sessionError: { code: "INTERNAL", message: "the session map is not an object" },
    });
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("the session map is not an object");
    // "This session has no Thread yet" would be a claim the bridge cannot make
    // while the record that would say so cannot be read.
    expect(text).not.toContain("这个会话还没有 Thread");
  });

  it("draws the connected layout in the design's order once demo is on", () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.setDemo(true);
    const text = render(main.RunSessionTab, tabProps(t));

    for (const expected of [
      "Core 进程",
      "配置目录",
      "Socket",
      "恢复结果",
      "当前 Run",
      "Turn 1 · 完成 · 2 次工具",
      "Turn 3 · 流式输出",
      "会话配置快照",
      // The provider is labelled as the provider: the design's `profile` was a
      // name for a different value than the one the Core reports.
      "提供方",
      "super-agent",
      "skillRoots",
      "子 Agent 委派",
      "researcher",
    ]) {
      expect(text, expected).toContain(expected);
    }

    // The connected layout is Core, Run, snapshot, delegations — in that order.
    const order = ["Core 进程", "当前 Run", "会话配置快照", "子 Agent 委派"].map((label) => text.indexOf(label));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("hands the disconnected layout to the offline module", () => {
    const { main, services, t } = buildMain();
    services.setConnection("offline");
    const text = render(main.RunSessionTab, tabProps(t));
    // The offline composition is Core, recovery, Run — the recovery card is the
    // one the connected layout does not show.
    expect(text).toContain("恢复与阻塞");
    expect(text).not.toContain("会话配置快照");
    const order = ["Core 进程", "恢复与阻塞", "当前 Run"].map((label) => text.indexOf(label));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("states that no Core state has been read yet rather than claiming a failed attempt", () => {
    const { main, services, t } = buildMain();
    services.setConnection("offline");
    const text = render(main.RunSessionTab, tabProps(t));
    // Before the host answers, the card says exactly that. It does not claim a
    // connection attempt that never happened — the design's sample error shows
    // only while demo is on.
    expect(text).toContain("还没有读到 Core 的连接状态");
    expect(text).not.toContain("ENOENT");
  });

  it("draws the design's connection error only while demo is on", () => {
    const { main, services, t } = buildMain();
    services.setConnection("offline");
    services.setDemo(true);
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("connect ENOENT ~/.super-agent/run/core.sock");
  });

  it("leaves out a card whose module did not load instead of failing the tab", () => {
    const { main, services, parts, t } = buildMain();
    services.setConnection("ready");
    delete parts.RunPanel;
    const text = render(main.RunSessionTab, tabProps(t));
    expect(text).toContain("Core 进程");
    expect(text).toContain("会话配置快照");
    expect(text).toContain("子 Agent 委派");
    expect(text).not.toContain("当前 Run");
  });

  it("reports a Core action as unsupported instead of a success", async () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.setDemo(true);
    const tree = renderTree(main.RunSessionTab, tabProps(t));
    const restart = elementsOf(tree).find(
      (node) => node.type === "button" && textOf(node.props.children).includes("重启 Core"),
    );
    expect(restart, "no restart control").toBeDefined();
    restart.props.onClick();
    await Promise.resolve();
    expect(services.outcomeOf("core.restart").status).toBe("unsupported");
  });

  it("keeps a delegation's own action id, so two rows do not share one outcome", async () => {
    const { main, services, t } = buildMain();
    services.setConnection("ready");
    services.setDemo(true);
    const tree = renderTree(main.RunSessionTab, tabProps(t));
    const cancel = elementsOf(tree).find(
      (node) => node.type === "button" && textOf(node.props.children).includes("取消"),
    );
    expect(cancel).toBeDefined();
    cancel.props.onClick();
    await Promise.resolve();
    expect(services.outcomeOf("delegation.cancel:researcher").status).toBe("unsupported");
  });
});

describe("the composer shows the selected Session's fixed Core binding", () => {
  it("reads a read-only fixed binding and clears stale values on Session or Conversation switch", () => {
    const { services, shell, t } = buildMain();
    services.setConnection("ready");
    const originalSnapshot = {
      sessionId: "session-fixed",
      conversationId: "conversation-fixed",
      config: {
        modelId: "exactmodel",
        thinkingLevel: "high",
        permissionMode: "approve_none",
      },
    };
    services.viewState.set({
      sessionId: "session-fixed",
      conversationId: "conversation-fixed",
      snapshot: originalSnapshot,
    });

    expect(composerReadouts(shell, t)).toEqual({
      model: "exactmodel",
      thinking: "thinking · high",
      permission: "approve_none",
    });

    // These are fixed-binding readouts. They must not expose any control that
    // could silently change the Core configuration from the composer.
    const elements = composerElements(shell, t);
    for (const { node, tree } of Object.values(elements)) {
      expect(node.type).toBe("span");
      expect(elementsOf(tree).some((element) => ["button", "input", "select"].includes(element.type))).toBe(false);
    }

    // During a Session switch, the previous snapshot can still be in client
    // state while the new read is pending. Its values do not belong to the new
    // selected Session even before the host clears the snapshot.
    services.viewState.set({
      sessionId: "session-next",
      conversationId: "conversation-next",
      snapshot: originalSnapshot,
    });
    expect(composerReadouts(shell, t)).toEqual({
      model: "模型未知",
      thinking: "thinking · 未知",
      permission: "未知",
    });

    // A fork can change the Conversation within the same Session. A snapshot
    // from the parent Conversation is stale for that branch as well.
    services.viewState.set({
      sessionId: "session-fixed",
      conversationId: "conversation-fork",
      snapshot: originalSnapshot,
    });
    expect(composerReadouts(shell, t)).toEqual({
      model: "模型未知",
      thinking: "thinking · 未知",
      permission: "未知",
    });

    services.viewState.set({ sessionId: "session-next", conversationId: "conversation-next", snapshot: null });
    expect(composerReadouts(shell, t)).toEqual({
      model: "模型未知",
      thinking: "thinking · 未知",
      permission: "未知",
    });
  });
});

describe("the history a finished Run leaves behind", () => {
  /**
   * A tab whose Thread holds finished work and whose Conversation has history.
   *
   * `run: null` is the state the milestone is about: the Core has no active Run,
   * and the card used to have nothing left to say but "No active Run".
   *
   * Every draw walks the tree from the top with the hook cursor reset, because
   * the nested cards are only called when the tree is walked — which is also
   * when their effects run. The hook *store* is carried forward; only the cursor
   * is reset, so a second draw sees what the first one's reads answered.
   */
  function historyTab({ runs, messages, turns, messagesAnswer, threadAnswer, turnsAnswer, run } = {}) {
    const built = buildMain();
    const { main, services, t } = built;
    services.setConnection("ready");
    services.viewState.set({
      sessionId: "dsh-session-9",
      threadId: "thread-7",
      conversationId: "77",
      eventSeq: 10,
      run: run ?? null,
    });
    const sent = [];
    services.run = (id, payload) => {
      sent.push({ id, payload });
      if (id === "thread.get") {
        if (typeof threadAnswer === "function") return threadAnswer(payload);
        return Promise.resolve(
          threadAnswer ?? {
            status: "done",
            reason: null,
            result: {
              threadId: "thread-7",
              mainConversationId: "77",
              runs: runs ?? [{ runId: "run-1", conversationId: "77", status: "completed" }],
            },
          },
        );
      }
      if (id === "messages.list") {
        if (typeof messagesAnswer === "function") return messagesAnswer(payload);
        return Promise.resolve({
          status: "done",
          reason: null,
          result: {
            items: messages ?? [{ entryId: 3, role: "user", text: "hello" }],
            nextCursor: null,
            watermark: 12,
            caughtUp: true,
          },
        });
      }
      if (id === "turns.list") {
        if (typeof turnsAnswer === "function") return turnsAnswer(payload);
        return Promise.resolve({
          status: "done",
          reason: null,
          result: { items: turns ?? [{ turnId: 1, status: "completed" }], nextCursor: null },
        });
      }
      return Promise.resolve({ status: "pending", reason: null, result: null });
    };
    const props = tabProps(t);
    const draw = () => {
      hookCursor = 0;
      return elementsOf(main.RunSessionTab(props));
    };
    const textNow = () => {
      hookCursor = 0;
      return textOf(main.RunSessionTab(props));
    };
    const buttonsNow = () => draw().filter((node) => node.type === "button");
    const buttonSaying = (text) => buttonsNow().find((node) => textOf(node.props.children).includes(text));
    const settle = async () => {
      for (let step = 0; step < 8; step += 1) await Promise.resolve();
    };
    renderTree(main.RunSessionTab, props);
    // Walk it once so the nested cards' effects start their reads.
    draw();
    return { ...built, sent, draw, textNow, buttonsNow, buttonSaying, settle };
  }

  it("keeps a completed Run reachable from the history entry, with its Redo", async () => {
    const { textNow, buttonSaying, settle, sent } = historyTab();
    await settle();

    // The finished Run is named with the Core's own status, so the entry is
    // there after the Run ended rather than the card falling to "No active Run".
    expect(textNow()).toContain("run-1 · completed");
    // And its Redo is reachable *from that entry* — that is what keeping the
    // entry is for.
    const redo = buttonSaying("重做这个已完成的 Run");
    expect(redo, "no Redo on the history entry").toBeDefined();
    redo.props.onClick();
    await settle();
    expect(sent.find((call) => call.id === "run.redo").payload).toEqual({ runId: "run-1" });
  });

  it("offers no Redo for a Run that has not stopped", async () => {
    // A Run that is still going is acted on by the live card above; a second
    // Redo here would be two controls for one thing, one of them wrong.
    const { textNow, buttonSaying, settle } = historyTab({
      runs: [{ runId: "run-2", conversationId: "77", status: "running" }],
    });
    await settle();
    expect(textNow()).toContain("run-2 · running");
    expect(buttonSaying("重做这个已完成的 Run")).toBeUndefined();
  });

  it("pages the Conversation by the Core's own cursor, and reports the Core's own watermark and caughtUp", async () => {
    // Both of the page's own facts are drawn as they came, and the next page is
    // asked for with the cursor the Core gave. The two axes are kept apart: the
    // cursor says whether another page of *messages* exists, `caughtUp` says the
    // projection has caught up with the transcript — which is why the second
    // page is reached with the cursor, and the end of the pages is stated from
    // the cursor being absent rather than from `caughtUp`.
    const pages = [
      {
        status: "done",
        reason: null,
        result: {
          items: [{ entryId: 3, role: "user", text: "hello" }],
          nextCursor: "c9",
          watermark: 12,
          caughtUp: false,
        },
      },
      {
        status: "done",
        reason: null,
        result: {
          items: [{ entryId: 1, role: "user", text: "later" }],
          nextCursor: null,
          watermark: 9,
          caughtUp: true,
        },
      },
    ];
    let read = 0;
    const { textNow, buttonSaying, settle, sent } = historyTab({
      messagesAnswer: () => Promise.resolve(pages[Math.min(read++, pages.length - 1)]),
    });
    await settle();

    // One page in, the Core still offers a cursor and has not said it is caught
    // up: the card says both, and offers the next page rather than claiming the
    // end.
    const first = textNow();
    expect(first).toContain("游标 c9 · 水位 12 · 已读 1 条");
    expect(first).not.toContain("Core 报 caughtUp");
    expect(first).not.toContain("已读到最后一条");
    expect(first).toContain("user · hello");
    // The cursor the Core gave is the offset *after* this page, so the page it
    // names is the later one — the control says so.
    const more = buttonSaying("加载后续消息");
    expect(more, "no load-more control").toBeDefined();

    more.props.onClick();
    await settle();
    // The next read carries the cursor the Core gave, unchanged.
    const listed = sent.filter((call) => call.id === "messages.list");
    expect(listed[listed.length - 1].payload).toEqual({ conversationId: "77", limit: 20, cursor: "c9" });
    // The second page is appended and its own watermark is drawn; the pages are
    // now exhausted (no cursor), and the projection is caught up — each said by
    // its own fact.
    const second = textNow();
    expect(second).toContain("later");
    expect(second).toContain("水位 9");
    expect(second).toContain("已读到最后一条");
    expect(second).toContain("Core 报 caughtUp");
    expect(buttonSaying("加载后续消息")).toBeUndefined();
  });

  it("does not call a page the end of the Conversation just because the projection is caught up", async () => {
    // The Core's `caughtUp` is the projection having reached Pi's transcript,
    // and it is independent of pagination: a first page can be caught up and
    // still have later pages. Drawing it as "the Conversation has been read to
    // the end" would state the end of the messages from a fact that says
    // nothing about pages.
    const { textNow, buttonSaying, settle } = historyTab({
      messagesAnswer: () =>
        Promise.resolve({
          status: "done",
          reason: null,
          result: {
            items: [{ entryId: 3, role: "user", text: "hello" }],
            nextCursor: "c9",
            watermark: 12,
            caughtUp: true,
          },
        }),
    });
    await settle();

    const text = textNow();
    expect(text).toContain("Core 报 caughtUp");
    expect(text).toContain("投影已追平至水位 12");
    expect(text).not.toContain("已读到最后一条");
    expect(buttonSaying("加载后续消息"), "the later page was dropped").toBeDefined();
  });

  it("re-reads the Thread's Runs when the host's account of the session moves", async () => {
    // Keyed only on the Thread, the first read would be the last: a Run that
    // progresses or stops on the same Thread would never be read again. The
    // host's own account of the session is a state event the card already sees,
    // and the history is read again on it.
    // The Core's view of the Thread, as the test moves it: both the history and
    // the controls read this one answer, which is what makes them agree.
    let runs = [{ runId: "run-2", conversationId: "77", status: "running" }];
    const liveRun = (status, turns) => ({
      runId: "run-2",
      threadId: "thread-7",
      conversationId: "77",
      status,
      turns,
      waitingCount: 0,
      elapsed: "0s",
    });
    const { services, draw, textNow, settle } = historyTab({
      // The Run is live from the first draw, so the layout does not change when
      // the host's account of it does.
      run: liveRun("running", []),
      threadAnswer: () =>
        Promise.resolve({
          status: "done",
          reason: null,
          result: { threadId: "thread-7", mainConversationId: "77", runs },
        }),
    });
    await settle();
    expect(textNow()).toContain("run-2 · running");

    // The same Run reports a Turn and stops: the host's account moves, and the
    // history is read again rather than frozen at "running".
    runs = [{ runId: "run-2", conversationId: "77", status: "completed" }];
    services.viewState.set({ run: liveRun("completed", [{ n: 1, tools: 0, state: "done" }]) });
    draw();
    await settle();
    expect(textNow()).toContain("run-2 · completed");
  });

  it("re-reads the Runs when the refresh control is used", async () => {
    // The host's account does not move for every commit — a message written
    // while nothing is running is one it cannot see — so the explicit control
    // is the other half of the refresh.
    let runs = [];
    const { textNow, buttonSaying, draw, settle } = historyTab({
      threadAnswer: () =>
        Promise.resolve({
          status: "done",
          reason: null,
          result: { threadId: "thread-7", mainConversationId: "77", runs },
        }),
    });
    await settle();
    expect(textNow()).toContain("该 Thread 还没有 Run。");

    // The Core now holds a Run the first read could not have seen.
    runs = [{ runId: "run-9", conversationId: "77", status: "completed" }];
    buttonSaying("刷新历史").props.onClick();
    // The click moves the card; the walk is what starts the read.
    draw();
    await settle();
    expect(textNow()).toContain("run-9 · completed");
  });

  it("re-reads persisted messages when the Core event sequence advances past an empty first page", async () => {
    let firstPageReads = 0;
    const { services, draw, textNow, settle, sent } = historyTab({
      messagesAnswer: () => {
        firstPageReads += 1;
        return Promise.resolve({
          status: "done",
          reason: null,
          result: firstPageReads === 1
            ? { items: [], nextCursor: null, watermark: 10, caughtUp: true }
            : {
                items: [{ entryId: 11, role: "assistant", text: "arrived after the empty read" }],
                nextCursor: null,
                watermark: 11,
                caughtUp: true,
              },
        });
      },
    });
    await settle();
    expect(textNow()).toContain("该 Conversation 还没有持久消息。");
    expect(sent.filter((call) => call.id === "messages.list")).toHaveLength(1);

    // The Core commits an answer after the empty page was read. Its committed
    // event sequence reaches client state even while no Run is active, and the
    // history starts a fresh first-page read on that revision.
    services.viewState.set({ eventSeq: 11 });
    draw();
    await settle();
    expect(sent.filter((call) => call.id === "messages.list")).toHaveLength(2);
    expect(sent.filter((call) => call.id === "messages.list").at(-1).payload).toEqual({
      conversationId: "77",
      limit: 20,
    });
    expect(textNow()).toContain("assistant · arrived after the empty read");
  });

  it("drops a later-page read when a newer Core event sequence replaces its snapshot", async () => {
    let firstPageReads = 0;
    let releaseLaterPage;
    const laterPage = new Promise((resolve) => { releaseLaterPage = resolve; });
    const { services, draw, textNow, buttonSaying, settle, sent } = historyTab({
      messagesAnswer: (payload) => {
        if (payload.cursor !== undefined) return laterPage;
        firstPageReads += 1;
        return Promise.resolve({
          status: "done",
          reason: null,
          result: firstPageReads === 1
            ? {
                items: [{ entryId: 10, role: "assistant", text: "old snapshot" }],
                nextCursor: "old-page-cursor",
                watermark: 10,
                caughtUp: false,
              }
            : {
                items: [{ entryId: 12, role: "assistant", text: "new snapshot" }],
                nextCursor: null,
                watermark: 12,
                caughtUp: true,
              },
        });
      },
    });
    await settle();
    buttonSaying("加载后续消息").props.onClick();
    await settle();
    const pageReads = sent.filter((call) => call.id === "messages.list");
    expect(pageReads.at(-1).payload).toEqual({
      conversationId: "77",
      limit: 20,
      cursor: "old-page-cursor",
    });

    // A committed event invalidates the snapshot while the older cursor read
    // is in flight. The history restarts at page one, and the late page must
    // not append its contents to the newer snapshot.
    services.viewState.set({ eventSeq: 11 });
    draw();
    await settle();
    expect(textNow()).toContain("new snapshot");
    releaseLaterPage({
      status: "done",
      reason: null,
      result: {
        items: [{ entryId: 11, role: "assistant", text: "stale later page" }],
        nextCursor: null,
        watermark: 11,
        caughtUp: true,
      },
    });
    await settle();
    expect(textNow()).toContain("new snapshot");
    expect(textNow()).not.toContain("stale later page");
  });

  it("offers a Fork from a persisted message entry after the Run has ended", async () => {
    const { sent, buttonSaying, settle } = historyTab({
      messages: [{ entryId: 12, messageId: "message-12", role: "assistant", text: "finished answer" }],
    });
    await settle();

    const fork = buttonSaying("从 entry 12 分支");
    expect(fork, "no Fork control for the selected persisted entry").toBeDefined();
    fork.props.onClick();
    await settle();
    expect(sent.find((call) => call.id === "run.fork").payload).toEqual({
      conversationId: "77",
      sourceEntryId: 12,
    });
  });

  it("drops a page read for a Conversation the card has left", async () => {
    // `loadMore` reads with an `await`, and the card can switch Conversations
    // under it: the page is read for the line that was on screen, and it is
    // written only if that is still the line there.
    let release = null;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { services, draw, textNow, buttonSaying, settle } = historyTab({
      messagesAnswer: (payload) =>
        payload.cursor === undefined
          ? Promise.resolve({
              status: "done",
              reason: null,
              result: {
                items: [{ entryId: 3, role: "user", text: "hello" }],
                nextCursor: "c9",
                watermark: 12,
                caughtUp: false,
              },
            })
          : held.then(() =>
              Promise.resolve({
                status: "done",
                reason: null,
                result: {
                  items: [{ entryId: 1, role: "user", text: "left-behind" }],
                  nextCursor: null,
                  watermark: 9,
                  caughtUp: true,
                },
              }),
            ),
    });
    await settle();
    buttonSaying("加载后续消息").props.onClick();
    await settle();

    // The session moves to another Conversation while that page is in flight.
    services.viewState.set({ conversationId: "88" });
    draw();
    await settle();
    release();
    await settle();

    expect(textNow()).not.toContain("left-behind");
  });

  it("does not draw one Run's Turns under another Run's name when the reads finish out of order", async () => {
    // Two choices, two reads, and the answers can come back in the other order.
    // The late one is read for a Run that is no longer the chosen one, and is
    // dropped rather than drawn as if it were.
    const held = new Map();
    const { textNow, buttonSaying, settle } = historyTab({
      runs: [
        { runId: "run-1", conversationId: "77", status: "completed" },
        { runId: "run-2", conversationId: "77", status: "completed" },
      ],
      turnsAnswer: (payload) => new Promise((resolve) => held.set(payload.runId, resolve)),
    });
    await settle();
    buttonSaying("run-1 · completed").props.onClick();
    await settle();
    buttonSaying("run-2 · completed").props.onClick();
    await settle();

    // The Run chosen last answers first, and the one chosen before it answers
    // after — out of order.
    held.get("run-2")({
      status: "done",
      reason: null,
      result: { items: [{ turnId: 7, status: "completed" }], nextCursor: null },
    });
    await settle();
    held.get("run-1")({
      status: "done",
      reason: null,
      result: { items: [{ turnId: 1, status: "failed" }], nextCursor: null },
    });
    await settle();

    const text = textNow();
    expect(text).toContain("Turn 7 · completed");
    expect(text).not.toContain("Turn 1 · failed");
  });

  it("drills into one Run's Turns from its history row", async () => {
    const { textNow, buttonSaying, settle, sent } = historyTab({
      turns: [
        { turnId: 1, status: "completed" },
        { turnId: 2, status: "failed" },
      ],
    });
    await settle();

    const row = buttonSaying("run-1 · completed");
    expect(row, "no Run row").toBeDefined();
    row.props.onClick();
    await settle();

    expect(sent.find((call) => call.id === "turns.list").payload).toEqual({ runId: "run-1", limit: 50 });
    const text = textNow();
    expect(text).toContain("Turn 1 · completed");
    expect(text).toContain("Turn 2 · failed");
  });

  it("says a Thread whose history cannot be read instead of drawing an empty one", async () => {
    const { textNow, settle } = historyTab({
      threadAnswer: { status: "error", reason: "NOT_FOUND", result: null },
    });
    await settle();
    const text = textNow();
    expect(text).toContain("读不到该 Thread 的历史：NOT_FOUND");
    expect(text).not.toContain("该 Thread 还没有 Run。");
  });
});

describe("the Thread's own controls", () => {
  const threadView = (overrides = {}) => ({
    threadId: "thread-7",
    mainConversationId: "77",
    status: "idle",
    blockingReasons: [],
    controlRevision: 1,
    activeRuns: [],
    queuedRuns: [],
    runs: [],
    queuedInputIds: [],
    pendingInputs: 0,
    pendingWaits: 0,
    activeDelegations: 0,
    pendingDeliveries: 0,
    eventSeq: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  });

  /**
   * The Run card over a facade whose Thread view and action outcomes the test
   * sets, so the controls are read against the Core's own facts.
   *
   * The card closes over the facade it was built with, so the stand-in is built
   * before the panel is — the same shape the supplement's receipt test uses.
   */
  function controlsTab({ view, outcomes = {}, sent = [] } = {}) {
    const built = buildMain();
    built.services.setConnection("ready");
    built.services.viewState.set({
      sessionId: "dsh-session-9",
      threadId: "thread-7",
      conversationId: "77",
      run: null,
    });
    let currentView = view;
    let threadReads = 0;
    const services = {
      viewState: built.services.viewState,
      fixture: () => null,
      outcomeOf: (id) => outcomes[id] ?? { status: "idle", reason: null, result: null },
      subscribeOutcomes: () => () => {},
      run: (id, payload) => {
        sent.push({ id, payload });
        if (id === "thread.get") {
          threadReads += 1;
          const answer = typeof currentView === "function" ? currentView(threadReads) : currentView;
          return Promise.resolve({ status: "done", reason: null, result: answer });
        }
        if (id === "messages.list") {
          return Promise.resolve({
            status: "done",
            reason: null,
            result: { items: [], nextCursor: null, watermark: 0, caughtUp: true },
          });
        }
        return Promise.resolve({ status: "pending", reason: null, result: null });
      },
    };
    // The shell is rebuilt over the stand-in, because `ActionBtn` dispatches
    // through the facade its own shell closed over: built over the real one, a
    // click would leave the test's `sent` empty.
    const shell = chunkFactories
      .get("client.shell.js")()
      .createShell({ kernel: built.kernel, services, views: {}, blocks: { set() {} } });
    shell.bindTranslate(built.t);
    const panel = chunkFactories
      .get("client.run-panel.js")()
      .createRunPanel({ kernel: built.kernel, services, parts: { ActionBtn: shell.ActionBtn } });
    const props = tabProps(built.t);
    const draw = () => {
      hookCursor = 0;
      return elementsOf(panel.RunPanel(props));
    };
    const textNow = () => {
      hookCursor = 0;
      return textOf(panel.RunPanel(props));
    };
    const buttonsNow = () => draw().filter((node) => node.type === "button");
    const buttonSaying = (text) => buttonsNow().find((node) => textOf(node.props.children).includes(text));
    const settle = async () => {
      for (let step = 0; step < 8; step += 1) await Promise.resolve();
    };
    renderTree(panel.RunPanel, props);
    draw();
    return {
      ...built,
      panel,
      sent,
      draw,
      textNow,
      buttonsNow,
      buttonSaying,
      settle,
      setThreadView(next) {
        currentView = next;
      },
      setRun(run) {
        built.services.viewState.set({ run });
      },
      threadReadCount() {
        return threadReads;
      },
    };
  }

  it("draws the Core's own Thread state, and pauses the Thread it names", async () => {
    const { sent, textNow, buttonSaying, settle } = controlsTab({
      view: threadView({ status: "running", blockingReasons: [{ kind: "gate", gate: "permission" }] }),
    });
    await settle();

    // The state a control is offered against is the Core's own view, not a
    // guess this half made.
    const text = textNow();
    expect(text).toContain("Thread 控制");
    expect(text).toContain("running");
    expect(text).toContain("permission");

    const pause = buttonSaying("暂停 Thread");
    expect(pause, "no pause control").toBeDefined();
    expect(pause.props.disabled).not.toBe(true);
    pause.props.onClick();
    await settle();
    expect(sent.find((call) => call.id === "thread.pause").payload).toEqual({ threadId: "thread-7" });
  });

  it("names exactly the work a resume continues, and nothing it was not told to", async () => {
    // The Core's contract: an unlisted Run stays cancelled and an unlisted input
    // stays queued. So the lists sent are the ones the user marked — and with
    // nothing marked there is no instruction to send at all.
    const { sent, textNow, buttonSaying, settle } = controlsTab({
      view: threadView({
        status: "paused_by_user",
        runs: [
          { runId: "run-2", conversationId: "77", status: "cancelled" },
          { runId: "run-1", conversationId: "77", status: "completed" },
        ],
        queuedInputIds: [
          { inputId: "in-1", conversationId: "77" },
          { inputId: "in-2", conversationId: "77" },
        ],
      }),
    });
    await settle();

    buttonSaying("run-2 · cancelled").props.onClick();
    await settle();
    expect(buttonSaying("恢复 Thread").props.disabled).not.toBe(true);
    buttonSaying("恢复 Thread").props.onClick();
    await settle();
    // The Run is named and nothing else is: no empty `queuedInputs` claiming a
    // decision that was never made.
    expect(sent.filter((call) => call.id === "thread.resume").pop().payload).toEqual({
      threadId: "thread-7",
      continueRunIds: ["run-2"],
    });

    // Deciding about one queued input names that one, and only that one.
    buttonSaying("执行").props.onClick();
    await settle();
    buttonSaying("恢复 Thread").props.onClick();
    await settle();
    expect(sent.filter((call) => call.id === "thread.resume").pop().payload).toEqual({
      threadId: "thread-7",
      continueRunIds: ["run-2"],
      queuedInputs: [{ inputId: "in-1", action: "run" }],
    });

    // And the other decision is the other action.
    buttonSaying("丢弃").props.onClick();
    await settle();
    buttonSaying("恢复 Thread").props.onClick();
    await settle();
    expect(sent.filter((call) => call.id === "thread.resume").pop().payload).toEqual({
      threadId: "thread-7",
      continueRunIds: ["run-2"],
      queuedInputs: [{ inputId: "in-1", action: "drop" }],
    });
    // `in-2` was never decided about, so it is never named.
    expect(sent.filter((call) => call.id === "thread.resume").pop().payload.queuedInputs).toHaveLength(1);
  });

  it("says the Core's view names no queued input or stopped Run instead of inventing one", async () => {
    // The locked public shape carries `runs` and `queuedInputIds`; a Core that
    // does not answer with them has not said there are none, and this half has
    // no ids to offer. Saying so is the only honest control.
    const { textNow, settle } = controlsTab({
      view: { threadId: "thread-7", mainConversationId: "77", status: "idle", blockingReasons: [] },
    });
    await settle();
    const text = textNow();
    expect(text).toContain("没有可继续的 Run");
    expect(text).toContain("没有排队输入");
  });

  it("archives the Core Thread", async () => {
    const { sent, buttonSaying, settle } = controlsTab({
      view: threadView(),
    });
    await settle();

    const archive = buttonSaying("归档 Core Thread");
    expect(archive, "no archive control").toBeDefined();
    archive.props.onClick();
    await settle();
    expect(sent.find((call) => call.id === "thread.archive").payload).toEqual({ threadId: "thread-7" });
  });

  it("disables archive when the Core reports an archived Thread", async () => {
    const { buttonSaying, settle } = controlsTab({
      view: threadView({ status: "archived" }),
    });
    await settle();
    expect(buttonSaying("归档 Core Thread").props.disabled).toBe(true);
  });

  it("draws the Core's receipt for each control", async () => {
    const { textNow, settle } = controlsTab({
      view: threadView({ status: "paused_by_user" }),
      outcomes: {
        "thread.pause": {
          status: "done",
          reason: null,
          result: { requestId: "sap-thread.pause-1", resourceId: "thread-7", state: "applied", receiptSeq: 4 },
        },
        "thread.resume": {
          status: "done",
          reason: null,
          result: {
            requestId: "sap-thread.resume-1",
            resourceId: "thread-7",
            state: "applied",
            receiptSeq: 5,
            startedRunIds: ["run-9"],
          },
        },
      },
    });
    await settle();
    const text = textNow();
    expect(text).toContain("暂停 回执：thread-7 · 状态 applied");
    expect(text).toContain("恢复 回执：thread-7 · 状态 applied");
    expect(text).toContain("请求");
    expect(text).toContain("sap-thread.pause-1");
    expect(text).toContain("序号");
    expect(text).toContain("4");
    expect(text).toContain("sap-thread.resume-1");
    expect(text).toContain("5");
    // A resume that started a Run says which one, as the Core named it.
    expect(text).toContain("已启动 Run：run-9");
  });
});
