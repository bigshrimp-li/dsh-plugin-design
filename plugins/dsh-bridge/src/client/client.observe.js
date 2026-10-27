/**
 * Observe page of the bridge's client bundle, loaded as a package-local chunk.
 *
 * M1 draws the observability surface, not the observation. This module owns the
 * time-window and entry-scope filters, the key metrics with their numerator and
 * denominator, the tool ranking, the Run/Turn token view and the data-quality
 * panel — the shape of the design in `view/Observe.html`.
 *
 * Every number on the page comes from the demo fixture declared at the bottom of
 * this file, and it appears only while demo is explicitly on: the fixture read
 * goes through `services.fixture("observe")`, which answers `null` otherwise.
 * With demo off the same layout renders `unknown` where M1 has no fact, because
 * there is no Core to read one from; nothing here fabricates a statistic. M4
 * replaces the adapter behind the fixture and this layout stays.
 *
 * A chunk cannot require a sibling chunk, so the shared card, the field, the
 * action button and the member detail arrive through `kernel` and `parts`. The
 * entry fills `parts.MemberDetail` after `createObservationDetail` returns, so
 * it is read at render time rather than captured here.
 *
 * See `docs/requirements/dsh-integration/DSH界面验收.md` for the chunk-loading rules this file follows.
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  chunk: "client.observe.js",
  factory() {
    /** Time windows the filter offers, in the order the design shows them. */
    const WINDOWS = ["24h", "7d", "30d"];
    /** Entry scopes the filter offers; `all` is the union of the other two. */
    const SCOPES = ["entry", "subagent", "all"];
    /** Demo scenarios the fixture declares, in the order the demo control shows them. */
    const SCENARIOS = ["normal", "zero", "unknown", "unsupported", "error"];
    const DEFAULT_WINDOW = "24h";
    const DEFAULT_SCOPE = "entry";
    const DEFAULT_GRANULARITY = "run";

    /** The key metrics, each with the unit its numerator/denominator line names. */
    const METRICS = [
      { id: "toolRequestRate", labelKey: "metric.toolRequestRate", unitKey: "metric.unit.exposedRuns" },
      { id: "toolSuccessRate", labelKey: "metric.toolSuccessRate", unitKey: "metric.unit.started" },
      { id: "subagentStartRate", labelKey: "metric.subagentStartRate", unitKey: "metric.unit.exposedRuns" },
      { id: "skillReadRate", labelKey: "metric.skillReadRate", unitKey: "metric.unit.exposedRuns" },
    ];

    /** The tool table's columns, with the fixed widths the design lays them out at. */
    const TOOL_COLUMNS = [
      { id: "tool", labelKey: "tools.col.tool", basis: "0 0 68px" },
      { id: "exposedRuns", labelKey: "tools.col.exposedRuns", basis: "0 0 52px", align: "right" },
      { id: "requestRate", labelKey: "tools.col.requestRate", basis: "0 0 74px", align: "right" },
      { id: "calls", labelKey: "tools.col.calls", basis: "0 0 44px", align: "right" },
      { id: "successRate", labelKey: "tools.col.successRate", basis: "0 0 56px", align: "right" },
      { id: "latency", labelKey: "tools.col.latency", basis: "1 1 auto", align: "right" },
    ];

    /** Attribute marking this page's own stylesheet element. */
    const OBSERVE_STYLE_ID = "@super-agent/dsh-bridge/observe.css";

    /**
     * The few rules this page owns. The shared sheet already carries the tokens,
     * the cards, the metrics and the tables; this adds only the segmented filter
     * and the filter row, which no other page draws.
     */
    const OBSERVE_CSS = [
      ".sap-obs{display:flex;flex-direction:column;gap:10px}",
      ".sap-obs-filterrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".sap-obs-filterlabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".sap-obs-seg{display:inline-flex;align-items:center;gap:2px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:2px}",
      ".sap-obs-seg-btn{height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".sap-obs-seg-btn[data-active=true]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);font-weight:500}",
      ".sap-obs-meta{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
      ".sap-obs-link{border:0;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-link);cursor:pointer;padding:0}",
    ].join("");

    // #region dictionary
    const zh = {
      "observe.filter.window": "时间窗口",
      "observe.filter.scope": "范围",
      "observe.window.24h": "最近 24 小时",
      "observe.window.7d": "最近 7 天",
      "observe.window.30d": "最近 30 天",
      "observe.scope.entry": "入口 Run",
      "observe.scope.subagent": "子 Agent",
      "observe.scope.all": "全部",

      "observe.meta.asOf": "asOf {value}",
      "observe.meta.watermark": "索引水位 {value}",
      "observe.meta.running": "仍在运行 {value}",
      "observe.meta.unknown": "未知 {value}",
      "observe.meta.coverage": "覆盖率 {value}",

      "observe.value.unknown": "未知",
      "observe.value.na": "N/A",
      "observe.value.unsupported": "不支持",
      "observe.value.uncovered": "未覆盖",

      "observe.metrics.title": "关键指标",
      "observe.metrics.note": "分母为零返回 N/A",

      "observe.tools.title": "Tool 排行",
      "observe.tools.viewAll": "查看全部",
      "observe.tools.empty": "本窗口没有工具调用记录",
      "observe.tools.unsupported": "该维度 Core 未提供，暂不支持",
      "observe.tools.footnote": "成功率同时给出分子与分母；拒绝 {rejects} 次、执行前取消 {cancelled} 次单列，不并入失败。",

      "observe.tokens.title": "Token 用量",
      "observe.tokens.byRun": "按 Run",
      "observe.tokens.byTurn": "按 Turn",
      "observe.tokens.input": "输入",
      "observe.tokens.output": "输出",
      "observe.tokens.cacheRead": "缓存读",
      "observe.tokens.cacheWrite": "缓存写",
      "observe.tokens.costUnknown": "costKnown = false · 未配置价格，只展示 token，不折算费用。",

      "observe.quality.title": "数据质量",
      "observe.quality.note": "进行中的 cohort 标为 provisional",
      "observe.quality.unindexed": "未索引记录",
      "observe.quality.droppedFrames": "订阅丢帧",
      "observe.quality.missingExposure": "缺少曝光",
      "observe.quality.exportBacklog": "导出积压",
      "observe.quality.footnote": "无记录 ≠ 未触发；缺少曝光与来源不明的调用不并入分子。",

      "observe.members.title": "成员",
      "observe.members.empty": "当前范围没有成员",
      "observe.members.view": "查看",
      "observe.member.kind.run": "入口 Run",
      "observe.member.kind.subagent": "子 Agent",

      "observe.production.note": "观测服务未连接，当前没有可用的查询结果。",
      "observe.demo.scenario": "演示场景",
      "observe.scenario.normal": "正常",
      "observe.scenario.zero": "零分母",
      "observe.scenario.unknown": "未知",
      "observe.scenario.unsupported": "不支持",
      "observe.scenario.error": "错误",

      "observe.error.title": "观测数据读取失败",
      "observe.error.retry": "重试",
      "observe.detail.unavailable": "成员详情区域未接入。",

      "metric.toolRequestRate": "工具请求触发率",
      "metric.toolSuccessRate": "工具执行成功率",
      "metric.subagentStartRate": "Subagent 启动率",
      "metric.skillReadRate": "Skill 读取率",
      "metric.unit.exposedRuns": "曝光 Run",
      "metric.unit.started": "已开始执行",
      "metric.detail": "{numerator} / {denominator} {unit}",
      "metric.noExposure": "本窗口无曝光",

      "tools.col.tool": "工具",
      "tools.col.exposedRuns": "曝光 Run",
      "tools.col.requestRate": "请求触发率",
      "tools.col.calls": "次数",
      "tools.col.successRate": "成功率",
      "tools.col.latency": "p50 / p95",
    };

    /** English copy — the same key set as {@link zh}. */
    const en = {
      "observe.filter.window": "Time window",
      "observe.filter.scope": "Scope",
      "observe.window.24h": "Last 24 hours",
      "observe.window.7d": "Last 7 days",
      "observe.window.30d": "Last 30 days",
      "observe.scope.entry": "Entry Run",
      "observe.scope.subagent": "Subagent",
      "observe.scope.all": "All",

      "observe.meta.asOf": "asOf {value}",
      "observe.meta.watermark": "index watermark {value}",
      "observe.meta.running": "running {value}",
      "observe.meta.unknown": "unknown {value}",
      "observe.meta.coverage": "coverage {value}",

      "observe.value.unknown": "unknown",
      "observe.value.na": "N/A",
      "observe.value.unsupported": "unsupported",
      "observe.value.uncovered": "not covered",

      "observe.metrics.title": "Key metrics",
      "observe.metrics.note": "N/A when the denominator is zero",

      "observe.tools.title": "Tool ranking",
      "observe.tools.viewAll": "View all",
      "observe.tools.empty": "No tool calls in this window",
      "observe.tools.unsupported": "Core does not provide this dimension yet",
      "observe.tools.footnote":
        "Success rate shows its numerator and denominator; {rejects} refusals and {cancelled} pre-execution cancellations are listed separately and are not counted as failures.",

      "observe.tokens.title": "Token usage",
      "observe.tokens.byRun": "By Run",
      "observe.tokens.byTurn": "By Turn",
      "observe.tokens.input": "Input",
      "observe.tokens.output": "Output",
      "observe.tokens.cacheRead": "Cache read",
      "observe.tokens.cacheWrite": "Cache write",
      "observe.tokens.costUnknown": "costKnown = false · no price configured, so only tokens are shown and no cost is derived.",

      "observe.quality.title": "Data quality",
      "observe.quality.note": "In-progress cohorts are marked provisional",
      "observe.quality.unindexed": "Unindexed records",
      "observe.quality.droppedFrames": "Dropped frames",
      "observe.quality.missingExposure": "Missing exposure",
      "observe.quality.exportBacklog": "Export backlog",
      "observe.quality.footnote":
        "No record ≠ not triggered; missing exposure and unattributed calls are not counted in the numerator.",

      "observe.members.title": "Members",
      "observe.members.empty": "No members in this scope",
      "observe.members.view": "View",
      "observe.member.kind.run": "Entry Run",
      "observe.member.kind.subagent": "Subagent",

      "observe.production.note": "The observation service is disconnected. No query results are available.",
      "observe.demo.scenario": "Demo scenario",
      "observe.scenario.normal": "Normal",
      "observe.scenario.zero": "Zero denominator",
      "observe.scenario.unknown": "Unknown",
      "observe.scenario.unsupported": "Unsupported",
      "observe.scenario.error": "Error",

      "observe.error.title": "Reading the observation data failed",
      "observe.error.retry": "Retry",
      "observe.detail.unavailable": "The member detail area is not wired up.",

      "metric.toolRequestRate": "Tool request rate",
      "metric.toolSuccessRate": "Tool success rate",
      "metric.subagentStartRate": "Subagent start rate",
      "metric.skillReadRate": "Skill read rate",
      "metric.unit.exposedRuns": "exposed Runs",
      "metric.unit.started": "started executions",
      "metric.detail": "{numerator} / {denominator} {unit}",
      "metric.noExposure": "no exposure in this window",

      "tools.col.tool": "Tool",
      "tools.col.exposedRuns": "Exposed Runs",
      "tools.col.requestRate": "Request rate",
      "tools.col.calls": "Calls",
      "tools.col.successRate": "Success rate",
      "tools.col.latency": "p50 / p95",
    };
    // #endregion

    // #region formatting
    /** Resolve `{name}` placeholders in one dictionary entry. */
    function interpolate(dictionary, key, params) {
      const raw = dictionary[key];
      if (raw === undefined) return key;
      return raw.replace(/\{(\w+)\}/g, (match, name) =>
        params && Object.hasOwn(params, name) ? String(params[name]) : match,
      );
    }

    /**
     * Classify one rate.
     *
     * The four outcomes are the four the design distinguishes: a measured value,
     * a zero denominator (`na`, which the page shows as N/A rather than 0%), an
     * absent numerator or denominator (`unknown`), and a dimension Core does not
     * provide (`unsupported`). Keeping them apart is the point — a zero
     * denominator is not a failure and not an unknown.
     */
    function rateParts(rate) {
      if (rate === null || rate === undefined) return { state: "unknown" };
      if (rate.unsupported === true) return { state: "unsupported" };
      const numerator = rate.numerator;
      const denominator = rate.denominator;
      if (denominator === 0) return { state: "na", numerator, denominator };
      if (numerator === null || numerator === undefined || denominator === null || denominator === undefined) {
        return { state: "unknown", numerator, denominator };
      }
      return { state: "value", numerator, denominator, percent: Math.round((numerator / denominator) * 100) };
    }

    /** The big line of a metric tile or a rate cell. */
    function rateValueText(parts, t) {
      if (parts.state === "na") return t("observe.value.na");
      if (parts.state === "unknown") return t("observe.value.unknown");
      if (parts.state === "unsupported") return t("observe.value.unsupported");
      return `${parts.percent}%`;
    }

    /** The small line under a metric: its numerator and denominator with their unit. */
    function rateDetailText(parts, unit, t) {
      if (parts.state === "na") return t("metric.noExposure");
      if (parts.state === "unknown") return t("observe.value.unknown");
      if (parts.state === "unsupported") return "";
      return t("metric.detail", { numerator: parts.numerator, denominator: parts.denominator, unit });
    }

    /** A count that keeps a measured zero apart from an unknown and an uncovered value. */
    function countText(value, t) {
      if (value === null || value === undefined) return t("observe.value.unknown");
      if (value === "uncovered") return t("observe.value.uncovered");
      return String(value);
    }

    /** Compact token counts: 1_420_000 -> "1.42M", 186_000 -> "186K". */
    function compactTokens(value, t) {
      if (value === null || value === undefined) return t("observe.value.unknown");
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
      return String(value);
    }
    // #endregion

    /**
     * Build the Observe page against one activation's kernel, services and parts.
     * @param options.kernel - shared React/primitives/hooks from the entry.
     * @param options.services - the service facade holding the injected state.
     * @param options.parts - the shared controls: `ActionBtn` from the shell, and
     * `MemberDetail` from the observation-detail module once it has loaded.
     * @returns the tab body, this module's dictionary slice and its demo fixture.
     */
    function createObserveView({ kernel, services, parts = {} }) {
      const { React, h, Style, Card, Field, Dot, useStore } = kernel;

      /** The fallback translator for a component a seat handed no `t`. */
      const fallbackT = (key, params) => interpolate(zh, key, params);

      /** One segmented filter: a pure interface control, so it never raises an action. */
      function Segmented({ options, value, onSelect }) {
        return h(
          "span",
          { className: "sap-obs-seg" },
          options.map((option) =>
            h(
              "button",
              {
                key: option.id,
                type: "button",
                className: "sap-obs-seg-btn",
                "data-active": value === option.id ? "true" : undefined,
                "data-option": option.id,
                onClick: () => onSelect(option.id),
              },
              option.label,
            ),
          ),
        );
      }

      /** One metric tile: the value, then its numerator and denominator. */
      function MetricTile({ t, metric, rate }) {
        const info = rateParts(rate);
        const value = rateValueText(info, t);
        return h(
          "div",
          { className: "sap-metric", "data-metric": metric.id, "data-state": info.state },
          h("div", { className: "sap-metric-label" }, t(metric.labelKey)),
          h("div", { className: "sap-metric-value sap-mono", "data-value": value }, value),
          h("div", { className: "sap-metric-detail sap-mono" }, rateDetailText(info, t(metric.unitKey), t)),
        );
      }

      /** The tool ranking: a header, one row per tool, and the caveat under it. */
      function ToolTable({ t, tools, totals }) {
        if (tools === null) return h("div", { className: "sap-unavailable" }, t("observe.tools.unsupported"));
        if (tools.length === 0) return h("div", { className: "sap-empty" }, t("observe.tools.empty"));
        const cellStyle = (column) => ({ flex: column.basis, textAlign: column.align ?? "left" });
        return [
          h(
            "div",
            { className: "sap-table-head", key: "head" },
            TOOL_COLUMNS.map((column) => h("span", { key: column.id, style: cellStyle(column) }, t(column.labelKey))),
          ),
          ...tools.map((tool) => {
            const request = rateParts(tool.requestRate);
            const success = rateParts(tool.successRate);
            return h(
              "div",
              {
                className: "sap-table-row",
                key: tool.id,
                "data-tool": tool.id,
                "data-rejects": String(tool.rejects ?? ""),
                "data-cancelled": String(tool.cancelled ?? ""),
              },
              h("span", { className: "sap-mono", style: cellStyle(TOOL_COLUMNS[0]) }, tool.name),
              h("span", { className: "sap-mono", style: cellStyle(TOOL_COLUMNS[1]) }, countText(tool.exposedRuns, t)),
              h("span", { className: "sap-mono", style: cellStyle(TOOL_COLUMNS[2]) }, rateValueText(request, t)),
              h("span", { className: "sap-mono", style: cellStyle(TOOL_COLUMNS[3]) }, countText(tool.calls, t)),
              h(
                "span",
                {
                  className: "sap-mono",
                  style: cellStyle(TOOL_COLUMNS[4]),
                  "data-success-rate": rateValueText(success, t),
                  "data-numerator": success.numerator === undefined ? "" : String(success.numerator),
                  "data-denominator": success.denominator === undefined ? "" : String(success.denominator),
                },
                rateValueText(success, t),
                success.state === "value"
                  ? h("span", { className: "sap-muted" }, ` ${success.numerator}/${success.denominator}`)
                  : null,
              ),
              h(
                "span",
                { className: "sap-mono", style: cellStyle(TOOL_COLUMNS[5]) },
                `${tool.p50 ?? t("observe.value.unknown")} / ${tool.p95 ?? t("observe.value.unknown")}`,
              ),
            );
          }),
          h("div", { className: "sap-metric-detail", key: "foot" }, t("observe.tools.footnote", totals)),
        ];
      }

      /** The token view: the selected granularity's four counts and the cost caveat. */
      function TokenGrid({ t, tokens, granularity }) {
        const values = granularity === "turn" ? tokens?.byTurn : tokens?.byRun;
        const cells = [
          { id: "input", labelKey: "observe.tokens.input", value: values?.input },
          { id: "output", labelKey: "observe.tokens.output", value: values?.output },
          { id: "cacheRead", labelKey: "observe.tokens.cacheRead", value: values?.cacheRead },
          { id: "cacheWrite", labelKey: "observe.tokens.cacheWrite", value: values?.cacheWrite },
        ];
        return [
          h(
            "div",
            { className: "sap-grid4", key: "grid" },
            cells.map((cell) =>
              h(
                "div",
                { key: cell.id, "data-token": cell.id, "data-value": compactTokens(cell.value, t) },
                h("div", { className: "sap-metric-label" }, t(cell.labelKey)),
                h("div", { className: "sap-mono", style: { marginTop: 2, fontSize: 14, fontWeight: 500 } }, compactTokens(cell.value, t)),
              ),
            ),
          ),
          tokens?.costKnown === false
            ? h("div", { className: "sap-metric-detail", key: "cost" }, t("observe.tokens.costUnknown"))
            : null,
        ];
      }

      /** The data-quality panel: four counters that keep zero, unknown and uncovered apart. */
      function QualityGrid({ t, quality }) {
        const cells = [
          { id: "unindexed", labelKey: "observe.quality.unindexed" },
          { id: "droppedFrames", labelKey: "observe.quality.droppedFrames" },
          { id: "missingExposure", labelKey: "observe.quality.missingExposure" },
          { id: "exportBacklog", labelKey: "observe.quality.exportBacklog" },
        ];
        const valueOf = (id) => (quality === null || quality === undefined ? null : quality[id]);
        return [
          h(
            "div",
            { className: "sap-grid4", key: "grid" },
            cells.map((cell) => {
              const text = countText(valueOf(cell.id), t);
              return h(
                "div",
                { key: cell.id, "data-quality": cell.id, "data-value": text },
                h("div", { className: "sap-metric-label" }, t(cell.labelKey)),
                h("div", { className: "sap-mono", style: { marginTop: 2, fontSize: 14, fontWeight: 500 } }, text),
              );
            }),
          ),
          h("div", { className: "sap-metric-detail", key: "foot" }, t("observe.quality.footnote")),
        ];
      }

      /** The members of the selected scope, each row a drill-in to the member detail. */
      function MembersList({ t, members, selectedId, onSelect }) {
        if (members.length === 0) return h("div", { className: "sap-empty" }, t("observe.members.empty"));
        return members.map((member) =>
          h(
            "div",
            { className: "sap-table-row", key: member.id, "data-member": member.id },
            h("span", { className: "sap-mono", style: { flex: "1 1 auto", minWidth: 0 } }, member.name),
            h("span", { className: "sap-tag" }, t(member.kind === "subagent" ? "observe.member.kind.subagent" : "observe.member.kind.run")),
            h(Dot, { tone: member.status === "running" ? "ok" : member.status === "failed" ? "bad" : "idle" }),
            h(
              "button",
              {
                type: "button",
                className: "sap-obs-link",
                "data-member-view": member.id,
                "data-active": selectedId === member.id ? "true" : undefined,
                onClick: () => onSelect(member),
              },
              t("observe.members.view"),
            ),
          ),
        );
      }

      /**
       * The detail carrier.
       *
       * `parts.MemberDetail` is read here, at render time, because the entry fills
       * it after this module is built; capturing it at construction would freeze
       * the hole. When no module supplies one the carrier says so rather than
       * drawing an empty box that would read as "nothing to see".
       */
      function DetailHost({ t, member, onClose }) {
        const MemberDetail = parts.MemberDetail;
        if (member === null) return null;
        if (typeof MemberDetail !== "function") {
          return h("div", { className: "sap-unavailable", "data-detail": "unavailable" }, t("observe.detail.unavailable"));
        }
        return h(MemberDetail, { member, t, onClose });
      }

      /** The action control, or nothing when the entry has not supplied one. */
      function action(id, label, variant) {
        const ActionBtn = parts.ActionBtn;
        if (typeof ActionBtn !== "function") return null;
        return h(ActionBtn, { id, variant }, label);
      }

      const liveMetrics = {
        "tool.request_trigger_rate": "工具请求触发率",
        "tool.execution_success_rate": "工具执行成功率",
        "subagent.start_rate": "Subagent 启动率",
        "skill.read_rate": "Skill 读取率",
        "tool.execution_trigger_rate": "工具执行触发率",
        "skill.context_rate": "Skill 进入上下文比例",
        "subagent.request_trigger_rate": "Subagent 请求触发率",
        "subagent.sync_share": "同步委派占比",
        "subagent.async_share": "异步委派占比",
        "report.async_processing_rate": "异步报告处理率",
      };
      const filterLabels = {
        agentDefinitionVersion: "Agent 版本", modelBinding: "模型绑定", toolVersion: "Tool 版本",
        skillVersion: "Skill 版本", permissionMode: "权限模式", runSource: "Run 来源", deploymentVersion: "部署版本",
      };
      const encodeRef = (ref) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(ref))))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      const rowsOf = value => Array.isArray(value) ? value.filter(row => row && typeof row === "object") : [];
      function LiveObserveTab({ t = fallbackT }) {
        const api = services.observations;
        const [windowId, setWindowId] = React.useState(DEFAULT_WINDOW);
        const [scope, setScope] = React.useState(DEFAULT_SCOPE);
        const [granularity, setGranularity] = React.useState(DEFAULT_GRANULARITY);
        const [descendants, setDescendants] = React.useState(false);
        const [allMetrics, setAllMetrics] = React.useState(false);
        const [filters, setFilters] = React.useState(() => Object.fromEntries(Object.keys(filterLabels).map((key) => [key, null])));
        const [groupBy, setGroupBy] = React.useState("");
        const [refresh, setRefresh] = React.useState(0);
        const [data, setData] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [members, setMembers] = React.useState(null);
        const [detail, setDetail] = React.useState({});
        const [navigation] = React.useState(() => ({ epoch: 0 }));
        React.useEffect(() => {
          let alive = true;
          navigation.epoch += 1;
          setData(null); setMembers(null); setDetail({}); setError(null); setBusy(true);
          const until = Date.now();
          const query = {
            window: { from: new Date(until - ({ "24h": 1, "7d": 7, "30d": 30 }[windowId]) * 86400000).toISOString(),
              until: new Date(until).toISOString(), basis: "run_started_at" },
            scope: { entry: "entry_only", subagent: "subagent_only", all: "all_runs" }[scope],
            includeDescendants: descendants, filters,
            metrics: Object.keys(liveMetrics).slice(0, allMetrics ? undefined : 4),
            groupBy: groupBy ? [groupBy] : [],
          };
          const { metrics: _metrics, groupBy: _groupBy, ...shared } = query;
          Promise.allSettled([api.metrics(query), api.tools(query), api.usage({ ...shared, groupBy: granularity }), api.health()])
            .then(results => { if (!alive) return; const keys = ["metrics", "tools", "usage", "health"], next = {}; const errors = []; results.forEach((result, index) => { if (result.status === "fulfilled" && result.value && typeof result.value === "object") next[keys[index]] = result.value; else errors.push(`${keys[index]}：${result.reason?.message || "响应结构无效"}`); }); setData(next); if (errors.length) setError(errors.join("；")); })
            .catch((failure) => { if (alive) setError(`${failure.code ?? ""} ${failure.message ?? failure}`.trim()); })
            .finally(() => { if (alive) setBusy(false); });
          return () => { alive = false; navigation.epoch += 1; };
        }, [windowId, scope, granularity, descendants, allMetrics, filters, groupBy, refresh, api]);
        const drill = async (work, apply) => {
          const epoch = ++navigation.epoch;
          setError(null); setBusy(true);
          try {
            const value = await work();
            if (navigation.epoch === epoch) apply(value);
          } catch (failure) {
            if (navigation.epoch === epoch) setError(`${failure.code ?? ""} ${failure.message ?? failure}`.trim());
          } finally { if (navigation.epoch === epoch) setBusy(false); }
        };
        const button = (label, attrs, onClick) => h("button", {
          type: "button", className: "sap-obs-link", ...attrs, onClick,
        }, label);
        const showTrace = (id) => drill(() => api.trace(id), (trace) => setDetail({ trace }));
        const showMembers = (metric, side, cursor) => drill(
          () => api.members({ queryId: metric.queryId, side, ...(cursor ? { cursor } : {}) }),
          (page) => { setMembers({ ...page, metric }); setDetail({}); },
        );
        const snapshots = rowsOf(data?.metrics?.metrics);
        const trace = detail.trace;
        const execution = detail.execution;
        const refs = execution
          ? rowsOf(execution.attempts).flatMap((a) => [a.inputRef, a.outputRef]).filter(Boolean)
          : rowsOf(trace?.facts).flatMap((f) => rowsOf(f.contentRefs)) ?? [];
        const uniqueRefs = [...new Map(refs.map((ref) => [encodeRef(ref), ref])).entries()];
        return h("div", { className: "sap-root sap-obs", "aria-busy": busy },
          Style(), h("style", { "data-plugin-css": OBSERVE_STYLE_ID }, OBSERVE_CSS),
          h(Card, { title: "观测范围", children: [
            h("div", { className: "sap-obs-filterrow", key: "scope" },
              h(Segmented, { options: WINDOWS.map((id) => ({ id, label: t(`observe.window.${id}`) })), value: windowId, onSelect: setWindowId }),
              h(Segmented, { options: SCOPES.map((id) => ({ id, label: t(`observe.scope.${id}`) })), value: scope, onSelect: setScope }),
              h("label", {}, h("input", { type: "checkbox", checked: descendants, onChange: (e) => setDescendants(e.target.checked) }), "包含后代 Run"),
              button("刷新", {}, () => setRefresh((value) => value + 1))),
            h("details", { key: "filters" }, h("summary", {}, "版本与配置筛选"),
              Object.entries(filterLabels).map(([key, label]) => h("label", { key, style: { display: "block" } }, label,
                h("input", { "data-observation-filter": key, value: filters[key] ?? "", placeholder: "全部",
                  onChange: (e) => setFilters((current) => ({ ...current, [key]: e.target.value || null })) }))),
              h("label", {}, "分组 ", h("select", { value: groupBy, onChange: (e) => setGroupBy(e.target.value) },
                h("option", { value: "" }, "不分组"), Object.entries(filterLabels).map(([key, label]) => h("option", { key, value: key }, label))))),
            h("div", { key: "meta", className: "sap-obs-meta" },
              `asOf ${data?.metrics?.asOf ?? "未知"} · 索引水位 ${data?.metrics?.watermark ?? "未知"}`),
          ] }),
          error ? h("div", { role: "alert", className: "sap-error", "data-error": error }, error,
            button("重新查询", {}, () => setRefresh((value) => value + 1))) : null,
          busy ? h("div", { role: "status" }, "正在读取…") : null,
          h(Card, { title: "关键指标", aside: h("label", {},
            h("input", { type: "checkbox", checked: allMetrics, onChange: (e) => setAllMetrics(e.target.checked) }), "显示全部指标"),
          children: snapshots.length === 0 ? h("div", { className: "sap-empty" }, data ? "此范围没有指标记录" : "未知") :
            h("div", { className: "sap-grid2" }, snapshots.map((metric) => h("div", { key: metric.queryId, className: "sap-metric" },
              h("div", { className: "sap-metric-label" }, liveMetrics[metric.metric] ?? metric.metric),
              h("div", { className: "sap-mono" }, Object.entries(metric.group || {}).map(([key, value]) => `${filterLabels[key] ?? key}: ${value ?? "未知"}`).join(" · ")),
              h("div", { className: "sap-metric-value" }, metric.coverage?.state === "unsupported" ? "不支持" :
                metric.value === null ? metric.reason === "zero_denominator" ? "N/A" : "未知" : `${(metric.value * 100).toFixed(1)}%`),
              h("div", {}, button(`分子 ${metric.numerator ?? "未知"}`, { "data-metric-side": `${metric.metric}:numerator` }, () => showMembers(metric, "numerator")),
                " / ", button(`分母 ${metric.denominator ?? "未知"}`, { "data-metric-side": `${metric.metric}:denominator` }, () => showMembers(metric, "denominator")),
                ` · ${metric.memberType}`),
              h("div", { className: "sap-obs-meta" }, `${metric.provisional ? "暂定 · " : ""}未知 ${metric.unknownCount} · 运行中 ${metric.runningCount} · 覆盖 ${metric.coverage?.state}`),
            ))) }),
          h(Card, { title: "Tool 排行", children: h(ToolTable, {
            t, tools: rowsOf(data?.tools?.rows).map((row, index) => ({
              id: `${row.toolName}:${index}`, name: [row.toolName, ...Object.entries(row.requestTrigger?.group || {})
                .filter(([key]) => key !== "toolName").map(([, value]) => value ?? "未知")].join(" · "),
              exposedRuns: row.exposedRuns, requestRate: row.requestTrigger, successRate: row.executionSuccess,
              calls: row.logicalInvocationCount, rejects: row.outcomes?.denied, cancelled: row.outcomes?.cancelledBeforeStart,
              p50: row.executionDurationMs?.p50, p95: row.executionDurationMs?.p95,
            })), totals: { rejects: rowsOf(data?.tools?.rows).reduce((s, r) => s + (r.outcomes?.denied || 0), 0),
              cancelled: rowsOf(data?.tools?.rows).reduce((s, r) => s + (r.outcomes?.cancelledBeforeStart || 0), 0) },
          }) }),
          h(Card, { title: "Token 用量", aside: h(Segmented, {
            options: [{ id: "run", label: "按 Run" }, { id: "turn", label: "按 Turn" }, { id: "model", label: "按模型" }],
            value: granularity, onSelect: setGranularity,
          }), children: rowsOf(data?.usage?.buckets).map((bucket, index) => h("div", { key: index, className: "sap-table-row" },
            bucket.runId ? button(bucket.turnId ?? bucket.runId, {}, () => showTrace(bucket.runId)) : h("span", {}, bucket.modelId ?? "未知模型"),
            h("span", {}, bucket.purpose === "compaction" ? "上下文压缩" : bucket.purpose === "agent" ? "任务执行" : "用途未知"),
            h("span", { className: "sap-mono" }, `输入 ${bucket.inputTokens ?? "未知"} · 输出 ${bucket.outputTokens ?? "未知"} · 缓存读 ${bucket.cacheReadTokens ?? "未知"} · 缓存写 ${bucket.cacheWriteTokens ?? "未知"}`),
            h("span", {}, bucket.costKnown ? `${bucket.cost} ${bucket.currency}` : "费用未知"),
            h("span", {}, `用量未知请求 ${bucket.unknownAttempts}`))) }),
          h(Card, { title: "数据质量", children: [
            h(QualityGrid, { key: "quality", t, quality: data ? {
              unindexed: data.health?.unindexedFacts, droppedFrames: data.health?.droppedNotifications,
              missingExposure: data.health?.missingExposureRuns, exportBacklog: data.health?.remoteExport?.backlog,
            } : null }),
            h("div", { key: "coverage", className: "sap-obs-meta" },
              `索引 ${data?.health?.indexState ?? "未知"} · 事实覆盖 ${data?.health?.sourceCoverage?.state ?? "未知"}`),
          ] }),
          members ? h(Card, { title: `成员 · ${members.side === "numerator" ? "分子" : "分母"}`, children: [
            ...rowsOf(members.members).map((member) => h("div", { key: member.memberId, className: "sap-table-row" },
              h("span", {}, `${member.memberType} · ${member.memberId}`),
              member.runId ? button("查看", { "data-member-view": member.memberId }, () => showTrace(member.runId)) : h("span", {}, "所属 Run 未知"))),
            members.nextCursor ? button("下一页", { key: "next" }, () => showMembers(members.metric, members.side, members.nextCursor)) : null,
          ] }) : null,
          trace ? h(Card, { title: `Run ${trace.runId}`, aside: button("关闭详情", {}, () => setDetail({})), children: [
            button("Thread 关系图", { key: "graph", "data-thread-graph": trace.threadId },
              () => drill(() => api.graph(trace.threadId), (graph) => setDetail((current) => ({ ...current, graph })))),
            h("div", { key: "trace" }, `Trace ${trace.traceId} · 覆盖 ${trace.coverage?.state}`),
            ...rowsOf(trace.links).map((link, index) => button(`${link.kind} → ${link.runId}`, { key: `link:${index}` }, () => showTrace(link.runId))),
            ...[...new Map(rowsOf(trace.facts).filter((f) => f.executionId).map((f) => [f.executionId, f])).values()].map((fact) =>
              button(`${fact.payload?.toolName ?? "执行"} · ${fact.payload?.status}`, { key: fact.executionId, "data-execution-view": fact.executionId },
                () => drill(() => api.execution(fact.executionId), (value) => setDetail((current) => ({ ...current, execution: value, content: null }))))),
            ...rowsOf(trace.facts).filter((f) => !f.executionId).map((fact) => h("div", { key: fact.factId },
              `${fact.type} · ${fact.occurredAt ?? "时间未知"} · ${fact.payload?.status ?? fact.payload?.phase ?? ""}`)),
          ] }) : null,
          detail.graph ? h(Card, { title: "Thread 关系", children: [
            ...rowsOf(detail.graph.nodes).map((node) => h("div", { key: node.id }, `${node.kind} · ${node.id} · ${node.status ?? ""}`)),
            ...rowsOf(detail.graph.edges).map((edge, index) => h("div", { key: `edge:${index}` }, `${edge.fromId} — ${edge.kind} → ${edge.toId}`)),
          ] }) : null,
          execution ? h(Card, { title: `${execution.toolName ?? "工具"} · ${execution.status}`, children:
            rowsOf(execution.attempts).map((attempt) => h("div", { key: attempt.attemptId },
              `${attempt.attemptId} · ${attempt.status} · ${attempt.durationMs ?? "未知"} ms`)) }) : null,
          uniqueRefs.length ? h(Card, { title: "来源正文", children: uniqueRefs.map(([encoded, ref]) =>
            button(`${ref.kind} · ${ref.part}`, { key: encoded, "data-content-ref": encoded },
              () => drill(() => api.content(ref), (content) => setDetail((current) => ({ ...current, content }))))) }) : null,
          detail.content ? h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } },
            detail.content.status === "available" ? detail.content.content : `${detail.content.status} · ${detail.content.reason}`) : null,
        );
      }

      function ObserveTab(props) {
        const state = useStore(services.viewState);
        return h(state.demo !== true && services.observations ? LiveObserveTab : FixtureObserveTab, props);
      }

      /** Explicit demo and disconnected-layout carrier. */
      function FixtureObserveTab(props) {
        const t = props.t ?? fallbackT;
        const state = useStore(services.viewState);
        const demo = state.demo === true;
        const fixture = demo ? services.fixture("observe") : null;

        const [windowId, setWindowId] = React.useState(DEFAULT_WINDOW);
        const [scope, setScope] = React.useState(DEFAULT_SCOPE);
        const [granularity, setGranularity] = React.useState(DEFAULT_GRANULARITY);
        const [scenarioId, setScenarioId] = React.useState(null);
        const [selectedMember, setSelectedMember] = React.useState(null);

        const scenarioName = scenarioId ?? fixture?.defaultScenario ?? "normal";
        const scenario = fixture?.scenarios?.[scenarioName] ?? null;
        const scopeData = scenario?.scopes?.[scope] ?? scenario?.scopes?.all ?? null;
        const meta = scenario?.meta?.windows?.[windowId] ?? scenario?.meta?.windows?.[DEFAULT_WINDOW] ?? null;

        const metrics = scopeData?.metrics ?? null;
        const tools = scopeData?.tools ?? (fixture === null ? [] : null);
        const members = scopeData?.members ?? [];
        const tokens = scenario?.tokens ?? null;
        const quality = scenario?.quality ?? null;
        const totals = { rejects: 0, cancelled: 0 };
        if (Array.isArray(tools)) {
          for (const tool of tools) {
            totals.rejects += tool.rejects ?? 0;
            totals.cancelled += tool.cancelled ?? 0;
          }
        }

        const filterCard = h(
          "div",
          { className: "sap-card", key: "filter" },
          h(
            "div",
            { className: "sap-obs-filterrow" },
            h("span", { className: "sap-obs-filterlabel" }, t("observe.filter.window")),
            h(Segmented, {
              options: WINDOWS.map((id) => ({ id, label: t(`observe.window.${id}`) })),
              value: windowId,
              onSelect: setWindowId,
            }),
            h("span", { className: "sap-spacer" }),
            h("span", { className: "sap-obs-filterlabel" }, t("observe.filter.scope")),
            h(Segmented, {
              options: SCOPES.map((id) => ({ id, label: t(`observe.scope.${id}`) })),
              value: scope,
              onSelect: setScope,
            }),
          ),
          h(
            "div",
            { className: "sap-obs-meta sap-mono", "data-meta": "true" },
            [
              t("observe.meta.asOf", { value: meta?.asOf ?? t("observe.value.unknown") }),
              t("observe.meta.watermark", { value: countText(meta?.indexWatermark, t) }),
              t("observe.meta.running", { value: countText(meta?.running, t) }),
              t("observe.meta.unknown", { value: countText(meta?.unknown, t) }),
              t("observe.meta.coverage", { value: rateValueText(rateParts(meta?.coverage), t) }),
            ].join(" · "),
          ),
        );

        const metricsCard = h(Card, {
          key: "metrics",
          title: t("observe.metrics.title"),
          aside: h("span", { className: "sap-metric-detail" }, t("observe.metrics.note")),
          children: h(
            "div",
            { className: "sap-grid2" },
            METRICS.map((metric) => h(MetricTile, { key: metric.id, t, metric, rate: metrics?.[metric.id] ?? null })),
          ),
        });

        const toolsCard = h(Card, {
          key: "tools",
          title: t("observe.tools.title"),
          aside: action("observe.viewAll", t("observe.tools.viewAll")),
          children: h(ToolTable, { t, tools, totals }),
        });

        const tokensCard = h(Card, {
          key: "tokens",
          title: t("observe.tokens.title"),
          aside: h(Segmented, {
            options: [
              { id: "run", label: t("observe.tokens.byRun") },
              { id: "turn", label: t("observe.tokens.byTurn") },
            ],
            value: granularity,
            onSelect: setGranularity,
          }),
          children: h(TokenGrid, { t, tokens, granularity }),
        });

        const qualityCard = h(Card, {
          key: "quality",
          title: t("observe.quality.title"),
          aside: h("span", { className: "sap-metric-detail" }, t("observe.quality.note")),
          children: h(QualityGrid, { t, quality }),
        });

        const membersCard = h(Card, {
          key: "members",
          title: t("observe.members.title"),
          children: h(MembersList, {
            t,
            members,
            selectedId: selectedMember?.id ?? null,
            onSelect: (member) => setSelectedMember(member),
          }),
        });

        const body =
          scenario?.error === undefined
            ? [metricsCard, toolsCard, tokensCard, qualityCard, membersCard]
            : h(
                "div",
                { className: "sap-error", key: "error", "data-error": scenario.error.reason },
                h("div", {}, t("observe.error.title")),
                h("div", { className: "sap-mono" }, scenario.error.reason),
                action("observe.retry", t("observe.error.retry")),
              );

        return h(
          "div",
          { className: "sap-root sap-obs" },
          Style(),
          h("style", { key: "observe-css", "data-plugin-css": OBSERVE_STYLE_ID }, OBSERVE_CSS),
          fixture === null ? h("div", { className: "sap-note", key: "production" }, t("observe.production.note")) : null,
          fixture === null
            ? null
            : h(
                "div",
                { className: "sap-obs-filterrow", key: "scenario" },
                h("span", { className: "sap-obs-filterlabel" }, t("observe.demo.scenario")),
                h(Segmented, {
                  options: SCENARIOS.map((id) => ({ id, label: t(`observe.scenario.${id}`) })),
                  value: scenarioName,
                  onSelect: setScenarioId,
                }),
              ),
          filterCard,
          body,
          h(DetailHost, { key: "detail", t, member: selectedMember, onClose: () => setSelectedMember(null) }),
        );
      }

      return {
        ObserveTab,
        dictionary: { zh, en },
        demoFixture: DEMO,
      };
    }

    /**
     * The observation sample the demo state renders.
     *
     * Every scenario is declared here, and the page reads them only through
     * `services.fixture("observe")` — so no number reaches the interface in a
     * state that is not marked as demo. `normal` carries the layout's own sample
     * values; `zero` empties the denominators so the page shows N/A; `unknown`
     * withholds values; `unsupported` marks a dimension Core does not provide;
     * `error` is the failed read. M4 replaces this object with the Core adapter.
     */
    const DEMO = {
      observe: {
        defaultScenario: "normal",
        scenarios: {
          normal: {
            meta: {
              windows: {
                "24h": {
                  asOf: "09:12",
                  indexWatermark: 1284,
                  running: 4,
                  unknown: 2,
                  coverage: { numerator: 1262, denominator: 1284 },
                },
                "7d": {
                  asOf: "10-20 09:12",
                  indexWatermark: 8210,
                  running: 3,
                  unknown: 11,
                  coverage: { numerator: 7980, denominator: 8210 },
                },
                "30d": {
                  asOf: "10-20 09:12",
                  indexWatermark: 32180,
                  running: 3,
                  unknown: 44,
                  coverage: { numerator: 31200, denominator: 32180 },
                },
              },
            },
            tokens: {
              costKnown: false,
              byRun: { input: 1420000, output: 186000, cacheRead: 1100000, cacheWrite: 62000 },
              byTurn: { input: 142000, output: 18600, cacheRead: 110000, cacheWrite: 6200 },
            },
            quality: { unindexed: 0, droppedFrames: 0, missingExposure: 3, exportBacklog: 0 },
            scopes: {
              entry: {
                metrics: {
                  toolRequestRate: { numerator: 20, denominator: 80 },
                  toolSuccessRate: { numerator: 36, denominator: 40 },
                  subagentStartRate: { numerator: 8, denominator: 50 },
                  skillReadRate: { numerator: 0, denominator: 0 },
                },
                tools: [
                  { id: "edit", name: "edit", exposedRuns: 80, requestRate: { numerator: 20, denominator: 80 }, calls: 50, successRate: { numerator: 45, denominator: 50 }, rejects: 5, cancelled: 5, p50: "0.4s", p95: "1.2s" },
                  { id: "bash", name: "bash", exposedRuns: 80, requestRate: { numerator: 33, denominator: 80 }, calls: 132, successRate: { numerator: 127, denominator: 132 }, rejects: 0, cancelled: 0, p50: "1.1s", p95: "4.8s" },
                  { id: "read", name: "read", exposedRuns: 80, requestRate: { numerator: 50, denominator: 80 }, calls: 240, successRate: { numerator: 238, denominator: 240 }, rejects: 0, cancelled: 0, p50: "0.1s", p95: "0.3s" },
                ],
                members: [
                  { id: "run_7f3c", kind: "run", name: "Core 服务接口核对", status: "running", turns: 3, tokens: { input: 42000, output: 6000 } },
                ],
              },
              subagent: {
                metrics: {
                  toolRequestRate: { numerator: 28, denominator: 30 },
                  toolSuccessRate: { numerator: 26, denominator: 28 },
                  subagentStartRate: { numerator: 2, denominator: 30 },
                  skillReadRate: { numerator: 9, denominator: 30 },
                },
                tools: [
                  { id: "search", name: "search", exposedRuns: 30, requestRate: { numerator: 12, denominator: 30 }, calls: 18, successRate: { numerator: 17, denominator: 18 }, rejects: 1, cancelled: 0, p50: "0.6s", p95: "2.0s" },
                  { id: "read", name: "read", exposedRuns: 30, requestRate: { numerator: 16, denominator: 30 }, calls: 40, successRate: { numerator: 39, denominator: 40 }, rejects: 0, cancelled: 1, p50: "0.1s", p95: "0.4s" },
                ],
                members: [
                  { id: "sa_researcher", kind: "subagent", name: "researcher", mode: "sync", status: "running", description: "只读调研代码与文档，输出带出处的结论", turns: 4, tokens: { input: 26000, output: 4200 } },
                  { id: "sa_planner", kind: "subagent", name: "planner", mode: "async", status: "done", description: "拆解任务并给出执行顺序", turns: 2, tokens: { input: 9000, output: 1500 } },
                ],
              },
              all: {
                metrics: {
                  toolRequestRate: { numerator: 48, denominator: 110 },
                  toolSuccessRate: { numerator: 62, denominator: 68 },
                  subagentStartRate: { numerator: 10, denominator: 110 },
                  skillReadRate: { numerator: 9, denominator: 110 },
                },
                tools: [
                  { id: "edit", name: "edit", exposedRuns: 110, requestRate: { numerator: 24, denominator: 110 }, calls: 50, successRate: { numerator: 45, denominator: 50 }, rejects: 5, cancelled: 5, p50: "0.4s", p95: "1.2s" },
                  { id: "bash", name: "bash", exposedRuns: 110, requestRate: { numerator: 33, denominator: 110 }, calls: 132, successRate: { numerator: 127, denominator: 132 }, rejects: 0, cancelled: 0, p50: "1.1s", p95: "4.8s" },
                  { id: "read", name: "read", exposedRuns: 110, requestRate: { numerator: 66, denominator: 110 }, calls: 280, successRate: { numerator: 277, denominator: 280 }, rejects: 0, cancelled: 1, p50: "0.1s", p95: "0.3s" },
                ],
                members: [
                  { id: "run_7f3c", kind: "run", name: "Core 服务接口核对", status: "running", turns: 3, tokens: { input: 42000, output: 6000 } },
                  { id: "sa_researcher", kind: "subagent", name: "researcher", mode: "sync", status: "running", description: "只读调研代码与文档，输出带出处的结论", turns: 4, tokens: { input: 26000, output: 4200 } },
                  { id: "sa_planner", kind: "subagent", name: "planner", mode: "async", status: "done", description: "拆解任务并给出执行顺序", turns: 2, tokens: { input: 9000, output: 1500 } },
                ],
              },
            },
          },
          zero: {
            meta: {
              windows: {
                "24h": { asOf: "09:12", indexWatermark: 0, running: 0, unknown: 0, coverage: { numerator: 0, denominator: 0 } },
              },
            },
            tokens: {
              costKnown: false,
              byRun: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              byTurn: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            quality: { unindexed: 0, droppedFrames: 0, missingExposure: 0, exportBacklog: 0 },
            scopes: {
              all: {
                metrics: {
                  toolRequestRate: { numerator: 0, denominator: 0 },
                  toolSuccessRate: { numerator: 0, denominator: 0 },
                  subagentStartRate: { numerator: 0, denominator: 0 },
                  skillReadRate: { numerator: 0, denominator: 0 },
                },
                tools: [],
                members: [],
              },
            },
          },
          unknown: {
            meta: {
              windows: {
                "24h": { asOf: null, indexWatermark: null, running: null, unknown: null, coverage: null },
              },
            },
            tokens: { costKnown: false, byRun: null, byTurn: null },
            quality: { unindexed: null, droppedFrames: "uncovered", missingExposure: null, exportBacklog: null },
            scopes: {
              all: {
                metrics: {
                  toolRequestRate: null,
                  toolSuccessRate: { numerator: 36, denominator: null },
                  subagentStartRate: null,
                  skillReadRate: null,
                },
                tools: [
                  { id: "edit", name: "edit", exposedRuns: null, requestRate: null, calls: null, successRate: { numerator: null, denominator: 50 }, rejects: null, cancelled: null, p50: null, p95: null },
                ],
                members: [{ id: "run_unknown", kind: "run", name: "未知 Run", status: "unknown", turns: null, tokens: null }],
              },
            },
          },
          unsupported: {
            meta: {
              windows: {
                "24h": { asOf: "09:12", indexWatermark: 1284, running: 4, unknown: 2, coverage: { numerator: 1262, denominator: 1284 } },
              },
            },
            tokens: {
              costKnown: false,
              byRun: { input: 1420000, output: 186000, cacheRead: 1100000, cacheWrite: 62000 },
              byTurn: { input: 142000, output: 18600, cacheRead: 110000, cacheWrite: 6200 },
            },
            quality: { unindexed: 0, droppedFrames: 0, missingExposure: 3, exportBacklog: 0 },
            scopes: {
              all: {
                metrics: {
                  toolRequestRate: { numerator: 20, denominator: 80 },
                  toolSuccessRate: { numerator: 36, denominator: 40 },
                  subagentStartRate: { numerator: 8, denominator: 50 },
                  skillReadRate: { unsupported: true },
                },
                tools: null,
                members: [
                  { id: "run_7f3c", kind: "run", name: "Core 服务接口核对", status: "running", turns: 3, tokens: { input: 42000, output: 6000 } },
                ],
              },
            },
          },
          error: {
            error: { reason: "core.unavailable" },
            meta: { windows: { "24h": { asOf: null, indexWatermark: null, running: null, unknown: null, coverage: null } } },
            tokens: null,
            quality: null,
            scopes: { all: { metrics: null, tools: null, members: [] } },
          },
        },
      },
    };

    return { createObserveView };
  },
});
