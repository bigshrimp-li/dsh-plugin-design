/**
 * Routes, SSE parameters and log defaults.
 *
 * Actions on a resource use a `:verb` suffix (`POST /v1/server:shutdown`) so a
 * route never changes meaning when a sub-resource is added under it.
 */

export const API_PREFIX = "/v1";

export const ROUTES = {
  /** Version, protocol range, state, pid, home, socket and lock paths, recovery. */
  server: "/v1/server",
  /** Models currently available to create a Thread, without provider secrets. */
  models: "/v1/models",
  /** Tail of `logs/core.log`, redacted. */
  serverLogs: "/v1/server/logs",
  /** Graceful shutdown; the same sequence as SIGTERM. */
  serverShutdown: "/v1/server:shutdown",
  /** Server-Sent Events: committed events by `seq`, plus live frames. */
  events: "/v1/events",
} as const;

export type RouteName = keyof typeof ROUTES;

/** Server-Sent Events media type. */
export const SSE_CONTENT_TYPE = "text/event-stream";

/** Heartbeat comment interval; a client treats 2× this without data as a drop. */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * The two `event:` names this stream carries (design §6.2).
 *
 * Exactly one class of frame per name: `committed` data is a `CommittedEvent`,
 * `live` data is a `LiveFrame`. The Core and its clients both read the names
 * from here, so neither can drift from the other.
 */
export const SSE_EVENT_COMMITTED = "committed";
export const SSE_EVENT_LIVE = "live";

/** `GET /v1/events` query parameters (design §6.1). */
export const SSE_QUERY_AFTER = "after";
export const SSE_QUERY_THREAD_ID = "threadId";
export const SSE_QUERY_WORKSPACE_ID = "workspaceId";
export const SSE_QUERY_LIVE = "live";

/**
 * The seq a committed event carries before the event outbox exists.
 *
 * Nothing assigns seqs yet, so the process can only report `0`. Such an event
 * is never given an SSE `id:`, which is what keeps it from being mistaken for a
 * resume cursor: a client that reconnects has nothing to resume from, and the
 * stream is not resumable until the outbox lands.
 */
export const UNSEQUENCED_EVENT_SEQ = 0;

/** Default `tail` for `GET /v1/server/logs`. */
export const DEFAULT_LOG_TAIL_LINES = 200;

/** `logs/core.log` is rotated once past this size, keeping one previous file. */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/* ------------------------------------------------------------------ thread routes */

/**
 * The Thread/Conversation/Run/Workspace surface (design §5.2, §5.3, §5.7).
 *
 * Paths are templates: `{name}` is one path segment. Actions keep the `:verb`
 * suffix the service interface fixes, so `/v1/threads/{threadId}:stop` never
 * changes meaning when a sub-resource is added under `/v1/threads/{threadId}`.
 *
 * The table is ordered most-specific-first and `matchRoute` walks it in order:
 * `/v1/threads/{threadId}:stop` and `/v1/threads/{threadId}` both match the same
 * segment count, and the suffixed one has to win.
 */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export const THREADS_PATH = "/v1/threads";
export const THREAD_PATH = "/v1/threads/{threadId}";
export const THREAD_INPUTS_PATH = "/v1/threads/{threadId}/inputs";
export const THREAD_STOP_PATH = "/v1/threads/{threadId}:stop";
export const THREAD_PAUSE_PATH = "/v1/threads/{threadId}:pause";
export const THREAD_RESUME_PATH = "/v1/threads/{threadId}:resume";
export const THREAD_ARCHIVE_PATH = "/v1/threads/{threadId}:archive";
export const THREAD_WAITS_PATH = "/v1/threads/{threadId}/waits";
export const CONVERSATION_DELEGATIONS_PATH = "/v1/conversations/{conversationId}/delegations";
export const DELEGATION_PATH = "/v1/delegations/{delegationId}";
export const DELEGATION_CANCEL_PATH = "/v1/delegations/{delegationId}:cancel";
export const RUN_TASK_TREE_PATH = "/v1/observation/runs/{runId}/task-tree";
export const RUN_TASK_EXPORT_PATH = "/v1/observation/runs/{runId}/task-export";
export const CONVERSATION_PATH = "/v1/conversations/{conversationId}";
export const CONVERSATION_CONFIG_PATH = "/v1/conversations/{conversationId}/config";
export const CONVERSATION_MESSAGES_PATH = "/v1/conversations/{conversationId}/messages";
export const CONVERSATION_FORK_PATH = "/v1/conversations/{conversationId}:fork";
export const RUN_PATH = "/v1/runs/{runId}";
export const RUN_TURNS_PATH = "/v1/runs/{runId}/turns";
export const RUN_REDO_PATH = "/v1/runs/{runId}:redo";
export const RUN_FILE_DEPENDENCY_PATH = "/v1/runs/{runId}:resolve-file-dependency";
export const RUN_FILE_DEPENDENCY_REVIEW_PATH = "/v1/runs/{runId}/file-dependency";
export const WAIT_PROVIDE_FILE_PATH = "/v1/waits/{waitId}:provide-file";
export const WAIT_ANSWER_PATH = "/v1/waits/{waitId}:answer";
export const WAIT_RESOLVE_PATH = "/v1/waits/{waitId}:resolve";
export const WORKSPACES_PATH = "/v1/workspaces";
export const WORKSPACE_PATH = "/v1/workspaces/{workspaceId}";

/**
 * The `clientRef` filter on `GET /v1/threads` (design §5.7).
 *
 * Two parameters rather than one encoded blob, because the reference *is* two facts and a
 * client that sent only one of them has asked an incomplete question: the pair is what a
 * lookup is keyed by, so `client` without `sessionId` is refused rather than treated as
 * "any session of this client". They are the same names the create body's `clientRef`
 * object uses, so the two sides cannot drift about which half is which.
 */
export const THREADS_QUERY_CLIENT = "client";
export const THREADS_QUERY_SESSION_ID = "sessionId";

/** Names the matcher can return; the handler switches on these. */
export type ThreadRouteName =
  | "conversationGoals"
  | "goal"
  | "goalUpdate"
  | "goalSteer"
  | "goalPause"
  | "goalResume"
  | "goalCancel"
  | "threads"
  | "thread"
  | "threadInputs"
  | "threadStop"
  | "threadPause"
  | "threadResume"
  | "threadArchive"
  | "threadDelete"
  | "threadRestore"
  | "threadWaits"
  | "threadExecutions"
  | "executionVerify"
  | "waitRenew"
  | "conversation"
  | "conversationContext"
  | "conversationCompact"
  | "conversationConfig"
  | "conversationDiscardPending"
  | "conversationDelegations"
  | "delegation"
  | "delegationCancel"
  | "runTaskTree"
  | "runTaskExport"
  | "conversationMessages"
  | "conversationFork"
  | "run"
  | "runTurns"
  | "runRedo"
  | "runFileDependency"
  | "runFileDependencyReview"
  | "waitProvideFile"
  | "waitAnswer"
  | "waitResolve"
  | "workspaces"
  | "managedWorkspaces"
  | "managedWorkspaceOpen"
  | "workspace";

export type ThreadRouteSpec = {
  readonly name: ThreadRouteName;
  readonly method: HttpMethod;
  readonly path: string;
};

export const THREAD_ROUTES: readonly ThreadRouteSpec[] = [
  { name: "conversationGoals", method: "GET", path: "/v1/conversations/{conversationId}/goals" },
  { name: "conversationGoals", method: "POST", path: "/v1/conversations/{conversationId}/goals" },
  { name: "goalPause", method: "POST", path: "/v1/goals/{goalId}:pause" },
  { name: "goalResume", method: "POST", path: "/v1/goals/{goalId}:resume" },
  { name: "goalCancel", method: "POST", path: "/v1/goals/{goalId}:cancel" },
  { name: "goalSteer", method: "POST", path: "/v1/goals/{goalId}:steer" },
  { name: "goalUpdate", method: "PATCH", path: "/v1/goals/{goalId}" },
  { name: "goal", method: "GET", path: "/v1/goals/{goalId}" },
  { name: "conversationDelegations", method: "GET", path: CONVERSATION_DELEGATIONS_PATH },
  { name: "delegationCancel", method: "POST", path: DELEGATION_CANCEL_PATH },
  { name: "delegation", method: "GET", path: DELEGATION_PATH },
  { name: "runTaskExport", method: "GET", path: RUN_TASK_EXPORT_PATH },
  { name: "runTaskTree", method: "GET", path: RUN_TASK_TREE_PATH },
  { name: "managedWorkspaceOpen", method: "POST", path: "/v1/workspaces/managed:open" },
  { name: "managedWorkspaces", method: "GET", path: "/v1/workspaces/managed" },
  { name: "conversationContext", method: "GET", path: "/v1/conversations/{conversationId}/context" },
  { name: "conversationCompact", method: "POST", path: "/v1/conversations/{conversationId}:compact" },
  { name: "conversationDiscardPending", method: "POST", path: "/v1/conversations/{conversationId}:discard-pending" },
  { name: "threadExecutions", method: "GET", path: "/v1/threads/{threadId}/executions" },
  { name: "executionVerify", method: "POST", path: "/v1/threads/{threadId}/executions/{executionId}:verify" },
  { name: "waitRenew", method: "POST", path: "/v1/waits/{waitId}:renew" },
  { name: "threadInputs", method: "POST", path: THREAD_INPUTS_PATH },
  { name: "threadWaits", method: "GET", path: THREAD_WAITS_PATH },
  { name: "threadStop", method: "POST", path: THREAD_STOP_PATH },
  { name: "threadPause", method: "POST", path: THREAD_PAUSE_PATH },
  { name: "threadResume", method: "POST", path: THREAD_RESUME_PATH },
  { name: "threadArchive", method: "POST", path: THREAD_ARCHIVE_PATH },
  { name: "threadDelete", method: "POST", path: "/v1/threads/{threadId}:delete" },
  { name: "threadRestore", method: "POST", path: "/v1/threads/{threadId}:restore" },
  { name: "thread", method: "GET", path: THREAD_PATH },
  { name: "thread", method: "PATCH", path: THREAD_PATH },
  { name: "threads", method: "GET", path: THREADS_PATH },
  { name: "threads", method: "POST", path: THREADS_PATH },
  { name: "conversationConfig", method: "PATCH", path: CONVERSATION_CONFIG_PATH },
  { name: "conversationMessages", method: "GET", path: CONVERSATION_MESSAGES_PATH },
  { name: "conversationFork", method: "POST", path: CONVERSATION_FORK_PATH },
  { name: "conversation", method: "GET", path: CONVERSATION_PATH },
  { name: "runTurns", method: "GET", path: RUN_TURNS_PATH },
  { name: "runRedo", method: "POST", path: RUN_REDO_PATH },
  { name: "runFileDependency", method: "POST", path: RUN_FILE_DEPENDENCY_PATH },
  { name: "runFileDependencyReview", method: "GET", path: RUN_FILE_DEPENDENCY_REVIEW_PATH },
  { name: "run", method: "GET", path: RUN_PATH },
  { name: "waitProvideFile", method: "POST", path: WAIT_PROVIDE_FILE_PATH },
  { name: "waitAnswer", method: "POST", path: WAIT_ANSWER_PATH },
  { name: "waitResolve", method: "POST", path: WAIT_RESOLVE_PATH },
  { name: "workspaces", method: "GET", path: WORKSPACES_PATH },
  { name: "workspaces", method: "POST", path: WORKSPACES_PATH },
  { name: "workspace", method: "GET", path: WORKSPACE_PATH },
];

export type ThreadRouteMatch = {
  readonly name: ThreadRouteName;
  readonly params: Readonly<Record<string, string>>;
};

/**
 * Compiled matchers, built once from {@link THREAD_ROUTES}.
 *
 * A placeholder is `([^/]+)` inside its own segment, so a captured id can never
 * span a `/`. A suffixed action segment (`{threadId}:stop`) captures lazily up to
 * the literal suffix, which is what keeps `thr_1:stop` from capturing `thr_1:stop`
 * as the id.
 */
type CompiledRoute = {
  readonly spec: ThreadRouteSpec;
  readonly pattern: RegExp;
  readonly params: readonly string[];
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileRoute(spec: ThreadRouteSpec): CompiledRoute {
  const params: string[] = [];
  const segments = spec.path.split("/").map((segment) => {
    if (segment === "") return "";
    let pattern = "";
    let cursor = 0;
    const placeholder = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
    for (let match = placeholder.exec(segment); match !== null; match = placeholder.exec(segment)) {
      pattern += escapeRegExp(segment.slice(cursor, match.index));
      const name = match[1] as string;
      params.push(name);
      // Lazy so a literal suffix in the same segment (`:stop`) still matches.
      pattern += "([^/]+?)";
      cursor = match.index + match[0].length;
    }
    pattern += escapeRegExp(segment.slice(cursor));
    return pattern;
  });
  // `split("/")` already yields the leading empty segment, so joining restores the
  // leading slash; adding another one here would require `//v1/...`.
  return { spec, pattern: new RegExp(`^${segments.join("/")}$`), params };
}

const COMPILED_THREAD_ROUTES: readonly CompiledRoute[] = THREAD_ROUTES.map(compileRoute);

/** Match a request against the Thread surface; `null` when nothing matches. */
export function matchThreadRoute(method: string, pathname: string): ThreadRouteMatch | null {
  for (const route of COMPILED_THREAD_ROUTES) {
    if (route.spec.method !== method) continue;
    const matched = route.pattern.exec(pathname);
    if (matched === null) continue;
    const params: Record<string, string> = {};
    for (let index = 0; index < route.params.length; index += 1) {
      params[route.params[index] as string] = decodeURIComponent(matched[index + 1] as string);
    }
    return { name: route.spec.name, params };
  }
  return null;
}
