// Task IDs are locators. Core authenticates every read and command.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code });

export function createBackgroundActions({ client, attempt, requireText, optional, scopeFor, cacheHome }) {
  const handlers = { "task.scope": p => attempt(() => scopeFor(p)) };
  async function scoped(p) {
    const scope = await scopeFor(p);
    if (p.taskScope !== scope) throw fail("TASK_SCOPE_CHANGED", "服务实例或操作者已变化，请返回原入口核对原操作。");
    return scope;
  }
  const pathFor = (scope, action, p) => join(cacheHome, "task-receipts", digest([scope, p.conversationId, action, p.scheduleId || p.taskId || null, p.requestId]) + ".json");
  const fields = ["target", "prompt", "stopCondition", "intervalSec", "expiresAt", "fireImmediately", "maxModelCalls", "dailyLimit", "tools", "expectedRevision"];
  const authorization = p => digest(fields.map(key => [key, p[key] ?? null]));
  async function remember(p, action, send) {
    if (!Object.hasOwn(p, "taskScope")) return send(); // Existing SDK/Host callers use Core's receipt directly.
    const scope = await scoped(p);
    requireText(p, "conversationId");
    if (action !== "schedule.create") {
      const schedule = action.startsWith("schedule.");
      const view = await (schedule ? client.schedules : client.backgroundTasks).get(requireText(p, schedule ? "scheduleId" : "taskId"));
      if (view.conversationId !== p.conversationId) throw fail("NOT_FOUND", "该操作不属于当前对话。");
    }
    const receipt = await send();
    if (receipt?.requestId !== p.requestId || !receipt.resourceId) throw fail("RECEIPT_UNKNOWN", "Core 未返回可核对的回执。");
    const dir = join(cacheHome, "task-receipts"), path = pathFor(scope, action, p);
    await mkdir(dir, { mode: 0o700, recursive: true });
    const temp = path + "." + randomUUID();
    try {
      await writeFile(temp, JSON.stringify({ action, receipt, authorization: authorization(p) }), { mode: 0o600, flag: "wx" });
      await rename(temp, path);
    } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return receipt;
  }
  handlers["task.receipt"] = p => attempt(async () => {
    const scope = await scoped(p);
    requireText(p, "conversationId"); requireText(p, "requestId");
    let record;
    try { record = JSON.parse(await readFile(pathFor(scope, p.operation, p), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { receipt: null }; throw error; }
    if (record.action !== p.operation || record.authorization !== authorization(p)) throw fail("IDEMPOTENCY_CONFLICT", "原回执的授权内容与查询不同。");
    const group = record.action.startsWith("schedule.") ? client.schedules : client.backgroundTasks;
    const resource = await group.get(record.receipt.resourceId);
    if (resource.conversationId !== p.conversationId) throw fail("NOT_FOUND", "当前对话无法读取原回执。");
    return { receipt: record.receipt };
  });
  for (const [prefix, group] of [["task", "backgroundTasks"], ["schedule", "schedules"]]) {
    const id = prefix === "task" ? "taskId" : "scheduleId";
    handlers[prefix + ".list"] = p => attempt(() => client[group].list(requireText(p, "conversationId"), optional(p, ["kind", "status", "cursor", "limit"])));
    handlers[prefix + ".get"] = p => attempt(() => client[group].get(requireText(p, id)));
    for (const method of (prefix === "task" ? ["cancel", "detach"] : ["pause", "resume", "cancel"])) {
      const action = prefix + "." + method;
      handlers[action] = p => attempt(() => remember(p, action, () => client[group][method](requireText(p, id), {
        requestId: requireText(p, "requestId"), ...optional(p, ["expectedRevision"]),
      })));
    }
  }
  handlers["task.output"] = p => attempt(() => client.backgroundTasks.output(requireText(p, "taskId"), {
    stream: requireText(p, "stream"), ...optional(p, ["cursor", "limitBytes"]),
  }));
  handlers["schedule.create"] = p => attempt(() => remember(p, "schedule.create", () => client.schedules.create(requireText(p, "conversationId"), {
    requestId: requireText(p, "requestId"), ...optional(p, ["prompt", "stopCondition", "target", "intervalSec", "expiresAt", "fireImmediately", "maxModelCalls", "dailyLimit", "tools"]),
  })));
  return handlers;
}
