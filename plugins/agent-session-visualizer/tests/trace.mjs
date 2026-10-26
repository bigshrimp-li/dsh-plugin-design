/**
 * Fixture regression for the four-level trace.
 *
 * The fixture is a hand-written Codex rollout: one Run, two model responses
 * (two Turns), one tool call that is recorded both as a response item and as a
 * runtime item, and a usage record per response. It proves the split rules
 * without depending on this machine's real session history.
 *
 * It also exercises the generic derivation used by Claude, Grok and Noval,
 * where the provider only records the Run boundary natively.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTrace, deriveTrace } from "../adapters/common/trace.mjs";

const home = await mkdtemp(path.join(tmpdir(), "asv-trace-"));
process.env.CODEX_HOME = home;
const { buildSessionContext, buildSessionGraph } = await import("../adapters/codex/index.mjs");
const sessionId = "01ab0000-1111-7222-8333-944455556666";
const directory = path.join(home, "sessions", "2026", "10", "22");
await mkdir(directory, { recursive: true });
const file = path.join(directory, `rollout-2026-10-22T10-00-00-${sessionId}.jsonl`);

const events = [
  {
    timestamp: "2026-10-22T02:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      cwd: "/tmp/asv-fixture",
      originator: "Codex Fixture",
      cli_version: "9.9.9",
      base_instructions: { text: "You are the fixture system prompt." },
      source: "cli",
    },
  },
  {
    timestamp: "2026-10-22T02:00:00.100Z",
    type: "turn_context",
    payload: {
      turn_id: "run-fixture-1",
      model: "gpt-fixture",
      effort: "high",
      approval_policy: "never",
      sandbox_policy: { type: "workspace-write" },
      collaboration_mode: { settings: { developer_instructions: "Fixture developer instructions." } },
    },
  },
  {
    timestamp: "2026-10-22T02:00:00.200Z",
    type: "world_state",
    payload: {
      full: true,
      state: {
        model: "gpt-fixture",
        agents_md: { directory: "/tmp/asv-fixture", text: "# Fixture AGENTS.md" },
        host_skills: { body: "## Fixture skills" },
        permissions: { instructions: "be careful", approved_command_prefixes: [["git", "status"]] },
      },
    },
  },
  {
    timestamp: "2026-10-22T02:00:00.300Z",
    type: "response_item",
    payload: {
      type: "additional_tools",
      id: "at_fixture",
      role: "developer",
      tools: [{ type: "namespace", name: "functions", description: "", tools: [{ type: "custom", name: "exec", description: "run code", format: { type: "text" }, parameters: { type: "object" } }] }],
    },
  },
  { timestamp: "2026-10-22T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "run-fixture-1" } },
  {
    timestamp: "2026-10-22T02:00:01.100Z",
    type: "response_item",
    payload: { type: "message", id: "msg_user_1", role: "user", content: [{ type: "input_text", text: "把 fixture 跑通" }] },
  },
  {
    timestamp: "2026-10-22T02:00:02.000Z",
    type: "event_msg",
    payload: { type: "item_completed", turn_id: "run-fixture-1", item: { type: "Reasoning", id: "rs_1", summary_text: ["先读文件"], raw_content: [] }, started_at_ms: 1000, completed_at_ms: 1500 },
  },
  {
    timestamp: "2026-10-22T02:00:02.010Z",
    type: "response_item",
    payload: { type: "reasoning", id: "rs_1", summary: ["先读文件"] },
  },
  {
    timestamp: "2026-10-22T02:00:03.000Z",
    type: "response_item",
    payload: { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call-1", name: "exec", input: "tools.exec_command({cmd:'ls'})" },
  },
  {
    timestamp: "2026-10-22T02:00:03.500Z",
    type: "response_item",
    payload: { type: "custom_tool_call_output", id: "ctco_1", call_id: "call-1", output: [{ type: "input_text", text: "a.txt" }] },
  },
  {
    timestamp: "2026-10-22T02:00:03.600Z",
    type: "event_msg",
    payload: { type: "item_completed", turn_id: "run-fixture-1", item: { type: "CommandExecution", id: "exec-1", command: ["/bin/bash", "-lc", "ls"], status: "completed", exit_code: 0, aggregated_output: "a.txt" }, started_at_ms: 3000, completed_at_ms: 3600 },
  },
  {
    timestamp: "2026-10-22T02:00:04.000Z",
    type: "token_usage_record",
    payload: {
      turn_id: "run-fixture-1",
      response_id: "resp_fixture_1",
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110 },
    },
  },
  {
    timestamp: "2026-10-22T02:00:05.000Z",
    type: "event_msg",
    payload: { type: "item_completed", turn_id: "run-fixture-1", item: { type: "AgentMessage", id: "msg_assistant_1", content: [{ type: "Text", text: "fixture 已经跑通。" }], phase: "final_answer" }, started_at_ms: 4000, completed_at_ms: 5000 },
  },
  {
    timestamp: "2026-10-22T02:00:05.010Z",
    type: "response_item",
    payload: { type: "message", id: "msg_assistant_1", role: "assistant", content: [{ type: "output_text", text: "fixture 已经跑通。" }], phase: "final_answer" },
  },
  {
    timestamp: "2026-10-22T02:00:05.500Z",
    type: "token_usage_record",
    payload: {
      turn_id: "run-fixture-1",
      response_id: "resp_fixture_2",
      usage: { input_tokens: 150, cached_input_tokens: 30, output_tokens: 20, total_tokens: 170 },
    },
  },
  {
    timestamp: "2026-10-22T02:00:06.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "run-fixture-1", last_agent_message: "fixture 已经跑通。" },
  },
];

await writeFile(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

try {
  const graph = await buildSessionGraph(sessionId);
  assert.equal(graph.schemaVersion, 3, "graph payload must declare schemaVersion 3");
  assert.ok(graph.trace, "graph payload must carry the trace tree");
  const thread = graph.trace.threads[0];
  assert.equal(thread.runs.length, 1, "one task boundary is one Run");
  const [run] = thread.runs;
  assert.equal(run.status, "completed");
  assert.equal(run.prompt, "把 fixture 跑通", "Run input comes from the user message");
  assert.equal(run.finalAnswer, "fixture 已经跑通。");
  assert.equal(run.turns.length, 2, "each model response becomes one Turn");
  assert.equal(run.usage.requests, 2);
  assert.equal(run.usage.totalTokens, 280, "usage records fold into the Run total");
  assert.equal(run.turns[0].usage.totalTokens, 110);
  assert.equal(run.turns[1].usage.totalTokens, 170);

  // New domain model assertions:
  assert.ok(Array.isArray(graph.trace.branches), "trace must carry branches (session lines)");
  assert.ok(Array.isArray(graph.trace.runs), "trace must carry flat runs for the conversation");
  assert.ok(Array.isArray(graph.trace.messages), "trace must carry derived message stream for Overview");
  assert.ok(run.waterfall && run.waterfall.length > 0, "run must carry waterfall timeline rows for RunDetail");
  assert.equal(graph.trace.metrics.runs, 1);
  assert.ok(graph.trace.metrics.totalTokens >= 280);

  const firstTurn = run.turns[0];
  const kinds = firstTurn.items.map((item) => item.kind);
  assert.ok(kinds.includes("reasoning"), "reasoning is a trace item");
  assert.ok(kinds.includes("tool"), "tool call is a trace item");
  const toolItem = firstTurn.items.find((item) => item.kind === "tool");
  const toolNode = graph.graph.nodes.find((node) => node.id === toolItem.nodeId);
  assert.ok(toolNode, "trace items point at their graph node instead of copying payloads");
  assert.equal(toolNode.tools[0].callId, "call-1");
  assert.equal(firstTurn.durationMs, 2000, "Turn duration spans its response and tool execution");

  const secondTurn = run.turns[1];
  assert.equal(secondTurn.items.filter((item) => item.kind === "answer").length, 1, "the final response is one answer item, not two");
  assert.equal(secondTurn.items[0].nodeId, graph.graph.nodes.find((node) => node.type === "final")?.id);

  const traceItems = run.turns.flatMap((turn) => turn.items);
  assert.equal(new Set(traceItems.map((item) => item.id)).size, traceItems.length, "trace item ids stay unique");

  const context = await buildSessionContext(sessionId);
  const [rootContext] = context.contexts;
  assert.equal(rootContext.systemPrompt, "You are the fixture system prompt.");
  assert.equal(rootContext.developerInstructions, "Fixture developer instructions.");
  assert.equal(rootContext.agentsMd.text, "# Fixture AGENTS.md");
  assert.equal(rootContext.skills, "## Fixture skills");
  assert.equal(rootContext.model, "gpt-fixture");
  assert.equal(rootContext.approvalPolicy, "never");
  assert.equal(rootContext.tools[0].tools[0].name, "exec");

  // Generic derivation: providers that only record the Run boundary.
  const session = { id: "conv-generic", shortId: "conv-gen", title: "generic", status: "completed", startedAt: "2026-10-22T02:00:00.000Z", cwd: "/tmp/generic" };
  const parsed = [{
    record: { id: "thread-1" },
    lastTimestamp: "2026-10-22T02:05:00.000Z",
    turnMeta: [{ id: "native-run-1", startedAt: "2026-10-22T02:00:01.000Z", completedAt: "2026-10-22T02:05:00.000Z", status: "completed" }],
    items: [
      { type: "user", summary: "帮我看看", timestamp: "2026-10-22T02:00:01.000Z", turnId: "native-run-1" },
      { type: "model", summary: "先列目录", content: "先列目录", timestamp: "2026-10-22T02:00:02.000Z", turnId: "native-run-1" },
      { type: "tool", summary: "1 个调用与结果", timestamp: "2026-10-22T02:00:03.000Z", turnId: "native-run-1", tools: [{ name: "Bash", action: "读取或检查数据", status: "completed", timestamp: "2026-10-22T02:00:03.000Z", callId: "tool-1" }] },
      { type: "final", summary: "看完了", content: "看完了", timestamp: "2026-10-22T02:04:00.000Z", turnId: "native-run-1" },
    ],
  }];
  const nodesByThread = new Map([["thread-1", parsed[0].items.map((item, index) => ({ id: `thread-1:${index + 1}` }))]]);
  const generic = deriveTrace({ provider: "fixture", session, threads: [{ id: "thread-1", name: "Root", nickname: "Root", path: "/root", parentId: null, status: "completed" }], parsed, nodesByThread });
  assert.equal(generic.metrics.runs, 1);
  assert.equal(generic.metrics.turns, 2, "a model response opens a Turn; the tool batch belongs to it");
  const genericRun = generic.threads[0].runs[0];
  assert.equal(genericRun.prompt, "帮我看看");
  assert.equal(genericRun.turns[0].items.filter((item) => item.kind === "tool").length, 1);
  assert.equal(genericRun.turns[1].items[0].kind, "answer");

  const assembled = buildTrace({ provider: "fixture", session, threads: [], runs: [] });
  assert.equal(assembled.metrics.runs, 0);

  console.log("PASS: Codex fixture gives Conversation → 1 Run → 2 Turns with tool/reasoning/answer leaves, and generic derivation matches the same levels");
} finally {
  await rm(home, { recursive: true, force: true });
}
