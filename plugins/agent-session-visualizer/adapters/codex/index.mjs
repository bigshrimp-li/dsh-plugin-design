import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { addUsage, buildTrace, durationMs, emptyUsage, normalizeUsage, traceItem } from "../common/trace.mjs";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const roots = [
  { directory: path.join(codexHome, "sessions") },
];
const colors = ["violet", "blue", "rose", "acid"];
const indexById = new Map();
const fileCache = new Map();
let revision = 0;
let refreshPromise = null;

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || part?.content || part?.input_text || "").filter(Boolean).join("\n");
}

function visibleUserText(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const ignored = /^(<recommended_plugins>|# AGENTS\.md instructions|<environment_context>|<app-context>|<skills_instructions>|<permissions instructions>|<collaboration_mode>)/;
  return content
    .map((part) => part?.text || part?.content || part?.input_text || "")
    .filter((text) => text && !ignored.test(text.trim()))
    .join("\n")
    .replace(/<external_[a-z_]+>[\s\S]*?<\/external_[a-z_]+>/g, "")
    .trim();
}

function rawText(value) {
  if (typeof value === "string") return value;
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function compact(value, length = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, length);
}

function sourceInfo(meta) {
  const spawn = meta?.source?.subagent?.thread_spawn;
  return {
    isSubagent: Boolean(spawn),
    parentId: spawn?.parent_thread_id || null,
    agentPath: spawn?.agent_path || "/root",
    agentNickname: spawn?.agent_nickname || null,
    depth: spawn?.depth || 0,
  };
}

async function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [{ file: full }] : [];
  }));
  return nested.flat();
}

async function readFirstLine(file) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
  } finally {
    await handle.close();
  }
}

async function readSample(file, size) {
  const handle = await fsp.open(file, "r");
  try {
    const chunkSize = Math.min(256 * 1024, size);
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

function userMessagesFromSample(sample) {
  const messages = [];
  for (const line of sample.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "response_item" || event.payload?.type !== "message" || event.payload.role !== "user") continue;
      const text = visibleUserText(event.payload.content);
      if (text) messages.push(text);
    } catch {
      // Head/tail samples can start or end in the middle of a JSONL record.
    }
  }
  return messages;
}

async function inspectFile(entry) {
  const stat = await fsp.stat(entry.file);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = fileCache.get(entry.file);
  if (cached?.signature === signature) return cached.record;
  const firstLine = await readFirstLine(entry.file);
  const first = JSON.parse(firstLine);
  if (first.type !== "session_meta") throw new Error(`Missing session_meta in ${entry.file}`);
  const meta = first.payload || {};
  const source = sourceInfo(meta);
  const id = meta.id || path.basename(entry.file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1];
  if (!id) throw new Error(`Missing session id in ${entry.file}`);
  const workspace = path.basename(meta.cwd || "") || "Unknown workspace";
  const fallbackTitle = source.isSubagent
    ? `${source.agentNickname || "Sub-agent"} · ${source.agentPath}`
    : `${workspace} · ${id.slice(0, 8)}`;
  const record = {
    id,
    shortId: id.slice(0, 8),
    file: entry.file,
    fileName: path.basename(entry.file),
    sizeBytes: stat.size,
    createdAt: meta.timestamp || stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    cwd: meta.cwd || "",
    workspace,
    originator: meta.originator || "Codex",
    cliVersion: meta.cli_version || "unknown",
    title: cached?.record?.title || fallbackTitle,
    latestPrompt: cached?.record?.latestPrompt || "",
    ...source,
  };
  fileCache.set(entry.file, { signature, record });
  return record;
}

async function enrichRecord(record) {
  const cached = fileCache.get(record.file);
  if (cached?.sampleSignature === cached.signature) return record;
  const sample = await readSample(record.file, record.sizeBytes);
  const messages = userMessagesFromSample(sample);
  if (messages.length) {
    record.title = compact(messages[0], 96);
    record.latestPrompt = compact(messages.at(-1), 180);
  }
  cached.sampleSignature = cached.signature;
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
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active: Date.now() - new Date(record.updatedAt).getTime() < 5 * 60 * 1000,
    isSubagent: record.isSubagent,
    parentId: record.parentId,
    agentPath: record.agentPath,
    agentNickname: record.agentNickname,
    depth: record.depth,
    originator: record.originator,
    cliVersion: record.cliVersion,
  };
}

export async function refreshSessionIndex() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const entries = (await Promise.all(roots.map((root) => walk(root.directory)))).flat();
    const inspected = await Promise.all(entries.map(async (entry) => {
      try { return await inspectFile(entry); } catch { return null; }
    }));
    const longestById = new Map();
    for (const record of inspected.filter(Boolean)) {
      const existing = longestById.get(record.id);
      if (!existing || record.sizeBytes > existing.sizeBytes) longestById.set(record.id, record);
    }
    const records = [...longestById.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    await Promise.all(records.slice(0, 120).map(enrichRecord));

    const previous = new Map([...indexById].map(([id, record]) => [id, `${record.sizeBytes}:${record.updatedAt}`]));
    const next = new Map(records.map((record) => [record.id, record]));
    const addedIds = records.filter((record) => !previous.has(record.id)).map((record) => record.id);
    const changedIds = records.filter((record) => previous.has(record.id) && previous.get(record.id) !== `${record.sizeBytes}:${record.updatedAt}`).map((record) => record.id);
    const removedIds = [...previous.keys()].filter((id) => !next.has(id));
    indexById.clear();
    for (const record of records) indexById.set(record.id, record);
    if (addedIds.length || changedIds.length || removedIds.length || revision === 0) revision += 1;
    return { revision, addedIds, changedIds, removedIds };
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function listSessions() {
  await refreshSessionIndex();
  const sourceRecords = [...indexById.values()];
  const rootRecordFor = (record) => {
    let current = record;
    const visited = new Set([record.id]);
    while (current.parentId && indexById.has(current.parentId) && !visited.has(current.parentId)) {
      visited.add(current.parentId);
      current = indexById.get(current.parentId);
    }
    return current;
  };
  const conversations = new Map();
  for (const record of sourceRecords) {
    const rootRecord = rootRecordFor(record);
    const group = conversations.get(rootRecord.id) || { rootRecord, members: [] };
    group.members.push(record);
    conversations.set(rootRecord.id, group);
  }
  const sessions = [...conversations.values()].map(({ rootRecord, members }) => {
    const longest = [...members].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    const latest = [...members].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const representative = publicRecord(longest);
    return {
      ...representative,
      id: rootRecord.id,
      shortId: rootRecord.shortId,
      conversationId: rootRecord.id,
      sourceSessionId: longest.id,
      cwd: rootRecord.cwd || representative.cwd,
      workspace: rootRecord.workspace || representative.workspace,
      isSubagent: false,
      parentId: null,
      agentPath: "/root",
      agentNickname: null,
      updatedAt: latest.updatedAt,
      active: members.some((member) => Date.now() - new Date(member.updatedAt).getTime() < 5 * 60 * 1000),
      memberCount: members.length,
      subagentCount: members.filter((member) => member.isSubagent).length,
    };
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const projectMap = new Map();
  for (const session of sessions) {
    const projectPath = session.cwd || "未关联工程目录";
    const project = projectMap.get(projectPath) || {
      id: projectPath,
      name: session.cwd ? path.basename(session.cwd) : "未关联工程",
      path: projectPath,
      count: 0,
      active: 0,
      updatedAt: session.updatedAt,
    };
    project.count += 1;
    project.active += session.active ? 1 : 0;
    if (new Date(session.updatedAt) > new Date(project.updatedAt)) project.updatedAt = session.updatedAt;
    projectMap.set(projectPath, project);
  }
  const projects = [...projectMap.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return {
    provider: "codex",
    revision,
    directories: roots.map((root) => ({ path: root.directory })),
    metrics: {
      total: sessions.length,
      projects: projects.length,
      sourceFiles: sourceRecords.length,
      merged: sourceRecords.length - sessions.length,
      active: sessions.filter((session) => session.active).length,
    },
    projects,
    sessions,
  };
}

function classifyTool(name, input) {
  const source = `${name || ""} ${input || ""}`;
  if (/spawn_agent|followup_task|wait_agent|send_message|collaboration/i.test(source)) return { category: "agent", action: "Agent 协作" };
  if (/web|browser|search/i.test(source)) return { category: "web", action: "网络或浏览器操作" };
  if (/apply_patch|write|edit/i.test(source)) return { category: "write", action: "写入或修改文件" };
  if (/read|list|find|rg |sed |cat |exec_command/i.test(source)) return { category: "read", action: "读取或检查数据" };
  if (/update_plan|goal/i.test(source)) return { category: "state", action: "更新执行状态" };
  return { category: "tool", action: "执行工具" };
}


/** The response-family prefix shared by ids of one thread, never one response. */
function idFamily(value) {
  const match = /([0-9a-f]{22})/i.exec(String(value || ""));
  return match ? match[1] : null;
}

function runtimeItemKind(item) {
  switch (item?.type) {
    case "CommandExecution": return "tool";
    case "McpToolCall": return "tool";
    case "FileChange": return "tool";
    case "ImageView": return "tool";
    case "Reasoning": return "reasoning";
    case "AgentMessage": return "output";
    case "SubAgentActivity": return "subagent";
    case "CollabAgentToolCall": return "subagent";
    case "ContextCompaction": return "compaction";
    default: return null;
  }
}

function runtimeDuration(item, payload) {
  if (Number.isFinite(payload?.started_at_ms) && Number.isFinite(payload?.completed_at_ms)) {
    return Math.max(0, payload.completed_at_ms - payload.started_at_ms);
  }
  const seconds = item?.duration?.secs;
  if (Number.isFinite(seconds)) return Math.round((seconds + (item.duration.nanos || 0) / 1e9) * 1000);
  return null;
}

/**
 * Parse one Codex rollout into graph items plus the trace hierarchy.
 *
 * Codex's own `turn_id` is one user request through its final answer, so it is
 * the Run. A model response is delimited by `token_usage_record`: every
 * response item and every runtime item that executes before the next usage
 * record belongs to that response, which is the Turn.
 */
async function parseThread(record, { ignoredRunIds = new Set() } = {}) {
  const items = [];
  const runs = [];
  const runById = new Map();
  const calls = new Map();
  const pendingUsers = [];
  let currentRun = null;
  let openGroup = null;
  let lastGroup = null;
  let openBatch = null;
  let pendingAgentMessage = null;
  let pendingReasoning = null;
  let inputSequence = 0;
  let lastTimestamp = record.createdAt;
  let running = false;

  const pushGraphItem = (item) => {
    const nodeId = `${record.id}:${items.length + 1}`;
    items.push({ ...item, nodeId });
    return nodeId;
  };

  const openTurn = (timestamp) => {
    if (!currentRun) return null;
    if (openGroup) return openGroup;
    openGroup = {
      id: `${currentRun.id}:turn-${currentRun.turns.length + 1}`,
      runId: currentRun.id,
      index: currentRun.turns.length + 1,
      startedAt: timestamp || lastTimestamp,
      completedAt: null,
      durationMs: null,
      status: "completed",
      items: [],
      usage: null,
      model: currentRun.model || null,
    };
    currentRun.turns.push(openGroup);
    return openGroup;
  };

  const closeTurn = (timestamp) => {
    if (!openGroup) return;
    openGroup.completedAt = timestamp || openGroup.completedAt || lastTimestamp;
    openGroup.durationMs = durationMs(openGroup.startedAt, openGroup.completedAt);
    openGroup.status = openGroup.items.some((item) => item.status === "failed") ? "failed" : "completed";
    lastGroup = openGroup;
    openGroup = null;
  };

  const targetTurn = () => openGroup || lastGroup || openTurn(lastTimestamp);

  const pushTraceItem = (turn, item) => {
    if (!turn) return null;
    const entry = traceItem({ id: `${turn.id}:${turn.items.length + 1}`, ...item });
    turn.items.push(entry);
    return entry;
  };

  const closeRun = (timestamp) => {
    if (!currentRun) return;
    closeTurn(timestamp);
    currentRun.completedAt = timestamp || lastTimestamp;
    currentRun.status = "completed";
    currentRun.durationMs = durationMs(currentRun.startedAt, currentRun.completedAt);
    running = false;
    currentRun = null;
  };

  const flushBatch = () => {
    if (!openBatch) return;
    const batch = openBatch;
    openBatch = null;
    const type = batch.tools.some((tool) => tool.category === "agent") ? "agent" : "tool";
    const nodeId = pushGraphItem({
      type,
      timestamp: batch.timestamp,
      turnId: batch.turnId,
      label: type === "agent" ? "Agent 协作批次" : "工具调用批次",
      summary: `${batch.tools.length} 个调用与结果`,
      content: batch.tools.map((tool) => `${tool.name}: ${tool.action} (${tool.status})`).join("\n"),
      tools: batch.tools,
    });
    const turn = batch.turn || targetTurn();
    for (const [index, tool] of batch.tools.entries()) {
      pushTraceItem(turn, {
        kind: tool.status === "failed" ? "failure" : "tool",
        label: tool.name,
        summary: `${tool.command || tool.action} · ${tool.status}`,
        timestamp: tool.timestamp,
        durationMs: tool.durationSeconds != null ? Math.round(tool.durationSeconds * 1000) : null,
        status: tool.status,
        nodeId,
        toolIndex: index,
        category: tool.category,
        callId: tool.callId,
        command: tool.command ? String(tool.command).slice(0, 4096) : "",
        result: tool.result ? String(tool.result).slice(0, 8192) : (tool.output ? String(tool.output).slice(0, 8192) : ""),
      });
    }
  };

  const stream = fs.createReadStream(record.file, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    lastTimestamp = event.timestamp || lastTimestamp;
    const payload = event.payload || {};

    if (event.type === "event_msg" && payload.type === "task_started") {
      flushBatch();
      closeTurn(event.timestamp);
      const runId = payload.turn_id || `run-${runs.length + 1}`;
      if (ignoredRunIds.has(runId)) {
        currentRun = null;
        continue;
      }
      const run = runById.get(runId) || {
        id: runId,
        threadId: record.id,
        index: runs.length + 1,
        startedAt: event.timestamp,
        completedAt: null,
        durationMs: null,
        status: "running",
        trigger: payload.turn_attribution?.turn_trigger || null,
        prompt: null,
        promptNodeId: null,
        inputItems: [],
        finalAnswer: null,
        usage: emptyUsage(),
        turns: [],
        model: null,
      };
      if (!runById.has(runId)) {
        runs.push(run);
        runById.set(runId, run);
      }
      currentRun = run;
      running = true;
      for (const item of pendingUsers.splice(0)) {
        run.inputItems.push(item);
        const isSynthetic = item.isSynthetic || /^（外部页面打开事件）/.test(item.summary);
        if (!run.prompt || (/^（外部页面打开事件）/.test(run.prompt) && !isSynthetic)) {
          run.prompt = item.summary;
          run.promptNodeId = item.nodeId;
        }
      }
      continue;
    }

    if (event.type === "event_msg" && payload.type === "task_complete") {
      if (currentRun && currentRun.id !== payload.turn_id) continue;
      const run = runById.get(payload.turn_id);
      if (run && ignoredRunIds.has(run.id)) continue;
      flushBatch();
      if (run) {
        run.finalAnswer = payload.last_agent_message || run.finalAnswer;
        if (!run.finalAnswer) {
          const answer = [...run.turns].reverse().flatMap((turn) => turn.items).find((item) => item.kind === "answer" || item.kind === "output");
          if (answer) {
            run.finalAnswer = answer.content || null;
            run.finalAnswerNodeId = answer.nodeId || null;
          }
        }
      }
      closeRun(event.timestamp);
      continue;
    }

    if (event.type === "token_usage_record") {
      const usage = normalizeUsage(payload.usage);
      if (currentRun && usage) addUsage(currentRun.usage, usage);
      if (currentRun) {
        const turn = openGroup || openTurn(lastTimestamp);
        if (turn) {
          turn.usage = usage;
          turn.responseId = payload.response_id || null;
          turn.completedAt = event.timestamp;
          closeTurn(event.timestamp);
        }
      }
      continue;
    }

    if (event.type === "turn_context") {
      if (currentRun) {
        currentRun.model = payload.model || currentRun.model;
        currentRun.effort = payload.effort || null;
        currentRun.approvalPolicy = payload.approval_policy || null;
        currentRun.sandbox = payload.sandbox_policy?.type || null;
        currentRun.cwd = payload.cwd || currentRun.cwd;
      }
      continue;
    }

    if (event.type === "compacted") {
      const turn = targetTurn();
      pushTraceItem(turn, {
        kind: "compaction",
        label: "上下文压缩",
        summary: compact(payload.message, 200),
        timestamp: event.timestamp,
        content: payload.message || "",
      });
      continue;
    }

    if (event.type === "event_msg" && payload.type === "item_completed") {
      const item = payload.item || {};
      const kind = runtimeItemKind(item);
      const turn = targetTurn();
      const duration = runtimeDuration(item, payload);
      if (kind === "tool") {
        const tool = item.id ? calls.get(item.id) : null;
        if (tool) {
          if (Number.isFinite(item.exit_code)) tool.exitCode = item.exit_code;
          if (item.status) tool.status = item.status === "completed" ? "completed" : item.status;
          if (item.aggregated_output && !tool.output) tool.output = String(item.aggregated_output).slice(0, 4096);
          if (duration != null && tool.durationSeconds == null) tool.durationSeconds = duration / 1000;
          tool.runtime = item.type;
          if (item.command) tool.command = String(Array.isArray(item.command) ? item.command.join(" ") : item.command).slice(0, 2048);
          if (item.aggregated_output) tool.result = String(item.aggregated_output).slice(0, 4096);
        }
        if (item.type === "FileChange" && item.changes) {
          const changed = Object.keys(item.changes);
          pushTraceItem(turn, {
            kind: "tool",
            label: `文件变更 · ${changed.length} 个文件`,
            summary: changed.map((file) => path.basename(file)).join(", "),
            timestamp: event.timestamp,
            durationMs: duration,
            status: item.changes && Object.values(item.changes).some((change) => change?.type === "delete") ? "completed" : "completed",
            content: Object.entries(item.changes).map(([file, change]) => `${change?.type || "change"} ${file}\n${change?.content || ""}`).join("\n\n"),
          });
        }
        continue;
      }
      if (kind === "reasoning") {
        const text = (item.summary_text || []).join("\n\n") || (item.raw_content || []).join("\n\n");
        if (text) {
          const entry = pushTraceItem(turn, { kind: "reasoning", label: "推理摘要", summary: text, timestamp: event.timestamp, durationMs: duration, content: text });
          pendingReasoning = { text, timestamp: event.timestamp, item: entry };
        }
        continue;
      }
      if (kind === "output") {
        // The matching response_item message follows this runtime record; it
        // carries the same text and the graph node. Keep the metadata until it
        // arrives so one message never becomes two trace items.
        pendingAgentMessage = {
          text: contentText(item.content) || "",
          phase: item.phase || null,
          durationMs: duration,
          timestamp: event.timestamp,
        };
        continue;
      }
      if (kind === "subagent") {
        const isWait = item.type === "CollabAgentToolCall" && item.tool === "wait";
        pushTraceItem(turn, {
          kind: isWait ? "wait" : "subagent",
          label: item.type === "SubAgentActivity" ? `子 Agent · ${item.kind || "activity"}` : `Agent 协作 · ${item.tool || "call"}`,
          summary: [item.agent_path, ...(item.receiver_agents || []), item.status].filter(Boolean).join(" · "),
          timestamp: event.timestamp,
          durationMs: duration,
          status: item.status || null,
          agentThreadId: item.agent_thread_id || null,
          agentPath: item.agent_path || null,
        });
        continue;
      }
      if (kind === "compaction") {
        pushTraceItem(turn, { kind: "compaction", label: "上下文压缩", summary: `耗时 ${duration ?? "未知"}ms`, timestamp: event.timestamp, durationMs: duration });
      }
      continue;
    }

    if (event.type !== "response_item") continue;

    if (["custom_tool_call", "function_call", "tool_search_call"].includes(payload.type)) {
      const turn = openTurn(event.timestamp);
      if (!openBatch) openBatch = { timestamp: event.timestamp, turnId: currentRun?.id || null, tools: [], turn };
      const input = payload.input ?? payload.arguments ?? payload.query ?? "";
      const classified = classifyTool(payload.name || payload.type, input);
      let parsedCmd = "";
      try {
        const parsed = typeof input === "string" ? JSON.parse(input) : input;
        parsedCmd = parsed?.command || parsed?.cmd || parsed?.query || "";
      } catch (e) {}
      const tool = {
        id: payload.call_id || payload.id || `tool-${calls.size + 1}`,
        callId: payload.call_id || payload.id || null,
        timestamp: event.timestamp,
        status: "running",
        name: payload.name || payload.type,
        ...classified,
        input: rawText(input).slice(0, 2048),
        command: (parsedCmd || rawText(input)).slice(0, 2048),
        output: "",
        result: "",
      };
      openBatch.tools.push(tool);
      if (tool.callId) calls.set(tool.callId, tool);
      if (payload.id) calls.set(payload.id, tool);
      continue;
    }
    if (["custom_tool_call_output", "function_call_output", "tool_search_output"].includes(payload.type)) {
      const tool = calls.get(payload.call_id || payload.id) || openBatch?.tools.findLast((entry) => entry.status === "running") || [...calls.values()].reverse().find((entry) => entry.status === "running");
      if (tool) {
        const outStr = rawText(payload.output ?? payload.results ?? "");
        tool.output = outStr.slice(0, 4096);
        tool.result = tool.output;
        tool.completedAt = event.timestamp;
        tool.status = "completed";
        tool.durationSeconds = Math.max(0, (new Date(event.timestamp) - new Date(tool.timestamp)) / 1000);
      }
      continue;
    }
    if (payload.type === "reasoning") {
      const text = (payload.summary || []).join("\n\n");
      if (text) {
        // The runtime Reasoning record already produced this summary moments
        // earlier; merging avoids two reasoning rows for one response.
        if (pendingReasoning && pendingReasoning.text === text) {
          pendingReasoning = null;
        } else {
          const turn = openTurn(event.timestamp);
          pushTraceItem(turn, { kind: "reasoning", label: "推理摘要", summary: text, timestamp: event.timestamp, content: text });
        }
      }
      continue;
    }

    if (payload.type === "message") {
      if (payload.role === "user") {
        flushBatch();
        let text = visibleUserText(payload.content);
        let isSynthetic = false;
        if (!text) {
          const raw = contentText(payload.content);
          if (/^<external_[a-z_]+>/.test(raw)) {
            text = "（外部页面打开事件）";
            isSynthetic = true;
          }
        }
        if (!text) continue;
        const nodeId = pushGraphItem({ type: "user", label: record.isSubagent ? "Agent 任务" : "用户消息", summary: compact(text), content: text, timestamp: event.timestamp, turnId: currentRun?.id || null });
        inputSequence += 1;
        const entry = { id: `${record.id}:input-${inputSequence}`, kind: "input", label: record.isSubagent ? "Agent 任务" : "用户消息", summary: text, nodeId, timestamp: event.timestamp, isSynthetic };
        if (currentRun) {
          currentRun.inputItems.push(entry);
          if (!currentRun.prompt || (/^（外部页面打开事件）/.test(currentRun.prompt) && !isSynthetic)) {
            currentRun.prompt = compact(text);
            currentRun.promptNodeId = nodeId;
          }
        } else {
          pendingUsers.push(entry);
        }
        continue;
      }
      if (payload.role === "assistant") {
        flushBatch();
        const text = contentText(payload.content);
        if (!text) continue;
        const runtime = pendingAgentMessage && pendingAgentMessage.text === text ? pendingAgentMessage : null;
        pendingAgentMessage = null;
        const phase = payload.phase || runtime?.phase || "assistant";
        const isFinal = phase === "final_answer";
        const nodeId = pushGraphItem({ type: isFinal ? "final" : "model", label: isFinal ? "最终回答" : "模型消息", summary: compact(text), content: text, phase, timestamp: event.timestamp, turnId: currentRun?.id || null });
        const turn = openTurn(event.timestamp);
        pushTraceItem(turn, { kind: isFinal ? "answer" : "output", label: isFinal ? "最终回答" : "模型消息", summary: text, timestamp: event.timestamp, durationMs: runtime?.durationMs ?? null, nodeId, phase });
        continue;
      }
      continue;
    }

    if (payload.type === "agent_message") {
      flushBatch();
      const text = contentText(payload.content);
      const inbound = record.isSubagent && payload.recipient === record.agentPath && payload.author !== record.agentPath;
      let cleanSummary = "";
      const payloadMatch = text.match(/Payload:\s*([\s\S]*)$/m);
      if (payloadMatch && payloadMatch[1]?.trim()) {
        cleanSummary = payloadMatch[1].trim();
      } else {
        cleanSummary = text.replace(/^Message Type:[^\n]*\n(?:Task name:[^\n]*\n)?(?:Sender:[^\n]*\n)?(?:Payload:\s*)?/m, "").trim();
      }
      cleanSummary = cleanSummary.replace(/^[#\s]+[^\n]*\n/m, "").replace(/\n+/g, " ").trim();

      const authorShort = (payload.author || "").split("/").pop() || (record.isSubagent ? "SubAgent" : "Root");
      const recipientShort = (payload.recipient || "").split("/").pop() || (record.isSubagent ? "Root" : "SubAgent");
      const commLabel = inbound
        ? (/Message Type: NEW_TASK/.test(text) ? `【任务】${authorShort} ➔ ${recipientShort}` : `【跟进】${authorShort} ➔ ${recipientShort}`)
        : `【回流】${authorShort} ➔ ${recipientShort}`;

      const nodeId = pushGraphItem({
        type: inbound ? "user" : "agent-result",
        label: commLabel,
        summary: compact(cleanSummary || (inbound ? "接收上游任务指令" : "回传执行结论")),
        content: cleanSummary || text,
        messageDirection: inbound ? "inbound" : "outbound",
        author: payload.author || null,
        recipient: payload.recipient || null,
        timestamp: event.timestamp,
        turnId: currentRun?.id || null,
      });
      inputSequence += inbound ? 1 : 0;
      const entry = {
        ...(inbound ? { id: `${record.id}:input-${inputSequence}` } : {}),
        kind: inbound ? "input" : "subagent",
        label: commLabel,
        summary: compact(cleanSummary || text, 200),
        nodeId,
        timestamp: event.timestamp,
        agentPath: inbound ? payload.author : payload.recipient,
      };
      if (inbound) {
        if (currentRun) {
          currentRun.inputItems.push(entry);
          if (!currentRun.prompt || /^（外部页面打开事件）/.test(currentRun.prompt)) {
            currentRun.prompt = entry.summary;
            currentRun.promptNodeId = nodeId;
          }
        } else {
          pendingUsers.push(entry);
        }
      } else {
        pushTraceItem(targetTurn(), entry);
      }
    }
  }
  closeTurn(lastTimestamp);
  closeRun(lastTimestamp);
  flushBatch();

  if (!items.length) {
    items.push({ nodeId: `${record.id}:1`, type: "model", label: "空 Session", summary: "尚无可展示的消息或工具调用", content: "该 Session 当前只有元数据。", timestamp: record.createdAt, turnId: null });
  }
  return {
    record,
    items,
    runs,
    status: running ? "running" : "completed",
    lastTimestamp,
  };
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
      if (incoming.get(targetId) === 0) {
        queue.push(nodeById.get(targetId));
        queue.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }
    }
  }
  if (processed !== nodes.length) throw new Error(`Graph contains a cycle: processed ${processed}/${nodes.length} nodes`);
  const roots = nodes.filter((node) => originalIncoming.get(node.id) === 0);
  if (roots.length !== 1) throw new Error(`Graph must have exactly one root, found ${roots.length}`);
  for (const node of nodes) {
    node.layer = layer.get(node.id);
    node.y = 90 + node.layer * 150;
  }
  return { rootNodeId: roots[0].id, layers: Math.max(...layer.values()) + 1 };
}

export async function buildSessionGraph(sessionId) {
  await refreshSessionIndex();
  const records = subtreeRecords(sessionId);
  if (!records.length) {
    const error = new Error(`Codex session ${sessionId} not found`);
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  const parsed = [];
  const parsedById = new Map();
  for (const record of records) {
    const parent = parsedById.get(record.parentId);
    const ancestorRunIds = new Set(parent ? [...parent.ancestorRunIds, ...parent.runs.map((run) => run.id)] : []);
    const thread = await parseThread(record, { ignoredRunIds: ancestorRunIds });
    thread.ancestorRunIds = ancestorRunIds;
    parsed.push(thread);
    parsedById.set(record.id, thread);
  }
  const threads = parsed.map((thread, index) => ({
    id: thread.record.id,
    name: thread.record.isSubagent ? "Sub-agent" : "Root Agent",
    path: thread.record.agentPath,
    nickname: thread.record.agentNickname || (index === 0 ? "Root" : `Agent ${index}`),
    parentId: index === 0 ? null : thread.record.parentId,
    laneX: 70 + index * 340,
    status: thread.status,
    runs: thread.runs.length,
    turns: thread.runs.length,
    startedAt: thread.record.createdAt,
    completedAt: thread.lastTimestamp,
    file: thread.record.file,
    depth: thread.record.depth,
    color: index === 0 ? "acid" : colors[(index - 1) % colors.length],
  }));
  const nodes = [];
  const edges = [];
  const perThread = new Map();
  for (const [threadIndex, thread] of parsed.entries()) {
    const laneX = threads[threadIndex].laneX;
    const threadNodes = thread.items.map((item) => ({
      id: item.nodeId,
      x: laneX,
      y: 0,
      width: 290,
      height: item.type === "tool" || item.type === "agent" ? 120 : 100,
      threadId: thread.record.id,
      ...item,
    }));
    nodes.push(...threadNodes);
    perThread.set(thread.record.id, threadNodes);
    for (let index = 1; index < threadNodes.length; index += 1) {
      edges.push({ from: threadNodes[index - 1].id, to: threadNodes[index].id, type: "sequence", label: "" });
    }
  }

  // 跨泳道动态通信连线 (Inter-agent Communication Edges)
  const threadByPath = new Map(threads.map((t) => [t.path, t]));
  const existingEdgeKeys = new Set();
  const pushEdge = (fromId, toId, type, label) => {
    if (!fromId || !toId || fromId === toId) return;
    const key = `${fromId}->${toId}`;
    if (existingEdgeKeys.has(key)) return;
    existingEdgeKeys.add(key);
    edges.push({ from: fromId, to: toId, type, label });
  };

  // 全量对齐多 Agent 的每一次派发任务与结果回流
  for (const n of nodes) {
    if (n.type === "agent-result" && n.author) {
      const childThread = threadByPath.get(n.author);
      if (childThread) {
        const cNodes = perThread.get(childThread.id) || [];
        const sourceNode = [...cNodes].reverse().find((cn) => (cn.type === "final" || cn.type === "agent" || cn.type === "tool") && new Date(cn.timestamp) <= new Date(n.timestamp));
        if (sourceNode) {
          const childName = childThread.nickname || "Agent";
          pushEdge(sourceNode.id, n.id, "return", `${childName} ➔ 回流`);
        }
      }
    }

    if (n.type === "agent" && n.tools?.some((t) => /send_message|followup_task|spawn/i.test(t.name))) {
      const tool = n.tools.find((t) => /send_message|followup_task|spawn/i.test(t.name));
      const targetMatch = (tool.input || tool.command || "").match(/"target"\s*:\s*"([^"]+)"/);
      if (targetMatch) {
        const targetPath = targetMatch[1];
        const childThread = threadByPath.get(targetPath);
        if (childThread) {
          const cNodes = perThread.get(childThread.id) || [];
          const targetNode = cNodes.find((cn) => cn.type === "user" && new Date(cn.timestamp) >= new Date(n.timestamp));
          if (targetNode) {
            const childName = childThread.nickname || "Agent";
            pushEdge(n.id, targetNode.id, "spawn", `派发 ➔ ${childName}`);
          }
        }
      }
    }
  }

  for (const thread of parsed.slice(1)) {
    const childNodes = perThread.get(thread.record.id) || [];
    const parentNodes = perThread.get(thread.record.parentId) || [];
    if (!childNodes.length || !parentNodes.length) continue;
    const identityTokens = [thread.record.agentPath, thread.record.agentNickname, thread.record.id].filter(Boolean).map((value) => value.toLowerCase());
    const spawn = parentNodes.find((node) => node.tools?.some((tool) => {
      const evidence = `${tool.input} ${tool.output}`.toLowerCase();
      return identityTokens.some((token) => evidence.includes(token));
    }))
      || [...parentNodes].reverse().find((node) => new Date(node.timestamp) <= new Date(thread.record.createdAt))
      || parentNodes[0];

    const childFirstRun = thread.runs[0];
    const rawChildPrompt = childFirstRun?.prompt || thread.record.agentPath || "子任务";
    const spawnSummary = rawChildPrompt.replace(/^Message Type:[^\n]*\n(?:Task name:[^\n]*\n)?(?:Sender:[^\n]*\n)?(?:Payload:\s*)?/m, "").slice(0, 36);
    pushEdge(spawn.id, childNodes[0].id, "spawn", `委派: ${thread.record.agentNickname || "Agent"}`);

    const lastRun = thread.runs.at(-1);
    const childFinalMsg = lastRun?.finalAnswer || [...thread.items].reverse().find((it) => it.type === "final" || it.phase === "final_answer")?.content || "";
    const cleanFinalText = childFinalMsg.replace(/^[#\s]+[^\n]*\n/m, "").replace(/\n+/g, " ").trim();
    const returnSummary = cleanFinalText.slice(0, 48) || "任务完成并返回结果";

    const returned = parentNodes.find((node) => node.type === "agent-result" && new Date(node.timestamp) >= new Date(thread.lastTimestamp))
      || parentNodes.find((node) => new Date(node.timestamp) >= new Date(thread.lastTimestamp));
    if (returned) {
      if (/Payload:\s*$/m.test(returned.summary) || !returned.content || returned.content.includes("encrypted_content")) {
        returned.summary = `[ 🔓 已解密回流 ] ${returnSummary}`;
        returned.content = childFinalMsg || returned.content;
        returned.isDecrypted = true;
      }
      pushEdge(childNodes.at(-1).id, returned.id, "return", `回流: ${returnSummary.slice(0, 24)}`);
    }
  }

  const layout = applyCausalLayout(nodes, edges);
  const graphRuns = parsed.flatMap((thread) => thread.runs.map((run) => {
    const runNodes = (perThread.get(thread.record.id) || []).filter((node) => node.turnId === run.id);
    return {
      ...run,
      threadId: thread.record.id,
      nodeIds: runNodes.map((node) => node.id),
      minX: runNodes.length ? Math.min(...runNodes.map((node) => node.x)) : 0,
      maxX: runNodes.length ? Math.max(...runNodes.map((node) => node.x + node.width)) : 0,
      minY: runNodes.length ? Math.min(...runNodes.map((node) => node.y)) : 0,
      maxY: runNodes.length ? Math.max(...runNodes.map((node) => node.y + node.height)) : 0,
    };
  }));

  const root = parsed[0];
  const allTools = nodes.flatMap((node) => node.tools || []);
  const session = {
    id: root.record.id,
    shortId: root.record.shortId,
    title: root.record.title,
    status: root.status,
    startedAt: root.record.createdAt,
    completedAt: root.status === "completed" ? root.lastTimestamp : null,
    updatedAt: root.record.updatedAt,
    cwd: root.record.cwd,
    cliVersion: root.record.cliVersion,
    provider: "codex",
  };
  const trace = buildTrace({ provider: "codex", session, threads, runs: graphRuns, metrics: { toolCalls: allTools.length, subAgents: Math.max(0, threads.length - 1) } });

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    source: {
      provider: "codex",
      adapterVersion: 4,
      mode: "live-local-session-graph",
      rootFile: root.record.file,
      childFiles: parsed.slice(1).map((thread) => thread.record.file),
      directory: codexHome,
      note: "从本地 Codex JSONL session 按需生成。Run 取自 task_started/task_complete，Turn 取自每次模型响应（token_usage_record 边界）。",
    },
    session,
    graph: {
      width: Math.max(1000, 100 + threads.length * 350),
      height: Math.max(700, 140 + layout.layers * 150),
      nodes,
      edges,
      threads,
      turns: graphRuns,
      rootNodeId: layout.rootNodeId,
    },
    trace,
    metrics: {
      threads: threads.length,
      runs: trace.metrics.runs,
      turns: trace.metrics.turns,
      nodes: nodes.length,
      toolCalls: allTools.length,
      subAgents: Math.max(0, threads.length - 1),
    },
  };
}

/**
 * The session-level input context: what the model was actually given.
 *
 * Codex persists the base instructions in session_meta, the developer
 * instructions and policy in turn_context, the repository AGENTS.md and skill
 * bodies in world_state, and the tool schema in the developer `additional_tools`
 * response item. Everything here is read from those records; nothing is
 * reconstructed from templates.
 */
export async function buildSessionContext(sessionId) {
  await refreshSessionIndex();
  const records = subtreeRecords(sessionId);
  if (!records.length) {
    const error = new Error(`Codex session ${sessionId} not found`);
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  const contexts = [];
  for (const record of records) {
    const context = {
      threadId: record.id,
      file: record.file,
      nickname: record.agentNickname,
      agentPath: record.agentPath,
      systemPrompt: null,
      developerInstructions: null,
      agentsMd: null,
      skills: null,
      tools: null,
      permissions: null,
      model: null,
      effort: null,
      approvalPolicy: null,
      sandbox: null,
      cwd: record.cwd,
      cliVersion: record.cliVersion,
      originator: record.originator,
    };
    const reader = readline.createInterface({ input: fs.createReadStream(record.file, { encoding: "utf8" }), crlfDelay: Infinity });
    let found = 0;
    for await (const line of reader) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const payload = event.payload || {};
      if (event.type === "session_meta") {
        context.systemPrompt = payload.base_instructions?.text || null;
        context.cwd = payload.cwd || context.cwd;
        context.cliVersion = payload.cli_version || context.cliVersion;
        context.originator = payload.originator || context.originator;
        found += 1;
      } else if (event.type === "turn_context" && !context.developerInstructions) {
        context.developerInstructions = payload.collaboration_mode?.settings?.developer_instructions || null;
        context.model = payload.model || null;
        context.effort = payload.effort || null;
        context.approvalPolicy = payload.approval_policy || null;
        context.sandbox = payload.sandbox_policy?.type || null;
        found += 1;
      } else if (event.type === "world_state" && payload.full && payload.state) {
        const state = payload.state;
        context.agentsMd = state.agents_md?.text ? { directory: state.agents_md.directory, text: state.agents_md.text } : null;
        context.skills = state.host_skills?.body || null;
        context.permissions = state.permissions ? { instructions: state.permissions.instructions || null, approvedCommandPrefixes: state.permissions.approved_command_prefixes || [] } : null;
        context.model = state.model || context.model;
        found += 1;
      } else if (event.type === "response_item" && payload.type === "additional_tools" && !context.tools) {
        context.tools = (payload.tools || []).map((group) => ({
          type: group.type,
          name: group.name || null,
          description: group.description || "",
          tools: (group.tools || []).map((tool) => ({ type: tool.type, name: tool.name, description: tool.description || "", parameters: tool.parameters || null, format: tool.format || null })),
        }));
        found += 1;
      }
      if (found >= 4 && context.systemPrompt && context.tools) break;
    }
    reader.close();
    contexts.push(context);
  }
  return {
    provider: "codex",
    sessionId,
    note: "会话级输入快照：系统提示词、开发者指令、仓库 AGENTS.md、技能清单、工具 schema 与权限策略。均取自本地 rollout 原文。",
    contexts,
  };
}

export function codexDirectories() {
  return roots.map((root) => ({ path: root.directory }));
}
