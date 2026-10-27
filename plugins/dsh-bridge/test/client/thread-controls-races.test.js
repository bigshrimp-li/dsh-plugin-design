import { beforeEach, describe, expect, it } from "vitest";

/**
 * Public UI regressions for Thread controls. The panel is rendered through the
 * same chunk factories and action facade as the client entry; only React's
 * element and hook surface is represented here, as in main.test.js.
 */

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.styles.js");
await import("../../src/client/client.services.js");
await import("../../src/client/client.shell.js");
await import("../../src/client/client.run-panel.js");
await import("../../src/client/index.js");

const factories = new Map(loaded.map((definition) => [definition.chunk ?? "entry", definition.factory]));
let hookStates = [];
let hookCursor = 0;

function sameDeps(previous, next) {
  return previous !== undefined && next !== undefined && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
}

function fakeReact() {
  return {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { type, props: merged };
    },
    useState(initial) {
      const index = hookCursor++;
      if (!Object.hasOwn(hookStates, index)) hookStates[index] = typeof initial === "function" ? initial() : initial;
      return [hookStates[index], (value) => {
        hookStates[index] = typeof value === "function" ? value(hookStates[index]) : value;
      }];
    },
    useEffect(run, deps) {
      const index = hookCursor++;
      const previous = hookStates[index];
      if (previous !== undefined && sameDeps(previous.deps, deps)) return;
      if (typeof previous?.cleanup === "function") previous.cleanup();
      hookStates[index] = { deps, cleanup: run() };
    },
  };
}

function resetHooks() {
  for (const state of hookStates) if (typeof state?.cleanup === "function") state.cleanup();
  hookStates = [];
  hookCursor = 0;
}

function fakeRequire(specifier) {
  if (specifier === "react") return fakeReact();
  throw new Error(`unexpected require: ${specifier}`);
}

function translate(dictionary) {
  return (key, params) => {
    const raw = dictionary[key];
    if (raw === undefined) return key;
    return raw.replace(/\{(\w+)\}/g, (match, name) => params && Object.hasOwn(params, name) ? String(params[name]) : match);
  };
}

/** Expand function components once and collect both visible text and elements. */
function inspectTree(node, elements = [], words = []) {
  if (node === null || node === undefined || node === false) return { elements, words };
  if (Array.isArray(node)) {
    for (const child of node) inspectTree(child, elements, words);
    return { elements, words };
  }
  if (typeof node === "string" || typeof node === "number") {
    words.push(String(node));
    return { elements, words };
  }
  if (typeof node !== "object") return { elements, words };
  elements.push(node);
  if (node.type === "style") return { elements, words };
  if (typeof node.type === "function") inspectTree(node.type(node.props), elements, words);
  else inspectTree(node.props?.children, elements, words);
  return { elements, words };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function threadView(overrides = {}) {
  return {
    threadId: "thread-a",
    mainConversationId: "conversation-a",
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
  };
}

function buildControls({ threadViews, failingActions = new Map() }) {
  const kernel = factories.get("entry")(fakeRequire).createKernel({
    CSS: factories.get("client.styles.js")().CSS,
    STYLE_ID: "@super-agent/dsh-bridge/client.css",
  });
  const servicesModule = factories.get("client.services.js")();
  const calls = [];
  const transport = {
    async call(id, payload) {
      calls.push({ id, payload });
      const failure = failingActions.get(id);
      if (failure !== undefined) throw failure;
      if (id === "thread.get") {
        const answer = threadViews.get(payload.threadId);
        if (answer === undefined) throw new Error(`no scripted view for ${payload.threadId}`);
        return await (typeof answer === "function" ? answer() : answer);
      }
      if (id === "messages.list") {
        return { status: "done", result: { items: [], nextCursor: null, watermark: 0, caughtUp: true } };
      }
      return {
        status: "done",
        result: {
          requestId: `request:${id}`,
          resourceId: payload.threadId,
          state: "applied",
          receiptSeq: 11,
        },
      };
    },
  };
  const services = servicesModule.createServices({
    initial: {
      connection: "ready",
      sessionId: "dsh-session-a",
      threadId: "thread-a",
      conversationId: "conversation-a",
      run: null,
    },
    transport,
  });
  const shell = factories.get("client.shell.js")().createShell({
    kernel,
    services,
    views: {},
    blocks: { set() {} },
  });
  const panel = factories.get("client.run-panel.js")().createRunPanel({
    kernel,
    services,
    parts: { ActionBtn: shell.ActionBtn },
  });
  const t = translate({ ...shell.dictionary.zh, ...panel.dictionary.zh });
  shell.bindTranslate(t);

  const render = (threadId, revision) => {
    expect(panel.ThreadControls, "ThreadControls is wired into the public Run panel").toBeTypeOf("function");
    hookCursor = 0;
    const tree = panel.ThreadControls({ services, t, threadId, enabled: true, revision });
    return inspectTree(tree);
  };
  const buttonSaying = (rendered, label) => rendered.elements.find(
    (element) => element.type === "button" && visibleText(element.props.children).includes(label),
  );
  const visibleText = (node) => {
    if (node === null || node === undefined || node === false) return "";
    if (Array.isArray(node)) return node.map(visibleText).join("");
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (typeof node !== "object") return "";
    if (node.type === "style") return "";
    if (typeof node.type === "function") return visibleText(node.type(node.props));
    return visibleText(node.props?.children);
  };
  return {
    calls,
    panel,
    services,
    render,
    buttonSaying,
    threadReadCount: () => calls.filter((call) => call.id === "thread.get").length,
  };
}

async function settle() {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

beforeEach(resetHooks);

describe("Thread controls after a Thread switch", () => {
  it("drops a late prior Thread read and keeps only choices made for the visible Thread", async () => {
    const lateB = deferred();
    const { calls, render, buttonSaying } = buildControls({
      threadViews: new Map([
        ["thread-a", Promise.resolve({
          status: "done",
          result: threadView({
            status: "paused_by_user",
            runs: [{ runId: "run-a", conversationId: "conversation-a", status: "cancelled" }],
            queuedInputIds: [{ inputId: "input-a", conversationId: "conversation-a" }],
          }),
        })],
        ["thread-b", lateB.promise],
        ["thread-c", Promise.resolve({
          status: "done",
          result: {
            ...threadView({ threadId: "thread-c", mainConversationId: "conversation-c", status: "idle" }),
            runs: [{ runId: "run-c", conversationId: "conversation-c", status: "cancelled" }],
            queuedInputIds: [{ inputId: "input-c", conversationId: "conversation-c" }],
          },
        })],
      ]),
    });

    render("thread-a");
    await settle();
    let view = render("thread-a");
    expect(view.words.join("")).toContain("paused_by_user");
    buttonSaying(view, "run-a · cancelled").props.onClick();
    view = render("thread-a");
    expect(buttonSaying(view, "恢复 Thread").props.disabled).toBe(false);

    // B starts a read that will answer after the panel has moved on to C.
    render("thread-b");
    const cView = render("thread-c");
    await settle();
    view = render("thread-c");
    expect(view.words.join("")).toContain("idle");
    expect(view.words.join("")).not.toContain("paused_by_user");
    expect(buttonSaying(view, "恢复 Thread").props.disabled).toBe(true);
    expect(buttonSaying(view, "run-c · cancelled")).toBeDefined();

    // B's stale answer must not overwrite C's view or add its Run/input as a
    // selectable choice after the switch.
    lateB.resolve({
      status: "done",
      result: {
        ...threadView({ threadId: "thread-b", mainConversationId: "conversation-b", status: "archived" }),
        runs: [{ runId: "run-b", conversationId: "conversation-b", status: "cancelled" }],
        queuedInputIds: [{ inputId: "input-b", conversationId: "conversation-b" }],
      },
    });
    await settle();
    view = render("thread-c");
    expect(view.words.join("")).toContain("idle");
    expect(view.words.join("")).not.toContain("archived");
    expect(buttonSaying(view, "run-b · cancelled")).toBeUndefined();

    buttonSaying(view, "run-c · cancelled").props.onClick();
    view = render("thread-c");
    buttonSaying(view, "恢复 Thread").props.onClick();
    await settle();
    expect(calls.filter((call) => call.id === "thread.resume").at(-1).payload).toEqual({
      threadId: "thread-c",
      continueRunIds: ["run-c"],
    });
    expect(cView.words.join("")).not.toContain("archived");
  });

  it("shows an action failure beside the Core state without inventing a successful receipt", async () => {
    const { render, buttonSaying } = buildControls({
      threadViews: new Map([[
        "thread-a",
        Promise.resolve({
          status: "done",
            result: threadView(),
        }),
      ]]),
      failingActions: new Map([[
        "thread.archive",
        new Error("ARCHIVE_REJECTED: Thread has an unresolved gate"),
      ]]),
    });

    render("thread-a");
    await settle();
    let view = render("thread-a");
    buttonSaying(view, "归档 Core Thread").props.onClick();
    await settle();
    view = render("thread-a");

    const text = view.words.join("");
    expect(text).toContain("ARCHIVE_REJECTED: Thread has an unresolved gate");
    expect(text).toContain("idle");
    expect(text).not.toContain("归档 回执");
  });

  it("can resume an empty paused Thread without starting its cancelled Run or queued input", async () => {
    let readCount = 0;
    const view = (status) => ({
      status: "done",
      result: threadView({
        status,
        runs: [{ runId: "run-left-cancelled", conversationId: "conversation-a", status: "cancelled" }],
        queuedInputIds: [{ inputId: "input-left-queued", conversationId: "conversation-a" }],
      }),
    });
    const { calls, render, buttonSaying } = buildControls({
      threadViews: new Map([["thread-a", () => Promise.resolve(view(readCount++ === 0 ? "paused_by_user" : "idle"))]]),
    });

    render("thread-a");
    await settle();
    let rendered = render("thread-a");
    expect(rendered.words.join("")).toContain("paused_by_user");
    expect(buttonSaying(rendered, "run-left-cancelled · cancelled")).toBeDefined();
    expect(rendered.words.join("")).toContain("input-left-queued · conversation-a");

    // A user pause is itself enough to resume the Thread. With no explicit
    // choice, the request names no work and the Core clears only that pause.
    const resume = buttonSaying(rendered, "恢复 Thread");
    expect(resume.props.disabled).toBe(false);
    resume.props.onClick();
    await settle();

    expect(calls.filter((call) => call.id === "thread.resume").at(-1).payload).toEqual({ threadId: "thread-a" });
    rendered = render("thread-a");
    await settle();
    rendered = render("thread-a");
    expect(rendered.words.join("")).toContain("idle");
    expect(buttonSaying(rendered, "run-left-cancelled · cancelled")).toBeDefined();
    expect(rendered.words.join("")).toContain("input-left-queued · conversation-a");
  });

  it("re-reads on a host revision and manual refresh, then drops choices absent from Core's refreshed view", async () => {
    let currentView = threadView({
      runs: [{ runId: "run-cancelled", conversationId: "conversation-a", status: "cancelled" }],
      queuedInputIds: [{ inputId: "input-queued", conversationId: "conversation-a" }],
    });
    const { calls, render, buttonSaying, threadReadCount } = buildControls({
      threadViews: new Map([[
        "thread-a",
        () => Promise.resolve({ status: "done", result: currentView }),
      ]]),
    });

    render("thread-a", "revision-1");
    await settle();
    let rendered = render("thread-a", "revision-1");
    expect(buttonSaying(rendered, "run-cancelled · cancelled")).toBeDefined();
    expect(rendered.words.join("")).toContain("input-queued · conversation-a");

    buttonSaying(rendered, "run-cancelled · cancelled").props.onClick();
    buttonSaying(rendered, "执行").props.onClick();
    const readsBeforeRevision = threadReadCount();

    // A new host revision causes a fresh Core read while preserving choices
    // whose ids remain in that Core view.
    currentView = threadView({
      status: "paused_by_user",
      runs: [{ runId: "run-cancelled", conversationId: "conversation-a", status: "cancelled" }],
      queuedInputIds: [{ inputId: "input-queued", conversationId: "conversation-a" }],
    });
    render("thread-a", "revision-2");
    await settle();
    rendered = render("thread-a", "revision-2");
    expect(threadReadCount()).toBeGreaterThan(readsBeforeRevision);
    expect(buttonSaying(rendered, "恢复 Thread").props.disabled).toBe(false);

    // After manual refresh Core no longer reports either selectable item.
    // The stale choices are filtered and cannot be sent in the resume action.
    const readsBeforeRefresh = threadReadCount();
    currentView = threadView({ status: "paused_by_user" });
    buttonSaying(rendered, "刷新 Thread 状态").props.onClick();
    render("thread-a", "revision-2");
    await settle();
    rendered = render("thread-a", "revision-2");
    expect(threadReadCount()).toBeGreaterThan(readsBeforeRefresh);
    expect(rendered.words.join("")).not.toContain("run-cancelled");
    expect(rendered.words.join("")).not.toContain("input-queued");
    buttonSaying(rendered, "恢复 Thread").props.onClick();
    await settle();
    expect(calls.filter((call) => call.id === "thread.resume").at(-1).payload).toEqual({
      threadId: "thread-a",
    });
  });
});
