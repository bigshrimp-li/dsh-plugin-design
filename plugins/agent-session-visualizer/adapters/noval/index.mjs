import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { deriveTrace } from "../common/trace.mjs";

const LOG_DIR_NAME = ".noval/session-logs";
const colors = ["violet", "blue", "rose", "acid"];

function compact(value, length = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, length);
}

function rawText(value) {
  if (typeof value === "string") return value;
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function classifyTool(name, input) {
  const source = `${name || ""} ${input || ""}`;
  if (/submit_|report_/i.test(name || "")) return { category: "submit", action: "提交结果" };
  if (/write|edit|patch|delete|move|rename/i.test(source)) return { category: "write", action: "写入或修改文件" };
  if (/read|list|find|grep|glob|bash|command/i.test(source)) return { category: "read", action: "读取或检查数据" };
  return { category: "tool", action: "执行工具" };
}

async function findSessionFiles(workspaceRoot) {
  const dir = path.join(workspaceRoot, LOG_DIR_NAME);
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => ({ file: path.join(dir, e.name), conversationId: e.name.replace(/\.jsonl$/, "") }));
}

async function inspectFile(entry) {
  const stat = await fsp.stat(entry.file);
  let meta = null;
  let lastPrompt = "";
  try {
    const reader = readline.createInterface({ input: fs.createReadStream(entry.file), crlfDelay: Infinity });
    let lineCount = 0;
    for await (const line of reader) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "session_meta" && !meta) {
          meta = event;
        }
        if (event.type === "message" && event.role === "user") {
          lastPrompt = compact(event.content, 180);
        }
      } catch {
        // skip malformed lines
      }
      lineCount += 1;
      if (lineCount > 200) break;
    }
  } catch {
    // ignore
  }
  const sessionId = meta?.sessionId || entry.conversationId;
  const workspaceRoot = meta?.workspaceRoot || "";
  return {
    id: sessionId,
    shortId: String(sessionId).slice(0, 8),
    conversationId: entry.conversationId,
    file: entry.file,
    fileName: path.basename(entry.file),
    sizeBytes: stat.size,
    createdAt: meta?.startedAt || stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    workspace: path.basename(workspaceRoot) || "Unknown workspace",
    workspaceRoot,
    cwd: workspaceRoot,
    title: lastPrompt || `${meta?.taskType || "session"} · ${String(sessionId).slice(0, 8)}`,
    latestPrompt: lastPrompt,
    model: meta?.model || "unknown",
    taskType: meta?.taskType || "",
    mode: meta?.mode || "agent",
    status: "unknown"
  };
}

export async function listSessions({ workspaceRoot } = {}) {
  if (!workspaceRoot) return { provider: "noval", sessions: [], projects: [] };
  const files = await findSessionFiles(workspaceRoot);
  const records = (await Promise.all(files.map(inspectFile))).filter(Boolean);
  records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const projectMap = new Map();
  for (const session of records) {
    const projectPath = session.workspaceRoot || "未关联工程目录";
    const project = projectMap.get(projectPath) || {
      id: projectPath,
      name: session.workspace || "未关联工程",
      path: projectPath,
      count: 0,
      updatedAt: session.updatedAt
    };
    project.count += 1;
    if (new Date(session.updatedAt) > new Date(project.updatedAt)) project.updatedAt = session.updatedAt;
    projectMap.set(projectPath, project);
  }
  return {
    provider: "noval",
    providerLabel: "Noval",
    revision: 0,
    directories: workspaceRoot ? [{ path: workspaceRoot }] : [],
    metrics: {
      total: records.length,
      projects: projectMap.size,
      sourceFiles: records.length,
      merged: 0,
      active: 0
    },
    sessions: records,
    projects: [...projectMap.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  };
}

function parseThreadEvents(events, threadId) {
  const items = [];
  const turns = new Map();
  const calls = new Map();
  let currentTurn = null;
  let openBatch = null;

  // 预扫描：收集本线程中实际出现过消息/工具事件的 turnId。
  // turn_start/turn_complete 事件可能不带 threadId（旧日志），
  // 因此需要通过同 turnId 的消息/工具事件来判断该 turn 是否属于本线程。
  const activeTurnIds = new Set();
  for (const event of events) {
    if (event.threadId && event.threadId !== threadId) continue;
    if ((event.type === "message" || event.type === "tool_call" || event.type === "tool_result") && event.turnId) {
      activeTurnIds.add(event.turnId);
    }
  }

  const flushBatch = () => {
    if (!openBatch) return;
    const type = "tool";
    items.push({
      type,
      timestamp: openBatch.timestamp,
      turnId: openBatch.turnId,
      label: "工具调用批次",
      summary: `${openBatch.tools.length} 个调用与结果`,
      content: openBatch.tools.map((t) => `${t.name}: ${t.action} (${t.status})`).join("\n"),
      tools: openBatch.tools
    });
    openBatch = null;
  };

  for (const event of events) {
    if (event.threadId && event.threadId !== threadId) continue;
    if (event.type === "turn_start") {
      if (!activeTurnIds.has(event.turnId)) continue;
      flushBatch();
      currentTurn = event.turnId;
      turns.set(currentTurn, { id: currentTurn, threadId, startedAt: event.timestamp, completedAt: null, status: "running" });
      continue;
    }
    if (event.type === "turn_complete") {
      if (!activeTurnIds.has(event.turnId)) continue;
      flushBatch();
      const turn = turns.get(event.turnId);
      if (turn) {
        turn.completedAt = event.timestamp;
        turn.status = event.status || "completed";
      }
      if (currentTurn === event.turnId) currentTurn = null;
      continue;
    }
    if (event.type === "message" && event.role === "user") {
      flushBatch();
      items.push({
        type: "user",
        timestamp: event.timestamp,
        turnId: event.turnId || currentTurn,
        label: "用户消息",
        summary: compact(event.content),
        content: String(event.content || "")
      });
      continue;
    }
    if (event.type === "message" && event.role === "assistant") {
      flushBatch();
      items.push({
        type: "model",
        timestamp: event.timestamp,
        turnId: event.turnId || currentTurn,
        label: "模型消息",
        summary: compact(event.content),
        content: String(event.content || ""),
        usage: event.usage || null
      });
      continue;
    }
    if (event.type === "tool_call") {
      if (!openBatch) openBatch = { timestamp: event.timestamp, turnId: event.turnId || currentTurn, tools: [] };
      const classified = classifyTool(event.name, event.input);
      const tool = {
        id: event.callId || `tool-${calls.size + 1}`,
        callId: event.callId || null,
        timestamp: event.timestamp,
        status: "running",
        name: event.name,
        ...classified,
        input: rawText(event.input),
        output: ""
      };
      openBatch.tools.push(tool);
      if (tool.callId) calls.set(tool.callId, tool);
      continue;
    }
    if (event.type === "tool_result") {
      const tool = calls.get(event.callId) || openBatch?.tools.findLast((t) => t.status === "running");
      if (tool) {
        tool.output = rawText(event.output);
        tool.status = event.status || "completed";
        tool.error = event.error || "";
        tool.durationSeconds = event.durationMs ? event.durationMs / 1000 : 0;
      }
      continue;
    }
  }
  flushBatch();
  return { items, turns: [...turns.values()] };
}

export async function buildSessionGraph(sessionId, { workspaceRoot } = {}) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  const sessions = await listSessions({ workspaceRoot });
  const record = sessions.sessions.find((s) => s.id === sessionId || s.conversationId === sessionId);
  if (!record) throw new Error(`Noval session ${sessionId} not found`);

  const events = [];
  const reader = readline.createInterface({ input: fs.createReadStream(record.file), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  // 收集所有 agent_spawn 事件，用于构建子线程和 spawn/return 边
  const spawns = [];
  for (const event of events) {
    if (event.type === "agent_spawn") {
      spawns.push(event);
    }
  }

  // 构建 threads
  const threads = [];
  const rootThread = {
    id: record.id,
    name: "Root Agent",
    path: "/root",
    nickname: "Root",
    parentId: null,
    laneY: 105,
    status: "completed",
    turns: 0,
    color: "acid"
  };
  threads.push(rootThread);

  const subThreads = new Map();
  for (const spawn of spawns) {
    if (subThreads.has(spawn.childThreadId)) continue;
    const thread = {
      id: spawn.childThreadId,
      name: spawn.nickname || "Sub-agent",
      path: spawn.agentPath || "/sub",
      nickname: spawn.nickname || "Agent",
      parentId: record.id,
      laneY: 105 + (subThreads.size + 1) * 300,
      status: "completed",
      turns: 0,
      color: colors[subThreads.size % colors.length]
    };
    subThreads.set(spawn.childThreadId, thread);
    threads.push(thread);
  }

  // 解析每个 thread 的事件
  // 根线程事件的 threadId 为空字符串，因此用 record.id 作为 threadId 传入，
  // 使 turn.threadId 与根线程 id 一致。
  const parsed = new Map();
  parsed.set(record.id, parseThreadEvents(events, record.id));
  for (const [tid] of subThreads) {
    parsed.set(tid, parseThreadEvents(events, tid));
  }

  // 构建节点和边
  const nodes = [];
  const edges = [];
  const perThread = new Map();

  for (const thread of threads) {
    const laneY = thread.laneY;
    const threadData = parsed.get(thread.id) || { items: [], turns: [] };
    thread.turns = threadData.turns.length;
    const threadNodes = threadData.items.map((item, index) => ({
      id: `${thread.id}:${item.turnId || "session"}:${index + 1}`,
      x: 0,
      y: laneY - (item.type === "tool" ? 7 : 0),
      width: 232,
      height: item.type === "tool" ? 132 : 116,
      threadId: thread.id,
      ...item
    }));
    nodes.push(...threadNodes);
    perThread.set(thread.id, threadNodes);
    for (let i = 1; i < threadNodes.length; i += 1) {
      edges.push({ from: threadNodes[i - 1].id, to: threadNodes[i].id, type: "sequence", label: "" });
    }
  }

  // agent_spawn / agent_return 边
  for (const spawn of spawns) {
    const childNodes = perThread.get(spawn.childThreadId) || [];
    const parentNodes = perThread.get(record.id) || [];
    if (!childNodes.length || !parentNodes.length) continue;
    // spawn 边：找到 spawn 事件之前最近的父节点
    const spawnEvent = events.find((e) => e.type === "agent_spawn" && e.childThreadId === spawn.childThreadId);
    const spawnTime = spawnEvent?.timestamp;
    let spawnNode = parentNodes.find((n) => n.timestamp && spawnTime && new Date(n.timestamp) <= new Date(spawnTime));
    if (!spawnNode) spawnNode = parentNodes[parentNodes.length - 1];
    edges.push({ from: spawnNode.id, to: childNodes[0].id, type: "spawn", label: spawn.nickname || "sub-agent" });

    // return 边
    const returnEvent = events.find((e) => e.type === "agent_return" && e.childThreadId === spawn.childThreadId);
    if (returnEvent) {
      const returnTime = returnEvent.timestamp;
      let returnNode = parentNodes.find((n) => n.timestamp && returnTime && new Date(n.timestamp) >= new Date(returnTime));
      if (!returnNode) returnNode = parentNodes[parentNodes.length - 1];
      edges.push({ from: childNodes[childNodes.length - 1].id, to: returnNode.id, type: "return", label: "result" });
    }
  }

  // 计算布局（简单的从左到右）
  const layers = new Map();
  const visited = new Set();
  function assignLayer(nodeId, layer) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    layers.set(nodeId, Math.max(layers.get(nodeId) || 0, layer));
    for (const edge of edges) {
      if (edge.from === nodeId) {
        assignLayer(edge.to, layer + 1);
      }
    }
  }
  const rootNodes = nodes.filter((n) => !edges.some((e) => e.to === n.id));
  for (const node of rootNodes) assignLayer(node.id, 0);

  for (const node of nodes) {
    const layer = layers.get(node.id) || 0;
    node.x = 70 + layer * 275;
  }

  const maxLayer = Math.max(0, ...[...layers.values()]);
  const allTools = nodes.flatMap((n) => n.tools || []);

  const session = {
    id: record.id,
    shortId: record.shortId,
    title: record.title,
    status: record.status,
    startedAt: record.createdAt,
    completedAt: record.updatedAt,
    cwd: record.workspaceRoot,
    model: record.model,
    taskType: record.taskType,
    provider: "noval"
  };
  const parsedThreads = threads.map((thread) => {
    const data = parsed.get(thread.id) || { items: [], turns: [] };
    const lastItem = data.items.at(-1);
    return { record: { id: thread.id }, items: data.items, turnMeta: data.turns, lastTimestamp: lastItem?.timestamp || record.updatedAt };
  });
  const trace = deriveTrace({ provider: "noval", session, threads, parsed: parsedThreads, nodesByThread: perThread });
  const graphRuns = trace.threads.flatMap((thread) => thread.runs.map((run) => {
    const runNodes = nodes.filter((node) => node.threadId === thread.id && node.turnId === run.id);
    return {
      ...run,
      threadId: thread.id,
      nodeIds: runNodes.map((node) => node.id),
      minX: runNodes.length ? Math.min(...runNodes.map((node) => node.x)) : 0,
      maxX: runNodes.length ? Math.max(...runNodes.map((node) => node.x + node.width)) : 0
    };
  }));

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    source: {
      provider: "noval",
      adapterVersion: 1,
      mode: "live-local-session-graph",
      rootFile: record.file,
      workspaceRoot: record.workspaceRoot,
      note: "从本地 Noval session JSONL 按需生成的执行图。"
    },
    session: {
      id: record.id,
      shortId: record.shortId,
      title: record.title,
      status: record.status,
      startedAt: record.createdAt,
      completedAt: record.updatedAt,
      cwd: record.workspaceRoot,
      model: record.model,
      taskType: record.taskType,
      provider: "noval"
    },
    graph: {
      width: Math.max(900, 70 + (maxLayer + 1) * 275),
      height: Math.max(400, 250 + (threads.length - 1) * 300),
      nodes,
      edges,
      threads,
      turns: graphRuns,
      rootNodeId: rootNodes[0]?.id || nodes[0]?.id || null
    },
    trace,
    metrics: {
      threads: threads.length,
      runs: trace.metrics.runs,
      turns: trace.metrics.turns,
      nodes: nodes.length,
      toolCalls: allTools.length,
      subAgents: subThreads.size
    }
  };
}
