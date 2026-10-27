/**
 * The disconnected half of the interface, loaded as a package-local chunk.
 *
 * Two things live here. The conversation-dock notice is the design's
 * troubleshooting block: why Core is unreachable, the three steps to check, and
 * the connection actions. The panel is the other disconnected composition —
 * the Core process card in its disconnected shape, the recovery card, and the
 * Run card with no Run in it — which is a different set of cards from the
 * connected layout, not the same one with fields blanked.
 *
 * The composer itself is made inert by the shell, through dsh's own block
 * registry; this module only supplies the copy that block carries.
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  chunk: "client.offline.js",
  factory() {
    /** The action ids the notice's controls raise through the facade. */
    const ACTIONS = { reconnect: "core.reconnect", startCore: "core.start", openConfig: "core.openConfig" };

    const zh = {
      "offline.title": "Agent Core 未连接",
      "offline.body":
        "dsh-bridge 连不上 {socket}。dsh 里的会话记录只是展示副本：连上后按 lastSeq 补齐事件，游标过期时用消息分页重建。",
      "offline.step.1.title": "确认 Core 进程在运行",
      "offline.step.1.body": "运行 super-agent serve --home {home}；退出 dsh 不会停止 Core。",
      "offline.step.2.title": "检查 Socket 路径",
      "offline.step.2.body": "core.yaml 的 socketPath 要与插件配置一致；macOS 路径上限 104 字节。",
      "offline.step.3.title": "重新连接",
      "offline.step.3.body":
        "插件不代拉起 Core 进程：由安装或运维启动 super-agent serve，面板只负责连上它并显示状态。",
      "offline.reconnect": "重新连接",
      "offline.startCore": "启动 Core",
      "offline.openConfig": "打开配置目录",
      "offline.footer": "coreHome {home} · socketPath {socket} · autoStart {autoStart} · 已尝试 {attempts} 次",
    };

    const en = {
      "offline.title": "Agent Core is not connected",
      "offline.body":
        "dsh-bridge cannot reach {socket}. The session here is a display copy: once connected it catches up by lastSeq, and rebuilds from message paging when the cursor has expired.",
      "offline.step.1.title": "Check that the Core process is running",
      "offline.step.1.body": "Run super-agent serve --home {home}; leaving dsh does not stop Core.",
      "offline.step.2.title": "Check the socket path",
      "offline.step.2.body":
        "core.yaml's socketPath must match the plugin configuration; macOS caps a path at 104 bytes.",
      "offline.step.3.title": "Reconnect",
      "offline.step.3.body":
        "The plugin does not start Core for you: installation or operations runs super-agent serve, and the panel connects to it and shows its state.",
      "offline.reconnect": "Reconnect",
      "offline.startCore": "Start Core",
      "offline.openConfig": "Open config directory",
      "offline.footer": "coreHome {home} · socketPath {socket} · autoStart {autoStart} · tried {attempts} times",
    };

    /**
     * Build the disconnected views.
     * @param options.kernel - shared React/primitives/hooks from the entry.
     * @param options.services - the service facade holding the injected state.
     * @param options.parts - the pieces other modules draw, filled in by the
     * entry. Read at render time, so module order does not matter.
     */
    function createOffline({ kernel, services, parts }) {
      const { h, Card, IconWarning, useStore } = kernel;
      const { ActionBtn } = parts;

      /**
       * `conversation.input.dock`: the disconnected conversation notice.
       *
       * It draws nothing while Core is connected, so the seat it was registered
       * on stays empty rather than showing a stale diagnostic.
       */
      function OfflineNotice(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        if (state.connection === "ready") return null;
        // The reason Core is unreachable, as the host reported it — never a
        // fabricated `ENOENT`, which is the design's sample string and shows
        // only while demo is on. The last fallback is for the moment before the
        // host has answered anything at all. The host's reason is an object,
        // and the line drawn is the one line inside it.
        const reason =
          services.reasonText(state.core.error) ?? services.fixture("offline")?.error ?? t("core.unwiredReason");
        const step = (index, titleKey, bodyKey, params) =>
          h(
            "div",
            { className: "sap-step", key: `step-${index}` },
            h("span", { className: "sap-step-index" }, String(index)),
            h(
              "div",
              {},
              h("div", { className: "sap-step-title" }, t(titleKey)),
              h("div", { className: "sap-step-body" }, t(bodyKey, params)),
            ),
          );
        return h(
          "div",
          { className: "sap-root sap-offline" },
          h("div", { className: "sap-offline-icon" }, IconWarning()),
          h("h2", { className: "sap-offline-title" }, t("offline.title")),
          h("div", { className: "sap-error sap-mono" }, reason),
          h("p", { className: "sap-offline-body" }, t("offline.body", { socket: state.core.socketPath })),
          step(1, "offline.step.1.title", "offline.step.1.body", { home: state.core.home }),
          step(2, "offline.step.2.title", "offline.step.2.body", {}),
          step(3, "offline.step.3.title", "offline.step.3.body", {}),
          h(
            "div",
            { className: "sap-actions" },
            h(ActionBtn, { id: ACTIONS.reconnect, variant: "solid" }, t("offline.reconnect")),
            h(ActionBtn, { id: ACTIONS.startCore }, t("offline.startCore")),
            h(ActionBtn, { id: ACTIONS.openConfig }, t("offline.openConfig")),
          ),
          h(
            "div",
            { className: "sap-mono sap-muted", style: { fontSize: 11 } },
            t("offline.footer", {
              home: state.core.home,
              socket: state.core.socketPath,
              autoStart: String(state.core.autoStart),
              attempts: String(state.core.attempts),
            }),
          ),
        );
      }

      /**
       * The panel's disconnected composition.
       *
       * The Core card and the recovery card belong to the connected module; this
       * one only decides which of them the disconnected layout shows, and in
       * what order. A part that has not loaded is left out rather than drawn as
       * an empty card, and the Core card falls back to this module's own so the
       * panel still explains itself.
       */
      function OfflinePanel(props) {
        const core = parts.CoreStatusCard ?? OfflineCoreCard;
        const cards = [
          [core, "core"],
          [parts.RecoveryCard, "recovery"],
          [parts.RunPanel, "run"],
        ];
        return cards
          .filter(([component]) => component !== undefined)
          .map(([component, key]) => h(component, { ...props, key }));
      }

      /** A stand-in Core card for a bundle where the connected module is absent. */
      function OfflineCoreCard(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        return h(Card, {
          title: t("panel.coreProcess.title"),
          children: h(
            "div",
            { className: "sap-error sap-mono" },
            services.reasonText(state.core.error) ?? services.fixture("offline")?.error ?? t("core.unwiredReason"),
          ),
        });
      }

      return {
        OfflineNotice,
        OfflinePanel,
        ACTIONS,
        dictionary: { zh, en },
        /**
         * The disconnected sample: the design's own `ENOENT` line. It is drawn
         * only while demo is on; with demo off the card states the reason the
         * host gave, rather than claiming a failed attempt of its own.
         */
        demoFixture: { offline: { error: "connect ENOENT ~/.super-agent/run/core.sock" } },
      };
    }

    return { createOffline };
  },
});
