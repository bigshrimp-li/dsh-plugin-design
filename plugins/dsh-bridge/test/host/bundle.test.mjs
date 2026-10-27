/**
 * Static checks for the dsh bridge bundle.
 *
 * These run under the repository's `npm test` and deliberately do not load the
 * dsh runtime: they assert the manifest contract dsh reads, the patch rows the
 * `alc` profile composes, and the host entry's plugin export shape. Behavioural
 * verification of the echo Agent needs the live harness and is covered by
 * `docs/requirements/p0-skeleton/P0人工检查.md`.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");
const manifest = JSON.parse(await read("../../package.json"));
const lock = JSON.parse(await read("../../../../package-lock.json"));
const bridgeLock = lock.packages?.["plugins/dsh-bridge"];
const patch = await read("../../cordis.patch.yml");
const VALIDATED_DSH_RANGE = "0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.3";

describe("bundle manifest", () => {
  it("declares the patch dsh composes into a profile", () => {
    expect(manifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
  });

  it("points its root export at the host entry", () => {
    expect(manifest.exports?.["."]).toBe("./dist/host/index.js");
  });

  it("points its ./client export at the browser entry", () => {
    expect(manifest.exports?.["./client"]).toBe("./src/client/index.js");
  });

  it("declares the browser platform dsh serves", () => {
    expect(manifest.dsh?.client?.platform).toBe("web");
  });

  it("declares only the two DSH releases verified against this bridge", () => {
    expect(manifest.engines?.dsh).toBe(VALIDATED_DSH_RANGE);
    expect(bridgeLock?.engines?.dsh).toBe(VALIDATED_DSH_RANGE);
  });

  it("declares the scope primitive as an optional peer dependency", () => {
    // The scope tag is a module-private symbol, so the bundle has to reach the
    // *harness's* copy of `@deepseek-ai/dsh-scope`. dsh routes that copy only
    // when the package is declared here as a peer dependency; `optional` keeps
    // npm from trying to install it, since the host provides it. Every other
    // host check injects a stub primitive, so this is the one assertion that
    // fails if the declaration is removed.
    expect(manifest.peerDependencies?.["@deepseek-ai/dsh-scope"]).toBe(VALIDATED_DSH_RANGE);
    expect(bridgeLock?.peerDependencies?.["@deepseek-ai/dsh-scope"]).toBe(VALIDATED_DSH_RANGE);
    expect(manifest.peerDependenciesMeta?.["@deepseek-ai/dsh-scope"]?.optional).toBe(true);
    expect(bridgeLock?.peerDependenciesMeta?.["@deepseek-ai/dsh-scope"]?.optional).toBe(true);
  });
});

describe("cordis patch", () => {
  // Top-level patch rows start at column 0 with "- "; nested list items are indented.
  const rows = patch.split(/\n(?=- )/);

  it("leaves the native agent-loop enabled so DSH keeps its own session factory", () => {
    const row = rows.find((candidate) => candidate.split("\n")[0] === "- id: agent-loop");
    expect(row, "the bridge must not patch the native agent-loop row").toBeUndefined();
  });

  it("inserts the bridge row", () => {
    const row = rows.find((candidate) => candidate.startsWith("- insert:"));
    expect(row, "insert row missing from cordis.patch.yml").toBeDefined();
    expect(row).toMatch(/^\s*- id: super-agent-bridge$/m);
    expect(row).toMatch(/^\s*name: '@super-agent\/dsh-bridge'$/m);
  });
});

describe("host entry", () => {
  it("exports the apply function dsh calls", async () => {
    const host = await import("../../src/host/index.js");
    expect(typeof host.apply).toBe("function");
    expect(host.apply.length).toBeGreaterThanOrEqual(1);
  });

  it("does not inject into the native AgentFactory or Session services", async () => {
    const host = await import("../../src/host/index.js");
    expect(host.inject).toEqual([]);
    expect(host.applySessionAdapter).toBeTypeOf("function");
  });

  it("registers the Core routes without reading the native AgentFactory or Session services", async () => {
    const host = await import("../../src/host/index.js");
    const accesses = [];
    const requestedDependencies = [];
    const paths = [];
    const dshHost = {
      effect(run) {
        return run();
      },
      webServer: {
        register(route) {
          paths.push(route.path);
          return () => {};
        },
      },
    };
    const ctx = new Proxy(
      {
        logger: { error() {}, warn() {} },
        inject(dependencies, callback) {
          requestedDependencies.push(dependencies);
          callback(dshHost);
        },
      },
      {
        get(target, property, receiver) {
          accesses.push(property);
          if (["agents", "sessions", "sessionPersistence"].includes(property)) {
            throw new Error(`production apply requested native DSH service ${String(property)}`);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() => host.apply(ctx)).not.toThrow();
    expect(requestedDependencies).toEqual([["webServer"]]);
    expect(paths).toEqual(expect.arrayContaining(["/super-agent/state", "/super-agent/action", "/super-agent/events"]));
    expect(accesses).not.toContain("agents");
    expect(accesses).not.toContain("sessions");
    expect(accesses).not.toContain("sessionPersistence");
  });
});
