/**
 * Initialization-cancellation checks for the bridge's Agent factory, against
 * the *real* Cordis context, the real SessionStore and the real AgentRegistry.
 *
 * The sibling `agent-factory.test.mjs` models the harness with stand-ins, which
 * is enough to pin the publication order and the effect accounting. It cannot
 * pin cancellation, because cancellation is where the bridge meets machinery it
 * does not own: Cordis's effect teardown, the SessionStore's session entry, and
 * the AgentRegistry's `announcing`/`detachRequested` contract — the registry
 * keeps an entry in its store until the `agent/created` dispatch it is running
 * settles, and no stand-in reproduces that. So this file loads the harness the
 * machine actually runs, resolved from the installed `dsh`, and drives the
 * factory against it.
 *
 * The load is best-effort, like the scope-routing checks beside it:
 * `@deepseek-ai/dsh-agent` is not a dependency of this repository, so a
 * checkout without `dsh` installed skips these rather than failing the offline
 * suite. Where `dsh` is present — the machine that runs the profile — they run.
 *
 * Every scenario here has the same shape: a step of the initialization is held
 * open by something outside the bridge, one of the three lifetimes ends, and
 * the factory has to be done anyway. "Done" is not "the step finished" — it is
 * a prompt rejection, nothing published, and no resource left open, without
 * waiting on the promise that is never going to settle.
 *
 * "Nothing published" is about what the bridge can do, and the registry entry
 * is the one part of it the bridge does not own. `AgentRegistry.enter`'s detach
 * closure only records the request while an `agent/created` dispatch is in
 * flight, so a listener that never lets go keeps a disposed agent reachable
 * until it does. That is a host limitation with a public shape — there is no
 * API to evict an entry mid-dispatch — and the checks below assert it where it
 * applies rather than claiming an empty registry everywhere.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const host = await import("../../src/host/index.js");

/** Locate the installed `dsh` package that carries the real harness modules. */
function locateDsh() {
  const candidates = [];
  if (process.env.DSH_INSTALL_ROOT !== undefined) candidates.push(process.env.DSH_INSTALL_ROOT);
  try {
    candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@deepseek-ai", "dsh"));
  } catch {
    // `npm` may be absent; the env override is then the only route.
  }
  return candidates.find((root) =>
    existsSync(join(root, "node_modules", "@deepseek-ai", "dsh-session", "lib", "index.js")),
  );
}

const dshRoot = locateDsh();

/** The real harness modules, loaded by absolute path from the install. */
const real =
  dshRoot === undefined
    ? undefined
    : await (async () => {
        const modules = join(dshRoot, "node_modules", "@deepseek-ai");
        const load = (name, file = "index.js") => import(pathToFileURL(join(modules, name, "lib", file)).href);
        const { Context } = await load("cordis");
        const { default: SessionStore } = await load("dsh-session");
        const { default: AgentRegistry } = await load("dsh-agent");
        const { createScope } = await load("dsh-scope");
        return { Context, SessionStore, AgentRegistry, createScope };
      })();

/**
 * Rejections nothing caught.
 *
 * A cancellation abandons promises that are still running — a `setup` that is
 * still pending, a `persistence.create` that has not returned — and the one
 * thing a bridge must not do with an abandoned promise is let its rejection
 * reach the process as an unhandled rejection. Every scenario below asserts the
 * list is still empty after it settles.
 */
const unhandled = [];
const recordUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", recordUnhandled);
afterEach(async () => {
  // Unhandled-rejection reporting lands a turn after the queue drains.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(unhandled.splice(0)).toEqual([]);
});

/** Resolve after `ms`, for a race that has to distinguish "hung" from "slow". */
function after(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Settle `promise` into a tag, or report that it never settled in time. */
function settleWithin(promise, ms) {
  return Promise.race([
    promise.then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", error }),
    ),
    after(ms).then(() => ({ kind: "hung" })),
  ]);
}

/**
 * Boot the real harness, apply the bridge to it, and hand back what the checks
 * need to observe: the root context, the plugin's own fiber (disposing it is a
 * plugin unload), the factory, and every scope the factory minted.
 */
async function boot({ persistence } = {}) {
  const { Context, SessionStore, AgentRegistry, createScope } = real;
  const root = new Context();
  new SessionStore(root);
  new AgentRegistry(root);
  if (persistence !== undefined) root.provide("sessionPersistence", persistence);

  const minted = [];
  host.setScopePrimitive({
    createScope(ctx, key) {
      const scope = createScope(ctx, key);
      const record = { key, disposed: 0 };
      minted.push(record);
      return {
        ctx: scope.ctx,
        rawDispose: scope.rawDispose,
        dispose: () => {
          record.disposed += 1;
          return scope.dispose();
        },
      };
    },
  });

  const plugin = root.plugin({
    name: "dsh-bridge-test-session-adapter",
    inject: ["agents", "sessions"],
    apply(pluginCtx) {
      host.applySessionAdapter(pluginCtx, {});
    },
  });
  await plugin;
  // The registry stores the canonicalised factory behind a wrapper; the bridge
  // is what these checks drive, so take it out of the wrapper.
  const registered = root.agents.requireFactory();
  return { root, plugin, minted, factory: registered.target ?? registered };
}

/**
 * A caller whose lifetime is a real Cordis fiber, with a count of the effects
 * the factory registered on it and has not retired.
 *
 * The owner context the factory is handed is a thin delegate over the real one,
 * so `effect` runs the real Cordis registration and teardown while the check
 * can still see whether the bridge let go: an effect left behind by a
 * cancellation is a registration that outlives the agent it was for.
 */
async function caller(root) {
  let inner;
  const fiber = root.plugin((ctx) => {
    inner = ctx;
  });
  await fiber;
  const live = new Set();
  const ctx = {
    effect(run, label) {
      const entry = { label };
      live.add(entry);
      const disposer = inner.effect(run, label);
      return () => {
        live.delete(entry);
        return disposer();
      };
    },
  };
  const disposeFiber = fiber.dispose.bind(fiber);
  return {
    ctx,
    live,
    /** Unload the caller. Nothing it owned is live afterwards. */
    async dispose() {
      const result = await disposeFiber();
      live.clear();
      return result;
    },
  };
}

/**
 * A persistence handle stand-in that counts its closes.
 *
 * `readHold` turns it into a *cooperating* backend: the read watches the signal
 * it was handed and rejects on abort, which is what lets a check observe that
 * the signal reaching it is the transaction's fused one rather than only the
 * caller's.
 * @param id - the session id the handle belongs to.
 * @param readHold - a deferred resolved when the read has started, if the read
 *   should hold until its signal aborts.
 * @returns the handle stand-in.
 */
function fakeHandle(id, readHold) {
  const handle = {
    id,
    closed: 0,
    /** The signal the last `read` was handed. */
    readSignal: undefined,
    header: { version: 4, id, isSeeded: false },
    inheritedEventCount: 0,
    async append() {},
    async read(_from, _to, options) {
      handle.readSignal = options?.signal;
      if (readHold === undefined) return { events: [], eventState: "shared-frozen" };
      readHold.resolve();
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
      return { events: [], eventState: "shared-frozen" };
    },
    async close() {
      this.closed += 1;
    },
  };
  return handle;
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

describe.skipIf(dshRoot === undefined)("initialization cancellation (real harness)", () => {
  it("does not start queued persistence work after synchronous caller abort", async () => {
    let creates = 0;
    const { factory, root } = await boot({ persistence: {
      async create() { creates += 1; return fakeHandle("queued-abort"); },
    } });
    const owner = await caller(root);
    const controller = new AbortController();
    const reason = new Error("caller cancelled before the microtask");
    const creating = factory.createAgent(owner.ctx, { sessionId: "queued-abort", signal: controller.signal });
    controller.abort(reason);
    const outcome = await settleWithin(creating, 500);
    expect(outcome.kind).toBe("rejected");
    expect(creates).toBe(0);
    await owner.dispose();
  });

  it("rejects a create whose setup never settles when its owner unloads", async () => {
    // The lifecycle effect is registered before `setup` is awaited, so an owner
    // can unload while `setup` is still pending — and `setup` is somebody
    // else's promise. Waiting for it to settle is waiting forever; the factory
    // has to reject on the owner's teardown instead.
    const { root, factory, minted } = await boot();
    const owner = await caller(root);
    const started = deferred();
    const created = factory.createAgent(owner.ctx, {
      sessionId: "cancel-setup",
      setup: () => {
        started.resolve();
        return new Promise(() => {});
      },
    });
    created.catch(() => {});
    await started.promise;

    const outcome = settleWithin(created, 500);
    await owner.dispose();

    const settled = await outcome;
    expect(settled).toMatchObject({ kind: "rejected" });
    expect(String(settled.error)).toMatch(/owner disposed during setup/);
    // Nothing was published, and the agent's scope went with it.
    expect(root.agents.get("cancel-setup")).toBeUndefined();
    expect(root.agents.store.size).toBe(0);
    expect(minted.map((record) => record.disposed)).toEqual([1]);
    expect(owner.live.size).toBe(0);
  });

  it("rejects a create whose agent/created listener never lets go, without waiting for it", async () => {
    // The registry keeps a creating agent in its store until the `agent/created`
    // dispatch settles — `detach()` during `announcing` only records the
    // request. So a listener that never resolves is exactly the case where a
    // factory that waits for the announcement strands a disposed agent in the
    // real registry. It must reject on the owner's teardown, request the detach
    // immediately, and let the entry leave when the listener finally lets go.
    const { root, factory, minted } = await boot();
    const owner = await caller(root);
    const gate = deferred();
    const announced = deferred();
    let seen;
    root.on("agent/created", (payload) => {
      seen = payload;
      announced.resolve();
      return gate.promise;
    });

    const created = factory.createAgent(owner.ctx, { sessionId: "cancel-announce" });
    created.catch(() => {});
    await announced.promise;
    // The agent is entered and the dispatch is in flight; the listener holds it.
    expect(root.agents.get("cancel-announce")).toBeDefined();

    const outcome = settleWithin(created, 500);
    await owner.dispose();
    expect(await outcome).toMatchObject({ kind: "rejected" });

    // The listener was handed the transaction's own signal, and it is aborted:
    // every reason this initialization can end reaches whoever is listening,
    // not just the caller's own.
    expect(seen.signal.aborted).toBe(true);
    // The agent is already disposed even though the registry cannot drop it yet.
    expect(minted.map((record) => record.disposed)).toEqual([1]);

    // A HOST LIMITATION, asserted rather than assumed: the entry is still in the
    // store, and this bridge cannot remove it. `AgentRegistry.enter`'s detach
    // closure sets `detachRequested` and returns while `announcing` is true, and
    // only `announce`'s own `finally` calls `detachEntered`. There is no public
    // API to evict an entry mid-dispatch, so a listener that ignores the signal
    // keeps a disposed agent reachable for as long as it likes. What the bridge
    // owes is that the agent is *disposed* and the detach *requested* — not that
    // the registry is empty, which it is not, here, on purpose.
    expect(root.agents.get("cancel-announce")).toBeDefined();

    // Releasing the listener completes the dispatch; the detach the teardown
    // requested runs in the registry's own `finally`, with nobody else asking.
    gate.resolve();
    await after(20);
    expect(root.agents.get("cancel-announce")).toBeUndefined();
    expect(root.agents.store.size).toBe(0);
    expect(owner.live.size).toBe(0);
  });

  it("drops a setup result that arrives after the owner is gone instead of committing it", async () => {
    // `setup` may still be running when the owner unloads. Whatever it returns
    // afterwards belongs to an initialization that is over: committing it would
    // apply a caller's changes to an agent that has already been disposed.
    const { root, factory } = await boot();
    const owner = await caller(root);
    const started = deferred();
    const result = deferred();
    let committed = 0;
    const created = factory.createAgent(owner.ctx, {
      sessionId: "cancel-commit",
      setup: () => {
        started.resolve();
        return result.promise.then(() => ({
          commit() {
            committed += 1;
          },
        }));
      },
    });
    created.catch(() => {});
    await started.promise;

    const outcome = settleWithin(created, 500);
    await owner.dispose();
    expect(await outcome).toMatchObject({ kind: "rejected" });

    // The late result settles into nothing: no commit, no registry entry.
    result.resolve();
    await after(20);
    expect(committed).toBe(0);
    expect(root.agents.get("cancel-commit")).toBeUndefined();
    expect(root.agents.store.size).toBe(0);
  });

  it("closes a persistence handle that arrives after the plugin unloaded", async () => {
    // The window between `persistence.create` being called and its handle
    // coming back belongs to nobody: no agent exists yet, so a sweep that only
    // knows about published agents misses it entirely, and the handle stays
    // open for the life of the process.
    const created = deferred();
    const handle = fakeHandle("cancel-late-handle");
    const { root, plugin, factory } = await boot({
      persistence: {
        create: () => created.promise,
        open: () => created.promise,
      },
    });
    const owner = await caller(root);

    const outcome = settleWithin(
      factory.createAgent(owner.ctx, { sessionId: "cancel-late-handle" }),
      500,
    );
    // Unload the plugin while `create` is still outstanding. The caller stays
    // alive: the transaction is the plugin's, so it must not need the caller.
    await plugin.dispose();
    expect(await outcome).toMatchObject({ kind: "rejected" });

    // The handle arrives into a plugin that is gone. Nothing is waiting for it,
    // so the transaction that opened it is the only thing that can close it.
    created.resolve(handle);
    await after(20);
    expect(handle.closed).toBe(1);
    expect(root.agents.get("cancel-late-handle")).toBeUndefined();
    expect(root.agents.store.size).toBe(0);
    expect(owner.live.size).toBe(0);
  });

  it("cancels a create still in setup when the plugin unloads, and closes its handle", async () => {
    // The caller outlives the plugin. Without a transaction that starts at the
    // beginning of the initialization, the plugin's unload would find nothing
    // to sweep and the create would finish into a plugin that is gone —
    // entering an agent into a registry nobody will sweep again.
    const handle = fakeHandle("cancel-plugin-setup");
    const { root, plugin, factory, minted } = await boot({
      persistence: { create: async () => handle, open: async () => handle },
    });
    const owner = await caller(root);
    const started = deferred();
    const created = factory.createAgent(owner.ctx, {
      sessionId: "cancel-plugin-setup",
      setup: () => {
        started.resolve();
        return new Promise(() => {});
      },
    });
    created.catch(() => {});
    await started.promise;

    const outcome = settleWithin(created, 500);
    await plugin.dispose();
    expect(await outcome).toMatchObject({ kind: "rejected" });

    expect(handle.closed).toBe(1);
    expect(minted.map((record) => record.disposed)).toEqual([1]);
    expect(root.agents.get("cancel-plugin-setup")).toBeUndefined();
    expect(root.agents.store.size).toBe(0);
    // The caller is still alive and kept nothing: the effect the factory
    // registered on it was retired by the sweep, not left to the caller's own
    // teardown, which has not run.
    expect(owner.live.size).toBe(0);

    // And the caller's own unload is then a no-op rather than a second teardown.
    await owner.dispose();
    expect(handle.closed).toBe(1);
  });

  it("rejects a create on the caller's own signal without publishing anything", async () => {
    // The third lifetime: the caller can abandon its own create. It must end
    // the initialization the same way an owner or plugin unload does, since the
    // three mean the same thing to everything downstream.
    const handle = fakeHandle("cancel-caller-signal");
    const { root, factory, minted } = await boot({
      persistence: { create: async () => handle, open: async () => handle },
    });
    const owner = await caller(root);
    const started = deferred();
    const controller = new AbortController();
    const created = factory.createAgent(owner.ctx, {
      sessionId: "cancel-caller-signal",
      signal: controller.signal,
      setup: () => {
        started.resolve();
        return new Promise(() => {});
      },
    });
    created.catch(() => {});
    await started.promise;

    const outcome = settleWithin(created, 500);
    controller.abort(new Error("caller gave up"));
    expect(await outcome).toMatchObject({ kind: "rejected" });

    expect(handle.closed).toBe(1);
    expect(minted.map((record) => record.disposed)).toEqual([1]);
    expect(root.agents.store.size).toBe(0);
    expect(owner.live.size).toBe(0);
  });

  it("rejects a resume whose persistence open never returns when the plugin unloads", async () => {
    // `resume` reaches its handle through `open`, and the same window applies:
    // there is no agent, no registry entry, and nothing for a published-agent
    // sweep to find until the handle comes back.
    const opened = deferred();
    const handle = fakeHandle("cancel-resume");
    const { root, plugin, factory } = await boot({
      persistence: { create: async () => handle, open: () => opened.promise },
    });
    const owner = await caller(root);

    const outcome = settleWithin(
      factory.resume(owner.ctx, { resumeSessionId: "cancel-resume" }),
      500,
    );
    await plugin.dispose();
    expect(await outcome).toMatchObject({ kind: "rejected" });

    opened.resolve(handle);
    await after(20);
    expect(handle.closed).toBe(1);
    expect(root.agents.store.size).toBe(0);
    expect(owner.live.size).toBe(0);
  });

  it("rejects a create whose owner unloads while a cooperating backend is creating it", async () => {
    // The owner is associated with the transaction before its first step, so
    // an owner that unloads while `persistence.create` is still running stops
    // the factory — and a backend that watches the signal it was handed hears
    // about it, rather than being left to finish into a context that is gone.
    // What the backend is handed is the transaction's fused signal: the owner's
    // unload is not the caller's abort, and the caller is not the only lifetime
    // that can end this initialization.
    const started = deferred();
    const handles = [];
    const { root, factory } = await boot({
      persistence: {
        create: async (header, options) => {
          const handle = fakeHandle(header.id);
          handles.push(handle);
          started.resolve(options.signal);
          await new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
          });
          return handle;
        },
        open: async () => fakeHandle("unused"),
      },
    });
    const owner = await caller(root);
    const created = factory.createAgent(owner.ctx, { sessionId: "owner-create" });
    created.catch(() => {});
    const handed = await started.promise;

    const outcome = settleWithin(created, 500);
    await owner.dispose();

    expect(await outcome).toMatchObject({ kind: "rejected" });
    // The signal the backend holds is aborted, so a cooperating create does not
    // have to be waited for — it is told.
    expect(handed).toBeInstanceOf(AbortSignal);
    expect(handed.aborted).toBe(true);
    expect(String(handed.reason)).toMatch(/owner disposed during initialization/);
    // The handle was never returned, so there is nothing the factory could have
    // closed; the backend still holds its own.
    expect(root.agents.store.size).toBe(0);
    expect(owner.live.size).toBe(0);
  });

  it("aborts a resume's read when the owner unloads while the backend is reading", async () => {
    // A read is where a cooperating backend is most likely to hold a step open,
    // so it is where the fused signal has to reach: an owner that unloads while
    // the handle is reading has to stop the read, not wait for a page of events
    // nobody will ever finish.
    const reading = deferred();
    const handle = fakeHandle("owner-read", reading);
    const { root, factory } = await boot({
      persistence: {
        create: async () => handle,
        open: async () => handle,
      },
    });
    const owner = await caller(root);
    const created = factory.resume(owner.ctx, { resumeSessionId: "owner-read" });
    created.catch(() => {});
    await reading.promise;

    const outcome = settleWithin(created, 500);
    await owner.dispose();

    expect(await outcome).toMatchObject({ kind: "rejected" });
    expect(handle.readSignal.aborted).toBe(true);
    // The handle the transaction opened is closed by the transaction.
    expect(handle.closed).toBe(1);
    expect(root.agents.store.size).toBe(0);
    expect(owner.live.size).toBe(0);
  });
});
