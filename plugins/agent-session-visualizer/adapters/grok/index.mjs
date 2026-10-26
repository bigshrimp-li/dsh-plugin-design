import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { deriveTrace } from "../common/trace.mjs";

const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const sessionsRoot = path.join(grokHome, "sessions");
const roots = [{ directory: sessionsRoot }];
const colors = ["violet", "blue", "rose", "acid"];
const indexById = new Map();
let revision = 0;
let refreshPromise = null;

function rawText(value) {
  if (typeof value === "string") return value;
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function compact(value, length = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, length);
}

function timestampFor(event, fallback) {
  const milliseconds = event?.params?._meta?.agentTimestampMs;
  if (milliseconds) return new Date(milliseconds).toISOString();
  if (event?.timestamp) return new Date(event.timestamp * 1000).toISOString();
  return fallback;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (content?.text) return content.text;
  if (content?.content?.text) return content.content.text;
  if (!Array.isArray(content)) return rawText(content);
  return content.map((part) => part?.content?.text || part?.content || part?.text || "").filter(Boolean).map(rawText).join("\n");
}

function classifyTool(name, input) {
  const source = `${name || ""} ${input || ""}`;
  if (/spawn_subagent|get_command_or_subagent_output/i.test(name || "")) return { category: "agent", action: "Agent 协作" };
  if (/web|browser|search/i.test(source)) return { category: "web", action: "网络或浏览器操作" };
  if (/search_replace|write|edit|patch|delete|move/i.test(source)) return { category: "write", action: "写入或修改文件" };
  if (/read|list|find|grep|glob|terminal_command|command/i.test(source)) return { category: "read", action: "读取或检查数据" };
  if (/plan|todo|workflow/i.test(source)) return { category: "state", action: "更新执行状态" };
  return { category: "tool", action: "执行工具" };
}

async function findSessionDirectories() {
  if (!fs.existsSync(sessionsRoot)) return [];
  const groups = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  const nested = await Promise.all(groups.filter((entry) => entry.isDirectory()).map(async (group) => {
    const groupPath = path.join(sessionsRoot, group.name);
    const sessions = await fsp.readdir(groupPath, { withFileTypes: true }).catch(() => []);
    return sessions.filter((entry) => entry.isDirectory()).map((entry) => path.join(groupPath, entry.name));
  }));
  return nested.flat().filter((directory) => fs.existsSync(path.join(directory, "summary.json")));
}

async function readSubagentLinks(parentDirectory) {
  const directory = path.join(parentDirectory, "subagents");
  if (!fs.existsSync(directory)) return [];
  const files = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name === "meta.json") files.push(full);
    }
  }
  await walk(directory);
  const links = [];
  for (const file of files) {
    try {
      const meta = JSON.parse(await fsp.readFile(file, "utf8"));
      const childId = meta.session_id || meta.sessionId || meta.child_session_id || meta.childSessionId || meta.id;
      if (!childId) continue;
      links.push({
        childId,
        parentId: meta.parent_session_id || meta.parentSessionId || null,
        nickname: meta.description || meta.label || meta.name || meta.subagent_type || "Sub-agent",
        agentPath: meta.agent_path || meta.agentPath || `/subagents/${childId}`,
        subagentType: meta.subagent_type || meta.subagentType || meta.agent_type || null,
        raw: meta,
      });
    } catch {
      // A partially-written metadata file will be retried on the next scan.
    }
  }
  return links;
}

async function inspectDirectory(directory) {
  const summaryFile = path.join(directory, "summary.json");
  const updateFile = path.join(directory, "updates.jsonl");
  const chatFile = path.join(directory, "chat_history.jsonl");
  const [summaryText, summaryStat, updateStat, chatStat] = await Promise.all([
    fsp.readFile(summaryFile, "utf8"),
    fsp.stat(summaryFile),
    fsp.stat(updateFile).catch(() => null),
    fsp.stat(chatFile).catch(() => null),
  ]);
  const summary = JSON.parse(summaryText);
  const id = summary.info?.id || path.basename(directory);
  const cwd = summary.info?.cwd || "";
  const links = await readSubagentLinks(directory);
  return {
    id,
    shortId: id.slice(0, 8),
    directory,
    summaryFile,
    updateFile,
    chatFile,
    sizeBytes: (updateStat?.size || 0) + (chatStat?.size || 0) + summaryStat.size,
    signature: `${summaryStat.size}:${summaryStat.mtimeMs}:${updateStat?.size || 0}:${updateStat?.mtimeMs || 0}:${chatStat?.size || 0}:${chatStat?.mtimeMs || 0}:${links.length}`,
    createdAt: summary.created_at || summaryStat.birthtime.toISOString(),
    updatedAt: summary.updated_at || summary.last_active_at || summaryStat.mtime.toISOString(),
    cwd,
    workspace: path.basename(cwd) || "Unknown workspace",
    title: summary.generated_title || summary.session_summary || `${path.basename(cwd) || "Grok"} · ${id.slice(0, 8)}`,
    latestPrompt: summary.last_turn_summary || summary.last_recap || summary.session_summary || "",
    modelId: summary.current_model_id || "unknown",
    agentName: summary.agent_name || "grok-build",
    reasoningEffort: summary.reasoning_effort || null,
    numMessages: summary.num_messages || 0,
    numChatMessages: summary.num_chat_messages || 0,
    links,
    parentId: null,
    isSubagent: false,
    agentPath: "/root",
    agentNickname: null,
    subagentType: null,
  };
}

function publicRecord(record, activeIds) {
  return {
    id: record.id,
    shortId: record.shortId,
    title: record.title,
    latestPrompt: compact(record.latestPrompt, 180),
    cwd: record.cwd,
    workspace: record.workspace,
    file: record.updateFile,
    fileName: "updates.jsonl",
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active: activeIds.has(record.id) || Date.now() - new Date(record.updatedAt).getTime() < 5 * 60 * 1000,
    isSubagent: record.isSubagent,
    parentId: record.parentId,
    agentPath: record.agentPath,
    agentNickname: record.agentNickname,
    modelId: record.modelId,
    agentName: record.agentName,
  };
}

async function activeSessionIds() {
  try {
    const entries = JSON.parse(await fsp.readFile(path.join(grokHome, "active_sessions.json"), "utf8"));
    return new Set(entries.map((entry) => entry.session_id).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function refreshSessionIndex() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const directories = await findSessionDirectories();
    const records = (await Promise.all(directories.map(async (directory) => {
      try { return await inspectDirectory(directory); } catch { return null; }
    }))).filter(Boolean);
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const parent of records) {
      for (const link of parent.links) {
        const child = byId.get(link.childId);
        if (!child) continue;
        child.parentId = link.parentId || parent.id;
        child.isSubagent = true;
        child.agentPath = link.agentPath;
        child.agentNickname = link.nickname;
        child.subagentType = link.subagentType;
      }
    }
    records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const previous = new Map([...indexById].map(([id, record]) => [id, record.signature]));
    const addedIds = records.filter((record) => !previous.has(record.id)).map((record) => record.id);
    const changedIds = records.filter((record) => previous.has(record.id) && previous.get(record.id) !== record.signature).map((record) => record.id);
    const removedIds = [...previous.keys()].filter((id) => !byId.has(id));
    indexById.clear();
    for (const record of records) indexById.set(record.id, record);
    if (addedIds.length || changedIds.length || removedIds.length || revision === 0) revision += 1;
    return { provider: "grok", revision, addedIds, changedIds, removedIds };
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function listSessions() {
  await refreshSessionIndex();
  const activeIds = await activeSessionIds();
  const rootsOnly = [...indexById.values()].filter((record) => !record.isSubagent);
  const sessions = rootsOnly.map((record) => {
    const descendants = [...indexById.values()].filter((candidate) => candidate.parentId === record.id);
    return {
      ...publicRecord(record, activeIds),
      conversationId: record.id,
      sourceSessionId: record.id,
      memberCount: 1 + descendants.length,
      subagentCount: descendants.length,
    };
  });
  const projectMap = new Map();
  for (const session of sessions) {
    const projectPath = session.cwd || "未关联工程目录";
    const project = projectMap.get(projectPath) || { id: projectPath, name: session.cwd ? path.basename(session.cwd) : "未关联工程", path: projectPath, count: 0, active: 0, updatedAt: session.updatedAt };
    project.count += 1;
    project.active += session.active ? 1 : 0;
    if (new Date(session.updatedAt) > new Date(project.updatedAt)) project.updatedAt = session.updatedAt;
    projectMap.set(projectPath, project);
  }
  const projects = [...projectMap.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return {
    provider: "grok",
    providerLabel: "Grok Build",
    revision,
    directories: roots.map((root) => ({ path: root.directory })),
    metrics: { total: sessions.length, projects: projects.length, sourceFiles: indexById.size, merged: indexById.size - sessions.length, active: sessions.filter((session) => session.active).length },
    projects,
    sessions,
  };
}

async function readChatToolData(record) {
  const calls = new Map();
  const results = new Map();
  if (!fs.existsSync(record.chatFile)) return { calls, results };
  const reader = readline.createInterface({ input: fs.createReadStream(record.chatFile), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    for (const call of message.tool_calls || []) calls.set(call.id, call);
    if (message.type === "tool_result" && message.tool_call_id) results.set(message.tool_call_id, rawText(message.content));
  }
  return { calls, results };
}

function richestOutput(update) {
  const candidates = [update.rawOutput, update.content, update.output, update.result].filter((value) => value != null).map(rawText);
  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

function mergeModelSteps(items) {
  const merged = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = items[index + 1];
    if (item.type === "model" && next && ["tool", "agent"].includes(next.type) && item.turnId === next.turnId) {
      merged.push({ ...item, type: next.type, label: next.type === "agent" ? "模型输出 · Agent 协作" : "模型输出 · 工具批次", tools: next.tools, toolSummary: next.content, height: 132 });
      index += 1;
    } else merged.push(item);
  }
  return merged;
}

async function parseThread(record) {
  const items = [];
  const turns = [];
  const calls = new Map();
  const { calls: chatCalls, results: chatResults } = await readChatToolData(record);
  let currentTurn = null;
  let openBatch = null;
  let lastTimestamp = record.createdAt;
  let running = false;
  let turnNumber = 0;

  const flushBatch = () => {
    if (!openBatch) return;
    for (const tool of openBatch.tools) {
      const chatResult = chatResults.get(tool.callId);
      if (chatResult && chatResult.length > tool.output.length) tool.output = chatResult;
      if (tool.status === "running" && tool.output) tool.status = "completed";
    }
    const type = openBatch.tools.some((tool) => tool.category === "agent") ? "agent" : "tool";
    items.push({ type, timestamp: openBatch.timestamp, turnId: openBatch.turnId, label: type === "agent" ? "Agent 协作批次" : "工具调用批次", summary: `${openBatch.tools.length} 个调用与结果`, content: openBatch.tools.map((tool) => `${tool.name}: ${tool.action} (${tool.status})`).join("\n"), tools: openBatch.tools });
    openBatch = null;
  };

  if (fs.existsSync(record.updateFile)) {
    const reader = readline.createInterface({ input: fs.createReadStream(record.updateFile), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      lastTimestamp = timestampFor(event, lastTimestamp);
      const update = event.params?.update || {};
      const kind = update.sessionUpdate;
      if (kind === "user_message_chunk") {
        flushBatch();
        turnNumber += 1;
        currentTurn = `grok-turn-${turnNumber}`;
        running = true;
        const text = contentText(update.content);
        turns.push({ id: currentTurn, startedAt: lastTimestamp, completedAt: null, status: "running" });
        items.push({ type: "user", label: record.isSubagent ? "Agent 任务" : "用户消息", summary: compact(text), content: text, timestamp: lastTimestamp, turnId: currentTurn });
        continue;
      }
      if (kind === "agent_message_chunk") {
        flushBatch();
        const text = contentText(update.content);
        if (text) items.push({ type: "model", label: "模型消息", summary: compact(text), content: text, timestamp: lastTimestamp, turnId: currentTurn, phase: "assistant", promptId: event.params?._meta?.promptId || null });
        continue;
      }
      if (kind === "tool_call") {
        if (!openBatch) openBatch = { timestamp: lastTimestamp, turnId: currentTurn, tools: [] };
        const callId = update.toolCallId;
        const chatCall = chatCalls.get(callId);
        const input = chatCall?.arguments ?? update.rawInput ?? "";
        const name = chatCall?.name || update._meta?.["x.ai/tool"]?.name || update.title || "tool";
        const classified = classifyTool(name, rawText(input));
        const tool = { id: callId || `tool-${calls.size + 1}`, callId: callId || null, timestamp: lastTimestamp, status: "running", name, title: update.title || name, ...classified, input: rawText(input), output: "" };
        openBatch.tools.push(tool);
        if (callId) calls.set(callId, tool);
        continue;
      }
      if (kind === "tool_call_update") {
        const tool = calls.get(update.toolCallId);
        if (!tool) continue;
        const output = richestOutput(update);
        if (output.length > tool.output.length) tool.output = output;
        if (update.rawInput && rawText(update.rawInput).length > tool.input.length) tool.input = rawText(update.rawInput);
        const status = String(update.status || event.params?._meta?.updateParams?.status || "").toLowerCase();
        if (status) tool.status = /complete|success/.test(status) ? "completed" : /fail|error/.test(status) ? "failed" : status;
        if (tool.output && !status) tool.status = "completed";
        tool.completedAt = lastTimestamp;
        continue;
      }
      if (kind === "task_completed") {
        const snapshot = update.task_snapshot || {};
        const tool = calls.get(snapshot.task_id);
        if (tool) {
          const output = rawText(snapshot.output);
          if (output.length > tool.output.length) tool.output = output;
          tool.status = snapshot.completed ? "completed" : "failed";
          tool.completedAt = lastTimestamp;
          tool.durationSeconds = snapshot.start_time && snapshot.end_time ? Math.max(0, snapshot.end_time.secs_since_epoch - snapshot.start_time.secs_since_epoch) : null;
        }
        continue;
      }
      if (kind === "turn_completed") {
        flushBatch();
        const turn = turns.findLast((candidate) => candidate.id === currentTurn);
        if (turn) Object.assign(turn, { completedAt: lastTimestamp, status: "completed", stopReason: update.stop_reason || null, usage: update.usage || null });
        const finalIndex = items.findLastIndex((item) => item.turnId === currentTurn && item.type === "model");
        if (finalIndex >= 0) Object.assign(items[finalIndex], { type: "final", label: "最终回答", phase: "final_answer" });
        currentTurn = null;
        running = false;
      }
    }
  }
  flushBatch();
  if (!items.length) items.push({ type: "model", label: "空 Session", summary: "尚无可展示的消息或工具调用", content: "该 Session 当前只有元数据。", timestamp: record.createdAt, turnId: null });
  return { record, items: mergeModelSteps(items), turns: turns.length, turnMeta: turns, status: running ? "running" : "completed", lastTimestamp };
}

function subtreeRecords(rootId) {
  const records = [];
  const visit = (id) => {
    const record = indexById.get(id);
    if (!record || records.includes(record)) return;
    records.push(record);
    [...indexById.values()].filter((candidate) => candidate.parentId === id).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).forEach((child) => visit(child.id));
  };
  visit(rootId);
  return records;
}

function applyCausalLayout(nodes, edges) {
  const nodeById = new Map();
  for (const node of nodes) {
    if (nodeById.has(node.id)) throw new Error(`Duplicate graph node id: ${node.id}`);
    nodeById.set(node.id, node);
  }
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) throw new Error(`Graph edge references a missing node: ${edge.from} -> ${edge.to}`);
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const originalIncoming = new Map(incoming);
  const layer = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => incoming.get(node.id) === 0).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let processed = 0;
  while (queue.length) {
    const node = queue.shift();
    processed += 1;
    for (const targetId of outgoing.get(node.id)) {
      layer.set(targetId, Math.max(layer.get(targetId), layer.get(node.id) + 1));
      incoming.set(targetId, incoming.get(targetId) - 1);
      if (incoming.get(targetId) === 0) queue.push(nodeById.get(targetId));
    }
    queue.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }
  if (processed !== nodes.length) throw new Error(`Graph contains a cycle: processed ${processed}/${nodes.length} nodes`);
  const graphRoots = nodes.filter((node) => originalIncoming.get(node.id) === 0);
  if (graphRoots.length !== 1) throw new Error(`Graph must have exactly one root, found ${graphRoots.length}`);
  for (const node of nodes) { node.layer = layer.get(node.id); node.x = 70 + node.layer * 275; }
  return { rootNodeId: graphRoots[0].id, layers: Math.max(...layer.values()) + 1 };
}

export async function buildSessionGraph(sessionId) {
  await refreshSessionIndex();
  const records = subtreeRecords(sessionId);
  if (!records.length) {
    const error = new Error(`Grok Build session ${sessionId} not found`);
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  const parsed = [];
  for (const record of records) parsed.push(await parseThread(record));
  const threads = parsed.map((thread, index) => ({
    id: thread.record.id,
    name: thread.record.isSubagent ? (thread.record.subagentType || "Sub-agent") : "Root Agent",
    path: thread.record.agentPath,
    nickname: thread.record.agentNickname || (index === 0 ? "Root" : `Agent ${index}`),
    parentId: index === 0 ? null : thread.record.parentId,
    laneY: 105 + index * 300,
    status: thread.status,
    turns: thread.turns,
    color: index === 0 ? "acid" : colors[(index - 1) % colors.length],
  }));
  const nodes = [];
  const edges = [];
  const perThread = new Map();
  for (const [threadIndex, thread] of parsed.entries()) {
    const laneY = threads[threadIndex].laneY;
    const threadNodes = thread.items.map((item, itemIndex) => ({ id: `${thread.record.id}:${item.turnId || "session"}:${itemIndex + 1}`, x: 0, y: laneY - (["tool", "agent"].includes(item.type) ? 7 : 0), width: 232, height: ["tool", "agent"].includes(item.type) ? 132 : 116, threadId: thread.record.id, ...item }));
    nodes.push(...threadNodes);
    perThread.set(thread.record.id, threadNodes);
    for (let index = 1; index < threadNodes.length; index += 1) edges.push({ from: threadNodes[index - 1].id, to: threadNodes[index].id, type: "sequence", label: "" });
  }
  for (const thread of parsed.slice(1)) {
    const childNodes = perThread.get(thread.record.id) || [];
    const parentNodes = perThread.get(thread.record.parentId) || [];
    if (!childNodes.length || !parentNodes.length) continue;
    const tokens = [thread.record.id, thread.record.agentNickname, thread.record.agentPath].filter(Boolean).map((value) => value.toLowerCase());
    const spawn = parentNodes.find((node) => node.tools?.some((tool) => tokens.some((token) => `${tool.input} ${tool.output}`.toLowerCase().includes(token)))) || [...parentNodes].reverse().find((node) => new Date(node.timestamp) <= new Date(thread.record.createdAt)) || parentNodes[0];
    edges.push({ from: spawn.id, to: childNodes[0].id, type: "spawn", label: thread.record.agentNickname || "sub-agent" });
    const returned = parentNodes.find((node) => new Date(node.timestamp) >= new Date(thread.lastTimestamp));
    if (returned) edges.push({ from: childNodes.at(-1).id, to: returned.id, type: "return", label: "result" });
  }
  const layout = applyCausalLayout(nodes, edges);
  const graphTurns = parsed.flatMap((thread) => thread.turnMeta.map((turn, turnIndex) => {
    const turnNodes = (perThread.get(thread.record.id) || []).filter((node) => node.turnId === turn.id);
    return { ...turn, threadId: thread.record.id, index: turnIndex + 1, nodeIds: turnNodes.map((node) => node.id), minX: turnNodes.length ? Math.min(...turnNodes.map((node) => node.x)) : 0, maxX: turnNodes.length ? Math.max(...turnNodes.map((node) => node.x + node.width)) : 0 };
  }));
  const root = parsed[0];
  const allTools = nodes.flatMap((node) => node.tools || []);
  const session = { id: root.record.id, shortId: root.record.shortId, title: root.record.title, status: root.status, startedAt: root.record.createdAt, completedAt: root.status === "completed" ? root.lastTimestamp : null, updatedAt: root.record.updatedAt, cwd: root.record.cwd, cliVersion: root.record.agentName, modelId: root.record.modelId, provider: "grok" };
  const trace = deriveTrace({ provider: "grok", session, threads, parsed, nodesByThread: perThread });
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    source: { provider: "grok", providerLabel: "Grok Build", adapterVersion: 1, mode: "live-local-session-graph", rootFile: root.record.updateFile, childFiles: parsed.slice(1).map((thread) => thread.record.updateFile), directory: grokHome, note: "Grok updates/events 提供时间边界，chat history 补齐完整工具输入与结果。" },
    session: { id: root.record.id, shortId: root.record.shortId, title: root.record.title, status: root.status, startedAt: root.record.createdAt, completedAt: root.status === "completed" ? root.lastTimestamp : null, updatedAt: root.record.updatedAt, cwd: root.record.cwd, cliVersion: root.record.agentName, modelId: root.record.modelId, provider: "grok" },
    graph: { width: Math.max(900, 70 + layout.layers * 275), height: Math.max(400, 250 + (threads.length - 1) * 300), nodes, edges, threads, turns: graphTurns, rootNodeId: layout.rootNodeId },
    trace,
    metrics: { threads: threads.length, runs: trace.metrics.runs, turns: trace.metrics.turns, nodes: nodes.length, toolCalls: allTools.length, subAgents: Math.max(0, threads.length - 1) },
  };
}

export function grokDirectories() {
  return roots.map((root) => ({ path: root.directory }));
}

/**
 * Read the input context Grok writes next to a session: the rendered system
 * prompt, the tool schema, the injected AGENTS.md files, and any usage/signal
 * summaries. Files that a given session did not write stay absent.
 */
export async function buildSessionContext(sessionId) {
  await refreshSessionIndex();
  const records = subtreeRecords(sessionId);
  if (!records.length) {
    const error = new Error(`Grok Build session ${sessionId} not found`);
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  const readIfPresent = async (file) => {
    try { return await fsp.readFile(file, "utf8"); } catch { return null; }
  };
  const parseIfPresent = async (file) => {
    const text = await readIfPresent(file);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  const contexts = [];
  for (const record of records) {
    const directory = record.directory || path.dirname(record.updateFile || record.file);
    const systemPrompt = await readIfPresent(path.join(directory, "system_prompt.txt"));
    const toolDefinitions = await parseIfPresent(path.join(directory, "tool_definitions.json"));
    const promptContext = await parseIfPresent(path.join(directory, "prompt_context.json"));
    const usage = await parseIfPresent(path.join(directory, "usage.json"));
    const signals = await parseIfPresent(path.join(directory, "signals.json"));
    const agentsFiles = Array.isArray(promptContext?.agents_md_files) ? promptContext.agents_md_files : [];
    contexts.push({
      threadId: record.id,
      file: record.updateFile || record.file,
      nickname: record.agentNickname,
      agentPath: record.agentPath,
      systemPrompt,
      developerInstructions: null,
      agentsMd: agentsFiles.length ? { directory: promptContext?.working_directory || record.cwd, text: agentsFiles.map((item) => `# ${item.file_path || item.file_name}\n\n${item.content || ""}`).join("\n\n") } : null,
      skills: null,
      tools: Array.isArray(toolDefinitions) ? [{
        type: "functions",
        name: "Grok 工具 schema",
        description: "",
        tools: toolDefinitions.map((tool) => ({
          type: tool.type || "function",
          name: tool.function?.name || tool.name || "tool",
          description: tool.function?.description || tool.description || "",
          parameters: tool.function?.parameters || tool.parameters || null,
        })),
      }] : null,
      permissions: null,
      model: record.modelId || null,
      effort: null,
      approvalPolicy: null,
      sandbox: null,
      usage,
      signals,
      cwd: record.cwd,
      cliVersion: record.agentName || null,
      originator: "Grok Build",
    });
  }
  return {
    provider: "grok",
    sessionId,
    note: "Grok 在 session 目录里同时保存渲染后的 system_prompt、tool_definitions 与 prompt_context（含注入的 AGENTS.md 全文）。",
    contexts,
  };
}
