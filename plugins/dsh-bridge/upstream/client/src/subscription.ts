/**
 * The resumable event subscription.
 *
 * `GET /v1/events` is an SSE stream of two kinds of frame — committed events
 * (replayable, `seq`-addressed) and live frames (lossy, not persisted). The
 * subscription is an `AsyncIterable` the caller drives: it reconnects on its
 * own, but a cursor the Core has forgotten (`CURSOR_EXPIRED` / HTTP 410) is
 * thrown to the caller rather than retried, because only the caller can rebuild
 * its view.
 *
 * Reconnection carries the last `id` seen as `Last-Event-ID` (and as the
 * `after` query), and backs off exponentially up to a cap. The stream is
 * considered dropped after 2× the heartbeat interval with no data at all —
 * including the comment heartbeats the Core sends.
 */
import { StringDecoder } from "node:string_decoder";
import type { IncomingMessage } from "node:http";

import {
  HEADER_CALLER,
  HEADER_LAST_EVENT_ID,
  HEADER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ROUTES,
  SSE_CONTENT_TYPE,
  SSE_EVENT_COMMITTED,
  SSE_EVENT_LIVE,
  SSE_QUERY_AFTER,
  SSE_QUERY_LIVE,
  SSE_QUERY_THREAD_ID,
  type CommittedEvent,
  type LiveFrame,
  type SubscriptionEvent,
} from "@super-agent/protocol";

import { CoreClientError, CoreConnectionError, CursorExpiredError, clientErrorFromEnvelope, parseErrorEnvelope } from "./errors.js";
import { SseParser, type SseEvent } from "./sse.js";
import { openEventStream, readBody, type ConnectionOptions } from "./transport.js";

export type SubscriptionOptions = {
  /** Resume after this committed-event seq. */
  readonly after?: number;
  /** Restrict to these Threads; absent means every Thread. */
  readonly threadIds?: readonly string[];
  /** Ask for live frames as well as committed events. */
  readonly live?: boolean;
  /** Aborts the subscription; the iterator's `return()` works too. */
  readonly signal?: AbortSignal;
};

export type SubscriptionContext = ConnectionOptions & {
  readonly caller: string;
  readonly heartbeatIntervalMs: number;
};

const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5_000;

export function createSubscription(
  context: SubscriptionContext,
  options: SubscriptionOptions = {},
): AsyncIterable<SubscriptionEvent> {
  // One controller carries both ways the subscription ends early: a caller's
  // abort and the iterator's `return()`. `return()` has to reach the stream even
  // while a `next()` is pending, and only the stream itself can settle that
  // `next()`, so it must be interrupted from the outside.
  const controller = new AbortController();
  const external = options.signal;
  if (external !== undefined) {
    if (external.aborted) {
      controller.abort();
    } else {
      const forward = (): void => controller.abort();
      external.addEventListener("abort", forward, { once: true });
      // Drop the forwarder when the subscription ends, so a caller's
      // long-lived signal does not collect a listener per subscription.
      controller.signal.addEventListener("abort", () => external.removeEventListener("abort", forward), {
        once: true,
      });
    }
  }
  const generator = iterate(context, options, controller.signal);
  // A terminal failure ends the subscription as surely as an abort, so release
  // the caller's listener then too; otherwise a long-lived signal collects one
  // per finished subscription.
  const endOnFailure = <T>(result: Promise<T>): Promise<T> => {
    void result.catch(() => controller.abort());
    return result;
  };
  return {
    [Symbol.asyncIterator](): AsyncIterator<SubscriptionEvent> {
      return {
        next: (): Promise<IteratorResult<SubscriptionEvent>> => endOnFailure(generator.next()),
        return: (value?: void): Promise<IteratorResult<SubscriptionEvent>> => {
          controller.abort();
          return generator.return(value);
        },
        throw: (error?: unknown): Promise<IteratorResult<SubscriptionEvent>> => {
          controller.abort();
          return endOnFailure(generator.throw(error));
        },
      };
    },
  };
}

async function* iterate(
  context: SubscriptionContext,
  options: SubscriptionOptions,
  signal: AbortSignal,
): AsyncGenerator<SubscriptionEvent, void, void> {
  const idleTimeoutMs = context.heartbeatIntervalMs * 2;
  const cursor: CursorRef = { value: options.after === undefined ? undefined : String(options.after) };
  let backoff = INITIAL_BACKOFF_MS;

  while (true) {
    if (isAborted(signal)) return;
    try {
      for await (const event of streamOnce(context, options, cursor, idleTimeoutMs, signal)) {
        backoff = INITIAL_BACKOFF_MS;
        yield event;
      }
      // The stream ended on its own: reconnect from where we stopped.
    } catch (error) {
      if (error instanceof CursorExpiredError || error instanceof CoreClientError) throw error;
      if (isAborted(signal)) return;
      // Anything else is a transport failure: fall through and reconnect.
    }
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

type CursorRef = { value: string | undefined };

async function* streamOnce(
  context: SubscriptionContext,
  options: SubscriptionOptions,
  cursor: CursorRef,
  idleTimeoutMs: number,
  signal: AbortSignal,
): AsyncGenerator<SubscriptionEvent, void, void> {
  let res: IncomingMessage;
  try {
    res = await openEventStream({
      ...context,
      path: eventsPath(options, cursor.value),
      headers: eventHeaders(context, cursor.value),
      signal,
    });
  } catch (error) {
    // An abort while the headers are still in flight is a normal end, not a
    // transport failure to reconnect from.
    if (isAborted(signal)) return;
    throw error;
  }
  const onAbort = (): void => {
    res.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // The signal may have fired between the open resolving and the listener
    // above being attached; the `finally` destroys the response either way.
    if (isAborted(signal)) return;
    if (res.statusCode !== 200) {
      const body = await readBody(res);
      const envelope = parseErrorEnvelope(tryParseJson(body));
      if (envelope !== null) {
        const error = clientErrorFromEnvelope(res.statusCode ?? 0, envelope);
        // A retryable protocol error is a reason to reconnect; anything else is
        // the caller's to handle. A forgotten cursor is never retried.
        if (error instanceof CursorExpiredError || !error.retryable) throw error;
        return;
      }
      if (res.statusCode === 410) {
        throw new CursorExpiredError({
          message: "the event cursor is no longer retained",
          httpStatus: 410,
        });
      }
      throw new CoreConnectionError(
        "malformed_response",
        `the event stream failed with HTTP ${res.statusCode ?? 0} and no error envelope`,
      );
    }

    const parser = new SseParser();
    // A network chunk can end anywhere, including inside a multi-byte
    // character. The decoder holds the partial sequence across chunks so the
    // parser only ever sees whole characters.
    const decoder = new StringDecoder("utf8");
    const idleTimer = setTimeout(() => {
      // No data for 2× the heartbeat interval: treat the stream as dropped and
      // let the reconnect path take over.
      res.destroy();
    }, idleTimeoutMs);
    try {
      for await (const chunk of res) {
        idleTimer.refresh();
        for (const sse of parser.push(decoder.write(chunk))) {
          const item = decodeEvent(sse);
          if (item === null) continue;
          // Only a committed event moves the cursor. A live frame — including the
          // `stream.reset` a retry emits — is the model's output in flight and has no
          // seq; letting one set the cursor would make a reconnect resume from a point
          // that never existed, and an empty `id:` on one would silently throw away
          // everything the caller had already been served.
          if (item.kind === "committed") {
            const next =
              sse.id !== undefined && sse.id !== ""
                ? sse.id
                : // Seq 0 is the unsequenced marker a Core without an outbox sends; it is
                  // not a position in any window, and resuming from it would replay
                  // everything.
                  item.event.seq >= 1
                  ? String(item.event.seq)
                  : null;
            if (next !== null) cursor.value = next;
          }
          yield item;
        }
      }
    } finally {
      clearTimeout(idleTimer);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    res.destroy();
  }
}

function decodeEvent(sse: SseEvent): SubscriptionEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sse.data);
  } catch {
    throw new CoreConnectionError("malformed_response", "an SSE data payload was not valid JSON");
  }
  const kind = classify(sse.event, parsed);
  if (kind === "committed") return { kind: "committed", event: parsed as CommittedEvent };
  if (kind === "live") return { kind: "live", frame: parsed as LiveFrame };
  return null;
}

function classify(name: string | undefined, value: unknown): "committed" | "live" | null {
  // The `event:` name decides, and both sides read it from the protocol package
  // so they cannot drift. The shape check behind it is a fallback for a Core
  // that predates the shared constant, not a second source of truth.
  if (name === SSE_EVENT_COMMITTED) return "committed";
  if (name === SSE_EVENT_LIVE) return "live";
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.requestRef === "string") return "live";
  if (typeof record.seq === "number" && typeof record.time === "string") return "committed";
  return null;
}

function eventsPath(options: SubscriptionOptions, cursor: string | undefined): string {
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set(SSE_QUERY_AFTER, cursor);
  for (const threadId of options.threadIds ?? []) params.append(SSE_QUERY_THREAD_ID, threadId);
  if (options.live === true) params.set(SSE_QUERY_LIVE, "true");
  const query = params.toString();
  return query === "" ? ROUTES.events : `${ROUTES.events}?${query}`;
}

function eventHeaders(context: SubscriptionContext, cursor: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    [HEADER_PROTOCOL_VERSION]: String(PROTOCOL_VERSION),
    [HEADER_CALLER]: context.caller,
    accept: SSE_CONTENT_TYPE,
  };
  if (cursor !== undefined) headers[HEADER_LAST_EVENT_ID] = cursor;
  return headers;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
