import { describe, expect, it, vi } from "vitest";

/**
 * Unit checks for the browser half's transport and the facade over it.
 *
 * The browser chunk has no socket and no SDK: what it has is `fetch`, against
 * the routes the host registers. Both are stand-ins here — a `fetch` that
 * records the request it was handed, and an `EventSource` that can be made to
 * deliver a frame. What the checks are about is the contract between the two
 * halves: which action becomes which host operation, where the request id comes
 * from, and what the panel is told when the host refuses.
 *
 * The module registers itself into `window.__ModuleLoader__` at module scope, so
 * a fake loader is installed before the import.
 */

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.services.js");

const services = loaded.find((definition) => definition.chunk === "client.services.js").factory();
const { ACTION, CONNECTION, createServices, createCoreTransport, readSessionHistory } = services;

/** A `fetch` stand-in that records every request and answers from a script. */
function fakeFetch(answer = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const body = typeof answer === "function" ? await answer(url, options) : answer;
    return {
      ok: body?.ok ?? true,
      status: body?.status ?? 200,
      async json() {
        return body?.body ?? null;
      },
    };
  };
  impl.calls = calls;
  /** The JSON body of the nth request. */
  impl.bodyOf = (index) => JSON.parse(calls[index].options.body);
  return impl;
}

/** An `EventSource` stand-in: records the URL and can deliver frames. */
function fakeEventSource() {
  const sources = [];
  class Fake {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.onmessage = null;
      this.closed = 0;
      sources.push(this);
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    emit(type, data) {
      const handler = type === "message" ? this.onmessage : this.listeners.get(type);
      handler?.({ data: JSON.stringify(data) });
    }
    close() {
      this.closed += 1;
    }
  }
  return { Fake, sources };
}

/** A transport over a stand-in host. */
function transportOver(fetchImpl, extra = {}) {
  return createCoreTransport({ fetchImpl, ...extra });
}

function fakeHistoryRemote({ snapshot, pages = [] }) {
  const record = { follows: [], pages: [], signals: [], disposeCount: 0 };
  const remote = {
    follow(options, signal) {
      record.follows.push(options);
      record.signals.push(signal);
      return {
        [Symbol.asyncIterator]() {
          return { next: async () => ({ done: false, value: snapshot }) };
        },
        dispose() {
          record.disposeCount += 1;
        },
      };
    },
    async page(options, signal) {
      record.pages.push(options);
      record.signals.push(signal);
      return pages.shift();
    },
  };
  return { remote, record };
}

const historyEvent = (seq) => ({
  type: "event",
  event: { seq, type: "assistant/message", data: { message: { id: `message-${seq}` } } },
});

describe("reading one public DSH session-history snapshot", () => {
  it("keeps the opening cursor fixed across backward pages and disposes the follow", async () => {
    const address = { kind: "session", sessionId: "session-history" };
    const { remote, record } = fakeHistoryRemote({
      snapshot: {
        type: "snapshot",
        cursor: 100,
        records: [historyEvent(90), historyEvent(80)],
        hasMore: true,
      },
      pages: [
        { ok: true, value: { records: [historyEvent(70), historyEvent(60)], hasMore: true } },
        { ok: true, value: { records: [historyEvent(50)], hasMore: false } },
      ],
    });

    const history = await readSessionHistory(remote, address.sessionId);

    expect(record.follows).toEqual([{ address, maxMessages: 200 }]);
    expect(record.pages).toEqual([
      { address, throughSeq: 100, beforeSeq: 80, maxMessages: 200 },
      { address, throughSeq: 100, beforeSeq: 60, maxMessages: 200 },
    ]);
    expect(history.map((event) => event.seq)).toEqual([50, 60, 70, 80, 90]);
    expect(record.disposeCount).toBe(1);
    expect(record.signals[0].aborted).toBe(true);
    expect(record.signals.every((signal) => signal === record.signals[0])).toBe(true);
  });

  it("rejects a page cursor that does not move and still disposes the follow", async () => {
    const { remote, record } = fakeHistoryRemote({
      snapshot: {
        type: "snapshot",
        cursor: 100,
        records: [historyEvent(90), historyEvent(80)],
        hasMore: true,
      },
      pages: [{ ok: true, value: { records: [historyEvent(80)], hasMore: true } }],
    });

    await expect(readSessionHistory(remote, "session-history")).rejects.toThrow(/分页没有前进/);
    expect(record.pages).toEqual([
      { address: { kind: "session", sessionId: "session-history" }, throughSeq: 100, beforeSeq: 80, maxMessages: 200 },
    ]);
    expect(record.disposeCount).toBe(1);
    expect(record.signals[0].aborted).toBe(true);
  });
});

/**
 * A dsh Session seat stand-in.
 *
 * It records what the transport asked of dsh — which session it forked from and
 * which one it selected — because those two calls *are* the difference between
 * opening a real forked session and quietly starting a blank one.
 */
function fakeSeat({
  current = "session-1",
  child = "session-2",
  forkError = null,
  history = [
    { seq: 10, type: "assistant/message", data: { message: { id: "core-msg-before" } } },
    { seq: 42, type: "assistant/message", data: { message: { id: "core-msg-picked" } } },
    { seq: 90, type: "assistant/message", data: { message: { id: "core-msg-later" } } },
  ],
} = {}) {
  const record = { forks: [], histories: [], selected: [] };
  return {
    record,
    seat: {
      current: () => current,
      async history(sessionId) {
        record.histories.push(sessionId);
        return history;
      },
      async fork(sessionId, atSeq) {
        record.forks.push({ sessionId, atSeq });
        if (forkError !== null) throw forkError;
        return child;
      },
      select(sessionId) {
        record.selected.push(sessionId);
      },
    },
  };
}

/** The Core's chosen entry is in the first page; later history is on page two. */
function forkMessagesPage(payload) {
  const items = payload.cursor === undefined
    ? [
        { messageId: "msg-before", entryId: 7, kind: "assistant" },
        { messageId: "msg-picked", entryId: 12, kind: "assistant" },
      ]
    : [{ messageId: "msg-later", entryId: 20, kind: "assistant" }];
  return {
    ok: true,
    body: { ok: true, result: { items, nextCursor: payload.cursor === undefined ? "page-two" : null } },
  };
}

function inheritedForkMessagesPage(payload) {
  const items = payload.cursor === undefined
    ? [{ messageId: "branch-msg-before", entryId: 7, kind: "assistant" }]
    : [{
        messageId: "branch-msg-picked",
        entryId: 12,
        kind: "assistant",
        // MessageView.origin carries the Core message id without the bridge's
        // `core-` namespace; the bridge applies that namespace when matching
        // the public identity against DSH's persisted event id.
        origin: { conversationId: "29", messageId: "msg-picked" },
      }];
  return {
    ok: true,
    body: { ok: true, result: { items, nextCursor: payload.cursor === undefined ? "page-two" : null } },
  };
}

function forkFetch({
  forked = { conversationId: "77", threadId: "thread-1", inheritedThrough: 12 },
  messagesPage = forkMessagesPage,
} = {}) {
  return fakeFetch((url, options) => {
    const { action, payload } = JSON.parse(options.body);
    if (action === "messages.list") return messagesPage(payload);
    if (action === "conversation.fork") return { ok: true, body: { ok: true, result: forked } };
    return {
      ok: true,
      body: { ok: true, result: { sessionId: "session-2", threadId: "thread-1", conversationId: "77" } },
    };
  });
}

describe("the transport's actions", () => {
  it("sends a stop as the host's thread.stop, under a request id of its own", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: { state: "accepted", receiptSeq: 4 } } });
    const transport = transportOver(fetch);
    const answer = await transport.call("run.stop", { threadId: "thread-1", reason: "user" });

    expect(fetch.calls[0].url).toBe("/super-agent/action");
    expect(fetch.calls[0].options.method).toBe("POST");
    const body = fetch.bodyOf(0);
    expect(body.action).toBe("thread.stop");
    expect(body.payload.threadId).toBe("thread-1");
    expect(body.payload.reason).toBe("user");
    // The id is the Core's idempotency key, and the click is where a retry is
    // decided — so the id is minted at the click, not at the socket.
    expect(typeof body.payload.requestId).toBe("string");
    expect(body.payload.requestId).not.toBe("");
    expect(answer).toEqual({ status: ACTION.DONE, reason: null, result: { state: "accepted", receiptSeq: 4 } });
  });

  it("mints a fresh request id per call, so two clicks are two commands", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    const transport = transportOver(fetch);
    await transport.call("run.stop", { threadId: "thread-1" });
    await transport.call("run.stop", { threadId: "thread-1" });
    expect(fetch.bodyOf(0).payload.requestId).not.toBe(fetch.bodyOf(1).payload.requestId);
  });

  it("maps redo to the operation that names the Run", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    const transport = transportOver(fetch);
    await transport.call("run.redo", { runId: "run-1" });
    expect(fetch.bodyOf(0)).toMatchObject({ action: "run.redo", payload: { runId: "run-1" } });
  });

  it("opens a dsh session for a fork, records the association, and selects it", async () => {
    const fetch = forkFetch();
    const { record, seat } = fakeSeat();
    const transport = transportOver(fetch, { session: seat });
    const answer = await transport.call("run.fork", { conversationId: "29", sourceEntryId: 12 });

    // Core entry 12 is not a DSH sequence number. The chosen message is at DSH
    // seq 42, while later Core/DSH history reaches entry 20/seq 90; the fork
    // must stop at the mapped seq for entry 12, not the newest session event.
    expect(record.forks).toEqual([{ sessionId: "session-1", atSeq: 42 }]);
    expect(record.histories).toEqual(["session-1"]);

    // The chosen Core entry and DSH's persisted messages are resolved across
    // all pages before either side creates a branch; only then is the Core
    // fork, DSH's own fork, and the association written in order.
    expect(fetch.calls.map((call) => JSON.parse(call.options.body).action)).toEqual([
      "messages.list",
      "messages.list",
      "conversation.fork",
      "session.associate",
    ]);
    // The boundary the caller chose travels with the fork: the Core requires
    // `sourceEntryId`, and it is passed through as chosen — not defaulted here.
    expect(fetch.bodyOf(0).payload).toMatchObject({ conversationId: "29", limit: 200 });
    expect(fetch.bodyOf(1).payload).toMatchObject({ conversationId: "29", limit: 200, cursor: "page-two" });
    expect(fetch.bodyOf(2).payload).toMatchObject({ conversationId: "29", sourceEntryId: 12 });
    expect(fetch.bodyOf(3).payload).toMatchObject({
      sessionId: "session-2",
      sourceSessionId: "session-1",
      threadId: "thread-1",
      conversationId: "77",
    });
    // The association carries its own id derived from the fork's, so a retried
    // click re-writes the same record rather than a second one.
    expect(fetch.bodyOf(3).payload.requestId).toBe(`${fetch.bodyOf(2).payload.requestId}:associate`);

    expect(record.selected).toEqual(["session-2"]);
    expect(answer.status).toBe(ACTION.DONE);
    expect(answer.result).toEqual({
      sessionId: "session-2",
      threadId: "thread-1",
      conversationId: "77",
      inheritedThrough: 12,
    });
  });

  it("maps an inherited Core message through origin when forking a fork again", async () => {
    const fetch = forkFetch({ messagesPage: inheritedForkMessagesPage });
    const { record, seat } = fakeSeat();
    const transport = transportOver(fetch, { session: seat });

    await transport.call("run.fork", { conversationId: "branch-conversation", sourceEntryId: 12 });

    // A forked MessageView can have a new Core messageId while origin points
    // at the DSH message retained by the inherited session history. The
    // second fork must use that public origin identity to find the exact DSH
    // event, rather than rejecting a valid inherited boundary or using the
    // latest event in the session.
    expect(record.histories).toEqual(["session-1"]);
    expect(record.forks).toEqual([{ sessionId: "session-1", atSeq: 42 }]);
    expect(fetch.bodyOf(2).payload).toMatchObject({
      conversationId: "branch-conversation",
      sourceEntryId: 12,
    });
  });

  it("names the Core branch it left behind when dsh cannot open the session", async () => {
    const fetch = forkFetch();
    const { seat, record } = fakeSeat({ forkError: new Error("the Host rejects a source with no completed turn") });
    const transport = transportOver(fetch, { session: seat });
    const caught = await transport
      .call("run.fork", { conversationId: "29", sourceEntryId: 12 })
      .catch((error) => error);
    // The Core fork is not undone, so the failure has to say so: the reader
    // needs to know the branch Conversation exists.
    expect(String(caught.message)).toContain("77");
    expect(String(caught.message)).toContain("no completed turn");
    expect(fetch.calls.map((call) => JSON.parse(call.options.body).action)).toEqual([
      "messages.list",
      "messages.list",
      "conversation.fork",
    ]);
    expect(record.forks).toEqual([{ sessionId: "session-1", atSeq: 42 }]);
    expect(record.selected).toEqual([]);
  });

  it("reports a fork as unsupported when the build has no dsh session capability", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    const answer = await transportOver(fetch).call("run.fork", { conversationId: "29", sourceEntryId: 12 });
    expect(answer.status).toBe(ACTION.UNSUPPORTED);
    expect(answer.reason).toMatch(/dsh 会话/);
    // Nothing was forked in the Core either: half a fork is not a fork.
    expect(fetch.calls).toEqual([]);
  });

  it("refuses a fork with no session on screen instead of forking something else", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    const { seat } = fakeSeat({ current: null });
    const answer = await transportOver(fetch, { session: seat }).call("run.fork", {
      conversationId: "29",
      sourceEntryId: 12,
    });
    expect(answer.status).toBe(ACTION.ERROR);
    expect(answer.reason).toMatch(/没有正在显示的会话/);
    expect(fetch.calls).toEqual([]);
  });

  it("refuses the fork before creating a Core branch when the chosen entry has no DSH mapping", async () => {
    const fetch = forkFetch();
    const history = [
      { seq: 10, type: "assistant/message", data: { message: { id: "core-msg-before" } } },
      { seq: 90, type: "assistant/message", data: { message: { id: "core-msg-later" } } },
    ];
    const { record, seat } = fakeSeat({ history });
    const transport = transportOver(fetch, { session: seat });

    await expect(transport.call("run.fork", { conversationId: "29", sourceEntryId: 12 })).rejects.toThrow(
      /尚未同步到 DSH/,
    );

    expect(record.histories).toEqual(["session-1"]);
    expect(record.forks).toEqual([]);
    expect(record.selected).toEqual([]);
    expect(fetch.calls.map((call) => JSON.parse(call.options.body).action)).toEqual([
      "messages.list",
      "messages.list",
    ]);
  });

  it("refuses a fork with no chosen boundary, before anything is sent", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    const { record, seat } = fakeSeat();
    const transport = transportOver(fetch, { session: seat });
    // The Core requires `sourceEntryId`, and a fork has to name the entry it
    // branches at. This half does not invent one — the newest entry, or
    // "whatever is current" — because that would move the branch point without
    // anyone choosing it. So a payload without one never becomes a request, and
    // no session is opened for it either.
    const caught = await transport.call("run.fork", { conversationId: "29" }).catch((error) => error);
    expect(String(caught.message)).toMatch(/sourceEntryId is required/);
    expect(fetch.calls).toEqual([]);
    expect(record.forks).toEqual([]);
  });

  it("refuses a boundary that is not an entry id, rather than coercing it", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    const { seat } = fakeSeat();
    const transport = transportOver(fetch, { session: seat });
    // A string that looks like a number is still not the integer the Core
    // requires; coercing it here would send a request the Core refuses with a
    // code the user cannot act on.
    const caught = await transport
      .call("run.fork", { conversationId: "29", sourceEntryId: "12" })
      .catch((error) => error);
    expect(String(caught.message)).toMatch(/sourceEntryId is required/);
    expect(fetch.calls).toEqual([]);
  });

  it("refuses to send an action whose target it does not have", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    const transport = transportOver(fetch);
    await expect(transport.call("run.stop", {})).rejects.toThrow(/threadId is required/);
    expect(fetch.calls).toEqual([]);
  });

  it("says what it cannot do instead of asking the host to refuse it", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    const transport = transportOver(fetch);
    const answer = await transport.call("core.start", {});
    expect(answer.status).toBe(ACTION.UNSUPPORTED);
    expect(answer.reason).toMatch(/不代拉起/);
    expect(fetch.calls).toEqual([]);
  });

  it("reports an action this build does not know at all", async () => {
    const transport = transportOver(fakeFetch({ body: { ok: true, result: {} } }));
    const answer = await transport.call("something.else", {});
    expect(answer.status).toBe(ACTION.UNSUPPORTED);
    expect(answer.reason).toMatch(/没有对应的 Core 操作/);
  });

  it("reads a reconnect as a state read, and reports what it found", async () => {
    const ready = transportOver(
      fakeFetch({ body: { connection: "ready", core: { error: null }, threads: [], run: null } }),
    );
    expect((await ready.call("core.reconnect", {})).status).toBe(ACTION.DONE);

    const down = transportOver(
      fakeFetch({
        body: { connection: "offline", core: { error: { code: "ENOENT", message: "no socket" } }, threads: [] },
      }),
    );
    const answer = await down.call("core.reconnect", {});
    expect(answer.status).toBe(ACTION.ERROR);
    expect(answer.reason).toBe("no socket");
  });
});

describe("the supplement to a Run", () => {
  it("sends it as a next_turn to the Run the caller names, in that Conversation", async () => {
    const fetch = fakeFetch({
      body: {
        ok: true,
        result: {
          requestId: "r",
          resourceId: "input-9",
          state: "accepted",
          receiptSeq: 4,
          inputId: "input-9",
          runId: "run-7",
          delivery: "next_turn",
        },
      },
    });
    await transportOver(fetch).call("run.supplement", {
      threadId: "thread-1",
      requestId: "sap-supplement-1",
      text: "再看一下",
      targetRunId: "run-7",
      conversationId: "77",
    });
    const body = fetch.bodyOf(0);
    expect(body.action).toBe("input.submit");
    // `next_turn` with the target named: the words join that Run's later Turns
    // instead of queueing behind it, and they are written into the Conversation
    // the caller addressed rather than whatever the Core would pick.
    expect(body.payload).toMatchObject({
      threadId: "thread-1",
      text: "再看一下",
      delivery: "next_turn",
      targetRunId: "run-7",
      conversationId: "77",
    });
    // The id is the caller's, not one minted per request — see the retry below.
    expect(body.payload.requestId).toBe("sap-supplement-1");
  });

  it("retries one supplement under the id it was given, not under a fresh one", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: { inputId: "input-9", runId: "run-7" } } });
    const transport = transportOver(fetch);
    const supplement = {
      threadId: "thread-1",
      requestId: "sap-supplement-1",
      text: "再看一下",
      targetRunId: "run-7",
      conversationId: "77",
    };
    await transport.call("run.supplement", supplement);
    await transport.call("run.supplement", supplement);
    // Both attempts are the same command: the same id and the same target. A
    // fresh id per attempt would make a slow answer into two accepted inputs,
    // and a target left out of the retry is how the words become a second Run.
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.bodyOf(1).payload).toEqual(fetch.bodyOf(0).payload);
    expect(fetch.bodyOf(1).payload.delivery).toBe("next_turn");
    expect(fetch.bodyOf(1).payload.targetRunId).toBe("run-7");
  });

  it("refuses a supplement with no target Run instead of sending it as a new Run", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    await expect(
      transportOver(fetch).call("run.supplement", {
        threadId: "thread-1",
        requestId: "sap-supplement-1",
        text: "再说一句",
      }),
    ).rejects.toThrow(/targetRunId is required/);
    // Nothing left this half: the words did not become a `new_run` under a
    // target that was invented here, which is the failure the design names.
    expect(fetch.calls).toEqual([]);
  });

  it("refuses a supplement with no words", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: {} } });
    await expect(
      transportOver(fetch).call("run.supplement", {
        threadId: "thread-1",
        requestId: "sap-supplement-1",
        targetRunId: "run-7",
        text: "",
      }),
    ).rejects.toThrow(/text is required/);
    expect(fetch.calls).toEqual([]);
  });

  it("keeps the Core's refusal as the Core's, without retrying it as a new Run", async () => {
    const fetch = fakeFetch({
      ok: false,
      status: 409,
      body: { error: { code: "RUN_NOT_ACTIVE", message: "Run run-7 is not active" } },
    });
    const services = createServices({ transport: transportOver(fetch) });
    const outcome = await services.run("run.supplement", {
      threadId: "thread-1",
      requestId: "sap-supplement-1",
      text: "再看一下",
      targetRunId: "run-7",
      conversationId: "77",
    });
    expect(outcome.status).toBe(ACTION.ERROR);
    expect(outcome.reason).toContain("Run run-7 is not active");
    // One request, still a `next_turn`: a refusal is the Core's answer, not a
    // reason to send the same words again as a second Run.
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.bodyOf(0).payload.delivery).toBe("next_turn");
  });
});

describe("the transport's state read", () => {
  it("names the session on screen, so the host answers about that session", async () => {
    const fetch = fakeFetch({ body: { connection: "ready", core: {}, threads: [], threadId: "thread-1" } });
    const { seat } = fakeSeat({ current: "session-9" });
    await transportOver(fetch, { session: seat }).state();
    // The identity travels with the read rather than being assumed by the host:
    // two panels open at once must not be answered about the same Thread.
    expect(fetch.calls[0].url).toBe("/super-agent/state?sessionId=session-9");
  });

  it("reads without a session id when nothing is on screen, rather than naming another session", async () => {
    const fetch = fakeFetch({ body: { connection: "ready", core: {}, threads: [] } });
    const { seat } = fakeSeat({ current: null });
    await transportOver(fetch, { session: seat }).state();
    // No `?sessionId=` at all: the host is asked the question it can answer
    // without attribution, rather than one carrying a session id from nowhere.
    expect(fetch.calls[0].url).toBe("/super-agent/state");
  });

  it("keeps the session id in the offline state, because that fact is local", async () => {
    const { seat } = fakeSeat({ current: "session-9" });
    const state = await transportOver(async () => {
      throw new Error("Failed to fetch");
    }, { session: seat }).state();
    expect(state.connection).toBe(CONNECTION.OFFLINE);
    expect(state.sessionId).toBe("session-9");
    expect(state.threadId).toBeNull();
    // Nothing was read from the Core, so there is no config snapshot and no
    // config failure either: the card says it is not connected, which is true.
    expect(state.snapshot).toBeNull();
    expect(state.snapshotError).toBeNull();
  });

  it("returns what the host answered", async () => {
    const state = await transportOver(
      fakeFetch({ body: { connection: "ready", core: { home: "/tmp/h" }, threads: [{ threadId: "t1" }] } }),
    ).state();
    expect(state.connection).toBe(CONNECTION.READY);
    expect(state.threads).toHaveLength(1);
  });

  it("keeps the config snapshot the session on screen was answered for", async () => {
    const snapshot = { sessionId: "session-9", conversationId: "29", config: { provider: "super-agent" } };
    const fetch = fakeFetch({
      body: { connection: "ready", core: {}, threads: [], sessionId: "session-9", snapshot },
    });
    const { seat } = fakeSeat({ current: "session-9" });
    const state = await transportOver(fetch, { session: seat }).state();
    expect(state.snapshot).toEqual(snapshot);
  });

  it("drops a config snapshot read for a session the panel has left", async () => {
    const fetch = fakeFetch({
      body: {
        connection: "ready",
        core: {},
        threads: [],
        sessionId: "session-a",
        snapshot: { sessionId: "session-a", conversationId: "29", config: { provider: "session-a-provider" } },
        snapshotError: { code: "INTERNAL", message: "read for session-a" },
      },
    });
    const { seat } = fakeSeat({ current: "session-b" });
    const state = await transportOver(fetch, { session: seat }).state();
    // The answer is about session-a and the panel is showing session-b. A
    // configuration belongs to the conversation it describes, so it is dropped
    // rather than drawn under another session's name — the card then says it is
    // still reading. The rest of the answer is handed on as it always was.
    expect(state.snapshot).toBeNull();
    expect(state.snapshotError).toBeNull();
    expect(state.connection).toBe(CONNECTION.READY);
    expect(state.sessionId).toBe("session-a");
  });

  it("reports an unreachable host instead of throwing, and says which failure it was", async () => {
    const transport = transportOver(async () => {
      throw new Error("Failed to fetch");
    });
    const state = await transport.state();
    expect(state.connection).toBe(CONNECTION.OFFLINE);
    expect(state.core.error).toEqual({ code: "HOST_UNREACHABLE", message: "Failed to fetch" });
  });

  it("reports a host that answered with an error status", async () => {
    const state = await transportOver(fakeFetch({ ok: false, status: 500, body: null })).state();
    expect(state.connection).toBe(CONNECTION.OFFLINE);
    expect(state.core.error.code).toBe("HOST_ERROR");
  });

  it("follows the state on a timer, and stops when told to", async () => {
    vi.useFakeTimers();
    try {
      const fetch = fakeFetch({ body: { connection: "ready", core: {}, threads: [], run: null } });
      const seen = [];
      const stop = transportOver(fetch).watch((state) => seen.push(state.connection), { intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([CONNECTION.READY]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(seen).toHaveLength(2);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(seen).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes on a committed event as well as on the timer", async () => {
    vi.useFakeTimers();
    try {
      const fetch = fakeFetch({ body: { connection: "ready", core: {}, threads: [], run: null } });
      const events = fakeEventSource();
      const seen = [];
      const stop = transportOver(fetch, { EventSourceImpl: events.Fake }).watch((state) => seen.push(state), {
        intervalMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(1);
      // A committed event means the facts may have moved, so the reaction is a
      // refresh rather than a local patch: one path builds the view.
      events.sources[0].emit("message", { seq: 9, type: "run.completed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(2);
      stop();
      expect(events.sources[0].closed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands out the raw stream, committed events and live frames apart", async () => {
    const events = fakeEventSource();
    const committed = [];
    const live = [];
    const stop = transportOver(fakeFetch({}), { EventSourceImpl: events.Fake }).subscribe({
      onEvent: (event) => committed.push(event),
      onLive: (frame) => live.push(frame),
    });
    events.sources[0].emit("message", { seq: 1, type: "run.started" });
    events.sources[0].emit("live", { type: "delta", delta: "hi" });
    expect(committed).toEqual([{ seq: 1, type: "run.started" }]);
    expect(live).toEqual([{ type: "delta", delta: "hi" }]);
    stop();
    expect(events.sources[0].closed).toBe(1);
  });
});

describe("the facade over the transport", () => {
  it("reports pending before the answer, and the receipt with the success", async () => {
    const fetch = fakeFetch({ body: { ok: true, result: { state: "accepted", receiptSeq: 4 } } });
    const facade = createServices({ transport: transportOver(fetch) });
    const statuses = [];
    facade.subscribeOutcomes((id, outcome) => statuses.push(outcome.status));

    const outcome = await facade.run("run.stop", { threadId: "thread-1" });
    expect(statuses).toEqual([ACTION.PENDING, ACTION.DONE]);
    // The receipt travels with the outcome: "accepted" is the Core's claim, and
    // the panel shows the Core's words rather than its own.
    expect(outcome.result).toEqual({ state: "accepted", receiptSeq: 4 });
  });

  it("turns a refusal into an error the panel can render, never an exception", async () => {
    const facade = createServices({
      transport: transportOver(fakeFetch({ ok: false, status: 501, body: { error: { code: "NOT_SUPPORTED", message: "not in this build" } } })),
    });
    const outcome = await facade.run("run.redo", { runId: "run-1" });
    expect(outcome.status).toBe(ACTION.ERROR);
    expect(outcome.reason).toBe("not in this build");
  });

  it("reports an action as unsupported when no transport was injected at all", async () => {
    const facade = createServices({});
    const outcome = await facade.run("run.stop", { threadId: "thread-1" });
    expect(outcome.status).toBe(ACTION.UNSUPPORTED);
    expect(outcome.reason).toBe(facade.UNWIRED_REASON);
  });

  it("keeps the last outcome of each action, and answers idle for one that never ran", () => {
    const facade = createServices({});
    expect(facade.outcomeOf("run.stop")).toEqual({ status: ACTION.IDLE, reason: null, result: null });
  });

  it("does not give two independent instances the same id, even with the clock frozen", () => {
    // A control that has to keep its id across a retry mints it here — see the
    // supplement — and the Core's ledger is keyed by the Thread, so two
    // *different* operations that minted one key would make the second be
    // answered with the first one's receipt. Two windows, or two page loads,
    // are two instances, and they can mint their first id in the same
    // millisecond: the clock is frozen here so a pass cannot come from the
    // clock having moved, and so cannot come from anything but the id itself.
    const frozen = () => 1_700_000_000_000;
    const one = createServices({ transport: createCoreTransport({ fetchImpl: fakeFetch({}), now: frozen }) });
    const two = createServices({ transport: createCoreTransport({ fetchImpl: fakeFetch({}), now: frozen }) });
    const first = one.requestId("run.supplement");
    const second = two.requestId("run.supplement");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^sap-run\.supplement-/);
    expect(second).toMatch(/^sap-run\.supplement-/);

    // And within one instance, two calls in the same millisecond are two ids:
    // the first is not "the same operation" as the second.
    expect(one.requestId("run.supplement")).not.toBe(first);
  });

  it("still mints a distinct id with no transport, so a panel rebuilt offline cannot reuse one", () => {
    // The fallback path, for a build with no transport injected. A rebuilt
    // *panel* shares the facade — it is one plugin instance — so this is the
    // counter a rebuild must not restart. The card's own counter did restart,
    // and two panels' first supplements were then one key.
    const facade = createServices({});
    const ids = [facade.requestId("run.supplement"), facade.requestId("run.supplement")];
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the failure the panel draws", () => {
  const { reasonText } = createServices({});

  it("draws the host's message, not the object around it", () => {
    // The interface draws text; an object handed to it is a render error, and
    // the panel showed exactly that before this existed.
    expect(reasonText({ code: "ENOENT", message: "no socket at /tmp/core.sock" })).toBe(
      "ENOENT: no socket at /tmp/core.sock",
    );
  });

  it("keeps the code when the host sent no message, and says nothing when it sent neither", () => {
    expect(reasonText({ code: "HOST_ERROR" })).toBe("HOST_ERROR");
    expect(reasonText({ message: "down" })).toBe("down");
    expect(reasonText({})).toBeNull();
    expect(reasonText(null)).toBeNull();
    expect(reasonText("")).toBeNull();
  });

  it("passes a plain string through, so a declared sample still reads as one line", () => {
    expect(reasonText("connect ENOENT ~/.super-agent/run/core.sock")).toBe(
      "connect ENOENT ~/.super-agent/run/core.sock",
    );
  });
});
