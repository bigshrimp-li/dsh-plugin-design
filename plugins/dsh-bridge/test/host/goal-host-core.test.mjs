import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeFixture, textOf, waitFor } from "./native-core-fixture.mjs";

const reply = (text, command) => ({ id: "native-goal-fixture", model: "native-goal-model", choices: [{ index: 0, message: { role: "assistant", content: text,
  ...(command ? { tool_calls: [{ id: "proof-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] } : {}) }, finish_reason: command ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

function fixture() {
  return nativeFixture(body => {
    const serialized = JSON.stringify(body), verify = serialized.includes("Independently verify a candidate goal completion."), evaluate = serialized.includes("You evaluate progress toward a user-authorized goal.");
    let output;
    if (verify || evaluate) {
      const input = JSON.parse(textOf(body.messages.filter(message => message.role === "user").at(-1)));
      const evidenceRefs = input.allowedEvidenceRefs;
      output = reply(JSON.stringify({ decision: verify ? "pass" : "candidate_complete", summary: "Verified native Host committed shell proof", nextStep: "", blockerKey: "", evidenceRefs, gaps: [], completedItems: ["native proof"], remainingItems: [],
        ...(verify ? { criteria: input.acceptanceCriteria.map(item => ({ criterionId: item.id, verdict: "pass", evidenceRefs })) } : {}) }));
    } else {
      const last = body.messages.filter(message => !(message.role === "user" && (textOf(message).startsWith("<runtime-goal-context>") || textOf(message).startsWith("<orchestration-context>")))).at(-1);
      output = last?.role === "tool" ? reply("NATIVE_GOAL_WORK_DONE") : reply("", serialized.includes("CANCEL_NATIVE_FIXTURE") ? "printf started > native-goal-tool-started; sleep 10; printf CANCEL_NATIVE_FIXTURE" : "printf NATIVE_COMMITTED_PROOF");
    }
    return output;
  });
}

describe.skipIf(!process.versions.electron || !process.env.SUPER_AGENT_SOURCE_ROOT)("native DSH Host → public SDK → real Go Goal", () => {
  it("creates, executes real tools, evaluates, independently verifies and preserves the original receipt", async () => {
    const f = await fixture(), payload = { requestId: "native-goal-create", conversationId: f.thread.mainConversationId, objective: "Produce committed native Host proof and verify it", acceptanceCriteria: [{ id: "proof", description: "Committed shell output contains NATIVE_COMMITTED_PROOF" }], limits: { totalTokens: 100000, maxIterations: 3, maxModelRequests: 12 } };
    const receipt = await f.bridge.call("goal.create", payload);
    expect(receipt).toMatchObject({ requestId: payload.requestId, state: "accepted", goalId: expect.any(String), receiptSeq: expect.any(Number) });
    expect(await f.bridge.call("goal.create", payload)).toEqual(receipt);
    const goal = await waitFor(() => f.bridge.call("goal.get", { goalId: receipt.goalId }), value => value.status === "completed", "goal completion");
    expect(goal.budget).toMatchObject({ settledTokens: 60, reservedTokens: 0, uncertainTokens: 0, modelRequests: 4 });
    expect(goal.checkpoint.evidenceRefs.length).toBeGreaterThan(0);
    expect(f.requests.filter(body => JSON.stringify(body).includes("You evaluate progress toward a user-authorized goal."))).toHaveLength(1);
    expect(f.requests.filter(body => JSON.stringify(body).includes("Independently verify a candidate goal completion."))).toHaveLength(1);
    expect(await f.bridge.call("goal.create", payload)).toEqual(receipt);
  });
  it("cancels an actual running Goal tool through the Host and reuses its original control receipt", async () => {
    const f = await fixture();
    const receipt = await f.bridge.call("goal.create", { requestId: "native-goal-cancel-create", conversationId: f.thread.mainConversationId, objective: "CANCEL_NATIVE_FIXTURE", limits: { totalTokens: 100000, maxIterations: 3, maxModelRequests: 12 } });
    await waitFor(async () => {
      const executions = await f.sdk.listExecutions(f.thread.threadId);
      const started = await readFile(join(f.workspaceRoot, "native-goal-tool-started"), "utf8").catch(() => "");
      return { executions, started };
    }, value => value.started === "started" && value.executions.some(item => item.toolName === "bash" && item.status === "running"), "running shell with actual start marker");
    const current = await f.bridge.call("goal.get", { goalId: receipt.goalId });
    const payload = { requestId: "native-goal-cancel", goalId: receipt.goalId, expectedRevision: current.revision, reason: "synthetic integration cancellation" };
    const cancelled = await f.bridge.call("goal.cancel", payload);
    expect(cancelled).toMatchObject({ requestId: payload.requestId, state: "accepted", goalId: receipt.goalId, receiptSeq: expect.any(Number) });
    await waitFor(() => f.bridge.call("goal.get", { goalId: receipt.goalId }), value => value.status === "cancelled", "cancelled goal");
    expect(await f.bridge.call("goal.cancel", payload)).toEqual(cancelled);
    expect(f.requests.some(body => JSON.stringify(body).includes("Independently verify a candidate goal completion."))).toBe(false);
  });
});
