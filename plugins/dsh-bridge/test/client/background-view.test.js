import { describe, expect, it } from "vitest";
const chunks = [];
globalThis.window = { __ModuleLoader__: { load: item => chunks.push(item) } };
await import("../../src/client/client.space-view.js");
const h = (type, props, ...children) => ({ type, props: { ...props, children } });
const requests = [];
const { ScheduleForm, BackgroundCard } = chunks[0].factory().createSpaceView({ kernel: { React: { createElement: h, useState: v => [typeof v === "function" ? v() : v, () => {}], useRef: current => ({ current }) }, h }, controller: { taskRequestId: () => "create-1", createTaskSchedule: async args => { requests.push(args); if (requests.length === 1) throw Error("connection interrupted"); return { resourceId: "plan1" }; } }, services: {}, ctx: {}, primitives: {} });
describe("后台任务卡", () => {
  it("shows a stop intent without claiming the process exited, and offers only granted actions", () => {
    const ui = JSON.stringify(BackgroundCard({ s: { ready: true }, task: { taskId: "bt1", conversationId: "1", kind: "shell", status: "stopping", allowedActions: ["output"] } }));
    expect(ui).toContain("正在停止");
    expect(ui).not.toContain("已取消");
    expect(ui).toContain("读取 stdout"); expect(ui).toContain("读取 stderr"); expect(ui).not.toContain("请求停止");
  });
  it("retains exit evidence and the verification entry", () => {
    const render = (status, allowedActions, exitCode) => JSON.stringify(BackgroundCard({ s: { ready: true }, task: { taskId: "bt1", conversationId: "1", kind: "shell", status, allowedActions, exitCode, executionId: "exec1" } }));
    expect(render("failed", [], 7)).toContain("退出码 7");
    expect(render("unknown", ["verify"], null)).toContain("exec1 并填写证据");
  });
});

it("retries an ambiguous schedule with its original authorization and expiry", async () => {
  const form = ScheduleForm({ s: { ready: true } }).props.children[1];
  const original = globalThis.FormData;
  class Values { getAll(name) { return name === "tools" ? ["read"] : []; } get(name) { return { target: "PR #42", prompt: "Check CI", stopCondition: "CI passed", minutes: "5", hours: "24" }[name]; } }
  try {
    globalThis.FormData = Values;
    const event = { preventDefault() {}, currentTarget: { reset() {} } };
    await form.props.onSubmit(event);
    await form.props.onSubmit(event);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({ target: "PR #42", intervalSec: 300, requestId: "create-1", tools: ["read"] });
  } finally { globalThis.FormData = original; }
});
