/**
 * The panel's "current Run" card, loaded as a package-local chunk.
 *
 * This is the area the design puts the live Run in: the Turn list, the waiting
 * count and the stop/redo/fork controls. The facts are the host's — the card
 * reads the view state the transport fills — and every control raises a real
 * command through the facade, so a stop that the Core refused reads as a
 * refusal instead of leaving a "stopped" claim behind. While a command is in
 * flight the button reads as pending, because "accepted" is not "done".
 *
 * The demo fixture is still here, and it is still the only thing that can put
 * sample data on this card: it is drawn only while demo is explicitly on *and*
 * the Core is not connected. A connected panel with nothing running is a real
 * state — "no active Run" — and it is not the same as "we do not know".
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  chunk: "client.run-panel.js",
  factory() {
    /** The action ids this card raises through the facade. */
    const ACTIONS = {
      stop: "run.stop",
      redo: "run.redo",
      fork: "run.fork",
      supplement: "run.supplement",
      // The Thread's own controls, as distinct from the Run's: they act on the
      // Thread the session runs on rather than on one Run of it.
      pause: "thread.pause",
      resume: "thread.resume",
      archive: "thread.archive",
    };

    /**
     * How many supplement ids this *module* has minted on its own.
     *
     * Module scope rather than per-card, and only the fallback path uses it: a
     * card rebuilt with no service allocator would otherwise start counting at
     * one again and mint the id the previous card already used.
     */
    let supplements = 0;

    const zh = {
      "panel.run.title": "当前 Run",
      "panel.run.running": "运行中",
      "panel.run.turnDone": "Turn {n} · 完成 · {tools} 次工具",
      "panel.run.turnStreaming": "Turn {n} · 流式输出",
      "panel.run.waiting": "等待项",
      "panel.run.waitingValue": "{count} 项 · 已用时 {elapsed}",
      "panel.run.stop": "停止 Run",
      "panel.run.redo": "重做 Run",
      "panel.run.fork": "Fork",
      "panel.run.forkHere": "从 entry {entryId} 分支",
      "panel.run.stopHint": "停止后已完成的内容保留，可继续；恢复走 POST /v1/threads/{id}:resume。",
      "panel.run.noRun": "无活动 Run",
      "panel.run.status": "Run 状态",
      "panel.run.turn": "Turn",
      "panel.run.thread": "Thread",
      "panel.run.unknown": "—",
      "panel.run.offlineNote": "连接 Core 后这些操作恢复可用；会话内容以 Core 为准，不写回本地副本。",
      "panel.run.idleNote": "已连接 Core，当前没有运行中的 Run。",
      "panel.run.receipt": "{action} 回执：{id}",
      "panel.run.receiptAction.stop": "停止",
      "panel.run.receiptAction.redo": "重做",
      "panel.run.receiptAction.fork": "Fork",
      "panel.run.forkNote": "Fork 在 Core 里复制出分支 Conversation，再用 dsh 自己的 fork 打开新会话并切过去；回执里是新会话 id 与分支 Conversation id。",
      "panel.run.forkReceipt":
        "Fork 回执：新会话 {sessionId} · Core Conversation {conversationId} · 分支点 entry {boundary}",
      "panel.run.boundary": "分支点 entry",
      "panel.run.boundaryNone": "未选择",
      "panel.run.boundaryReading": "正在读取该 Conversation 的持久消息，用作 Fork 的分支点…",
      "panel.run.boundaryUnreadable": "读不到该 Conversation 的消息：{reason}",
      "panel.run.boundaryEmpty": "该 Conversation 还没有可作分支点的持久消息（entryId）。",
      "panel.run.boundaryHint":
        "Fork 从你点选的那条持久消息处分支：Core 要求 sourceEntryId，未选择时这里不发请求，也不会替你猜一个 entry。",
      "panel.run.boundaryEntry": "entry {entryId} · {role}",
      "panel.run.target": "目标 Run",
      "panel.run.conversation": "Conversation",
      "panel.run.supplementPlaceholder": "补充给上面这个 Run 的下一轮…",
      "panel.run.supplement": "补充到 Run",
      "panel.run.supplementHint":
        "以 next_turn 追加到上面点名的那个 Run（不进队列、不等旧 Run 结束）；目标已结束或缺失时由 Core 明确拒绝，不会变成新的 Run。",
      "panel.run.supplementReceipt": "补充回执：inputId {inputId} · 投递 {delivery} · Run {runId} · 状态 {state}",
      "panel.run.supplementNoTarget": "补充必须点名一个活动 Run：当前没有活动 Run，所以这里不提供补充操作。",
      "panel.run.history": "历史",
      "panel.run.historyReading": "正在读取该 Thread 的历史…",
      "panel.run.historyUnreadable": "读不到该 Thread 的历史：{reason}",
      "panel.run.historyEmpty": "该 Thread 还没有 Run。",
      "panel.run.historyRun": "{runId} · {status}",
      "panel.run.historyTurnsReading": "正在读取该 Run 的 Turn…",
      "panel.run.historyTurnsUnreadable": "读不到该 Run 的 Turn：{reason}",
      "panel.run.historyTurnsEmpty": "该 Run 没有 Turn。",
      "panel.run.historyTurn": "Turn {n} · {status}",
      "panel.run.historyMessages": "该 Conversation 的消息",
      "panel.run.historyMessagesLoading": "正在读取该 Conversation 的持久消息…",
      "panel.run.historyMessagesUnreadable": "读不到该 Conversation 的消息：{reason}",
      "panel.run.historyMessagesEmpty": "该 Conversation 还没有持久消息。",
      "panel.run.historyCaughtUp": "Core 报 caughtUp：投影已追平至水位 {watermark}（这只说投影读到了这里，不等于消息已读完）。",
      "panel.run.historyPageEnd": "已读到最后一条（没有后续页）。",
      "panel.run.historyMessage": "{role} · {text}",
      "panel.run.historyMore": "加载后续消息",
      "panel.run.historyMoreHint": "游标 {cursor} · 水位 {watermark} · 已读 {count} 条",
      "panel.run.historyRefresh": "刷新历史",
      "panel.run.redoCompleted": "重做这个已完成的 Run",
      "panel.thread.title": "Thread 控制",
      "panel.thread.reading": "正在读取该 Thread 的控制状态…",
      "panel.thread.unreadable": "读不到该 Thread 的控制状态：{reason}",
      "panel.thread.status": "Thread 状态",
      "panel.thread.blocking": "阻塞原因",
      "panel.thread.pause": "暂停 Thread",
      "panel.thread.resume": "恢复 Thread",
      "panel.thread.archive": "归档 Core Thread",
      "panel.thread.controlsOffline": "连接 Core 后这些控制恢复可用。",
      "panel.thread.archiveHint":
        "归档后此 Thread 停止推进，已有记录仍可查看。",
      "panel.thread.resumeHint":
        "恢复会解除暂停；只继续所选 Run、处理所选输入，其余保持原状。",
      "panel.thread.stoppedRuns": "已取消、可继续的 Run",
      "panel.thread.noStoppedRuns": "没有可继续的 Run。",
      "panel.thread.queuedInputs": "排队中的输入",
      "panel.thread.noQueuedInputs": "没有排队输入。",
      "panel.thread.queuedInput": "{inputId} · {conversationId}",
      "panel.thread.queuedRun": "执行",
      "panel.thread.queuedDrop": "丢弃",
      "panel.thread.queuedKept": "保持排队",
      "panel.thread.resumeNeedsChoice": "暂停时可直接恢复；需要继续工作时，请选择下方的 Run 或输入。",
      "panel.thread.refresh": "刷新 Thread 状态",
      "panel.thread.receipt": "{action} 回执：{id} · 状态 {state} · 请求 {requestId} · 序号 {receiptSeq}",
      "panel.thread.receiptStarted": "已启动 Run：{runIds}",
      "panel.thread.receiptAction.pause": "暂停",
      "panel.thread.receiptAction.resume": "恢复",
      "panel.thread.receiptAction.archive": "归档",
    };

    const en = {
      "panel.run.title": "Current Run",
      "panel.run.running": "running",
      "panel.run.turnDone": "Turn {n} · done · {tools} tool calls",
      "panel.run.turnStreaming": "Turn {n} · streaming",
      "panel.run.waiting": "Waiting",
      "panel.run.waitingValue": "{count} items · {elapsed} elapsed",
      "panel.run.stop": "Stop Run",
      "panel.run.redo": "Redo Run",
      "panel.run.fork": "Fork",
      "panel.run.forkHere": "Fork at entry {entryId}",
      "panel.run.stopHint": "Completed content is kept and can be resumed via POST /v1/threads/{id}:resume.",
      "panel.run.noRun": "No active Run",
      "panel.run.status": "Run state",
      "panel.run.turn": "Turn",
      "panel.run.thread": "Thread",
      "panel.run.unknown": "—",
      "panel.run.offlineNote":
        "These actions return once Core is connected; the session follows Core and is not written back locally.",
      "panel.run.idleNote": "Core is connected and no Run is running.",
      "panel.run.receipt": "{action} receipt: {id}",
      "panel.run.receiptAction.stop": "stop",
      "panel.run.receiptAction.redo": "redo",
      "panel.run.receiptAction.fork": "fork",
      "panel.run.forkNote":
        "Fork copies a branch Conversation in Core, then opens a new dsh session on it through dsh's own fork and switches to it; the receipt names both ids.",
      "panel.run.forkReceipt":
        "Fork receipt: new session {sessionId} · Core conversation {conversationId} · branch entry {boundary}",
      "panel.run.boundary": "Branch entry",
      "panel.run.boundaryNone": "none chosen",
      "panel.run.boundaryReading": "Reading this Conversation's persisted messages for the fork boundary…",
      "panel.run.boundaryUnreadable": "This Conversation's messages could not be read: {reason}",
      "panel.run.boundaryEmpty": "This Conversation has no persisted message (entryId) to branch at yet.",
      "panel.run.boundaryHint":
        "A fork branches at the persisted message you pick: the Core requires sourceEntryId, and while none is chosen no request is sent — no entry is guessed for you.",
      "panel.run.boundaryEntry": "entry {entryId} · {role}",
      "panel.run.target": "Target Run",
      "panel.run.conversation": "Conversation",
      "panel.run.supplementPlaceholder": "Supplement the Run above's next turn…",
      "panel.run.supplement": "Supplement Run",
      "panel.run.supplementHint":
        "Appended to the Run named above as next_turn — it does not queue and does not wait for that Run to end; when the target has ended or is missing the Core refuses, and the words do not become a new Run.",
      "panel.run.supplementReceipt": "Supplement receipt: inputId {inputId} · delivery {delivery} · Run {runId} · state {state}",
      "panel.run.supplementNoTarget":
        "A supplement must name an active Run: there is none, so this card offers no supplement here.",
      "panel.run.history": "History",
      "panel.run.historyReading": "Reading this Thread's history…",
      "panel.run.historyUnreadable": "This Thread's history could not be read: {reason}",
      "panel.run.historyEmpty": "This Thread has no Run yet.",
      "panel.run.historyRun": "{runId} · {status}",
      "panel.run.historyTurnsReading": "Reading this Run's Turns…",
      "panel.run.historyTurnsUnreadable": "This Run's Turns could not be read: {reason}",
      "panel.run.historyTurnsEmpty": "This Run has no Turn.",
      "panel.run.historyTurn": "Turn {n} · {status}",
      "panel.run.historyMessages": "This Conversation's messages",
      "panel.run.historyMessagesLoading": "Reading this Conversation's persisted messages…",
      "panel.run.historyMessagesUnreadable": "This Conversation's messages could not be read: {reason}",
      "panel.run.historyMessagesEmpty": "This Conversation has no persisted message yet.",
      "panel.run.historyCaughtUp": "The Core reports caughtUp: the projection has caught up to watermark {watermark} (that is where the projection has read to, not that the messages have been read to the end).",
      "panel.run.historyPageEnd": "Read to the last message (there is no later page).",
      "panel.run.historyMessage": "{role} · {text}",
      "panel.run.historyMore": "Load later messages",
      "panel.run.historyMoreHint": "cursor {cursor} · watermark {watermark} · {count} read",
      "panel.run.historyRefresh": "Refresh history",
      "panel.run.redoCompleted": "Redo this completed Run",
      "panel.thread.title": "Thread controls",
      "panel.thread.reading": "Reading this Thread's control state…",
      "panel.thread.unreadable": "This Thread's control state could not be read: {reason}",
      "panel.thread.status": "Thread status",
      "panel.thread.blocking": "Blocking reasons",
      "panel.thread.pause": "Pause Thread",
      "panel.thread.resume": "Resume Thread",
      "panel.thread.archive": "Archive Core Thread",
      "panel.thread.controlsOffline": "These controls come back once the Core is connected.",
      "panel.thread.archiveHint":
        "Archiving stops this Thread from advancing. Its existing records remain available.",
      "panel.thread.resumeHint":
        "Resume clears the pause and handles only the selected Runs and inputs. Everything else keeps its current state.",
      "panel.thread.stoppedRuns": "Cancelled Runs that can be continued",
      "panel.thread.noStoppedRuns": "No Runs to continue.",
      "panel.thread.queuedInputs": "Queued inputs",
      "panel.thread.noQueuedInputs": "No queued inputs.",
      "panel.thread.queuedInput": "{inputId} · {conversationId}",
      "panel.thread.queuedRun": "Run",
      "panel.thread.queuedDrop": "Drop",
      "panel.thread.queuedKept": "Keep queued",
      "panel.thread.resumeNeedsChoice": "A paused Thread can resume without starting work. Select Runs or inputs below to continue them.",
      "panel.thread.refresh": "Refresh Thread state",
      "panel.thread.receipt": "{action} receipt: {id} · state {state} · request {requestId} · sequence {receiptSeq}",
      "panel.thread.receiptStarted": "Runs started: {runIds}",
      "panel.thread.receiptAction.pause": "Pause",
      "panel.thread.receiptAction.resume": "Resume",
      "panel.thread.receiptAction.archive": "Archive",
    };

    /**
     * Build the Run card.
     * @param options.kernel - shared React/primitives/hooks from the entry.
     * @param options.services - the service facade holding the injected state.
     * @param options.parts - pieces other modules draw; this card draws only
     *   its own, and reads `parts.ActionBtn` for its controls.
     */
    function createRunPanel({ kernel, services, parts }) {
      const { h, Dot, Card, Field, Btn, useStore, useOutcome, React } = kernel;
      const { ActionBtn } = parts;

      /** One Turn row: a finished Turn names its tool calls, the live one streams. */
      const TurnRow = ({ turn, t }) =>
        h(
          "div",
          { className: "sap-turn", key: `turn-${turn.n}` },
          h(Dot, { tone: turn.state === "done" ? "idle" : "ok" }),
          h(
            "span",
            {},
            turn.state === "done"
              ? t("panel.run.turnDone", { n: turn.n, tools: turn.tools })
              : t("panel.run.turnStreaming", { n: turn.n }),
          ),
        );

      /**
       * What one action's receipt says, or nothing while there is none.
       *
       * A receipt is the Core's answer, and it is shown as the id the Core
       * named: a fork's new Conversation, a stop's Thread, a redo's Run. An
       * action that has not answered yet shows nothing here — the button is
       * already saying it is pending.
       */
      const Receipt = ({ outcome, label, t }) => {
        const result = outcome.status === "done" ? outcome.result : null;
        if (result === null || result === undefined) return null;
        // A fork answers with two ids that are not interchangeable: the dsh
        // session the user can now find in the sidebar, and the Core
        // Conversation it reads. Showing one of them as "the id" would leave
        // the reader unable to check either half of the mapping.
        if (result.sessionId !== undefined && result.conversationId !== undefined) {
          return h(
            "div",
            { className: "sap-muted sap-mono", style: { fontSize: 11, lineHeight: 1.6 } },
            t("panel.run.forkReceipt", {
              sessionId: String(result.sessionId),
              conversationId: String(result.conversationId),
              // The boundary the Core *reports* it inherited through, next to
              // the one that was chosen: the two are the check that the branch
              // was taken where the user said, and a Core answer that differs
              // from the selection is visible here rather than assumed equal.
              boundary: String(result.inheritedThrough ?? t("panel.run.unknown")),
            }),
          );
        }
        const id = result.conversationId ?? result.threadId ?? result.runId ?? result.state ?? null;
        if (id === null) return null;
        return h(
          "div",
          { className: "sap-muted sap-mono", style: { fontSize: 11, lineHeight: 1.6 } },
          t("panel.run.receipt", { action: t(`panel.run.receiptAction.${label}`), id: String(id) }),
        );
      };

      /**
       * What the supplement's receipt says, or nothing while there is none.
       *
       * The receipt is the Core's own answer, drawn as the ids it named: the
       * input the words became, the delivery the Core actually used, and the Run
       * they went to. `next_turn` is shown as itself — a receipt that came back
       * `new_run` would be visible here rather than passed off as the supplement
       * that was asked for.
       */
      const SupplementReceipt = ({ outcome, t }) => {
        const result = outcome.status === "done" ? outcome.result : null;
        if (result === null || result === undefined) return null;
        return h(
          "div",
          { className: "sap-muted sap-mono", style: { fontSize: 11, lineHeight: 1.6 } },
          t("panel.run.supplementReceipt", {
            inputId: String(result.inputId ?? result.resourceId ?? t("panel.run.unknown")),
            delivery: String(result.delivery ?? t("panel.run.unknown")),
            runId: String(result.runId ?? t("panel.run.unknown")),
            state: String(result.state ?? t("panel.run.unknown")),
          }),
        );
      };

      /**
       * The Runs a Thread view names, in the shape this card draws.
       *
       * The Core has carried the list two ways: `runs` entries with their own
       * status, and the older pair of id lists. Both are read — a build that
       * reports only ids still shows its history, and one that reports statuses
       * shows them as they are.
       * @param view - a `ThreadView`.
       */
      const runsOf = (view) => {
        if (Array.isArray(view?.runs)) {
          return view.runs
            .filter((run) => typeof run?.runId === "string" && run.runId !== "")
            .map((run) => ({
              runId: run.runId,
              conversationId: run.conversationId ?? null,
              status: run.status ?? null,
            }));
        }
        const active = Array.isArray(view?.activeRuns) ? view.activeRuns : [];
        const queued = Array.isArray(view?.queuedRuns) ? view.queuedRuns : [];
        return [
          ...active.map((runId) => ({ runId, conversationId: null, status: "running" })),
          ...queued.map((runId) => ({ runId, conversationId: null, status: "queued" })),
        ];
      };

      /** The two statuses a Run is in when it has stopped for good. */
      const terminalStatuses = ["completed", "failed", "cancelled"];

      /**
       * What the Thread already holds, so a finished Run does not vanish.
       *
       * The card above is about the Run that is live; this is about the ones
       * that are not. A Run that has completed has to stay reachable — its
       * Turns, and a Redo — rather than the panel falling to "no active Run"
       * and losing the history behind it. Every fact drawn here is the Core's
       * own read: the Thread's Run list, one Run's Turns, and the Conversation's
       * messages paged by the cursor the Core itself gives.
       */
      function History({ services, t, threadId, conversationId, revision }) {
        const callable = typeof services.run === "function";
        const [runs, setRuns] = React.useState(null);
        const [runsError, setRunsError] = React.useState(null);
        const [selected, setSelected] = React.useState(null);
        const [turns, setTurns] = React.useState(null);
        const [turnsError, setTurnsError] = React.useState(null);
        const [messages, setMessages] = React.useState(null);
        const [cursor, setCursor] = React.useState(null);
        // The Core's own two facts about the page, drawn as they come rather
        // than worked out here. They are two different axes and the card keeps
        // them apart: `nextCursor` (drawn as the cursor) says whether another
        // page of *messages* exists, while `caughtUp` says whether the
        // projection has caught up with Pi's transcript — a page can carry a
        // cursor and still be `caughtUp`, and one that says `caughtUp` can still
        // have later pages. `watermark` is the last native entry the projection
        // has consumed, the position the history is known to be complete *up
        // to*. Reading "there is no more" off a missing cursor instead would
        // turn "the projection has not looked yet" into "there is nothing
        // later", which is the one thing the page's own contract says a reader
        // must not do.
        const [watermark, setWatermark] = React.useState(null);
        const [caughtUp, setCaughtUp] = React.useState(false);
        const [messagesError, setMessagesError] = React.useState(null);
        const [loadingMore, setLoadingMore] = React.useState(false);
        /** Bumped by the refresh control, to re-read without the card moving. */
        const [refreshNonce, setRefreshNonce] = React.useState(0);
        /**
         * What the card is showing *now*, in a cell that outlives a re-render.
         *
         * `choose` and `loadMore` read with an `await`, and the card can move
         * under one: another Run can be chosen, the session can switch
         * Conversations. The closure a handler runs in holds the identity it was
         * rendered with — the one that moved *away* — so a reply is checked
         * against this cell instead, which the render (and `choose` itself, the
         * moment it is asked for a Run) keeps current. A reply whose target is
         * no longer on screen is dropped rather than drawn under the new one.
         * A `useState` cell is used as the ref because the bundle's React shim
         * carries no `useRef`.
         */
        const [onScreen] = React.useState(() => ({ conversationId: null, runId: null, refreshNonce: 0 }));
        onScreen.conversationId = conversationId ?? null;
        onScreen.refreshNonce = refreshNonce;
        onScreen.revision = revision;
        const redo = useOutcome(services, ACTIONS.redo);
        const fork = useOutcome(services, ACTIONS.fork);

        // The Thread's Runs. Two effects, not one: the first is what the card
        // does when it *moves to another Thread* — the entries on screen belong
        // to the Thread that left, so they go — and the second is the read
        // itself. Splitting them is what lets a re-read *refresh* the Runs
        // instead of clearing the card: a reader who has drilled into one Run's
        // Turns keeps them while a newer Run appears beside them. Keyed only on
        // the Thread, the read would freeze at its first answer and the Run that
        // just started or finished would never appear; it is therefore also
        // keyed on the host's own account of this session (see `revision`).
        React.useEffect(() => {
          setRuns(null);
          setRunsError(null);
          setSelected(null);
          setTurns(null);
          setTurnsError(null);
          // The chosen Run left with the Thread: a reply still in flight for it
          // must not be taken for one of the new Thread's Runs.
          onScreen.runId = null;
        }, [threadId]);

        React.useEffect(() => {
          if (threadId === null || threadId === undefined || !callable) return undefined;
          let current = true;
          void (async () => {
            const answer = await services.run("thread.get", { threadId });
            if (!current) return;
            if (answer?.status !== "done") {
              setRunsError(answer?.reason ?? null);
              return;
            }
            setRuns(runsOf(answer.result));
          })();
          return () => {
            current = false;
          };
        }, [threadId, revision, refreshNonce]);

        // The Conversation's first page of persisted messages. As above, the
        // clear and the read are told apart; here they share their keys, because
        // a refresh of this axis means reading it from its first page again
        // (the pages a reader has already walked are asked for from the cursor
        // the Core gave, and a refresh that kept them would have to be a cache).
        React.useEffect(() => {
          setMessages(null);
          setCursor(null);
          setWatermark(null);
          setCaughtUp(false);
          setMessagesError(null);
        }, [conversationId, revision, refreshNonce]);

        React.useEffect(() => {
          if (conversationId === null || conversationId === undefined || !callable) return undefined;
          let current = true;
          void (async () => {
            const answer = await services.run("messages.list", { conversationId, limit: 20 });
            if (!current) return;
            if (answer?.status !== "done") {
              setMessagesError(answer?.reason ?? null);
              return;
            }
            setMessages(Array.isArray(answer.result?.items) ? answer.result.items : []);
            setCursor(answer.result?.nextCursor ?? null);
            setWatermark(answer.result?.watermark ?? null);
            setCaughtUp(answer.result?.caughtUp === true);
          })();
          return () => {
            current = false;
          };
        }, [conversationId, revision, refreshNonce]);

        /**
         * One more page of the Conversation, from the cursor the Core gave.
         *
         * The page is asked for with the Conversation *this render* is showing,
         * and appended only if that is still the one on screen when the answer
         * arrives: a page read for a line the card has left is dropped, not
         * written under the new line. The cursor is the Core's own — the page it
         * names is the one *after* this one, which is the later messages, so the
         * control says so rather than calling them earlier.
         */
        const loadMore = async () => {
          if (cursor === null || conversationId === null || conversationId === undefined) return;
          const forConversation = conversationId;
          const forNonce = refreshNonce;
          const forRevision = revision;
          setLoadingMore(true);
          const answer = await services.run("messages.list", { conversationId: forConversation, limit: 20, cursor });
          setLoadingMore(false);
          // Dropped if the card moved to another Conversation, or if the page
          // was refreshed under the read: in either case the list this answer
          // was read to extend is no longer the one on screen.
          if (onScreen.conversationId !== forConversation || onScreen.refreshNonce !== forNonce ||
              onScreen.revision !== forRevision) return;
          if (answer?.status !== "done") {
            setMessagesError(answer?.reason ?? null);
            return;
          }
          const items = Array.isArray(answer.result?.items) ? answer.result.items : [];
          setMessages((previous) => [...(previous ?? []), ...items]);
          setCursor(answer.result?.nextCursor ?? null);
          setWatermark(answer.result?.watermark ?? null);
          setCaughtUp(answer.result?.caughtUp === true);
        };

        /**
         * One Run's Turns, read when its row is chosen.
         *
         * A later choice supersedes an earlier one, and the two reads can
         * finish out of order: the answer is drawn only when the Run it was read
         * for is still the chosen one, so a Turn list that arrives late is
         * dropped rather than drawn under another Run's name.
         */
        const choose = async (run) => {
          onScreen.runId = run.runId;
          setSelected(run.runId);
          setTurns(null);
          setTurnsError(null);
          const answer = await services.run("turns.list", { runId: run.runId, limit: 50 });
          if (onScreen.runId !== run.runId) return;
          if (answer?.status !== "done") {
            setTurnsError(answer?.reason ?? null);
            return;
          }
          setTurns(Array.isArray(answer.result?.items) ? answer.result.items : []);
        };

        if (!callable) return null;
        // No Thread, no history: a session the home has no Thread for has
        // nothing to show here, and the card above already says so. Drawing a
        // "reading…" that can never finish would be worse than drawing nothing.
        if (threadId === null || threadId === undefined) return null;

        return h(
          "div",
          { className: "sap-fields", key: "history" },
          h("div", { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } }, t("panel.run.history")),
          runs === null && runsError === null
            ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.run.historyReading"))
            : null,
          runsError !== null
            ? h("div", { className: "sap-error sap-mono", style: { fontSize: 11 } }, t("panel.run.historyUnreadable", { reason: runsError }))
            : null,
          runs !== null && runs.length === 0
            ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.run.historyEmpty"))
            : null,
          runs === null || runs.length === 0
            ? null
            : h(
                "div",
                { className: "sap-actions", style: { flexWrap: "wrap" } },
                runs.map((run) =>
                  h(
                    "span",
                    { key: `history-${run.runId}`, style: { display: "inline-flex", gap: 4, alignItems: "center" } },
                    h(
                      Btn,
                      {
                        variant: run.runId === selected ? "solid" : "ghost",
                        onClick: () => void choose(run),
                      },
                      t("panel.run.historyRun", { runId: run.runId, status: run.status ?? t("panel.run.unknown") }),
                    ),
                    // A finished Run's Redo is reachable from the history entry
                    // — that is the whole point of keeping the entry. A Run
                    // that is still going offers no Redo here: the live card
                    // above is the one that acts on it.
                    terminalStatuses.includes(run.status)
                      ? h(
                          ActionBtn,
                          { id: ACTIONS.redo, payload: { runId: run.runId } },
                          t("panel.run.redoCompleted"),
                        )
                      : null,
                  ),
                ),
              ),
          selected === null
            ? null
            : h(
                "div",
                { className: "sap-fields", key: "history-turns" },
                turns === null && turnsError === null
                  ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.run.historyTurnsReading"))
                  : null,
                turnsError !== null
                  ? h("div", { className: "sap-error sap-mono", style: { fontSize: 11 } }, t("panel.run.historyTurnsUnreadable", { reason: turnsError }))
                  : null,
                turns !== null && turns.length === 0
                  ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.run.historyTurnsEmpty"))
                  : null,
                turns === null
                  ? null
                  : turns.map((turn, index) =>
                      h(
                        "div",
                        { key: `history-turn-${turn?.turnId ?? index}`, className: "sap-muted sap-mono", style: { fontSize: 11 } },
                        t("panel.run.historyTurn", {
                          n: turn?.turnId ?? index + 1,
                          status: turn?.status ?? t("panel.run.unknown"),
                        }),
                      ),
                    ),
              ),
          h(Receipt, { key: "history-receipt-redo", outcome: redo, label: "redo", t }),
          h(
            "div",
            { className: "sap-fields", key: "history-messages" },
            h("div", { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } }, t("panel.run.historyMessages")),
            messages === null && messagesError === null
              ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.run.historyMessagesLoading"))
              : null,
            messagesError !== null
              ? h("div", { className: "sap-error sap-mono", style: { fontSize: 11 } }, t("panel.run.historyMessagesUnreadable", { reason: messagesError }))
              : null,
            messages !== null && messages.length === 0
              ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.run.historyMessagesEmpty"))
              : null,
            // The messages themselves, not only how many were read: a history
            // entry that named a count and nothing else would not be a view of
            // the Conversation. Each row is the Core's own `MessageView`, with
            // the role it reports and the text it holds — a message with no
            // text (a tool call) shows its role alone rather than an invented
            // body.
            messages === null
              ? null
              : messages.map((item, index) =>
                  h(
                    "div",
                    {
                      key: `history-message-${item?.messageId ?? item?.entryId ?? index}`,
                      className: "sap-muted sap-mono",
                      style: { fontSize: 11 },
                    },
                    t("panel.run.historyMessage", {
                      role: item?.role ?? t("panel.run.unknown"),
                      text: item?.text ?? "",
                    }),
                    Number.isSafeInteger(item?.entryId)
                      ? h(ActionBtn, {
                          id: ACTIONS.fork,
                          payload: { conversationId, sourceEntryId: item.entryId },
                        }, t("panel.run.forkHere", { entryId: item.entryId }))
                      : null,
                  ),
                ),
            messages !== null && messages.length > 0
              ? h(
                  "div",
                  { className: "sap-muted sap-mono", style: { fontSize: 11 } },
                  t("panel.run.historyMoreHint", {
                    cursor: cursor ?? t("panel.run.unknown"),
                    watermark: watermark ?? t("panel.run.unknown"),
                    count: messages.length,
                  }),
                )
              : null,
            // The two axes are drawn as they came, and kept apart. "There is no
            // later page" is the cursor the Core did *not* give; "the projection
            // has caught up" is the Core's `caughtUp`, which says nothing about
            // pages — a first page can be caught up and still have later ones.
            // Drawing the second as the first would say the Conversation had
            // been read to its end when the Core only said the projection had
            // reached the watermark.
            messages !== null && cursor === null && messages.length > 0
              ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.run.historyPageEnd"))
              : null,
            caughtUp === true && messages !== null
              ? h(
                  "div",
                  { className: "sap-muted", style: { fontSize: 11 } },
                  t("panel.run.historyCaughtUp", { watermark: watermark ?? t("panel.run.unknown") }),
                )
              : null,
            h(
              "div",
              { className: "sap-actions", key: "history-refresh", style: { gap: 6 } },
              // A Thread's own history moves when the Core commits to it, and
              // the host's account of this session (the Run above) does not
              // always move with it — a message committed while nothing is
              // running is one the card would otherwise never read. The control
              // is the explicit half of the refresh: the Runs are re-read on the
              // host's own state as well, and this re-reads both.
              h(
                Btn,
                { onClick: () => setRefreshNonce((previous) => previous + 1) },
                t("panel.run.historyRefresh"),
              ),
              cursor === null
                ? null
                : h(
                    Btn,
                    { disabled: loadingMore, onClick: () => void loadMore() },
                    t("panel.run.historyMore"),
                  ),
            ),
            h(Receipt, { key: "history-receipt-fork", outcome: fork, label: "fork", t }),
          ),
        );
      }

      /**
       * What can be done to the Thread itself.
       *
       * The Run card acts on one Run; these act on the Thread the session runs
       * on — pausing it, resuming the work a stop left behind, and archiving it
       * in the Core. Each is a Core command, and the card draws the Core's own
       * Thread view (its status, the Runs it holds, the inputs it has queued)
       * so a control is offered against a fact rather than a guess.
       *
       * Resume is the one that must not infer. The Core's own contract says an
       * unlisted Run stays cancelled and an unlisted input stays queued —
       * resuming is an instruction, not an inference — so the lists sent are
       * exactly the ones the user marked. An empty selection can still clear
       * the Thread's user pause without starting any work.
       *
       * Archiving here is the *Core's* Thread archive. It is not a dsh session
       * archive, and the card says so rather than letting one stand for the
       * other: the two are different objects, and a control that silently did
       * one while being read as the other would be the confusion this card is
       * meant to prevent.
       */
      function ThreadControls({ services, t, threadId, enabled, revision }) {
        const callable = typeof services.run === "function";
        const [loadedView, setView] = React.useState(null);
        const view = loadedView?.threadId === threadId ? loadedView : null;
        const [error, setError] = React.useState(null);
        const [refreshNonce, setRefreshNonce] = React.useState(0);
        /** The cancelled Runs the user has named for continuation. */
        const [continueRunIds, setContinueRunIds] = React.useState([]);
        /** What the user decided about a queued input, by its id. */
        const [decisions, setDecisions] = React.useState({});
        const pause = useOutcome(services, ACTIONS.pause);
        const resume = useOutcome(services, ACTIONS.resume);
        const archive = useOutcome(services, ACTIONS.archive);

        // A decision belongs to the Thread it was made about, so moving to
        // another Thread starts from nothing chosen rather than carrying the
        // previous Thread's names over.
        React.useEffect(() => {
          setContinueRunIds([]);
          setDecisions({});
          setView(null);
          setError(null);
        }, [threadId]);

        // The Core's own view of the Thread. Re-read when the Thread changes and
        // after any of the three commands answers: the state a control is drawn
        // against is the state the Core last reported, not the one this half
        // hoped for.
        React.useEffect(() => {
          if (enabled !== true || threadId === null || threadId === undefined || !callable) return undefined;
          let current = true;
          void (async () => {
            const answer = await services.run("thread.get", { threadId });
            if (!current) return;
            if (answer?.status !== "done") {
              setView(null);
              setError(answer?.reason ?? "Thread state is unavailable");
              return;
            }
            setError(null);
            setView(answer.result ?? null);
          })();
          return () => {
            current = false;
          };
        }, [threadId, enabled, revision, refreshNonce, pause.status, resume.status, archive.status]);

        const stoppedRuns = Array.isArray(view?.runs)
          ? view.runs.filter((run) => run?.status === "cancelled" && typeof run.runId === "string")
          : null;
        const queuedInputs = Array.isArray(view?.queuedInputIds)
          ? view.queuedInputIds.filter((input) => typeof input?.inputId === "string")
          : null;
        const chosenRuns = continueRunIds.filter((id) => stoppedRuns?.some((run) => run.runId === id));
        const chosenInputs = Object.entries(decisions)
          .filter(([id, action]) => (action === "run" || action === "drop") && queuedInputs?.some((input) => input.inputId === id))
          .map(([inputId, action]) => ({ inputId, action }));
        const hasChoice = chosenRuns.length > 0 || chosenInputs.length > 0;
        const paused = view?.status === "paused_by_user" || view?.status === "paused" ||
          view?.blockingReasons?.some((reason) => reason?.kind === "gate" && reason.gate === "paused_by_user");
        const archived = view?.status === "archived";
        const toggleRun = (runId) =>
          setContinueRunIds((previous) =>
            previous.includes(runId) ? previous.filter((id) => id !== runId) : [...previous, runId],
          );
        // Clicking the action already chosen takes it back: "keep queued" has to
        // be reachable again, or the only way out of a decision would be a
        // different decision.
        const decide = (inputId, action) =>
          setDecisions((previous) => {
            const next = { ...previous };
            if (next[inputId] === action) delete next[inputId];
            else next[inputId] = action;
            return next;
          });
        /** The resume's own two lists, and only the ones that were chosen. */
        const resumePayload = () => ({
          threadId,
          ...(chosenRuns.length === 0 ? {} : { continueRunIds: chosenRuns }),
          ...(chosenInputs.length === 0 ? {} : { queuedInputs: chosenInputs }),
        });
        const receiptOf = (outcome, label) => {
          const result = outcome.status === "done" ? outcome.result : null;
          if (result === null || result === undefined) return null;
          if ((result.resourceId ?? result.threadId) !== threadId) return null;
          return h(
            "div",
            { className: "sap-muted sap-mono", style: { fontSize: 11, lineHeight: 1.6 } },
            t("panel.thread.receipt", {
              action: t(`panel.thread.receiptAction.${label}`),
              id: String(result.resourceId ?? result.threadId ?? t("panel.run.unknown")),
              state: String(result.state ?? t("panel.run.unknown")),
              requestId: String(result.requestId ?? t("panel.run.unknown")),
              receiptSeq: String(result.receiptSeq ?? t("panel.run.unknown")),
            }),
            // A resume answers with the Runs it minted, and they are shown as
            // the Core named them — a receipt that reported none is a resume
            // that continued nothing.
            Array.isArray(result.startedRunIds) && result.startedRunIds.length > 0
              ? h(
                  "div",
                  { className: "sap-muted sap-mono", style: { fontSize: 11 } },
                  t("panel.thread.receiptStarted", { runIds: result.startedRunIds.join(", ") }),
                )
              : null,
          );
        };

        const actions = (disabled) =>
          h(
            "div",
            { className: "sap-actions", key: "thread-actions", style: { flexWrap: "wrap" } },
            // Each control carries the Thread it acts on, so it acts on the one
            // it names rather than on whatever is "current" when it is clicked.
            h(ActionBtn, { id: ACTIONS.pause, disabled: disabled || paused, payload: () => ({ threadId }) }, t("panel.thread.pause")),
            h(
              ActionBtn,
              { id: ACTIONS.resume, disabled: disabled || (!hasChoice && !paused), payload: resumePayload },
              t("panel.thread.resume"),
            ),
            h(ActionBtn, { id: ACTIONS.archive, disabled, payload: () => ({ threadId }) }, t("panel.thread.archive")),
          );

        // Not connected: the controls are drawn disabled rather than absent, so
        // the card says they exist and why they cannot be used — the same way
        // the Run card's own controls behave.
        if (enabled !== true) {
          return h(
            "div",
            { className: "sap-fields", key: "thread-controls" },
            h("div", { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } }, t("panel.thread.title")),
            actions(true),
            h(
              "div",
              { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } },
              t("panel.thread.controlsOffline"),
            ),
          );
        }
        // No Thread, no controls: a session the home has no Thread for has
        // nothing to pause, resume or archive.
        if (threadId === null || threadId === undefined || !callable) return null;

        return h(
          "div",
          { className: "sap-fields", key: "thread-controls" },
          h("div", { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } }, t("panel.thread.title")),
          view === null && error === null
            ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.thread.reading"))
            : null,
          error !== null
            ? h(
                "div",
                { className: "sap-error sap-mono", style: { fontSize: 11 } },
                t("panel.thread.unreadable", { reason: error }),
              )
            : null,
          view === null
            ? null
            : h(
                "div",
                { className: "sap-fields", key: "thread-state" },
                h(Field, { label: t("panel.thread.status"), value: String(view.status ?? t("panel.run.unknown")) }),
                h(Field, {
                  label: t("panel.thread.blocking"),
                  value:
                    Array.isArray(view.blockingReasons) && view.blockingReasons.length > 0
                      ? view.blockingReasons.map((reason) =>
                          typeof reason === "string" ? reason :
                            reason.kind === "gate" ? reason.gate : reason.kind).join(", ")
                      : t("panel.run.unknown"),
                }),
              ),
          actions(view === null || archived),
          h(Btn, { variant: "ghost", onClick: () => setRefreshNonce((value) => value + 1) }, t("panel.thread.refresh")),
          // What a resume could name, and the choice of whether to name it. The
          // two lists are the Core's own; when its view does not carry one, the
          // card says so instead of offering a list it made up.
          stoppedRuns === null
            ? h(
                "div",
                { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } },
                t("panel.thread.noStoppedRuns"),
              )
            : h(
                "div",
                { className: "sap-fields", key: "stopped-runs" },
                h("div", { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } }, t("panel.thread.stoppedRuns")),
                stoppedRuns.length === 0
                  ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.thread.noStoppedRuns"))
                  : h(
                      "div",
                      { className: "sap-actions", style: { flexWrap: "wrap" } },
                      stoppedRuns.map((run) =>
                        h(
                          Btn,
                          {
                            key: `stopped-${run.runId}`,
                            variant: continueRunIds.includes(run.runId) ? "solid" : "ghost",
                            onClick: () => toggleRun(run.runId),
                          },
                          t("panel.run.historyRun", { runId: run.runId, status: run.status ?? t("panel.run.unknown") }),
                        ),
                      ),
                    ),
              ),
          queuedInputs === null
            ? h(
                "div",
                { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } },
                t("panel.thread.noQueuedInputs"),
              )
            : h(
                "div",
                { className: "sap-fields", key: "queued-inputs" },
                h("div", { className: "sap-muted", style: { fontSize: 11, lineHeight: 1.6 } }, t("panel.thread.queuedInputs")),
                queuedInputs.length === 0
                  ? h("div", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.thread.noQueuedInputs"))
                  : queuedInputs.map((input) =>
                      h(
                        "div",
                        { key: `queued-${input.inputId}`, style: { display: "flex", gap: 6, alignItems: "center" } },
                        h(
                          "span",
                          { className: "sap-muted sap-mono", style: { fontSize: 11 } },
                          t("panel.thread.queuedInput", {
                            inputId: input.inputId,
                            conversationId: input.conversationId ?? t("panel.run.unknown"),
                          }),
                        ),
                        h(
                          Btn,
                          {
                            variant: decisions[input.inputId] === "run" ? "solid" : "ghost",
                            onClick: () => decide(input.inputId, "run"),
                          },
                          t("panel.thread.queuedRun"),
                        ),
                        h(
                          Btn,
                          {
                            variant: decisions[input.inputId] === "drop" ? "solid" : "ghost",
                            onClick: () => decide(input.inputId, "drop"),
                          },
                          t("panel.thread.queuedDrop"),
                        ),
                        decisions[input.inputId] === undefined
                          ? h("span", { className: "sap-muted", style: { fontSize: 11 } }, t("panel.thread.queuedKept"))
                          : null,
                      ),
                    ),
              ),
          h(
            "div",
            { className: "sap-muted", key: "resume-hint", style: { fontSize: 11, lineHeight: 1.6 } },
            hasChoice ? t("panel.thread.resumeHint") : t("panel.thread.resumeNeedsChoice"),
          ),
          h(
            "div",
            { className: "sap-muted", key: "archive-hint", style: { fontSize: 11, lineHeight: 1.6 } },
            t("panel.thread.archiveHint"),
          ),
          h("div", { key: "thread-receipts" }, [
            h("span", { key: "pause" }, receiptOf(pause, "pause")),
            h("span", { key: "resume" }, receiptOf(resume, "resume")),
            h("span", { key: "archive" }, receiptOf(archive, "archive")),
          ]),
        );
      }

      /**
       * The current Run.
       *
       * `run` is the host's summary while the Core is connected and the demo
       * fixture otherwise, which is what makes the three layouts differ without
       * any of them pretending: unreachable, connected-and-idle, and running.
       */
      function RunPanel(props) {
        const state = useStore(services.viewState);
        const t = props.t;
        const connected = state.connection === "ready";
        // Demo, when it is explicitly on, wins: that is what a demo mode is,
        // and the whole interface carries the marker while it is. With demo
        // off the card is the host's facts, and a connected panel with nothing
        // running is a real state rather than a blank.
        const demoRun = services.fixture("run");
        const live = demoRun === null && connected ? state.run : null;
        const run = demoRun ?? live;
        const threadId = live === null ? null : state.threadId;
        // The Thread this session is on, whether or not a Run is live.
        //
        // `threadId` above is the *live Run's* Thread and is deliberately null
        // when nothing is running — the controls act on a Run, and a card with
        // no Run has no target. The history is the one thing here that is about
        // the Thread rather than the Run, so it is named from the host's view
        // state instead: keyed off the live Run, the history card would be
        // handed no Thread at exactly the moment it exists for — after the Run
        // has finished — and could never read the entry it is meant to keep.
        const threadOnScreen = state.threadId ?? null;
        // The host's own account of this session, as one value that moves when
        // the Core's answer about it moves: the live Run, its status, and how
        // many Turns it has reported. The history re-reads on it, so a Run that
        // started or stopped, or a Turn that landed, is read again rather than
        // frozen at the card's first read. `elapsed` is deliberately left out —
        // the host re-formats it on every poll, and a card that re-read on it
        // would refresh while nothing had happened.
        const revision = `${state.eventSeq ?? ""}:${
          live === null ? "" : `${live.runId}:${live.status}:${live.turns?.length ?? 0}`}`;
        // The controls act on the live Run. A demo card has nothing behind it,
        // so its controls stay disabled instead of failing at the click — a
        // button that errors when pressed is worse than one that says it is not
        // available.
        const actionable = live !== null;
        const stop = useOutcome(services, ACTIONS.stop);
        const redo = useOutcome(services, ACTIONS.redo);
        const fork = useOutcome(services, ACTIONS.fork);
        const supplement = useOutcome(services, ACTIONS.supplement);
        /** The words being written for the next supplement. */
        const [draft, setDraft] = React.useState("");
        /** The id this supplement is submitted under, kept per words-and-target. */
        const [submission, setSubmission] = React.useState(null);
        /**
         * The id a supplement is sent under.
         *
         * A retry of a supplement that timed out must be *the same command* —
         * the same id and the same target — so the Core answers with the receipt
         * it already wrote instead of writing the words a second time. So the id
         * belongs to the words and the Run they are written for, and is kept
         * until either changes: a new draft, or another target, is a new
         * supplement and gets its own id.
         *
         * The id itself comes from the service layer's allocator, not from a
         * counter in this card: a card that counted for itself would restart at
         * one whenever it is rebuilt, and the Core's ledger is keyed by the
         * Thread — so this panel's first supplement and the next panel's first
         * supplement would be one key, and the second would be answered with the
         * first one's receipt. Keeping the id here is still what makes the retry
         * the same command; only the minting moves.
         */
        const submissionFor = (key) => {
          if (submission !== null && submission.key === key) return submission;
          const next = {
            key,
            requestId:
              typeof services.requestId === "function"
                ? services.requestId(ACTIONS.supplement)
                : `sap-${ACTIONS.supplement}-${Date.now().toString(36)}-${(supplements += 1).toString(36)}`,
          };
          setSubmission(next);
          return next;
        };
        // Once the Core has taken the words they are its, so the box is emptied
        // for the next supplement — and the id goes with them, because the next
        // supplement is a new command even if the same words are typed again.
        React.useEffect(() => {
          if (supplement.status === "done" && supplement.result?.inputId !== undefined) {
            setDraft("");
            setSubmission(null);
          }
        }, [supplement]);
        /**
         * The persisted messages a fork boundary can be taken at, and the one
         * chosen.
         *
         * The list is the Core's own listing of the Conversation on screen — so
         * the entry ids are the ones a fork is accepted at, rather than a count
         * this half could keep for itself. The choice starts empty and stays
         * empty until the user picks: a fork has to name the entry it branches
         * at, and defaulting to the newest one would move the branch point
         * without anyone choosing it.
         */
        const [boundaries, setBoundaries] = React.useState(null);
        const [boundary, setBoundary] = React.useState(null);
        const [boundaryError, setBoundaryError] = React.useState(null);
        const boundaryConversation = live === null ? null : (live.conversationId ?? null);
        React.useEffect(() => {
          // The read is keyed on the Conversation it was taken for, and a reply
          // that arrives after the card has moved on is dropped rather than
          // drawn: switching sessions must not leave the previous line's
          // entries selectable under the new one's fork.
          setBoundaries(null);
          setBoundary(null);
          setBoundaryError(null);
          if (boundaryConversation === null || typeof services.run !== "function") return undefined;
          let current = true;
          void (async () => {
            const answer = await services.run("messages.list", {
              conversationId: boundaryConversation,
              limit: 20,
            });
            if (!current) return;
            if (answer?.status !== "done") {
              setBoundaryError(answer?.reason ?? null);
              return;
            }
            setBoundaries(Array.isArray(answer.result?.items) ? answer.result.items : []);
          })();
          return () => {
            current = false;
          };
        }, [boundaryConversation]);
        // Only a message the Core gave an entry is a boundary: a message the
        // listing carries with no entry (a projection not yet placed in the
        // history) is not an address a fork can be taken at, and offering it
        // would be offering a refusal.
        const boundaryItems =
          boundaries === null ? [] : boundaries.filter((item) => Number.isInteger(item?.entryId));

        if (!connected && demoRun === null) {
          return h(Card, {
            title: t("panel.run.title"),
            collapsible: true,
            id: "run",
            aside: h("span", { className: "sap-status" }, h(Dot, { tone: "idle" }), t("panel.run.noRun")),
            children: [
              h(
                "div",
                { className: "sap-fields", key: "fields" },
                h(Field, { label: t("panel.run.status"), value: t("panel.run.unknown") }),
                h(Field, { label: t("panel.run.turn"), value: t("panel.run.unknown") }),
                h(Field, { label: t("panel.run.waiting"), value: t("panel.run.unknown") }),
              ),
              h(
                "div",
                { className: "sap-actions", key: "actions" },
                h(ActionBtn, { id: ACTIONS.stop, disabled: true }, t("panel.run.stop")),
                h(ActionBtn, { id: ACTIONS.redo, disabled: true }, t("panel.run.redo")),
                h(ActionBtn, { id: ACTIONS.fork, disabled: true }, t("panel.run.fork")),
              ),
              h(ThreadControls, { key: "threadControls", services, t, threadId: null, enabled: false }),
              h(
                "div",
                { className: "sap-muted", key: "note", style: { fontSize: 11, lineHeight: 1.6 } },
                t("panel.run.offlineNote"),
              ),
            ],
          });
        }

        if (run === null) {
          return h(Card, {
            title: t("panel.run.title"),
            collapsible: true,
            id: "run",
            aside: h("span", { className: "sap-status" }, h(Dot, { tone: "idle" }), t("panel.run.noRun")),
            children: [
              h(
                "div",
                { className: "sap-fields", key: "fields" },
                h(Field, { label: t("panel.run.thread"), value: threadId ?? t("panel.run.unknown") }),
                h(Field, { label: t("panel.run.turn"), value: t("panel.run.unknown") }),
                h(Field, { label: t("panel.run.waiting"), value: t("panel.run.unknown") }),
              ),
              h(
                "div",
                { className: "sap-muted", key: "note", style: { fontSize: 11, lineHeight: 1.6 } },
                t("panel.run.idleNote"),
              ),
              // No Run means no target, and a supplement without a target is
              // the one thing this card must not offer: the Core would refuse
              // it, and sending it as a new Run instead is what the design
              // forbids. So the control is absent and the card says why.
              h(
                "div",
                { className: "sap-muted", key: "supplementNote", style: { fontSize: 11, lineHeight: 1.6 } },
                t("panel.run.supplementNoTarget"),
              ),
              // The Thread's own controls do not need a live Run: pausing,
              // resuming what a stop left behind, and archiving are about the
              // Thread, and the moment they matter most is when nothing is
              // running.
              h(ThreadControls, { key: "threadControls", services, t, threadId: threadOnScreen, enabled: true, revision }),
              // "No active Run" is not "nothing here": the Thread's own history
              // — its finished Runs, their Turns, and this Conversation's
              // messages — is what keeps a completed Run reachable.
              h(History, {
                key: "history",
                services,
                t,
                threadId: threadOnScreen,
                conversationId: state.conversationId ?? null,
                revision,
              }),
            ],
          });
        }

        return h(Card, {
          title: t("panel.run.title"),
          collapsible: true,
          id: "run",
          aside: h("span", { className: "sap-status" }, h(Dot, { tone: "ok" }), t("panel.run.running")),
          children: [
            h("div", { className: "sap-turns", key: "turns" }, run.turns.map((turn) => h(TurnRow, { turn, t }))),
            h(
              "div",
              { className: "sap-field", key: "waiting" },
              h("span", { className: "sap-field-label" }, t("panel.run.waiting")),
              h(
                "span",
                { className: "sap-field-value sap-mono" },
                t("panel.run.waitingValue", { count: run.waitingCount, elapsed: run.elapsed }),
              ),
            ),
            // What a supplement would name, drawn where the control that sends
            // it can be read: the Run and the Conversation the words would go
            // to. Both are the host's facts about this Run, not a "current"
            // anything.
            h(
              "div",
              { className: "sap-fields", key: "target" },
              h(Field, { label: t("panel.run.target"), value: run.runId ?? t("panel.run.unknown") }),
              h(Field, { label: t("panel.run.conversation"), value: run.conversationId ?? t("panel.run.unknown") }),
            ),
            // The fork's boundary, and where it is chosen. The entries are the
            // Core's own persisted messages of this Conversation, drawn as the
            // ids a fork is accepted at; the choice is the user's, and the
            // control that sends it is disabled until one is made.
            h(
              "div",
              { className: "sap-fields", key: "boundary" },
              h(Field, {
                label: t("panel.run.boundary"),
                value: boundary === null ? t("panel.run.boundaryNone") : String(boundary),
              }),
            ),
            boundaries === null && boundaryError === null
              ? h(
                  "div",
                  { className: "sap-muted", key: "boundaryReading", style: { fontSize: 11, lineHeight: 1.6 } },
                  t("panel.run.boundaryReading"),
                )
              : null,
            boundaryError !== null
              ? h(
                  "div",
                  { className: "sap-error sap-mono", key: "boundaryError", style: { fontSize: 11, lineHeight: 1.6 } },
                  t("panel.run.boundaryUnreadable", { reason: boundaryError }),
                )
              : null,
            boundaries !== null && boundaryItems.length === 0
              ? h(
                  "div",
                  { className: "sap-muted", key: "boundaryEmpty", style: { fontSize: 11, lineHeight: 1.6 } },
                  t("panel.run.boundaryEmpty"),
                )
              : null,
            boundaryItems.length === 0
              ? null
              : h(
                  "div",
                  { className: "sap-actions", key: "boundaryRows", style: { flexWrap: "wrap" } },
                  boundaryItems.map((item) =>
                    h(
                      Btn,
                      {
                        key: `boundary-${item.entryId}`,
                        variant: item.entryId === boundary ? "solid" : "ghost",
                        onClick: () => setBoundary(item.entryId),
                      },
                      t("panel.run.boundaryEntry", {
                        entryId: item.entryId,
                        role: item.role ?? item.kind ?? t("panel.run.unknown"),
                      }),
                    ),
                  ),
                ),
            h(
              "div",
              { className: "sap-actions", key: "actions" },
              // Each control carries what the Core needs to act on *this* Run:
              // the Thread to stop, the Run to redo, the Conversation to fork.
              // Nothing is inferred from a "current" anything — a stale card
              // would otherwise stop a Run the user is no longer looking at.
              h(
                ActionBtn,
                {
                  id: ACTIONS.stop,
                  disabled: !actionable,
                  payload: { threadId: threadId ?? run.threadId },
                },
                t("panel.run.stop"),
              ),
              h(
                ActionBtn,
                { id: ACTIONS.redo, disabled: !actionable, payload: { runId: run.runId } },
                t("panel.run.redo"),
              ),
              h(
                ActionBtn,
                {
                  id: ACTIONS.fork,
                  // A fork needs the entry it branches at. Until one is chosen
                  // the control is disabled rather than sending a request the
                  // Core will refuse, and it is *not* sent with a guessed entry.
                  disabled: !actionable || run.conversationId === undefined || boundary === null,
                  payload: { conversationId: run.conversationId, sourceEntryId: boundary },
                },
                t("panel.run.fork"),
              ),
            ),
            h(Receipt, { key: "receipt-stop", outcome: stop, label: "stop", t }),
            h(Receipt, { key: "receipt-redo", outcome: redo, label: "redo", t }),
            h(Receipt, { key: "receipt-fork", outcome: fork, label: "fork", t }),
            // The supplement is its own entry rather than a mode of the
            // composer: it belongs to the Run on screen, and it is the card that
            // can name that Run. The words travel with the click and the target
            // is read then — a supplement sent to "whatever is active" could
            // land on a Run that ended between the draw and the click, which is
            // the one outcome the Core refuses and this control must not cause.
            h(
              "div",
              { className: "sap-actions", key: "supplement" },
              h("input", {
                key: "supplement-text",
                className: "sap-mono",
                style: {
                  flex: "1 1 160px",
                  minWidth: 0,
                  background: "transparent",
                  color: "inherit",
                  border: "1px solid var(--dsw-alias-border-l2)",
                  borderRadius: 6,
                  padding: "4px 8px",
                  fontSize: 12,
                },
                value: draft,
                placeholder: t("panel.run.supplementPlaceholder"),
                "aria-label": t("panel.run.supplementPlaceholder"),
                onChange: (event) => setDraft(event?.target?.value ?? ""),
              }),
              h(
                ActionBtn,
                {
                  id: ACTIONS.supplement,
                  disabled: !actionable || run.runId === undefined || draft.trim() === "",
                  payload: () => {
                    const key = `${String(run.runId)}\u0000${draft}`;
                    return {
                      threadId: threadId ?? run.threadId,
                      requestId: submissionFor(key).requestId,
                      text: draft,
                      targetRunId: run.runId,
                      conversationId: run.conversationId,
                    };
                  },
                },
                t("panel.run.supplement"),
              ),
            ),
            h(SupplementReceipt, { key: "receipt-supplement", outcome: supplement, t }),
            h(ThreadControls, {
              key: "threadControls",
              services,
              t,
              threadId: threadOnScreen ?? run.threadId ?? null,
              enabled: true,
              revision,
            }),
            // The Thread's other Runs are reachable while one is live too: the
            // history is not only what is left when nothing is running.
            h(History, {
              key: "history",
              services,
              t,
              threadId: threadOnScreen ?? run.threadId ?? null,
              conversationId: run.conversationId ?? state.conversationId ?? null,
              revision,
            }),
            h(
              "div",
              { className: "sap-muted", key: "supplementHint", style: { fontSize: 11, lineHeight: 1.6 } },
              t("panel.run.supplementHint"),
            ),
            h(
              "div",
              { className: "sap-muted", key: "hint", style: { fontSize: 11, lineHeight: 1.6 } },
              t("panel.run.stopHint"),
            ),
            h(
              "div",
              { className: "sap-muted", key: "forkNote", style: { fontSize: 11, lineHeight: 1.6 } },
              t("panel.run.forkNote"),
            ),
          ],
        });
      }

      return {
        RunPanel,
        ThreadControls,
        ACTIONS,
        dictionary: { zh, en },
        /** The Run the design shows, drawn only while demo is explicitly on. */
        demoFixture: {
          run: {
            elapsed: "00:42",
            waitingCount: 0,
            turns: [
              { n: 1, tools: 2, state: "done" },
              { n: 2, tools: 1, state: "done" },
              { n: 3, state: "running" },
            ],
          },
        },
      };
    }

    return { createRunPanel };
  },
});
