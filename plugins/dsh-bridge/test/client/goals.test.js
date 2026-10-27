import { describe, expect, it } from "vitest";

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: definition => loaded.push(definition) } };
await import("../../src/client/client.space.js");
const { createSpace, parseGoalCommand } = loaded[0].factory();
const response = (result, status = 200) => ({ ok: status < 400, status, json: async () => status < 400 ? { result } : { error: result } });

function fixture({ supported = true, mutate, storageFailure = false, saved: initial = {} } = {}) {
  const requests = [], values = new Map(); let counter = 0;
  let goal = { goalId: "g1", conversationId: "c1", threadId: "t1", objective: "迁移", status: "running", phase: "execute", revision: 4, iteration: 1, limits: { totalTokens: 10000 }, budget: { settledTokens: 100, reservedTokens: 500, uncertainTokens: 0 } };
  const saved = { selected: { threadId: "t1", conversationId: "c1" }, modelId: "model-a", modelSource: "conversation_override", ...initial };
  values.set("super-agent.space.v1", JSON.stringify(saved));
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes("/state")) return { ok: true, json: async () => ({ connection: "ready" }) };
    const { action, payload } = JSON.parse(init.body); requests.push({ action, payload });
    if (mutate) { const result = await mutate(action, payload, { setGoal: value => { goal = value; }, goal }); if (result !== undefined) return result; }
    if (action === "server.info") return response({ runtimeFeatures: { goalsV1: supported } });
    if (action === "models.list") return response([{ id: "model-a", selectable: true }]);
    if (action === "settings.get") return response({ configuration: { modelConfiguration: { models: [] } } });
    if (action === "goal.list") return response({ items: goal ? [goal] : [], eventSeq: 1 });
    if (action === "goal.get") return response(goal);
    if (action === "thread.get") return response({ threadId: "t1", activeRuns: [] });
    if (action === "conversation.get") return response({ conversationId: "c1", config: { modelId: "model-a" } });
    if (["messages.list", "thread.list", "waits.list"].includes(action)) return response({ items: [] });
    if (action === "executions.list") return response([]);
    if (action.startsWith("goal.")) return response({ state: "accepted", goalId: goal?.goalId || "new-goal" });
    return response({});
  };
  const kernel = { React: { createElement: () => null }, h: () => null };
  const space = createSpace({ kernel, services: { viewState: { set() {} } }, transport: { call: async () => ({}), nextRequestId: name => `${name}:${++counter}` }, ctx: { layout: { selectPanel() {} } }, Panel() {}, fetchImpl, storage: { getItem: key => values.get(key), setItem: (key, value) => { if (storageFailure) throw new Error("storage full"); values.set(key, value); } }, EventSourceImpl: null });
  return { ...space, requests, values, fetchImpl, setGoal: value => { goal = value; }, getGoal: () => goal };
}

describe("goal composer", () => {
  it("parses bounded goals, controls, quoted objectives, and literal escapes", () => {
    expect(parseGoalCommand('/goal "修复登录失败" --budget 200000')).toEqual({ kind: "goal", operation: "create", objective: "修复登录失败", limits: { totalTokens: 200000 } });
    expect(parseGoalCommand("/goal --budget 300 -- status 检查").objective).toBe("status 检查");
    expect(parseGoalCommand("/goal budget +100")).toMatchObject({ operation: "budget", increase: 100 });
    expect(parseGoalCommand("/goal resume")).toMatchObject({ operation: "resume" });
    expect(parseGoalCommand("//goal status")).toEqual({ kind: "literal", text: "/goal status" });
    expect(parseGoalCommand("请解释 /goal")).toBeNull();
    for (const text of ["/goal x", "/goal x --budget NaN", "/goal x --budget -1", "/goal x --budget 1.5", "/goal x --budget 9007199254740992", "/goal x --budget 2 --budget 3", "/goal 'x --budget 2", "/goal pause now"]) expect(() => parseGoalCommand(text)).toThrow();
  });
  it("sends goal create through its own action and never treats a slash command as model text", async () => {
    const value = fixture(); await value.controller.refresh();
    value.controller.setDraft("/goal 完成迁移 --budget 20000"); await value.controller.send();
    expect(value.requests.find(request => request.action === "goal.create")?.payload).toMatchObject({ conversationId: "c1", objective: "完成迁移", limits: { totalTokens: 20000 }, resumePolicy: "manual_after_restart" });
    expect(value.requests.some(request => request.action === "input.submit")).toBe(false);
    value.controller.dispose();
  });
  it("fails closed when goal capability is absent and retains the composer", async () => {
    const value = fixture({ supported: false }); await value.controller.refresh();
    value.controller.setDraft("/goal 迁移 --budget 1000"); expect(await value.controller.send()).toBeNull();
    expect(value.requests.some(request => ["goal.create", "input.submit"].includes(request.action))).toBe(false);
    expect(value.controller.getSnapshot().draft).toContain("/goal");
    value.controller.dispose();
  });
  it("retries the original goal id, revision, request id and budget after a lost receipt", async () => {
    let fail = true;
    const value = fixture({ mutate: (action, _payload, context) => {
      if (action === "goal.update" && fail) { fail = false; context.setGoal({ ...context.goal, revision: 5, limits: { totalTokens: 12000 } }); throw new Error("response lost"); }
    } });
    await value.controller.refresh();
    await expect(value.controller.increaseGoalBudget(2000)).rejects.toThrow("response lost");
    await value.controller.refresh(); await value.controller.increaseGoalBudget(2000);
    const calls = value.requests.filter(request => request.action === "goal.update");
    expect(calls).toHaveLength(2); expect(calls[1].payload).toEqual(calls[0].payload);
    expect(calls[1].payload).toMatchObject({ goalId: "g1", expectedRevision: 4, limits: { totalTokens: 12000 } });
    value.controller.dispose();
  });
  it("persists an uncertain command before sending and refuses to redirect it to a new goal", async () => {
    const value = fixture({ mutate: (action, _payload, context) => {
      if (action === "goal.pause") { context.setGoal({ ...context.goal, goalId: "g2", revision: 1 }); throw new Error("timeout"); }
    } });
    await value.controller.refresh(); await expect(value.controller.controlGoal("pause")).rejects.toThrow();
    const cache = JSON.parse(value.values.get("super-agent.space.v1"));
    expect(Object.values(cache.pendingGoalOperations)[0].payload).toMatchObject({ goalId: "g1", expectedRevision: 4 });
    await value.controller.refresh(); await expect(value.controller.controlGoal("pause")).rejects.toThrow("原目标命令尚未确认");
    expect(value.requests.filter(request => request.action === "goal.pause")).toHaveLength(1);
    value.controller.dispose();
  });
  it("uses explicit steer and preserves normal-message semantics", async () => {
    const value = fixture(); await value.controller.refresh();
    value.controller.setGoalInputMode("steer"); value.controller.setDraft("保留现有 API"); await value.controller.send();
    expect(value.requests.find(request => request.action === "goal.steer")?.payload).toMatchObject({ goalId: "g1", expectedRevision: 4, text: "保留现有 API" });
    value.controller.setGoalInputMode("message"); value.controller.setDraft("独立新任务"); await value.controller.send();
    expect(value.requests.find(request => request.action === "input.submit")?.payload).toMatchObject({ text: "独立新任务", delivery: "new_run" });
    value.controller.dispose();
  });
  it("does not regress a goal snapshot and ignores a duplicate committed goal event", async () => {
    const value = fixture(); await value.controller.refresh();
    value.setGoal({ ...value.getGoal(), revision: 3, status: "paused" });
    await value.controller.refresh();
    expect(value.controller.getSnapshot().goal).toMatchObject({ revision: 4, status: "running" });
    const before = value.requests.filter(request => request.action === "server.info").length;
    value.controller.receiveEvent({ type: "goal.status_changed", seq: 7 });
    value.controller.receiveEvent({ type: "goal.status_changed", seq: 7 });
    await value.controller.refresh();
    expect(value.requests.filter(request => request.action === "server.info")).toHaveLength(before + 1);
    expect(value.controller.getSnapshot().goalEventSeq).toBe(7);
    value.controller.dispose();
  });
  it("does not release an earlier uncertain command when a later retry is unsupported", async () => {
    let stage = 0;
    const value = fixture({ mutate: action => {
      if (action === "goal.pause") { stage = 1; throw new Error("lost receipt"); }
      if (action === "server.info" && stage) return response({ runtimeFeatures: { goalsV1: false } });
    } });
    await value.controller.refresh();
    await expect(value.controller.controlGoal("pause")).rejects.toThrow("lost receipt");
    const record = value.controller.pendingGoalOperations()[0];
    await expect(value.controller.retryGoalOperation(record.payload.requestId)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(value.controller.pendingGoalOperations()[0].payload).toEqual(record.payload);
    value.controller.dispose();
  });
  it("previews the objective and freezes goal attachment references across receipt retries", async () => {
    let lost = true;
    const ref = { attachmentId: "attachment-a", representationId: "representation-a" };
    const value = fixture({ saved: { attachments: [{ id: "card-a", status: "ready", ref }] }, mutate: action => {
      if (action === "attachments.capabilities") return response({ supported: true, inputPreview: true });
      if (action === "attachments.drafts.create") return response({ draftId: "draft-a" });
      if (action === "input.preview") return response({ planId: "plan-a", signature: "signature-a", canSend: true });
      if (action === "goal.create" && lost) { lost = false; throw new Error("receipt lost"); }
    } });
    await value.controller.refresh(); value.controller.setDraft("/goal 根据附件修复 --budget 20000");
    expect(await value.controller.send()).toBeNull();
    expect(value.controller.getSnapshot().attachments).toHaveLength(1);
    await value.controller.send();
    const calls = value.requests.filter(request => request.action === "goal.create");
    expect(calls).toHaveLength(2); expect(calls[1].payload).toEqual(calls[0].payload);
    expect(calls[0].payload).toMatchObject({ objective: "根据附件修复", preparedAttachments: [ref], previewId: "plan-a", previewSignature: "signature-a" });
    expect(value.requests.find(request => request.action === "input.preview")?.payload).toMatchObject({ text: "根据附件修复", delivery: "new_run" });
    value.controller.dispose();
  });
  it("blocks a goal mutation when its recovery payload cannot be saved", async () => {
    const value = fixture({ storageFailure: true }); await value.controller.refresh();
    await expect(value.controller.controlGoal("pause")).rejects.toThrow("无法保存原目标操作");
    value.controller.setDraft("/goal 修复 --budget 10000"); expect(await value.controller.send()).toBeNull();
    expect(value.requests.some(request => ["goal.create", "goal.pause"].includes(request.action))).toBe(false);
    value.controller.dispose();
  });
  it("freezes the clicked goal before an asynchronous capability check", async () => {
    let gate = false, release;
    const delayed = new Promise(resolve => { release = resolve; });
    const value = fixture({ mutate: action => {
      if (action === "server.info" && gate) { gate = false; return delayed; }
    } });
    await value.controller.refresh(); gate = true;
    const pause = value.controller.controlGoal("pause");
    value.setGoal({ ...value.getGoal(), goalId: "replacement-goal", revision: 1 });
    await value.controller.refresh();
    release(response({ runtimeFeatures: { goalsV1: true } })); await pause;
    expect(value.requests.find(request => request.action === "goal.pause")?.payload).toMatchObject({ goalId: "g1", expectedRevision: 4 });
    value.controller.dispose();
  });
});
