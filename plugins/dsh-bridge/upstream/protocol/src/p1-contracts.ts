/**
 * The Thread service contract (design §4–§5.3, §5.7).
 *
 * This file is the *public* shape of the Thread surface: what a caller sends, what
 * it gets back, and the pure rules both sides apply to the same bytes. It is not a
 * second domain model. The Agent Loop's own `Thread`/`Conversation`/`Run`/`Turn`
 * records stay the truth; what is here is their projection onto the wire, plus the
 * vocabulary the projection is allowed to use.
 *
 * Three rules hold across the whole file:
 *
 * - **Absent is `null`, never optional.** Every field a view carries is declared.
 *   A JSON body that omits a field and one that sends `null` must not be two
 *   different states, because a client cannot tell them apart after parsing.
 * - **Timestamps are ISO 8601 strings.** Durable records hold epoch milliseconds;
 *   the projection converts once, at the boundary, so no caller has to guess.
 * - **Ids are opaque strings.** The Core's own ids (`thr_…`, `run_…`) are already
 *   strings; a Conversation id is a number underneath (Pi's native id) and is
 *   carried as its decimal text here, so the wire never depends on that detail.
 *
 * Nothing in this file reads storage, schedules work or decides whether a command
 * is allowed. It is types, constants and pure functions — the protocol package has
 * no runtime dependencies at all, so it stays usable in the browser.
 */
import type { BlockingReason, ReceiptState } from "./views.js";
import type { FileInputPolicy } from "./workspace-files.js";

/* ------------------------------------------------------------------ vocabulary */

/** The Thread statuses of the Agent Loop's aggregator, on the wire. */
export const THREAD_STATUSES = [
  "idle",
  "running",
  "waiting",
  "completed",
  "paused_by_user",
  "failed",
  "archived",
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export function isThreadStatus(value: string): value is ThreadStatus {
  return (THREAD_STATUSES as readonly string[]).includes(value);
}

export const RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

/** The two statuses a Run is in when it has stopped for good. */
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export const WAITING_REASONS = ["tool", "subagent", "user", "permission", "retry", "file_input"] as const;

export type WaitingReason = (typeof WAITING_REASONS)[number];

export function isWaitingReason(value: string): value is WaitingReason {
  return (WAITING_REASONS as readonly string[]).includes(value);
}

export const RUN_END_REASONS = [
  "final_answer",
  "user_stop",
  "thread_archived",
  "thread_failed",
  "config_changed",
  "timeout",
  "model_failure",
  "capacity",
  "permission_failure",
] as const;

export type RunEndReason = (typeof RUN_END_REASONS)[number];

export const TURN_STATUSES = ["preparing", "requesting", "tools", "closed", "failed"] as const;

export type TurnStatus = (typeof TURN_STATUSES)[number];

export const MESSAGE_KINDS = [
  "system",
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "core",
  "agent_message",
  "compaction",
  "observation",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_SOURCES = ["core", "user", "agent", "tool", "subagent"] as const;

export type MessageSource = (typeof MESSAGE_SOURCES)[number];

export const PERMISSION_MODES = ["approve_all", "workspace_auto", "approve_none"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/** How an accepted input is meant to land. */
export const INPUT_DELIVERIES = ["new_run", "next_turn"] as const;

export type InputDelivery = (typeof INPUT_DELIVERIES)[number];

export function isInputDelivery(value: string): value is InputDelivery {
  return (INPUT_DELIVERIES as readonly string[]).includes(value);
}

/** How a redo re-runs its Run. */
export const REDO_MODES = ["same_conversation", "fork"] as const;

export type RedoMode = (typeof REDO_MODES)[number];

export function isRedoMode(value: string): value is RedoMode {
  return (REDO_MODES as readonly string[]).includes(value);
}

export const WAIT_KINDS = ["user", "permission", "file_input"] as const;

export type WaitKind = (typeof WAIT_KINDS)[number];

export const WAIT_STATUSES = ["waiting", "answered", "cancelled"] as const;

export type WaitStatus = (typeof WAIT_STATUSES)[number];

/* ------------------------------------------------------------------ ids */

/**
 * A Conversation id on the wire.
 *
 * The durable id is Pi's native number (`NativeConversationId`). Carrying it as
 * decimal text keeps the wire contract independent of that representation: a
 * client treats it as an opaque string, and the Core parses it back. The two
 * functions below are the *only* place that conversion happens, so a client that
 * round-trips an id gets the same bytes back.
 */
export function toConversationId(value: number): string {
  return String(value);
}

/** Parses a Conversation id from the wire; `null` when it is not a non-negative integer. */
export function parseConversationId(raw: string): number | null {
  if (raw === "" || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/* ------------------------------------------------------------------ pagination */

/** Items per page when the caller does not ask. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Items per page when the caller asks for more. The Core never returns more. */
export const MAX_PAGE_LIMIT = 200;

/**
 * The page size to use for a requested one.
 *
 * A missing limit gets the default and an oversized one is clamped; only a value
 * that cannot be a page size at all (negative, fractional, not a number) is
 * refused, because silently turning `-1` into `50` would answer a different
 * question than the one that was asked.
 */
export function resolvePageLimit(requested: number | undefined): number | null {
  if (requested === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) return null;
  return Math.min(requested, MAX_PAGE_LIMIT);
}

/**
 * An opaque forward cursor.
 *
 * Deliberately opaque: it encodes a position in *this* listing, and a client that
 * parsed it would start depending on an ordering the Core is free to change. It is
 * URL-safe base64 of a small JSON object, and `decodeCursor` returns `null` for
 * anything it did not produce.
 */
export function encodeCursor(offset: number): string {
  const json = JSON.stringify({ o: offset });
  const base64 = base64Encode(json);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The offset a cursor names; `null` when the cursor was not produced by {@link encodeCursor}. */
export function decodeCursor(cursor: string): number | null {
  if (cursor === "" || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
  const json = base64Decode(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const offset = (parsed as { readonly o?: unknown }).o;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;
  return offset;
}

/** One page of a listing, with the cursor for the next one (`null` at the end). */
export type Page<T> = {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

/**
 * `btoa`/`atob` are globals in Node and in the browser; the protocol package may not
 * import either runtime's own modules. The payload is ASCII JSON, so the Latin-1
 * restriction of these functions never bites.
 */
declare const btoa: (input: string) => string;
declare const atob: (input: string) => string;

function base64Encode(text: string): string {
  return btoa(text);
}

function base64Decode(text: string): string | null {
  try {
    return atob(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ receipts */

/**
 * The receipt every state-changing Thread command returns.
 *
 * `state` is carried through from the Core unchanged and says only that the
 * command's acceptance is durable — never that the work is done (design §4.2).
 * `receiptSeq` is the seq of the commit that accepted it, so a client that
 * subscribes from there sees everything that follows.
 */
export type CommandReceipt = {
  readonly requestId: string;
  readonly resourceId: string;
  readonly state: ReceiptState;
  readonly receiptSeq: number;
};

/**
 * The receipt for input delivery, which also names the Run the input landed in and the
 * message the accepted input became.
 *
 * `messageId` is the stable id the Core files the accepted input under: it is derived from
 * the input's own durable identity rather than from the entry it later becomes, so it is the
 * same id the message listing returns once that entry appears. A client that received this
 * receipt therefore holds the id of the message its input became before any entry exists to
 * name it, and a replay of the same request holds the same id — a duplicate acceptance
 * returns the receipt the first one produced.
 */
export type InputReceipt = CommandReceipt & {
  readonly inputId: string;
  readonly runId: string;
  readonly delivery: InputDelivery;
  readonly messageId: string;
};

/* ------------------------------------------------------------------ thread views */

/** One line of `GET /v1/threads`. */
export type ThreadSummary = {
  readonly deletedAt?: string | null;
  readonly recoverUntil?: string | null;
  readonly recoveryExpired?: boolean;
  readonly title?: string | null;
  readonly pinned?: boolean;
  readonly threadId: string;
  readonly mainConversationId: string;
  readonly status: ThreadStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * One Run of a Thread, as the Thread's own view names it.
 *
 * `runs` is the *discovery* list: every Run the Thread has ever had, on its main line and on
 * every fork of it, so a caller can find work it did not create. It carries the owning
 * `conversationId` — a Run belongs to exactly one line — and the Run's `status`, which is what
 * lets a caller pick out the cancelled Runs a resume may continue without reading each Run in
 * turn. Anything beyond that is `getRun`'s job.
 */
export type ThreadRunRef = {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunStatus;
};

/**
 * One input accepted and still waiting to be chosen, with the line that owns it.
 *
 * This is the identity `ResumeThreadRequest.queuedInputs[].inputId` names. The set is "still
 * waiting", not "ever accepted": an input leaves it when a Run takes it, so a resume is never
 * offered something already dispatched.
 */
export type ThreadQueuedInputRef = {
  readonly inputId: string;
  readonly conversationId: string;
};

export type ThreadView = {
  readonly deletedAt?: string | null;
  readonly recoverUntil?: string | null;
  readonly recoveryExpired?: boolean;
  readonly title?: string | null;
  readonly pinned?: boolean;
  readonly threadId: string;
  readonly mainConversationId: string;
  readonly status: ThreadStatus;
  /** Why the Thread is not progressing, most decisive first. Empty when it is. */
  readonly blockingReasons: readonly BlockingReason[];
  readonly controlRevision: number;
  /** Runs advancing right now. */
  readonly activeRuns: readonly string[];
  /** Runs accepted and waiting for the scheduler. */
  readonly queuedRuns: readonly string[];
  /**
   * Every Run of this Thread, over its main line and every fork of it. Terminal Runs stay in
   * the list, so a Run that has stopped for good is still discoverable.
   *
   * The order is the main line first, then each other line in the order that line's own index
   * holds its Runs. It is **not** all lines merged by creation time — a fork's older Run can
   * follow the main line's newer one — and it is **not** a single-transaction snapshot of the
   * whole Thread: the view walks the Thread's lines one at a time, so a Run that commits
   * between two of those reads can be missing here. A command that acts on this list
   * revalidates inside its own transaction rather than trusting it.
   */
  readonly runs: readonly ThreadRunRef[];
  /**
   * Inputs still waiting to be chosen — the set `resume` selects from.
   *
   * The same read that produced `pendingInputs`, so `queuedInputIds.length === pendingInputs`
   * holds for one view. The same caveat as `runs` applies: this is not a Thread-wide
   * transaction.
   */
  readonly queuedInputIds: readonly ThreadQueuedInputRef[];
  readonly pendingInputs: number;
  readonly pendingWaits: number;
  readonly activeDelegations: number;
  readonly pendingDeliveries: number;
  /**
   * Highest committed event seq at or before the moment the view was read.
   *
   * At or before, not after: the view walks the Thread's lines one at a time, so a watermark taken
   * after the read could sit above a fact the view missed and the replay from it would skip that
   * fact (see `runs`).
   */
  readonly eventSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** The client-side reference a Thread was created for; lookup only, never a rule. */
export type ClientRef = {
  readonly client: string;
  readonly sessionId: string;
};

export type CreateThreadRequest = {
  readonly requestId: string;
  readonly agentId: string;
  readonly workspaceId?: string | null;
  /** Absolute working directory; must be inside the Workspace's roots. */
  readonly cwd?: string | null;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly permissionMode?: PermissionMode;
  readonly skillRoots?: readonly string[];
  readonly clientRef?: ClientRef;
  /** A selected immutable input. It is not a client filesystem path. */
  readonly fileInput?: FileInputPolicy;
  readonly fileBranchId?: string;
};

export type CreateThreadResult = {
  readonly threadId: string;
  readonly mainConversationId: string;
  readonly configRevision: string;
  readonly status: ThreadStatus;
};

/** A non-secret model entry the Core currently exposes for new Threads. */
export type ModelCatalogEntry = {
  /** The exact Pi model id accepted by `CreateThreadRequest.modelId`. */
  readonly id: string;
  /** The runtime provider id accepted by the Conversation config. */
  readonly provider: string;
  readonly name: string;
  /** False when `id` is published by more than one provider and cannot be selected alone. */
  readonly selectable: boolean;
  /** A stable, non-secret reason when the entry cannot be selected. */
  readonly unavailableReason?: string;
  readonly supportedThinkingLevels?: readonly string[];
  readonly capabilities?: ConversationModelCapabilities;
  readonly capabilitySource?: ConversationModelCapabilities["source"];
};

export type InputMaterialRef = {
  readonly kind: "file" | "reference" | "image";
  readonly snapshotId: string; readonly path: string; readonly source?: string; readonly mediaType?: string;
};
export type InputMaterialView = {
  readonly kind: "file" | "reference" | "image" | "skill";
  readonly snapshotId: string; readonly path: string; readonly source: string; readonly mediaType: string;
  readonly contentHash: string; readonly size: number; readonly status: "available";
  readonly attachmentId?: string;
  readonly representationId?: string;
  readonly mode?: "inline" | "range" | "on_demand" | "image";
  readonly format?: "text" | "image";
  readonly range?: { readonly start: number; readonly end: number; readonly offset?: number };
};
export type SelectedSkillRef = {
  readonly skillId: string; readonly sourceId: string; readonly version: string;
  readonly sourceRevision: number; readonly policyRevision: number;
};
export type SubmitInputRequest = {
  readonly preparedAttachments?: readonly import("./attachments.js").PreparedAttachmentUse[];
  readonly previewId?: string;
  readonly previewSignature?: string;
  readonly selectedSkillRefs?: readonly SelectedSkillRef[];
  readonly materials?: readonly InputMaterialRef[];
  readonly selectedSkillIds?: readonly string[];
  readonly requestId: string;
  readonly text: string;
  readonly requiredFiles?: readonly string[];
  readonly delivery?: InputDelivery;
  /** New Runs only. Fixed snapshots execute on an independent verification branch. */
  readonly fileInput?: FileInputPolicy;
  readonly fileBranchId?: string;
  /**
   * Required for `next_turn`: the Run the supplement belongs to. The design forbids
   * resolving it as "whatever is active" — between the lookup and the write the Run
   * can end, and the supplement then lands on a Run that will never read it.
   */
  readonly targetRunId?: string;
  /**
   * The Conversation this input belongs to, as `toConversationId` renders it.
   *
   * Absent means the Thread's main Conversation, which is what every caller that has
   * no fork to address means — and the Core treats absence that way rather than
   * guessing at another Conversation. A named Conversation is not a hint: the Core
   * refuses the input outright when it is not one of the Thread's own, and refuses a
   * `requestId` that was already accepted into a different one. Answering with the
   * main Conversation instead would put a fork's message on a line of history the
   * caller did not address, and nothing in the receipt would say so.
   */
  readonly conversationId?: string;
};

export type ResolveFileDependencyRequest = {
  readonly requestId: string;
  readonly expectedFileRevision: number;
  readonly choice: "last_success" | "partial" | "cancel";
  readonly paths?: readonly string[];
};
export type ResolveFileDependencyResult = {
  readonly receipt: CommandReceipt;
  readonly runId: string;
  readonly choice: ResolveFileDependencyRequest["choice"];
  readonly snapshotId: string | null;
  readonly affectedRunIds: readonly string[];
};
export type FileDependencyReview = {
  /** Accepted file selection awaiting the Core receipt; another client can resume the exact command. */
  readonly pendingDecision?: ResolveFileDependencyRequest & { readonly snapshotId: string | null };
  readonly run: RunView;
  readonly fileRevision: number;
  readonly branch: import("./workspace-files.js").FileBranch;
  readonly currentSuccessful: import("./workspace-files.js").FileSnapshot;
  readonly predecessorRunId: string;
  readonly artifacts: import("./workspace-files.js").RunFileArtifacts | null;
  readonly affectedRunIds: readonly string[];
};

export type StopThreadRequest = {
  readonly requestId: string;
  readonly reason?: string;
};

export type ThreadControlRequest = {
  readonly requestId: string;
};

/**
 * What a resume may do with the work a stop left behind.
 *
 * Every list is explicit and every unlisted item keeps its current state: the
 * design's rule is that resuming is an instruction, not an inference, so a Run the
 * caller did not name stays cancelled and an input it did not name stays queued.
 * Answering an `ask_user` or permission wait is *not* done here — that resumes the
 * Run it belongs to directly (design §5.2).
 */
export type ResumeThreadRequest = {
  readonly requestId: string;
  /** Cancelled Runs to continue: each gets a new Run that links back to it. */
  readonly continueRunIds?: readonly string[];
  /** Queued inputs to place into a Run, or to drop. */
  readonly queuedInputs?: readonly QueuedInputDecision[];
  /** Reports still suppressed: hand to a later Run, or leave suppressed. */
  readonly suppressedReports?: readonly SuppressedReportDecision[];
};

export type QueuedInputDecision = {
  readonly inputId: string;
  readonly action: "run" | "drop";
};

export type SuppressedReportDecision = {
  readonly delegationId: string;
  readonly action: "deliver" | "keep_suppressed";
};

export type ResumeThreadResult = CommandReceipt & {
  /** Runs minted by `continueRunIds`, in the order the request named them. */
  readonly startedRunIds: readonly string[];
};

/* ------------------------------------------------------------------ conversation */

export type ConversationConfigView = {
  readonly modelSource?: "service_default" | "conversation_override";
  readonly thinkingSource?: "service_default" | "model_default" | "conversation_override";
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string | null;
  readonly permissionMode: PermissionMode;
  readonly permissionSource?: "service_default" | "conversation_override";
  readonly cwd: string | null;
  readonly workspaceRoots: readonly string[];
  readonly skillRoots: readonly string[];
  readonly maxOutputTokens: number | null;
};

/** Capabilities recorded in the Conversation's fixed model binding. */
export type ConversationModelCapabilities = {
  readonly input: readonly ("text" | "image")[];
  readonly tools: boolean;
  readonly thinking: boolean;
  readonly toolResultImages: "native" | "synthetic_user" | "unsupported";
  readonly maxImages?: number;
  readonly maxRequestBytes?: number;
  readonly source: "pi-1.3.0-and-protocol" | "operator_declared";
};

export type ConversationView = {
  readonly conversationId: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly agentRevision: string;
  readonly config: ConversationConfigView;
  readonly configRevision: string;
  readonly pendingConfig?: { readonly invalidReason?: string; readonly configRevision: string; readonly blockingRunId: string; readonly config: ConversationConfigView } | null;
  readonly modelCapabilities?: ConversationModelCapabilities;
  /** Inheritance boundary when this Conversation was forked; `null` for a fresh one. */
  readonly inheritedThrough: number | null;
  readonly createdAt: string;
};

/**
 * A configuration edit.
 *
 * `expectedConfigRevision` is the caller's view of the revision it is editing.
 * A mismatch is `VERSION_CONFLICT` — deliberately not `IDEMPOTENCY_CONFLICT`,
 * which is about the same `requestId` arriving with different content: a stale
 * edit is a different failure, and a caller has to do a different thing about it.
 */
export type UpdateConversationConfigRequest = {
  readonly requestId: string;
  readonly expectedConfigRevision: string;
  readonly patch: ConversationConfigPatch;
};

export type ConversationConfigPatch = {
  /** Resolve and freeze the current service model and its generation defaults. */
  readonly modelSource?: "service_default";
  readonly permissionSource?: "service_default" | "conversation_override";
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly permissionMode?: PermissionMode;
  readonly maxOutputTokens?: number;
  readonly skillRoots?: readonly string[];
};

export type UpdateConversationConfigResult = CommandReceipt & {
  readonly configRevision: string;
  readonly pendingConfig?: ConversationView["pendingConfig"];
  /** Work pinned to the old revision, cancelled as `config_changed`. */
  readonly invalidatedRunIds: readonly string[];
};

/* ------------------------------------------------------------------ waits */

/**
 * The body of `POST /v1/waits/{waitId}:answer`.
 *
 * `answer` is the text the question was asked for; it is stored verbatim and is *not* a
 * permission grant — answering "yes" to a question never authorises an action, which is
 * why the permission path below is a separate call with a separate decision.
 */
export type AnswerWaitRequest = {
  readonly requestId: string;
  readonly answer: string;
};

/** The body of `POST /v1/waits/{waitId}:resolve`. */
export type ResolvePermissionRequest = {
  readonly requestId: string;
  readonly decision: "allow" | "deny";
  readonly reason?: string;
  /**
   * The policy revision the decision was made against.
   *
   * Declared because a client that read the revision should be able to say so, and the
   * Core's permission path revalidates the policy itself before releasing a guarded
   * action. A build that cannot check it must say so rather than appear to.
   */
  readonly policyRevision?: number;
};

/* ------------------------------------------------------------------ messages */

/**
 * One business message, as a client needs it to rebuild its view.
 *
 * `text` is the projected body: the Core rebuilds it from the Pi entry the message
 * points at, so a client that reconnects after a restart sees the same history
 * without holding a copy of its own. It is `null` for messages that carry only
 * structure (a tool call with no text, a core state update).
 */
export type MessageView = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly kind: MessageKind;
  readonly role: MessageRole;
  readonly source: MessageSource;
  /**
   * The accepted input this user message came from.
   *
   * This is additive and optional because older projections did not retain the association.
   * The accepted Run is also used as `runId` for a user message, which has no Turn owner.
   */
  readonly input?: {
    readonly inputId: string;
    readonly runId: string;
    readonly delivery: "new_run" | "next_turn";
  };
  /**
   * The Run and Turn this message belongs to, when the reader can tell.
   *
   * Both are facts about the Turn, and the Turn is settled later than the message — so the
   * projection does not store them and a reader derives them from the Turn record. They are
   * `null` when nothing derives them yet, which is different from "this message belongs to
   * no Turn" and is stated rather than guessed.
   */
  readonly runId: string | null;
  readonly turnId: string | null;
  readonly toolCallId: string | null;
  /** Additive call detail; older stored projections omit this field. */
  readonly toolCall?: { readonly name: string; readonly arguments: string };
  /** Explicit native result status; absent when older source evidence is unavailable. */
  readonly toolResult?: { readonly isError: boolean };
  /** Pi entry this message was projected from, when one exists. */
  readonly entryId: number | null;
  readonly text: string | null;
  /** Provider-returned content blocks; no synthetic reasoning. */
  readonly fragments?: readonly { readonly type: "text" | "thinking"; readonly text: string }[];
  /** True only for the successful Run settlement's final assistant message. */
  readonly isFinal?: boolean;
  readonly materials?: readonly InputMaterialView[];
  readonly selectedSkillIds?: readonly string[];
  readonly createdAt: string;
  /** The message this one was inherited from, when a fork carried it over. */
  readonly origin: { readonly conversationId: string; readonly messageId: string } | null;
  /**
   * The generation a live frame named while this message was being produced.
   *
   * A client replaces accumulated deltas with this message by matching the frame's
   * `messageId` against this key. `null` means nothing reserved a generation, which is a
   * different statement from the message having had no live frames.
   */
  readonly generationKey: string | null;
};

export type MessageQuery = {
  /** Exclusive lower bound: return messages after this one. */
  readonly afterMessageId?: string;
  readonly cursor?: string;
  readonly limit?: number;
};

/**
 * One page of a conversation's messages, with what the reader knows about the rest.
 *
 * A page is not just its items. `watermark` is the last native entry the projection has
 * consumed — the position the history is known to be complete *up to* — and `caughtUp` says
 * whether it has reached the end of what the conversation holds. Without them a reader that
 * saw an empty page could not tell "there is nothing older" from "the projection has not
 * looked yet", which is exactly the distinction a reconnecting client needs.
 *
 * `total` and `range` describe the conversation as the index holds it, so a page that is
 * short because it was filtered is distinguishable from one that is short because the
 * history is.
 */
export type MessagePage = {
  readonly items: readonly MessageView[];
  readonly nextCursor: string | null;
  /** The last native entry the projection consumed; `null` when it has consumed none. */
  readonly watermark: number | null;
  readonly caughtUp: boolean;
  readonly total: number;
  readonly range: { readonly from: number; readonly to: number };
};

/* ------------------------------------------------------------------ runs and turns */

export type RunView = {
  readonly permissionPolicy?: { readonly mode: PermissionMode; readonly source: "service_default" | "conversation_override" };
  readonly runId: string;
  readonly threadId: string;
  readonly conversationId: string;
  readonly status: RunStatus;
  readonly waitingFor: WaitingReason | null;
  readonly endReason: RunEndReason | null;
  readonly error: string | null;
  /** The final answer, once the Run has one. */
  readonly answer: string | null;
  readonly input: string;
  /** Frozen policy is available while queued; a concrete file binding exists only after resolution. */
  readonly fileInput?: FileInputPolicy | null;
  readonly fileBranchId?: string | null;
  readonly fileDependencyBlocked?: boolean;
  readonly fileBinding?: {
    readonly branchId: string;
    readonly cwd: string;
    readonly workspaceRoots: readonly string[];
    readonly inputSnapshotId: string;
    readonly inputHash: string;
  } | null;
  readonly pendingNextTurns: number;
  readonly pendingWaits: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly projectContext?: {
    readonly policy: { readonly autoInstructions: boolean; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly timeoutMs: number };
    readonly loadedBytes: number;
    readonly sources: readonly { readonly path: string; readonly scope: string; readonly status: string; readonly hash: string | null; readonly bytes: number | null }[];
  };
  readonly frozenModel?: { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string | null; readonly configRevision: string };
};

export type TurnView = {
  readonly turnId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly requestRef: string;
  readonly attempt: number;
  readonly status: TurnStatus;
  readonly toolCallIds: readonly string[];
  readonly createdAt: string;
};

/**
 * Re-run a Run.
 *
 * The first cut refuses a Run that took a `next_turn` supplement or answered an
 * `ask_user` question: replaying it would mean guessing which of the follow-ups to
 * keep, and the design would rather say `NOT_SUPPORTED` than invent an answer.
 */
export type RedoRunRequest = {
  readonly requestId: string;
  readonly mode?: RedoMode;
  /** Replacement text for the Run's input; the original is used when absent. */
  readonly edit?: string;
  /** Required when `mode` is `fork`: the entry the copy is taken at. */
  readonly atEntryId?: number;
};

export type RedoRunResult = {
  readonly runId: string;
  readonly conversationId: string;
};

export type ForkConversationRequest = {
  readonly requestId: string;
  /** The entry the fork is taken at; everything after it is not copied. */
  readonly sourceEntryId: number;
  readonly reason?: string;
};

export type ForkConversationResult = {
  readonly conversationId: string;
  readonly threadId: string;
  readonly inheritedThrough: number | null;
};

/* ------------------------------------------------------------------ waits */

export type WaitView = {
  readonly waitId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly kind: WaitKind;
  readonly prompt: string;
  readonly answeredBy?: string | null;
  readonly expiresAt?: string;
  readonly answeredAt?: string | null;
  readonly options?: readonly string[];
  readonly context?: string | null;
  readonly artifactRefs?: readonly string[];
  readonly fileInput?: { readonly path: string; readonly baselineHash: string | null; readonly snapshotId?: string; readonly contentHash?: string };
  readonly status: WaitStatus;
  readonly answer: string | null;
  readonly decision: "allow" | "deny" | null;
};

/* ------------------------------------------------------------------ workspace */

/**
 * A registered Workspace, as the Thread surface needs it.
 *
 * This is the *minimum* the Thread surface uses: enough to look one up by root and
 * to register one when a client creates its first Thread there. The full Workspace
 * management surface (extra roots, ignore rules, changes, revert) is not part of
 * M2 and is not described here.
 */
export type WorkspaceView = {
  readonly workspaceId: string;
  /** Canonical (realpath) main root. */
  readonly root: string;
  /**
   * The Workspace's configuration revision: the digest of its normalised configuration
   * text, so two reads of an unchanged Workspace report the same value and an edited one
   * reports a different value.
   *
   * It is a **string, and `null` means unknown**, never a number. There is no counter to
   * report and inventing one — `0`, say — would be a value a client compares as if it
   * meant something. `null` is the honest answer for a Workspace whose configuration is
   * not readable: the revision is a fact of the text, and without the text there is no
   * fact to report.
   */
  readonly revision: string | null;
  readonly name: string | null;
};

/** `GET /v1/workspaces?root=…`: found or not — never an error for "not registered". */
export type WorkspaceLookupResult = {
  readonly workspace: WorkspaceView | null;
};

export type RegisterWorkspaceRequest = {
  readonly requestId: string;
  readonly root: string;
  readonly name?: string;
};

/** A Core-owned project, below the immutable <Core home>/workspaces container. */
export type ManagedWorkspaceView = WorkspaceView & { readonly relativePath: string };
export type ManagedWorkspaceBrowseView = {
  readonly baseRoot: string;
  readonly relativePath: string;
  readonly root: string;
  readonly exists: boolean;
  readonly limit: number;
  /** Directory scanning or registered-project enumeration reached its bounded budget. */
  readonly truncated: boolean;
  readonly directories: readonly { readonly name: string; readonly relativePath: string; readonly root: string; readonly workspaceId: string | null }[];
  readonly workspaces: readonly ManagedWorkspaceView[];
};
export type OpenManagedWorkspaceRequest = {
  readonly requestId: string;
  /** Nonempty canonical POSIX relative path; never the container itself. */
  readonly relativePath: string;
  /** Explicit confirmation to create missing project directories. */
  readonly createIfMissing: boolean;
};
/** Returned only after the directory exists and the shared registry has completed. */
export type OpenManagedWorkspaceResult = ManagedWorkspaceView & {
  readonly requestId: string;
  readonly state: "ready";
  readonly baseRoot: string;
  readonly directoryCreated: boolean;
};

/* ------------------------------------------------------------------ body readers */

/**
 * The small readers the HTTP layer uses to turn untyped JSON into these shapes.
 *
 * They are here rather than in the server because the SDK and the DSH bridge need
 * the same answers about what a well-formed body is, and two implementations of
 * "is this a non-empty string" is how the two sides drift.
 */
export function readString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value !== "" ? value : null;
}

export function readOptionalString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : null;
}

export function readOptionalInteger(body: Record<string, unknown>, field: string): number | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function readStringArray(body: Record<string, unknown>, field: string): readonly string[] | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  return value.every((item): item is string => typeof item === "string") ? value : null;
}

/**
 * A `ClientRef` from an untyped body: the value, `undefined` when the field is absent,
 * or `null` when it is present but is not one.
 *
 * The two members are both required and both non-empty. A `{client, sessionId}` with an
 * empty `sessionId` is not a reference to anything, and accepting it would store a key
 * that no later lookup can reproduce. Unknown members are refused rather than dropped:
 * a caller that sent `{client, sessionId, extra}` meant something this contract does not
 * carry, and silently discarding the extra would answer a different question.
 */
export function readClientRef(body: Record<string, unknown>, field: string): ClientRef | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("client") || !keys.includes("sessionId")) return null;
  const client = record["client"];
  const sessionId = record["sessionId"];
  if (typeof client !== "string" || client === "" || typeof sessionId !== "string" || sessionId === "") return null;
  return { client, sessionId };
}

export type UpdateThreadMetadataRequest = {
  readonly requestId: string; readonly expectedControlRevision: number;
  readonly title?: string; readonly pinned?: boolean; readonly archived?: false;
};

/** Delete has no recovery grace period. Existing legacy recovery records keep their stored deadline. */
export type ThreadDeletionRequest = { readonly requestId: string; readonly expectedControlRevision: number };

export type ProvideRequiredFileRequest = {
  readonly mode?: "provide" | "new_branch";
  readonly requestId: string; readonly conversationId: string; readonly snapshotId: string; readonly sourcePath: string;
};

export type CompactConversationRequest = { readonly requestId: string; readonly runId: string };
/** Read-only evidence from the effective context after applying its checkpoint.
 * A retained range does not claim that the entire original attachment is present. */
export type CurrentAttachmentContext = {
  readonly status: "available" | "unknown";
  readonly contextRevision: string | null;
  readonly asOf: string;
  readonly basis: "effective_checkpoint_projection";
  readonly checkpointId: string | null;
  readonly items: readonly {
    readonly attachmentId: string;
    readonly representationId: string;
    readonly contentHash: string;
    readonly status: "content_retained" | "reference_only" | "unknown";
    readonly retainedFormats: readonly ("text" | "image")[];
    readonly evidence: readonly {
      readonly source: "user_input" | "tool_result";
      readonly entryId: number;
      readonly formats: readonly ("text" | "image")[];
      readonly range?: import("./attachments.js").AttachmentReturnedRange;
    }[];
    readonly reason: string | null;
  }[];
  readonly reason: string | null;
};
export type ConversationContextView = {
  readonly conversationId: string; readonly configRevision: string; readonly latestRunId: string | null;
  readonly currentAttachments?: CurrentAttachmentContext;
  readonly lastRequest: {
    readonly requestRef: string; readonly runId: string; readonly model: { readonly provider: string; readonly modelId: string };
    readonly estimate: { readonly source: "estimate"; readonly strategy: string; readonly inputTokens: number;
      readonly contextWindow: number; readonly outputReserve: number; readonly otherReserve: number; readonly availableInput: number } | null;
    readonly actualUsage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly total: number } | null;
    readonly projectContext: NonNullable<RunView["projectContext"]> | null;
    readonly systemPromptHash?: string | null;
    readonly systemPrompt?: string | null;
    readonly agentRevision?: string | null;
  } | null;
  readonly nativeAutomaticCompaction: false;
  readonly checkpoints: readonly { readonly id: string; readonly runId: string; readonly reason: string; readonly status: string;
    readonly tokensBefore: number; readonly tokensAfter: number | null; readonly sourceContextRevision: string;
    readonly createdAt: string; readonly committedAt: string | null; readonly failureRef: string | null }[];
  readonly compactionOperation: { readonly requestId: string; readonly runId: string;
    readonly status: "running" | "committed" | "below_threshold" | "aborted" | "failed" | "unknown";
    readonly checkpointId: string | null; readonly reason: string | null; readonly createdAt: string; readonly endedAt: string | null } | null;
};

export type ProvideRequiredFileResult = CommandReceipt & { readonly newBranch?: { readonly runId: string; readonly conversationId: string } };

/* ------------------------------------------------------------------ delegation contracts */

export type DelegationMode = "sync" | "async";
export type DelegationStatus = "created" | "running" | "completed" | "failed" | "cancelled";
export type DelegationDeliveryState = "pending" | "incorporated" | "processed" | "suppressed";

export type DelegationView = {
  readonly id: string;
  readonly parentConversationId: string;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly childConversationId: string;
  readonly childRunId: string | null;
  readonly mode: DelegationMode;
  readonly historyMode: "full_history" | "task_log";
  readonly agentId: string;
  readonly status: DelegationStatus;
  readonly deliveryState: DelegationDeliveryState | null;
  readonly resultRef: string | null;
  readonly receivedByRunId: string | null;
  readonly queueReason?: string | null;
  readonly waitDeadlineAt?: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type PageQuery = {
  readonly cursor?: string;
  readonly limit?: number;
};

export type DelegationPageQuery = PageQuery;

export type CancelDelegationRequest = {
  readonly requestId: string;
  readonly reason?: string;
};

export type CancelDelegationResult = CommandReceipt & {
  readonly status: DelegationStatus;
};

export type TaskTreeNodeView = {
  readonly id: string;
  readonly conversationId: string;
  readonly runId: string | null;
  readonly parentId: string | null;
  readonly kind: "root" | "subagent" | "follow_up";
  readonly status: string;
  readonly mode?: DelegationMode;
  readonly agentId?: string;
  readonly task?: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type TaskTreeView = {
  readonly rootRunId: string;
  readonly nodes: readonly TaskTreeNodeView[];
  readonly totalNodes: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
};

export type TaskExportScope = {
  readonly complete: boolean;
  readonly reason: string | null;
  readonly missingRanges: readonly string[];
};

export type TaskExportManifest = {
  readonly sha256: string;
  readonly totalNodes: number;
  readonly exportedAt: number;
};

export type TaskExportNode = {
  readonly id: string;
  readonly conversationId: string;
  readonly runId: string | null;
  readonly parentId: string | null;
  readonly kind: "root" | "subagent" | "follow_up";
  readonly status: string;
  readonly mode?: DelegationMode;
  readonly agentId?: string;
  readonly task?: string;
  readonly sanitizedOutput?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type TaskExportView = {
  readonly rootRunId: string;
  readonly scope: TaskExportScope;
  readonly manifest: TaskExportManifest;
  readonly topology: TaskTreeView;
  readonly nodes: readonly TaskExportNode[];
};
