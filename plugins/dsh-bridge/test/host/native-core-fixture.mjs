import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect } from "vitest";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
export const textOf = message => typeof message?.content === "string" ? message.content : (message?.content || []).map(item => item.text || "").join("");
export async function waitFor(read, predicate, label) {
  const end = Date.now() + 20000; let last;
  while (Date.now() < end) { last = await read(); if (predicate(last)) return last; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
export async function nativeFixture(respond, runtimeEnv = {}) {
  expect(process.versions.electron).toBeTruthy();
  const root = process.env.SUPER_AGENT_SOURCE_ROOT;
  // Chord declares an import-only public export; require.resolve would select the wrong condition.
  const chordRoot = join(root, "node_modules/@earendil-works/chord");
  const contextExport = JSON.parse(await readFile(join(chordRoot, "package.json"), "utf8")).exports["./context"];
  const contextEntry = typeof contextExport === "string" ? contextExport : contextExport?.import;
  if (typeof contextEntry !== "string") throw new Error("Chord must declare its public ./context ESM entry");
  const [{ CoreServer, createConfiguredGoServingFactory, initialSettings }, { createClient }, { BACKGROUND_CONTEXT }, { createCoreServiceFor }] = await Promise.all([
    import(pathToFileURL(join(root, "packages/server/dist/index.js")).href),
    import(pathToFileURL(join(root, "packages/client/dist/index.js")).href),
    import(pathToFileURL(join(chordRoot, contextEntry)).href),
    import("../../dist/host/core-service.js"),
  ]);
  const home = await realpath(await mkdtemp("/tmp/sa-native-host-")); cleanups.push(() => rm(home, { recursive: true, force: true }));
  const requests = [];
  const upstream = createServer((request, res) => { void (async () => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); requests.push(body);
    const output = await respond(body);
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
    runtimeEnv, env: { NATIVE_GOAL_FIXTURE_KEY: "synthetic-loopback-only" }, binaryPath: process.env.SUPER_AGENT_GO_RUNTIME_BINARY || join(root, "go-runtime/bin/runtime-worker"), enableBuiltinTools: true, runtimeSettings: () => settings }) });
  cleanups.push(() => server.stop()); await server.start();
  const socketPath = server.info().socketPath;
  const reconnect = async () => {
    const sdk = createClient({ socketPath, caller: "dsh-super-agent-space", heartbeatIntervalMs: 50 });
    return { sdk, bridge: await createCoreServiceFor({ caller: "dsh-super-agent-space", options: { home: join(home, "bridge"), socketPath } }) };
  };
  const { sdk, bridge } = await reconnect();
  const workspaceRoot = join(home, "workspace"); await mkdir(workspaceRoot);
  const workspace = await sdk.registerWorkspace({ requestId: "workspace", root: workspaceRoot });
  const thread = await sdk.createThread({ requestId: "thread", agentId: "main", modelId: "native-goal-model", workspaceId: workspace.workspaceId, cwd: workspaceRoot, permissionMode: "approve_none" });
  return { bridge, sdk, requests, thread, workspaceRoot, home, socketPath, reconnect };
}
