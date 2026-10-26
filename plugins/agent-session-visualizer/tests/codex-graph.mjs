import { buildSessionGraph } from "../adapters/codex/index.mjs";

const fixtureId = "01a00f1f-5570-79d1-beee-706875d5f3b0";
const graph = await buildSessionGraph(fixtureId);
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
const nodes = new Map(graph.graph.nodes.map((node) => [node.id, node]));
const nodeIds = graph.graph.nodes.map((node) => node.id);
const incoming = new Map(nodeIds.map((id) => [id, 0]));

invariant(nodes.size === nodeIds.length, "Graph node ids must be globally unique");
for (const edge of graph.graph.edges) {
  invariant(nodes.has(edge.from) && nodes.has(edge.to), `Missing edge endpoint: ${edge.from} -> ${edge.to}`);
  invariant(nodes.get(edge.to).x > nodes.get(edge.from).x, `Backward causal edge: ${edge.from} -> ${edge.to}`);
  incoming.set(edge.to, incoming.get(edge.to) + 1);
}
invariant([...incoming.values()].filter((count) => count === 0).length === 1, "Execution graph must have exactly one root");

const rootThread = graph.graph.threads.find((thread) => !thread.parentId);
const rootTurnIds = new Set(graph.graph.turns.filter((turn) => turn.threadId === rootThread.id).map((turn) => turn.id));
const childThreads = graph.graph.threads.filter((thread) => thread.parentId);
invariant(childThreads.length >= 3, "Regression fixture must include the known Sub-agent branches");
for (const thread of childThreads) {
  const threadNodes = graph.graph.nodes.filter((node) => node.threadId === thread.id);
  invariant(thread.turns === 1, `${thread.nickname} inherited ancestor Turns`);
  invariant(threadNodes[0]?.label === "Agent 任务", `${thread.nickname} does not start at its actual NEW_TASK`);
  invariant(threadNodes.every((node) => !rootTurnIds.has(node.turnId)), `${thread.nickname} contains replayed Root nodes`);
  invariant(graph.graph.edges.some((edge) => edge.type === "spawn" && edge.to === threadNodes[0]?.id), `${thread.nickname} has no incoming Spawn edge`);
}
invariant(graph.graph.turns.length === graph.graph.threads.reduce((total, thread) => total + thread.turns, 0), "Turn metadata and thread counts disagree");

console.log(`PASS: ${graph.metrics.threads} threads, ${graph.metrics.turns} real Turns, ${graph.metrics.nodes} unique nodes, one causal root`);
