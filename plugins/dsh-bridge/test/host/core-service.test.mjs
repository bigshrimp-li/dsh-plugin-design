/**
 * The bridge's Core service: the operations the panel can raise, the state it
 * draws, and the routes the browser half reaches both through.
 *
 * The SDK client is a stand-in — the real one speaks a Unix socket, and what
 * these checks are about is not the socket but the contract on top of it: which
 * action becomes which call, what happens when the caller forgets a request id,
 * and what the panel is told when the Core is not there. A stand-in that
 * *records* its calls is the only way to assert the first, and one that can be
 * made to fail is the only way to assert the last.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CORE_ROUTE_PREFIX,
  CoreServiceError,
  createCoreService,
  createCoreServiceFor,
  isTrustedRequest,
  registerCoreRoutes,
  resolveCoreOptions,
} from "../../src/host/core-service.js";
import { SESSION_MAP_SCHEMA_VERSION, openSessionMap } from "../../src/host/session-map.js";

/** A memory filesystem, for the real session map. */
function memoryFs() {
  const files = new Map();
  return {
    files,
    async mkdir() {},
    async readFile(path) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return files.get(path);
    },
    async writeFile(path, text) {
      files.set(path, text);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

/**
 * The real session map over a memory filesystem, seeded with `entries`.
 *
 * The real one, not a stand-in: whether a session rejoins its Thread or is
 * recorded against the wrong one *is* the answer these checks are about.
 */
async function sessionMapWith(entries = []) {
  const fs = memoryFs();
  const map = await openSessionMap({ path: "/mem/sessions.json", fs });
  for (const entry of entries) await map.put(entry);
  return { map, fs };
}

/** A mapping entry, with the fields the map requires. */
function mapping(overrides = {}) {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    mainConversationId: "29",
    workspaceId: "ws-1",
    workspaceRoot: "/tmp/ws",
    cwd: "/tmp/ws",
    agentId: "main",
    modelId: null,
    createdAt: 1,
    ...overrides,
  };
}

/** A Thread as the Core's listing returns it. */
function threadView(overrides = {}) {
  return {
    threadId: "thread-1",
    mainConversationId: "29",
    status: "running",
    blockingReasons: [],
    controlRevision: 1,
    activeRuns: [],
    queuedRuns: [],
    pendingInputs: 0,
    pendingWaits: 0,
    activeDelegations: 0,
    pendingDeliveries: 0,
    eventSeq: 12,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:01:00.000Z",
    ...overrides,
  };
}

/** An SDK client stand-in that records every call and can be made to fail. */
function fakeClient(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    const answer = typeof result === "function" ? result(...args) : result;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    calls,
    getServerInfo: record("getServerInfo", { pid: 1, startedAt: "2026-10-20T00:00:00.000Z" }),
    getServerLogs: record("getServerLogs", { lines: [] }),
    listThreads: record("listThreads", { items: [], nextCursor: null }),
    getThread: record("getThread", threadView()),
    createThread: record("createThread", { threadId: "thread-1", mainConversationId: "29" }),
    stopThread: record("stopThread", { requestId: "r", resourceId: "thread-1", state: "accepted", receiptSeq: 3 }),
    pauseThread: record("pauseThread", { requestId: "r", resourceId: "thread-1", state: "accepted", receiptSeq: 4 }),
    resumeThread: record("resumeThread", { requestId: "r", resourceId: "thread-1", state: "accepted", receiptSeq: 5 }),
    archiveThread: record("archiveThread", { requestId: "r", resourceId: "thread-1", state: "accepted", receiptSeq: 6 }),
    submitInput: record("submitInput", {
      requestId: "r",
      resourceId: "input-1",
      state: "accepted",
      receiptSeq: 7,
      runId: "run-1",
      delivery: "new_run",
    }),
    getRun: record("getRun", { runId: "run-1", threadId: "thread-1", status: "running" }),
    listTurns: record("listTurns", { items: [], nextCursor: null }),
    listMessages: record("listMessages", { items: [], nextCursor: null }),
    getConversation: record("getConversation", { conversationId: "29" }),
    forkConversation: record("forkConversation", { conversationId: "30" }),
    listWaits: record("listWaits", { items: [], nextCursor: null }),
    answerWait: record("answerWait", { requestId: "r", resourceId: "wait-1", state: "accepted", receiptSeq: 8 }),
    resolvePermission: record("resolvePermission", { requestId: "r", resourceId: "wait-1", state: "accepted", receiptSeq: 9 }),
    redoRun: record("redoRun", { requestId: "r", resourceId: "run-1", state: "accepted", receiptSeq: 10 }),
    findWorkspace: record("findWorkspace", null),
    registerWorkspace: record("registerWorkspace", { workspaceId: "ws-1", root: "/tmp/ws" }),
    ...overrides,
  };
}

/** The service over a stand-in client. */
function serviceOver(client, { now = () => 0, sessionMap = null } = {}) {
  return createCoreService({
    client,
    options: { home: "/tmp/home", socketPath: "/tmp/home/run/core.sock", lockFile: "/tmp/home/run/core.lock" },
    now,
    sessionMap,
  });
}

describe("the Core address", () => {
  it("reads the home and the socket from the environment, and defaults inside the home", () => {
    expect(resolveCoreOptions({ SUPER_AGENT_HOME: "/tmp/h" })).toEqual({
      home: "/tmp/h",
      socketPath: "/tmp/h/run/core.sock",
      lockFile: "/tmp/h/run/core.lock",
    });
    // An operator who moved the socket says so; the home still names the rest.
    expect(resolveCoreOptions({ SUPER_AGENT_HOME: "/tmp/h", SUPER_AGENT_SOCKET: "/tmp/other.sock" }).socketPath).toBe(
      "/tmp/other.sock",
    );
  });
});

describe("raising an operation", () => {
  it("queries attachment evidence for the displayed Conversation rather than the pre-conversation draft scope", async () => {
    const evidence = vi.fn(async () => ({ items: [{ runId: "run-1", conversationId: "29" }] }));
    const service = serviceOver(fakeClient({ attachments: { evidence } }));
    expect(await service.call("attachments.evidence", { attachmentId: "at-1", conversationId: "29" }))
      .toEqual({ items: [{ runId: "run-1", conversationId: "29" }] });
    expect(evidence).toHaveBeenCalledWith("at-1", "29");
  });

  it("maps an action to the SDK call it names, with the caller's arguments", async () => {
    const client = fakeClient();
    const service = serviceOver(client);
    await service.call("thread.stop", { threadId: "thread-1", requestId: "r-1", reason: "user" });
    expect(client.calls).toEqual([{ name: "stopThread", args: ["thread-1", { requestId: "r-1", reason: "user" }] }]);
  });

  it("refuses a state-changing action that carries no request id of its own", async () => {
    const client = fakeClient();
    const service = serviceOver(client);
    // The id is the Core's idempotency key, so a missing one is a refusal to
    // act rather than a command under an id this layer invented.
    await expect(service.call("thread.stop", { threadId: "thread-1" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(client.calls).toEqual([]);
  });

  it("refuses an action this bridge does not offer", async () => {
    const service = serviceOver(fakeClient());
    await expect(service.call("thread.explode", {})).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("refuses a read that names no Thread", async () => {
    const service = serviceOver(fakeClient());
    await expect(service.call("thread.get", {})).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("carries the Core's own error code through, so the browser can act on it", async () => {
    const failure = Object.assign(new Error("no Thread names conversation 29"), { code: "NOT_FOUND" });
    const client = fakeClient({ getThread: async () => Promise.reject(failure) });
    const service = serviceOver(client);
    const caught = await service.call("thread.get", { threadId: "thread-1" }).catch((error) => error);
    expect(caught).toBeInstanceOf(CoreServiceError);
    expect(caught.code).toBe("NOT_FOUND");
    expect(caught.message).toBe("no Thread names conversation 29");
  });

  it("lists every action it offers, so the set can be read in one place", () => {
    const ids = serviceOver(fakeClient()).actionIds();
    expect(ids).toContain("thread.create");
    expect(ids).toContain("run.redo");
    expect(ids).toContain("workspace.find");
  });

  it("returns the SDK's unwrapped workspace lookup view and preserves a null miss", async () => {
    const workspace = { workspaceId: "ws-registered", root: "/workspace", configRevision: "revision" };
    const present = serviceOver(fakeClient({ findWorkspace: async () => workspace }));
    expect(await present.call("workspace.find", { root: "/workspace" })).toEqual(workspace);
    expect(await serviceOver(fakeClient()).call("workspace.find", { root: "/missing" })).toBeNull();
  });
});

describe("what the panel draws", () => {
  it("reports the Thread and Run of the Session the caller named", async () => {
    const client = fakeClient({
      listThreads: async () => ({
        items: [
          threadView({ threadId: "idle-thread", updatedAt: "2026-10-20T00:09:00.000Z" }),
          threadView({ threadId: "busy-thread", activeRuns: ["run-9"], updatedAt: "2026-10-20T00:01:00.000Z" }),
        ],
        nextCursor: null,
      }),
      getThread: async (threadId) =>
        threadView({ threadId, mainConversationId: "29", activeRuns: threadId === "busy-thread" ? ["run-9"] : [] }),
      getRun: async () => ({
        runId: "run-9",
        threadId: "busy-thread",
        conversationId: "29",
        status: "running",
        pendingWaits: 2,
        elapsedMs: 42_000,
        answer: null,
        endReason: null,
      }),
      listTurns: async () => ({
        items: [
          { turnId: "t1", runId: "run-9", status: "completed", toolCallIds: ["c1", "c2"] },
          { turnId: "t2", runId: "run-9", status: "running", toolCallIds: [] },
        ],
        nextCursor: null,
      }),
    });
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "busy-thread" })]);
    const state = await serviceOver(client, { sessionMap: map }).state({ sessionId: "session-1" });
    expect(state.connection).toBe("ready");
    expect(state.threads).toHaveLength(2);
    // The Thread is the one this Session's record names — not the busiest or
    // the newest one in the home, which is another session's Thread.
    expect(state.sessionId).toBe("session-1");
    expect(state.threadId).toBe("busy-thread");
    expect(state.conversationId).toBe("29");
    expect(state.mainConversationId).toBe("29");
    expect(state.run).toEqual({
      runId: "run-9",
      threadId: "busy-thread",
      conversationId: "29",
      status: "running",
      endReason: null,
      answer: null,
      waitingCount: 2,
      elapsed: "00:42",
      turns: [
        { n: 1, tools: 2, state: "done" },
        { n: 2, tools: 0, state: "running" },
      ],
    });
  });

  it("keeps two sessions apart when both are open, whichever ran last", async () => {
    const client = fakeClient({
      listThreads: async () => ({
        items: [threadView({ threadId: "thread-a" }), threadView({ threadId: "thread-b", updatedAt: "2026-10-20T00:09:00.000Z" })],
        nextCursor: null,
      }),
      getThread: async (threadId) => threadView({ threadId, mainConversationId: threadId === "thread-a" ? "11" : "22" }),
    });
    const { map } = await sessionMapWith([
      mapping({ sessionId: "session-a", threadId: "thread-a", mainConversationId: "11" }),
      mapping({ sessionId: "session-b", threadId: "thread-b", mainConversationId: "22", createdAt: 2 }),
    ]);
    const service = serviceOver(client, { sessionMap: map });

    // Alternating reads: each answers for the session it was asked about, and
    // the more recently touched Thread never leaks into the other's answer.
    expect(await service.state({ sessionId: "session-a" })).toMatchObject({
      threadId: "thread-a",
      conversationId: "11",
    });
    expect(await service.state({ sessionId: "session-b" })).toMatchObject({
      threadId: "thread-b",
      conversationId: "22",
    });
    expect(await service.state({ sessionId: "session-a" })).toMatchObject({ threadId: "thread-a" });
  });

  it("reports a forked session's own Conversation, not the Thread's main one", async () => {
    const client = fakeClient({
      getThread: async () => threadView({ threadId: "thread-1", mainConversationId: "29" }),
    });
    const { map } = await sessionMapWith([
      mapping({ sessionId: "session-fork", threadId: "thread-1", mainConversationId: "29", conversationId: "77" }),
    ]);
    const state = await serviceOver(client, { sessionMap: map }).state({ sessionId: "session-fork" });
    expect(state.threadId).toBe("thread-1");
    expect(state.conversationId).toBe("77");
    // The Thread's own line is still reported, so a reader can tell a fork from
    // the branch it came from.
    expect(state.mainConversationId).toBe("29");
  });

  it("claims no Thread when the caller names none, and still lists the home's Threads", async () => {
    const client = fakeClient({
      listThreads: async () => ({
        items: [
          threadView({ threadId: "older", updatedAt: "2026-10-20T00:01:00.000Z" }),
          threadView({ threadId: "newer", updatedAt: "2026-10-20T00:09:00.000Z" }),
        ],
        nextCursor: null,
      }),
    });
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "newer" })]);
    const state = await serviceOver(client, { sessionMap: map }).state();
    // The list is the whole home, and it is labelled as such; the *attribution*
    // is what a caller without a session id cannot have, so it gets `null`
    // rather than whichever Thread happens to be newest.
    expect(state.threads).toHaveLength(2);
    expect(state.sessionId).toBeNull();
    expect(state.threadId).toBeNull();
    expect(state.run).toBeNull();
  });

  it("reports a session with no Thread yet as having none", async () => {
    const { map } = await sessionMapWith();
    const state = await serviceOver(fakeClient(), { sessionMap: map }).state({ sessionId: "session-new" });
    expect(state.connection).toBe("ready");
    expect(state.sessionId).toBe("session-new");
    expect(state.threadId).toBeNull();
    expect(state.conversationId).toBeNull();
    expect(state.run).toBeNull();
  });

  it("reports nothing for a Thread the home no longer holds, rather than a stale id", async () => {
    const client = fakeClient({
      getThread: async () => Promise.reject(Object.assign(new Error("no such Thread"), { code: "NOT_FOUND" })),
    });
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "thread-gone" })]);
    const state = await serviceOver(client, { sessionMap: map }).state({ sessionId: "session-1" });
    expect(state.connection).toBe("ready");
    expect(state.threadId).toBeNull();
    // The record is left alone: a read that repaired it would turn a Core that
    // is briefly away into a session that has lost its Thread for good.
    expect(map.get("session-1").threadId).toBe("thread-gone");
  });

  it("carries the config of the Session's own Conversation, and no path of this home", async () => {
    const client = fakeClient({
      getConversation: async (conversationId) => ({
        conversationId,
        threadId: "thread-1",
        agentId: "main",
        agentRevision: "agent-rev-2",
        configRevision: "config-rev-3",
        inheritedThrough: null,
        createdAt: "2026-10-20T00:00:00.000Z",
        config: {
          provider: "super-agent",
          modelId: "go-main",
          thinkingLevel: "high",
          permissionMode: "workspace_auto",
          cwd: "/tmp/ws",
          workspaceRoots: ["/tmp/ws"],
          skillRoots: ["/skills/one", "/skills/two"],
          maxOutputTokens: 4096,
        },
      }),
    });
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "thread-1" })]);
    const state = await serviceOver(client, { sessionMap: map }).state({ sessionId: "session-1" });
    expect(state.snapshot).toEqual({
      sessionId: "session-1",
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
    });
    // The card draws no path, so none of this home's paths travel to the browser
    // with it — the Core's own view carries them, and this answer does not.
    expect(JSON.stringify(state.snapshot)).not.toContain("/tmp/ws");
  });

  it("reads the config of the Conversation the Session is showing, fork or not", async () => {
    const asked = [];
    const client = fakeClient({
      getConversation: async (conversationId) => {
        asked.push(conversationId);
        return { conversationId, agentId: "main", config: { provider: "super-agent", modelId: "go-main" } };
      },
    });
    const { map } = await sessionMapWith([
      mapping({ sessionId: "session-fork", threadId: "thread-1", mainConversationId: "29", conversationId: "77" }),
    ]);
    const state = await serviceOver(client, { sessionMap: map }).state({ sessionId: "session-fork" });
    // The fork's own branch Conversation, not the Thread's main one: the config
    // a session runs under is the config of the Conversation it is showing.
    expect(asked).toEqual(["77"]);
    expect(state.snapshot).toMatchObject({ sessionId: "session-fork", conversationId: "77" });
  });

  it("names a config read that failed as its own failure, not as the Core being down", async () => {
    const client = fakeClient({
      getConversation: async () => Promise.reject(Object.assign(new Error("no such Conversation"), { code: "NOT_FOUND" })),
    });
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "thread-1" })]);
    const state = await serviceOver(client, { sessionMap: map }).state({ sessionId: "session-1" });
    // The link is up and reported as up; the config is what failed, and it is
    // named rather than passed off as an unreachable Core.
    expect(state.connection).toBe("ready");
    expect(state.core.error).toBeNull();
    expect(state.snapshot).toBeNull();
    expect(state.snapshotError).toEqual({ code: "NOT_FOUND", message: "no such Conversation" });
    // And the identity is unaffected: one read failing is not the whole answer.
    expect(state.threadId).toBe("thread-1");
    expect(state.conversationId).toBe("29");
    expect(state.sessionId).toBe("session-1");
  });

  it("reads no config when the Session has no Conversation to read one from", async () => {
    const client = fakeClient();
    const { map } = await sessionMapWith();
    const state = await serviceOver(client, { sessionMap: map }).state({ sessionId: "session-new" });
    expect(state.connection).toBe("ready");
    expect(state.snapshot).toBeNull();
    expect(state.snapshotError).toBeNull();
    // No Conversation, so no read was attempted — the absence is not a failure.
    expect(client.calls.map((call) => call.name)).not.toContain("getConversation");
  });

  it("reports an unreadable record as its own failure, not as the Core being down", async () => {
    const fs = memoryFs();
    fs.files.set("/mem/sessions.json", "{ not json");
    const map = await openSessionMap({ path: "/mem/sessions.json", fs }).catch(() => null);
    expect(map).toBeNull();
    // A service whose provider raises the same way the real one does.
    const service = serviceOver(fakeClient(), {
      sessionMap: async () => {
        throw new Error("Unexpected token i in JSON at position 2");
      },
    });
    const state = await service.state({ sessionId: "session-1" });
    // The link is fine and is reported as fine; the record is what failed, and
    // it is named — an unreadable record is not an empty one.
    expect(state.connection).toBe("ready");
    expect(state.core.error).toBeNull();
    expect(state.sessionError).toMatchObject({ message: expect.stringContaining("Unexpected token") });
    expect(state.threadId).toBeNull();
  });

  it("says the record is missing when this build has none, rather than that the session has no Thread", async () => {
    const state = await serviceOver(fakeClient()).state({ sessionId: "session-1" });
    expect(state.connection).toBe("ready");
    expect(state.sessionError).toMatchObject({ code: "NOT_SUPPORTED" });
    expect(state.threadId).toBeNull();
  });

  it("reports the Core as unreachable instead of throwing, with the reason it gave", async () => {
    const failure = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    const client = fakeClient({ getServerInfo: async () => Promise.reject(failure) });
    const state = await serviceOver(client).state();
    expect(state.connection).toBe("offline");
    expect(state.threads).toEqual([]);
    expect(state.run).toBeNull();
    expect(state.core.error).toEqual({ code: "ENOENT", message: "connect ENOENT" });
  });

  it("remembers the last successful call, and clears the failure on the next one", async () => {
    let fail = true;
    const client = fakeClient({
      getServerInfo: async () => {
        if (fail) throw Object.assign(new Error("down"), { code: "INTERNAL" });
        return { pid: 2 };
      },
    });
    const service = serviceOver(client, { now: () => 1_700_000_000_000 });
    expect((await service.state()).connection).toBe("offline");
    fail = false;
    const state = await service.state();
    expect(state.connection).toBe("ready");
    expect(state.core.error).toBeNull();
    expect(state.core.lastOkAt).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("recording a fork's session", () => {
  /** A client whose Conversation 77 lives in thread-1. */
  const forkedClient = () =>
    fakeClient({
      getThread: async (threadId) => threadView({ threadId, mainConversationId: "29" }),
      getConversation: async (conversationId) => ({ conversationId, threadId: "thread-1", inheritedThrough: 12 }),
    });

  it("writes the new session against its source's Thread and the fork's Conversation", async () => {
    const { map, fs } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "thread-1" })]);
    const service = serviceOver(forkedClient(), { sessionMap: map, now: () => 500 });
    const result = await service.call("session.associate", {
      requestId: "r-1",
      sessionId: "session-2",
      sourceSessionId: "session-1",
      threadId: "thread-1",
      conversationId: "77",
    });
    expect(result).toEqual({ sessionId: "session-2", threadId: "thread-1", conversationId: "77" });

    // On disk, not only in memory: the association is what makes the next
    // start rejoin the forked Conversation instead of creating a new Thread.
    const written = JSON.parse(fs.files.get("/mem/sessions.json"));
    const child = written.sessions.find((entry) => entry.sessionId === "session-2");
    expect(child).toMatchObject({
      threadId: "thread-1",
      mainConversationId: "29",
      conversationId: "77",
      // Inherited from the source: the two sessions run one Thread, so the
      // Workspace and agent are the same facts, not re-derived ones.
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/ws",
      agentId: "main",
    });
    // The source's own record is untouched.
    expect(written.sessions.find((entry) => entry.sessionId === "session-1")).toMatchObject({
      threadId: "thread-1",
      conversationId: "29",
    });
  });

  it("refuses a source session that has no Thread to fork from", async () => {
    const { map } = await sessionMapWith();
    const service = serviceOver(forkedClient(), { sessionMap: map });
    await expect(
      service.call("session.associate", {
        requestId: "r-1",
        sessionId: "session-2",
        sourceSessionId: "session-1",
        threadId: "thread-1",
        conversationId: "77",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(map.get("session-2")).toBeUndefined();
  });

  it("refuses a fork that claims to land in a different Thread", async () => {
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "thread-1" })]);
    const service = serviceOver(forkedClient(), { sessionMap: map });
    // A fork is a Conversation *in* a Thread, so a Thread that changed is not a
    // fork — and recording it would point the new session at another line.
    await expect(
      service.call("session.associate", {
        requestId: "r-1",
        sessionId: "session-2",
        sourceSessionId: "session-1",
        threadId: "thread-9",
        conversationId: "77",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(map.get("session-2")).toBeUndefined();
  });

  it("refuses a Conversation the Core does not place in that Thread", async () => {
    const client = fakeClient({
      getConversation: async (conversationId) => ({ conversationId, threadId: "somewhere-else" }),
    });
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "thread-1" })]);
    const service = serviceOver(client, { sessionMap: map });
    await expect(
      service.call("session.associate", {
        requestId: "r-1",
        sessionId: "session-2",
        sourceSessionId: "session-1",
        threadId: "thread-1",
        conversationId: "77",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(map.get("session-2")).toBeUndefined();
  });

  it("refuses the write when this build has no session map at all", async () => {
    const service = serviceOver(forkedClient());
    await expect(
      service.call("session.associate", {
        requestId: "r-1",
        sessionId: "session-2",
        sourceSessionId: "session-1",
        threadId: "thread-1",
        conversationId: "77",
      }),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});

describe("the routes", () => {
  /** A web server stand-in that records registrations and can dispatch to one. */
  function fakeWebServer() {
    const routes = new Map();
    return {
      routes,
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    };
  }

  /** A request stand-in: headers, a method, and a body to read. */
  function request({ method = "GET", headers = {}, body = "", url = "/" } = {}) {
    const chunks = body === "" ? [] : [Buffer.from(body, "utf8")];
    return {
      method,
      headers: { host: "127.0.0.1:3000", ...headers },
      url,
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
      on() {},
      off() {},
    };
  }

  /** A response stand-in that collects what was written. */
  function response() {
    const written = [];
    return {
      status: null,
      headers: null,
      written,
      body: "",
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      write(text) {
        written.push(text);
        this.body += text;
      },
      end(text) {
        if (text !== undefined) this.body += text;
      },
    };
  }

  function routesOver(service, log = {}) {
    const webServer = fakeWebServer();
    const effect = (run) => {
      run();
      return () => {};
    };
    const paths = registerCoreRoutes({ webServer, effect, service, log });
    return { webServer, paths };
  }

  it("registers the three routes under one prefix, through the plugin's own lifetime", () => {
    const registered = [];
    const effect = (run) => {
      registered.push(run);
      return () => {};
    };
    const paths = registerCoreRoutes({
      webServer: fakeWebServer(),
      effect,
      service: serviceOver(fakeClient()),
      log: {},
    });
    expect(paths).toEqual([
      `${CORE_ROUTE_PREFIX}/state`,
      `${CORE_ROUTE_PREFIX}/action`,
      `${CORE_ROUTE_PREFIX}/events`,
    ]);
    expect(registered).toHaveLength(3);
  });

  it("serves the state the panel draws", async () => {
    const { webServer } = routesOver(serviceOver(fakeClient()));
    const res = response();
    await webServer.routes.get(`${CORE_ROUTE_PREFIX}/state`).handler(request(), res);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).connection).toBe("ready");
  });

  it("reads the session the panel names off the query, so the answer is about it", async () => {
    const client = fakeClient({
      getThread: async () => threadView({ threadId: "thread-1", mainConversationId: "29" }),
    });
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "thread-1" })]);
    const { webServer } = routesOver(serviceOver(client, { sessionMap: map }));
    const res = response();
    await webServer.routes
      .get(`${CORE_ROUTE_PREFIX}/state`)
      .handler(request({ url: `${CORE_ROUTE_PREFIX}/state?sessionId=session-1` }), res);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      sessionId: "session-1",
      threadId: "thread-1",
      conversationId: "29",
    });
  });

  it("serves the config snapshot the panel draws over the state route", async () => {
    const client = fakeClient({
      getThread: async () => threadView({ threadId: "thread-1", mainConversationId: "29" }),
      getConversation: async (conversationId) => ({
        conversationId,
        agentId: "main",
        agentRevision: "agent-rev-2",
        configRevision: "config-rev-3",
        config: { provider: "super-agent", modelId: "go-main", thinkingLevel: null, permissionMode: "workspace_auto", skillRoots: [] },
      }),
    });
    const { map } = await sessionMapWith([mapping({ sessionId: "session-1", threadId: "thread-1" })]);
    const { webServer } = routesOver(serviceOver(client, { sessionMap: map }));
    const res = response();
    await webServer.routes
      .get(`${CORE_ROUTE_PREFIX}/state`)
      .handler(request({ url: `${CORE_ROUTE_PREFIX}/state?sessionId=session-1` }), res);
    // The browser half has no path to the Core: what the card draws is what
    // this route carried, so the snapshot has to be in the answer itself.
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).snapshot).toMatchObject({
      sessionId: "session-1",
      conversationId: "29",
      config: { provider: "super-agent", modelId: "go-main" },
    });
  });

  it("raises an action and answers with the Core's result", async () => {
    const client = fakeClient();
    const { webServer } = routesOver(serviceOver(client));
    const res = response();
    await webServer.routes.get(`${CORE_ROUTE_PREFIX}/action`).handler(
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "thread.stop", payload: { threadId: "thread-1", requestId: "r-1" } }),
      }),
      res,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      result: { requestId: "r", resourceId: "thread-1", state: "accepted", receiptSeq: 3 },
    });
    expect(client.calls.map((call) => call.name)).toEqual(["stopThread"]);
  });

  it("answers a refused action with the code's own status", async () => {
    const { webServer } = routesOver(serviceOver(fakeClient()));
    const res = response();
    await webServer.routes.get(`${CORE_ROUTE_PREFIX}/action`).handler(
      request({ method: "POST", body: JSON.stringify({ action: "thread.stop", payload: {} }) }),
      res,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("INVALID_REQUEST");
  });

  it("refuses a request that did not come from the Harness's own window", async () => {
    const { webServer } = routesOver(serviceOver(fakeClient()));
    const res = response();
    await webServer.routes.get(`${CORE_ROUTE_PREFIX}/state`).handler(
      request({ headers: { host: "127.0.0.1:3000", origin: "https://example.com" } }),
      res,
    );
    expect(res.status).toBe(403);
  });

  it("accepts a service that is still being built, so the routes exist before the SDK loads", async () => {
    const service = serviceOver(fakeClient());
    const { webServer } = routesOver(() => Promise.resolve(service));
    const res = response();
    await webServer.routes.get(`${CORE_ROUTE_PREFIX}/state`).handler(request(), res);
    expect(res.status).toBe(200);
  });

  it("relays committed events with their seq as the cursor, and live frames without one", async () => {
    const service = {
      subscribe({ live }) {
        expect(live).toBe(true);
        return (async function* () {
          yield { kind: "committed", event: { seq: 7, type: "run.started", threadId: "thread-1", payload: {} } };
          yield { kind: "live", frame: { type: "delta", requestRef: "req-1", attempt: 1, index: 0, delta: "hi" } };
        })();
      },
      state: async () => ({}),
      call: async () => ({}),
    };
    const { webServer } = routesOver(service);
    const res = response();
    await webServer.routes.get(`${CORE_ROUTE_PREFIX}/events`).handler(request({ url: "/super-agent/events" }), res);
    // The committed frame is the *default* message — no `event:` line — because
    // a named SSE event only reaches a listener registered for that name, and
    // the browser half has no copy of the Core's event vocabulary.
    expect(res.body).toContain('id: 7\ndata: {"seq":7,"type":"run.started"');
    expect(res.body).toContain('event: live\ndata: {"type":"delta"');
    expect(res.body).not.toContain("id: 8");
  });

  it("builds a service over a socket when the caller has no client", async () => {
    const client = fakeClient();
    const service = await createCoreServiceFor({
      options: { home: "/tmp/h", socketPath: "/tmp/h/run/core.sock", lockFile: "/tmp/h/run/core.lock" },
      client,
    });
    expect(service.options.socketPath).toBe("/tmp/h/run/core.sock");
    expect(service.actionIds()).toContain("thread.get");
  });

  it("resumes only a cursor belonging to the same Core instance after target changes", async () => {
    let scope = "target-a:instance-a";
    const subscriptions = [];
    const service = { eventScope: () => scope, subscribe(input) {
      subscriptions.push(input);
      return (async function* () { yield { kind: "committed", event: { seq: 7, type: "run.started" } }; })();
    } };
    const { webServer } = routesOver(service);
    const handler = webServer.routes.get(`${CORE_ROUTE_PREFIX}/events`).handler;
    const first = response(); await handler(request({ url: "/super-agent/events" }), first);
    const cursor = /^id: (.+)$/m.exec(first.body)[1];
    await handler(request({ url: "/super-agent/events", headers: { "last-event-id": cursor } }), response());
    expect(subscriptions.at(-1)).toMatchObject({ after: 7, expectedEventScope: scope });
    scope = "target-b:instance-b";
    await handler(request({ url: "/super-agent/events", headers: { "last-event-id": cursor } }), response());
    expect(subscriptions.at(-1)).not.toHaveProperty("after");
    expect(subscriptions.at(-1).expectedEventScope).toBe(scope);
    await handler(request({ url: "/super-agent/events", headers: { "last-event-id": "9000" } }), response());
    expect(subscriptions.at(-1)).not.toHaveProperty("after");
  });
});

describe("the subscription seam", () => {
  /** A client whose `subscribe` records what the service handed the SDK. */
  function clientRecordingSubscriptions() {
    const seen = [];
    const client = fakeClient({
      subscribe: (options) => {
        seen.push(options);
        return (async function* () {})();
      },
    });
    return { client, seen };
  }

  it("hands the SDK the Thread its caller named, under the SDK's own field", async () => {
    // This is the seam where a name can go missing, and it is checked through
    // the real adapter rather than a stand-in that records whatever it was
    // given. The service reads the singular `threadId` its callers use and maps
    // it to the SDK's plural `threadIds`; the SDK treats an absent `threadIds` as
    // *every* Thread, so a caller that passed the plural itself would have it
    // dropped here and be handed the whole home — which looks like it worked.
    const { client, seen } = clientRecordingSubscriptions();
    await serviceOver(client).subscribe({ threadId: "thread-1", after: 41, live: true });
    expect(seen).toEqual([{ after: 41, threadIds: ["thread-1"], live: true }]);
  });

  it("records the drop that makes the wrong field look like it worked", async () => {
    // Not a contract to keep, but the trap itself, pinned: the plural is not
    // read here, so a caller that used it is restricted to nothing at all. The
    // two call sites in `host/index.js` both did this, and the fix is at the
    // call sites — this is what would silently come back if one of them did
    // again, and what the SDK's "absent means every Thread" turns into a
    // home-wide watch.
    const { client, seen } = clientRecordingSubscriptions();
    await serviceOver(client).subscribe({ threadIds: ["thread-1"], live: true });
    expect(seen).toEqual([{ live: true }]);
  });

  it("asks for every Thread when no Thread is named, rather than for one", async () => {
    // The other half of the mapping: absence is a request of its own — the
    // panel's own read of the home — and not one Thread with the name missing.
    const { client, seen } = clientRecordingSubscriptions();
    await serviceOver(client).subscribe({ live: true });
    expect(seen).toEqual([{ live: true }]);
  });
});

describe("trusting a request", () => {
  const trusted = (headers) => isTrustedRequest({ headers: { host: "127.0.0.1:3000", ...headers } });

  it("accepts the Harness's own window, and the desktop app's origin", () => {
    expect(trusted({})).toBe(true);
    expect(trusted({ origin: "dsh-app://app" })).toBe(true);
    expect(trusted({ origin: "http://127.0.0.1:3000" })).toBe(true);
    expect(trusted({ host: "localhost:3000" })).toBe(true);
  });

  it("refuses a cross-site page, a foreign origin, and a host that is not loopback", () => {
    expect(trusted({ "sec-fetch-site": "cross-site" })).toBe(false);
    expect(trusted({ origin: "https://example.com" })).toBe(false);
    expect(trusted({ host: "evil.example.com" })).toBe(false);
  });
});

describe("managed Core workspace actions", () => {
  const location = { baseRoot: "/core-home/workspaces", relativePath: "team/project", root: "/core-home/workspaces/team/project", exists: false, directories: [], workspaces: [] };
  function managedService({ instanceId = "core-a", sdkOpen, uds = false } = {}) {
    const managedWorkspaces = { browse: vi.fn(async () => location), open: vi.fn(sdkOpen || (async input => ({ ...location, requestId: input.requestId, state: "ready", workspaceId: "workspace-managed", directoryCreated: true }))) };
    const client = fakeClient({ managedWorkspaces });
    const settingsClient = { getIdentity: vi.fn(async () => ({ instanceId })) };
    const service = createCoreService({ client, settingsClient, options: { home: "/bridge-home", socketPath: "/core-home/run/core.sock", ...(uds ? {} : { baseUrl: "https://remote.example:7443", expectedInstanceId: "core-a" }) } });
    return { service, client, settingsClient, managedWorkspaces };
  }

  it("browses through the current SDK and adds the actual authenticated instance without opening directories", async () => {
    const value = managedService();
    const result = await value.service.call("workspace.managed.browse", { relativePath: "team/project", targetId: "target-a", expectedInstanceId: "core-a" });
    expect(value.managedWorkspaces.browse).toHaveBeenCalledExactlyOnceWith("team/project");
    expect(value.managedWorkspaces.open).not.toHaveBeenCalled();
    expect(result).toEqual({ ...location, targetId: "target-a", instanceId: "core-a", connectionKind: "https" });
    expect(value.client.calls).toEqual([]);
  });

  it("opens with the exact original request id and only returns the completed registration", async () => {
    const value = managedService();
    const result = await value.service.call("workspace.managed.open", { requestId: "original-open", relativePath: "team/project", createIfMissing: true, expectedInstanceId: "core-a", targetId: "target-a" });
    expect(value.managedWorkspaces.open).toHaveBeenCalledExactlyOnceWith({ requestId: "original-open", relativePath: "team/project", createIfMissing: true });
    expect(result).toMatchObject({ state: "ready", workspaceId: "workspace-managed", instanceId: "core-a", targetId: "target-a" });
    await expect(value.service.call("workspace.managed.open", { relativePath: "team/project", expectedInstanceId: "core-a" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(value.managedWorkspaces.open).toHaveBeenCalledTimes(1);
  });

  it("rejects an instance change before invoking the filesystem mutation", async () => {
    const value = managedService({ instanceId: "core-b" });
    await expect(value.service.call("workspace.managed.open", { requestId: "original-open", relativePath: "team/project", createIfMissing: true, expectedInstanceId: "core-a" })).rejects.toMatchObject({ code: "INSTANCE_CHANGED", details: { operationAccepted: false, phase: "bridge_before_core" } });
    expect(value.managedWorkspaces.open).not.toHaveBeenCalled();
  });

  it("marks missing identity arguments as a pre-Core rejection without invoking the mutation", async () => {
    const value = managedService();
    await expect(value.service.call("workspace.managed.open", { requestId: "original-open", relativePath: "team/project" })).rejects.toMatchObject({ code: "INVALID_REQUEST", details: { operationAccepted: false, phase: "bridge_before_core" } });
    expect(value.managedWorkspaces.open).not.toHaveBeenCalled();
    expect(value.settingsClient.getIdentity).not.toHaveBeenCalled();
  });

  it("preserves the Core phase details when registration partially succeeds", async () => {
    const failure = Object.assign(new Error("registry CAS failed after directory creation"), { code: "VERSION_CONFLICT", details: { operationAccepted: true, phase: "register" } });
    const value = managedService({ sdkOpen: async () => { throw failure; } });
    await expect(value.service.call("workspace.managed.open", { requestId: "original-open", relativePath: "team/project", createIfMissing: true, expectedInstanceId: "core-a" })).rejects.toMatchObject({ code: "VERSION_CONFLICT", details: { operationAccepted: true, phase: "register" } });
  });

  it("keeps the managed selector available on legacy UDS with a real process version", async () => {
    const value = managedService({ uds: true });
    const result = await value.service.call("workspace.managed.browse", { relativePath: "", targetId: null });
    expect(result).toMatchObject({ instanceId: null, connectionKind: "uds", serverPid: 1, serverStartedAt: "2026-10-20T00:00:00.000Z", targetId: null });
    expect(value.settingsClient.getIdentity).not.toHaveBeenCalled();
    await value.service.call("workspace.managed.open", { requestId: "uds-open", relativePath: "team/project", createIfMissing: true, expectedServerPid: result.serverPid, expectedServerStartedAt: result.serverStartedAt });
    expect(value.managedWorkspaces.open).toHaveBeenCalledOnce();
    await expect(value.service.call("workspace.managed.open", { requestId: "stale-uds-open", relativePath: "other", expectedServerPid: 99, expectedServerStartedAt: result.serverStartedAt })).rejects.toMatchObject({ code: "INSTANCE_CHANGED" });
    expect(value.managedWorkspaces.open).toHaveBeenCalledOnce();
  });
});
