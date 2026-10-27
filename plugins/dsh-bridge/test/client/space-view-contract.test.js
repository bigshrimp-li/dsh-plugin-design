import { describe, expect, it, vi } from "vitest";

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.space.js");
const spaceModule = loaded.pop().factory();
await import("../../src/client/client.space-view.js");
const { createSpaceView } = loaded.pop().factory();

const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });

function fixture(messages = [], { deletedAt, observations, resources = {} } = {}) {
  const requests = [];
  const layoutSelections = [];
  const state = {
    directories: [{ root: "/workspace" }], root: "/workspace", modelId: "model-a",
    titles: { "conversation-1": "A saved Super Agent thread" },
  };
  const React = {
    createElement,
    Fragment: Symbol("Fragment"),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useRef: initial => ({ current: initial }),
    useEffect() {},
    useState: (initial) => [initial, () => {}],
  };
  const kernel = { React, h: createElement };
  const services = {
    viewState: { get: () => ({}), set() {} },
    ...(observations ? { observations } : {}),
  };
  const transport = {
    nextRequestId: (name) => `${name}-1`,
    async call() { throw new Error("the Space must use its independent Core routes"); },
  };
  const ctx = { layout: { selectPanel: (id) => layoutSelections.push(id) } };
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^\/super-agent\//, "");
    if (path.startsWith("state")) {
      const query = new URL(`http://space.test/${path}`).searchParams;
      return { ok: true, status: 200, json: async () => ({
        connection: "ready", threadId: query.get("threadId"), conversationId: query.get("conversationId"),
      }) };
    }
    const { action, payload } = JSON.parse(init.body);
    requests.push({ action, payload });
    if (resources[action]) return { ok: true, status: 200, json: async () => ({ result: await resources[action](payload) }) };
    const result = action === "models.list" ? [{ id: "model-a", selectable: true }]
      : action === "thread.list" ? { items: [{ threadId: "thread-1", mainConversationId: "conversation-1", ...(deletedAt ? { deletedAt, recoverUntil: "2026-11-21T00:00:00.000Z" } : {}) }] }
        : action === "conversation.get" ? { conversationId: payload.conversationId, config: { cwd: "/workspace", modelId: "model-a" } }
          : action === "messages.list" ? { items: messages, caughtUp: true }
            : action === "thread.get" ? { threadId: payload.threadId, activeRuns: [], ...(deletedAt ? { deletedAt, recoverUntil: "2026-11-21T00:00:00.000Z" } : {}) }
              : {};
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  const storage = { getItem: () => JSON.stringify(state), setItem() {} };
  const primitives = {
    Button: () => null, Menu: () => null, Tooltip: () => null, Modal: () => null,
    FISH_LOGO_VIEWBOX: null, FISH_LOGO_PATH: "",
  };
  const space = spaceModule.createSpace({ kernel, services, transport, ctx, Panel: () => null,
    createSpaceView, primitives, fetchImpl, storage, EventSourceImpl: null });
  const view = createSpaceView({ kernel, controller: space.controller, services, ctx, Panel: () => null,
    SPACE_ID: spaceModule.SPACE_ID, primitives });
  return { ...space, ...view, React, primitives, requests, layoutSelections };
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
    },
  };
}

function values(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) values(item, output);
  } else if (value && typeof value === "object") {
    output.push(value);
    values(value.props?.children, output);
    values(value.props?.anchor, output);
  }
  return output;
}

function visibleText(value, output = []) {
  if (typeof value === "string" || typeof value === "number") output.push(String(value));
  else if (Array.isArray(value)) for (const item of value) visibleText(item, output);
  else if (value && typeof value === "object") visibleText(value.props?.children, output);
  return output.join(" ");
}

describe("independent Super Agent space view contract", () => {
  it("opens an actual retry relation and reads null-body tool arguments separately from prose without delivering reports", async () => {
    const reads = [], run = { runId: "retry-run", conversationId: "retry-conversation", status: "completed", frozenModel: { provider: "local", modelId: "model-a" } };
    const graph = { threadId: "thread-1", nodes: [{ kind: "run", runId: "source-run", conversationId: "conversation-1", status: "failed" }, { kind: "run", ...run }],
      edges: [{ kind: "origin_run", fromId: "source-run", toId: "retry-run", factId: "real-origin-fact" }] };
    const messages = [{ messageId: "retry-body", role: "assistant", kind: "assistant", text: "Ordinary persistent reply." },
      { messageId: "retry-call", role: "assistant", kind: "tool_call", text: null, toolCallId: "write-call", toolCall: { name: "write", arguments: '{"path":"B_RESULT.md","content":"EXACT_RETRY_BYTES","mode":"create"}' } }];
    const space = fixture([], { observations: {
      graph: async threadId => { reads.push({ kind: "graph", threadId }); return graph; },
      trace: async runId => { reads.push({ kind: "trace", runId }); return { facts: [{ type: "report", factId: "report-fact", payload: { reportId: "report-1", status: "pending", originalParentRunId: "source-run", recipientRunId: null, receivedAt: null, processedAt: null } }], links: [] }; },
    }, resources: { "run.get": async () => run, "messages.list": async payload => ({ items: payload.conversationId === run.conversationId ? messages : [], caughtUp: true }) } });
    await space.controller.refresh(); await space.controller.selectThread("thread-1", "conversation-1");
    const component = values(space.Space()).find(node => typeof node.type === "function" && node.type.name === "TaskGraph");
    expect(component).toBeTruthy();
    const slots = []; let cursor = 0, effectDeps, cleanup;
    space.React.useState = initial => { const at = cursor++; if (!(at in slots)) slots[at] = initial; return [slots[at], next => { slots[at] = typeof next === "function" ? next(slots[at]) : next; }]; };
    space.React.useEffect = (effect, deps) => { if (!effectDeps || deps.some((value, index) => value !== effectDeps[index])) { cleanup?.(); effectDeps = deps; cleanup = effect(); } };
    const draw = () => { cursor = 0; return component.type(component.props); };
    const before = space.requests.length;
    try {
      draw().props.onToggle({ currentTarget: { open: true } }); draw();
      await vi.waitFor(() => expect(visibleText(draw())).toContain("原输入独立重试：source-run → retry-run"));
      const card = values(draw()).find(node => node.type === "div" && visibleText(node).startsWith("任务 retry-run"));
      values(card).find(node => node.type === "button").props.onClick();
      await vi.waitFor(() => expect(visibleText(draw())).toContain("Ordinary persistent reply."));
      const tree = draw(), tool = values(tree).find(node => node.type === "article" && visibleText(node).includes("write-call"));
      expect(visibleText(tool)).not.toContain("Ordinary persistent reply.");
      const detail = values(tool).find(node => node.type === "details");
      expect(visibleText(detail)).toContain("write · write-call");
      expect(values(detail).find(node => node.type === "pre").props.children).toEqual([messages[1].toolCall.arguments]);
      expect(visibleText(tree)).toContain("原父任务 source-run · 接收任务 未接收 · 已接收 未记录 · 已处理 未记录");
      expect(visibleText(tree)).toContain("打开详情不会重复交付");
      expect(space.requests.slice(before).map(request => request.action)).toEqual(["run.get", "messages.list"]);
      expect(space.requests.at(-1).payload.conversationId).toBe("retry-conversation");
      expect(reads).toEqual([{ kind: "graph", threadId: "thread-1" }, { kind: "trace", runId: "retry-run" }]);
    } finally { cleanup?.(); space.controller.dispose(); }
  });
  it("keeps deleted history readable while disabling every conversation-changing control", async () => {
    const space = fixture([{ messageId: "historical", entryId: 1, kind: "assistant", role: "assistant", text: "retained historical answer" }], { deletedAt: "2026-10-22T00:00:00.000Z" });
    await space.controller.refresh(); const selection = space.controller.selectThread("thread-1", "conversation-1");
    const loading = render(space.Space(), new Set(Object.values(space.primitives)));
    expect(values(loading).find(node => node.props?.["aria-label"] === "Super Agent 消息").props.disabled).toBe(true);
    await selection;
    const tree = render(space.Space(), new Set(Object.values(space.primitives))), nodes = values(tree);
    expect(visibleText(tree)).toContain("retained historical answer"); expect(visibleText(tree)).toContain("无法恢复");
    for (const label of ["暂停", "恢复", "停止", "从此分支", "添加附件", "选择本次任务使用的 Skill", "显式压缩最近已完成任务"]) {
      const node = nodes.find(node => visibleText(node) === label || node.props?.["aria-label"] === label);
      expect(node, label).toBeTruthy(); expect(node.props.disabled, label).toBe(true);
    }
    for (const label of ["Super Agent 消息", "Super Agent 模型", "Super Agent 思考等级", "对话审批覆盖"]) {
      const node = nodes.find(node => node.props?.["aria-label"] === label); expect(node, label).toBeTruthy(); expect(node.props.disabled, label).toBe(true);
    }
    expect(nodes.find(node => visibleText(node) === "只读刷新状态").props.disabled).toBeFalsy();
    space.controller.dispose();
  });
  it("labels only native tool errors as failures while retaining the actual result text", async () => {
    const space = fixture([
      { messageId: "failed", kind: "tool_result", role: "tool", text: "shell exited 1", toolResult: { isError: true } },
      { messageId: "success", kind: "tool_result", role: "tool", text: "read done", toolResult: { isError: false } },
      { messageId: "legacy", kind: "tool_result", role: "tool", text: "old result with no status" },
    ]);
    await space.controller.refresh(); await space.controller.selectThread("thread-1", "conversation-1");
    expect(space.controller.getSnapshot().messages).toHaveLength(3);
    const tree = render(space.Space(), new Set(Object.values(space.primitives)));
    expect(values(tree).filter(node => node.props?.["data-tool-error"] === true)).toHaveLength(1);
    expect(visibleText(tree)).toContain("工具执行失败"); expect(visibleText(tree)).toContain("shell exited 1");
    space.controller.dispose();
  });

  it("keeps navigation in the DSH sidebar instead of nesting a second pane in the conversation", async () => {
    const space = fixture();
    await space.controller.refresh();
    const primitiveTypes = new Set(Object.values(space.primitives));
    const main = render(space.Space(), primitiveTypes);
    const mainNodes = values(main);

    expect(mainNodes.some((node) => node.type === "nav")).toBe(false);
    expect(mainNodes.some((node) => node.type === "aside")).toBe(false);
    const heroWorkspacePicker = mainNodes.filter((node) =>
      node.props?.["aria-label"] === "Super Agent 工作目录" && node.props?.["aria-haspopup"] === "menu");
    expect(heroWorkspacePicker).toHaveLength(1);
    expect(mainNodes.some((node) => node.props?.["aria-label"] === "Super Agent 工作区")).toBe(false);
    expect(visibleText(main)).not.toContain("新建会话");
    expect(visibleText(main)).not.toContain("A saved Super Agent thread");

    const sidebar = render(space.DirectorySection(), primitiveTypes);
    const sidebarNodes = values(sidebar);
    const sidebarText = visibleText(sidebar);
    expect(sidebarText).toContain("workspace");
    expect(sidebarText).toContain("A saved Super Agent thread");
    expect(sidebarText.split("A saved Super Agent thread").length - 1).toBe(1);
    expect(sidebarNodes.some((node) => /Super Agent.*(运行区|工作区)/.test(node.props?.["aria-label"] || ""))).toBe(true);
    space.controller.dispose();
  });

  it("does not open a nested inspection pane from inside the conversation", () => {
    const space = fixture();
    const mainComponent = space.Space;
    const primitiveTypes = new Set(Object.values(space.primitives));
    const before = render(mainComponent(), primitiveTypes);
    const inspectionToggle = values(before).find((node) => node.props?.["aria-label"] === "运行与观测");
    inspectionToggle?.props?.onClick?.();
    const after = render(mainComponent(), primitiveTypes);
    expect(values(after).some((node) => node.type === "aside")).toBe(false);
    space.controller.dispose();
  });
});
