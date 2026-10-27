/**
 * Scope-routing checks for the bridge's Agent factory, against the *real*
 * Cordis context, SessionStore and scope primitive.
 *
 * The sibling `agent-factory.test.mjs` models the harness with stand-ins, which
 * is enough for publication order and rollback. It cannot check routing,
 * because routing lives in the harness's own scope machinery: the SessionStore
 * keys a session's `session/event` carrier off the scope of the context that
 * called `enter`, and only the real `createScope`/`scopeOf` pair can observe
 * that. So this file loads the harness the machine actually runs — resolved
 * from the installed `dsh` — and drives the factory against it.
 *
 * The load is best-effort on purpose. `@deepseek-ai/dsh-session` is not a
 * dependency of this repository, so a checkout without `dsh` installed cannot
 * run these checks; they are skipped there rather than failing the offline
 * suite. Where `dsh` is present (the machine that runs the profile), they run
 * and pin the routing.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

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
        const { createScope } = await load("dsh-scope");
        return { Context, SessionStore, createScope };
      })();

describe.skipIf(dshRoot === undefined)("session scope routing (real harness)", () => {
  it("delivers an appended event to a session/event listener setup registered on the agent's scoped context", async () => {
    // The factory must publish the session through `agent.ctx`, not the
    // plugin's ctx: the store captures the scope of whichever context called
    // `enter`, and a listener registered on `agent.ctx` during `setup` is
    // filtered against that captured scope. Publishing through the plugin's
    // unscoped ctx routes the event away from it.
    const { Context, SessionStore, createScope } = real;
    const root = new Context();
    new SessionStore(root);

    let factory;
    const enteredAgents = [];
    root.provide("agents", {
      setFactory(registered) {
        factory = registered;
        return () => {};
      },
      enter(agent) {
        enteredAgents.push(agent);
        return () => enteredAgents.pop();
      },
      async announce() {},
    });

    host.setScopePrimitive({ createScope });
    host.applySessionAdapter(root, {});

    const seen = [];
    const created = await factory.createAgent(root, {
      sessionId: "scope-routing-1",
      setup: (agentCtx) => {
        agentCtx.on("session/event", (_session, event) => seen.push(event.type));
      },
    });

    // The scoped context is a distinct object from the plugin's — that identity
    // is what the store's carrier keys off.
    expect(created.agent.ctx).not.toBe(root);
    created.agent.session.append("turn/start", { turn: 1 });

    expect(seen).toEqual(["turn/start"]);
    expect(enteredAgents).toHaveLength(1);

    await created.dispose();
  });
});
