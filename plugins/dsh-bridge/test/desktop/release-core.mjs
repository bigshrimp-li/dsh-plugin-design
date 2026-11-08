// Isolated release fixture: the model is deterministic; the standalone Go Runtime serves its real file and wait APIs.
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const source = process.env.SUPER_AGENT_SOURCE_ROOT;
if (!source || !process.argv[2]) throw new Error("Set SUPER_AGENT_SOURCE_ROOT and provide an isolated temporary directory");
const root = resolve(process.argv[2]), workspace = join(root, "workspace"), home = join(root, "core");
await mkdir(home, { mode: 0o700 }); await mkdir(workspace, { recursive: true });
let seq = 0;
const provider = createServer(async (req, res) => { try {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const { messages } = JSON.parse(Buffer.concat(chunks).toString());
  const last = messages.findLastIndex(item => item.role === "user");
  const content = messages[last]?.content || "";
  const prompt = typeof content === "string" ? content : content.map(x => x.text || "").join("");
  const tools = messages.slice(last + 1).flatMap(item => item.tool_calls || []).map(item => item.function?.name);
  let name, args, text = "此轮检查完成。";
  if (prompt.includes("验收等待") && !tools.includes("ask_user")) {
    name = "ask_user"; args = { question: "可以继续检查吗？" };
  } else if ((prompt.includes("验收写入") || prompt.includes("验收拒绝")) && !tools.includes("write")) {
    name = "write"; args = { path: prompt.includes("验收拒绝") ? "拒绝.txt" : "验收结果.txt", content: "真实 Go 写入\n第二行\n第三行\n" };
  } else if (prompt.includes("Perform only the authorized check")) {
    text = JSON.stringify({ outcome: "done", summary: "检查已完成", evidenceRefs: ["release-check"] });
  }
  const id = "desktop-qa-" + (++seq);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id, model: "desktop-model", choices: [{ index: 0, finish_reason: name ? "tool_calls" : "stop", message: { role: "assistant", content: name ? "" : text,
    ...(name ? { tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : {}) } }] }));
} catch { res.writeHead(500); res.end(); } });
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const modelPort = await listen(provider);
const config = { schemaVersion: 1, agent: { name: "DSH 验收", mission: "只操作合成验收资料。" }, modelConfiguration: { schemaVersion: 1, app: { name: "release-qa", version: "1" },
  credentials: [{ id: "fixture", kind: "api_key", source: { type: "env", name: "DSH_RELEASE_FIXTURE" } }],
  providers: [{ id: "fixture", driver: "compatible", protocol: "openai-completions", baseUrl: "http://127.0.0.1:" + modelPort + "/v1", credentialRef: "fixture", authScheme: "bearer", allowLoopbackHttp: true, protocolOptions: { maxTokensField: "max_tokens" } }],
  models: [{ id: "fixture-model", providerRef: "fixture", modelId: "desktop-model", definition: { source: "explicit", contextWindow: 16384, maxOutputTokens: 1024, capabilities: { input: ["text"], tools: true, thinking: false, toolResultImages: "unsupported" } }, generation: { maxOutputTokens: 256, reasoning: { mode: "provider_default" } } }],
  requestPolicy: { totalTimeoutMs: 6000, streamIdleTimeoutMs: 3000, maxAttempts: 1 } }, maxConcurrentRuns: 2, retention: { maxEvents: 5000, maxAgeMs: null }, firstAdmissionCredentialRefs: ["fixture"] };
await Promise.all([writeFile(join(home, "serving-config.json"), JSON.stringify(config), { mode: 0o600 }),
  writeFile(join(workspace, "输入.txt"), "DSH 合成输入\n")]);
const binary = process.env.SUPER_AGENT_GO_RUNTIME_BINARY || join(source, "go-runtime/bin/super-agent-runtime");
const child = spawn(binary, ["serve", "--home", home, "--socket", join(home, "run/core.sock")], {
  env: { ...process.env, DSH_RELEASE_FIXTURE: "synthetic-loopback", SUPERAGENT_BACKGROUND_TASKS: "1", SUPERAGENT_TASK_MONITORS: "1", SUPERAGENT_TASK_SCHEDULES: "1" }, stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill("SIGTERM"));
child.on("error", error => { console.error(error.message); provider.close(); process.exitCode = 1; });
child.on("exit", code => { provider.close(); process.exitCode = code ?? 1; });
