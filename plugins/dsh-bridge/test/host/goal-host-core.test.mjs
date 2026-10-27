import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const textOf = message => typeof message?.content === "string" ? message.content : (message?.content || []).map(item => item.text || "").join("");
const reply = (text, command) => ({ id: "native-goal-fixture", model: "native-goal-model", choices: [{ index: 0, message: { role: "assistant", content: text,
  ...(command ? { tool_calls: [{ id: "proof-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] } : {}) }, finish_reason: command ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

async function waitFor(read, predicate, label) {
  const end = Date.now() + 20000; let last;
  while (Date.now() < end) { last = await read(); if (predicate(last)) return last; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
async function fixture() {
  expect(process.versions.electron).toBeTruthy();
  const root = process.env.SUPER_AGENT_SOURCE_ROOT;
  // Chord declares an import-only public export; require.resolve would select the wrong condition.
  const chordRoot = join(root, "node_modules/@earendil-works/chord");
  const contextExport = JSON.parse(await readFile(join(chordRoot, "package.json"), "utf8")).exports["./context"];
  const contextEntry = typeof contextExport === "string" ? contextExport : contextExport?.import;
  if (typeof contextEntry !== "string") throw new Error("Chord must declare its public ./context ESM entry");
  const [{ CoreServer, createConfiguredGoServingFactory, initialSettings }, { createClient }, { BACKGROUND_CONTEXT }, { createCoreService }] = await Promise.all([
    import(pathToFileURL(join(root, "packages/server/dist/index.js")).href),
    import(pathToFileURL(join(root, "packages/client/dist/index.js")).href),
    import(pathToFileURL(join(chordRoot, contextEntry)).href),
    import("../../dist/host/core-service.js"),
  ]);
  const home = await realpath(await mkdtemp("/tmp/sa-native-goal-")); cleanups.push(() => rm(home, { recursive: true, force: true }));
  const requests = [];
  const upstream = createServer((request, res) => { void (async () => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); requests.push(body);
    const serialized = JSON.stringify(body), verify = serialized.includes("Independently verify a candidate goal completion."), evaluate = serialized.includes("You evaluate progress toward a user-authorized goal.");
    let output;
    if (verify || evaluate) {
      const input = JSON.parse(textOf(body.messages.filter(message => message.role === "user").at(-1)));
      const evidenceRefs = input.allowedEvidenceRefs;
      output = reply(JSON.stringify({ decision: verify ? "pass" : "candidate_complete", summary: "Verified native Host committed shell proof", nextStep: "", blockerKey: "", evidenceRefs, gaps: [], completedItems: ["native proof"], remainingItems: [],
        ...(verify ? { criteria: input.acceptanceCriteria.map(item => ({ criterionId: item.id, verdict: "pass", evidenceRefs })) } : {}) }));
    } else {
      const last = body.messages.filter(message => !(message.role === "user" && textOf(message).startsWith("<runtime-goal-context>"))).at(-1);
      output = last?.role === "tool" ? reply("NATIVE_GOAL_WORK_DONE") : reply("", serialized.includes("CANCEL_NATIVE_FIXTURE") ? "printf started > native-goal-tool-started; sleep 10; printf CANCEL_NATIVE_FIXTURE" : "printf NATIVE_COMMITTED_PROOF");
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(output));
  })().catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }); });
  await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const configuration = { schemaVersion: 1, agent: { name: "Native Goal Host fixture", mission: "Produce and verify fixture proof" },
    modelConfiguration: { schemaVersion: 1, app: { name: "native-goal-fixture", version: "1" }, credentials: [{ id: "fixture", kind: "api_key", source: { type: "env", name: "NATIVE_GOAL_FIXTURE_KEY" } }],
      providers: [{ id: "fixture", driver: "compatible", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, credentialRef: "fixture", authScheme: "bearer", allowLoopbackHttp: true, protocolOptions: { maxTokensField: "max_tokens" } }],
      models: [{ id: "fixture-model", providerRef: "fixture", modelId: "native-goal-model", definition: { source: "explicit", contextWindow: 16384, maxOutputTokens: 1024, capabilities: { input: ["text"], tools: true, thinking: false, toolResultImages: "unsupported" } }, generation: { maxOutputTokens: 256, reasoning: { mode: "provider_default" } } }],
      requestPolicy: { totalTimeoutMs: 5000, streamIdleTimeoutMs: 2000, maxAttempts: 1 } }, maxConcurrentRuns: 2, retention: { maxEvents: 1000, maxAgeMs: null }, firstAdmissionCredentialRefs: ["fixture"] };
  const settings = initialSettings(configuration.modelConfiguration);
  const server = new CoreServer({ home, heartbeatIntervalMs: 50, runtime: createConfiguredGoServingFactory({ context: BACKGROUND_CONTEXT, configuration,
    env: { NATIVE_GOAL_FIXTURE_KEY: "synthetic-loopback-only" }, binaryPath: process.env.SUPER_AGENT_GO_RUNTIME_BINARY || join(root, "go-runtime/bin/runtime-worker"), enableBuiltinTools: true, runtimeSettings: () => settings }) });
  cleanups.push(() => server.stop()); await server.start();
  const sdk = createClient({ socketPath: server.info().socketPath, caller: "native-dsh-goal-integration", heartbeatIntervalMs: 50 });
  const bridge = createCoreService({ client: sdk, options: { home: join(home, "bridge"), socketPath: server.info().socketPath } });
  const workspaceRoot = join(home, "workspace"); await mkdir(workspaceRoot);
  const workspace = await sdk.registerWorkspace({ requestId: "workspace", root: workspaceRoot });
  const thread = await sdk.createThread({ requestId: "thread", agentId: "main", modelId: "native-goal-model", workspaceId: workspace.workspaceId, cwd: workspaceRoot, permissionMode: "approve_none" });
  return { bridge, sdk, requests, thread, workspaceRoot };
}

describe.skipIf(!process.versions.electron || !process.env.SUPER_AGENT_SOURCE_ROOT)("native DSH Host → public SDK → real Go Goal", () => {
  it("creates, executes real tools, evaluates, independently verifies and preserves the original receipt", async () => {
    const f = await fixture(), payload = { requestId: "native-goal-create", conversationId: f.thread.mainConversationId, objective: "Produce committed native Host proof and verify it", acceptanceCriteria: [{ id: "proof", description: "Committed shell output contains NATIVE_COMMITTED_PROOF" }], limits: { totalTokens: 100000, maxIterations: 3, maxModelRequests: 12 } };
    const receipt = await f.bridge.call("goal.create", payload);
    expect(receipt).toMatchObject({ requestId: payload.requestId, state: "accepted", goalId: expect.any(String), receiptSeq: expect.any(Number) });
    expect(await f.bridge.call("goal.create", payload)).toEqual(receipt);
    const goal = await waitFor(() => f.bridge.call("goal.get", { goalId: receipt.goalId }), value => value.status === "completed", "goal completion");
    expect(goal.budget).toMatchObject({ settledTokens: 60, reservedTokens: 0, uncertainTokens: 0, modelRequests: 4 });
    expect(goal.checkpoint.evidenceRefs.length).toBeGreaterThan(0);
    expect(f.requests.filter(body => JSON.stringify(body).includes("You evaluate progress toward a user-authorized goal."))).toHaveLength(1);
    expect(f.requests.filter(body => JSON.stringify(body).includes("Independently verify a candidate goal completion."))).toHaveLength(1);
    expect(await f.bridge.call("goal.create", payload)).toEqual(receipt);
  });
  it("cancels an actual running Goal tool through the Host and reuses its original control receipt", async () => {
    const f = await fixture();
    const receipt = await f.bridge.call("goal.create", { requestId: "native-goal-cancel-create", conversationId: f.thread.mainConversationId, objective: "CANCEL_NATIVE_FIXTURE", limits: { totalTokens: 100000, maxIterations: 3, maxModelRequests: 12 } });
    await waitFor(async () => {
      const executions = await f.sdk.listExecutions(f.thread.threadId);
      const started = await readFile(join(f.workspaceRoot, "native-goal-tool-started"), "utf8").catch(() => "");
      return { executions, started };
    }, value => value.started === "started" && value.executions.some(item => item.toolName === "bash" && item.status === "running"), "running shell with actual start marker");
    const current = await f.bridge.call("goal.get", { goalId: receipt.goalId });
    const payload = { requestId: "native-goal-cancel", goalId: receipt.goalId, expectedRevision: current.revision, reason: "synthetic integration cancellation" };
    const cancelled = await f.bridge.call("goal.cancel", payload);
    expect(cancelled).toMatchObject({ requestId: payload.requestId, state: "accepted", goalId: receipt.goalId, receiptSeq: expect.any(Number) });
    await waitFor(() => f.bridge.call("goal.get", { goalId: receipt.goalId }), value => value.status === "cancelled", "cancelled goal");
    expect(await f.bridge.call("goal.cancel", payload)).toEqual(cancelled);
    expect(f.requests.some(body => JSON.stringify(body).includes("Independently verify a candidate goal completion."))).toBe(false);
  });
});
