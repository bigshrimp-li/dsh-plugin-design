import { describe, expect, it } from "vitest";
const loaded = [];
globalThis.window = { __ModuleLoader__: { load: value => loaded.push(value) } };
await import("../../src/client/client.settings.js");
const { createSettingsController, mergeDraft, prepareProviderEdit, SECTIONS } = loaded[0].factory();
const configuration = { modelConfiguration: { credentials: [], providers: [], models: [] }, defaultModelConfigId: null,
  context: { autoInstructions: true, maxFileBytes: 65536, maxTotalBytes: 262144, timeoutMs: 2000 }, tools: { enabled: ["read"], approval: "workspace_auto" } };
function fixture(handler, storage) {
  let next = 0; const calls = [];
  const controller = createSettingsController({ transport: { nextRequestId: action => `${action}-${++next}` }, ...(storage ? { storage } : {}), fetchImpl: async (_url, init) => {
    const command = JSON.parse(init.body); calls.push(command);
    const result = await handler?.(command, calls) || (command.action === "targets.list" ? { selectedId: "target-a", targets: [], compatibilityUds: false } : command.action === "settings.get" ? { configuration: structuredClone(configuration), version: 1, instanceId: "core-a" } : command.action === "models.list" ? [] : {});
    return result.httpError ? { ok: false, status: 409, json: async () => ({ error: result.httpError }) } : { ok: true, json: async () => ({ result }) };
  } });
  return { controller, calls };
}
describe("provider editor protocol and authentication boundaries", () => {
  const local = { id: "local", driver: "compatible", protocol: "openai-completions", baseUrl: "http://127.0.0.1:3425/v1", authScheme: "none", credentialRef: "", allowLoopbackHttp: true, protocolOptions: { maxTokensField: "max_tokens" } };
  it("requires explicit loopback HTTP consent and creates a separate no-auth credential without replacing a key", () => {
    expect(() => prepareProviderEdit({ ...local, allowLoopbackHttp: false }, [])).toThrow("明确开启例外");
    expect(prepareProviderEdit(local, [])).toEqual({ entry: { ...local, credentialRef: "local-none" }, credential: { id: "local-none", kind: "none" } });
    expect(() => prepareProviderEdit(local, [{ id: "local-none", kind: "api_key" }])).toThrow("已用于密钥");
    expect(prepareProviderEdit(local, [{ id: "local-none", kind: "none" }]).credential).toBeNull();
  });
  it("rejects remote no-auth, credential-bearing URLs and protocol-incompatible authentication", () => {
    expect(() => prepareProviderEdit({ ...local, baseUrl: "https://api.example.com/v1" }, [])).toThrow("仅适用于本机回环");
    expect(() => prepareProviderEdit({ ...local, baseUrl: "https://user:secret@localhost/v1" }, [])).toThrow("不带凭据");
    expect(() => prepareProviderEdit({ ...local, authScheme: "x-api-key", credentialRef: "key" }, [])).toThrow("仅适用于 anthropic-messages");
  });
  it("removes protocol-specific fields when the user changes to a native provider", () => {
    expect(prepareProviderEdit({ ...local, driver: "pi_builtin", nativeProvider: "openai", credentialRef: "key" }, []).entry).toEqual({ id: "local", driver: "pi_builtin", nativeProvider: "openai", credentialRef: "key", protocolOptions: { maxTokensField: "max_tokens" } });
  });
});
describe("production settings draft", () => {
  it("retains the latest MCP check separately from the activated directory and scopes it to the target", async () => {
    let checks = 0;
    const { controller } = fixture(({ action }) => action === "mcp.check" ? ++checks === 1 ? { status: "connected", protocol: "streamable-http/2025-03-26", tools: [{ name: "record" }] } : { status: "unavailable", errorCode: "MODEL_FAILURE" } : null);
    await controller.load();
    const server = { id: "fixture", url: "https://mcp.example.invalid", enabled: true, credentialRef: null, timeoutMs: 5000 };
    await controller.checkMcp(server);
    expect(controller.getSnapshot().mcpChecks.fixture.result.status).toBe("connected");
    await controller.checkMcp(server);
    expect(controller.getSnapshot().mcpChecks.fixture).toEqual({ server, result: { status: "unavailable", errorCode: "MODEL_FAILURE" } });
    expect(controller.getSnapshot().draft).toEqual(configuration);
    await controller.targetAction("select", { targetId: "target-b" });
    expect(controller.getSnapshot().mcpChecks).toEqual({});
  });
  it("does not publish a late MCP check after the target settings were reloaded", async () => {
    let resolveCheck;
    const { controller } = fixture(({ action }) => action === "mcp.check" ? new Promise(resolve => { resolveCheck = resolve; }) : null);
    await controller.load();
    const check = controller.checkMcp({ id: "fixture", url: "https://mcp.example.invalid" });
    await controller.load();
    resolveCheck({ status: "connected", tools: [{ name: "record" }] });
    await check;
    expect(controller.getSnapshot().mcpChecks).toEqual({});
  });
  it("has seven sections and keeps cross-section changes in one atomic request", async () => {
    const { controller, calls } = fixture(({ action }) => action === "settings.apply" ? { operationId: "op-a", status: "succeeded", version: 2 } : null);
    await controller.load();
    controller.edit(draft => { draft.context.timeoutMs = 3000; }); controller.setSection("tools");
    controller.edit(draft => { draft.tools.approval = "approve_all"; });
    expect(SECTIONS).toHaveLength(7); expect(controller.getSnapshot().changes).toHaveLength(2);
    await controller.apply();
    expect(calls.find(call => call.action === "settings.apply").payload).toMatchObject({ expectedVersion: 1, targetId: "target-a", configuration: { context: { timeoutMs: 3000 }, tools: { approval: "approve_all" } } });
  });
  it("preserves a conflicting draft and requires explicit decisions for conflicting fields", async () => {
    let reads = 0;
    const { controller } = fixture(({ action }) => {
      if (action === "settings.get" && ++reads > 1) return { configuration: { ...structuredClone(configuration), context: { ...configuration.context, timeoutMs: 4000 } }, version: 2, instanceId: "core-a" };
      if (action === "settings.apply") return { httpError: { code: "VERSION_CONFLICT", message: "changed" } };
    });
    await controller.load(); controller.edit(draft => { draft.context.timeoutMs = 3000; }); await controller.apply();
    expect(controller.getSnapshot().draft.context.timeoutMs).toBe(3000);
    expect(controller.getSnapshot().conflict.conflicts).toMatchObject([{ field: "context.timeoutMs", before: 2000, server: 4000, after: 3000 }]);
    expect(() => controller.resolveConflict()).toThrow("选择服务端值");
    controller.resolveConflict({ "context.timeoutMs": "mine" });
    expect(controller.getSnapshot()).toMatchObject({ version: 2, draft: { context: { timeoutMs: 3000 } }, conflict: null });
  });
  it("queries the original operation after an unknown transport result and does not submit a new command", async () => {
    const { controller, calls } = fixture(({ action }) => { if (action === "settings.apply") throw new Error("disconnected"); if (action === "settings.operation") return { operationId: "settings.apply-1", status: "succeeded", version: 2 }; });
    await controller.load(); controller.edit(draft => { draft.context.timeoutMs = 3000; }); await controller.apply();
    await controller.queryOperation();
    expect(calls.filter(call => call.action === "settings.apply")).toHaveLength(1);
    expect(calls.find(call => call.action === "settings.operation").payload.operationId).toBe("settings.apply-1");
  });
  it("merges independent server fields without discarding the user's changes", () => {
    expect(mergeDraft({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 })).toEqual({ merged: { a: 2, b: 2 }, conflicts: [] });
  });
  it("restores a non-secret cross-section draft after a fresh client starts on the same instance", async () => {
    const records = new Map(), storage = { getItem: key => records.get(key), setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
    const first = fixture(null, storage); await first.controller.load(); first.controller.edit(draft => { draft.context.timeoutMs = 3000; });
    const second = fixture(null, storage); await second.controller.load();
    expect(second.controller.getSnapshot()).toMatchObject({ version: 1, instanceId: "core-a", draft: { context: { timeoutMs: 3000 } } });
    expect(second.controller.getSnapshot().note).toContain("已恢复此目标");
  });
});

it("does not discard an unknown operation or release its prepared credential reference", async () => {
  const { controller, calls } = fixture(({ action }) => { if (action === "settings.apply") throw new Error("transport outcome unknown"); if (action === "settings.operation") return { operationId: "settings.apply-1", status: "succeeded", version: 2 }; });
  await controller.load(); controller.edit(draft => { draft.modelConfiguration.credentials.push({ id: "staged-id", kind: "api_key", source: { type: "credential_store", ref: "prepared-ref" } }); });
  await controller.apply();
  expect(controller.getSnapshot().unconfirmedOperation).toBe(true);
  const before = structuredClone(controller.getSnapshot().draft);
  await expect(controller.abandon()).rejects.toThrow("先查询原操作");
  await expect(controller.targetAction("remove", { targetId: "target-a" })).rejects.toThrow("先查询原操作");
  await expect(controller.call("targets.save", { targetId: "target-a", baseUrl: "https://new.example.invalid" })).rejects.toThrow("先查询原操作");
  expect(controller.getSnapshot().draft).toEqual(before);
  expect(calls.some(call => call.action === "credentials.release" || call.action === "targets.remove" || call.action === "targets.save")).toBe(false);
  await controller.targetAction("pair", { targetId: "target-a", pairingCode: "replacement-login", actorId: "same-operator" });
  expect(calls.find(call => call.action === "targets.pair").payload.expectedInstanceId).toBe("core-a");
  expect(controller.getSnapshot().draft).toEqual(before);
  await controller.queryOperation();
  expect(calls.find(call => call.action === "settings.operation").payload.operationId).toBe("settings.apply-1");
  expect(calls.filter(call => call.action === "settings.apply")).toHaveLength(1);
  expect(controller.getSnapshot().unconfirmedOperation).toBe(false);
});
