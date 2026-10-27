import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Bundle-level checks for the bridge's client half.
 *
 * This file used to check the P0 interface probe, which was one self-contained
 * file. M1 split the bundle into a served entry plus package-local chunks, so
 * what is checked here is the wiring *between* those modules: that the entry
 * loads its chunks the way the host makes them reachable, that a missing
 * optional one is reported rather than fatal, and that the whole bundle
 * registers the same interface the probe did.
 *
 * The per-component behaviour moved with the code: the shell and the facade are
 * covered by `shell.test.js`, and the page modules bring their own checks with
 * them (`main.test.js`, `offline.test.js`, `observe.test.js`). What was the
 * probe's inspection face is gone by design — the production entry must not
 * publish a debug readback — and the sample-data assertions moved to the
 * modules that now own that content.
 *
 * Each module registers itself into `window.__ModuleLoader__` at module scope,
 * so a fake loader is installed before the dynamic imports. Nothing here needs
 * the dsh runtime: React is a hand-written stand-in and the client context is a
 * recorder.
 */

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.styles.js");
await import("../../src/client/client.services.js");
await import("../../src/client/client.shell.js");
await import("../../src/client/client.main.js");
await import("../../src/client/client.run-panel.js");
await import("../../src/client/client.offline.js");
await import("../../src/client/client.observe.js");
await import("../../src/client/client.observation-detail.js");
await import("../../src/client/client.space.js");
await import("../../src/client/client.space-view.js");
await import("../../src/client/client.settings.js");
await import("../../src/client/client.settings-content.js");
await import("../../src/client/client.file-decisions.js");
await import("../../src/client/client.trace.js");
await import("../../src/client/index.js");

/** One registered chunk factory, by the chunk file it was loaded from. */
const chunkFactories = new Map();
for (const definition of loaded) chunkFactories.set(definition.chunk ?? "entry", definition.factory);
const entry = loaded.find((definition) => definition.chunk === undefined);

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
    /** Reset the hook store between component calls. */
    __reset() {
      states = [];
      cursor = 0;
    },
  };
}

/** The chunk file each key of the bundle is loaded from. */
const CHUNK_FILES = {
  "./client.styles.js": "client.styles.js",
  "./client.services.js": "client.services.js",
  "./client.shell.js": "client.shell.js",
  "./client.main.js": "client.main.js",
  "./client.run-panel.js": "client.run-panel.js",
  "./client.offline.js": "client.offline.js",
  "./client.observe.js": "client.observe.js",
  "./client.observation-detail.js": "client.observation-detail.js",
  "./client.space.js": "client.space.js",
  "./client.space-view.js": "client.space-view.js",
  "./client.settings.js": "client.settings.js",
  "./client.settings-content.js": "client.settings-content.js",
  "./client.file-decisions.js": "client.file-decisions.js",
  "./client.trace.js": "client.trace.js",
};

/** Production owns one root panel and two independent navigation actions. */
const DESIGN_SLOTS = [
  "main",
  "sidebar.panellist",
  "sidebar.footer.action",
  "settings.section",
];

const activeDisposers = new Set();
const EmptyPrimitive = () => null;
const MenuPrimitive = Object.assign(() => null, {
  Root: EmptyPrimitive, Trigger: EmptyPrimitive, Content: EmptyPrimitive, Item: EmptyPrimitive,
});
const dshPrimitives = new Proxy({ Button: EmptyPrimitive, Menu: MenuPrimitive, Modal: EmptyPrimitive, Tooltip: EmptyPrimitive }, {
  get(target, property) { return target[property] ?? EmptyPrimitive; },
});
afterEach(() => {
  for (const dispose of [...activeDisposers]) dispose();
  vi.useRealTimers();
});

// The production space has its own host routes. Keep this bundle test offline.
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^\/super-agent\//, "");
  if (path.startsWith("state")) return { ok: true, status: 200, json: async () => ({ connection: "ready" }) };
  const { action } = JSON.parse(init.body);
  const result = action === "models.list" ? [] : action === "thread.list" ? { items: [] } : {};
  return { ok: true, status: 200, json: async () => ({ result }) };
};

/**
 * The `require` a bundle factory receives.
 *
 * dsh hands a factory a synchronous `require` for the platform seed and
 * registered factories, plus `require.async` for package-local chunks. This
 * stand-in serves the same two, over whichever chunk modules a test has made
 * available: a chunk that is not available rejects, exactly as a 404 would.
 * @param available - chunk file name to its module, or `null` for a missing one.
 */
function fakeRequire(available) {
  const react = fakeReact();
  const require = (specifier) => {
    if (specifier === "react") return react;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return dshPrimitives;
    if (Object.hasOwn(available, specifier)) return available[specifier];
    throw new Error(`dsh-bridge: unexpected require: ${specifier}`);
  };
  require.async = async (specifier) => {
    if (!Object.hasOwn(available, specifier) || available[specifier] === null) {
      throw new Error(`client-modules: cannot fetch chunk ${specifier}`);
    }
    return available[specifier];
  };
  require.react = react;
  return require;
}

/** Every chunk the repository currently ships, as the loader would serve them. */
function shippedChunks() {
  const available = {};
  for (const [specifier, file] of Object.entries(CHUNK_FILES)) {
    const factory = chunkFactories.get(file);
    available[specifier] = factory === undefined ? null : factory();
  }
  return available;
}

/**
 * The dictionary slice each page module declares, built the way the entry
 * builds them. A chunk factory returns the `create*` function, not the module
 * itself, so the slices only exist once a module has been created.
 */
function pageDictionaries() {
  const plugin = entry.factory(fakeRequire(shippedChunks()));
  const kernel = plugin.createKernel({
    CSS: chunkFactories.get("client.styles.js")().CSS,
    STYLE_ID: "@super-agent/dsh-bridge/client.css",
  });
  const services = chunkFactories.get("client.services.js")().createServices();
  const shell = chunkFactories.get("client.shell.js")().createShell({ kernel, services, views: {}, blocks: { set() {} } });
  const parts = { ActionBtn: shell.ActionBtn };
  const pages = [
    chunkFactories.get("client.main.js")().createMainView({ kernel, services, parts }),
    chunkFactories.get("client.run-panel.js")().createRunPanel({ kernel, services, parts }),
    chunkFactories.get("client.offline.js")().createOffline({ kernel, services, parts }),
    chunkFactories.get("client.observe.js")().createObserveView({ kernel, services, parts }),
    chunkFactories.get("client.observation-detail.js")().createObservationDetail({ kernel, services, parts }),
  ];
  return [shell, ...pages].map((module) => module.dictionary);
}

/** Build the plugin and a recording client context. */
function activate({ chunks, uiWorkspace, onCreateSpaceView } = {}) {
  const available = chunks ?? shippedChunks();
  if (onCreateSpaceView && available["./client.space-view.js"]) {
    const spaceView = available["./client.space-view.js"];
    available["./client.space-view.js"] = {
      ...spaceView,
      createSpaceView(options) {
        onCreateSpaceView(options);
        return spaceView.createSpaceView(options);
      },
    };
  }
  const plugin = entry.factory(fakeRequire(available));

  const record = { injections: [], effects: [], locales: [], panelSelections: [], nativeReads: [], uiWorkspaceReads: [] };
  const dictionaries = new Map();

  const rawContext = {
    locale: {
      register(namespace, value) {
        dictionaries.set(namespace, value);
        record.locales.push({ namespace, value });
        return () => {};
      },
      bind(namespace) {
        const bound = (key, params) => {
          const raw = dictionaries.get(namespace)?.zh?.[key];
          if (raw === undefined) return key;
          return raw.replace(/\{(\w+)\}/g, (match, name) =>
            params && Object.hasOwn(params, name) ? String(params[name]) : match,
          );
        };
        bound.en = (key) => dictionaries.get(namespace)?.en?.[key] ?? key;
        return bound;
      },
    },
    effect(run, label) {
      const dispose = run();
      let disposed = false;
      const guardedDispose = () => {
        if (disposed) return;
        disposed = true;
        activeDisposers.delete(guardedDispose);
        dispose?.();
      };
      activeDisposers.add(guardedDispose);
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
    uiWorkspace: uiWorkspace ?? {
      listDirectory: async () => [],
      createDirectory: async () => "/workspace/new",
    },
  };
  const forbidden = new Set(["agents", "sessions", "sessionPersistence", "sidebarRight", "sidebarRightTabs", "conversation", "remote"]);
  const ctx = new Proxy(rawContext, {
    get(target, property, receiver) {
      if (property === "uiWorkspace") record.uiWorkspaceReads.push(property);
      if (forbidden.has(property)) {
        record.nativeReads.push(property);
        throw new Error(`production entry must not read native DSH service ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  return {
    plugin,
    ctx,
    record,
  };
}

describe("dsh-bridge client bundle", () => {
  it("activates without awaiting the chunks", () => {
    // The host audits every entry's fiber state once, right after its own
    // startup await. An `apply` that awaits its chunks is still in flight at
    // that moment, and the whole application then renders a boot failure
    // instead of the interface. So the body must hand the host an activated
    // fiber and do the loading in the background.
    const { plugin, ctx, record } = activate();
    const result = plugin.apply(ctx, undefined);
    expect(result).toBeUndefined();
    expect(record.effects).toEqual([]);
    return plugin.activate(ctx, undefined).then(() => {
      expect(record.effects.length).toBeGreaterThan(0);
    });
  });

  it("reports a background activation failure without taking the plugin down", async () => {
    const chunks = shippedChunks();
    chunks["./client.shell.js"] = null;
    const { plugin, ctx } = activate({ chunks });
    const logged = [];
    ctx.logger = { error: (error) => logged.push(String(error?.message ?? error)) };

    expect(plugin.apply(ctx, undefined)).toBeUndefined();
    await vi.waitFor(() => expect(logged.length).toBe(1));
    expect(logged[0]).toMatch(/required chunk \.\/client\.shell\.js did not load/);
  });

  it("assembles the whole shipped bundle with nothing missing", async () => {
    const { plugin, ctx } = activate();
    const result = await plugin.activate(ctx, undefined);
    // Every chunk is on disk now, so a failure here means the bundle the
    // milestone delivers does not actually compose. The per-chunk failure paths
    // are exercised by the two tests below.
    expect(result.failures).toEqual([]);
    expect(result.dictionaries.zh["panel.title"]).toBe("Agent Core");
  });

  it("merges every page's dictionary without a key two of them claim differently", async () => {
    const { plugin } = activate();
    const { dictionaries, collisions } = plugin.mergeDictionaries(pageDictionaries());
    expect(collisions).toEqual([]);
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.zh).sort());
    // Each page's own keys survive the merge, so no page was silently dropped.
    for (const key of ["panel.coreProcess.title", "panel.run.title", "offline.title", "observe.metrics.title"]) {
      expect(dictionaries.zh[key], key).toBeDefined();
    }
  });

  it("gives each page its own demo area, with no area claimed twice", async () => {
    const { plugin, ctx } = activate();
    const result = await plugin.activate(ctx, undefined);
    expect(result.services.fixtureConflicts()).toEqual([]);
    expect(result.services.fixtureAreas().sort()).toEqual([
      "composer",
      "delegations",
      "observationDetail",
      "observe",
      "offline",
      "recovery",
      "run",
      "snapshot",
    ]);
  });

  it("fails the activation when a chunk the interface cannot be drawn without is missing", async () => {
    const chunks = shippedChunks();
    chunks["./client.shell.js"] = null;
    const { plugin, ctx } = activate({ chunks });
    await expect(plugin.activate(ctx, undefined)).rejects.toThrow(
      /required chunk \.\/client\.shell\.js did not load/,
    );
  });

  it("reports an optional chunk that has not landed instead of taking the bundle down", async () => {
    const chunks = shippedChunks();
    chunks["./client.observe.js"] = null;
    const { plugin, ctx } = activate({ chunks });
    const result = await plugin.activate(ctx, undefined);
    expect(result.failures).toContainEqual({
      chunk: "./client.observe.js",
      required: false,
      message: expect.stringContaining("cannot fetch chunk"),
    });
  });

  it("registers only the independent root space and its two navigation slots", async () => {
    const { plugin, ctx, record } = activate();
    await plugin.activate(ctx, undefined);
    expect(record.injections.map((entry) => entry.slot)).toEqual(DESIGN_SLOTS);
    expect(record.effects.map((entry) => entry.label)).toEqual([
      "dsh-bridge: dictionaries",
      "dsh-bridge: Super Agent space",
      "dsh-bridge: Super Agent",
      "dsh-bridge: Super Agent directories",
      "dsh-bridge: Super Agent settings",
      "dsh-bridge: independent space lifecycle",
    ]);
    expect(record.effects.every((effect) => typeof effect.dispose === "function")).toBe(true);
    expect(record.nativeReads).toEqual([]);
    expect(record.panelSelections).toEqual([]);
  });

  it("uses one stable Space ID across the root panel and both sidebar entries", async () => {
    const { plugin, ctx, record } = activate();
    await plugin.activate(ctx, undefined);
    const optionsOf = (slot) => record.registered.find((entry) => entry.options.name === slot).options;
    expect(optionsOf("main")).toMatchObject({ name: "main", key: "@super-agent/dsh-bridge/space" });
    expect(optionsOf("sidebar.panellist")).toMatchObject({ name: "sidebar.panellist", id: optionsOf("main").key });
    expect(optionsOf("sidebar.footer.action")).toMatchObject({ name: "sidebar.footer.action", id: optionsOf("main").key });
    expect(record.registered.map((entry) => entry.options.name).sort()).toEqual([...DESIGN_SLOTS].sort());
  });

  it("uses only the layout slot services and never reads native Session or composer APIs", async () => {
    const { plugin, ctx, record } = activate();
    await plugin.activate(ctx, undefined);
    expect(plugin.inject).toEqual(["slots", "locale", "layout", "uiWorkspace"]);
    expect(record.nativeReads).toEqual([]);
    expect(record.injections.map((entry) => entry.slot)).not.toContain("conversation.input.model");
    expect(record.injections.map((entry) => entry.slot)).not.toContain("conversation.input.overlay");
  });

  it("adapts only the public directory-browser methods into the Space view", async () => {
    const calls = [];
    const unexpected = [];
    const allowed = new Set(["pickDirectory", "listDirectory", "createDirectory"]);
    const uiWorkspace = new Proxy({
      async pickDirectory() { calls.push({ method: "pickDirectory" }); return "/workspace/picked"; },
      async listDirectory(path, signal) { calls.push({ method: "listDirectory", path, signal }); return [{ name: "child" }]; },
      async createDirectory(path, name) { calls.push({ method: "createDirectory", path, name }); return `${path}/${name}`; },
    }, {
      get(target, property, receiver) {
        if (!allowed.has(property)) {
          unexpected.push(String(property));
          throw new Error(`unexpected uiWorkspace capability: ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let viewOptions;
    const { plugin, ctx, record } = activate({ uiWorkspace, onCreateSpaceView: (options) => { viewOptions = options; } });
    const result = await plugin.activate(ctx, undefined);
    result.space.registrations.find((entry) => entry.slot === "main").component();

    expect(viewOptions.directoryBrowser).toBeDefined();
    expect(viewOptions.directoryBrowser === uiWorkspace).toBe(false);
    expect(Object.keys(viewOptions.directoryBrowser).sort()).toEqual(["createDirectory", "listDirectory", "pickDirectory"]);
    await expect(viewOptions.directoryBrowser.pickDirectory()).resolves.toBe("/workspace/picked");
    const signal = new AbortController().signal;
    await expect(viewOptions.directoryBrowser.listDirectory("/workspace", signal)).resolves.toEqual([{ name: "child" }]);
    await expect(viewOptions.directoryBrowser.createDirectory("/workspace", "child")).resolves.toBe("/workspace/child");
    expect(calls).toEqual([
      { method: "pickDirectory" },
      { method: "listDirectory", path: "/workspace", signal },
      { method: "createDirectory", path: "/workspace", name: "child" },
    ]);
    expect(unexpected).toEqual([]);
    expect(record.nativeReads).toEqual([]);
    expect(record.uiWorkspaceReads.length).toBeGreaterThan(0);
  });

  it("clears its timer when the plugin unloads", async () => {
    vi.useFakeTimers();
    try {
      const { plugin, ctx, record } = activate({ mounted: null, adopted: false });
      await plugin.activate(ctx, undefined);
      for (const effect of record.effects) effect.dispose();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("injects the services the interface needs", () => {
    const { plugin } = activate();
    expect(plugin.inject).toEqual(["slots", "locale", "layout", "uiWorkspace"]);
  });

  it("publishes no debug face, on the global object or on the plugin", async () => {
    // The production entry must not carry the P0 probe's inspection readback or
    // the page-level switch it read: neither is part of this bundle, and
    // nothing here defines them.
    expect(globalThis.__SUPER_AGENT_PROBE__).toBeUndefined();
    expect(globalThis.__SUPER_AGENT_PROBE_STATE__).toBeUndefined();
    expect(globalThis.__SUPER_AGENT_PROBE_EXPOSE__).toBeUndefined();

    const { plugin, ctx } = activate();
    await plugin.activate(ctx, undefined);
    expect(plugin).not.toHaveProperty("probe");
    expect(globalThis.__SUPER_AGENT_PROBE__).toBeUndefined();
  });

  it("keeps one dictionary per language, with the two in step", async () => {
    const { plugin, ctx, record } = activate();
    await plugin.activate(ctx, undefined);
    expect(record.locales).toHaveLength(1);
    const { zh, en } = record.locales[0].value;
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("hands the pages no fixture content until demo is explicitly on", async () => {
    const { plugin, ctx } = activate();
    const result = await plugin.activate(ctx, undefined);
    expect(result.services.fixtureAreas()).toContain("composer");
    expect(result.services.fixture("composer")).toBeNull();
    result.services.setDemo(true);
    expect(result.services.fixture("composer")).toEqual({
      model: "go-main",
      thinking: "medium",
      permission: "workspace_auto",
    });
  });
});
