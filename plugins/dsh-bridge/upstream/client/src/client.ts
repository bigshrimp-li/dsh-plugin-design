/**
 * The Core client.
 *
 * A thin, typed facade over the Core's UDS service: read-only calls
 * (`getServerInfo`, `getServerLogs`), one state-changing command (`shutdown`),
 * and the resumable event subscription. Every request carries the protocol
 * version and the caller identity; a state-changing call additionally carries
 * an `X-Request-Id`, which the client refuses to invent — a missing one is a
 * local error, before any request is sent.
 */
import {
  HEADER_CALLER,
  HEADER_PROTOCOL_VERSION,
  HEADER_REQUEST_ID,
  PROTOCOL_VERSION,
  ROUTES,
  SSE_HEARTBEAT_INTERVAL_MS,
  THREADS_PATH,
  THREADS_QUERY_CLIENT,
  THREADS_QUERY_SESSION_ID,
  httpStatusForError,
  type AnswerWaitRequest,
  type ClientRef,
  type CommandReceipt,
  type ConversationView,
  type UpdateConversationConfigRequest,
  type UpdateConversationConfigResult,
  type CreateThreadRequest,
  type CreateThreadResult,
  type ForkConversationRequest,
  type ForkConversationResult,
  type InputReceipt,
  type MessagePage,
  type MessageQuery,
  type ModelCatalogEntry,
  type Page,
  type RedoRunRequest,
  type RedoRunResult,
  type RegisterWorkspaceRequest,
  type ResolvePermissionRequest,
  type ResumeThreadRequest,
  type ResumeThreadResult,
  type RunView,
  type StopThreadRequest,
  type ServerInfo,
  type ServerLogsView,
  type ShutdownAccepted,
  type SubmitInputRequest,
  type SubscriptionEvent,
  type ThreadControlRequest,
  type ThreadStatus,
  type ThreadSummary,
  type ThreadView,
  type TurnView,
  type WaitStatus,
  type WaitView,
  type WorkspaceLookupResult,
  type WorkspaceView,
} from "@super-agent/protocol";

import { createSkillSourceClient, type SkillSourceClient } from "./skill-sources.js";
import { createAttachmentClient, type AttachmentClient } from "./attachments.js";
import { createSkillInstallationClient, type SkillInstallationClient } from "./skill-installations.js";
import { createWorkspaceFileClient, type WorkspaceFileClient } from "./workspace-files.js";
import { createManagedWorkspaceClient, type ManagedWorkspaceClient } from "./managed-workspaces.js";
import { createGoalClient, type GoalClient } from "./goals.js";

import { CoreClientError, clientErrorFromEnvelope, parseErrorEnvelope } from "./errors.js";
import { createSubscription, type SubscriptionOptions } from "./subscription.js";
import { malformedResponse, sendRequest, type HttpResponse, type ConnectionOptions } from "./transport.js";
import type {
  ObservationContentRef, ObservationContentResult, ObservationExecution, ObservationHealth,
  ObservationMetricMembersPage, ObservationMetricMembersRequest, ObservationMetricsResponse,
  ObservationQuery, ObservationRunTrace, ObservationThreadGraph, ObservationToolsResponse,
  ObservationConversationTracePage, ObservationConversationTraceQuery,
  ObservationUsageQuery, ObservationUsageResponse,
} from "@super-agent/protocol";

/** The request timeout for a single call, unless overridden. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type ClientOptions = ConnectionOptions & {
  /** Caller identity sent as `X-Caller`; must be non-empty. */
  readonly caller: string;
  /** Heartbeat interval the Core uses; 2× this without data means a drop. */
  readonly heartbeatIntervalMs?: number;
  /** Per-call request timeout. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
};

export type GetServerLogsOptions = {
  /** How many trailing lines to return; the Core applies its own default. */
  readonly tail?: number;
};

/** One page of a listing: how many to ask for, and where to resume. */
export type PageOptions = {
  readonly limit?: number;
  readonly cursor?: string;
};

export type ListThreadsOptions = PageOptions & {
  readonly deleted?: "exclude" | "only" | "include";
  readonly status?: ThreadStatus;
  /**
   * Return only the Threads created for this caller reference (design §5.7).
   *
   * The reference is a lookup key, not a rule: it narrows the listing to the Threads that
   * recorded it, and a Thread that recorded none is not one of them.
   */
  readonly clientRef?: ClientRef;
};

export type ListWaitsOptions = PageOptions & {
  readonly status?: WaitStatus;
};

export interface CoreClient {
  readonly goals: GoalClient;
  readonly attachments: AttachmentClient;
  readonly skillInstallations: SkillInstallationClient;
  readonly managedWorkspaces: ManagedWorkspaceClient;
  readonly files: WorkspaceFileClient;
  readonly skills: SkillSourceClient;
  getObservationMetrics(query: ObservationQuery): Promise<ObservationMetricsResponse>;
  getObservationTools(query: ObservationQuery): Promise<ObservationToolsResponse>;
  getObservationUsage(query: ObservationUsageQuery): Promise<ObservationUsageResponse>;
  listObservationMembers(request: ObservationMetricMembersRequest): Promise<ObservationMetricMembersPage>;
  getObservationHealth(): Promise<ObservationHealth>;
  getObservationThreadGraph(threadId: string): Promise<ObservationThreadGraph>;
  getObservationRunTrace(runId: string): Promise<ObservationRunTrace>;
  getObservationConversationTrace(conversationId: string, query?: ObservationConversationTraceQuery): Promise<ObservationConversationTracePage>;
  getObservationExecution(executionId: string): Promise<ObservationExecution>;
  getObservationContent(ref: ObservationContentRef): Promise<ObservationContentResult>;
  readonly socketPath: string;
  readonly caller: string;
  getServerInfo(): Promise<ServerInfo>;
  getServerLogs(options?: GetServerLogsOptions): Promise<ServerLogsView>;
  /** Models the connected Core can select for a new Thread. */
  listModels(): Promise<readonly ModelCatalogEntry[]>;
  /** A non-empty `requestId` is required; a missing one fails locally. */
  shutdown(requestId?: string): Promise<ShutdownAccepted>;
  subscribe(options?: SubscriptionOptions): AsyncIterable<SubscriptionEvent>;

  /* ---- the Thread surface (design §5.2, §5.3) ---- */

  /** Create a Thread. The `requestId` is both the idempotency key and the body's id. */
  createThread(request: CreateThreadRequest): Promise<CreateThreadResult>;
  listThreads(options?: ListThreadsOptions): Promise<Page<ThreadSummary>>;
  getThread(threadId: string): Promise<ThreadView>;

  /**
   * Submit input to a Thread.
   *
   * The receipt says the input was *accepted*, never that the Run it started has finished:
   * a caller that wants the answer subscribes to the events and reads the messages.
   */
  submitInput(threadId: string, request: SubmitInputRequest): Promise<InputReceipt>;

  updateThreadMetadata(threadId: string, request: import("@super-agent/protocol").UpdateThreadMetadataRequest): Promise<CommandReceipt>;
  /** Irreversible application deletion; refuses unsettled work and releases recovery protection immediately. */
  deleteThread(threadId: string, request: import("@super-agent/protocol").ThreadDeletionRequest): Promise<CommandReceipt>;
  /** Compatibility for legacy records only; newly deleted Threads return RECOVERY_EXPIRED. */
  restoreThread(threadId: string, request: import("@super-agent/protocol").ThreadDeletionRequest): Promise<CommandReceipt>;
  getConversation(conversationId: string): Promise<ConversationView>;
  getConversationContext(conversationId: string): Promise<import("@super-agent/protocol").ConversationContextView>;
  compactConversation(conversationId: string, request: import("@super-agent/protocol").CompactConversationRequest): Promise<CommandReceipt>;
  updateConversationConfig(conversationId: string, request: UpdateConversationConfigRequest): Promise<UpdateConversationConfigResult>;
  /**
   * One page of a Conversation's messages, with what the projection knows about the rest.
   *
   * The page is carried through as the Core wrote it: the messages and their identities,
   * and the `watermark` and `caughtUp` that say how far the projection has read. The SDK
   * infers neither — an empty page is not "this Conversation has no history", and
   * `caughtUp: false` is not "there is no earlier history", so a caller that replaced
   * them with its own reading would be stating a completeness the Core never stated.
   */
  listMessages(conversationId: string, options?: MessageQuery): Promise<MessagePage>;

  getRun(runId: string): Promise<RunView>;
  listTurns(runId: string, options?: PageOptions): Promise<Page<TurnView>>;

  /* ---- control, waits, redo and fork (design §5.4, §5.5) ---- */

  /** Stop a Thread: revoke the work in flight and freeze what has not started. */
  stopThread(threadId: string, request: StopThreadRequest): Promise<CommandReceipt>;
  pauseThread(threadId: string, request: ThreadControlRequest): Promise<CommandReceipt>;
  /**
   * Resume a Thread, with the caller's decisions about the work a stop left behind.
   *
   * Every list is optional and every item it does not name keeps its state: a resume is an
   * instruction, not an inference. The answer names the Runs it started.
   */
  resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResult>;
  archiveThread(threadId: string, request: ThreadControlRequest): Promise<CommandReceipt>;

  /** The waits a Thread is holding. Only pending ones can be listed. */
  listWaits(threadId: string, options?: ListWaitsOptions): Promise<Page<WaitView>>;
  answerWait(waitId: string, request: AnswerWaitRequest): Promise<CommandReceipt>;
  resolvePermission(waitId: string, request: ResolvePermissionRequest): Promise<CommandReceipt>;
  provideRequiredFile(waitId: string, request: import("@super-agent/protocol").ProvideRequiredFileRequest): Promise<import("@super-agent/protocol").ProvideRequiredFileResult>;
  listExecutions(threadId: string): Promise<readonly import("@super-agent/protocol").ExecutionView[]>;
  verifyExecution(threadId: string, executionId: string, request: import("@super-agent/protocol").VerifyExecutionRequest): Promise<CommandReceipt>;
  renewApproval(waitId: string, request: { requestId: string }): Promise<CommandReceipt>;
  discardPendingConfig(conversationId: string, request: { requestId: string; expectedConfigRevision: string }): Promise<UpdateConversationConfigResult>;

  /** Re-run a Run. `mode: "fork"` copies history first and runs in the copy. */
  redoRun(runId: string, request: RedoRunRequest): Promise<RedoRunResult>;
  /** Copy a Conversation's history up to one entry into a new Conversation. */
  forkConversation(
    conversationId: string,
    request: ForkConversationRequest,
  ): Promise<ForkConversationResult>;

  /** The Workspace whose main root is `root`, or `null` when this home has none. */
  findWorkspace(root: string): Promise<WorkspaceView | null>;
  /** Register `root` as a Workspace; an already-known root returns the existing one. */
  registerWorkspace(request: RegisterWorkspaceRequest): Promise<WorkspaceView>;
}

export function createClient(options: ClientOptions): CoreClient {
  return new Client(options);
}

class Client implements CoreClient {
  readonly goals: GoalClient;
  readonly attachments: AttachmentClient;
  readonly skillInstallations: SkillInstallationClient;
  readonly managedWorkspaces: ManagedWorkspaceClient;
  readonly files: WorkspaceFileClient;
  readonly skills: SkillSourceClient;
  readonly socketPath: string;
  readonly caller: string;

  readonly #connection: ConnectionOptions;
  readonly #heartbeatIntervalMs: number | undefined;
  readonly #requestTimeoutMs: number;

  constructor(options: ClientOptions) {
    if ((!options.socketPath && !options.baseUrl) || (options.socketPath && options.baseUrl)) {
      throw new CoreClientError({
        code: "INVALID_REQUEST",
        message: "socketPath is required to create a client",
        httpStatus: httpStatusForError("INVALID_REQUEST"),
      });
    }
    if (typeof options.caller !== "string" || options.caller.trim() === "") {
      throw new CoreClientError({
        code: "INVALID_REQUEST",
        message: "caller is required to create a client",
        httpStatus: httpStatusForError("INVALID_REQUEST"),
      });
    }
    this.socketPath = options.socketPath ?? "";
    this.#connection = { ...options };
    this.caller = options.caller;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.goals = createGoalClient((method, path, body) => method === "GET"
      ? this.#query(path) : this.#command({ method, path, requestId: String(body?.["requestId"] ?? ""), body: body ?? {} }));
    this.attachments = createAttachmentClient((method, path, body) => method === "GET"
      ? this.#query(path) : this.#command({ method, path, requestId: String(body?.["requestId"] ?? ""), body: body ?? {} }));
    this.skillInstallations = createSkillInstallationClient((method, path, body) => method === "GET"
      ? this.#query(path) : this.#command({ method, path, requestId: String(body?.["requestId"] ?? ""), body: body ?? {} }));
    this.skills = createSkillSourceClient((method, path, body) => method === "GET"
      ? this.#query(path) : this.#command({ method, path, requestId: String(body?.["requestId"] ?? ""), body: body ?? {} }));
    this.files = createWorkspaceFileClient((method, path, body) => method === "GET"
      ? this.#query(path) : this.#command({ method, path, requestId: String(body?.["requestId"] ?? ""), body: body ?? {} }));
    this.managedWorkspaces = createManagedWorkspaceClient((method, path, body) => method === "GET"
      ? this.#query(path) : this.#command({ method, path, requestId: String(body?.["requestId"] ?? ""), body: body ?? {} }));
  }

  async getServerInfo(): Promise<ServerInfo> {
    const response = await sendRequest({
      ...this.#connection,
      method: "GET",
      path: ROUTES.server,
      headers: this.#headers(),
      timeoutMs: this.#requestTimeoutMs,
    });
    return this.#readJson<ServerInfo>(response);
  }

  async getServerLogs(options: GetServerLogsOptions = {}): Promise<ServerLogsView> {
    const path = options.tail === undefined ? ROUTES.serverLogs : `${ROUTES.serverLogs}?tail=${String(options.tail)}`;
    const response = await sendRequest({
      ...this.#connection,
      method: "GET",
      path,
      headers: this.#headers(),
      timeoutMs: this.#requestTimeoutMs,
    });
    return this.#readJson<ServerLogsView>(response);
  }

  async listModels(): Promise<readonly ModelCatalogEntry[]> {
    const response = await sendRequest({
      ...this.#connection,
      method: "GET",
      path: ROUTES.models,
      headers: this.#headers(),
      timeoutMs: this.#requestTimeoutMs,
    });
    const catalog = this.#readJson<{ readonly items: readonly ModelCatalogEntry[] }>(response);
    if (!Array.isArray(catalog.items)) throw malformedResponse(response.status, "the model catalog was not a list");
    return catalog.items;
  }

  async shutdown(requestId?: string): Promise<ShutdownAccepted> {
    const id = requireRequestId(requestId);
    const response = await sendRequest({
      ...this.#connection,
      method: "POST",
      path: ROUTES.serverShutdown,
      headers: this.#headers({ [HEADER_REQUEST_ID]: id }),
      timeoutMs: this.#requestTimeoutMs,
    });
    return this.#readJson<ShutdownAccepted>(response);
  }

  subscribe(options: SubscriptionOptions = {}): AsyncIterable<SubscriptionEvent> {
    return createSubscription(
      {
        ...this.#connection,
        caller: this.caller,
        heartbeatIntervalMs: this.#heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS,
      },
      options,
    );
  }

  /* ---------------------------------------------------------------- threads */

  async createThread(request: CreateThreadRequest): Promise<CreateThreadResult> {
    return this.#command<CreateThreadResult>({
      method: "POST",
      path: THREADS_PATH,
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  async listThreads(options: ListThreadsOptions = {}): Promise<Page<ThreadSummary>> {
    const query = pageQuery(options);
    if (options.status !== undefined) query.set("status", options.status);
    if (options.deleted !== undefined) query.set("deleted", options.deleted);
    // Both halves travel together; the Core refuses one without the other rather than
    // widening the filter, so the client never sends a half-reference of its own accord.
    if (options.clientRef !== undefined) {
      query.set(THREADS_QUERY_CLIENT, options.clientRef.client);
      query.set(THREADS_QUERY_SESSION_ID, options.clientRef.sessionId);
    }
    return this.#query<Page<ThreadSummary>>(THREADS_PATH, query);
  }

  async getThread(threadId: string): Promise<ThreadView> {
    return this.#query<ThreadView>(`${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}`);
  }

  async submitInput(threadId: string, request: SubmitInputRequest): Promise<InputReceipt> {
    return this.#command<InputReceipt>({
      method: "POST",
      path: `${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}/inputs`,
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  async updateThreadMetadata(threadId: string, request: import("@super-agent/protocol").UpdateThreadMetadataRequest): Promise<CommandReceipt> {
    return this.#command({ method: "PATCH", path: `${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}`,
      requestId: request.requestId, body: request as unknown as Record<string, unknown> });
  }

  async deleteThread(threadId: string, request: import("@super-agent/protocol").ThreadDeletionRequest): Promise<CommandReceipt> {
    return this.#command({ method: "POST", path: `${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}:delete`, requestId: request.requestId, body: request });
  }

  async restoreThread(threadId: string, request: import("@super-agent/protocol").ThreadDeletionRequest): Promise<CommandReceipt> {
    return this.#command({ method: "POST", path: `${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}:restore`, requestId: request.requestId, body: request });
  }

  async getConversation(conversationId: string): Promise<ConversationView> {
    return this.#query<ConversationView>(
      `/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}`,
    );
  }

  async getConversationContext(conversationId: string): Promise<import("@super-agent/protocol").ConversationContextView> {
    return this.#query(`/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}/context`);
  }
  async compactConversation(conversationId: string, request: import("@super-agent/protocol").CompactConversationRequest): Promise<CommandReceipt> {
    return this.#command({ method: "POST", path: `/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}:compact`, requestId: request.requestId, body: request as unknown as Record<string, unknown> });
  }

  async updateConversationConfig(conversationId: string, request: UpdateConversationConfigRequest): Promise<UpdateConversationConfigResult> {
    return await this.#command<UpdateConversationConfigResult>({ method: "PATCH",
      path: `/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}/config`,
      requestId: request.requestId, body: request as unknown as Record<string, unknown> });
  }


  async listMessages(conversationId: string, options: MessageQuery = {}): Promise<MessagePage> {
    const query = pageQuery(options);
    if (options.afterMessageId !== undefined) query.set("afterMessageId", options.afterMessageId);
    return this.#query<MessagePage>(
      `/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}/messages`,
      query,
    );
  }

  async getRun(runId: string): Promise<RunView> {
    return this.#query<RunView>(`/v1/runs/${encodeURIComponent(requireId(runId, "runId"))}`);
  }

  async listTurns(runId: string, options: PageOptions = {}): Promise<Page<TurnView>> {
    return this.#query<Page<TurnView>>(
      `/v1/runs/${encodeURIComponent(requireId(runId, "runId"))}/turns`,
      pageQuery(options),
    );
  }

  async stopThread(threadId: string, request: StopThreadRequest): Promise<CommandReceipt> {
    return this.#command<CommandReceipt>({
      method: "POST",
      path: `${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}:stop`,
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  async pauseThread(threadId: string, request: ThreadControlRequest): Promise<CommandReceipt> {
    return this.#control("pause", threadId, request);
  }

  async archiveThread(threadId: string, request: ThreadControlRequest): Promise<CommandReceipt> {
    return this.#control("archive", threadId, request);
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResult> {
    return this.#command<ResumeThreadResult>({
      method: "POST",
      path: `${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}:resume`,
      requestId: request.requestId,
      // The decision lists travel as they were given, absent when the caller named none:
      // sending `[]` where the caller said nothing would be the client inventing a
      // decision, and "resume and decide nothing" is a different request from "resume".
      body: request as unknown as Record<string, unknown>,
    });
  }

  async listWaits(threadId: string, options: ListWaitsOptions = {}): Promise<Page<WaitView>> {
    const query = pageQuery(options);
    if (options.status !== undefined) query.set("status", options.status);
    return this.#query<Page<WaitView>>(
      `${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}/waits`,
      query,
    );
  }

  async answerWait(waitId: string, request: AnswerWaitRequest): Promise<CommandReceipt> {
    return this.#command<CommandReceipt>({
      method: "POST",
      path: `/v1/waits/${encodeURIComponent(requireId(waitId, "waitId"))}:answer`,
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  async listExecutions(threadId: string): Promise<readonly import("@super-agent/protocol").ExecutionView[]> {
    return (await this.#query<{items: readonly import("@super-agent/protocol").ExecutionView[]}>(`/v1/threads/${encodeURIComponent(requireId(threadId, "threadId"))}/executions`, new URLSearchParams())).items;
  }
  async discardPendingConfig(conversationId: string, request: { requestId: string; expectedConfigRevision: string }): Promise<UpdateConversationConfigResult> {
    return this.#command({ method: "POST", path: `/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}:discard-pending`, requestId: request.requestId, body: request });
  }
  async verifyExecution(threadId: string, executionId: string, request: import("@super-agent/protocol").VerifyExecutionRequest): Promise<CommandReceipt> {
    return this.#command({ method: "POST", path: `/v1/threads/${encodeURIComponent(requireId(threadId, "threadId"))}/executions/${encodeURIComponent(requireId(executionId, "executionId"))}:verify`, requestId: request.requestId, body: request as unknown as Record<string, unknown> });
  }
  async renewApproval(waitId: string, request: { requestId: string }): Promise<CommandReceipt> {
    return this.#command({ method: "POST", path: `/v1/waits/${encodeURIComponent(requireId(waitId, "waitId"))}:renew`, requestId: request.requestId, body: request });
  }

  async provideRequiredFile(waitId: string, request: import("@super-agent/protocol").ProvideRequiredFileRequest): Promise<import("@super-agent/protocol").ProvideRequiredFileResult> {
    return this.#command({ method: "POST", path: `/v1/waits/${encodeURIComponent(requireId(waitId, "waitId"))}:provide-file`,
      requestId: request.requestId, body: request as unknown as Record<string, unknown> });
  }

  async resolvePermission(waitId: string, request: ResolvePermissionRequest): Promise<CommandReceipt> {
    return this.#command<CommandReceipt>({
      method: "POST",
      path: `/v1/waits/${encodeURIComponent(requireId(waitId, "waitId"))}:resolve`,
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  async redoRun(runId: string, request: RedoRunRequest): Promise<RedoRunResult> {
    return this.#command<RedoRunResult>({
      method: "POST",
      path: `/v1/runs/${encodeURIComponent(requireId(runId, "runId"))}:redo`,
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  async forkConversation(
    conversationId: string,
    request: ForkConversationRequest,
  ): Promise<ForkConversationResult> {
    return this.#command<ForkConversationResult>({
      method: "POST",
      path: `/v1/conversations/${encodeURIComponent(requireId(conversationId, "conversationId"))}:fork`,
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  async findWorkspace(root: string): Promise<WorkspaceView | null> {
    const query = new URLSearchParams({ root: requireId(root, "root") });
    const result = await this.#query<WorkspaceLookupResult>("/v1/workspaces", query);
    return result.workspace;
  }

  async registerWorkspace(request: RegisterWorkspaceRequest): Promise<WorkspaceView> {
    // The registration answers with the Workspace itself; the *lookup* is the wrapped one,
    // because "not registered" needs somewhere to be `null`.
    return this.#command<WorkspaceView>({
      method: "POST",
      path: "/v1/workspaces",
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  /* ---------------------------------------------------------------- requests */

  getObservationMetrics(query: ObservationQuery): Promise<ObservationMetricsResponse> {
    return this.#query("/v1/metrics", observationQuery(query));
  }
  getObservationTools(query: ObservationQuery): Promise<ObservationToolsResponse> {
    return this.#query("/v1/metrics/tools", observationQuery(query));
  }
  getObservationUsage(query: ObservationUsageQuery): Promise<ObservationUsageResponse> {
    return this.#query("/v1/metrics/usage", observationQuery(query));
  }
  listObservationMembers(request: ObservationMetricMembersRequest): Promise<ObservationMetricMembersPage> {
    const params = new URLSearchParams({ side: request.side });
    if (request.cursor != null) params.set("cursor", request.cursor);
    if (request.limit != null) params.set("limit", String(request.limit));
    return this.#query(`/v1/metrics/${encodeURIComponent(requireId(request.queryId, "queryId"))}/members`, params);
  }
  getObservationHealth(): Promise<ObservationHealth> {
    return this.#query("/v1/observation/health");
  }
  getObservationThreadGraph(id: string): Promise<ObservationThreadGraph> {
    return this.#query(`/v1/observation/threads/${encodeURIComponent(requireId(id, "threadId"))}/graph`);
  }
  getObservationRunTrace(id: string): Promise<ObservationRunTrace> {
    return this.#query(`/v1/observation/runs/${encodeURIComponent(requireId(id, "runId"))}/trace`);
  }
  getObservationConversationTrace(id: string, query: ObservationConversationTraceQuery = {}): Promise<ObservationConversationTracePage> {
    const params = new URLSearchParams();
    if (query.cursor != null) params.set("cursor", query.cursor);
    if (query.search !== undefined) params.set("search", query.search);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    return this.#query(`/v1/observation/conversations/${encodeURIComponent(requireId(id, "conversationId"))}/trace`, params);
  }
  getObservationExecution(id: string): Promise<ObservationExecution> {
    return this.#query(`/v1/observation/executions/${encodeURIComponent(requireId(id, "executionId"))}`);
  }
  getObservationContent(ref: ObservationContentRef): Promise<ObservationContentResult> {
    return this.#query(`/v1/observation/content/${Buffer.from(JSON.stringify(ref), "utf8").toString("base64url")}`);
  }

  /**
   * One state-changing call.
   *
   * The id goes in the body *and* in `X-Request-Id`, and the two are the same string by
   * construction. The Core refuses a call whose two ids disagree, so a client that sent one
   * of them from somewhere else would be refused rather than silently keyed under an id it
   * did not choose — and the replay guarantee ("the same requestId returns the receipt the
   * first call produced") only holds if there is one id.
   */
  async #command<T extends object>(call: {
    readonly method: "POST" | "PATCH";
    readonly path: string;
    readonly requestId: string;
    readonly body: Record<string, unknown>;
  }): Promise<T> {
    const id = requireRequestId(call.requestId);
    const response = await sendRequest({
      ...this.#connection,
      method: call.method,
      path: call.path,
      headers: this.#headers({ [HEADER_REQUEST_ID]: id }),
      timeoutMs: this.#requestTimeoutMs,
      body: JSON.stringify(call.body),
    });
    return this.#readJson<T>(response);
  }

  /** Pause and archive are the same call with a different suffix. */
  async #control(
    action: "pause" | "archive",
    threadId: string,
    request: ThreadControlRequest,
  ): Promise<CommandReceipt> {
    return this.#command<CommandReceipt>({
      method: "POST",
      path: `${THREADS_PATH}/${encodeURIComponent(requireId(threadId, "threadId"))}:${action}`,
      requestId: request.requestId,
      body: request as unknown as Record<string, unknown>,
    });
  }

  async #query<T extends object>(path: string, query?: URLSearchParams): Promise<T> {
    const search = query === undefined || [...query.keys()].length === 0 ? "" : `?${query.toString()}`;
    const response = await sendRequest({
      ...this.#connection,
      method: "GET",
      path: `${path}${search}`,
      headers: this.#headers(),
      timeoutMs: this.#requestTimeoutMs,
    });
    return this.#readJson<T>(response);
  }

  #headers(extra?: Readonly<Record<string, string>>): Record<string, string> {
    return {
      [HEADER_PROTOCOL_VERSION]: String(PROTOCOL_VERSION),
      [HEADER_CALLER]: this.caller,
      accept: "application/json",
      ...extra,
    };
  }

  #readJson<T extends object>(response: HttpResponse): T {
    if (response.status >= 400) {
      const envelope = parseErrorEnvelope(tryParseJson(response.body));
      if (envelope !== null) throw clientErrorFromEnvelope(response.status, envelope);
      throw malformedResponse(response.status);
    }
    const parsed = tryParseJson(response.body);
    if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw malformedResponse(response.status, "the body was not a JSON object");
    }
    return parsed as T;
  }
}

function observationQuery(query: ObservationQuery | ObservationUsageQuery): URLSearchParams {
  const params = new URLSearchParams({ scope: query.scope, includeDescendants: String(query.includeDescendants) });
  if (query.window.from !== null) params.set("from", query.window.from);
  if (query.window.until !== null) params.set("until", query.window.until);
  for (const [key, value] of Object.entries(query.filters)) if (value !== null) params.set(key, value);
  for (const group of typeof query.groupBy === "string" ? [query.groupBy] : query.groupBy) params.append("groupBy", group);
  if ("metrics" in query) for (const metric of query.metrics) params.append("metric", metric);
  return params;
}

function requireRequestId(requestId: string | undefined): string {
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw new CoreClientError({
      code: "INVALID_REQUEST",
      message: "a non-empty requestId is required for state-changing calls",
      httpStatus: httpStatusForError("INVALID_REQUEST"),
    });
  }
  return requestId;
}

/**
 * A path id, refused locally when it is empty.
 *
 * An empty id would build a path that names the *collection* rather than a member of it —
 * `GET /v1/threads/` matches nothing, and the caller would be told `NOT_FOUND` about a
 * Thread it never named. Failing here says which argument was wrong.
 */
function requireId(value: string, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new CoreClientError({
      code: "INVALID_REQUEST",
      message: `${name} is required`,
      httpStatus: httpStatusForError("INVALID_REQUEST"),
    });
  }
  return value;
}

/** The `limit`/`cursor` of a listing, omitted when the caller did not set them. */
function pageQuery(options: PageOptions): URLSearchParams {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  return query;
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
