import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "grok-visualizer-"));
process.env.GROK_HOME = temp;
const rootId = "01900000-0000-7000-8000-000000000001";
const childId = "01900000-0000-7000-8000-000000000002";
const group = path.join(temp, "sessions", "%2Ftmp%2Fgrok-fixture");
const rootDir = path.join(group, rootId);
const childDir = path.join(group, childId);
await fsp.mkdir(path.join(rootDir, "subagents", "research"), { recursive: true });
await fsp.mkdir(childDir, { recursive: true });

const summary = (id, title, created, updated) => JSON.stringify({
  info: { id, cwd: "/tmp/grok-fixture" },
  generated_title: title,
  created_at: created,
  updated_at: updated,
  num_messages: 6,
  num_chat_messages: 4,
  current_model_id: "grok-fixture",
  agent_name: "grok-build",
});
const event = (timestamp, update, meta = {}) => JSON.stringify({ timestamp, method: "session/update", params: { sessionId: rootId, update, _meta: { agentTimestampMs: timestamp * 1000, ...meta } } });
const rootUpdates = [
  event(1700000001, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "请并行研究" } }),
  event(1700000002, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我会启动研究 Agent。" } }, { promptId: "root-turn" }),
  event(1700000002.1, { sessionUpdate: "tool_call", toolCallId: "spawn-1", title: "spawn_subagent", rawInput: { prompt: "研究代码", description: "Research" }, _meta: { "x.ai/tool": { name: "spawn_subagent" } } }, { promptId: "root-turn" }),
  event(1700000002.2, { sessionUpdate: "tool_call_update", toolCallId: "spawn-1", status: "completed", content: [{ type: "content", content: { type: "text", text: `Started ${childId}` } }] }, { promptId: "root-turn" }),
  event(1700000005, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "研究 Agent 已完成。" } }, { promptId: "root-turn" }),
  event(1700000005.1, { sessionUpdate: "turn_completed", prompt_id: "root-turn", stop_reason: "end_turn" }),
].join("\n") + "\n";
const childEvent = (timestamp, update, meta = {}) => JSON.stringify({ timestamp, method: "session/update", params: { sessionId: childId, update, _meta: { agentTimestampMs: timestamp * 1000, ...meta } } });
const childUpdates = [
  childEvent(1700000003, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "研究代码" } }),
  childEvent(1700000004, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "研究结论" } }, { promptId: "child-turn" }),
  childEvent(1700000004.1, { sessionUpdate: "turn_completed", prompt_id: "child-turn", stop_reason: "end_turn" }),
].join("\n") + "\n";

await Promise.all([
  fsp.writeFile(path.join(rootDir, "summary.json"), summary(rootId, "Root fixture", "2023-11-14T22:13:20Z", "2023-11-14T22:13:26Z")),
  fsp.writeFile(path.join(rootDir, "updates.jsonl"), rootUpdates),
  fsp.writeFile(path.join(rootDir, "chat_history.jsonl"), [
    JSON.stringify({ type: "assistant", content: "我会启动研究 Agent。", tool_calls: [{ id: "spawn-1", name: "spawn_subagent", arguments: JSON.stringify({ prompt: "研究代码", description: "Research" }) }] }),
    JSON.stringify({ type: "tool_result", tool_call_id: "spawn-1", content: `Started ${childId}` }),
  ].join("\n") + "\n"),
  fsp.writeFile(path.join(rootDir, "subagents", "research", "meta.json"), JSON.stringify({ session_id: childId, parent_session_id: rootId, description: "Research", subagent_type: "explore", agent_path: "/subagents/research" })),
  fsp.writeFile(path.join(childDir, "summary.json"), summary(childId, "Child fixture", "2023-11-14T22:13:23Z", "2023-11-14T22:13:24Z")),
  fsp.writeFile(path.join(childDir, "updates.jsonl"), childUpdates),
  fsp.writeFile(path.join(childDir, "chat_history.jsonl"), ""),
]);

const { buildSessionGraph, listSessions } = await import("../adapters/grok/index.mjs");
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
try {
  const index = await listSessions();
  invariant(index.sessions.length === 1, "Grok child Session was not merged under its Root directory entry");
  invariant(index.sessions[0].subagentCount === 1, "Grok child metadata was not indexed");
  const graph = await buildSessionGraph(rootId);
  invariant(graph.metrics.threads === 2 && graph.metrics.subAgents === 1, "Grok child did not become an independent graph Thread");
  invariant(graph.graph.edges.some((edge) => edge.type === "spawn"), "Grok child has no Spawn edge");
  invariant(graph.graph.edges.some((edge) => edge.type === "return"), "Grok child has no Return edge");
  invariant(graph.graph.nodes.find((node) => node.threadId === childId)?.label === "Agent 任务", "Grok child does not start with an Agent task node");
  console.log("PASS: Grok native Sub-agent metadata becomes one child Thread with Spawn and Return edges");
} finally {
  await fsp.rm(temp, { recursive: true, force: true });
}
