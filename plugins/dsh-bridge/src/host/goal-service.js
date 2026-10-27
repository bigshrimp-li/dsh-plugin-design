/** Goal commands use the public SDK and never fall back to a chat input. */
export function createGoalActions({ client, attempt, error }) {
  const required = (payload, name) => {
    if (typeof payload?.[name] !== "string" || !payload[name].trim()) throw error("INVALID_REQUEST", `${name} is required`);
    return payload[name];
  };
  const pick = (payload, names) => Object.fromEntries(names.filter(name => payload[name] !== undefined).map(name => [name, payload[name]]));
  const invoke = (method, work) => attempt(async () => {
    const info = await client.getServerInfo();
    if (info?.runtimeFeatures?.goalsV1 !== true || typeof client.goals?.[method] !== "function") {
      throw error("NOT_SUPPORTED", "当前 Core 不支持持久目标，请连接支持 goalsV1 的 Go runtime");
    }
    return work();
  });
  const control = (method, fields = []) => payload => invoke(method, () => {
    if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1) throw error("INVALID_REQUEST", "expectedRevision must be a positive safe integer");
    return client.goals[method](required(payload, "goalId"), { requestId: required(payload, "requestId"), expectedRevision: payload.expectedRevision, ...pick(payload, fields) });
  });
  return {
    "goal.create": payload => invoke("create", () => client.goals.create(required(payload, "conversationId"), {
      requestId: required(payload, "requestId"), objective: required(payload, "objective"), limits: payload.limits,
      ...pick(payload, ["acceptanceCriteria", "resumePolicy", "preparedAttachments", "selectedSkillRefs", "previewId", "previewSignature", "materials", "selectedSkillIds", "fileInput", "fileBranchId"]),
    })),
    "goal.list": payload => invoke("list", () => client.goals.list(required(payload, "conversationId"), pick(payload, ["cursor", "limit"]))),
    "goal.get": payload => invoke("get", () => client.goals.get(required(payload, "goalId"))),
    "goal.status": payload => invoke("get", () => client.goals.get(required(payload, "goalId"))),
    "goal.update": control("update", ["objective", "acceptanceCriteria", "limits"]),
    "goal.steer": control("steer", ["text"]),
    "goal.pause": control("pause", ["reason"]),
    "goal.resume": control("resume", ["reason"]),
    "goal.cancel": control("cancel", ["reason"]),
  };
}
