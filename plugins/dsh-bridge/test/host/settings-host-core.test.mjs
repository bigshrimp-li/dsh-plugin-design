import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { localService } from "../../src/host/local-service.js";
import { startGo } from "./go-service.mjs";

it.skipIf(!process.versions.electron || !process.env.SUPER_AGENT_SOURCE_ROOT)("recovers a dropped local configuration receipt on the same Go instance and actor without another write", async () => {
  const home = await realpath(await mkdtemp("/tmp/dsh-setting-"));
  let server;
  try {
    const models = ["first", "second"].map(id => ({ id, providerRef: "fixture", modelId: id, definition: { source: "explicit",
      contextWindow: 16384, maxOutputTokens: 1024, capabilities: { input: ["text"], tools: true, thinking: false, toolResultImages: "unsupported" } },
      generation: { maxOutputTokens: 128, reasoning: { mode: "provider_default" } } }));
    await writeFile(join(home, "serving-config.json"), JSON.stringify({ schemaVersion: 1, agent: { name: "Fixture", mission: "Settings integration" }, modelConfiguration: {
      schemaVersion: 1, app: { name: "fixture", version: "1" }, credentials: [{ id: "none", kind: "none" }], models, providers: [
        { id: "fixture", driver: "compatible", protocol: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", allowLoopbackHttp: true, credentialRef: "none", authScheme: "none", protocolOptions: {} }],
      requestPolicy: { totalTimeoutMs: 5000, streamIdleTimeoutMs: 2000, maxAttempts: 1 } }, maxConcurrentRuns: 2,
      retention: { maxEvents: 1000, maxAgeMs: null }, firstAdmissionCredentialRefs: [] }));
    const caller = "dsh-super-agent-space";
    server = await startGo(home, caller);
    const info = await server.sdk.getServerInfo();
    const targetId = "local-go:" + info.instanceId;
    const service = localService({ options: { home, socketPath: server.options.socketPath }, ensure: () => server.sdk.getServerInfo() });
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
    const before = a.getSnapshot();
    expect(before).toMatchObject({ local: true, selectedId: targetId, instanceId: info.instanceId,
      executionConnection: "connected", configConnection: "paired", error: "",
      targets: [{ id: targetId, actorId: caller, connectionKind: "uds", baseUrl: server.options.socketPath }] });
    a.edit(draft => { draft.defaultModelConfigId = "second"; }); await a.apply();
    expect(a.getSnapshot().unconfirmedOperation).toBe(true);
    const b = controller(); await b.load(); await b.queryOperation();
    expect(b.getSnapshot()).toMatchObject({ unconfirmedOperation: false, version: before.version + 1, baseline: { defaultModelConfigId: "second" } });
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ expectedVersion: before.version, targetId, expectedActorId: caller, expectedInstanceId: info.instanceId, configuration: { modelConfiguration: { models } } });
    const stale = controller(); await stale.load(); stale.edit(draft => { draft.defaultModelConfigId = "first"; });
    b.edit(draft => { draft.context.timeoutMs += 1; }); await b.apply();
    await stale.apply();
    expect(stale.getSnapshot().conflict).toBeTruthy();
    expect(stale.getSnapshot().draft.defaultModelConfigId).toBe("first");
    await expect(service.call("settings.get", { targetId, expectedActorId: "different" })).rejects.toMatchObject({ code: "TARGET_SCOPE_CHANGED" });
  } finally {
    await server?.stop();
    await rm(home, { recursive: true, force: true });
  }
});
