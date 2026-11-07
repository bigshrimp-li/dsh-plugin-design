import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

it.skipIf(!process.versions.electron || !process.env.SUPER_AGENT_SOURCE_ROOT)("separates live UDS execution from paired Go settings and recovers activation after a dropped reply", async () => {
  const root = process.env.SUPER_AGENT_SOURCE_ROOT;
  const home = await realpath(await mkdtemp("/tmp/dsh-setting-"));
  let proc, exit;
  try {
    const keyFile = join(home, "key.pem"), certFile = join(home, "cert.pem"), pairingCodeFile = join(home, "pair"), pairingCode = randomUUID();
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
    await writeFile(pairingCodeFile, pairingCode, { mode: 0o600 });
    const httpsConfig = join(home, "https.json"), config = join(home, "config.json");
    await writeFile(httpsConfig, JSON.stringify({ allowedRoots: [home], host: "127.0.0.1", port: 0, keyFile, certFile, pairingCodeFile }));
    const models = ["first", "second"].map(id => ({ id, providerRef: "fixture", modelId: id, definition: { source: "explicit",
      contextWindow: 16384, maxOutputTokens: 1024, capabilities: { input: ["text"], tools: true, thinking: false, toolResultImages: "unsupported" } },
      generation: { maxOutputTokens: 128, reasoning: { mode: "provider_default" } } }));
    await writeFile(config, JSON.stringify({ schemaVersion: 1, agent: { name: "Fixture", mission: "Settings integration" }, modelConfiguration: {
      schemaVersion: 1, app: { name: "fixture", version: "1" }, credentials: [{ id: "none", kind: "none" }], models, providers: [
        { id: "fixture", driver: "compatible", protocol: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", allowLoopbackHttp: true, credentialRef: "none", authScheme: "none", protocolOptions: {} }],
      requestPolicy: { totalTimeoutMs: 5000, streamIdleTimeoutMs: 2000, maxAttempts: 1 } }, maxConcurrentRuns: 2,
      retention: { maxEvents: 1000, maxAgeMs: null }, firstAdmissionCredentialRefs: [] }));
    proc = spawn(process.execPath, [join(root, "scripts/serve-local-dsh-go.mjs"), "--home", home, "--go-binary",
      join(root, "go-runtime/bin/runtime-worker"), "--config", config, "--https-config", httpsConfig], { stdio: ["ignore", "pipe", "pipe"] });
    exit = new Promise(resolve => proc.once("exit", resolve));
    const baseUrl = await new Promise((resolve, reject) => {
      let output = "";
      const read = chunk => {
        output += chunk;
        const match = output.match(/Super Agent HTTPS ready: (https:\/\/[^\s]+)/);
        if (match) resolve(match[1]);
      };
      proc.stdout.on("data", read); proc.stderr.on("data", read); proc.once("error", reject);
      proc.once("exit", () => reject(new Error("Go settings launcher exited: " + output)));
    });
    const { openTargetService } = await import("../../src/host/target-store.js");
    const { createCoreServiceFor } = await import("../../dist/host/core-service.js");
    const service = await openTargetService({ createService: createCoreServiceFor, options: { home: join(home, "bridge"), socketPath: join(home, "run", "core.sock") } });
    const chunks = []; globalThis.window = { __ModuleLoader__: { load: d => chunks.push(d) } };
    await import("../../src/client/client.settings.js");
    const { createSettingsController } = chunks[0].factory();
    let loseReply = true;
    const sent = [], memory = new Map(), storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) };
    function controller() {
      return createSettingsController({ transport: { nextRequestId: () => randomUUID() }, storage, fetchImpl: async (_url, init) => {
        const { action, payload } = JSON.parse(init.body);
        try {
          const result = await service.call(action, payload);
          if (action === "settings.apply") { sent.push(payload); if (loseReply) { loseReply = false; throw new Error("reply lost"); } }
          return { ok: true, json: async () => ({ result }) };
        } catch (error) { return { ok: false, status: 409, json: async () => ({ error: { code: error.code || "DISCONNECTED", message: error.message } }) }; }
      } });
    }
    const a = controller(); await a.load();
    expect(a.getSnapshot()).toMatchObject({ executionConnection: "connected", configConnection: "unpaired", error: "" });
    const saved = await service.call("targets.save", { name: "Go", baseUrl, ca: await readFile(certFile, "utf8") });
    await service.call("targets.pair", { targetId: saved.id, pairingCode, actorId: "fixture-owner" });
    await a.targetAction("select", { targetId: saved.id });
    const before = a.getSnapshot();
    expect(before).toMatchObject({ executionConnection: "connected", configConnection: "paired" });
    a.edit(draft => { draft.defaultModelConfigId = "second"; }); await a.apply();
    expect(a.getSnapshot().unconfirmedOperation).toBe(true);
    const b = controller(); await b.load(); await b.queryOperation();
    expect(b.getSnapshot()).toMatchObject({ unconfirmedOperation: false, version: before.version + 1, baseline: { defaultModelConfigId: "second" } });
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ expectedVersion: before.version, targetId: saved.id, configuration: { modelConfiguration: { models } } });
    const stale = controller(); await stale.load(); stale.edit(draft => { draft.defaultModelConfigId = "first"; });
    b.edit(draft => { draft.context.timeoutMs += 1; }); await b.apply();
    await stale.apply();
    expect(stale.getSnapshot().conflict).toBeTruthy();
    expect(stale.getSnapshot().draft.defaultModelConfigId).toBe("first");
    await expect(service.call("settings.get", { targetId: saved.id, expectedActorId: "different" })).rejects.toMatchObject({ code: "TARGET_SCOPE_CHANGED" });
  } finally {
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
    if (exit) await exit;
    await rm(home, { recursive: true, force: true });
  }
});
