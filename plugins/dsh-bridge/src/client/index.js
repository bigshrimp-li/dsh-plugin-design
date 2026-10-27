/** Independent Super Agent root panel. Harness owns its native Sessions and composer.
 * Client bundle revision: goals-v1-20261027. Bump with chunk changes
 * when deploying through a Harness host that caches package resources by entry.
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /**
     * Every module of the bundle, as the package-local chunk that carries it.
     *
     * `required` ones are the bundle itself — without them there is no
     * interface to draw, so a failure there is fatal to the activation. The
     * page modules arrive as the milestone that owns them lands; until then the
     * shell draws an explicit "not wired up yet" body, which is why a missing
     * one is recorded and reported instead of failing the plugin.
     */
    const CHUNKS = {
      styles: { file: "./client.styles.js", required: true },
      services: { file: "./client.services.js", required: true },
      shell: { file: "./client.shell.js", required: true },
      space: { file: "./client.space.js", required: true },
      spaceView: { file: "./client.space-view.js", required: true },
      settings: { file: "./client.settings.js", required: true },
      settingsContent: { file: "./client.settings-content.js", required: true },
      fileDecisions: { file: "./client.file-decisions.js", required: true },
      trace: { file: "./client.trace.js", required: true },
      main: { file: "./client.main.js", required: false },
      runPanel: { file: "./client.run-panel.js", required: false },
      offline: { file: "./client.offline.js", required: false },
      observe: { file: "./client.observe.js", required: false },
      observationDetail: { file: "./client.observation-detail.js", required: false },
    };

    // Native Workspace and Session services remain owned by Harness.
    const inject = ["slots", "locale", "layout", "uiWorkspace"];

    /**
     * Load every chunk of the bundle.
     *
     * A required chunk that will not load throws, because an activation without
     * it would draw nothing. An optional one is recorded and left out: the
     * shell renders its own honest stand-in for an area no module supplies.
     * @param asyncRequire - `require.async` from this factory.
     * @returns the loaded modules by key, and the failures.
     */
    async function loadChunks(asyncRequire) {
      const modules = {};
      const failures = [];
      await Promise.all(
        Object.entries(CHUNKS).map(async ([key, chunk]) => {
          try {
            modules[key] = await asyncRequire(chunk.file);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ chunk: chunk.file, required: chunk.required, message });
            if (chunk.required) {
              throw new Error(`dsh-bridge: required chunk ${chunk.file} did not load: ${message}`, { cause: error });
            }
          }
        }),
      );
      return { modules, failures };
    }

    /**
     * The kernel every chunk of this bundle draws with.
     *
     * A chunk cannot synchronously require another chunk (dsh's module protocol
     * forbids it), so everything shared travels through here: the element
     * factory, the primitives, the icons, the single stylesheet element and the
     * two store hooks. The entry hands it to each module's `create*` function
     * rather than letting a module reach for it.
     * @param options.CSS - the stylesheet text from the styles chunk.
     * @param options.STYLE_ID - the attribute marking that stylesheet element.
     */
    function createKernel({ CSS, STYLE_ID }) {
      /** Status dot; tone picks the state token. */
      function Dot({ tone }) {
        return h("span", { className: "sap-dot", "data-tone": tone, "aria-hidden": "true" });
      }

      /** Inline SVG frame. */
      function Svg({ viewBox, size, strokeWidth, children }) {
        return h(
          "svg",
          {
            viewBox,
            width: size,
            height: size,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: strokeWidth ?? 1.5,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true",
          },
          children,
        );
      }

      /** The design's "space" glyph for the Super Agent row. */
      function IconSuperAgent() {
        return h(
          Svg,
          { viewBox: "0 0 16 16", size: 16 },
          h("path", { key: "arc", d: "M13 8a5 5 0 1 1-1.6-3.7" }),
          h("path", { key: "arrow", d: "M13 2.6v3h-3" }),
        );
      }

      /** The design's warning glyph for the disconnected notice. */
      function IconWarning() {
        return h(
          Svg,
          { viewBox: "0 0 20 20", size: 20, strokeWidth: 1.6 },
          h("path", { key: "bar", d: "M10 3.2v8.4" }),
          h("circle", { key: "dot", cx: 10, cy: 15.8, r: 1, fill: "currentColor", stroke: "none" }),
        );
      }

      /** The design's delegation glyph for the subagent tool card. */
      function IconDelegation() {
        return h(
          Svg,
          { viewBox: "0 0 16 16", size: 15 },
          h("circle", { key: "a", cx: 5.6, cy: 5, r: 2.2 }),
          h("circle", { key: "b", cx: 11, cy: 10.6, r: 2.2 }),
          h("path", { key: "link", d: "M7.5 6.2 9.4 9" }),
        );
      }

      /**
       * One card with a title row and optional trailing aside.
       *
       * `collapsible` turns the title row into a disclosure control: the title
       * becomes a real button carrying `aria-expanded` (and `aria-controls`
       * when the card was given an `id`), so the card folds from the keyboard
       * as well as from a click. It starts expanded, so what a reader sees
       * first is the design's layout and folding is something they ask for.
       */
      function Card({ title, aside, children, collapsible, id }) {
        const [open, setOpen] = React.useState(true);
        const bodyId = id === undefined ? undefined : `${id}-body`;
        const heading =
          collapsible === true
            ? h(
                "button",
                {
                  type: "button",
                  className: "sap-card-toggle",
                  "aria-expanded": open,
                  ...(bodyId === undefined ? {} : { "aria-controls": bodyId }),
                  onClick: () => setOpen((value) => !value),
                },
                h("span", { className: "sap-card-title" }, title),
                h("span", { className: "sap-card-chevron", "data-open": String(open), "aria-hidden": "true" }),
              )
            : h("span", { className: "sap-card-title" }, title);
        return h(
          "div",
          { className: "sap-card", "data-collapsed": collapsible === true && !open ? "true" : undefined },
          h("div", { className: "sap-card-head" }, heading, h("span", { className: "sap-spacer" }), aside ?? null),
          collapsible === true ? h("div", { id: bodyId, hidden: !open }, children) : children,
        );
      }

      /** One labelled value row. */
      function Field({ label, value }) {
        return h(
          "div",
          { className: "sap-field" },
          h("span", { className: "sap-field-label" }, label),
          h("span", { className: "sap-field-value sap-mono" }, value),
        );
      }

      /**
       * One push button. `solid` is the design's filled primary and `link` its
       * borderless text control; anything else is the outlined default.
       */
      function Btn({ children, variant, disabled, onClick }) {
        const shape = variant ?? "ghost";
        return h(
          "button",
          {
            type: "button",
            className: shape === "link" ? "sap-link" : "sap-btn",
            "data-variant": shape,
            disabled: disabled === true,
            onClick: disabled === true ? undefined : onClick,
          },
          children,
        );
      }

      /** One settings/composer chip. */
      function Chip({ children, mono, disabled }) {
        return h(
          "span",
          {
            className: mono === true ? "sap-chip sap-mono" : "sap-chip",
            "data-disabled": disabled === true ? "true" : undefined,
          },
          children,
        );
      }

      /**
       * Subscribe a component to a store.
       *
       * `useState` + `useEffect` rather than `useSyncExternalStore`: the seats
       * this bundle renders into are plain function components, and the pair is
       * enough for a store that notifies on every change.
       */
      function useStore(store) {
        const [snapshot, setSnapshot] = React.useState(() => store.get());
        React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), [store]);
        return snapshot;
      }

      /** Subscribe a component to one action's outcome. */
      function useOutcome(services, id) {
        const [outcome, setOutcome] = React.useState(() => services.outcomeOf(id));
        React.useEffect(
          () =>
            services.subscribeOutcomes((changed) => {
              if (changed === id) setOutcome(services.outcomeOf(id));
            }),
          [services, id],
        );
        return outcome;
      }

      /** The bundle's single stylesheet, rendered as an element so unmount removes it. */
      function Style() {
        return h("style", { key: "bridge-css", "data-plugin-css": STYLE_ID }, CSS);
      }

      return {
        React,
        h,
        Style,
        Dot,
        Svg,
        IconSuperAgent,
        IconWarning,
        IconDelegation,
        Card,
        Field,
        Btn,
        Chip,
        useStore,
        useOutcome,
      };
    }

    /**
     * Merge every module's dictionary slice into one namespace.
     *
     * The bundle registers a single dictionary, so a key two modules claim with
     * different text is a bug rather than a preference: the first claim wins and
     * the collision is reported, because a silent last-wins would make the copy
     * depend on chunk arrival order.
     * @param slices - `{ zh, en }` pairs, in load order.
     * @returns the merged dictionaries and the keys that collided.
     */
    function mergeDictionaries(slices) {
      const merged = { zh: {}, en: {} };
      const collisions = [];
      for (const slice of slices) {
        for (const language of ["zh", "en"]) {
          for (const [key, text] of Object.entries(slice?.[language] ?? {})) {
            if (Object.hasOwn(merged[language], key)) {
              if (merged[language][key] !== text) collisions.push({ language, key });
              continue;
            }
            merged[language][key] = text;
          }
        }
      }
      return { dictionaries: merged, collisions };
    }

    /**
     * Client plugin body.
     *
     * It returns before the chunks have arrived, and that is deliberate. The
     * host audits every entry's fiber state once, right after its own startup
     * await, and an entry still mid-activation is reported as failed — the whole
     * application renders a boot failure instead of the interface. A body that
     * awaits the chunks is exactly that entry. dsh's own multi-file client
     * plugins keep `apply` synchronous and reach for their chunk from inside a
     * lazy component for the same reason.
     *
     * So the interface is wired by {@link activate} in the background, and what
     * this function owes the host is an activated fiber. A failure there is
     * reported through the logger: the plugin stays up, and the shell draws its
     * own honest stand-in for whatever did not load.
     * @param ctx - client root context.
     * @param config - plugin config, when the host delivers one. dsh 0.2.0-rc.2
     * creates a client half with `{ name }` only, so this is normally
     * `undefined`; the view state is injected from the settings surface instead,
     * and the parameter is honoured for a host that starts delivering it.
     */
    function apply(ctx, config) {
      activate(ctx, config).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.logger && typeof ctx.logger.error === "function") ctx.logger.error(error);
        else if (typeof console !== "undefined" && console.error) console.error(`[dsh-bridge] ${message}`);
      });
    }

    /**
     * Load the bundle's chunks and wire the interface they carry.
     * @param ctx - client root context.
     * @param config - plugin config, when the host delivers one.
     * @returns what the activation produced, once every chunk has arrived.
     */
    async function activate(ctx, config) {
      const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      const { modules, failures } = await loadChunks(require.async);

      const kernel = createKernel({ CSS: modules.styles.CSS, STYLE_ID: modules.styles.STYLE_ID });
      // The transport is the host's routes, unless the host injected one — the
      // config seam is what the offline suite drives, and dsh 0.2.0-rc.2 creates
      // a client half with `{ name }` only, so in a real profile this is the
      // transport the bridge builds for itself.
      const transport = config?.transport ?? modules.services.createCoreTransport();
      const services = modules.services.createServices({
        initial: config?.viewState,
        transport,
      });
      // The shell is built first because the page modules draw their actions
      // with its control: a chunk cannot require a sibling chunk, so everything
      // shared travels through the entry like this.
      const shell = modules.shell.createShell({
        kernel,
        services,
        blocks: undefined,
        views: {},
        openPanel: () => ctx.layout.selectPanel(modules.space.SPACE_ID),
      });
      // The composition root wires the page modules together. Every module gets
      // the same mutable `parts` object and reads what it needs when it renders,
      // so two modules can draw each other's pieces without a chunk requiring a
      // sibling chunk and without an order between them.
      const parts = { ActionBtn: shell.ActionBtn };
      const runPanel = modules.runPanel?.createRunPanel({ kernel, services, parts });
      const offline = modules.offline?.createOffline({ kernel, services, parts });
      const main = modules.main?.createMainView({ kernel, services, parts });
      const observationDetail = modules.observationDetail?.createObservationDetail({ kernel, services, parts });
      const observe = modules.observe?.createObserveView({ kernel, services, parts });

      Object.assign(parts, {
        RunPanel: runPanel?.RunPanel,
        OfflineNotice: offline?.OfflineNotice,
        OfflinePanel: offline?.OfflinePanel,
        CoreStatusCard: main?.CoreStatusCard,
        RecoveryCard: main?.RecoveryCard,
        MemberDetail: observationDetail?.MemberDetail,
      });

      shell.setViews({
        runSession: main?.RunSessionTab,
        observe: observe?.ObserveTab,
        offlineNotice: offline?.OfflineNotice,
      });

      const slices = [shell, main, runPanel, offline, observe, observationDetail]
        .filter((module) => module !== undefined)
        .map((module) => module.dictionary);
      const { dictionaries } = mergeDictionaries(slices);

      ctx.effect(() => ctx.locale.register(shell.LOCALE_NS, dictionaries), "dsh-bridge: dictionaries");
      shell.bindTranslate(ctx.locale.bind(shell.LOCALE_NS));

      for (const module of [shell, main, runPanel, offline, observe, observationDetail]) {
        if (module?.demoFixture !== undefined) services.registerFixtures(module.demoFixture);
      }

      const trace = modules.trace.createTrace({ kernel, services });
      const space = modules.space.createSpace({ kernel, services, transport, ctx, primitives, createSpaceView: modules.spaceView.createSpaceView, ConversationTrace: trace.ConversationTrace,
        directoryBrowser: {
          pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
          listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
          createDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
        },
        Panel: shell.registrations.find(entry => entry.slot === "sidebar.right.pane.tab").component });
      const fileDecisions = modules.fileDecisions.createFileDecisions({ kernel, primitives, space });
      const content = modules.settingsContent.createSettingsContent({ kernel, primitives, space, fileDecisions });
      const settings = modules.settings.createSettings({ kernel, transport, primitives, space, content,
        Panel: shell.registrations.find(entry => entry.slot === "sidebar.right.pane.tab").component });
      for (const entry of [...space.registrations, ...settings.registrations]) {
        ctx.effect(() => registerSlot(ctx, entry, shell.LOCALE_NS), `dsh-bridge: ${entry.label}`);
      }
      ctx.effect(() => space.controller.start(), "dsh-bridge: independent space lifecycle");
      return { failures, dictionaries, services, kernel, shell, space, settings };
    }

    /**
     * Register one entry through `slots.inject`.
     *
     * A single slot already held by a built-in throws in `slots.register` when
     * the two sit at the same priority; both single slots the design uses
     * register below the built-ins, so a throw here would mean the shadowing
     * assumption broke — the plugin reports that instead of hiding it, and the
     * other slots still render.
     */
    function registerSlot(ctx, entry, localeNamespace) {
      return ctx.slots.inject(entry.slot, () => {
        try {
          return ctx.slots.register(
            {
              ...entry.options,
              ...(entry.labelKey === undefined ? {} : { label: () => ctx.locale.bind(localeNamespace)(entry.labelKey) }),
              locale: localeNamespace,
            },
            entry.component,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (typeof console !== "undefined" && console.warn) {
            console.warn(`[dsh-bridge] ${entry.slot} was not claimed: ${message}`);
          }
          return () => {};
        }
      });
    }

    return { inject, apply, activate, createKernel, mergeDictionaries };
  },
});
