/**
 * Views: what a caller sees when it asks about the process, and what it gets
 * back from a state-changing command.
 */
import type { JsonObject } from "./json.js";

/* ------------------------------------------------------------------ server */

export type ServerState = "starting" | "ready" | "degraded" | "stopping";

/** Inclusive range of protocol versions the process can serve. */
export type ProtocolRange = {
  readonly min: number;
  readonly max: number;
};

/**
 * A Thread the startup reconciliation could not release (design §2.2 step 4).
 *
 * Reasons include the Core's `ThreadBlockingReason` and startup configuration
 * recovery failures; business ids are carried as opaque strings here.
 */
export type BlockingReason =
  | { readonly kind: "gate"; readonly gate: string }
  | { readonly kind: "unknown_executions"; readonly executionIds: readonly string[] }
  | { readonly kind: "missing_config" }
  | { readonly kind: "pending_waits"; readonly waitIds: readonly string[] }
  | { readonly kind: "stopping_tasks"; readonly count: number }
  | { readonly kind: "queued_work"; readonly runs: number; readonly inputs: number };

export type BlockedThread = {
  readonly threadId: string;
  readonly blockingReasons: readonly BlockingReason[];
};

/** Outcome of the startup reconciliation, as reported by `GET /v1/server`. */
export type RecoverySummary = {
  readonly blockedThreads: readonly BlockedThread[];
  readonly pendingWaits: number;
  readonly activeDelegations: number;
};

export const EMPTY_RECOVERY: RecoverySummary = {
  blockedThreads: [],
  pendingWaits: 0,
  activeDelegations: 0,
};

export type RuntimeFeatures = { readonly goalsV1?: boolean };

export type ServerInfo = {
  /** Missing features are unsupported. Reported from the serving runtime. */
  readonly runtimeFeatures?: RuntimeFeatures;
  readonly version: string;
  readonly protocol: ProtocolRange;
  readonly state: ServerState;
  readonly pid: number;
  /** ISO 8601, UTC. */
  readonly startedAt: string;
  /** Configuration directory in effect for this process. */
  readonly home: string;
  readonly socketPath: string;
  readonly lockPath: string;
  /** Highest committed event seq; 0 before the first commit. */
  readonly eventSeq: number;
  readonly recovery: RecoverySummary;
};

/* ------------------------------------------------------------------ receipts */

/**
 * The receipt vocabulary, carried through from the Core unchanged.
 *
 * `accepted` is the only state a command receipt takes today: the acceptance is
 * durable. `queued` and `placed` are the Core's finer placement states — an input
 * accepted while a Run is already active is `queued`, one folded into a live Run is
 * `placed` — and mapping them to `accepted` would tell a caller that work it has not
 * seen scheduled is already under way.
 *
 * `completed` is the state a receipt never takes: it is here so the distinction the
 * design draws ("受理不等于完成", §4.2) has a name on both sides, and a client that
 * compares against it is not comparing against a value the vocabulary cannot express.
 */
export type ReceiptState = "accepted" | "queued" | "placed" | "completed";

/**
 * Returned by every state-changing command.
 *
 * `receiptSeq` is the seq of the event produced by the commit that accepted the
 * command: a client that subscribes from it sees everything that follows.
 * Replaying the same `requestId` returns the original receipt unchanged.
 */
export type Receipt = {
  readonly requestId: string;
  readonly state: ReceiptState;
  readonly receiptSeq: number;
  /** The resource the command acted on, e.g. `run_01J…`. */
  readonly resourceId?: string;
};

/* ------------------------------------------------------------------ logs */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One line of `logs/core.log`. Never carries credentials or model text. */
export type LogEntry = {
  /** ISO 8601, UTC. */
  readonly time: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: JsonObject;
};

export type ServerLogsView = {
  readonly entries: readonly LogEntry[];
};

/** Body of a successful `POST /v1/server:shutdown` (design §5.1). */
export type ShutdownAccepted = {
  readonly state: "stopping";
};

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
