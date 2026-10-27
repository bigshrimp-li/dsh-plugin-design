import { describe, expect, it } from "vitest";

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: definition => loaded.push(definition) } };
await import("../../src/client/client.space-view.js");
const { createSpaceView } = loaded[0].factory();

const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
const view = createSpaceView({
  kernel: { React: { createElement }, h: createElement },
  controller: {},
  services: {},
  ctx: {},
  primitives: {},
});

describe("chat Run grouping", () => {
  it("keeps user, thinking, intermediate replies, tool calls and results in source order", () => {
    const messages = [
      { messageId: "user", role: "user", text: "task", runId: "run-1" },
      { messageId: "thinking", role: "assistant", kind: "thinking", text: "plan", runId: "run-1" },
      { messageId: "middle", role: "assistant", kind: "assistant", text: "working", runId: "run-1" },
      { messageId: "call", role: "assistant", kind: "tool_call", text: null, runId: "run-1", toolCall: { name: "read" } },
      { messageId: "result", role: "tool", kind: "tool_result", text: "contents", runId: "run-1" },
      { messageId: "final", role: "assistant", kind: "assistant", text: "answer", runId: "run-1", isFinal: true },
    ];

    const [group] = view.groupChatRuns(messages);
    expect(group.users.map(message => message.messageId)).toEqual(["user"]);
    expect(group.process.map(message => message.messageId)).toEqual(["thinking", "middle", "call", "result"]);
    expect(group.bodies.map(message => message.messageId)).toEqual(["final"]);
    expect(group.items.map(message => message.messageId)).toEqual(messages.map(message => message.messageId));
  });

  it("separates thinking fragments from a final reply and does not promote middle prose", () => {
    const messages = [
      { messageId: "user", role: "user", text: "task", runId: "run-1" },
      { messageId: "answer", role: "assistant", kind: "assistant", isFinal: true, fragments: [
        { type: "thinking", text: "consider options" },
        { type: "text", text: "final body" },
      ], runId: "run-1" },
    ];

    const [group] = view.groupChatRuns(messages);
    expect(group.process).toEqual([expect.objectContaining({
      messageId: "answer:thinking:0",
      sourceMessageId: "answer",
      kind: "thinking",
      text: "consider options",
    })]);
    expect(group.bodies).toEqual([messages[1]]);
  });

  it("keeps live text visible while a Run has other process facts", () => {
    const live = { messageId: "live", role: "assistant", kind: "assistant", text: "streaming", runId: "run-1", live: true };
    const [group] = view.groupChatRuns([
      { messageId: "call", role: "assistant", kind: "tool_call", text: null, runId: "run-1", toolCall: { name: "read" } },
    ], [live]);

    expect(group.process.map(message => message.messageId)).toEqual(["call"]);
    expect(group.bodies).toEqual([live]);
  });
});

describe("Run usage facts", () => {
  it("selects the latest revision of each attempt and never sums a requested placeholder", () => {
    const attempts = view.latestModelAttempts([
      { factId: "a-start", type: "model_attempt", attemptId: "attempt-a", sourceRevision: "1", occurredAt: "2026-10-22T00:00:00.000Z", payload: { status: "requested" } },
      { factId: "a-done", type: "model_attempt", attemptId: "attempt-a", sourceRevision: "2", occurredAt: "2026-10-22T00:00:01.000Z", payload: { status: "complete", usage: { inputTokens: 10 } } },
      { factId: "b-done", type: "model_attempt", attemptId: "attempt-b", sourceRevision: "10", occurredAt: "2026-10-22T00:00:02.000Z", payload: { status: "complete", usage: { outputTokens: 3 } } },
      { factId: "b-old", type: "model_attempt", attemptId: "attempt-b", sourceRevision: "9", occurredAt: "2026-10-22T00:00:03.000Z", payload: { status: "started" } },
    ]);

    expect(attempts.map(fact => fact.factId)).toEqual(["a-done", "b-done"]);
    expect(attempts.map(fact => fact.payload.status)).toEqual(["complete", "complete"]);
  });
});

it("leaves unproven message attribution separate instead of borrowing an adjacent Run", () => {
  const groups = view.groupChatRuns([
    { messageId: "old-user", role: "user", text: "same text" },
    { messageId: "answer", role: "assistant", kind: "assistant", isFinal: true, runId: "real-run", text: "answer" },
    { messageId: "orphan", role: "tool", kind: "tool_result", text: "orphan result" },
  ]);
  expect(groups.map(group => group.runId)).toEqual([null, "real-run", null]);
});

it("counts actual attempt usage once, keeps zero usage, and deduplicates tool retries as one step", () => {
  const metrics = view.metricsFromTrace({ coverage: { state: "complete" }, facts: [
    { type: "model_attempt", factId: "a1", attemptId: "a", sourceRevision: "1", payload: { status: "started" } },
    { type: "model_attempt", factId: "a2", attemptId: "a", sourceRevision: "2", payload: { status: "complete", durationMs: 2000, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 0 } } },
    { type: "model_attempt", factId: "b", attemptId: "b", payload: { status: "failed", durationMs: 500, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    { type: "tool_invocation", factId: "t1", executionId: "try1", payload: { logicalInvocationId: "call" } },
    { type: "tool_invocation", factId: "t2", executionId: "try2", payload: { logicalInvocationId: "call" } },
  ] });
  expect(metrics).toEqual({ tokens: 100, input: 10, output: 20, cacheRead: 70, cacheWrite: 0, modelMs: 2500, steps: 1, partial: false });
  expect(view.metricsFromTrace({ facts: [{ type: "model_attempt", factId: "unknown", payload: { status: "complete" } }] }).tokens).toBeNull();
});
