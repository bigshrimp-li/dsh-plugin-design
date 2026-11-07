// Opt-in acceptance against the explicitly selected desktop HTTPS Core. All writes target new named Threads.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const [origin, scenario, reportPath] = process.argv.slice(2);
if (!process.versions.electron || !origin || !["thread", "goal", "permission"].includes(scenario) || !reportPath?.startsWith("/")) {
  throw new Error("Use DSH Electron with ELECTRON_RUN_AS_NODE=1 and pass the selected HTTPS origin, thread|goal|permission and an absolute report path.");
}
const home = join(homedir(), ".super-agent");
const targets = JSON.parse(await readFile(join(home, "dsh-targets.json"), "utf8"));
const target = targets.targets.find(item => item.id === targets.selectedId);
assert.ok(target && target.baseUrl === origin && new URL(origin).protocol === "https:" && target.accessToken && target.instanceId);
const installed = join(homedir(), ".dsh/profiles/desktop/node_modules/@super-agent/dsh-bridge");
const { createCoreServiceFor } = await import(pathToFileURL(join(installed, "dist/host/core-service.js")));
const connect = () => createCoreServiceFor({ caller: "dsh-super-agent-space", options: { home, baseUrl: origin, ca: target.ca,
  accessToken: target.accessToken, actorId: target.actorId, expectedInstanceId: target.instanceId,
  localCacheHome: join(home, "targets", createHash("sha256").update(target.id + ":" + target.instanceId).digest("hex")) } });
let bridge = await connect();
const prefix = "acceptance-" + randomUUID(), id = label => prefix + "-" + label;
const title = "验收 · " + { thread: "Thread 等待与停止", goal: "Goal 暂停与取消", permission: "单次动作审批" }[scenario] + " · " + new Date().toISOString();
const report = { origin, title, steps: [], startedAt: new Date().toISOString() };
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const step = async (name, value) => { report.steps.push({ name, value }); await save(); };
const request = (action, payload = {}) => bridge.call(action, { ...payload, targetId: target.id });
const readThread = () => request("thread.get", { threadId: report.threadId });
const readGoal = () => request("goal.get", { goalId: report.goalId });
const waits = status => request("waits.list", { threadId: report.threadId, status, limit: 100 }).then(page => page.items);
const run = runId => request("run.get", { runId });
const input = (conversationId, text, label) => request("input.submit", { threadId: report.threadId, conversationId, requestId: id(label), text });
const waitFor = async (label, read, matches, timeout = 75000) => {
  const until = Date.now() + timeout;
  for (;;) { const result = await read(); if (matches(result)) return result; if (Date.now() >= until) throw new Error("Timed out: " + label); await sleep(500); }
};
const noteWait = wait => ({ waitId: wait.waitId, conversationId: wait.conversationId, runId: wait.runId, kind: wait.kind, status: wait.status });
const userWait = async (conversationId, runId) => {
  const result = await waitFor("ask_user on " + conversationId, async () => {
    const row = (await waits("waiting")).find(w => w.conversationId === conversationId && w.runId === runId);
    if (row) return row;
    const current = await run(runId);
    if (["cancelled", "failed", "completed"].includes(current.status)) throw new Error("No ask_user wait; Run ended as " + current.status);
    return null;
  }, Boolean);
  assert.equal(result.kind, "user");
  return result;
};
const prompt = key => "只做一次交互验收：必须调用 ask_user 工具，question 为“请选择验收标记 " + key + "”，选项为“继续”和“结束”。不要读取文件或运行命令，不要用文字代替该工具。得到回答后仅回复“收到”，不要再调用工具。";
const goalControl = async (action, fields, label) => {
  // The Goal can advance between a GET and a CAS. A conflict must re-read the current revision.
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = await readGoal();
    const cmd = { requestId: id(label + "-" + attempt), goalId: current.goalId, expectedRevision: current.revision, ...fields };
    try { const receipt = await request("goal." + action, cmd); assert.equal(receipt.requestId, cmd.requestId); return { cmd, receipt }; }
    catch (error) { if (!["VERSION_CONFLICT", "REVISION_CONFLICT", "GOAL_REVISION_CONFLICT"].includes(error.code)) throw error; }
  }
  throw new Error("Goal revision kept changing during " + label);
};
async function threadScenario() {
  const threadId = report.threadId, main = report.conversationId;
  const first = await input(main, prompt("A"), "main-wait");
  const a = await userWait(main, first.runId); await step("main wait", noteWait(a));
  bridge = await connect();
  assert.equal((await waits("waiting")).find(w => w.waitId === a.waitId)?.runId, first.runId);
  const history = await request("messages.list", { conversationId: main, limit: 100 });
  const entry = history.items.find(message => message.role === "user" && Number.isInteger(message.entryId));
  assert.ok(entry);
  const fork = await request("conversation.fork", { conversationId: main, sourceEntryId: entry.entryId, requestId: id("fork") });
  report.forkId = fork.conversationId;
  const forkInput = await input(fork.conversationId, prompt("B"), "fork-wait");
  const b = await userWait(fork.conversationId, forkInput.runId); await step("fork wait", noteWait(b));
  const q1 = await input(fork.conversationId, "此项只是排队验收，无需执行。", "queued-drop");
  const q2 = await input(fork.conversationId, "此项是恢复验收，暂不读取文件或使用工具。", "queued-keep");
  assert.equal(q1.state, "queued"); assert.equal(q2.state, "queued");
  const paused = await request("thread.pause", { threadId, requestId: id("pause") });
  const frozen = await readThread(); assert.equal(frozen.status, "paused_by_user");
  const queued = frozen.queuedInputIds.filter(item => item.conversationId === fork.conversationId);
  assert.equal(queued.length, 2);
  await step("pause with two queued inputs", { status: frozen.status, queue: queued, receipt: paused.state, waiting: (await waits("waiting")).map(noteWait) });
  const resumed = await request("thread.resume", { threadId, requestId: id("resume"), continueRunIds: [],
    queuedInputs: queued.map((item, idx) => ({ inputId: item.inputId, action: idx === 0 ? "drop" : "run" })), suppressedReports: [] });
  assert.equal((await readThread()).queuedInputIds.length, 1);
  await step("resume with explicit drop/run", { receipt: resumed.state, startedRunIds: resumed.startedRunIds, remaining: (await readThread()).queuedInputIds });
  const ac = { waitId: a.waitId, requestId: id("answer-main"), answer: "继续" };
  const answer = await request("wait.answer", ac);
  const after = (await waits("answered")).find(w => w.waitId === a.waitId);
  assert.equal(after?.status, "answered");
  assert.ok((await waits("waiting")).some(w => w.waitId === b.waitId));
  assert.deepEqual(await request("wait.answer", ac), answer);
  await step("answer scoped to main", { answer: noteWait(after), sibling: b.waitId, siblingStillWaiting: true, sameReceiptOnReplay: true });
  await waitFor("first short response to settle", () => run(first.runId), row => row.status === "completed");
  const last = await input(main, prompt("A2"), "main-wait2");
  const pendingA = await userWait(main, last.runId);
  const schedule = await request("schedule.create", { conversationId: fork.conversationId, requestId: id("schedule"), target: "本次专用 Thread",
    prompt: "仅检查本次验收状态。", stopCondition: "检查一次后停止。", intervalSec: 600, fireImmediately: false, expiresAt: Date.now() + 300000, maxModelCalls: 1, dailyLimit: 1, tools: [] });
  report.scheduleId = schedule.resourceId; await save();
  const stop = { threadId, requestId: id("stop"), reason: "停止此验收 Thread 的所有 Conversation 和有限期计划" };
  const stopped = await request("thread.stop", stop);
  bridge = await connect(); assert.deepEqual(await request("thread.stop", stop), stopped);
  const terminalRuns = await waitFor("all active runs to settle", async () => Promise.all([run(last.runId), run(forkInput.runId)]),
    rows => rows.every(row => ["cancelled", "failed", "completed"].includes(row.status)));
  const cancelledWaits = await waits("cancelled");
  assert.ok([pendingA.waitId, b.waitId].every(waitId => cancelledWaits.some(w => w.waitId === waitId)));
  const plan = await request("schedule.get", { scheduleId: schedule.resourceId }); assert.equal(plan.status, "cancelled");
  await step("Thread stop across Conversations", { receipt: stopped.state, threadStatus: (await readThread()).status, replaySameReceipt: true,
    runs: terminalRuns.map(r => ({ runId: r.runId, conversationId: r.conversationId, status: r.status })),
    cancelledWaits: cancelledWaits.map(noteWait), schedule: { scheduleId: plan.scheduleId, status: plan.status, occurrences: plan.occurrences?.length || 0 } });
}
async function permissionScenario() {
  const expiresAt = Date.now() + 180000;
  const cmd = await input(report.conversationId, `这是一次公开工具的授权验收。请只调用一次 schedule_create，发起目标“验收标记”的周期检查审批，prompt 为“读取本对话验收标记”，stopCondition 为“首轮回报后停止”，intervalSec 600，expiresAt ${expiresAt}，fireImmediately false，maxModelCalls 1，dailyLimit 1，tools 为空数组。授权你发起这份提案，实际授权由后续审批决定。不要改用 ask_user，不读写文件。若审批拒绝请停止并回复“已拒绝”。`, "permission");
  const approval = await waitFor("permission request", async () => {
    const item = (await waits("waiting")).find(w => w.runId === cmd.runId && w.kind === "permission");
    if (item) return item;
    const current = await run(cmd.runId);
    if (["completed", "failed", "cancelled"].includes(current.status)) throw new Error("No approval wait; Run ended as " + current.status);
    return null;
  }, Boolean);
  assert.ok(approval.expiresAt); await step("pending approval", { ...noteWait(approval), expiresAt: approval.expiresAt });
  bridge = await connect(); assert.equal((await waits("waiting")).find(w => w.waitId === approval.waitId)?.runId, cmd.runId);
  const reject = { requestId: id("deny"), waitId: approval.waitId, decision: "deny", reason: "新验收 Thread 仅验证本次拒绝，无需执行命令" };
  const ack = await request("wait.resolve", reject); assert.deepEqual(await request("wait.resolve", reject), ack);
  const resolved = (await waits("answered")).find(w => w.waitId === approval.waitId);
  assert.equal(resolved?.decision, "deny");
  assert.equal(resolved.kind, "permission");
  const executions = await request("executions.list", { threadId: report.threadId });
  await step("deny only the associated action", { ...noteWait(resolved), decision: resolved.decision, answer: resolved.answer, sameReceiptOnReplay: true,
    executions: executions.filter(e => e.runId === cmd.runId).map(e => ({ executionId: e.executionId, status: e.status })) });
  const ended = await waitFor("short post-denial response", () => run(cmd.runId), r => ["completed", "failed", "cancelled"].includes(r.status));
  const plans = await request("schedule.list", { conversationId: report.conversationId });
  assert.equal(plans.items.length, 0);
  await step("run settled", { runId: ended.runId, status: ended.status, schedulesCreated: plans.items.length });
}
async function goalScenario() {
  const initial = await request("goal.create", { conversationId: report.conversationId, requestId: id("goal"),
    objective: "只做目标控制验收；如需执行，只问一个简短问题并等待，不读写任何文件。", limits: { totalTokens: 20000, maxModelRequests: 3, maxIterations: 2, maxActiveDurationMs: 90000 } });
  report.goalId = initial.goalId; assert.ok(report.goalId); await save();
  const pause = await goalControl("pause", { reason: "验收暂时暂停" }, "pause-goal");
  const paused = await waitFor("goal paused", readGoal, g => g.status === "paused");
  await step("Goal paused", { goalId: paused.goalId, revision: paused.revision, status: paused.status, desiredState: paused.desiredState, budget: paused.budget });
  bridge = await connect(); assert.deepEqual(await request("goal.pause", pause.cmd), pause.receipt);
  await goalControl("update", { limits: { ...paused.limits, totalTokens: 20500 } }, "budget");
  await step("Goal budget increased while paused", { totalTokens: (await readGoal()).limits.totalTokens });
  await goalControl("steer", { text: "只核对验收状态，禁止额外工具或文件操作。" }, "steer");
  await step("Goal steering accepted", { status: (await readGoal()).status, revision: (await readGoal()).revision });
  await goalControl("resume", { reason: "验收显式恢复" }, "resume-goal");
  const active = await readGoal(); await step("Goal resumed", { desiredState: active.desiredState, status: active.status, revision: active.revision });
  const cancel = await goalControl("cancel", { reason: "验收完成，永久取消此新目标" }, "cancel-goal");
  const done = await waitFor("goal terminal cancel", readGoal, g => g.status === "cancelled");
  bridge = await connect(); assert.deepEqual(await request("goal.cancel", cancel.cmd), cancel.receipt);
  await step("Goal terminal", { status: done.status, desiredState: done.desiredState, revision: done.revision, budget: done.budget, replaySameReceipt: true });
}
let ok = false;
try {
  const info = await request("server.info"); assert.equal(info.state, "ready"); assert.equal(info.runtimeFeatures?.[scenario === "goal" ? "goalsV1" : "taskSchedulesV1"], true);
  const catalog = await request("models.list"); const model = (Array.isArray(catalog) ? catalog : catalog.items).find(item => item.selectable !== false);
  assert.ok(model?.id); report.modelId = model.id;
  const thread = await request("thread.create", { requestId: id("thread"), agentId: "main", modelId: model.id, permissionMode: scenario === "permission" ? "approve_all" : "approve_none" });
  report.threadId = thread.threadId; report.conversationId = thread.mainConversationId; await save();
  const own = await readThread(); await request("thread.metadata", { requestId: id("title"), threadId: thread.threadId, expectedControlRevision: own.controlRevision, title });
  if (scenario === "thread") await threadScenario();
  else if (scenario === "permission") await permissionScenario();
  else await goalScenario();
  ok = true;
} catch (error) {
  report.failure = { code: error.code || error.name, reason: error.name === "AssertionError" ? "assertion at " + String(error.stack).split("\n").find(line => line.includes("live-thread-controls.mjs"))?.trim() : String(error.message).slice(0, 200) };
} finally {
  if (report.threadId) {
    if (report.goalId) { const g = await readGoal(); if (!["completed", "cancelled", "failed"].includes(g.status)) await goalControl("cancel", { reason: "验收清理" }, "cleanup-goal"); }
    const current = await readThread(); if (!ok || (current.activeRuns?.length ?? 0) > 0) await request("thread.stop", { threadId: report.threadId, requestId: id("cleanup-stop"), reason: "清理本轮新建的验收 Thread" });
    if (report.scheduleId) report.finalScheduleStatus = (await request("schedule.get", { scheduleId: report.scheduleId })).status;
    const settled = await waitFor("cleanup of this acceptance Thread", readThread, row => !(row.activeRuns?.length), 15000);
    report.cleanup = { status: settled.status, activeRuns: settled.activeRuns, waiting: (await waits("waiting")).length };
  }
  report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ report: reportPath, title, scenario, threadId: report.threadId, steps: report.steps.map(s => s.name), failure: report.failure, cleanup: report.cleanup }));
  if (!ok) process.exitCode = 1;
}
