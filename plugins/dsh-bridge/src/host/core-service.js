/**
 * The bridge's Core service: one link to the Core, and the routes the browser
 * half reaches it through.
 *
 * Two callers share this module, and they must not each grow their own idea of
 * what the Core is. The host's Agent factory uses it in-process to create a
 * Thread, submit input and stop work; the browser half uses it over HTTP to
 * read state and raise the same operations. Both go through the same SDK
 * client, so "the panel says the Run is running" and "the Agent submitted the
 * input" are answers from one connection, not two.
 *
 * The browser cannot open a Unix socket, which is why there are routes here at
 * all: DSH serves the page from the same origin as its own web server, so a
 * same-origin `fetch` to a route this plugin registers is the shortest path
 * that keeps the Core's UDS surface on the host side, where it belongs. Nothing
 * in the browser half imports the SDK, and nothing in it knows the socket path.
 *
 * **Every state-changing call carries a caller-chosen `requestId`.** The host
 * refuses to invent one. The Core's idempotency is keyed by that id, so a
 * request id generated at the transport would make every retry a new command —
 * a second Run for one submitted message, a second fork for one click. The
 * browser facade is where a retry is decided, so the browser facade is where
 * the id is chosen.
 */
/** The prefix every route this plugin registers lives under. */
import { createObservationService } from "./observation-service.js";
import { createLocalArtifactService } from "./local-artifacts.js";
import { createFileDecisionActions } from "./file-decisions-service.js";
import { createLocalUploadService } from "./local-uploads.js";
import { createGoalActions } from "./goal-service.js";
export const CORE_ROUTE_PREFIX = "/super-agent";

/**
 * The Core's address, as the bridge reads it.
 *
 * `SUPER_AGENT_HOME` is the Core's home; the socket is where the Core puts it
 * unless the operator moved it. Nothing here reads a real user home by default
 * in a test or in the isolated profile — both set the variable explicitly.
 * @param env - the environment to read.
 */
export function resolveCoreOptions(env = process.env) {
  const home = env.SUPER_AGENT_HOME ?? `${env.HOME ?? "."}/.super-agent`;
  return {
    home,
    socketPath: env.SUPER_AGENT_SOCKET ?? `${home}/run/core.sock`,
    lockFile: `${home}/run/core.lock`,
  };
}

/** Whether an action changes Core state, and therefore needs a request id. */
const COMMANDS = new Set([
  "thread.create",
  "thread.stop",
  "thread.pause",
  "thread.resume",
  "thread.archive",
  "thread.metadata",
  "thread.delete",
  "thread.restore",
  "conversation.updateConfig",
  "conversation.discardPending",
  "conversation.compact",
  "input.submit",
  "goal.create", "goal.update", "goal.steer", "goal.pause", "goal.resume", "goal.cancel",
  "wait.answer",
  "wait.resolve",
  "wait.provideFile",
  "wait.renewApproval",
  "execution.verify",
  "run.redo",
  "conversation.fork",
  "workspace.register",
  "workspace.managed.open",
  // Writes the bridge's own durable record, not the Core's. It still takes a
  // caller-chosen id, because the same rule applies: a retried click must
  // re-attach to the record it already wrote rather than append a second one.
  "session.associate",
]);

/** A refusal that carries the Core's own error code, so the browser can act on it. */
export class CoreServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CoreServiceError";
    this.code = code;
    this.details = details ?? null;
  }
}

/** Require a non-empty string argument, naming it when it is missing. */
function requireText(payload, field) {
  const value = payload?.[field];
  if (typeof value !== "string" || value === "") {
    throw new CoreServiceError("INVALID_REQUEST", `${field} is required`, { field });
  }
  return value;
}

/** Require a caller-chosen request id. See the module header for why this is not generated. */
function requireRequestId(payload) {
  return requireText(payload, "requestId");
}

/** Pass through a field only when the caller set it, so an absent one stays absent. */
function optional(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/** Milliseconds, as the panel's `mm:ss` elapsed text. */
function elapsedText(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One Run, as the panel's card draws it.
 *
 * A projection, and deliberately a narrow one: the card needs a turn list, a
 * waiting count and an elapsed time, and nothing else the Core knows about the
 * Run belongs in a view whose only job is to be read at a glance.
 * @param run - a `RunView`, or nothing.
 * @param turns - the Run's `TurnView`s, oldest first.
 * @returns the card's Run, or `null` when there is no Run to draw.
 */
function runSummaryOf(run, turns) {
  if (run === null || run === undefined) return null;
  return {
    runId: run.runId,
    threadId: run.threadId,
    conversationId: run.conversationId,
    status: run.status,
    endReason: run.endReason ?? null,
    answer: run.answer ?? null,
    waitingCount: run.pendingWaits ?? 0,
    elapsed: elapsedText(run.elapsedMs),
    turns: (turns ?? []).map((turn, index) => ({
      n: index + 1,
      tools: Array.isArray(turn.toolCallIds) ? turn.toolCallIds.length : 0,
      state: turn.status === "completed" ? "done" : "running",
    })),
  };
}

/**
 * The Thread a Session runs on, and the Conversation it is showing.
 *
 * The pair is read from the durable mapping, never inferred. Picking the
 * newest Thread — or the one with a Run on it — answers a question the panel
 * did not ask, and answers it about *another session*: with two sessions open,
 * the second one's operations would land on the first one's Thread, and a fork
 * would be recorded against whichever session happened to run last.
 *
 * A mapping that names a Thread the home no longer holds reports nothing rather
 * than failing: the session has no Thread it can reach, and saying so is the
 * honest answer. It is not forgotten here — the write side owns that — because
 * a read that repaired the record would turn a transient outage into a lost
 * association.
 * @param client - the SDK client.
 * @param map - the session map, or `null` when this build has none.
 * @param sessionId - the Session the caller is asking about.
 * @returns the Thread's view and the Conversation, each `null` when there is none.
 */
async function threadForSession(client, map, sessionId) {
  const mapped = map?.get(sessionId);
  if (mapped === undefined || mapped === null) return { thread: null, conversationId: null };
  try {
    const thread = await client.getThread(mapped.threadId);
    return { thread, conversationId: mapped.conversationId ?? String(thread.mainConversationId) };
  } catch (error) {
    if (error?.code !== "NOT_FOUND") throw error;
    return { thread: null, conversationId: null };
  }
}

/**
 * Build the service.
 *
 * `client` is the SDK client, injected rather than constructed here so the
 * offline suite can drive every route against a stand-in and so the same
 * service can be built over a socket the tests chose.
 * @param options.client - the `@super-agent/client` client.
 * @param options.options - the Core's address, for the view state.
 * @param options.now - clock, for the timestamps the routes report.
 * @param options.sessionMap - the durable Session↔Thread record, as a provider
 *   (or the map itself). Absent means this build cannot tell which Thread a
 *   session runs on, and the panel says so instead of guessing one.
 * @returns the operations, the view state, and the event subscription.
 */
export function createCoreService({ client, settingsClient, options, now = () => Date.now(), sessionMap = null }) {
  /** The last connection failure, cleared by the next call that succeeds. */
  let lastError = null;
  let lastOkAt = null;
  const localUploads = createLocalUploadService({ files: client.files, home: options.localCacheHome || options.home,
    targetKey: options.instanceId || options.baseUrl || options.socketPath || "local", actorId: options.actorId, now });
  const localArtifacts = createLocalArtifactService({ files: client.files, home: options.localCacheHome || options.home, actorId: options.actorId });

  /** The session map, resolved once: it is opened from a file, not per request. */
  const resolveSessionMap = async () => {
    if (sessionMap === null) return null;
    return await (typeof sessionMap === "function" ? sessionMap() : sessionMap);
  };

  /** Run one SDK call, recording whether the link is up. */
  const attempt = async (work) => {
    try {
      const result = await work();
      lastError = null;
      lastOkAt = now();
      return result;
    } catch (error) {
      lastError = {
        code: typeof error?.code === "string" ? error.code : "INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  };

  const managedWorkspaceIdentity = async payload => {
    if (!options.baseUrl) {
      const info = await client.getServerInfo();
      if (!Number.isInteger(info?.pid) || typeof info.startedAt !== "string") throw new CoreServiceError("PROTOCOL_INCOMPATIBLE", "当前 UDS Core 未提供进程版本");
      if (payload.expectedInstanceId || payload.expectedServerPid !== undefined && payload.expectedServerPid !== info.pid || payload.expectedServerStartedAt !== undefined && payload.expectedServerStartedAt !== info.startedAt) throw new CoreServiceError("INSTANCE_CHANGED", "UDS Core 进程已变化，请重新读取工作区后确认");
      return { instanceId: null, connectionKind: "uds", serverPid: info.pid, serverStartedAt: info.startedAt, targetId: payload.targetId ?? null };
    }
    const identity = await settingsClient.getIdentity();
    if (typeof identity?.instanceId !== "string" || !identity.instanceId) throw new CoreServiceError("PROTOCOL_INCOMPATIBLE", "当前 Core 未提供工作区实例标识");
    if (payload.expectedInstanceId && payload.expectedInstanceId !== identity.instanceId) throw new CoreServiceError("INSTANCE_CHANGED", "Core 实例已变化，请重新读取工作区后确认");
    return { instanceId: identity.instanceId, connectionKind: "https", targetId: payload.targetId ?? null };
  };

  /**
   * One operation, by name.
   *
   * The names are the browser facade's vocabulary. Keeping the dispatch table
   * here — rather than letting each caller reach for the SDK method it wants —
   * is what makes "what the panel can do" a list that can be read in one place
   * and asserted in one place.
   */
  const operations = {
    ...createGoalActions({ client, attempt, error: (code, message) => new CoreServiceError(code, message) }),
    ...createFileDecisionActions({ client, attempt }),
    "files.capabilities": () => attempt(() => client.files.capabilities()),
    "files.environment": payload => attempt(() => client.files.environment({ ...(payload.snapshotId ? { snapshotId: payload.snapshotId } : {}), ...(payload.runId ? { runId: payload.runId } : {}), ...(payload.presetId ? { presetId: payload.presetId } : {}) })),
    "files.transfer.create": payload => attempt(() => client.files.createTransfer({ requestId: requireRequestId(payload), workspaceId: requireText(payload, "workspaceId"), manifest: payload.manifest, source: payload.source })),
    "files.transfer.get": payload => attempt(() => client.files.getTransfer(requireText(payload, "operationId"))),
    "files.transfer.upload": payload => attempt(() => client.files.uploadBlock(requireText(payload, "operationId"), { requestId: requireRequestId(payload), hash: requireText(payload, "hash"), dataBase64: requireText(payload, "dataBase64") })),
    "files.transfer.commit": payload => attempt(() => client.files.commitTransfer(requireText(payload, "operationId"), requireRequestId(payload))),
    "files.transfer.cancel": payload => attempt(() => client.files.cancelTransfer(requireText(payload, "operationId"), requireRequestId(payload))),
    "files.snapshots": payload => attempt(() => client.files.listSnapshots(requireText(payload, "workspaceId"))),
    "files.snapshot": payload => attempt(() => client.files.getSnapshot(requireText(payload, "snapshotId"))),
    "files.snapshotDirectory": payload => attempt(() => client.files.snapshotDirectory(requireText(payload, "workspaceId"), { requestId: requireRequestId(payload), path: requireText(payload, "path"), ...optional(payload, ["rules"]) })),
    "files.snapshotGit": payload => attempt(() => client.files.snapshotGit(requireText(payload, "workspaceId"), { requestId: requireRequestId(payload), repository: requireText(payload, "repository"), ref: requireText(payload, "ref") })),
    "files.import.start": payload => attempt(() => client.files.startImport({ requestId: requireRequestId(payload), workspaceId: requireText(payload, "workspaceId"), mode: payload.mode, ...optional(payload, ["path", "repository", "ref", "credentialRef", "rules"]) })),
    "files.imports": () => attempt(() => client.files.listImports()),
    "files.import": payload => attempt(() => client.files.getImport(requireText(payload, "operationId"))),
    "files.import.cancel": payload => attempt(() => client.files.cancelImport(requireText(payload, "operationId"), requireRequestId(payload))),
    "files.import.retry": payload => attempt(() => client.files.retryImport(requireText(payload, "operationId"), requireRequestId(payload))),
    "files.previewLocal": payload => attempt(async () => {
      return localUploads.preview(requireText(payload, "path"), payload.rules);
    }),
    "files.syncLocal": payload => attempt(async () => {
      const operation = await localUploads.start({ requestId: requireRequestId(payload), candidateId: requireText(payload, "candidateId"), workspaceId: requireText(payload, "workspaceId") });
      return localUploads.wait(operation.operationId);
    }),
    "files.localUpload.start": payload => attempt(() => localUploads.start({ requestId: requireRequestId(payload), candidateId: requireText(payload, "candidateId"), workspaceId: requireText(payload, "workspaceId") })),
    "files.localUploads": () => attempt(() => localUploads.list()),
    "files.localUpload": payload => attempt(() => localUploads.get(requireText(payload, "operationId"))),
    "files.localUpload.inspect": payload => attempt(() => localUploads.inspect(requireText(payload, "operationId"))),
    "files.localUpload.cancel": payload => attempt(() => localUploads.cancel(requireText(payload, "operationId"), requireRequestId(payload))),
    "files.localUpload.resume": payload => attempt(() => localUploads.resume(requireText(payload, "operationId"), requireRequestId(payload))),
    "files.branch.create": payload => attempt(() => client.files.createBranch({ requestId: requireRequestId(payload), workspaceId: requireText(payload, "workspaceId"), conversationId: requireText(payload, "conversationId"), snapshotId: requireText(payload, "snapshotId") })),
    "files.branch.get": payload => attempt(() => client.files.getBranch(requireText(payload, "branchId"))),
    "files.branch.previewMerge": payload => attempt(() => client.files.previewMerge(requireText(payload, "branchId"), { requestId: requireRequestId(payload), baseSnapshotId: requireText(payload, "baseSnapshotId"), incomingSnapshotId: requireText(payload, "incomingSnapshotId") })),
    "files.branch.merge": payload => attempt(() => client.files.mergeBranch(requireText(payload, "branchId"), { requestId: requireRequestId(payload), expectedRevision: payload.expectedRevision, baseSnapshotId: requireText(payload, "baseSnapshotId"), incomingSnapshotId: requireText(payload, "incomingSnapshotId"), ...optional(payload, ["resolutions"]) })),
    "files.run": payload => attempt(() => client.files.getRunFiles(requireText(payload, "runId"))),
    "files.artifacts": payload => attempt(() => client.files.getArtifacts(requireText(payload, "runId"))),
    "files.read": payload => attempt(() => client.files.readSnapshotFile(requireText(payload, "snapshotId"), requireText(payload, "path"))),
    "files.rollback": payload => attempt(() => client.files.rollbackRun(requireText(payload, "runId"), {
      requestId: requireRequestId(payload), expectedRevision: payload.expectedRevision, files: payload.files,
    })),
    "files.applyLocal": payload => localArtifacts.apply(payload),
    "files.applyOperation": payload => localArtifacts.get(requireText(payload, "operationId")),
    "files.applyOperations": payload => localArtifacts.list(requireText(payload, "runId")),
    "files.applyConflict.preview": payload => localArtifacts.previewConflict(payload),
    "files.applyConflict.resolve": payload => localArtifacts.resolveConflict(payload),
    "skills.list": payload => attempt(() => client.skills.listSources(payload?.workspaceId)),
    "skills.catalog": payload => attempt(async () => {
      const workspace = payload?.workspaceId ? { workspaceId: payload.workspaceId } : payload?.root ? await client.findWorkspace(payload.root) : null;
      return (client.skills.catalog || client.skills.scan)(workspace?.workspaceId);
    }),
    "workspaces.lookup": payload => attempt(() => client.findWorkspace(requireText(payload, "root"))),
    "skills.locations": payload => attempt(() => client.skillInstallations.locations(payload?.workspaceId)),
    "skills.installations": payload => attempt(() => client.skillInstallations.list(payload?.workspaceId)),
    "skills.discover": payload => attempt(() => client.skillInstallations.discover({ requestId: requireRequestId(payload), workspaceId: payload.workspaceId || null, ...optional(payload, ["cwd"]) })),
    "skills.previewImport": payload => attempt(() => client.skillInstallations.previewImport({ requestId: requireRequestId(payload), sourceId: requireText(payload, "sourceId"), snapshotId: requireText(payload, "snapshotId"), workspaceId: payload.workspaceId || null, ...optional(payload, ["skillPaths", "aliases", "replace"]) })),
    "skills.previewMigration": payload => attempt(() => client.skillInstallations.previewMigration({ requestId: requireRequestId(payload), sourceId: requireText(payload, "sourceId"), snapshotId: requireText(payload, "snapshotId"), workspaceId: payload.workspaceId || null, ...optional(payload, ["skillPaths", "aliases", "replace"]) })),
    "skills.previewUpdate": payload => attempt(() => client.skillInstallations.previewUpdate({ requestId: requireRequestId(payload), installationId: requireText(payload, "installationId"), expectedRevision: payload.expectedRevision, ...optional(payload, ["snapshotId", "ref", "expectedPackageHash", "resolution"]) })),
    "skills.applyInstall": payload => attempt(() => client.skillInstallations.apply({ requestId: requireRequestId(payload), planId: requireText(payload, "planId") })),
    "skills.installOperations": () => attempt(() => client.skillInstallations.listOperations()),
    "skills.installOperation": payload => attempt(() => client.skillInstallations.getOperation(requireText(payload, "operationId"))),
    "skills.retryInstall": payload => attempt(() => client.skillInstallations.retry(requireText(payload, "operationId"), { requestId: requireRequestId(payload) })),
    "skills.cancelInstall": payload => attempt(() => client.skillInstallations.cancel(requireText(payload, "operationId"), { requestId: requireRequestId(payload) })),
    "skills.installEnabled": payload => attempt(() => client.skillInstallations.setEnabled(requireText(payload, "installationId"), { requestId: requireRequestId(payload), expectedRevision: payload.expectedRevision, enabled: payload.enabled })),
    "skills.installRemove": payload => attempt(() => client.skillInstallations.remove(requireText(payload, "installationId"), { requestId: requireRequestId(payload), expectedRevision: payload.expectedRevision })),
    "attachments.capabilities": () => attempt(() => client.attachments.capabilities()),
    "attachments.drafts.create": payload => attempt(() => client.attachments.createDraft({ requestId: requireRequestId(payload), ...optional(payload, ["conversationId", "workspaceId"]) })),
    "attachments.prepare": payload => attempt(() => client.attachments.prepare({ requestId: requireRequestId(payload), draftId: requireText(payload, "draftId"), name: requireText(payload, "name"), ...optional(payload, ["dataBase64", "snapshotId", "path", "projectPath"]) })),
    "attachments.get": payload => attempt(() => payload.attachmentId ? client.attachments.get(payload.attachmentId) : client.attachments.getDraft(requireText(payload, "draftId"))),
    "attachments.operation": payload => attempt(() => client.attachments.getOperation(requireText(payload, "operationId"))),
    "attachments.remove": payload => attempt(() => client.attachments.remove(requireText(payload, "attachmentId"), { requestId: requireRequestId(payload), draftId: requireText(payload, "draftId") })),
    "attachments.retry": payload => attempt(() => client.attachments.retry(requireText(payload, "attachmentId"), { requestId: requireRequestId(payload) })),
    "attachments.cancel": payload => attempt(() => client.attachments.cancel(requireText(payload, "operationId"), { requestId: requireRequestId(payload) })),
    "attachments.read": payload => attempt(() => client.attachments.read({ attachmentId: requireText(payload, "attachmentId"), representationId: requireText(payload, "representationId"), ...optional(payload, ["format", "range"]) })),
    "attachments.evidence": payload => attempt(() => client.attachments.evidence(requireText(payload, "attachmentId"), payload.conversationId)),
    "attachments.projectFiles": payload => attempt(async () => {
      const workspace = payload?.workspaceId ? { workspaceId: payload.workspaceId } : await client.findWorkspace(requireText(payload, "root"));
      if (!workspace) throw new CoreServiceError("NOT_FOUND", "请先注册项目工作区");
      return client.attachments.projectFiles(workspace.workspaceId, payload.query);
    }),
    "input.preview": payload => attempt(() => client.attachments.previewInput({ requestId: requireRequestId(payload),
      draftId: requireText(payload, "draftId"), text: typeof payload.text === "string" ? payload.text : "",
      attachments: payload.attachments || [], ...optional(payload, ["conversationId", "workspaceId", "modelId", "provider", "selectedSkillRefs", "selectedSkillIds", "delivery", "targetRunId", "thinkingLevel", "permissionMode"]) })),
    "skills.scan": payload => attempt(() => client.skills.scan(payload?.workspaceId)),
    "skills.create": payload => attempt(() => client.skills.createSource({ requestId: requireRequestId(payload), kind: requireText(payload, "kind"), location: requireText(payload, "location"), workspaceId: payload.workspaceId || null, ...optional(payload, ["credentialRef", "expectedPackageHash"]) })),
    "skills.sync": payload => attempt(() => client.skills.syncSource(requireText(payload, "sourceId"), { requestId: requireRequestId(payload), expectedRevision: payload.expectedRevision, ...optional(payload, ["ref", "expectedPackageHash"]) })),
    "skills.sync.start": payload => attempt(() => client.skills.startSync(requireText(payload, "sourceId"), { requestId: requireRequestId(payload), expectedRevision: payload.expectedRevision, ...optional(payload, ["ref", "expectedPackageHash"]) })),
    "skills.operations": () => attempt(() => client.skills.listOperations()),
    "skills.operation": payload => attempt(() => client.skills.getOperation(requireText(payload, "operationId"))),
    "skills.operation.cancel": payload => attempt(() => client.skills.cancelOperation(requireText(payload, "operationId"), { requestId: requireRequestId(payload) })),
    "skills.operation.retry": payload => attempt(() => client.skills.retryOperation(requireText(payload, "operationId"), { requestId: requireRequestId(payload) })),
    "skills.recordVersion": payload => attempt(() => client.skills.recordVersion(requireText(payload, "sourceId"), { requestId: requireRequestId(payload), snapshotId: requireText(payload, "snapshotId"), expectedRevision: payload.expectedRevision, ...optional(payload, ["activate"]) })),
    "skills.update": payload => attempt(() => client.skills.updateSource(requireText(payload, "sourceId"), { requestId: requireRequestId(payload), expectedRevision: payload.expectedRevision, ...optional(payload, ["enabled", "snapshotId"]) })),
    "skills.policy": payload => attempt(() => client.skills.setPolicy(requireText(payload, "sourceId"), { requestId: requireRequestId(payload), workspaceId: payload.workspaceId || null, skillPath: requireText(payload, "skillPath"), enabled: payload.enabled, expectedRevision: payload.expectedRevision, ...optional(payload, ["alias"]) })),
    "skills.remove": payload => attempt(() => client.skills.removeSource(requireText(payload, "sourceId"), { requestId: requireRequestId(payload), workspaceId: payload.workspaceId || null, expectedRevision: payload.expectedRevision })),
    "settings.get": () => attempt(() => settingsClient.getSettings()),
    "mcp.status": () => attempt(() => settingsClient.getMcpStatus()),
    "mcp.check": payload => attempt(() => settingsClient.checkMcp(payload.server)),
    "models.history": () => attempt(() => settingsClient.getModelHistory()),
    "credentials.list": () => attempt(() => settingsClient.listCredentials()),
    "credentials.check": payload => attempt(() => settingsClient.checkCredential(requireText(payload, "credentialRef"), { requestId: requireRequestId(payload), providerId: requireText(payload, "providerId"), ...(payload.modelConfiguration ? { modelConfiguration: payload.modelConfiguration } : {}) })),
    "credentials.revoke": payload => attempt(() => settingsClient.revokeCredential({ requestId: requireRequestId(payload), credentialRef: requireText(payload, "credentialRef") })),
    "settings.apply": payload => attempt(() => settingsClient.applySettings({ requestId: requireRequestId(payload), expectedVersion: payload.expectedVersion, configuration: payload.configuration })),
    "settings.operation": payload => attempt(() => settingsClient.getOperation(requireText(payload, "operationId"))),
    "credentials.stage": payload => attempt(() => settingsClient.stageCredential({ requestId: requireRequestId(payload), secret: requireText(payload, "secret") })),
    "credentials.release": payload => attempt(() => settingsClient.releaseCredential(requireText(payload, "credentialRef"))),
    "server.info": () => attempt(() => client.getServerInfo()),
    "models.list": () => attempt(() => client.listModels()),
    "server.logs": (payload) => attempt(() => client.getServerLogs(optional(payload, ["tail"]))),
    // `clientRef` is passed through so the Core's own durable lookup — the
    // Threads one client created for one of its sessions — is reachable from
    // the panel. Nothing in this milestone calls it yet; the bridge's own
    // Session↔Thread record stays the association this panel draws from,
    // because a fork's *new* session names a Thread that already existed and
    // a creation-time reference cannot express that.
    "thread.list": (payload) =>
      attempt(() => client.listThreads(optional(payload, ["status", "deleted", "limit", "cursor", "clientRef"]))),
    "thread.get": (payload) => attempt(() => client.getThread(requireText(payload, "threadId"))),
    "thread.metadata": payload => attempt(() => client.updateThreadMetadata(requireText(payload, "threadId"), {
      requestId: requireRequestId(payload), expectedControlRevision: payload.expectedControlRevision,
      ...optional(payload, ["title", "pinned", "archived"]),
    })),
    "thread.delete": payload => attempt(() => client.deleteThread(requireText(payload, "threadId"), { requestId: requireRequestId(payload), expectedControlRevision: payload.expectedControlRevision })),
    "thread.restore": payload => attempt(() => client.restoreThread(requireText(payload, "threadId"), { requestId: requireRequestId(payload), expectedControlRevision: payload.expectedControlRevision })),
    "thread.create": (payload) =>
      attempt(() =>
        client.createThread({
          requestId: requireRequestId(payload),
          agentId: requireText(payload, "agentId"),
          ...optional(payload, ["workspaceId", "cwd", "modelId", "thinkingLevel", "permissionMode", "skillRoots", "clientRef", "fileInput", "fileBranchId"]),
        }),
      ),
    "thread.stop": (payload) =>
      attempt(() =>
        client.stopThread(requireText(payload, "threadId"), {
          requestId: requireRequestId(payload),
          ...optional(payload, ["reason"]),
        }),
      ),
    "thread.pause": (payload) =>
      attempt(() =>
        client.pauseThread(requireText(payload, "threadId"), { requestId: requireRequestId(payload) }),
      ),
    "thread.resume": (payload) =>
      attempt(() =>
        client.resumeThread(requireText(payload, "threadId"), {
          requestId: requireRequestId(payload),
          ...optional(payload, ["continueRunIds", "queuedInputs", "suppressedReports"]),
        }),
      ),
    "thread.archive": (payload) =>
      attempt(() =>
        client.archiveThread(requireText(payload, "threadId"), { requestId: requireRequestId(payload) }),
      ),
    // `conversationId` is the Conversation the input belongs to, and it is
    // passed through rather than defaulted here: a session that shows a Core
    // fork must write into the fork, and the Core is the one that decides
    // whether the name is one of the Thread's own Conversations. Absence means
    // the Thread's main Conversation, which is what the Core documents — so a
    // caller with no fork to address says nothing and means the same thing.
    "input.submit": (payload) =>
      attempt(() =>
        client.submitInput(requireText(payload, "threadId"), {
          requestId: requireRequestId(payload),
          text: typeof payload.text === "string" ? payload.text : requireText(payload, "text"),
          ...optional(payload, ["delivery", "targetRunId", "conversationId", "fileInput", "fileBranchId", "materials", "selectedSkillIds", "preparedAttachments", "previewId", "previewSignature", "selectedSkillRefs"]),
        }),
      ),
    "run.get": (payload) => attempt(() => client.getRun(requireText(payload, "runId"))),
    "turns.list": (payload) =>
      attempt(() => client.listTurns(requireText(payload, "runId"), optional(payload, ["limit", "cursor"]))),
    "messages.list": (payload) =>
      attempt(() =>
        client.listMessages(
          requireText(payload, "conversationId"),
          optional(payload, ["limit", "cursor", "afterMessageId"]),
        ),
      ),
    "conversation.get": (payload) =>
      attempt(() => client.getConversation(requireText(payload, "conversationId"))),
    "conversation.updateConfig": (payload) => attempt(() => client.updateConversationConfig(requireText(payload, "conversationId"), {
      requestId: requireRequestId(payload), expectedConfigRevision: requireText(payload, "expectedConfigRevision"), patch: payload.patch,
    })),
    "conversation.context": payload => attempt(() => client.getConversationContext(requireText(payload, "conversationId"))),
    "conversation.compact": payload => attempt(() => client.compactConversation(requireText(payload, "conversationId"), { requestId: requireRequestId(payload), runId: requireText(payload, "runId") })),
    "conversation.discardPending": payload => attempt(() => client.discardPendingConfig(requireText(payload, "conversationId"), {
      requestId: requireRequestId(payload), expectedConfigRevision: requireText(payload, "expectedConfigRevision"),
    })),
    "conversation.fork": (payload) =>
      attempt(() =>
        client.forkConversation(requireText(payload, "conversationId"), {
          requestId: requireRequestId(payload),
          sourceEntryId: payload?.sourceEntryId,
          ...optional(payload, ["reason"]),
        }),
      ),
    "waits.list": (payload) =>
      attempt(() =>
        client.listWaits(requireText(payload, "threadId"), optional(payload, ["status", "limit", "cursor"])),
      ),
    "wait.answer": (payload) =>
      attempt(() =>
        client.answerWait(requireText(payload, "waitId"), {
          requestId: requireRequestId(payload),
          answer: requireText(payload, "answer"),
        }),
      ),
    "executions.list": payload => attempt(() => client.listExecutions(requireText(payload, "threadId"))),
    "execution.verify": payload => attempt(() => client.verifyExecution(requireText(payload, "threadId"), requireText(payload, "executionId"), {
      requestId: requireRequestId(payload), conclusion: requireText(payload, "conclusion"), evidence: requireText(payload, "evidence"),
    })),
    "wait.renewApproval": payload => attempt(() => client.renewApproval(requireText(payload, "waitId"), { requestId: requireRequestId(payload) })),
    "wait.provideFile": payload => attempt(() => client.provideRequiredFile(requireText(payload, "waitId"), {
      requestId: requireRequestId(payload), conversationId: requireText(payload, "conversationId"),
      snapshotId: requireText(payload, "snapshotId"), sourcePath: requireText(payload, "sourcePath"),
      ...optional(payload, ["mode"]),
    })),
    "wait.resolve": (payload) =>
      attempt(() =>
        client.resolvePermission(requireText(payload, "waitId"), {
          requestId: requireRequestId(payload),
          decision: requireText(payload, "decision"),
          ...optional(payload, ["reason"]),
        }),
      ),
    "run.redo": (payload) =>
      attempt(() =>
        client.redoRun(requireText(payload, "runId"), {
          requestId: requireRequestId(payload),
          ...optional(payload, ["mode", "edit", "atEntryId"]),
        }),
      ),
    "workspace.find": (payload) => attempt(() => client.findWorkspace(requireText(payload, "root"))),
    "workspace.managed.browse": payload => attempt(async () => {
      const identity = await managedWorkspaceIdentity(payload);
      return { ...await client.managedWorkspaces.browse(payload.relativePath ?? ""), ...identity };
    }),
    "workspace.managed.open": payload => attempt(async () => {
      let identity, input;
      try {
        if (options.baseUrl) requireText(payload, "expectedInstanceId");
        else if (!Number.isInteger(payload.expectedServerPid) || !payload.expectedServerStartedAt) throw new CoreServiceError("INVALID_REQUEST", "请先读取当前 UDS Core 的工作区目录");
        input = { requestId: requireRequestId(payload), relativePath: requireText(payload, "relativePath"), createIfMissing: payload.createIfMissing === true };
        identity = await managedWorkspaceIdentity(payload);
      } catch (error) {
        throw new CoreServiceError(error.code || "INTERNAL", error.message, { ...error.details, operationAccepted: false, phase: "bridge_before_core" });
      }
      return { ...await client.managedWorkspaces.open(input), ...identity };
    }),
    "workspace.register": (payload) =>
      attempt(() =>
        client.registerWorkspace({ requestId: requireRequestId(payload), root: requireText(payload, "root") }),
      ),
    /**
     * Record that a Session is now showing one of its Thread's Conversations.
     *
     * This is the write half of {@link threadForSession}, and it exists for the
     * one case the lazy creation path cannot cover: a session opened for a Core
     * fork. That session must not create a Thread — it belongs to the Thread its
     * source already has, and to the Conversation the fork produced — so the
     * association is written here, from the facts the Core just returned.
     *
     * Nothing is taken on the caller's word. The source Session must already
     * have a mapping (there is nothing to fork from otherwise), the fork must
     * stay in that Thread (a fork is a Conversation *in* a Thread), and the
     * Conversation must be one the Core reports as belonging to that Thread.
     */
    "session.associate": (payload) =>
      attempt(async () => {
        const map = await resolveSessionMap();
        if (map === null) {
          throw new CoreServiceError("NOT_SUPPORTED", "this bridge has no session map to record the association in");
        }
        const sessionId = requireText(payload, "sessionId");
        const sourceSessionId = requireText(payload, "sourceSessionId");
        const threadId = requireText(payload, "threadId");
        const conversationId = requireText(payload, "conversationId");
        const source = map.get(sourceSessionId);
        if (source === undefined) {
          throw new CoreServiceError(
            "NOT_FOUND",
            `session ${sourceSessionId} has no Thread, so there is nothing to associate a fork with`,
            { sessionId: sourceSessionId },
          );
        }
        if (source.threadId !== threadId) {
          throw new CoreServiceError(
            "INVALID_REQUEST",
            `a fork's session stays on its source's Thread: ${sourceSessionId} runs on ${source.threadId}`,
            { sourceSessionId, threadId },
          );
        }
        const conversation = await client.getConversation(conversationId);
        if (String(conversation?.threadId) !== threadId) {
          throw new CoreServiceError(
            "INVALID_REQUEST",
            `conversation ${conversationId} is not in Thread ${threadId}`,
            { conversationId, threadId },
          );
        }
        // The Workspace, agent and model are inherited from the source rather
        // than re-read: the two sessions run the same Thread, so the facts are
        // the same facts, and re-deriving them could only disagree.
        const entry = await map.put({ ...source, sessionId, threadId, conversationId, createdAt: now() });
        return {
          sessionId: entry.sessionId,
          threadId: entry.threadId,
          conversationId: entry.conversationId,
        };
      }),
  };

  return {
    /** The Core's address this service was built for. */
    options,
    observations: createObservationService({ client }),
    /** The operation names the browser facade may raise. */
    actionIds() {
      return Object.keys(operations);
    },
    /**
     * Raise one operation.
     *
     * A failure is re-thrown as a {@link CoreServiceError} carrying the Core's
     * own code: the route layer turns it into a status, and the browser facade
     * turns it into the outcome the panel renders. Nothing is swallowed — an
     * action that did not happen must not read as one that did.
     */
    async call(action, payload) {
      const operation = operations[action];
      if (operation === undefined) {
        throw new CoreServiceError("NOT_SUPPORTED", `${action} is not an operation of this bridge`, { action });
      }
      if (COMMANDS.has(action) && (typeof payload?.requestId !== "string" || payload.requestId === "")) {
        throw new CoreServiceError("INVALID_REQUEST", `${action} needs a caller-chosen requestId`, { action, ...(action === "workspace.managed.open" ? { operationAccepted: false, phase: "bridge_before_core" } : {}) });
      }
      try {
        return await operation(payload ?? {});
      } catch (error) {
        if (error instanceof CoreServiceError) throw error;
        throw new CoreServiceError(
          typeof error?.code === "string" ? error.code : "INTERNAL",
          error instanceof Error ? error.message : String(error),
          error?.details ?? null,
        );
      }
    },
    /**
     * What the panel draws, for one named Session.
     *
     * Read-only and never throwing: a panel that could not be drawn would leave
     * the user with nothing to look at, and "the Core is unreachable, and here
     * is why" is exactly the state the offline page exists to show.
     *
     * `sessionId` is the Session the browser half is showing, and it is what
     * makes the answer about *this* panel rather than about the home. The
     * Thread and Conversation come from that Session's durable mapping, so two
     * sessions open at once each read their own — and switching between them
     * changes which one the controls act on. Without a session id there is no
     * attribution to report: the whole-home Thread list is still returned, but
     * `threadId` is `null`, because "the most recently touched Thread" is a
     * different question and answering it here is how one session's operations
     * end up landing on another's Thread.
     * @param options.sessionId - the Session on screen, when the caller knows it.
     * @returns the connection state, the Threads this home holds, and the Run
     *   the panel draws for that Session.
     */
    async state({ sessionId, threadId, conversationId: selectedConversationId } = {}) {
      /** The Core's address and how the link is doing, read at the moment of the answer. */
      const base = () => ({
        core: {
          home: options.home,
          socketPath: options.socketPath,
          lockFile: options.lockFile,
          error: lastError,
          lastOkAt: lastOkAt === null ? null : new Date(lastOkAt).toISOString(),
        },
      });
      const known = typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
      /**
       * The bridge's own record, and why it could not be read.
       *
       * Read here, outside the link's own failure handling: a corrupt
       * `sessions.json` is not the Core being unreachable, and reporting it as
       * one would send the reader to reconnect a link that is fine. A record
       * that cannot be read is *not* an empty one either — that is the guess
       * this file exists to refuse — so the failure is named rather than
       * swallowed.
       */
      let map = null;
      let sessionError = null;
      try {
        map = await resolveSessionMap();
        if (map === null && !threadId) {
          sessionError = {
            code: "NOT_SUPPORTED",
            message: "this bridge has no record of which Thread a session runs on",
          };
        }
      } catch (error) {
        sessionError = {
          code: typeof error?.code === "string" ? error.code : "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        const [info, threads] = await Promise.all([client.getServerInfo(), client.listThreads()]);
        const items = threads.items ?? [];
        const selectedThread = threadId ? await client.getThread(threadId) : null;
        const { thread, conversationId } = selectedThread
          ? { thread: selectedThread, conversationId: selectedConversationId || selectedThread.mainConversationId }
          : known === null || map === null
            ? { thread: null, conversationId: null }
            : await threadForSession(client, map, known);
        if (selectedConversationId && thread &&
            (await client.getConversation(selectedConversationId)).threadId !== thread.threadId) {
          throw new CoreServiceError("INVALID_REQUEST", "conversation is not in the selected Thread");
        }
        let run = null;
        if (thread !== null && (thread.activeRuns ?? []).length > 0) {
          const runId = thread.activeRuns[0];
          const [view, turns] = await Promise.all([client.getRun(runId), client.listTurns(runId)]);
          run = runSummaryOf(view, turns.items);
        }
        /**
         * The Session's fixed Conversation, as the Core describes it.
         *
         * This is what the panel's config snapshot card draws, and it is read
         * here because the panel has no path to the Core of its own: the card
         * can show what this answer carries and nothing else. The read is the
         * Conversation's own public view — the agent, the two revisions and the
         * config — so nothing about this home is inferred to fill a field in.
         *
         * Its failure is its own, and it is read the way `sessionError` is: the
         * link can be up and the Session's identity known while this one read
         * fails, so it does not touch `connection` and does not fail the state
         * read. A config that could not be read is not a Core that is
         * unreachable, and reporting it as one would send the reader to
         * reconnect a link that is fine.
         *
         * Only the fields the card draws are carried. The Conversation's own
         * view also holds this home's paths (`cwd`, `workspaceRoots`), and those
         * are left behind: a card that never draws a path is no reason to put
         * one in the browser's copy of the state.
         */
        let snapshot = null;
        let snapshotError = null;
        if (conversationId !== null) {
          const text = (value) => (typeof value === "string" && value !== "" ? value : null);
          try {
            const conversation = await client.getConversation(conversationId);
            const config = conversation?.config ?? null;
            snapshot = {
              // The Session and the Conversation this was read for. They travel
              // with the config so a reader can tell whose configuration it is,
              // and so an answer that arrives after the panel has moved on is
              // not drawn under another session's name.
              sessionId: known,
              conversationId,
              agentId: text(conversation?.agentId),
              agentRevision: text(conversation?.agentRevision),
              configRevision: text(conversation?.configRevision),
              config: {
                provider: text(config?.provider),
                modelId: text(config?.modelId),
                thinkingLevel: text(config?.thinkingLevel),
                permissionMode: text(config?.permissionMode),
                ...(conversation?.modelCapabilities === undefined ? {} : {
                  modelCapabilities: conversation.modelCapabilities,
                }),
                skillRoots: Array.isArray(config?.skillRoots)
                  ? config.skillRoots.filter((root) => typeof root === "string")
                  : [],
              },
            };
          } catch (error) {
            snapshotError = {
              code: typeof error?.code === "string" ? error.code : "INTERNAL",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }
        // The read itself is a successful contact, so it counts as one: the
        // panel's "last answered at" would otherwise only move when the user
        // pressed something, which is the opposite of what it says.
        lastError = null;
        lastOkAt = now();
        return {
          ...base(),
          connection: "ready",
          info,
          eventSeq: thread?.eventSeq ?? info?.eventSeq ?? null,
          threads: items,
          sessionId: known,
          threadId: thread?.threadId ?? null,
          conversationId,
          // The Thread's own main Conversation, so a reader can tell the
          // session's Conversation from it: equal means the session shows the
          // Thread's line, different means it shows a fork.
          mainConversationId: thread === null ? null : String(thread.mainConversationId),
          sessionError,
          // The config snapshot, and why it could not be read. Both are `null`
          // when there is no Conversation to read one from.
          snapshot,
          snapshotError,
          run,
        };
      } catch (error) {
        lastError = {
          code: typeof error?.code === "string" ? error.code : "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        };
        return {
          ...base(),
          connection: "offline",
          info: null,
          threads: [],
          sessionId: known,
          threadId: null,
          conversationId: null,
          mainConversationId: null,
          sessionError,
          // No Conversation was reached, so no config was read: the snapshot is
          // absent for the same reason the Thread is, not because it failed.
          snapshot: null,
          snapshotError: null,
          run: null,
        };
      }
    },
    /**
     * The committed events of the Threads this bridge cares about.
     *
     * Passed through to the SDK's own subscription rather than re-implemented:
     * resuming from `after` is the SDK's cursor rule, and a second copy of it
     * here would be a second answer to "what did I already see".
     * @param options.after - the last seq the caller already holds.
     * @param options.threadId - restrict to one Thread.
     * @param options.live - also carry the frames that are not durable.
     * @param options.signal - stop the subscription.
     */
    subscribe({ after, threadId, live, signal } = {}) {
      return client.subscribe({
        ...(after === undefined ? {} : { after }),
        // `threadIds` is an array in the SDK, and it is *not* the same field as
        // the singular name this service's callers use: passing the wrong one
        // subscribes to every Thread and looks like it worked.
        ...(threadId === undefined ? {} : { threadIds: [threadId] }),
        ...(live === undefined ? {} : { live }),
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}

/**
 * Build a service over a real socket.
 *
 * The SDK is imported here rather than at the top of the file, and that is not
 * tidiness. The host half is loaded by the Harness from a profile, and the
 * Harness resolves specifiers by its own rules; a static import of a package
 * that is not in the profile would make this *module* unloadable, which would
 * take the whole plugin down — including the parts that never talk to a Core.
 * A deferred import fails at the call instead, where the failure is about the
 * thing that was actually missing.
 * @param options.options - the Core's address; defaults to {@link resolveCoreOptions}.
 * @param options.caller - the identity the Core records for these calls.
 * @param options.client - an SDK client, when the caller already has one.
 * @param options.now - clock.
 * @param options.sessionMap - the durable Session↔Thread record, as a provider.
 * @returns the service.
 */
export async function createCoreServiceFor({
  options = resolveCoreOptions(),
  caller = "dsh-bridge",
  client,
  now,
  sessionMap = null,
} = {}) {
  const connection = {
    ...(options.baseUrl ? { baseUrl: options.baseUrl, accessToken: options.accessToken, expectedInstanceId: options.expectedInstanceId, ...(options.ca ? { ca: options.ca } : {}) } : { socketPath: options.socketPath }), caller,
  };
  const module = await import("@super-agent/client");
  const sdk = client ?? module.createClient(connection);
  const settingsClient = module.createSettingsClient?.(connection);
  return createCoreService({ client: sdk, settingsClient, options, sessionMap, ...(now === undefined ? {} : { now }) });
}

/* ------------------------------------------------------------------ routes */

/**
 * Whether a request came from the Harness's own window.
 *
 * The same check the sibling design plugin makes, and for the same reason: the
 * routes are on a loopback server, but "loopback" is not an authorization — a
 * page the user happens to be visiting can reach 127.0.0.1. So the origin, the
 * fetch site and the host all have to agree that this is the Harness.
 * @param req - the request.
 * @returns whether to serve it.
 */
export function isTrustedRequest(req) {
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  try {
    const target = new URL(`http://${host}`);
    return (
      ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
      req.headers?.["sec-fetch-site"] !== "cross-site" &&
      (origin === undefined || origin === "dsh-app://app" || new URL(origin).host === target.host)
    );
  } catch {
    return false;
  }
}

/** Read a JSON request body, bounded so a malformed client cannot grow it without limit. */
async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new CoreServiceError("INVALID_REQUEST", "the request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CoreServiceError("INVALID_REQUEST", "the request body is not JSON");
  }
}

/** The HTTP status a Core error code maps to, for the routes' own answers. */
const STATUS_BY_CODE = {
  INSTANCE_CHANGED: 409,
  PROTOCOL_INCOMPATIBLE: 502,
  INVALID_REQUEST: 400,
  LOCAL_ARTIFACT_REJECTED: 400,
  LOCAL_ARTIFACT_REVIEW_REQUIRED: 409,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CURSOR_EXPIRED: 410,
  NOT_SUPPORTED: 501,
  INTERNAL: 500,
};

/**
 * Register the browser-facing routes.
 *
 * `effect` is the plugin's own lifetime: every registration is undone when the
 * plugin unloads, so a reload does not leave the old routes answering.
 *
 * `service` may be the service itself or a function returning it. The function
 * form is what the host uses, and it is why registration can be synchronous:
 * building the service imports the SDK, and an import that had to finish before
 * the routes existed would make "the browser asked too early" a 404 with no
 * handler to explain it. Resolving per request moves that wait onto the request
 * that needs it, and a service is built once no matter how many requests await it.
 * @param options.webServer - DSH's web server, with `register`.
 * @param options.effect - the plugin's effect registration.
 * @param options.service - the service built by {@link createCoreService}, or a
 *   function returning it (or a promise of it).
 * @param options.log - a logger; failures are reported rather than dropped.
 * @returns the registered paths.
 */
export function registerCoreRoutes({ webServer, effect, service, log }) {
  const resolveService = async () => (typeof service === "function" ? await service() : service);

  const reply = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const guard = (handler) => async (req, res) => {
    if (!isTrustedRequest(req)) return reply(res, 403, { error: "only the Harness's own window may call this" });
    try {
      await handler(req, res);
    } catch (error) {
      const code = error instanceof CoreServiceError ? error.code : "INTERNAL";
      const status = STATUS_BY_CODE[code] ?? 500;
      if (status >= 500) log?.error?.(error);
      reply(res, status, {
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof CoreServiceError ? error.details : null,
        },
      });
    }
  };

  const paths = [];

  effect(() =>
    webServer.register({
      kind: "exact",
      path: `${CORE_ROUTE_PREFIX}/state`,
      handler: guard(async (req, res) => {
        if (req.method !== "GET") return reply(res, 405, { error: { code: "INVALID_REQUEST", message: "use GET" } });
        // The Session the browser half is showing travels as a query parameter
        // because it is part of *what is being read*, not a command: the same
        // question asked from two panels has two different answers.
        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionId = url.searchParams.get("sessionId");
        reply(res, 200, await (await resolveService()).state({
          ...(sessionId === null ? {} : { sessionId }),
          ...(url.searchParams.has("threadId") ? { threadId: url.searchParams.get("threadId") } : {}),
          ...(url.searchParams.has("conversationId") ? { conversationId: url.searchParams.get("conversationId") } : {}),
        }));
      }),
    }),
  );
  paths.push(`${CORE_ROUTE_PREFIX}/state`);

  effect(() =>
    webServer.register({
      kind: "exact",
      path: `${CORE_ROUTE_PREFIX}/action`,
      handler: guard(async (req, res) => {
        if (req.method !== "POST") return reply(res, 405, { error: { code: "INVALID_REQUEST", message: "use POST" } });
        const body = await readJsonBody(req, 32 * 1024 * 1024);
        const result = await (await resolveService()).call(body.action, body.payload ?? {});
        reply(res, 200, { ok: true, result });
      }),
    }),
  );
  paths.push(`${CORE_ROUTE_PREFIX}/action`);

  /**
   * The committed-event stream.
   *
   * Relayed rather than re-derived: the SDK already knows how to resume from a
   * cursor and when to give up on one. The browser cursor pairs the Core's seq
   * with its target and instance, so reconnecting after a target switch cannot
   * carry the old Core's cursor into the new stream.
   */
  effect(() =>
    webServer.register({
      kind: "exact",
      path: `${CORE_ROUTE_PREFIX}/events`,
      handler: guard(async (req, res) => {
        if (req.method !== "GET") return reply(res, 405, { error: { code: "INVALID_REQUEST", message: "use GET" } });
        const url = new URL(req.url ?? "/", "http://localhost");
        const query = url.searchParams.get("after");
        const service = await resolveService();
        const eventScope = service.eventScope?.();
        const cursorScope = eventScope === undefined ? null : Buffer.from(eventScope).toString("base64url");
        const lastEventId = req.headers["last-event-id"];
        const scopedCursor = typeof lastEventId === "string" ? /^([A-Za-z0-9_-]+):([0-9]+)$/.exec(lastEventId) : null;
        const after = query !== null ? Number(query) : cursorScope === null
          ? lastEventId !== undefined ? Number(lastEventId) : undefined
          : scopedCursor?.[1] === cursorScope ? Number(scopedCursor[2]) : undefined;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        const controller = new AbortController();
        const close = () => controller.abort();
        req.on("close", close);
        try {
          const events = service.subscribe({
            ...(Number.isSafeInteger(after) ? { after } : {}),
            ...(eventScope === undefined ? {} : { expectedEventScope: eventScope }),
            live: true,
            signal: controller.signal,
          });
          for await (const event of await events) {
            if (event.kind === "committed") {
              // The default message, with the type inside the JSON rather than
              // as an SSE `event:` name. A named event only reaches a listener
              // registered for that exact name, so naming them would make the
              // browser carry a copy of the Core's event vocabulary — a copy
              // that goes stale the first time the Core grows a type. The
              // browser half has no way to import the protocol's own list, so
              // the wire carries it instead.
              res.write(`id: ${cursorScope === null ? "" : `${cursorScope}:`}${event.event.seq}\ndata: ${JSON.stringify(event.event)}\n\n`);
            } else {
              // No `id:` line: a live frame is not durable, and giving it one
              // would make the browser resume from a seq the Core never wrote.
              res.write(`event: live\ndata: ${JSON.stringify(event.frame)}\n\n`);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) log?.warn?.(error);
        } finally {
          req.off("close", close);
          res.end();
        }
      }),
    }),
  );
  paths.push(`${CORE_ROUTE_PREFIX}/events`);

  return paths;
}
