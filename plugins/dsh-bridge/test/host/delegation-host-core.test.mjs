import { describe, expect, it } from "vitest";
import { nativeFixture, textOf, waitFor } from "./native-core-fixture.mjs";

const capabilities = { agents: [{ id: "reviewer", revision: "1", name: "DSH_DELEGATED_REVIEWER", mission: "Return the local review result",
  systemPrompt: null, toolNames: [], skillRoots: [], usage: ["subagent"] }] };
async function fixture(mode) {
  let release, issued = false;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await nativeFixture(async body => {
    const child = body.messages.some(m => m.role === "system" && textOf(m).includes("DSH_DELEGATED_REVIEWER"));
    if (child) await gate;
    const delegate = !issued && !child;
    if (delegate) issued = true;
    return { id: "dsh-proof", choices: [{ index: 0, finish_reason: delegate ? "tool_calls" : "stop",
      message: { role: "assistant", content: child ? "review finished" : "parent finished", ...(delegate ? { tool_calls: [{ id: "hand-off", type: "function",
        function: { name: "subagent_start", arguments: JSON.stringify({ agentDefinitionRef: "reviewer@1", task: "Review the result", mode, contextMode: "task_log" }) } }] } : {}) } }] };
  }, {}, capabilities);
  const { threadId, mainConversationId: conversationId } = f.thread;
  const { runId } = await f.bridge.call("input.submit", { threadId, requestId: "delegate", text: "Delegate the review" });
  const root = { threadId, conversationId, runId };
  const page = await waitFor(() => f.bridge.call("delegation.list", root), p => p.items.length === 1, "owned delegation");
  const item = page.items[0], selection = { ...root, scope: page.scope, delegationId: item.id };
  return { ...f, root, item, selection, release };
}

describe.skipIf(!process.versions.electron || !process.env.SUPER_AGENT_SOURCE_ROOT)("DSH Host → public delegation SDK → Go", () => {
  it("cancels only a selected delegation, rejects other object scopes, and reconciles a repeated command", async () => {
    const f = await fixture("sync");
    try {
      expect((await f.sdk.getServerInfo()).runtimeFeatures.delegationsV1).toBe(true);
      expect(await f.bridge.call("delegation.get", f.selection)).toMatchObject({ id: f.item.id, mode: "sync", allowedActions: ["cancel"] });
      const other = await f.sdk.createThread({ requestId: "other", agentId: "main", modelId: "native-goal-model", permissionMode: "approve_none" });
      await expect(f.bridge.call("delegation.get", { ...f.selection, delegationId: f.root.runId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const cancel = { ...f.selection, requestId: "selected-only" };
      await expect(f.bridge.call("delegation.cancel", { ...cancel, threadId: other.threadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(f.bridge.call("delegation.cancel", { ...cancel, runId: f.item.childRunId, conversationId: f.item.childConversationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(f.bridge.call("delegation.cancel", { ...cancel, scope: "old service" })).rejects.toMatchObject({ code: "INSTANCE_CHANGED" });
      const receipt = await f.bridge.call("delegation.cancel", cancel);
      expect(receipt).toMatchObject({ state: "accepted", resourceId: f.item.id, requestId: cancel.requestId });
      const resumed = await f.reconnect();
      expect(await resumed.bridge.call("delegation.cancel", cancel)).toEqual(receipt);
      const terminal = await waitFor(() => resumed.bridge.call("delegation.get", f.selection), d => d.status === "cancelled", "child cancellation");
      expect(terminal.allowedActions).toEqual([]);
    } finally { f.release(); }
  });
  it("reads an async child's result separately from its receiving Run's processing", async () => {
    const f = await fixture("async");
    try {
      await waitFor(() => f.sdk.getRun(f.root.runId), r => r.status === "completed", "original parent completion");
      expect((await f.bridge.call("delegation.get", f.selection)).deliveryState).not.toBe("processed");
      f.release();
      const item = await waitFor(() => f.bridge.call("delegation.get", f.selection), d => d.deliveryState === "processed", "recipient processed child report");
      expect(item).toMatchObject({ id: f.item.id, status: "completed", resultRef: expect.any(String), receivedByRunId: expect.any(String), allowedActions: [] });
    } finally { f.release(); }
  });
});
