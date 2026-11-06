import { expect, it, vi } from "vitest";
let chunk;
globalThis.window = { __ModuleLoader__: { load: def => { chunk = def; } } };
await import("../../src/client/client.delegations.js");
const h = (type, props, ...children) => ({ type, ...props, children });
const props = { targetId: "local", threadId: "thread", conversationId: "parent", runId: "origin" };
function view(resource) {
  let cursor = 0, effect;
  const slots = [];
  const React = {
    useState(initial) { const n = cursor++; slots[n] ??= { v: initial }; return [slots[n].v, x => { slots[n].v = typeof x === "function" ? x(slots[n].v) : x; }]; },
    useRef(initial) { const n = cursor++; return slots[n] ??= { current: initial }; },
    useEffect(fn) { const n = cursor++; if (!slots[n]) { slots[n] = true; effect = fn; } },
  };
  const Component = chunk.factory().createDelegations({ kernel: { React, h }, controller: { resource } });
  const draw = () => { cursor = 0; const result = Component(props); if (effect) { const fn = effect; effect = null; fn(); } return result; };
  function button(label, node = draw()) {
    if (node?.type === "button" && node.children.includes(label)) return node;
    for (const child of node?.children || []) { if (!child || typeof child !== "object") continue; const found = button(label, child); if (found) return found; }
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const click = async label => { button(label).onClick(); await flush(); };
  return { draw, button, click, flush };
}
it("shows only confirmed controls, keeps the original command after an unknown result, and reads state after every attempt", async () => {
  const id = "del_selected", row = { id, parentRunId: "origin", agentId: "reviewer", status: "running", mode: "async", deliveryState: null };
  let current = { ...row, allowedActions: ["cancel"] }, attempts = 0;
  const resource = vi.fn(async (operation, args) => {
    if (operation === "delegation.list") return { scope: "actor-instance", items: [row], nextCursor: null };
    expect(args).toMatchObject({ ...props, delegationId: id, scope: "actor-instance" });
    if (operation === "delegation.get") return current;
    if (!attempts++) throw Error("连接已断开");
    current = { ...current, allowedActions: [] };
    return { state: "accepted", resourceId: id, requestId: args.requestId };
  });
  const v = view(resource); v.draw(); await v.flush();
  expect(v.button("取消此委派")).toBeUndefined();
  await v.click("reviewer · " + id);
  await v.click("取消此委派");
  expect(JSON.stringify(v.draw())).toContain("连接已断开");
  await v.click("取消此委派");
  const commands = resource.mock.calls.filter(([op]) => op === "delegation.cancel");
  expect(commands).toHaveLength(2); expect(commands[0][1]).toEqual(commands[1][1]);
  expect(resource.mock.calls.at(-1)[0]).toBe("delegation.get");
  expect(v.button("取消此委派")).toBeUndefined();
  expect(JSON.stringify(v.draw())).toContain("子任务：运行中");
  expect(JSON.stringify(v.draw())).not.toContain("子任务：已取消");
  current = { ...current, status: "cancelled", deliveryState: "suppressed" };
  await v.click("刷新委派状态");
  expect(JSON.stringify(v.draw())).toContain("子任务：已取消");
  expect(JSON.stringify(v.draw())).toContain("报告处理：尚无处理记录");
  current = { ...row, status: "completed", deliveryState: "processed", receivedByRunId: "follow-up", allowedActions: [] };
  await v.click("刷新委派状态");
  expect(JSON.stringify(v.draw())).toContain("已由后续任务处理，原父任务未处理此报告");
});
it("clears previously readable IDs when Core denies the detail", async () => {
  const v = view(async op => {
    if (op === "delegation.list") return { scope: "actor-instance", items: [{ id: "private", agentId: "reviewer" }] };
    throw Error("delegation unavailable");
  });
  v.draw(); await v.flush(); await v.click("reviewer · private");
  expect(JSON.stringify(v.draw())).toContain("delegation unavailable");
  expect(v.button("reviewer · private")).toBeUndefined();
  expect(v.button("取消此委派")).toBeUndefined();
});
