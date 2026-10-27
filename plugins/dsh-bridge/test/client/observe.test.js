import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit checks for the bridge's Observe page and its member detail.
 *
 * Each module of the bundle registers itself into `window.__ModuleLoader__` at
 * module scope, so a fake loader is installed before the dynamic imports, the
 * same way `shell.test.js` does it. The React stand-in here is a little more
 * capable than the shell's: it renders a component tree eagerly and keeps one
 * hook store per component instance, so the page can be mounted with the real
 * action button and the real member detail nested inside it — the two places a
 * hook runs below the page itself.
 *
 * These checks are the page's offline evidence. That `client.observe.js` and
 * `client.observation-detail.js` are the only names the host serves for these
 * pages, and that `require.async` is the only way to reach them, is a property
 * of the host and is written up in `docs/requirements/dsh-integration/DSH界面验收.md`.
 */

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.styles.js");
await import("../../src/client/client.services.js");
await import("../../src/client/client.shell.js");
await import("../../src/client/client.observe.js");
await import("../../src/client/client.observation-detail.js");
await import("../../src/client/index.js");

/** One registered chunk factory, by the chunk file it was loaded from. */
const chunkFactories = new Map();
for (const definition of loaded) {
  chunkFactories.set(definition.chunk ?? "entry", definition.factory);
}
const entryDefinition = loaded.find((definition) => definition.chunk === undefined);

// #region React stand-in
/**
 * A React stand-in that renders a tree eagerly.
 *
 * Every function component is called during the render and replaced by what it
 * returned, so a walker never has to call a component itself. Hook state lives
 * in a store keyed by the instance's path in the tree, which is stable across
 * re-renders for the parts of the tree that did not change — enough for a page
 * whose state is local filter selections.
 */
function createRenderer() {
  const stores = new Map();
  let frame = null;

  /** Whether two dependency lists would let React skip the effect. */
  function sameDeps(previous, next) {
    if (previous === undefined || next === undefined) return false;
    return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
  }

  const React = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { type, props: merged };
    },
    useState(initial) {
      const index = frame.cursor;
      frame.cursor += 1;
      // Capture the store array, not `frame`: a subscriber fires long after the
      // render that registered it, when `frame` points at some other component.
      const store = frame.store;
      if (!Object.hasOwn(store, index)) {
        store[index] = typeof initial === "function" ? initial() : initial;
      }
      return [
        store[index],
        (value) => {
          store[index] = typeof value === "function" ? value(store[index]) : value;
        },
      ];
    },
    useEffect(run, deps) {
      const index = frame.cursor;
      frame.cursor += 1;
      const store = frame.store;
      const previous = store[index];
      if (previous !== undefined && sameDeps(previous.deps, deps)) return;
      if (previous !== undefined && typeof previous.cleanup === "function") previous.cleanup();
      store[index] = { deps, cleanup: run() };
    },
  };

  /** Expand one node into plain host elements, running every component in it. */
  function expand(node, path) {
    if (node === null || node === undefined || node === false || node === true) return node;
    if (typeof node === "string" || typeof node === "number") return node;
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}#${index}`));
    const { type, props } = node;
    if (typeof type === "function") {
      const instancePath = `${path}/${type.name || "anonymous"}`;
      if (!stores.has(instancePath)) stores.set(instancePath, []);
      const previous = frame;
      frame = { cursor: 0, store: stores.get(instancePath) };
      let output;
      try {
        output = type(props);
      } finally {
        frame = previous;
      }
      return expand(output, instancePath);
    }
    return { type, props: { ...props, children: expand(props?.children, path) } };
  }

  function render(component, props) {
    return expand(React.createElement(component, props), "root");
  }

  return { React, render, stores };
}

const renderer = createRenderer();

/** Concatenate the text a rendered tree carries, ignoring stylesheets. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node.type === "style") return "";
  return textOf(node.props?.children);
}

/** Every host element in a rendered tree, depth first. */
function elementsOf(node, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, found);
    return found;
  }
  found.push(node);
  elementsOf(node.props?.children, found);
  return found;
}

/** Mount one component over stores that survive re-renders, the way React does. */
function mount(component, props) {
  renderer.stores.clear();
  let tree = renderer.render(component, props);
  return {
    tree: () => tree,
    text: () => textOf(tree),
    update(next) {
      tree = renderer.render(component, next ?? props);
      return textOf(tree);
    },
    unmount() {
      for (const store of renderer.stores.values()) {
        for (const slot of [...store].reverse()) {
          if (slot !== null && typeof slot === "object" && typeof slot.cleanup === "function") slot.cleanup();
        }
      }
      renderer.stores.clear();
    },
  };
}
// #endregion

// #region harness
/** The `require` a bundle factory receives: the platform's React, nothing else. */
function fakeRequire() {
  const fake = (specifier) => {
    if (specifier === "react") return renderer.React;
    throw new Error(`unexpected require: ${specifier}`);
  };
  fake.async = async () => {
    throw new Error("client-modules: no chunk is reachable here");
  };
  return fake;
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

/** The one namespace the entry merges, in load order, first claim winning. */
function mergedTranslate(modules) {
  const merged = {};
  for (const module of modules) {
    for (const [key, text] of Object.entries(module.dictionary?.zh ?? {})) {
      if (!Object.hasOwn(merged, key)) merged[key] = text;
    }
  }
  return translate(merged);
}

/**
 * Build the Observe page the way the entry assembles it, over the real facade.
 * @param options.memberDetail - whether `parts.MemberDetail` is already filled,
 * as it is once the entry has wired the observation-detail module.
 */
function buildObserve({ initial, demo = false, memberDetail = true, observations = null } = {}) {
  const styles = chunkFactories.get("client.styles.js")();
  const kernel = entryDefinition.factory(fakeRequire()).createKernel({ CSS: styles.CSS, STYLE_ID: styles.STYLE_ID });
  const services = chunkFactories.get("client.services.js")().createServices({ initial });
  if (observations !== null) services.observations = observations;
  const shell = chunkFactories.get("client.shell.js")().createShell({ kernel, services, views: {}, blocks: { set() {} } });
  // A seat hands the components a translator over the merged namespace; the
  // shell binds its own fallback for the action button the same way.
  shell.bindTranslate(translate(shell.dictionary.zh));
  const observationDetail = chunkFactories
    .get("client.observation-detail.js")()
    .createObservationDetail({ kernel, services, parts: { ActionBtn: shell.ActionBtn } });
  const parts = { ActionBtn: shell.ActionBtn };
  const observe = chunkFactories.get("client.observe.js")().createObserveView({
    kernel,
    services,
    parts: memberDetail ? { ...parts, MemberDetail: observationDetail.MemberDetail } : parts,
  });
  services.registerFixtures(observe.demoFixture);
  services.registerFixtures(observationDetail.demoFixture);
  if (demo) services.setDemo(true);
  return {
    kernel,
    services,
    shell,
    observe,
    observationDetail,
    parts,
    t: mergedTranslate([shell, observe, observationDetail]),
  };
}

/** Mount the page the way the panel's tab seat does: with the merged translator. */
function mountPage(built) {
  return mount(built.observe.ObserveTab, { t: built.t });
}

/** The first host element carrying `attr`. */
function byAttr(tree, attr, value) {
  return elementsOf(tree).find(
    (node) => node.props?.[attr] !== undefined && (value === undefined || node.props[attr] === value),
  );
}

/** A button whose text contains `label`. */
function buttonWith(tree, label) {
  return elementsOf(tree).find((node) => node.type === "button" && textOf(node.props?.children).includes(label));
}

/** Click a control by the data attribute that names it. */
function click(view, attr, value) {
  byAttr(view.tree(), attr, value).props.onClick();
  view.update();
}

async function settle(view) {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  view.update();
}

const OBSERVATION_METRICS = [
  "tool.request_trigger_rate",
  "tool.execution_success_rate",
  "subagent.start_rate",
  "skill.read_rate",
];
const ALL_LIVE_METRICS = [
  ...OBSERVATION_METRICS,
  "tool.execution_trigger_rate",
  "skill.context_rate",
  "subagent.request_trigger_rate",
  "subagent.sync_share",
  "subagent.async_share",
  "report.async_processing_rate",
];
const OBSERVATION_FILTERS = {
  agentDefinitionVersion: null,
  modelBinding: null,
  toolVersion: null,
  skillVersion: null,
  permissionMode: null,
  runSource: null,
  deploymentVersion: null,
};
const OBSERVATION_COVERAGE = { state: "complete", missingFields: [], reason: null };
const CONTENT_REF = { kind: "entry", id: "entry/one", part: "output" };

function observationSnapshot(query, metric, queryId, numerator = 1, denominator = 2) {
  return {
    queryId,
    metric,
    metricVersion: "1",
    memberType: "run",
    window: query.window,
    scope: query.scope,
    includeDescendants: query.includeDescendants,
    filters: query.filters,
    group: {},
    asOf: "2026-10-21T12:00:00.000Z",
    watermark: "w-81",
    provisional: false,
    coverage: OBSERVATION_COVERAGE,
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    unknownCount: 0,
    runningCount: 0,
    reason: denominator === 0 ? "zero_denominator" : null,
  };
}

function observationServiceFixture() {
  const calls = {
    metrics: [],
    tools: [],
    usage: [],
    members: [],
    health: 0,
    graph: [],
    trace: [],
    execution: [],
    content: [],
  };
  const service = {
    calls,
    async metrics(query) {
      calls.metrics.push(structuredClone(query));
      return {
        asOf: "2026-10-21T12:00:00.000Z",
        watermark: "w-81",
        metrics: OBSERVATION_METRICS.map((metric) => observationSnapshot(query, metric, `q:${metric}`)),
      };
    },
    async tools(query) {
      calls.tools.push(structuredClone(query));
      return {
        asOf: "2026-10-21T12:00:00.000Z",
        watermark: "w-81",
        rows: [{
          toolName: "edit",
          exposedRuns: 2,
          logicalInvocationCount: 1,
          attemptCount: 1,
          outcomes: {
            succeeded: 1,
            failed: 0,
            denied: 0,
            cancelledBeforeStart: 0,
            cancelled: 0,
            timedOut: 0,
            unknown: 0,
            running: 0,
          },
          requestTrigger: observationSnapshot(query, "tool.request_trigger_rate", "q:tool:request"),
          executionTrigger: observationSnapshot(query, "tool.execution_trigger_rate", "q:tool:execution"),
          executionSuccess: observationSnapshot(query, "tool.execution_success_rate", "q:tool:success"),
          executionDurationMs: { p50: 10, p95: 25, coverage: OBSERVATION_COVERAGE },
        }],
      };
    },
    async usage(query) {
      calls.usage.push(structuredClone(query));
      return {
        queryId: "q:usage",
        asOf: "2026-10-21T12:00:00.000Z",
        watermark: "w-81",
        query,
        coverage: OBSERVATION_COVERAGE,
        buckets: [{
          runId: "run/one",
          turnId: null,
          providerId: "provider",
          modelId: "model",
          inputTokens: 1300,
          outputTokens: 240,
          cacheReadTokens: 800,
          cacheWriteTokens: 40,
          unknownAttempts: 0,
          costKnown: false,
          cost: null,
          currency: null,
        }],
      };
    },
    async members(request) {
      calls.members.push({ ...request });
      return {
        queryId: request.queryId,
        side: request.side,
        memberType: "run",
        members: [{ memberType: "run", memberId: "run/one", runId: "run/one", sourceRefs: ["entry/one"] }],
        nextCursor: null,
      };
    },
    async health() {
      calls.health += 1;
      return {
        indexState: "ready",
        dirty: false,
        watermark: "w-81",
        indexedFacts: 81,
        unindexedFacts: 0,
        droppedNotifications: 0,
        refreshCount: 1,
        rebuildCount: 1,
        missingExposureRuns: 0,
        missingTimeFacts: 0,
        unknownUsageAttempts: 0,
        sourceCoverage: { ...OBSERVATION_COVERAGE, byFactType: [] },
        remoteExport: { state: "disabled", backlog: 0 },
      };
    },
    async graph(threadId) {
      calls.graph.push(threadId);
      return {
        threadId,
        nodes: [],
        edges: [],
        coverage: OBSERVATION_COVERAGE,
        asOf: "2026-10-21T12:00:00.000Z",
        watermark: "w-81",
      };
    },
    async trace(runId) {
      calls.trace.push(runId);
      return {
        runId,
        traceId: "1234567890abcdef1234567890abcdef",
        threadId: "thread/one",
        conversationId: "conversation/one",
        run: null,
        facts: [{
          type: "tool_invocation",
          factId: "fact:tool/one",
          sourceKind: "behavior_record",
          sourceRef: "tool/one",
          sourceRevision: "1",
          schemaVersion: 1,
          deploymentId: "deployment/one",
          storagePartitionId: "home/one",
          projectionVersion: 1,
          occurredAt: "2026-10-21T11:59:00.000Z",
          threadId: "thread/one",
          conversationId: "conversation/one",
          runId,
          traceId: "1234567890abcdef1234567890abcdef",
          turnId: "turn/one",
          originRunId: null,
          parentRunId: null,
          requestRef: null,
          attemptId: "attempt/one",
          toolCallId: "call/one",
          executionId: "execution/one",
          delegationId: null,
          deliveryId: null,
          contentRefs: [CONTENT_REF],
          coverage: OBSERVATION_COVERAGE,
          missingFields: [],
          payload: {
            phase: "terminal",
            status: "succeeded",
            toolName: "edit",
            caller: "model",
            logicalInvocationId: "call/one",
            parentExecutionId: null,
            responseFactId: null,
            startedAt: "2026-10-21T11:59:00.000Z",
            endedAt: "2026-10-21T11:59:00.010Z",
            durationMs: 10,
          },
        }],
        links: [],
        coverage: OBSERVATION_COVERAGE,
        asOf: "2026-10-21T12:00:00.000Z",
        watermark: "w-81",
      };
    },
    async execution(executionId) {
      calls.execution.push(executionId);
      return {
        executionId,
        logicalInvocationId: "call/one",
        runId: "run/one",
        toolName: "edit",
        caller: "model",
        status: "succeeded",
        parentExecutionId: null,
        attempts: [{
          attemptId: "attempt/one",
          status: "succeeded",
          startedAt: "2026-10-21T11:59:00.000Z",
          endedAt: "2026-10-21T11:59:00.010Z",
          durationMs: 10,
          inputRef: null,
          outputRef: CONTENT_REF,
        }],
        coverage: OBSERVATION_COVERAGE,
        asOf: "2026-10-21T12:00:00.000Z",
        watermark: "w-81",
      };
    },
    async content(ref) {
      calls.content.push(ref);
      return {
        status: "available",
        ref,
        content: "tool output",
        contentType: "text/plain",
        redactions: [],
        reason: null,
      };
    },
  };
  return service;
}
// #endregion

describe("dsh-bridge Observe page", () => {
  describe("module registration", () => {
    it("registers both pages as package-local chunks that build their view", () => {
      const observe = chunkFactories.get("client.observe.js")();
      const detail = chunkFactories.get("client.observation-detail.js")();
      expect(typeof observe.createObserveView).toBe("function");
      expect(typeof detail.createObservationDetail).toBe("function");
    });

    it("keeps each page's two dictionaries in step", () => {
      const { observe, observationDetail } = buildObserve();
      for (const module of [observe, observationDetail]) {
        expect(Object.keys(module.dictionary.en).sort()).toEqual(Object.keys(module.dictionary.zh).sort());
      }
    });

    it("declares the areas the entry registers, and no key the shell already owns", () => {
      const { observe, observationDetail } = buildObserve();
      expect(Object.keys(observe.demoFixture)).toEqual(["observe"]);
      expect(Object.keys(observationDetail.demoFixture)).toEqual(["observationDetail"]);
      const owned = /^(sidebar\.|header\.|composer\.|panel\.|field\.|value\.|delegation\.|action\.|demo\.|tool\.subagent\.|settings\.)/;
      for (const key of Object.keys(observe.dictionary.zh)) expect(key).not.toMatch(owned);
      for (const key of Object.keys(observationDetail.dictionary.zh)) expect(key).not.toMatch(owned);
    });
  });

  describe("production (demo off)", () => {
    it("draws the layout but reads no fixture, so every value is unknown", () => {
      const built = buildObserve({ demo: false });
      expect(built.services.fixture("observe")).toBeNull();

      const view = mountPage(built);
      const text = view.text();
      expect(text).toContain("观测服务未连接");
      expect(text).toContain("未知");
      // No sample value reaches the page while demo is off.
      expect(text).not.toContain("1.42M");
      expect(text).not.toContain("09:12");
      expect(text).not.toContain("1284");
      // The demo-only scenario control is not drawn at all.
      expect(byAttr(view.tree(), "data-option", "zero")).toBeUndefined();
    });

    it("still offers the filters, and the tool ranking says there is nothing to rank", () => {
      const view = mountPage(buildObserve());
      expect(byAttr(view.tree(), "data-option", "7d")).toBeDefined();
      expect(byAttr(view.tree(), "data-option", "subagent")).toBeDefined();
      expect(view.text()).toContain("本窗口没有工具调用记录");
    });
  });

  describe("demo: filters", () => {
    it("shows the fixture only while demo is on", () => {
      const built = buildObserve();
      const view = mountPage(built);
      expect(view.text()).not.toContain("09:12");
      built.services.setDemo(true);
      view.update();
      expect(view.text()).toContain("asOf 09:12");
      built.services.setDemo(false);
      view.update();
      expect(view.text()).not.toContain("09:12");
    });

    it("offers the three windows and the three scopes, with the selected one marked", () => {
      const view = mountPage(buildObserve({ demo: true }));
      for (const id of ["24h", "7d", "30d", "entry", "subagent", "all"]) {
        expect(byAttr(view.tree(), "data-option", id), `missing option ${id}`).toBeDefined();
      }
      expect(byAttr(view.tree(), "data-option", "24h").props["data-active"]).toBe("true");
      expect(byAttr(view.tree(), "data-option", "entry").props["data-active"]).toBe("true");
      expect(byAttr(view.tree(), "data-option", "7d").props["data-active"]).toBeUndefined();
    });

    it("changes the meta line when the window changes", () => {
      const view = mountPage(buildObserve({ demo: true }));
      expect(view.text()).toContain("索引水位 1284");

      click(view, "data-option", "7d");
      expect(byAttr(view.tree(), "data-option", "7d").props["data-active"]).toBe("true");
      expect(view.text()).toContain("索引水位 8210");
      expect(view.text()).not.toContain("索引水位 1284");
    });

    it("changes the cohort when the scope changes", () => {
      const view = mountPage(buildObserve({ demo: true }));
      expect(view.text()).toContain("Core 服务接口核对");

      click(view, "data-option", "subagent");
      expect(view.text()).toContain("researcher");
      expect(view.text()).toContain("planner");
      expect(view.text()).not.toContain("Core 服务接口核对");

      click(view, "data-option", "all");
      expect(view.text()).toContain("Core 服务接口核对");
      expect(view.text()).toContain("researcher");
    });
  });

  describe("demo: key metrics", () => {
    it("gives every metric its numerator and denominator", () => {
      const view = mountPage(buildObserve({ demo: true }));
      const text = view.text();
      expect(text).toContain("工具请求触发率");
      expect(text).toContain("25%");
      expect(text).toContain("20 / 80 曝光 Run");
      expect(text).toContain("90%");
      expect(text).toContain("36 / 40 已开始执行");
    });

    it("shows N/A rather than 0% when the denominator is zero", () => {
      const view = mountPage(buildObserve({ demo: true }));
      const skill = byAttr(view.tree(), "data-metric", "skillReadRate");
      expect(skill.props["data-state"]).toBe("na");
      expect(textOf(skill.props.children)).toContain("N/A");
      expect(textOf(skill.props.children)).toContain("本窗口无曝光");
      expect(textOf(skill.props.children)).not.toContain("0%");
    });
  });

  describe("demo: tool ranking", () => {
    it("lists the columns the design names, per tool", () => {
      const view = mountPage(buildObserve({ demo: true }));
      const text = view.text();
      for (const column of ["工具", "曝光 Run", "请求触发率", "次数", "成功率", "p50 / p95"]) {
        expect(text).toContain(column);
      }
      const edit = byAttr(view.tree(), "data-tool", "edit");
      expect(textOf(edit.props.children)).toContain("edit");
      expect(textOf(edit.props.children)).toContain("80");
      expect(textOf(edit.props.children)).toContain("50");
      expect(textOf(edit.props.children)).toContain("0.4s / 1.2s");
    });

    it("shows the success rate with both its numerator and denominator", () => {
      const view = mountPage(buildObserve({ demo: true }));
      const edit = byAttr(view.tree(), "data-tool", "edit");
      const success = elementsOf(edit.props.children).find((node) => node.props?.["data-success-rate"] !== undefined);
      expect(success.props["data-success-rate"]).toBe("90%");
      expect(success.props["data-numerator"]).toBe("45");
      expect(success.props["data-denominator"]).toBe("50");
      expect(textOf(edit.props.children)).toContain("45/50");
    });

    it("lists refusals and pre-execution cancellations separately, out of the failure count", () => {
      const view = mountPage(buildObserve({ demo: true }));
      const edit = byAttr(view.tree(), "data-tool", "edit");
      expect(edit.props["data-rejects"]).toBe("5");
      expect(edit.props["data-cancelled"]).toBe("5");
      expect(view.text()).toContain("拒绝 5 次、执行前取消 5 次单列，不并入失败");
    });
  });

  describe("demo: tokens and quality", () => {
    it("shows tokens by Run and by Turn, and never derives a cost", () => {
      const view = mountPage(buildObserve({ demo: true }));
      expect(byAttr(view.tree(), "data-token", "input").props["data-value"]).toBe("1.42M");
      expect(byAttr(view.tree(), "data-token", "cacheRead").props["data-value"]).toBe("1.10M");
      expect(view.text()).toContain("costKnown = false");

      buttonWith(view.tree(), "按 Turn").props.onClick();
      view.update();
      expect(byAttr(view.tree(), "data-token", "input").props["data-value"]).toBe("142K");
    });

    it("keeps a measured zero, an unknown and an uncovered value apart", () => {
      const view = mountPage(buildObserve({ demo: true }));
      expect(byAttr(view.tree(), "data-quality", "unindexed").props["data-value"]).toBe("0");
      expect(byAttr(view.tree(), "data-quality", "missingExposure").props["data-value"]).toBe("3");
      expect(view.text()).toContain("无记录 ≠ 未触发");

      click(view, "data-option", "unknown");
      expect(byAttr(view.tree(), "data-quality", "unindexed").props["data-value"]).toBe("未知");
      expect(byAttr(view.tree(), "data-quality", "droppedFrames").props["data-value"]).toBe("未覆盖");
    });
  });

  describe("demo: scenarios", () => {
    it("switches to the zero-denominator sample and shows N/A everywhere", () => {
      const view = mountPage(buildObserve({ demo: true }));
      click(view, "data-option", "zero");
      for (const id of ["toolRequestRate", "toolSuccessRate", "subagentStartRate", "skillReadRate"]) {
        expect(byAttr(view.tree(), "data-metric", id).props["data-state"]).toBe("na");
      }
      expect(view.text()).toContain("本窗口没有工具调用记录");
    });

    it("switches to the unknown sample and withholds values", () => {
      const view = mountPage(buildObserve({ demo: true }));
      click(view, "data-option", "unknown");
      expect(byAttr(view.tree(), "data-metric", "toolRequestRate").props["data-state"]).toBe("unknown");
      expect(byAttr(view.tree(), "data-token", "input").props["data-value"]).toBe("未知");
    });

    it("switches to the unsupported sample and names the dimension Core does not provide", () => {
      const view = mountPage(buildObserve({ demo: true }));
      click(view, "data-option", "unsupported");
      expect(byAttr(view.tree(), "data-metric", "skillReadRate").props["data-state"]).toBe("unsupported");
      expect(view.text()).toContain("不支持");
      expect(view.text()).toContain("该维度 Core 未提供");
    });

    it("switches to the error sample and offers a retry that reports itself unwired", async () => {
      const built = buildObserve({ demo: true });
      const view = mountPage(built);
      click(view, "data-option", "error");
      expect(byAttr(view.tree(), "data-error", "core.unavailable")).toBeDefined();
      expect(view.text()).toContain("观测数据读取失败");

      buttonWith(view.tree(), "重试").props.onClick();
      await Promise.resolve();
      view.update();
      expect(built.services.outcomeOf("observe.retry").status).toBe("unsupported");
      expect(view.text()).toContain("未接入 · 未执行");
    });
  });

  describe("demo: member detail carrier", () => {
    it("drills into a member and hosts the detail the entry supplies", () => {
      const view = mountPage(buildObserve({ demo: true }));
      expect(view.text()).not.toContain("成员详情");

      click(view, "data-member-view", "run_7f3c");
      expect(byAttr(view.tree(), "data-member-detail", "run_7f3c")).toBeDefined();
      expect(view.text()).toContain("成员详情");
      expect(view.text()).toContain("Trace · 按 Turn");
    });

    it("says the carrier is unwired when no module supplies a detail", () => {
      const view = mountPage(buildObserve({ demo: true, memberDetail: false }));
      click(view, "data-member-view", "run_7f3c");
      expect(byAttr(view.tree(), "data-detail", "unavailable")).toBeDefined();
      expect(view.text()).toContain("成员详情区域未接入");
    });

    it("reads the member detail at render time, so a part filled in later still appears", () => {
      const built = buildObserve({ demo: true, memberDetail: false });
      const view = mountPage(built);
      click(view, "data-member-view", "run_7f3c");
      expect(byAttr(view.tree(), "data-detail", "unavailable")).toBeDefined();

      // The entry fills `parts.MemberDetail` after `createObserveView` returns.
      built.parts.MemberDetail = built.observationDetail.MemberDetail;
      view.update();
      expect(byAttr(view.tree(), "data-member-detail", "run_7f3c")).toBeDefined();
    });
  });

  describe("actions", () => {
    it("reports the view-all action as unwired rather than a success", async () => {
      const built = buildObserve({ demo: true });
      const view = mountPage(built);
      const button = buttonWith(view.tree(), "查看全部");
      expect(button).toBeDefined();

      button.props.onClick();
      await Promise.resolve();
      view.update();
      expect(built.services.outcomeOf("observe.viewAll").status).toBe("unsupported");
      expect(view.text()).toContain("未接入 · 未执行");
    });
  });
});

describe("dsh-bridge member detail", () => {
  /** The detail's own translator; its keys are the module's, not the page's. */
  function detailT(built) {
    return translate(built.observationDetail.dictionary.zh);
  }

  /** Mount the detail directly, the way the Observe page hosts it. */
  function mountDetail(member, { demo = true } = {}) {
    const built = buildObserve({ demo });
    const view = mount(built.observationDetail.MemberDetail, {
      member,
      t: detailT(built),
      onClose: () => {},
    });
    return { view, ...built };
  }

  it("draws a sub-agent's facts and, in demo, its per-Turn trace", () => {
    const { view } = mountDetail({
      id: "sa_researcher",
      kind: "subagent",
      name: "researcher",
      mode: "sync",
      status: "running",
      description: "只读调研代码与文档，输出带出处的结论",
      turns: 4,
      tokens: { input: 26000, output: 4200 },
    });
    const text = view.text();
    expect(text).toContain("researcher");
    expect(text).toContain("子 Agent");
    expect(text).toContain("运行中");
    expect(text).toContain("同步");
    expect(text).toContain("26K / 4K");
    expect(text).toContain("Trace · 按 Turn");
    expect(byAttr(view.tree(), "data-trace", "1")).toBeDefined();
    expect(byAttr(view.tree(), "data-trace", "4")).toBeDefined();
  });

  it("draws a tool member's success rate with its numerator and denominator", () => {
    const { view } = mountDetail({
      id: "edit",
      kind: "tool",
      name: "edit",
      exposedRuns: 80,
      calls: 50,
      successRate: { numerator: 45, denominator: 50 },
      rejects: 5,
      cancelled: 5,
      p50: "0.4s",
      p95: "1.2s",
    });
    const text = view.text();
    expect(text).toContain("工具");
    expect(text).toContain("90% (45/50)");
    expect(text).toContain("0.4s / 1.2s");
  });

  it("withholds the trace while demo is off", () => {
    const { view } = mountDetail(
      { id: "sa_researcher", kind: "subagent", name: "researcher", status: "running" },
      { demo: false },
    );
    expect(view.text()).toContain("无 Trace 记录");
    expect(view.text()).not.toContain("3.2s");
  });

  it("closes through its own control", () => {
    let closed = 0;
    const built = buildObserve({ demo: true });
    const view = mount(built.observationDetail.MemberDetail, {
      member: { id: "run_7f3c", kind: "run", name: "Core 服务接口核对", status: "running", turns: 3 },
      t: detailT(built),
      onClose: () => {
        closed += 1;
      },
    });
    buttonWith(view.tree(), "关闭").props.onClick();
    expect(closed).toBe(1);
  });

  it("reports its trace action as unwired", async () => {
    const built = buildObserve({ demo: true });
    const member = { id: "sa_planner", kind: "subagent", name: "planner", status: "done" };
    const props = { member, t: detailT(built), onClose: () => {} };
    const view = mount(built.observationDetail.MemberDetail, props);

    buttonWith(view.tree(), "查看 Trace").props.onClick();
    await Promise.resolve();
    view.update(props);
    expect(built.services.outcomeOf("detail.viewTrace:sa_planner").status).toBe("unsupported");
    expect(view.text()).toContain("未接入 · 未执行");
  });
});

describe("Observe Core-backed queries and drill-down", () => {
  const fixedNow = new Date("2026-10-21T12:00:00.000Z");

  function useFixedClock() {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes the browser observation facade through same-origin GETs with query and ref fields", async () => {
    const requests = [];
    const serviceModule = chunkFactories.get("client.services.js")();
    const transport = serviceModule.createCoreTransport({
      base: "/super-agent",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, async json() { return {}; } };
      },
    });
    const services = serviceModule.createServices({ transport });
    expect(services.observations).toBe(transport.observations);

    const query = {
      window: {
        from: "2026-10-01T00:00:00.000Z", until: "2026-10-21T00:00:00.000Z", basis: "run_started_at",
      },
      scope: "subagent_only",
      includeDescendants: true,
      filters: {
        agentDefinitionVersion: "agent/2", modelBinding: "provider/model with space", toolVersion: null,
        skillVersion: "review@3", permissionMode: "approve_none", runSource: "retry", deploymentVersion: "deploy-7",
      },
      metrics: ["tool.request_trigger_rate", "skill.context_rate"],
      groupBy: ["modelBinding", "skillVersion"],
    };
    await services.observations.metrics(query);
    await services.observations.tools(query);
    await services.observations.usage({ ...query, groupBy: "turn", metrics: undefined });
    await services.observations.members({ queryId: "query/with slash", side: "denominator", cursor: "c/2" });
    await services.observations.health();
    await services.observations.graph("thread/one?x=1");
    await services.observations.trace("run/one?x=1");
    await services.observations.execution("execution/one?x=1");
    const ref = { kind: "document", id: "文档/one?x=1", part: "snapshot" };
    await services.observations.content(ref);

    expect(requests).toHaveLength(9);
    for (const { url, options } of requests) {
      expect(new URL(url, "https://harness.example").origin).toBe("https://harness.example");
      expect(options).toMatchObject({ method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
    }
    const metricUrl = new URL(requests[0].url, "https://harness.example");
    expect(metricUrl.pathname).toBe("/super-agent/observation/metrics");
    expect(metricUrl.searchParams.getAll("metric")).toEqual(query.metrics);
    expect(metricUrl.searchParams.getAll("groupBy")).toEqual(query.groupBy);
    expect(metricUrl.searchParams.get("scope")).toBe(query.scope);
    expect(metricUrl.searchParams.get("includeDescendants")).toBe("true");
    expect(metricUrl.searchParams.get("modelBinding")).toBe("provider/model with space");
    expect(metricUrl.searchParams.has("toolVersion")).toBe(false);

    expect(new URL(requests[1].url, "https://harness.example").pathname).toBe("/super-agent/observation/tools");
    const usageUrl = new URL(requests[2].url, "https://harness.example");
    expect(usageUrl.pathname).toBe("/super-agent/observation/usage");
    expect(usageUrl.searchParams.get("groupBy")).toBe("turn");
    const membersUrl = new URL(requests[3].url, "https://harness.example");
    expect(membersUrl.pathname).toBe("/super-agent/observation/members");
    expect(Object.fromEntries(membersUrl.searchParams)).toEqual({ queryId: "query/with slash", side: "denominator", cursor: "c/2" });
    expect(new URL(requests[4].url, "https://harness.example").pathname).toBe("/super-agent/observation/health");
    expect(new URL(requests[5].url, "https://harness.example").searchParams.get("threadId")).toBe("thread/one?x=1");
    expect(new URL(requests[6].url, "https://harness.example").searchParams.get("runId")).toBe("run/one?x=1");
    expect(new URL(requests[7].url, "https://harness.example").searchParams.get("executionId")).toBe("execution/one?x=1");
    const contentUrl = new URL(requests[8].url, "https://harness.example");
    const encodedRef = contentUrl.searchParams.get("ref");
    expect(contentUrl.pathname).toBe("/super-agent/observation/content");
    expect(encodedRef).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(encodedRef, "base64url").toString("utf8"))).toEqual(ref);
  });

  it("queries only the live service with a complete, shared window and filter DTO", async () => {
    useFixedClock();
    const observations = observationServiceFixture();
    const built = buildObserve({ observations });
    const view = mountPage(built);
    await settle(view);

    expect(built.services.fixture("observe")).toBeNull();
    expect(observations.calls.metrics).toHaveLength(1);
    expect(observations.calls.tools).toHaveLength(1);
    expect(observations.calls.usage).toHaveLength(1);

    const query = observations.calls.metrics[0];
    expect(query).toEqual({
      window: {
        from: "2026-10-20T12:00:00.000Z",
        until: "2026-10-21T12:00:00.000Z",
        basis: "run_started_at",
      },
      scope: "entry_only",
      includeDescendants: false,
      filters: OBSERVATION_FILTERS,
      metrics: OBSERVATION_METRICS,
      groupBy: [],
    });
    expect(observations.calls.tools[0]).toEqual(query);
    expect(observations.calls.usage[0]).toEqual({
      window: query.window,
      scope: query.scope,
      includeDescendants: query.includeDescendants,
      filters: query.filters,
      groupBy: "run",
    });
    expect(view.text()).not.toContain("1.42M");
    expect(view.text()).not.toContain("09:12");
    view.unmount();
  });

  it("keeps healthy observation sections visible when one request fails and old payload fields are absent", async () => {
    useFixedClock();
    const observations = observationServiceFixture();
    observations.metrics = async () => ({ metrics: [{ queryId: "old", metric: "tool.request_trigger_rate", value: null }], watermark: 0 });
    observations.tools = async () => { throw new Error("tools unavailable"); };
    observations.usage = async () => ({});
    observations.health = async () => ({});
    const view = mountPage(buildObserve({ observations }));
    await settle(view);
    expect(view.text()).toContain("tools unavailable");
    expect(view.text()).toContain("关键指标");
    expect(view.text()).toContain("Token 用量");
    expect(view.text()).toContain("重新查询");
    view.unmount();
  });

  it("maps window and scope controls to query values without dropping config filters", async () => {
    useFixedClock();
    const observations = observationServiceFixture();
    const view = mountPage(buildObserve({ observations }));
    await settle(view);

    click(view, "data-option", "7d");
    await settle(view);
    const week = observations.calls.metrics.at(-1);
    expect(week.window).toEqual({
      from: "2026-10-14T12:00:00.000Z",
      until: "2026-10-21T12:00:00.000Z",
      basis: "run_started_at",
    });
    expect(week.scope).toBe("entry_only");
    expect(week.filters).toEqual(OBSERVATION_FILTERS);

    click(view, "data-option", "subagent");
    await settle(view);
    const subagents = observations.calls.metrics.at(-1);
    expect(subagents.scope).toBe("subagent_only");
    expect(subagents.includeDescendants).toBe(false);
    expect(subagents.window).toEqual(week.window);
    expect(subagents.filters).toEqual(OBSERVATION_FILTERS);
    expect(observations.calls.tools.at(-1)).toEqual(subagents);
    expect(observations.calls.usage.at(-1)).toMatchObject({
      scope: "subagent_only",
      includeDescendants: false,
      window: week.window,
      filters: OBSERVATION_FILTERS,
    });
    view.unmount();
  });

  it("exposes every config filter and metric, and displays returned group metadata", async () => {
    useFixedClock();
    const observations = observationServiceFixture();
    const readMetrics = observations.metrics;
    observations.metrics = async (query) => {
      const result = await readMetrics(query);
      const key = query.groupBy[0];
      return {
        ...result,
        metrics: result.metrics.map((metric) => ({
          ...metric,
          group: key ? { [key]: "provider/model-7" } : {},
        })),
      };
    };
    const view = mountPage(buildObserve({ observations }));
    await settle(view);

    const filterInputs = elementsOf(view.tree()).filter((node) => node.props?.["data-observation-filter"] !== undefined);
    expect(filterInputs.map((node) => node.props["data-observation-filter"]).sort()).toEqual(Object.keys(OBSERVATION_FILTERS).sort());
    const dimensions = Object.keys(OBSERVATION_FILTERS);
    const groupSelect = elementsOf(view.tree()).find((node) => node.type === "select");
    expect(elementsOf(groupSelect).filter((node) => node.type === "option").map((node) => node.props.value)).toEqual(["", ...dimensions]);

    const allMetricsLabel = elementsOf(view.tree()).find((node) => node.type === "label" && textOf(node).includes("显示全部指标"));
    const allMetricsCheckbox = elementsOf(allMetricsLabel).find((node) => node.type === "input");
    allMetricsCheckbox.props.onChange({ target: { checked: true } });
    view.update();
    await settle(view);
    expect(observations.calls.metrics.at(-1).metrics).toEqual(ALL_LIVE_METRICS);

    const currentGroupSelect = elementsOf(view.tree()).find((node) => node.type === "select");
    currentGroupSelect.props.onChange({ target: { value: "modelBinding" } });
    view.update();
    await settle(view);
    expect(observations.calls.metrics.at(-1).groupBy).toEqual(["modelBinding"]);
    expect(view.text()).toContain("模型绑定: provider/model-7");

    const agentFilter = byAttr(view.tree(), "data-observation-filter", "agentDefinitionVersion");
    agentFilter.props.onChange({ target: { value: "agent/2026" } });
    view.update();
    await settle(view);
    expect(observations.calls.metrics.at(-1).filters).toMatchObject({ agentDefinitionVersion: "agent/2026" });
    view.unmount();
  });

  it("does not let an older filter request overwrite the newer result", async () => {
    useFixedClock();
    const batches = {};
    let currentBatch = 0;
    const deferred = () => {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      return { promise, resolve };
    };
    const slot = (name) => {
      batches[currentBatch] ??= {};
      const value = deferred();
      batches[currentBatch][name] = value;
      return value.promise;
    };
    const observations = {
      metrics: () => { currentBatch += 1; return slot("metrics"); },
      tools: () => slot("tools"),
      usage: () => slot("usage"),
      health: () => slot("health"),
    };
    const view = mountPage(buildObserve({ observations }));
    expect(Object.keys(batches)).toEqual(["1"]);

    click(view, "data-option", "7d");
    expect(Object.keys(batches)).toEqual(["1", "2"]);
    const fulfill = (batch, watermark) => {
      batch.metrics.resolve({ asOf: "2026-10-21T12:00:00.000Z", watermark, metrics: [] });
      batch.tools.resolve({ asOf: "2026-10-21T12:00:00.000Z", watermark, rows: [] });
      batch.usage.resolve({ queryId: `usage-${watermark}`, asOf: "2026-10-21T12:00:00.000Z", watermark, query: {}, coverage: OBSERVATION_COVERAGE, buckets: [] });
      batch.health.resolve({ indexState: "ready", unindexedFacts: 0, droppedNotifications: 0, missingExposureRuns: 0,
        remoteExport: { backlog: 0 }, sourceCoverage: { state: "complete" } });
    };

    fulfill(batches[2], "w-new");
    await settle(view);
    expect(view.text()).toContain("索引水位 w-new");
    fulfill(batches[1], "w-old");
    await settle(view);
    expect(view.text()).toContain("索引水位 w-new");
    expect(view.text()).not.toContain("w-old");
    view.unmount();
  });

  it("keeps live errors and unknown content out of the demo fixture", async () => {
    useFixedClock();
    const failed = observationServiceFixture();
    failed.metrics = async () => {
      const error = new Error("query snapshot expired");
      error.code = "CURSOR_EXPIRED";
      throw error;
    };
    const errorView = mountPage(buildObserve({ observations: failed }));
    await settle(errorView);
    expect(byAttr(errorView.tree(), "role", "alert")).toBeDefined();
    expect(errorView.text()).toContain("query snapshot expired");
    expect(errorView.text()).not.toContain("Core 服务接口核对");
    expect(errorView.text()).not.toContain("1.42M");
    errorView.unmount();

    const observations = observationServiceFixture();
    observations.content = async (ref) => {
      observations.calls.content.push(ref);
      return { status: "unknown", ref, content: null, contentType: null, redactions: [], reason: "not retained" };
    };
    const view = mountPage(buildObserve({ observations }));
    await settle(view);
    click(view, "data-metric-side", "tool.request_trigger_rate:numerator");
    await settle(view);
    click(view, "data-member-view", "run/one");
    await settle(view);
    click(view, "data-thread-graph", "thread/one");
    await settle(view);
    click(view, "data-execution-view", "execution/one");
    await settle(view);
    click(view, "data-content-ref", Buffer.from(JSON.stringify(CONTENT_REF), "utf8").toString("base64url"));
    await settle(view);
    expect(view.text()).toContain("unknown · not retained");
    expect(view.text()).not.toContain("tool output");
    expect(view.text()).not.toContain("Core 服务接口核对");
    expect(observations.calls.content).toEqual([CONTENT_REF]);
    view.unmount();
  });

  it("pins member pages to the returned metric queryId and drills through returned refs", async () => {
    useFixedClock();
    const observations = observationServiceFixture();
    const view = mountPage(buildObserve({ observations }));
    await settle(view);

    click(view, "data-metric-side", "tool.request_trigger_rate:numerator");
    await settle(view);
    expect(observations.calls.members.at(-1)).toMatchObject({
      queryId: "q:tool.request_trigger_rate",
      side: "numerator",
    });
    expect(observations.calls.members.at(-1)).not.toHaveProperty("filters");
    expect(observations.calls.members.at(-1)).not.toHaveProperty("window");
    expect(byAttr(view.tree(), "data-member-view", "run/one")).toBeDefined();

    click(view, "data-member-view", "run/one");
    await settle(view);
    expect(observations.calls.trace).toContain("run/one");
    expect(byAttr(view.tree(), "data-thread-graph", "thread/one")).toBeDefined();

    click(view, "data-thread-graph", "thread/one");
    await settle(view);
    expect(observations.calls.graph).toEqual(["thread/one"]);
    expect(byAttr(view.tree(), "data-execution-view", "execution/one")).toBeDefined();

    click(view, "data-execution-view", "execution/one");
    await settle(view);
    const encodedRef = Buffer.from(JSON.stringify(CONTENT_REF), "utf8").toString("base64url");
    expect(byAttr(view.tree(), "data-content-ref", encodedRef)).toBeDefined();

    click(view, "data-content-ref", encodedRef);
    await settle(view);
    expect(observations.calls.execution).toEqual(["execution/one"]);
    expect(observations.calls.content).toEqual([CONTENT_REF]);
    expect(view.text()).toContain("tool output");
    view.unmount();
  });
});
