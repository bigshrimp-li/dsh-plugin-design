import { describe, expect, it } from "vitest";

/**
 * Unit checks for the disconnected half of the interface.
 *
 * Two things are worth pinning here. The notice has to carry what the design
 * puts in it — the reason, the three diagnostic steps and the connection
 * details — without inventing a reason M1 never observed; and the disconnected
 * panel has to be its own composition, built from whichever parts loaded,
 * rather than the connected layout with the fields blanked.
 *
 * The module registers itself into `window.__ModuleLoader__` at module scope,
 * so the fake loader goes in before the dynamic imports. As in the other module
 * tests, React is a hand-written stand-in and the service facade is the real
 * one.
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

/** Minimal React stand-in: element descriptors plus the two hooks the bundle uses. */
function fakeReact() {
  let states = [];
  let cursor = 0;
  const same = (previous, next) =>
    previous !== undefined &&
    next !== undefined &&
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]));
  return {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { type, props: merged };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!Object.hasOwn(states, index)) states[index] = typeof initial === "function" ? initial() : initial;
      return [
        states[index],
        (value) => {
          states[index] = typeof value === "function" ? value(states[index]) : value;
        },
      ];
    },
    useEffect(run, deps) {
      const index = cursor;
      cursor += 1;
      const previous = states[index];
      if (previous !== undefined && same(previous.deps, deps)) return;
      if (previous !== undefined && typeof previous.cleanup === "function") previous.cleanup();
      states[index] = { deps, cleanup: run() };
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

/** Merge the modules' dictionary slices the way the entry does. */
function mergeDictionaries(modules) {
  const zh = {};
  const en = {};
  for (const module of modules.filter((entry) => entry !== undefined)) {
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

/** The props the notice and the panel receive from their seats. */
function tabProps(t) {
  return { t };
}

/**
 * Build the bundle over the real shell, facade and both page modules.
 * @param options.withMain - whether the connected module is present. The entry
 * always loads it when it is, so this is how a partial bundle is exercised.
 */
function buildOffline({ withMain = true } = {}) {
  const kernel = chunkFactories.get("entry")(fakeRequire).createKernel({
    CSS: chunkFactories.get("client.styles.js")().CSS,
    STYLE_ID: "@super-agent/dsh-bridge/client.css",
  });
  const services = chunkFactories.get("client.services.js")().createServices();
  const shell = chunkFactories.get("client.shell.js")().createShell({ kernel, services, views: {}, blocks: { set() {} } });
  const parts = { ActionBtn: shell.ActionBtn };
  const runPanel = chunkFactories.get("client.run-panel.js")().createRunPanel({ kernel, services, parts });
  const offline = chunkFactories.get("client.offline.js")().createOffline({ kernel, services, parts });
  const main = withMain ? chunkFactories.get("client.main.js")().createMainView({ kernel, services, parts }) : undefined;
  Object.assign(parts, {
    RunPanel: runPanel.RunPanel,
    OfflineNotice: offline.OfflineNotice,
    OfflinePanel: offline.OfflinePanel,
    CoreStatusCard: main?.CoreStatusCard,
    RecoveryCard: main?.RecoveryCard,
  });
  for (const module of [shell, main, runPanel, offline]) {
    if (module?.demoFixture !== undefined) services.registerFixtures(module.demoFixture);
  }
  const t = translate(mergeDictionaries([shell, main, runPanel, offline]).zh);
  shell.bindTranslate(t);
  return { kernel, services, shell, main, runPanel, offline, parts, t };
}

describe("the disconnected notice", () => {
  it("keeps the two dictionaries in step", () => {
    const { offline } = buildOffline();
    expect(Object.keys(offline.dictionary.en).sort()).toEqual(Object.keys(offline.dictionary.zh).sort());
  });

  it("draws nothing while Core is connected", () => {
    const { offline, services, t } = buildOffline();
    services.setConnection("ready");
    expect(render(offline.OfflineNotice, tabProps(t))).toBe("");
  });

  it("carries the reason, the three steps and the connection details", () => {
    const { offline, services, t } = buildOffline();
    services.setConnection("offline");
    const text = render(offline.OfflineNotice, tabProps(t));

    expect(text).toContain("Agent Core 未连接");
    // The three diagnostic steps, numbered in order.
    expect(text).toContain("1确认 Core 进程在运行");
    expect(text).toContain("2检查 Socket 路径");
    expect(text).toContain("3重新连接");
    // The connection details the design puts in the footer.
    expect(text).toContain("~/.super-agent");
    expect(text).toContain("run/core.sock");
    expect(text).toContain("autoStart true");
    expect(text).toContain("已尝试 0 次");
  });

  it("states that no Core state has been read rather than the design's sample error", () => {
    const { offline, services, t } = buildOffline();
    services.setConnection("offline");
    const text = render(offline.OfflineNotice, tabProps(t));
    expect(text).toContain("还没有读到 Core 的连接状态");
    expect(text).not.toContain("ENOENT");
    // Nothing was attempted, so the footer must not claim a retry.
    expect(text).toContain("已尝试 0 次");
  });

  it("shows the design's connection error only while demo is on", () => {
    const { offline, services, t } = buildOffline();
    services.setConnection("offline");
    services.setDemo(true);
    expect(render(offline.OfflineNotice, tabProps(t))).toContain("connect ENOENT ~/.super-agent/run/core.sock");
  });

  it("prefers an injected reason over both the fixture and the M1 statement", () => {
    const { offline, services, t } = buildOffline();
    services.setConnection("offline");
    services.setDemo(true);
    const { DEFAULT_STATE } = chunkFactories.get("client.services.js")();
    services.setCore({ ...DEFAULT_STATE.core, error: "EACCES run/core.sock" });
    const text = render(offline.OfflineNotice, tabProps(t));
    expect(text).toContain("EACCES run/core.sock");
    expect(text).not.toContain("ENOENT");
  });

  it("reports each connection action as unsupported, under its own id", async () => {
    const { offline, services, t } = buildOffline();
    services.setConnection("offline");
    const tree = renderTree(offline.OfflineNotice, tabProps(t));
    const buttons = elementsOf(tree).filter((node) => node.type === "button");
    expect(buttons.map((node) => textOf(node.props.children))).toEqual(["重新连接", "启动 Core", "打开配置目录"]);
    for (const button of buttons) button.props.onClick();
    await Promise.resolve();
    for (const id of ["core.reconnect", "core.start", "core.openConfig"]) {
      expect(services.outcomeOf(id).status, id).toBe("unsupported");
    }
  });
});

describe("the disconnected panel", () => {
  it("composes Core, recovery and Run in the design's order", () => {
    const { offline, services, t } = buildOffline();
    services.setConnection("offline");
    const text = render(offline.OfflinePanel, tabProps(t));
    const order = ["Core 进程", "恢复与阻塞", "当前 Run"].map((label) => text.indexOf(label));
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("leaves out a part that did not load instead of drawing an empty card", () => {
    const { offline, services, parts, t } = buildOffline();
    services.setConnection("offline");
    delete parts.RunPanel;
    const text = render(offline.OfflinePanel, tabProps(t));
    expect(text).toContain("Core 进程");
    expect(text).toContain("恢复与阻塞");
    expect(text).not.toContain("当前 Run");
  });

  it("falls back to its own Core card when the connected module is absent", () => {
    const { offline, services, parts, t } = buildOffline({ withMain: false });
    services.setConnection("offline");
    expect(parts.CoreStatusCard).toBeUndefined();
    const text = render(offline.OfflinePanel, tabProps(t));
    expect(text).toContain("Core 进程");
    expect(text).toContain("还没有读到 Core 的连接状态");
    expect(text).not.toContain("ENOENT");
  });
});
