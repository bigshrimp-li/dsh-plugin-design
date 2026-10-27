import { describe, expect, it, vi } from "vitest";

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.space-view.js");
const { createSpaceView, CSS, attachmentRangeLabel, currentAttachmentState, compactionStatusLabel, skillCatalogRowKey, skillChoiceState } = loaded[0].factory();

it("reports small-history compaction and unknown receipts without implying a committed checkpoint", () => {
  expect(compactionStatusLabel({ status: "aborted", reason: "no_effective_cut" })).toContain("历史不足");
  expect(compactionStatusLabel({ status: "aborted" })).toContain("未完成");
  expect(compactionStatusLabel({ status: "unknown" })).toContain("尚未确认");
  expect(compactionStatusLabel({ status: "committed" })).toContain("压缩已提交");
});

it("distinguishes effective partial contents, reference-only and unverified historical attachments", () => {
  const material = { attachmentId: "a", representationId: "r", contentHash: "hash" };
  const item = { ...material, status: "content_retained", retainedFormats: ["text"], evidence: [{ source: "tool_result", formats: ["text"], range: { start: 3, end: 3, offset: 0, endOffset: 400 } }] };
  const current = { status: "available", items: [item] };
  const state = currentAttachmentState(material, current);
  expect(state.label).toContain("部分文字");
  expect(state.evidence[0]).toContain("部分范围");
  expect(state.evidence[0]).toContain("结束字符偏移 400");
  expect(state.reason).toContain("不代表原选区、整份文件或全文");
  expect(currentAttachmentState(material, { ...current, items: [{ ...item, status: "reference_only" }] }).label).toContain("仅保留附件引用");
  for (const value of [undefined, { status: "unknown", items: [item] }, { ...current, items: [{ ...item, representationId: "other" }] }, { ...current, items: [{ ...item, contentHash: "other" }] }]) {
    expect(currentAttachmentState(material, value).label).toContain("未核实");
  }
});

it("labels page fragments as partial even when the returned fragment begins at character zero", () => {
  expect(attachmentRangeLabel({ start: 3, end: 3, offset: 0, endOffset: 400 })).toContain("部分范围");
  expect(attachmentRangeLabel({ start: 3, end: 3, offset: 0, endOffset: 400 })).toContain("结束字符偏移 400");
  expect(attachmentRangeLabel({ start: 3, end: 4 })).toBe("3–4");
});
it("keeps shadowed Skill rows distinct and confirms changed sources or versions without replacing the frozen selection", () => {
  const global = { skillId: "scope-check", status: "disabled", workspaceId: null, sourceIds: ["global"], snapshotId: "global-v1" };
  const workspace = { ...global, status: "available", workspaceId: "workspace-a", sourceIds: ["workspace"], sourceId: "workspace", snapshotId: "a-v1", sourceRevision: 1, policyRevision: 1 };
  const state = { selectedSkillIds: ["scope-check"], selectedSkills: [workspace] };
  expect(skillCatalogRowKey(global)).not.toBe(skillCatalogRowKey(workspace));
  expect(skillChoiceState(global, state)).toEqual({ checked: false, needsConfirmation: false });
  expect(skillChoiceState(workspace, state)).toEqual({ checked: true, needsConfirmation: false });
  expect(skillChoiceState({ ...workspace, snapshotId: "a-v2", sourceRevision: 2 }, state)).toEqual({ checked: false, needsConfirmation: true });
  expect(skillChoiceState({ ...workspace, sourceId: "other" }, state).needsConfirmation).toBe(true);
  expect(state.selectedSkills[0].snapshotId).toBe("a-v1");
});

function element(type, props, ...children) {
  return { type, props: { ...props, children } };
}

function primitive(name) {
  const Component = function InjectedPrimitive(props) { return element(`primitive:${name}`, props, props.children); };
  Component.displayName = `Injected${name}`;
  return Component;
}

function menuPrimitive() {
  const Menu = primitive("Menu");
  Menu.Root = primitive("Menu.Root");
  Menu.Trigger = primitive("Menu.Trigger");
  Menu.Content = primitive("Menu.Content");
  Menu.Item = primitive("Menu.Item");
  return Menu;
}

function allNodes(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) allNodes(item, output);
  } else if (value && typeof value === "object") {
    output.push(value);
    allNodes(value.props?.children, output);
    allNodes(value.props?.anchor, output);
    allNodes(value.props?.footer, output);
  }
  return output;
}

function buildView({ workspaceForm = false, directoryBrowser, threads, runEffects = false, managedDirectories = [], models } = {}) {
  const snapshot = {
    ready: true, loaded: true, error: "", busy: false, draft: "", root: "/workspace", modelId: "model-a",
    models: models || [{ id: "model-a", selectable: true }], directories: [{ root: "/workspace" }],
    viewOptions: { grouping: "group", threadOrder: "updated", archiveFilter: "hide" },
    titles: { "conversation-1": "Saved thread" },
    threads: threads || [{ threadId: "thread-1", mainConversationId: "conversation-1", title: "Saved thread", pinned: false, archived: false,
      conversation: { config: { cwd: "/workspace", modelId: "model-a" } } }],
    selected: null, messages: [], live: [], thread: null, inspector: false, workspaceForm,
    targetId: "remote-target", coreInstanceId: "instance-remote", coreTargetLabel: "远程 Core · https://remote.example:7443",
    workspaceLoading: false, workspaceOpening: false, workspaceError: "", workspaceRequest: null,
    managedWorkspaceLocation: { targetId: "remote-target", instanceId: "instance-remote", baseRoot: "/remote/core/workspaces", relativePath: "", root: "/remote/core/workspaces", exists: true, directories: managedDirectories },
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    browseManagedWorkspace: vi.fn(async relativePath => { snapshot.managedWorkspaceLocation = { ...snapshot.managedWorkspaceLocation, relativePath, root: `/remote/core/workspaces${relativePath ? `/${relativePath}` : ""}` }; return snapshot.managedWorkspaceLocation; }),
    openManagedWorkspace: vi.fn(async relativePath => { snapshot.workspaceForm = false; snapshot.root = `/remote/core/workspaces/${relativePath}`; return { root: snapshot.root, state: "ready" }; }),
    setDraft: vi.fn(), setModel: vi.fn(), setThinking: vi.fn(), send: vi.fn(), refresh: vi.fn(), selectThread: vi.fn(),
    newConversation: vi.fn(), registerWorkspace: vi.fn(async () => { snapshot.workspaceForm = false; }), fork: vi.fn(), renameThread: vi.fn(), pinThread: vi.fn(),
    deleteThread: vi.fn(), archiveThread: vi.fn(), unarchiveThread: vi.fn(), renameWorkspace: vi.fn(), removeWorkspace: vi.fn(), setViewOptions: vi.fn(),
    setManualThreadOrder: vi.fn(),
    setWorkspaceForm: vi.fn((value) => { snapshot.workspaceForm = value; }),
    setInspector: vi.fn(), reportError: vi.fn(), stop: vi.fn(),
  };
  const state = [];
  let cursor = 0;
  const React = {
    createElement: element,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useRef(initial) { const index = cursor++; if (!Object.hasOwn(state, index)) state[index] = { current: initial }; return state[index]; },
    useEffect(effect, deps = []) { const index = cursor++, previous = state[index]; if (runEffects && (!previous || deps.some((value, at) => value !== previous.deps[at]))) { previous?.cleanup?.(); state[index] = { deps, cleanup: effect() }; } },
    Fragment: Symbol("Fragment"),
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(state, index)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
    beginRender() { cursor = 0; },
  };
  const kernel = { React, h: element };
  const services = { viewState: { get: () => ({}), set: vi.fn() } };
  const ctx = { layout: { selectPanel: vi.fn() } };
  const primitives = {
    Button: primitive("Button"), Menu: menuPrimitive(), Tooltip: primitive("Tooltip"), Modal: primitive("Modal"),
    writeClipboard: vi.fn(),
  };
  const result = createSpaceView({ kernel, controller, services, ctx, Panel: () => null,
    SPACE_ID: "@super-agent/dsh-bridge/space", primitives, directoryBrowser });
  return { ...result, controller, primitives, snapshot, React };
}

function render(value, primitiveTypes, depth = 0) {
  if (depth > 40) throw new Error("component tree exceeded its depth limit");
  if (Array.isArray(value)) return value.map((item) => render(item, primitiveTypes, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (typeof value.type === "function" && !primitiveTypes.has(value.type)) {
    return render(value.type(value.props || {}), primitiveTypes, depth + 1);
  }
  return {
    ...value,
    props: {
      ...value.props,
      children: render(value.props?.children, primitiveTypes, depth + 1),
      ...(value.props?.anchor === undefined ? {} : { anchor: render(value.props.anchor, primitiveTypes, depth + 1) }),
      ...(value.props?.footer === undefined ? {} : { footer: render(value.props.footer, primitiveTypes, depth + 1) }),
    },
  };
}

function includesText(value, expected) {
  if (typeof value === "string" || typeof value === "number") return String(value).includes(expected);
  if (Array.isArray(value)) return value.some((item) => includesText(item, expected));
  return Boolean(value && typeof value === "object" && includesText(value.props?.children, expected));
}

describe("Super Agent Space uses injected DSH UI primitives", () => {
  it("uses injected Button, controlled Menu, and labelled Tooltip primitives", () => {
    const view = buildView({ workspaceForm: true });
    const menuTypes = [view.primitives.Menu, view.primitives.Menu.Root, view.primitives.Menu.Trigger,
      view.primitives.Menu.Content, view.primitives.Menu.Item];
    const primitiveTypes = new Set([view.primitives.Button, view.primitives.Tooltip, view.primitives.Modal, ...menuTypes]);
    view.React.beginRender();
    const tree = render([view.Space(), view.DirectorySection()], primitiveTypes);
    const types = new Set(allNodes(tree).map((node) => node.type));

    const nodes = allNodes(tree);
    const buttons = nodes.filter((node) => node.type === view.primitives.Button);
    const menus = nodes.filter((node) => node.type === view.primitives.Menu);
    const tooltips = nodes.filter((node) => node.type === view.primitives.Tooltip);
    expect(types.has(view.primitives.Button)).toBe(true);
    expect(buttons.some((node) => node.props?.variant === "outline")).toBe(true);
    expect(buttons.some((node) => node.props?.variant === "primary")).toBe(true);
    expect(menuTypes.some((type) => types.has(type))).toBe(true);
    expect(menus.some((node) => typeof node.props?.open === "boolean" &&
      typeof node.props?.onClose === "function" && typeof node.props?.onSelect === "function")).toBe(true);
    expect(menus.some((node) => node.props?.anchor?.props?.["aria-haspopup"] === "menu")).toBe(true);
    expect(tooltips.length).toBeGreaterThan(0);
    expect(tooltips.every((node) => typeof node.props?.label === "string" && node.props.label.length > 0)).toBe(true);

    const rootMenu = menus.find((node) => node.props?.items?.some((item) => item.id === "model") && node.props?.items?.some((item) => item.id === "thinking"));
    expect(rootMenu).toBeTruthy();
    view.React.beginRender();
    rootMenu.props.onSelect("model");
    const modelTree = render([view.Space(), view.DirectorySection()], primitiveTypes);
    const modelMenu = allNodes(modelTree).find((node) => node.type === view.primitives.Menu && node.props?.items?.some((item) => item.id === "model-a"));
    modelMenu.props.onSelect("model-a");
    return Promise.resolve().then(() => expect(view.controller.setModel).toHaveBeenCalledWith("model-a"));
  });

  it("uses a two-level model and reasoning menu with provider default and off kept separate", async () => {
    const view = buildView({ models: [
      { id: "model-a", name: "Model A", selectable: true, supportedThinkingLevels: ["off", "low", "high"] },
    ] });
    view.snapshot.draft = "draft survives menu navigation";
    const primitiveTypes = new Set(Object.values(view.primitives));
    const draw = () => {
      view.React.beginRender();
      return allNodes(render(view.Space(), primitiveTypes));
    };
    const root = draw().find(node => node.type === view.primitives.Menu &&
      node.props?.items?.some(item => item.id === "model") && node.props?.items?.some(item => item.id === "thinking"));
    expect(root.props.items.map(item => item.id)).toEqual(["model", "thinking"]);
    root.props.onSelect("thinking");
    const reasoning = draw().find(node => node.type === view.primitives.Menu &&
      node.props?.items?.some(item => item.id === "provider_default") && node.props?.items?.some(item => item.id === "off"));
    expect(reasoning.props.items.map(item => item.label)).toEqual(expect.arrayContaining(["提供方默认", "关闭", "low", "high"]));
    expect(reasoning.props.items.find(item => item.id === "provider_default").label).toBe("提供方默认");
    expect(reasoning.props.items.find(item => item.id === "off").label).toBe("关闭");
    reasoning.props.onSelect("high");
    await Promise.resolve();
    expect(view.controller.setThinking).toHaveBeenCalledWith("high");
    expect(view.snapshot.draft).toBe("draft survives menu navigation");
  });

  it("shows the actual model and pending selection separately while a Run is active", () => {
    const view = buildView({ models: [
      { id: "model-a", name: "Model A", selectable: true, supportedThinkingLevels: ["low", "high"] },
      { id: "model-b", name: "Model B", selectable: true, supportedThinkingLevels: ["high"] },
    ] });
    view.snapshot.selected = { threadId: "thread-1", conversationId: "conversation-1" };
    view.snapshot.thread = { threadId: "thread-1", status: "running", activeRuns: ["run-1"], runs: [] };
    view.snapshot.conversation = {
      conversationId: "conversation-1", configRevision: "effective-r1",
      config: { cwd: "/workspace", modelId: "model-a", thinkingLevel: "low", modelSource: "conversation_override" },
      pendingConfig: { configRevision: "pending-r2", blockingRunId: "run-1", config: { modelId: "model-b", thinkingLevel: "high" } },
    };
    view.snapshot.runDetails = [{ runId: "run-1", conversationId: "conversation-1", status: "running",
      frozenModel: { modelId: "model-a", thinkingLevel: "low" } }];
    const primitiveTypes = new Set(Object.values(view.primitives));
    view.React.beginRender();
    const tree = render(view.Space(), primitiveTypes);
    expect(includesText(tree, "当前 Model A · low")).toBe(true);
    expect(includesText(tree, "新选择将在当前任务结束后生效")).toBe(true);
    expect(includesText(tree, "待任务 run-1")).toBe(false);
    expect(allNodes(tree).find(node => node.props?.["aria-label"] === "Super Agent 模型").props.children).toContain("Model B");
    expect(allNodes(tree).some(node => node.type === "button" && includesText(node, "撤销待生效选择"))).toBe(true);
  });

  it("constrains the host model-menu wrapper and keeps header actions on one line", () => {
    const view = buildView();
    view.React.beginRender();
    const styles = allNodes(render(view.Space(), new Set(Object.values(view.primitives)))).find(node => node.type === "style").props.children.join("");
    expect(styles).toContain(".sa-header-actions{flex:none;");
    expect(styles).toContain("padding-right:var(--sa-diff-width,480px)");
    expect(styles).toContain(".sa-space[data-diff-expanded=true]>.sa-space-header");
    expect(styles).toContain("touch-action:none");
    expect(styles).toContain(".sa-header-btn{flex:none;white-space:nowrap;");
    expect(styles).toContain(".sa-composer-bar>:has(>.sa-model-menu){order:3;flex:1 1 calc(100% - 40px);max-width:calc(100% - 40px)}");
  });

  it("copies only the selected final reply body and reports success", async () => {
    const view = buildView();
    const run = { runId: "run-1", conversationId: "conversation-1", status: "completed", frozenModel: { modelId: "model-a" } };
    view.snapshot.selected = { threadId: "thread-1", conversationId: "conversation-1" };
    view.snapshot.thread = { threadId: "thread-1", status: "completed", activeRuns: [], runs: [run] };
    view.snapshot.runDetails = [run];
    view.snapshot.messages = [
      { messageId: "thinking", role: "assistant", kind: "thinking", text: "PRIVATE_PLAN", runId: "run-1", entryId: 1 },
      { messageId: "final", role: "assistant", kind: "assistant", text: "FINAL_BODY_ONLY", runId: "run-1", entryId: 2, isFinal: true },
    ];
    const primitiveTypes = new Set(Object.values(view.primitives));
    const draw = () => {
      view.React.beginRender();
      return allNodes(render(view.Space(), primitiveTypes));
    };
    const copy = draw().find(node => node.type === "button" && node.props?.["aria-label"] === "复制回复正文");
    expect(copy).toBeTruthy();
    await copy.props.onClick();
    expect(view.primitives.writeClipboard).toHaveBeenCalledWith("FINAL_BODY_ONLY");
    expect(draw().some(node => includesText(node, "已复制正文"))).toBe(true);
  });

  it("opens the directory dialog through the injected DSH Modal", () => {
    const view = buildView({ workspaceForm: true });
    const menuTypes = [view.primitives.Menu, view.primitives.Menu.Root, view.primitives.Menu.Trigger,
      view.primitives.Menu.Content, view.primitives.Menu.Item];
    const primitiveTypes = new Set([view.primitives.Button, view.primitives.Tooltip, view.primitives.Modal, ...menuTypes]);
    view.React.beginRender();
    const nodes = allNodes(render([view.Space(), view.DirectorySection()], primitiveTypes));
    const modal = nodes.find((node) => node.type === view.primitives.Modal && node.props?.title === "当前 Core 工作区");

    expect(modal).toBeDefined();
    expect(modal.props.open).toBe(true);
    expect(typeof modal.props.onClose).toBe("function");
  });

  it("scopes narrow-modal sizing and path wrapping to the workspace chooser body", () => {
    const view = buildView({ workspaceForm: true });
    view.React.beginRender();
    const nodes = allNodes(render(view.DirectorySection(), new Set(Object.values(view.primitives))));
    const modal = nodes.find(node => node.type === view.primitives.Modal && node.props.title === "当前 Core 工作区");
    expect(allNodes(modal).find(node => node.type === "form").props.className).toBe("sa-dialog-body sa-workspace-dialog-body");
    expect(CSS).toMatch(/\.sa-dialog-body\.sa-workspace-dialog-body\{[^}]*width:100%;min-width:0;max-width:100%;padding:8px 20px 16px/);
    expect(CSS).toContain(".sa-workspace-dialog-body p{margin:0;min-width:0;overflow-wrap:anywhere}");
    expect(CSS).toContain(".sa-workspace-dialog-body .sa-directory-browser{height:clamp(110px,22vh,190px)");
  });

  it("defaults to the current Core browser even when a native directory picker exists", async () => {
    const directoryBrowser = { pickDirectory: vi.fn(), listDirectory: vi.fn(), createDirectory: vi.fn() };
    const view = buildView({ workspaceForm: true, directoryBrowser, runEffects: true });
    const primitiveTypes = new Set(Object.values(view.primitives));
    view.React.beginRender();
    const nodes = allNodes(render(view.DirectorySection(), primitiveTypes));
    await view.controller.browseManagedWorkspace.mock.results[0].value;
    expect(view.controller.browseManagedWorkspace).toHaveBeenCalledWith("");
    expect(nodes.some(node => includesText(node, "远程 Core · https://remote.example:7443"))).toBe(true);
    expect(nodes.some(node => includesText(node, "/remote/core/workspaces"))).toBe(true);
    expect(directoryBrowser.pickDirectory).not.toHaveBeenCalled();
    expect(directoryBrowser.listDirectory).not.toHaveBeenCalled();
    expect(directoryBrowser.createDirectory).not.toHaveBeenCalled();
    expect(view.controller.registerWorkspace).not.toHaveBeenCalled();
    expect(view.controller.openManagedWorkspace).not.toHaveBeenCalled();
  });

  it("cancels without creating or registering a workspace and keeps the prior selection", () => {
    const view = buildView({ workspaceForm: true });
    const types = new Set(Object.values(view.primitives));
    view.React.beginRender();
    const nodes = allNodes(render(view.DirectorySection(), types));
    nodes.find(node => node.type === view.primitives.Modal && node.props.title === "当前 Core 工作区").props.onClose();
    expect(view.controller.setWorkspaceForm).toHaveBeenCalledWith(false);
    expect(view.controller.openManagedWorkspace).not.toHaveBeenCalled();
    expect(view.controller.registerWorkspace).not.toHaveBeenCalled();
    expect(view.snapshot.root).toBe("/workspace");
  });

  it("previews a relative Core path and makes Enter browse without creating it", async () => {
    const view = buildView({ workspaceForm: true });
    const types = new Set(Object.values(view.primitives));
    const draw = () => { view.React.beginRender(); return allNodes(render(view.DirectorySection(), types)); };
    draw().find(node => node.props?.["aria-label"] === "Core 工作区相对目录").props.onChange({ target: { value: "team/project" } });
    const typed = draw(), input = typed.find(node => node.props?.["aria-label"] === "Core 工作区相对目录");
    expect(typed.some(node => includesText(node, "/remote/core/workspaces/team/project"))).toBe(true);
    input.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault: vi.fn() });
    await view.controller.browseManagedWorkspace.mock.results[0].value;
    expect(view.controller.browseManagedWorkspace).toHaveBeenCalledWith("team/project");
    expect(view.controller.openManagedWorkspace).not.toHaveBeenCalled();
    expect(view.snapshot.root).toBe("/workspace");
    draw().find(node => node.type === view.primitives.Button && includesText(node, "创建／打开")).props.onClick();
    await view.controller.openManagedWorkspace.mock.results[0].value;
    expect(view.controller.openManagedWorkspace).toHaveBeenCalledWith("team/project");
    expect(view.snapshot.root).toBe("/remote/core/workspaces/team/project");
  });

  it("keeps an unknown request fixed and exposes only retry or cancellation", () => {
    const view = buildView({ workspaceForm: true });
    view.snapshot.workspaceRequest = { requestId: "original-open", relativePath: "team/project" };
    const types = new Set(Object.values(view.primitives));
    view.React.beginRender();
    const nodes = allNodes(render(view.DirectorySection(), types));
    expect(nodes.find(node => node.props?.["aria-label"] === "Core 工作区相对目录").props.disabled).toBe(true);
    expect(nodes.some(node => includesText(node, "原请求 original-open"))).toBe(true);
    expect(nodes.find(node => node.type === view.primitives.Button && includesText(node, "重试确认原请求"))).toBeDefined();
    expect(view.controller.openManagedWorkspace).not.toHaveBeenCalled();
  });

  it("sends on Enter but preserves Shift+Enter and IME composition", () => {
    const view = buildView();
    const menuTypes = [view.primitives.Menu, view.primitives.Menu.Root, view.primitives.Menu.Trigger,
      view.primitives.Menu.Content, view.primitives.Menu.Item];
    const primitiveTypes = new Set([view.primitives.Button, view.primitives.Tooltip, view.primitives.Modal, ...menuTypes]);
    const tree = render(view.Space(), primitiveTypes);
    const textarea = allNodes(tree).find((node) => node.type === "textarea" && node.props?.["aria-label"] === "Super Agent 消息");
    expect(textarea).toBeDefined();

    const enter = { key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, isComposing: false, keyCode: 13,
      preventDefault: vi.fn() };
    textarea.props.onKeyDown(enter);
    expect(view.controller.send).toHaveBeenCalledOnce();
    expect(enter.preventDefault).toHaveBeenCalledOnce();

    view.controller.send.mockClear();
    const preserveInput = [
      { shiftKey: true },
      { nativeEvent: { isComposing: true } },
      { isComposing: true },
      { keyCode: 229 },
    ];
    for (const extra of preserveInput) {
      const event = { key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, isComposing: false,
        keyCode: 13, preventDefault: vi.fn(), ...extra };
      textarea.props.onKeyDown(event);
      expect(view.controller.send).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("selects an existing Core directory as a candidate and confirms it separately", async () => {
    const view = buildView({ workspaceForm: true, managedDirectories: [{ name: "已有项目", relativePath: "team/existing", root: "/remote/core/workspaces/team/existing", workspaceId: "workspace-existing" }] });
    view.snapshot.managedWorkspaceLocation.truncated = true;
    const types = new Set(Object.values(view.primitives));
    const draw = () => { view.React.beginRender(); return allNodes(render(view.DirectorySection(), types)); };
    draw().find(node => node.type === "button" && includesText(node, "已有项目")).props.onClick();
    expect(view.controller.openManagedWorkspace).not.toHaveBeenCalled();
    expect(view.snapshot.root).toBe("/workspace");
    const selected = draw();
    expect(selected.some(node => includesText(node, "目录较多，仅显示前 1 项，请输入相对目录继续浏览"))).toBe(true);
    expect(selected.find(node => node.props?.["aria-label"] === "Core 工作区相对目录").props.value).toBe("team/existing");
    selected.find(node => node.type === view.primitives.Button && includesText(node, "创建／打开")).props.onClick();
    await view.controller.openManagedWorkspace.mock.results[0].value;
    expect(view.controller.openManagedWorkspace).toHaveBeenCalledWith("team/existing");
  });

  it("offers one irreversible delete action and no archive or recovery view", async () => {
    const view = buildView({ threads: [{ threadId: "thread-1", title: "Saved thread", archived: true,
      mainConversationId: "conversation-1", conversation: { config: { cwd: "/workspace" } } }] });
    const primitiveTypes = new Set(Object.values(view.primitives));
    const draw = () => { view.React.beginRender(); return allNodes(render(view.DirectorySection(), primitiveTypes)); };
    const initial = draw(), menu = initial.find(node => node.type === view.primitives.Menu && node.props?.items?.some(item => item.id === "delete"));
    expect(menu.props.items.map(item => item.id)).toEqual(["pin", "rename", "delete"]);
    expect(initial.filter(node => node.type === view.primitives.Menu).flatMap(node => node.props.items || []).some(item => ["archive", "deleted", "only"].includes(item.id))).toBe(false);
    menu.props.onSelect("delete");
    expect(view.controller.deleteThread).not.toHaveBeenCalled();
    const confirmation = draw().find(node => node.type === view.primitives.Modal && node.props?.title === "删除对话");
    expect(confirmation.props.open).toBe(true);
    expect(confirmation.props.description).toContain("无法恢复");
    expect(confirmation.props.description).not.toContain("30");
    await allNodes(confirmation.props.footer).find(node => node.type === view.primitives.Button && includesText(node, "删除")).props.onClick();
    expect(view.controller.deleteThread).toHaveBeenCalledWith("thread-1");
    expect(view.controller.archiveThread).not.toHaveBeenCalled();
  });

  it("reorders conversations by drag and persists manual ordering", () => {
    const view = buildView({ threads: [
      { threadId: "thread-1", mainConversationId: "conversation-1", title: "First", manualOrder: 0, conversation: { config: { cwd: "/workspace", modelId: "model-a" } } },
      { threadId: "thread-2", mainConversationId: "conversation-2", title: "Second", manualOrder: 1, conversation: { config: { cwd: "/workspace", modelId: "model-a" } } },
    ] });
    const menuTypes = [view.primitives.Menu, view.primitives.Menu.Root, view.primitives.Menu.Trigger,
      view.primitives.Menu.Content, view.primitives.Menu.Item];
    const primitiveTypes = new Set([view.primitives.Button, view.primitives.Tooltip, view.primitives.Modal, ...menuTypes]);
    view.React.beginRender();
    const rows = allNodes(render(view.DirectorySection(), primitiveTypes)).filter((node) => node.props?.draggable === true);
    expect(rows).toHaveLength(2);
    const target = rows[0];
    const event = {
      dataTransfer: { types: ["application/x-super-agent-thread"], getData: () => "thread-2" },
      preventDefault: vi.fn(),
    };
    target.props.onDrop(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(view.controller.setManualThreadOrder).toHaveBeenCalledWith(["thread-2", "thread-1"]);
    expect(view.controller.setViewOptions).toHaveBeenCalledWith({ threadOrder: "manual" });
  });
});

it("shows cancellation even when the aborted Run has no committed process message", () => {
  const view = buildView();
  view.snapshot.selected = { threadId: "thread-1", conversationId: "conversation-1" };
  view.snapshot.thread = { status: "paused_by_user", activeRuns: [], runs: [] };
  view.snapshot.runDetails = [{ runId: "stopped", conversationId: "conversation-1", status: "cancelled" }];
  view.snapshot.messages = [{ messageId: "input", runId: "stopped", role: "user", text: "stop test" }];
  view.React.beginRender();
  const tree = render(view.Space(), new Set(Object.values(view.primitives)));
  expect(includesText(tree, "已停止")).toBe(true);
  expect(allNodes(tree).some(node => node.props?.className === "sa-send sa-send-stop")).toBe(false);
});

it("does not replace a known permission wait or cancelling Run with a Thread-wide unknown label", () => {
  const view = buildView();
  view.snapshot.selected = { threadId: "thread-1", conversationId: "conversation-1" };
  view.snapshot.thread = { status: "waiting", activeRuns: ["run-1"], runs: [], blockingReasons: [{ kind: "unknown_executions" }] };
  const run = { runId: "run-1", conversationId: "conversation-1", status: "waiting", waitingFor: "permission" };
  view.snapshot.runDetails = [run];
  view.snapshot.messages = [{ messageId: "input", runId: "run-1", role: "user", text: "test" },
    { messageId: "tool", runId: "run-1", kind: "tool_call", toolCall: { name: "write", arguments: {} } }];
  const draw = () => { view.React.beginRender(); return render(view.Space(), new Set(Object.values(view.primitives))); };
  expect(includesText(draw(), "等待审批")).toBe(true);
  view.snapshot.runDetails = [{ ...run, status: "cancelling" }];
  view.snapshot.thread.status = "paused_by_user";
  expect(includesText(draw(), "停止处理中")).toBe(true);
});

describe("formal composer attachment interactions", () => {
  const draw = view => { view.React.beginRender(); return render(view.Space(), new Set(Object.values(view.primitives))); };
  it("lets a UDS user choose a model when the directory is available without a service default", () => {
    const view = buildView(); view.snapshot.modelId = "";
    const nodes = allNodes(draw(view));
    expect(nodes.find(node => node.props?.["aria-label"] === "Super Agent 模型").props.disabled).toBe(false);
    expect(nodes.find(node => node.props?.["aria-label"] === "Super Agent 思考等级").props.disabled).toBe(true);
  });
  it("returns context-preview focus to its opening button", () => {
    const view = buildView(); view.snapshot.attachments = [{ id: "card", name: "note.txt", status: "ready", size: 8 }];
    const opener = allNodes(draw(view)).find(node => node.type === "button" && includesText(node, "查看本次上下文"));
    const focus = vi.fn(); opener.props.ref.current = { focus }; opener.props.onClick();
    const dialog = allNodes(draw(view)).find(node => node.type === view.primitives.Modal && node.props.title === "本次上下文");
    dialog.props.onClose(); expect(focus).toHaveBeenCalledOnce();
  });
  it("separates attachment actions from Skill selection and keeps sending available alongside stop", () => {
    const view = buildView();
    view.snapshot.selected = { threadId: "thread-1", conversationId: "conversation-1" };
    view.snapshot.thread = { activeRuns: ["run-live"] };
    view.snapshot.runDetails = [{ runId: "run-live", conversationId: "conversation-1", status: "running" }];
    view.snapshot.attachments = [{ id: "card", name: "截图.png", status: "ready", mode: "image", kind: "image", size: 1024 }];
    const nodes = allNodes(draw(view));
    const attachmentMenu = nodes.find(node => node.type === view.primitives.Menu && node.props.anchor?.props?.["aria-label"] === "添加附件");
    expect(attachmentMenu.props.items.map(item => item.label)).toEqual(["添加图片或文件", "引用项目文件"]);
    expect(nodes.find(node => node.props?.["aria-label"] === "选择本次任务使用的 Skill")).toBeTruthy();
    expect(nodes.find(node => node.props?.["aria-label"] === "发送").props.disabled).toBeFalsy();
    expect(nodes.find(node => node.props?.["aria-label"] === "停止")).toBeTruthy();
    expect(includesText(draw(view), "材料类型")).toBe(false);
    expect(includesText(draw(view), "查看本次上下文")).toBe(true);
  });
  it("retains a failed card and blocks sending while the user can still remove or retry it", () => {
    const view = buildView();
    view.snapshot.draft = "保留任务正文";
    view.snapshot.attachments = [{ id: "bad-card", name: "failed.txt", size: 12, status: "failed", error: "读取失败，请重试" }, { id: "good-card", name: "success.txt", size: 8, status: "ready", mode: "inline" }];
    const tree = draw(view), nodes = allNodes(tree);
    expect(nodes.find(node => node.props?.["aria-label"] === "发送").props.disabled).toBe(true);
    expect(nodes.find(node => node.props?.["aria-label"] === "移除 failed.txt")).toBeTruthy();
    expect(includesText(tree, "读取失败，请重试")).toBe(true);
    expect(includesText(tree, "success.txt")).toBe(true);
    expect(nodes.find(node => node.props?.["aria-label"] === "Super Agent 消息").props.value).toBe("保留任务正文");
  });
  it("preserves normal paste and composing Enter while routing only clipboard images into attachments", async () => {
    const view = buildView(); view.controller.addMessageFiles = vi.fn(async () => []);
    const input = allNodes(draw(view)).find(node => node.props?.["aria-label"] === "Super Agent 消息");
    const preventText = vi.fn(); input.props.onPaste({ clipboardData: { items: [{ kind: "string", type: "text/plain" }] }, preventDefault: preventText });
    expect(preventText).not.toHaveBeenCalled();
    const image = new File([new Uint8Array([137,80,78,71])], "clipboard.png", { type: "image/png" }), preventImage = vi.fn();
    input.props.onPaste({ clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => image }] }, preventDefault: preventImage });
    await Promise.resolve(); expect(preventImage).toHaveBeenCalledOnce(); expect(view.controller.addMessageFiles).toHaveBeenCalledWith([image]);
    const preventEnter = vi.fn();
    input.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault: preventEnter });
    input.props.onKeyDown({ key: "Enter", keyCode: 229, preventDefault: preventEnter });
    expect(view.controller.send).not.toHaveBeenCalled(); expect(preventEnter).not.toHaveBeenCalled();
    input.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault: preventEnter });
    expect(view.controller.send).toHaveBeenCalledOnce();
  });
  it("limits file drop handling to the composer and leaves other DSH drag types untouched", async () => {
    const view = buildView(); view.controller.addMessageFiles = vi.fn(async () => []);
    const form = allNodes(draw(view)).find(node => node.type === "form" && node.props?.className === "sa-composer"), prevent = vi.fn(), stop = vi.fn();
    form.props.onDragOver({ dataTransfer: { types: ["application/x-super-agent-thread"] }, preventDefault: prevent });
    expect(prevent).not.toHaveBeenCalled();
    const file = new File(["test"], "notes.txt");
    form.props.onDrop({ dataTransfer: { files: [file] }, preventDefault: prevent, stopPropagation: stop });
    await Promise.resolve(); expect(prevent).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce(); expect(view.controller.addMessageFiles).toHaveBeenCalledWith([file]);
  });
  it("reports persisted historical materials as received without inventing model understanding", () => {
    const view = buildView();
    view.snapshot.selected = { threadId: "thread-1", conversationId: "conversation-1" };
    view.snapshot.messages = [{ messageId: "input", role: "user", kind: "user", text: "", materials: [{ kind: "image", path: "original.png", snapshotId: "fixed", contentHash: "abc", mode: "image" }] }];
    const tree = draw(view);
    expect(includesText(tree, "original.png")).toBe(true); expect(includesText(tree, "已接收")).toBe(true);
    expect(includesText(tree, "模型已理解")).toBe(false); expect(includesText(tree, "请求和 Trace 记录为准")).toBe(true);
  });
});
