import { describe, expect, it } from "vitest";
const chunks = [];
globalThis.window = { __ModuleLoader__: { load: item => chunks.push(item) } };
await import("../../src/client/client.space-view.js");
const h = (type, props, ...children) => ({ type, props: { ...props, children } });
const requests = [];
const { ScheduleForm, BackgroundCard } = chunks[0].factory().createSpaceView({ kernel: { React: { createElement: h, useState: v => [typeof v === "function" ? v() : v, () => {}], useRef: current => ({ current }), useEffect() {} }, h }, controller: { taskRequestId: () => "create-1", createTaskSchedule: async args => { requests.push(args); if (requests.length === 1) throw Error("connection interrupted"); return { resourceId: "plan1" }; } }, services: {}, ctx: {}, primitives: {} });
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

it("sends the selected authorization and first-check timing to the durable controller", async () => {
  const form = ScheduleForm({ s: { ready: true } }).props.children[1];
  const original = globalThis.FormData;
  class Values { getAll(name) { return name === "tools" ? ["read"] : []; } get(name) { return { target: "PR #42", prompt: "Check CI", stopCondition: "CI passed", minutes: "5", hours: "24", first: "later" }[name]; } }
  try {
    globalThis.FormData = Values;
    const event = { preventDefault() {}, currentTarget: { reset() {} } };
    await form.props.onSubmit(event);
    await form.props.onSubmit(event);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ target: "PR #42", intervalSec: 300, fireImmediately: false, tools: ["read"] });
    expect(requests[0].expiresAt).toBeGreaterThan(Date.now());
  } finally { globalThis.FormData = original; }
});

it("refreshes an open schedule when its revision changes and restores only historical output positions", async () => {
  const hooks = [], effects = [];
  let at = 0, snapshot = { revision: 2, status: "active", nextAt: 10000, expiresAt: 100000, occurrences: [] };
  const React = {
    createElement: h,
    useState(initial) { const slot = at++; if (!(slot in hooks)) hooks[slot] = typeof initial === "function" ? initial() : initial;
      return [hooks[slot], value => { hooks[slot] = typeof value === "function" ? value(hooks[slot]) : value; }]; },
    useEffect(work, deps) { const slot = at++; if (!hooks[slot] || deps.some((v, i) => v !== hooks[slot].deps[i])) {
      hooks[slot]?.cleanup?.(); const hook = hooks[slot] = { deps }; effects.push(() => { hook.cleanup = work(); }); } },
  };
  const reads = [], s = { ready: true, taskScope: "scope-a", coreInstanceId: "core", targetId: "target" };
  const controller = { backgroundAction: async (task, action, fields) => {
    reads.push({ action, fields }); return action === "get" ? snapshot : { data: "bytes", nextCursor: "new-position", eof: false };
  } };
  const { BackgroundCard } = chunks[0].factory().createSpaceView({ kernel: { React, h }, controller, services: {}, ctx: {}, primitives: {} });
  const storage = new Map([['sa.task-log:["core","target","t","task"]', JSON.stringify({ stdout: { nextCursor: "out-old", text: "old-private-text" }, stderr: { nextCursor: "err-old" } })]]);
  const original = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) };
  const task = { taskId: "task", threadId: "t", conversationId: "c", kind: "schedule", status: "active", revision: 2, allowedActions: ["output"] };
  const render = () => { at = 0; const tree = BackgroundCard({ s, task }); while(effects.length) effects.shift()(); return tree; };
  const find = (tree, label) => {
    if (!tree || typeof tree !== "object") return null;
    if (tree.type === "button" && tree.props.children.includes(label)) return tree;
    for (const child of (Array.isArray(tree) ? tree : tree.props?.children || [])) { const button = find(child, label); if (button) return button; }
  };
  try {
    let tree = render();
    expect(JSON.stringify(tree)).not.toContain("old-private-text");
    find(tree, "计划详情").props.onClick(); render(); await Promise.resolve(); tree = render();
    expect(JSON.stringify(tree)).toContain("下次检查");
    snapshot = { ...snapshot, revision: 3, status: "paused" }; Object.assign(task, { revision: 3, status: "paused" });
    expect(JSON.stringify(render())).not.toContain("下次检查"); await Promise.resolve(); tree = render();
    expect(JSON.stringify(tree)).toContain("下次检查：—");
    find(tree, "续读 stdout").props.onClick(); await Promise.resolve(); tree = render();
    find(tree, "续读 stderr").props.onClick(); await Promise.resolve();
    expect(reads.filter(x => x.action === "output").map(x => x.fields)).toEqual([{ stream: "stdout", cursor: "out-old" }, { stream: "stderr", cursor: "err-old" }]);
    expect(storage.get('sa.task-log:["scope-a","c","task"]')).not.toContain("bytes");
  } finally { if (original === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = original; }
});
