/**
 * Member detail of the bridge's client bundle, loaded as a package-local chunk.
 *
 * This module owns the drill-in the Observe page hosts: given one member of the
 * observation — an entry Run, a sub-agent, or a tool — it draws that member's
 * facts and, in demo, the per-Turn trace the sample declares. The Observe page
 * renders it through `parts.MemberDetail`, which the entry fills from this
 * module's `createObservationDetail`; the detail carries its own action control
 * (`parts.ActionBtn`), and every action reports itself as unwired because M1 has
 * no Core.
 *
 * Like every page module, its sample content is declared here and read only
 * through `services.fixture("observationDetail")`, so a trace reaches the
 * interface only while demo is explicitly on.
 *
 * See `docs/requirements/dsh-integration/DSH界面验收.md` for the chunk-loading rules this file follows.
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  chunk: "client.observation-detail.js",
  factory() {
    /** The trace table's columns, with the widths the detail lays them out at. */
    const TRACE_COLUMNS = [
      { id: "turn", labelKey: "detail.trace.turn", basis: "0 0 44px" },
      { id: "input", labelKey: "detail.trace.input", basis: "0 0 64px", align: "right" },
      { id: "output", labelKey: "detail.trace.output", basis: "0 0 64px", align: "right" },
      { id: "cacheRead", labelKey: "detail.trace.cacheRead", basis: "0 0 64px", align: "right" },
      { id: "cacheWrite", labelKey: "detail.trace.cacheWrite", basis: "0 0 64px", align: "right" },
      { id: "toolCalls", labelKey: "detail.trace.toolCalls", basis: "0 0 56px", align: "right" },
      { id: "duration", labelKey: "detail.trace.duration", basis: "1 1 auto", align: "right" },
    ];

    // #region dictionary
    const zh = {
      "detail.title": "成员详情",
      "detail.close": "关闭",
      "detail.empty": "选择一个成员查看详情。",
      "detail.value.unknown": "未知",

      "detail.kind.run": "入口 Run",
      "detail.kind.subagent": "子 Agent",
      "detail.kind.tool": "工具",

      "detail.status.running": "运行中",
      "detail.status.done": "已完成",
      "detail.status.failed": "失败",
      "detail.status.unknown": "未知",

      "detail.mode.sync": "同步",
      "detail.mode.async": "异步",

      "detail.field.id": "id",
      "detail.field.kind": "类型",
      "detail.field.status": "状态",
      "detail.field.mode": "模式",
      "detail.field.description": "说明",
      "detail.field.turns": "Turn",
      "detail.field.tokens": "Token（输入 / 输出）",
      "detail.field.exposedRuns": "曝光 Run",
      "detail.field.calls": "调用次数",
      "detail.field.successRate": "成功率",
      "detail.field.rejects": "拒绝",
      "detail.field.cancelled": "执行前取消",
      "detail.field.latency": "p50 / p95",

      "detail.trace.title": "Trace · 按 Turn",
      "detail.trace.empty": "无 Trace 记录",
      "detail.trace.turn": "Turn",
      "detail.trace.input": "输入",
      "detail.trace.output": "输出",
      "detail.trace.cacheRead": "缓存读",
      "detail.trace.cacheWrite": "缓存写",
      "detail.trace.toolCalls": "工具调用",
      "detail.trace.duration": "耗时",

      "detail.action.viewTrace": "查看 Trace",
    };

    /** English copy — the same key set as {@link zh}. */
    const en = {
      "detail.title": "Member detail",
      "detail.close": "Close",
      "detail.empty": "Select a member to see its detail.",
      "detail.value.unknown": "unknown",

      "detail.kind.run": "Entry Run",
      "detail.kind.subagent": "Subagent",
      "detail.kind.tool": "Tool",

      "detail.status.running": "running",
      "detail.status.done": "done",
      "detail.status.failed": "failed",
      "detail.status.unknown": "unknown",

      "detail.mode.sync": "Sync",
      "detail.mode.async": "Async",

      "detail.field.id": "id",
      "detail.field.kind": "Kind",
      "detail.field.status": "Status",
      "detail.field.mode": "Mode",
      "detail.field.description": "Description",
      "detail.field.turns": "Turns",
      "detail.field.tokens": "Tokens (input / output)",
      "detail.field.exposedRuns": "Exposed Runs",
      "detail.field.calls": "Calls",
      "detail.field.successRate": "Success rate",
      "detail.field.rejects": "Refusals",
      "detail.field.cancelled": "Pre-execution cancellations",
      "detail.field.latency": "p50 / p95",

      "detail.trace.title": "Trace · by Turn",
      "detail.trace.empty": "No trace records",
      "detail.trace.turn": "Turn",
      "detail.trace.input": "Input",
      "detail.trace.output": "Output",
      "detail.trace.cacheRead": "Cache read",
      "detail.trace.cacheWrite": "Cache write",
      "detail.trace.toolCalls": "Tool calls",
      "detail.trace.duration": "Duration",

      "detail.action.viewTrace": "View trace",
    };
    // #endregion

    /** Resolve `{name}` placeholders in one dictionary entry. */
    function interpolate(dictionary, key, params) {
      const raw = dictionary[key];
      if (raw === undefined) return key;
      return raw.replace(/\{(\w+)\}/g, (match, name) =>
        params && Object.hasOwn(params, name) ? String(params[name]) : match,
      );
    }

    /** A count that keeps a measured zero apart from an unknown value. */
    function countText(value, t) {
      if (value === null || value === undefined) return t("detail.value.unknown");
      return String(value);
    }

    /** Compact token counts: 1_420_000 -> "1.42M", 186_000 -> "186K". */
    function compactTokens(value, t) {
      if (value === null || value === undefined) return t("detail.value.unknown");
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
      return String(value);
    }

    /** The success-rate text a tool member carries, or the honest stand-in. */
    function successRateText(rate, t) {
      if (rate === null || rate === undefined) return t("detail.value.unknown");
      if (rate.denominator === 0) return "N/A";
      if (rate.numerator === null || rate.numerator === undefined || rate.denominator === null || rate.denominator === undefined) {
        return t("detail.value.unknown");
      }
      return `${Math.round((rate.numerator / rate.denominator) * 100)}% (${rate.numerator}/${rate.denominator})`;
    }

    /** One of the statuses the detail knows; anything else is `unknown`. */
    function statusKey(status) {
      return status === "running" || status === "done" || status === "failed" ? status : "unknown";
    }

    /**
     * Build the member detail against one activation's kernel, services and parts.
     * @param options.kernel - shared React/primitives/hooks from the entry.
     * @param options.services - the service facade holding the injected state.
     * @param options.parts - the shared controls; `ActionBtn` from the shell.
     * @returns the detail component, this module's dictionary slice and its demo fixture.
     */
    function createObservationDetail({ kernel, services, parts = {} }) {
      const { h, Style, Field } = kernel;

      /** The fallback translator for a component a seat handed no `t`. */
      const fallbackT = (key, params) => interpolate(zh, key, params);

      /** The action control, or nothing when the entry has not supplied one. */
      function action(id, label) {
        const ActionBtn = parts.ActionBtn;
        if (typeof ActionBtn !== "function") return null;
        return h(ActionBtn, { id }, label);
      }

      /** One member's facts, and in demo the per-Turn trace declared for it. */
      function MemberDetail(props) {
        const t = props.t ?? fallbackT;
        const member = props.member ?? null;
        const onClose = props.onClose;

        if (member === null) {
          return h(
            "div",
            { className: "sap-root sap-card", "data-member-detail": "none" },
            Style(),
            h("div", { className: "sap-empty" }, t("detail.empty")),
          );
        }

        const fixture = services.fixture("observationDetail");
        const traces = fixture?.traces?.[member.id] ?? null;
        const kind = member.kind === "subagent" ? "subagent" : member.kind === "tool" ? "tool" : "run";

        const fields = [];
        const addField = (labelKey, value) => {
          if (value === undefined) return;
          fields.push(h(Field, { key: labelKey, label: t(labelKey), value }));
        };
        addField("detail.field.id", String(member.id));
        addField("detail.field.kind", t(`detail.kind.${kind}`));
        if (member.mode !== undefined) addField("detail.field.mode", t(member.mode === "async" ? "detail.mode.async" : "detail.mode.sync"));
        if (member.status !== undefined) addField("detail.field.status", t(`detail.status.${statusKey(member.status)}`));
        if (member.description !== undefined) addField("detail.field.description", member.description);
        if (member.turns !== undefined) addField("detail.field.turns", countText(member.turns, t));
        if (member.tokens !== undefined) {
          addField(
            "detail.field.tokens",
            member.tokens === null
              ? t("detail.value.unknown")
              : `${compactTokens(member.tokens.input, t)} / ${compactTokens(member.tokens.output, t)}`,
          );
        }
        if (member.exposedRuns !== undefined) addField("detail.field.exposedRuns", countText(member.exposedRuns, t));
        if (member.calls !== undefined) addField("detail.field.calls", countText(member.calls, t));
        if (member.successRate !== undefined) addField("detail.field.successRate", successRateText(member.successRate, t));
        if (member.rejects !== undefined) addField("detail.field.rejects", countText(member.rejects, t));
        if (member.cancelled !== undefined) addField("detail.field.cancelled", countText(member.cancelled, t));
        if (member.p50 !== undefined || member.p95 !== undefined) {
          addField("detail.field.latency", `${member.p50 ?? t("detail.value.unknown")} / ${member.p95 ?? t("detail.value.unknown")}`);
        }

        const cellStyle = (column) => ({ flex: column.basis, textAlign: column.align ?? "left" });
        const trace =
          traces === null
            ? h("div", { className: "sap-empty", key: "trace-empty" }, t("detail.trace.empty"))
            : [
                h(
                  "div",
                  { className: "sap-table-head", key: "trace-head" },
                  TRACE_COLUMNS.map((column) => h("span", { key: column.id, style: cellStyle(column) }, t(column.labelKey))),
                ),
                ...traces.map((entry) =>
                  h(
                    "div",
                    { className: "sap-table-row", key: entry.turn, "data-trace": String(entry.turn) },
                    h("span", { className: "sap-mono", style: cellStyle(TRACE_COLUMNS[0]) }, String(entry.turn)),
                    h("span", { className: "sap-mono", style: cellStyle(TRACE_COLUMNS[1]) }, compactTokens(entry.input, t)),
                    h("span", { className: "sap-mono", style: cellStyle(TRACE_COLUMNS[2]) }, compactTokens(entry.output, t)),
                    h("span", { className: "sap-mono", style: cellStyle(TRACE_COLUMNS[3]) }, compactTokens(entry.cacheRead, t)),
                    h("span", { className: "sap-mono", style: cellStyle(TRACE_COLUMNS[4]) }, compactTokens(entry.cacheWrite, t)),
                    h("span", { className: "sap-mono", style: cellStyle(TRACE_COLUMNS[5]) }, countText(entry.toolCalls, t)),
                    h("span", { className: "sap-mono", style: cellStyle(TRACE_COLUMNS[6]) }, entry.duration ?? t("detail.value.unknown")),
                  ),
                ),
              ];

        return h(
          "div",
          { className: "sap-root sap-card", "data-member-detail": String(member.id) },
          Style(),
          h(
            "div",
            { className: "sap-card-head" },
            h("span", { className: "sap-card-title" }, t("detail.title")),
            h("span", { className: "sap-tag" }, t(`detail.kind.${kind}`)),
            h("span", { className: "sap-spacer" }),
            h(
              "button",
              { type: "button", className: "sap-link", "data-detail-close": "true", onClick: () => onClose?.() },
              t("detail.close"),
            ),
          ),
          h("div", { className: "sap-tooltitle" }, member.name),
          h("div", { className: "sap-card" }, fields),
          h("div", { className: "sap-card-title" }, t("detail.trace.title")),
          trace,
          action(`detail.viewTrace:${member.id}`, t("detail.action.viewTrace")),
        );
      }

      return {
        MemberDetail,
        dictionary: { zh, en },
        demoFixture: DEMO,
      };
    }

    /**
     * The member-detail sample the demo state renders.
     *
     * The trace rows are declared per member id and read only through
     * `services.fixture("observationDetail")`, so a trace appears only while demo
     * is explicitly on. M4 replaces this with the Core trace adapter.
     */
    const DEMO = {
      observationDetail: {
        traces: {
          run_7f3c: [
            { turn: 1, input: 12000, output: 1800, cacheRead: 9000, cacheWrite: 1200, toolCalls: 2, duration: "1.4s" },
            { turn: 2, input: 15000, output: 2400, cacheRead: 11000, cacheWrite: 1400, toolCalls: 3, duration: "2.1s" },
            { turn: 3, input: 15000, output: 1800, cacheRead: 12000, cacheWrite: 1600, toolCalls: 1, duration: "0.9s" },
          ],
          sa_researcher: [
            { turn: 1, input: 8000, output: 1200, cacheRead: 6000, cacheWrite: 800, toolCalls: 4, duration: "3.2s" },
            { turn: 2, input: 9000, output: 1500, cacheRead: 7000, cacheWrite: 900, toolCalls: 2, duration: "2.4s" },
            { turn: 3, input: 9000, output: 1500, cacheRead: 7000, cacheWrite: 900, toolCalls: 1, duration: "1.8s" },
            { turn: 4, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, duration: "0.2s" },
          ],
          sa_planner: [
            { turn: 1, input: 5000, output: 800, cacheRead: 4000, cacheWrite: 500, toolCalls: 1, duration: "1.1s" },
            { turn: 2, input: 4000, output: 700, cacheRead: 3500, cacheWrite: 400, toolCalls: 0, duration: "0.6s" },
          ],
        },
      },
    };

    return { createObservationDetail };
  },
});
