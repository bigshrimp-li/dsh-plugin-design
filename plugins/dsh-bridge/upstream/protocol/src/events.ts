/**
 * The two kinds of event the stream carries (design §6.2).
 *
 * Committed events are written in the same Storage commit as the business fact
 * they describe: their `seq` is global, gapless and replayable. Live frames are
 * the model's stream as it arrives — lossy, not persisted, and never a
 * substitute for a committed message.
 */
import type { JsonObject } from "./json.js";
import type { MessageKind, MessageRole, MessageSource } from "./p1-contracts.js";
import type { BlockedThread, ServerState } from "./views.js";

/* ------------------------------------------------------------------ committed */

/**
 * Service-level committed events.
 *
 * The Core declares the same three names in its own `SERVICE_EVENT_TYPES` — it is the
 * package that stores them — and a test in the server package holds the two lists equal,
 * for the same reason the Thread vocabulary is held equal: a durable row is published
 * under the name it was written with, so a second list that drifted would make the record
 * and the wire disagree.
 *
 * Later packages extend this union with the Turn, tool, message, delegation,
 * compaction, usage and workspace events of design §6.3.
 */
export const SERVER_EVENT_TYPES = ["server.ready", "server.status_changed", "server.stopping"] as const;

export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

/**
 * The Thread, input, Run, wait and configuration facts of design §6.3 that the
 * Core owns today.
 *
 * The Core's own sink writes these names verbatim, so an outbox row is the frame
 * a client sees: no translation step exists that could make the durable record
 * and the wire disagree. `run.redone` is the one name the design's table does not
 * enumerate — a redo accepts a fresh Run against replaced history, and naming it
 * as an ordinary `input.accepted` would hide the source Run from a subscriber
 * that wants to show what was redone.
 *
 * `message.committed` is the per-message fact, and it is deliberately *not*
 * `input.accepted` under another name: acceptance says the Core took the input,
 * while this says a message now exists in the record. An input that Pi has not yet
 * linked to a native entry has the first and not the second, and a client that
 * treated them as one would show a message as delivered before there was one.
 */
export const THREAD_EVENT_TYPES = [
  "thread.created",
  "thread.status_changed",
  "input.accepted",
  "message.committed",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.redone",
  "conversation.config_changed",
  "wait.answered",
] as const;

export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];

export type CommittedEventType = ServerEventType | ThreadEventType;

export type CommittedEvent = {
  /** Global, strictly increasing, never reused. The SSE `id`. */
  readonly seq: number;
  readonly type: CommittedEventType;
  /** ISO 8601, UTC. */
  readonly time: string;
  /** Absent for service-level events. */
  readonly threadId?: string;
  readonly payload: JsonObject;
};

/** `server.ready` — scheduling has been released; the reconciliation is done. */
export type ServerReadyPayload = {
  readonly blockedThreads: readonly BlockedThread[];
};

/** `server.status_changed` — `state` is the state the process just entered. */
export type ServerStatusChangedPayload = {
  readonly state: ServerState;
  readonly reason?: string;
};

/** `server.stopping` — pushed to every open stream before the listener closes. */
export type ServerStoppingPayload = {
  readonly reason?: string;
};

/* ------------------------------------------------------------------ thread facts */

/**
 * The payloads of the Thread and Run facts, as the Core writes them.
 *
 * They are the Core's own record of what happened, carried to the wire without a
 * second reading. Fields a client does not need are still here: an event is the
 * durable account of a fact, and dropping a field at publication would make the
 * replayable record less complete than the commit that produced it.
 */
export type ThreadCreatedPayload = {
  readonly threadId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly configRevision: string;
};

export type ThreadStatusChangedPayload = {
  readonly controlRevision: number;
  readonly control: {
    readonly pausedByUser: boolean;
    readonly failed: boolean;
    readonly archived: boolean;
  };
  /** Runs the change affected — cancelled, or left to finish, depending on the reason. */
  readonly affectedRunIds: readonly string[];
  /** Why the gate moved; `null` when the change came from an ordinary control call. */
  readonly reason: string | null;
};

export type InputAcceptedPayload = {
  readonly inputId: string;
  readonly runId: string;
  /** `new_run` starts a Run; `next_turn` joins the active one. */
  readonly delivery: string;
  readonly state: string;
  readonly receiptSeq: number;
  /** `fresh` on first acceptance, `duplicate` on a replayed `requestId`. */
  readonly outcome: string;
};

/**
 * `message.committed` — one message became a durable fact of the record.
 *
 * This is the same shape the message query returns (`MessageView`), minus the two fields a
 * projection cannot honestly know when it writes: `runId` and `turnId` are facts about the
 * Turn, and the Turn is settled later than the message. A reader that wants them reads them
 * from the Turn record; the event states only what it observed.
 *
 * It is written in the commit that made the message durable, and it is written *per
 * message*: an accepted input that Pi has not yet linked to a native entry is a projected
 * input, not a committed native message, and it does not publish this event. That is the
 * whole difference between `input.accepted` and `message.committed` — the first says the
 * Core took the input, the second says a message now exists.
 */
export type MessageCommittedPayload = {
  readonly messageId: string;
  /** The native conversation id, as a string: the record names it, not the protocol. */
  readonly conversationId: string;
  readonly kind: MessageKind;
  readonly role: MessageRole;
  readonly source: MessageSource;
  readonly toolCallId: string | null;
  /** The Pi entry this message was projected from; `null` until the sweep links one. */
  readonly entryId: number | null;
  readonly text: string | null;
  /** Epoch milliseconds. `MessageView.createdAt` is the ISO form of the same instant. */
  readonly createdAt: number;
  /** The message this one was inherited from, when a fork carried it over. */
  readonly origin: { readonly conversationId: string; readonly messageId: string } | null;
  /**
   * The generation a live frame named while this message was still being produced.
   *
   * A client replaces accumulated deltas with this message by matching the frame's
   * `messageId` against this key, which is why the two must come from one reservation
   * rather than from two independent guesses. `null` when nothing reserved a generation.
   */
  readonly generationKey: string | null;
};

export type RunStartedPayload = {
  readonly runId: string;
  readonly conversationId: string;
  readonly configRevision: string;
};

export type RunSettledPayload = {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: string;
  readonly endReason: string | null;
};

export type RunRedonePayload = {
  readonly runId: string;
  readonly sourceRunId: string;
  readonly conversationId: string;
  readonly mode: string;
  readonly outcome: string;
};

export type ConversationConfigChangedPayload = {
  readonly conversationId: string;
  readonly configRevision: string;
  /** Runs whose pinned revision no longer resolves and that must not be replayed. */
  readonly invalidatedRunIds: readonly string[];
};

export type WaitAnsweredPayload = {
  readonly waitId: string;
  readonly runId: string;
  readonly kind: string;
  readonly decision: string;
  readonly answer: string | null;
  readonly receiptSeq: number;
};

/* ------------------------------------------------------------------ live */

export type LiveFrameType =
  | "stream.text_delta"
  | "stream.thinking_delta"
  | "stream.tool_call_delta"
  | "stream.reset";

/**
 * A model stream fragment.
 *
 * Frames of one attempt share a `messageId` and carry an increasing `index`.
 * `stream.reset` means the same request is being retried, so the client drops
 * what it accumulated — for that message, and nothing else: a retry never
 * disturbs the committed cursor or another message's frames.
 *
 * `messageId` is the attempt's *live* key until the committed message exists. The
 * Core derives a message id from the Pi entry that carries it, and Pi's public
 * stream reveals that entry only when the message ends, so a frame cannot carry
 * the committed id while the tokens are still arriving. A client correlates the
 * two through the run, turn and attempt on the frame. See
 * `docs/requirements/thread-service/p1-durable-event-boundaries.md`.
 */
export type LiveFrame = {
  readonly type: LiveFrameType;
  readonly threadId: string;
  readonly runId: string;
  readonly turnId: string;
  /** The frozen request this frame belongs to. */
  readonly requestRef: string;
  /** Retry counter within one Turn; frames from different attempts never merge. */
  readonly attempt: number;
  readonly messageId: string;
  readonly index: number;
  readonly delta: string;
  /**
   * The tool call a `stream.tool_call_delta` belongs to, when the producer knows it.
   *
   * The argument fragments of a call are useless on their own: a host renders them into
   * the call the model declared, and a message may contain several calls, so the message
   * id is not a substitute for the call's own identity. The Core has it — Pi announces the
   * call with its id and name before any fragment arrives — and passes it through here so a
   * consumer does not have to guess which call a fragment belongs to, or drop it.
   *
   * Absent on frames of other types, and absent on a tool-call delta whose call was never
   * announced, which is the honest state rather than an empty id.
   */
  readonly toolCallId?: string;
  readonly toolName?: string;
};

/* ------------------------------------------------------------------ subscription */

/**
 * One item of the event stream, tagged by the class of frame it arrived in.
 *
 * A subscriber never has to guess: the frame's `event:` name says which of the
 * two shapes the data is, and this union carries that through.
 */
export type SubscriptionEvent =
  | { readonly kind: "committed"; readonly event: CommittedEvent }
  | { readonly kind: "live"; readonly frame: LiveFrame };
