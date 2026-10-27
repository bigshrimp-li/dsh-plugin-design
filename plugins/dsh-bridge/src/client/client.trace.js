/** Conversation facts use frozen server cursors; a refresh replaces one complete watermarked view. */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge", chunk: "client.trace.js",
  factory() {
    const TRACE_CSS = `
.sa-trace{display:flex;flex-direction:column;gap:12px;padding:16px;min-width:0}
.sa-trace-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.sa-trace-toolbar input{flex:1 1 220px;min-width:0}
.sa-trace-toolbar select{max-width:220px}
.sa-trace-meta{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.sa-trace-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,356px);gap:14px;align-items:start;min-width:0}
.sa-trace-runs{display:flex;flex-direction:column;gap:10px;min-width:0}
.sa-trace-run,.sa-trace-turn,.sa-trace-detail{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);min-width:0}
.sa-trace-run{padding:10px}
.sa-trace-turn{margin:8px 0 0 12px;padding:8px}
.sa-trace-row{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;min-width:0}
.sa-trace-row strong{overflow-wrap:anywhere}
.sa-trace-row button{max-width:100%;text-align:left;overflow-wrap:anywhere}
.sa-trace-actions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.sa-trace-facts{display:flex;flex-direction:column;gap:5px;margin-top:8px}
.sa-trace-fact{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:start;width:100%;padding:7px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;text-align:left}
.sa-trace-fact:hover,.sa-trace-fact[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}
.sa-trace-fact code,.sa-trace-relation code,.sa-trace-final code{overflow-wrap:anywhere}
.sa-trace-hit{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.sa-trace-detail{position:sticky;top:8px;padding:12px;max-height:calc(100vh - 180px);overflow:auto}
.sa-trace-detail-head{display:flex;justify-content:flex-end;margin-bottom:6px}
.sa-trace-detail pre,.sa-trace-final pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
.sa-trace-detail dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 10px;margin:8px 0}
.sa-trace-detail dt{color:var(--dsw-alias-label-tertiary)}
.sa-trace-detail dd{margin:0;overflow-wrap:anywhere}
.sa-trace-relations{display:flex;flex-direction:column;gap:5px}
.sa-trace-relation{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sa-trace-final{margin-top:8px;padding:8px;border-left:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l1)}
.sa-trace-empty{padding:20px;text-align:center}
.sa-trace button:focus-visible,.sa-trace input:focus-visible,.sa-trace select:focus-visible,.sa-trace summary:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:2px}
@media(max-width:760px){.sa-trace{padding:10px}.sa-trace-grid{grid-template-columns:minmax(0,1fr)}.sa-trace-detail{position:static;max-height:none}.sa-trace-turn{margin-left:0}.sa-trace-toolbar>*{flex:1 1 140px}.sa-trace-toolbar select{max-width:none}.sa-trace-actions{width:100%;margin-left:0}}
`;
    const factKey = fact => fact ? `${fact.factId}:${fact.sourceRevision || ""}` : "";
    const coverageText = coverage => {
      if (!coverage || typeof coverage !== "object") return "覆盖范围未知";
      const label = { complete: "完整", partial: "部分", unknown: "未知", unsupported: "不支持" }[coverage.state] || coverage.state || "未知";
      const missing = [...new Set(Array.isArray(coverage.missingFields) ? coverage.missingFields : [])];
      const incomplete = Array.isArray(coverage.byFactType)
        ? coverage.byFactType.filter(row => row.state !== "complete").map(row => `${row.type}:${row.state}`)
        : [];
      const details = [...missing, ...incomplete];
      return `${label}${details.length ? ` · 缺少 ${details.join("、")}` : ""}${coverage.reason ? ` · ${coverage.reason}` : ""}`;
    };
    const dedupeFacts = facts => [...new Map(facts.filter(Boolean).map(fact => [fact.factId, fact])).values()];
    const dedupeNodes = nodes => [...new Map((nodes || []).map(node => [`${node.kind}:${node.id || node.runId || node.conversationId}`, node])).values()];
    const metadataSearchText = fact => JSON.stringify({
      type: fact.type,
      factId: fact.factId,
      runId: fact.runId,
      turnId: fact.turnId,
      attemptId: fact.attemptId,
      executionId: fact.executionId,
      requestRef: fact.requestRef,
      toolName: fact.payload && typeof fact.payload === "object" ? fact.payload.toolName ?? null : null,
      modelId: fact.payload && typeof fact.payload === "object" ? fact.payload.modelId ?? null : null,
      providerId: fact.payload && typeof fact.payload === "object" ? fact.payload.providerId ?? null : null,
      status: fact.payload && typeof fact.payload === "object" ? fact.payload.status ?? null : null,
    }).toLowerCase();
    const contentSearchHit = (fact, search) => {
      const needle = String(search || "").trim().toLowerCase();
      return Boolean(needle) && !metadataSearchText(fact).includes(needle);
    };

    function createTraceController({ read, conversationId, pageSize = 100 }) {
      let state = {
        facts: [], total: 0, nextCursor: null, search: "", watermark: null, asOf: null,
        queryId: null, coverage: null, busy: false, loaded: false, error: "", lastSuccessAt: null,
      };
      let generation = 0, disposed = false;
      const listeners = new Set();
      const set = patch => {
        if (disposed) return;
        const next = { ...state, ...patch };
        if (JSON.stringify(next) === JSON.stringify(state)) return;
        state = next;
        for (const listener of listeners) listener();
      };
      const verify = page => {
        if (!page || page.conversationId !== conversationId || !Array.isArray(page.facts) ||
            !Number.isSafeInteger(page.total) || typeof page.queryId !== "string") {
          throw new Error("轨迹响应结构无效");
        }
        if (page.facts.some(fact => !fact || typeof fact.factId !== "string" || fact.conversationId !== conversationId)) {
          throw new Error("轨迹事实不属于当前会话");
        }
        return page;
      };
      const readPage = async query => {
        if (typeof read !== "function") throw new Error("当前连接没有 Conversation Trace 查询能力");
        return verify(await read(conversationId, query));
      };
      const replace = async (search = state.search, desired = Math.max(pageSize, state.facts.length)) => {
        if (disposed || state.busy) return state;
        const at = ++generation;
        set({ busy: true, error: "" });
        try {
          let page = await readPage({ search, limit: Math.min(500, desired) });
          const queryId = page.queryId, watermark = page.watermark;
          const facts = [...page.facts];
          while (page.nextCursor && facts.length < desired) {
            page = await readPage({ search, cursor: page.nextCursor, limit: Math.min(500, desired - facts.length) });
            if (page.queryId !== queryId || page.watermark !== watermark) throw new Error("轨迹分页水位发生变化，请刷新");
            facts.push(...page.facts);
          }
          if (disposed || at !== generation) return state;
          set({
            facts: dedupeFacts(facts), total: page.total, nextCursor: page.nextCursor || null,
            search, watermark: page.watermark ?? watermark ?? null, asOf: page.asOf || null,
            queryId: page.queryId || queryId, coverage: page.coverage || null,
            busy: false, loaded: true, error: "", lastSuccessAt: new Date().toISOString(),
          });
        } catch (error) {
          if (!disposed && at === generation) set({ busy: false, loaded: true, error: error.message });
        }
        return state;
      };
      return {
        getState: () => state,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        refresh: () => replace(),
        search: value => replace(String(value || "").trim(), pageSize),
        async more() {
          if (disposed || state.busy || !state.nextCursor) return state;
          const at = ++generation, before = state;
          set({ busy: true, error: "" });
          try {
            const page = await readPage({ search: before.search, cursor: before.nextCursor, limit: pageSize });
            if (page.queryId !== before.queryId || page.watermark !== before.watermark) {
              throw new Error("轨迹分页水位发生变化，请刷新");
            }
            if (!disposed && at === generation) set({
              facts: dedupeFacts([...before.facts, ...page.facts]), total: page.total,
              nextCursor: page.nextCursor || null, coverage: page.coverage || before.coverage,
              asOf: page.asOf || before.asOf, busy: false, loaded: true,
              lastSuccessAt: new Date().toISOString(),
            });
          } catch (error) {
            if (!disposed && at === generation) set({ busy: false, error: error.message });
          }
          return state;
        },
        async locate(ids = {}) {
          if (disposed) return { level: null, exhausted: true };
          const find = () => {
            if (ids.factId) {
              const fact = state.facts.find(item => item.factId === ids.factId);
              if (fact) return { level: "fact", factId: fact.factId, runId: fact.runId || null, turnId: fact.turnId || null };
            }
            if (ids.turnId) {
              const fact = state.facts.find(item => item.turnId === ids.turnId);
              if (fact) return { level: "turn", factId: fact.factId, runId: fact.runId || ids.runId || null, turnId: fact.turnId };
            }
            if (ids.runId) {
              const fact = state.facts.find(item => item.runId === ids.runId);
              if (fact) return { level: "run", factId: fact.factId, runId: fact.runId, turnId: null };
            }
            return null;
          };
          try {
            let found = find();
            let pagesRead = 0;
            while (!found && state.nextCursor && pagesRead < 100) {
              const before = state, page = await readPage({ search: before.search, cursor: before.nextCursor, limit: pageSize });
              if (disposed) return { level: null, exhausted: false };
              if (page.queryId !== before.queryId || page.watermark !== before.watermark) {
                throw new Error("轨迹分页水位发生变化，请刷新");
              }
              pagesRead++;
              state = {
                ...state,
                facts: dedupeFacts([...state.facts, ...page.facts]),
                total: page.total,
                nextCursor: page.nextCursor || null,
                coverage: page.coverage || state.coverage,
                asOf: page.asOf || state.asOf,
                loaded: true,
              };
              for (const listener of listeners) listener();
              found = find();
            }
            if (found) return { ...found, exhausted: !state.nextCursor };
            if (!ids.factId && !ids.turnId && !ids.runId) return { level: "conversation", exhausted: !state.nextCursor };
            return { level: state.nextCursor ? null : "conversation", exhausted: !state.nextCursor };
          } catch (error) {
            set({ busy: false, loaded: true, error: error.message });
            return { level: null, exhausted: false, error: error.message };
          }
        },
        dispose() { disposed = true; generation++; listeners.clear(); },
      };
    }

    function groupConversationFacts(facts) {
      const runs = new Map();
      for (const fact of facts) {
        const runId = typeof fact.runId === "string" ? fact.runId : null;
        let run = runs.get(runId);
        if (!run) {
          run = { runId, facts: [], runFacts: [], turns: new Map() };
          runs.set(runId, run);
        }
        run.facts.push(fact);
        if (typeof fact.turnId !== "string") {
          run.runFacts.push(fact);
          continue;
        }
        let turn = run.turns.get(fact.turnId);
        if (!turn) {
          turn = { turnId: fact.turnId, facts: [] };
          run.turns.set(fact.turnId, turn);
        }
        turn.facts.push(fact);
      }
      return [...runs.values()];
    }

    function buildTraceExport({ conversationId, threadId = null, targetId = null, state, messages = [], graph = null, filters = {}, loadedContent = [] }) {
      const facts = (state?.facts || []).filter(fact => fact.conversationId === conversationId);
      const runIds = new Set(facts.map(fact => fact.runId).filter(Boolean));
      return {
        format: "super-agent-conversation-trace-v1",
        exportedAt: new Date().toISOString(),
        scope: { targetId, threadId, conversationId },
        query: {
          search: state?.search || "",
          queryId: state?.queryId || null,
          watermark: state?.watermark || null,
          asOf: state?.asOf || null,
          coverage: state?.coverage || null,
          filters: { ...filters },
          loadedFacts: facts.length,
          totalFacts: state?.total ?? null,
        },
        facts,
        finalMessages: (messages || []).filter(message => message?.isFinal === true &&
          (message.conversationId == null || message.conversationId === conversationId) &&
          (message.runId == null || runIds.has(message.runId))),
        relations: graph ? {
          coverage: graph.coverage || null,
          nodes: dedupeNodes(graph.nodes),
          edges: Array.isArray(graph.edges) ? graph.edges : [],
        } : null,
        loadedContent: (loadedContent || []).filter(entry => entry?.result?.status === "available"),
        note: "Only facts and readable content already loaded for this Conversation are exported.",
      };
    }

    function createTrace({ kernel, services }) {
      const { React, h } = kernel;
      const time = value => value ? new Date(value).toLocaleString() : "未知";
      const duration = value => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)} ms` : "未知";
      const statusOf = fact => fact?.payload?.status || fact?.payload?.phase || "已记录";
      const lane = fact => ({
        thread: "Thread",
        conversation: "Conversation",
        run: "Run",
        model_attempt: "模型尝试",
        tool_invocation: "工具",
        skill_evidence: "Skill",
        delegation: "子 Agent",
        report: "报告",
      })[fact.type] || "输入与控制";
      const referenceKey = reference => `${reference.kind}:${reference.id}:${reference.part}`;

      function Content({ reference, onLoaded }) {
        const [state, set] = React.useState({ busy: false, result: null, error: "" });
        const load = async () => {
          if (state.busy) return;
          set({ busy: true, result: null, error: "" });
          try {
            const result = await services.observations.content(reference);
            set({ busy: false, result, error: "" });
            if (result?.status === "available") onLoaded?.({ ref: reference, result });
          } catch (error) {
            set({ busy: false, result: null, error: error.message });
          }
        };
        const result = state.result;
        const status = result?.status || (state.error ? "error" : "unknown");
        return h("details", { className: "sa-run-card", onToggle: event => {
          if (event.currentTarget.open && !state.result && !state.busy && !state.error) void load();
        } },
          h("summary", null, `内容 ${reference.part} · ${reference.kind}:${reference.id}`),
          state.busy ? h("p", { role: "status" }, "读取内容…")
            : state.error ? h("p", { role: "alert", className: "sa-error" }, state.error,
              h("button", { type: "button", className: "sa-chip", onClick: () => void load() }, "重试此内容"))
              : result ? h(React.Fragment, null,
                h("p", { className: "sa-muted" }, `状态 ${status}${result.reason ? ` · ${result.reason}` : ""}${result.redactions?.length ? ` · 脱敏 ${result.redactions.join("、")}` : ""}`),
                result.status === "available" && h("pre", null, typeof result.content === "string" ? result.content : JSON.stringify(result.content, null, 2)))
                : h("p", { className: "sa-muted" }, "展开后按需读取；读取失败只影响此内容。"));
      }

      function FactDetail({ fact, onLoadedContent }) {
        const p = fact.payload || {};
        const common = h(React.Fragment, null,
          h("dl", null,
            h("dt", null, "事实"), h("dd", null, fact.factId),
            h("dt", null, "来源"), h("dd", null, `${fact.sourceKind} · ${fact.sourceRef} · 修订 ${fact.sourceRevision || "未知"}`),
            h("dt", null, "发生时间"), h("dd", null, time(fact.occurredAt)),
            h("dt", null, "请求"), h("dd", null, fact.requestRef || "未知"),
            h("dt", null, "尝试"), h("dd", null, fact.attemptId || "无"),
            h("dt", null, "执行"), h("dd", null, fact.executionId || "无"),
            h("dt", null, "覆盖"), h("dd", null, coverageText(fact.coverage))));
        let typed = null;
        if (fact.type === "run") typed = h("p", null, `状态 ${p.status || "未知"} · 来源 ${p.source || "未知"} · 开始 ${time(p.startedAt)} · 结束 ${time(p.endedAt)} · 终止原因 ${p.endReason || "未知"} · 入口任务 ${p.entryRun == null ? "未知" : p.entryRun ? "是" : "否"}`);
        else if (fact.type === "model_attempt") typed = h(React.Fragment, null,
          h("p", null, `模型 ${p.providerId || "未知"}/${p.modelId || "未知"} · 状态 ${p.status || "未知"} · 目的 ${p.purpose || "未知"}`),
          h("p", null, `开始 ${time(p.startedAt)} · 首 token ${time(p.firstTokenAt)} · 结束 ${time(p.endedAt)} · 首 token 延迟 ${duration(p.firstTokenLatencyMs)} · 总耗时 ${duration(p.durationMs)}`),
          h("p", null, `用量 输入 ${p.usage?.inputTokens ?? "未知"} · 输出 ${p.usage?.outputTokens ?? "未知"} · 缓存读 ${p.usage?.cacheReadTokens ?? "未知"} · 缓存写 ${p.usage?.cacheWriteTokens ?? "未知"} · 费用 ${p.usage?.costKnown ? `${p.usage.cost} ${p.usage.currency || ""}`.trim() : "未知"}`),
          h("p", { className: "sa-muted" }, `响应完成 ${p.responseComplete == null ? "未知" : p.responseComplete ? "是" : "否"} · 暴露工具 ${p.exposedTools?.length ?? 0} · Skill ${p.exposedSkills?.length ?? 0}`));
        else if (fact.type === "tool_invocation") typed = h(React.Fragment, null,
          h("p", null, `${p.toolName || "工具"} · ${p.phase || "阶段未知"} · ${p.status || "状态未知"} · 调用方 ${p.caller || "未知"}`),
          h("p", null, `逻辑调用 ${p.logicalInvocationId || "未知"} · 父执行 ${p.parentExecutionId || "无"} · 开始 ${time(p.startedAt)} · 结束 ${time(p.endedAt)} · 耗时 ${duration(p.durationMs)}`),
          h("p", { className: "sa-muted" }, `调用 ${fact.toolCallId || "未知"} · 执行 ${fact.executionId || "未知"} · 响应事实 ${p.responseFactId || "无"}`));
        else if (fact.type === "skill_evidence") typed = h("p", null, `${p.skillId || "Skill"} · ${p.version || "版本未知"} · ${p.phase || "阶段未知"} · 来源 ${p.source || "未知"} · hash ${p.contentHash || "未知"} · 覆盖 ${p.coveredBytes ?? "未知"}/${p.expectedBytes ?? "未知"} B`);
        else if (fact.type === "delegation") typed = h("p", null, `子 Agent · ${p.phase || "阶段未知"} · ${p.status || "状态未知"} · 模式 ${p.mode || "未知"} · 父调用 ${p.parentToolCallId || "未知"} · 子 Conversation ${p.childConversationId || "未知"} · 子 Run ${p.childRunId || "未知"} · 报告 ${p.reportId || "无"}`);
        else if (fact.type === "report") typed = h("p", null, `报告 ${p.reportId || "未知"} · ${p.status || "状态未知"} · 原父任务 ${p.originalParentRunId || "未知"} · 接收任务 ${p.recipientRunId || "未接收"} · 生成 ${time(p.generatedAt)} · 接收 ${time(p.receivedAt)} · 处理 ${time(p.processedAt)}`);
        else if (fact.type === "conversation") typed = h("p", null, `用途 ${p.purpose || "未知"} · 来源 Conversation ${p.forkedFromConversationId || "无"}`);
        else if (fact.type === "thread") typed = h("p", null, `状态 ${p.status || "未知"} · Agent ${p.agentDefinitionVersion || "未知"} · 模型绑定 ${p.modelBinding || "未知"} · 权限 ${p.permissionMode || "未知"} · 版本 ${p.deploymentVersion || "未知"}`);
        return h(React.Fragment, null, typed,
          h("details", null, h("summary", null, "结构化载荷"),
            h("pre", null, JSON.stringify(p, null, 2))),
          ...(fact.contentRefs || []).map(reference => h(Content, {
            key: referenceKey(reference), reference, onLoaded: onLoadedContent,
          })));
      }

      function ConversationTrace({ conversationId, threadId, targetId, title, threadTitle, messages = [], initialFocus, onOpenConversation, controller: spaceController }) {
        const read = services.observations?.conversationTrace;
        const traceController = React.useMemo(() => createTraceController({ read, conversationId }), [read, conversationId]);
        const state = React.useSyncExternalStore(traceController.subscribe, traceController.getState, traceController.getState);
        const [search, setSearch] = React.useState("");
        const [runFilter, setRunFilter] = React.useState("");
        const [typeFilter, setTypeFilter] = React.useState("");
        const [statusFilter, setStatusFilter] = React.useState("");
        const [selection, setSelection] = React.useState(null);
        const [openRuns, setOpenRuns] = React.useState({});
        const [openTurns, setOpenTurns] = React.useState({});
        const [focusNotice, setFocusNotice] = React.useState("");
        const [graph, setGraph] = React.useState(null);
        const [graphError, setGraphError] = React.useState("");
        const [loadedContent, setLoadedContent] = React.useState([]);
        const [exportState, setExportState] = React.useState("");
        const [controlState, setControlState] = React.useState("");
        const detailTrigger = React.useRef(null);
        const focusTargetMismatch = Boolean(initialFocus?.targetId && targetId && initialFocus.targetId !== targetId);
        const focusConversationMismatch = Boolean(initialFocus?.conversationId && initialFocus.conversationId !== conversationId);
        const focusThreadMismatch = Boolean(initialFocus?.threadId && threadId && initialFocus.threadId !== threadId);
        const focusKey = JSON.stringify(initialFocus || null);

        React.useEffect(() => {
          void traceController.refresh();
          const timer = setInterval(() => void traceController.refresh(), 3000);
          return () => { clearInterval(timer); traceController.dispose(); };
        }, [traceController]);

        React.useEffect(() => {
          if (!state.loaded || !initialFocus || focusTargetMismatch || focusConversationMismatch || focusThreadMismatch) return undefined;
          let active = true;
          const requestedLevel = initialFocus.factId ? "fact" : initialFocus.turnId ? "turn" : initialFocus.runId ? "run" : "conversation";
          const requestedLabel = { fact: "事实", turn: "Turn", run: "Run", conversation: "Conversation" }[requestedLevel];
          void traceController.locate(initialFocus).then(found => {
            if (!active) return;
            if (found.level === "fact") {
              setSelection({ kind: "fact", id: found.factId, runId: found.runId, turnId: found.turnId });
              if (found.runId) setOpenRuns(current => ({ ...current, [found.runId]: true }));
              if (found.runId && found.turnId) setOpenTurns(current => ({ ...current, [`${found.runId}:${found.turnId}`]: true }));
            } else if (found.level === "turn") {
              setSelection({ kind: "turn", id: found.turnId, runId: found.runId });
              if (found.runId) setOpenRuns(current => ({ ...current, [found.runId]: true }));
              if (found.runId) setOpenTurns(current => ({ ...current, [`${found.runId}:${found.turnId}`]: true }));
            } else if (found.level === "run") {
              setSelection({ kind: "run", id: found.runId, runId: found.runId });
              setOpenRuns(current => ({ ...current, [found.runId]: true }));
            }
            if (found.error) setFocusNotice(`定位失败：${found.error}`);
            else if (found.level === "conversation" && requestedLevel !== "conversation") {
              setFocusNotice(`未找到${requestedLabel} ${initialFocus.factId || initialFocus.turnId || initialFocus.runId}；${found.exhausted ? `已读取当前查询全部 ${traceController.getState().total} 条事实` : "当前覆盖范围尚未结束"}，降级显示整个 Conversation。`);
            } else if (found.level && found.level !== requestedLevel) {
              setFocusNotice(`未找到${requestedLabel}，已降级定位到 ${found.level === "fact" ? "事实" : found.level === "turn" ? "Turn" : "Run"} ${found.factId || found.turnId || found.runId}。`);
            }
          });
          return () => { active = false; };
        }, [traceController, state.loaded, focusKey, focusTargetMismatch, focusConversationMismatch, focusThreadMismatch]);

        React.useEffect(() => {
          let active = true;
          if (!threadId || typeof services.observations?.graph !== "function") return undefined;
          setGraphError("");
          void services.observations.graph(threadId)
            .then(result => { if (active) setGraph(result || null); })
            .catch(error => { if (active) setGraphError(error.message || "关联关系读取失败"); });
          return () => { active = false; };
        }, [threadId, state.watermark]);

        const allRuns = groupConversationFacts(state.facts);
        const runs = allRuns.filter(run => run.runId);
        const runOptions = runs.map(run => run.runId);
        const effectiveRunFilter = runOptions.includes(runFilter) ? runFilter : "";
        const factTypes = [...new Set(state.facts.map(fact => fact.type))].sort();
        const statuses = [...new Set(state.facts.map(statusOf).filter(Boolean))].sort();
        const visibleFacts = state.facts.filter(fact =>
          (!effectiveRunFilter || fact.runId === effectiveRunFilter) &&
          (!typeFilter || fact.type === typeFilter) &&
          (!statusFilter || statusOf(fact) === statusFilter));
        const visibleRuns = groupConversationFacts(visibleFacts);
        const turnCount = new Set(state.facts.map(fact => fact.turnId).filter(Boolean)).size;
        const runStatusCounts = new Map();
        for (const run of runs) {
          const runFact = [...(run.facts || [])].reverse().find(fact => fact.type === "run");
          const status = runFact?.type === "run" ? runFact.payload.status || "unknown" : "unknown";
          runStatusCounts.set(status, (runStatusCounts.get(status) || 0) + 1);
        }
        const threadFact = state.facts.find(fact => fact.type === "thread");
        const conversationFact = state.facts.find(fact => fact.type === "conversation");
        const defaultRunId = selection?.runId || initialFocus?.runId || runs.at(-1)?.runId || null;
        const selectedFact = selection?.kind === "fact" ? state.facts.find(fact => fact.factId === selection.id) : null;
        const selectedRun = selection?.kind === "run" ? runs.find(run => run.runId === selection.id) : null;
        const selectedTurn = selection?.kind === "turn"
          ? runs.flatMap(run => [...run.turns.values()].map(turn => ({ ...turn, runId: run.runId }))).find(turn => turn.turnId === selection.id)
          : null;

        const rememberDetailTrigger = event => {
          detailTrigger.current = event?.currentTarget || null;
        };
        const closeDetail = () => {
          const trigger = detailTrigger.current;
          setSelection(null);
          if (trigger && typeof trigger.focus === "function") trigger.focus();
        };
        const selectRun = (runId, event) => {
          rememberDetailTrigger(event);
          setSelection({ kind: "run", id: runId, runId });
          setOpenRuns(current => ({ ...current, [runId]: true }));
        };
        const selectTurn = (runId, turnId, event) => {
          rememberDetailTrigger(event);
          setSelection({ kind: "turn", id: turnId, runId, turnId });
          setOpenRuns(current => ({ ...current, [runId]: true }));
          setOpenTurns(current => ({ ...current, [`${runId}:${turnId}`]: true }));
        };
        const selectFact = (fact, event) => {
          rememberDetailTrigger(event);
          setSelection({ kind: "fact", id: fact.factId, runId: fact.runId || null, turnId: fact.turnId || null });
          if (fact.runId) setOpenRuns(current => ({ ...current, [fact.runId]: true }));
          if (fact.runId && fact.turnId) setOpenTurns(current => ({ ...current, [`${fact.runId}:${fact.turnId}`]: true }));
        };
        const runOpen = runId => Object.hasOwn(openRuns, runId) ? openRuns[runId] : runId === defaultRunId;
        const turnOpen = (runId, turnId) => {
          const key = `${runId}:${turnId}`;
          return Object.hasOwn(openTurns, key) ? openTurns[key] : turnId === selection?.turnId;
        };

        const relationRows = [];
        if (graph) {
          const nodes = dedupeNodes(graph.nodes);
          const byId = new Map(nodes.map(node => [node.id, node]));
          for (const edge of graph.edges || []) {
            const from = byId.get(edge.fromId), to = byId.get(edge.toId);
            const fromCurrent = from?.conversationId === conversationId;
            const toCurrent = to?.conversationId === conversationId;
            if (!fromCurrent && !toCurrent) continue;
            relationRows.push({ edge, target: fromCurrent ? to : from, direction: fromCurrent ? "outgoing" : "incoming" });
          }
        }
        const relationLabel = kind => ({ fork: "对话分支", parent_run: "父子任务", origin_run: "原输入独立重试", delegation: "子 Agent 委派", report_delivery: "报告交付" })[kind] || kind;
        const openRelation = row => {
          const target = row.target;
          if (!target) return;
          if (target.conversationId && target.conversationId !== conversationId && onOpenConversation) {
            onOpenConversation(target.conversationId);
            return;
          }
          if (target.runId) selectRun(target.runId);
        };
        const download = () => {
          try {
            const payload = buildTraceExport({
              conversationId, threadId, targetId, state, messages, graph,
              filters: { runId: effectiveRunFilter || null, type: typeFilter || null, status: statusFilter || null },
              loadedContent,
            });
            const text = JSON.stringify(payload, null, 2);
            if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
              setExportState(`已生成 ${payload.facts.length} 条事实的导出内容，但当前页面不能下载文件。`);
              return;
            }
            const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `conversation-trace-${conversationId}.json`;
            anchor.click();
            URL.revokeObjectURL(url);
            setExportState(`已导出 ${payload.facts.length} 条已加载事实和 ${payload.loadedContent.length} 项已读内容。`);
          } catch (error) {
            setExportState(`导出失败：${error.message}`);
          }
        };
        const pauseThread = async () => {
          if (!spaceController?.controlThread || !threadId) return;
          setControlState("暂停请求处理中…");
          try {
            await spaceController.controlThread("pause");
            setControlState("暂停请求已接收；实际 Thread 状态以刷新为准。");
          } catch (error) {
            setControlState(`暂停失败：${error.message}`);
          }
        };
        const finalMessages = messages.filter(message => message?.isFinal === true && message.runId);
        const renderFinal = message => h("article", { className: "sa-trace-final", key: `final:${message.messageId}`, "aria-label": `最终回答 ${message.messageId}` },
          h("div", { className: "sa-trace-row" }, h("strong", null, "最终回答"), h("code", null, message.messageId)),
          h("pre", null, message.text || "正文未知"));
        const renderFact = fact => {
          const selected = selection?.kind === "fact" && selection.id === fact.factId;
          const hit = contentSearchHit(fact, state.search);
          return h("button", {
            type: "button", className: "sa-trace-fact", key: factKey(fact),
            "aria-pressed": selected, "data-fact-id": fact.factId,
            onClick: event => selectFact(fact, event),
          },
            h("span", null, lane(fact)),
            h("span", null, h("strong", null, fact.payload?.toolName || fact.payload?.modelId || fact.payload?.skillId || fact.payload?.reportId || fact.type),
              h("span", { className: "sa-muted" }, ` · ${statusOf(fact)} · ${time(fact.occurredAt)}`),
              hit && h("span", { className: "sa-trace-hit" }, " · 命中可读取内容")),
            h("code", null, fact.factId));
        };
        const detail = selectedFact ? h(React.Fragment, null,
          h("div", { className: "sa-trace-row" }, h("strong", null, `事实 ${selectedFact.factId}`), h("span", { className: "sa-muted" }, lane(selectedFact))),
          h(FactDetail, { fact: selectedFact, onLoadedContent: loaded => setLoadedContent(current =>
            current.some(entry => referenceKey(entry.ref) === referenceKey(loaded.ref)) ? current : [...current, loaded]) }))
          : selectedTurn ? h(React.Fragment, null,
            h("div", { className: "sa-trace-row" }, h("strong", null, `Turn ${selectedTurn.turnId}`), h("span", { className: "sa-muted" }, `Run ${selectedTurn.runId} · ${selectedTurn.facts.length} 条事实`)),
            ...selectedTurn.facts.map(fact => h("p", { key: fact.factId }, `${lane(fact)} · ${statusOf(fact)} · ${fact.factId}`)))
            : selectedRun ? h(React.Fragment, null,
              h("div", { className: "sa-trace-row" }, h("strong", null, `Run ${selectedRun.runId}`), h("span", { className: "sa-muted" }, `Turn ${selectedRun.turns.size} · 事实 ${selectedRun.facts.length}`)),
              ...selectedRun.facts.slice(0, 20).map(fact => h("p", { key: fact.factId }, `${lane(fact)} · ${statusOf(fact)} · ${time(fact.occurredAt)}`)))
              : h("p", { className: "sa-muted" }, "选择 Run、Turn 或事实查看详情。");
        const detailOpen = Boolean(selectedFact || selectedTurn || selectedRun);
        const empty = !state.loaded && state.busy ? "读取轨迹…"
          : state.error && !state.facts.length ? "轨迹读取失败；不能据此判断没有执行"
            : state.search && !state.facts.length ? "当前 Conversation 没有匹配的轨迹事实"
              : !state.facts.length ? "当前 Conversation 尚无已索引事实；这不代表没有执行"
                : visibleFacts.length ? "" : "当前筛选只覆盖已加载事实，没有匹配项";

        return h("section", { className: "sa-trace", "aria-label": "会话轨迹", "data-trace-conversation-id": conversationId },
          h("style", null, TRACE_CSS),
          h("header", null,
            h("div", { className: "sa-trace-row" },
              h("strong", null, title || `Conversation ${conversationId}`),
              h("span", { className: "sa-muted" }, `Thread ${threadTitle || threadId || "未知"} · ${conversationFact?.payload?.purpose || "用途未知"} · 创建 ${time(conversationFact?.occurredAt)}`)),
            h("p", { className: "sa-trace-meta" }, `Conversation ${conversationId} · Thread ${threadId || "未知"} · ${runs.length} Run · ${turnCount} Turn · Agent ${threadFact?.payload?.agentDefinitionVersion || "未知"}`),
            h("p", { className: "sa-trace-meta" }, `Run 状态：${runStatusCounts.size ? [...runStatusCounts].map(([status, count]) => `${status} ${count}`).join(" · ") : "未知"} · 读取 ${state.facts.length}/${state.total} 条事实`),
            (focusTargetMismatch || focusConversationMismatch || focusThreadMismatch) && h("p", { role: "alert", className: "sa-error" }, "深链身份与当前页面不一致，已拒绝跨目标定位。"),
            focusNotice && h("p", { role: "status", className: "sa-muted" }, focusNotice)),
          h("form", { className: "sa-trace-toolbar", onSubmit: event => { event.preventDefault(); void traceController.search(search); } },
            h("input", { "aria-label": "搜索会话轨迹", placeholder: "搜索身份、工具、模型及可读取内容", value: search,
              maxLength: 256, onChange: event => setSearch(event.target.value) }),
            h("button", { type: "submit", disabled: state.busy }, "搜索"),
            h("button", { type: "button", disabled: state.busy, onClick: () => { setSearch(""); void traceController.search(""); } }, "清除搜索"),
            h("button", { type: "button", disabled: state.busy, onClick: () => void traceController.refresh() }, "刷新"),
            h("button", { type: "button", onClick: download }, "导出 Trace"),
            spaceController?.controlThread && threadId && h("button", { type: "button", onClick: () => void pauseThread() }, "暂停 Thread")),
          h("div", { className: "sa-trace-toolbar", "aria-label": "Trace 筛选" },
            h("select", { "aria-label": "按 Run 筛选", value: effectiveRunFilter, onChange: event => setRunFilter(event.target.value) },
              h("option", { value: "" }, "全部 Run"), ...runOptions.map(runId => h("option", { key: runId, value: runId }, runId))),
            h("select", { "aria-label": "按节点类型筛选", value: typeFilter, onChange: event => setTypeFilter(event.target.value) },
              h("option", { value: "" }, "全部节点类型"), ...factTypes.map(type => h("option", { key: type, value: type }, lane({ type })))),
            h("select", { "aria-label": "按状态筛选", value: statusFilter, onChange: event => setStatusFilter(event.target.value) },
              h("option", { value: "" }, "全部状态"), ...statuses.map(status => h("option", { key: status, value: status }, status))),
            h("span", { className: "sa-muted" }, "按 Run、类型和状态筛选仅作用于已加载事实。")),
          h("p", { className: "sa-trace-meta" }, `水位 ${state.watermark || "未知"} · 查询 ${state.queryId || "读取中"} · ${time(state.asOf)} · 覆盖 ${coverageText(state.coverage)} · 上次成功 ${time(state.lastSuccessAt)}`),
          state.error && state.facts.length > 0 && h("p", { role: "alert", className: "sa-error" }, `${state.error}。保留上次成功读取的 ${state.facts.length} 条事实。`),
          state.error && !state.facts.length && h("p", { role: "alert", className: "sa-error" }, state.error),
          graphError && h("p", { role: "alert", className: "sa-muted" }, `关联关系读取失败：${graphError}。Run 和事实仍可读取。`),
          exportState && h("p", { role: "status", className: "sa-muted" }, exportState),
          controlState && h("p", { role: "status", className: "sa-muted" }, controlState),
          relationRows.length > 0 && h("section", { className: "sa-trace-relations", "aria-label": "Trace 关联关系" },
            h("strong", null, "关联关系"),
            ...relationRows.map(row => h("div", { className: "sa-trace-relation", key: `${row.edge.kind}:${row.edge.factId}:${row.edge.fromId}:${row.edge.toId}` },
              h("span", null, relationLabel(row.edge.kind)),
              h("code", null, `${row.edge.fromId} → ${row.edge.toId}`),
              row.target && h("button", { type: "button", className: "sa-chip", onClick: () => openRelation(row) },
                row.target.conversationId && row.target.conversationId !== conversationId ? `打开 Conversation ${row.target.conversationId}` : `定位 ${row.target.runId || row.target.id}`)))),
          empty && h("p", { className: "sa-trace-empty", role: state.error ? "alert" : "status" }, empty),
          h("div", { className: "sa-trace-grid" },
            h("div", { className: "sa-trace-runs" }, ...visibleRuns.map(run => {
              const runId = run.runId || "unattributed";
              const runFact = [...run.facts].reverse().find(fact => fact.type === "run");
              const runStatus = runFact?.type === "run" ? runFact.payload.status || "未知" : "状态未知";
              const attempts = [...new Map(run.facts.filter(fact => fact.type === "model_attempt").map(fact => [fact.attemptId || fact.factId, fact])).values()];
              const model = attempts.at(-1)?.payload;
              const elapsed = runFact?.type === "run" && runFact.payload.startedAt && runFact.payload.endedAt
                ? Date.parse(runFact.payload.endedAt) - Date.parse(runFact.payload.startedAt) : null;
              const user = messages.find(message => message.runId === runId && (message.role === "user" || message.kind === "user"));
              const runFinals = finalMessages.filter(message => message.runId === runId && !message.turnId);
              const turnNodes = [...run.turns.values()].map(turn => h("section", { className: "sa-trace-turn", key: turn.turnId },
                h("div", { className: "sa-trace-row" },
                  h("button", { type: "button", className: "sa-chip", "aria-expanded": turnOpen(runId, turn.turnId), onClick: () => setOpenTurns(current => ({ ...current, [`${runId}:${turn.turnId}`]: !turnOpen(runId, turn.turnId) })) },
                    turnOpen(runId, turn.turnId) ? "收起 Turn" : "展开 Turn"),
                  h("button", { type: "button", className: "sa-chip", onClick: event => selectTurn(runId, turn.turnId, event) }, "Turn 详情"),
                  h("strong", null, `Turn ${turn.turnId}`),
                  h("span", { className: "sa-muted" }, `${turn.facts.length} 条事实`)),
                turnOpen(runId, turn.turnId) && h("div", { className: "sa-trace-facts" }, ...turn.facts.map(renderFact)),
                ...finalMessages.filter(message => message.runId === runId && message.turnId === turn.turnId).map(renderFinal)));
              const expanded = runOpen(runId) && h(React.Fragment, null,
                h("div", { className: "sa-trace-facts" }, ...run.runFacts.map(renderFact)),
                ...turnNodes,
                ...runFinals.map(renderFinal));
              return h("section", { className: "sa-trace-run", key: runId, "data-run-id": run.runId },
                h("div", { className: "sa-trace-row" },
                  h("button", { type: "button", className: "sa-chip", "aria-expanded": runOpen(runId), onClick: () => setOpenRuns(current => ({ ...current, [runId]: !runOpen(runId) })) },
                    runOpen(runId) ? "收起 Run" : "展开 Run"),
                  h("button", { type: "button", className: "sa-chip", onClick: event => selectRun(run.runId, event), disabled: !run.runId }, "Run 详情"),
                  h("strong", null, run.runId ? `Run ${run.runId}` : "未归属 Run"),
                  h("span", { className: "sa-muted" }, `${runStatus} · ${run.turns.size} Turn · ${run.facts.length} 事实`)),
                h("p", { className: "sa-trace-meta" }, `输入 ${user?.text ? user.text.slice(0, 160) : "摘要未知"} · 模型 ${model ? `${model.providerId || "未知"}/${model.modelId || "未知"}` : "未知"} · 用时 ${Number.isFinite(elapsed) ? duration(elapsed) : "未知"}`),
                expanded);
            })),
            h("aside", {
              className: "sa-trace-detail", "aria-label": "Trace 节点详情", tabIndex: -1,
              onKeyDown: event => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                closeDetail();
              },
            },
              detailOpen && h("div", { className: "sa-trace-detail-head" },
                h("button", { type: "button", className: "sa-chip", "aria-label": "关闭 Trace 详情", onClick: closeDetail }, "关闭详情")),
              detail)),
          state.nextCursor && h("button", { type: "button", disabled: state.busy, onClick: () => void traceController.more() },
            state.busy ? "读取下一页…" : `读取下一页 · 已读 ${state.facts.length}/${state.total}`),
          h("p", { className: "sa-trace-meta" }, "Trace 查询、展开和导出只读取持久事实；不会调用模型、执行工具、回答等待或恢复任务。"));
      }
      return { ConversationTrace };
    }
    return {
      createTraceController, groupConversationFacts, createTrace, buildTraceExport,
      contentSearchHit, coverageText,
    };
  },
});
