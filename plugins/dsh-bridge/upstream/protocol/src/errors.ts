/**
 * The error vocabulary and its mapping to HTTP status codes.
 *
 * `ERROR_CODES` is the single source of truth: the union type, the status map
 * and the completeness test are all derived from it, so a code cannot be added
 * without a status.
 *
 * The set is the Core's own error vocabulary (`@super-agent/core`
 * `types/contracts.ts`) plus the codes the service interface introduces
 * (design §4.2). Every Core code is present here so a Core error can always be
 * transported without translation; codes the design's table does not list are
 * given the status that matches what the caller has to do about them.
 *
 * Two codes are in neither list and are additions this package makes:
 * `VERSION_CONFLICT`, which §4.2's table and §3.3 both use but neither source
 * declares; and `SERVER_STOPPING`, because §2.1 makes `stopping` refuse new
 * commands and the only "not serving" code the design has is `SERVER_STARTING`,
 * which would report the wrong state. Both need to be folded back into the
 * design document.
 */
import type { JsonObject } from "./json.js";

export const ERROR_CODES = [
  // 400 — the request itself is wrong and must be changed before retrying.
  "INVALID_REQUEST",
  "CONFIG_INVALID",
  "PROTOCOL_MISMATCH",

  // 403 — the caller is known but not allowed to touch this resource.
  "PERMISSION_DENIED",

  // 404 — the addressed resource does not exist.
  "NOT_FOUND",
  "WAIT_NOT_FOUND",
  "DELEGATION_NOT_FOUND",
  "TOOL_NOT_FOUND",

  // 409 — the request conflicts with the resource's current state.
  "IDEMPOTENCY_CONFLICT",
  "VERSION_CONFLICT",
  "RUN_NOT_ACTIVE",
  "WAIT_ALREADY_ANSWERED",
  "THREAD_PAUSED",
  "THREAD_FAILED",
  "THREAD_ARCHIVED",
  "THREAD_DELETED",
  "RECOVERY_EXPIRED",
  "CONFIG_IN_USE",
  "FILE_CONFLICT",
  "POLICY_CHANGED",
  "PARAMS_CHANGED",
  "TOOL_REPLAY_MISMATCH",
  "TOOL_SCHEMA_CHANGED",
  "EXECUTION_UNKNOWN",
  "COMPACTION_NO_PROGRESS",
  "CANCELLED",

  // 410 — the requested cursor is older than what is still retained.
  "CURSOR_EXPIRED",

  // 413 — the context no longer fits the model.
  "CONTEXT_OVERFLOW",

  // 422 — the caller is authenticated but the account/credential is unusable.
  "AUTH_REQUIRED",
  "ACCOUNT_CHANGED",

  // 429 — the process is at capacity; retry later.
  "CAPACITY",

  // 500 — an internal invariant failed.
  "INTERNAL",
  "COMPACTION_FAILED",

  // 501 — the capability is recognised but not implemented.
  "NOT_SUPPORTED",

  // 502 — the upstream model or provider failed.
  "MODEL_FAILURE",

  // 503 — the process cannot serve the request right now.
  "SERVER_STARTING",
  "SERVER_STOPPING",
  "STORAGE_FAILURE",
  "RECOVERY_BLOCKED",

  // 504 — the operation did not finish in time.
  "TIMEOUT",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  CONFIG_INVALID: 400,
  PROTOCOL_MISMATCH: 400,

  PERMISSION_DENIED: 403,

  NOT_FOUND: 404,
  WAIT_NOT_FOUND: 404,
  DELEGATION_NOT_FOUND: 404,
  TOOL_NOT_FOUND: 404,

  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  RUN_NOT_ACTIVE: 409,
  WAIT_ALREADY_ANSWERED: 409,
  THREAD_PAUSED: 409,
  THREAD_FAILED: 409,
  THREAD_ARCHIVED: 409,
  THREAD_DELETED: 409,
  RECOVERY_EXPIRED: 410,
  CONFIG_IN_USE: 409,
  FILE_CONFLICT: 409,
  POLICY_CHANGED: 409,
  PARAMS_CHANGED: 409,
  TOOL_REPLAY_MISMATCH: 409,
  TOOL_SCHEMA_CHANGED: 409,
  EXECUTION_UNKNOWN: 409,
  COMPACTION_NO_PROGRESS: 409,
  CANCELLED: 409,

  CURSOR_EXPIRED: 410,

  CONTEXT_OVERFLOW: 413,

  AUTH_REQUIRED: 422,
  ACCOUNT_CHANGED: 422,

  CAPACITY: 429,

  INTERNAL: 500,
  COMPACTION_FAILED: 500,

  NOT_SUPPORTED: 501,

  MODEL_FAILURE: 502,

  SERVER_STARTING: 503,
  SERVER_STOPPING: 503,
  STORAGE_FAILURE: 503,
  RECOVERY_BLOCKED: 503,

  TIMEOUT: 504,
};

/** HTTP status for an error code. Total by construction; never throws. */
export function httpStatusForError(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

export type ErrorBody = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** The resource the failure is about, when it is about one. */
  readonly resourceId?: string;
  /** Structured detail: field errors, blocking reasons, conflicting references. */
  readonly details: JsonObject;
};

export type ErrorEnvelope = {
  readonly error: ErrorBody;
};
