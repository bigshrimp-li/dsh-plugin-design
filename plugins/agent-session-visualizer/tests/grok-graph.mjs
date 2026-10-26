import { buildSessionGraph, listSessions } from "../adapters/grok/index.mjs";

const invariant = (condition, message) => { if (!condition) throw new Error(message); };
const index = await listSessions();
invariant(index.provider === "grok", "Grok index provider is incorrect");
invariant(index.sessions.length > 0, "No local Grok Build sessions were indexed");
invariant(new Set(index.sessions.map((session) => session.id)).size === index.sessions.length, "Grok Session Directory contains duplicate ids");

let graph = null;
for (const session of index.sessions) {
  const candidate = await buildSessionGraph(session.id);
  if (candidate.metrics.toolCalls > 0) { graph = candidate; break; }
}
invariant(graph, "No Grok Build session with tool calls was available for regression testing");
invariant(graph.source.provider === "grok", "Grok graph source is incorrect");
invariant(graph.graph.turns.length === graph.metrics.turns, "Grok Turn metadata disagrees with metrics");
invariant(graph.graph.nodes.some((node) => node.type === "user"), "Grok graph has no user node");
invariant(graph.graph.nodes.some((node) => node.type === "final"), "Grok graph has no final answer node");

const ids = graph.graph.nodes.map((node) => node.id);
const nodes = new Map(graph.graph.nodes.map((node) => [node.id, node]));
const incoming = new Map(ids.map((id) => [id, 0]));
invariant(ids.length === nodes.size, "Grok graph node ids are not globally unique");
for (const edge of graph.graph.edges) {
  invariant(nodes.has(edge.from) && nodes.has(edge.to), `Missing Grok edge endpoint: ${edge.from} -> ${edge.to}`);
  invariant(nodes.get(edge.to).x > nodes.get(edge.from).x, `Backward Grok causal edge: ${edge.from} -> ${edge.to}`);
  incoming.set(edge.to, incoming.get(edge.to) + 1);
}
invariant([...incoming.values()].filter((count) => count === 0).length === 1, "Grok graph must have exactly one root");

const user = graph.graph.nodes.find((node) => node.type === "user");
invariant(!user.content.trim().startsWith("{"), "Grok user content was rendered as a JSON wrapper");
const tools = graph.graph.nodes.flatMap((node) => node.tools || []);
invariant(tools.some((tool) => tool.input), "Grok tools have no complete input");
invariant(tools.some((tool) => tool.output), "Grok tools have no complete result");

console.log(`PASS: Grok ${graph.session.shortId}, ${graph.metrics.turns} Turns, ${graph.metrics.nodes} nodes, ${graph.metrics.toolCalls} paired tools`);
