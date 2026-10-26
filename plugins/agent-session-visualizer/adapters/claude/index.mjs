import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { deriveTrace } from "../common/trace.mjs";

const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
const projectsRoot = path.join(claudeHome, "projects");
const roots = [{ directory: projectsRoot }];
const colors = ["violet", "blue", "rose", "acid"];
const indexById = new Map();
const fileCache = new Map();
let revision = 0;
let refreshPromise = null;

function rawText(value) {
  if (typeof value === "string") return value;
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function compact(value, length = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, length);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content?.text || rawText(content);
  return content.map((part) => part?.text || part?.content?.text || (typeof part?.content === "string" ? part.content : "")).filter(Boolean).join("\n");
}

function classifyTool(name, input) {
  const source = `${name || ""} ${input || ""}`;
  if (/^(Agent|TaskOutput|SendMessage)$/i.test(name || "")) return { category: "agent", action: "Agent 协作" };
  if (/WebSearch|WebFetch|browser|search/i.test(source)) return { category: "web", action: "网络或浏览器操作" };
  if (/^(Write|Edit|NotebookEdit)$/i.test(name || "")) return { category: "write", action: "写入或修改文件" };
  if (/^(Read|Glob|Grep|Bash)$/i.test(name || "")) return { category: "read", action: "读取或检查数据" };
  if (/^(TaskCreate|TaskUpdate|TodoWrite|ExitPlanMode)$/i.test(name || "")) return { category: "state", action: "更新执行状态" };
  return { category: "tool", action: "执行工具" };
}

async function findRootFiles() {
  if (!fs.existsSync(projectsRoot)) return [];
  const projects = await fsp.readdir(projectsRoot, { withFileTypes: true });
  const nested = await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (project) => {
    const directory = path.join(projectsRoot, project.name);
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(directory, entry.name));
  }));
  return nested.flat();
}

async function readSample(file, size) {
  const handle = await fsp.open(file, "r");
  try {
    const chunkSize = Math.min(384 * 1024, size);
    const head = Buffer.alloc(chunkSize);
    const tail = Buffer.alloc(chunkSize);
    const headRead = await handle.read(head, 0, chunkSize, 0);
    const tailStart = Math.max(0, size - chunkSize);
    const tailRead = tailStart ? await handle.read(tail, 0, chunkSize, tailStart) : { bytesRead: 0 };
    return `${head.subarray(0, headRead.bytesRead).toString("utf8")}\n${tail.subarray(0, tailRead.bytesRead).toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

function inspectSample(sample) {
  let cwd = "";
  let version = "unknown";
  let model = "unknown";
  let title = "";
  let firstPrompt = "";
  let lastPrompt = "";
  let createdAt = null;
  let slug = null;
  for (const line of sample.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    cwd ||= event.cwd || "";
    version = event.version || version;
    slug = event.slug || slug;
    createdAt ||= event.timestamp || event.snapshot?.timestamp || null;
    if (event.type === "ai-title" && event.aiTitle) title = event.aiTitle;
    if (event.type === "last-prompt" && event.lastPrompt) lastPrompt = event.lastPrompt;
    if (event.type === "user" && typeof event.message?.content === "string") firstPrompt ||= event.message.content;
    if (event.type === "assistant" && event.message?.model && event.message.model !== "<synthetic>") model = event.message.model;
  }
  return { cwd, version, model, title, firstPrompt, lastPrompt, createdAt, slug };
}

async function inspectFile(file) {
  const stat = await fsp.stat(file);
  const id = path.basename(file, ".jsonl");
  const sessionDirectory = path.join(path.dirname(file), id);
  const subagentDirectory = path.join(sessionDirectory, "subagents");
  const subagentEntries = await fsp.readdir(subagentDirectory, { withFileTypes: true }).catch(() => []);
  const subagentFiles = subagentEntries.filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".meta.json")));
  const subagentStats = await Promise.all(subagentFiles.map(async (entry) => {
    const childStat = await fsp.stat(path.join(subagentDirectory, entry.name));
    return { name: entry.name, size: childStat.size, mtimeMs: childStat.mtimeMs };
  }));
  const subagentCount = subagentFiles.filter((entry) => entry.name.endsWith(".jsonl") && !entry.name.endsWith(".meta.json")).length;
  const signature = `${stat.size}:${stat.mtimeMs}:${subagentStats.map((entry) => `${entry.name}:${entry.size}:${entry.mtimeMs}`).join("|")}`;
  const cached = fileCache.get(file);
  if (cached?.signature === signature) return cached.record;
  const sample = await readSample(file, stat.size);
  const info = inspectSample(sample);
  const cwd = info.cwd;
  const record = {
    id,
    shortId: id.slice(0, 8),
    file,
    sessionDirectory,
    subagentDirectory,
    sizeBytes: stat.size + subagentStats.reduce((total, entry) => total + entry.size, 0),
    signature,
    createdAt: info.createdAt || stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    cwd,
    workspace: path.basename(cwd) || "Unknown workspace",
    title: info.title || compact(info.firstPrompt, 96) || info.slug || `${path.basename(cwd) || "Claude"} · ${id.slice(0, 8)}`,
    latestPrompt: compact(info.lastPrompt || info.firstPrompt, 180),
    version: info.version,
    model: info.model,
    slug: info.slug,
    subagentCount,
  };
  fileCache.set(file, { signature, record });
  return record;
}

function publicRecord(record) {
  return {
    id: record.id,
    shortId: record.shortId,
    title: record.title,
    latestPrompt: record.latestPrompt,
    cwd: record.cwd,
    workspace: record.workspace,
    file: record.file,
    fileName: path.basename(record.file),
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active: Date.now() - new Date(record.updatedAt).getTime() < 5 * 60 * 1000,
    isSubagent: false,
    parentId: null,
    agentPath: "/root",
    agentNickname: null,
    sourceSessionId: record.id,
    conversationId: record.id,
    memberCount: 1 + record.subagentCount,
    subagentCount: record.subagentCount,
    cliVersion: record.version,
    modelId: record.model,
  };
}

export async function refreshSessionIndex() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const files = await findRootFiles();
    const records = (await Promise.all(files.map(async (file) => {
      try { return await inspectFile(file); } catch { return null; }
    }))).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const previous = new Map([...indexById].map(([id, record]) => [id, record.signature]));
    const next = new Map(records.map((record) => [record.id, record]));
    const addedIds = records.filter((record) => !previous.has(record.id)).map((record) => record.id);
    const changedIds = records.filter((record) => previous.has(record.id) && previous.get(record.id) !== record.signature).map((record) => record.id);
    const removedIds = [...previous.keys()].filter((id) => !next.has(id));
    indexById.clear();
    for (const record of records) indexById.set(record.id, record);
    if (addedIds.length || changedIds.length || removedIds.length || revision === 0) revision += 1;
    return { provider: "claude", revision, addedIds, changedIds, removedIds };
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function listSessions() {
  await refreshSessionIndex();
  const sessions = [...indexById.values()].map(publicRecord);
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
    provider: "claude",
    providerLabel: "Claude Code",
    revision,
    directories: roots.map((root) => ({ path: root.directory })),
    metrics: { total: sessions.length, projects: projects.length, sourceFiles: sessions.reduce((total, session) => total + session.memberCount, 0), merged: sessions.reduce((total, session) => total + session.subagentCount, 0), active: sessions.filter((session) => session.active).length },
    projects,
    sessions,
  };
}

async function readAgentCatalog(rootFile) {
  const catalog = new Map();
  const reader = readline.createInterface({ input: fs.createReadStream(rootFile), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "attachment" || event.attachment?.type !== "agent_listing_delta") continue;
    const types = event.attachment.addedTypes || [];
    const lines = event.attachment.addedLines || [];
    for (const [index, type] of types.entries()) {
      const rawDefinition = lines[index] || "";
      const toolMatch = rawDefinition.match(/\(Tools:\s*([^)]*)\)\s*$/);
      const prefix = rawDefinition.replace(/^\s*-\s*[^:]+:\s*/, "").replace(/\s*\(Tools:[^)]*\)\s*$/, "").trim();
      catalog.set(type, {
        agentType: type,
        description: prefix,
        declaredTools: toolMatch?.[1]?.trim() || "未在 agent listing 中声明",
        rawDefinition,
        source: "attachment.agent_listing_delta",
      });
    }
  }
  return catalog;
}

async function readCustomAgentDefinition(root, agentType) {
  const candidates = [
    path.join(root.cwd || "", ".claude", "agents", `${agentType}.md`),
    path.join(claudeHome, "agents", `${agentType}.md`),
  ];
  for (const candidate of candidates) {
    try {
      const content = await fsp.readFile(candidate, "utf8");
      return { source: candidate, content };
    } catch { /* try the next definition scope */ }
  }
  return null;
}

async function loadSubagentRecords(root, catalog) {
  const entries = await fsp.readdir(root.subagentDirectory, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".jsonl"))) {
    const file = path.join(root.subagentDirectory, entry.name);
    const agentFileId = path.basename(entry.name, ".jsonl");
    const agentId = agentFileId.replace(/^agent-/, "");
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(root.subagentDirectory, `${agentFileId}.meta.json`), "utf8")); } catch { /* optional */ }
    const catalogEntry = catalog.get(meta.agentType) || null;
    const customDefinition = await readCustomAgentDefinition(root, meta.agentType);
    const stat = await fsp.stat(file);
    records.push({
      id: `${root.id}:${agentFileId}`,
      agentId,
      shortId: agentId.slice(0, 8),
      file,
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      cwd: root.cwd,
      workspace: root.workspace,
      title: meta.description || `${meta.agentType || "Sub-agent"} · ${agentId.slice(0, 8)}`,
      isSubagent: true,
      parentId: root.id,
      agentPath: `/subagents/${agentId}`,
      agentNickname: meta.description || meta.agentType || `Agent ${agentId.slice(0, 4)}`,
      agentType: meta.agentType || "Sub-agent",
      spawnDepth: meta.spawnDepth || 1,
      toolUseId: meta.toolUseId || null,
      agentDefinition: catalogEntry,
      customDefinition,
      model: root.model,
      version: root.version,
    });
  }
  return records.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

async function externalToolOutput(record, tool, output) {
  const direct = path.join(path.dirname(record.file), path.basename(record.file, ".jsonl"), "tool-results", `${tool.callId}.txt`);
  try {
    const text = await fsp.readFile(direct, "utf8");
    if (text.length > output.length) return text;
  } catch { /* not externalized under the call id */ }
  const references = output.match(/(?:Full output|output_file):\s*([^\n<]+)/g) || [];
  for (const reference of references) {
    const candidate = reference.replace(/^[^:]+:\s*/, "").trim();
    if (!candidate.startsWith(claudeHome)) continue;
    try {
      const text = await fsp.readFile(candidate, "utf8");
      if (text.length > output.length) return text;
    } catch { /* source may have been cleaned up */ }
  }
  return output;
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
  let currentTurn = null;
  let turnNumber = 0;
  let openBatch = null;
  let activeMessageId = null;
  let lastTimestamp = record.createdAt;
  let running = false;

  const flushBatch = () => {
    if (!openBatch) return;
    const type = openBatch.tools.some((tool) => tool.category === "agent") ? "agent" : "tool";
    items.push({ type, timestamp: openBatch.timestamp, turnId: openBatch.turnId, label: type === "agent" ? "Agent 协作批次" : "工具调用批次", summary: `${openBatch.tools.length} 个调用与结果`, content: openBatch.tools.map((tool) => `${tool.name}: ${tool.action} (${tool.status})`).join("\n"), tools: openBatch.tools, modelMessageId: openBatch.modelMessageId });
    openBatch = null;
  };
  const closeTurn = (timestamp) => {
    if (!currentTurn) return;
    flushBatch();
    const turn = turns.findLast((candidate) => candidate.id === currentTurn);
    if (turn) Object.assign(turn, { completedAt: timestamp, status: "completed" });
    const last = items.findLast((item) => item.turnId === currentTurn);
    if (last?.type === "model") Object.assign(last, { type: "final", label: "最终回答", phase: "final_answer" });
    currentTurn = null;
    activeMessageId = null;
    running = false;
  };

  const reader = readline.createInterface({ input: fs.createReadStream(record.file), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    lastTimestamp = event.timestamp || event.snapshot?.timestamp || lastTimestamp;
    if (event.type === "system" && event.subtype === "turn_duration") {
      closeTurn(lastTimestamp);
      continue;
    }
    if (event.type === "user") {
      const content = event.message?.content;
      const parts = Array.isArray(content) ? content : [];
      const results = parts.filter((part) => part?.type === "tool_result");
      for (const result of results) {
        const tool = calls.get(result.tool_use_id);
        if (!tool) continue;
        const candidates = [result.content, event.toolUseResult].filter((value) => value != null).map(rawText).sort((a, b) => b.length - a.length);
        tool.output = await externalToolOutput(record, tool, candidates[0] || "");
        tool.status = result.is_error ? "failed" : "completed";
        tool.completedAt = lastTimestamp;
      }
      const userText = typeof content === "string" ? content : parts.filter((part) => part?.type === "text").map((part) => part.text).filter(Boolean).join("\n");
      if (!results.length && userText) {
        closeTurn(lastTimestamp);
        turnNumber += 1;
        currentTurn = `${record.isSubagent ? `agent-${record.agentId}` : "claude"}-turn-${turnNumber}`;
        running = true;
        turns.push({ id: currentTurn, startedAt: lastTimestamp, completedAt: null, status: "running", promptId: event.promptId || null });
        items.push({ type: "user", label: record.isSubagent ? "Agent 任务" : "用户消息", summary: compact(userText), content: userText, timestamp: lastTimestamp, turnId: currentTurn, messageUuid: event.uuid || null });
      }
      continue;
    }
    if (event.type !== "assistant") continue;
    const messageId = event.message?.id || event.uuid;
    if (activeMessageId && messageId !== activeMessageId) flushBatch();
    activeMessageId = messageId;
    const parts = Array.isArray(event.message?.content) ? event.message.content : [];
    const text = parts.filter((part) => part?.type === "text").map((part) => part.text).filter(Boolean).join("\n");
    if (text) {
      flushBatch();
      items.push({ type: "model", label: "模型消息", summary: compact(text), content: text, timestamp: lastTimestamp, turnId: currentTurn, phase: "assistant", messageUuid: event.uuid || null, modelMessageId: messageId, model: event.message?.model || null, usage: event.message?.usage || null });
    }
    const toolUses = parts.filter((part) => part?.type === "tool_use");
    if (toolUses.length) {
      if (!openBatch) openBatch = { timestamp: lastTimestamp, turnId: currentTurn, modelMessageId: messageId, tools: [] };
      for (const call of toolUses) {
        const classified = classifyTool(call.name, rawText(call.input));
        const tool = { id: call.id || `tool-${calls.size + 1}`, callId: call.id || null, timestamp: lastTimestamp, status: "running", name: call.name || "tool", title: call.name || "tool", ...classified, input: rawText(call.input), output: "", modelMessageId: messageId };
        openBatch.tools.push(tool);
        if (call.id) calls.set(call.id, tool);
      }
    }
  }
  closeTurn(lastTimestamp);
  flushBatch();
  if (!items.length) items.push({ type: "model", label: "空 Session", summary: "尚无可展示的消息或工具调用", content: "该 Session 当前只有元数据。", timestamp: record.createdAt, turnId: null });
  return { record, items: mergeModelSteps(items), turns: turns.length, turnMeta: turns, status: running ? "running" : "completed", lastTimestamp };
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
  const rootRecord = indexById.get(sessionId);
  if (!rootRecord) {
    const error = new Error(`Claude Code session ${sessionId} not found`);
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  const agentCatalog = await readAgentCatalog(rootRecord.file);
  const childRecords = await loadSubagentRecords(rootRecord, agentCatalog);
  const parsed = [await parseThread({ ...rootRecord, isSubagent: false, agentPath: "/root", agentNickname: "Root" })];
  for (const record of childRecords) parsed.push(await parseThread(record));

  for (const thread of parsed.slice(1)) {
    const observed = new Map();
    for (const tool of thread.items.flatMap((item) => item.tools || [])) observed.set(tool.name, (observed.get(tool.name) || 0) + 1);
    const firstTask = thread.items.find((item) => item.type === "user");
    if (!firstTask) continue;
    const definition = thread.record.agentDefinition;
    const custom = thread.record.customDefinition;
    firstTask.agentContext = {
      provider: "claude",
      agentType: thread.record.agentType,
      description: thread.record.agentNickname,
      spawnDepth: thread.record.spawnDepth,
      spawnToolUseId: thread.record.toolUseId,
      systemPrompt: custom ? {
        status: "agent_definition_available",
        content: custom.content,
        source: custom.source,
        note: "这是 Claude Code 加载的自定义 Agent definition；运行时最终系统提示词还会叠加 Claude Code 内置基础指令，Session 未保存最终拼装结果。",
      } : {
        status: "not_persisted",
        content: "",
        source: "Claude Code Session JSONL",
        note: `该历史 Session 没有保存 ${thread.record.agentType} Agent 最终解析后的 system prompt，无法无损恢复。下面保留运行时写入日志的 Agent definition。`,
      },
      agentDefinition: definition || {
        agentType: thread.record.agentType,
        description: thread.record.agentNickname,
        declaredTools: "未在 Session 的 agent listing 中找到",
        rawDefinition: "",
        source: "subagent meta",
      },
      observedTools: [...observed.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    };
  }

  const nodes = [];
  const edges = [];
  const perThread = new Map();
  const provisionalThreads = [];
  for (const [threadIndex, thread] of parsed.entries()) {
    const laneY = 105 + threadIndex * 300;
    const threadNodes = thread.items.map((item, itemIndex) => ({ id: `${thread.record.id}:${item.turnId || "session"}:${itemIndex + 1}`, x: 0, y: laneY - (["tool", "agent"].includes(item.type) ? 7 : 0), width: 232, height: ["tool", "agent"].includes(item.type) ? 132 : 116, threadId: thread.record.id, ...item }));
    nodes.push(...threadNodes);
    perThread.set(thread.record.id, threadNodes);
    provisionalThreads.push({ parsed: thread, laneY, threadNodes });
    for (let index = 1; index < threadNodes.length; index += 1) edges.push({ from: threadNodes[index - 1].id, to: threadNodes[index].id, type: "sequence", label: "" });
  }

  const parentByChild = new Map();
  for (const child of parsed.slice(1)) {
    const spawnNode = nodes.find((node) => node.tools?.some((tool) => tool.callId === child.record.toolUseId));
    const parentId = spawnNode?.threadId || rootRecord.id;
    parentByChild.set(child.record.id, parentId);
    const childNodes = perThread.get(child.record.id) || [];
    const parentNodes = perThread.get(parentId) || [];
    if (!childNodes.length || !parentNodes.length) continue;
    const spawn = spawnNode || [...parentNodes].reverse().find((node) => new Date(node.timestamp) <= new Date(child.record.createdAt)) || parentNodes[0];
    edges.push({ from: spawn.id, to: childNodes[0].id, type: "spawn", label: child.record.agentNickname || "sub-agent" });
    const returned = parentNodes.find((node) => node.tools?.some((tool) => /TaskOutput/i.test(tool.name) && tool.input.includes(child.record.agentId))) || parentNodes.find((node) => new Date(node.timestamp) >= new Date(child.lastTimestamp));
    if (returned) edges.push({ from: childNodes.at(-1).id, to: returned.id, type: "return", label: "result" });
  }

  const layout = applyCausalLayout(nodes, edges);
  const threads = provisionalThreads.map(({ parsed: thread, laneY }, index) => ({
    id: thread.record.id,
    name: thread.record.isSubagent ? thread.record.agentType : "Root Agent",
    path: thread.record.agentPath || "/root",
    nickname: thread.record.agentNickname || (index === 0 ? "Root" : `Agent ${index}`),
    parentId: index === 0 ? null : parentByChild.get(thread.record.id) || rootRecord.id,
    laneY,
    status: thread.status,
    turns: thread.turns,
    color: index === 0 ? "acid" : colors[(index - 1) % colors.length],
  }));
  const graphTurns = parsed.flatMap((thread) => thread.turnMeta.map((turn, turnIndex) => {
    const turnNodes = (perThread.get(thread.record.id) || []).filter((node) => node.turnId === turn.id);
    return { ...turn, threadId: thread.record.id, index: turnIndex + 1, nodeIds: turnNodes.map((node) => node.id), minX: turnNodes.length ? Math.min(...turnNodes.map((node) => node.x)) : 0, maxX: turnNodes.length ? Math.max(...turnNodes.map((node) => node.x + node.width)) : 0 };
  }));
  const root = parsed[0];
  const allTools = nodes.flatMap((node) => node.tools || []);
  const session = { id: rootRecord.id, shortId: rootRecord.shortId, title: rootRecord.title, status: root.status, startedAt: rootRecord.createdAt, completedAt: root.status === "completed" ? root.lastTimestamp : null, updatedAt: rootRecord.updatedAt, cwd: rootRecord.cwd, cliVersion: rootRecord.version, modelId: rootRecord.model, provider: "claude" };
  const trace = deriveTrace({ provider: "claude", session, threads, parsed, nodesByThread: perThread });
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    source: { provider: "claude", providerLabel: "Claude Code", adapterVersion: 1, mode: "live-local-session-graph", rootFile: rootRecord.file, childFiles: childRecords.map((record) => record.file), directory: claudeHome, note: "Claude message/content blocks 按 UUID 顺序归一化，tool_use/tool_result 按 call ID 配对，Sub-agent 由 meta toolUseId 连接。" },
    session: { id: rootRecord.id, shortId: rootRecord.shortId, title: rootRecord.title, status: root.status, startedAt: rootRecord.createdAt, completedAt: root.status === "completed" ? root.lastTimestamp : null, updatedAt: rootRecord.updatedAt, cwd: rootRecord.cwd, cliVersion: rootRecord.version, modelId: rootRecord.model, provider: "claude" },
    graph: { width: Math.max(900, 70 + layout.layers * 275), height: Math.max(400, 250 + (threads.length - 1) * 300), nodes, edges, threads, turns: graphTurns, rootNodeId: layout.rootNodeId },
    trace,
    metrics: { threads: threads.length, runs: trace.metrics.runs, turns: trace.metrics.turns, nodes: nodes.length, toolCalls: allTools.length, subAgents: childRecords.length },
  };
}

export function claudeDirectories() {
  return roots.map((root) => ({ path: root.directory }));
}

/**
 * The input context Claude Code keeps in a session file.
 *
 * Claude does not persist the assembled system prompt, so this reports that
 * gap instead of inventing one. It does persist the skill listing, the agent
 * listing and permission hook decisions, which are the parts that changed how
 * the model behaved.
 */
export async function buildSessionContext(sessionId) {
  await refreshSessionIndex();
  const rootRecord = indexById.get(sessionId);
  if (!rootRecord) {
    const error = new Error(`Claude Code session ${sessionId} not found`);
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  const catalog = await readAgentCatalog(rootRecord.file);
  const members = await loadSubagentRecords(rootRecord, catalog);
  const files = [rootRecord.file, ...members.map((record) => record.file)];
  const contexts = [];
  for (const [index, file] of files.entries()) {
    const context = {
      threadId: index === 0 ? rootRecord.id : members[index - 1]?.id,
      file,
      nickname: index === 0 ? "Root" : members[index - 1]?.agentNickname,
      agentPath: index === 0 ? "/root" : members[index - 1]?.agentPath,
      systemPrompt: null,
      systemPromptNote: "Claude Code 不把最终拼装的 system prompt 写入 session JSONL，只能看到它派生的 skill/agent 清单。",
      developerInstructions: null,
      agentsMd: null,
      skills: null,
      agents: null,
      tools: null,
      permissions: null,
      attachments: {},
      model: index === 0 ? rootRecord.model : null,
      effort: null,
      approvalPolicy: null,
      sandbox: null,
      cwd: rootRecord.cwd,
      cliVersion: rootRecord.version,
      originator: "Claude Code",
    };
    const reader = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== "attachment") continue;
      const attachment = event.attachment || {};
      const type = attachment.type || "unknown";
      context.attachments[type] = (context.attachments[type] || 0) + 1;
      if (type === "skill_listing" && attachment.content) context.skills = attachment.content;
      if (type === "agent_listing_delta" && attachment.addedLines) context.agents = attachment.addedLines.join("\n");
      if (type === "hook_permission_decision") {
        context.permissions ||= { decisions: [] };
        if (context.permissions.decisions.length < 30) context.permissions.decisions.push({ decision: attachment.decision, toolUseID: attachment.toolUseID || null, hookEvent: attachment.hookEvent || null });
      }
    }
    reader.close();
    contexts.push(context);
  }
  return {
    provider: "claude",
    sessionId,
    note: "Claude Code 只持久化附件事实（技能清单、Agent 清单、权限 hook 决策）；最终 system prompt 需要付费 API 才能取回，这里明确标注缺失。",
    contexts,
  };
}
