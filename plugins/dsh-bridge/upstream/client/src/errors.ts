/**
 * The client's error vocabulary.
 *
 * Three layers, kept apart on purpose so a caller can tell what it has to do:
 *
 *  - `CoreClientError`  — the Core answered with an `ErrorEnvelope`. The `code`
 *                         is the protocol's, the `httpStatus` is the status the
 *                         transport actually saw (the envelope wins on a
 *                         disagreement, per the service interface).
 *  - `CoreConnectionError` — there was no protocol answer to speak of: the
 *                         socket could not be reached, the call timed out, or
 *                         the response was not a JSON envelope. `reason` tells
 *                         the three apart.
 *  - `CursorExpiredError` — a specialisation of the protocol error: the caller's
 *                         cursor is older than what is retained. The caller has
 *                         to rebuild its view; the client never reconnects past
 *                         it.
 */
import {
  ERROR_CODES,
  type ErrorBody,
  type ErrorCode,
  type ErrorEnvelope,
  type JsonObject,
} from "@super-agent/protocol";

/** Why a call failed before it produced a protocol-level answer. */
export type ConnectionFailureReason = "unreachable" | "timeout" | "malformed_response" | "certificate";

export type CoreClientErrorParams = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly resourceId?: string | undefined;
  readonly details?: JsonObject;
  readonly httpStatus: number;
};

/** A failure the Core reported with an `ErrorEnvelope`. */
export class CoreClientError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly resourceId: string | undefined;
  readonly details: JsonObject;
  readonly httpStatus: number;

  constructor(params: CoreClientErrorParams) {
    super(params.message);
    this.name = "CoreClientError";
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.resourceId = params.resourceId;
    this.details = params.details ?? {};
    this.httpStatus = params.httpStatus;
  }
}

export type CursorExpiredErrorParams = {
  readonly message: string;
  readonly retryable?: boolean;
  readonly resourceId?: string | undefined;
  readonly details?: JsonObject;
  readonly httpStatus: number;
};

/** The cursor the caller asked from is no longer retained (HTTP 410 / `CURSOR_EXPIRED`). */
export class CursorExpiredError extends CoreClientError {
  constructor(params: CursorExpiredErrorParams) {
    super({ ...params, code: "CURSOR_EXPIRED" });
    this.name = "CursorExpiredError";
  }
}

/** A failure that happened before, or instead of, a protocol-level answer. */
export class CoreConnectionError extends Error {
  readonly reason: ConnectionFailureReason;

  constructor(reason: ConnectionFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreConnectionError";
    this.reason = reason;
  }
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}

/**
 * Reads a value as an `ErrorEnvelope`.
 *
 * Returns `null` when the shape is not one: a body without an `error` object, a
 * `code` that is not a string, or a `message` that is not a string. A `code`
 * that is a string but not in the protocol's vocabulary is reported as
 * `INTERNAL` — it is still a protocol-level error, just one this build does not
 * know.
 */
export function parseErrorEnvelope(value: unknown): ErrorEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  const rawCode = record.code;
  const rawMessage = record.message;
  if (typeof rawCode !== "string" || typeof rawMessage !== "string") return null;

  const code: ErrorCode = isErrorCode(rawCode) ? rawCode : "INTERNAL";
  const retryable = typeof record.retryable === "boolean" ? record.retryable : false;
  const resourceId = typeof record.resourceId === "string" ? record.resourceId : undefined;
  const details: JsonObject =
    typeof record.details === "object" && record.details !== null && !Array.isArray(record.details)
      ? (record.details as JsonObject)
      : {};

  const body: ErrorBody = {
    code,
    message: rawMessage,
    retryable,
    details,
    ...(resourceId !== undefined ? { resourceId } : {}),
  };
  return { error: body };
}

/**
 * Maps a protocol error answer to an error.
 *
 * The envelope's `code` decides; the transport's `httpStatus` is carried
 * alongside even when the two disagree. Other 410 errors, such as an expired
 * Thread recovery period, must not be mistaken for an SSE cursor error.
 */
export function clientErrorFromEnvelope(httpStatus: number, envelope: ErrorEnvelope): CoreClientError {
  const body = envelope.error;
  if (body.code === "CURSOR_EXPIRED") {
    return new CursorExpiredError({
      message: body.message,
      retryable: body.retryable,
      resourceId: body.resourceId,
      details: body.details,
      httpStatus,
    });
  }
  return new CoreClientError({
    code: body.code,
    message: body.message,
    retryable: body.retryable,
    resourceId: body.resourceId,
    details: body.details,
    httpStatus,
  });
}
