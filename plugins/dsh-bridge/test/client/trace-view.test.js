import { describe, expect, it, vi } from "vitest";

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: definition => loaded.push(definition) } };
await import("../../src/client/client.trace.js");
const { createTrace } = loaded[0].factory();

function element(type, props, ...children) {
  return { type, props: { ...props, children } };
}

function allNodes(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) allNodes(item, output);
  } else if (value && typeof value === "object") {
    output.push(value);
    allNodes(value.props?.children, output);
  }
  return output;
}

function text(value, output = []) {
  if (typeof value === "string" || typeof value === "number") output.push(String(value));
  else if (Array.isArray(value)) for (const item of value) text(item, output);
  else if (value && typeof value === "object") text(value.props?.children, output);
  return output.join(" ");
}

function harness({ read, graph, props = {} }) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const React = {
    Fragment: Symbol("Fragment"),
    createElement: element,
    useMemo(factory, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, at) => value !== previous.deps[at])) {
        slots[index] = { deps, value: factory() };
      }
      return slots[index].value;
    },
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], next => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps = []) {
      const index = cursor++;
      const previous = effects[index];
      if (!previous || deps.some((value, at) => value !== previous.deps[at])) {
        effects[index]?.cleanup?.();
        effects[index] = { deps, effect, pending: true };
      }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };
  const services = {
    observations: {
      conversationTrace: read,
      graph,
      content: vi.fn(),
    },
  };
  const ConversationTrace = createTrace({ kernel: { React, h: element }, services }).ConversationTrace;
  const draw = () => {
    cursor = 0;
    return ConversationTrace(props);
  };
  const flushEffects = () => {
    for (const item of effects) {
      if (!item?.pending) continue;
      item.pending = false;
      item.cleanup = item.effect();
    }
  };
  const renderIsolated = (component, componentProps = {}) => {
    cursor = 1000;
    return component(componentProps);
  };
  return { draw, flushEffects, renderIsolated, services, React };
}

const page = facts => ({
  conversationId: "conversation-1", queryId: "query-1", watermark: "watermark-1",
  facts, total: facts.length, offset: 0, nextCursor: null, asOf: "2026-10-22T00:00:00.000Z",
  coverage: { state: "complete", missingFields: [], reason: null },
});

describe("Conversation Trace page", () => {
  it("locates a fact, links only final messages to it, and exposes a typed Conversation relation", async () => {
    const fact = {
      factId: "tool-fact", type: "tool_invocation", conversationId: "conversation-1",
      threadId: "thread-1", runId: "run-1", turnId: "turn-1", sourceKind: "core_document",
      sourceRef: "execution-1", sourceRevision: "1", occurredAt: "2026-10-22T00:00:01.000Z",
      payload: { toolName: "read", phase: "terminal", status: "succeeded", caller: "model",
        logicalInvocationId: "logical-1", startedAt: "2026-10-22T00:00:00.000Z",
        endedAt: "2026-10-22T00:00:01.000Z", durationMs: 1000 },
      contentRefs: [], coverage: { state: "complete", missingFields: [], reason: null }, missingFields: [],
    };
    const read = vi.fn(async () => page([
      { ...fact, factId: "run-fact", type: "run", turnId: null, payload: { status: "completed", startedAt: "2026-10-22T00:00:00.000Z", endedAt: "2026-10-22T00:00:02.000Z" } },
      fact,
    ]));
    const graph = vi.fn(async () => ({
      threadId: "thread-1",
      nodes: [
        { kind: "conversation", id: "conversation-1", threadId: "thread-1", conversationId: "conversation-1", runId: null },
        { kind: "conversation", id: "conversation-0", threadId: "thread-1", conversationId: "conversation-0", runId: null },
      ],
      edges: [{ kind: "fork", fromId: "conversation-0", toId: "conversation-1", factId: "fork-fact" }],
      coverage: { state: "complete", missingFields: [], reason: null },
    }));
    const onOpenConversation = vi.fn();
    const view = harness({ read, graph, props: {
      conversationId: "conversation-1", threadId: "thread-1", targetId: "target-1",
      title: "Main", threadTitle: "Thread", messages: [
        { messageId: "user", role: "user", runId: "run-1", text: "run request" },
        { messageId: "final", role: "assistant", kind: "assistant", runId: "run-1", turnId: "turn-1", isFinal: true, text: "FINAL_ANSWER" },
        { messageId: "middle", role: "assistant", kind: "assistant", runId: "run-1", turnId: "turn-1", isFinal: false, text: "INTERMEDIATE_TEXT" },
      ],
      initialFocus: { targetId: "target-1", threadId: "thread-1", conversationId: "conversation-1", runId: "run-1", turnId: "turn-1", factId: "tool-fact" },
      onOpenConversation,
    } });

    view.draw();
    view.flushEffects();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await Promise.resolve();
    const tree = view.draw();
    view.flushEffects();
    await Promise.resolve();
    const finalTree = view.draw();
    const body = text(finalTree);
    expect(body).toContain("FINAL_ANSWER");
    expect(body).not.toContain("INTERMEDIATE_TEXT");
    expect(body).toContain("事实 tool-fact");
    expect(body).toContain("打开 Conversation conversation-0");

    const relation = allNodes(finalTree).find(node => node.type === "button" && text(node).includes("打开 Conversation conversation-0"));
    relation.props.onClick();
    expect(onOpenConversation).toHaveBeenCalledWith("conversation-0");
    expect(graph).toHaveBeenCalledWith("thread-1");
  });

  it("rejects a deep link from another target without selecting a node", async () => {
    const view = harness({
      read: async () => page([{
        factId: "run-fact", type: "run", conversationId: "conversation-1", runId: "run-1",
        turnId: null, payload: { status: "completed" }, contentRefs: [],
        coverage: { state: "complete", missingFields: [], reason: null }, missingFields: [],
      }]),
      graph: async () => null,
      props: {
        conversationId: "conversation-1", threadId: "thread-1", targetId: "target-b",
        initialFocus: { targetId: "target-a", threadId: "thread-1", conversationId: "conversation-1", runId: "run-1" },
      },
    });
    view.draw();
    view.flushEffects();
    await Promise.resolve();
    const body = text(view.draw());
    expect(body).toContain("深链身份与当前页面不一致");
    expect(body).toContain("选择 Run、Turn 或事实查看详情");
  });

  it("keeps a failed content read inside the selected fact detail", async () => {
    const contentError = new Error("detail became unavailable");
    const view = harness({
      read: async () => page([{
        factId: "attempt-fact", type: "model_attempt", conversationId: "conversation-1",
        threadId: "thread-1", runId: "run-1", turnId: "turn-1", sourceKind: "core_document",
        sourceRef: "request-1", sourceRevision: "1", occurredAt: "2026-10-22T00:00:01.000Z",
        payload: { status: "complete", providerId: "provider", modelId: "model",
          startedAt: "2026-10-22T00:00:00.000Z", endedAt: "2026-10-22T00:00:01.000Z",
          durationMs: 1000, usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costKnown: false } },
        contentRefs: [{ kind: "document", id: "request-doc", part: "input" }],
        coverage: { state: "complete", missingFields: [], reason: null }, missingFields: [],
      }]),
      graph: async () => null,
      props: {
        conversationId: "conversation-1", threadId: "thread-1", targetId: "target-1",
        initialFocus: { targetId: "target-1", threadId: "thread-1", conversationId: "conversation-1", factId: "attempt-fact" },
      },
    });
    view.services.observations.content.mockRejectedValue(contentError);
    view.draw();
    view.flushEffects();
    await vi.waitFor(() => expect(text(view.draw())).toContain("Run run-1"));
    view.flushEffects();
    await vi.waitFor(() => expect(text(view.draw())).toContain("事实 attempt-fact"));
    const selected = view.draw();
    expect(text(selected)).toContain("覆盖 完整");
    const detail = allNodes(selected).find(node => typeof node.type === "function" && node.type.name === "FactDetail");
    expect(detail).toBeTruthy();
    const factTree = detail.type(detail.props);
    const content = allNodes(factTree).find(node => typeof node.type === "function" && node.type.name === "Content");
    expect(content).toBeTruthy();
    const first = view.renderIsolated(content.type, content.props);
    const disclosure = allNodes(first).find(node => node.type === "details");
    disclosure.props.onToggle({ currentTarget: { open: true } });
    await vi.waitFor(() => expect(view.services.observations.content).toHaveBeenCalled());
    await Promise.resolve();
    const failed = text(view.renderIsolated(content.type, content.props));
    expect(failed).toContain("detail became unavailable");
    expect(text(view.draw())).toContain("attempt-fact");
  });

  it("closes a selected detail with focus restored to its opener", async () => {
    const view = harness({
      read: async () => page([{
        factId: "run-fact", type: "run", conversationId: "conversation-1", runId: "run-1",
        turnId: null, payload: { status: "completed", startedAt: "2026-10-22T00:00:00.000Z", endedAt: "2026-10-22T00:00:01.000Z" },
        contentRefs: [], coverage: { state: "complete", missingFields: [], reason: null }, missingFields: [],
      }]),
      graph: async () => null,
      props: { conversationId: "conversation-1", threadId: "thread-1", targetId: "target-1" },
    });
    view.draw();
    view.flushEffects();
    await vi.waitFor(() => expect(text(view.draw())).toContain("Run run-1"));

    const focus = vi.fn();
    const open = allNodes(view.draw()).find(node => node.type === "button" && text(node) === "Run 详情");
    open.props.onClick({ currentTarget: { focus } });
    expect(text(view.draw())).toContain("关闭详情");

    const close = allNodes(view.draw()).find(node => node.type === "button" && node.props?.["aria-label"] === "关闭 Trace 详情");
    close.props.onClick();
    expect(focus).toHaveBeenCalledOnce();
    expect(text(view.draw())).toContain("选择 Run、Turn 或事实查看详情");

    open.props.onClick({ currentTarget: { focus } });
    const aside = allNodes(view.draw()).find(node => node.type === "aside" && node.props?.["aria-label"] === "Trace 节点详情");
    aside.props.onKeyDown({ key: "Escape", preventDefault: vi.fn() });
    expect(focus).toHaveBeenCalledTimes(2);
    expect(text(view.draw())).toContain("选择 Run、Turn 或事实查看详情");
  });
});
