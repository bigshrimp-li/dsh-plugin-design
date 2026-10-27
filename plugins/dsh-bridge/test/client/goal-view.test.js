import { describe, expect, it } from "vitest";
const loaded = [];
globalThis.window = { __ModuleLoader__: { load: definition => loaded.push(definition) } };
await import("../../src/client/client.space-view.js");
const { createSpaceView } = loaded[0].factory();
const h = (type, props, ...children) => ({ type, props: { ...props, children } });
const { GoalCard } = createSpaceView({ kernel: { React: { createElement: h, useState: initial => [initial, () => {}] }, h }, controller: { pendingGoalOperations: () => [] }, services: {}, ctx: {}, primitives: {} });
const goal = { goalId: "goal-a", objective: "完成迁移", status: "pausing", revision: 5, iteration: 2, limits: { totalTokens: 10000 }, budget: { settledTokens: 1000, estimatedTokens: 200, reservedTokens: 2000, uncertainTokens: 500 }, checkpoint: { completedItems: ["入口已迁移"], remainingItems: ["完成回归"], nextStep: "运行测试" } };
describe("goal card", () => {
  it("shows authoritative pausing and subtracts uncertain reservation exactly once", () => {
    const rendered = JSON.stringify(GoalCard({ s: { goal } }));
    expect(rendered).toContain("正在暂停");
    expect(rendered).toContain("可用 7,000");
    expect(rendered).toContain("未确认占用 500");
    expect(rendered).toContain("含估算 200 token");
    expect(rendered).toContain("运行测试");
    expect(rendered).not.toContain('"children":["恢复目标"]');
  });
  it("shows unknown accounting instead of zero and has no controls for terminal failure", () => {
    const rendered = JSON.stringify(GoalCard({ s: { goal: { ...goal, status: "failed", budget: {} } } }));
    expect(rendered).toContain("尚未确认");
    expect(rendered).not.toContain("恢复目标");
    expect(rendered).not.toContain("取消目标");
    expect(rendered).not.toContain("提高预算");
  });
});
