/**
 * The panel's "Run & session" tab, loaded as a package-local chunk.
 *
 * This module owns the cards the design puts next to the Run: the Core process
 * card in both its connected and disconnected shapes, the session config
 * snapshot, the subagent delegations, and the recovery-and-blocking card. It
 * also decides which of them a tab shows — the connected layout and the
 * disconnected one are different compositions in the design, not one layout
 * with fields blanked.
 *
 * The chat area and the composer belong to dsh itself; this bundle only adds
 * the header badge and the composer chips (the shell) and the block that makes
 * an offline composer inert. What this module draws is the right-hand panel.
 *
 * Every card reads the injected view state and the facade's demo fixtures. With
 * demo off there is no Run and no delegation to show, and those cards say so
 * with dashes and disabled controls rather than sample values. The config
 * snapshot is the one card with a live source of its own: it draws the config
 * the host read from this Session's Conversation, and says which of its states
 * it is in — not read yet, unreadable, no Conversation, or not connected —
 * rather than reading an absent sample as a Core that is down.
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  chunk: "client.main.js",
  factory() {
    /** The action ids these cards raise through the facade. */
    const ACTIONS = {
      restartCore: "core.restart",
      viewLogs: "core.logs",
      openConfig: "core.openConfig",
      reconnect: "core.reconnect",
      startCore: "core.start",
      switchModel: "snapshot.switchModel",
      switchPermission: "snapshot.switchPermission",
      cancelDelegation: "delegation.cancel",
      viewDelegation: "delegation.view",
    };

    const zh = {
      "panel.snapshot.title": "会话配置快照",
      "panel.snapshot.fixed": "创建时固定",
      "panel.snapshot.notice": "修改会以 config_changed 取消当前 Run，回执里会列出受影响的 Run。",
      "panel.snapshot.switchModel": "切换模型",
      "panel.snapshot.switchPermission": "修改权限模式",
      // `field.*` belongs to the shell, and the shell has no key for this one:
      // the value is the model provider, and the key says so rather than
      // borrowing the shell's `profile`, which is a different thing.
      "panel.snapshot.provider": "提供方",
      "panel.snapshot.configRevision": "配置版本",
      "panel.snapshot.capabilities": "声明能力",
      "panel.snapshot.capabilitySource": "能力来源",
      "panel.snapshot.capabilityNotice": "能力来自固定配置声明，未在本会话中逐项实测。",
      "panel.snapshot.capabilityUnknown": "未知",

      "panel.delegations.title": "子 Agent 委派",
      "panel.delegations.none": "还没有可读的子 Agent 委派信息：Core 的委派读面尚未接入本面板。",

      "panel.recovery.title": "恢复与阻塞",
      "panel.recovery.unreadable": "未连接，无法读取",
      "panel.recovery.empty": "没有待恢复的 Thread",
      "panel.recovery.emptyHint": "连接后 Core 会返回恢复结果与各 Thread 的 blockingReasons。",
      "panel.recovery.pendingWait": "待处理等待",
      "panel.recovery.activeDelegation": "活动委派",
      // Said only when the Core really is not connected — the snapshot card's
      // other states say what they are instead of blaming the link.
      "panel.snapshot.unavailable": "未连接 Core，读不到会话配置快照。",
      "panel.snapshot.reading": "正在读取这个会话的配置快照…",
      "panel.snapshot.noConversation": "这个会话还没有 Core Conversation，没有配置快照可读。",
      "panel.snapshot.unreadable": "这个会话的配置快照读不到。",
      "panel.delegations.unavailable": "未连接 Core，读不到子 Agent 委派。",

      "panel.threads.title": "Core 里的 Thread",
      "panel.threads.empty": "这个 home 里还没有 Thread",
      "panel.threads.emptyHint": "在 dsh 里发一条消息，插件会为这个会话创建 Thread。",
      "panel.threads.row": "{status} · Run {active} · 等待 {waits}",
      "panel.threads.updated": "更新于 {at}",

      "panel.session.title": "当前会话归属",
      "panel.session.dshSession": "dsh 会话",
      "panel.session.thread": "Core Thread",
      "panel.session.conversation": "Core Conversation",
      "panel.session.unmapped": "这个会话还没有 Thread：发一条消息，插件会为它创建。",
      "panel.session.unreadable": "宿主还没有回答这个会话的归属。",
      "panel.session.forked": "这是 fork 出来的分支会话，读的是 Core 里那个分支 Conversation。",
      "panel.session.note": "下面的 Thread 列表是整个 home 的全部 Thread，不是这个会话的归属。",
    };

    const en = {
      "panel.snapshot.title": "Session config snapshot",
      "panel.snapshot.fixed": "Fixed at creation",
      "panel.snapshot.notice": "A change cancels the current Run as config_changed; the receipt lists the affected Runs.",
      "panel.snapshot.switchModel": "Switch model",
      "panel.snapshot.switchPermission": "Change permission mode",
      "panel.snapshot.provider": "Provider",
      "panel.snapshot.configRevision": "Config revision",
      "panel.snapshot.capabilities": "Declared capabilities",
      "panel.snapshot.capabilitySource": "Capability source",
      "panel.snapshot.capabilityNotice": "Capabilities are from the fixed configuration; not individually tested in this session.",
      "panel.snapshot.capabilityUnknown": "Unknown",

      "panel.delegations.title": "Subagent delegations",
      "panel.delegations.none":
        "No subagent delegations can be read yet: Core's delegation read is not wired into this panel.",

      "panel.recovery.title": "Recovery & blocking",
      "panel.recovery.unreadable": "Disconnected, cannot read",
      "panel.recovery.empty": "No Thread to recover",
      "panel.recovery.emptyHint":
        "Once connected, Core returns the recovery result and each Thread's blockingReasons.",
      "panel.recovery.pendingWait": "Pending waits",
      "panel.recovery.activeDelegation": "Active delegations",
      "panel.snapshot.unavailable": "Core is not connected, so the session config snapshot cannot be read.",
      "panel.snapshot.reading": "Reading this session's config snapshot…",
      "panel.snapshot.noConversation":
        "This session has no Core Conversation yet, so there is no config snapshot to read.",
      "panel.snapshot.unreadable": "This session's config snapshot could not be read.",
      "panel.delegations.unavailable": "Core is not connected, so subagent delegations cannot be read.",

      "panel.threads.title": "Threads in Core",
      "panel.threads.empty": "This home holds no Thread yet",
      "panel.threads.emptyHint": "Send a message in dsh and the plugin creates a Thread for the session.",
      "panel.threads.row": "{status} · Runs {active} · waits {waits}",
      "panel.threads.updated": "updated {at}",

      "panel.session.title": "This session's identity",
      "panel.session.dshSession": "dsh session",
      "panel.session.thread": "Core Thread",
      "panel.session.conversation": "Core Conversation",
      "panel.session.unmapped": "This session has no Thread yet: send a message and the plugin creates one.",
      "panel.session.unreadable": "The host has not answered with this session's identity yet.",
      "panel.session.forked": "This is a forked session; it reads the branch Conversation in Core.",
      "panel.session.note": "The Thread list below is every Thread in this home, not this session's own.",
    };

    /**
     * Build the tab and the cards it composes.
     * @param options.kernel - shared React/primitives/hooks from the entry.
     * @param options.services - the service facade holding the injected state.
     * @param options.parts - the pieces other modules draw, filled in by the
     * entry. Read at render time, so module order does not matter.
     */
    function createMainView({ kernel, services, parts }) {
      const { h, Dot, Card, Field, useStore } = kernel;
      const { ActionBtn } = parts;

      /**
       * The Core process card.
       *
       * Connected, it shows where Core is and how recovery went, with the
       * restart and log actions. Disconnected, it leads with the reason Core is
       * unreachable and offers the reconnect/start actions instead — the reason
       * being the one the host reported, never a fabricated `ENOENT`, which is
       * the design's sample string and shows only while demo is on.
       */
      function CoreStatusCard(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        const offline = state.connection !== "ready";
        const fixture = services.fixture("offline");

        if (offline) {
          const reason = services.reasonText(state.core.error) ?? fixture?.error ?? t("core.unwiredReason");
          return h(Card, {
            title: t("panel.coreProcess.title"),
            aside: h("span", { className: "sap-status" }, h(Dot, { tone: "bad" }), t("panel.coreProcess.offline")),
            children: [
              h("div", { className: "sap-error sap-mono", key: "error" }, reason),
              h(
                "div",
                { className: "sap-fields", key: "fields" },
                h(
                  Field,
                  { label: t("field.lockFile"), value: `${state.core.lockFile} · ${t("value.none")}` },
                ),
                h(
                  Field,
                  {
                    label: t("field.autoStart"),
                    value: `${String(state.core.autoStart)} · ${t("core.attempts", { count: state.core.attempts })}`,
                  },
                ),
                h(Field, { label: t("field.configDir"), value: state.core.home }),
              ),
              h(
                "div",
                { className: "sap-actions", key: "actions" },
                h(ActionBtn, { id: ACTIONS.reconnect, variant: "solid" }, t("panel.coreProcess.reconnect")),
                h(ActionBtn, { id: ACTIONS.startCore }, t("panel.coreProcess.startCore")),
                h(ActionBtn, { id: ACTIONS.viewLogs }, t("panel.coreProcess.logs")),
              ),
            ],
          });
        }

        const recovery = services.fixture("recovery");
        return h(Card, {
          title: t("panel.coreProcess.title"),
          aside: h("span", { className: "sap-status" }, h(Dot, { tone: "ok" }), t("panel.coreProcess.ready")),
          children: [
            h(
              "div",
              { className: "sap-fields", key: "fields" },
              h(Field, { label: t("field.configDir"), value: state.core.home }),
              h(Field, { label: t("field.socket"), value: state.core.socketPath }),
              h(
                Field,
                {
                  label: t("field.recovery"),
                  value: recovery === null ? t("value.unknown") : t("value.recoveryNone"),
                },
              ),
            ),
            h(
              "div",
              { className: "sap-actions", key: "actions" },
              h(ActionBtn, { id: ACTIONS.restartCore }, t("panel.coreProcess.restart")),
              h(ActionBtn, { id: ACTIONS.viewLogs }, t("panel.coreProcess.logs")),
              h("span", { className: "sap-spacer" }),
              h(ActionBtn, { id: ACTIONS.openConfig, variant: "link" }, t("panel.coreProcess.openConfig")),
            ),
          ],
        });
      }

      /**
       * Which dsh Session this panel belongs to, and what it maps to in Core.
       *
       * The ids are shown as they are, not summarised, because the whole point
       * of the card is that the mapping can be *checked*: the dsh Session the
       * panel is showing, the Thread its turns run on, and the Conversation it
       * reads. A forked session's Conversation differs from the Thread's main
       * one, and saying so is how a reader tells a fork from the line it was
       * forked away from.
       */
      function SessionCard(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        const unknown = t("panel.run.unknown");
        const forked =
          state.conversationId !== null &&
          state.threadId !== null &&
          state.conversationId !== state.mainConversationId;
        return h(Card, {
          title: t("panel.session.title"),
          collapsible: true,
          id: "session",
          children: [
            h(
              "div",
              { className: "sap-fields", key: "fields" },
              h(Field, { label: t("panel.session.dshSession"), value: state.sessionId ?? unknown }),
              h(Field, { label: t("panel.session.thread"), value: state.threadId ?? unknown }),
              h(Field, { label: t("panel.session.conversation"), value: state.conversationId ?? unknown }),
            ),
            h(
              "div",
              { className: "sap-muted", key: "note", style: { fontSize: 11, lineHeight: 1.6 } },
              // A record the bridge cannot read comes first, and says so in the
              // host's own words: it is not the same failure as a session that
              // has no Thread, and reporting it as one would be a claim the
              // bridge cannot make.
              state.sessionError !== null
                ? `${t("panel.session.unreadable")} ${services.reasonText(state.sessionError) ?? ""}`.trim()
                : state.sessionId === null
                  ? t("panel.session.unreadable")
                  : state.threadId === null
                    ? t("panel.session.unmapped")
                    : forked
                      ? t("panel.session.forked")
                      : t("panel.session.note"),
            ),
          ],
        });
      }

      /**
       * The Threads this home holds, as the Core listed them.
       *
       * This is the panel's only whole-Core view, and it exists because the
       * browser half is not told which session the window is showing: a card
       * that claimed to be "this session's Thread" would be guessing. What it
       * can say truthfully is which Threads exist, what state each is in, and
       * which one the Run card is drawing — so that is what it says.
       */
      function ThreadsCard(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        const threads = state.threads ?? [];
        if (threads.length === 0) {
          return h(Card, {
            title: t("panel.threads.title"),
            collapsible: true,
            id: "threads",
            children: [
              h("div", { className: "sap-muted", key: "empty" }, t("panel.threads.empty")),
              h("div", { className: "sap-muted", key: "hint", style: { fontSize: 11 } }, t("panel.threads.emptyHint")),
            ],
          });
        }
        return h(Card, {
          title: t("panel.threads.title"),
          collapsible: true,
          id: "threads",
          children: threads.map((thread) =>
            h(
              "div",
              { className: "sap-turn", key: thread.threadId },
              h(Dot, { tone: (thread.activeRuns ?? []).length > 0 ? "ok" : "idle" }),
              h(
                "span",
                { className: "sap-mono" },
                thread.threadId === state.threadId ? `▸ ${thread.threadId}` : thread.threadId,
              ),
              h(
                "span",
                { className: "sap-muted" },
                t("panel.threads.row", {
                  status: thread.status,
                  active: String((thread.activeRuns ?? []).length),
                  waits: String(thread.pendingWaits ?? 0),
                }),
              ),
            ),
          ),
        });
      }

      /**
       * A snapshot's own fields, drawn the same way for a live one and a demo
       * one: the fixture is sample content of the same shape, so one place
       * decides what a config looks like on screen.
       *
       * Each label names the value under it. The provider is the provider — the
       * Core's own `config.provider` — and is not called a "profile", which is a
       * different thing this snapshot does not carry.
       * @param snapshot - a config snapshot, live or sample.
       * @param t - the translator.
       */
      function snapshotFields(snapshot, t) {
        const config = snapshot.config ?? {};
        const none = t("value.none");
        const roots = (config.skillRoots ?? []).length === 0 ? none : config.skillRoots.join(" · ");
        const capabilities = config.modelCapabilities;
        const capabilityText = capabilities == null ? t("panel.snapshot.capabilityUnknown") :
          `input: ${capabilities.input.join(", ")} · tools: ${capabilities.tools} · thinking: ${capabilities.thinking} · toolResultImages: ${capabilities.toolResultImages}`;
        return [
          h(
            "div",
            { className: "sap-fields", key: "fields" },
            h(Field, { label: t("panel.snapshot.provider"), value: config.provider ?? none }),
            h(Field, { label: t("field.agent"), value: snapshot.agentId ?? none }),
            h(Field, { label: t("field.model"), value: config.modelId ?? none }),
            h(Field, { label: t("field.thinking"), value: config.thinkingLevel ?? none }),
            h(Field, { label: t("field.permissionMode"), value: config.permissionMode ?? none }),
            h(Field, { label: t("field.skillRoots"), value: roots }),
            h(Field, { label: t("panel.snapshot.configRevision"), value: snapshot.configRevision ?? none }),
            h(Field, { label: t("panel.snapshot.capabilities"), value: capabilityText }),
            h(Field, { label: t("panel.snapshot.capabilitySource"), value: capabilities?.source ?? t("panel.snapshot.capabilityUnknown") }),
          ),
          h("div", { className: "sap-note", key: "capabilities" }, t("panel.snapshot.capabilityNotice")),
          h("div", { className: "sap-note", key: "notice" }, t("panel.snapshot.notice")),
          h(
            "div",
            { className: "sap-actions", key: "actions" },
            h(ActionBtn, { id: ACTIONS.switchModel }, t("panel.snapshot.switchModel")),
            h(ActionBtn, { id: ACTIONS.switchPermission }, t("panel.snapshot.switchPermission")),
          ),
        ];
      }

      /**
       * The session config snapshot.
       *
       * The card draws what the host read from this Session's own Conversation,
       * and only that: with demo off there is no other source. Not read yet,
       * could not be read, this session has no Conversation yet, and the Core is
       * not connected are four different facts — only the last of them is about
       * the link — and each is said as itself, so an absent sample is never
       * reported as a Core that is down. The demo fixture is drawn only while
       * demo is on, which is the only thing that can turn it on.
       */
      function SnapshotCard(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        const fixture = services.fixture("snapshot");
        const card = (children) =>
          h(Card, {
            title: t("panel.snapshot.title"),
            collapsible: true,
            id: "snapshot",
            aside: h("span", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.snapshot.fixed")),
            children,
          });
        const line = (text) => h("div", { className: "sap-unavailable" }, text);

        if (fixture !== null) return card(snapshotFields(fixture, t));
        if (state.connection !== "ready") return card(line(t("panel.snapshot.unavailable")));
        // No Conversation means no read was attempted, so this is not a failure
        // to report and not the link: there is simply nothing to read yet.
        if (state.sessionId === null || state.conversationId === null) {
          return card(line(t("panel.snapshot.noConversation")));
        }
        if (state.snapshotError !== null) {
          const reason = services.reasonText(state.snapshotError);
          const said = t("panel.snapshot.unreadable");
          return card(line(reason === null ? said : `${said} ${reason}`));
        }
        // A snapshot carries the Session and Conversation it was read for, and
        // it is drawn only when both are the ones on screen: a configuration
        // belongs to the conversation it describes, so one read for another
        // session is not this session's config however it arrived.
        const snapshot = state.snapshot;
        if (
          snapshot === null ||
          snapshot.sessionId !== state.sessionId ||
          snapshot.conversationId !== state.conversationId
        ) {
          return card(line(t("panel.snapshot.reading")));
        }
        return card(snapshotFields(snapshot, t));
      }

      /**
       * The subagent delegations; only the connected layout shows them.
       *
       * Like the config snapshot, this card has no live source in this
       * milestone — nothing reads a Thread's delegations — so with demo off it
       * says exactly that. What it must not do is read an absent sample as a
       * Core that is down: the link is fine, the *read* does not exist yet, and
       * the two are different statements about different things.
       */
      function DelegationsCard(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        const delegations = services.fixture("delegations");
        if (delegations === null) {
          return h(Card, {
            title: t("panel.delegations.title"),
            collapsible: true,
            id: "delegations",
            aside: h("span", { className: "sap-mono sap-muted", style: { fontSize: 11 } }, t("value.unknown")),
            children: h(
              "div",
              { className: "sap-unavailable" },
              t(state.connection === "ready" ? "panel.delegations.none" : "panel.delegations.unavailable"),
            ),
          });
        }
        const row = (entry) =>
          h(
            "div",
            { className: "sap-turn", key: entry.name },
            h(Dot, { tone: entry.status === "running" ? "ok" : "idle" }),
            h("span", { className: "sap-mono" }, entry.name),
            h("span", { className: "sap-tag" }, t(entry.mode === "sync" ? "delegation.sync" : "delegation.async")),
            h("span", { className: "sap-spacer" }),
            h(
              "span",
              { className: entry.status === "running" ? "" : "sap-muted", style: { fontSize: 11 } },
              t(entry.status === "running" ? "delegation.running" : "delegation.delivered"),
            ),
            entry.status === "running"
              ? h(ActionBtn, { id: `${ACTIONS.cancelDelegation}:${entry.name}`, variant: "link" }, t("delegation.cancel"))
              : h(ActionBtn, { id: `${ACTIONS.viewDelegation}:${entry.name}`, variant: "link" }, t("delegation.view")),
          );
        return h(Card, {
          title: t("panel.delegations.title"),
          collapsible: true,
          id: "delegations",
          aside: h("span", { className: "sap-mono sap-muted", style: { fontSize: 11 } }, String(delegations.length)),
          children: h("div", { className: "sap-turns" }, delegations.map(row)),
        });
      }

      /** Recovery and blocking; the disconnected layout leads with it. */
      function RecoveryCard(props) {
        const t = props.t;
        return h(Card, {
          title: t("panel.recovery.title"),
          collapsible: true,
          id: "recovery",
          aside: h("span", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.recovery.unreadable")),
          children: [
            h(
              "div",
              { className: "sap-muted", key: "empty", style: { fontSize: 13, textAlign: "center", padding: "12px 0" } },
              t("panel.recovery.empty"),
            ),
            h("div", { className: "sap-muted", key: "hint", style: { fontSize: 11, lineHeight: 1.6 } }, t("panel.recovery.emptyHint")),
            h(
              "div",
              { className: "sap-fields", key: "fields" },
              h(Field, { label: t("panel.recovery.pendingWait"), value: t("value.unknown") }),
              h(Field, { label: t("panel.recovery.activeDelegation"), value: t("value.unknown") }),
            ),
          ],
        });
      }

      /**
       * The "Run & session" tab.
       *
       * Connected and disconnected are two compositions in the design: the
       * first shows the Run, the snapshot and the delegations; the second shows
       * the recovery card and a Run that is not there. The disconnected one is
       * built by the offline module, which owns that copy.
       */
      function RunSessionTab(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        // Every chunk is optional, so a card whose module did not load is left
        // out rather than handed to the element factory as `undefined`.
        const compose = (cards) =>
          cards
            .filter(([, component]) => component !== undefined)
            .map(([key, component]) => h(component, { ...props, key }));
        if (state.connection !== "ready") {
          const OfflinePanel = parts.OfflinePanel;
          if (OfflinePanel !== undefined) return h(OfflinePanel, props);
          return compose([
            ["core", CoreStatusCard],
            ["recovery", RecoveryCard],
            ["run", parts.RunPanel],
          ]);
        }
        return compose([
          ["core", CoreStatusCard],
          ["session", SessionCard],
          ["threads", ThreadsCard],
          ["run", parts.RunPanel],
          ["snapshot", SnapshotCard],
          ["delegations", DelegationsCard],
        ]);
      }

      return {
        RunSessionTab,
        CoreStatusCard,
        SessionCard,
        ThreadsCard,
        RecoveryCard,
        SnapshotCard,
        DelegationsCard,
        ACTIONS,
        dictionary: { zh, en },
        /** The connected layout's sample content, drawn only while demo is on. */
        demoFixture: {
          // The same shape the host answers with, so the sample and a live
          // snapshot are drawn by the same code and cannot drift apart.
          snapshot: {
            sessionId: "demo-session",
            conversationId: "demo-conversation",
            agentId: "main",
            agentRevision: "demo-agent-rev",
            configRevision: "demo-config-rev",
            config: {
              provider: "super-agent",
              modelId: "go-main",
              thinkingLevel: "medium",
              permissionMode: "workspace_auto",
              skillRoots: ["~/.dsh/skills", "~/.super-agent/skills"],
            },
          },
          delegations: [
            { name: "researcher", mode: "sync", status: "running" },
            { name: "writer", mode: "async", status: "delivered" },
          ],
          recovery: { status: "none", pendingWaits: 0, activeDelegations: 0 },
        },
      };
    }

    return { createMainView };
  },
});
