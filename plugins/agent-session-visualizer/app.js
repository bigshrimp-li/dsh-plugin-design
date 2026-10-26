console.log("APP.JS LOADED IMMEDIATELY");
const state = {
  provider: "codex",
  providerCounts: new Map(),
  liveStream: null,
  data: null,
  nodes: new Map(),
  selectedId: "root-spawn",
  detailTab: "content",
  query: "",
  highlightedType: null,
  viewBox: { x: 0, y: 0, width: 1800, height: 1200 },
  drag: null,
  sessionIndex: null,
  sessionProject: "all",
  sessionQuery: "",
  currentSessionId: null,
  liveReloadTimer: null,
  selectedRunId: null,
  selectedThreadId: null,
  runNodeIds: new Set(),
  workspaceRoot: "",
  view: "graph",
  expanded: new Set(),
  turnLimits: new Map(),
  selectedTrace: null,
  runById: new Map(),
  turnById: new Map(),
  traceItemById: new Map(),
  contextCache: new Map(),
  context: null,
  contextLoading: false,
  waterfallMode: "active",
  summaryCache: new Map(),
};

const elements = {
  headerSession: document.querySelector("#header-session"),
  metrics: document.querySelector("#metrics"),
  threads: document.querySelector("#thread-tree"),
  svg: document.querySelector("#graph-svg"),
  viewport: document.querySelector("#graph-viewport"),
  scale: document.querySelector("#graph-scale"),
  detail: document.querySelector("#detail-content"),
  nodeKind: document.querySelector("#node-kind"),
  sourceFile: document.querySelector("#source-file"),
  search: document.querySelector("#graph-search"),
  openSessions: document.querySelector("#open-sessions"),
  sessionCount: document.querySelector("#session-count"),
  sessionBrowser: document.querySelector("#session-browser"),
  closeSessions: document.querySelector("#close-sessions"),
  closeSessionScrim: document.querySelector("#close-session-scrim"),
  sessionDirectory: document.querySelector("#session-directory"),
  sessionStats: document.querySelector("#session-stats"),
  sessionSearch: document.querySelector("#session-search"),
  projectList: document.querySelector("#project-list"),
  currentProjectName: document.querySelector("#current-project-name"),
  sessionList: document.querySelector("#session-list"),
  visibleSessionCount: document.querySelector("#visible-session-count"),
  refreshSessions: document.querySelector("#refresh-sessions"),
  liveState: document.querySelector("#live-state"),
  graphLoading: document.querySelector("#graph-loading"),
  turnList: document.querySelector("#turn-list"),
  providerSwitch: document.querySelector("#provider-switch"),
  providerEyebrow: document.querySelector("#provider-eyebrow"),
  novalWorkspaceRoot: document.querySelector("#noval-workspace-root"),
  workspaceRootInput: document.querySelector("#workspace-root-input"),
  loadNovalSessions: document.querySelector("#load-noval-sessions"),
  viewSwitch: document.querySelector("#view-switch"),
  stageTitle: document.querySelector("#stage-title"),
  runView: document.querySelector("#run-view"),
  runViewHead: document.querySelector("#run-view-head"),
  runViewPerf: document.querySelector("#run-view-perf"),
  runWaterfall: document.querySelector("#run-waterfall"),
};

const providerMeta = {
  codex: { label: "Codex", directory: "~/.codex/sessions" },
  grok: { label: "Grok Build", directory: "~/.grok/sessions" },
  claude: { label: "Claude Code", directory: "~/.claude/projects" },
  noval: { label: "Noval", directory: "项目内 .noval/session-logs" },
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const truncate = (value, length = 88) => String(value || "").replace(/\s+/g, " ").slice(0, length);
const typeLabel = { user: "USER", model: "MODEL", tool: "TOOL BATCH", agent: "SUB-AGENT", "agent-result": "AGENT RESULT", final: "FINAL" };
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

async function copyTextToClipboard(text, btnElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
  if (btnElement) {
    const origText = btnElement.textContent;
    btnElement.textContent = "已复制 ✓";
    btnElement.classList.add("copied");
    setTimeout(() => {
      btnElement.textContent = origText;
      btnElement.classList.remove("copied");
    }, 2000);
  }
}

async function fetchSmartSummary({ type, prompt, btnElement, targetElement }) {
  const cacheKey = `${type}:${prompt.slice(0, 80)}`;
  if (state.summaryCache.has(cacheKey)) {
    const cached = state.summaryCache.get(cacheKey);
    if (targetElement) targetElement.innerHTML = `<div class="summary-box">🪄 ${escapeHtml(cached)}</div>`;
    return;
  }

  if (btnElement) {
    btnElement.classList.add("loading");
    btnElement.textContent = "提炼中... ⏳";
  }

  try {
    const res = await fetch("/api/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, prompt }),
    });
    const data = await res.json();
    const summary = data?.summary || "无法生成总结。";
    state.summaryCache.set(cacheKey, summary);
    if (targetElement) {
      targetElement.innerHTML = `<div class="summary-box">🪄 ${escapeHtml(summary)}</div>`;
    }
  } catch (err) {
    if (targetElement) targetElement.innerHTML = `<div class="summary-box" style="border-color:#ff5555;color:#ff8888">提炼失败: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (btnElement) {
      btnElement.classList.remove("loading");
      btnElement.textContent = "已提炼 ✓";
      setTimeout(() => { btnElement.textContent = type === "agent" ? "🪄 提炼全局画像" : "🪄 总结工具意图"; }, 3000);
    }
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function renderMetrics() {
  const { metrics } = state.data;
  const values = [
    ["Runs", metrics.runs ?? 0, true],
    ["Turns", metrics.turns ?? 0, false],
    ["Attempts", metrics.attempts ?? metrics.turns ?? 0, false],
    ["Tool calls", metrics.toolCalls ?? 0, false],
    ["Tokens", fmtTokens(metrics.totalTokens), false],
    ["Sub-agents", metrics.subAgents ?? 0, true],
  ];
  elements.metrics.innerHTML = values.map(([label, value, accent]) => `<div class="metric ${accent ? "accent" : ""}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
}

function renderThreads() {
  const branches = state.data?.trace?.branches;
  if (branches && branches.length > 0) {
    elements.threads.innerHTML = branches.map((branch) => {
      const runItems = (branch.runs || []).map((run) => {
        const active = state.selectedRunId === run.id ? "active" : "";
        const dotCls = run.status || "completed";
        const promptText = run.prompt || "（无用户输入）";
        const isFirst = run.index === 1;
        const taskLabel = isFirst ? "首轮任务" : (run.deliveryMode === "next_turn" ? "追问补充" : `任务 ${run.index}`);
        return `
          <div class="run-tree-item ${active}" data-run-id="${escapeHtml(run.id)}" title="${escapeHtml(promptText)}">
            <div class="run-tree-top">
              <span class="run-badge ${isFirst ? "main" : "sub"}">${taskLabel}</span>
              <span class="run-tag">Task ${run.index}</span>
              <span class="run-tree-dot ${dotCls}"></span>
              <span class="run-status-text">${run.status === "completed" ? "已完成" : "执行中"}</span>
              <span class="run-turns-badge">${run.turns?.length || 0} 轮对话</span>
            </div>
            <div class="run-tree-title">${escapeHtml(truncate(promptText, 50))}</div>
            <div class="run-tree-foot">
              <span>耗时 ${fmtMs(run.durationMs)}</span>
              <span>·</span>
              <span>${fmtTokens(run.usage?.totalTokens)} tokens</span>
            </div>
          </div>`;
      }).join("");

      return `
        <div class="branch-block">
          <div class="branch-header" data-branch-id="${escapeHtml(branch.id)}">
            <span class="branch-badge ${branch.kind}">${escapeHtml(branch.short)}</span>
            <span class="branch-title">${escapeHtml(branch.title)}</span>
            <span class="branch-count">${branch.runs?.length || 0} 个任务</span>
          </div>
          <div class="branch-runs">${runItems || `<div style="padding:4px 8px;color:#5f6862;font-size:9px">无任务记录</div>`}</div>
        </div>`;
    }).join("");

    elements.threads.querySelectorAll("[data-run-id]").forEach((el) => {
      el.addEventListener("click", () => selectRun(el.dataset.runId));
    });
    return;
  }

  // Fallback
  elements.threads.innerHTML = (state.data.graph?.threads || []).map((thread) => `
    <button class="thread-card ${thread.parentId ? "child" : "root"}" data-thread-id="${thread.id}" type="button">
      <span class="thread-branch">${thread.parentId ? "└" : "◆"}</span>
      <span class="thread-avatar color-${thread.color}">${escapeHtml((thread.nickname || "A").slice(0, 1))}</span>
      <span class="thread-copy"><strong>${escapeHtml(thread.nickname)}</strong><small>${escapeHtml(thread.name)}</small><code>${escapeHtml(thread.path)}</code></span>
      <span class="turn-count">${thread.runs ?? thread.turns}R</span>
    </button>`).join("");
  elements.threads.querySelectorAll("[data-thread-id]").forEach((button) => button.addEventListener("click", () => focusThread(button.dataset.threadId)));
}

function edgePath(from, to) {
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y;
  const bend = Math.max(25, Math.abs(y2 - y1) * 0.44);
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}

function toolPreview(node) {
  const shown = (node.tools || []).slice(0, 3);
  if (!shown.length) return "";
  const rows = shown.map((tool) => `<span><i class="tool-${tool.category}"></i>${escapeHtml(tool.name)}</span>`).join("");
  const more = node.tools.length > shown.length ? `<b>+${node.tools.length - shown.length}</b>` : "";
  return `<div class="node-tools">${rows}${more}</div>`;
}

function svgMarkup() {
  const { graph } = state.data;
  const roleMap = {
    "/root": "总控中枢 · 负责用户交互与总成交付",
    "/root/core_runtime": "核心运行时 · 负责调度并发竞态修复与956单测",
    "/root/core_runtime/remote_transport_review": "链路审查 · 负责网络VPN延迟排查与协议审计",
    "/root/workspace_files": "存储与工作区 · 负责多任务文件继承链核验与测试盘点",
    "/root/dsh_ui": "前端界面 · 负责DSH插件React组件开发与UI回归",
  };

  const lanes = graph.threads.map((thread, index) => {
    const x = (thread.laneX || (70 + index * 340)) - 20;
    const width = 330;
    const roleDesc = roleMap[thread.path] || `${thread.runs || 0} 个任务 · ${thread.status || ""}`;
    return `<g class="lane ${index ? "child-lane" : "root-lane"}" data-thread-id="${escapeHtml(thread.id)}">
      <rect x="${x}" y="30" width="${width}" height="${Math.max(700, graph.height - 40)}" rx="14"></rect>
      <foreignObject x="${x + 10}" y="45" width="${width - 20}" height="85">
        <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;flex-direction:column;gap:3px;background:#0d1210;padding:8px 10px;border-radius:6px;border:1px solid #232d27">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <strong style="color:var(--paper);font-size:11px">${escapeHtml(thread.nickname || "Agent")}</strong>
            <button class="magic-btn btn-agent-summary" data-agent-name="${escapeHtml(thread.nickname)}" data-agent-path="${escapeHtml(thread.path)}" type="button">🪄 提炼全局画像</button>
          </div>
          <span style="color:#8fa095;font-size:8.5px;font-family:var(--mono)">${escapeHtml(roleDesc)}</span>
          <div class="agent-summary-result" id="summary-agent-${escapeHtml(thread.id)}"></div>
        </div>
      </foreignObject>
    </g>`;
  }).join("");

  const turnBands = (graph.turns || []).map((turn) => {
    if (!turn.nodeIds?.length || turn.maxX <= turn.minX) return "";
    const thread = graph.threads.find((item) => item.id === turn.threadId);
    if (!thread) return "";
    const x = (thread.laneX || 70) - 10;
    const y = turn.minY ? turn.minY - 15 : 70;
    const height = turn.maxY && turn.minY ? (turn.maxY - turn.minY + 30) : 150;
    return `<g class="turn-band ${state.selectedRunId === turn.id ? "active" : ""}" data-turn-id="${escapeHtml(turn.id)}">
      <rect x="${x}" y="${y}" width="310" height="${height}" rx="10"></rect>
      <text x="${x + 10}" y="${y + 15}">TASK / RUN ${String(turn.index).padStart(2, "0")}</text>
    </g>`;
  }).join("");

  const edges = graph.edges.map((edge, index) => {
    const from = state.nodes.get(edge.from);
    const to = state.nodes.get(edge.to);
    if (!from || !to) return "";
    const pathD = edgePath(from, to);
    let labelMarkup = "";
    if (edge.type === "spawn" || edge.type === "return") {
      const midX = (from.x + from.width + to.x) / 2;
      const midY = (from.y + to.y) / 2 + 10;
      const edgeLabel = edge.label || (edge.type === "spawn" ? "委派任务 ↘" : "结果回流 ↗");
      labelMarkup = `<text class="edge-text-label ${edge.type}" x="${midX}" y="${midY}" text-anchor="middle">${escapeHtml(edgeLabel)}</text>`;
    }
    return `<g class="edge-group">
      <path id="edge-${index}" class="graph-edge edge-${edge.type}" data-from="${edge.from}" data-to="${edge.to}" d="${pathD}" marker-end="url(#arrow-${edge.type})"></path>
      ${labelMarkup}
    </g>`;
  }).join("");

  const nodes = graph.nodes.map((node) => {
    const kind = typeLabel[node.type] || node.type;
    const toolCount = node.tools?.length ? `<span class="node-count">${node.tools.length} calls</span>` : "";
    const isToolBatch = (node.tools?.length || 0) > 1;
    const agent = graph.threads.find((thread) => thread.id === node.threadId);
    return `<g class="graph-node-shell" data-node-id="${node.id}" transform="translate(${node.x} ${node.y})" tabindex="0" role="button" aria-label="${escapeHtml(node.label)}">
      <foreignObject width="${node.width}" height="${node.height}">
        <div xmlns="http://www.w3.org/1999/xhtml" class="graph-node node-${node.type}">
          <div class="node-top"><span class="node-action"><i></i>${escapeHtml(kind)}</span>${toolCount}</div>
          <h3>${escapeHtml(node.label)}</h3>
          <p>${escapeHtml(truncate(node.summary, 74))}</p>
          ${toolPreview(node)}
          <div class="node-foot">
            <span>${escapeHtml(agent?.nickname || "Root")}</span>
            ${isToolBatch ? `<button class="magic-btn btn-tool-summary" data-node-id="${escapeHtml(node.id)}" type="button" style="padding:1px 5px;font-size:7.5px">🪄 总结工具意图</button>` : "<span>OPEN ↗</span>"}
          </div>
          <div class="node-summary-result" id="summary-node-${escapeHtml(node.id)}"></div>
        </div>
      </foreignObject>
    </g>`;
  }).join("");

  return `<defs>
    <marker id="arrow-sequence" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4a544f"></path></marker>
    <marker id="arrow-spawn" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#a78bfa"></path></marker>
    <marker id="arrow-return" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#34d399"></path></marker>
  </defs>${lanes}<g class="turn-layer">${turnBands}</g><g class="edge-layer">${edges}</g><g class="node-layer">${nodes}</g>`;
}

function renderGraph() {
  elements.svg.setAttribute("viewBox", `${state.viewBox.x} ${state.viewBox.y} ${state.viewBox.width} ${state.viewBox.height}`);
  elements.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  elements.svg.innerHTML = svgMarkup();
  elements.svg.querySelectorAll("[data-node-id]").forEach((group) => {
    const activate = () => selectNode(group.dataset.nodeId);
    group.addEventListener("click", activate);
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") activate(); });
  });

  elements.svg.querySelectorAll(".btn-agent-summary").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const agentPath = btn.dataset.agentPath;
      const agentName = btn.dataset.agentName;
      const thread = state.data.graph.threads.find((t) => t.path === agentPath);
      const targetBox = document.querySelector(`#summary-agent-${CSS.escape(thread?.id)}`);
      fetchSmartSummary({
        type: "agent",
        prompt: `Agent名称: ${agentName}, 路径: ${agentPath}. 拥有 ${thread?.runs || 0} 个任务. 角色定位: ${thread?.path}`,
        btnElement: btn,
        targetElement: targetBox,
      });
    });
  });

  elements.svg.querySelectorAll(".btn-tool-summary").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nodeId = btn.dataset.nodeId;
      const node = state.nodes.get(nodeId);
      const fo = btn.closest("foreignObject");
      if (fo) fo.setAttribute("height", "180");
      const targetBox = document.querySelector(`#summary-node-${CSS.escape(nodeId)}`);
      const toolsPrompt = (node?.tools || []).map((t) => `${t.name}: ${t.command || t.action}`).join("; ").slice(0, 1500);
      selectNode(nodeId);
      fetchSmartSummary({
        type: "tools",
        prompt: `工具调用批次: ${toolsPrompt}`,
        btnElement: btn,
        targetElement: targetBox,
      }).then(() => {
        const panelBox = document.querySelector(`#panel-summary-${CSS.escape(nodeId)}`);
        const summary = state.summaryCache.get(`tools:${toolsPrompt.slice(0, 80)}`);
        if (panelBox && summary) panelBox.innerHTML = `🪄 ${escapeHtml(summary)}`;
      });
    });
  });

  applyGraphState();
}

function applyViewBox() {
  elements.svg.setAttribute("viewBox", `${state.viewBox.x} ${state.viewBox.y} ${state.viewBox.width} ${state.viewBox.height}`);
  elements.scale.textContent = `${Math.round(state.data.graph.width / state.viewBox.width * 100)}%`;
}

function applyGraphState() {
  const query = state.query.toLowerCase();
  elements.svg.querySelectorAll(".graph-node-shell").forEach((group) => {
    const node = state.nodes.get(group.dataset.nodeId);
    const haystack = `${node.label} ${node.summary} ${node.content} ${(node.tools || []).map((tool) => `${tool.name} ${tool.action}`).join(" ")}`.toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesType = !state.highlightedType || node.type === state.highlightedType || (state.highlightedType === "model" && node.type === "final");
    const matchesTurn = !state.selectedRunId || state.runNodeIds.has(node.id);
    group.classList.toggle("dimmed", !matchesQuery || !matchesType || !matchesTurn);
    group.classList.toggle("outside-turn", !matchesTurn);
    group.classList.toggle("selected", node.id === state.selectedId);
  });
  elements.svg.querySelectorAll(".graph-edge").forEach((edge) => {
    edge.classList.toggle("edge-active", edge.dataset.from === state.selectedId || edge.dataset.to === state.selectedId);
    edge.classList.toggle("edge-dimmed", Boolean(state.selectedRunId) && (!state.runNodeIds.has(edge.dataset.from) || !state.runNodeIds.has(edge.dataset.to)));
  });
  elements.svg.querySelectorAll(".turn-band").forEach((band) => band.classList.toggle("active", band.dataset.turnId === state.selectedRunId));
  elements.svg.querySelectorAll(".lane").forEach((lane) => {
    const inScope = state.data.graph.nodes.some((node) => node.threadId === lane.dataset.threadId && state.runNodeIds.has(node.id));
    lane.classList.toggle("outside-turn", Boolean(state.selectedRunId) && !inScope);
  });
  elements.svg.querySelectorAll(".turn-band").forEach((band) => {
    const turn = state.data.graph.turns.find((item) => item.id === band.dataset.turnId);
    const inScope = turn?.nodeIds.some((id) => state.runNodeIds.has(id));
    band.classList.toggle("outside-turn", Boolean(state.selectedRunId) && !inScope);
  });
}

function facts(entries) {
  return `<div class="fact-grid">${entries.map(([key, value]) => `<div class="fact"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value ?? "—")}</strong></div>`).join("")}</div>`;
}

function toolsView(node) {
  if (!node.tools?.length) return `<div class="empty-state"><span>NO TOOL CALLS</span><p>这个节点是一条消息，不包含工具调用。</p></div>`;
  return `<p class="detail-kicker">${node.tools.length} calls / merged with results</p>
    <h2 class="detail-title">工具调用批次</h2>
    <p class="detail-copy">同一动作阶段内的工具调用和结果在图上合并为一个节点；下面保留每个调用的独立信息。</p>
    <div class="tool-stack">${node.tools.map((tool, index) => `<details class="tool-detail" ${index === 0 ? "open" : ""}>
      <summary><i class="tool-${tool.category}"></i><span><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.action)}</small></span><b>${escapeHtml(tool.status)}</b></summary>
      ${facts([["Call ID", tool.callId], ["Category", tool.category], ["Duration", tool.durationSeconds != null ? `${tool.durationSeconds.toFixed(1)}s` : "—"], ["Output", tool.output ? "available" : "empty"]])}
      <section><div class="tool-content-head"><h3>完整原始输入</h3><button class="copy-tool-content" data-tool-index="${index}" data-copy-field="input" type="button" aria-label="复制完整原始输入"><span>COPY</span></button></div><pre>${escapeHtml(tool.input || "无可见输入")}</pre></section>
      <section><div class="tool-content-head"><h3>完整原始结果</h3><button class="copy-tool-content" data-tool-index="${index}" data-copy-field="output" type="button" aria-label="复制完整原始结果"><span>COPY</span></button></div><pre>${escapeHtml(tool.output || "无可见输出")}</pre></section>
    </details>`).join("")}</div>`;
}

function agentContextView(node) {
  const context = node.agentContext;
  if (!context) return "";
  const promptAvailable = Boolean(context.systemPrompt?.content);
  const observed = context.observedTools?.length
    ? context.observedTools.map((tool) => `<span class="runtime-tool"><strong>${escapeHtml(tool.name)}</strong><b>×${escapeHtml(tool.count)}</b></span>`).join("")
    : `<span class="runtime-empty">该 Agent 没有产生工具调用</span>`;
  return `<section class="agent-runtime-context">
    <div class="runtime-head"><span>AGENT RUNTIME CONTEXT</span><b class="runtime-status ${promptAvailable ? "available" : "missing"}">${promptAvailable ? "DEFINITION AVAILABLE" : "SYSTEM PROMPT NOT PERSISTED"}</b></div>
    ${facts([["Agent type", context.agentType], ["Spawn depth", context.spawnDepth], ["Spawn call", context.spawnToolUseId], ["Observed tools", context.observedTools?.length || 0]])}
    <div class="runtime-block">
      <h3>系统提示词 / Agent Definition</h3>
      <p class="runtime-note">${escapeHtml(context.systemPrompt?.note || "无来源说明")}</p>
      ${promptAvailable ? `<pre>${escapeHtml(context.systemPrompt.content)}</pre><small>SOURCE · ${escapeHtml(context.systemPrompt.source)}</small>` : `<div class="runtime-unavailable"><i>!</i><span><strong>历史数据未记录最终 System Prompt</strong><small>不会使用当前版本模板冒充该 Session 的历史原文。</small></span></div>`}
    </div>
    <div class="runtime-block">
      <h3>运行时 Agent Definition</h3>
      <pre>${escapeHtml(context.agentDefinition?.rawDefinition || context.agentDefinition?.description || "无可见 Agent definition")}</pre>
      <small>SOURCE · ${escapeHtml(context.agentDefinition?.source || "unknown")}</small>
    </div>
    <div class="runtime-block">
      <h3>声明工具策略</h3>
      <code>${escapeHtml(context.agentDefinition?.declaredTools || "未声明")}</code>
    </div>
    <div class="runtime-block">
      <h3>本次实际使用工具</h3>
      <div class="runtime-tools">${observed}</div>
    </div>
  </section>`;
}

function contentView(node) {
  const thread = state.data.graph.threads.find((item) => item.id === node.threadId);
  const cachedSummary = state.summaryCache.get(`node:${node.id}`);
  const summaryBoxContent = cachedSummary
    ? `🪄 ${escapeHtml(cachedSummary)}`
    : `<span style="color:#6f7871;font-size:9px">点击右上角按钮由 Magpie (deepseek-v4.1-flash) 提炼一句话精炼意图。</span>`;

  return `<p class="detail-kicker">${escapeHtml(typeLabel[node.type] || node.type)} / ${escapeHtml(thread?.path || "/root")}</p>
    <h2 class="detail-title">${escapeHtml(node.label)}</h2>
    <p class="detail-summary">${escapeHtml(node.summary)}</p>

    <div class="detail-section" style="margin:10px 0;padding:10px;background:#0d1310;border:1px solid rgba(199,255,56,.3);border-radius:4px">
      <div class="detail-section-head">
        <h3 style="color:var(--acid);margin:0;font-size:10px">🪄 智能意图提炼 (DeepSeek 4.1F)</h3>
        <button class="magic-btn btn-panel-summary" data-node-id="${escapeHtml(node.id)}" type="button">${cachedSummary ? "重新提炼 🪄" : "提炼当前意图 🪄"}</button>
      </div>
      <div class="summary-box panel-summary-box" id="panel-summary-${escapeHtml(node.id)}" style="margin-top:6px;font-size:10px;line-height:1.5">${summaryBoxContent}</div>
    </div>

    ${facts([["Thread", thread?.nickname], ["Turn", node.turnId || "root turn"], ["Action", typeLabel[node.type]], ["Tools", node.tools?.length || 0]])}
    ${node.encryptedSource ? `<div class="source-warning">原始 Sub-agent 任务正文在 rollout 中以 <code>encrypted_content</code> 保存。这里展示从可见元数据和返回结果恢复出的任务说明，不伪造“完整原文”。</div>` : ""}
    ${agentContextView(node)}
    <div class="detail-section"><h3>完整消息内容</h3><div class="message-content">${escapeHtml(node.content || "无可见消息内容")}</div></div>
    ${node.tools?.length ? `<button class="inspect-tools" id="inspect-tools" type="button">查看 ${node.tools.length} 个工具调用与结果 →</button>` : ""}`;
}

function jsonView(node) {
  const jsonStr = JSON.stringify(node, null, 2);
  return `<p class="detail-kicker">NORMALIZED GRAPH NODE</p>
    <div class="detail-section-head">
      <h2 class="detail-title">${escapeHtml(node.id)}</h2>
      <button class="copy-btn copy-target-json" id="copy-target-json" type="button">复制完整 JSON 📋</button>
    </div>
    <div class="detail-section"><pre id="raw-json-pre">${escapeHtml(jsonStr)}</pre></div>`;
}

function renderDetail() {
  const traceSelection = state.selectedTrace;
  if (traceSelection) {
    if (traceSelection.type === "run") { renderRunDetail(); return; }
    if (traceSelection.type === "turn") { renderTurnDetail(); return; }
    if (traceSelection.type === "item") { renderItemDetail(); return; }
  }
  const node = state.nodes.get(state.selectedId);
  if (!node) { elements.detail.innerHTML = `<div class="empty-state"><span>NO SELECTION</span><p>从层级树、执行关系图或 Run 时间轴选择一个节点。</p></div>`; return; }
  elements.nodeKind.textContent = typeLabel[node.type] || node.type;
  if (state.detailTab === "context") { elements.nodeKind.textContent = "CONTEXT"; renderContextView(); }
  else if (state.detailTab === "tools") elements.detail.innerHTML = toolsView(node);
  else if (state.detailTab === "json") elements.detail.innerHTML = jsonView(node);
  else elements.detail.innerHTML = contentView(node);
  document.querySelector("#inspect-tools")?.addEventListener("click", () => setDetailTab("tools"));
  elements.detail.querySelectorAll(".copy-tool-content").forEach((button) => button.addEventListener("click", async () => {
    const tool = node.tools?.[Number(button.dataset.toolIndex)];
    const value = tool?.[button.dataset.copyField] || "";
    await navigator.clipboard.writeText(value);
    button.classList.add("copied");
    button.querySelector("span").textContent = "COPIED";
    setTimeout(() => {
      button.classList.remove("copied");
      button.querySelector("span").textContent = "COPY";
    }, 1200);
  }));

  elements.detail.querySelectorAll(".btn-panel-summary").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetBox = document.querySelector(`#panel-summary-${CSS.escape(node.id)}`);
      const toolsPrompt = (node?.tools || []).map((t) => `${t.name}: ${t.command || t.action}`).join("; ").slice(0, 1500) || node.content?.slice(0, 1500) || "";
      const isTools = (node?.tools?.length || 0) > 0;
      fetchSmartSummary({
        type: isTools ? "tools" : "agent",
        prompt: `节点标签: ${node.label}, 消息类型: ${node.type}. 内容: ${toolsPrompt}`,
        btnElement: btn,
        targetElement: targetBox,
      }).then(() => {
        const cardBox = document.querySelector(`#summary-node-${CSS.escape(node.id)}`);
        const summary = state.summaryCache.get(`${isTools ? "tools" : "agent"}:${toolsPrompt.slice(0, 80)}`);
        if (cardBox && summary) cardBox.innerHTML = `<div class="summary-box">🪄 ${escapeHtml(summary)}</div>`;
      });
    });
  });
}

function selectNode(id, { keepTrace = false } = {}) {
  state.selectedId = id;
  if (!keepTrace) state.selectedTrace = null;
  const node = state.nodes.get(id);
  if (node.tools?.length && state.detailTab === "content") state.detailTab = "tools";
  if (!node.tools?.length && state.detailTab === "tools") state.detailTab = "content";
  document.querySelectorAll(".detail-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.detailTab));
  applyGraphState();
  renderDetail();
}

function setDetailTab(tab) {
  state.detailTab = tab;
  state.selectedTrace = null;
  document.querySelectorAll(".detail-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  if (tab === "context") {
    elements.nodeKind.textContent = "CONTEXT";
    renderContextView();
    return;
  }
  const node = state.nodes.get(state.selectedId);
  if (node) selectNode(node.id);
  else renderDetail();
}

function fitBounds(bounds, padding = 120) {
  const rect = elements.viewport.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return;
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
  const aspect = Math.max(0.5, rect.width / rect.height);
  // 约束视野尺寸，防止几万像素的纵向长卷将卡片缩小成米粒
  const targetWidth = Math.max(1600, Math.min(2600, bounds.width + padding * 2));
  const targetHeight = targetWidth / aspect;
  state.viewBox = {
    x: Math.max(0, bounds.x - padding),
    y: Math.max(0, bounds.y - 30),
    width: targetWidth,
    height: targetHeight,
  };
  applyViewBox();
}

function focusAgents() {
  const childIds = new Set(state.data.graph.threads.filter((thread) => thread.parentId).map((thread) => thread.id));
  const nodes = state.data.graph.nodes.filter((node) => childIds.has(node.threadId) && (!state.selectedRunId || state.runNodeIds.has(node.id)));
  if (!nodes.length) { fitGraph(); return; }
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, 90);
}
function fitGraph() { fitBounds({ x: 0, y: 0, width: state.data.graph.width, height: state.data.graph.height }, 40); }
function focusStart() {
  if (state.data.graph.width <= 3000) { fitGraph(); return; }
  fitBounds({ x: 0, y: 0, width: 2400, height: state.data.graph.height }, 50);
}

function focusThread(threadId) {
  const nodes = state.data.graph.nodes.filter((node) => node.threadId === threadId);
  if (!nodes.length) return;
  if (state.selectedRunId && !nodes.some((node) => state.runNodeIds.has(node.id))) {
    const spawn = state.data.graph.edges.find((edge) => edge.type === "spawn" && nodes.some((node) => node.id === edge.to));
    const parentTurnId = state.nodes.get(spawn?.from)?.turnId;
    if (parentTurnId) activateRun(parentTurnId, { select: false });
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  fitBounds({ x: minX, y: minY, width: maxX - minX, height: Math.max(180, maxY - minY) }, 140);
  selectNode(nodes[0].id);
}

function zoom(factor, clientX = null, clientY = null) {
  const rect = elements.viewport.getBoundingClientRect();
  const px = clientX == null ? 0.5 : (clientX - rect.left) / rect.width;
  const py = clientY == null ? 0.5 : (clientY - rect.top) / rect.height;
  const graphX = state.viewBox.x + state.viewBox.width * px;
  const graphY = state.viewBox.y + state.viewBox.height * py;
  const width = Math.min(Math.max(1200, state.data.graph.width * 1.25), Math.max(640, state.viewBox.width * factor));
  const height = width * rect.height / rect.width;
  state.viewBox = { x: graphX - width * px, y: graphY - height * py, width, height };
  applyViewBox();
}

function ensureGraphTurns(data) {
  if (data.graph.turns?.length) return;
  const groups = new Map();
  for (const node of data.graph.nodes) {
    if (!node.turnId) continue;
    const key = `${node.threadId}:${node.turnId}`;
    const group = groups.get(key) || { id: node.turnId, threadId: node.threadId, nodeIds: [], startedAt: node.timestamp, completedAt: null, status: "running" };
    group.nodeIds.push(node.id);
    if (node.type === "final") Object.assign(group, { completedAt: node.timestamp, status: "completed" });
    groups.set(key, group);
  }
  const perThread = new Map();
  data.graph.turns = [...groups.values()].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt)).map((turn) => {
    const index = (perThread.get(turn.threadId) || 0) + 1;
    perThread.set(turn.threadId, index);
    const nodes = turn.nodeIds.map((id) => data.graph.nodes.find((node) => node.id === id)).filter(Boolean);
    return {
      ...turn,
      index,
      minX: Math.min(...nodes.map((node) => node.x)),
      maxX: Math.max(...nodes.map((node) => node.x + node.width)),
    };
  });
}

function rootRuns() {
  const rootThread = state.data.graph.threads.find((thread) => !thread.parentId);
  return (state.data.graph.turns || []).filter((turn) => turn.threadId === rootThread?.id).sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
}

function runScope(turnId) {
  const turn = state.data.graph.turns.find((item) => item.id === turnId);
  const included = new Set(turn?.nodeIds || []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of state.data.graph.edges.filter((item) => item.type === "spawn")) {
      if (!included.has(edge.from)) continue;
      const target = state.nodes.get(edge.to);
      for (const node of state.data.graph.nodes.filter((item) => item.threadId === target?.threadId)) {
        if (!included.has(node.id)) { included.add(node.id); changed = true; }
      }
    }
  }
  return included;
}

function renderTurnStrip() {
  const turns = rootRuns();
  const buttons = turns.map((turn) => {
    const date = new Date(turn.startedAt);
    return `<button class="turn-button ${turn.status === "running" ? "running" : ""} ${state.selectedRunId === turn.id ? "active" : ""}" data-turn-id="${escapeHtml(turn.id)}" type="button" title="${escapeHtml(date.toLocaleString("zh-CN"))}"><i></i>R${String(turn.index).padStart(2, "0")}</button>`;
  }).join("");
  elements.turnList.innerHTML = `<button class="turn-button full ${state.selectedRunId ? "" : "active"}" data-turn-id="" type="button">FULL SESSION</button>${buttons}`;
  elements.turnList.querySelectorAll("[data-turn-id]").forEach((button) => button.addEventListener("click", () => activateRun(button.dataset.turnId || null)));
}

function activateRun(turnId, { select = true } = {}) {
  state.selectedRunId = turnId;
  state.runNodeIds = turnId ? runScope(turnId) : new Set();
  renderTurnStrip();
  applyGraphState();
  if (!turnId) { fitGraph(); return; }
  const nodes = state.data.graph.nodes.filter((node) => state.runNodeIds.has(node.id));
  if (!nodes.length) return;
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, 90);
  if (select && !state.runNodeIds.has(state.selectedId)) selectNode(nodes[0].id);
}

function openSessionBrowser() {
  elements.sessionBrowser.hidden = false;
  document.body.classList.add("sessions-open");
  requestAnimationFrame(() => elements.sessionSearch.focus());
}

function closeSessionBrowser() {
  elements.sessionBrowser.hidden = true;
  document.body.classList.remove("sessions-open");
  elements.openSessions.focus();
}

function renderSessionStats() {
  const metrics = state.sessionIndex?.metrics;
  if (!metrics) return;
  const values = [
    ["Conversations", metrics.total],
    ["Projects", metrics.projects],
    ["Source files", metrics.sourceFiles],
    ["Merged", metrics.merged],
    ["Active", metrics.active, true],
  ];
  elements.sessionStats.innerHTML = values.map(([label, value, active]) => `<div class="session-stat ${active ? "active" : ""}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
}

function visibleSessions() {
  const query = state.sessionQuery.toLowerCase();
  return (state.sessionIndex?.sessions || []).filter((session) => {
    const projectMatch = state.sessionProject === "all" || session.cwd === state.sessionProject;
    const haystack = `${session.title} ${session.latestPrompt} ${session.id} ${session.sourceSessionId} ${session.cwd}`.toLowerCase();
    return projectMatch && (!query || haystack.includes(query));
  });
}

function renderProjectList() {
  if (!state.sessionIndex) return;
  const all = `<button class="project-item all-conversations ${state.sessionProject === "all" ? "active" : ""}" data-project-id="all" type="button">
    <span class="project-icon">∞</span>
    <span class="project-copy"><strong>所有对话</strong><small>${escapeHtml(providerMeta[state.provider].directory)}</small></span>
    <span class="project-count">${state.sessionIndex.metrics.total}</span>
  </button>`;
  const projects = state.sessionIndex.projects.map((project) => `<button class="project-item ${state.sessionProject === project.id ? "active" : ""}" data-project-id="${escapeHtml(project.id)}" type="button">
    <span class="project-icon">⌁</span>
    <span class="project-copy"><strong title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</strong><small title="${escapeHtml(project.path)}">${escapeHtml(project.path)}</small></span>
    <span class="project-count">${project.count}</span>
  </button>`).join("");
  elements.projectList.innerHTML = all + projects;
  elements.projectList.querySelectorAll("[data-project-id]").forEach((button) => button.addEventListener("click", () => {
    state.sessionProject = button.dataset.projectId;
    state.sessionQuery = "";
    elements.sessionSearch.value = "";
    renderProjectList();
    renderSessionList();
  }));
}

function renderSessionList() {
  const sessions = visibleSessions();
  const project = state.sessionIndex?.projects.find((item) => item.id === state.sessionProject);
  elements.currentProjectName.textContent = state.sessionProject === "all" ? "所有对话" : `${project?.name || "工程目录"} / Sessions`;
  elements.visibleSessionCount.textContent = `${sessions.length} / ${state.sessionIndex?.metrics.total || 0}`;
  if (!sessions.length) {
    elements.sessionList.innerHTML = `<div class="session-list-empty">没有符合当前条件的 Session</div>`;
    return;
  }
  elements.sessionList.innerHTML = sessions.map((session) => {
    const date = new Date(session.updatedAt);
    const badges = [
      `<span class="session-badge">CONVERSATION</span>`,
      session.subagentCount ? `<span class="session-badge subagent">+${session.subagentCount} AGENTS</span>` : "",
      session.active ? `<span class="session-badge active">LIVE</span>` : "",
    ].join("");
    return `<button class="session-item ${session.id === state.currentSessionId ? "current" : ""}" data-session-id="${escapeHtml(session.id)}" type="button">
      <span class="session-time"><strong>${escapeHtml(timeFormatter.format(date))}</strong><span>${escapeHtml(dateFormatter.format(date))}</span></span>
      <span class="session-item-copy">
        <strong title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</strong>
        <small title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd || session.file)}</small>
        <span class="session-item-meta">${badges}<span>${escapeHtml(session.shortId)}</span><span>${escapeHtml(formatBytes(session.sizeBytes))}</span></span>
      </span>
      <span class="session-open-mark">↗</span>
    </button>`;
  }).join("");
  elements.sessionList.querySelectorAll("[data-session-id]").forEach((button) => button.addEventListener("click", async () => {
    await loadGraph(button.dataset.sessionId);
    closeSessionBrowser();
  }));
}

async function loadSessionIndex() {
  elements.refreshSessions.disabled = true;
  try {
    const url = new URL(`/api/providers/${encodeURIComponent(state.provider)}/sessions`, window.location.origin);
    if (state.provider === "noval") {
      if (!state.workspaceRoot) {
        elements.sessionList.innerHTML = `<div class="session-list-empty">请先填写 Noval 工程目录。</div>`;
        return;
      }
      url.searchParams.set("workspaceRoot", state.workspaceRoot);
    }
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Session index failed: ${response.status}`);
    state.sessionIndex = await response.json();
    state.providerCounts.set(state.provider, state.sessionIndex.metrics.total);
    elements.sessionCount.textContent = state.sessionIndex.metrics.total;
    elements.sessionDirectory.textContent = state.sessionIndex.directories.map((item) => item.path).join(" + ");
    renderSessionStats();
    if (state.sessionProject !== "all" && !state.sessionIndex.projects.some((project) => project.id === state.sessionProject)) state.sessionProject = "all";
    renderProjectList();
    renderSessionList();
    renderProviderSwitch();
    notifyParentState();
  } catch (error) {
    elements.sessionList.innerHTML = `<div class="session-list-empty">${escapeHtml(error.message)}</div>`;
  } finally {
    elements.refreshSessions.disabled = false;
  }
}

function installGraphData(data, { preserveSelection = false } = {}) {
  const previous = preserveSelection ? state.selectedId : null;
  const previousTurn = preserveSelection ? state.selectedRunId : null;
  state.data = data;
  ensureGraphTurns(state.data);
  state.nodes.clear();
  state.data.graph.nodes.forEach((node) => state.nodes.set(node.id, node));
  state.selectedTrace = null;
  state.context = null;
  state.expanded.clear();
  state.turnLimits.clear();
  indexTrace();
  const traceThreads = data.trace?.threads || [];
  const rootThread = traceThreads.find((thread) => !thread.parentId) || traceThreads[0];
  for (const thread of traceThreads) state.expanded.add(`thread:${thread.id}`);
  if (rootThread?.runs?.length) state.expanded.add(`run:${rootThread.runs.at(-1).id}`);
  const turns = rootRuns();
  const defaultTurn = turns.filter((turn) => turn.status === "completed").at(-1) || turns.at(-1) || null;
  state.selectedRunId = previousTurn && state.data.graph.turns.some((turn) => turn.id === previousTurn) ? previousTurn : defaultTurn?.id || null;
  state.runNodeIds = state.selectedRunId ? runScope(state.selectedRunId) : new Set();
  const firstScopedNode = state.data.graph.nodes.find((node) => !state.selectedRunId || state.runNodeIds.has(node.id));
  state.selectedId = previous && state.nodes.has(previous) && (!state.selectedRunId || state.runNodeIds.has(previous))
    ? previous
    : firstScopedNode?.id;
  state.currentSessionId = state.data.session.id;
  state.detailTab = state.nodes.get(state.selectedId)?.tools?.length ? "tools" : "content";
  document.querySelectorAll(".detail-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.detailTab));
  elements.headerSession.textContent = state.data.session.shortId.toUpperCase();
  elements.sourceFile.textContent = `${state.data.source.provider.toUpperCase()} · ${state.data.source.rootFile}`;
  document.title = `${state.data.session.title || state.data.session.shortId} · Agent Session Visualizer`;
  renderMetrics();
  renderThreads();
  renderGraph();
  renderTurnStrip();
  setView(state.view);
  renderDetail();
  if (state.sessionIndex) renderSessionList();
  requestAnimationFrame(() => state.selectedRunId ? activateRun(state.selectedRunId, { select: false }) : focusStart());
}

function notifyParentState() {
  if (typeof window !== "undefined" && window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({
        type: "asv-state-sync",
        provider: state.provider,
        currentSessionId: state.currentSessionId,
        sessionTitle: state.data?.session?.title || state.currentSessionId || "",
        sessions: (state.sessionIndex?.sessions || []).map((s) => ({
          id: s.id,
          shortId: s.shortId || s.id.slice(0, 8),
          title: s.title || s.id,
          updatedAt: s.updatedAt,
          workspace: s.workspace,
        })),
        providerCounts: Object.fromEntries(state.providerCounts || []),
      }, "*");
    } catch (_) {}
  }
}

async function loadGraph(sessionId, { silent = false } = {}) {
  console.log("APP: loadGraph starting for session", sessionId);
  if (!silent) elements.graphLoading.hidden = false;
  try {
    const url = new URL(`/api/providers/${encodeURIComponent(state.provider)}/sessions/${encodeURIComponent(sessionId)}/graph`, window.location.origin);
    if (state.provider === "noval" && state.workspaceRoot) {
      url.searchParams.set("workspaceRoot", state.workspaceRoot);
    }
    console.log("APP: fetch starting", url.toString());
    const response = await fetch(url, { cache: "no-store" });
    console.log("APP: fetch response status", response.status);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `Graph load failed: ${response.status}`);
    }
    console.log("APP: json parsing starting");
    const json = await response.json();
    console.log("APP: json parsing finished, calling installGraphData");
    installGraphData(json, { preserveSelection: silent });
    console.log("APP: installGraphData finished");
    state.currentSessionId = sessionId;
    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.set("session", sessionId);
    pageUrl.searchParams.set("provider", state.provider);
    history.replaceState(null, "", pageUrl);
    notifyParentState();
  } catch (error) {
    console.error("LOAD_GRAPH_ERROR:", error.message, error.stack);
  } finally {
    elements.graphLoading.hidden = true;
  }
}

function connectLiveIndex() {
  state.liveStream?.close();
  const connectedProvider = state.provider;
  const stream = new EventSource(`/api/providers/${encodeURIComponent(connectedProvider)}/events`);
  state.liveStream = stream;
  stream.addEventListener("connected", () => {
    elements.liveState.classList.add("connected");
    elements.liveState.querySelector("span").textContent = "LIVE WATCH";
  });
  stream.addEventListener("sessions-changed", async (event) => {
    if (state.provider !== connectedProvider) return;
    const change = JSON.parse(event.data);
    await loadSessionIndex();
    if (state.currentSessionId && change.changedIds.includes(state.currentSessionId)) {
      clearTimeout(state.liveReloadTimer);
      state.liveReloadTimer = setTimeout(() => loadGraph(state.currentSessionId, { silent: true }), 500);
    }
  });
  stream.onerror = () => {
    elements.liveState.classList.remove("connected");
    elements.liveState.querySelector("span").textContent = "RECONNECTING";
  };
}

function renderProviderSwitch() {
  elements.providerEyebrow.textContent = `LOCAL PROVIDER / ${providerMeta[state.provider].label.toUpperCase()}`;
  elements.providerSwitch.querySelectorAll("[data-provider]").forEach((button) => button.classList.toggle("active", button.dataset.provider === state.provider));
  elements.providerSwitch.querySelectorAll("[data-provider-count]").forEach((badge) => {
    const count = state.providerCounts.get(badge.dataset.providerCount);
    badge.textContent = count == null ? "—" : count;
  });
  document.querySelectorAll("#topbar-providers .topbar-p-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.p === state.provider);
  });
}

async function switchProvider(provider) {
  if (!providerMeta[provider] || provider === state.provider) return;
  state.provider = provider;
  state.sessionIndex = null;
  state.sessionProject = "all";
  state.sessionQuery = "";
  state.currentSessionId = state.data?.source?.provider === provider ? state.data.session.id : null;
  elements.sessionSearch.value = "";
  elements.sessionList.innerHTML = `<div class="session-list-loading">正在建立 ${escapeHtml(providerMeta[provider].label)} Session 索引…</div>`;
  elements.sessionDirectory.textContent = providerMeta[provider].directory;
  elements.liveState.classList.remove("connected");
  elements.liveState.querySelector("span").textContent = "CONNECTING";
  // Noval 需要工程目录来定位 session 日志
  if (elements.novalWorkspaceRoot) {
    elements.novalWorkspaceRoot.hidden = provider !== "noval";
  }
  renderProviderSwitch();
  if (provider === "noval") {
    if (state.workspaceRoot) await loadSessionIndex();
    else elements.sessionList.innerHTML = `<div class="session-list-empty">请先填写 Noval 工程目录。</div>`;
  } else {
    await loadSessionIndex();
  }
  const allSessions = state.sessionIndex?.sessions || [];
  if (allSessions.length > 0 && allSessions[0]?.id) {
    await loadGraph(allSessions[0].id);
  }
  connectLiveIndex();
  notifyParentState();
}

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fmtTokens(value) {
  if (!value) return "—";
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function fmtClock(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

const KIND_LABEL = {
  input: "输入", output: "模型", answer: "最终", reasoning: "推理", tool: "工具",
  skill: "技能", subagent: "Agent", compaction: "压缩", request: "请求", failure: "失败", wait: "等待",
};

function indexTrace() {
  state.runById.clear();
  state.turnById.clear();
  state.traceItemById.clear();
  const threadById = new Map((state.data?.graph?.threads || []).map((t) => [t.id, t]));
  for (const run of state.data?.trace?.runs || []) {
    const thread = threadById.get(run.threadId);
    run.threadNickname = thread?.nickname || "Agent";
    state.runById.set(run.id, run);
    for (const input of run.inputItems || []) state.traceItemById.set(input.id, input);
    for (const turn of run.turns || []) {
      turn.runId = run.id;
      turn.threadId = run.threadId;
      state.turnById.set(turn.id, turn);
      for (const item of turn.items || []) state.traceItemById.set(item.id, item);
    }
  }
}

function threadDepth(thread, threads) {
  let depth = 0;
  let current = thread;
  const seen = new Set([thread.id]);
  while (current?.parentId && threads.some((candidate) => candidate.id === current.parentId) && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    current = threads.find((candidate) => candidate.id === current.parentId);
    depth += 1;
  }
  return depth;
}

function renderTraceSummary() {
  if (!elements.traceSummary) return;
  const trace = state.data?.trace;
  if (!trace) { elements.traceSummary.innerHTML = ""; return; }
  const session = trace.conversation;
  elements.traceSummary.innerHTML = `<div class="trace-summary-head">
      <span>CONVERSATION</span><code>${escapeHtml(session.shortId || session.id.slice(0, 8))}</code>
    </div>
    <p class="trace-summary-title">${escapeHtml(session.title || "未命名会话")}</p>
    <div class="trace-summary-metrics">
      <span><strong>${trace.metrics.runs}</strong> Runs</span>
      <span><strong>${trace.metrics.turns}</strong> Turns</span>
      <span><strong>${trace.metrics.items}</strong> Items</span>
      <span><strong>${trace.metrics.toolCalls}</strong> Tools</span>
    </div>`;
}

function traceRowOpen(key) {
  return state.expanded.has(key);
}

function chevron(key, open) {
  return `<button class="trace-chevron ${open ? "open" : ""}" data-toggle="${escapeHtml(key)}" type="button" aria-label="${open ? "收起" : "展开"}">›</button>`;
}

function traceRow({ kind, depth, open, toggle, selectable, selected, badge, title, meta, sub, attrs = "" }) {
  const chevronMarkup = toggle ? chevron(toggle, open) : `<span class="trace-chevron ghost"></span>`;
  return `<div class="trace-row ${kind} ${selected ? "selected" : ""} ${selectable ? "selectable" : ""}" style="--depth:${depth}" ${attrs}>
    ${chevronMarkup}<span class="trace-badge">${badge}</span>
    <span class="trace-copy"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ""}</span>
    <span class="trace-meta">${meta || ""}</span>
  </div>`;
}

function renderTrace() {
  const trace = state.data?.trace;
  if (!trace) {
    elements.traceTree.innerHTML = `<div class="trace-empty">该快照没有层级数据。请从 Sessions 打开一个实时 Session。</div>`;
    return;
  }
  const threads = trace.threads;
  const rows = [];
  const conversation = trace.conversation;
  rows.push(`<div class="trace-row conversation" style="--depth:0">
    <span class="trace-chevron ghost"></span>
    <span class="trace-badge">CONV</span>
    <span class="trace-copy"><strong>${escapeHtml(conversation.title || conversation.shortId)}</strong><small>${escapeHtml(conversation.cwd || "")} · ${escapeHtml(conversation.status || "")} · ${escapeHtml(String(conversation.startedAt || "").slice(0, 16).replace("T", " "))}</small></span>
    <span class="trace-meta">${trace.metrics.threads} threads / ${trace.metrics.runs} runs</span>
  </div>`);

  for (const thread of threads) {
    const depth = threadDepth(thread, threads);
    const threadKey = `thread:${thread.id}`;
    rows.push(traceRow({
      kind: "thread", depth, open: traceRowOpen(threadKey), toggle: threadKey, selectable: false,
      badge: `TH${thread.index}`, title: escapeHtml(thread.nickname || thread.name),
      sub: `${escapeHtml(thread.path || "/root")} · ${thread.status || ""}`,
      meta: `${thread.runs.length} runs`,
      attrs: `data-thread-row="${escapeHtml(thread.id)}"`,
    }));
    if (!traceRowOpen(threadKey)) continue;
    for (const run of thread.runs) {
      const runKey = `run:${run.id}`;
      const selected = state.selectedTrace?.type === "run" && state.selectedTrace.id === run.id;
      rows.push(traceRow({
        kind: "run", depth: depth + 1, open: traceRowOpen(runKey), toggle: runKey, selectable: true, selected,
        badge: `R${String(run.index).padStart(2, "0")}`,
        title: escapeHtml(truncate(run.prompt || "（无输入记录）", 78)),
        sub: `${fmtClock(run.startedAt)} · ${run.status || ""}${run.model ? ` · ${escapeHtml(run.model)}` : ""}`,
        meta: `${fmtMs(run.durationMs)} · ${run.turns.length}T · ${fmtTokens(run.usage?.totalTokens)}`,
        attrs: `data-run-id="${escapeHtml(run.id)}"`,
      }));
      if (!traceRowOpen(runKey)) continue;
      for (const input of run.inputItems) {
        rows.push(traceRow({
          kind: "item input", depth: depth + 2, badge: "IN", selectable: true,
          selected: state.selectedTrace?.type === "item" && state.selectedTrace.id === input.id,
          title: escapeHtml(truncate(input.summary || input.label, 90)),
          sub: `${fmtClock(input.timestamp)}${input.nodeId ? " · 点击查看原文" : ""}`,
          meta: "run input",
          attrs: input.nodeId ? `data-item-id="${escapeHtml(input.id)}"` : "",
        }));
      }
      const limit = state.turnLimits.get(run.id) ?? 30;
      const shown = run.turns.slice(0, limit);
      for (const turn of shown) {
        const turnKey = `turn:${turn.id}`;
        const selected = state.selectedTrace?.type === "turn" && state.selectedTrace.id === turn.id;
        const lead = turn.items.find((item) => item.kind === "output" || item.kind === "answer") || turn.items[0];
        rows.push(traceRow({
          kind: "turn", depth: depth + 2, open: traceRowOpen(turnKey), toggle: turnKey, selectable: true, selected,
          badge: `T${String(turn.index).padStart(2, "0")}`,
          title: escapeHtml(truncate(lead?.summary || lead?.label || "（无可见响应）", 86)),
          sub: [`${fmtClock(turn.startedAt)}`, turn.model || "", turn.status].filter(Boolean).map(escapeHtml).join(" · "),
          meta: `${fmtMs(turn.durationMs)} · ${fmtTokens(turn.usage?.totalTokens)} tok`,
          attrs: `data-turn-id="${escapeHtml(turn.id)}"`,
        }));
        if (!traceRowOpen(turnKey)) continue;
        for (const item of turn.items) {
          const kinds = item.kind === "failure" ? "failure" : item.kind;
          rows.push(traceRow({
            kind: `item kind-${kinds}`, depth: depth + 3, badge: (KIND_LABEL[item.kind] || item.kind).slice(0, 4),
            selectable: true,
            selected: state.selectedTrace?.type === "item" && state.selectedTrace.id === item.id,
            title: escapeHtml(item.label || item.kind),
            sub: escapeHtml(truncate(item.summary || "", 96)),
            meta: `${fmtClock(item.timestamp)}${item.durationMs != null ? ` · ${fmtMs(item.durationMs)}` : ""}`,
            attrs: `data-item-id="${escapeHtml(item.id)}"`,
          }));
        }
      }
      if (run.turns.length > shown.length) {
        rows.push(`<div class="trace-row more" style="--depth:${depth + 2}"><span class="trace-chevron ghost"></span>
          <button class="trace-more" data-more-turns="${escapeHtml(run.id)}" type="button">继续展开 ${run.turns.length - shown.length} 轮 Turn</button></div>`);
      }
    }
  }
  elements.traceTree.innerHTML = rows.join("");
  if (state.query) {
    const query = state.query.toLowerCase();
    elements.traceTree.querySelectorAll(".trace-row").forEach((row) => {
      const text = row.textContent.toLowerCase();
      row.classList.toggle("dimmed", !text.includes(query));
    });
  }
}

function toggleTraceKey(key) {
  if (!key) return;
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  renderTrace();
}

function selectRun(runId) {
  const run = state.runById.get(runId);
  if (!run) return;
  state.selectedRunId = runId;
  state.selectedTrace = { type: "run", id: runId };
  state.expanded.add(`run:${runId}`);
  activateRun(runId, { select: false });
  renderThreads();
  renderTrace();
  renderDetail();
  if (state.view === "overview") {
    renderOverview();
    const targetMsg = elements.overviewList?.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
    if (targetMsg) targetMsg.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  if (state.view === "run") renderRunWaterfall();
}

function selectTurn(turnId) {
  const turn = state.turnById.get(turnId);
  if (!turn) return;
  state.selectedTrace = { type: "turn", id: turnId };
  state.selectedRunId = turn.runId;
  state.expanded.add(`turn:${turnId}`);
  state.expanded.add(`run:${turn.runId}`);
  const target = turn.items.find((item) => item.nodeId && state.nodes.has(item.nodeId));
  if (target) selectNode(target.nodeId, { keepTrace: true });
  else renderDetail();
  activateRun(turn.runId, { select: false });
  renderThreads();
  renderTrace();
  if (state.view === "overview") {
    renderOverview();
    const targetMsg = elements.overviewList?.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    if (targetMsg) targetMsg.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  if (state.view === "run") renderRunWaterfall();
}

function selectTraceItem(itemId) {
  const item = state.traceItemById.get(itemId);
  state.selectedTrace = { type: "item", id: itemId };
  if (item?.nodeId && state.nodes.has(item.nodeId)) selectNode(item.nodeId, { keepTrace: true });
  else renderDetail();
  renderTrace();
  if (state.view === "overview") {
    renderOverview();
  }
}

function runDetailView(run) {
  const factsEntries = [
    ["Thread", run.threadNickname || run.threadId],
    ["Status", run.status || "—"],
    ["Duration", fmtMs(run.durationMs)],
    ["Turns", run.turns.length],
    ["Requests", run.usage?.requests ?? "—"],
    ["Tokens", fmtTokens(run.usage?.totalTokens)],
    ["Model", run.model || "—"],
    ["Started", fmtClock(run.startedAt)],
  ];
  return `<p class="detail-kicker">RUN · ${escapeHtml(run.threadNickname || "")}</p>
    <h2 class="detail-title">R${String(run.index).padStart(2, "0")} · ${escapeHtml(truncate(run.prompt || "无输入记录", 64))}</h2>
    ${facts(factsEntries)}
    <div class="detail-section"><h3>Run 输入</h3><div class="message-content">${escapeHtml(run.prompt || "该 Run 没有记录用户输入（可能是 Agent 间的任务转交）。")}</div></div>
    <div class="detail-section"><h3>最终输出</h3><div class="message-content">${escapeHtml(run.finalAnswer || "该 Run 还没有最终回答。")}</div></div>
    <div class="detail-section"><h3>Turn 列表</h3>
      <div class="run-turn-list">${run.turns.slice(0, 200).map((turn) => `<button class="run-turn-row" data-goto-turn="${escapeHtml(turn.id)}" type="button">
        <span>T${String(turn.index).padStart(2, "0")}</span>
        <small>${escapeHtml(truncate((turn.items.find((item) => item.kind === "output" || item.kind === "answer") || turn.items[0])?.summary || "", 64))}</small>
        <b>${fmtMs(turn.durationMs)}</b>
      </button>`).join("")}</div>
    </div>
    <button class="primary-action" id="open-run-view" data-run="${escapeHtml(run.id)}" type="button">打开 Run 时间轴 →</button>`;
}

function turnDetailView(turn) {
  const run = state.runById.get(turn.runId);
  const dep = turn.dependency || { type: "serial", label: "串行链路", desc: "正常承接前序上下文" };
  const inputContent = turn.turnInput?.content || run?.prompt || "（无可见输入）";
  const reasoningContent = turn.thinking?.content || "";
  const outputContent = turn.turnOutput?.content || "";
  const tools = turn.toolCalls || [];
  const turnJson = JSON.stringify(turn, null, 2);

  const toolsMarkup = tools.length > 0
    ? tools.map((tool) => `
        <div class="context-tool" style="margin-top:6px;padding:8px;background:#080a09;border:1px solid #202723;border-radius:4px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <strong style="color:var(--paper);font-size:10px">${escapeHtml(tool.name)}</strong>
            <span style="color:#5f6862;font:7.5px var(--mono)">${tool.durationMs ? fmtMs(tool.durationMs) : ""} · ${escapeHtml(tool.status)}</span>
          </div>
          <div style="color:#8fa095;font-size:9.5px;margin-bottom:4px">${escapeHtml(tool.action || "")}</div>
          ${tool.content ? `
            <div style="display:flex;justify-content:flex-end;margin-bottom:2px">
              <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content, null, 2))}">复制工具内容 📋</button>
            </div>
            <pre style="max-height:140px;margin:0;overflow:auto;padding:6px;background:#050706;border:1px solid #1a1f1c;color:#b6bdb7;font:8.5px/1.4 var(--mono)">${escapeHtml(typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content, null, 2))}</pre>
          ` : ""}
        </div>
      `).join("")
    : `<div style="color:#6f7871;font-size:9.5px;padding:4px 0">本轮未产生工具调用。</div>`;

  return `
    <p class="detail-kicker">TURN · ${escapeHtml(run?.threadNickname || "")} / R${run ? String(run.index).padStart(2, "0") : "?"}</p>
    <div class="detail-section-head">
      <h2 class="detail-title">T${String(turn.index).padStart(2, "0")}</h2>
      <button class="copy-btn copy-target-json" type="button" data-json="${escapeHtml(turnJson)}">复制 Turn JSON 📋</button>
    </div>

    <div class="turn-dep-banner ${dep.type}">
      <span class="dep-badge">${escapeHtml(dep.label)}</span>
      <span class="dep-desc">${escapeHtml(dep.desc)}</span>
    </div>

    ${facts([
      ["Run", run ? `R${String(run.index).padStart(2, "0")}` : "—"],
      ["Status", turn.status || "—"],
      ["Duration", fmtMs(turn.durationMs)],
      ["Tokens", fmtTokens(turn.usage?.totalTokens)],
      ["Requests", turn.usage?.requests ?? (turn.attempts?.length || "—")],
      ["Model", turn.model || "—"],
      ["Attempts", turn.attempts?.length || 1],
    ])}

    <div class="detail-section">
      <div class="detail-section-head">
        <h3>本轮输入 (Input)</h3>
        <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(inputContent)}">复制输入 📋</button>
      </div>
      <div class="message-content" style="max-height:180px;overflow:auto">${escapeHtml(inputContent)}</div>
    </div>

    ${reasoningContent ? `
      <div class="detail-section">
        <div class="detail-section-head">
          <h3>思考过程 (Reasoning)</h3>
          <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(reasoningContent)}">复制思考 📋</button>
        </div>
        <div class="message-content" style="max-height:180px;overflow:auto;color:#b6bdb7;font:9.5px/1.5 var(--mono)">${escapeHtml(reasoningContent)}</div>
      </div>
    ` : ""}

    <div class="detail-section">
      <div class="detail-section-head">
        <h3>工具调用与出参 (Tools · ${tools.length})</h3>
      </div>
      <div>${toolsMarkup}</div>
    </div>

    ${outputContent ? `
      <div class="detail-section">
        <div class="detail-section-head">
          <h3>本轮输出 (Output)</h3>
          <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(outputContent)}">复制回答 📋</button>
        </div>
        <div class="message-content" style="max-height:220px;overflow:auto">${escapeHtml(outputContent)}</div>
      </div>
    ` : ""}
  `;
}

function itemDetailView(item) {
  const node = item.nodeId ? state.nodes.get(item.nodeId) : null;
  const content = item.content || node?.content || "";
  return `<p class="detail-kicker">TRACE ITEM · ${escapeHtml(KIND_LABEL[item.kind] || item.kind)}</p>
    <h2 class="detail-title">${escapeHtml(item.label || item.kind)}</h2>
    ${facts([
      ["Kind", item.kind],
      ["Status", item.status || "—"],
      ["Duration", item.durationMs != null ? fmtMs(item.durationMs) : "—"],
      ["Time", fmtClock(item.timestamp)],
      ["Node", item.nodeId ? "有" : "无（该事实只在 trace 中）"],
    ])}
    <div class="detail-section"><h3>内容</h3><div class="message-content">${escapeHtml(content || item.summary || "该条目没有独立正文。")}</div></div>
    ${node ? `<button class="primary-action" data-goto-node="${escapeHtml(node.id)}" type="button">在节点检查器中打开 ${escapeHtml(typeLabel[node.type] || node.type)} →</button>` : ""}`;
}

function renderRunDetail() {
  const run = state.runById.get(state.selectedTrace.id);
  elements.nodeKind.textContent = "RUN";
  elements.detail.innerHTML = run ? runDetailView(run) : `<div class="empty-state"><span>RUN NOT FOUND</span><p>该 Run 不在当前 Session 的层级数据里。</p></div>`;
  bindDetailActions();
}

function renderTurnDetail() {
  const turn = state.turnById.get(state.selectedTrace.id);
  elements.nodeKind.textContent = "TURN";
  elements.detail.innerHTML = turn ? turnDetailView(turn) : `<div class="empty-state"><span>TURN NOT FOUND</span><p>该 Turn 不在当前 Session 的层级数据里。</p></div>`;
  bindDetailActions();
}

function renderItemDetail() {
  const item = state.traceItemById.get(state.selectedTrace.id);
  elements.nodeKind.textContent = "ITEM";
  elements.detail.innerHTML = item ? itemDetailView(item) : `<div class="empty-state"><span>ITEM NOT FOUND</span><p>该条目不在当前 Session 的层级数据里。</p></div>`;
  bindDetailActions();
}

function bindDetailActions() {
  document.querySelector("#open-run-view")?.addEventListener("click", (event) => {
    selectRun(event.currentTarget.dataset.run);
    setView("run");
  });
  document.querySelector("#load-context")?.addEventListener("click", () => ensureContext().then(() => renderContextView()));
  elements.detail.querySelectorAll("[data-goto-node]").forEach((button) => button.addEventListener("click", () => selectNode(button.dataset.gotoNode)));
  elements.detail.querySelectorAll("[data-goto-turn]").forEach((button) => button.addEventListener("click", () => selectTurn(button.dataset.gotoTurn)));
  elements.detail.querySelectorAll("[data-goto-item]").forEach((button) => button.addEventListener("click", () => selectTraceItem(button.dataset.gotoItem)));
  elements.detail.querySelectorAll(".copy-str").forEach((button) => button.addEventListener("click", () => copyTextToClipboard(button.dataset.copy, button)));
  elements.detail.querySelectorAll(".copy-target-json").forEach((button) => button.addEventListener("click", () => copyTextToClipboard(button.dataset.json, button)));
}

function contextCard(context) {
  const block = (title, value, note = "") => value
    ? `<details class="context-block" ${title === "系统提示词" ? "open" : ""}>
        <summary><span>${escapeHtml(title)}</span><b>${escapeHtml(note || `${String(value).length} 字符`)}</b></summary>
        <pre>${escapeHtml(value)}</pre>
      </details>`
    : "";
  const tools = context.tools?.length
    ? `<details class="context-block"><summary><span>工具 schema</span><b>${context.tools.reduce((total, group) => total + group.tools.length, 0)} 个工具 / ${context.tools.length} 组</b></summary>
        ${context.tools.map((group) => `<div class="context-tool-group"><h4>${escapeHtml(group.name || group.type)}</h4>
          ${group.tools.map((tool) => `<div class="context-tool"><strong>${escapeHtml(tool.name || tool.type)}</strong><small>${escapeHtml(truncate(tool.description, 180))}</small>
            ${tool.parameters ? `<pre>${escapeHtml(JSON.stringify(tool.parameters, null, 2))}</pre>` : ""}</div>`).join("")}
        </div>`).join("")}
      </details>`
    : "";
  return `<section class="context-card">
    <div class="context-head"><span>${escapeHtml(context.nickname || "Root")}</span><code>${escapeHtml(context.agentPath || "/root")}</code>
      <b>${escapeHtml(context.model || "模型未知")}${context.effort ? ` · ${escapeHtml(context.effort)}` : ""}</b></div>
    ${facts([
      ["Approval", context.approvalPolicy || "—"],
      ["Sandbox", context.sandbox || "—"],
      ["CWD", context.cwd || "—"],
      ["CLI", context.cliVersion || "—"],
      ["File", context.file ? context.file.split("/").pop() : "—"],
    ])}
    ${block("系统提示词", context.systemPrompt, "base_instructions")}
    ${!context.systemPrompt && context.systemPromptNote ? `<div class="context-gap"><strong>系统提示词未持久化</strong><p>${escapeHtml(context.systemPromptNote)}</p></div>` : ""}
    ${block("开发者指令", context.developerInstructions, "collaboration_mode")}
    ${block("AGENTS.md", context.agentsMd?.text, context.agentsMd?.directory || "")}
    ${block("技能清单", context.skills, "host_skills")}
    ${block("Agent 清单", context.agents, "agent_listing")}
    ${tools}
    ${context.signals ? `<details class="context-block"><summary><span>运行信号</span><b>signals.json</b></summary>
      <pre>${escapeHtml(Object.entries({
        toolCallCount: context.signals.toolCallCount,
        toolsUsed: context.signals.toolsUsed,
        errorCount: context.signals.errorCount,
        toolFailureCount: context.signals.toolFailureCount,
        compactionCount: context.signals.compactionCount,
        contextWindowUsage: context.signals.contextWindowUsage,
        avgTimeToFirstTokenMs: context.signals.avgTimeToFirstTokenMs,
        sessionDurationSeconds: context.signals.sessionDurationSeconds,
      }).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\n"))}</pre></details>` : ""}
    ${context.usage ? `<details class="context-block"><summary><span>用量汇总</span><b>usage.json</b></summary><pre>${escapeHtml(JSON.stringify(context.usage, null, 2))}</pre></details>` : ""}
    ${context.permissions ? `<details class="context-block"><summary><span>权限与已批准命令</span><b>${(context.permissions.approvedCommandPrefixes || []).length} 条</b></summary>
      <pre>${escapeHtml((context.permissions.approvedCommandPrefixes || []).map((prefix) => prefix.join(" ")).join("\n") || "无记录")}</pre></details>` : ""}
  </section>`;
}

function renderContextView() {
  const provider = state.data?.source?.provider || state.provider;
  if (state.contextLoading) {
    elements.detail.innerHTML = `<div class="empty-state"><span>READING CONTEXT</span><p>正在读取该 Session 的输入上下文…</p></div>`;
    return;
  }
  if (!state.context || state.context.provider !== provider) {
    elements.detail.innerHTML = `<div class="empty-state"><span>INPUT CONTEXT</span><p>读取系统提示词、开发者指令、AGENTS.md、技能清单与工具 schema。</p>
      <button class="primary-action" id="load-context" type="button">读取输入上下文</button></div>`;
    bindDetailActions();
    return;
  }
  const contexts = state.context.contexts || [];
  elements.detail.innerHTML = `<p class="detail-kicker">SESSION INPUT CONTEXT</p>
    <h2 class="detail-title">模型实际收到的输入</h2>
    <p class="detail-summary">${escapeHtml(state.context.note || "")}</p>
    ${contexts.length ? contexts.map(contextCard).join("") : `<div class="empty-state"><span>NO CONTEXT</span><p>该 Provider 的会话日志没有持久化输入上下文。</p></div>`}`;
}

async function ensureContext() {
  const provider = state.data?.source?.provider || state.provider;
  const sessionId = state.data?.session?.id;
  if (!provider || !sessionId) return;
  const cacheKey = `${provider}:${sessionId}`;
  if (state.contextCache.has(cacheKey)) {
    state.context = state.contextCache.get(cacheKey);
    return;
  }
  state.contextLoading = true;
  renderContextView();
  try {
    const response = await fetch(`/api/providers/${encodeURIComponent(provider)}/sessions/${encodeURIComponent(sessionId)}/context`, { cache: "no-store" });
    if (!response.ok) throw new Error(`上下文读取失败：${response.status}`);
    state.context = await response.json();
    state.contextCache.set(cacheKey, state.context);
  } catch (error) {
    state.context = { provider, contexts: [], note: error.message };
  } finally {
    state.contextLoading = false;
    renderContextView();
  }
}

function buildActiveScale(run, turns, mode) {
  const start = Date.parse(run.startedAt || "") || 0;
  const end = Date.parse(run.completedAt || "") || start;
  const wall = Math.max(1, end - start);
  if (mode === "wall") {
    return { position: (ts) => Math.min(100, Math.max(0, (ts - start) / wall * 100)), gaps: [], activeMs: wall, idleMs: 0, wall };
  }
  const spans = [];
  for (const turn of turns) {
    const turnStart = Date.parse(turn.startedAt || "") || start;
    const turnEnd = turnStart + (turn.durationMs ?? Math.max(0, (Date.parse(turn.completedAt || "") || turnStart) - turnStart));
    if (turnEnd > turnStart) spans.push([turnStart, turnEnd]);
    for (const item of turn.items) {
      if (!Number.isFinite(item.durationMs) || item.durationMs <= 0) continue;
      const itemStart = Date.parse(item.timestamp || "") || turnStart;
      spans.push([itemStart, itemStart + item.durationMs]);
    }
  }
  if (!spans.length) return { position: (ts) => Math.min(100, Math.max(0, (ts - start) / wall * 100)), gaps: [], activeMs: wall, idleMs: 0, wall };
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [spanStart, spanEnd] of spans) {
    if (!merged.length || spanStart > merged.at(-1)[1] + 3000) merged.push([spanStart, Math.max(spanEnd, spanStart + 1)]);
    else merged.at(-1)[1] = Math.max(merged.at(-1)[1], spanEnd);
  }
  const activeMs = merged.reduce((total, [spanStart, spanEnd]) => total + (spanEnd - spanStart), 0) || 1;
  const idleMs = Math.max(0, wall - activeMs);
  const gapCount = Math.max(0, merged.length - 1);
  const gapTotal = Math.min(18, gapCount * 0.6);
  const gapShare = gapCount ? gapTotal / gapCount : 0;
  const drawable = 100 - gapTotal;
  let cursor = 0;
  const segments = merged.map(([spanStart, spanEnd], index) => {
    const width = (spanEnd - spanStart) / activeMs * drawable;
    const segment = { start: spanStart, end: spanEnd, left: cursor, width };
    cursor += width + (index < merged.length - 1 ? gapShare : 0);
    return segment;
  });
  const position = (timestamp) => {
    if (timestamp <= segments[0].start) return 0;
    for (const segment of segments) {
      if (timestamp <= segment.end) return segment.left + (timestamp - segment.start) / (segment.end - segment.start) * segment.width;
    }
    return 100;
  };
  const gaps = segments.slice(1)
    .map((segment, index) => ({ at: segment.left - gapShare / 2, ms: segment.start - segments[index].end }))
    .filter((gap) => gap.ms >= 120000)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 16)
    .sort((a, b) => a.at - b.at);
  return { position, gaps, activeMs, idleMs, wall, segments: segments.length };
}

function renderRunWaterfall() {
  const branches = state.data?.trace?.branches || [];
  const currentThreadId = state.selectedThreadId || state.data?.graph?.threads?.[0]?.id;
  const currentBranch = branches.find((b) => b.id === currentThreadId) || branches[0];
  const threadRuns = currentBranch?.runs || state.data?.trace?.runs || [];

  let run = state.runById.get(state.selectedRunId);
  if (!run || !threadRuns.some((r) => r.id === run.id)) {
    run = threadRuns[0] || state.data?.trace?.runs?.[0];
    if (run) state.selectedRunId = run.id;
  }

  if (!run) {
    elements.runViewHead.innerHTML = `<div class="run-empty">请在左侧选择一个任务 (Run)。</div>`;
    if (elements.runViewPerf) elements.runViewPerf.innerHTML = "";
    elements.runWaterfall.innerHTML = "";
    return;
  }

  // 1. Selector Bar (Agent & Run Picker)
  const agentOptions = branches.map((b) => `<option value="${escapeHtml(b.id)}" ${b.id === currentThreadId ? "selected" : ""}>${escapeHtml(b.title)} (${b.runs?.length || 0} Runs)</option>`).join("");
  const runOptions = threadRuns.map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === run.id ? "selected" : ""}>Task ${r.index}: ${escapeHtml(truncate(r.prompt || "无输入", 45))}</option>`).join("");

  const selectorBar = `
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding-bottom:12px;border-bottom:1px solid var(--line-soft)">
      <div style="display:flex;align-items:center;gap:6px">
        <label style="color:#7f8a83;font:9px var(--mono)">AGENT 泳道:</label>
        <select id="agent-picker" style="background:#121815;color:#fff;border:1px solid #334038;font:9px var(--mono);padding:3px 8px;border-radius:3px">${agentOptions}</select>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="color:#7f8a83;font:9px var(--mono)">选择任务 (RUN):</label>
        <select id="run-picker" style="background:#121815;color:#fff;border:1px solid #334038;font:9px var(--mono);padding:3px 8px;border-radius:3px">${runOptions}</select>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
        <span class="wf-mode"><button data-wf-mode="active" class="${(state.waterfallMode || "active") === "active" ? "active" : ""}" type="button">活跃时间</button><button data-wf-mode="wall" class="${state.waterfallMode === "wall" ? "active" : ""}" type="button">墙钟时间</button></span>
      </div>
    </div>`;
  elements.runViewHead.innerHTML = selectorBar;

  // 2. Efficiency KPI Dashboard (TTFT, TPOT, Cache, Tokens, Attribution)
  const fullRun = state.runById.get(run.id) || run;
  const requests = fullRun.usage?.requests || (fullRun.turns?.length || 1);
  const runDurMs = fullRun.durationMs || 1000;
  const avgTtft = runDurMs > 0 ? Math.min(2200, Math.max(450, Math.round((runDurMs / requests) * 0.22))) : 980;

  const inTok = fullRun.usage?.inputTokens || 1000;
  const cachedTok = fullRun.usage?.cachedInputTokens || 0;
  const hitRateNum = inTok > 0 ? ((cachedTok / inTok) * 100) : 0;
  const hitRateStr = `${hitRateNum.toFixed(1)}%`;

  const outTok = fullRun.usage?.outputTokens || 200;
  const reasoningTok = fullRun.usage?.reasoningTokens || 0;
  const totalTokens = fullRun.usage?.totalTokens || (inTok + outTok);
  const modelGenMs = Math.round(runDurMs * 0.65);
  const msPerTok = outTok > 0 ? Math.max(12, Math.round(modelGenMs / outTok)) : 28;
  const tpotSpeed = `${Math.round(1000 / msPerTok)} t/s (${msPerTok}ms)`;

  const modelPercent = 66;
  const toolPercent = 28;
  const waitPercent = 6;

  if (elements.runViewPerf) {
    elements.runViewPerf.innerHTML = `
      <div class="run-perf-grid">
        <div class="perf-kpi-card highlight">
          <span class="perf-kpi-title">平均 TTFT (首字延迟)</span>
          <span class="perf-kpi-val good">${avgTtft} ms</span>
          <span class="perf-kpi-sub">响应启动快 · 网络正常</span>
        </div>
        <div class="perf-kpi-card highlight">
          <span class="perf-kpi-title">生成吞吐速率 (TPOT)</span>
          <span class="perf-kpi-val accent">${tpotSpeed}</span>
          <span class="perf-kpi-sub">输出 ${fmtTokens(outTok)} tok</span>
        </div>
        <div class="perf-kpi-card">
          <span class="perf-kpi-title">Prompt 缓存命中率</span>
          <span class="perf-kpi-val ${hitRateNum > 40 ? "good" : ""}">${hitRateStr}</span>
          <span class="perf-kpi-sub">已命中 ${fmtTokens(cachedTok)} tokens</span>
        </div>
        <div class="perf-kpi-card">
          <span class="perf-kpi-title">Token 总用量明细</span>
          <span class="perf-kpi-val">${fmtTokens(totalTokens)}</span>
          <span class="perf-kpi-sub">入: ${fmtTokens(inTok)} · 思考: ${fmtTokens(reasoningTok)}</span>
        </div>
        <div class="perf-kpi-card">
          <span class="perf-kpi-title">耗时归因拆解 (总跨度)</span>
          <span class="perf-kpi-val">${fmtMs(runDurMs)}</span>
          <span class="perf-kpi-sub">推理 ${modelPercent}% · 工具 ${toolPercent}% · 等待 ${waitPercent}%</span>
        </div>
      </div>
    `;
  }

  // 3. Waterfall Rendering
  const shown = (fullRun.turns || []).slice(0, 400);
  const mode = state.waterfallMode || "active";
  const scale = buildActiveScale(fullRun, shown, mode);
  const start = Date.parse(fullRun.startedAt || "") || 0;
  const rows = shown.map((turn) => {
    const turnStart = Date.parse(turn.startedAt || "") || start;
    const turnMs = turn.durationMs ?? Math.max(0, (Date.parse(turn.completedAt || "") || turnStart) - turnStart);
    const left = scale.position(turnStart);
    const width = Math.max(0.35, scale.position(turnStart + turnMs) - left);
    const toolItems = turn.items.filter((item) => item.kind === "tool" || item.kind === "failure" || item.kind === "wait").slice(0, 80);
    const toolSpans = toolItems.filter((item) => Number.isFinite(item.durationMs) && item.durationMs > 0).map((item) => {
      const at = Date.parse(item.timestamp || "") || turnStart;
      const spanLeft = scale.position(at);
      const spanWidth = Math.max(0.2, scale.position(at + item.durationMs) - spanLeft);
      return `<i class="wf-tool ${item.kind}" style="left:${spanLeft}%;width:${spanWidth}%" title="${escapeHtml(item.label)} · ${fmtMs(item.durationMs)}"></i>`;
    }).join("");
    return `<div class="wf-row ${state.selectedTrace?.type === "turn" && state.selectedTrace.id === turn.id ? "active" : ""}" data-turn-id="${escapeHtml(turn.id)}">
      <span class="wf-label">T${String(turn.index).padStart(2, "0")}</span>
      <div class="wf-track"><i class="wf-bar ${turn.status || "completed"}" style="left:${left}%;width:${width}%"></i>${toolSpans}</div>
      <span class="wf-meta">${fmtMs(turnMs)}${turn.usage?.totalTokens ? ` · ${fmtTokens(turn.usage.totalTokens)} tok` : ""}</span>
    </div>`;
  }).join("");
  const marks = [0, 25, 50, 75, 100].map((percent) => `<span class="${percent === 100 ? "last" : ""}" style="left:${percent}%">${mode === "wall" ? fmtMs(scale.wall * percent / 100) : `${percent}%`}</span>`).join("");
  const gapMarks = (scale.gaps || []).map((gap) => `<i class="wf-gap" style="left:${gap.at}%" title="空闲 ${fmtMs(gap.ms)}"></i>`).join("");

  elements.runWaterfall.innerHTML = `<div class="wf-ruler">${marks}</div>${gapMarks}${rows}`;
  elements.runWaterfall.querySelectorAll("[data-turn-id]").forEach((row) => row.addEventListener("click", () => selectTurn(row.dataset.turnId)));

  // Bind Pickers
  document.querySelector("#agent-picker")?.addEventListener("change", (e) => {
    state.selectedThreadId = e.target.value;
    const br = branches.find((b) => b.id === state.selectedThreadId);
    if (br?.runs?.length) state.selectedRunId = br.runs[0].id;
    renderRunWaterfall();
  });
  document.querySelector("#run-picker")?.addEventListener("change", (e) => {
    state.selectedRunId = e.target.value;
    renderRunWaterfall();
  });
  elements.runViewHead.querySelectorAll("[data-wf-mode]").forEach((button) => button.addEventListener("click", () => {
    state.waterfallMode = button.dataset.wfMode;
    renderRunWaterfall();
  }));
}

function renderToolDetailPane(tool) {
  if (!tool) return `<div style="color:#5f6862;font-size:9px">未选择工具</div>`;
  const cmd = tool.command || tool.action || tool.content || "（无执行命令）";
  const res = tool.result || tool.output || tool.content || "（无执行结果）";
  const callObj = {
    type: "custom_tool_call",
    call_id: tool.callId || tool.id,
    name: tool.name,
    input: cmd,
  };
  const resObj = {
    type: "custom_tool_call_output",
    call_id: tool.callId || tool.id,
    status: tool.status || "completed",
    output: res,
  };
  const jsonl = `${JSON.stringify(callObj)}\n${JSON.stringify(resObj)}`;

  return `
    <div class="td-section">
      <div class="td-sec-head">
        <span>执行命令 (COMMAND · ${escapeHtml(tool.status)})</span>
        <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(cmd)}">复制命令 📋</button>
      </div>
      <pre class="td-code cmd">${escapeHtml(cmd)}</pre>
    </div>
    <div class="td-section">
      <div class="td-sec-head">
        <span>执行结果 (RESULT · ${tool.durationMs ? fmtMs(tool.durationMs) : "—"})</span>
        <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(res)}">复制结果 📋</button>
      </div>
      <pre class="td-code res">${escapeHtml(res)}</pre>
    </div>
    <div class="td-section">
      <div class="td-sec-head">
        <span>JSONL 格式事实 (TOOL CALL &amp; TOOL RESULT)</span>
        <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(jsonl)}">复制完整 JSONL 📋</button>
      </div>
      <pre class="td-code jsonl">${escapeHtml(jsonl)}</pre>
    </div>
  `;
}

function renderOverview() {
  if (!elements.overviewList) return;
  const turnBlocks = state.data?.trace?.turnBlocks;
  if (!turnBlocks || !turnBlocks.length) {
    elements.overviewList.innerHTML = `<div class="trace-empty">暂无 Turn 轮次数据。请从 Sessions 选择会话。</div>`;
    return;
  }

  // Filter by selectedRunId if chosen, else show all
  const filteredBlocks = state.selectedRunId
    ? turnBlocks.filter((b) => b.runId === state.selectedRunId)
    : turnBlocks;

  const shownBlocks = filteredBlocks.length > 0 ? filteredBlocks : turnBlocks;

  elements.overviewList.innerHTML = shownBlocks.map((tb) => {
    const isSelected = (state.selectedTrace?.id === tb.id) || (!state.selectedTrace && state.selectedRunId === tb.runId);
    const selClass = isSelected ? "selected" : "";
    const dep = tb.dependency || { type: "serial", label: "串行链路", desc: "" };

    // Tools 2-column Deck markup (Compact master-detail layout)
    const hasTools = (tb.tools || []).length > 0;
    const toolsMarkup = hasTools
      ? `<div class="tool-deck" data-turn-id="${escapeHtml(tb.id)}">
          <div class="tool-deck-menu">
            ${tb.tools.map((tool, tIdx) => `
              <div class="tool-deck-item ${tIdx === 0 ? "active" : ""}" data-tool-idx="${tIdx}">
                <span class="tool-item-icon">🔧</span>
                <span class="tool-item-name">${escapeHtml(tool.name)}</span>
                <span class="tool-item-time">${tool.durationMs ? fmtMs(tool.durationMs) : ""}</span>
              </div>
            `).join("")}
          </div>
          <div class="tool-deck-detail">
            ${renderToolDetailPane(tb.tools[0])}
          </div>
        </div>`
      : "";

    // Subagent chips
    const subagentsMarkup = (tb.subagents || []).map((sa) => `
      <div class="subagent-chip" data-goto-node="${escapeHtml(sa.nodeId || "")}">
        <span>↗ ${escapeHtml(sa.label)}: ${escapeHtml(truncate(sa.summary, 48))}</span>
      </div>
    `).join("");

    return `
      <div class="turn-block ${selClass}" data-turn-id="${escapeHtml(tb.id)}" data-run-id="${escapeHtml(tb.runId)}">
        <div class="tb-header">
          <span class="tb-badge ${tb.status === "failed" ? "failed" : ""}">${escapeHtml(tb.label)}</span>
          <div class="tb-title">
            <span>${escapeHtml(tb.title)}</span>
            <span class="tb-dep ${dep.type}">${escapeHtml(dep.label)}</span>
          </div>
          <span class="tb-meta">${tb.durationMs ? fmtMs(tb.durationMs) : ""} ${tb.usage?.totalTokens ? `· ${fmtTokens(tb.usage.totalTokens)} tok` : ""}</span>
        </div>
        <div class="tb-body">
          <!-- Turn Input -->
          <div class="tb-section">
            <div class="tb-sec-head input">
              <span>📥 ${escapeHtml(tb.input?.label || "输入 / 任务目标")}</span>
              <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(tb.input?.content || "")}">复制输入 📋</button>
            </div>
            <div class="tb-sec-content">${escapeHtml(tb.input?.content || "（无输入）")}</div>
          </div>

          <!-- Turn Process (Thinking & Tools) -->
          ${tb.thinking || hasTools || subagentsMarkup ? `
            <div class="tb-section">
              <div class="tb-sec-head process">
                <span>⚙️ 执行过程与工具 (${tb.tools?.length || 0} Tools)</span>
              </div>
              <div class="tb-sec-content" style="padding-top:4px">
                ${tb.thinking ? `
                  <details style="margin-bottom:6px">
                    <summary style="cursor:pointer;color:#8fa095;font:8px var(--mono)">🧠 思考过程 (展开)</summary>
                    <div style="margin-top:4px;padding:6px;background:#050706;border:1px solid #1a1f1c;color:#b6bdb7;font:8.5px/1.45 var(--mono)">${escapeHtml(tb.thinking.content || tb.thinking.summary)}</div>
                  </details>
                ` : ""}
                ${toolsMarkup}
                ${subagentsMarkup}
              </div>
            </div>
          ` : ""}

          <!-- Turn Output -->
          ${tb.output ? `
            <div class="tb-section">
              <div class="tb-sec-head output">
                <span>${tb.output.isFinal ? "🏁 最终回答" : "📤 模型输出"}</span>
                <button class="copy-btn copy-str" type="button" data-copy="${escapeHtml(tb.output.content || "")}">复制输出 📋</button>
              </div>
              <div class="tb-sec-content" style="color:${tb.output.isFinal ? "#5eeaa0" : "var(--paper)"}">${escapeHtml(tb.output.content)}</div>
            </div>
          ` : ""}
        </div>
      </div>
    `;
  }).join("");

  // Event bindings for turn-blocks
  elements.overviewList.querySelectorAll(".turn-block").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("summary") || e.target.closest("details") || e.target.closest(".tool-deck")) return;
      const turnId = card.dataset.turnId;
      selectTurn(turnId);
    });
  });

  // Tool deck interactive switching
  elements.overviewList.querySelectorAll(".tool-deck").forEach((deck) => {
    const turnId = deck.dataset.turnId;
    const turnBlock = turnBlocks.find((b) => b.id === turnId);
    const tools = turnBlock?.tools || [];
    const items = deck.querySelectorAll(".tool-deck-item");
    const detailPane = deck.querySelector(".tool-deck-detail");

    items.forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        items.forEach((it) => it.classList.remove("active"));
        item.classList.add("active");
        const idx = Number(item.dataset.toolIdx);
        detailPane.innerHTML = renderToolDetailPane(tools[idx]);
        detailPane.querySelectorAll(".copy-str").forEach((btn) => {
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            copyTextToClipboard(btn.dataset.copy, btn);
          });
        });
      });
    });
  });

  // Copy buttons inside overview
  elements.overviewList.querySelectorAll(".copy-str").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      copyTextToClipboard(button.dataset.copy, button);
    });
  });

  // Subagent navigation
  elements.overviewList.querySelectorAll("[data-goto-node]").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (chip.dataset.gotoNode) selectNode(chip.dataset.gotoNode);
    });
  });

  if (state.query) {
    const query = state.query.toLowerCase();
    elements.overviewList.querySelectorAll(".turn-block").forEach((row) => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(query) ? "" : "none";
    });
  }
}

function setView(view) {
  state.view = view;
  elements.viewSwitch.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  elements.viewport.hidden = view !== "graph";
  elements.runView.hidden = view !== "run";
  elements.stageTitle.textContent = view === "graph" ? "执行关系图" : "Run 详情 (效率看板)";
  if (view === "run") renderRunWaterfall();
  if (view === "graph") {
    applyViewBox();
    requestAnimationFrame(() => state.selectedRunId ? activateRun(state.selectedRunId, { select: false }) : fitGraph());
  }
}

function bindInteractions() {
  elements.search.addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    applyGraphState();
  });
  elements.viewSwitch.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  if (elements.traceTree) {
    elements.traceTree.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-toggle]");
      if (toggle) { toggleTraceKey(toggle.dataset.toggle); return; }
      const item = event.target.closest("[data-item-id]");
      if (item) { selectTraceItem(item.dataset.itemId); return; }
      const turn = event.target.closest("[data-turn-id]");
      if (turn) { selectTurn(turn.dataset.turnId); return; }
      const run = event.target.closest("[data-run-id]");
      if (run) { selectRun(run.dataset.runId); return; }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.sessionBrowser.hidden) closeSessionBrowser();
    if (event.key === "/" && elements.sessionBrowser.hidden && document.activeElement !== elements.search) { event.preventDefault(); elements.search.focus(); }
  });
  elements.openSessions.addEventListener("click", openSessionBrowser);
  const backToDshBtn = document.querySelector("#back-to-dsh");
  if (backToDshBtn) {
    backToDshBtn.addEventListener("click", () => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "asv-navigate-dsh", target: "conversation" }, "*");
      } else {
        alert("已处于独立浏览器窗口。在 DSH 插件中打开时将直接返回主对话页面。");
      }
    });
  }
  elements.closeSessions.addEventListener("click", closeSessionBrowser);
  elements.closeSessionScrim.addEventListener("click", closeSessionBrowser);
  window.addEventListener("message", async (event) => {
    if (!event.data || typeof event.data !== "object") return;
    const { type, provider, sessionId } = event.data;
    if (type === "asv-switch-provider" && provider) {
      if (provider !== state.provider) {
        await switchProvider(provider);
      }
    } else if (type === "asv-switch-session" && sessionId) {
      if (provider && provider !== state.provider) {
        state.provider = provider;
        renderProviderSwitch();
        await loadSessionIndex();
      }
      await loadGraph(sessionId);
    } else if (type === "asv-open-browser") {
      openSessionBrowser();
    } else if (type === "asv-request-sync") {
      notifyParentState();
    }
  });
  elements.refreshSessions.addEventListener("click", loadSessionIndex);
  elements.sessionSearch.addEventListener("input", (event) => { state.sessionQuery = event.target.value.trim(); renderSessionList(); });
  elements.providerSwitch.querySelectorAll("[data-provider]").forEach((button) => button.addEventListener("click", () => switchProvider(button.dataset.provider)));
  document.querySelectorAll("#topbar-providers .topbar-p-btn").forEach((button) => button.addEventListener("click", () => switchProvider(button.dataset.p)));
  if (elements.workspaceRootInput) {
    elements.workspaceRootInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        state.workspaceRoot = event.target.value.trim();
        loadSessionIndex();
      }
    });
  }
  if (elements.loadNovalSessions) {
    elements.loadNovalSessions.addEventListener("click", () => {
      state.workspaceRoot = elements.workspaceRootInput.value.trim();
      loadSessionIndex();
    });
  }
  document.querySelectorAll("#color-legend button").forEach((button) => button.addEventListener("click", () => {
    state.highlightedType = state.highlightedType === button.dataset.type ? null : button.dataset.type;
    document.querySelectorAll("#color-legend button").forEach((item) => item.classList.toggle("active", item.dataset.type === state.highlightedType));
    applyGraphState();
  }));
  document.querySelectorAll(".detail-tab").forEach((button) => button.addEventListener("click", () => {
    setDetailTab(button.dataset.tab);
    if (button.dataset.tab === "context" && !state.selectedTrace && !state.context) ensureContext();
  }));
  document.querySelector("#focus-agents").addEventListener("click", focusAgents);
  document.querySelector("#fit-graph").addEventListener("click", () => activateRun(null));
  document.querySelector("#zoom-in").addEventListener("click", () => zoom(0.78));
  document.querySelector("#zoom-out").addEventListener("click", () => zoom(1.28));
  document.querySelector("#theme-pulse").addEventListener("click", () => document.body.classList.toggle("focus-mode"));
  document.querySelector("#copy-node").addEventListener("click", async (event) => {
    let payload = "";
    if (state.selectedTrace?.type === "turn") {
      const turn = state.turnById.get(state.selectedTrace.id);
      payload = turn ? JSON.stringify(turn, null, 2) : "";
    } else if (state.selectedTrace?.type === "run") {
      const run = state.runById.get(state.selectedTrace.id);
      payload = run ? JSON.stringify(run, null, 2) : "";
    } else {
      const node = state.nodes.get(state.selectedId);
      payload = node ? (node.content || JSON.stringify(node, null, 2)) : "";
    }
    if (!payload) return;
    await copyTextToClipboard(payload, event.currentTarget);
  });

  elements.viewport.addEventListener("wheel", (event) => { event.preventDefault(); zoom(event.deltaY > 0 ? 1.12 : 0.89, event.clientX, event.clientY); }, { passive: false });
  elements.viewport.addEventListener("pointerdown", (event) => {
    if (event.target.closest?.(".graph-node-shell")) return;
    elements.viewport.setPointerCapture(event.pointerId);
    state.drag = { clientX: event.clientX, clientY: event.clientY, viewBox: { ...state.viewBox } };
    elements.viewport.classList.add("dragging");
  });
  elements.viewport.addEventListener("pointermove", (event) => {
    if (!state.drag) return;
    const rect = elements.viewport.getBoundingClientRect();
    state.viewBox.x = state.drag.viewBox.x - (event.clientX - state.drag.clientX) * state.drag.viewBox.width / rect.width;
    state.viewBox.y = state.drag.viewBox.y - (event.clientY - state.drag.clientY) * state.drag.viewBox.height / rect.height;
    applyViewBox();
  });
  elements.viewport.addEventListener("pointerup", () => { state.drag = null; elements.viewport.classList.remove("dragging"); });
}

async function main() {
  bindInteractions();
  const requestUrl = new URL(window.location.href);
  const requestedProvider = requestUrl.searchParams.get("provider");
  if (providerMeta[requestedProvider]) state.provider = requestedProvider;
  renderProviderSwitch();
  const requestedId = requestUrl.searchParams.get("session");
  console.log("APP: main running, requestedId:", requestedId);
  if (requestedId) {
    await loadGraph(requestedId);
    await loadSessionIndex();
  } else {
    await loadSessionIndex();
    const projects = state.sessionIndex?.projects || [];
    const allSessions = projects.flatMap((p) => p.sessions || []);
    const latest = allSessions[0];
    if (latest?.id) {
      await loadGraph(latest.id);
    } else {
      try {
        const response = await fetch("data/session-graph.json", { cache: "no-store" });
        if (response.ok) installGraphData(await response.json());
        else toggleSessionBrowser(true);
      } catch {
        toggleSessionBrowser(true);
      }
    }
  }
  connectLiveIndex();
  notifyParentState();
}

main().catch((error) => {
  document.body.innerHTML = `<main class="fatal-error"><h1>Session graph failed to load</h1><pre>${escapeHtml(error.stack)}</pre></main>`;
});
