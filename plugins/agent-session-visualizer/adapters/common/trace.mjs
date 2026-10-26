/**
 * The domain model trace vocabulary aligned with the prototype designs.
 *
 * Implements the domain hierarchy derived from:
 *   - Map.dc.html & Overview.dc.html (Information Architecture & 3-column Overview)
 *   - RunDetail.dc.html (Waterfall Timeline & Lifecycle events)
 *   - MessageMap.dc.html (Message ↔ Turn ↔ Run Projection)
 *   - States.dc.html (Fail/Retry attempts, Waits, Delegations, Compactions)
 *   - ADR 0002 (Run = Business Unit, Turn = Model Response + Tool Round)
 *
 * Core Principles:
 *   1. Conversation is the single page boundary. No synthetic thread trees.
 *   2. Branches (Session Lines) manage main / fork / btw / delegation paths.
 *   3. Run is the business unit (input envelope -> final answer / terminal state).
 *   4. Turn is one model response + its closing tool round.
 *   5. Retries & length truncations increment Attempt, NEVER create a new Turn!
 *   6. Context compaction has its own compactionId and is NOT a business Turn.
 */

/** The standard entity levels in descending order. */
export const TRACE_LEVELS = ["conversation", "thread", "run", "turn"];

/** Formal domain entity types. */
export const DOMAIN_ENTITIES = [
  "conversation", "branch", "run", "turn", "attempt", "tool_call", "execution", "wait", "delegation", "compaction"
];

/** The leaf kinds a Turn or Message can hold. */
export const TURN_ITEM_KINDS = [
  "input", "output", "reasoning", "tool", "skill", "subagent", "compaction", "request", "answer", "failure", "wait", "decision"
];

/** The colour role each kind uses. Aligned with prototype status colors. */
export const KIND_COLORS = {
  input: "user",
  output: "model",
  answer: "final",
  reasoning: "reasoning",
  tool: "tool",
  skill: "skill",
  subagent: "agent",
  compaction: "compaction",
  request: "muted",
  failure: "danger",
  wait: "wait",
  decision: "ok",
};

/** Standard text truncation length. */
export const PREVIEW_LENGTH = 160;

/** Collapse whitespace and cut a preview. */
export function preview(value, length = PREVIEW_LENGTH) {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, length);
}

/** The wall-clock length between two ISO timestamps in milliseconds. */
export function durationMs(from, to) {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/** Empty token usage structure. */
export function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
}

/** Add a usage record into a running total. */
export function addUsage(total, usage) {
  if (!usage) return total;
  total.requests = (total.requests || 0) + (usage.requests || 1);
  for (const key of ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total[key] = (total[key] || 0) + value;
    }
  }
  return total;
}

/** True when a usage total carries no numbers at all. */
export function usageIsEmpty(usage) {
  if (!usage) return true;
  return usage.requests === 0 && !usage.totalTokens;
}

/** Normalise the token counters a provider reports. */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const usage = emptyUsage();
  usage.inputTokens = numberOrNull(raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens);
  usage.cachedInputTokens = numberOrNull(raw.cached_input_tokens ?? raw.cachedInputTokens ?? raw.cache_read_input_tokens);
  usage.cacheWriteTokens = numberOrNull(raw.cache_write_input_tokens ?? raw.cacheWriteTokens ?? raw.cache_creation_input_tokens);
  usage.outputTokens = numberOrNull(raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens);
  usage.reasoningTokens = numberOrNull(raw.reasoning_output_tokens ?? raw.reasoningTokens);
  usage.totalTokens = numberOrNull(raw.total_tokens ?? raw.totalTokens) ?? (
    [usage.inputTokens, usage.outputTokens].every((value) => value != null) ? usage.inputTokens + usage.outputTokens : null
  );
  usage.requests = 1;
  return usage;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A leaf item inside a Turn. */
export function traceItem({
  id, kind, label, summary = "", timestamp = null, durationMs: duration = null,
  status = null, nodeId = null, toolIndex = null, content = null, ...rest
}) {
  const safeContent = typeof content === "string" && content.length > 4096 ? `${content.slice(0, 4096)}...` : content;
  return {
    id,
    kind,
    label,
    summary: preview(summary),
    timestamp,
    durationMs: duration,
    status,
    nodeId,
    toolIndex,
    content: safeContent,
    ...rest
  };
}

/**
 * Group ordered graph items into Turns with proper Attempt support.
 *
 * Implements the core domain rule:
 * - A model response opens an Attempt.
 * - If an attempt is truncated or network-retried, it stays in the SAME Turn as attempt + 1.
 * - Tools following an attempt belong to that Turn.
 * - When all tools close and next normal response arrives, a new Turn opens.
 */
export function groupItemsIntoTurns(items, { runId, turnIdPrefix }) {
  const turns = [];
  const loose = [];
  let openTurn = null;

  const startNewTurn = (timestamp, model) => {
    openTurn = {
      id: `${turnIdPrefix}-${turns.length + 1}`,
      runId,
      index: turns.length + 1,
      startedAt: timestamp,
      completedAt: null,
      durationMs: null,
      status: "completed",
      items: [],
      attempts: [],
      usage: null,
      model: model || null,
      reasoning: [],
    };
    turns.push(openTurn);
    return openTurn;
  };

  for (const item of items) {
    const kind = item.kind || item.type;
    if (kind === "input" || kind === "user") {
      loose.push(item);
      continue;
    }

    const isResponse = ["output", "answer", "model", "final", "reasoning"].includes(kind);

    if (isResponse) {
      // Determine if this is a new Attempt in the same Turn or a new Turn
      const isRetry = openTurn && openTurn.items.some((i) => i.status === "failed" || i.kind === "failure");
      if (!openTurn || (!isRetry && openTurn.items.some((i) => i.kind === "tool"))) {
        if (openTurn && !openTurn.completedAt) openTurn.completedAt = item.timestamp;
        startNewTurn(item.timestamp, item.model);
      }

      // Record as an attempt entry
      const attemptNum = openTurn.attempts.length + 1;
      const attemptEntry = {
        attemptNumber: attemptNum,
        timestamp: item.timestamp,
        status: item.status || "completed",
        stopReason: item.stopReason || (kind === "final" ? "end_turn" : null),
        summary: preview(item.summary || item.content),
      };
      openTurn.attempts.push(attemptEntry);
    } else if (!openTurn) {
      startNewTurn(item.timestamp, item.model);
    }

    openTurn.items.push(item);
    if (item.timestamp) openTurn.completedAt = item.timestamp;
    if (item.status === "failed") openTurn.status = "failed";
  }

  for (const turn of turns) {
    turn.durationMs = durationMs(turn.startedAt, turn.completedAt);
  }
  return { turns, loose };
}

/**
 * Build the complete domain Trace payload.
 *
 * Produces:
 *   - conversation: page scope
 *   - branches: session lines (main / fork / btw / delegation)
 *   - runs: business task units with waterfall data
 *   - messages: unified message stream for the 3-column Overview
 *   - metrics: domain counters
 *   - threads: backwards-compatible mirror for existing svg graph
 */
export function buildTrace({ provider, session, threads = [], runs = [], metrics = {} }) {
  // Normalize branches from threads
  const branches = threads.map((th, index) => {
    const isRoot = !th.parentId && index === 0;
    const kind = isRoot ? "main" : th.kind || (th.parentId ? "delegation" : "fork");
    return {
      id: th.id,
      kind,
      short: kind === "main" ? "主" : kind === "delegation" ? "派" : "叉",
      title: th.nickname || th.name || (isRoot ? "主线会话" : `分支 ${th.id.slice(0, 8)}`),
      sub: isRoot ? "继承全部历史 · 主执行线" : `父线 ${th.parentId?.slice(0, 8) || "root"} · 独立执行`,
      parentId: th.parentId || null,
      status: th.status || "completed",
      startedAt: th.startedAt || session.startedAt,
      runs: [],
    };
  });

  const branchById = new Map(branches.map((b) => [b.id, b]));
  const defaultBranch = branches[0] || { id: "main", kind: "main", title: "主线", runs: [] };

  // Sort and assign runs to branches
  const orderedRuns = [...runs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const run of orderedRuns) {
    const targetBranch = branchById.get(run.threadId) || defaultBranch;
    targetBranch.runs.push(run);

    // Enrich turns with serial/parallel dependencies and structured I/O
    enrichRunTurns(run);

    // Compute waterfall rows for RunDetail
    run.waterfall = computeRunWaterfall(run);
  }

  // Maintain backwards-compatible thread tree
  const threadTree = branches.map((branch, index) => ({
    id: branch.id,
    name: branch.title,
    nickname: branch.title,
    path: branch.id === "main" ? "/root" : `/${branch.id}`,
    parentId: branch.parentId,
    status: branch.status,
    index: index + 1,
    runs: branch.runs.map((r, rIdx) => ({
      ...r,
      index: r.index ?? rIdx + 1,
    })),
  }));

  const allTurns = orderedRuns.flatMap((r) => r.turns || []);
  const allItems = allTurns.flatMap((t) => t.items || []);
  const allAttempts = allTurns.flatMap((t) => t.attempts || []);
  const toolCallsCount = allItems.filter((i) => i.kind === "tool").length;

  const serializedBranches = branches.map((b) => ({
    ...b,
    runs: b.runs.map((r, rIdx) => ({
      id: r.id,
      index: r.index ?? rIdx + 1,
      status: r.status,
      prompt: r.prompt,
      deliveryMode: r.deliveryMode,
      durationMs: r.durationMs,
      turnsCount: r.turns?.length || 0,
      usage: r.usage,
    })),
  }));

  return {
    provider,
    conversation: {
      id: session.id,
      shortId: session.shortId || session.id?.slice(0, 8),
      title: session.title || "对话轨迹",
      status: session.status || "completed",
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      cwd: session.cwd,
      provider,
    },
    branches: serializedBranches,
    runs: orderedRuns,
    messages: [],
    threads: threadTree,
    metrics: {
      runs: orderedRuns.length,
      turns: allTurns.length,
      attempts: Math.max(allAttempts.length, allTurns.length),
      items: allItems.length,
      toolCalls: toolCallsCount,
      subAgents: branches.filter((b) => b.kind === "delegation" || b.parentId).length,
      threads: branches.length,
      totalTokens: orderedRuns.reduce((sum, r) => sum + (r.usage?.totalTokens || 0), 0),
      ...metrics,
    },
  };
}

/**
 * Enrich turns inside a run with dependency analysis (serial/parallel)
 * and structured input/output elements.
 */
function enrichRunTurns(run) {
  const turns = run.turns || [];
  for (let idx = 0; idx < turns.length; idx++) {
    const turn = turns[idx];

    // 1. Dependency analysis (serial vs parallel)
    if (idx === 0) {
      turn.dependency = {
        type: "root",
        label: "起始轮次",
        desc: "接收输入任务并开始首轮思考",
      };
    } else {
      const prevTurn = turns[idx - 1];
      const curStart = Date.parse(turn.startedAt);
      const prevEnd = Date.parse(prevTurn.completedAt);
      const isOverlap = Number.isFinite(curStart) && Number.isFinite(prevEnd) && curStart < prevEnd;
      if (isOverlap) {
        turn.dependency = {
          type: "parallel",
          label: "并行执行",
          prevTurnId: prevTurn.id,
          desc: `与 T${String(prevTurn.index).padStart(2, "0")} 并发执行`,
        };
      } else {
        turn.dependency = {
          type: "serial",
          label: "串行链路",
          prevTurnId: prevTurn.id,
          desc: `承接 T${String(prevTurn.index).padStart(2, "0")} 执行结果`,
        };
      }
    }

    // 2. Turn Input
    if (idx === 0) {
      turn.turnInput = {
        type: run.deliveryMode === "next_turn" ? "next_turn" : "user",
        label: run.deliveryMode === "next_turn" ? "补充输入" : "任务输入",
        content: run.prompt || "（无输入记录）",
      };
    } else {
      const prevTurn = turns[idx - 1];
      const prevTools = (prevTurn.items || []).filter((i) => i.kind === "tool");
      turn.turnInput = {
        type: "context_return",
        label: "环境/工具回流",
        content: prevTools.length > 0
          ? `承接前序 T${prevTurn.index} 的 ${prevTools.length} 个工具执行结果`
          : `承接前序 T${prevTurn.index} 的模型输出与上下文`,
      };
    }

    // 3. Thinking / Reasoning
    const reasoningItems = (turn.items || []).filter((i) => i.kind === "reasoning");
    turn.thinking = reasoningItems.length > 0 ? {
      summary: reasoningItems.map((r) => r.summary).filter(Boolean).join("\n") || "思考中...",
      content: reasoningItems.map((r) => r.content || r.summary).filter(Boolean).join("\n\n"),
    } : null;

    // 4. Tools
    turn.toolCalls = (turn.items || []).filter((i) => i.kind === "tool" || i.kind === "failure").map((tool) => ({
      id: tool.id,
      name: tool.label || tool.name || "tool",
      command: tool.command ? preview(tool.command, 2048) : preview(tool.summary || "", 512),
      result: tool.result ? preview(tool.result, 4096) : "（无执行输出）",
      action: tool.summary,
      status: tool.status || "completed",
      durationMs: tool.durationMs,
      callId: tool.callId,
      nodeId: tool.nodeId,
    }));

    // 5. Output / Final Answer
    const answerItem = (turn.items || []).find((i) => i.kind === "answer" || i.phase === "final_answer" || i.kind === "output");
    turn.turnOutput = answerItem ? {
      kind: answerItem.kind,
      isFinal: answerItem.kind === "answer" || answerItem.phase === "final_answer",
      content: answerItem.content || answerItem.summary || "",
      nodeId: answerItem.nodeId,
    } : null;

    // 6. Subagent delegation / returns
    turn.subagents = (turn.items || []).filter((i) => i.kind === "subagent").map((sa) => ({
      id: sa.id,
      label: sa.label || "Sub-agent 通信",
      summary: sa.summary,
      agentPath: sa.agentPath,
      nodeId: sa.nodeId,
    }));
  }
}

/**
 * Derive structured TurnBlocks for Overview rendering.
 * Aligned with user mental model:
 *   - Turn 1: User Input Message
 *   - Turn 2: Tool calls batch + Tool execution results
 *   - Turn 3+: Subsequent model reasoning / response / final answer
 */
function deriveTurnBlocks(runs) {
  const blocks = [];
  for (const run of runs) {
    let turnSequence = 0;

    // 1. Turn 1 is ALWAYS the User Input Message
    turnSequence += 1;
    blocks.push({
      id: `${run.id}:turn-user`,
      runId: run.id,
      runIndex: run.index,
      turnIndex: turnSequence,
      label: `T${String(turnSequence).padStart(2, "0")}`,
      title: `任务 ${run.index} · 用户输入消息`,
      type: "user_turn",
      status: "completed",
      durationMs: null,
      usage: null,
      model: null,
      dependency: { type: "root", label: "起始输入", desc: "用户发起业务提问" },
      input: {
        label: run.deliveryMode === "next_turn" ? "用户补充输入" : "用户输入消息",
        content: run.prompt || "（无输入记录）",
      },
      thinking: null,
      tools: [],
      output: null,
      subagents: [],
    });

    // 2. Subsequent Turns for model execution and tool calls
    for (const turn of (run.turns || [])) {
      turnSequence += 1;
      const hasTools = (turn.toolCalls || []).length > 0;
      const turnTitle = hasTools
        ? `任务 ${run.index} · 工具执行批次 (${turn.toolCalls.length} 个工具调用与结果)`
        : `任务 ${run.index} · 模型推理与回复`;

      blocks.push({
        id: turn.id,
        runId: run.id,
        runIndex: run.index,
        turnIndex: turnSequence,
        label: `T${String(turnSequence).padStart(2, "0")}`,
        title: turnTitle,
        type: hasTools ? "tool_turn" : "model_turn",
        status: turn.status || "completed",
        durationMs: turn.durationMs,
        usage: turn.usage,
        model: turn.model || run.model,
        dependency: {
          type: "serial",
          label: "串行链路",
          desc: `承接 T${String(turnSequence - 1).padStart(2, "0")} 的执行结果与上下文`,
        },
        input: turnSequence === 2
          ? { label: "触发来源", content: `承接 T01 用户输入消息` }
          : turn.turnInput,
        thinking: turn.thinking,
        tools: turn.toolCalls || [],
        output: turn.turnOutput,
        subagents: turn.subagents || [],
      });
    }
  }
  return blocks;
}

/**
 * Compute waterfall timeline rows for a single Run.
 * Aligned with the RunDetail.dc.html specification.
 */
function computeRunWaterfall(run) {
  const rows = [];
  const runStart = Date.parse(run.startedAt);
  const runEnd = Date.parse(run.completedAt) || (runStart + (run.durationMs || 1000));
  const runSpan = Math.max(1, runEnd - runStart);

  rows.push({
    id: `wf-${run.id}-total`,
    label: `${run.id} 任务总跨度`,
    kind: "run",
    cls: "run",
    dot: "run",
    tag: run.status,
    left: 0,
    width: 100,
    barText: run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—",
  });

  for (const turn of (run.turns || [])) {
    const tStart = Date.parse(turn.startedAt) || runStart;
    const tEnd = Date.parse(turn.completedAt) || (tStart + (turn.durationMs || 500));
    const tLeft = Math.max(0, Math.min(100, ((tStart - runStart) / runSpan) * 100));
    const tWidth = Math.max(2, Math.min(100 - tLeft, ((tEnd - tStart) / runSpan) * 100));

    rows.push({
      id: `wf-${turn.id}`,
      label: `T${turn.index} · 模型响应轮`,
      kind: "turn",
      cls: turn.status === "failed" ? "turn bad" : "turn",
      dot: turn.status === "failed" ? "err" : "turn",
      tag: turn.status,
      left: Number(tLeft.toFixed(1)),
      width: Number(tWidth.toFixed(1)),
      barText: turn.durationMs != null ? `${(turn.durationMs / 1000).toFixed(1)}s` : "—",
    });

    for (const item of (turn.items || [])) {
      if (item.kind === "input") continue;
      const iStart = Date.parse(item.timestamp) || tStart;
      const iDur = item.durationMs || 80;
      const iLeft = Math.max(0, Math.min(100, ((iStart - runStart) / runSpan) * 100));
      const iWidth = Math.max(1.5, Math.min(100 - iLeft, (iDur / runSpan) * 100));

      rows.push({
        id: `wf-${item.id}`,
        label: `${item.label || item.kind}: ${preview(item.summary, 32)}`,
        kind: item.kind,
        cls: item.kind === "failure" ? "err" : item.kind === "wait" ? "warn" : item.kind === "tool" ? "tool" : "turn",
        dot: item.kind === "failure" ? "err" : item.kind === "wait" ? "warn" : item.kind === "tool" ? "tool" : "turn",
        tag: item.status || "",
        left: Number(iLeft.toFixed(1)),
        width: Number(iWidth.toFixed(1)),
        barText: item.durationMs != null ? (item.durationMs < 1000 ? `${item.durationMs}ms` : `${(item.durationMs / 1000).toFixed(1)}s`) : "",
      });
    }
  }

  return rows;
}

/**
 * Derive unified message items for the Overview middle column.
 */
function deriveMessageStream(runs) {
  const messages = [];
  let msgSeq = 0;

  for (const run of runs) {
    // User input message
    messages.push({
      id: `msg-in-${run.id}`,
      seq: ++msgSeq,
      runId: run.id,
      turn: run.id,
      role: "user",
      badge: run.deliveryMode === "next_turn" ? "补充输入" : "用户输入",
      badgeCls: "user",
      tag: `${run.id} · ${run.deliveryMode || "new_run"}`,
      text: run.prompt || "（无用户输入）",
      dur: "—",
      cardCls: run.deliveryMode === "next_turn" ? "wait" : "",
      hasBlock: false,
    });

    for (const turn of (run.turns || [])) {
      for (const item of (turn.items || [])) {
        if (item.kind === "input") continue;

        const isAnswer = item.kind === "answer" || item.phase === "final_answer";
        const isTool = item.kind === "tool" || item.kind === "failure";
        const isWait = item.kind === "wait";
        const isCompaction = item.kind === "compaction";

        messages.push({
          id: `msg-item-${item.id}`,
          seq: ++msgSeq,
          runId: run.id,
          turnId: turn.id,
          turn: `T${turn.index}`,
          role: isAnswer ? "assistant" : isTool ? "tool" : isWait ? "wait" : isCompaction ? "core" : "assistant",
          badge: isAnswer ? "最终回答" : item.label || item.kind,
          badgeCls: isAnswer ? "ok" : isTool ? "tool" : isWait ? "wait" : isCompaction ? "comp" : "assistant",
          tag: `${run.id} · T${turn.index}${item.callId ? ` · ${item.callId}` : ""}`,
          text: item.summary || item.label || "",
          dur: item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s` : "—",
          cardCls: isAnswer ? "is-final" : isTool ? "plain" : isWait ? "wait" : isCompaction ? "comp" : "",
          hasBlock: Boolean(item.content || item.summary),
          blockLabel: isTool ? "payload" : "summary",
          blockBody: typeof item.content === "string" ? item.content : item.summary || "",
        });
      }
    }
  }

  return messages;
}

/**
 * Derive trace for providers with flat logs.
 */
export function deriveTrace({ provider, session, threads = [], parsed = [], nodesByThread }) {
  const runs = [];
  const traceThreads = threads.map((thread) => ({
    id: thread.id,
    name: thread.name,
    path: thread.path,
    nickname: thread.nickname,
    parentId: thread.parentId,
    status: thread.status,
    startedAt: thread.startedAt || session.startedAt,
    completedAt: thread.completedAt || null,
    color: thread.color,
    file: thread.file || null,
    depth: thread.depth || 0,
  }));

  for (const thread of parsed) {
    const threadId = thread.record.id;
    const nodeList = nodesByThread.get(threadId) || [];
    const metaRuns = thread.turnMeta || thread.turns || [];
    const runByKey = new Map();

    const makeRun = (id, meta) => {
      const run = {
        id,
        threadId,
        index: runs.filter((c) => c.threadId === threadId).length + 1,
        startedAt: meta?.startedAt || null,
        completedAt: meta?.completedAt || null,
        status: meta?.status || "completed",
        deliveryMode: "new_run",
        prompt: null,
        promptNodeId: null,
        inputItems: [],
        finalAnswer: null,
        finalAnswerNodeId: null,
        usage: null,
        model: null,
        turns: [],
      };
      run.durationMs = durationMs(run.startedAt, run.completedAt);
      runs.push(run);
      runByKey.set(id, run);
      return run;
    };

    for (const meta of metaRuns) makeRun(meta.id, meta);

    let looseRun = null;
    let openTurn = null;

    const openTurnFor = (run, timestamp) => {
      openTurn = {
        id: `${run.id}:turn-${run.turns.length + 1}`,
        runId: run.id,
        index: run.turns.length + 1,
        startedAt: timestamp || run.startedAt,
        completedAt: null,
        durationMs: null,
        status: "completed",
        items: [],
        attempts: [{ attemptNumber: 1, timestamp: timestamp || run.startedAt, status: "completed" }],
        usage: null,
        model: null,
      };
      run.turns.push(openTurn);
      return openTurn;
    };

    for (const [index, item] of (thread.items || []).entries()) {
      const nodeId = nodeList[index]?.id || null;
      const run = runByKey.get(item.turnId) || (looseRun ||= makeRun(`${threadId}:loose`, null));
      const kind = kindOfGraphItem(item);
      if (!kind) continue;

      const entry = traceItem({
        id: `${run.id}:${run.turns.length + 1}:${(openTurn?.items.length || 0) + 1}:${index + 1}`,
        kind,
        label: item.label || kind,
        summary: item.summary || item.content || "",
        timestamp: item.timestamp || null,
        durationMs: Number.isFinite(item.durationSeconds) ? Math.round(item.durationSeconds * 1000) : null,
        status: item.status || null,
        nodeId,
        toolIndex: null,
        phase: item.phase || null,
      });

      if (kind === "input") {
        run.inputItems.push(entry);
        if (!run.prompt) run.prompt = item.summary || null;
        if (!run.promptNodeId) run.promptNodeId = nodeId;
        continue;
      }

      const mergedOutput = item.tools?.length && item.toolSummary
        ? [traceItem({
            id: `${entry.id}:output`,
            kind: item.phase === "final_answer" ? "answer" : "output",
            label: item.phase === "final_answer" ? "最终回答" : "模型消息",
            summary: item.content || item.toolSummary,
            timestamp: entry.timestamp,
            status: item.status || null,
            nodeId,
            phase: item.phase || null,
          })]
        : [];

      const leaves = item.tools?.length
        ? [...mergedOutput, ...item.tools.map((tool, toolIndex) => traceItem({
            id: `${entry.id}:tool-${toolIndex + 1}`,
            kind: tool.status === "failed" ? "failure" : "tool",
            label: tool.name || "tool",
            summary: `${tool.action || ""} · ${tool.status || ""}`,
            timestamp: tool.timestamp || entry.timestamp,
            durationMs: Number.isFinite(tool.durationSeconds) ? Math.round(tool.durationSeconds * 1000) : null,
            status: tool.status || null,
            nodeId,
            toolIndex,
            category: tool.category || null,
            callId: tool.callId || null,
          }))]
        : [entry];

      for (const leaf of leaves) {
        if (!openTurn || ["output", "answer"].includes(leaf.kind)) {
          if (openTurn) {
            openTurn.completedAt = openTurn.completedAt || leaf.timestamp;
            openTurn.durationMs = durationMs(openTurn.startedAt, openTurn.completedAt);
          }
          openTurnFor(run, leaf.timestamp);
        }
        openTurn.items.push(leaf);
        if (leaf.timestamp) openTurn.completedAt = leaf.timestamp;
        if (item.usage && ["output", "answer"].includes(leaf.kind)) {
          const usage = normalizeUsage(item.usage);
          if (usage) {
            addUsage(openTurn.usage ||= emptyUsage(), usage);
            addUsage(run.usage ||= emptyUsage(), usage);
          }
        }
        if (["output", "answer"].includes(leaf.kind)) {
          run.finalAnswer = item.summary || null;
          run.finalAnswerNodeId = nodeId;
        }
      }
    }

    if (openTurn) {
      openTurn.completedAt = openTurn.completedAt || thread.lastTimestamp;
      openTurn.durationMs = durationMs(openTurn.startedAt, openTurn.completedAt);
    }
    for (const run of runs.filter((candidate) => candidate.threadId === threadId)) {
      run.status = run.status === "running" || !run.completedAt ? "completed" : run.status;
      run.durationMs = durationMs(run.startedAt, run.completedAt);
    }
  }

  return buildTrace({ provider, session, threads: traceThreads, runs });
}

function kindOfGraphItem(item) {
  switch (item.type) {
    case "user": return "input";
    case "model": return "output";
    case "final": return "answer";
    case "tool":
    case "agent": return "tool";
    case "agent-result": return "subagent";
    default: return null;
  }
}

/** The per-run summary line the tree shows next to a Run. */
export function runSummary(run) {
  const parts = [];
  if (run.durationMs != null) parts.push(`${(run.durationMs / 1000).toFixed(1)}s`);
  else if (run.startedAt && run.completedAt) parts.push("耗时未知");
  if (run.usage && run.usage.requests) parts.push(`${run.usage.requests} 次请求`);
  if (run.turns) parts.push(`${run.turns.length} 轮`);
  if (run.status && run.status !== "completed") parts.push(run.status);
  return parts.join(" · ") || "无记录";
}

/** The per-turn summary line. */
export function turnSummary(turn) {
  const parts = [];
  const tools = (turn.items || []).filter((item) => item.kind === "tool").length;
  if (turn.durationMs != null) parts.push(`${(turn.durationMs / 1000).toFixed(1)}s`);
  if (tools) parts.push(`${tools} 个工具`);
  if (turn.usage?.totalTokens) parts.push(`${turn.usage.totalTokens} tokens`);
  return parts.join(" · ") || "无记录";
}
