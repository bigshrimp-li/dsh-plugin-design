window.__ModuleLoader__.load({ id: "@super-agent/dsh-bridge", chunk: "client.delegations.js", factory() {
  const childStates = { created: "已创建", running: "运行中", completed: "已完成", cancelled: "已取消", failed: "失败" };
  const reportStates = { pending: "等待交付", incorporated: "已交付", processed: "已交付", suppressed: "已停止交付" };
  function reportProcessing(item) {
    if (item.deliveryState !== "processed") return "尚无处理记录";
    if (!item.receivedByRunId) return "已处理，接收任务未记录";
    return item.receivedByRunId === item.parentRunId ? "已由原父任务处理" : "已由后续任务处理，原父任务未处理此报告";
  }
  // A delegation has exactly one user cancellation intent; the immutable ID also survives a Host restart.
  const cancellationId = id => "dsh-delegation-cancel:" + id;
  function createDelegations({ kernel: { React, h }, controller }) {
    return function Delegations({ targetId, threadId, conversationId, runId }) {
      const [page, setPage] = React.useState(null), [detail, setDetail] = React.useState(null);
      const [busy, setBusy] = React.useState(true), [error, setError] = React.useState(""), [notice, setNotice] = React.useState("");
      const generation = React.useRef(0), lock = React.useRef(false);
      const call = (action, payload = {}) => controller.resource("delegation." + action, { targetId, threadId, conversationId, runId, ...payload });
      function work(fn) {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError("");
        const version = generation.current, active = () => version === generation.current;
        void fn(active).catch(failure => {
          if (active()) { setError(failure.message); setDetail(null); setPage(null); setNotice(""); }
        }).finally(() => { if (active()) { lock.current = false; setBusy(false); } });
      }
      function list(append = false) {
        work(async active => {
          if (!append) { setDetail(null); setNotice(""); }
          const result = await call("list", { limit: 20, ...(append ? { scope: page.scope, cursor: page.nextCursor } : {}) });
          if (!active()) return;
          setPage(current => ({ ...result, items: [...new Map([...(append ? current?.items || [] : []), ...result.items].map(item => [item.id, item])).values()] }));
        });
      }
      React.useEffect(() => {
        list(); return () => { generation.current++; lock.current = false; };
      }, [targetId, threadId, conversationId, runId]);
      const select = id => work(async active => {
        setDetail(null); setNotice("");
        const item = await call("get", { delegationId: id, scope: page.scope });
        if (active()) setDetail(item);
      });
      const cancel = () => work(async active => {
        const id = detail.id, args = { delegationId: id, scope: page.scope };
        const requestId = cancellationId(id);
        try {
          const receipt = await call("cancel", { ...args, requestId });
          if (receipt.requestId !== requestId || receipt.resourceId !== id || receipt.state !== "accepted")
            throw new Error("服务未返回可核对的取消回执。");
          if (active()) setNotice("服务已接收取消请求；子任务状态以下方读取结果为准。");
        } catch (failure) {
          if (active()) setError(failure.message + " 请核对当前状态；重试会使用原请求编号。");
        }
        if (!active()) return;
        // A receipt may arrive before the child terminates; a failed response may have been accepted.
        const item = await call("get", args);
        if (active()) setDetail(item);
      });
      return h("section", { className: "sa-run-card", "aria-label": "本任务发出的委派", "aria-busy": busy },
        h("h4", null, "本任务发出的委派"),
        page?.items.length === 0 && h("p", { className: "sa-muted" }, page.nextCursor ? "本页没有此任务的委派。" : "没有此任务的委派记录。"),
        ...(page?.items || []).map(item => h("button", { type: "button", key: item.id, disabled: busy, "aria-pressed": detail?.id === item.id,
          onClick: () => select(item.id) }, `${item.agentId} · ${item.id}`)),
        page?.nextCursor && h("button", { type: "button", disabled: busy, onClick: () => list(true) }, "读取下一页"),
        !page && !busy && h("button", { type: "button", onClick: () => list() }, "重新读取委派"),
        detail && h("div", null,
          h("p", null, `子任务：${childStates[detail.status] || "状态未知"}`),
          h("p", null, `报告交付：${reportStates[detail.deliveryState] || (detail.mode === "sync" ? "同步返回，见任务轨迹" : "尚无交付记录")}`),
          h("p", null, `报告处理：${reportProcessing(detail)}${detail.receivedByRunId ? " · 接收任务 " + detail.receivedByRunId : ""}`),
          h("details", null, h("summary", null, "关联任务与报告"), h("p", null, "父任务：" + detail.parentRunId),
            h("p", null, "子任务：" + (detail.childRunId || "尚未创建")),
            detail.resultRef && h("p", null, "报告引用：" + detail.resultRef)),
          h("button", { type: "button", disabled: busy, onClick: () => select(detail.id) }, "刷新委派状态"),
          detail.allowedActions?.includes("cancel") && h("button", { type: "button", disabled: busy, onClick: cancel }, "取消此委派")),
        busy && h("p", { role: "status", className: "sa-muted" }, "正在核对委派…"),
        notice && h("p", { role: "status" }, notice), error && h("p", { role: "alert", className: "sa-error" }, error));
    };
  }
  return { createDelegations };
} });
