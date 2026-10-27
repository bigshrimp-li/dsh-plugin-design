import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit checks for the bridge's client bundle: the entry, its shell, and the
 * service facade.
 *
 * Each module of the bundle registers itself into `window.__ModuleLoader__` at
 * module scope, so a fake loader is installed before the dynamic imports.
 * Nothing here needs the dsh runtime: React is a hand-written stand-in, and the
 * client context is a recorder.
 *
 * These checks are the bundle's offline evidence. The chunk split itself — that
 * `client.<name>.js` is the only name the host serves, and that `require.async`
 * is the only way to reach it — is a property of the host, not of this code, so
 * it is written up with its source in `docs/requirements/dsh-integration/DSH界面验收.md` and checked against
 * a live dsh rather than modelled here.
 */

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.styles.js");
await import("../../src/client/client.services.js");
await import("../../src/client/client.shell.js");
await import("../../src/client/client.space.js");
await import("../../src/client/client.space-view.js");
await import("../../src/client/client.settings.js");
await import("../../src/client/client.settings-content.js");
await import("../../src/client/client.file-decisions.js");
await import("../../src/client/client.trace.js");
await import("../../src/client/index.js");

/** One registered chunk factory, by the chunk file it was loaded from. */
const chunkFactories = new Map();
for (const definition of loaded) {
  chunkFactories.set(definition.chunk ?? "entry", definition.factory);
}
const entryDefinition = loaded.find((definition) => definition.chunk === undefined);

const activeEntryDisposers = new Set();
const EmptyPrimitive = () => null;
const MenuPrimitive = Object.assign(() => null, {
  Root: EmptyPrimitive, Trigger: EmptyPrimitive, Content: EmptyPrimitive, Item: EmptyPrimitive,
});
const dshPrimitives = new Proxy({ Button: EmptyPrimitive, Menu: MenuPrimitive, Modal: EmptyPrimitive, Tooltip: EmptyPrimitive }, {
  get(target, property) { return target[property] ?? EmptyPrimitive; },
});
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^\/super-agent\//, "");
  if (path.startsWith("state")) return { ok: true, status: 200, json: async () => ({ connection: "ready" }) };
  const { action } = JSON.parse(init.body);
  const result = action === "models.list" ? [] : action === "thread.list" ? { items: [] } : {};
  return { ok: true, status: 200, json: async () => ({ result }) };
};

// #region React stand-in
/** Hook state the stand-in hands back, in call order. */
let hookStates = [];
let hookCursor = 0;

/** Whether two dependency lists would let React skip the effect. */
function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false;
  return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
}

/** Minimal React stand-in: element descriptors plus the two hooks the bundle uses. */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      // Positional children win; an explicit `children` prop survives when there are none.
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
      // An unchanged dependency list is a skipped effect, and a skipped effect
      // keeps its previous cleanup — that is what makes this worth modelling:
      // an effect that raised the composer block on every render would clear and
      // re-raise it forever.
      if (previous !== undefined && sameDeps(previous.deps, deps)) return;
      if (previous !== undefined && typeof previous.cleanup === "function") previous.cleanup();
      hookStates[index] = { deps, cleanup: run() };
    },
  };
}
// #endregion

// #region rendering helpers
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

/** Render one component with a fresh hook store, optionally preset per hook index. */
function render(component, props, preset) {
  hookStates = preset ? [...preset] : [];
  hookCursor = 0;
  return textOf(component(props));
}

/**
 * Mount one component over a hook store that survives re-renders, the way React
 * does. `update` re-renders with the previous hooks still in place, so an effect
 * whose dependencies did not change does not run again, and `unmount` runs the
 * cleanups that are still outstanding.
 */
function mount(component, props) {
  hookStates = [];
  let tree = null;
  const draw = (next) => {
    hookCursor = 0;
    tree = component(next);
    return textOf(tree);
  };
  draw(props);
  return {
    text: () => textOf(tree),
    tree: () => tree,
    update(next) {
      return draw(next);
    },
    unmount() {
      for (const state of [...hookStates].reverse()) {
        if (state !== null && typeof state === "object" && typeof state.cleanup === "function") {
          state.cleanup();
        }
      }
      hookStates = [];
    },
  };
}
// #endregion

/** Build a shell over the real facade and a recording block registry. */
function buildShell({ views = {}, initial, openPanel } = {}) {
  const kernel = entryDefinition.factory(fakeRequireFor({})).createKernel({
    CSS: chunkFactories.get("client.styles.js")().CSS,
    STYLE_ID: "@super-agent/dsh-bridge/client.css",
  });
  const services = chunkFactories.get("client.services.js")().createServices({ initial });
  const blocks = [];
  const shell = chunkFactories.get("client.shell.js")().createShell({
    kernel,
    services,
    views,
    openPanel,
    blocks: {
      set(sessionId, block) {
        blocks.push({ sessionId, block });
      },
    },
  });
  // Components fall back to this activation's copy when a seat hands them no
  // `t`; in the real plugin the entry binds the locale seat's translator.
  shell.bindTranslate(translate(shell.dictionary.zh));
  const components = new Map();
  for (const entry of shell.registrations) {
    components.set(entry.options.name, entry.component);
    if (entry.options.key !== undefined) components.set(`${entry.options.name}#${entry.options.key}`, entry.component);
  }
  return { kernel, services, shell, blocks, components };
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

/** The `require` a chunk factory receives: the platform's React, nothing else. */
function fakeRequireFor(modules) {
  const fake = (specifier) => {
    if (specifier === "react") return fakeReact();
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return dshPrimitives;
    if (Object.hasOwn(modules, specifier)) return modules[specifier];
    throw new Error(`unexpected require: ${specifier}`);
  };
  fake.async = async (specifier) => {
    if (!Object.hasOwn(modules, specifier)) throw new Error(`dsh-bridge: chunk ${specifier} is not available`);
    return modules[specifier];
  };
  return fake;
}

/** The props a Session-scoped slot component receives from its seat. */
function slotProps(t, sessionId = "session-1") {
  return { t, sessionId };
}

/** The design's slots, in the order the shell declares them. */
const DESIGN_SLOTS = [
  "sidebar.panellist",
  "conversation.session.header.utilities",
  "conversation.input.model",
  "conversation.input.left",
  "conversation.input.permission",
  "conversation.input.overlay",
  "conversation.input.dock",
  "sidebar.right.pane.tab",
  "tool.call.toolview",
  "settings.plugins.tab",
];

describe("dsh-bridge client bundle", () => {
  afterEach(() => {
    for (const dispose of [...activeEntryDisposers]) dispose();
    vi.useRealTimers();
  });

  describe("shell", () => {
    it("claims every design slot exactly once", () => {
      const { shell } = buildShell();
      expect(shell.registrations.map((entry) => entry.slot)).toEqual(DESIGN_SLOTS);
    });

    it("gives each slot the registration options its cardinality requires", () => {
      const { shell } = buildShell();
      const optionsOf = (slot) => shell.registrations.find((entry) => entry.slot === slot).options;
      // List seats need an id and an order; keyed seats need the key alone.
      expect(optionsOf("sidebar.panellist")).toEqual({ name: "sidebar.panellist", id: "super-agent-row", order: 10 });
      expect(optionsOf("sidebar.right.pane.tab")).toEqual({ name: "sidebar.right.pane.tab", key: shell.TAB_ID });
      expect(optionsOf("tool.call.toolview")).toEqual({ name: "tool.call.toolview", key: "subagent_start" });
    });

    it("shadows the built-in single-slot controls instead of colliding with them", () => {
      // Both seats are held by a built-in that declares no priority of its own
      // (i.e. 0). The lowest priority renders, so a negative one takes the seat.
      const { shell } = buildShell();
      const optionsOf = (slot) => shell.registrations.find((entry) => entry.slot === slot).options;
      expect(optionsOf("conversation.input.model").priority).toBeLessThan(0);
      expect(optionsOf("conversation.input.permission").priority).toBeLessThan(0);
    });

    it("gives the settings tab a label the seat can draw", () => {
      const { shell } = buildShell();
      const entry = shell.registrations.find((candidate) => candidate.slot === "settings.plugins.tab");
      expect(entry.labelKey).toBe("settings.tab.title");
      expect(shell.dictionary.zh[entry.labelKey]).toBe("Super Agent");
    });

    it("opens the panel when the sidebar row is clicked, and tolerates no callback", () => {
      const openPanel = vi.fn();
      const { shell, components } = buildShell({ openPanel });
      const row = mount(components.get("sidebar.panellist"), slotProps((key) => key));
      const button = elementsOf(row.tree()).find((node) => node.type === "button" && node.props.className === "sap-row");

      expect(button).toBeDefined();
      expect(button.props.onClick).toBeTypeOf("function");
      button.props.onClick();
      expect(openPanel).toHaveBeenCalledTimes(1);

      const withoutCallback = buildShell().components.get("sidebar.panellist");
      const safeRow = mount(withoutCallback, slotProps((key) => key));
      const safeButton = elementsOf(safeRow.tree()).find((node) => node.type === "button" && node.props.className === "sap-row");
      expect(() => safeButton.props.onClick?.()).not.toThrow();
    });

    it("declares the panel's tab type with the same id its body registers under", () => {
      const { shell } = buildShell();
      const definition = shell.tabDefinition(translate(shell.dictionary.zh));
      expect(definition.id).toBe(shell.TAB_ID);
      expect(definition.kind).toBe(shell.TAB_KIND);
      expect(definition.priority).toBe("extension");
      expect(definition.title()).toBe("Agent Core");
      expect(definition.guide[0].description()).toBe("Agent Core 的 Run、会话与可观测数据");
    });

    it("keeps the two dictionaries in step", () => {
      const { shell } = buildShell();
      expect(Object.keys(shell.dictionary.en).sort()).toEqual(Object.keys(shell.dictionary.zh).sort());
    });
  });

  describe("injected state", () => {
    it("starts in production: no Core, no demo, and unknown values instead of samples", () => {
      const { services, shell, components } = buildShell();
      const t = translate(shell.dictionary.zh);
      expect(services.viewState.get().connection).toBe("offline");
      expect(services.viewState.get().demo).toBe(false);

      expect(render(components.get("conversation.input.model"), slotProps(t))).toContain("模型未知");
      expect(render(components.get("conversation.input.left"), slotProps(t))).toContain("thinking · 未知");
      expect(render(components.get("conversation.input.permission"), slotProps(t))).toContain("未知");
      expect(render(components.get("conversation.session.header.utilities"), slotProps(t))).toContain("Core 未连接");
    });

    it("shows the demo marker and the sample values only while demo is explicitly on", () => {
      const { services, shell, components } = buildShell();
      const t = translate(shell.dictionary.zh);
      services.registerFixtures(shell.demoFixture);

      // Off: the fixture is registered but nothing may read it.
      expect(services.fixture("composer")).toBeNull();
      expect(render(components.get("conversation.input.model"), slotProps(t))).not.toContain("go-main");

      services.setDemo(true);
      expect(render(components.get("conversation.input.model"), slotProps(t))).toContain("go-main · 演示");
      expect(render(components.get("conversation.input.left"), slotProps(t))).toContain("thinking · medium · 演示");
      expect(render(components.get("conversation.session.header.utilities"), slotProps(t))).toContain("演示状态");
      expect(render(components.get("sidebar.panellist"), slotProps(t))).toContain("演示状态");

      services.setDemo(false);
      expect(render(components.get("conversation.input.model"), slotProps(t))).toContain("模型未知");
    });

    it("marks the panel body as demo content only in the demo state", () => {
      const { services, shell, components } = buildShell();
      const t = translate(shell.dictionary.zh);
      const panel = components.get(`sidebar.right.pane.tab#${shell.TAB_ID}`);
      expect(render(panel, slotProps(t))).not.toContain("演示状态");
      services.setDemo(true);
      expect(render(panel, slotProps(t))).toContain("演示状态");
      expect(render(panel, slotProps(t))).toContain("不是真实 Core 记录");
    });

    it("switches the connection state the pages render", () => {
      const { services, shell, components } = buildShell();
      const t = translate(shell.dictionary.zh);
      const badge = components.get("conversation.session.header.utilities");
      expect(render(badge, slotProps(t))).toContain("Core 未连接");
      services.setConnection("ready");
      expect(render(badge, slotProps(t))).toContain("Core ready");
    });

    it("injects that state from the settings surface, which is the only entry to it", () => {
      const { services, shell, components } = buildShell();
      const t = translate(shell.dictionary.zh);
      const settings = mount(components.get("settings.plugins.tab"), slotProps(t));

      const click = (label) => {
        const button = elementsOf(settings.tree()).find(
          (node) => node.type === "button" && textOf(node.props.children).includes(label),
        );
        expect(button, `no control labelled "${label}"`).toBeDefined();
        button.props.onClick();
      };

      click("开启");
      expect(services.viewState.get().demo).toBe(true);
      click("关闭");
      expect(services.viewState.get().demo).toBe(false);
      click("Core ready");
      expect(services.viewState.get().connection).toBe("ready");
      click("Offline");
      expect(services.viewState.get().connection).toBe("offline");
    });

    it("refuses a second module's claim on an area another one already declared", () => {
      const { services } = buildShell();
      services.registerFixtures({ run: { a: 1 } });
      services.registerFixtures({ run: { b: 2 } });
      expect(services.fixtureAreas()).toEqual(["run"]);
      expect(services.fixtureConflicts()).toEqual(["run"]);
    });
  });

  describe("composer block", () => {
    it("raises the block while offline, so the masked input is really inert", () => {
      const { shell, components, blocks } = buildShell();
      const t = translate(shell.dictionary.zh);
      const overlay = mount(components.get("conversation.input.overlay"), slotProps(t));

      expect(overlay.text()).toContain("输入已停用");
      expect(blocks).toEqual([{ sessionId: "session-1", block: { reason: "连接 Core 后可发送…" } }]);

      // A plain re-render raises nothing new: the effect depends on the values
      // that matter, not on the render itself.
      overlay.update(slotProps(t));
      expect(blocks).toHaveLength(1);

      overlay.unmount();
      expect(blocks.at(-1)).toEqual({ sessionId: "session-1", block: undefined });
    });

    it("raises no block while Core is ready, and clears one when it becomes ready", () => {
      const { services, shell, components, blocks } = buildShell();
      const t = translate(shell.dictionary.zh);
      const overlay = mount(components.get("conversation.input.overlay"), slotProps(t));
      expect(blocks).toHaveLength(1);

      services.setConnection("ready");
      overlay.update(slotProps(t));
      expect(overlay.text()).toBe("");
      expect(blocks.at(-1)).toEqual({ sessionId: "session-1", block: undefined });
    });

    it("carries the block's reason in the language in force when it was raised", () => {
      const { shell, components, blocks } = buildShell();
      const overlay = mount(
        components.get("conversation.input.overlay"),
        slotProps(translate(shell.dictionary.zh)),
      );
      overlay.update(slotProps(translate(shell.dictionary.en)));
      expect(blocks.at(-1)).toEqual({ sessionId: "session-1", block: { reason: "Connect Core to send…" } });
    });
  });

  describe("card disclosure", () => {
    it("leaves a card that did not ask to be collapsible alone", () => {
      const { kernel } = buildShell();
      const card = mount(kernel.Card, { title: "Core process", children: "body" });
      expect(elementsOf(card.tree()).filter((node) => node.type === "button")).toEqual([]);
      expect(card.text()).toBe("Core processbody");
    });

    it("starts a collapsible card expanded, with the title as a real button", () => {
      const { kernel } = buildShell();
      const card = mount(kernel.Card, { title: "Core process", collapsible: true, id: "core", children: "body" });
      const toggle = elementsOf(card.tree()).find((node) => node.type === "button");
      // A real button is what makes the control reachable and operable from the
      // keyboard: Enter and Space activate it without any key handler of ours.
      expect(toggle).toBeDefined();
      expect(toggle.props["aria-expanded"]).toBe(true);
      expect(toggle.props["aria-controls"]).toBe("core-body");
      expect(card.text()).toBe("Core processbody");
    });

    it("folds and unfolds the body from that control", () => {
      const { kernel } = buildShell();
      const card = mount(kernel.Card, { title: "Core process", collapsible: true, children: "body" });
      const toggle = () => elementsOf(card.tree()).find((node) => node.type === "button");
      const body = () => elementsOf(card.tree()).find((node) => node.type === "div" && "hidden" in node.props);

      expect(body().props.hidden).toBe(false);
      toggle().props.onClick();
      card.update({ title: "Core process", collapsible: true, children: "body" });
      expect(toggle().props["aria-expanded"]).toBe(false);
      expect(body().props.hidden).toBe(true);
      expect(elementsOf(card.tree()).some((node) => node.props["data-collapsed"] === "true")).toBe(true);

      toggle().props.onClick();
      card.update({ title: "Core process", collapsible: true, children: "body" });
      expect(toggle().props["aria-expanded"]).toBe(true);
      expect(body().props.hidden).toBe(false);
    });
  });

  describe("unwired areas and actions", () => {
    it("says a tab body is not wired up rather than drawing an empty page", () => {
      const { shell, components } = buildShell();
      const t = translate(shell.dictionary.zh);
      const panel = components.get(`sidebar.right.pane.tab#${shell.TAB_ID}`);
      expect(render(panel, slotProps(t))).toContain("该区域尚未接入");
    });

    it("draws a tab body once its module supplies one", () => {
      const Body = () => "body-from-module";
      const { shell, components } = buildShell({ views: { runSession: Body } });
      const t = translate(shell.dictionary.zh);
      const panel = components.get(`sidebar.right.pane.tab#${shell.TAB_ID}`);
      expect(render(panel, slotProps(t))).toContain("body-from-module");
    });

    it("claims the offline dock seat without drawing anything when no module supplies the notice", () => {
      const { shell, components } = buildShell();
      const t = translate(shell.dictionary.zh);
      expect(render(components.get("conversation.input.dock"), slotProps(t))).toBe("");
    });

    it("reports an action as unsupported instead of a success", async () => {
      const { services, shell } = buildShell();
      const t = translate(shell.dictionary.zh);
      const button = mount(shell.ActionBtn, { id: "run.stop", children: "停止 Run" });
      expect(button.text()).toBe("停止 Run");

      button.tree().props.onClick();
      await Promise.resolve();

      expect(services.outcomeOf("run.stop").status).toBe("unsupported");
      button.update({ id: "run.stop", children: "停止 Run" });
      expect(button.text()).toContain("未接入 · 未执行");
      expect(button.text()).not.toContain("已停止");
    });

    it("keeps a disabled action disabled rather than reporting anything", () => {
      const { services, shell } = buildShell();
      const button = mount(shell.ActionBtn, { id: "run.fork", disabled: true, children: "Fork" });
      const element = elementsOf(button.tree()).find((node) => node.type === "button");
      expect(element.props.disabled).toBe(true);
      expect(element.props.onClick).toBeUndefined();
      expect(services.outcomeOf("run.fork").status).toBe("idle");
    });
  });

  describe("entry", () => {
    /**
     * Build the plugin and a recording client context.
     * @param options.mounted - the Session on screen at activation; `null`
     * models a page with no Session mounted yet.
     * @param options.adopted - whether that Session's store is adopted already.
     * @param options.chunks - which chunk files the loader can serve.
     */
    function activate({ chunks } = {}) {
      const available =
        chunks ??
        Object.fromEntries(
          ["client.styles.js", "client.services.js", "client.shell.js", "client.space.js", "client.space-view.js", "client.settings.js", "client.settings-content.js", "client.file-decisions.js", "client.trace.js"].map((file) => [
            `./${file}`,
            chunkFactories.get(file)(),
          ]),
        );
      const plugin = entryDefinition.factory(fakeRequireFor(available));

      const record = {
        injections: [], effects: [], locales: [], panelSelections: [], nativeReads: [], warnings: [],
      };
      const dictionaries = new Map();

      const rawContext = {
        locale: {
          register(namespace, value) {
            dictionaries.set(namespace, value);
            record.locales.push({ namespace, dictionaries: value });
            return () => {};
          },
          bind(namespace) {
            const bound = (key, params) => translate(dictionaries.get(namespace)?.zh ?? {})(key, params);
            bound.en = (key, params) => translate(dictionaries.get(namespace)?.en ?? {})(key, params);
            return bound;
          },
        },
        effect(run, label) {
          const dispose = run();
          let disposed = false;
          const guardedDispose = () => {
            if (disposed) return;
            disposed = true;
            activeEntryDisposers.delete(guardedDispose);
            dispose?.();
          };
          activeEntryDisposers.add(guardedDispose);
          record.effects.push({ label, dispose: guardedDispose });
          return guardedDispose;
        },
        slots: {
          inject(slot, contribute) {
            const dispose = contribute();
            record.injections.push({ slot, dispose });
            return () => {
              dispose();
            };
          },
          register(options, component) {
            record.registered = record.registered ?? [];
            record.registered.push({ options, component });
            return () => {};
          },
        },
        layout: { selectPanel: (id) => record.panelSelections.push(id) },
        uiWorkspace: {
          listDirectory: async () => [],
          createDirectory: async () => "/workspace/new",
        },
      };
      const forbidden = new Set(["agents", "sessions", "sessionPersistence", "sidebarRight", "sidebarRightTabs", "conversation", "remote"]);
      const ctx = new Proxy(rawContext, {
        get(target, property, receiver) {
          if (forbidden.has(property)) {
            record.nativeReads.push(property);
            throw new Error(`production entry must not read native DSH service ${String(property)}`);
          }
          return Reflect.get(target, property, receiver);
        },
      });

      return { plugin, ctx, record };
    }

    it("injects the services the interface needs", () => {
      const { plugin } = activate();
      expect(plugin.inject).toEqual(["slots", "locale", "layout", "uiWorkspace"]);
    });

    it("publishes no debug face on the global object", () => {
      // AC04: the production entry must not carry the P0 probe's inspection
      // face. Neither the readback global nor the page-level state switch it
      // read is part of this bundle.
      expect(globalThis.__SUPER_AGENT_PROBE__).toBeUndefined();
      expect(globalThis.__SUPER_AGENT_PROBE_STATE__).toBeUndefined();
      expect(globalThis.__SUPER_AGENT_PROBE_EXPOSE__).toBeUndefined();
      const { plugin } = activate();
      expect(plugin).not.toHaveProperty("probe");
      // `activate` is the plugin's own body, exported so a test can await the
      // work `apply` deliberately leaves running in the background. It reads
      // nothing back: the probe's readback global and page-level state switch
      // are what AC04 retires, and neither is here.
      expect(Object.keys(plugin).sort()).toEqual(["activate", "apply", "createKernel", "inject", "mergeDictionaries"]);
    });

    it("registers every slot through an effect so unloading disposes it", async () => {
      const { plugin, ctx, record } = activate();
      await plugin.activate(ctx, undefined);
      expect(record.injections.map((entry) => entry.slot)).toEqual(["main", "sidebar.panellist", "sidebar.footer.action", "settings.section"]);
      expect(record.effects.map((entry) => entry.label)).toEqual([
        "dsh-bridge: dictionaries",
        "dsh-bridge: Super Agent space",
        "dsh-bridge: Super Agent",
        "dsh-bridge: Super Agent directories",
      "dsh-bridge: Super Agent settings",
        "dsh-bridge: independent space lifecycle",
      ]);
      expect(record.effects.every((entry) => typeof entry.dispose === "function")).toBe(true);
    });

    it("does not read native Session or composer services", async () => {
      const { plugin, ctx, record } = activate();
      await plugin.activate(ctx, undefined);
      expect(record.panelSelections).toEqual([]);
      expect(record.nativeReads).toEqual([]);
    });

    it("clears its timer when the plugin unloads", async () => {
      vi.useFakeTimers();
      const { plugin, ctx, record } = activate({ mounted: null, adopted: false });
      await plugin.activate(ctx, undefined);
      for (const effect of record.effects) effect.dispose();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps a missing optional chunk from taking the bundle down, and reports it", async () => {
      const { plugin, ctx } = activate();
      const result = await plugin.activate(ctx, undefined);
      expect(result.failures.map((failure) => failure.chunk).sort()).toEqual([
        "./client.main.js",
        "./client.observation-detail.js",
        "./client.observe.js",
        "./client.offline.js",
        "./client.run-panel.js",
      ]);
      expect(result.failures.every((failure) => failure.required === false)).toBe(true);
    });

    it("fails loudly when a chunk the bundle cannot draw without is missing", async () => {
      const { plugin, ctx } = activate({ chunks: {} });
      await expect(plugin.activate(ctx, undefined)).rejects.toThrow(/required chunk \.\/client.styles\.js did not load/);
    });

    it("merges one dictionary from every module and reports a genuine collision", () => {
      const { plugin } = activate();
      const merged = plugin.mergeDictionaries([{ zh: { a: "1" }, en: { a: "1" } }, { zh: { a: "1", b: "2" }, en: {} }]);
      expect(merged.dictionaries.zh).toEqual({ a: "1", b: "2" });
      expect(merged.collisions).toEqual([]);
      expect(plugin.mergeDictionaries([{ zh: { a: "1" } }, { zh: { a: "different" } }]).collisions).toEqual([
        { language: "zh", key: "a" },
      ]);
    });
  });
});

it("passes the bound translator to panel descendants when mounted outside a host slot", () => {
  const { shell, components, kernel } = buildShell();
  shell.bindTranslate(translate(shell.dictionary.zh));
  shell.setViews({ runSession: props => kernel.h("p", null, props.t("panel.tab.runSession")) });
  const panel = components.get(`sidebar.right.pane.tab#${shell.TAB_ID}`);
  expect(() => render(panel, {})).not.toThrow();
  expect(render(panel, {})).toContain(shell.dictionary.zh["panel.tab.runSession"]);
});
