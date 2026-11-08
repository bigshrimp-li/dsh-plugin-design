import { connect } from "node:net";
import WebSocket, { createWebSocketStream } from "ws";
import {
  EVENT_SOCKET_PATH, EVENT_SOCKET_PROTOCOL, HEADER_CALLER,
  type EventSocketMessage,
} from "@super-agent/protocol";
import { CoreConnectionError } from "./errors.js";

export type EventScope = {
  readonly workspaceIds?: readonly string[];
  readonly threadIds?: readonly string[];
};

export type EventSocketOptions = EventScope & {
  readonly instanceId?: string;
  readonly after?: number;
  readonly live?: boolean;
  readonly signal?: AbortSignal;
};

export function eventQuery(options: EventSocketOptions): string {
  const params = new URLSearchParams();
  for (const id of options.threadIds ?? []) params.append("threadId", id);
  for (const id of options.workspaceIds ?? []) params.append("workspaceId", id);
  if (options.instanceId !== undefined) params.set("instanceId", options.instanceId);
  if (options.after !== undefined) {
    if (!options.instanceId || !Number.isSafeInteger(options.after) || options.after < 0) {
      throw new TypeError("resuming requires a nonnegative event sequence and its instanceId");
    }
    params.set("after", String(options.after));
  }
  if (options.live !== undefined) params.set("live", String(options.live));
  return params.size > 0 ? `?${params}` : "";
}

function parseFrame(raw: unknown): EventSocketMessage {
  if (typeof raw !== "string") throw new CoreConnectionError("malformed_response", "expected a JSON text message");
  let value: EventSocketMessage;
  try { value = JSON.parse(raw) as EventSocketMessage; }
  catch (cause) { throw new CoreConnectionError("malformed_response", "invalid JSON in Runtime event frame", { cause }); }
  if (value?.kind === "committed" && Number.isSafeInteger(value.event?.seq) && value.event.seq > 0 &&
      typeof value.event.time === "string" && typeof value.event.type === "string" && value.event.payload &&
      typeof value.event.payload === "object" && !Array.isArray(value.event.payload)) return value;
  if (value?.kind === "live" && value.frame) {
    const frame = value.frame;
    if (["stream.text_delta", "stream.thinking_delta", "stream.tool_call_delta", "stream.reset"].includes(frame.type) &&
        [frame.threadId, frame.runId, frame.turnId, frame.requestRef, frame.messageId, frame.delta].every(field => typeof field === "string") &&
        Number.isSafeInteger(frame.attempt) && frame.attempt >= 1 && Number.isSafeInteger(frame.index) && frame.index >= 0) return value;
  }
  if (value?.kind === "resync_required" && ["CURSOR_EXPIRED", "INVALID_REQUEST", "ACCOUNT_CHANGED"].includes(value.code)) return value;
  throw new CoreConnectionError("malformed_response", "unrecognized Runtime event frame");
}

/** One WS subscription. The caller applies its snapshot before resuming or changing scope. */
export async function* openEventSocket(
  socketPath: string, caller: string, options: EventSocketOptions, handshakeTimeout: number, expectedInstanceId?: string,
): AsyncGenerator<EventSocketMessage> {
  if (options.signal?.aborted) return;
  const path = EVENT_SOCKET_PATH + eventQuery(options);
  const socket = new WebSocket(`ws://localhost${path}`, EVENT_SOCKET_PROTOCOL, {
    createConnection: () => connect({ path: socketPath }),
    headers: { [HEADER_CALLER]: caller, ...(expectedInstanceId ? { "X-Core-Instance-Id": expectedInstanceId } : {}) },
    handshakeTimeout,
    maxPayload: 16 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const stream = createWebSocketStream(socket, { readableObjectMode: true, highWaterMark: 16 });
  const abort = () => socket.terminate();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const raw of stream) {
      if (options.signal?.aborted) break;
      const message = parseFrame(raw);
      yield message;
      if (message.kind === "resync_required") break;
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    socket.terminate();
    stream.destroy();
  }
}
