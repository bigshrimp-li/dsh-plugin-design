/**
 * Service facade, the host transport, and injectable view state, loaded as a
 * package-local chunk.
 *
 * Every product action the interface offers is routed through
 * {@link createServices}, and the facade never fabricates a receipt: an action
 * that cannot happen reads as `unsupported`, and one that failed reads as
 * `error` with the reason the host gave. The transport underneath it is
 * {@link createCoreTransport}, which reaches the host half over the routes the
 * host registers — this half has no socket, no SDK and no path to the Core, and
 * that is the point: the browser asks the host, the host asks the Core.
 *
 * The view state is *injected*: `connection` and `demo` start at their
 * production defaults and only change when something explicitly sets them (the
 * transport's poll, the settings tab). Views read the state and choose between
 * live facts and their own declared demo fixture; the demo flag is the only
 * thing that can turn that fixture on.
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  chunk: "client.services.js",
  factory() {
    /** Core link state, as the interface names it. */
    const CONNECTION = { READY: "ready", OFFLINE: "offline" };

    /** How an action ended. `unsupported` and `error` are never a success. */
    const ACTION = { IDLE: "idle", PENDING: "pending", DONE: "done", UNSUPPORTED: "unsupported", ERROR: "error" };

    /** The route prefix the host half registers, and the only address this half knows. */
    const CORE_ROUTE = "/super-agent";

    /** One stream per page, and one owner across tabs when Web Locks are available. */
    function createSharedEventSubscriber({ locks = globalThis.document ? globalThis.navigator?.locks : undefined, Channel = globalThis.BroadcastChannel, lifecycle = globalThis } = {}) {
      const streams = new WeakMap();
      return function subscribeEvents(Events, url, listener) {
        if (typeof Events !== "function") return () => {};
        let urls = streams.get(Events);
        if (!urls) { urls = new Map(); streams.set(Events, urls); }
        let entry = urls.get(url);
        if (!entry) {
          entry = { listeners: new Set(), stopped: false, suspend: null };
          urls.set(url, entry);
          const deliver = (type, payload) => {
            for (const receiver of [...entry.listeners]) {
              try { receiver[type]?.(payload); } catch { /* A failed view cannot stop other subscribers. */ }
            }
          };
          const start = () => {
            if (entry.stopped || entry.suspend) return;
            let source, channel, release, ended = false;
            const abort = new AbortController();
            const publish = (type, payload) => {
              if (ended) return;
              deliver(type, payload);
              try { channel?.postMessage({ type, payload }); } catch {}
            };
            const open = () => {
              if (ended || entry.stopped) return;
              try {
                source = new Events(url);
                const parse = type => message => {
                  try { publish(type, JSON.parse(message.data)); } catch { /* Malformed frames are not facts. */ }
                };
                source.onmessage = parse("onEvent");
                source.addEventListener?.("live", parse("onLive"));
                source.addEventListener?.("error", () => publish("onError", null));
              } catch { publish("onError", null); }
            };
            entry.suspend = () => {
              ended = true; abort.abort(); release?.(); source?.close?.(); channel?.close(); entry.suspend = null;
            };
            if (locks?.request && typeof Channel === "function") {
              try {
                channel = new Channel(`super-agent.events.v1:${url}`);
                channel.onmessage = event => {
                  if (!ended && ["onEvent", "onLive", "onError"].includes(event.data?.type)) deliver(event.data.type, event.data.payload);
                };
                void locks.request(`super-agent.events.v1:${url}`, { signal: abort.signal }, async () => {
                  if (ended) return;
                  open();
                  await new Promise(resolve => { release = resolve; if (ended) resolve(); });
                }).catch(() => { if (!ended) { channel?.close(); channel = null; open(); } });
              } catch { channel?.close(); channel = null; open(); }
            } else open();
          };
          const hide = () => entry.suspend?.();
          lifecycle.addEventListener?.("pagehide", hide);
          lifecycle.addEventListener?.("pageshow", start);
          entry.stop = () => {
            entry.stopped = true; hide();
            lifecycle.removeEventListener?.("pagehide", hide);
            lifecycle.removeEventListener?.("pageshow", start);
            urls.delete(url);
          };
          // Install the first subscriber before a synchronous constructor can report an error.
          entry.listeners.add(listener);
          start();
        } else entry.listeners.add(listener);
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true; entry.listeners.delete(listener);
          if (!entry.listeners.size) entry.stop();
        };
      };
    }
    const subscribeSharedEvents = createSharedEventSubscriber();

    /** Read one fixed DSH journal snapshot through its public Remote API. */
    async function readSessionHistory(remote, sessionId) {
      const address = { kind: "session", sessionId };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("读取会话历史超时")), 15000);
      let stream;
      try {
        stream = remote.follow({ address, maxMessages: 200 }, controller.signal);
        const opening = await stream[Symbol.asyncIterator]().next();
        const snapshot = opening.value;
        if (opening.done || snapshot?.type !== "snapshot" || !Number.isSafeInteger(snapshot.cursor)) {
          throw new Error("DSH 没有返回可定位的历史快照");
        }
        const events = new Map();
        let page = snapshot;
        let beforeSeq = Infinity;
        for (;;) {
          let first = beforeSeq;
          for (const record of page.records ?? []) {
            const event = record?.event;
            if (record?.type !== "event" || !Number.isSafeInteger(event?.seq)) {
              throw new Error("DSH 历史页包含无效事件");
            }
            events.set(event.seq, event);
            first = Math.min(first, event.seq);
          }
          if (!page.hasMore) break;
          if (!(first < beforeSeq)) throw new Error("DSH 历史分页没有前进");
          beforeSeq = first;
          const result = await remote.page(
            { address, throughSeq: snapshot.cursor, beforeSeq, maxMessages: 200 },
            controller.signal,
          );
          if (!result?.ok) throw result?.error ?? new Error("读取 DSH 历史失败");
          page = result.value;
        }
        return [...events.values()].sort((a, b) => a.seq - b.seq);
      } finally {
        clearTimeout(timer);
        controller.abort();
        stream?.dispose?.();
      }
    }

    /**
     * A random token for an operation id.
     *
     * The Core's ledger is keyed by the Thread and the caller's `requestId`, so
     * two *different* operations that minted one id are not two operations: the
     * second is answered with the first one's receipt. A clock and a counter
     * cannot separate two panels — the counter restarts with the panel, and two
     * windows (or two page loads) can mint their first id in the same
     * millisecond — so the token comes from the platform's own random source.
     * Where there is none (an old or restricted page) the clock and the
     * counter are all there is, and two instances minting in the same
     * millisecond are *not* separated: that is a limit of the fallback, stated
     * rather than papered over.
     * @returns the token.
     */
    const randomToken = () => {
      const source = globalThis.crypto;
      if (source !== undefined && typeof source.randomUUID === "function") {
        return source.randomUUID();
      }
      if (source !== undefined && typeof source.getRandomValues === "function") {
        const bytes = source.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      return `t${Date.now().toString(36)}`;
    };

    /**
     * Production defaults. These are the product's documented defaults, not
     * sample values: a path is not a statistic, and none of this is a run.
     */
    const DEFAULT_STATE = {
      connection: CONNECTION.OFFLINE,
      demo: false,
      core: {
        home: "~/.super-agent",
        socketPath: "run/core.sock",
        lockFile: "run/core.lock",
        autoStart: true,
        attempts: 0,
        /**
         * Why Core is unreachable, as the host last reported it. `null` before
         * any attempt — not a made-up `ENOENT`, which would claim a connection
         * attempt that never happened.
         */
        error: null,
      },
      /** The Threads the Core holds, newest activity first, as the host listed them. */
      threads: [],
      /** The dsh Session this panel belongs to, as the host answered for it. */
      sessionId: null,
      eventSeq: null,
      /** The Thread that Session runs on, once the host has named one. */
      threadId: null,
      /** The Conversation that Session is showing — a fork's own, for a forked session. */
      conversationId: null,
      /** The Thread's own main Conversation, so a fork is distinguishable from it. */
      mainConversationId: null,
      /**
       * Why the bridge could not read its own Session↔Thread record. Not a Core
       * failure: the link can be perfectly healthy while the record that says
       * which Thread this session runs on is unreadable.
       */
      sessionError: null,
      /**
       * The Session's Conversation config, as the host read it: the public
       * fields only, and `null` until the host has answered with one. It is not
       * a sample — with demo off an absent snapshot means "not read yet", which
       * is what the card says.
       */
      snapshot: null,
      /**
       * Why the config of this Session's Conversation could not be read. Its own
       * failure, like `sessionError`: the link can be up and the identity known
       * while this one read fails.
       */
      snapshotError: null,
      /** The Run the panel draws, or `null` when nothing is running. */
      run: null,
    };

    /** A frozen shallow copy, so a subscriber cannot reach the store's own object. */
    function freeze(state) {
      return Object.freeze({ ...state, core: Object.freeze({ ...state.core }) });
    }

    /**
     * Minimal observable store.
     * @param initial - the first snapshot.
     * @returns `{ get, set, subscribe }`; `set` merges a patch and notifies once.
     */
    function createStore(initial) {
      let snapshot = freeze(initial);
      const listeners = new Set();
      return {
        get() {
          return snapshot;
        },
        set(patch) {
          const next = freeze({ ...snapshot, ...patch, core: { ...snapshot.core, ...(patch.core ?? {}) } });
          if (JSON.stringify(next) === JSON.stringify(snapshot)) return snapshot;
          snapshot = next;
          for (const listener of [...listeners]) listener(snapshot);
          return snapshot;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    /**
     * The browser's transport to the host half.
     *
     * It speaks two things and nothing else: `POST {base}/action` for the
     * operations the host offers, and `GET {base}/state` for what the panel
     * draws. Both are same-origin, because the page is served by the same
     * Harness that registered the routes.
     *
     * ## Why the request ids are minted here
     *
     * The Core's idempotency is keyed by the caller's `requestId`, so an id
     * minted at the transport would make every retry a new command — a second
     * Run for one submitted message, a second fork for one click. The retry is
     * decided here, at the click, so the id is minted here too.
     *
     * ## Why some actions are not sent anywhere
     *
     * An action with no Core operation behind it is answered `unsupported`
     * *with a reason*, rather than being forwarded to a route that would refuse
     * it with a code the user cannot act on. Starting the Core, opening a
     * config folder and switching a conversation's model are all real things
     * this build cannot do, and the panel says so in those words.
     * @param options.fetchImpl - the fetch to use; defaults to the global one.
     * @param options.base - the route prefix.
     * @param options.now - clock, for elapsed-free request ids and for tests.
     * @param options.EventSourceImpl - the SSE constructor; defaults to the global one.
     * @param options.session - the dsh Session seat: `{ current, fork, select }`.
     *   `current()` is the Session on screen, `fork(id)` opens a new dsh Session
     *   from it through dsh's own public fork, and `select(id)` is dsh's own
     *   navigation to it. Absent in a build with no dsh Session surface, where
     *   the panel still reads state but cannot open a session for a fork.
     * @returns the transport the facade drives.
     */
    function createCoreTransport({
      fetchImpl,
      base = CORE_ROUTE,
      now = () => Date.now(),
      EventSourceImpl,
      session = null,
    } = {}) {
      const request = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
      const Events = EventSourceImpl ?? (typeof EventSource === "function" ? EventSource : undefined);
      let counter = 0;
      // The clock is a readable prefix, not the separator: what makes two ids
      // different is {@link randomToken}, and the counter behind it covers a
      // page with no random source at all.
      const nextRequestId = (action) =>
        `sap-${action}-${now().toString(36)}-${randomToken()}-${(counter += 1).toString(36)}`;

      const requireField = (payload, field) => {
        const value = payload?.[field];
        if (typeof value !== "string" || value === "") {
          throw new Error(`${field} is required to do that`);
        }
        return value;
      };

      /**
       * The entry a fork is taken at, as the Core requires it: an integer.
       *
       * Not a string, and not defaulted. The Core refuses a fork with no
       * `sourceEntryId` — and a panel that guessed one, whether the newest
       * entry or "whatever is current", would branch the history at a point the
       * user never chose, silently. So the id travels from the message the user
       * picked, and a payload without one is refused *here*, before any request.
       */
      const requireEntryId = (payload, field) => {
        const value = payload?.[field];
        if (!Number.isInteger(value)) throw new Error(`${field} is required to do that`);
        return value;
      };

      const readJson = async (response) => {
        try {
          return await response.json();
        } catch {
          return null;
        }
      };
      const observeRead = async (path, params = new URLSearchParams()) => {
        if (!request) throw new Error("无法读取观测数据：浏览器没有 fetch");
        const response = await request(`${base}/observation/${path}${params.size ? `?${params}` : ""}`, {
          method: "GET", credentials: "same-origin", headers: { accept: "application/json" },
        });
        const body = await readJson(response);
        if (!response.ok) {
          const error = new Error(body?.error?.message ?? "观测数据读取失败");
          error.code = body?.error?.code ?? "INTERNAL";
          throw error;
        }
        if (body === null) throw new Error("观测数据响应不是 JSON");
        return body;
      };
      const observationParams = (query) => {
        const params = new URLSearchParams({ scope: query.scope, includeDescendants: String(query.includeDescendants) });
        for (const key of ["from", "until"]) if (query.window[key] !== null) params.set(key, query.window[key]);
        for (const [key, value] of Object.entries(query.filters)) if (value !== null) params.set(key, value);
        for (const value of typeof query.groupBy === "string" ? [query.groupBy] : query.groupBy) params.append("groupBy", value);
        for (const value of query.metrics ?? []) params.append("metric", value);
        return params;
      };
      const observations = {
        metrics: (query) => observeRead("metrics", observationParams(query)),
        tools: (query) => observeRead("tools", observationParams(query)),
        usage: (query) => observeRead("usage", observationParams(query)),
        health: () => observeRead("health"),
        members: (query) => observeRead("members", new URLSearchParams(
          Object.entries(query).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)]))),
        graph: (threadId) => observeRead("thread-graph", new URLSearchParams({ threadId })),
        trace: (runId) => observeRead("run-trace", new URLSearchParams({ runId })),
        conversationTrace: (conversationId, query = {}) => observeRead("conversation-trace", new URLSearchParams({ conversationId, ...query })),
        execution: (executionId) => observeRead("execution", new URLSearchParams({ executionId })),
        content: (ref) => {
          const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(ref))))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          return observeRead("content", new URLSearchParams({ ref: encoded }));
        },
      };

      /**
       * The operations this half may raise, and the Core operation each becomes.
       *
       * The key is the interface's action id; the value builds the host call.
       * Only actions with a real Core operation are listed — see the note above.
       */
      const OPERATIONS = {
        "run.stop": (payload) => [
          "thread.stop",
          {
            threadId: requireField(payload, "threadId"),
            requestId: nextRequestId("run.stop"),
            ...(payload?.reason === undefined ? {} : { reason: payload.reason }),
          },
        ],
        "run.redo": (payload) => [
          "run.redo",
          {
            runId: requireField(payload, "runId"),
            requestId: nextRequestId("run.redo"),
            ...(payload?.mode === undefined ? {} : { mode: payload.mode }),
          },
        ],
        /**
         * A supplement to the Run the caller names.
         *
         * The delivery is `next_turn` with the target Run in the payload, which
         * is what the design requires and what the Core enforces: a supplement
         * belongs to the Run it was written for, so a Run that has ended cannot
         * take one and the Core refuses rather than quietly turning the words
         * into a second Run. This half must not undo that. A payload without a
         * target Run is refused *here*, before any request is made, because
         * sending the same words as a `new_run` is exactly the failure that rule
         * exists to prevent — and a refusal that comes back from the Core
         * travels to the panel as the Core's own failure, unretried.
         *
         * The Conversation the supplement belongs to travels with it: a session
         * showing a fork writes into the fork, and the Core refuses a name that
         * is not one of the Thread's own.
         *
         * The `requestId` comes from the caller rather than being minted here,
         * which is the one place this half departs from the rule above: a
         * supplement that timed out has to be retried as *the same command*, so
         * the id belongs to the supplement and not to the request. A caller
         * that minted a fresh one per attempt would turn one supplement into two
         * accepted inputs the moment the first answer was merely slow.
         */
        "run.supplement": (payload) => [
          "input.submit",
          {
            threadId: requireField(payload, "threadId"),
            requestId: requireField(payload, "requestId"),
            text: requireField(payload, "text"),
            delivery: "next_turn",
            targetRunId: requireField(payload, "targetRunId"),
            ...(payload?.conversationId === undefined ? {} : { conversationId: payload.conversationId }),
          },
        ],
        "thread.pause": (payload) => [
          "thread.pause",
          { threadId: requireField(payload, "threadId"), requestId: nextRequestId("thread.pause") },
        ],
        /**
         * Resume, with the decisions the caller made and no others.
         *
         * `continueRunIds` and `queuedInputs` are the *explicit* lists a resume
         * carries: an unlisted Run stays cancelled and an unlisted input stays
         * queued, so sending `[]` where the caller named nothing would be this
         * half inventing a decision. Each is therefore passed through only when
         * it was given, and a resume with neither is the bare "resume" the Core
         * also accepts.
         */
        "thread.resume": (payload) => [
          "thread.resume",
          {
            threadId: requireField(payload, "threadId"),
            requestId: nextRequestId("thread.resume"),
            ...(payload?.continueRunIds === undefined ? {} : { continueRunIds: payload.continueRunIds }),
            ...(payload?.queuedInputs === undefined ? {} : { queuedInputs: payload.queuedInputs }),
          },
        ],
        "thread.archive": (payload) => [
          "thread.archive",
          { threadId: requireField(payload, "threadId"), requestId: nextRequestId("thread.archive") },
        ],
        "wait.answer": (payload) => [
          "wait.answer",
          {
            waitId: requireField(payload, "waitId"),
            requestId: nextRequestId("wait.answer"),
            answer: requireField(payload, "answer"),
          },
        ],
        /**
         * The Conversation's own persisted messages, paged.
         *
         * The read the Run card takes a fork boundary from, and the same read
         * the history view pages. It is the Core's own listing, so the entry ids
         * it names are the ones a fork is accepted at — which is the whole point
         * of taking the boundary from here rather than from anything the panel
         * could count for itself.
         */
        "messages.list": (payload) => [
          "messages.list",
          {
            conversationId: requireField(payload, "conversationId"),
            ...(payload?.limit === undefined ? {} : { limit: payload.limit }),
            ...(payload?.cursor === undefined ? {} : { cursor: payload.cursor }),
          },
        ],
        /**
         * The Thread itself, as the Core reports it.
         *
         * The history view reads it for the Runs the Thread holds — the ones
         * that already finished as much as the ones still going. It is the
         * Core's own list, so a Run the panel draws is a Run the Core has,
         * rather than one this half remembers having seen.
         */
        "thread.get": (payload) => ["thread.get", { threadId: requireField(payload, "threadId") }],
        /**
         * One Run's Turns, paged.
         *
         * The drill-down behind a Run row: a finished Run's Turns are what the
         * history entry shows when the panel has no live Run to draw.
         */
        "turns.list": (payload) => [
          "turns.list",
          {
            runId: requireField(payload, "runId"),
            ...(payload?.limit === undefined ? {} : { limit: payload.limit }),
            ...(payload?.cursor === undefined ? {} : { cursor: payload.cursor }),
          },
        ],
        /** One Run, as the Core reports it — its status and which Conversation it is in. */
        "run.get": (payload) => ["run.get", { runId: requireField(payload, "runId") }],
        "core.logs": (payload) => [
          "server.logs",
          { ...(payload?.tail === undefined ? {} : { tail: payload.tail }) },
        ],
      };

      /**
       * Actions the interface offers that this build cannot carry out, each with
       * the reason the user is shown. They are listed rather than left to fall
       * through, because "we do not do this" and "we do not know this action"
       * are different answers and only one of them is a bug.
       */
      const UNAVAILABLE = {
        "core.start": "启动 Core 由安装与运维负责，插件不代拉起进程",
        "core.restart": "重启 Core 由安装与运维负责，插件不代拉起进程",
        "core.openConfig": "打开配置目录是桌面动作，浏览器这一侧没有这个能力",
        "snapshot.switchModel": "修改会话配置在本次里程碑未实现",
        "snapshot.switchPermission": "修改会话配置在本次里程碑未实现",
        "delegation.cancel": "取消子 Agent 委派在本次里程碑未实现",
        "delegation.view": "子 Agent 详情在本次里程碑未实现",
      };

      /**
       * The Session on screen, when this build has one.
       *
       * Read at the moment of each request rather than captured once: the whole
       * point is that switching sessions changes what the panel asks about, and
       * a captured id would keep answering for the session the panel opened
       * with.
       * @returns the dsh Session id, or `null` when nothing is on screen.
       */
      const currentSessionId = () => {
        const id = session?.current?.();
        return typeof id === "string" && id !== "" ? id : null;
      };

      /**
       * The state a read reports when there is nothing to report.
       *
       * The Session id is still named, because it is a local fact the browser
       * already holds: a panel that could not be told which session it belongs
       * to would be a different failure from a Core that is down.
       */
      const offlineState = (error) => ({
        connection: CONNECTION.OFFLINE,
        core: { ...DEFAULT_STATE.core, error },
        threads: [],
        sessionId: currentSessionId(),
        threadId: null,
        conversationId: null,
        mainConversationId: null,
        sessionError: null,
        // Nothing was read from the Core, so there is no config snapshot and no
        // config failure to report either.
        snapshot: null,
        snapshotError: null,
        run: null,
      });

      /** Read what the panel draws. Never throws: an unreachable host is a state, not an error. */
      const readState = async () => {
        if (request === undefined) {
          return offlineState({ code: "NO_FETCH", message: "这个浏览器没有 fetch，无法访问宿主" });
        }
        try {
          // The Session travels with the read: the host answers about the
          // session the panel is showing, and two panels open at once therefore
          // get two answers instead of one shared "newest Thread".
          const sessionId = currentSessionId();
          const query = sessionId === null ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
          const response = await request(`${base}/state${query}`, { method: "GET" });
          const body = await readJson(response);
          if (!response.ok || body === null) {
            return offlineState({ code: "HOST_ERROR", message: `宿主返回了 ${response.status}` });
          }
          // The answer is about the Session this read named. If the panel has
          // moved to another Session since, the config it carries belongs to a
          // session that is no longer on screen, and a configuration has no
          // honest place beside another session's name: it is *this* session's
          // config or it is not shown. So the snapshot is dropped — the card
          // then says it is still reading — while the rest of the answer is
          // handed on exactly as it always was.
          const onScreen = currentSessionId();
          if (body.snapshot != null && onScreen !== null && body.sessionId !== onScreen) {
            return { ...body, snapshot: null, snapshotError: null };
          }
          return body;
        } catch (error) {
          return offlineState({
            code: "HOST_UNREACHABLE",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };

      /** Raise one Core operation through the host. */
      const post = async (action, payload) => {
        if (request === undefined) throw new Error("这个浏览器没有 fetch，无法访问宿主");
        const response = await request(`${base}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, payload }),
        });
        const body = await readJson(response);
        if (!response.ok || body?.error !== undefined || body === null) {
          const failure = new Error(
            body?.error?.message ?? `宿主拒绝了 ${action}（HTTP ${response.status}）`,
          );
          failure.code = body?.error?.code ?? "INTERNAL";
          failure.details = body?.error?.details ?? null;
          throw failure;
        }
        return body.result;
      };

      /**
       * Fork the Conversation, open a dsh Session for the fork, and select it.
       *
       * One click, three facts, and the order they are established in is the
       * part that matters. The Core fork comes first because it is the
       * idempotent half: its request id is the Core's, so a retry re-attaches to
       * the Conversation it already made. The dsh Session comes second, through
       * dsh's own public fork — not a manual new session, which would be a
       * different conversation wearing the same name. The association is
       * written third, so the new session's first turn finds its Thread instead
       * of creating a second one. Only then is the session selected.
       *
       * The Core's fork is *not* undone if a later step fails. A fork is a
       * history, and the honest failure is the one that says which step failed
       * — not one that silently deletes work the user asked for.
       *
       * The boundary is the caller's: `sourceEntryId` is the entry the branch is
       * taken at, and the Core requires it. It is passed through as the user
       * chose it — this half neither invents one nor repairs a missing one, so a
       * fork with no chosen boundary is refused before the request goes out
       * rather than landing on an entry the user did not pick.
       * @param payload - `{ conversationId, sourceEntryId }`: the Conversation to
       *   fork, and the entry the fork is taken at.
       * @returns the outcome, naming the new Session and the Conversation.
       */
      const fork = async (payload) => {
        const conversationId = requireField(payload, "conversationId");
        const sourceEntryId = requireEntryId(payload, "sourceEntryId");
        if (session === null || typeof session.fork !== "function" ||
            typeof session.history !== "function" || typeof session.select !== "function") {
          return {
            status: ACTION.UNSUPPORTED,
            reason: "这个构建没有 dsh 会话能力，无法为 fork 打开新会话",
            result: null,
          };
        }
        const sourceSessionId = currentSessionId();
        if (sourceSessionId === null) {
          return { status: ACTION.ERROR, reason: "没有正在显示的会话，无法 fork", result: null };
        }
        // Resolve both sides before creating anything. A Core entry number is
        // not a DSH event seq, and omitting atSeq would silently fork later work.
        const messages = [];
        let cursor;
        const cursors = new Set();
        do {
          const page = await post("messages.list", { conversationId, limit: 200, ...(cursor ? { cursor } : {}) });
          messages.push(...(page?.items ?? []));
          cursor = page?.nextCursor ?? null;
          if (cursor !== null && cursors.has(cursor)) throw new Error("Core 历史分页没有前进");
          cursors.add(cursor);
        } while (cursor !== null);
        const keysOf = (message) => message.kind === "tool_call" && message.toolCallId
          ? [`call:${message.toolCallId}`]
          : [`message:core-${message.messageId}`,
              ...(message.origin?.messageId ? [`message:core-${message.origin.messageId}`] : [])];
        const boundary = messages.filter((message) => message.entryId === sourceEntryId);
        if (boundary.length === 0) throw new Error("所选分支位置没有可用的持久消息");
        const wanted = new Map(boundary.flatMap((message) => keysOf(message).map((key) => [key, message.messageId])));
        const excluded = new Set(messages.filter((message) =>
          message.entryId === null || message.entryId > sourceEntryId).flatMap(keysOf));
        const events = await session.history(sourceSessionId);
        const eventKey = (event) => event.type === "tool/call"
          ? `call:${event.data?.callId}`
          : `message:${event.type === "user/message" ? event.data?.id : event.data?.message?.id}`;
        let atSeq = -1;
        const found = new Set();
        for (const event of events) {
          const key = eventKey(event);
          if (wanted.has(key) && Number.isSafeInteger(event.seq)) {
            found.add(wanted.get(key));
            atSeq = Math.max(atSeq, event.seq);
          }
        }
        if (found.size !== boundary.length || atSeq < 0) {
          throw new Error("所选历史尚未同步到 DSH，请刷新历史后再创建分支");
        }
        if (events.some((event) => event.seq <= atSeq && excluded.has(eventKey(event)))) {
          throw new Error("两侧历史顺序不一致，无法在所选位置安全创建分支");
        }
        if (currentSessionId() !== sourceSessionId) throw new Error("会话已切换，请在目标会话重新创建分支");
        const requestId = nextRequestId("run.fork");
        const forked = await post("conversation.fork", { conversationId, requestId, sourceEntryId });
        let childSessionId;
        try {
          childSessionId = await session.fork(sourceSessionId, atSeq);
        } catch (error) {
          // The Core half is already done and is not rolled back. Saying which
          // half failed — and that the branch Conversation exists — is the only
          // honest report; a bare failure would read as "nothing happened".
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Core 里的分支 Conversation ${String(forked.conversationId)} 已经创建，但 dsh 没能为它打开新会话：${reason}`,
          );
        }
        if (typeof childSessionId !== "string" || childSessionId === "") {
          throw new Error("dsh 的 fork 没有返回新的会话 id");
        }
        await post("session.associate", {
          sessionId: childSessionId,
          sourceSessionId,
          threadId: requireField(forked, "threadId"),
          conversationId: requireField(forked, "conversationId"),
          requestId: `${requestId}:associate`,
        });
        if (currentSessionId() === sourceSessionId) session.select(childSessionId);
        return {
          status: ACTION.DONE,
          reason: null,
          result: {
            sessionId: childSessionId,
            threadId: forked.threadId,
            conversationId: forked.conversationId,
            inheritedThrough: forked.inheritedThrough ?? null,
          },
        };
      };

      /** Everyone following the state; a session switch refreshes them all. */
      const followers = new Set();

      /** Re-read the state and hand it to every follower. */
      const refresh = async () => {
        const state = await readState();
        for (const follower of [...followers]) follower(state);
        return state;
      };

      return {
        /** Read what the panel draws. */
        state: readState,
        observations,
        /** Re-read the state now, and tell everyone following it. */
        refresh,
        /**
         * One operation id, from the same allocator this transport mints its
         * own with.
         *
         * Exposed because one control has to mint its id where the *retry* is
         * decided — the panel, so a supplement that timed out is re-sent as the
         * same command — while the *uniqueness* has to come from something that
         * outlives the panel. A counter inside a component restarts at zero
         * whenever the card is rebuilt, and the Core's ledger is keyed by the
         * Thread, not by the click: two panels' first supplements would be one
         * key, and the second would be answered with the first one's receipt.
         * What separates them is the random token in the id, which two panels
         * (and two windows) do not share; this transport's counter keeps a
         * single instance's calls apart as well. See {@link randomToken} for
         * what that does and does not promise.
         * @param action - the action id, which the id names.
         * @returns the id.
         */
        nextRequestId,

        /**
         * Run one product action.
         * @param action - the interface's action id.
         * @param payload - the action's arguments.
         * @returns `{ status, reason, result }`; only `done` is a success.
         */
        async call(action, payload) {
          // A reconnect is not a Core command: it is the panel asking the host
          // to try the link again, and the answer is the state the read returns.
          if (action === "core.reconnect") {
            const state = await readState();
            return state.connection === CONNECTION.READY
              ? { status: ACTION.DONE, reason: null, result: state }
              : { status: ACTION.ERROR, reason: state.core?.error?.message ?? null, result: state };
          }
          // A fork is not one command either: it is the Core's fork, a dsh
          // session opened on it, the record that ties them, and the selection.
          if (action === "run.fork") return await fork(payload ?? {});
          if (UNAVAILABLE[action] !== undefined) {
            return { status: ACTION.UNSUPPORTED, reason: UNAVAILABLE[action], result: null };
          }
          const build = OPERATIONS[action];
          if (build === undefined) {
            return { status: ACTION.UNSUPPORTED, reason: `${action} 没有对应的 Core 操作`, result: null };
          }
          const [operation, operationPayload] = build(payload ?? {});
          const result = await post(operation, { ...operationPayload, ...(payload && Object.hasOwn(payload, "targetId") ? { targetId: payload.targetId } : {}) });
          return { status: ACTION.DONE, reason: null, result };
        },
        /**
         * Follow the host's state until the returned function is called.
         *
         * Two sources, deliberately: the Core's committed events drive a refresh
         * the moment something happens, and the interval is the fallback for
         * what no event carries — a Thread created by another window, a Core
         * that went away. A view that only polled would lag; one that only
         * listened would miss everything the bridge did not cause.
         * @param listener - called with the state, on every change.
         * @param options.intervalMs - the polling fallback's period.
         * @returns the stop function.
         */
        watch(listener, { intervalMs = 2000 } = {}) {
          let stopped = false;
          const tick = async () => {
            if (stopped) return;
            const state = await readState();
            if (!stopped) listener(state);
          };
          // Registered as a follower as well as polled, so a session switch
          // repaints the panel at once instead of at the next tick: the switch
          // is exactly the moment the answer changes.
          followers.add(listener);
          const timer = typeof setInterval === "function" ? setInterval(() => void tick(), intervalMs) : null;
          void tick();
          const stopEvents = subscribeSharedEvents(Events, `${base}/events`, { onEvent: () => void tick() });
          return () => {
            stopped = true;
            followers.delete(listener);
            if (timer !== null) clearInterval(timer);
            stopEvents();
          };
        },
        /**
         * Follow the Core's committed events and live frames.
         *
         * Kept separate from {@link watch}: this is the raw stream, for a caller
         * that wants the events themselves rather than the state they imply.
         * @param options.onEvent - called with each committed event.
         * @param options.onLive - called with each live frame.
         * @returns the stop function.
         */
        subscribe({ onEvent, onLive, onError } = {}) {
          return subscribeSharedEvents(Events, `${base}/events`, { onEvent, onLive, onError });
        },
      };
    }

    /**
     * The bridge's service facade.
     *
     * `transport` is the seam a later milestone fills with the real browser-host
     * SDK call. While it is absent every action reports `unsupported` — the
     * interface says what it cannot do instead of pretending it did it.
     * @param options.initial - initial view state, merged over the defaults.
     * @param options.transport - `{ call(action, payload) }`, or nothing in M1.
     * @returns the facade: view state, action outcomes, and the explicit setters
     * the settings surface drives.
     */
    function createServices({ initial, transport } = {}) {
      const viewState = createStore({
        ...DEFAULT_STATE,
        ...(initial ?? {}),
        core: { ...DEFAULT_STATE.core, ...(initial?.core ?? {}) },
      });
      /** Last outcome per action id; the interface reads these to show why nothing moved. */
      const outcomes = new Map();
      let targetGeneration = 0;
      /** Ids minted here when no transport could supply one; only ever increases. */
      let fallbackIds = 0;
      const outcomeListeners = new Set();
      /**
       * Declared demo content, per area, and the areas a second module tried to
       * claim. Fixtures live here rather than inside the store so that turning
       * demo off hides them wholesale: nothing renders a fixture except through
       * {@link fixture}, which answers `null` unless demo is explicitly on.
       */
      const fixtures = new Map();
      const fixtureConflicts = [];

      const publish = (id, outcome) => {
        outcomes.set(id, Object.freeze(outcome));
        for (const listener of [...outcomeListeners]) listener(id, outcomes.get(id));
      };

      return {
        viewState,
        resetForTarget() {
          targetGeneration++;
          for (const id of [...outcomes.keys()]) publish(id, { status: ACTION.IDLE, reason: null, result: null });
          outcomes.clear();
          viewState.set({ ...DEFAULT_STATE, info: null, core: { home: null, socketPath: null, lockFile: null, autoStart: false, attempts: 0, error: null } });
        },
        observations: transport?.observations ?? null,
        /** The reason an action gives when no transport was injected at all. */
        UNWIRED_REASON: "插件没有注入 Core 传输，动作未执行",
        /**
         * The host's failure, as the one line the panel draws.
         *
         * The host reports a failure as `{code, message}`: the code is for a
         * caller that branches, the message is for the reader. Handing the
         * object to the interface is not a thing it can draw, so this is the
         * one place that decides — the message when there is one, the code
         * when the message is missing, and `null` when the host said nothing,
         * which lets the caller fall back to its own words.
         * @param failure - the host's error, a plain string, or nothing.
         * @returns the text to draw, or `null`.
         */
        reasonText(failure) {
          if (failure === null || failure === undefined) return null;
          if (typeof failure === "string") return failure === "" ? null : failure;
          if (typeof failure !== "object") return String(failure);
          const message = typeof failure.message === "string" && failure.message !== "" ? failure.message : null;
          const code = typeof failure.code === "string" && failure.code !== "" ? failure.code : null;
          if (message === null && code === null) return null;
          return message === null ? code : code === null ? message : `${code}: ${message}`;
        },
        /**
         * An operation id for a control that has to keep its id across a retry.
         *
         * The id comes from the transport's own allocator when there is one, so
         * a card rebuilt over the same plugin draws from a counter that did not
         * restart with it; the Core's ledger is keyed by the Thread, so two
         * different operations that minted one key would make the second be
         * answered with the first one's receipt. A build with no transport gets
         * an id from the same random token and a counter of its own.
         * @param action - the action id the id names.
         * @returns the id.
         */
        requestId(action) {
          if (typeof transport?.nextRequestId === "function") return transport.nextRequestId(action);
          return `sap-${action}-${randomToken()}-${(fallbackIds += 1).toString(36)}`;
        },
        /**
         * Run one product action.
         *
         * Resolves to the outcome; it never resolves to a success while no
         * transport exists, and it never throws at the caller — a failure is an
         * outcome the interface renders, not an exception it swallows. A success
         * carries the Core's own receipt in `result`, because "accepted" and
         * "done" are different claims and only the Core gets to make the second.
         * @param id - action id the interface uses to find its own outcome.
         * @param payload - action arguments, forwarded to the transport.
         */
        async run(id, payload) {
          const generation = targetGeneration;
          publish(id, { status: ACTION.PENDING, reason: null, result: null });
          if (transport === undefined || transport === null) {
            const outcome = { status: ACTION.UNSUPPORTED, reason: this.UNWIRED_REASON, result: null };
            if (generation === targetGeneration) publish(id, outcome);
            return outcome;
          }
          try {
            const answer = await transport.call(id, payload);
            const outcome = {
              status: answer?.status ?? ACTION.DONE,
              reason: answer?.reason ?? null,
              result: answer?.result ?? null,
            };
            if (generation === targetGeneration) publish(id, outcome);
            return outcome;
          } catch (error) {
            const outcome = {
              status: ACTION.ERROR,
              reason: error instanceof Error ? error.message : String(error),
              result: null,
            };
            if (generation === targetGeneration) publish(id, outcome);
            return outcome;
          }
        },
        /** The last outcome of one action, or `idle` when it has never run. */
        outcomeOf(id) {
          return outcomes.get(id) ?? Object.freeze({ status: ACTION.IDLE, reason: null, result: null });
        },
        subscribeOutcomes(listener) {
          outcomeListeners.add(listener);
          return () => {
            outcomeListeners.delete(listener);
          };
        },
        /** Explicitly turn demo content on or off; the interface marks it whenever it is on. */
        setDemo(demo) {
          return viewState.set({ demo: demo === true });
        },
        /**
         * Declare the demo content one area of the interface owns.
         *
         * The module that draws an area also owns its sample values, so no
         * module has to know another's shape. A second claim on the same area
         * is recorded rather than thrown: a collision is a bug to fix, not a
         * reason to take the whole interface down.
         * @param areas - area name to sample content.
         */
        registerFixtures(areas) {
          for (const [area, value] of Object.entries(areas ?? {})) {
            if (fixtures.has(area)) {
              fixtureConflicts.push(area);
              continue;
            }
            fixtures.set(area, Object.freeze(value));
          }
        },
        /**
         * The demo content for one area, or `null` unless demo is explicitly on.
         * Every fixture read goes through here, so no page can show sample data
         * in a state that is not marked as demo.
         * @param area - area name registered through {@link registerFixtures}.
         */
        fixture(area) {
          return viewState.get().demo === true ? (fixtures.get(area) ?? null) : null;
        },
        /** The areas some module declared demo content for; the entry checks collisions with it. */
        fixtureAreas() {
          return [...fixtures.keys()];
        },
        /** Areas a second module tried to claim; empty in a healthy build. */
        fixtureConflicts() {
          return [...fixtureConflicts];
        },
        /** Explicitly choose the Core link state the pages render. */
        setConnection(connection) {
          return viewState.set({ connection: connection === CONNECTION.READY ? CONNECTION.READY : CONNECTION.OFFLINE });
        },
        /** Replace the Core connection facts the panel shows. */
        setCore(core) {
          return viewState.set({ core });
        },
      };
    }

    return { CONNECTION, ACTION, DEFAULT_STATE, CORE_ROUTE, createStore, createServices, createCoreTransport, readSessionHistory, createSharedEventSubscriber };
  },
});
