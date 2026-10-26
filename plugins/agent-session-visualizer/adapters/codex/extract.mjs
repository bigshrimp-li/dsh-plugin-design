import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionGraph, listSessions } from "./index.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputPath = path.join(projectRoot, "data/session-graph.json");
const requestedId = process.argv[2];
const index = await listSessions();
const fallback = index.sessions.find((session) => !session.isSubagent)
  || index.sessions[0];
const sessionId = requestedId || fallback?.id;
if (!sessionId) throw new Error("No Codex sessions found");

const graph = await buildSessionGraph(sessionId);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(graph, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);
console.log(`${graph.metrics.threads} threads, ${graph.metrics.turns} turns, ${graph.metrics.nodes} graph nodes, ${graph.metrics.toolCalls} tool calls`);
