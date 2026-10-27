/**
 * Lifecycle checks for the bridge's Agent factory.
 *
 * These model the harness rather than load it: the session store, the two
 * registries, the persistence handle and the scope primitive are all
 * stand-ins, built from the contracts the reference implementation
 * (`@deepseek-ai/dsh-agent-loop`) and the harness services state. Behaviour
 * against a live harness is covered by `docs/requirements/p0-skeleton/P0人工检查.md`.
 *
 * The scope primitive is a stand-in on purpose. The real module cannot be
 * imported from this repository — it is not a dependency — which is exactly
 * why the host entry resolves it lazily and exposes `setScopePrimitive`; these
 * checks exercise the seam the harness does not use, so that the parts that
 * *are* independent of the harness (which context reaches `setup`, what the
 * log owes before publication, what unwinds when setup throws) can be pinned
 * offline.
 */
import { getEventListeners } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";

const host = await import("../../src/host/index.js");

/** A scope primitive that records what it minted. */
function fakeScopePrimitive() {
  const minted = [];
  return {
    minted,
    createScope(ctx, key) {
      // A scoped context inherits the plugin's dependency API, so the agent
      // reaches every service through it exactly as before — and is a distinct
      // object from the plugin's, which is the identity `setup` receives.
      //
      // `sessions` is the exception: the real store keys a session's event
      // routing off the scope of the context that called `enter`, so a scoped
      // context reaches a *different* `sessions` than the plugin's. The
      // stand-in gives it its own recorder rather than letting it inherit the
      // plugin's object, because without that a publication routed through the
      // plugin's ctx is indistinguishable from one routed through the agent's —
      // which is the whole of the defect the recorder exists to catch.
      const record = { key, scopedEnters: [], scopedAnnounces: [], disposed: 0, rawDisposed: 0 };
      const scoped = Object.create(ctx, {
        __scoped: { value: key },
        sessions: {
          value: {
            prepare: (...args) => ctx.sessions.prepare(...args),
            enter: (session) => {
              record.scopedEnters.push(session);
              return ctx.sessions.enter(session);
            },
            announce: (session) => {
              record.scopedAnnounces.push(session);
              return ctx.sessions.announce(session);
            },
          },
        },
      });
      const rawDispose = () => {
        record.rawDisposed += 1;
      };
      record.ctx = scoped;
      record.rawDispose = rawDispose;
      minted.push(record);
      return {
        ctx: scoped,
        rawDispose,
        dispose: () => {
          record.disposed += 1;
        },
      };
    },
  };
}

/** A session stand-in with the two reads the factory performs. */
function fakeSession(id, seed = []) {
  const events = [...seed];
  return {
    events,
    id,
    header: { version: 4, id, isSeeded: false },
    inheritedEventCount: 0,
    snapshotEvents(from = 0) {
      return events.slice(from);
    },
    append(type, data) {
      const event = { seq: events.length, type, data };
      events.push(event);
      return event;
    },
  };
}

/** A persistence handle stand-in: what was appended, and whether it closed. */
function fakeHandle(session, storedEvents = [], order = []) {
  return {
    appended: [],
    closed: 0,
    /** What each `read` was handed. */
    readOptions: [],
    header: session.header,
    inheritedEventCount: 0,
    async append(events) {
      this.appended.push(...events);
      order.push("handle.append");
    },
    async read(_from, _to, options) {
      this.readOptions.push(options);
      return { events: storedEvents, eventState: "shared-frozen" };
    },
    async close() {
      this.closed += 1;
    },
  };
}

/**
 * An effect host: records registrations and hands back Cordis-style disposers.
 *
 * A real Cordis effect disposer both removes the registration and runs the
 * teardowns it collected, so the stand-in does too — that is what lets a check
 * observe an effect count returning to zero after a dispose, or a plugin-unload
 * sweep. Effects registered on the same host share one list.
 *
 * Cordis collects two shapes, and both are teardowns: a callback that *returns*
 * a function (the returned one is the teardown) and a generator whose yields
 * are. A host that ran only the second would let a registration whose teardown
 * is a returned function look inert, which is exactly the difference a check
 * about "does unloading the owner still cancel this?" turns on.
 */
function effectHost() {
  const effects = [];
  const effect = (run, label) => {
    const produced = run();
    const entry = { label };
    if (produced !== null && typeof produced === "object" && Symbol.iterator in produced) {
      const yields = [];
      for (let step = produced.next(); !step.done; step = produced.next()) yields.push(step.value);
      entry.yields = yields;
    } else {
      entry.result = produced;
    }
    effects.push(entry);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const at = effects.indexOf(entry);
      if (at !== -1) effects.splice(at, 1);
      for (const yielded of entry.yields ?? []) {
        if (typeof yielded === "function") yielded();
      }
      if (typeof entry.result === "function") entry.result();
    };
  };
  return { effects, effect };
}

/** A caller context whose effect host is distinct from the plugin's. */
function ownerContext() {
  const host = effectHost();
  return { ctx: { effect: host.effect }, effects: host.effects };
}

/**
 * An owner context whose unload the check can trigger.
 *
 * The registrations live on the owner, so unloading it means running every
 * teardown it holds — which is what the harness does when the caller's own
 * lifetime ends.
 */
function liveOwner() {
  const host = effectHost();
  const disposers = [];
  return {
    ctx: {
      effect(run, label) {
        const dispose = host.effect(run, label);
        disposers.push(dispose);
        return dispose;
      },
    },
    effects: host.effects,
    async dispose() {
      for (const dispose of disposers.splice(0)) await dispose();
    },
  };
}

/** A deferred: the promise, and the two ways to settle it. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A harness stand-in: the two registries, the handle, and the effect host. */
function fakeHarness({ session, handle, persistence = true, order = [] } = {}) {
  const host = effectHost();
  const record = {
    effects: host.effects,
    order,
    enteredSessions: [],
    enteredAgents: [],
    announcedSessions: [],
    announcedAgents: [],
    /** How many times `create` was entered, and what each call was handed. */
    createCalls: 0,
    createOptions: [],
    /** What each `open` was handed. */
    openOptions: [],
    factory: undefined,
  };
  const ctx = {
    logger: { warn() {} },
    emit() {},
    get(name) {
      if (name !== "sessionPersistence") return undefined;
      if (!persistence) return undefined;
      return {
        async create(_header, options) {
          record.createCalls += 1;
          record.createOptions.push(options);
          return handle;
        },
        async open(_id, _mode, options) {
          record.openOptions.push(options);
          return handle;
        },
      };
    },
    effect: host.effect,
    sessions: {
      prepare(id) {
        return session ?? fakeSession(id);
      },
      enter(entered) {
        record.enteredSessions.push(entered);
        order.push("session.enter");
        return () => record.enteredSessions.pop();
      },
      announce(announced) {
        record.announcedSessions.push(announced);
      },
    },
    agents: {
      setFactory(factory) {
        record.factory = factory;
      },
      enter(agent, parent) {
        record.enteredAgents.push({ agent, parent });
        order.push("agent.enter");
        return () => record.enteredAgents.pop();
      },
      async announce(agent, source) {
        record.announcedAgents.push({ agent, source });
      },
    },
  };
  return { ctx, record };
}

/** Apply the plugin and hand back the factory the harness would call. */
function activate(harness, primitive, config = {}) {
  host.setScopePrimitive(primitive);
  host.applySessionAdapter(harness.ctx, config);
  return harness.record.factory;
}

let primitive;
beforeEach(() => {
  primitive = fakeScopePrimitive();
});

describe("factory context", () => {
  it("hands setup the agent's scoped context, not the plugin's", async () => {
    // The harness binds the session's preset through this argument and refuses
    // an unscoped context, so the identity here is the whole fix: an agent that
    // receives the plugin context cannot be published at all.
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);

    let seen;
    const { agent } = await factory.createAgent(harness.ctx, {
      sessionId: "s-1",
      setup: (agentCtx, created) => {
        seen = { agentCtx, created };
      },
    });

    expect(primitive.minted).toHaveLength(1);
    expect(seen.agentCtx).toBe(primitive.minted[0].ctx);
    expect(seen.agentCtx).not.toBe(harness.ctx);
    expect(seen.created).toBe(agent);
    expect(agent.ctx).toBe(primitive.minted[0].ctx);
  });

  it("mints one scope per agent", async () => {
    const harness = fakeHarness({ handle: fakeHandle(fakeSession("s-1")) });
    const factory = activate(harness, primitive);

    await factory.createAgent(harness.ctx, { sessionId: "s-1" });
    await factory.createAgent(harness.ctx, { sessionId: "s-2" });

    expect(primitive.minted).toHaveLength(2);
    expect(primitive.minted[0].key).not.toBe(primitive.minted[1].key);
  });
});

describe("publication", () => {
  it("stores the seed through the handle before entering the registries", async () => {
    // A fork's seed never re-emits through `session/event`, so nothing else
    // would ever write it — and the handle refuses the first live append whose
    // seq does not continue from its cursor. Order matters as much as the
    // write: entering first would install the live append hooks while the seed
    // is still unstored, so the first live event would be refused.
    const seed = [{ seq: 0, type: "turn/start", data: { turn: 1 } }];
    const session = fakeSession("s-1", seed);
    const order = [];
    const handle = fakeHandle(session, [], order);
    const harness = fakeHarness({ session, handle, order });
    const factory = activate(harness, primitive);

    await factory.createAgent(harness.ctx, { sessionId: "s-1", seed });

    expect(handle.appended).toEqual(seed);
    expect(harness.record.enteredSessions).toHaveLength(1);
    expect(order.indexOf("handle.append")).toBeLessThan(order.indexOf("session.enter"));
    expect(order.indexOf("handle.append")).toBeLessThan(order.indexOf("agent.enter"));
  });

  it("enters and announces the session through the agent's scoped context", async () => {
    // The store keys a session's event routing off the scope of the context
    // that called `enter`, so a session entered through the plugin's unscoped
    // ctx never reaches a `session/event` listener that `setup` registered on
    // `agent.ctx`. The agent registry is the other way round — it keys off the
    // agent itself — so it stays on the plugin's context.
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session });
    const factory = activate(harness, primitive);

    await factory.createAgent(harness.ctx, { sessionId: "s-1" });

    const [scope] = primitive.minted;
    expect(scope.scopedEnters).toEqual([session]);
    expect(scope.scopedAnnounces).toEqual([session]);
    expect(harness.record.enteredAgents).toHaveLength(1);
  });

  it("flushes only what the log does not already hold on resume", async () => {
    const stored = [{ seq: 0, type: "turn/start", data: { turn: 1 } }];
    const session = fakeSession("s-1", stored);
    const handle = fakeHandle(session, stored);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);

    await factory.resume(harness.ctx, { resumeSessionId: "s-1" });

    // Everything read back is already stored; the constructor adds nothing, so
    // the flush is a no-op rather than a re-write of the whole history.
    expect(handle.appended).toEqual([]);
  });

  it("flushes what setup appended, which never re-emits either", async () => {
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);

    await factory.createAgent(harness.ctx, {
      sessionId: "s-1",
      setup: (_agentCtx, agent) => {
        agent.session.append("model/selection", { model: "echo" });
      },
    });

    expect(handle.appended.map((event) => event.type)).toEqual(["model/selection"]);
  });
});

describe("turn numbering", () => {
  it("continues the history's numbering instead of restarting at 1", async () => {
    const seed = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      { seq: 1, type: "turn/end", data: { turn: 1 } },
      { seq: 2, type: "turn/start", data: { turn: 2 } },
    ];
    const session = fakeSession("s-1", seed);
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);

    const { agent } = await factory.createAgent(harness.ctx, { sessionId: "s-1", seed });

    expect(agent._turnCounter).toBe(2);
  });

  it("starts at 0 for a session with no history", async () => {
    const harness = fakeHarness({ handle: fakeHandle(fakeSession("s-1")) });
    const factory = activate(harness, primitive);

    const { agent } = await factory.createAgent(harness.ctx, { sessionId: "s-1" });

    expect(agent._turnCounter).toBe(0);
  });

  it("emits a contiguous turn number on the first turn after a resume", async () => {
    // Inspecting the private counter only proves the seed was read; the real
    // contract is the number the resumed agent writes. A regression that reset
    // the counter after publication would still leave `_turnCounter` correct
    // until the first turn, so drive one and read the event it emits.
    const stored = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      { seq: 1, type: "turn/end", data: { turn: 1 } },
      { seq: 2, type: "turn/start", data: { turn: 2 } },
      { seq: 3, type: "turn/end", data: { turn: 2 } },
    ];
    const session = fakeSession("s-1", stored);
    const handle = fakeHandle(session, stored);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive, { chunkDelayMs: 0 });

    const { agent } = await factory.resume(harness.ctx, { resumeSessionId: "s-1" });
    agent.followup({ id: "m-1", content: [{ type: "text", text: "hello" }] });
    await agent.whenIdle();

    const turns = session.events.filter((event) => event.type === "turn/start").map((event) => event.data.turn);
    expect(turns.at(-1)).toBe(3);
  });
});

describe("rollback", () => {
  it("closes the handle and disposes the scope when setup throws", async () => {
    // Without this the id stays reserved in the backend's tracker and a retry
    // fails with "session already exists" for a session nobody ever got.
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);

    await expect(
      factory.createAgent(harness.ctx, {
        sessionId: "s-1",
        setup: () => {
          throw new Error("Agent preset binding requires a scoped context");
        },
      }),
    ).rejects.toThrow("Agent preset binding requires a scoped context");

    expect(handle.closed).toBe(1);
    expect(primitive.minted[0].disposed).toBe(1);
    expect(harness.record.enteredSessions).toEqual([]);
    expect(harness.record.announcedAgents).toEqual([]);
  });

  it("closes the handle when the agent registry refuses the announcement", async () => {
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    harness.ctx.agents.announce = async () => {
      throw new Error("already registered");
    };
    const factory = activate(harness, primitive);

    await expect(factory.createAgent(harness.ctx, { sessionId: "s-1" })).rejects.toThrow(
      "already registered",
    );

    expect(handle.closed).toBe(1);
    expect(primitive.minted[0].disposed).toBe(1);
  });

  it("opens nothing when the owner's cancellation effect cannot be registered", async () => {
    // The owner is associated with the transaction before its first step, so a
    // context that cannot hold an effect is refused before anything is opened:
    // no persistence handle, no session id reserved. A disposed owner context
    // is the realistic trigger — registering an effect on it throws
    // "cannot create effect on inactive context".
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);
    const deadOwner = {
      effect() {
        throw new Error("cannot create effect on inactive context");
      },
    };

    await expect(factory.createAgent(deadOwner, { sessionId: "s-1" })).rejects.toThrow(
      "cannot create effect on inactive context",
    );

    // Nothing was opened, so there is nothing to close.
    expect(handle.closed).toBe(0);
    expect(harness.record.enteredSessions).toEqual([]);
    expect(harness.record.enteredAgents).toEqual([]);
  });

  it("closes the handle when the owner's lifecycle effect cannot be registered", async () => {
    // The publication registers the owner effect that owns the agent — and the
    // scope, and the handle — once those exist, and it is where the owner's
    // lifetime takes over from the cancellation registration made at
    // construction. Throwing there must still unwind: the handle closes, the
    // scope goes, and the earlier registration is taken back off the owner
    // rather than left behind.
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);
    const host = effectHost();
    const owner = {
      ctx: {
        effect(run, label) {
          if (typeof label === "string" && label.startsWith("dsh-bridge.lifecycle(")) {
            throw new Error("cannot create effect on inactive context");
          }
          return host.effect(run, label);
        },
      },
      effects: host.effects,
    };

    await expect(factory.createAgent(owner.ctx, { sessionId: "s-1" })).rejects.toThrow(
      "cannot create effect on inactive context",
    );

    expect(handle.closed).toBe(1);
    expect(primitive.minted[0].disposed).toBe(1);
    expect(harness.record.enteredSessions).toEqual([]);
    expect(harness.record.enteredAgents).toEqual([]);
    // The cancellation registration was retired, not left on the owner.
    expect(owner.effects).toEqual([]);
  });
});

describe("plugin unload", () => {
  it("sweeps agents whose owner context outlives the plugin", async () => {
    // The lifecycle effect is scoped to the owner, so it does not fire when the
    // *plugin* unloads. Without a sweep, unloading the plugin clears the
    // factory slot but leaves every already-created agent entered, with its
    // session and handle open, for the life of the process.
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);
    const owner = ownerContext();

    await factory.createAgent(owner.ctx, { sessionId: "s-1" });
    await factory.createAgent(owner.ctx, { sessionId: "s-2" });
    expect(harness.record.enteredAgents).toHaveLength(2);

    // Unloading the plugin runs the sweep effect's teardown; the owner context
    // is still alive, so only the plugin's own sweep can reach these agents.
    const sweep = harness.record.effects.find((effect) => effect.label === "dsh-bridge.sweepAgents()");
    expect(sweep, "the plugin registered no sweep effect").toBeDefined();
    await sweep.result();

    expect(handle.closed).toBe(2);
    expect(primitive.minted.every((minted) => minted.disposed === 1)).toBe(true);
    expect(harness.record.enteredAgents).toEqual([]);
  });
});

describe("owner lifetime", () => {
  it("registers a teardown that yields the scope's own disposer", async () => {
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);

    await factory.createAgent(harness.ctx, { sessionId: "s-1" });

    const lifecycle = harness.record.effects.find((effect) => effect.label?.startsWith("dsh-bridge.lifecycle("));
    expect(lifecycle, "the factory registered no lifecycle effect").toBeDefined();
    // The scope's raw disposer is yielded by identity: the effect owns a
    // teardown order, and a wrapper would dispose as a concurrent sibling.
    expect(lifecycle.yields[0]).toBe(primitive.minted[0].rawDispose);
    expect(typeof lifecycle.yields[1]).toBe("function");
  });

  it("disposes the agent and closes the handle when the owner goes away", async () => {
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);

    await factory.createAgent(harness.ctx, { sessionId: "s-1" });
    const lifecycle = harness.record.effects.find((effect) => effect.label?.startsWith("dsh-bridge.lifecycle("));

    await lifecycle.yields[1]();

    expect(handle.closed).toBe(1);
    expect(primitive.minted[0].disposed).toBe(1);
    expect(harness.record.enteredAgents).toEqual([]);
  });

  it("disposes once when both the owner and the caller dispose", async () => {
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);

    const created = await factory.createAgent(harness.ctx, { sessionId: "s-1" });
    const lifecycle = harness.record.effects.find((effect) => effect.label?.startsWith("dsh-bridge.lifecycle("));

    await Promise.all([created.dispose(), lifecycle.yields[1]()]);

    expect(handle.closed).toBe(1);
    expect(primitive.minted[0].disposed).toBe(1);
  });

  it("rejects and publishes nothing when the owner unloads during setup", async () => {
    // The effect is registered before `setup` is awaited, so an owner that
    // unloads mid-setup tears the agent down while `setup` is still pending.
    // Without a liveness check the resumed `setup` would then enter the dead
    // Agent into both registries — the review re-entered it into the registry.
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);
    const owner = ownerContext();

    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let setupStarted;
    const started = new Promise((resolve) => {
      setupStarted = resolve;
    });
    const created = factory.createAgent(owner.ctx, {
      sessionId: "s-1",
      setup: () => {
        setupStarted();
        return pending;
      },
    });
    created.catch(() => {});

    await started;
    const lifecycle = owner.effects.find((effect) => effect.label?.startsWith("dsh-bridge.lifecycle("));
    expect(lifecycle, "the lifecycle effect was not registered before setup").toBeDefined();

    await lifecycle.yields[1]();
    release();

    await expect(created).rejects.toThrow(/owner disposed during setup/);
    expect(harness.record.enteredSessions).toEqual([]);
    expect(harness.record.enteredAgents).toEqual([]);
    expect(harness.record.announcedAgents).toEqual([]);
    expect(handle.closed).toBe(1);
  });

  it("retires its owner effect on every dispose, so cycles do not accumulate", async () => {
    // Each `create` registers an effect that holds the session history. A
    // discarded disposer leaves one live effect per create/dispose cycle.
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const owner = ownerContext();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const created = await factory.createAgent(owner.ctx, { sessionId: `s-${cycle}` });
      await created.dispose();
    }

    expect(owner.effects).toEqual([]);
  });

  it("cancels the factory when the owner unloads before the agent exists", async () => {
    // The owner is associated with the transaction at construction, not when
    // the agent is built: the window before the agent is the longest one there
    // is, and an owner that unloads inside it has to stop the factory rather
    // than leave it to finish into a context that is gone.
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);
    const owner = liveOwner();
    const started = deferred();
    // The persistence stand-in is replaced by one that holds `create` open, so
    // the owner unload lands while the very first step is still running.
    harness.ctx.get = (name) =>
      name === "sessionPersistence"
        ? {
            async create() {
              started.resolve();
              return new Promise(() => {});
            },
            async open() {
              return handle;
            },
          }
        : undefined;

    const created = factory.createAgent(owner.ctx, { sessionId: "s-1" });
    created.catch(() => {});
    await started.promise;

    await owner.dispose();

    await expect(created).rejects.toThrow(/owner disposed during initialization/);
    expect(harness.record.enteredSessions).toEqual([]);
    expect(harness.record.enteredAgents).toEqual([]);
    expect(primitive.minted).toEqual([]);
  });

  it("hands every persistence step the transaction's signal, not only the caller's", async () => {
    // A backend that honours a signal has to hear every reason this
    // initialization can end. The caller's own is one of three — the owner
    // unloading and the plugin unloading are the other two — so what reaches
    // the backend is the fused signal, not the caller's.
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);
    const controller = new AbortController();

    const created = await factory.createAgent(harness.ctx, {
      sessionId: "s-1",
      signal: controller.signal,
    });

    expect(harness.record.createOptions[0].signal).toBeInstanceOf(AbortSignal);
    expect(harness.record.createOptions[0].signal).not.toBe(controller.signal);
    expect(harness.record.createOptions[0].signal.aborted).toBe(false);
    await created.dispose();
  });

  it("hands a resume's open and read the transaction's signal too", async () => {
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);
    const controller = new AbortController();

    const created = await factory.resume(harness.ctx, {
      resumeSessionId: "s-1",
      signal: controller.signal,
    });

    expect(harness.record.openOptions[0].signal).toBeInstanceOf(AbortSignal);
    expect(harness.record.openOptions[0].signal).not.toBe(controller.signal);
    expect(handle.readOptions[0].signal).toBe(harness.record.openOptions[0].signal);
    await created.dispose();
  });
});

describe("caller signal", () => {
  it("takes the caller's abort listener off once the agent is delivered", async () => {
    // The host's contract for the caller's signal is *creation only*. Leaving
    // the listener attached would both keep a closure on a signal the caller
    // may hold for a long time and let an abort meant for an initialization
    // that is already over reach the live agent.
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const controller = new AbortController();

    const created = await factory.createAgent(harness.ctx, {
      sessionId: "s-1",
      signal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    // And an abort after delivery is not an abort for this creation.
    controller.abort(new Error("too late"));
    expect(harness.record.enteredAgents).toHaveLength(1);
    await created.dispose();
  });

  it("takes the caller's abort listener off when creation fails", async () => {
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const controller = new AbortController();

    await expect(
      factory.createAgent(harness.ctx, {
        sessionId: "s-1",
        signal: controller.signal,
        setup: () => {
          throw new Error("setup refused");
        },
      }),
    ).rejects.toThrow(/setup refused/);

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("takes the caller's abort listener off when the agent is disposed", async () => {
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const controller = new AbortController();

    const created = await factory.createAgent(harness.ctx, {
      sessionId: "s-1",
      signal: controller.signal,
    });
    // Attached again by hand, so the check is about the dispose path and not
    // about the success path having run first.
    const stray = () => {};
    controller.signal.addEventListener("abort", stray);
    await created.dispose();

    expect(getEventListeners(controller.signal, "abort")).toEqual([stray]);
  });

  it("does not start a step's work once the transaction is over", async () => {
    // The race abandons a step's *result*, but only after the step has run —
    // and running it is the side effect. A caller that has already aborted must
    // not get a persistence handle opened for it.
    const session = fakeSession("s-1");
    const handle = fakeHandle(session);
    const harness = fakeHarness({ session, handle });
    const factory = activate(harness, primitive);
    const controller = new AbortController();
    controller.abort(new Error("already gone"));

    await expect(
      factory.createAgent(harness.ctx, { sessionId: "s-1", signal: controller.signal }),
    ).rejects.toThrow(/already gone/);

    expect(harness.record.createCalls).toBe(0);
    expect(handle.closed).toBe(0);
  });

  it("does not start a step's work once the transaction is over", async () => {
    // The race abandons a step's *result*, but only after the step has run, and
    // running it is the side effect: a `setup` that opens something would have
    // opened it for an initialization that is already cancelled. The window is
    // real — the owner's own registration happens with no liveness check
    // between it and the `setup` step — so the refusal has to be in the step.
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const controller = new AbortController();
    let setups = 0;
    const owner = liveOwner();
    const register = owner.ctx.effect.bind(owner.ctx);
    owner.ctx.effect = (run, label) => {
      // The owner's lifetime ends in the same turn the agent is handed over to
      // it, which is the one moment between the handover and the `setup` step.
      if (typeof label === "string" && label.startsWith("dsh-bridge.lifecycle(")) {
        controller.abort(new Error("owner went away at handover"));
      }
      return register(run, label);
    };

    const created = factory.createAgent(owner.ctx, {
      sessionId: "s-1",
      signal: controller.signal,
      setup: () => {
        setups += 1;
      },
    });
    created.catch(() => {});

    await expect(created).rejects.toThrow(/owner went away at handover/);
    expect(setups).toBe(0);
    expect(harness.record.enteredSessions).toEqual([]);
    expect(harness.record.enteredAgents).toEqual([]);
  });

  it("does not commit a setup result the caller aborted in the microtask before it landed", async () => {
    // `await` hands the turn back to the queue, and an abort that arrives there
    // is decided before the continuation runs: the step's race is already won
    // by the time the commit object is in hand, so the check has to be made
    // again before it is applied.
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const controller = new AbortController();
    let committed = 0;

    const created = factory.createAgent(harness.ctx, {
      sessionId: "s-1",
      signal: controller.signal,
      setup: () => {
        // Queued, so it runs before the `await` continuation that applies it.
        queueMicrotask(() => controller.abort(new Error("caller changed its mind")));
        return {
          commit() {
            committed += 1;
          },
        };
      },
    });
    created.catch(() => {});

    await expect(created).rejects.toThrow(/caller changed its mind/);
    expect(committed).toBe(0);
    expect(harness.record.enteredSessions).toEqual([]);
    expect(harness.record.enteredAgents).toEqual([]);
  });
});

describe("disposed agent", () => {
  it("refuses input instead of queueing it silently", async () => {
    // The four input methods are declared `void` in the host's Agent contract,
    // so a synchronous throw is the contract's own error channel. What they
    // must not do is take the message, grow the queue, and let the driver
    // return without opening a turn: the caller is told nothing and the message
    // is gone for good.
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const created = await factory.createAgent(harness.ctx, { sessionId: "s-1" });
    await created.dispose();
    const { agent } = created;
    const message = { id: "m-1", role: "user", content: [] };

    expect(() => agent.followup(message)).toThrow(/disposed/);
    expect(() => agent.steer(message)).toThrow(/disposed/);
    expect(() => agent.send(message, "next-turn", true)).toThrow(/disposed/);
    expect(() => agent.inject(message)).toThrow(/disposed/);

    // Nothing was queued behind the refusals, and no turn was opened for them.
    expect(agent.inbox.nextTurn).toEqual([]);
    expect(agent.inbox.nextStep).toEqual([]);
    expect(agent.status).toBe("idle");
  });

  it("refuses the inbox's own doors into the same queue", async () => {
    // The inbox is the other way into the queue and a public part of the Agent
    // surface, so the same rule has to hold there or the refusal above can be
    // walked around.
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const created = await factory.createAgent(harness.ctx, { sessionId: "s-1" });
    await created.dispose();
    const { agent } = created;
    const message = { id: "m-1", role: "user", content: [] };

    expect(() => agent.inbox.append("next-turn", message)).toThrow(/disposed/);
    expect(() => agent.inbox.prepend("next-step", message)).toThrow(/disposed/);
    expect(() => agent.inbox.splice("next-turn", 0, 0, [message])).toThrow(/disposed/);
    expect(agent.inbox.nextTurn).toEqual([]);
    expect(agent.inbox.nextStep).toEqual([]);

    // Taking work away is still allowed — disposal itself clears through here.
    expect(() => agent.inbox.clear()).not.toThrow();
    expect(() => agent.inbox.remove("m-1")).not.toThrow();
    expect(() => agent.inbox.splice("next-turn", 0, 0, [])).not.toThrow();
  });

  it("still accepts input while the agent is live", async () => {
    const session = fakeSession("s-1");
    const harness = fakeHarness({ session, handle: fakeHandle(session) });
    const factory = activate(harness, primitive);
    const created = await factory.createAgent(harness.ctx, { sessionId: "s-1" });
    const message = { id: "m-1", role: "user", content: [] };

    expect(() => created.agent.inject(message)).not.toThrow();
    expect(created.agent.inbox.nextStep).toEqual([message]);

    await created.dispose();
  });
});
