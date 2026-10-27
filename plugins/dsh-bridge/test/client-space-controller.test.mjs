import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/client/client.space.js", import.meta.url), "utf8");

function loadModule() {
  let module;
  const window = { __ModuleLoader__: { load: definition => { module = definition.factory(); } } };
  runInNewContext(source, {
    window,
    globalThis: { fetch: undefined, localStorage: undefined, EventSource: undefined },
    AbortController,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });
  return module;
}

function createHarness({ threads = [], details = {}, saved = {}, stopResponse, directoryBrowser = { open() {} } } = {}) {
  const calls = [];
  const selectedPanels = [];
  const stored = new Map([["super-agent.space.v1", JSON.stringify(saved)]]);
  const storage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  const summaries = threads.map(({ threadId, conversationId, root }) => ({
    threadId, mainConversationId: conversationId, status: "completed", createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z", root,
  }));
  let nextId = 0;
  const transport = { nextRequestId: action => `${action}-${++nextId}`, call: async () => ({ status: "done" }) };
  const services = { viewState: { set() {} } };
  const ctx = { layout: { selectPanel(panelId) { selectedPanels.push(panelId); } } };
  let viewProps;
  const createSpaceView = props => {
    viewProps = props;
    return { Space() {}, DirectorySection() {} };
  };
  const actionResults = async (action, payload) => {
    calls.push({ action, payload });
    switch (action) {
      case "models.list": return [{ id: "provider/model", selectable: true }];
      case "thread.list": return { items: summaries, nextCursor: null };
      case "conversation.get": {
        const sourceThread = threads.find(item => item.conversationId === payload.conversationId);
        return { conversationId: payload.conversationId, config: { cwd: sourceThread?.root ?? "/work/default" } };
      }
      case "thread.get": return details[payload.threadId] || { threadId: payload.threadId, status: "completed", activeRuns: [], queuedRuns: [] };
      case "thread.stop": {
        if (stopResponse) return await stopResponse(payload);
        return { requestId: payload.requestId, resourceId: payload.threadId, state: "accepted", receiptSeq: 17 };
      }
      case "thread.metadata": {
        const current = details[payload.threadId] || { threadId: payload.threadId, status: "completed", activeRuns: [], queuedRuns: [] };
        details[payload.threadId] = { ...current, ...(payload.title ? { title: payload.title } : {}), ...(typeof payload.pinned === "boolean" ? { pinned: payload.pinned } : {}), ...(payload.archived === false ? { status: "idle", archived: false } : {}) };
        return { state: "accepted" };
      }
      case "thread.archive": details[payload.threadId] = { ...details[payload.threadId], status: "archived" }; return { requestId: payload.requestId, resourceId: payload.threadId, state: "accepted", receiptSeq: 18 };
      case "workspace.register": return { root: payload.root, workspaceId: "ws-local" };
      default: throw new Error(`Unexpected action ${action}`);
    }
  };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith("/super-agent/state")) {
      return { ok: true, json: async () => ({ connection: "ready", core: { status: "ready" } }) };
    }
    if (String(url) === "/super-agent/action") {
      const { action, payload } = JSON.parse(init.body);
      const result = await actionResults(action, payload);
      return { ok: true, json: async () => ({ result }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const kernel = { React: {}, h: (type, props) => ({ type, props }) };
  const createSpace = loadModule().createSpace;
  const result = createSpace({ kernel, services, transport, ctx, Panel: {}, createSpaceView, primitives: {},
    directoryBrowser, fetchImpl, storage, EventSourceImpl: undefined });
  return { ...result, calls, selectedPanels, storage, stored, getViewProps: () => viewProps };
}

describe("Super Agent space controller local organization", () => {
  it("keeps a removed workspace hidden after refresh and leaves its thread ungrouped", async () => {
    const space = createHarness({
      threads: [{ threadId: "thread-a", conversationId: "conversation-a", root: "/work/a" }],
      saved: { directories: [{ root: "/work/a", title: "Alpha" }] },
    });

    await space.controller.refresh();
    await space.controller.removeWorkspace("/work/a");
    await space.controller.refresh();

    const snapshot = space.controller.getSnapshot();
    expect(snapshot.directories).toEqual([]);
    expect(snapshot.removedRoots).toEqual(["/work/a"]);
    expect(snapshot.threads[0].root).toBe("/work/a");
    expect(snapshot.directories.some(directory => directory.root === snapshot.threads[0].root)).toBe(false);
    expect(JSON.parse(space.stored.get("super-agent.space.v1")).removedRoots).toEqual(["/work/a"]);
    expect(space.calls.some(call => call.action === "workspace.remove")).toBe(false);
  });

  it("opens the Super Agent main panel when showing the workspace dialog, but not when hiding it", () => {
    const space = createHarness();

    space.controller.setWorkspaceForm(true);

    expect(space.controller.getSnapshot().workspaceForm).toBe(true);
    expect(space.selectedPanels).toEqual(["@super-agent/dsh-bridge/space"]);

    space.controller.setWorkspaceForm(false);

    expect(space.controller.getSnapshot().workspaceForm).toBe(false);
    expect(space.selectedPanels).toEqual(["@super-agent/dsh-bridge/space"]);
  });

  it("persists rename, pin, manual order, partial view options, and directory browser wiring", async () => {
    const directoryBrowser = { open: "public-picker" };
    const space = createHarness({
      directoryBrowser,
      threads: [
        { threadId: "thread-a", conversationId: "conversation-a", root: "/work/a" },
        { threadId: "thread-b", conversationId: "conversation-b", root: "/work/b" },
      ],
      saved: { directories: [{ root: "/work/a" }], viewOptions: { grouping: "group", threadOrder: "updated", archiveFilter: "hide" } },
    });
    await space.controller.refresh();

    space.controller.renameWorkspace("/work/a", "Alpha renamed");
    await space.controller.pinThread("thread-b", true);
    space.controller.setManualThreadOrder(["thread-b", "thread-a"]);
    space.controller.setViewOptions({ grouping: "flat", archiveFilter: "only" });
    space.registrations.find(entry => entry.slot === "main").component({});

    const snapshot = space.controller.getSnapshot();
    expect(snapshot.directories.find(directory => directory.root === "/work/a").title).toBe("Alpha renamed");
    expect(snapshot.threads.find(thread => thread.threadId === "thread-b")).toMatchObject({ pinned: true, manualOrder: 0 });
    expect(snapshot.threads.find(thread => thread.threadId === "thread-a").manualOrder).toBe(1);
    expect(snapshot.viewOptions).toEqual({ grouping: "flat", threadOrder: "updated", archiveFilter: "only" });
    expect(space.getViewProps().directoryBrowser).toBe(directoryBrowser);
    expect(JSON.parse(space.stored.get("super-agent.space.v1"))).toMatchObject({
      viewOptions: snapshot.viewOptions, manualThreadOrder: ["thread-b", "thread-a"],
    });
  });

  it("rejects duplicate workspace names without changing either directory", async () => {
    const space = createHarness({
      threads: [
        { threadId: "thread-a", conversationId: "conversation-a", root: "/work/a" },
        { threadId: "thread-b", conversationId: "conversation-b", root: "/work/b" },
      ],
      saved: { directories: [{ root: "/work/a", title: "Alpha" }, { root: "/work/b", title: "Beta" }] },
    });
    await space.controller.refresh();

    expect(() => space.controller.renameWorkspace("/work/a", " Beta ")).toThrow("已存在名为“Beta”的工作区。");
    expect(space.controller.getSnapshot().directories).toEqual([
      { root: "/work/a", title: "Alpha" },
      { root: "/work/b", title: "Beta" },
    ]);
  });

  it("refuses active-work archive without implicitly stopping or hiding the thread", async () => {
    const space = createHarness({
      threads: [{ threadId: "thread-a", conversationId: "conversation-a", root: "/work/a" }],
      details: { "thread-a": { threadId: "thread-a", status: "running", activeRuns: ["run-a"], queuedRuns: [] } },
    });
    await space.controller.refresh();
    await expect(space.controller.archiveThread("thread-a")).rejects.toThrow("会话仍有运行");
    expect(space.controller.getSnapshot().threads[0].archived).toBe(false);
    expect(space.calls.map(call => call.action)).not.toContain("thread.stop");
    expect(space.calls.map(call => call.action)).not.toContain("thread.archive");
  });

  it("does not hide an active thread when Core fails to confirm the stop", async () => {
    const space = createHarness({
      threads: [{ threadId: "thread-a", conversationId: "conversation-a", root: "/work/a" }],
      details: { "thread-a": { threadId: "thread-a", status: "waiting", activeRuns: [{ runId: "run-a" }], queuedRuns: [] } },
      stopResponse: async () => ({ state: "accepted", receiptSeq: 9 }),
    });
    await space.controller.refresh();

    await expect(space.controller.archiveThread("thread-a")).rejects.toThrow("会话仍有运行");
    expect(space.controller.getSnapshot().threads[0].archived).toBe(false);
  });

  it("archives a settled thread through Core without stopping it or deleting history", async () => {
    const space = createHarness({
      threads: [{ threadId: "thread-a", conversationId: "conversation-a", root: "/work/a" }],
      details: { "thread-a": { threadId: "thread-a", status: "completed", activeRuns: [], queuedRuns: [] } },
    });
    await space.controller.refresh();
    await space.controller.archiveThread("thread-a");

    expect(space.controller.getSnapshot().threads[0].archived).toBe(true);
    expect(space.calls.map(call => call.action)).toContain("thread.get");
    expect(space.calls.map(call => call.action)).not.toContain("thread.stop");
    expect(space.calls.map(call => call.action)).toContain("thread.archive");
    expect(space.calls.map(call => call.action)).not.toContain("messages.delete");
  });
});
