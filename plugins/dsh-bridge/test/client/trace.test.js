import { describe, expect, it } from "vitest";
const loaded = [];
globalThis.window = { __ModuleLoader__: { load: definition => loaded.push(definition) } };
await import("../../src/client/client.trace.js");
const {
  createTraceController, groupConversationFacts, contentSearchHit,
  coverageText, buildTraceExport,
} = loaded[0].factory();
const fact = (factId, extra = {}) => ({ factId, conversationId: "c1", type: "model_attempt", ...extra });
const page = (queryId, facts, nextCursor = null, extra = {}) => ({ conversationId: "c1", queryId, watermark: queryId, facts, total: 3, offset: 0, nextCursor, ...extra });

describe("conversation trace watermarks", () => {
  it("deduplicates page identities and atomically replaces updated revisions on refresh", async () => {
    let revision = 1;
    const controller = createTraceController({ conversationId: "c1", pageSize: 2, read: async (_id, query) => {
      if (query.cursor) return page("q1", [fact("b"), fact("c")]);
      return revision === 1 ? page("q1", [fact("a"), fact("b")], "next") : page("q2", [fact("a", { sourceRevision: "2" }), fact("b"), fact("c")]);
    } });
    await controller.refresh(); await controller.more();
    expect(controller.getState().facts.map(f => f.factId)).toEqual(["a", "b", "c"]);
    revision = 2; await controller.refresh();
    expect(controller.getState().watermark).toBe("q2");
    expect(controller.getState().facts[0].sourceRevision).toBe("2");
    controller.dispose();
  });
  it("keeps a healthy page after a failed or mismatched continuation and can recover", async () => {
    let broken = true;
    const controller = createTraceController({ conversationId: "c1", pageSize: 1, read: async (_id, query) => query.cursor ? page("other-query", [fact("x")]) : broken ? page("q1", [fact("a")], "next") : page("q2", [fact("b")]) });
    await controller.refresh(); await controller.more();
    expect(controller.getState().facts.map(f => f.factId)).toEqual(["a"]);
    expect(controller.getState().error).toContain("水位");
    broken = false; await controller.refresh();
    expect(controller.getState().facts.map(f => f.factId)).toEqual(["b"]);
    expect(controller.getState().error).toBe("");
  });
  it("does not apply a late result after unmount or target switch", async () => {
    let resolve;
    const controller = createTraceController({ conversationId: "c1", read: () => new Promise(done => { resolve = done; }) });
    const work = controller.refresh(); controller.dispose(); resolve(page("q1", [fact("late")])); await work;
    expect(controller.getState().facts).toEqual([]);
  });
  it("keeps the last successful facts when refresh fails", async () => {
    let fail = false;
    const controller = createTraceController({ conversationId: "c1", read: async () => {
      if (fail) throw new Error("index temporarily unavailable");
      return page("q1", [fact("a")]);
    } });
    await controller.refresh();
    const successfulAt = controller.getState().lastSuccessAt;
    fail = true;
    await controller.refresh();
    expect(controller.getState()).toMatchObject({ error: "index temporarily unavailable", loaded: true });
    expect(controller.getState().facts.map(item => item.factId)).toEqual(["a"]);
    expect(controller.getState().lastSuccessAt).toBe(successfulAt);
    controller.dispose();
  });
  it("follows a deeper cursor when locating a focused Turn and falls back by identity", async () => {
    const controller = createTraceController({ conversationId: "c1", pageSize: 1, read: async (_id, query) => {
      if (query.cursor) return page("q1", [fact("target", { runId: "run-2", turnId: "turn-2" })]);
      return page("q1", [fact("run", { runId: "run-1" })], "next");
    } });
    await controller.refresh();
    const found = await controller.locate({ factId: "missing-fact", turnId: "turn-2", runId: "run-2" });
    expect(found).toMatchObject({ level: "turn", factId: "target", runId: "run-2", turnId: "turn-2", exhausted: true });
    expect(controller.getState().facts.map(item => item.factId)).toEqual(["run", "target"]);
    controller.dispose();
  });
  it("does not apply a locate page after disposal", async () => {
    let resolve;
    const controller = createTraceController({ conversationId: "c1", pageSize: 1, read: async (_id, query) => query.cursor
      ? new Promise(done => { resolve = done; })
      : page("q1", [fact("first", { runId: "run-1" })], "next") });
    await controller.refresh();
    const locating = controller.locate({ runId: "run-late" });
    controller.dispose();
    resolve(page("q1", [fact("late", { runId: "run-late" })]));
    expect(await locating).toEqual({ level: null, exhausted: false });
    expect(controller.getState().facts.map(item => item.factId)).toEqual(["first"]);
  });
});

describe("conversation trace hierarchy", () => {
  it("groups Run-level facts before their Turns without changing fact order", () => {
    const grouped = groupConversationFacts([
      fact("run-fact", { runId: "run-1", turnId: null }),
      fact("turn-a", { runId: "run-1", turnId: "turn-1" }),
      fact("turn-b", { runId: "run-1", turnId: "turn-2" }),
      fact("orphan"),
    ]);
    expect(grouped.map(run => run.runId)).toEqual(["run-1", null]);
    expect(grouped[0].facts.map(item => item.factId)).toEqual(["run-fact", "turn-a", "turn-b"]);
    expect([...grouped[0].turns.keys()]).toEqual(["turn-1", "turn-2"]);
    expect(grouped[1].facts.map(item => item.factId)).toEqual(["orphan"]);
  });
});

describe("conversation trace presentation helpers", () => {
  it("distinguishes a metadata search from a content-only hit and formats coverage", () => {
    const row = fact("a", { payload: { toolName: "read", status: "succeeded" } });
    expect(contentSearchHit(row, "read")).toBe(false);
    expect(contentSearchHit(row, "bytes only in content")).toBe(true);
    expect(coverageText({ state: "partial", missingFields: ["model_attempt", "result"], reason: "source_lag" }))
      .toBe("部分 · 缺少 model_attempt、result · source_lag");
  });
  it("exports only current Conversation facts, final messages and successfully read content", () => {
    const state = {
      facts: [
        fact("a", { runId: "run-1" }),
        { ...fact("foreign"), conversationId: "c2" },
      ],
      search: "needle", queryId: "q1", watermark: "w1", asOf: "2026-10-22T00:00:00.000Z",
      coverage: { state: "complete", missingFields: [], reason: null }, total: 2,
    };
    const result = buildTraceExport({
      conversationId: "c1", threadId: "t1", targetId: "target-1", state,
      messages: [
        { messageId: "final", runId: "run-1", isFinal: true, text: "answer" },
        { messageId: "middle", runId: "run-1", isFinal: false, text: "middle" },
        { messageId: "foreign", runId: "run-2", isFinal: true, text: "other" },
      ],
      filters: { runId: "run-1" },
      loadedContent: [
        { ref: { kind: "document", id: "d1", part: "output" }, result: { status: "available", content: "readable" } },
        { ref: { kind: "document", id: "d2", part: "output" }, result: { status: "forbidden", content: null } },
      ],
    });
    expect(result.facts.map(item => item.factId)).toEqual(["a"]);
    expect(result.finalMessages.map(item => item.messageId)).toEqual(["final"]);
    expect(result.query).toMatchObject({ search: "needle", queryId: "q1", watermark: "w1", filters: { runId: "run-1" } });
    expect(result.loadedContent).toHaveLength(1);
  });
});
