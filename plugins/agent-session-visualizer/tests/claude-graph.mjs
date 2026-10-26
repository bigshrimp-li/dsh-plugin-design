import { buildSessionGraph, listSessions } from "../adapters/claude/index.mjs";

const fixtureId = "e7f3932d-7cb2-4e4d-a6cf-f32af5c1b3a9";
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
const index = await listSessions();
invariant(index.provider === "claude", "Claude index provider is incorrect");
invariant(index.sessions.length > 0, "No local Claude Code sessions were indexed");
invariant(new Set(index.sessions.map((session) => session.id)).size === index.sessions.length, "Claude Session Directory contains duplicate Root ids");
const fixture = index.sessions.find((session) => session.id === fixtureId);
invariant(fixture?.subagentCount >= 5, "Claude regression Session is missing its known Sub-agents");

const graph = await buildSessionGraph(fixtureId);
const ids = graph.graph.nodes.map((node) => node.id);
const nodes = new Map(graph.graph.nodes.map((node) => [node.id, node]));
const incoming = new Map(ids.map((id) => [id, 0]));
invariant(graph.source.provider === "claude", "Claude graph source is incorrect");
invariant(ids.length === nodes.size, "Claude graph node ids are not globally unique");
for (const edge of graph.graph.edges) {
  invariant(nodes.has(edge.from) && nodes.has(edge.to), `Missing Claude edge endpoint: ${edge.from} -> ${edge.to}`);
  invariant(nodes.get(edge.to).x > nodes.get(edge.from).x, `Backward Claude causal edge: ${edge.from} -> ${edge.to}`);
  incoming.set(edge.to, incoming.get(edge.to) + 1);
}
invariant([...incoming.values()].filter((count) => count === 0).length === 1, "Claude graph must have exactly one root");
invariant(graph.metrics.threads === 6 && graph.metrics.subAgents === 5, "Claude Sub-agents did not become independent Threads");
invariant(graph.graph.edges.filter((edge) => edge.type === "spawn").length === 5, "Claude Spawn edges do not match Sub-agent metadata");
invariant(graph.graph.edges.filter((edge) => edge.type === "return").length === 5, "Claude Return edges do not match TaskOutput results");
for (const thread of graph.graph.threads.filter((item) => item.parentId)) {
  const first = graph.graph.nodes.find((node) => node.threadId === thread.id);
  invariant(first?.label === "Agent 任务", `${thread.nickname} does not start with its actual Agent prompt`);
  invariant(first.agentContext?.agentType, `${thread.nickname} has no Agent runtime context`);
  invariant(first.agentContext?.systemPrompt?.status, `${thread.nickname} has no system-prompt provenance status`);
  invariant(first.agentContext?.agentDefinition?.declaredTools, `${thread.nickname} has no declared tool policy`);
  invariant(first.agentContext?.observedTools?.length > 0, `${thread.nickname} has no observed tool inventory`);
}
const tools = graph.graph.nodes.flatMap((node) => node.tools || []);
invariant(tools.some((tool) => tool.name === "Agent" && tool.input && tool.output), "Claude Agent call/result was not paired");
invariant(tools.some((tool) => tool.name === "TaskOutput" && tool.output), "Claude Agent result retrieval was not preserved");
invariant(graph.graph.nodes.some((node) => node.type === "final"), "Claude final responses are missing");

console.log(`PASS: Claude ${graph.metrics.threads} threads, ${graph.metrics.turns} Turns, ${graph.metrics.nodes} nodes, ${graph.metrics.toolCalls} paired tools`);
