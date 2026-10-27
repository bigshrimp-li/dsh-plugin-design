/**
 * Protocol version and the request headers that carry it.
 *
 * The version is exchanged in a header rather than in the path so that a route
 * keeps its meaning across versions; a request whose version is outside the
 * supported range is rejected with `PROTOCOL_MISMATCH` before any handler runs.
 */

/** The version this build speaks, and the one it sends on every request. */
export const PROTOCOL_VERSION = 1;

/** Lowest version this build can still serve. */
export const PROTOCOL_MIN_VERSION = 1;

/** Highest version this build can serve. */
export const PROTOCOL_MAX_VERSION = 1;

export const HEADER_PROTOCOL_VERSION = "X-Protocol-Version";

/** Caller identity, e.g. `dsh-bridge`. Participates in the idempotency key. */
export const HEADER_CALLER = "X-Caller";

/** Required on every state-changing command; replays return the first receipt. */
export const HEADER_REQUEST_ID = "X-Request-Id";

/**
 * Reconnect cursor for `GET /v1/events`: the `id` of the last committed event
 * the client saw. Sent by the client, never by the server.
 */
export const HEADER_LAST_EVENT_ID = "Last-Event-ID";

export const PROTOCOL_HEADERS = [
  HEADER_PROTOCOL_VERSION,
  HEADER_CALLER,
  HEADER_REQUEST_ID,
] as const;

/** True when a peer's `X-Protocol-Version` is one this build can serve. */
export function isSupportedProtocolVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= PROTOCOL_MIN_VERSION &&
    version <= PROTOCOL_MAX_VERSION
  );
}

/** Parses an `X-Protocol-Version` header value; `null` when it is not an integer. */
export function parseProtocolVersion(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}
