/**
 * Host half of the dsh bridge bundle.
 *
 * The default plugin serves an independent Super Agent space. The explicit
 * applySessionAdapter export retains the previous adapter for compatibility tests.
 * It is never registered by the bundle. The historical adapter
 * whose `apply` registers the single `AgentFactory` dsh calls for every
 * session. The Agent it publishes owns a real Session log and drives real
 * turn/step boundaries, and each of its turns is a *Core Run*: the session's
 * Thread is created in the Agent Core on first use, the user's text is
 * submitted to it, and the transcript is filled from the Core's own record of
 * the conversation. Nothing here answers a prompt — the model does, in the
 * Core, and this half's job is to be a faithful window onto it.
 *
 * That is also why the browser half has no path to the Core of its own. The
 * Core speaks a Unix socket, which a page cannot open, so the state the panel
 * draws and the commands its buttons raise both travel through this file's
 * routes; see `core-service.js`. The panel reads; this half acts.
 *
 * Plain JavaScript on purpose — the host half is loaded by dsh, not compiled
 * here, and it must not pull the repository's TypeScript build into the profile.
 * Capabilities are reached through the plugin context (`ctx.sessions`,
 * `ctx.agents`, `ctx.sessionPersistence`, `ctx.webServer`) rather than by
 * importing the harness's own packages, which keeps the bundle independent of
 * where the installation resolves those from.
 *
 * `@deepseek-ai/dsh-scope` is the one exception, and it is not a preference. An
 * Agent's context has to be *scoped*: `dsh-agent-preset-registry` binds the
 * session's preset through whatever context the factory hands to `setup`, and
 * refuses an unscoped one. The symbol that tags a scope is module-private, so
 * no amount of context inspection can mint one — the module has to be imported,
 * and it has to be the *harness's* copy: a second copy would carry a second
 * symbol, and the harness's `scopeOf` would not recognise the tag.
 *
 * The manifest declares it as an optional peer dependency, which is what makes
 * the harness route the import to its own copy. That routing reads each
 * ancestor directory's `peerDependencies` and intercepts a match; `optional`
 * keeps npm from trying to install it here, since the host provides it. A
 * bundle that simply imported the package would get Node's plain resolution,
 * which cannot see the installation, and would fail to load.
 *
 * The import is deferred to first use and behind `setScopePrimitive` because
 * the package is genuinely absent from this repository, and the offline suite
 * has to stay able to load this file.
 */
import { createCoreServiceFor, registerCoreRoutes, resolveCoreOptions } from "./core-service.js";
import { registerObservationRoutes } from "./observation-service.js";
import {
  messageIdentityKeys,
  runIdOf,
  sessionEventForMessage,
  submittedInputSource,
  turnErrorReason,
  turnOutcomeFor,
  unseenMessages,
} from "./event-mapping.js";
import { defaultInputReceiptsPath, openInputReceipts } from "./input-receipts.js";
import { defaultSessionMapPath, openSessionMap } from "./session-map.js";
import { MessagePositions } from "./message-positions.js";
import { openTargetService } from "./target-store.js";

/** Services that must exist before the factory can be registered. */
export const inject = [];

/**
 * The scope primitive, resolved on first use.
 *
 * The harness resolves the specifier to its own copy (see the header), but the
 * package is not installed here, so a top-level import would make this file
 * unloadable by the offline suite. Deferring it keeps `npm test` able to import
 * the plugin while the harness still gets the real module.
 */
let scopePrimitive;

/**
 * Replace the scope primitive. This is the offline suite's seam; the harness
 * never calls it.
 * @param primitive - a module exposing `createScope`.
 */
export function setScopePrimitive(primitive) {
  scopePrimitive = primitive;
}

async function loadScopePrimitive() {
  scopePrimitive ??= await import("@deepseek-ai/dsh-scope");
  return scopePrimitive;
}

/**
 * The two things a session needs from outside itself: the Core link, and the
 * durable record of which Thread a Session runs on.
 *
 * Both are *providers* — functions returning a promise — rather than values,
 * and both are built on first use rather than at plugin load. Building the Core
 * link imports the SDK, and the SDK resolves against the profile at runtime;
 * reading the mapping touches the filesystem. Neither should happen for a
 * plugin whose sessions never run a turn, and neither should be able to stop
 * the plugin from loading.
 */
let coreSeams = null;

/**
 * Replace the Core link, the session map and the input records. This is the
 * offline suite's seam; the harness never calls it.
 * @param seams - `{ core?, sessionMap?, inputReceipts? }`, each a provider.
 */
export function setCoreSeams(seams = {}) {
  coreSeams = {
    core: seams.core ?? null,
    sessionMap: seams.sessionMap ?? null,
    inputReceipts: seams.inputReceipts ?? null,
  };
}

/** Build a value once, however many callers ask for it. */
function once(load) {
  let value;
  return () => (value ??= load());
}

/**
 * Build a value once, giving a failed build another chance.
 *
 * `once` remembers whatever the build returned — a rejected promise included —
 * so a store that could not be opened once could never be opened again in this
 * process, however long ago the file it choked on was fixed. This remembers a
 * *successful* build only, and shares one attempt among callers that arrive
 * while it is in flight, so a value that must exist once still does.
 * @param load - the build.
 * @returns a provider of the built value.
 */
function onceSucceeding(load) {
  let pending;
  return async () => {
    if (pending === undefined) {
      pending = load().then(
        (value) => value,
        (error) => {
          // Forgotten, not cached: the next caller tries again.
          pending = undefined;
          throw error;
        },
      );
    }
    return await pending;
  };
}

/**
 * The highest turn number a history already used.
 *
 * A resumed or forked session's log already contains turns, and turn numbers
 * are the identity the UI groups a step under, so a counter that restarts at 1
 * renumbers work the user can still see. Read from the events rather than from
 * a projection: this probe writes `turn/start` itself, so its own vocabulary is
 * the authority, and it needs no projection registration to be correct.
 * @param events - the session's seed events, in log order.
 * @returns the last turn number used, or 0 for an empty history.
 */
function lastTurnIn(events) {
  let last = 0;
  for (const event of events) {
    const turn = event?.type === "turn/start" ? event.data?.turn : undefined;
    if (Number.isSafeInteger(turn) && turn > last) last = turn;
  }
  return last;
}

/**
 * Say what a refused creation means, when the reason is this bridge's own configuration.
 *
 * The Core requires a model on every Thread and refuses a creation that names none — a Core
 * that filled in a default would be choosing the user's model for them, which is the one
 * thing the configuration is there to decide. That refusal is correct, but its message names
 * the Core's own field ("modelId is required to create a Thread"), and that tells a user
 * nothing about *where* the value was supposed to come from: nothing in the Core's answer
 * mentions the profile row that left it out. When this bridge is the one that omitted the
 * field, the actionable statement is about this bridge's configuration, so the refusal is
 * re-stated in those terms — the same failure, said in the place the fix belongs.
 *
 * Only that one refusal is rewritten. The condition names the field the Core complained
 * about as well as the configuration this bridge is missing, so a creation refused for
 * anything else — a Workspace outside its root, an unknown agent — is reported exactly as
 * the Core stated it, and a Core whose wording this build cannot read leaves the original
 * error in place, which is no worse than not translating at all.
 * @param error - what the Core refused with.
 * @param settings - the bridge's settings: the agent and model a new Thread is created with.
 * @returns the error to throw in its place.
 */
function explainCreateRefusal(error, settings) {
  const namesModel = String(error?.message ?? "").includes("modelId");
  if (settings.modelId === null && error?.code === "INVALID_REQUEST" && namesModel) {
    return new Error(
      "no Thread can be created: this profile's @super-agent/dsh-bridge row declares no modelId, so the Core " +
        `refused the creation (${String(error?.message)}). Add a "modelId" to that row's config in the dsh profile.`,
      { cause: error },
    );
  }
  return error;
}

/** Independent space only. Never replace the Harness AgentFactory or native sessions. */
export function apply(ctx) {
  const service = onceSucceeding(() => openTargetService({ options: resolveCoreOptions() }));
  ctx.inject?.(["webServer"], (host) => {
    registerCoreRoutes({ webServer: host.webServer, effect: host.effect, service, log: ctx.logger });
    registerObservationRoutes({ webServer: host.webServer, effect: host.effect,
      service: async () => (await service()).observations, log: ctx.logger });
  });
}

/**
 * Register the Agent factory, and the routes the browser half calls it through.
 * @param ctx - the plugin's Cordis context.
 * @param config - the bundle row's config: the agent and model a new Thread is
 *   created with. Both are recorded on the Thread, so a session that names
 *   neither gets the Core's own default rather than this file's guess.
 */
export function applySessionAdapter(ctx, config) {
  const agentId = typeof config?.agentId === "string" && config.agentId !== "" ? config.agentId : "super-agent";
  const modelId = typeof config?.modelId === "string" && config.modelId !== "" ? config.modelId : null;
  const settings = { agentId, modelId };
  // Every transaction this plugin has started and not yet finished, keyed by
  // the transaction's own `dispose`.
  //
  // It is a set of transactions rather than of published agents on purpose. The
  // lifecycle effect that owns an agent is registered on the *owner's* context,
  // so it fires when the owner unloads, not when this plugin does — an agent
  // whose caller outlives the plugin would otherwise stay entered, with its
  // session and handle open, for the life of the process. But an agent is the
  // *end* of the work: before it exists there is a `persistence.create`/`open`
  // that has not returned, a caller's `setup` still running, a registry
  // `announce` still dispatching. A set that only starts holding the
  // transaction once it publishes leaves that whole window owned by nobody,
  // and a plugin unload that misses it lets the initialization finish into a
  // plugin that is gone.
  const inflight = new Set();
  const factory = {
    createAgent: (ownerCtx, options) => createAgent(ctx, settings, seams, ownerCtx, options, inflight),
    resume: (ownerCtx, options) => resumeAgent(ctx, settings, seams, ownerCtx, options, inflight),
  };
  ctx.effect(() => ctx.agents.setFactory(factory), "dsh-bridge.setFactory()");
  // Disposing the factory slot above only clears it; transactions already
  // started must be cancelled and torn down too, or their registries and
  // persistence handles leak past the plugin that created them.
  ctx.effect(() => () => sweepInflight(inflight), "dsh-bridge.sweepAgents()");
  // The harness suppresses info-level logging, so the P0 smoke check reads this
  // line to confirm the factory took the profile's single factory slot. The
  // wording is left as it was: it is what an existing check looks for, and a
  // log line is not worth breaking a check over.
  console.log("[dsh-bridge] echo Agent factory registered");

  const coreOptions = resolveCoreOptions();
  const seams = {
    // Memoised: one link, however many sessions ask for it, so "the panel says
    // the Run is running" and "the Agent submitted the input" are answers from
    // one connection rather than two.
    core:
      coreSeams?.core ??
      // The panel's service reads and writes the *same* mapping instance the
      // Agent does. Two `openSessionMap` calls over one path would be two
      // in-memory copies of one file, and each whole-file write would drop the
      // entries the other had learned since it opened.
      once(() =>
        createCoreServiceFor({
          options: coreOptions,
          caller: "dsh-bridge",
          sessionMap: () => seams.sessionMap(),
        }),
      ),
    sessionMap: coreSeams?.sessionMap ?? once(() => openSessionMap({ path: defaultSessionMapPath() })),
    // One instance, for the same reason the session map is one: a second
    // `openInputReceipts` over one path would be a second in-memory copy, and
    // each whole-file write would drop what the other had learned. Unlike the
    // session map it is not built with `once`: a record file this build cannot
    // read once — a half-written file, a file being restored — must not stop
    // this process from reading records for the rest of its life, so a failed
    // open is forgotten and the next turn tries the file again. What a failure
    // means for *that* turn is the turn's to decide. See
    // {@link ThreadAgent#_inputReceipts}.
    inputReceipts: onceSucceeding(() =>
      coreSeams?.inputReceipts === null || coreSeams?.inputReceipts === undefined
        ? openInputReceipts({ path: defaultInputReceiptsPath() })
        : coreSeams.inputReceipts(),
    ),
  };

  // The browser half's only door to the Core. Optional injection, because a
  // Harness without a web server (a CLI session) still runs turns — it just has
  // no panel to serve, and a plugin that refused to load without one would take
  // the factory down with it.
  ctx.inject?.(["webServer"], (host) => {
    registerCoreRoutes({
      webServer: host.webServer,
      effect: host.effect,
      service: seams.core,
      log: ctx.logger,
    });
    registerObservationRoutes({
      webServer: host.webServer,
      effect: host.effect,
      service: async () => (await seams.core()).observations,
      log: ctx.logger,
    });
  });
}

/**
 * Dispose every transaction this plugin still has open.
 *
 * Called from the plugin's own teardown. Disposing cancels first, so a step
 * that is still waiting stops waiting rather than finishing into a plugin that
 * is gone; a handle that only arrives afterwards is closed by the transaction
 * that opened it. Each `dispose` is memoised, so a transaction already torn
 * down by its owner (or its caller) is a no-op here, and a failure in one must
 * not strand the rest.
 * @param inflight - the live transactions, as their own memoised `dispose`.
 */
async function sweepInflight(inflight) {
  await Promise.allSettled([...inflight].map((dispose) => dispose()));
}

// ---------------------------------------------------------------------------
// Initialization transactions
// ---------------------------------------------------------------------------

/** The reason a cancellation carries, as an `Error`. */
function abortReason(signal) {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Close a resource that arrived after the transaction that opened it was over.
 *
 * Nothing is waiting for it any more and nothing owns it: the caller stopped
 * waiting for the factory, and the plugin has already swept. Closing it here is
 * the only chance it gets. A failure has nobody left to report to.
 * @param handle - the late resource.
 */
async function closeQuietly(handle) {
  try {
    await handle?.close();
  } catch {
    // Deliberately dropped: see above.
  }
}

/**
 * One agent-creation transaction, from its first step to its last.
 *
 * This is where three separate lifetimes meet. The caller's own `signal`, the
 * owner context's teardown and this plugin's unload all mean the same thing —
 * stop, and leave nothing behind — so all three cancel the same controller.
 *
 * It is also what makes cancellation *work*. Every step of the sequence waits
 * on that controller rather than on the promise the step is made of, because a
 * step that never settles is not a step the transaction can afford to wait
 * for: a caller's `setup` that never resolves, a `persistence.create` that
 * never returns, a registry listener that never lets go. The teardown those
 * steps are blocking is the only thing that can clean up after them, so
 * waiting for them to finish first is waiting forever.
 *
 * What a step produces after the transaction is over is dropped, not acted on:
 * a `setup` that resolves late never gets to commit, and a handle that arrives
 * late is closed here, because the caller has stopped waiting and the plugin
 * has already swept.
 *
 * The owner is associated here, at construction, rather than when the agent
 * exists. The window before the agent is the longest one there is — a
 * `persistence.create` that has not returned, a scope import that has not
 * resolved — and an owner that unloads inside it has to be able to cancel the
 * factory, not watch it finish into a context that is gone.
 * @param options - the caller's factory options; `signal` is one cancellation
 *   source among three.
 * @param inflight - the plugin's set of live transactions; the transaction is
 *   added on construction, so an unload cannot miss one that is still starting.
 * @param ownerCtx - the caller context whose lifetime owns the agent. Only its
 *   teardown is taken from it here; the publication registers the half that
 *   owns the agent's scope once there is a scope to order.
 * @param label - the transaction's name, for the effect registration and the
 *   cancellation reasons it raises.
 * @returns the transaction.
 */
function beginTransaction(options, inflight, ownerCtx, label) {
  const cancellation = new AbortController();
  /** Resources the transaction opened and no publication has taken over yet. */
  const orphans = new Set();
  /** The publication's own teardown, once there is a publication. */
  let publication;
  let disposing;
  let disposed = false;

  const cancel = (reason) => {
    if (!cancellation.signal.aborted) cancellation.abort(reason);
  };

  // Source one: the owner's teardown, registered first and registered now.
  //
  // The window before the agent exists is the longest one there is — a
  // `persistence.create` that has not returned, a scope import that has not
  // resolved — and an owner that unloads inside it has to be able to cancel
  // the factory rather than watch it finish into a context that is gone.
  //
  // This registration is the *cancellation* half only: it stops the factory
  // waiting, and there is no agent yet to tear down. `publishAgent` hands the
  // owner's lifetime over to the effect that owns the agent the moment it has
  // registered it, and that one fires on the same teardown and disposes too.
  //
  // The handover is a flag rather than an early return of the registration
  // because in Cordis a disposer *runs* the teardowns it collected — retiring
  // this effect and firing it are the same call. So the teardown is written to
  // be inert once the handover has happened, and running it is how the
  // registration is taken off the owner.
  let ownerHandedOver = false;
  let ownerAttached = true;
  const ownerEffect = ownerCtx.effect(
    () => () => {
      if (ownerHandedOver) return;
      cancel(new Error(`${label} aborted: owner disposed during initialization`));
    },
    `${label}.ownerCancel()`,
  );
  const detachOwner = () => {
    if (!ownerAttached) return;
    ownerAttached = false;
    // Before the call, not after: the teardown reads it.
    ownerHandedOver = true;
    ownerEffect();
  };

  // Source two: the caller's signal, which may already be aborted.
  //
  // The host's contract for it is *creation only*: the factory is handed the
  // signal to govern the initialization, and nothing says it governs the agent
  // afterwards. So the listener is named and taken off again — on success,
  // before the handle is handed back, and on every path that does not deliver
  // one. Left attached it would both outlive the caller's interest in this
  // factory call and let an abort meant for an initialization that is already
  // over cancel a live agent.
  const caller = options.signal;
  const onCallerAbort = () => cancel(caller.reason);
  let callerAttached = false;
  if (caller !== undefined) {
    if (caller.aborted) cancel(caller.reason);
    else {
      caller.addEventListener("abort", onCallerAbort, { once: true });
      callerAttached = true;
    }
  }
  const detachCaller = () => {
    if (!callerAttached) return;
    callerAttached = false;
    caller.removeEventListener("abort", onCallerAbort);
  };

  // What every step races. Rejecting is the only way to stop waiting on a step
  // that will not settle, so it is also how the factory is told to go.
  const stopped = new Promise((_resolve, reject) => {
    const fail = () => reject(abortReason(cancellation.signal));
    if (cancellation.signal.aborted) fail();
    else cancellation.signal.addEventListener("abort", fail, { once: true });
  });
  // A race handles this one, but a transaction can be cancelled before its
  // first step and never raced at all; an unhandled rejection there would be a
  // process-level alarm for a condition this file expects.
  stopped.catch(() => {});

  /**
   * Refuse a step the transaction is already over for.
   *
   * The race below abandons a step's *result*, but only after the step has
   * run: a `setup` that opens something, a `persistence` call that creates a
   * file. An initialization that has already been cancelled must not start new
   * side effects, so the check is made before the work is handed to the
   * microtask queue rather than after it comes back.
   *
   * `disposed` is only ever set by `dispose`, which cancels in the same
   * synchronous step, so a disposed transaction's signal is always aborted and
   * this reports the same reason the race would have.
   */
  const refuseIfOver = () => {
    if (!disposed && !cancellation.signal.aborted) return;
    throw abortReason(cancellation.signal);
  };

  /**
   * Await one step, giving up on it when the transaction is cancelled.
   * @param work - the step.
   * @returns its value, or a rejection carrying the cancellation's reason.
   */
  const step = async (work) => {
    refuseIfOver();
    const promise = Promise.resolve().then(() => {
      refuseIfOver();
      return work();
    });
    // The loser of the race is not awaited by anybody, so its rejection has to
    // be absorbed here: it is a result the transaction has already abandoned.
    promise.catch(() => {});
    return await Promise.race([promise, stopped]);
  };

  /**
   * Await one step that produces a resource to close.
   * @param work - the step.
   * @returns the resource, while the transaction is still live.
   */
  const stepForHandle = async (work) => {
    refuseIfOver();
    const promise = Promise.resolve().then(() => {
      refuseIfOver();
      return work();
    });
    promise.then(
      (handle) => {
        if (disposed) void closeQuietly(handle);
        else orphans.add(handle);
      },
      () => {},
    );
    return await Promise.race([promise, stopped]);
  };

  const dispose = (ownerTriggered = false) =>
    (disposing ??= (async () => {
      // Before anything is torn down: a step still waiting must stop waiting,
      // and a step still running must not be allowed to commit.
      disposed = true;
      cancel(new Error("agent transaction disposed"));
      // Nothing is waiting on either lifetime any more. A registration left on
      // the caller's signal or on the owner's context is a closure that outlives
      // the initialization it was made for.
      detachCaller();
      detachOwner();
      const failures = [];
      try {
        await publication?.(ownerTriggered);
      } catch (error) {
        failures.push(error);
      }
      for (const handle of [...orphans]) {
        try {
          await handle?.close();
        } catch (error) {
          failures.push(error);
        }
      }
      orphans.clear();
      inflight?.delete(dispose);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "agent transaction disposal failed");
    })());

  inflight?.add(dispose);

  return {
    /** The one signal all three lifetimes cancel. */
    signal: cancellation.signal,
    /** Whether this transaction has been cancelled or disposed. */
    get disposed() {
      return disposed;
    },
    cancel,
    step,
    stepForHandle,
    /**
     * Take a resource out of the transaction's hands.
     *
     * Called by a publication for the handle it now closes itself, in the
     * order it needs. Without this the handle would be closed twice.
     * @param handle - the resource the publication owns.
     */
    claim(handle) {
      orphans.delete(handle);
    },
    /**
     * Register the publication's teardown, run by `dispose` before anything
     * the transaction still holds.
     * @param teardown - receives whether the owner's lifetime ended first.
     */
    adoptPublication(teardown) {
      publication = teardown;
    },
    /**
     * Take the caller's signal out of the transaction.
     *
     * Called by the publication once the agent has been delivered, because the
     * host gives the caller's signal to the *initialization*: an abort that
     * arrives after the handle is handed back is an abort for something that is
     * already over, and must not reach the live agent. `dispose` calls it too,
     * so no path leaves a listener behind.
     */
    detachCaller,
    /**
     * Retire the owner's cancellation registration.
     *
     * Called by the publication as soon as it has registered the effect that
     * owns the agent — that one fires on the same teardown and disposes as
     * well, so keeping both would leave the owner with a registration per
     * initialization that never goes away. `dispose` calls it too, for every
     * path that never gets that far.
     */
    detachOwner,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh session and Thread agent under the caller-supplied identity.
 * @param ctx - plugin context carrying the harness services.
 * @param settings - the bridge's settings.
 * @param seams - the Core link and the session map, as providers.
 * @param ownerCtx - caller context that owns the transaction and live handle.
 * @param options - identity, metadata, per-agent options, setup, and signal.
 * @param inflight - the plugin's set of live transactions.
 * @returns the owned handle.
 */
async function createAgent(ctx, settings, seams, ownerCtx, options, inflight) {
  const transaction = beginTransaction(options, inflight, ownerCtx, `dsh-bridge.create(${options.sessionId})`);
  try {
    const session = ctx.sessions.prepare(options.sessionId, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      ...(options.inheritedEventCount === undefined
        ? {}
        : { inheritedEventCount: options.inheritedEventCount }),
    });
    let handle;
    const persistence = ctx.get("sessionPersistence");
    if (persistence !== undefined) {
      handle = await transaction.stepForHandle(() =>
        persistence.create(session.header, {
          inheritedEventCount: session.inheritedEventCount,
          // The transaction's own signal, not the caller's: a backend that
          // honours a signal has to hear every reason this initialization can
          // end — the owner unloading and the plugin unloading too — not only
          // the one the caller knows about.
          signal: transaction.signal,
        }),
      );
    }
    return await publishAgent(ctx, ownerCtx, settings, seams, options, transaction, {
      session,
      handle,
      // Nothing of this session is stored yet, so the whole log — a fork's seed
      // included — is the unstored suffix the publication commit has to flush.
      storedCount: 0,
      history: options.seed ?? [],
      source: "startup",
    });
  } catch (error) {
    await transaction.dispose().catch(() => {});
    throw error;
  }
}

/**
 * Load a persisted session and Thread agent on it.
 * @param ctx - plugin context carrying the harness services.
 * @param settings - the bridge's settings.
 * @param seams - the Core link and the session map, as providers.
 * @param ownerCtx - caller context that owns the load and live handle.
 * @param options - persisted identity, per-agent options, setup, and signal.
 * @param inflight - the plugin's set of live transactions.
 * @returns the owned handle.
 */
async function resumeAgent(ctx, settings, seams, ownerCtx, options, inflight) {
  const persistence = ctx.get("sessionPersistence");
  if (persistence === undefined) {
    throw new Error("cannot resume: session persistence is not configured");
  }
  const transaction = beginTransaction(options, inflight, ownerCtx, `dsh-bridge.resume(${options.resumeSessionId})`);
  try {
    const id = options.resumeSessionId;
    const handle = await transaction.stepForHandle(() =>
      persistence.open(id, "write", {
        // See `createAgent`: the transaction's signal is the fused one.
        signal: transaction.signal,
      }),
    );
    // The read is the step a backend is most likely to hold open — it is where
    // a cooperating reader watches the signal — so an owner that unloads while
    // it is in flight has to reach it, or the factory waits on a read nobody
    // will ever finish.
    const read = await transaction.step(() =>
      handle.read(0, undefined, {
        signal: transaction.signal,
      }),
    );
    const session = ctx.sessions.prepare(id, {
      seed: [...read.events],
      meta: { ...handle.header },
      inheritedEventCount: handle.inheritedEventCount,
      eventState: read.eventState,
    });
    return await publishAgent(ctx, ownerCtx, settings, seams, options, transaction, {
      session,
      handle,
      // Everything read back is already stored, so only what the constructor
      // and `setup` append after this point needs flushing.
      storedCount: read.events.length,
      history: read.events,
      source: "resume",
    });
  } catch (error) {
    await transaction.dispose().catch(() => {});
    throw error;
  }
}

/**
 * Compose the agent's scoped world, store what the log owes, enter both
 * registries, announce both creations, and return the handle whose `dispose`
 * reverses all of it in order.
 *
 * The order here is the contract, not a preference:
 *
 * 1. `setup` runs while the agent is unpublished, because that is where dsh
 *    binds the session's preset — and that binding needs the *scoped* context
 *    the agent was built with, or it refuses the agent outright.
 * 2. The unstored suffix is flushed through the persistence handle before the
 *    live append hooks are installed. Events the session acquired before
 *    publication — a fork's seed, the constructor's markers, whatever `setup`
 *    appended — never re-emit through `session/event`, so nothing else would
 *    ever write them; and the handle refuses the first live append whose `seq`
 *    does not continue from its cursor.
 * 3. Any failure at any point — including the scope import, the scope
 *    construction, or the owner-effect registration, all of which run before
 *    the log is flushed — unwinds through `dispose`, so a throw leaves no open
 *    handle and no reserved session id for a retry to collide with.
 * 4. `sessions.enter`/`announce` go through the agent's scoped context, while
 *    `agents` stays on this plugin's: the session store keys its event routing
 *    off the *calling* context's scope, so a session entered through the
 *    plugin's unscoped ctx would never reach a `session/event` listener that
 *    `setup` registered on `agent.ctx`. The agent registry keys off the agent
 *    itself, so its calls are scope-independent (see the commit for the
 *    asymmetry's evidence).
 * @param ctx - plugin context.
 * @param ownerCtx - caller context that owns the agent's lifecycle.
 * @param settings - the bridge's settings.
 * @param seams - the Core link and the session map, as providers.
 * @param options - the caller's factory options.
 * @param transaction - the transaction this publication belongs to, which owns
 *   cancellation, the handles, and the plugin's unload sweep.
 * @param prepared - the prepared session, its handle, the stored cursor, the
 *   history to number turns from, and which path published it.
 * @returns the published agent and the transaction's `dispose`.
 */
async function publishAgent(ctx, ownerCtx, settings, seams, options, transaction, prepared) {
  const { session, handle, history, source } = prepared;
  const stored = { handle, storedCount: prepared.storedCount };
  // The publication closes this handle itself, in the order it needs — after
  // the agent is quiet and before the session leaves the registries.
  transaction.claim(handle);

  let agent;
  let detachSession;
  let detachAgent;
  let unfollowOwner;

  // Every await below goes through `transaction.step`, so the owner unloads,
  // the plugin unloads and the caller aborts all stop the *wait*, not just the
  // work: a `setup` that never resolves and a registry listener that never
  // lets go would otherwise hold the factory open past the teardown that is
  // trying to clean up after them. `assertLive` is the cheap synchronous form
  // of the same check, for the points where nothing is being awaited.
  const assertLive = () => {
    if (transaction.signal.aborted) throw abortReason(transaction.signal);
  };

  /**
   * Reverse everything publication did, exactly once.
   *
   * Memoised because two owners race for it: the caller's own `dispose` and
   * the owner context's teardown. Both must be able to call it, and neither
   * may tear down what the other is still using. Failures are collected rather
   * than thrown one at a time, so a stuck turn cannot leave the persistence
   * handle open behind it.
   * @param ownerTriggered - whether the owner's lifetime ended first.
   * @returns the disposal promise.
   */
  const dispose = async (ownerTriggered = false) => {
    const failures = [];
    // The agent may not exist yet: the scope import, scope construction, or
    // owner-effect registration can throw before it does, and the handle the
    // session already acquired still has to close.
    if (agent !== undefined) {
      try {
        agent.beginDispose();
        agent.cancel({ kind: "disposed" });
        await agent.whenIdle();
        // The follow outlives turns, so it is not closed by `whenIdle`: it is
        // stopped and awaited here, before the scope goes, so its subscription
        // is gone and no late callback can reach a disposed session.
        await agent._stopFollow();
        await agent.scope.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await stored.handle?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      detachAgent?.();
      detachSession?.();
    } catch (error) {
      failures.push(error);
    } finally {
      // Disposing the owner effect is skipped when the owner triggered this
      // disposal: the owner's own teardown is already running that effect's
      // teardown, and re-entering it would recurse.
      if (!ownerTriggered) {
        try {
          await unfollowOwner?.();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `agent "${session.id}" disposal failed`);
  };
  transaction.adoptPublication(dispose);

  const primitive = await transaction.step(() => loadScopePrimitive());
  assertLive();
  agent = new ThreadAgent(ctx, settings, session, options.agentOptions ?? {}, {
    scopePrimitive: primitive,
    lastTurn: lastTurnIn(history),
    // The history is what the transcript's dedupe set is seeded from: a resumed
    // session already holds the messages of the Thread it is about to rejoin,
    // and re-reading them must not append them again.
    history,
    core: seams?.core ?? null,
    sessionMap: seams?.sessionMap ?? null,
    inputReceipts: seams?.inputReceipts ?? null,
  });

  // Tie the agent to the caller's lifetime. The scope's own disposer is
  // yielded by identity, not wrapped: the effect owns a teardown ORDER, and
  // yielding a wrapper would let Cordis run it as a concurrent sibling that
  // unregisters the agent while its last turn is still draining. The
  // disposer is kept so `dispose` can retire the effect itself.
  unfollowOwner = ownerCtx.effect(function* () {
    yield agent.scope.rawDispose;
    yield () => {
      // Cancel first: a `setup` still in flight stops waiting rather than
      // publishing an agent whose owner is already gone.
      transaction.cancel(
        new Error(`agent "${agent.id}" setup aborted: owner disposed during setup`),
      );
      if (transaction.disposed) return;
      return transaction.dispose(true);
    };
  }, `dsh-bridge.lifecycle(${agent.id})`);
  // The effect above fires on the same teardown as the transaction's own owner
  // registration and disposes as well, so from here on it is the one that owns
  // the owner's lifetime. Retiring the earlier registration keeps the owner
  // from accumulating one per initialization.
  transaction.detachOwner();

  if (typeof options.setup === "function") {
    const setup = options.setup;
    const commit = await transaction.step(() => setup(agent.ctx, agent));
    // `await` hands the turn back to the microtask queue, and a caller's abort
    // can land in it: the step's race is already decided by the time this line
    // runs, so a cancellation that arrived while `setup` was returning would
    // otherwise be committed anyway. `commit` applies the caller's changes to
    // an agent whose initialization is over.
    assertLive();
    if (commit !== undefined && typeof commit.commit === "function") commit.commit();
  }
  assertLive();
  await transaction.step(() => flushUnstored(stored, session));
  assertLive();
  detachSession = agent.ctx.sessions.enter(session);
  detachAgent = ctx.agents.enter(agent, options.parentAgent);
  agent.ctx.sessions.announce(session);
  assertLive();
  // The transaction's signal, not the caller's: a listener that honours it has
  // to hear about every reason this initialization can end, not just the one
  // the caller knows about.
  await transaction.step(() => ctx.agents.announce(agent, source, transaction.signal));
  assertLive();
  // The initialization is over and the handle is about to be handed back, so
  // the caller's signal stops here: an abort after this point is not an abort
  // for this creation.
  transaction.detachCaller();
  // A session that opens onto a Thread it already has has history to draw, and
  // answers that may still be coming: its own turns ended in an earlier
  // process, or have not been opened yet. The follow is what reads them in, so
  // an open shows what the Core holds without the user having to send a prompt
  // to make it appear. A session with no Thread yet reads nothing: the follow
  // resolves its Thread from the record and stops when there is none.
  agent._startFollow();
  return { agent, dispose: () => transaction.dispose() };
}

/**
 * Write the session events the log does not hold yet.
 *
 * `snapshotEvents` is deprecated for new callers, and this is a new one — but
 * it is the only read the session exposes, and the reference implementation in
 * `@deepseek-ai/dsh-agent-loop` flushes through exactly this call for exactly
 * this reason. There is no async equivalent to migrate to.
 * @param stored - the handle and how many events it already holds.
 * @param session - the unpublished session whose suffix is owed.
 */
async function flushUnstored(stored, session) {
  if (stored.handle === undefined) return;
  const suffix = session.snapshotEvents(stored.storedCount);
  if (suffix.length === 0) return;
  await stored.handle.append(suffix);
  stored.storedCount += suffix.length;
}

// ---------------------------------------------------------------------------
// Thread agent
// ---------------------------------------------------------------------------

let localMessageCounter = 0;
const nextLocalMessageId = (sessionId) =>
  `dsh-${sessionId}-msg-${(localMessageCounter += 1).toString(36)}`;

/**
 * The idempotency key one turn's input is submitted under.
 *
 * The Core answers a repeated key with the receipt it already wrote and writes
 * nothing a second time, so the key is the whole of what makes a replayed prompt
 * one message rather than two. It is therefore the *input's* identity when the
 * Host gave one: a turn counter is a fact about this process's turns, and a
 * replay arrives under a different turn — or in a different process, after a
 * reconnect — which is exactly when the same words would otherwise be accepted
 * again. The key names the session as well, so two sessions' inputs cannot
 * collide on one Host-minted identity.
 *
 * An input with no identity of its own — a caller that is not the Host, or a
 * batch of several messages, which becomes one input with no single identity to
 * name — keeps the counter it has always been named by.
 * @param sessionId - this session's id.
 * @param turn - the open turn's number.
 * @param source - the source the input arrived with, or `null`.
 * @returns the request id to submit under.
 */
function inputRequestId(sessionId, turn, source) {
  if (source === null) return `dsh:${sessionId}:turn:${turn}`;
  return `dsh:${sessionId}:input:${source.rpcId}`;
}

/**
 * The transcript's identity for an input the Core has accepted.
 *
 * The Core names the message the acceptance wrote — the same id its message
 * listing returns for that message, so a re-read records it once, under one
 * identity — and the source the input arrived with is what the interface retires
 * its submission echo against. Both are needed together: the id without the
 * source leaves the echo standing, and the source without the id would put one
 * prompt's identity on whichever message came back first. Either one missing
 * means there is nothing to claim, and nothing is claimed — a Core that names no
 * message leaves the echo to the interface's own reload, which rebuilds the
 * conversation from durable events alone.
 * @param receipt - the receipt `input.submit` returned.
 * @param source - the source the input arrived with, or `null`.
 * @returns `{ messageId, source }`, or `null` when the Core named no message or
 *   the input has no identity of its own to echo.
 */
function acceptedInputOf(receipt, source) {
  const messageId = receipt?.messageId;
  if (typeof messageId !== "string" || messageId === "") return null;
  if (source === null) return null;
  return { messageId, source };
}

/**
 * The codes that mean "this process could not say what happened to the input".
 *
 * A refusal the Core decided is an answer: it names a code, and by the Core's
 * own contract a refusal writes no ledger entry, so the input is not held
 * anywhere and the session is the only place its words can be kept. These are
 * the other kind — the process failed around the request, and whether the
 * acceptance committed before it did is exactly what is not known. `TIMEOUT` is
 * the clearest of them (the work may well have been done), and `INTERNAL` is the
 * one a server raises on a path it did not expect, which can be either side of
 * the commit.
 *
 * An error with no code at all — a socket that closed, a request that never
 * arrived — is the same case and is treated as one.
 */
const UNKNOWN_OUTCOME_CODES = new Set([
  "INTERNAL",
  "TIMEOUT",
  "CAPACITY",
  "SERVER_STARTING",
  "SERVER_STOPPING",
  "STORAGE_FAILURE",
  "RECOVERY_BLOCKED",
]);

/**
 * Whether a failed `input.submit` leaves the input's fate unknown.
 *
 * `IDEMPOTENCY_CONFLICT` is not in the set and is not a plain refusal either:
 * it is the Core saying it *does* hold an entry under this key, under a payload
 * this call did not send. The words are durable; a second copy of them is what
 * must not be made. See the caller.
 * @param error - what the submit threw.
 * @returns whether the Core may hold this input without having said so.
 */
function outcomeUnknown(error) {
  const code = error?.code;
  if (typeof code !== "string" || code === "") return true;
  return UNKNOWN_OUTCOME_CODES.has(code);
}

/**
 * The command one input is submitted as.
 *
 * It is the wire payload's whole intent: which Thread and Conversation the words
 * go into, whether they are a supplement to a Run, and which Run that is. The
 * text is not part of it — the words belong to the input being submitted, and
 * the same command submitted twice carries the same words by construction.
 * @param input - the command.
 * @param text - the turn's words.
 * @returns the `input.submit` payload.
 */
function submitPayload(input, text) {
  return {
    requestId: input.requestId,
    threadId: input.threadId,
    text,
    conversationId: input.conversationId,
    ...(input.delivery === "next_turn"
      ? { delivery: "next_turn", targetRunId: input.targetRunId }
      : {}),
  };
}

/**
 * The command a recorded input was submitted as.
 *
 * A prompt the Host delivers again is submitted again *as it was*. The Core keys
 * idempotency on the request id **and a hash of the payload**, so a second
 * delivery that re-decides the delivery — the Run it first joined has settled
 * since, so it is judged `new_run` now — is the same key under a different shape:
 * the Core refuses it as `IDEMPOTENCY_CONFLICT` rather than answering with the
 * receipt it already wrote, and the transcript ends up with the session's own
 * copy of the words beside the Core's. Repeating the recorded command makes the
 * payload the same, and the Core answers with the acceptance it already has.
 * @param record - the stored record of this input's first delivery.
 * @returns the command to submit.
 */
function recordedCommand(record) {
  return {
    requestId: record.requestId,
    threadId: record.threadId,
    conversationId: record.conversationId,
    delivery: record.delivery,
    targetRunId: record.targetRunId,
  };
}

/**
 * The Core messages a session log already holds, by the keys this build
 * remembers them by.
 *
 * A resumed session's log is full of messages this agent appended in an earlier
 * process, and re-reading the Core's history must not append them a second
 * time. The keys are the ones {@link messageIdentityKeys} reads, so this is a
 * read of the same vocabulary rather than a guess at what the log means.
 *
 * ## Why the shapes are read as they are
 *
 * The log holds the harness's own shapes, and they nest the message
 * differently: a `user/message`'s `data` *is* the message — the session title
 * reads its source off the top level — while every other message event carries
 * it under `data.message`. Reading only the nested one would leave every user
 * message unrecorded, and the user's own words would be appended again on the
 * next read of the Core's history. `tool/call` is not a message at all: it
 * carries the call's fields, and its identity in the log is the `callId` — the
 * same value the Core's own call identity carries.
 * @param history - the session's seed events, in log order.
 * @returns the keys already recorded.
 */
function seenMessagesIn(history) {
  const seen = new Set();
  for (const event of history ?? []) {
    const data = event?.data;
    const id = nonEmpty(data?.id) ?? nonEmpty(data?.message?.id);
    if (id !== null && id.startsWith("core-")) seen.add(id);
    const callId = nonEmpty(data?.callId);
    if (event?.type === "tool/call" && callId !== null) seen.add(`call:${callId}`);
  }
  return seen;
}

/** A non-empty string, or `null`. */
function nonEmpty(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * How long the follow waits before asking for another stream after one ended.
 *
 * A wait between reconnect attempts, not a drain: what makes the reconnect
 * complete is the read taken before it (see {@link ThreadAgent#_followThread}),
 * never this delay. A stream that ends under a session that is still open is a
 * dropped connection, and reconnecting immediately in a loop would be a hot
 * one.
 */
const FOLLOW_RETRY_MS = 1000;

/**
 * Resolve when the signal is aborted, or after `ms`, whichever comes first.
 *
 * Used between reconnect attempts so a session being disposed does not wait out
 * the delay: the abort resolves the wait in the same step.
 * @param signal - the follow's own cancellation.
 * @param ms - the longest to wait.
 */
function waitForAbort(signal, ms) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The DSH stream chunk a Core live frame becomes, when one carries the same
 * fact.
 *
 * The interface's own chunk vocabulary is the authority, so the mapping is
 * stated as a table rather than inferred from the frame's name: `text-delta`
 * and `reasoning-delta` are both `{ index, text }`, which is exactly what the
 * Core's text and thinking deltas carry, so those two translate without
 * invention.
 *
 * `stream.tool_call_delta` is deliberately not here, although the interface has
 * a chunk for it: `tool-call-delta` is `{ index, id, argumentsDelta }` plus an
 * optional `name`, and it is the only chunk that carries a *call's* identity
 * rather than the message's — so it is built at the emission site, from the
 * `toolCallId`/`toolName` the Core puts on the frame. See
 * {@link ThreadAgent#_emitLive}: a fragment whose call the Core never announced
 * has no identity to be drawn under, and is dropped and recorded rather than
 * attributed to the message or to the nearest call.
 */
const CHUNK_FOR_FRAME = {
  "stream.text_delta": "text-delta",
  "stream.thinking_delta": "reasoning-delta",
};

/**
 * The frame type whose chunk is built from the call identity the frame carries.
 *
 * Named rather than spelled inline because two places have to agree on it: the
 * emission that builds the chunk, and the branch that decides a fragment cannot
 * be addressed.
 */
const TOOL_CALL_DELTA_FRAME = "stream.tool_call_delta";

/**
 * The DSH stream chunk one live frame becomes, or `undefined` when this build
 * has no faithful chunk for it.
 *
 * `undefined` is one answer for two different states, and the caller reports
 * them apart: a frame type this build does not map at all, and a tool-call
 * fragment whose call the Core never announced. Both are dropped rather than
 * drawn — but only the second is a *limitation* the Core could lift, so the
 * warning says which one it is.
 *
 * The tool-call chunk is built here rather than in the table because it is the
 * only chunk that names a *call*: `{ index, id, argumentsDelta }` with an
 * optional `name`. The `id` is the one the Core published for that call, never
 * the message id — one message can hold several calls, so the message id would
 * address the wrong one — and a fragment the Core could not address is not
 * attributed to the nearest call either, because that call's arguments are
 * someone else's. `name` is attached only when the Core named one: a placeholder
 * would be a tool identity nothing published.
 * @param frame - a `LiveFrame` from the Core.
 * @returns the chunk to emit, or `undefined` when the frame has none.
 */
function chunkOfFrame(frame) {
  const chunk = CHUNK_FOR_FRAME[frame.type];
  if (chunk !== undefined) return { type: chunk, index: frame.index, text: frame.delta };
  if (frame.type !== TOOL_CALL_DELTA_FRAME) return undefined;
  if (typeof frame.toolCallId !== "string" || frame.toolCallId === "") return undefined;
  return {
    type: "tool-call-delta",
    index: frame.index,
    id: frame.toolCallId,
    argumentsDelta: frame.delta,
    ...(typeof frame.toolName === "string" && frame.toolName !== ""
      ? { name: frame.toolName }
      : {}),
  };
}

/**
 * The Core's event for a message it has committed.
 *
 * The bridge reads the transcript through the message listing rather than out
 * of this payload, so the name is used only to know *when* a new message
 * exists. It is the Core's own published name — the protocol package carries it
 * as part of T10 — and the frame is the one that makes a transcript read
 * necessary before the Run settles.
 */
const MESSAGE_COMMITTED = "message.committed";

/**
 * The id one live frame's stream segment is known by.
 *
 * All three parts are needed. `requestRef` and `attempt` name the request
 * execution the fragment belongs to, which is what a retry replaces;
 * `messageId` names the message within it, which is what keeps two messages of
 * one attempt from being drawn as one run of text under one identity. It is the
 * value the interface receives as the frame's `attemptId`, whose own contract
 * leaves it to the host to mint.
 * @param frame - a `LiveFrame` from the Core.
 * @returns the segment id.
 */
function streamAttemptId(frame) {
  return `${frame.requestRef}:${frame.attempt}:${frame.messageId}`;
}

/**
 * An Agent whose conversation is a Core Thread.
 *
 * P0's echo answered the user itself. This one does not answer at all: it
 * *submits*, and what the transcript shows is what the Core recorded. That is
 * the whole point of the bridge — the interface is a window onto the Agent
 * Core, not a second implementation of it — and it is why nothing here invents
 * a reply. A turn with no Core link fails, visibly, rather than being completed
 * with something this file made up.
 *
 * ## Where the transcript comes from
 *
 * The user's words are submitted, then *read back* with the rest of the
 * messages. Nothing is appended locally on the success path, so one turn cannot
 * produce two copies of one message — the copy the user sees and the copy the
 * Core stored are the same record, keyed by the Core's own entry id. The one
 * exception is the failure path: when the submit itself fails the Core holds
 * nothing, and there the submitted text is appended locally, because a user
 * whose message vanished into a failed submit has no way to tell that from a
 * message that was never sent.
 *
 * ## Where the answer comes from
 *
 * The turn waits on the Thread's committed events, not on a poll. `run.completed`,
 * `run.failed` and `run.cancelled` are the three that end a turn, and
 * `thread.status_changed` is deliberately not one of them: a gate moving is not
 * the work finishing, and closing a turn on it would show a finished turn while
 * the Run is still going. Live frames are relayed as assistant-stream frames so
 * the interface streams while the Run runs; the committed message is still
 * appended from the Core's own projection, so a dropped frame costs a repaint
 * and never a lost word.
 */
class ThreadAgent {
  /**
   * @param ctx - plugin context.
   * @param settings - the bridge's settings: the agent and model a new Thread is
   *   created with.
   * @param session - the live session this agent drives.
   * @param options - per-agent options from the factory call.
   * @param init - the scope primitive, the last turn number the history used,
   *   and the two providers that reach the Core and the durable Session↔Thread
   *   mapping. Both are providers rather than values because building them
   *   imports the SDK and reads a file, and neither may happen for a session
   *   that never runs a turn.
   */
  constructor(ctx, settings, session, options, init) {
    // An Agent's context has to be scoped, not just the plugin's: dsh binds the
    // session's preset through `setup`'s context argument, and a context with no
    // scope tag is refused. The scope is keyed by the agent itself, the way the
    // reference loop keys it, and owns every registration made through `ctx`.
    this.scope = init.scopePrimitive.createScope(ctx, this);
    this.ctx = this.scope.ctx;
    this.settings = settings;
    this.session = session;
    this.options = options;
    this.core = init.core ?? null;
    this.sessionMap = init.sessionMap ?? null;
    this.inputReceipts = init.inputReceipts ?? null;
    this._status = "idle";
    this._nextTurn = [];
    this._nextStep = [];
    // Continue the history's numbering rather than restarting at 1: a resumed
    // or forked log already carries turns the interface groups steps under.
    this._turnCounter = init.lastTurn;
    this._active = null;
    this._idle = null;
    this._cancelCause = null;
    this._disposed = false;
    /** The Thread this session runs on, resolved on the first turn that needs it. */
    this._thread = null;
    /** The Run the open turn submitted into. */
    this._runId = null;
    /**
     * The live assistant streams the open turn is relaying, by attempt id.
     *
     * A map rather than one slot because one turn can have several messages
     * streaming at once — the same attempt's second message must not close the
     * first, and only the message a retry names may be discarded before the
     * turn ends.
     */
    this._streams = new Map();
    this._pendingLive = [];
    this._pendingToolCalls = new Set();
    for (const event of init.history) {
      if (event.type === "tool/call") this._pendingToolCalls.add(event.data.callId);
      if (event.type === "tool/result") this._pendingToolCalls.delete(event.data.callId);
    }
    this._lastToolResultTurn = null;
    this._projectionCaughtUp = false;
    /**
     * The revision the last relayed stream frame was numbered with.
     *
     * The interface's accumulator only accepts a frame whose revision is the
     * previous one plus one, and drops the attempt when it is not — so the
     * counter is per session and never rewinds. Numbering frames by their
     * attempt instead would send revision 1 with every chunk of one answer,
     * and the interface would draw the first and discard the rest.
     */
    this._streamRevision = 0;
    /**
     * The live frame types this build has already reported as unprojectable.
     *
     * Reported once per type rather than once per frame: a tool call streams
     * many argument fragments, and a limitation that repeated itself with every
     * one of them would bury the rest of the log.
     */
    this._unprojected = new Set();
    /** The Core entries this session log already holds. */
    this._seen = seenMessagesIn(init.history);
    this._messagePositions = new MessagePositions(init.history);
    this._openSteps = new Map();
    this._writtenStep = 0;
    this._openTurn = null;
    /**
     * This session's own view of the one Thread it shows, from open until it is
     * disposed or rebound, or `null`.
     *
     * A turn's subscription closes with the turn, so a message the Core commits
     * after the turn ended — a supplement accepted into the Run, an answer
     * projected behind the terminal event, a Run another entry started on the
     * same Conversation — would otherwise wait for a prompt the user has no
     * reason to send. The follow is what reads those in, and it is *this*
     * session's view of *its* Thread: it is not a watch on the home, and it ends
     * with the session. See {@link ThreadAgent#_startFollow}.
     */
    this._follow = null;
    /**
     * The reads this session has taken, in order.
     *
     * Every read of the Conversation — a turn's and the follow's — is chained
     * through this, so two of them are never inside the same page: a listing
     * read twice at once would see the same message unseen twice and append it
     * twice. The chain is kept settled, so a failed read does not poison the
     * ones behind it.
     */
    this._syncChain = Promise.resolve();
    this.inbox = makeInbox(this);
  }

  /** Session-backed Agent identity. */
  get id() {
    return this.session.id;
  }

  /** The current lifecycle state. */
  get status() {
    return this._status;
  }

  /** The Thread this session runs on, once it has been resolved. */
  get threadId() {
    return this._thread?.threadId ?? null;
  }

  /**
   * Refuse input the agent can no longer act on.
   *
   * The four input methods below are declared `void` in the host's Agent
   * contract, so a synchronous throw is the contract's own error channel. A
   * disposed agent has no turn left to open, so the honest answer is an error
   * at the call, and the queue untouched.
   */
  _refuseInput(method) {
    if (!this._disposed) return;
    throw new Error(`thread agent "${this.id}" is disposed: ${method} cannot accept input`);
  }

  /** Append one message to a pending list. */
  send(message, target, wakeup) {
    this._refuseInput("send");
    this.inbox.append(target, message);
    if (wakeup) void this._drive();
  }

  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message) {
    this._refuseInput("followup");
    this._nextTurn.push(message);
    void this._drive();
  }

  /** Submit steering for the nearest step, waking an idle driver. */
  steer(message) {
    this._refuseInput("steer");
    this._nextStep.push(message);
    void this._drive();
  }

  /** Queue model-facing context without waking the driver. */
  inject(message) {
    this._refuseInput("inject");
    this._nextStep.push(message);
  }

  /**
   * Abort the active turn; `keepInbox` preserves queued work.
   *
   * This stops the *turn* waiting. It is not a stop: the Run the Core is
   * advancing is the Core's to revoke, and the interface offers both acts, so
   * {@link ThreadAgent#stop} is the one that reaches the Core.
   */
  cancel(cause, options = {}) {
    this._cancelCause = cause;
    this._active?.abort(cause);
    if (!options.keepInbox) this.inbox.clear();
  }

  /**
   * Stop the Thread this session runs on.
   *
   * The Run is the Core's to revoke, and this is how the interface asks for it:
   * a receipt that says the command was accepted, never that the work has
   * already stopped.
   * @param requestId - the caller's idempotency key.
   * @param reason - why the user stopped it.
   */
  async stop(requestId, reason) {
    const thread = await this._ensureThread();
    const core = await this._requireCore();
    const receipt = await core.call("thread.stop", {
      requestId,
      threadId: thread.threadId,
      ...(reason === undefined ? {} : { reason }),
    });
    // The turn this agent is waiting on stops waiting too: the Core has revoked
    // the Run, so there is no answer coming and waiting for one would hold the
    // turn open past the thing that ended it.
    this.cancel({ kind: "user" });
    return receipt;
  }

  /** Resolve once the driver is idle. */
  whenIdle() {
    if (!this._running) return Promise.resolve();
    return this._idle.promise;
  }

  /** Run one maintenance task from the idle phase. */
  async runMaintenance(task) {
    if (this._running) throw new Error("agent is running; maintenance needs the idle phase");
    const controller = new AbortController();
    this._active = controller;
    try {
      return await task(controller.signal);
    } finally {
      this._active = null;
    }
  }

  /** Mark the agent disposed so no further turn opens. */
  beginDispose() {
    this._disposed = true;
    // The follow outlives turns, so it is not closed by any turn's `finally`: a
    // disposed agent has nothing left to draw into, and the subscription has to
    // go with the same synchronous step that stops new turns opening.
    //
    // The handle is *kept*, not cleared: `dispose` awaits the follow's own
    // promise, and a field cleared here would leave it reading `null` and
    // returning before the in-flight read was out. Aborting twice is harmless.
    this._follow?.controller.abort(new Error("agent transaction disposed"));
  }

  /**
   * Drive every queued turn until the inbox drains or a turn is cancelled.
   * @returns a promise resolving at quiescence.
   */
  async _drive() {
    if (this._running || this._disposed) return;
    this._running = true;
    this._idle = withResolvers();
    this._setStatus("running");
    let cancelled = false;
    try {
      while (!this._disposed && (this._nextTurn.length > 0 || this._nextStep.length > 0)) {
        const turn = (this._turnCounter += 1);
        const claimed = this.inbox.claim();
        if (claimed.length === 0) break;
        cancelled = await this._runTurn(turn, claimed);
        if (cancelled) break;
      }
    } finally {
      this._running = false;
      this._setStatus("idle");
      this._idle.resolve();
      this._idle = null;
    }
  }

  /**
   * Follow this session's Thread, from open until the session is disposed or
   * rebound onto another Conversation.
   *
   * This is the one reader that outlives a turn. A turn's subscription closes
   * with the turn, and everything the Core commits afterwards — a supplement
   * accepted into the Run, an answer projected behind the terminal event, a Run
   * another entry started on the same Conversation — would otherwise wait for a
   * prompt the user has no reason to send.
   *
   * It is *this session's* view of *its own* Thread: one subscription per open
   * session, closed with the session. It is not a watch on the home, and it is
   * not a timer. Only one follow exists per agent: a second call is a no-op.
   *
   * It appends only what the Core committed, through the same
   * {@link ThreadAgent#_syncMessages} the turns use, so the transcript gains no
   * word this half wrote. It sends no prompt, answers nothing, and opens no
   * turn of its own.
   */
  _startFollow() {
    if (this._disposed || this._follow !== null) return;
    const follow = { controller: new AbortController(), done: null };
    this._follow = follow;
    follow.done = this._followThread(follow.controller.signal)
      .catch((error) => {
        if (!follow.controller.signal.aborted) {
          this.ctx.logger.warn(`thread agent "${this.id}" could not follow its Thread: ${String(error)}`);
        }
      })
      .finally(() => {
        if (this._follow === follow) this._follow = null;
      });
  }

  /**
   * Stop the follow, if one is running, and wait for it to leave the Thread.
   *
   * Awaited rather than merely signalled: the caller is a disposal or a rebind,
   * and both need the old reader *gone* — its read out of the listing, its
   * late callbacks dropped — before the session's world changes under it.
   */
  async _stopFollow() {
    const follow = this._follow;
    if (follow === null) return;
    this._follow = null;
    follow.controller.abort(new Error("the session stopped following its Thread"));
    await follow.done;
  }

  /**
   * Point the follow at the Conversation the session now shows.
   *
   * The Thread is the same one; the line of history is not, so the reader that
   * was reading the old one is stopped and a fresh one takes over — including
   * its catch-up read, which is what draws the new Conversation's history.
   */
  async _rebindFollow() {
    await this._stopFollow();
    this._startFollow();
  }

  /**
   * The follow's own loop: try to follow the Thread, and try again if the
   * attempt failed for a reason that is not this follow being stopped.
   *
   * A follow that ended at its first failure would leave the session showing a
   * view that never moves again, with one line in the log to say so. The Core
   * being unreachable for a moment is not the session's answer, so the follow
   * waits and tries again rather than giving the Thread up.
   * @param signal - the follow's own cancellation, aborted by dispose and by a
   *   rebind.
   */
  async _followThread(signal) {
    for (;;) {
      if (signal.aborted || this._disposed) return;
      try {
        await this._followUntilStopped(signal);
        return;
      } catch (error) {
        if (signal.aborted || this._disposed) return;
        this.ctx.logger.warn(
          `thread agent "${this.id}" could not follow its Thread and is retrying: ${String(error)}`,
        );
        await waitForAbort(signal, FOLLOW_RETRY_MS);
      }
    }
  }

  /**
   * One attempt: the watermark, the read that closes the window for, and the
   * subscription held until something ends it.
   *
   * The order of the first two is the whole point. `thread.get` answers with the
   * process's committed-event watermark, and it is read *before* the listing,
   * never after: every fact committed up to that watermark is in the listing the
   * read below takes, because that read happens later, and every fact committed
   * after it carries a seq above the watermark and is replayed by the
   * subscription. Taking the watermark afterwards would leave the facts
   * committed in between in neither the listing nor the replay.
   *
   * `after` is exclusive on the Core's side, which is why the watermark itself
   * is the value to resume from and not the last event seen. It is not the same
   * axis as `messages.list`'s `page.watermark`, which is the projection's last
   * native entry and would skip or repeat committed events.
   *
   * One subscription is held, not one per round: the SDK reconnects it on its
   * own from the last event it saw. What it does not do is retry a cursor the
   * Core has forgotten — it throws, because only the caller can rebuild its view
   * — so a subscription that ends without this follow being stopped is rebuilt
   * from a fresh watermark. A subscription held on a dead cursor would never
   * carry another fact.
   *
   * The first read is not conditional on the Thread being busy. A session that
   * reopens onto a Thread that already settled still has its history to draw,
   * and that is the common case — the reopen after the work finished. The
   * subscription is held for the session's life rather than closed when the
   * Thread looks quiet: a Run another entry starts later on the same
   * Conversation is exactly what a Thread-empty test would stop watching for.
   *
   * The Thread is resolved from the session map rather than created: a session
   * that has never run a turn has no Thread, and a *read* is no reason to make
   * one. A mapping the Core no longer knows is dropped, exactly as the turn
   * path drops it.
   */
  async _followUntilStopped(signal) {
    const map = await this._sessionMap();
    const mapped = map?.get(this.session.id);
    if (mapped === undefined || mapped === null) return;
    const core = await this._requireCore();
    const threadId = mapped.threadId;
    for (;;) {
      let view;
      try {
        view = await core.call("thread.get", { threadId });
      } catch (error) {
        if (error?.code !== "NOT_FOUND") throw error;
        await this._forgetMapping(map, this.session.id, threadId);
        return;
      }
      if (this._thread === null) {
        // The session's own Thread, adopted from the record the same way the
        // turn path reads it: the Conversation this session *shows* is the one
        // its messages belong to, so a session opened on a Core fork reads the
        // fork.
        this._thread = {
          threadId: view.threadId,
          mainConversationId: String(view.mainConversationId),
          conversationId: mapped.conversationId ?? String(view.mainConversationId),
          workspaceId: mapped.workspaceId,
          cwd: mapped.cwd,
        };
      }
      const after = view?.eventSeq;
      if (signal.aborted || this._disposed) return;
      // Drawn before the subscription is asked for, so a Core that cannot be
      // subscribed to at all still has its history shown.
      await this._readWhenIdle(signal);
      if (signal.aborted || this._disposed) return;
      // The watermark is not optional, and this is where it is refused — after
      // the read, which does not depend on it, and before the subscription,
      // which does. A subscription taken without `after` starts where the Core
      // happens to be, so everything committed between the read above and the
      // first frame would be in neither the listing nor the replay: the very
      // window this ordering exists to close. The view always carries it, so a
      // view without one is a Core this bridge cannot follow without guessing —
      // refused and said out loud by the caller's retry, not silently downgraded
      // to an unanchored subscription that looks like it worked.
      if (typeof after !== "number") {
        throw new Error(
          `thread agent "${this.id}": the Core's Thread view carried no eventSeq, so the follow has no watermark to resume from`,
        );
      }
      const subscription = await core.subscribe({
        // The singular name is the one this bridge's Core seam reads, and it is
        // the SDK's plural `threadIds` that the seam maps it to. Passing the
        // plural here is dropped on the floor and subscribes to every Thread in
        // the home — which looks like it worked. See `core-service.js`.
        threadId,
        after,
        live: true,
        signal,
      });
      try {
        for await (const item of subscription) {
          if (signal.aborted || this._disposed) break;
          // Live frames belong to an open turn of this session, and the follow
          // opens none: a frame arriving here is another entry's Run streaming,
          // and drawing it into this session's transcript would attribute it to
          // a turn that never asked for it. Only committed facts are read.
          if (item.kind === "live") continue;
          if (item.event.type !== MESSAGE_COMMITTED && turnOutcomeFor(item.event) === null) continue;
          await this._readWhenIdle(signal);
        }
      } catch (error) {
        if (signal.aborted || this._disposed) return;
        this.ctx.logger.warn(
          `thread agent "${this.id}" lost its Thread subscription and is rebuilding: ${String(error)}`,
        );
        await waitForAbort(signal, FOLLOW_RETRY_MS);
        continue;
      } finally {
        try {
          await subscription?.[Symbol.asyncIterator]?.()?.return?.();
        } catch {
          // A stream that fails while closing has already said what it had.
        }
      }
      if (signal.aborted || this._disposed) return;
      // The stream ended under us rather than being closed, and the SDK does not
      // say why it is not coming back. Rebuild from a fresh watermark.
      await waitForAbort(signal, FOLLOW_RETRY_MS);
    }
  }

  /**
   * Take one read of the Conversation, but only while no turn is open.
   *
   * A turn's own reads are what attribute a message to the turn that submitted
   * it, and a follow's read landing first would take that attribution away. So
   * the follow waits for the driver to be idle rather than competing with it —
   * and it waits on the driver's own completion, not on a delay, because how
   * long a turn takes is not a fact this half can name.
   * @param signal - the follow's own cancellation.
   */
  async _readWhenIdle(signal) {
    // The wait has two ways out: the turn ending, and this follow being stopped.
    // The second is what keeps an awaited rebind from waiting on the turn it is
    // called from — but it is only *needed* when there is a wait, and it is
    // taken down when the wait ends.
    //
    // Both of those matter: this read runs once per committed fact, so a
    // listener registered per read would pile up on a signal that lives as long
    // as the session, and one left behind by a wait the turn ended first would
    // never be released at all.
    let release = null;
    const stopped = new Promise((resolve) => {
      release = resolve;
    });
    const onAbort = () => release();
    let armed = false;
    try {
      while (!signal.aborted && !this._disposed && this._running) {
        const idle = this._idle;
        if (idle === null) break;
        if (!armed) {
          if (signal.aborted) break;
          armed = true;
          signal.addEventListener("abort", onAbort, { once: true });
        }
        await Promise.race([idle.promise, stopped]);
      }
    } finally {
      if (armed) signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted || this._disposed) return;
    await this._syncMessages(this._turnCounter, 1, null);
  }

  /**
   * Open one durable turn, submit it, and close it with what the Core said.
   * @param turn - turn number.
   * @param messages - the claimed input batch.
   * @returns whether the turn was cancelled.
   */
  async _runTurn(turn, messages) {
    const controller = new AbortController();
    this._active = controller;
    const signal = controller.signal;
    const step = 1;
    const text = plainText(messages);
    // What this turn's own submission became, filled in by the submit it makes.
    // It is made per turn and travels down the turn's own calls rather than
    // sitting on the agent, so nothing another turn or another session does can
    // be read back as this turn's input. Nothing *here* survives the turn: what
    // outlives it is the record of the input, which is keyed by the Core's own
    // message id. See {@link acceptedInputOf} and
    // {@link ThreadAgent#_inputIdentityOf}.
    const submission = {
      // The Core answered this turn's submit and named the message it wrote.
      accepted: false,
      // A submit for this input has gone out and nothing has said what became
      // of it. Cleared when the Core answers with a refusal instead, because a
      // refusal writes nothing and the words are then nowhere again.
      attempted: false,
      // This prompt was delivered before: its record was read and named a
      // command. The words may be the Core's already.
      replayed: false,
      // Whether this prompt was delivered before is *not known*: its records
      // could not be read. The words may be the Core's already.
      historyUnknown: false,
      source: submittedInputSource(messages),
      input: null,
    };
    this._startTurn(turn);
    this._startStep({ turn, step });
    this._lastToolResultTurn = null;
    this._projectionCaughtUp = false;
    let outcome = { kind: "completed" };
    try {
      outcome = (await this._converse(turn, step, text, signal, submission)) ?? { kind: "completed" };
    } catch (error) {
      if (!signal.aborted) {
        this.ctx.logger.warn(`thread agent "${this.id}" turn failed: ${String(error)}`);
        // The failure's own words, in the contract's `error` variant: a reason
        // outside the interface's union is one no reader matches, and the turn
        // would render as one that merely ended. See {@link turnErrorReason}.
        outcome = turnErrorReason(error instanceof Error ? error.message : String(error));
        if (submission.accepted || error?.code === "IDEMPOTENCY_CONFLICT") {
          // The Core holds this turn's words: either the submit returned and
          // named the message it wrote, or it refused the key because it already
          // holds an entry under it. Either way a local copy would be a second
          // copy of the same words under an identity of its own, and the
          // interface would draw both. What the Core holds is read back instead,
          // so a failure between the acceptance and the read does not leave the
          // turn's words out of the transcript — and a message the record names
          // is still claimed by it when the read arrives.
          try {
            await this._syncMessages(turn, step, submission);
          } catch (readError) {
            // The read is the Core's to fail and this turn's failure is not it:
            // the words are durable under the id the acceptance returned and
            // appear at the next read, so the turn is closed as it was going to
            // be closed either way.
            this.ctx.logger.warn(
              `thread agent "${this.id}" turn ${turn} could not read back its accepted input: ${String(readError)}`,
            );
          }
        } else if (
          submission.source !== null &&
          (submission.historyUnknown ||
            submission.replayed ||
            (submission.attempted && outcomeUnknown(error)))
        ) {
          // The words are not written here, because they may already be the
          // Core's and this bridge cannot tell that they are not. Three ways in,
          // one fact:
          //
          // - the records could not be read, so whether this prompt was
          //   delivered before is unknown;
          // - they were read and named an earlier delivery of it;
          // - this turn's submit went out and nothing came back that says what
          //   became of it.
          //
          // Recording the words in any of those would be a second copy if the
          // Core holds them — and worse, a durable message echoing the prompt's
          // identity is exactly what the interface retires its own echo
          // against, so a copy made on a *guess* would also stop the Host from
          // delivering that prompt again. The words are left where they are (the
          // Host's own echo, not retired) and the record of what this input was
          // submitted as stands, so a second delivery of it repeats the same
          // command and the Core answers with what it holds. What the user sees
          // is the turn closed as failed below, which is the truth: what became
          // of the words is not known here.
          //
          // An input with no identity of its own is not this case. There is no
          // echo of it to leave standing and no delivery to protect — the caller
          // that sent it has nothing to retry *with* — so the words are kept
          // here, as they always were, rather than left to a recovery that
          // cannot name them.
          this.ctx.logger.warn(
            `thread agent "${this.id}" turn ${turn} could not account for an input that may already be the Core's: ${String(error)}`,
          );
        } else {
          // The Core refused this input, or was never asked — the submit had not
          // gone out when the turn failed. Either way it is held nowhere, so the
          // user's words are recorded here or they are gone. The source the input
          // arrived with is kept, because the interface retires the echo it
          // painted at the submit click only when a durable user message echoes
          // that identity.
          this._appendLocalUserMessage(text, submission.source);
        }
      }
    }
    this._endStream();
    const aborted = signal.aborted;
    this._finishTurn(
      // A cause is recorded only when the caller gave one: `cancel(cause)` is the
      // only thing that aborts the turn's signal, and a caller that named no
      // cause gets the contract's "no cause was recorded" rather than a guess at
      // who asked. See {@link cancelCauseForRunEndReason} for the Core's side.
      aborted ? { kind: "aborted", reason: this._cancelCause ?? { kind: "legacy" } } : outcome,
    );
    this._active = null;
    this._cancelCause = null;
    return aborted;
  }

  /**
   * Submit one turn's text and wait for the Run it landed in.
   * @param turn - the open turn.
   * @param step - the open step.
   * @param text - the submitted text.
   * @param signal - the turn's cancellation signal.
   * @returns the outcome for `turn/end`, or `null` when the turn was cancelled.
   */
  async _converse(turn, step, text, signal, submission) {
    const thread = await this._ensureThread();
    if (signal.aborted) return null;
    const core = await this._requireCore();
    // Every path below names the Conversation this session shows. A session
    // opened on a Core fork shows the fork, and the Core takes the Conversation
    // an input belongs to: leaving it out means the Thread's *main* one, which
    // is the line of history the fork was taken from — the user's words would
    // land there, silently and permanently. The mapped id is sent even when it
    // is the main one, so the request says what it means instead of relying on
    // a default that a later change could move.
    const conversationId = thread.conversationId;
    // A prompt the Host delivered before is submitted again *as it was*: what it
    // was submitted as is a fact of its first delivery and cannot be re-decided
    // from the Thread's state now. See {@link recordedCommand}.
    //
    // A records file that cannot be read is not "no record". Planning live here
    // would re-decide the command of an input that may already exist, so the
    // failure is raised and the submit never goes out — and the turn's failure
    // does not write the words either, because whether the Core already holds
    // them is exactly what could not be read. See
    // {@link ThreadAgent#_recordedInput}.
    let recorded;
    try {
      recorded = await this._recordedInput(submission.source);
    } catch (error) {
      submission.historyUnknown = true;
      throw error;
    }
    submission.replayed = recorded !== null;
    const command =
      recorded === null
        ? await this._planInput(core, thread, conversationId, turn, submission.source)
        : recordedCommand(recorded);
    // The command is on disk before the call that acts on it, not after: the
    // failure this record exists for is the one where nothing is written
    // afterwards, and an intent already on disk is what lets a second delivery
    // of this prompt repeat the same command instead of inventing a new one. An
    // input that cannot be recorded is not submitted at all — nothing is sent,
    // so nothing is lost. See {@link ThreadAgent#_rememberInput}.
    await this._rememberInput(command, submission.source);
    submission.attempted = true;
    let receipt;
    let submitted = command;
    try {
      receipt = await core.call("input.submit", submitPayload(command, text));
    } catch (error) {
      if (error?.code !== "RUN_NOT_ACTIVE") throw error;
      // It ended in between. The message becomes a Run of its own — a
      // *different* command, which is not the same thing as the Core rewriting
      // the one it refused. It stays in the Conversation this session shows:
      // the race is about the Run, not about which line of history the user is
      // typing into.
      //
      // With the input's own identity the key does not change: the refused
      // attempt was refused before anything was accepted, so no ledger entry
      // stands under this key, and keeping the input under one key is what lets
      // a replay of the same prompt be answered with the receipt it already has
      // instead of being accepted a second time. An input with no identity of
      // its own keeps the second key, as it always has.
      submitted = {
        requestId: submission.source === null ? `${command.requestId}:new_run` : command.requestId,
        threadId: command.threadId,
        conversationId: command.conversationId,
        delivery: "new_run",
        targetRunId: null,
      };
      // The fallback is a different command, so it is written down before *it*
      // is sent: a delivery that goes out under a command no record names is
      // one a re-delivery would repeat as the old command, and the Core would
      // then refuse the key it already holds in this shape.
      //
      // The refusal above wrote nothing, so as of here nothing of this input is
      // the Core's: a failure before the fallback's own submit goes out is a
      // failure of an input that was never sent, and the words are kept locally
      // as they are for any such failure. See {@link ThreadAgent#_rememberInput}.
      submission.attempted = false;
      await this._rememberInput(submitted, submission.source);
      submission.attempted = true;
      receipt = await core.call("input.submit", submitPayload(submitted, text));
    }
    this._runId = receipt.runId;
    // The association is made here, before anything is read: the Core names the
    // message its acceptance wrote, and the source this input arrived with is
    // echoed on that message and on no other. It is recorded before the read so
    // the very first append of the turn already carries it, and recorded rather
    // than only held so a read after this turn ends can still claim it. See
    // {@link acceptedInputOf}.
    submission.accepted = true;
    submission.input = acceptedInputOf(receipt, submission.source);
    await this._settleInput(submitted, submission.source, submission.input?.messageId ?? null);
    // Read back immediately: the Core commits the user's message with the
    // acceptance, so it is visible while the Run is still going rather than
    // only once the answer arrives.
    await this._syncMessages(turn, step, submission);
    if (signal.aborted) return null;
    return await this._awaitRun(receipt.runId, signal, submission);
  }

  /**
   * What this Session's earlier delivery of one prompt became, or `null`.
   *
   * Keyed by the Host's own identity for the prompt, which is the only thing a
   * second delivery of it carries. An input with no identity of its own — a
   * caller that is not the Host — has nothing to look up and is always planned
   * live.
   *
   * A failure to read the records is *raised*, not answered with `null`. `null`
   * means "this prompt was never delivered", and the caller acts on that by
   * deciding a command from the Thread's state now — which for an input that
   * *was* delivered is a second command for one prompt: the Run it joined may
   * have settled since, so it is judged `new_run` where its record says
   * `next_turn`, and the Core refuses a key it already holds in another shape.
   * So an input whose records cannot be read is not delivered at all: the
   * failure reaches the turn before its submit goes out, and nothing is lost
   * that had not already been sent.
   * @param source - the source the input arrived with, or `null`.
   * @returns the record, or `null` when this prompt has never been delivered.
   */
  async _recordedInput(source) {
    if (source === null) return null;
    const receipts = await this._inputReceipts();
    return receipts?.get(this.session.id, source.rpcId) ?? null;
  }

  /**
   * The command a prompt with no record of its own is submitted as.
   *
   * A message typed while a Run is going belongs to that Run: `next_turn` is the
   * delivery that says so, and the target is named rather than inferred, because
   * between the read above and the submit the Run can end.
   * @param core - the Core link.
   * @param thread - the Thread this session runs on.
   * @param conversationId - the Conversation this session shows.
   * @param turn - the open turn's number.
   * @param source - the source the input arrived with, or `null`.
   * @returns the command.
   */
  async _planInput(core, thread, conversationId, turn, source) {
    const view = await core.call("thread.get", { threadId: thread.threadId });
    const active = Array.isArray(view?.activeRuns) ? view.activeRuns : [];
    const targetRunId = await this._activeRunIn(core, active, conversationId);
    return {
      requestId: inputRequestId(this.session.id, turn, source),
      threadId: thread.threadId,
      conversationId,
      delivery: targetRunId === null ? "new_run" : "next_turn",
      targetRunId,
    };
  }

  /**
   * Write down what one input is about to be submitted as, before it is.
   *
   * Not best-effort. This record is what lets a second delivery of the same
   * prompt repeat this command instead of inventing one, so an input that
   * carries an identity of its own is not submitted until its command is on
   * disk. A store that cannot be written fails the turn *before* the submit —
   * the one failure here that costs nothing, because nothing was sent: the
   * Host's echo stands and the words are still in its hands. See
   * {@link ThreadAgent#_settleInput} for the write that follows the acceptance,
   * which is best-effort for the opposite reason.
   * @param command - the command the input is submitted as.
   * @param source - the source the input arrived with, or `null` for an input
   *   with no identity of its own, which is not recorded at all.
   */
  async _rememberInput(command, source) {
    if (source === null) return;
    const receipts = await this._inputReceipts();
    if (receipts === null) {
      // No records at all: this bridge cannot recognise a second delivery of
      // the input, so it does not make one. Nothing is sent and nothing is
      // written; the turn fails with the words where they already are.
      throw new Error(
        `session "${this.id}" keeps no input records, so it cannot submit a prompt that carries one`,
      );
    }
    await this._writeInputRecord(receipts, command, source, null);
  }

  /**
   * Write down what an accepted input became.
   *
   * The command is already on disk — the submit did not go out without it — so
   * this only adds the message the acceptance named. It is best-effort: a home
   * whose file cannot be written loses the ability to claim that message on a
   * *later* read, which is worth saying and is not worth failing a turn the Core
   * has already accepted over, nor worth writing the words again to compensate
   * for.
   * @param command - the command the input was submitted as.
   * @param source - the source the input arrived with, or `null`.
   * @param messageId - the message the acceptance named, when it is known.
   */
  async _settleInput(command, source, messageId) {
    if (source === null) return;
    try {
      const receipts = await this._inputReceipts();
      if (receipts === null) return;
      await this._writeInputRecord(receipts, command, source, messageId);
    } catch (error) {
      this.ctx.logger.warn(`thread agent "${this.id}" could not record its input: ${String(error)}`);
    }
  }

  /**
   * The record itself, in the one shape both writes above make.
   *
   * A record that already names a message keeps it: the re-write of a replayed
   * input must not erase the identity the first acceptance gave it.
   * @param receipts - the open store.
   * @param command - the command the input is submitted as.
   * @param source - the source the input arrived with.
   * @param messageId - the message the acceptance named, when it is known.
   */
  async _writeInputRecord(receipts, command, source, messageId) {
    const previous = receipts.get(this.session.id, source.rpcId);
    await receipts.put({
      sessionId: this.session.id,
      rpcId: source.rpcId,
      requestId: command.requestId,
      threadId: command.threadId,
      conversationId: command.conversationId,
      delivery: command.delivery,
      targetRunId: command.targetRunId ?? null,
      messageId: messageId ?? previous?.messageId ?? null,
      source,
      createdAt: Date.now(),
    });
  }

  /**
   * The active Run of one Conversation, or `null` when that Conversation has
   * none.
   *
   * A Thread can hold several Conversations — a fork is one — and
   * `thread.get`'s `activeRuns` lists the Runs of all of them, so the first
   * entry is not this session's Run: a supplement aimed at it would put the
   * user's words into a Run on a line of history they are not looking at.
   *
   * Which Conversation a Run belongs to is the Run's own public fact, read with
   * `run.get`, rather than something to infer from order, recency or the text.
   * The Core decides inside the acceptance transaction whether that Run may
   * take a supplement, so this read is a *selection*, not a permission check —
   * the same answer it gives is the one the caller names.
   *
   * A Run that has gone between the Thread read and this one is skipped rather
   * than reported: it cannot take a supplement, and any other failure is the
   * Core's to report.
   * @param core - the Core link.
   * @param activeRunIds - the Run ids the Thread view listed.
   * @param conversationId - the Conversation this session shows.
   * @returns the Run id to supplement, or `null`.
   */
  async _activeRunIn(core, activeRunIds, conversationId) {
    for (const runId of activeRunIds) {
      let run;
      try {
        run = await core.call("run.get", { runId });
      } catch (error) {
        if (error?.code !== "NOT_FOUND") throw error;
        continue;
      }
      if (run?.conversationId === conversationId) return runId;
    }
    return null;
  }

  /**
   * Wait for the Run the turn submitted into to reach a terminal state.
   *
   * The wait is on the Thread's committed events, so a dropped connection
   * resumes from the last seq rather than losing the answer, and a Run that
   * settled while nothing was watching is still settled on the next read. The
   * three terminal Run events are the only exits, and a stream that ends
   * without one is reported as an abort rather than as a completion.
   * @param runId - the Run to wait for.
   * @param signal - the turn's cancellation signal.
   * @param submission - what the turn's own submission became, so a message
   *   read back mid-Run is recorded with the input's own identity when it is
   *   that input. See {@link acceptedInputOf}.
   */
  async _awaitRun(runId, signal, submission) {
    const thread = this._thread;
    const core = await this._requireCore();
    // `threadId`, singular: it is the name this bridge's Core seam reads, and the
    // SDK's plural `threadIds` is what the seam maps it to. The plural here is
    // dropped on the floor, which subscribes to every Thread in the home and
    // looks like it worked — the wait below would then be woken by any other
    // session's Run. See `core-service.js`.
    const subscription = await core.subscribe({ threadId: thread.threadId, live: true, signal });
    try {
      for await (const item of subscription) {
        if (item.kind === "live") {
          // The subscription is the Thread's, so every Run of the Thread
          // streams through it — this session's own next turn, another
          // session's Run, a redo. Only the Run this turn submitted into may
          // draw into this session's open turn, and the association is that
          // Run's id, read from the receipt rather than taken to be whichever
          // Run streamed most recently.
          if (item.frame.runId !== runId) continue;
          this._emitLive(item.frame);
          continue;
        }
        if (item.event.type === MESSAGE_COMMITTED) {
          // A message is committed as it lands, not when the Run ends, and its
          // event names no Run: a message's Run and Turn are facts of the
          // settlement, so the projection does not claim them. Keying this read
          // on this Run's id would therefore skip exactly the event that
          // carries a new message, so the read is keyed on the name instead.
          await this._syncMessages(this._turnCounter, 1, submission);
          continue;
        }
        if (runIdOf(item.event) !== runId) continue;
        const outcome = turnOutcomeFor(item.event);
        if (outcome === null) continue;
        // The settlement's own read carries the submission too: this is the last
        // read before the turn ends, and a message the earlier reads did not see
        // yet — the Core commits a message and settles the Run in that order —
        // would otherwise be the one read that records the turn's own input
        // without its identity.
        await this._syncMessages(this._turnCounter, 1, submission);
        return outcome;
      }
      // The wait ended and the Run did not settle, so the turn is closed as
      // aborted — with the contract's "no cause was recorded", because nobody
      // cancelled it: the stream ended under us, and that is not one of the
      // causes the union names. What happened is said here, where it is a
      // diagnostic, rather than in a reason field no reader matches.
      this.ctx.logger.warn(
        `thread agent "${this.id}" turn ${this._turnCounter} closed aborted: the Core's event stream ended before the Run did`,
      );
      return { kind: "aborted", reason: { kind: "legacy" } };
    } finally {
      // `return()` ends the iteration even while a frame is pending; the signal
      // already carries the turn's cancellation, and both are idempotent.
      try {
        await subscription?.[Symbol.asyncIterator]?.()?.return?.();
      } catch {
        // A stream that fails while closing has already told us everything it
        // was going to; the turn's own outcome is not this failure.
      }
    }
  }

  /**
   * The identity one Core message is recorded under, or `null`.
   *
   * The record is asked first, because it is the answer that outlives the turn
   * that made it: an input whose read-back failed, or whose message was not in
   * the listing until a later turn, is still claimed by the id the acceptance
   * named. The turn's own receipt is the fallback — the same association, held
   * in memory — for a bridge whose record file could not be read or written.
   *
   * Both are keyed on the Core's own message id, and the record on the Session
   * and Conversation as well, so a message another Session or another line of
   * history wrote cannot be given this input's identity.
   *
   * A records file that cannot be read does not stop this: what is already
   * durable in the Core is history, and a file the bridge cannot read is no
   * reason to draw less of it. The message is then drawn with this turn's own
   * receipt, or without an identity at all — it is not dropped, and it is not
   * marked as held before it has been drawn. What is lost is the ability to
   * recognise it *later*, which is what the record is for and what a failed
   * read means.
   * @param message - the Core's `MessageView`.
   * @param conversationId - the Conversation being read.
   * @param submission - the open turn's submission, or `null`.
   * @returns `{ messageId, source }` when this message *is* the input, else `null`.
   */
  async _inputIdentityOf(message, conversationId, submission) {
    try {
      const receipts = await this._inputReceipts();
      const record = receipts?.forMessage(this.session.id, conversationId, message?.messageId);
      if (record !== undefined) return { messageId: message.messageId, source: record.source };
    } catch (error) {
      this.ctx.logger.warn(`thread agent "${this.id}" could not read its input records: ${String(error)}`);
    }
    return submission?.input ?? null;
  }

  /**
   * Append the messages this session log does not hold yet.
   *
   * Paged to the end rather than read once: a Thread that has been running for
   * a while holds more than a page, and a transcript that stopped at the first
   * page would silently lose the middle of a conversation.
   *
   * The Conversation read is the one the session is *showing*, not the Thread's
   * main one: a session opened on a Core fork must render the fork's history,
   * and reading the main Conversation would draw the branch it was forked away
   * from as if the fork had never happened.
   * @param turn - the turn the messages belong to.
   * @param step - the step the messages belong to.
   * @param submission - what the turn's own submission became, or `null` when
   *   the caller is not inside a turn that submitted. Only the message the
   *   receipt named is recorded with the input's own source. See
   *   {@link acceptedInputOf} and {@link ThreadAgent#_inputIdentityOf}.
   */
  async _syncMessages(turn, step, submission = null) {
    // One read at a time, however many readers there are: a turn's own read and
    // the follow's page the same listing, and two of them inside one page would
    // each see the same message unseen and append it twice. The chain is kept
    // settled, so a read that fails does not stop the ones behind it.
    const read = this._syncChain.then(() => this._readConversation(turn, step, submission));
    this._syncChain = read.then(
      () => undefined,
      () => undefined,
    );
    return read;
  }

  /**
   * The read itself, with the caller's turn/step and submission.
   *
   * Called only through {@link ThreadAgent#_syncMessages}, which is what keeps
   * two readers out of one page. See it for the ordering contract.
   * @param turn - the turn the messages are attributed to.
   * @param step - the step the messages are attributed to.
   * @param submission - what the turn's own submission became, or `null`.
   */
  async _readConversation(turn, step, submission) {
    const conversationId = this._shownConversation();
    if (conversationId === undefined || conversationId === null) return;
    const core = await this._requireCore();
    let cursor;
    for (;;) {
      const page = await core.call("messages.list", {
        conversationId,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      // The read is of one Conversation, and it is not the read's to decide
      // whether that is still the one on screen: a session rebound onto another
      // Conversation while this page was in flight — or disposed — must not
      // have the old line's messages appended under the new one. The page is
      // dropped, not re-attributed.
      if (this._disposed || this._shownConversation() !== conversationId) return;
      for (const message of page?.items ?? []) {
        this._messagePositions.bindCoreTurn(messageIdentityKeys(message)[0], message.turnId);
      }
      for (const message of unseenMessages(page?.items ?? [], this._seen)) {
        const identity = await this._inputIdentityOf(message, conversationId, submission);
        // The identity above is read with an `await`, and the screen can move
        // under one: a disposal or a rebind that landed while it was in flight
        // must not have this message appended, so the same check the page got is
        // made again here, at the append itself. It is checked *before* the
        // message is marked as held, not after: a message marked and then not
        // appended would be dropped from the transcript for good.
        if (this._disposed || this._shownConversation() !== conversationId) return;
        let mapped = sessionEventForMessage(message, { turn, step }, identity);
        if (mapped !== null && mapped.type !== "user/message") {
          const position = message.kind === "tool_call" || message.kind === "tool_result"
            ? this._messagePositions.claimTool(messageIdentityKeys(message)[0], message, turn, step)
            : this._messagePositions.claim(messageIdentityKeys(message)[0], turn, step, message.turnId);
          this._startTurn(position.turn);
          this._startStep(position);
          this._flushLive(false);
          mapped = sessionEventForMessage(message, position, identity);
        }
        // Every key this message can be known by is remembered — its own Core
        // id, and the call id for a tool call. See {@link messageIdentityKeys}
        // for why the entry is not one of them, and {@link unseenMessages} for
        // how a marker a log written earlier already holds is spent. It is
        // remembered after the mapping above, not before: a message marked as
        // held and then not appended would be dropped from the transcript for
        // good, and this is the one place in the read where a failure could sit
        // between the two.
        if (mapped !== null) {
          if (mapped.type === "tool/call") {
            this._pendingToolCalls.add(mapped.data.callId);
            // V4 requires an advertised assistant tool-call before the start
            // event. Both are projections of the same durable Core call.
            this.session.append("assistant/message", {
              turn: mapped.data.turn, step: mapped.data.step, stream: [],
              message: {
                id: messageIdentityKeys(message)[0],
                role: "assistant",
                source: { kind: "model", provider: "super-agent", model: "core" },
                content: [{
                  type: "tool-call", id: mapped.data.callId,
                  name: mapped.data.name, arguments: mapped.data.arguments,
                }],
              },
            }, { surfaceOp: "append" });
          }
          const event = this.session.append(mapped.type, mapped.data, mapped.options);
          if (mapped.type === "tool/result") {
            this._pendingToolCalls.delete(mapped.data.callId);
            this._lastToolResultTurn = message.turnId;
          }
          if (mapped.type === "assistant/message") this._settleStreams(message.messageId, event);
        }
        for (const key of messageIdentityKeys(message)) this._seen.add(key);
      }
      if (page?.nextCursor === null || page?.nextCursor === undefined) {
        this._projectionCaughtUp = page?.caughtUp === true;
        this._flushLive(true);
        if (!this._running) this._finishTurn({ kind: "completed" });
        return;
      }
      cursor = page.nextCursor;
    }
  }

  _startTurn(turn) {
    this._turnCounter = Math.max(this._turnCounter, turn);
    if (this._openTurn === turn) return;
    this._finishTurn({ kind: "completed" });
    this.session.append("turn/start", { turn });
    this._openTurn = turn;
    this._writtenStep = 0;
  }

  _finishTurn(reason) {
    if (this._openTurn === null) return;
    for (const position of [...this._openSteps.values()]) this._finishStep(position);
    this.session.append("turn/end", { turn: this._openTurn, reason });
    this._openTurn = null;
  }

  _startStep({ turn, step }) {
    const key = `${turn}:${step}`;
    if (this._openSteps.has(key)) return;
    for (const position of [...this._openSteps.values()]) this._finishStep(position);
    // A thinking-only preview can reserve a position that never receives an
    // assistant text entry. Retain its empty boundary instead of skipping a
    // step number or leaving it open across the following tool group.
    for (let missing = this._writtenStep + 1; missing < step; missing += 1) {
      this.session.append("step/start", { turn, step: missing });
      this.session.append("step/end", { turn, step: missing });
    }
    this.session.append("step/start", { turn, step });
    this._writtenStep = step;
    this._openSteps.set(key, { turn, step });
  }

  _finishStep({ turn, step }) {
    const key = `${turn}:${step}`;
    if (!this._openSteps.has(key)) return;
    this.session.append("step/end", { turn, step });
    this._openSteps.delete(key);
  }

  _settleStreams(messageId, event) {
    for (const [attemptId, stream] of this._streams) {
      if (stream.messageId !== messageId) continue;
      this._streams.delete(attemptId);
      this._emitStreamFrame({
        type: "end",
        attemptId,
        index: stream.index,
        outcome: Number.isSafeInteger(event?.seq)
          ? { kind: "committed", eventType: "assistant/message", seq: event.seq }
          : { kind: "abandoned" },
      });
    }
  }

  /**
   * Record the user's own words when the Core recorded nothing.
   *
   * The payload *is* the message: `user/message` is the one message event the
   * harness does not nest, and the session title reads the source off the top
   * level. See {@link sessionEventForMessage}, which shapes the same event for
   * the messages read back from the Core.
   *
   * The source the input arrived with is carried when the caller has it, because
   * the interface retires the echo it painted at the submit click only when a
   * durable user message echoes that identity — the same reason the Core's copy
   * is recorded with it. See {@link sourceFor}.
   * @param text - the turn's words.
   * @param source - the source the input arrived with, or `null`.
   */
  _appendLocalUserMessage(text, source = null) {
    if (text === "") return;
    this.session.append(
      "user/message",
      {
        id: nextLocalMessageId(this.session.id),
        role: "user",
        content: [{ type: "text", text }],
        source: source ?? { kind: "user" },
      },
      { surfaceOp: "append" },
    );
  }

  /**
   * Relay one live frame as an assistant-stream frame.
   *
   * A segment is keyed by the frame's `requestRef`, `attempt` **and**
   * `messageId`. The first two are what let a retried attempt start a new
   * stream instead of appending into the one the interface is already drawing;
   * the third is what keeps two messages of one attempt apart — the interface
   * holds one stream per attempt id, so two messages keyed alike would be drawn
   * as one run of text under one identity, and neither could then be recognised
   * when its committed copy arrives under its own id. The revision is the
   * session's own counter, one per frame, because that is what the interface
   * accepts frames against.
   *
   * Segments are opened, not swapped: two messages of one attempt are two
   * identities and may both be streaming, so opening the second must not close
   * the first. Only {@link ThreadAgent#_resetStream} closes one before the turn
   * ends, and it closes the one message the retry named.
   * @param frame - a `LiveFrame` from the Core.
   */
  _emitLive(frame, queued = false) {
    if (this._seen.has(`core-${frame.messageId}`)) return;
    if (frame.type === "stream.reset") {
      this._resetStream(frame);
      return;
    }
    const chunk = chunkOfFrame(frame);
    if (chunk === undefined) {
      this._noteUnprojected(
        frame,
        frame.type === TOOL_CALL_DELTA_FRAME
          ? "the Core named no tool call for it"
          : "this build has no chunk for that frame",
      );
      return;
    }
    const attemptId = streamAttemptId(frame);
    let stream = this._streams.get(attemptId);
    if (stream === undefined) {
      const position = frame.type === TOOL_CALL_DELTA_FRAME
        ? this._messagePositions.claimTool(`core-${frame.messageId}`, {
          kind: "tool_call", toolCallId: frame.toolCallId, turnId: frame.turnId,
        }, this._turnCounter, 1)
        : this._messagePositions.claim(`core-${frame.messageId}`, this._turnCounter, 1, frame.turnId);
      if (!queued && this._pendingLive.length > 0) {
        this._pendingLive.push(frame);
        this._flushLive(true);
        return;
      }
      if (!this._canStreamAt(position, frame, true)) {
        if (!queued) this._pendingLive.push(frame);
        return false;
      }
      this._startTurn(position.turn);
      this._startStep(position);
      stream = { attemptId, messageId: frame.messageId, index: 0 };
      this._streams.set(attemptId, stream);
      this._emitStreamFrame({
        type: "start",
        attemptId,
        ...position,
      });
    }
    this._emitStreamFrame({
      type: "chunk",
      attemptId,
      index: stream.index++,
      time: Date.now(),
      chunk,
    });
    return true;
  }

  _canStreamAt(position, frame, advance) {
    if (this._openSteps.has(`${position.turn}:${position.step}`)) return true;
    // Advancing within the same Core response could precede a mixed text/call
    // transcript entry. Its durable message must open that step first. A later
    // response may stream once the complete prior tool group is projected.
    return advance && this._running && this._projectionCaughtUp &&
      this._lastToolResultTurn != null && this._lastToolResultTurn !== frame.turnId &&
      this._pendingToolCalls.size === 0 && this._openTurn !== null && position.turn > this._openTurn;
  }

  _flushLive(advance) {
    // Pending frames retain provider order. Never skip an earlier position to
    // display a later one, and never publish a stream before its durable node.
    while (this._pendingLive.length > 0) {
      const frame = this._pendingLive[0];
      if (this._seen.has(`core-${frame.messageId}`)) { this._pendingLive.shift(); continue; }
      const position = this._messagePositions.positions.get(`core-${frame.messageId}`);
      if (!position || !this._canStreamAt(position, frame, advance)) return;
      this._pendingLive.shift();
      this._emitLive(frame, true);
    }
  }

  /**
   * Discard one message's uncommitted fragment, because it is being retried.
   *
   * `stream.reset` is the boundary between a request's attempts, not a frame of
   * either, so it appends nothing — a client that appended its empty delta
   * would show the user a fragment the model never produced. What it does is
   * close the segment of the message it names.
   *
   * It is matched on the **message id alone**, and that is the whole point of
   * the frame. A retry mints a new `requestRef` for the attempt it starts — the
   * ref is derived from the attempt it belongs to, so the boundary's ref is the
   * *new* attempt's and is never the one the discarded segment was opened under.
   * Matching on the ref would therefore find nothing to close in exactly the
   * case this exists for, and the fragment the model abandoned would stay on
   * screen until the turn ended. The message id is the half that is stable: one
   * logical message keeps its id across the attempts that produce it, which is
   * what lets this frame name the generation it supersedes.
   *
   * Only that message: another message of the same attempt is a different
   * identity with its own segment, and a reset for a message that has no open
   * segment — one that already ended, or a frame that arrived after the fact —
   * closes nothing rather than the nearest thing.
   *
   * Where one message has several segments open, the newest is the one being
   * superseded and the one to close. Segments are ordered by when they opened,
   * and that is attempt order: an attempt cannot stream before the boundary that
   * announces it. Older segments of the same id only stay open if a boundary was
   * missed — the stream is lossy by construction — and an attempt that is over
   * sends no more fragments, so such a segment is closed by the turn's end
   * rather than by this frame.
   *
   * The committed transcript and the reconnect cursor belong to the Core and are
   * not this stream's to touch either way.
   * @param frame - the `stream.reset` frame.
   */
  _resetStream(frame) {
    this._pendingLive = this._pendingLive.filter((pending) => pending.messageId !== frame.messageId);
    let newest = null;
    for (const [attemptId, stream] of this._streams) {
      if (stream.messageId !== frame.messageId) continue;
      newest = [attemptId, stream];
    }
    if (newest !== null) this._closeStreamAt(newest[0], newest[1]);
  }

  /**
   * Record a live frame this build has no faithful chunk for.
   *
   * Two states reach here and they are not the same statement, which is why the
   * caller passes the reason: a frame type with no chunk in this build's
   * vocabulary, and a `stream.tool_call_delta` the Core could not address to a
   * call. In the second case the chunk exists and this build would draw it — what
   * is missing is the call's identity, and inventing one (the message id, the
   * nearest call) would put an identity the Core never published into the
   * transcript, so the fragment is dropped instead.
   *
   * Recorded once per frame type: the stream is per-token and a warning per
   * fragment would drown the session it is describing. What is lost either way is
   * a live preview: the committed message is still read back from the Core's own
   * projection, so no word goes missing.
   * @param frame - the frame this build cannot project.
   * @param reason - why, in the words of the log line.
   */
  _noteUnprojected(frame, reason) {
    if (this._unprojected.has(frame.type)) return;
    this._unprojected.add(frame.type);
    this.ctx.logger.warn(
      `thread agent "${this.id}": live frame "${frame.type}" has no DSH stream chunk ` +
        `(${reason}); its fragment is not shown live`,
    );
  }

  /**
   * Publish one stream frame under the next revision.
   * @param frame - the frame's own fields, without a revision.
   */
  _emitStreamFrame(frame) {
    this._streamRevision += 1;
    this.ctx.emit("agent/assistant-stream", {
      agent: this,
      frame: { ...frame, revision: this._streamRevision },
    });
  }

  /** Close every live stream the turn opened. */
  _endStream() {
    this._pendingLive = [];
    // Each open segment is its own attempt, and one left open would leave the
    // interface drawing a stream nothing will ever finish.
    for (const [attemptId, stream] of [...this._streams]) this._closeStreamAt(attemptId, stream);
  }

  /**
   * Close one open segment.
   * @param attemptId - the segment's id, which is also the frame's `attemptId`.
   * @param stream - the segment's own state.
   */
  _closeStreamAt(attemptId, stream) {
    this._streams.delete(attemptId);
    this._emitStreamFrame({
      type: "end",
      attemptId,
      index: stream.index,
      // Not `committed`: the transcript's copy of this answer is the Core's
      // message, appended from the Core's own projection. A frame that named a
      // session event here would point at one this agent never wrote.
      outcome: { kind: "abandoned" },
    });
  }

  /**
   * The Thread this session runs on, creating it the first time it is needed.
   *
   * Two facts have to be established before a Thread can exist, and both are
   * read rather than guessed: which Workspace the session's directory is (the
   * Core answers, and registers it when it is new), and whether this Session
   * already has a Thread (the durable mapping answers). Only when the mapping
   * says nothing is a Thread created.
   *
   * A mapping that names a Thread the home no longer holds is *forgotten*, not
   * reused: the alternative is a session pointing at nothing, and the user's
   * next message would fail forever with no way to recover.
   */
  async _ensureThread() {
    const thread = await this._ensureThreadNow();
    // A session's association can change under it: a fork writes a new
    // Conversation for the child session, and the reader has to follow it. The
    // record is re-read here, where a turn is about to run, rather than trusted
    // to be the one this agent resolved first — the same reason the mapping is
    // read rather than assumed in the first place.
    if (this._thread !== null && !this._disposed) {
      const map = await this._sessionMap();
      const mapped = map?.get(this.session.id);
      const shown = mapped?.conversationId ?? null;
      if (shown !== null && shown !== this._thread.conversationId) {
        this._thread = { ...this._thread, conversationId: shown };
        // Awaited, not started and left behind: the reader that was on the old
        // line has to be *gone* — its read out of the listing, its late
        // callbacks dropped — before this turn reads the new one, or two readers
        // are in the listing at once and the old line's messages are appended
        // under the new one's turn. The follow's own wait leaves on its
        // cancellation (see {@link ThreadAgent#_readWhenIdle}), so waiting for
        // it here cannot be waiting on this turn.
        await this._rebindFollow();
      }
    }
    // A session that had no Thread when it opened starts following once it has
    // one: the follow is what draws what the Core commits outside a turn, and a
    // session that only began to have a Thread now needs it just as much.
    if (this._follow === null && !this._disposed) this._startFollow();
    return thread;
  }

  /** The Conversation this session currently shows, or `undefined`. */
  _shownConversation() {
    return this._thread?.conversationId ?? this._thread?.mainConversationId;
  }

  /**
   * Forget a Session's mapping, but only if it is still the one that was read.
   *
   * The record is shared, and two readers can find the same Thread gone: the
   * turn path and the follow both drop a mapping the home no longer holds. A
   * reader that forgets what it *saw* be stale must not forget what replaced it
   * — the other reader may have written a new Thread's mapping in between, and
   * an unconditional removal would delete that instead, leaving the Session with
   * no mapping at all and a second Thread on the next start.
   *
   * The comparison and the removal are one synchronous step, so nothing can land
   * between them.
   */
  async _forgetMapping(map, sessionId, threadId) {
    const current = map.get(sessionId);
    if (current === undefined || current === null || current.threadId !== threadId) return;
    await map.remove(sessionId);
  }

  /**
   * Resolve this session's Thread, creating it when the home does not hold one.
   * See {@link ThreadAgent#_ensureThread}, which is what callers use.
   */
  async _ensureThreadNow() {
    if (this._thread !== null) return this._thread;
    const core = await this._requireCore();
    const cwd = this._cwd();
    const map = await this._sessionMap();
    const mapped = map?.get(this.session.id);
    if (mapped !== undefined && mapped !== null) {
      try {
        const view = await core.call("thread.get", { threadId: mapped.threadId });
        this._thread = {
          threadId: view.threadId,
          mainConversationId: String(view.mainConversationId),
          // The Conversation this session *shows*: the Thread's main one for an
          // ordinary session, and the fork's own for a session opened on a Core
          // fork. Read from the record rather than assumed, because assuming it
          // is how a forked session ends up reading the history it was forked
          // away from.
          conversationId: mapped.conversationId ?? String(view.mainConversationId),
          workspaceId: mapped.workspaceId,
          cwd: mapped.cwd,
        };
        return this._thread;
      } catch (error) {
        if (error?.code !== "NOT_FOUND") throw error;
        await this._forgetMapping(map, this.session.id, mapped.threadId);
      }
    }

    const workspace = await this._workspaceFor(core, cwd);
    const created = await core
      .call("thread.create", {
        requestId: `dsh:${this.session.id}:thread`,
        agentId: this.settings.agentId,
        workspaceId: workspace.workspaceId,
        // The Workspace's own canonical root, not the path the session named: the
        // cwd has to be inside the root the Core recorded, and the root is the one
        // path both sides agree on.
        cwd: workspace.root,
        ...(this.settings.modelId === null ? {} : { modelId: this.settings.modelId }),
      })
      .catch((error) => {
        throw explainCreateRefusal(error, this.settings);
      });
    this._thread = {
      threadId: created.threadId,
      mainConversationId: String(created.mainConversationId),
      // A session that creates its own Thread shows that Thread's main
      // Conversation: there is nothing else it could be showing.
      conversationId: String(created.mainConversationId),
      workspaceId: workspace.workspaceId,
      cwd: workspace.root,
    };
    await map?.put({
      sessionId: this.session.id,
      threadId: created.threadId,
      mainConversationId: String(created.mainConversationId),
      conversationId: String(created.mainConversationId),
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.root,
      cwd: workspace.root,
      agentId: this.settings.agentId,
      modelId: this.settings.modelId,
      createdAt: Date.now(),
    });
    return this._thread;
  }

  /**
   * The Workspace the session's directory belongs to.
   *
   * Looked up first and registered only when the home does not know it: a
   * registration that always ran would be a write on every session start, and
   * the registry is a fact about what the user has, not a cache to refresh.
   * @param core - the Core link.
   * @param cwd - the session's directory.
   */
  async _workspaceFor(core, cwd) {
    const found = await core.call("workspace.find", { root: cwd });
    if (found !== null && found !== undefined) return found;
    return await core.call("workspace.register", {
      requestId: `dsh:${this.session.id}:workspace`,
      root: cwd,
    });
  }

  /** The directory this session works in, read from the session rather than assumed. */
  _cwd() {
    const candidates = [this.options?.cwd, this.session?.header?.cwd];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate !== "") return candidate;
    }
    throw new Error(
      `session "${this.id}" has no working directory, so there is no Workspace to put its Thread in`,
    );
  }

  /** The durable Session↔Thread mapping, or `null` when this build has none. */
  async _sessionMap() {
    if (this.sessionMap === null) return null;
    return await this.sessionMap();
  }

  /**
   * The input records, or `null` when this bridge keeps none at all.
   *
   * A store that cannot be *opened* throws, and every caller here is written to
   * a decision rather than a fallback, because "the records are unreadable" and
   * "there are no records" are different answers and only one of them is a
   * licence to act:
   *
   * - a *read of history* carries on without them
   *   ({@link ThreadAgent#_inputIdentityOf});
   * - a *delivery* does not, because planning one live is what turns a second
   *   delivery of a prompt into a second command for it
   *   ({@link ThreadAgent#_recordedInput}), and a command that cannot be written
   *   down is not submitted ({@link ThreadAgent#_rememberInput}).
   *
   * A failed open is not remembered as the answer: {@link onceSucceeding}
   * forgets it, so the next turn tries the file again. That is why the failure
   * is one turn's, not this process's — a file that was half-written when the
   * first turn asked is read normally by the second.
   */
  async _inputReceipts() {
    if (this.inputReceipts === null) return null;
    return await this.inputReceipts();
  }

  /** The Core link, or a refusal naming what is missing. */
  async _requireCore() {
    if (this.core === null) {
      throw new Error("this bridge has no Core link: a running Agent Core is required to run a session");
    }
    return await this.core();
  }

  /** Enter one lifecycle status and notify observers. */
  _setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    this.ctx.emit("agent/status", { agent: this, status });
  }
}

// ---------------------------------------------------------------------------
// Inbox and helpers
// ---------------------------------------------------------------------------

/** Build the agent-owned pending-input facade over two plain lists. */
function makeInbox(agent) {
  /**
   * Refuse a mutation that would add work to a disposed agent.
   *
   * The inbox is the other door into the same queue `followup`/`steer`/`send`/
   * `inject` use, and it is a public part of the Agent surface, so the same
   * rule has to hold here or the input methods' refusal can be walked around.
   * Only the operations that *grow* the queue are refused: `remove`, `replace`
   * and `clear` take work away, and `cancel` — which disposal itself runs —
   * clears through here.
   */
  const refuseIfDisposed = () => {
    agent._refuseInput("inbox");
  };
  return {
    get nextTurn() {
      return [...agent._nextTurn];
    },
    get nextStep() {
      return [...agent._nextStep];
    },
    clear() {
      agent._nextStep.length = 0;
      agent._nextTurn.length = 0;
    },
    append(target, message) {
      refuseIfDisposed();
      (target === "next-step" ? agent._nextStep : agent._nextTurn).push(message);
    },
    prepend(target, message) {
      refuseIfDisposed();
      (target === "next-step" ? agent._nextStep : agent._nextTurn).unshift(message);
    },
    replace(messageId, newMessage) {
      for (const list of [agent._nextTurn, agent._nextStep]) {
        const at = list.findIndex((message) => message.id === messageId);
        if (at !== -1) {
          list[at] = newMessage;
          return true;
        }
      }
      return false;
    },
    remove(messageId) {
      for (const list of [agent._nextTurn, agent._nextStep]) {
        const at = list.findIndex((message) => message.id === messageId);
        if (at !== -1) {
          list.splice(at, 1);
          return true;
        }
      }
      return false;
    },
    splice(target, start, deleteCount, inserted) {
      if (inserted.length > 0) refuseIfDisposed();
      const list = target === "next-step" ? agent._nextStep : agent._nextTurn;
      return list.splice(start, deleteCount, ...inserted);
    },
    claim() {
      const messages = [...agent._nextStep];
      agent._nextStep.length = 0;
      if (agent._nextTurn.length > 0) messages.push(agent._nextTurn.shift());
      return messages;
    },
  };
}

/** Concatenate the text blocks of a claimed message batch. */
function plainText(messages) {
  return messages
    .map((message) =>
      (message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" "),
    )
    .join(" ")
    .trim();
}

/** Deferred promise helper. */
function withResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
