/**
 * Shell half of the bridge's client bundle, loaded as a package-local chunk.
 *
 * This module owns what the design puts around the pages rather than inside
 * them: the space row, the Core status badge, the composer chips and the block
 * that makes an offline composer genuinely inert, the right Sidebar's tab type
 * and the panel frame, and the settings surface that injects the view state.
 * The panel's two tab bodies are built elsewhere (M1-T2/T3) and handed in
 * through `views`; when one is missing the frame says so instead of drawing an
 * empty page that would read as "nothing happened".
 *
 * Copy for the shared fields lives here so a view module never has to declare a
 * key this one already owns; the entry merges every module's dictionary into
 * one namespace and reports a key two modules claim differently.
 *
 * See `docs/requirements/dsh-integration/DSH界面验收.md` for the chunk-loading rules this file follows.
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  chunk: "client.shell.js",
  factory() {
    /** Dictionary namespace every module of this bundle contributes to. */
    const LOCALE_NS = "superAgentBridge";
    /**
     * The Agent Core panel's identity in the right Sidebar's tab system.
     *
     * `id` is this implementation's own name and the key the panel body
     * registers under in `sidebar.right.pane.tab`; `kind` is what
     * `ctx.sidebarRight.openTab` names. The two stages of a tab type must agree
     * on the id, so both live here.
     */
    const TAB_ID = "@super-agent/dsh-bridge/agent-core";
    /** Page kind of the Agent Core panel; `openTab` takes this. */
    const TAB_KIND = "agent-core";
    /**
     * The wait for an openable surface: first delay, and the ceiling it backs
     * off to. What is bounded is the frequency, not a total deadline — a commit
     * that lands late is a slow render, not a failure, and a fixed short window
     * reported it as one permanently.
     */
    const OPEN_RETRY_MIN_MS = 16;
    const OPEN_RETRY_MAX_MS = 1000;


    // #region dictionaries
    const zh = {
      "sidebar.row": "Super Agent",

      "header.ready": "Core ready",
      "header.offline": "Core 未连接",

      "composer.thinking": "thinking · {level}",
      "composer.placeholder": "输入指令，或输入 / 唤起命令…",
      "composer.placeholderOffline": "连接 Core 后可发送…",
      "composer.hint": "Enter 发送 · Shift+Enter 换行",
      "composer.hintOffline": "输入已停用",
      "composer.send": "发送",
      "composer.modelUnknown": "模型未知",
      "composer.thinkingUnknown": "未知",
      "composer.permissionUnknown": "未知",

      "panel.title": "Agent Core",
      "panel.guide": "Agent Core 的 Run、会话与可观测数据",
      "panel.tab.runSession": "运行与会话",
      "panel.tab.observe": "可观测",

      "panel.coreProcess.title": "Core 进程",
      "panel.coreProcess.ready": "ready",
      "panel.coreProcess.offline": "未连接",
      "panel.coreProcess.restart": "重启 Core",
      "panel.coreProcess.logs": "查看日志",
      "panel.coreProcess.openConfig": "打开配置目录",
      "panel.coreProcess.reconnect": "重新连接",
      "panel.coreProcess.startCore": "启动 Core",

      "panel.unavailable.title": "该区域尚未接入",
      "panel.unavailable.body": "本页由后续任务提供；M1 只搭好外壳与状态，不显示占位数据。",

      "field.configDir": "配置目录",
      "field.socket": "Socket",
      "field.recovery": "恢复结果",
      "field.lockFile": "锁文件",
      "field.autoStart": "autoStart",
      "field.profile": "profile",
      "field.agent": "agent",
      "field.model": "model",
      "field.thinking": "thinking",
      "field.permissionMode": "权限模式",
      "field.skillRoots": "skillRoots",
      "value.recoveryNone": "无待恢复 Thread",
      "value.none": "无",
      "value.unknown": "—",
      "core.unwiredReason": "还没有读到 Core 的连接状态：宿主尚未回答第一次查询。",
      "core.attempts": "已尝试 {count} 次",

      "delegation.sync": "同步",
      "delegation.async": "异步",
      "delegation.running": "运行中 · 报告待返回",
      "delegation.delivered": "已完成 · 报告已投递",
      "delegation.cancel": "取消",
      "delegation.view": "查看",

      "action.idle": "",
      "action.pending": "处理中…",
      "action.unsupported": "未接入 · 未执行",
      "action.error": "失败 · {reason}",

      "demo.chip": "演示状态",
      "demo.short": "演示",
      "demo.note": "演示状态：以下内容为版式示例，不是真实 Core 记录；关闭演示后不显示。",

      "tool.subagent.title": "子 Agent · {name}",
      "tool.subagent.description": "只读调研代码与文档，输出带出处的结论",
      "tool.subagent.running": "运行中",

      "settings.tab.title": "Super Agent",
      "settings.tab.body":
        "dsh-bridge 把本 profile 的会话交给 Agent Core 进程。下面的状态由本页显式注入；M1 未接入 Core，动作只报告未支持。",
      "settings.tab.state": "连接状态",
      "settings.tab.state.ready": "Core ready",
      "settings.tab.state.offline": "Offline",
      "settings.tab.demo": "演示状态",
      "settings.tab.demo.on": "开启",
      "settings.tab.demo.off": "关闭",
      "settings.tab.demo.hint": "开启后页面显示版式示例并持续标注；关闭后不显示任何示例数值。",
      "settings.tab.coreHome": "coreHome",
      "settings.tab.socketPath": "socketPath",
      "settings.tab.autoStart": "autoStart",
    };

    /** English copy — the same key set as {@link zh}. */
    const en = {
      "sidebar.row": "Super Agent",

      "header.ready": "Core ready",
      "header.offline": "Core disconnected",

      "composer.thinking": "thinking · {level}",
      "composer.placeholder": "Type an instruction, or / for commands…",
      "composer.placeholderOffline": "Connect Core to send…",
      "composer.hint": "Enter to send · Shift+Enter for a new line",
      "composer.hintOffline": "Input is disabled",
      "composer.send": "Send",
      "composer.modelUnknown": "model unknown",
      "composer.thinkingUnknown": "unknown",
      "composer.permissionUnknown": "unknown",

      "panel.title": "Agent Core",
      "panel.guide": "Runs, sessions and observability for Agent Core",
      "panel.tab.runSession": "Run & session",
      "panel.tab.observe": "Observability",

      "panel.coreProcess.title": "Core process",
      "panel.coreProcess.ready": "ready",
      "panel.coreProcess.offline": "disconnected",
      "panel.coreProcess.restart": "Restart Core",
      "panel.coreProcess.logs": "View logs",
      "panel.coreProcess.openConfig": "Open config directory",
      "panel.coreProcess.reconnect": "Reconnect",
      "panel.coreProcess.startCore": "Start Core",

      "panel.unavailable.title": "Not wired up yet",
      "panel.unavailable.body":
        "A later task supplies this area; M1 builds only the shell and its state, and shows no placeholder data.",

      "field.configDir": "Config directory",
      "field.socket": "Socket",
      "field.recovery": "Recovery",
      "field.lockFile": "Lock file",
      "field.autoStart": "autoStart",
      "field.profile": "profile",
      "field.agent": "agent",
      "field.model": "model",
      "field.thinking": "thinking",
      "field.permissionMode": "Permission mode",
      "field.skillRoots": "skillRoots",
      "value.recoveryNone": "No Thread to recover",
      "value.none": "none",
      "value.unknown": "—",
      "core.unwiredReason": "No Core state has been read yet: the host has not answered the first query.",
      "core.attempts": "tried {count} times",

      "delegation.sync": "Sync",
      "delegation.async": "Async",
      "delegation.running": "running · report pending",
      "delegation.delivered": "done · report delivered",
      "delegation.cancel": "Cancel",
      "delegation.view": "View",

      "action.idle": "",
      "action.pending": "working…",
      "action.unsupported": "not wired · nothing ran",
      "action.error": "failed · {reason}",

      "demo.chip": "Demo state",
      "demo.short": "demo",
      "demo.note": "Demo state: the content below is layout sample data, not a real Core record; it disappears when demo is off.",

      "tool.subagent.title": "Subagent · {name}",
      "tool.subagent.description": "Read-only research over code and docs, with sourced conclusions",
      "tool.subagent.running": "running",

      "settings.tab.title": "Super Agent",
      "settings.tab.body":
        "dsh-bridge routes this profile's sessions through the Agent Core process. The state below is injected explicitly from this page; M1 has no Core, so actions report themselves as unsupported.",
      "settings.tab.state": "Connection",
      "settings.tab.state.ready": "Core ready",
      "settings.tab.state.offline": "Offline",
      "settings.tab.demo": "Demo state",
      "settings.tab.demo.on": "On",
      "settings.tab.demo.off": "Off",
      "settings.tab.demo.hint":
        "While on, the pages show layout samples and say so throughout; while off, no sample value is drawn.",
      "settings.tab.coreHome": "coreHome",
      "settings.tab.socketPath": "socketPath",
      "settings.tab.autoStart": "autoStart",
    };
    // #endregion

    /**
     * Build the shell against one activation's kernel, services and views.
     * @param options.kernel - shared React/primitives/hooks from the entry.
     * @param options.services - the service facade holding the injected state.
     * @param options.views - tab bodies built by the page modules, if present.
     * @param options.blocks - `ctx.conversation.blocks`, the host's channel for
     * stopping a Session's input; the offline mask raises its reason through it.
     * @returns the tab identity, dictionary slice, registrations and tab type.
     */
    function createShell({ kernel, services, views = {}, blocks, openPanel }) {
      const {
        React,
        h,
        Style,
        Dot,
        Svg,
        Card,
        Field,
        Btn,
        Chip,
        IconSuperAgent,
        IconDelegation,
        useStore,
        useOutcome,
      } = kernel;

      /**
       * The tab bodies and the offline notice, filled in by the entry once the
       * page modules have been built. The shell is constructed first because
       * those modules draw their actions with its control, so this is a mutable
       * reference rather than a constructor argument.
       */
      let viewsRef = views;
      function setViews(next) {
        viewsRef = { ...viewsRef, ...next };
      }

      /** The injected view state every component in the shell reads. */
      const useViewState = () => useStore(services.viewState);

      /**
       * One push button for a product action.
       *
       * Every action goes through the facade, and the button says what came
       * back: while a call is in flight it reads as pending, and an action with
       * no transport behind it reads as unsupported rather than silently
       * succeeding. `disabled` is for actions the current connection state
       * cannot offer at all.
       */
      function ActionBtn({ id, variant, disabled, payload, children }) {
        const outcome = useOutcome(services, id);
        const status = disabled === true ? "idle" : outcome.status;
        const note =
          status === "pending"
            ? "action.pending"
            : status === "unsupported"
              ? "action.unsupported"
              : status === "error"
                ? "action.error"
                : null;
        return h(
          Btn,
          {
            variant,
            disabled: disabled === true,
            onClick: () => {
              // The arguments travel with the button that names the thing they
              // act on. A control that read a "current" selection instead would
              // act on whatever happened to be current when it was clicked.
              services.run(id, typeof payload === "function" ? payload() : payload);
            },
          },
          children,
          note === null
            ? null
            : h(
                "span",
                {
                  key: "note",
                  className: "sap-action",
                  "data-status": status,
                  "data-action": id,
                },
                h("span", {}, translate(note, { reason: outcome.reason ?? "" })),
              ),
        );
      }

      /**
       * The dictionary lookup a component uses when the seat did not hand it
       * one. Slot seats pass `t`; a component rendered outside a seat (a test,
       * or the tab body during a language switch) still has to say something,
       * so it falls back to this activation's own copy.
       */
      let boundTranslate = (key) => key;
      const translate = (key, params) => boundTranslate(key, params);

      /** `sidebar.panellist`: the Super Agent space row with its status dot. */
      function SidebarRow(props) {
        const state = useViewState();
        const offline = state.connection !== "ready";
        const t = props.t ?? translate;
        return h(
          "div",
          { className: "sap-root" },
          Style(),
          h(
            "button",
            {
              type: "button",
              className: "sap-row",
              "data-active": "true",
              "data-connection": state.connection,
              onClick: () => openPanel?.(),
            },
            IconSuperAgent(),
            h("span", { className: "sap-row-label" }, t("sidebar.row")),
            state.demo ? h("span", { className: "sap-demo-chip" }, t("demo.chip")) : null,
            h(Dot, { tone: offline ? "bad" : "ok" }),
          ),
        );
      }

      /** `conversation.session.header.utilities`: the Core status badge. */
      function HeaderBadge(props) {
        const state = useViewState();
        const offline = state.connection !== "ready";
        const t = props.t ?? translate;
        return h(
          "div",
          { className: "sap-root" },
          Style(),
          h(
            "span",
            {
              className: "sap-badge",
              "data-state": offline ? "offline" : "ready",
              "data-connection": state.connection,
            },
            h(Dot, { tone: offline ? "bad" : "ok" }),
            h("span", {}, t(offline ? "header.offline" : "header.ready")),
          ),
          state.demo ? h("span", { className: "sap-demo-chip" }, t("demo.chip")) : null,
        );
      }

      /**
       * One composer chip's value.
       *
       * Read the selected Conversation's actual fixed configuration. Demo
       * values remain explicit, and a missing snapshot remains unknown.
       */
      function composerValue(field, unknownKey, t, state) {
        const fixture = services.fixture("composer");
        const snapshot = state.snapshot;
        const config = state.connection === "ready" && state.snapshotError === null &&
          snapshot?.sessionId === state.sessionId && snapshot?.conversationId === state.conversationId
          ? snapshot?.config : undefined;
        const key = { model: "modelId", thinking: "thinkingLevel", permission: "permissionMode" }[field];
        const value = fixture === null ? config?.[key] : fixture[field];
        if (value === undefined || value === null) return t(unknownKey);
        return fixture === null ? value : `${value} · ${t("demo.short")}`;
      }

      /** `conversation.input.model`: the model selector chip. */
      function ModelSelect(props) {
        const state = useViewState();
        const offline = state.connection !== "ready";
        const t = props.t ?? translate;
        return h(
          "div",
          { className: "sap-root" },
          Style(),
          h(
            Chip,
            { mono: true, disabled: offline },
            h("span", { "data-composer": "model" }, composerValue("model", "composer.modelUnknown", t, state)),
          ),
        );
      }

      /** `conversation.input.left`: the thinking level chip. */
      function ThinkingSelect(props) {
        const state = useViewState();
        const offline = state.connection !== "ready";
        const t = props.t ?? translate;
        return h(
          "div",
          { className: "sap-root" },
          Style(),
          h(
            Chip,
            { disabled: offline },
            h(
              "span",
              { "data-composer": "thinking" },
              t("composer.thinking", { level: composerValue("thinking", "composer.thinkingUnknown", t, state) }),
            ),
          ),
        );
      }

      /** `conversation.input.permission`: the permission-mode chip. */
      function PermissionSelect(props) {
        const state = useViewState();
        const offline = state.connection !== "ready";
        const t = props.t ?? translate;
        return h(
          "div",
          { className: "sap-root" },
          Style(),
          h(
            Chip,
            { mono: true, disabled: offline },
            h(
              "span",
              { "data-composer": "permission" },
              composerValue("permission", "composer.permissionUnknown", t, state),
            ),
          ),
        );
      }

      /**
       * `conversation.input.overlay`: the disconnected composer mask.
       *
       * The mask is drawn here, so the composer cannot know why it is covered —
       * the dependency runs the other way. `ctx.conversation.blocks` is the
       * host's own channel for exactly that, described in dsh as "the one way
       * another plugin stops a session's input": the bar reads its own Session's
       * block and renders an inert editor, so the mask is an actual constraint
       * rather than a picture of one.
       *
       * It is raised per Session, from the component scoped to that Session, so
       * it follows the Session's own lifetime: the cleanup clears it when the
       * Session unmounts, when the layout stops being offline, or when the
       * plugin unloads.
       */
      function ComposerOverlay(props) {
        const state = useViewState();
        const offline = state.connection !== "ready";
        const sessionId = props.sessionId;
        const t = props.t ?? translate;
        // A value, not a thunk: the effect re-runs when the copy changes and not
        // when the component merely re-renders.
        const reason = offline ? t("composer.placeholderOffline") : undefined;
        React.useEffect(() => {
          if (reason === undefined || sessionId === undefined || blocks === undefined) return undefined;
          blocks.set(sessionId, { reason });
          return () => {
            blocks.set(sessionId, undefined);
          };
        }, [sessionId, reason]);
        if (!offline) return null;
        return h(
          "div",
          { className: "sap-root sap-overlay" },
          Style(),
          h("span", {}, t("composer.hintOffline")),
        );
      }

      /**
       * `conversation.input.dock`: the disconnected conversation notice.
       *
       * The notice itself is the offline module's (M1-T2), which owns the
       * diagnostic copy and decides when it applies. Until that module lands
       * the seat is still claimed, so the slot's identity does not change when
       * it does, and it draws nothing rather than a placeholder that would read
       * as a state the plugin is not actually in.
       */
      function DockNotice(props) {
        const Notice = viewsRef.offlineNotice;
        if (Notice === undefined) return null;
        return h(Notice, props);
      }

      /** The panel's tab bodies, or an honest stand-in when one is missing. */
      function TabBody({ name, props }) {
        const component = viewsRef[name];
        if (component === undefined) {
          return h(Card, {
            title: (props.t ?? translate)("panel.unavailable.title"),
            children: h(
              "div",
              { className: "sap-unavailable" },
              (props.t ?? translate)("panel.unavailable.body"),
            ),
          });
        }
        return h(component, { ...props, t: typeof props.t === "function" ? props.t : translate });
      }

      /** The demo marker the panel carries whenever demo content is on. */
      function DemoNote(props) {
        const state = useViewState();
        if (!state.demo) return null;
        const t = props.t ?? translate;
        return h("div", { className: "sap-demo", "data-demo": "true" }, t("demo.note"));
      }

      /** `sidebar.right.pane.tab`: the Agent Core panel with its two tabs. */
      function AgentCorePanel(props) {
        const state = useViewState();
        const t = props.t ?? translate;
        const [tab, setTab] = React.useState("runSession");
        const tabButton = (key, label) =>
          h(
            "button",
            {
              type: "button",
              className: "sap-tab",
              "data-active": tab === key ? "true" : undefined,
              onClick: () => setTab(key),
            },
            label,
          );
        return h(
          "div",
          { className: "sap-root sap-panel", "data-connection": state.connection },
          Style(),
          h(
            "div",
            { className: "sap-panel-head" },
            h("span", { className: "sap-panel-title" }, t("panel.title")),
            h("span", { className: "sap-mono sap-muted", style: { fontSize: 11 } }, state.core.home),
            state.demo ? h("span", { className: "sap-demo-chip" }, t("demo.chip")) : null,
          ),
          h(
            "div",
            { className: "sap-tabs" },
            tabButton("runSession", t("panel.tab.runSession")),
            tabButton("observe", t("panel.tab.observe")),
          ),
          h(
            "div",
            { className: "sap-panel-body" },
            h(DemoNote, props),
            tab === "observe"
              ? h(TabBody, { name: "observe", props })
              : h(TabBody, { name: "runSession", props }),
          ),
        );
      }

      /** `tool.call.toolview` for `subagent_start`: the subagent tool card. */
      function SubagentToolView(props) {
        const t = props.t ?? translate;
        const subagent = props.subagent ?? { name: "researcher", mode: "sync", status: "running" };
        return h(
          "div",
          { className: "sap-root" },
          Style(),
          h(
            "div",
            { className: "sap-toolcard" },
            h("span", { className: "sap-toolglyph" }, IconDelegation()),
            h(
              "div",
              { className: "sap-toolmain" },
              h(
                "div",
                { className: "sap-toolhead" },
                h("span", { className: "sap-tooltitle" }, t("tool.subagent.title", { name: subagent.name })),
                h("span", { className: "sap-tag" }, t(subagent.mode === "async" ? "delegation.async" : "delegation.sync")),
              ),
              h("div", { className: "sap-tooldesc" }, t("tool.subagent.description")),
            ),
            h(
              "span",
              { className: "sap-status" },
              h(Dot, { tone: subagent.status === "running" ? "ok" : "idle" }),
              h("span", { className: "sap-muted" }, t("tool.subagent.running")),
            ),
            h(
              "button",
              {
                type: "button",
                className: "sap-link",
                onClick: () => {
                  services.run("delegation.view", { name: subagent.name });
                },
              },
              t("delegation.view"),
            ),
          ),
        );
      }

      /**
       * `settings.plugins.tab`: where the view state is injected explicitly.
       *
       * This is the product surface for demo content: nothing else can turn it
       * on, and while it is on every page carries the demo marker. The plugin's
       * configuration is echoed read-only next to it.
       */
      function SettingsTab(props) {
        const state = useViewState();
        const t = props.t ?? translate;
        const choice = (active, label, onClick) =>
          h(
            "button",
            { type: "button", className: "sap-choice-btn", "data-active": active ? "true" : undefined, onClick },
            label,
          );
        return h(
          "div",
          { className: "sap-root sap-settings" },
          Style(),
          h("div", { className: "sap-settings-title" }, t("settings.tab.title")),
          h("p", { className: "sap-muted", style: { margin: 0, fontSize: 12, lineHeight: 1.6 } }, t("settings.tab.body")),
          h(Card, {
            title: t("settings.tab.state"),
            children: [
              h(
                "div",
                { className: "sap-choice", key: "connection" },
                choice(
                  state.connection === "ready",
                  t("settings.tab.state.ready"),
                  () => services.setConnection("ready"),
                ),
                choice(
                  state.connection !== "ready",
                  t("settings.tab.state.offline"),
                  () => services.setConnection("offline"),
                ),
              ),
              h("div", { className: "sap-field", key: "home" }, h(Field, { label: t("settings.tab.coreHome"), value: state.core.home })),
              h(
                "div",
                { className: "sap-field", key: "socket" },
                h(Field, { label: t("settings.tab.socketPath"), value: state.core.socketPath }),
              ),
              h(
                "div",
                { className: "sap-field", key: "autostart" },
                h(Field, { label: t("settings.tab.autoStart"), value: String(state.core.autoStart) }),
              ),
            ],
          }),
          h(Card, {
            title: t("settings.tab.demo"),
            children: [
              h(
                "div",
                { className: "sap-choice", key: "demo" },
                choice(state.demo === true, t("settings.tab.demo.on"), () => services.setDemo(true)),
                choice(state.demo !== true, t("settings.tab.demo.off"), () => services.setDemo(false)),
              ),
              h("div", { className: "sap-muted", key: "hint", style: { fontSize: 11, lineHeight: 1.6 } }, t("settings.tab.demo.hint")),
            ],
          }),
        );
      }

      /** Bind the fallback translator this activation's components use. */
      function bindTranslate(t) {
        boundTranslate = t;
      }

      /**
       * Every slot the design uses, with the options its cardinality requires:
       * `id`/`order` for lists, `key` for keyed slots, nothing for singles.
       */
      const registrations = [
        {
          slot: "sidebar.panellist",
          label: "sidebar row",
          options: { name: "sidebar.panellist", id: "super-agent-row", order: 10 },
          component: SidebarRow,
        },
        {
          slot: "conversation.session.header.utilities",
          label: "header badge",
          options: { name: "conversation.session.header.utilities", id: "super-agent-core-status", order: 10 },
          component: HeaderBadge,
        },
        {
          slot: "conversation.input.model",
          label: "model selector",
          // `single` slot, already held by the built-in model control:
          // registering at the same (default) priority throws. The lowest
          // priority renders, so -10 SHADOWS the built-in `ui-model-selection`
          // registration (which declares no priority, i.e. 0).
          options: { name: "conversation.input.model", priority: -10 },
          component: ModelSelect,
        },
        {
          slot: "conversation.input.left",
          label: "thinking selector",
          options: { name: "conversation.input.left", id: "super-agent-thinking", order: 10 },
          component: ThinkingSelect,
        },
        {
          slot: "conversation.input.permission",
          label: "permission selector",
          // Same story as the model slot above.
          options: { name: "conversation.input.permission", priority: -10 },
          component: PermissionSelect,
        },
        {
          slot: "conversation.input.overlay",
          label: "composer overlay",
          options: { name: "conversation.input.overlay", id: "super-agent-offline-mask", order: 10 },
          component: ComposerOverlay,
        },
        {
          slot: "conversation.input.dock",
          label: "offline notice",
          options: { name: "conversation.input.dock", id: "super-agent-offline-notice", order: 10 },
          component: DockNotice,
        },
        {
          slot: "sidebar.right.pane.tab",
          label: "Agent Core panel",
          // The body half of the panel's tab type; the key is the tab type's own
          // `id`, the only thing the seat uses to find the body of the type in
          // force. `tabDefinition` declares the other half.
          options: { name: "sidebar.right.pane.tab", key: TAB_ID },
          component: AgentCorePanel,
        },
        {
          slot: "tool.call.toolview",
          label: "subagent tool card",
          options: { name: "tool.call.toolview", key: "subagent_start" },
          component: SubagentToolView,
        },
        {
          slot: "settings.plugins.tab",
          label: "settings tab",
          // The seat draws this one's name from `label`; without it the tab is a
          // nameless button with an empty aria-label.
          labelKey: "settings.tab.title",
          options: { name: "settings.plugins.tab", id: "super-agent-settings", order: 10 },
          component: SettingsTab,
        },
      ];

      /**
       * Stage one of the panel's tab type: what the type IS.
       *
       * Registering the body alone puts nothing on screen — the keyed
       * `sidebar.right.pane.tab` seat draws the body of a tab the Session's
       * layout already holds, and no layout holds one until a type declares the
       * kind and something opens a tab of it. `id` must equal `TAB_ID`;
       * `extension` is the band a type from outside the product declares.
       */
      function tabDefinition(t) {
        return {
          id: TAB_ID,
          kind: TAB_KIND,
          priority: "extension",
          title: () => t("panel.title"),
          guide: [
            {
              id: "agent-core",
              order: 40,
              title: () => t("panel.title"),
              description: () => t("panel.guide"),
            },
          ],
        };
      }

      return {
        LOCALE_NS,
        TAB_ID,
        TAB_KIND,
        OPEN_RETRY_MIN_MS,
        OPEN_RETRY_MAX_MS,
        dictionary: { zh, en },
        registrations,
        tabDefinition,
        bindTranslate,
        /**
         * The one action control the bundle uses. A page module cannot require
         * a sibling chunk, so the entry hands this to each `create*` instead;
         * every product action then reports through the same facade and says
         * the same thing about an unwired call.
         */
        ActionBtn,
        setViews,
        /**
         * The composer chips' sample values. They are declared here and
         * injected into the service facade by the entry, so the chips render
         * them only while demo is explicitly on.
         */
        demoFixture: {
          composer: { model: "go-main", thinking: "medium", permission: "workspace_auto" },
        },
      };
    }

    return { createShell };
  },
});
