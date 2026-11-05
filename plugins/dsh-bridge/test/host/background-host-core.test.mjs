import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeFixture, textOf, waitFor } from "./native-core-fixture.mjs";

const enabled = { SUPERAGENT_BACKGROUND_TASKS: "1", SUPERAGENT_TASK_MONITORS: "1", SUPERAGENT_TASK_SCHEDULES: "1" };
function modelReply(text, name, args) {
  return { id: "background-proof", model: "native-goal-model", choices: [{ index: 0,
    finish_reason: name ? "tool_calls" : "stop", message: { role: "assistant", content: text,
      ...(name ? { tool_calls: [{ id: "task-proof", type: "function", function: { name, arguments: JSON.stringify(args) } }] } : {}) } }] };
}
function backgroundProvider() {
  let issued = false, subscribed = false;
  return body => {
    if (body.messages.some(message => textOf(message).includes("Perform only the authorized check in the input."))) {
      return modelReply(JSON.stringify({ outcome: "done", summary: "CI passed", evidenceRefs: ["ci/42"] }));
    }
    const prompt = textOf(body.messages.filter(message => message.role === "user").at(-1));
    if (!issued && prompt.includes("后台运行测试")) {
      issued = true;
      return modelReply("", "bash", { blockUntilMs: 0, command:
        "printf x >> launches; printf READY; while [ ! -f emit ]; do sleep 0.06; done; printf 'ERROR test failed\\n' >&2; while [ ! -f exit ]; do sleep 0.06; done; exit 7" });
    }
    const match = prompt.match(/观察 (task_[a-zA-Z0-9]+)/);
    if (!subscribed && match) {
      subscribed = true;
      return modelReply("", "monitor_start", { source: { taskId: match[1], stream: "stderr" }, filter: "ERROR", description: "测试失败日志" });
    }
    return modelReply(prompt.includes("2 加 2") ? "4" : "已收到");
  };
}
async function input(f, requestId, text) {
  const receipt = await f.bridge.call("input.submit", { threadId: f.thread.threadId, requestId, text });
  return waitFor(() => f.bridge.call("run.get", { runId: receipt.runId }), run => run.status === "completed", "Host input completion");
}
async function task(f, kind, status) {
  const page = await waitFor(() => f.bridge.call("task.list", { conversationId: f.thread.mainConversationId, kind }),
    p => p.items.length === 1 && p.items[0].status === status, "Host task list");
  return page.items[0];
}
async function replay(f, after, taskId) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
  try {
    for await (const frame of f.bridge.subscribe({ after, threadId: f.thread.threadId, signal: abort.signal })) {
      if (frame.kind === "committed" && frame.event.type === "background_task.finished" && frame.event.payload.taskId === taskId) return frame.event;
    }
  } finally { clearTimeout(timer); abort.abort(); }
  throw new Error("No terminal event on reconnect");
}

describe.skipIf(!process.versions.electron || !process.env.SUPER_AGENT_SOURCE_ROOT)("native DSH Host → SDK → Go background tasks", () => {
  it("keeps the Shell, monitor and its byte and event cursors across Host reconnect", async () => {
    const f = await nativeFixture(backgroundProvider(), enabled);
    const conversationId = f.thread.mainConversationId;
    expect((await f.sdk.getServerInfo()).runtimeFeatures).toMatchObject({ backgroundTasksV1: true, taskMonitorsV1: true, taskSchedulesV1: true });
    const origin = await input(f, "launch", "后台运行测试，失败后告诉我");
    const shell = await task(f, "shell", "running");
    expect(shell).toMatchObject({ originRunId: origin.runId, conversationId });
    const checkpoint = (await f.bridge.call("task.list", { conversationId })).asOfSeq;
    const prefix = await waitFor(() => f.bridge.call("task.output", { taskId: shell.taskId, stream: "stdout", limitBytes: 2 }),
      page => page.data === "RE", "live stdout");
    expect(prefix.eof).toBe(false);
    expect((await input(f, "math", "2 加 2 等于几")).answer).toBe("4");
    await input(f, "watch", "观察 " + shell.taskId);
    const monitor = await task(f, "monitor", "running");
    await writeFile(join(f.workspaceRoot, "emit"), "");
    await waitFor(() => f.bridge.call("task.get", { taskId: monitor.taskId }), v => v.status === "running" && v.monitor.matches === 1, "live monitor");
    await waitFor(() => f.sdk.listMessages(conversationId), v => v.items.some(m => m.source === "background_task" && m.text?.includes("monitor_batch")), "monitor delivery");

    const resumed = { ...f, ...await f.reconnect() };
    expect(await resumed.bridge.call("task.output", { taskId: shell.taskId, stream: "stdout", cursor: prefix.nextCursor })).toMatchObject({ data: "ADY", eof: false });
    const cancelled = await resumed.bridge.call("task.cancel", { taskId: monitor.taskId, requestId: "stop-watching" });
    expect(cancelled.state).toBe("accepted");
    await waitFor(() => resumed.bridge.call("task.get", { taskId: monitor.taskId }), v => v.status === "cancelled", "stop watcher");
    await writeFile(join(f.workspaceRoot, "exit"), "");
    const terminal = await waitFor(() => resumed.bridge.call("task.get", { taskId: shell.taskId }),
      v => v.status === "failed" && v.deliveryState === "processed", "original Conversation receives failure");
    expect(terminal).toMatchObject({ taskId: shell.taskId, originRunId: origin.runId, conversationId, exitCode: 7 });
    expect(await resumed.bridge.call("task.output", { taskId: shell.taskId, stream: "stderr" })).toMatchObject({ data: "ERROR test failed\n", eof: true });
    expect((await replay(resumed, checkpoint, shell.taskId)).seq).toBeGreaterThan(checkpoint);
    expect(await readFile(join(f.workspaceRoot, "launches"), "utf8")).toBe("x");
  });
  it("creates, follows and controls an authorized schedule through Host actions", async () => {
    const f = await nativeFixture(backgroundProvider(), enabled), conversationId = f.thread.mainConversationId;
    await input(f, "origin", "检查 PR #42 的 CI");
    const request = { conversationId, requestId: "schedule", target: "PR #42", prompt: "Read CI status", stopCondition: "CI completed",
      intervalSec: 300, expiresAt: Date.now() + 600000, maxModelCalls: 1, dailyLimit: 2 };
    const receipt = await f.bridge.call("schedule.create", request);
    expect(await f.bridge.call("schedule.create", request)).toEqual(receipt);
    const done = await waitFor(() => f.bridge.call("schedule.get", { scheduleId: receipt.resourceId }), p => p.status === "done", "check report");
    expect(done).toMatchObject({ target: "PR #42", lastResult: { outcome: "done", evidenceRefs: ["ci/42"] } });
    expect(done.occurrences).toHaveLength(1);
    expect(done.occurrences[0].conversationId).not.toBe(conversationId);
    expect((await f.bridge.call("run.get", { runId: done.occurrences[0].runId })).status).toBe("completed");
    const plan = await f.bridge.call("schedule.create", { ...request, requestId: "later", fireImmediately: false });
    for (const [method, status] of [["pause", "paused"], ["resume", "active"], ["cancel", "cancelled"]]) {
      await f.bridge.call("schedule." + method, { scheduleId: plan.resourceId, requestId: method });
      expect((await f.bridge.call("schedule.get", { scheduleId: plan.resourceId })).status).toBe(status);
    }
    expect((await f.bridge.call("schedule.list", { conversationId })).items.map(p => p.scheduleId).sort()).toEqual([plan.resourceId, receipt.resourceId].sort());
  });
});
