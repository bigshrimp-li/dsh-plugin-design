// Task IDs are locators. Core authenticates every read and command.
export function createBackgroundActions({ client, attempt, requireText, optional }) {
  const ids = { task: "taskId", schedule: "scheduleId" };
  const handlers = {};
  for (const [prefix, group] of [["task", "backgroundTasks"], ["schedule", "schedules"]]) {
    handlers[prefix + ".list"] = p => attempt(() => client[group].list(requireText(p, "conversationId"), optional(p, ["kind", "status", "cursor", "limit"])));
    handlers[prefix + ".get"] = p => attempt(() => client[group].get(requireText(p, ids[prefix])));
    for (const method of (prefix === "task" ? ["cancel", "detach"] : ["pause", "resume", "cancel"])) {
      handlers[prefix + "." + method] = p => attempt(() => client[group][method](requireText(p, ids[prefix]), {
        requestId: requireText(p, "requestId"), ...optional(p, ["expectedRevision"]),
      }));
    }
  }
  handlers["task.output"] = p => attempt(() => client.backgroundTasks.output(requireText(p, "taskId"), {
    stream: requireText(p, "stream"), ...optional(p, ["cursor", "limitBytes"]),
  }));
  handlers["schedule.create"] = p => attempt(() => client.schedules.create(requireText(p, "conversationId"), {
    requestId: requireText(p, "requestId"), ...optional(p, ["prompt", "stopCondition", "target", "intervalSec", "expiresAt", "fireImmediately", "maxModelCalls", "dailyLimit", "tools"]),
  }));
  return handlers;
}
