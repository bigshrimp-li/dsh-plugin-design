import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createClient } from "@super-agent/client";
import { startGo, configureModel } from "./go-service.mjs";
import { createCoreServiceFor } from "../../dist/host/core-service.js";
import { afterEach, expect } from "vitest";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
export const textOf = message => typeof message?.content === "string" ? message.content : (message?.content || []).map(item => item.text || "").join("");
export async function waitFor(read, predicate, label) {
  const end = Date.now() + 20000; let last;
  while (Date.now() < end) { last = await read(); if (predicate(last)) return last; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
export async function nativeFixture(respond, runtimeEnv = {}, capabilities) {
  expect(process.versions.electron).toBeTruthy();
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
  await writeFile(join(home, "serving-config.json"), JSON.stringify({
    agent: { id: "main", revision: "1", name: "Native Host fixture", mission: "Produce and verify fixture proof", usage: ["main"] },
    agents: capabilities?.agents || [], maxConcurrentRuns: 2, retention: { maxEvents: 1000, maxAgeMs: null },
  }), { mode: 0o600 });
  const server = await startGo(home, "dsh-super-agent-space", runtimeEnv);
  cleanups.push(server.stop);
  await configureModel(server, `http://127.0.0.1:${upstream.address().port}/v1`, "native-goal-model", ["bash", "read", "write"]);
  const { socketPath } = server.options;
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
