import { CoreServiceError, isTrustedRequest } from "./core-service.js";

export function createObservationService({ client }) {
  return Object.fromEntries(Object.entries({
    metrics: "getObservationMetrics", tools: "getObservationTools", usage: "getObservationUsage",
    members: "listObservationMembers", health: "getObservationHealth",
    graph: "getObservationThreadGraph", trace: "getObservationRunTrace", conversationTrace: "getObservationConversationTrace",
    execution: "getObservationExecution", content: "getObservationContent",
  }).map(([name, method]) => [name, (...args) => client[method](...args)]));
}

const dimensions = ["agentDefinitionVersion", "modelBinding", "toolVersion", "skillVersion",
  "permissionMode", "runSource", "deploymentVersion"];
function common(params) {
  const scope = params.get("scope") ?? "entry_only";
  const descendants = params.get("includeDescendants") ?? "false";
  if (!["entry_only", "subagent_only", "all_runs"].includes(scope) ||
      !["true", "false"].includes(descendants)) throw new CoreServiceError("INVALID_REQUEST", "invalid observation query");
  return {
    window: { from: params.get("from"), until: params.get("until"), basis: "run_started_at" },
    scope, includeDescendants: descendants === "true",
    filters: Object.fromEntries(dimensions.map((key) => [key, params.get(key)])),
  };
}
function required(params, key) {
  const value = params.get(key);
  if (!value) throw new CoreServiceError("INVALID_REQUEST", `${key} is required`);
  return value;
}
function queryFor(kind, params) {
  for (const key of new Set(params.keys())) {
    if ((key !== "metric" && key !== "groupBy") && params.getAll(key).length > 1) {
      throw new CoreServiceError("INVALID_REQUEST", `duplicate query field: ${key}`);
    }
  }
  if (kind === "usage" && params.getAll("groupBy").length > 1) {
    throw new CoreServiceError("INVALID_REQUEST", "duplicate query field: groupBy");
  }
  if (kind === "health") return [];
  if (kind === "metrics" || kind === "tools") return [{
    ...common(params), metrics: params.getAll("metric"), groupBy: params.getAll("groupBy"),
  }];
  if (kind === "usage") return [{ ...common(params), groupBy: params.get("groupBy") ?? "model" }];
  if (kind === "members") return [{
    queryId: required(params, "queryId"), side: required(params, "side"),
    ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}),
    ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
  }];
  if (kind === "conversationTrace") return [required(params, "conversationId"), {
    ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}),
    ...(params.has("search") ? { search: params.get("search") } : {}),
    ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
  }];
  if (kind === "content") {
    try {
      const encoded = required(params, "ref");
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) throw new Error();
      const ref = JSON.parse(bytes.toString("utf8"));
      if (!ref || typeof ref !== "object" || Array.isArray(ref) ||
          Object.keys(ref).some((key) => !["kind", "id", "part"].includes(key)) ||
          !["entry", "document", "artifact"].includes(ref.kind) ||
          !["input", "output", "snapshot", "artifact"].includes(ref.part) ||
          typeof ref.id !== "string" || ref.id.length === 0) throw new Error();
      return [ref];
    } catch { throw new CoreServiceError("INVALID_REQUEST", "invalid observation content reference"); }
  }
  return [required(params, { graph: "threadId", trace: "runId", execution: "executionId" }[kind])];
}
export function registerObservationRoutes({ webServer, effect, service, log }) {
  const paths = [];
  const reply = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  for (const [suffix, kind] of Object.entries({
    metrics: "metrics", tools: "tools", usage: "usage", members: "members", health: "health",
    "thread-graph": "graph", "run-trace": "trace", "conversation-trace": "conversationTrace", execution: "execution", content: "content",
  })) {
    const path = `/super-agent/observation/${suffix}`;
    effect(() => webServer.register({ kind: "exact", path, handler: async (req, res) => {
      if (!isTrustedRequest(req)) return reply(res, 403, { error: { code: "PERMISSION_DENIED", message: "only the Harness window may read observations" } });
      if (req.method !== "GET") return reply(res, 405, { error: { code: "INVALID_REQUEST", message: "use GET" } });
      try {
        const args = queryFor(kind, new URL(req.url ?? "/", "http://localhost").searchParams);
        const resolved = typeof service === "function" ? await service() : service;
        return reply(res, 200, await resolved[kind](...args));
      } catch (error) {
        const codes = { INVALID_REQUEST: 400, INVALID_ARGUMENT: 400, NOT_FOUND: 404, PERMISSION_DENIED: 403,
          CURSOR_EXPIRED: 410, NOT_SUPPORTED: 501, SERVER_STARTING: 503, SERVER_STOPPING: 503 };
        const code = Object.hasOwn(codes, error?.code) ? error.code : "INTERNAL";
        if (code === "INTERNAL") log?.error?.("observation route failed", { code });
        return reply(res, codes[code] ?? 500, { error: {
          code, message: code === "INTERNAL" ? "observation query failed" : error.message, details: error.details ?? null,
        } });
      }
    } }));
    paths.push(path);
  }
  return paths;
}
