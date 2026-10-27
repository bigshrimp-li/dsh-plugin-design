/**
 * What a session's turns do to the Agent Core, and what the Core's answers do
 * to the session log.
 *
 * The harness, the Core and the SDK are all stand-ins: the harness is modelled
 * from the contracts the reference loop and the harness services state (the
 * same way `agent-factory.test.mjs` models it), and the Core is a script that
 * records what it was asked and answers from a fixture. That is deliberate —
 * what these checks are about is the *translation*, and a real Core would make
 * the interesting part (which message is appended, under which id, once) a
 * matter of timing rather than of assertion.
 *
 * The session map is the real one, over a memory filesystem. It is the piece
 * that decides whether a session rejoins its Thread or creates a second one,
 * and a stand-in for it would be a stand-in for the answer.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import {
  messageIdentityKeys,
  runIdOf,
  sessionEventForMessage,
  sessionEventTypeFor,
  sessionRoleFor,
  statusLineFor,
  turnOutcomeFor,
  unseenMessages,
} from "../../src/host/event-mapping.js";
import { defaultInputReceiptsPath, openInputReceipts } from "../../src/host/input-receipts.js";
import { SESSION_MAP_SCHEMA_VERSION, defaultSessionMapPath, openSessionMap } from "../../src/host/session-map.js";

const host = await import("../../src/host/index.js");

/** The installed DSH release validator, when the isolated test run provides it. */
async function loadReleasedV4Validator() {
  const root = process.env.DSH_INSTALL_ROOT;
  if (typeof root !== "string" || root === "") return null;
  const requireFromDsh = createRequire(resolve(root, "package.json"));
  const formatPath = requireFromDsh.resolve("@deepseek-ai/dsh-session-format-v3-to-v4");
  const sessionPath = requireFromDsh.resolve("@deepseek-ai/dsh-session");
  const [format, session] = await Promise.all([
    import(pathToFileURL(formatPath).href),
    import(pathToFileURL(sessionPath).href),
  ]);
  return { ...format, ...session };
}

const releasedV4 = await loadReleasedV4Validator();

/* -------------------------------------------------------------- harness */

/** A scope primitive that records what it minted, like the real one's contract. */
function fakeScopePrimitive() {
  return {
    createScope(ctx, key) {
      const record = { key, disposed: 0 };
      const scoped = Object.create(ctx, { __scoped: { value: key } });
      record.ctx = scoped;
      const rawDispose = () => {
        record.disposed += 1;
      };
      return { ctx: scoped, rawDispose, dispose: rawDispose };
    },
  };
}

/** A session stand-in: the log, and the two reads the factory performs. */
function fakeSession(id, seed = [], header = {}) {
  const events = [...seed];
  const timeline = seed.map((event) => ({ kind: "append", event }));
  return {
    events,
    timeline,
    id,
    header: { version: 4, id, isSeeded: false, cwd: "/tmp/ws", ...header },
    inheritedEventCount: 0,
    snapshotEvents(from = 0) {
      return events.slice(from);
    },
    append(type, data, options) {
      const event = { seq: events.length, type, data, ...(options === undefined ? {} : { options }) };
      events.push(event);
      timeline.push({ kind: "append", event });
      return event;
    },
  };
}

/** A persistence handle stand-in. */
function fakeHandle(session, storedEvents = []) {
  return {
    appended: [],
    closed: 0,
    header: session.header,
    inheritedEventCount: 0,
    async append(events) {
      this.appended.push(...events);
    },
    async read() {
      return { events: storedEvents, eventState: "shared-frozen" };
    },
    async close() {
      this.closed += 1;
    },
  };
}

/** A harness stand-in: the registries, the handle and the effect host. */
function fakeHarness(session, handle) {
  const emitted = [];
  const warnings = [];
  const effects = [];
  const ctx = {
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
    emit(type, payload) {
      emitted.push({ type, payload });
      session?.timeline?.push({ kind: "emit", type, payload });
    },
    get(name) {
      if (name !== "sessionPersistence") return undefined;
      return {
        async create() {
          return handle;
        },
        async open() {
          return handle;
        },
      };
    },
    effect(run) {
      const teardown = run();
      effects.push(teardown);
      return () => {
        if (typeof teardown === "function") teardown();
      };
    },
    sessions: {
      prepare(id) {
        return session ?? fakeSession(id);
      },
      enter() {
        return () => {};
      },
      announce() {},
    },
    agents: {
      setFactory(factory) {
        ctx.__factory = factory;
      },
      enter() {
        return () => {};
      },
      async announce() {},
    },
  };
  return { ctx, emitted, effects, warnings };
}

/**
 * An owner context: the caller's own lifetime.
 *
 * The effect runs a generator and hands back the disposer the real one does —
 * the teardowns it yielded, run in order. Returning the generator object
 * instead would leave `unfollowOwner` a non-function, and a disposal would fail
 * on a stand-in rather than on the thing under check.
 */
function ownerContext() {
  return {
    effect: (run) => {
      const result = run();
      if (result === null || typeof result?.next !== "function") {
        return () => {
          if (typeof result === "function") result();
        };
      }
      const teardowns = [];
      for (let step = result.next(); !step.done; step = result.next()) teardowns.push(step.value);
      return () => {
        for (const teardown of teardowns) if (typeof teardown === "function") teardown();
      };
    },
  };
}

/* -------------------------------------------------------------- the Core */

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
 * A Core stand-in: a scripted set of answers, and a record of the questions.
 *
 * `state` is mutable so a check can change what the Core says between turns —
 * a Run that ends, a Thread that disappears — without rebuilding the world.
 */
function fakeCore(script = {}) {
  const state = {
    workspace: script.workspace ?? null,
    thread: script.thread ?? { threadId: "thread-1", mainConversationId: "29" },
    activeRuns: script.activeRuns ?? [],
    /**
     * The Runs `run.get` answers for, by id.
     *
     * A Run's Conversation is what decides whether it can take a supplement,
     * and the bridge reads it rather than assuming it — so a check about which
     * Run a message joins has to say which Conversation each one is in.
     */
    runs: script.runs ?? new Map(),
    messages: script.messages ?? [],
    /** The page's own position, when a check is about a page rather than its items. */
    page: script.page ?? null,
    /**
     * A history handed over page by page, when a check is about the paging.
     *
     * Each `messages.list` is the next page, in order; the last one is repeated
     * if the bridge asks again, so a read that ignores `nextCursor` cannot hang
     * the suite — it fails on the page count instead.
     */
    pages: script.pages ?? null,
    pagesRead: 0,
    events: script.events ?? [{ seq: 1, type: "run.completed", threadId: "thread-1", payload: { runId: "run-1" } }],
    live: script.live ?? [],
    /**
     * An explicit subscription, when a check needs the frames *interleaved*.
     *
     * `live` then `events` is enough for a check about either one, but not for
     * one about what happens between them — a committed fact arriving while a
     * Run is still streaming. This is the stream as a script, in order.
     */
    stream: script.stream ?? null,
    /** How many items the subscription has handed over, for ordering a check. */
    yielded: 0,
    /**
     * How many subscriptions have been closed by their consumer.
     *
     * Counted where the consumer's own `return()` reaches, so a check about
     * whether anything is still watching the Thread after a turn ends can say
     * so directly rather than inferring it from the absence of reads.
     */
    subscriptionsClosed: 0,
    /**
     * Every subscription asked for, in order: which Thread it named, the seq it
     * resumes after, and whether it asked for live frames.
     *
     * Recorded rather than acted on, because what a check has to see is the
     * *request*: a subscription that named no Thread would still be handed this
     * script's events, so the payload is the only place the mistake shows.
     */
    subscriptions: [],
    /**
     * How many of the next subscriptions fail before one is opened.
     *
     * The SDK does not retry a cursor the Core has forgotten — it throws to the
     * caller — so this is how a check puts the follow in front of the one
     * failure it is expected to rebuild from rather than end on.
     */
    subscribeFailures: script.subscribeFailures ?? 0,
    /**
     * The committed-event watermark `thread.get` answers with.
     *
     * A number, or a function of how many times it has been asked — which is how
     * a check makes the second watermark differ from the first and so sees that
     * a rebuilt subscription resumed from a *fresh* one rather than the dead one.
     */
    eventSeq: "eventSeq" in script ? script.eventSeq : 0,
    eventSeqReads: 0,
    failSubmit: script.failSubmit ?? null,
    /**
     * A promise every `messages.list` waits on before it answers.
     *
     * Lets a check hold a read in flight — the state a disposal has to wait
     * out, and the one an append made after it would be stale in.
     */
    hold: script.hold ?? null,
    /**
     * The Core message an accepted input became, as the receipt names it.
     *
     * The real Core mints this id for the input it wrote and returns it on the
     * receipt, so it is the other half of the identity a submitted input is
     * recorded under: the id names *which* durable message the words became,
     * and the source the input arrived with names *which* submission they
     * answer. `null` is the receipt of a Core that names no message — every
     * other check runs against that shape, and the bridge has to keep working
     * when the pairing cannot be made.
     */
    receiptMessageId: script.receiptMessageId ?? null,
    /** Refuse `thread.create` with this error, for a check about a creation the Core rejects. */
    failCreate: script.failCreate ?? null,
    /** Refuse the first `next_turn` delivery once, as a Run that ended first does. */
    failNextTurn: script.failNextTurn ?? false,
    /**
     * Fail the next `input.submit` calls, one entry each, in order.
     *
     * A check about a *second* submit — the fallback to a Run of its own after
     * the first was refused — needs to say what each call does, which a single
     * error for the whole action cannot. `null` in the list means that call
     * succeeds; the list is consumed, so it can be refilled between turns.
     */
    failSubmits: script.failSubmits ?? [],
    /**
     * Which Thread the home does not hold: one Thread's id, or `true` for every
     * Thread.
     *
     * Naming the one Thread is what lets a check say "the Thread this mapping
     * points at is gone" without also saying "and so is the one the turn is
     * about to make" — which is the difference between the mapping being dropped
     * and the mapping being dropped *again* after it was rewritten.
     */
    threadGone: script.threadGone ?? false,
    /**
     * A home that holds more than one Thread, when a check needs one.
     *
     * `null` keeps the single-Thread script the other checks were written
     * against. When it is a map, `thread.create` mints a fresh Thread per call
     * and `thread.get` answers for the Thread it was asked about — which is
     * what makes "two sessions do not cross" observable at all.
     */
    threads: script.threads ?? null,
    created: 0,
    /** Messages per Conversation, for a home where two sessions read two lines. */
    messagesByConversation: script.messagesByConversation ?? null,
  };
  const calls = [];
  return {
    calls,
    state,
    /** The calls of one action, in order. */
    callsOf(action) {
      return calls.filter((call) => call.action === action);
    },
    async call(action, payload) {
      // `yielded` is how far the subscription had got: it is what lets a check
      // say *when* a read happened, not merely that it did.
      calls.push({ action, payload, yielded: state.yielded });
      switch (action) {
        case "workspace.find":
          return state.workspace;
        case "workspace.register":
          return { workspaceId: "ws-1", root: payload.root };
        case "thread.create": {
          if (state.failCreate !== null) throw state.failCreate;
          if (state.threads === null) {
            state.thread = { threadId: "thread-1", mainConversationId: "29" };
            return state.thread;
          }
          state.created += 1;
          const created = { threadId: `thread-${state.created}`, mainConversationId: `${28 + state.created}` };
          state.threads.set(created.threadId, created);
          state.thread = created;
          return created;
        }
        case "thread.get": {
          if (state.threadGone === true || state.threadGone === payload.threadId) {
            throw Object.assign(new Error("no such Thread"), { code: "NOT_FOUND" });
          }
          // The watermark travels with the view, as the real one does: it is the
          // process's committed-event seq at the moment the view was taken, and
          // it is the value a subscription resumes from without a gap.
          state.eventSeqReads += 1;
          const eventSeq =
            typeof state.eventSeq === "function" ? state.eventSeq(state.eventSeqReads) : state.eventSeq;
          // A Core that carries no watermark omits the field, which is what a
          // check about a view without one scripts.
          const watermark = typeof eventSeq === "number" ? { eventSeq } : {};
          if (state.threads === null) {
            return { ...state.thread, activeRuns: state.activeRuns, ...watermark };
          }
          const found = state.threads.get(payload.threadId);
          if (found === undefined) throw Object.assign(new Error("no such Thread"), { code: "NOT_FOUND" });
          // A Thread entry may name its own active Runs: a Thread that holds a
          // fork has Runs in more than one Conversation, and which of them is
          // active is the fact a supplement's target is read against.
          return { ...found, activeRuns: found.activeRuns ?? [], ...watermark };
        }
        case "input.submit":
          if (state.failSubmit !== null) throw state.failSubmit;
          if (state.failSubmits.length > 0) {
            const failure = state.failSubmits.shift();
            if (failure !== null) throw failure;
          }
          if (payload.delivery === "next_turn" && state.failNextTurn) {
            state.failNextTurn = false;
            throw Object.assign(new Error("the Run is not active"), { code: "RUN_NOT_ACTIVE" });
          }
          return {
            requestId: payload.requestId,
            runId: "run-1",
            delivery: payload.delivery ?? "new_run",
            state: "accepted",
            receiptSeq: 7,
            // A replay of one prompt answers with the same acceptance, so the
            // named message is the same one the first call got.
            ...(state.receiptMessageId === null ? {} : { messageId: state.receiptMessageId }),
          };
        case "run.get": {
          const run = state.runs.get(payload.runId);
          if (run === undefined) throw Object.assign(new Error("no such Run"), { code: "NOT_FOUND" });
          return run;
        }
        case "messages.list": {
          if (state.hold !== null) await state.hold;
          if (state.pages !== null) {
            const index = Math.min(state.pagesRead, state.pages.length - 1);
            state.pagesRead += 1;
            return state.pages[index];
          }
          const byConversation = state.messagesByConversation?.get(payload.conversationId);
          // `messages` may be a function of how far the stream has got, for a
          // check about a message whose projection changes between two reads.
          const items =
            byConversation ?? (typeof state.messages === "function" ? state.messages(state.yielded) : state.messages);
          return { items, nextCursor: null, ...(state.page ?? {}) };
        }
        case "thread.stop":
          return { requestId: payload.requestId, resourceId: payload.threadId, state: "accepted", receiptSeq: 3 };
        default:
          throw new Error(`the Core stand-in was asked for ${action}`);
      }
    },
    async subscribe(options) {
      calls.push({ action: "subscribe", payload: options, yielded: state.yielded });
      // The seam this stands in for reads the *singular* `threadId` and maps it
      // to the SDK's plural `threadIds`. A caller passing the plural has it
      // dropped, and the SDK then subscribes to every Thread in the home — which
      // looks like it worked. Refusing it here is what keeps that mistake from
      // passing as a green check.
      if (options?.threadIds !== undefined) {
        throw new Error("subscribe was given `threadIds`; the Core seam reads the singular `threadId`");
      }
      state.subscriptions.push({
        threadId: options?.threadId,
        after: options?.after,
        live: options?.live === true,
      });
      if (state.subscribeFailures > 0) {
        state.subscribeFailures -= 1;
        throw Object.assign(new Error("the event cursor is no longer retained"), {
          name: "CursorExpiredError",
        });
      }
      const { stream, live, events } = state;
      const items = stream ?? [
        ...live.map((frame) => ({ kind: "live", frame })),
        ...events.map((event) => ({ kind: "committed", event })),
      ];
      return (async function* () {
        try {
          for (const item of items) {
            state.yielded += 1;
            yield item;
          }
        } finally {
          // Reached when the consumer's `for await` ends — by exhausting the
          // stream or by `return()`ing out of it, which is what a turn that
          // ends before the stream does leaves behind.
          state.subscriptionsClosed += 1;
        }
      })();
    },
  };
}

/** A Core message, as the listing projects it. */
function message(overrides = {}) {
  return {
    messageId: "msg-1",
    conversationId: "29",
    kind: "user",
    role: "user",
    source: "user",
    runId: "run-1",
    turnId: "turn-1",
    toolCallId: null,
    entryId: 1,
    text: "hello",
    createdAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A Core live frame, as the Thread's stream carries it.
 *
 * `run-1` and `live:turn-1:0` are the defaults because they are the Run and the
 * message the stand-in Core's `input.submit` answers with, so a check that is
 * about something else does not have to restate them.
 */
function frame(overrides = {}) {
  return {
    type: "stream.text_delta",
    threadId: "thread-1",
    runId: "run-1",
    turnId: "turn-1",
    requestRef: "req-1",
    attempt: 0,
    messageId: "live:turn-1:0",
    index: 0,
    delta: "hi",
    ...overrides,
  };
}

/** One committed event of the stream, in the shape `subscribe` yields. */
function committed(seq, type, payload = {}) {
  return {
    kind: "committed",
    event: { seq, type, threadId: "thread-1", time: "2026-10-20T00:00:00.000Z", payload },
  };
}

/** The settlement of `run-1`, which is what ends a turn. */
const settled = (seq = 9) => committed(seq, "run.completed", { runId: "run-1" });

/** The assistant-stream frames the agent published, in order. */
function streamFrames(harness) {
  return harness.emitted
    .filter((entry) => entry.type === "agent/assistant-stream")
    .map((entry) => entry.payload.frame);
}

/** Assert that DSH can attach every live stream to an open V4 turn and step. */
function expectStreamStartsHaveReleasedBoundaries(session) {
  let openTurn = null;
  let openStep = null;
  const openToolCalls = new Set();

  for (const item of session.timeline) {
    if (item.kind === "append") {
      const { type, data } = item.event;
      if (type === "turn/start") {
        expect(openToolCalls.size, "a new DSH Turn cannot cross an unfinished tool call").toBe(0);
        openTurn = data.turn;
        openStep = null;
      } else if (type === "step/start") {
        expect(openToolCalls.size, "a new DSH step cannot cross an unfinished tool call").toBe(0);
        openTurn = data.turn;
        openStep = data.step;
      } else if (type === "step/end") {
        expect(openToolCalls.size, "a DSH step cannot end with unfinished tool calls").toBe(0);
        if (openTurn === data.turn && openStep === data.step) openStep = null;
      } else if (type === "turn/end") {
        expect(openToolCalls.size, "a DSH Turn cannot end with unfinished tool calls").toBe(0);
        if (openTurn === data.turn) {
          openTurn = null;
          openStep = null;
        }
      } else if (type === "tool/call") {
        openToolCalls.add(data.callId);
      } else if (type === "tool/result") {
        openToolCalls.delete(data.message.toolCallId);
      }
      continue;
    }

    if (item.type !== "agent/assistant-stream" || item.payload.frame.type !== "start") continue;
    const { turn, step } = item.payload.frame;
    expect(openTurn, "assistant-stream start must follow its DSH turn/start").toBe(turn);
    expect(openStep, "assistant-stream start must follow its DSH step/start").toBe(step);
    // Open calls may share this exact step (parallel calls are one Core entry),
    // but the position transition above may not happen until their results land.
  }
}

/**
 * Publish one agent through the factory, over the stand-in Core.
 *
 * `sessionMap` lets two agents share one map, the way the plugin does: two
 * `openSessionMap` calls over one path would be two in-memory copies of one
 * file, and the second write would drop what the first had learned.
 */
async function startAgent({ core = fakeCore(), fs = memoryFs(), sessionMap, inputReceipts, session, seed = [] } = {}) {
  host.setScopePrimitive(fakeScopePrimitive());
  host.setCoreSeams({
    core: async () => core,
    sessionMap:
      sessionMap === undefined
        ? async () => openSessionMap({ path: "/mem/sessions.json", fs })
        : async () => sessionMap,
    // The record of what an input was submitted as, over the same memory
    // filesystem the session map uses: a check about a second delivery of a
    // prompt is a check about what survived the first one. A provider is
    // accepted as it is, so a check can hand in one that fails.
    inputReceipts:
      inputReceipts === undefined
        ? async () => openInputReceipts({ path: "/mem/inputs.json", fs })
        : typeof inputReceipts === "function"
          ? inputReceipts
          : async () => inputReceipts,
  });
  const prepared = session ?? fakeSession("session-1", seed);
  const harness = fakeHarness(prepared, fakeHandle(prepared, seed));
  host.applySessionAdapter(harness.ctx, { agentId: "main" });
  const published = await harness.ctx.__factory.createAgent(ownerContext(), {
    sessionId: prepared.id,
    ...(seed.length === 0 ? {} : { seed }),
  });
  return { ...published, core, fs, session: prepared, harness };
}

/** The session events of one type. */
const eventsOf = (session, type) => session.events.filter((event) => event.type === type);

beforeEach(() => {
  host.setCoreSeams({});
});

/* -------------------------------------------------------------- checks */

describe("a turn is a Core Run", () => {
  it("creates a Thread for the session's workspace, and records the pair", async () => {
    const { agent, core, fs, session } = await startAgent();
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The Workspace is looked up first and registered only when the home does
    // not know it — the registry is a fact about what the user has.
    expect(core.callsOf("workspace.find")).toHaveLength(1);
    expect(core.callsOf("workspace.register")[0].payload).toEqual({
      requestId: "dsh:session-1:workspace",
      root: "/tmp/ws",
    });
    // The Thread is created in the Workspace's own root, not the path the
    // session happened to name.
    expect(core.callsOf("thread.create")[0].payload).toMatchObject({
      agentId: "main",
      workspaceId: "ws-1",
      cwd: "/tmp/ws",
    });
    expect(eventsOf(session, "turn/start")).toHaveLength(1);

    const written = JSON.parse(fs.files.get("/mem/sessions.json"));
    expect(written.schemaVersion).toBe(SESSION_MAP_SCHEMA_VERSION);
    expect(written.sessions[0]).toMatchObject({
      sessionId: "session-1",
      threadId: "thread-1",
      mainConversationId: "29",
      workspaceId: "ws-1",
    });
  });

  it("submits the turn's text and ends the turn when the Run settles", async () => {
    const { agent, core, session } = await startAgent();
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The Conversation is named even when it is the Thread's main one: the
    // request says which line of history it means instead of relying on the
    // Core's default, which a later change could move.
    expect(core.callsOf("input.submit")[0].payload).toEqual({
      requestId: "dsh:session-1:turn:1",
      threadId: "thread-1",
      text: "hello",
      conversationId: "29",
    });
    // The wait is on the Thread's committed events, and the subscription names
    // the Thread and asks for the live frames too.
    expect(core.callsOf("subscribe")[0].payload).toMatchObject({ threadId: "thread-1", live: true });
    expect(eventsOf(session, "turn/end")[0].data).toMatchObject({ turn: 1, reason: { kind: "completed" } });
  });

  it("fills the transcript from the Core's own record, once per message", async () => {
    const core = fakeCore({
      messages: [
        message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" }),
        message({ entryId: 2, messageId: "msg-2", kind: "assistant", source: "core", text: "hi there" }),
      ],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const user = eventsOf(session, "user/message");
    const assistant = eventsOf(session, "assistant/message");
    expect(user).toHaveLength(1);
    expect(assistant).toHaveLength(1);
    // `user/message` carries the message itself; every other message event
    // nests it. The title projection reads `event.data.source` off the top
    // level, so a nested user message is a crash, not a cosmetic difference.
    // The id is the Core's `messageId`: the native entry is not an identity.
    expect(user[0].data.id).toBe("core-msg-1");
    expect(user[0].data.source).toEqual({ kind: "user" });
    expect(user[0].data.message).toBeUndefined();
    expect(assistant[0].data.message.id).toBe("core-msg-2");
    expect(assistant[0].data.message.content).toEqual([{ type: "text", text: "hi there" }]);

    // A second turn re-reads the same history — the Core lists from the start —
    // and must not append a second copy of a message the session already holds.
    agent.followup({ id: "m-2", content: [{ type: "text", text: "again" }] });
    await agent.whenIdle();
    expect(eventsOf(session, "user/message")).toHaveLength(1);
    expect(eventsOf(session, "assistant/message")).toHaveLength(1);
  });

  it("rejoins the Thread the session already has instead of creating a second", async () => {
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    const { agent, core } = await startAgent({ fs });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // Three reads of the same Thread, none of them a creation: the follow's
    // read when the session opened (to adopt the Thread the mapping names),
    // the turn's check that the mapping's Thread is still there, and the
    // turn's look for a Run already going before it submits. The follow's read
    // happens at open, before any turn, so the count is exact rather than a
    // floor.
    expect(core.callsOf("thread.get")).toHaveLength(3);
    expect(core.callsOf("thread.get")[0].payload.threadId).toBe("thread-1");
    expect(core.callsOf("thread.create")).toHaveLength(0);
    expect(core.callsOf("workspace.register")).toHaveLength(0);
  });

  it("forgets a mapping whose Thread the home no longer holds, and makes a new one", async () => {
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-gone",
            mainConversationId: "28",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    // The Thread the *mapping* names is gone. The one the turn goes on to create
    // is not: saying every Thread is gone would make the follow drop the fresh
    // mapping too, and the check would be about a home with no Threads at all
    // rather than about a stale mapping.
    const core = fakeCore({ threadGone: "thread-gone" });
    const { agent } = await startAgent({ core, fs });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // A session pointing at a Thread that is not there would fail forever with
    // no way out, so the stale mapping is dropped rather than reused.
    expect(core.callsOf("thread.create")).toHaveLength(1);
    const written = JSON.parse(fs.files.get("/mem/sessions.json"));
    expect(written.sessions).toHaveLength(1);
    expect(written.sessions[0].threadId).toBe("thread-1");
  });
});

describe("which Thread a session runs on", () => {
  it("keeps two sessions on their own Threads when they take turns", async () => {
    const core = fakeCore({ threads: new Map() });
    const fs = memoryFs();
    const map = await openSessionMap({ path: "/mem/sessions.json", fs });

    const first = await startAgent({ core, fs, sessionMap: map, session: fakeSession("session-a") });
    first.agent.followup({ id: "a-1", content: [{ type: "text", text: "from a" }] });
    await first.agent.whenIdle();

    const second = await startAgent({ core, fs, sessionMap: map, session: fakeSession("session-b") });
    second.agent.followup({ id: "b-1", content: [{ type: "text", text: "from b" }] });
    await second.agent.whenIdle();

    // Alternating back to the first session: it rejoins the Thread it made,
    // and does not adopt the Thread the session that ran most recently owns.
    first.agent.followup({ id: "a-2", content: [{ type: "text", text: "from a again" }] });
    await first.agent.whenIdle();

    expect(core.callsOf("thread.create")).toHaveLength(2);
    const submits = core.callsOf("input.submit");
    expect(submits.map((call) => call.payload.threadId)).toEqual(["thread-1", "thread-2", "thread-1"]);
    expect(map.get("session-a").threadId).toBe("thread-1");
    expect(map.get("session-b").threadId).toBe("thread-2");
  });

  it("rejoins the recorded Thread after a restart, without creating a second one", async () => {
    const core = fakeCore({ threads: new Map() });
    const fs = memoryFs();
    const map = await openSessionMap({ path: "/mem/sessions.json", fs });

    const before = await startAgent({ core, fs, sessionMap: map, session: fakeSession("session-1") });
    before.agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await before.agent.whenIdle();
    expect(core.callsOf("thread.create")).toHaveLength(1);

    // A new process reads the same home: a fresh map over the same file, and a
    // fresh agent for the same session. The pair has to survive both.
    const reopened = await openSessionMap({ path: "/mem/sessions.json", fs });
    const after = await startAgent({ core, fs, sessionMap: reopened, session: fakeSession("session-1") });
    after.agent.followup({ id: "m-2", content: [{ type: "text", text: "again" }] });
    await after.agent.whenIdle();

    expect(core.callsOf("thread.create")).toHaveLength(1);
    expect(core.callsOf("input.submit")[1].payload.threadId).toBe("thread-1");
    expect(reopened.get("session-1").threadId).toBe("thread-1");
  });

  it("writes a forked session's input into the fork, not the line it came from", async () => {
    const fs = memoryFs();
    const map = await openSessionMap({ path: "/mem/sessions.json", fs });
    await map.put({
      sessionId: "session-fork",
      threadId: "thread-1",
      mainConversationId: "29",
      conversationId: "77",
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws",
      agentId: "main",
      modelId: null,
      createdAt: 1,
    });
    const core = fakeCore({
      threads: new Map([["thread-1", { threadId: "thread-1", mainConversationId: "29" }]]),
      messagesByConversation: new Map([
        ["29", [message({ entryId: 1, conversationId: "29", kind: "user", text: "the line it was forked from" })]],
        ["77", [message({ entryId: 2, conversationId: "77", kind: "user", text: "the branch it shows" })]],
      ]),
    });
    const { agent, session } = await startAgent({ core, fs, sessionMap: map, session: fakeSession("session-fork") });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The input names the Conversation this session shows. Leaving it out means
    // the Thread's *main* one — the line the fork was taken from — so the user's
    // words would land on a branch they are not looking at, and nothing in the
    // receipt would say so. The Thread's clientRef and mainConversationId are
    // not the bridge's to change: only the address of this input is.
    const submits = core.callsOf("input.submit");
    expect(submits).toHaveLength(1);
    expect(submits[0].payload).toMatchObject({ threadId: "thread-1", conversationId: "77" });
    expect(submits[0].payload.targetRunId).toBeUndefined();
    // The fork is also what is read, and read as the fork — on every read of
    // the turn, before the submit and after the Run settles.
    const reads = core.callsOf("messages.list").map((call) => call.payload.conversationId);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((id) => id === "77")).toBe(true);
    expect(session.events.filter((event) => event.type === "user/message").map((event) => event.data.content[0].text)).toEqual([
      "the branch it shows",
    ]);
    expect(eventsOf(session, "turn/end")[0].data.reason).toMatchObject({ kind: "completed" });
  });

  it("supplements the Run of the Conversation this session shows, not another Conversation's", async () => {
    const fs = memoryFs();
    const map = await openSessionMap({ path: "/mem/sessions.json", fs });
    await map.put({
      sessionId: "session-fork",
      threadId: "thread-1",
      mainConversationId: "29",
      conversationId: "77",
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws",
      agentId: "main",
      modelId: null,
      createdAt: 1,
    });
    const core = fakeCore({
      threads: new Map([
        ["thread-1", { threadId: "thread-1", mainConversationId: "29", activeRuns: ["run-main", "run-fork"] }],
      ]),
      runs: new Map([
        ["run-main", { runId: "run-main", conversationId: "29" }],
        ["run-fork", { runId: "run-fork", conversationId: "77" }],
      ]),
    });
    const { agent } = await startAgent({ core, fs, sessionMap: map, session: fakeSession("session-fork") });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "and also" }] });
    await agent.whenIdle();

    // The Thread lists both Runs, and the first one is the main line's. The
    // supplement belongs to the fork's Run: a `next_turn` aimed at the other
    // would put the user's words into a Run on a branch they are not watching,
    // and the Core would accept it, because that Run is active and takes
    // supplements.
    const submits = core.callsOf("input.submit");
    expect(submits[0].payload).toMatchObject({
      delivery: "next_turn",
      targetRunId: "run-fork",
      conversationId: "77",
    });
    // Which Run is in which Conversation is read, not guessed: the bridge asks
    // the Core about the Runs it was told are active.
    expect(core.callsOf("run.get").map((call) => call.payload.runId)).toEqual(["run-main", "run-fork"]);
  });

  it("picks the main Conversation's Run for a session on the main line, whatever order the Thread lists", async () => {
    const core = fakeCore({
      activeRuns: ["run-fork", "run-main"],
      runs: new Map([
        ["run-fork", { runId: "run-fork", conversationId: "77" }],
        ["run-main", { runId: "run-main", conversationId: "29" }],
      ]),
    });
    const { agent } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "and also" }] });
    await agent.whenIdle();

    // Order is not the rule: a fork's Run listed first must not take an
    // ordinary session's message.
    expect(core.callsOf("input.submit")[0].payload).toMatchObject({
      delivery: "next_turn",
      targetRunId: "run-main",
      conversationId: "29",
    });
  });

  it("starts a new Run when the only active Run is another Conversation's", async () => {
    const fs = memoryFs();
    const map = await openSessionMap({ path: "/mem/sessions.json", fs });
    await map.put({
      sessionId: "session-fork",
      threadId: "thread-1",
      mainConversationId: "29",
      conversationId: "77",
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws",
      agentId: "main",
      modelId: null,
      createdAt: 1,
    });
    const core = fakeCore({
      threads: new Map([
        ["thread-1", { threadId: "thread-1", mainConversationId: "29", activeRuns: ["run-main"] }],
      ]),
      runs: new Map([["run-main", { runId: "run-main", conversationId: "29" }]]),
    });
    const { agent } = await startAgent({ core, fs, sessionMap: map, session: fakeSession("session-fork") });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "and also" }] });
    await agent.whenIdle();

    // Nothing in this session's Conversation is running, so the message opens a
    // Run of its own there — rather than joining a Run it does not belong to.
    const submits = core.callsOf("input.submit");
    expect(submits).toHaveLength(1);
    expect(submits[0].payload.delivery).toBeUndefined();
    expect(submits[0].payload).toMatchObject({ conversationId: "77" });
  });

  it("submits normally when the session shows the Thread's own Conversation", async () => {
    const fs = memoryFs();
    const map = await openSessionMap({ path: "/mem/sessions.json", fs });
    await map.put({
      sessionId: "session-1",
      threadId: "thread-1",
      mainConversationId: "29",
      conversationId: "29",
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws",
      agentId: "main",
      modelId: null,
      createdAt: 1,
    });
    const core = fakeCore({
      threads: new Map([["thread-1", { threadId: "thread-1", mainConversationId: "29" }]]),
    });
    const { agent } = await startAgent({ core, fs, sessionMap: map, session: fakeSession("session-1") });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    expect(core.callsOf("input.submit")).toHaveLength(1);
    // The main line is written to because it is the line this session shows,
    // and the request says so: a fork's Run in the same Thread is not taken.
    expect(core.callsOf("input.submit")[0].payload).toMatchObject({ conversationId: "29" });
    expect(core.callsOf("messages.list")[0].payload.conversationId).toBe("29");
  });
});

describe("the transcript's message identity", () => {
  it("appends every message of one entry, each under its own id", async () => {
    const core = fakeCore({
      messages: [
        message({ messageId: "msg-7", entryId: 7, kind: "assistant", text: "let me look" }),
        message({ messageId: "msg-8", entryId: 7, kind: "tool_call", toolCallId: "call-1" }),
        message({ messageId: "msg-9", entryId: 7, kind: "tool_call", toolCallId: "call-2" }),
      ],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The projection gives each message its own id, and the native entry is not
    // one: keying by the entry would record the narration and drop both calls.
    // V4 also needs a visible tool-call advertisement before each call starts.
    const assistantMessages = eventsOf(session, "assistant/message").map((event) => event.data.message);
    expect(assistantMessages.filter((message) => message.content.some((block) => block.type === "text")).map((message) => message.id)).toEqual([
      "core-msg-7",
    ]);
    expect(assistantMessages.filter((message) => message.content.some((block) => block.type === "tool-call")).map((message) => message.id)).toEqual([
      "core-msg-8",
      "core-msg-9",
    ]);
    expect(eventsOf(session, "tool/call").map((event) => event.data.callId)).toEqual(["call-1", "call-2"]);
  });

  it("keeps a message's id when its native entry is linked after acceptance", async () => {
    const core = fakeCore({
      messages: [message({ messageId: "msg-7", entryId: null, kind: "assistant", text: "the answer" })],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toEqual(["core-msg-7"]);

    // The same message, now carrying the native entry it was accepted into.
    // Nothing about the message changed, so nothing about it is appended again.
    core.state.messages = [message({ messageId: "msg-7", entryId: 12, kind: "assistant", text: "the answer" })];
    agent.followup({ id: "m-2", content: [{ type: "text", text: "again" }] });
    await agent.whenIdle();
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toEqual(["core-msg-7"]);
  });

  it("does not append the messages a resumed log already holds", async () => {
    const model = { kind: "model", provider: "super-agent", model: "core" };
    // The harness's own shapes, as the log really holds them: a user message's
    // `data` *is* the message, every other message event nests it, a call is
    // not a message at all, and a log written before the message id was the
    // identity holds the entry.
    const seed = [
      {
        seq: 0,
        type: "user/message",
        data: { id: "core-msg-1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
      },
      {
        seq: 1,
        type: "assistant/message",
        data: { turn: 1, step: 1, message: { id: "core-msg-2", role: "assistant", content: [{ type: "text", text: "hi" }], source: model } },
      },
      {
        seq: 2,
        type: "tool/call",
        data: { turn: 1, step: 1, callId: "call-1", name: "core_tool_call", arguments: "[]" },
      },
      {
        seq: 3,
        type: "assistant/message",
        data: { turn: 1, step: 1, message: { id: "core-entry-7", role: "assistant", content: [{ type: "text", text: "let me look" }], source: model } },
      },
    ];
    const core = fakeCore({
      messages: [
        message({ messageId: "msg-1", entryId: 1, kind: "user", text: "hello" }),
        message({ messageId: "msg-2", entryId: 2, kind: "assistant", text: "hi" }),
        message({ messageId: "msg-3", entryId: 2, kind: "tool_call", toolCallId: "call-1" }),
        message({ messageId: "msg-7", entryId: 7, kind: "assistant", text: "let me look" }),
        message({ messageId: "msg-8", entryId: 7, kind: "tool_call", toolCallId: "call-2" }),
      ],
    });
    const { agent, session } = await startAgent({ core, seed });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "again" }] });
    await agent.whenIdle();

    // Nothing the log holds comes back: not the user's words — reading only the
    // nested shape would have missed them and appended them a second time — not
    // a message id, and not a call id.
    expect(eventsOf(session, "user/message")).toHaveLength(1);
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toEqual([
      "core-msg-2",
      "core-entry-7",
      "core-msg-8",
    ]);
    // The legacy entry marker stands for the one message such a log recorded
    // for that entry, so the entry's *other* message is new rather than lost.
    expect(eventsOf(session, "tool/call").map((event) => event.data.callId)).toEqual(["call-1", "call-2"]);
  });

  it("pages the history to its end instead of stopping at the page's own position", async () => {
    const core = fakeCore({
      pages: [
        {
          items: [message({ messageId: "msg-1", entryId: 1, kind: "user", text: "hello" })],
          nextCursor: "c1",
          caughtUp: false,
          watermark: 0,
          range: { from: 0, to: 1 },
        },
        // A page with nothing in it, and a watermark of 0: the projection has
        // not caught up, and this is a position in the history, not its end.
        { items: [], nextCursor: "c2", caughtUp: false, watermark: 0, range: { from: 1, to: 1 } },
        {
          items: [message({ messageId: "msg-2", entryId: 2, kind: "assistant", text: "hi" })],
          nextCursor: null,
          caughtUp: true,
          watermark: 2,
          range: { from: 1, to: 2 },
        },
      ],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The read follows `nextCursor` and stops where it says the history ends,
    // whatever the page says about being caught up or about its watermark. The
    // turn reads the history twice — once at the acceptance and once when the
    // Run settles — so the first pass is the one that walks the pages.
    const cursors = core.callsOf("messages.list").map((call) => call.payload.cursor);
    expect(cursors.slice(0, 3)).toEqual([undefined, "c1", "c2"]);
    // What the second pass lists is already held, so neither message is in the
    // transcript twice.
    expect(eventsOf(session, "user/message")).toHaveLength(1);
    expect(eventsOf(session, "assistant/message")).toHaveLength(1);
    expect(eventsOf(session, "user/message").map((event) => event.data.id)).toEqual(["core-msg-1"]);
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toEqual(["core-msg-2"]);
  });

  it("does not clear the transcript when the projection has nothing to show yet", async () => {
    const first = message({ messageId: "msg-1", entryId: 1, kind: "user", text: "hello" });
    const answer = message({ messageId: "msg-2", entryId: 2, kind: "assistant", text: "hi" });
    const core = fakeCore({ messages: [first, answer] });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();
    expect(eventsOf(session, "user/message")).toHaveLength(1);
    expect(eventsOf(session, "assistant/message")).toHaveLength(1);

    // An empty projection window is a window, not a history: the messages the
    // session holds stay where they are.
    core.state.messages = [];
    agent.followup({ id: "m-2", content: [{ type: "text", text: "again" }] });
    await agent.whenIdle();
    expect(eventsOf(session, "user/message")).toHaveLength(1);
    expect(eventsOf(session, "assistant/message")).toHaveLength(1);

    // And when the window fills again, only what is new is appended.
    const later = message({ messageId: "msg-3", entryId: 3, kind: "assistant", text: "and more" });
    core.state.messages = [first, answer, later];
    agent.followup({ id: "m-3", content: [{ type: "text", text: "still there?" }] });
    await agent.whenIdle();
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toEqual([
      "core-msg-2",
      "core-msg-3",
    ]);
  });
});

describe.skipIf(releasedV4 === null)("released DSH v4 replay validation", () => {
  it("starts each live stream after its V4 boundaries and holds later Turns behind tool history", async () => {
    const history = [
      message({ messageId: "msg-input", entryId: 1, kind: "user", turnId: "core-turn-tool", text: "check this" }),
      message({
        messageId: "msg-narration",
        entryId: 2,
        kind: "assistant",
        turnId: "core-turn-tool",
        text: "I will check it.",
      }),
      message({
        messageId: "msg-call",
        entryId: 2,
        kind: "tool_call",
        role: "assistant",
        turnId: "core-turn-tool",
        toolCallId: "call-1",
        toolCall: { name: "echo", arguments: '{"text":"checked"}' },
        text: "",
      }),
      message({
        messageId: "msg-call-2",
        entryId: 2,
        kind: "tool_call",
        role: "assistant",
        turnId: "core-turn-tool",
        toolCallId: "call-2",
        toolCall: { name: "echo", arguments: '{"text":"also checked"}' },
        text: "",
      }),
      message({
        messageId: "msg-result",
        entryId: 2,
        kind: "tool_result",
        role: "tool",
        turnId: "core-turn-tool",
        toolCallId: "call-1",
        text: "checked",
      }),
      message({
        messageId: "msg-result-2",
        entryId: 2,
        kind: "tool_result",
        role: "tool",
        turnId: "core-turn-tool",
        toolCallId: "call-2",
        text: "also checked",
      }),
      message({
        messageId: "msg-final",
        entryId: 3,
        kind: "assistant",
        turnId: "core-turn-final",
        text: "The check passed.",
      }),
    ];
    const core = fakeCore({
      receiptMessageId: "msg-input",
      // The first committed-message sweep exposes the complete tool group, but
      // not the later Core Turn yet. Its live preview follows that sweep and
      // must not cross the still-open DSH tool step; the settlement read then
      // exposes the later Turn's committed message.
      messages: (yielded) => yielded >= 6 ? history : yielded >= 4 ? history.slice(0, 6) : [],
      stream: [
        {
          kind: "live",
          frame: frame({
            type: "stream.thinking_delta",
            turnId: "core-turn-tool",
            messageId: "live:tool-turn",
            delta: "inspect",
          }),
        },
        {
          kind: "live",
          frame: frame({
            type: "stream.text_delta",
            turnId: "core-turn-tool",
            messageId: "live:tool-turn",
            delta: "Checking",
          }),
        },
        {
          kind: "live",
          frame: frame({
            type: "stream.tool_call_delta",
            turnId: "core-turn-tool",
            messageId: "live:tool-turn",
            toolCallId: "call-1",
            index: 0,
            delta: '{"text":"checked"}',
          }),
        },
        committed(4, "message.committed", { messageId: "msg-result" }),
        {
          kind: "live",
          frame: frame({
            type: "stream.text_delta",
            turnId: "core-turn-final",
            messageId: "msg-final",
            delta: "The check passed.",
          }),
        },
        settled(),
      ],
    });
    const { agent, dispose, session, harness } = await startAgent({ core });
    agent.followup({ id: "input-1", content: [{ type: "text", text: "check this" }] });
    await agent.whenIdle();

    expect(core.callsOf("messages.list").some((call) => call.yielded < 4)).toBe(true);
    expect(core.callsOf("messages.list").some((call) => call.yielded === 4)).toBe(true);
    expect(core.callsOf("messages.list").some((call) => call.yielded >= 6)).toBe(true);
    const advertisement = eventsOf(session, "assistant/message").find((event) =>
      event.data.message.content.some((block) => block.type === "tool-call"),
    );
    const calls = eventsOf(session, "tool/call");
    const results = eventsOf(session, "tool/result");
    const call = calls.find((event) => event.data.callId === "call-1");
    const result = results.find((event) => event.data.message.toolCallId === "call-1");
    const secondCall = calls.find((event) => event.data.callId === "call-2");
    const secondResult = results.find((event) => event.data.message.toolCallId === "call-2");
    expect(advertisement).toBeDefined();
    expect(call).toBeDefined();
    expect(result).toBeDefined();
    expect(secondCall).toBeDefined();
    expect(secondResult).toBeDefined();
    const toolPosition = [advertisement.data.turn, advertisement.data.step];
    expect([call.data.turn, call.data.step]).toEqual(toolPosition);
    expect([result.data.turn, result.data.step]).toEqual(toolPosition);
    expect([secondCall.data.turn, secondCall.data.step]).toEqual(toolPosition);
    expect([secondResult.data.turn, secondResult.data.step]).toEqual(toolPosition);
    const finalMessage = eventsOf(session, "assistant/message").find(
      (event) => event.data.message.id === "core-msg-final",
    );
    expect(finalMessage?.data).toMatchObject({ turn: 2, step: 1 });
    const starts = streamFrames(harness)
      .filter((frame) => frame.type === "start")
      .map(({ turn, step }) => ({ turn, step }));
    expect(starts).toEqual([
      { turn: 1, step: 1 },
      { turn: 2, step: 1 },
    ]);
    expectStreamStartsHaveReleasedBoundaries(session);

    // Run the same released V4 relationship validator used when DSH reopens a
    // session file. FakeSession stores append options separately, so fold them
    // into the released event shape before validating this replay artifact.
    const artifact = {
      header: {
        version: 4,
        id: session.id,
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
        cwd: "/tmp/ws",
      },
      inheritedEventCount: 0,
      events: session.events.map(({ options, ...event }) => ({ ...event, ...(options ?? {}) })),
    };
    expect(() => releasedV4.restoreReleasedV4Artifact(artifact, releasedV4.KNOWN_SESSION_EVENT_TYPES)).not.toThrow();
    await dispose();
  });
});

describe("delivery while a Run is already going", () => {
  it("sends the message into the active Run as a next turn", async () => {
    const core = fakeCore({
      activeRuns: ["run-1"],
      runs: new Map([["run-1", { runId: "run-1", conversationId: "29" }]]),
    });
    const { agent } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "and also" }] });
    await agent.whenIdle();

    // The Run is a supplement's target only because it belongs to the
    // Conversation this session shows; the same address is carried on the
    // supplement so the Core writes it where it was read from.
    expect(core.callsOf("input.submit")[0].payload).toMatchObject({
      delivery: "next_turn",
      targetRunId: "run-1",
      conversationId: "29",
    });
  });

  it("falls back to a new Run under a different request id when the Run ended first", async () => {
    const core = fakeCore({
      activeRuns: ["run-1"],
      failNextTurn: true,
      runs: new Map([["run-1", { runId: "run-1", conversationId: "29" }]]),
    });
    const { agent } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "and also" }] });
    await agent.whenIdle();

    const submits = core.callsOf("input.submit");
    expect(submits).toHaveLength(2);
    expect(submits[0].payload.delivery).toBe("next_turn");
    // A second command, not the first one rewritten: the id the Core refused
    // must not be the id it is later asked to honour.
    expect(submits[1].payload.delivery).toBeUndefined();
    expect(submits[1].payload.requestId).toBe("dsh:session-1:turn:1:new_run");
    // The fallback is the same message into the same Conversation: a Run that
    // ended under it is no reason to change which branch the user is on.
    expect(submits[1].payload.conversationId).toBe("29");
  });
});

describe("who consumes a message the Core commits", () => {
  it("takes a supplement's words and the answer they draw, each once, into the turn already waiting on the Thread", async () => {
    // The supplement is submitted by the panel through the public
    // `input.submit` route, not through this agent: nothing here calls the
    // agent with it, and that is the point. What is being asked is who
    // *consumes* the messages the Core commits for it, and the answer is the
    // turn already waiting on the Thread — the subscription is the Thread's,
    // and a committed message is filtered by its name rather than by a Run
    // id, so a message this agent never submitted still reaches its read.
    const core = fakeCore({
      activeRuns: ["run-1"],
      // The listing grows as the Thread's stream advances, the way the Core's
      // own record does: the supplement's message is committed after the
      // turn's first read, and the answer after that. `yielded` is how far the
      // subscription has got, which is what makes the growth *ordered*.
      messages: (yielded) =>
        yielded < 1
          ? [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })]
          : yielded < 2
            ? [
                message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" }),
                message({ entryId: 2, messageId: "msg-2", kind: "user", text: "and also" }),
              ]
            : [
                message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" }),
                message({ entryId: 2, messageId: "msg-2", kind: "user", text: "and also" }),
                message({ entryId: 3, messageId: "msg-3", kind: "assistant", source: "core", text: "and so" }),
              ],
      stream: [
        committed(1, "message.committed", { messageId: "msg-2" }),
        committed(2, "message.committed", { messageId: "msg-3" }),
        settled(3),
      ],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // Each of them exactly once: three reads ran over a listing that went on
    // holding both, and a read that appended what it had already appended
    // would draw the user's words — and the answer — twice.
    const user = eventsOf(session, "user/message");
    const assistant = eventsOf(session, "assistant/message");
    expect(user.map((event) => event.data.id)).toEqual(["core-msg-1", "core-msg-2"]);
    expect(assistant.map((event) => event.data.message.id)).toEqual(["core-msg-3"]);
    expect(assistant[0].data.message.content).toEqual([{ type: "text", text: "and so" }]);
    // *When* the reads ran, which is what separates consuming the commits from
    // only reading at the end: one before the wait, one per committed message,
    // and the settlement's own. A wait that ignored `message.committed` and
    // read only at the settlement would leave the words out of the transcript
    // for the whole Run, and this sequence is where that shows.
    expect(core.callsOf("messages.list").map((call) => call.yielded)).toEqual([0, 1, 2, 3]);
    expect(eventsOf(session, "turn/end")[0].data.reason).toEqual({ kind: "completed" });
  });

  it("reads a projection the Core commits after the turn ended into the session, with no further prompt", async () => {
    // The turn ends on its Run's settlement while the Core goes on working —
    // the case of a supplement into a Run whose DSH turn has already stopped
    // waiting, or an answer projected behind the terminal event. What the
    // closed turn's subscription would have carried is carried by the follow,
    // which is why the message does not wait for a prompt the user has no
    // reason to send.
    //
    // The listing grows with the stream, so the message is only there once the
    // follow's read runs — the turn's own reads cannot have seen it.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    const core = fakeCore({
      messages: (yielded) =>
        yielded < 1
          ? [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })]
          : [
              message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" }),
              message({ entryId: 2, messageId: "msg-2", kind: "assistant", source: "core", text: "late" }),
            ],
      stream: [committed(2, "message.committed", { messageId: "msg-2" })],
    });
    const { session } = await startAgent({ core, fs });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The message is in the session with no prompt at all: the follow read it
    // in, and this half invented no prompt for it.
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toEqual(["core-msg-2"]);
    expect(core.callsOf("input.submit")).toHaveLength(0);
  });

  it("follows the Conversation the record now names, and draws that line's history", async () => {
    // A fork writes a new Conversation for the child session, so the record can
    // come to name a different line than the reader started on. The reader has
    // to move to it: the session shows the fork, and reading the line it was
    // forked away from would draw the branch as if the fork had never happened.
    let entry = {
      sessionId: "session-1",
      threadId: "thread-1",
      mainConversationId: "29",
      conversationId: "29",
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws",
      agentId: "main",
      modelId: null,
      createdAt: 1,
    };
    // A record that can be rewritten under the agent, which is what a fork does.
    const sessionMap = {
      path: "/mem/sessions.json",
      get: (sessionId) => (sessionId === "session-1" ? entry : undefined),
      all: () => [entry],
      put: async (next) => {
        entry = next;
        return next;
      },
      remove: async (sessionId) => {
        if (sessionId !== "session-1") return false;
        entry = undefined;
        return true;
      },
    };
    const core = fakeCore({
      messagesByConversation: new Map([
        ["29", [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "the line it came from" })]],
        ["30", [message({ entryId: 5, messageId: "msg-5", kind: "assistant", source: "core", text: "the fork" })]],
      ]),
    });
    const { agent, session } = await startAgent({ core, sessionMap });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The reader started on the line the record named at open.
    expect(eventsOf(session, "user/message").map((event) => event.data.id)).toEqual(["core-msg-1"]);

    entry = { ...entry, conversationId: "30" };
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The reads moved to the fork's line and its history was drawn, and the old
    // line's message was not drawn a second time under the new one.
    expect(core.callsOf("messages.list").some((call) => call.payload.conversationId === "30")).toBe(true);
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toContain("core-msg-5");
    expect(eventsOf(session, "user/message")).toHaveLength(1);
  });

  it("takes no subscription at all when the Core's view carries no watermark", async () => {
    // A subscription without `after` starts where the Core happens to be, so
    // everything committed between the read and the first frame would be in
    // neither the listing nor the replay. The view always carries the watermark,
    // so a view without one is a Core this bridge cannot follow without
    // guessing — refused, rather than downgraded to an unanchored subscription
    // that looks like it worked.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      stream: [],
      eventSeq: null,
    });
    const { dispose } = await startAgent({ core, fs });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(core.state.subscriptions).toHaveLength(0);
    // The read itself is not what is refused: a Core that cannot be subscribed
    // to still has history, and the follow drew it.
    expect(core.callsOf("messages.list").length).toBeGreaterThanOrEqual(1);
    await dispose();
  });

  it("registers an abort listener only for a wait, and takes it down when the wait ends", async () => {
    // The wait's second way out is what keeps an awaited rebind from waiting on
    // the turn it is called from. It is also per read, and a read happens once
    // per committed fact: a listener registered for a read that never waited
    // would pile up on a signal that lives as long as the session, and one left
    // behind by a wait the turn ended first would never be released.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      stream: [],
    });
    const { agent, dispose } = await startAgent({ core, fs });
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener: () => {
        added += 1;
      },
      removeEventListener: () => {
        removed += 1;
      },
    };

    // No turn is running, so this read does not wait and must not register.
    await agent._readWhenIdle(signal);
    expect(added).toBe(0);

    // A read that does wait registers once and takes it down when it leaves.
    let release;
    const idle = new Promise((resolve) => {
      release = resolve;
    });
    agent._running = true;
    agent._idle = { promise: idle };
    const reading = agent._readWhenIdle(signal);
    await Promise.resolve();
    expect(added).toBe(1);
    agent._running = false;
    release();
    await reading;
    expect(removed).toBe(1);
    await dispose();
  });

  it("resumes its subscription from the watermark it read before the listing, and names only its own Thread", async () => {
    // The order of these two reads is what closes the window between "what I
    // read" and "what I am told". The watermark has to be taken *before* the
    // listing: everything committed up to it is in the listing, which is read
    // later, and everything committed after it is replayed by the subscription.
    // Taken afterwards, the facts committed in between are in neither — the
    // listing was already answered and their seq is below the one subscribed
    // from.
    //
    // The subscription also has to *name* this Thread. The Core's seam reads the
    // singular `threadId` and maps it to the SDK's plural `threadIds`; a caller
    // passing the plural has it dropped, and the SDK then subscribes to every
    // Thread in the home — which looks like it worked. The stand-in refuses the
    // plural, so a caller that went back to it fails here rather than passing.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      stream: [],
      eventSeq: 41,
    });
    const { dispose } = await startAgent({ core, fs });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const view = core.calls.findIndex((call) => call.action === "thread.get");
    const listing = core.calls.findIndex((call) => call.action === "messages.list");
    expect(view).toBeGreaterThanOrEqual(0);
    expect(listing).toBeGreaterThanOrEqual(0);
    expect(view).toBeLessThan(listing);
    expect(core.state.subscriptions[0]).toMatchObject({ threadId: "thread-1", after: 41, live: true });
    await dispose();
  });

  it("rebuilds its subscription from a fresh watermark when the Core forgets its cursor", async () => {
    // The SDK does not retry a cursor the Core has forgotten: it throws to the
    // caller, because only the caller can rebuild its view. A follow that ended
    // there would leave the session showing a view that never moves again, with
    // one line in the log to say so — so it takes a fresh watermark and asks
    // again, which is what the second subscription's `after` proves: the newer
    // seq, not the dead one.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      stream: [],
      // A watermark that moves between reads, so the rebuilt subscription can be
      // told apart from a retry of the dead one.
      eventSeq: (reads) => 40 + reads,
      subscribeFailures: 1,
    });
    const { dispose } = await startAgent({ core, fs });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(core.state.subscriptions.length).toBeGreaterThanOrEqual(2);
    expect(core.state.subscriptions[0]).toMatchObject({ threadId: "thread-1", after: 41 });
    expect(core.state.subscriptions[1]).toMatchObject({ threadId: "thread-1", after: 42 });
    await dispose();
  });

  it("draws a settled Thread's history when the session opens on it, with no prompt at all", async () => {
    // The common reopen: the work is over, and the log this process holds does
    // not carry what an earlier one did. A session that only read while the
    // Thread was busy would show nothing here.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    const core = fakeCore({
      activeRuns: [],
      messages: [
        message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" }),
        message({ entryId: 2, messageId: "msg-2", kind: "assistant", source: "core", text: "hi" }),
      ],
    });
    const { session } = await startAgent({ core, fs });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(eventsOf(session, "user/message").map((event) => event.data.id)).toEqual(["core-msg-1"]);
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toEqual(["core-msg-2"]);
    // Nothing was submitted: the read is the recovery, not a prompt.
    expect(core.callsOf("input.submit")).toHaveLength(0);
  });

  it("does not finish disposing while a read is in flight, and drops that read's page", async () => {
    // The follow outlives turns, so a disposal has to *wait* for its read to
    // leave, not merely tell it to stop: a page that came back after the scope
    // was torn down would append into a session that is gone. The read is held
    // open here, and the disposal is watched while it is.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      stream: [],
      hold,
    });
    const { dispose, session } = await startAgent({ core, fs });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The read is in flight: `messages.list` was asked and has not answered.
    expect(core.callsOf("messages.list").length).toBeGreaterThanOrEqual(1);

    let finished = false;
    const disposing = dispose().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The disposal has not completed: the in-flight read has not left.
    expect(finished).toBe(false);

    release();
    await disposing;
    expect(finished).toBe(true);
    // The page that came back after the disposal was dropped, not appended.
    expect(eventsOf(session, "user/message")).toHaveLength(0);
  });

  it("drops a message whose identity was still being read when the agent was disposed", async () => {
    // The page check is not enough on its own: the identity one message is
    // recorded under is read with an `await` *after* the page arrived and
    // *before* the append, and a disposal can land inside it. A message appended
    // there would be drawn into a session that is already gone — and, worse,
    // marked as held on the way, so nothing would ever draw it again.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    // The first identity read is held; the seam asks its provider once and
    // remembers the answer, so this is the read every message in this check goes
    // through.
    const inputReceipts = () =>
      held.then(() => openInputReceipts({ path: "/mem/inputs.json", fs }));
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      stream: [],
    });
    const { dispose, session } = await startAgent({ core, fs, inputReceipts });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The page has arrived and the identity is being read.
    expect(core.callsOf("messages.list").length).toBeGreaterThanOrEqual(1);

    let finished = false;
    const disposing = dispose().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);

    release();
    await disposing;
    expect(finished).toBe(true);
    // The message was not appended, and not marked as held either: the check
    // comes before the marking, so a message dropped here is one the next read
    // still gets to draw.
    expect(eventsOf(session, "user/message")).toHaveLength(0);
  });

  it("stops the follow when the session is disposed, and reads nothing after it", async () => {
    // The follow outlives turns, so nothing but the disposal closes it. The
    // disposal awaits it: a message committed after the session is gone must
    // not reach a session that no longer has a reader.
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    let more = false;
    const core = fakeCore({
      messages: () =>
        more
          ? [
              message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" }),
              message({ entryId: 2, messageId: "msg-2", kind: "assistant", source: "core", text: "late" }),
            ]
          : [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      stream: [committed(1, "message.committed", { messageId: "msg-1" })],
    });
    const { dispose, session } = await startAgent({ core, fs });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The follow was reading while the session was open: the Core's own user
    // message is in the log, read by the follow and not by any turn.
    expect(eventsOf(session, "user/message").map((event) => event.data.id)).toEqual(["core-msg-1"]);
    await dispose();

    const reads = core.callsOf("messages.list").length;
    more = true;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(core.callsOf("messages.list").length).toBe(reads);
    expect(eventsOf(session, "assistant/message")).toHaveLength(0);
  });

  it("appends nothing twice when the log already holds what the Core lists", async () => {
    const fs = memoryFs();
    fs.files.set(
      "/mem/sessions.json",
      JSON.stringify({
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        sessions: [
          {
            sessionId: "session-1",
            threadId: "thread-1",
            mainConversationId: "29",
            conversationId: "29",
            workspaceId: "ws-1",
            workspaceRoot: "/tmp/ws",
            cwd: "/tmp/ws",
            agentId: "main",
            modelId: null,
            createdAt: 1,
          },
        ],
      }),
    );
    const core = fakeCore({
      activeRuns: [],
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
    });
    const { dispose, session } = await startAgent({
      core,
      fs,
      seed: [
        {
          seq: 0,
          type: "user/message",
          data: { id: "core-msg-1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(eventsOf(session, "user/message")).toHaveLength(1);
  });

  it("does not append an inherited fork message whose origin is already in the session log", async () => {
    const fs = memoryFs();
    const sessionMap = await openSessionMap({ path: "/mem/sessions.json", fs });
    await sessionMap.put({
      sessionId: "session-fork",
      threadId: "thread-1",
      mainConversationId: "29",
      conversationId: "77",
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws",
      agentId: "main",
      modelId: null,
      createdAt: 1,
    });
    const core = fakeCore({
      activeRuns: [],
      messages: [message({
        conversationId: "77",
        messageId: "fork-child-msg",
        origin: { conversationId: "29", messageId: "parent-msg" },
        kind: "user",
        role: "user",
        source: "user",
        text: "the accepted message inherited by this fork",
      })],
    });
    const seed = [{
      seq: 0,
      type: "user/message",
      data: {
        id: "core-parent-msg",
        role: "user",
        content: [{ type: "text", text: "the accepted message inherited by this fork" }],
        source: { kind: "user" },
      },
    }];
    const { session, dispose } = await startAgent({
      core,
      fs,
      sessionMap,
      session: fakeSession("session-fork", seed),
      seed,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(eventsOf(session, "user/message").map((event) => event.data.id)).toEqual(["core-parent-msg"]);
    expect(core.callsOf("input.submit")).toHaveLength(0);
    await dispose();
  });

  it("reads once more at the settlement, so a message projected behind the terminal event is still this turn's", async () => {
    const core = fakeCore({
      // The Run settles before its last message is readable: the turn's first
      // read sees only the user's words, and the answer is there at the
      // settlement's own read — the last one before the turn closes.
      messages: (yielded) =>
        yielded < 1
          ? [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })]
          : [
              message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" }),
              message({ entryId: 2, messageId: "msg-2", kind: "assistant", source: "core", text: "the answer" }),
            ],
      stream: [settled(1)],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const assistant = eventsOf(session, "assistant/message");
    expect(assistant.map((event) => event.data.message.id)).toEqual(["core-msg-2"]);
    // This turn's own, not a later turn's: the read at the settlement is what
    // catches a projection that lands behind the terminal event. A projection
    // that landed behind *that* read too would only be found by the next
    // turn's read, which is the case the check above states.
    expect(assistant[0].data.turn).toBe(1);
    expect(core.callsOf("messages.list").map((call) => call.yielded)).toEqual([0, 1]);
  });

  it("recovers on reopen through the first turn's read, and re-appends nothing the log holds", async () => {
    // A log an earlier serve of this home wrote: it holds the first exchange,
    // and not the message the Core committed after that serve stopped watching
    // the Thread. This is what a reopen really has in front of it. (In this
    // suite that is an earlier serve of the same home, not an independent
    // process restart.)
    const model = { kind: "model", provider: "super-agent", model: "core" };
    const seed = [
      {
        seq: 0,
        type: "user/message",
        data: { id: "core-msg-1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
      },
      {
        seq: 1,
        type: "assistant/message",
        data: {
          turn: 1,
          step: 1,
          message: { id: "core-msg-2", role: "assistant", content: [{ type: "text", text: "hi" }], source: model },
        },
      },
    ];
    const core = fakeCore({
      messages: [
        message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" }),
        message({ entryId: 2, messageId: "msg-2", kind: "assistant", source: "core", text: "hi" }),
        message({ entryId: 3, messageId: "msg-3", kind: "assistant", source: "core", text: "the late answer" }),
      ],
    });
    const { agent, session } = await startAgent({ core, seed });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "again" }] });
    await agent.whenIdle();

    // What the log already held is not appended again — the read is the same
    // one, over the same Conversation — and what it did not hold is appended,
    // once. The recovery is this read, and it runs because a turn opened.
    expect(eventsOf(session, "user/message")).toHaveLength(1);
    expect(eventsOf(session, "assistant/message").map((event) => event.data.message.id)).toEqual([
      "core-msg-2",
      "core-msg-3",
    ]);
  });
});

describe("a turn that cannot reach the Core", () => {
  it("keeps the user's words and ends the turn as failed", async () => {
    // A refusal the Core decided: it named a code, and by its own contract a
    // refusal writes no ledger entry, so the input is held nowhere and the
    // session is the only place its words can be kept.
    const core = fakeCore({
      failSubmit: Object.assign(new Error("the request is not one this Thread accepts"), { code: "INVALID_REQUEST" }),
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The Core holds nothing for this turn, so the message is recorded here or
    // it is gone — and it is recorded once, with a local id.
    const user = eventsOf(session, "user/message");
    expect(user).toHaveLength(1);
    expect(user[0].data.content).toEqual([{ type: "text", text: "hello" }]);
    expect(user[0].data.id).toMatch(/^dsh-session-1-msg-/);
    // The failure is written in the contract's own `error` variant, because a
    // reason outside the interface's map is one no reader matches: the terminal
    // error row is built only for `kind === "error"`, so a turn closed as
    // `failed` renders as a turn that merely ended. The bridge's sentence is the
    // message, and `UNKNOWN` is the map's marker for "no provider code applies".
    expect(eventsOf(session, "turn/end")[0].data.reason).toEqual({
      kind: "error",
      error: { message: "the request is not one this Thread accepts", code: "UNKNOWN" },
    });
  });

  it("keeps the words of an input with no prompt identity even when the outcome is not known", async () => {
    // Nothing identifies this input to the Host: no echo was painted for it and
    // its sender has no delivery to retry with, so there is nothing a copy here
    // could swallow — and nothing that could bring the words back if it is not
    // made. The words are kept, as they always were.
    const core = fakeCore({
      failSubmit: Object.assign(new Error("the socket is gone"), { code: "INTERNAL" }),
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const user = eventsOf(session, "user/message");
    expect(user).toHaveLength(1);
    expect(user[0].data.content).toEqual([{ type: "text", text: "hello" }]);
    expect(user[0].data.source).toEqual({ kind: "user" });
  });

  it("names the profile row when the Core refuses a creation for a missing model", async () => {
    // The real refusal, word for word, from a Core that requires an explicit model. The
    // bridge sent no modelId because its profile row declares none, and the Core's answer
    // says so in the Core's own vocabulary — which is not where the user can fix it.
    const core = fakeCore({
      failCreate: Object.assign(new Error("modelId is required to create a Thread"), {
        code: "INVALID_REQUEST",
      }),
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The creation really was attempted and really was refused: this is not the bridge
    // deciding on its own to stop before asking.
    expect(core.callsOf("thread.create")).toHaveLength(1);
    expect(core.callsOf("thread.create")[0].payload.modelId).toBeUndefined();

    // The turn ends in the contract's `error` variant, whose message names the
    // configuration to add — and the user's words are kept where the failure
    // left them.
    const end = eventsOf(session, "turn/end")[0].data.reason;
    expect(end.kind).toBe("error");
    expect(end.error.message).toContain("@super-agent/dsh-bridge row declares no modelId");
    expect(end.error.message).toContain("Add a \"modelId\" to that row's config");
    expect(end.error.code).toBe("UNKNOWN");
    expect(eventsOf(session, "user/message")).toHaveLength(1);
  });

  it("leaves a refusal that is not about the model exactly as the Core stated it", async () => {
    // A creation can be refused for reasons that have nothing to do with the model, and
    // the bridge's translation must not swallow them: a user told to configure a modelId
    // when the real problem is the Workspace would fix nothing.
    const core = fakeCore({
      failCreate: Object.assign(new Error("cwd is not inside the Workspace"), { code: "INVALID_REQUEST" }),
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    expect(eventsOf(session, "turn/end")[0].data.reason).toEqual({
      kind: "error",
      error: { message: "cwd is not inside the Workspace", code: "UNKNOWN" },
    });
  });

  it("ends the turn as an error when the Run itself fails", async () => {
    // The Core's own end reason, from the union it actually writes.
    const core = fakeCore({
      events: [{ seq: 2, type: "run.failed", threadId: "thread-1", payload: { runId: "run-1", endReason: "model_failure" } }],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The Core's own words are the message: the bridge does not invent a
    // sentence for a failure the Core named, and the code is the map's marker
    // for a failure that carries no provider code.
    expect(eventsOf(session, "turn/end")[0].data.reason).toEqual({
      kind: "error",
      error: { message: "model_failure", code: "UNKNOWN" },
    });
  });

  it("does not end the turn on a Thread gate moving", async () => {
    const core = fakeCore({
      events: [
        { seq: 2, type: "thread.status_changed", threadId: "thread-1", payload: {} },
        { seq: 3, type: "run.completed", threadId: "thread-1", payload: { runId: "run-1" } },
      ],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    expect(eventsOf(session, "turn/end")).toHaveLength(1);
    expect(eventsOf(session, "turn/end")[0].data.reason).toEqual({ kind: "completed" });
  });
});

describe("the identity a submitted input is recorded under", () => {
  it("echoes the input's own source on the message the Core named", async () => {
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    const user = eventsOf(session, "user/message");
    expect(user).toHaveLength(1);
    // The Core's own record, under the Core's own id.
    expect(user[0].data.id).toBe("core-msg-1");
    // And the identity the interface painted an echo for at the submit click.
    // It retires that echo only when a durable user message echoes the same
    // `rpcId`, and the Core's projection carries none — so the pairing is made
    // here, between the message the receipt named and the source the input
    // arrived with. Neither half alone retires anything.
    expect(user[0].data.source).toEqual({ kind: "user", rpcId: "rpc-1" });
  });

  it("keeps the request id the input's own id implies, so a replay reuses its acceptance", async () => {
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
    });
    const { agent, session } = await startAgent({ core });
    const prompt = {
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    };
    agent.followup(prompt);
    await agent.whenIdle();
    // The same real prompt, delivered again — a reconnect, or the same message
    // claimed by a later turn. Its identity is the prompt's and not the turn's,
    // so the Core sees the same key and answers with the acceptance it already
    // has instead of writing the words a second time.
    agent.followup(prompt);
    await agent.whenIdle();

    const submits = core.callsOf("input.submit");
    expect(submits.map((call) => call.payload.requestId)).toEqual([
      "dsh:session-1:input:rpc-1",
      "dsh:session-1:input:rpc-1",
    ]);
    expect(eventsOf(session, "user/message")).toHaveLength(1);
  });

  it("records a message this session did not submit without an identity of its own", async () => {
    // The read that carries this turn's own input carries whatever else is on
    // the line: another client's message, history read back, a fork's carried
    // rows. Naming the turn's input on one of those would retire an echo that
    // belongs to a different prompt.
    const core = fakeCore({
      messages: [
        message({ entryId: 1, messageId: "msg-1", kind: "user", text: "from elsewhere" }),
        message({ entryId: 2, messageId: "msg-2", kind: "user", text: "hello" }),
      ],
      receiptMessageId: "msg-2",
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    const user = eventsOf(session, "user/message");
    expect(user.map((event) => event.data.id)).toEqual(["core-msg-1", "core-msg-2"]);
    expect(user[0].data.source).toEqual({ kind: "user" });
    expect(user[1].data.source).toEqual({ kind: "user", rpcId: "rpc-1" });
  });

  it("names no identity for a batch that claims more than one input", async () => {
    // What the inbox held is one turn's batch and one Core input, and the
    // interface holds one identity per prompt rather than one per batch. Two
    // claimed inputs have two `rpcId`s, so there is no single one that stands
    // for the batch: recording either would retire the other prompt's echo,
    // and inventing a third would retire neither. The batch is submitted as it
    // was, and the copy kept here carries the bare source.
    const core = fakeCore({
      failSubmit: Object.assign(new Error("the request is not one this Thread accepts"), { code: "INVALID_REQUEST" }),
    });
    const { agent, session } = await startAgent({ core });
    agent.inject({ id: "m-1", content: [{ type: "text", text: "one" }], source: { kind: "user", rpcId: "rpc-a" } });
    agent.followup({ id: "m-2", content: [{ type: "text", text: "two" }], source: { kind: "user", rpcId: "rpc-b" } });
    await agent.whenIdle();

    expect(core.callsOf("input.submit")).toHaveLength(1);
    expect(core.callsOf("input.submit")[0].payload.text).toBe("one two");
    const user = eventsOf(session, "user/message");
    expect(user).toHaveLength(1);
    expect(user[0].data.source).toEqual({ kind: "user" });
  });

  it("keeps the input's own source on the copy made when the Core never took it", async () => {
    const core = fakeCore({
      failSubmit: Object.assign(new Error("the request is not one this Thread accepts"), { code: "INVALID_REQUEST" }),
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    const user = eventsOf(session, "user/message");
    expect(user).toHaveLength(1);
    // The session's own copy, under a local id — the Core wrote nothing, so
    // there is no message of the Core's to name. It still echoes the identity
    // the prompt arrived with: the echo the interface painted is retired
    // against that identity, so a copy recorded without it would leave the
    // user's own words on screen twice — the very thing the copy exists to
    // avoid for a submit that failed before the Core saw it.
    expect(user[0].data.id).toMatch(/^dsh-session-1-msg-/);
    expect(user[0].data.source).toEqual({ kind: "user", rpcId: "rpc-1" });
  });

  it("does not record a second copy when the turn fails after the Core took the words", async () => {
    // The submit returned, so the Core holds the words under the id its receipt
    // named. A local copy would be a second identity for one message and the
    // interface would draw both, so this turn records nothing and reads the
    // Core's own copy back instead.
    const core = fakeCore({
      messages: () => {
        throw new Error("the Core's listing is unreachable");
      },
      receiptMessageId: "msg-1",
    });
    const { agent, session, harness } = await startAgent({ core });
    agent.followup({
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    expect(eventsOf(session, "user/message")).toHaveLength(0);
    expect(eventsOf(session, "turn/end")[0].data.reason.kind).toBe("error");
    // The read is the Core's to fail, and the failure is said as the read's own
    // rather than as the turn's: the words are durable under the accepted id.
    expect(harness.warnings.some((line) => line.includes("could not read back its accepted input"))).toBe(true);

    // The next read is what brings them in, once, under the Core's id — and
    // still under the identity of the input they were: the acceptance named that
    // message, and the record of the input outlives the turn that submitted it,
    // so the echo the interface painted is retired by the read rather than left
    // for a reload. A turn that reads a message it did not submit does not
    // *claim* it here; it recognises one that was claimed when it was accepted.
    core.state.messages = [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })];
    core.state.receiptMessageId = null;
    agent.followup({ id: "m-2", content: [{ type: "text", text: "again" }] });
    await agent.whenIdle();

    const user = eventsOf(session, "user/message");
    expect(user.map((event) => event.data.id)).toEqual(["core-msg-1"]);
    expect(user[0].data.source).toEqual({ kind: "user", rpcId: "rpc-1" });
  });

  it("reuses the input's own request id for the fallback to a new Run", async () => {
    const core = fakeCore({
      activeRuns: ["run-1"],
      failNextTurn: true,
      runs: new Map([["run-1", { runId: "run-1", conversationId: "29" }]]),
    });
    const { agent } = await startAgent({ core });
    agent.followup({
      id: "m-1",
      content: [{ type: "text", text: "and also" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    const submits = core.callsOf("input.submit");
    expect(submits).toHaveLength(2);
    expect(submits[0].payload).toMatchObject({ delivery: "next_turn", requestId: "dsh:session-1:input:rpc-1" });
    // The refused attempt wrote nothing for the Core to remember, so the second
    // command is the same prompt under the same identity: a suffix minted here
    // would be a second key for words a replay of the first may already hold.
    expect(submits[1].payload.delivery).toBeUndefined();
    expect(submits[1].payload.requestId).toBe("dsh:session-1:input:rpc-1");
  });

  it("submits a prompt delivered again as the command it was first submitted as", async () => {
    // The Run the prompt first joined has settled, so a delivery judged *now*
    // would be a Run of its own. Judging it again is what makes one prompt two
    // commands: the Core keys idempotency on the request id **and a hash of the
    // payload**, so the same key under a different delivery is refused as a
    // conflict rather than answered with the receipt it already wrote.
    const core = fakeCore({
      activeRuns: ["run-1"],
      runs: new Map([["run-1", { runId: "run-1", conversationId: "29" }]]),
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
    });
    const { agent, session } = await startAgent({ core });
    const prompt = {
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    };
    agent.followup(prompt);
    await agent.whenIdle();
    core.state.activeRuns = [];
    agent.followup(prompt);
    await agent.whenIdle();

    const submits = core.callsOf("input.submit");
    expect(submits).toHaveLength(2);
    // The same command, word for word: the same key *and* the same delivery, so
    // the Core answers with the acceptance it already has instead of refusing a
    // key it holds under another shape.
    expect(submits[1].payload).toEqual(submits[0].payload);
    expect(submits[1].payload).toMatchObject({
      requestId: "dsh:session-1:input:rpc-1",
      delivery: "next_turn",
      targetRunId: "run-1",
    });
    // And one message, because the second delivery found the first acceptance.
    expect(eventsOf(session, "user/message")).toHaveLength(1);
  });

  it("records nothing locally when the submit's outcome is not known", async () => {
    // The request went out and nothing came back that says what became of it, so
    // the Core may hold these words. A copy here would be a second copy if it
    // does — and, echoing the prompt's identity, it would also retire the Host's
    // own echo and stop the prompt from being delivered again, which is the one
    // way an input that was never accepted could be lost for good.
    const core = fakeCore({
      failSubmit: Object.assign(new Error("the socket is gone"), { code: "INTERNAL" }),
    });
    const { agent, session, harness } = await startAgent({ core });
    const prompt = {
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    };
    agent.followup(prompt);
    await agent.whenIdle();

    expect(eventsOf(session, "user/message")).toHaveLength(0);
    // What the user sees is the turn closed as failed, which is the truth: the
    // outcome is not known.
    expect(eventsOf(session, "turn/end")[0].data.reason.kind).toBe("error");
    expect(harness.warnings.some((line) => line.includes("could not account for an input"))).toBe(true);

    // And the delivery is not lost with it: the record of what the input was
    // submitted as stands, so the Host's own echo is still the copy on screen
    // and a second delivery of the prompt repeats the same command.
    core.state.failSubmit = null;
    core.state.messages = [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })];
    core.state.receiptMessageId = "msg-1";
    agent.followup(prompt);
    await agent.whenIdle();

    const submits = core.callsOf("input.submit");
    expect(submits).toHaveLength(2);
    expect(submits[1].payload).toEqual(submits[0].payload);
    const user = eventsOf(session, "user/message");
    expect(user.map((event) => event.data.id)).toEqual(["core-msg-1"]);
    expect(user[0].data.source).toEqual({ kind: "user", rpcId: "rpc-1" });
  });

  it("does not copy the words when the Core refuses a key it already holds", async () => {
    // The same prompt's RPC id delivered with different words: the payload is
    // not the one the Core holds under that key, so it refuses rather than
    // answering with its receipt. The words it holds are already in the
    // transcript — a local copy would be a second copy of one message under an
    // identity of its own, which is what the interface draws twice.
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }], source: { kind: "user", rpcId: "rpc-1" } });
    await agent.whenIdle();
    core.state.failSubmit = Object.assign(new Error("the request id is already held"), {
      code: "IDEMPOTENCY_CONFLICT",
    });
    agent.followup({
      id: "m-2",
      content: [{ type: "text", text: "different words" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    const user = eventsOf(session, "user/message");
    expect(user.map((event) => event.data.id)).toEqual(["core-msg-1"]);
    // The refusal is still the turn's outcome: nothing is silently swallowed.
    const ends = eventsOf(session, "turn/end");
    expect(ends).toHaveLength(2);
    expect(ends[1].data.reason.kind).toBe("error");
  });

  it("does not submit a prompt whose records cannot be read", async () => {
    // The records answer "was this prompt delivered before?", and a file the
    // bridge cannot read cannot answer it. Planning the delivery live instead is
    // the one thing that must not happen: a prompt that *was* delivered would be
    // given a second command — judged against the Thread as it is now, where the
    // Run it joined has settled — and the Core refuses a key it already holds in
    // another shape. So the input is not submitted at all, and its words are not
    // written here either: whether the Core already holds them is exactly what
    // could not be read.
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
    });
    let unreadable = true;
    const { agent, session, harness } = await startAgent({
      core,
      inputReceipts: async () => {
        if (unreadable) throw new Error("the input records are schemaVersion 99, which this build does not read");
        return await openInputReceipts({ path: "/mem/inputs.json", fs: memoryFs() });
      },
    });
    agent.followup({
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    expect(core.callsOf("input.submit")).toHaveLength(0);
    expect(eventsOf(session, "user/message")).toHaveLength(0);
    expect(eventsOf(session, "turn/end")[0].data.reason.kind).toBe("error");

    // The failure is one turn's, not this process's: the file is read again on
    // the next delivery, which goes out and claims the message the Core names.
    unreadable = false;
    agent.followup({
      id: "m-2",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    expect(core.callsOf("input.submit")).toHaveLength(1);
    const user = eventsOf(session, "user/message");
    expect(user.map((event) => event.data.id)).toEqual(["core-msg-1"]);
    expect(user[0].data.source).toEqual({ kind: "user", rpcId: "rpc-1" });
    expect(harness.warnings.some((line) => line.includes("input records"))).toBe(true);
  });

  it("does not submit a prompt whose command cannot be written down", async () => {
    // The record is what lets a second delivery of the prompt repeat this
    // command, so a delivery that goes out without it is one this bridge can no
    // longer recognise. The submit waits on the write, and a write that fails
    // fails the turn *before* anything is sent — the one failure here that
    // costs nothing, so the words are kept, as for any input the Core was never
    // asked about.
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
    });
    const base = memoryFs();
    const fs = {
      ...base,
      async writeFile(path) {
        throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
      },
    };
    const { agent, session } = await startAgent({
      core,
      inputReceipts: async () => openInputReceipts({ path: "/mem/inputs.json", fs }),
    });
    agent.followup({
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    expect(core.callsOf("input.submit")).toHaveLength(0);
    const user = eventsOf(session, "user/message");
    expect(user).toHaveLength(1);
    expect(user[0].data.source).toEqual({ kind: "user", rpcId: "rpc-1" });
    expect(eventsOf(session, "turn/end")[0].data.reason.kind).toBe("error");
  });

  it("keeps the words the Core took when the record cannot be written after the receipt", async () => {
    // The write that follows the acceptance only adds the message id; the
    // command is already on disk. A home whose file stops being writable at that
    // point loses the ability to recognise the message on a *later* read, which
    // is worth saying and is not worth failing a turn the Core has accepted
    // over, nor worth writing the words a second time to make up for.
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
    });
    const base = memoryFs();
    let writes = 0;
    const fs = {
      ...base,
      async writeFile(path, text) {
        writes += 1;
        if (writes > 1) throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
        return await base.writeFile(path, text);
      },
    };
    const { agent, session, harness } = await startAgent({
      core,
      inputReceipts: async () => openInputReceipts({ path: "/mem/inputs.json", fs }),
    });
    agent.followup({
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    await agent.whenIdle();

    expect(core.callsOf("input.submit")).toHaveLength(1);
    expect(eventsOf(session, "turn/end")[0].data.reason).toEqual({ kind: "completed" });
    const user = eventsOf(session, "user/message");
    expect(user.map((event) => event.data.id)).toEqual(["core-msg-1"]);
    // This turn's own receipt still names the message, so the words are drawn
    // with the identity they arrived with even though the file never learned it.
    expect(user[0].data.source).toEqual({ kind: "user", rpcId: "rpc-1" });
    expect(harness.warnings.some((line) => line.includes("could not record its input"))).toBe(true);
  });

  it("writes the fallback to a new Run down before it is sent", async () => {
    // The fallback is a different command under the same key. A delivery that
    // goes out under a command no record names is one a re-delivery repeats as
    // the *old* command — the `next_turn` the Core just refused — and the Core
    // answers a key it already holds in another shape with a conflict. So the
    // record follows the fallback, not the other way round: here the fallback's
    // own outcome is never reported, and the record still says what was sent.
    const core = fakeCore({
      runs: new Map([["run-1", { runId: "run-1", conversationId: "29" }]]),
      activeRuns: ["run-1"],
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
      failSubmits: [
        Object.assign(new Error("the Run is not active"), { code: "RUN_NOT_ACTIVE" }),
        Object.assign(new Error("the socket is gone"), { code: "INTERNAL" }),
      ],
    });
    const receipts = await openInputReceipts({ path: "/mem/inputs.json", fs: memoryFs() });
    const { agent, session } = await startAgent({ core, inputReceipts: receipts });
    const prompt = {
      id: "m-1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "rpc-1" },
    };
    agent.followup(prompt);
    await agent.whenIdle();

    const submits = core.callsOf("input.submit");
    expect(submits).toHaveLength(2);
    expect(submits[0].payload).toMatchObject({ delivery: "next_turn", targetRunId: "run-1" });
    expect(submits[1].payload.delivery).toBeUndefined();
    expect(submits[1].payload.requestId).toBe("dsh:session-1:input:rpc-1");
    // The fallback's outcome is not known, so the words are not written here …
    expect(eventsOf(session, "user/message")).toHaveLength(0);
    // … and the record says `new_run`: it was written before the call that never
    // answered, not after it.
    expect(receipts.get("session-1", "rpc-1")).toMatchObject({ delivery: "new_run", messageId: null });

    // The next delivery repeats the fallback, not the refusal.
    core.state.failSubmits = [null];
    agent.followup(prompt);
    await agent.whenIdle();
    const after = core.callsOf("input.submit");
    expect(after).toHaveLength(3);
    expect(after[2].payload).toEqual(after[1].payload);
  });

  it("keeps the turn's own request id for an input that names no prompt identity", async () => {
    // The older shape: a source the interface can read, but no submission id to
    // correlate with. There is nothing to derive a stable key from, so the key
    // stays what it was — one per turn — and no source is echoed.
    const core = fakeCore({
      messages: [message({ entryId: 1, messageId: "msg-1", kind: "user", text: "hello" })],
      receiptMessageId: "msg-1",
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
    await agent.whenIdle();

    expect(core.callsOf("input.submit")[0].payload.requestId).toBe("dsh:session-1:turn:1");
    expect(eventsOf(session, "user/message")[0].data.source).toEqual({ kind: "user" });
  });
});

describe("stopping a Run", () => {
  it("asks the Core to stop the Thread, and stops waiting on the answer", async () => {
    const core = fakeCore({ events: [] });
    const { agent } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    // The turn is waiting on an event stream that will never settle, so the
    // stop is what ends it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const receipt = await agent.stop("req-1", "user");
    await agent.whenIdle();

    expect(receipt.state).toBe("accepted");
    expect(core.callsOf("thread.stop")[0].payload).toEqual({
      requestId: "req-1",
      threadId: "thread-1",
      reason: "user",
    });
  });
});

describe("streaming the answer", () => {
  it("relays live frames as an assistant stream, and closes it once", async () => {
    const core = fakeCore({
      live: [
        frame({ attempt: 1, messageId: "live:turn-1:1", index: 0, delta: "he" }),
        frame({ attempt: 1, messageId: "live:turn-1:1", index: 1, delta: "llo" }),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    expect(frames.map((frame) => frame.type)).toEqual(["start", "chunk", "chunk", "end"]);
    // One revision per frame, each the previous plus one: the interface's
    // accumulator drops any frame that does not follow that closely, so a
    // stream numbered by its attempt would draw the first chunk and no more.
    expect(frames.map((frame) => frame.revision)).toEqual([1, 2, 3, 4]);
    expect(frames[1].chunk).toEqual({ type: "text-delta", index: 0, text: "he" });
    expect(frames[3].outcome).toEqual({ kind: "abandoned" });
  });

  it("relays only the Run this turn submitted into, not another Run of the same Thread", async () => {
    const core = fakeCore({
      stream: [
        // A follow-up Run — another session's, or this one's own next turn —
        // streams through the same Thread subscription. Its frames are not this
        // turn's answer, and drawing them here would put another Run's words
        // inside this session's open turn.
        { kind: "live", frame: frame({ runId: "run-2", delta: "not mine" }) },
        { kind: "live", frame: frame({ delta: "mine" }) },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    expect(frames.map((frame) => frame.type)).toEqual(["start", "chunk", "end"]);
    expect(frames[1].chunk).toEqual({ type: "text-delta", index: 0, text: "mine" });
  });

  it("keeps two messages of one attempt apart, by their own messageId", async () => {
    const first = message({
      messageId: "live:m-text", entryId: 2, kind: "assistant", role: "assistant",
      text: "an answer", turnId: "turn-1",
    });
    const second = message({
      messageId: "live:m-again", entryId: 3, kind: "assistant", role: "assistant",
      text: "and more", turnId: "turn-1",
    });
    const core = fakeCore({
      messages: (yielded) => yielded >= 5 ? [first, second] : yielded >= 3 ? [first] : [],
      stream: [
        { kind: "live", frame: frame({ messageId: "live:m-text", index: 0, delta: "an " }) },
        { kind: "live", frame: frame({ messageId: "live:m-text", index: 1, delta: "answer" }) },
        committed(2, "message.committed", { messageId: "live:m-text" }),
        // The same attempt's second message. Sharing the attempt is not sharing
        // the message: keyed alike, the two would be drawn as one run of text
        // under one identity, and neither could be recognised when its
        // committed copy arrives under its own id. Its live preview waits for
        // the ordered history read to open that message's DSH step.
        { kind: "live", frame: frame({ messageId: "live:m-again", index: 0, delta: "and more" }) },
        committed(3, "message.committed", { messageId: "live:m-again" }),
        settled(),
      ],
    });
    const { agent, harness, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    // Each Core message owns its segment and its DSH step. The first segment
    // settles at its committed copy; the second starts only after its own step
    // is opened from ordered history.
    expect(frames.map((frame) => frame.type)).toEqual([
      "start", "chunk", "chunk", "end", "start", "chunk", "end",
    ]);
    const chunks = frames.filter((frame) => frame.type === "chunk");
    expect(chunks.map((chunk) => [chunk.attemptId, chunk.chunk.text])).toEqual([
      ["req-1:0:live:m-text", "an "],
      ["req-1:0:live:m-text", "answer"],
      ["req-1:0:live:m-again", "and more"],
    ]);
    // Two identities, not one message drawn twice.
    expect(new Set(chunks.map((chunk) => chunk.attemptId)).size).toBe(2);
    expect(frames.filter((frame) => frame.type === "start").map(({ turn, step }) => ({ turn, step }))).toEqual([
      { turn: 1, step: 1 },
      { turn: 1, step: 2 },
    ]);
    expectStreamStartsHaveReleasedBoundaries(session);
  });

  it("keeps two Core assistant messages in one Run on distinct DSH steps and matches their live streams", async () => {
    const first = message({
      entryId: 2,
      messageId: "core-answer-a",
      kind: "assistant",
      text: "first answer",
      turnId: "core-turn-a",
    });
    const second = message({
      entryId: 3,
      messageId: "core-answer-b",
      kind: "assistant",
      text: "second answer",
      turnId: "core-turn-b",
    });
    const core = fakeCore({
      // Nothing has been projected at submission time. Each Core message
      // appears only after its own committed event while the same Run is live.
      messages: (yielded) => yielded < 3 ? [] : yielded < 4 ? [first] : [first, second],
      stream: [
        { kind: "live", frame: frame({ messageId: "core-answer-a", turnId: "core-turn-a", delta: "first" }) },
        { kind: "live", frame: frame({ messageId: "core-answer-b", turnId: "core-turn-b", delta: "second" }) },
        committed(2, "message.committed", { messageId: "core-answer-a" }),
        committed(3, "message.committed", { messageId: "core-answer-b" }),
        committed(4, "message.committed", { messageId: "core-answer-a" }),
        settled(5),
      ],
    });
    const { agent, harness, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "answer twice" }] });
    await agent.whenIdle();

    const answers = eventsOf(session, "assistant/message");
    expect(answers.map((event) => event.data.message.id)).toEqual([
      "core-core-answer-a",
      "core-core-answer-b",
    ]);
    expect(answers.map((event) => event.data.message.content)).toEqual([
      [{ type: "text", text: "first answer" }],
      [{ type: "text", text: "second answer" }],
    ]);
    const positionOf = (event) => ({ turn: event.data.turn, step: event.data.step });
    const positions = answers.map(positionOf);
    expect(new Set(positions.map(({ turn, step }) => `${turn}:${step}`)).size).toBe(2);

    const starts = streamFrames(harness).filter((frame) => frame.type === "start");
    expect(starts).toHaveLength(2);
    for (const answer of answers) {
      const coreMessageId = answer.data.message.id.slice("core-".length);
      const start = starts.find((frame) => frame.attemptId.endsWith(`:${coreMessageId}`));
      expect(start, `live stream for ${coreMessageId}`).toBeDefined();
      expect({ turn: start.turn, step: start.step }).toEqual(positionOf(answer));
    }
    expectStreamStartsHaveReleasedBoundaries(session);

    // The later committed-event and Run-settlement reads saw the same history;
    // they must not add a second durable copy of either answer.
    expect(answers).toHaveLength(2);
    expect(core.callsOf("messages.list")).toHaveLength(5);
  });

  it("restores message positions after a host reopen and appends only later history", async () => {
    const first = message({
      entryId: 2,
      messageId: "core-answer-before-reopen-a",
      kind: "assistant",
      source: "core",
      text: "first answer",
      turnId: "core-turn-one",
    });
    const second = message({
      entryId: 3,
      messageId: "core-answer-before-reopen-b",
      kind: "assistant",
      source: "core",
      text: "second answer",
      turnId: "core-turn-one",
    });
    const later = message({
      entryId: 4,
      messageId: "core-answer-after-reopen",
      kind: "assistant",
      source: "core",
      text: "committed while the host was away",
      turnId: "core-turn-one",
    });
    const core = fakeCore({
      messages: (yielded) => yielded < 3 ? [] : yielded < 4 ? [first] : [first, second],
      stream: [
        { kind: "live", frame: frame({ messageId: first.messageId, turnId: first.turnId, delta: "first" }) },
        { kind: "live", frame: frame({ messageId: second.messageId, turnId: second.turnId, delta: "second" }) },
        committed(2, "message.committed", { messageId: first.messageId }),
        committed(3, "message.committed", { messageId: second.messageId }),
        committed(4, "message.committed", { messageId: first.messageId }),
        settled(5),
      ],
    });
    const fs = memoryFs();
    const before = await startAgent({ core, fs });
    before.agent.followup({ id: "before-reopen", content: [{ type: "text", text: "answer twice" }] });
    await before.agent.whenIdle();

    const previousAnswers = eventsOf(before.session, "assistant/message");
    expect(previousAnswers.map((event) => event.data.message.id)).toEqual([
      "core-core-answer-before-reopen-a",
      "core-core-answer-before-reopen-b",
    ]);
    const previousPositions = previousAnswers.map((event) => ({ turn: event.data.turn, step: event.data.step }));
    expect(new Set(previousPositions.map(({ turn, step }) => `${turn}:${step}`)).size).toBe(2);

    // Persist the exact log the next host reads, then expose one more Core
    // message that committed while there was no reader. The fresh host's first
    // history read must keep both identities/positions and append only the new
    // message after the old per-turn step high-water mark.
    const savedLog = before.session.events.map((event) => ({ ...event }));
    await before.dispose();
    core.state.messages = [first, second, later];
    core.state.stream = [];
    const after = await startAgent({ core, fs, seed: savedLog });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const answers = eventsOf(after.session, "assistant/message");
    expect(answers.map((event) => event.data.message.id)).toEqual([
      "core-core-answer-before-reopen-a",
      "core-core-answer-before-reopen-b",
      "core-core-answer-after-reopen",
    ]);
    expect(answers.slice(0, 2).map((event) => ({ turn: event.data.turn, step: event.data.step }))).toEqual(previousPositions);
    expect(answers[2].data).toMatchObject({ turn: previousPositions[1].turn, step: previousPositions[1].step + 1 });
    expect(new Set(answers.map((event) => `${event.data.turn}:${event.data.step}`)).size).toBe(3);
    expect(core.callsOf("input.submit")).toHaveLength(1);
    await after.dispose();
  });

  it("keeps legacy same-step history as written and gives a later unseen message a fresh step", async () => {
    const first = message({ entryId: 2, messageId: "legacy-answer-a", kind: "assistant", source: "core", text: "old A" });
    const second = message({ entryId: 3, messageId: "legacy-answer-b", kind: "assistant", source: "core", text: "old B" });
    const later = message({ entryId: 4, messageId: "after-legacy-collision", kind: "assistant", source: "core", text: "new C" });
    const core = fakeCore({ messages: [], stream: [settled(1)] });
    const fs = memoryFs();
    const before = await startAgent({ core, fs });
    before.agent.followup({ id: "create-thread", content: [{ type: "text", text: "create the existing Thread" }] });
    await before.agent.whenIdle();

    // A pre-fix session log can already contain colliding assistant positions.
    // Treat them as immutable history: the reopen must not duplicate or rewrite
    // those rows, and new history must move beyond their occupied step.
    const legacySeed = before.session.events.map((event) => ({ ...event }));
    legacySeed.push(
      {
        seq: legacySeed.length,
        type: "assistant/message",
        data: { turn: 1, step: 1, message: { id: "core-legacy-answer-a", role: "assistant", content: [{ type: "text", text: "old A" }] } },
      },
      {
        seq: legacySeed.length + 1,
        type: "assistant/message",
        data: { turn: 1, step: 1, message: { id: "core-legacy-answer-b", role: "assistant", content: [{ type: "text", text: "old B" }] } },
      },
    );
    await before.dispose();

    core.state.messages = [first, second, later];
    core.state.stream = [];
    const after = await startAgent({ core, fs, seed: legacySeed });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const answers = eventsOf(after.session, "assistant/message");
    expect(answers.map((event) => event.data.message.id)).toEqual([
      "core-legacy-answer-a",
      "core-legacy-answer-b",
      "core-after-legacy-collision",
    ]);
    expect(answers.slice(0, 2).map((event) => ({ turn: event.data.turn, step: event.data.step }))).toEqual([
      { turn: 1, step: 1 },
      { turn: 1, step: 1 },
    ]);
    expect(answers[2].data).toMatchObject({ turn: 1, step: 2 });
    expect(core.callsOf("input.submit")).toHaveLength(1);
    await after.dispose();
  });

  it("closes the retried message's fragment on stream.reset, and appends nothing for it", async () => {
    const core = fakeCore({
      messages: [message({ entryId: 1, kind: "user", text: "hello" })],
      stream: [
        { kind: "live", frame: frame({ messageId: "live:turn-1:0", delta: "half an ans" }) },
        // The retry names the message whose fragment it supersedes — and its own
        // request, because a retry mints the ref of the attempt it starts.
        {
          kind: "live",
          frame: frame({ type: "stream.reset", attempt: 1, requestRef: "req-2", messageId: "live:turn-1:0", delta: "" }),
        },
        { kind: "live", frame: frame({ attempt: 1, requestRef: "req-2", messageId: "live:turn-1:0", delta: "an answer" }) },
        settled(),
      ],
    });
    const { agent, harness, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    // The boundary closed attempt 0's segment and attempt 1 opened its own; the
    // reset itself is not content, so no chunk carries its empty delta.
    expect(frames.map((frame) => frame.type)).toEqual(["start", "chunk", "end", "start", "chunk", "end"]);
    expect(frames.map((frame) => frame.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(frames[0].attemptId).toBe("req-1:0:live:turn-1:0");
    expect(frames[3].attemptId).toBe("req-2:1:live:turn-1:0");
    expect(frames.filter((frame) => frame.type === "chunk").map((chunk) => chunk.chunk.text)).toEqual([
      "half an ans",
      "an answer",
    ]);
    // The superseded segment is closed, not merely idle: its own fragment stops
    // there and every later chunk belongs to the attempt that replaced it.
    expect(frames.filter((frame) => frame.attemptId === "req-1:0:live:turn-1:0").map((frame) => frame.type)).toEqual([
      "start",
      "chunk",
      "end",
    ]);
    // The retry touched the live segment and nothing else: the committed
    // transcript holds the Core's messages, not a fragment the model abandoned.
    expect(eventsOf(session, "assistant/message")).toHaveLength(0);
    expect(eventsOf(session, "user/message").map((event) => event.data.content[0].text)).toEqual(["hello"]);
  });

  it("closes the superseded fragment even though the boundary carries the new attempt's requestRef", async () => {
    const core = fakeCore({
      stream: [
        { kind: "live", frame: frame({ attempt: 1, messageId: "live:m-a", index: 0, delta: "A0" }) },
        { kind: "live", frame: frame({ attempt: 1, messageId: "live:m-a", index: 1, delta: "A1" }) },
        // A retry of the same message: its own attempt *and* its own request, as
        // the Core mints both from the attempt.
        {
          kind: "live",
          frame: frame({ type: "stream.reset", attempt: 2, requestRef: "req-2", messageId: "live:m-a", delta: "" }),
        },
        { kind: "live", frame: frame({ attempt: 2, requestRef: "req-2", messageId: "live:m-a", index: 0, delta: "A'" }) },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    const superseded = "req-1:1:live:m-a";
    const retried = "req-2:2:live:m-a";
    expect(frames.map((frame) => [frame.type, frame.attemptId])).toEqual([
      ["start", superseded],
      ["chunk", superseded],
      ["chunk", superseded],
      ["end", superseded],
      ["start", retried],
      ["chunk", retried],
      ["end", retried],
    ]);
    // The two fragments the model produced are kept apart by attempt, so the
    // abandoned one is closed with the two chunks it had and the retried one
    // starts from its own first chunk.
    expect(frames.filter((frame) => frame.attemptId === superseded && frame.type === "chunk").map((frame) => frame.chunk.text)).toEqual([
      "A0",
      "A1",
    ]);
    expect(frames.filter((frame) => frame.attemptId === retried && frame.type === "chunk").map((frame) => frame.chunk.text)).toEqual([
      "A'",
    ]);
  });

  it("closes the newest fragment of a message that has more than one open", async () => {
    const core = fakeCore({
      stream: [
        { kind: "live", frame: frame({ attempt: 1, messageId: "live:m-a", delta: "A1" }) },
        // No boundary between these two: the stream is lossy, so a frame can go
        // missing and leave an attempt's segment open when the next one starts.
        { kind: "live", frame: frame({ attempt: 2, requestRef: "req-2", messageId: "live:m-a", delta: "A2" }) },
        // The boundary that arrives afterwards supersedes the newest of them.
        {
          kind: "live",
          frame: frame({ type: "stream.reset", attempt: 3, requestRef: "req-3", messageId: "live:m-a", delta: "" }),
        },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    const older = "req-1:1:live:m-a";
    const newest = "req-2:2:live:m-a";
    expect(frames.map((frame) => [frame.type, frame.attemptId])).toEqual([
      ["start", older],
      ["chunk", older],
      ["start", newest],
      ["chunk", newest],
      // The one being superseded is the attempt that was streaming, not the one
      // that is already history.
      ["end", newest],
      ["end", older],
    ]);
    expect(frames.filter((frame) => frame.type === "end").map((frame) => frame.attemptId)).toEqual([newest, older]);
  });

  it("resets only the message it names, leaving another message of the same attempt streaming", async () => {
    const first = message({
      messageId: "live:m-a", entryId: 2, kind: "assistant", role: "assistant",
      text: "A0 A1", turnId: "turn-1",
    });
    const second = message({
      messageId: "live:m-b", entryId: 3, kind: "assistant", role: "assistant",
      text: "B0 B1", turnId: "turn-1",
    });
    const core = fakeCore({
      messages: (yielded) => yielded >= 6 ? [first, second] : [],
      stream: [
        { kind: "live", frame: frame({ messageId: "live:m-a", index: 0, delta: "A0" }) },
        // The same request and attempt, a second message. Its Core position
        // stays closed until ordered history opens its step.
        { kind: "live", frame: frame({ messageId: "live:m-b", index: 0, delta: "B0" }) },
        { kind: "live", frame: frame({ messageId: "live:m-a", index: 1, delta: "A1" }) },
        // A retry of message A alone.
        { kind: "live", frame: frame({ type: "stream.reset", attempt: 1, messageId: "live:m-a", delta: "" }) },
        { kind: "live", frame: frame({ messageId: "live:m-b", index: 1, delta: "B1" }) },
        // The ordered read opens B after both messages are projected. Resetting
        // A must not discard B's buffered fragments.
        committed(6, "message.committed", { messageId: "live:m-b" }),
        settled(),
      ],
    });
    const { agent, harness, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    const a = "req-1:0:live:m-a";
    const b = "req-1:0:live:m-b";
    expect(frames.map((frame) => [frame.type, frame.attemptId])).toEqual([
      ["start", a],
      ["chunk", a],
      ["chunk", a],
      // A alone is discarded, and B is untouched by it: still open, still its
      // own identity. Its held preview starts when the ordered read opens B.
      ["end", a],
      ["start", b],
      ["chunk", b],
      ["chunk", b],
      ["end", b],
    ]);
    // The retried message got no fragment after its reset, and the message that
    // was not named got no `start` and no `end` from it either.
    expect(frames.filter((frame) => frame.attemptId === a && frame.type === "chunk").map((frame) => frame.chunk.text)).toEqual([
      "A0",
      "A1",
    ]);
    expect(frames.filter((frame) => frame.attemptId === b && frame.type === "start")).toHaveLength(1);
    expect(frames.filter((frame) => frame.attemptId === b && frame.type === "chunk").map((frame) => frame.chunk.text)).toEqual([
      "B0",
      "B1",
    ]);
    expect(frames.map((frame) => frame.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expectStreamStartsHaveReleasedBoundaries(session);
  });

  it("does nothing when a reset names a message that has no open fragment", async () => {
    const core = fakeCore({
      stream: [
        { kind: "live", frame: frame({ messageId: "live:m-a", index: 0, delta: "A0" }) },
        // A late reset for a message that never opened a segment here. Closing
        // "the nearest thing" instead would cut off the message that is still
        // streaming.
        { kind: "live", frame: frame({ type: "stream.reset", attempt: 0, messageId: "live:m-gone", delta: "" }) },
        { kind: "live", frame: frame({ messageId: "live:m-a", index: 1, delta: "A1" }) },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    expect(frames.map((frame) => frame.type)).toEqual(["start", "chunk", "chunk", "end"]);
    expect(frames.map((frame) => frame.revision)).toEqual([1, 2, 3, 4]);
    expect(frames.filter((frame) => frame.type === "chunk").map((frame) => frame.chunk.text)).toEqual(["A0", "A1"]);
  });

  it("cannot close a retried fragment that carries the pre-mint fallback id", async () => {
    // The host may leave `LiveFrameContext.messageId` out, and the frame then
    // falls back to `live:<turnId>:<attempt>` — an id built from the attempt,
    // so the retry's boundary names a different one than the fragment it
    // supersedes and there is nothing for the reset to match. This is the
    // pre-mint fallback's limit, and it is why the production path has to mint
    // the committed id when the request starts: with it, one logical message
    // keeps its id across attempts and the boundary can name it.
    const first = message({
      messageId: "live:turn-1:0", entryId: 2, kind: "assistant", role: "assistant",
      text: "half an answer", turnId: "turn-1",
    });
    const second = message({
      messageId: "live:turn-1:1", entryId: 3, kind: "assistant", role: "assistant",
      text: "an answer", turnId: "turn-1",
    });
    const core = fakeCore({
      messages: (yielded) => yielded >= 4 ? [first, second] : [],
      stream: [
        { kind: "live", frame: frame({ attempt: 0, turnId: "turn-1", messageId: "live:turn-1:0", delta: "half an ans" }) },
        {
          kind: "live",
          frame: frame({
            type: "stream.reset",
            attempt: 1,
            turnId: "turn-1",
            requestRef: "req-2",
            messageId: "live:turn-1:1",
            delta: "",
          }),
        },
        {
          kind: "live",
          frame: frame({ attempt: 1, turnId: "turn-1", requestRef: "req-2", messageId: "live:turn-1:1", delta: "an answer" }),
        },
        committed(2, "message.committed", { messageId: "live:turn-1:1" }),
        settled(),
      ],
    });
    const { agent, harness, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const frames = streamFrames(harness);
    // The fallback names a different identity for the retry, so its reset does
    // not close the first fragment. The second preview remains held until the
    // committed history opens its step; each committed copy then settles its
    // own segment.
    expect(frames.map((frame) => [frame.type, frame.attemptId])).toEqual([
      ["start", "req-1:0:live:turn-1:0"],
      ["chunk", "req-1:0:live:turn-1:0"],
      ["end", "req-1:0:live:turn-1:0"],
      ["start", "req-2:1:live:turn-1:1"],
      ["chunk", "req-2:1:live:turn-1:1"],
      ["end", "req-2:1:live:turn-1:1"],
    ]);
    const firstMessage = session.timeline.findIndex(
      (item) => item.kind === "append"
        && item.event.type === "assistant/message"
        && item.event.data.message.id === "core-live:turn-1:0",
    );
    const firstEnd = session.timeline.findIndex(
      (item) => item.kind === "emit"
        && item.type === "agent/assistant-stream"
        && item.payload.frame.type === "end"
        && item.payload.frame.attemptId === "req-1:0:live:turn-1:0",
    );
    expect(firstMessage).toBeGreaterThanOrEqual(0);
    expect(firstEnd).toBeGreaterThan(firstMessage);
    expectStreamStartsHaveReleasedBoundaries(session);
  });

  it("projects a thinking frame as reasoning, not as text", async () => {
    const core = fakeCore({
      stream: [
        { kind: "live", frame: frame({ type: "stream.thinking_delta", index: 0, delta: "let me see" }) },
        { kind: "live", frame: frame({ index: 1, delta: "the answer" }) },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const chunks = streamFrames(harness).filter((frame) => frame.type === "chunk");
    // The interface has a chunk for a model's reasoning; drawing it as text
    // would claim the model said it.
    expect(chunks.map((chunk) => chunk.chunk)).toEqual([
      { type: "reasoning-delta", index: 0, text: "let me see" },
      { type: "text-delta", index: 1, text: "the answer" },
    ]);
  });

  it("addresses a tool-call fragment to the call the Core announced", async () => {
    const core = fakeCore({
      stream: [
        {
          kind: "live",
          frame: frame({
            type: "stream.tool_call_delta",
            index: 0,
            delta: '{"path":',
            toolCallId: "call-1",
            toolName: "read_file",
          }),
        },
        {
          kind: "live",
          frame: frame({
            type: "stream.tool_call_delta",
            index: 1,
            delta: '"a"}',
            toolCallId: "call-1",
            toolName: "read_file",
          }),
        },
        { kind: "live", frame: frame({ index: 2, delta: "done" }) },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The call's own id, name and argument fragment — the interface's
    // `tool-call-delta`, which names the call rather than the message. The id is
    // the one the Core published, so a host renders the fragment into the call
    // the model declared instead of under an identity this file invented.
    const chunks = streamFrames(harness)
      .filter((frame) => frame.type === "chunk")
      .map((chunk) => chunk.chunk);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, id: "call-1", argumentsDelta: '{"path":', name: "read_file" },
      { type: "tool-call-delta", index: 1, id: "call-1", argumentsDelta: '"a"}', name: "read_file" },
      { type: "text-delta", index: 2, text: "done" },
    ]);
    // An addressed fragment is not a limitation, so nothing is recorded for it.
    expect(harness.warnings.filter((line) => line.includes("stream.tool_call_delta"))).toHaveLength(0);
  });

  it("carries no name when the Core named no tool, rather than inventing one", async () => {
    const core = fakeCore({
      stream: [
        {
          kind: "live",
          frame: frame({ type: "stream.tool_call_delta", index: 0, delta: "{}", toolCallId: "call-9" }),
        },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The Core sets the two fields together, but they are independent in the
    // frame's type, and a name this file made up would be a tool identity
    // nothing published. Absent, not empty.
    const [chunk] = streamFrames(harness)
      .filter((frame) => frame.type === "chunk")
      .map((frame) => frame.chunk);
    expect(chunk).toEqual({ type: "tool-call-delta", index: 0, id: "call-9", argumentsDelta: "{}" });
    expect("name" in chunk).toBe(false);
  });

  it("keeps two calls of one message apart, and leaves a text delta its own identity", async () => {
    const core = fakeCore({
      stream: [
        {
          kind: "live",
          frame: frame({
            type: "stream.tool_call_delta",
            index: 0,
            delta: '{"a":',
            toolCallId: "call-a",
            toolName: "alpha",
          }),
        },
        { kind: "live", frame: frame({ index: 1, delta: "meanwhile" }) },
        {
          kind: "live",
          frame: frame({
            type: "stream.tool_call_delta",
            index: 2,
            delta: "1}",
            toolCallId: "call-b",
            toolName: "beta",
          }),
        },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // One message, two calls: each fragment keeps the id of the call it belongs
    // to, and the text between them is text — a fragment does not inherit the
    // previous call's identity, and a call's arguments are not drawn as words.
    const chunks = streamFrames(harness)
      .filter((frame) => frame.type === "chunk")
      .map((chunk) => chunk.chunk);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, id: "call-a", argumentsDelta: '{"a":', name: "alpha" },
      { type: "text-delta", index: 1, text: "meanwhile" },
      { type: "tool-call-delta", index: 2, id: "call-b", argumentsDelta: "1}", name: "beta" },
    ]);
    // Both fragments are in one segment: the message is what segments, and two
    // calls of one message are one stream of that message.
    expect(new Set(streamFrames(harness).filter((frame) => frame.type === "chunk").map((frame) => frame.attemptId)).size).toBe(1);
  });

  it("closes a segment opened by a tool-call fragment on stream.reset, like any other", async () => {
    const core = fakeCore({
      stream: [
        {
          kind: "live",
          frame: frame({
            type: "stream.tool_call_delta",
            index: 0,
            delta: '{"path":',
            toolCallId: "call-1",
            toolName: "read_file",
          }),
        },
        {
          kind: "live",
          frame: frame({ type: "stream.reset", attempt: 1, requestRef: "req-2", messageId: "live:turn-1:0", delta: "" }),
        },
        {
          kind: "live",
          frame: frame({
            type: "stream.tool_call_delta",
            attempt: 1,
            requestRef: "req-2",
            index: 0,
            delta: '{"other":',
            toolCallId: "call-2",
            toolName: "write_file",
          }),
        },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The boundary is about the message, not about what kind of chunk the
    // segment was drawing: the superseded attempt's call fragment stops there
    // and the replacement's call is addressed under its own id.
    const frames = streamFrames(harness);
    expect(frames.map((frame) => frame.type)).toEqual(["start", "chunk", "end", "start", "chunk", "end"]);
    expect(frames.filter((frame) => frame.attemptId === "req-1:0:live:turn-1:0").map((frame) => frame.type)).toEqual([
      "start",
      "chunk",
      "end",
    ]);
    expect(frames.filter((frame) => frame.type === "chunk").map((chunk) => chunk.chunk)).toEqual([
      { type: "tool-call-delta", index: 0, id: "call-1", argumentsDelta: '{"path":', name: "read_file" },
      { type: "tool-call-delta", index: 0, id: "call-2", argumentsDelta: '{"other":', name: "write_file" },
    ]);
  });

  it("drops a tool-call fragment whose call the Core never announced, and records it once", async () => {
    const core = fakeCore({
      stream: [
        { kind: "live", frame: frame({ type: "stream.tool_call_delta", index: 0, delta: '{"path":' }) },
        { kind: "live", frame: frame({ type: "stream.tool_call_delta", index: 1, delta: '"a"}' }) },
        { kind: "live", frame: frame({ index: 2, delta: "done" }) },
        settled(),
      ],
    });
    const { agent, harness } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The interface's tool-call chunk names the call, and a fragment whose call
    // was never announced has no id the Core published — the message id is not
    // the call id, and the nearest call's id is someone else's arguments. The
    // fragment is dropped instead of shown under a made-up identity, and the
    // limitation is said out loud once rather than per token.
    const chunks = streamFrames(harness).filter((frame) => frame.type === "chunk");
    expect(chunks.map((chunk) => chunk.chunk)).toEqual([{ type: "text-delta", index: 2, text: "done" }]);
    const noted = harness.warnings.filter((line) => line.includes("stream.tool_call_delta"));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain("named no tool call");
  });

  it("re-reads the transcript when a message is committed, before the Run settles", async () => {
    const core = fakeCore({
      stream: [
        { kind: "live", frame: frame({ delta: "working" }) },
        // A message the Core committed while the Run was still going. It names
        // no Run — a message's Run and Turn are facts of the settlement — so a
        // read keyed on this Run's id would skip exactly this event.
        committed(2, "message.committed", { messageId: "msg-7", text: "the answer" }),
        settled(3),
      ],
    });
    const { agent } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // `yielded` is how far the subscription had got when the read was made: one
    // read after the submit (nothing streamed yet), one with the Run still
    // live, and one at the settlement. A transcript that synced only at
    // settlement would have the first and the last and nothing between.
    expect(core.callsOf("messages.list").map((call) => call.yielded)).toEqual([0, 2, 3]);
  });

  it("appends a message once even though its native entry is linked after it is committed", async () => {
    // The projection fills `entryId` in after the commit, with no second event:
    // the first read sees the message unlinked, the later one sees its entry.
    // Both are reads of one message, and the session must hold it once.
    const unlinked = message({ entryId: null, messageId: "msg-7", kind: "assistant", text: "the answer" });
    const linked = message({ entryId: 7, messageId: "msg-7", kind: "assistant", text: "the answer" });
    const core = fakeCore({
      messages: (yielded) => (yielded < 3 ? [unlinked] : [linked]),
      stream: [
        { kind: "live", frame: frame({ delta: "the answer" }) },
        committed(2, "message.committed", { messageId: "msg-7" }),
        settled(3),
      ],
    });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const answers = eventsOf(session, "assistant/message");
    expect(answers).toHaveLength(1);
    expect(answers[0].data.message.content).toEqual([{ type: "text", text: "the answer" }]);
  });

  it("does not cancel the Run when the Core's stream ends without settling it", async () => {
    const core = fakeCore({ stream: [{ kind: "live", frame: frame({ delta: "half" }) }] });
    const { agent, session } = await startAgent({ core });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    // The wait ended; the Run did not. Stopping it is the Core's to do and the
    // user's to ask for, and a dropped stream is neither.
    expect(core.callsOf("thread.stop")).toHaveLength(0);
    // The turn is closed aborted, with the contract's "no cause was recorded":
    // nobody cancelled this turn, and a stream ending under it is not one of the
    // causes the union names.
    expect(eventsOf(session, "turn/end")[0].data.reason).toEqual({
      kind: "aborted",
      reason: { kind: "legacy" },
    });
  });
});

describe("the event mapping", () => {
  it("names a message by the Core's message id, so a re-read cannot duplicate it", () => {
    const mapped = sessionEventForMessage(message({ messageId: "msg-7", entryId: 7, kind: "assistant", source: "core", text: "hi" }));
    expect(mapped.type).toBe("assistant/message");
    expect(mapped.data.message.id).toBe("core-msg-7");
    // The id is the message's own, not its native entry's: an accepted message
    // is listed with `entryId: null` and linked to a real entry a moment later
    // without a second event, and an id that followed the entry would name the
    // same message twice and append it twice.
    const accepted = sessionEventForMessage(message({ messageId: "msg-7", entryId: null, kind: "assistant" }));
    expect(accepted.data.message.id).toBe("core-msg-7");
    // One entry can carry several messages — an assistant entry that narrates
    // and then calls two tools is three — so an id derived from the entry would
    // give them one name and the transcript would keep one of them.
    const narration = sessionEventForMessage(message({ messageId: "msg-7", entryId: 7, kind: "assistant" }));
    const call = sessionEventForMessage(message({ messageId: "msg-8", entryId: 7, kind: "tool_call", toolCallId: "call-1" }));
    expect(narration.data.message.id).toBe("core-msg-7");
    // The call is not a message event: its identity is the call's own id, which
    // the transcript records and reads back.
    expect(call.data.callId).toBe("call-1");
    expect(messageIdentityKeys(message({ messageId: "msg-7", entryId: 7 }))).not.toEqual(
      messageIdentityKeys(message({ messageId: "msg-8", entryId: 7, kind: "tool_call", toolCallId: "call-1" })),
    );
  });

  it("falls back to the entry id only for a record with no message id at all", () => {
    // The entry form is the id this module used to mint. It survives so a log
    // written then still matches the message it holds; it is never reached for
    // a message this Core wrote, because `messageId` is a required field of the
    // listing.
    const legacy = sessionEventForMessage(message({ messageId: null, entryId: 7, kind: "assistant" }));
    expect(legacy.data.message.id).toBe("core-entry-7");
    // A record with neither has no identity to be recorded under.
    expect(sessionEventForMessage(message({ messageId: null, entryId: null }))).toBeNull();
    // `""` is not an id: it would name a message that exists with no name.
    expect(sessionEventForMessage(message({ messageId: "", entryId: null }))).toBeNull();
  });

  it("remembers a tool call by its call id as well as its message id", () => {
    // The DSH transcript records a call under its `callId`, and a session log
    // written before this build keyed messages by their Core id holds no
    // message id for a call at all — only the `callId` its event carried.
    // Remembering the call id is what keeps a restart from appending it again.
    expect(messageIdentityKeys(message({ messageId: "msg-8", kind: "tool_call", toolCallId: "call-1" }))).toEqual([
      "core-msg-8",
      "call:call-1",
    ]);
    // Only a call: an assistant message is known by its own id alone, and a
    // call with no id is known by its message id rather than by a fabricated one.
    expect(messageIdentityKeys(message({ messageId: "msg-7", kind: "assistant" }))).toEqual(["core-msg-7"]);
    expect(messageIdentityKeys(message({ messageId: "msg-8", kind: "tool_call", toolCallId: null }))).toEqual(["core-msg-8"]);
  });

  it("remembers a forked message's origin id alongside its own child id", () => {
    expect(messageIdentityKeys(message({
      messageId: "fork-child-msg",
      origin: { conversationId: "29", messageId: "parent-msg" },
    }))).toEqual(["core-fork-child-msg", "core-parent-msg"]);
  });

  it("maps a message kind to the event type and role the transcript uses", () => {
    expect(sessionEventTypeFor("tool_call")).toBe("tool/call");
    expect(sessionEventTypeFor("tool_result")).toBe("tool/result");
    expect(sessionEventTypeFor("assistant")).toBe("assistant/message");
    expect(sessionRoleFor("assistant")).toBe("assistant");
    // A note the Core wrote itself is a developer message: the harness only
    // accepts `developer/message` with the `developer` role, and it has no
    // other role for a message that is neither the user's nor the model's.
    expect(sessionEventTypeFor("compaction")).toBe("developer/message");
    expect(sessionRoleFor("compaction")).toBe("developer");
    // An unknown kind is still recorded, as the same kind of note.
    expect(sessionEventTypeFor("something-new")).toBe("developer/message");
    expect(sessionRoleFor("something-new")).toBe("developer");
  });

  it("shapes each message event the way the harness validates it", () => {
    // The harness pairs the event type with the role and refuses the append
    // otherwise, and it requires a `surfaceOp` on every message event except
    // `tool/call`, which is not a surface event at all.
    const cases = [
      ["user", "user/message", "user", true],
      ["assistant", "assistant/message", "assistant", true],
      ["tool_result", "tool/result", "tool", true],
      ["system", "developer/message", "developer", true],
      ["tool_call", "tool/call", null, false],
    ];
    for (const [kind, type, role, onSurface] of cases) {
      const mapped = sessionEventForMessage(message({ kind, text: "body", toolCallId: "call-1" }), {
        turn: 3,
        step: 2,
      });
      expect([kind, mapped.type]).toEqual([kind, type]);
      if (role !== null) {
        const body = mapped.type === "user/message" ? mapped.data : mapped.data.message;
        expect([kind, body.role]).toEqual([kind, role]);
      }
      expect([kind, mapped.options?.surfaceOp ?? null]).toEqual([kind, onSurface ? "append" : null]);
      // Only the user's own message has no coordinates: the harness reads its
      // data as the message itself, so a turn field would land inside it. Every
      // other event states the turn and step it belongs to.
      if (kind !== "user") expect([kind, mapped.data.turn]).toEqual([kind, 3]);
    }
    // A tool call is the call's own fields, not a message: the harness refuses
    // a `surfaceOp` on it, and the transcript reads the call id off `callId`.
    const call = sessionEventForMessage(message({ kind: "tool_call", toolCallId: "call-1" }));
    expect(call.data.callId).toBe("call-1");
    expect(call.data.message).toBeUndefined();
    // The model source must name a provider and a model, and a tool result
    // must name the call it answers — the harness checks both.
    const assistant = sessionEventForMessage(message({ kind: "assistant" }));
    expect(assistant.data.message.source).toMatchObject({ kind: "model" });
    expect(assistant.data.message.source.provider).toBeTruthy();
    expect(assistant.data.message.source.model).toBeTruthy();
    const result = sessionEventForMessage(message({ kind: "tool_result", toolCallId: "call-1" }));
    expect(result.data.message.source).toEqual({ kind: "tool", callId: "call-1" });
    expect(result.data.message.toolCallId).toBe("call-1");
  });

  it("carries no text block for a message whose text is null", () => {
    const mapped = sessionEventForMessage(message({ kind: "assistant", text: null }));
    // Not an empty string: that would claim the model produced one.
    expect(mapped.data.message.content).toEqual([]);
  });

  it("reports only the messages the session does not already hold", () => {
    const seen = new Set(["core-msg-1"]);
    const unseen = unseenMessages(
      [message({ messageId: "msg-1", entryId: 1 }), message({ messageId: "msg-2", entryId: 2 })],
      seen,
    );
    expect(unseen.map((item) => item.messageId)).toEqual(["msg-2"]);
  });

  it("does not let one entry's legacy marker suppress the entry's other messages", () => {
    // A log written before the message id was the identity holds
    // `core-entry-7` for the one message such a build recorded for that entry.
    // The entry is not the message: suppressing every message it names would
    // lose the tool calls of an entry whose narration the old log already has.
    const held = new Set(["core-entry-7"]);
    const entry = [
      message({ messageId: "msg-7", entryId: 7, kind: "assistant", text: "let me look" }),
      message({ messageId: "msg-8", entryId: 7, kind: "tool_call", toolCallId: "call-1" }),
      message({ messageId: "msg-9", entryId: 7, kind: "tool_call", toolCallId: "call-2" }),
    ];
    expect(unseenMessages(entry, held).map((item) => item.messageId)).toEqual(["msg-8", "msg-9"]);
    // The marker is spent on the entry's *first* listed message, which is the
    // one such a build recorded: an entry's own message precedes its calls.
    // Read twice against the same held set, the answer is the same.
    expect(unseenMessages(entry, held).map((item) => item.messageId)).toEqual(["msg-8", "msg-9"]);
    // A message the session already holds by its own id is not re-listed, and
    // the marker does not reach an entry whose own message is a different one.
    const seenCall = new Set(["core-msg-8"]);
    expect(unseenMessages(entry, seenCall).map((item) => item.messageId)).toEqual(["msg-7", "msg-9"]);
  });

  it("keeps a message the log holds by its call id from coming back", () => {
    // A restart seeds `seen` from the log's own events, and a call in it was
    // recorded under its `callId` — there is no message id to match on.
    const held = new Set(["call:call-1"]);
    const listed = [
      message({ messageId: "msg-7", entryId: 7, kind: "assistant" }),
      message({ messageId: "msg-8", entryId: 7, kind: "tool_call", toolCallId: "call-1" }),
    ];
    expect(unseenMessages(listed, held).map((item) => item.messageId)).toEqual(["msg-7"]);
  });

  it("ends a turn only on the Run's own settlement", () => {
    expect(turnOutcomeFor({ type: "run.completed", payload: {} })).toEqual({ kind: "completed" });
    // A failed Run is the contract's `error` variant. There is no `failed`
    // member in the interface's map, and a reason it cannot match is a reason
    // its readers never draw.
    expect(turnOutcomeFor({ type: "run.failed", payload: { endReason: "model_failure" } })).toEqual({
      kind: "error",
      error: { message: "model_failure", code: "UNKNOWN" },
    });
    // A cancelled Run's cause is read from the Core's own record and nothing
    // else: `user_stop` is the Core saying a user's stop ended this Run, so it
    // maps to `user`. Every other end reason says why the Run stopped rather
    // than who asked, and is not a DSH cause at all — so the contract's "no
    // cause was recorded" is what is said, rather than a guess.
    expect(turnOutcomeFor({ type: "run.cancelled", payload: { endReason: "user_stop" } })).toEqual({
      kind: "aborted",
      reason: { kind: "user" },
    });
    expect(turnOutcomeFor({ type: "run.cancelled", payload: { endReason: "thread_archived" } })).toEqual({
      kind: "aborted",
      reason: { kind: "legacy" },
    });
    expect(turnOutcomeFor({ type: "run.cancelled", payload: {} })).toEqual({
      kind: "aborted",
      reason: { kind: "legacy" },
    });
    expect(turnOutcomeFor({ type: "thread.status_changed", payload: {} })).toBeNull();
    expect(turnOutcomeFor({ type: "input.accepted", payload: {} })).toBeNull();
  });

  it("names the Run an event is about, and nothing else", () => {
    expect(runIdOf({ payload: { runId: "run-1" } })).toBe("run-1");
    expect(runIdOf({ payload: { targetRunId: "run-2" } })).toBe("run-2");
    expect(runIdOf({ payload: {} })).toBeNull();
  });

  it("gives the panel a line for the facts it knows, and an honest one for the rest", () => {
    expect(statusLineFor({ type: "run.completed", threadId: "t", payload: { runId: "run-1" } })).toEqual({
      code: "run.completed",
      text: "Run 完成",
      threadId: "t",
      runId: "run-1",
    });
    const unknown = statusLineFor({ type: "future.event", payload: {} });
    expect(unknown.text).toBe("未知事件");
    // The code is the Core's own, so a caller can still branch on the fact.
    expect(unknown.code).toBe("future.event");
  });
});

describe("the session map", () => {
  it("lives beside the Core home unless the operator moved the home", () => {
    expect(defaultSessionMapPath({ SUPER_AGENT_HOME: "/tmp/h" })).toBe("/tmp/h/bridge/sessions.json");
  });

  it("treats an absent file as an empty map, and refuses one it cannot read", async () => {
    const fs = memoryFs();
    const map = await openSessionMap({ path: "/mem/sessions.json", fs });
    expect(map.get("session-1")).toBeUndefined();

    fs.files.set("/mem/sessions.json", "{ not json");
    await expect(openSessionMap({ path: "/mem/sessions.json", fs })).rejects.toThrow();
  });

  it("refuses a schema version this build does not read instead of guessing", async () => {
    const fs = memoryFs();
    fs.files.set("/mem/sessions.json", JSON.stringify({ schemaVersion: 99, sessions: [] }));
    await expect(openSessionMap({ path: "/mem/sessions.json", fs })).rejects.toThrow(/schemaVersion 99/);
  });

  it("replaces the whole file, so a crash leaves the previous mapping", async () => {
    const fs = memoryFs();
    const map = await openSessionMap({ path: "/mem/sessions.json", fs });
    await map.put({
      sessionId: "s1",
      threadId: "t1",
      mainConversationId: "1",
      workspaceId: "w1",
      workspaceRoot: "/tmp/ws",
      cwd: "/tmp/ws",
      agentId: "main",
      modelId: null,
      createdAt: 1,
    });
    expect(fs.files.has("/mem/sessions.json")).toBe(true);
    // The temporary file the write went through is gone: the replace is atomic.
    expect([...fs.files.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
    expect(await map.remove("s1")).toBe(true);
    expect(JSON.parse(fs.files.get("/mem/sessions.json")).sessions).toEqual([]);
  });
});

describe("the input records", () => {
  const record = (overrides = {}) => ({
    sessionId: "session-1",
    rpcId: "rpc-1",
    requestId: "dsh:session-1:input:rpc-1",
    threadId: "thread-1",
    conversationId: "29",
    delivery: "new_run",
    targetRunId: null,
    messageId: null,
    source: { kind: "user", rpcId: "rpc-1" },
    createdAt: 1,
    ...overrides,
  });

  it("lives beside the Core home unless the operator moved the home", () => {
    expect(defaultInputReceiptsPath({ SUPER_AGENT_HOME: "/tmp/h" })).toBe("/tmp/h/bridge/inputs.json");
  });

  it("keeps what an input was submitted as and what it became, across a reopen", async () => {
    const fs = memoryFs();
    const first = await openInputReceipts({ path: "/mem/inputs.json", fs });
    await first.put(record({ messageId: "msg-1" }));

    // A second bridge over the same file reads the same record: this is what a
    // read *after* the turn that submitted it claims the input's message by.
    const reopened = await openInputReceipts({ path: "/mem/inputs.json", fs });
    expect(reopened.get("session-1", "rpc-1")).toMatchObject({
      requestId: "dsh:session-1:input:rpc-1",
      delivery: "new_run",
      messageId: "msg-1",
    });
    expect(reopened.forMessage("session-1", "29", "msg-1")?.rpcId).toBe("rpc-1");
    // Another Session, and another line of history, are not this input.
    expect(reopened.forMessage("session-2", "29", "msg-1")).toBeUndefined();
    expect(reopened.forMessage("session-1", "31", "msg-1")).toBeUndefined();
  });

  it("keeps one Session's records bounded, dropping the one it least needs", async () => {
    const fs = memoryFs();
    const receipts = await openInputReceipts({ path: "/mem/inputs.json", fs, limit: 2 });
    for (const rpcId of ["rpc-1", "rpc-2", "rpc-3"]) {
      await receipts.put(record({ rpcId, requestId: `dsh:session-1:input:${rpcId}`, source: { kind: "user", rpcId } }));
    }
    expect(receipts.get("session-1", "rpc-1")).toBeUndefined();
    expect(receipts.all("session-1").map((entry) => entry.rpcId)).toEqual(["rpc-2", "rpc-3"]);
  });

  it("refuses a schema version this build does not read instead of guessing", async () => {
    const fs = memoryFs();
    fs.files.set("/mem/inputs.json", JSON.stringify({ schemaVersion: 99, inputs: [] }));
    await expect(openInputReceipts({ path: "/mem/inputs.json", fs })).rejects.toThrow(/schemaVersion 99/);
  });

  it("keeps both Sessions' records when they are written at once", async () => {
    // One store is opened per home, not per Session, and the write is a
    // whole-file replace through one temporary path: two writes in flight
    // together would interleave in it, and the second rename would find nothing
    // to rename. Two Sessions of one home do write at once — they are two turns
    // on one Core — so the writes are queued, and both records are in the file
    // the next open reads.
    const fs = memoryFs();
    const receipts = await openInputReceipts({ path: "/mem/inputs.json", fs });
    const mine = (sessionId, rpcId) =>
      record({
        sessionId,
        rpcId,
        requestId: `dsh:${sessionId}:input:${rpcId}`,
        source: { kind: "user", rpcId },
      });
    await Promise.all([receipts.put(mine("session-1", "rpc-a")), receipts.put(mine("session-2", "rpc-b"))]);

    const reopened = await openInputReceipts({ path: "/mem/inputs.json", fs });
    expect(reopened.get("session-1", "rpc-a")?.requestId).toBe("dsh:session-1:input:rpc-a");
    expect(reopened.get("session-2", "rpc-b")?.requestId).toBe("dsh:session-2:input:rpc-b");
  });

  it("remembers nothing a failed write did not put on disk", async () => {
    // A caller that is told the record could not be written must not find it
    // read back as though it had been: the store is what a later delivery asks
    // whether a prompt was submitted before, so it says what the file says.
    const base = memoryFs();
    let unwritable = false;
    const fs = {
      ...base,
      async writeFile(path, text) {
        if (unwritable) throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
        return await base.writeFile(path, text);
      },
    };
    const receipts = await openInputReceipts({ path: "/mem/inputs.json", fs, limit: 1 });
    await receipts.put(record({ messageId: "msg-1" }));

    unwritable = true;
    await expect(
      receipts.put(
        record({
          rpcId: "rpc-2",
          requestId: "dsh:session-1:input:rpc-2",
          source: { kind: "user", rpcId: "rpc-2" },
        }),
      ),
    ).rejects.toThrow(/EACCES/);
    // Neither the record the write would have added nor the one the cap would
    // have dropped: the store is exactly what the file holds.
    expect(receipts.get("session-1", "rpc-2")).toBeUndefined();
    expect(receipts.all("session-1").map((entry) => entry.rpcId)).toEqual(["rpc-1"]);
    expect(receipts.forMessage("session-1", "29", "msg-1")?.rpcId).toBe("rpc-1");

    // And the queue keeps going: the next write succeeds.
    unwritable = false;
    await receipts.put(
      record({
        rpcId: "rpc-2",
        requestId: "dsh:session-1:input:rpc-2",
        source: { kind: "user", rpcId: "rpc-2" },
      }),
    );
    expect(receipts.get("session-1", "rpc-2")?.requestId).toBe("dsh:session-1:input:rpc-2");
  });

  it("publishes a record only once the file holds it, and keeps the old state when the write fails", async () => {
    // The store answers questions another turn acts on — was this prompt
    // delivered before, is this message the one it became — so a reader that
    // arrives while a write is in flight must not be answered from it: a record
    // that is not on disk yet, or the absence of one that still is, is an answer
    // that never became true. The write is built beside the live state and
    // swapped in once the flush returns; here the file's last step is held open
    // while the reads happen, and then made to fail.
    const base = memoryFs();
    let blocked = null;
    let failing = false;
    const fs = {
      ...base,
      async rename(from, to) {
        if (blocked !== null) await blocked.promise;
        if (failing) throw Object.assign(new Error(`EACCES: ${to}`), { code: "EACCES" });
        return await base.rename(from, to);
      },
    };
    const hold = () => {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const second = record({
      rpcId: "rpc-2",
      requestId: "dsh:session-1:input:rpc-2",
      source: { kind: "user", rpcId: "rpc-2" },
    });
    const receipts = await openInputReceipts({ path: "/mem/inputs.json", fs, limit: 1 });
    await receipts.put(record({ messageId: "msg-1" }));

    // A second record at the cap's edge: publishing it drops the first.
    const held = hold();
    blocked = held;
    const writing = receipts.put(second);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(receipts.get("session-1", "rpc-2")).toBeUndefined();
    expect(receipts.get("session-1", "rpc-1")?.messageId).toBe("msg-1");
    expect(receipts.forMessage("session-1", "29", "msg-1")?.rpcId).toBe("rpc-1");
    expect(receipts.all("session-1").map((entry) => entry.rpcId)).toEqual(["rpc-1"]);

    held.release();
    blocked = null;
    await writing;
    expect(receipts.get("session-1", "rpc-2")?.requestId).toBe("dsh:session-1:input:rpc-2");
    expect(receipts.get("session-1", "rpc-1")).toBeUndefined();
    expect(receipts.all("session-1").map((entry) => entry.rpcId)).toEqual(["rpc-2"]);

    // The same write, this time failing at its last step: readers see the state
    // they saw before, whole — nothing dropped on the way to a record that was
    // never written.
    failing = true;
    const refused = hold();
    blocked = refused;
    const failed = receipts.put(
      record({ rpcId: "rpc-3", requestId: "dsh:session-1:input:rpc-3", source: { kind: "user", rpcId: "rpc-3" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(receipts.get("session-1", "rpc-3")).toBeUndefined();
    expect(receipts.all("session-1").map((entry) => entry.rpcId)).toEqual(["rpc-2"]);

    refused.release();
    blocked = null;
    await expect(failed).rejects.toThrow(/EACCES/);
    expect(receipts.get("session-1", "rpc-3")).toBeUndefined();
    expect(receipts.get("session-1", "rpc-2")?.requestId).toBe("dsh:session-1:input:rpc-2");
    expect(JSON.parse(base.files.get("/mem/inputs.json")).inputs.map((entry) => entry.rpcId)).toEqual(["rpc-2"]);

    // And the queue carries on: the next writer publishes normally.
    failing = false;
    await receipts.put(
      record({ rpcId: "rpc-3", requestId: "dsh:session-1:input:rpc-3", source: { kind: "user", rpcId: "rpc-3" } }),
    );
    expect(receipts.all("session-1").map((entry) => entry.rpcId)).toEqual(["rpc-3"]);
  });
});
