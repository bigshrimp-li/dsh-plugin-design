import { describe, expect, it, vi } from "vitest";
import { createGoalActions } from "../../src/host/goal-service.js";

function fixture({ enabled = true, methods = true } = {}) {
  const goals = Object.fromEntries(["create", "list", "get", "update", "steer", "pause", "resume", "cancel"].map(name => [name, vi.fn(async () => ({ state: "accepted" }))]));
  const client = { getServerInfo: vi.fn(async () => ({ runtimeFeatures: { goalsV1: enabled } })), ...(methods ? { goals } : {}) };
  const actions = createGoalActions({ client, attempt: work => work(), error: (code, message) => Object.assign(new Error(message), { code }) });
  return { actions, goals };
}

describe("goal SDK bridge", () => {
  it("passes frozen materials and identities through the public SDK", async () => {
    const { actions, goals } = fixture();
    const payload = { requestId: "goal-r", conversationId: "conv-a", objective: "完成迁移", limits: { totalTokens: 10000 }, preparedAttachments: [{ attachmentId: "a" }], selectedSkillRefs: [{ sourceId: "s" }], previewId: "p", previewSignature: "sig", fileBranchId: "branch", targetId: "local" };
    await actions["goal.create"](payload);
    const { conversationId, targetId: _target, ...request } = payload;
    expect(goals.create).toHaveBeenCalledWith(conversationId, request);
    for (const action of ["pause", "resume", "cancel", "steer", "update"]) {
      const fields = action === "steer" ? { text: "保留兼容" } : action === "update" ? { limits: { totalTokens: 20000 } } : { reason: "用户操作" };
      await actions[`goal.${action}`]({ goalId: "g-a", requestId: "fixed", expectedRevision: 7, ...fields });
      expect(goals[action]).toHaveBeenCalledWith("g-a", { requestId: "fixed", expectedRevision: 7, ...fields });
    }
  });
  it("rejects unavailable capability and an old SDK without submitting ordinary input", async () => {
    for (const options of [{ enabled: false }, { methods: false }]) {
      const { actions, goals } = fixture(options);
      await expect(actions["goal.create"]({ conversationId: "c", requestId: "r", objective: "x", limits: { totalTokens: 1 } })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
      expect(goals.create).not.toHaveBeenCalled();
    }
  });
  it("requires caller request identity and expected revision", async () => {
    const { actions, goals } = fixture();
    await expect(actions["goal.pause"]({ goalId: "g", expectedRevision: 1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(actions["goal.pause"]({ goalId: "g", requestId: "r" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(goals.pause).not.toHaveBeenCalled();
  });
});
