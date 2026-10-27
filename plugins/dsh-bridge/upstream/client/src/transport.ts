/**
 * HTTP/1.1 over a Unix Domain Socket, using `node:http`.
 *
 * The transport is deliberately thin: it turns a request into a promise of
 * status/headers/body, and turns every failure that is not a protocol answer
 * into a `CoreConnectionError` with a `reason`. Deciding what a status code
 * means is the client's job, not the transport's.
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";

import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";

import { CoreConnectionError } from "./errors.js";

export type HttpResponse = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
};

export type ConnectionOptions = {
  readonly socketPath?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly accessToken?: string | (() => string | Promise<string>) | undefined;
  readonly ca?: string | undefined;
  readonly expectedInstanceId?: string | undefined;
};

export type RequestOptions = ConnectionOptions & {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /**
   * The JSON body, already serialised.
   *
   * Serialised by the caller rather than here so the content type and the byte count the
   * transport sends are the ones the caller's own string produced — a transport that
   * re-encoded the object would send bytes nobody computed the length of.
   */
  readonly body?: string;
};

/** Sends a request and buffers the whole response. */
export async function sendRequest(options: RequestOptions): Promise<HttpResponse> {
  const connection = await requestConnection(options);
  const body = options.body;
  const headers =
    body === undefined
      ? options.headers
      : {
          ...options.headers,
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(body, "utf8")),
        };
  return new Promise<HttpResponse>((resolve, reject) => {
    let timedOut = false;
    const req = connection.request(
      {
        ...connection.options,
        method: options.method,
        path: options.path,
        headers: { ...headers, ...connection.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", (error) => {
          reject(timedOut ? timeoutError() : connectionError(error));
        });
      },
    );
    req.setTimeout(options.timeoutMs, () => {
      timedOut = true;
      req.destroy();
    });
    req.on("error", (error) => {
      reject(timedOut ? timeoutError() : connectionError(error));
    });
    req.end(body);
  });
}

/**
 * Opens a streaming request (for SSE) and resolves as soon as the response
 * headers arrive. The caller owns the returned message and destroys it to stop.
 * There is no request timeout: a subscription is long-lived by design. An
 * `AbortSignal` settles the open even before the headers arrive, so a caller
 * that aborts while the Core has accepted the connection but not yet answered
 * is not left waiting forever.
 */
export async function openEventStream(options: ConnectionOptions & {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
}): Promise<IncomingMessage> {
  const connection = await requestConnection(options);
  const signal = options.signal;
  return new Promise<IncomingMessage>((resolve, reject) => {
    let settled = false;
    function finish(): void {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort(): void {
      // Destroying the request alone leaves this promise pending, so the caller
      // waiting for headers would hang; the abort has to reject it too.
      finish();
      req.destroy();
      reject(signal?.reason);
    }
    const req = connection.request(
      {
        ...connection.options,
        method: "GET",
        path: options.path,
        headers: { ...options.headers, ...connection.headers },
      },
      (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        finish();
        resolve(res);
      },
    );
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error) => {
      if (settled) return;
      finish();
      reject(connectionError(error));
    });
    req.end();
  });
}

/** Reads a response body to the end; used for error answers on the stream route. */
export async function readBody(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function connectionError(error: unknown): CoreConnectionError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const label = typeof code === "string" ? code : "unknown";
  return new CoreConnectionError(
    /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(label) ? "certificate" : "unreachable",
    `cannot reach the Core (${label})`,
    { cause: error },
  );
}

export function timeoutError(): CoreConnectionError {
  return new CoreConnectionError("timeout", "the Core did not respond within the request timeout");
}

export function malformedResponse(status: number, detail = "the body was not a JSON error envelope"): CoreConnectionError {
  return new CoreConnectionError(
    "malformed_response",
    `the Core returned a malformed response (HTTP ${status}): ${detail}`,
  );
}

/** Credentials belong in headers; endpoints must be HTTPS origins without URL secrets. */
async function requestConnection(options: ConnectionOptions): Promise<{
  request: typeof httpRequest;
  options: HttpsRequestOptions;
  headers: Record<string, string>;
}> {
  if (options.baseUrl !== undefined) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new CoreConnectionError("unreachable", "invalid Core HTTPS address"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || options.socketPath) {
      throw new CoreConnectionError("unreachable", "Core address must be an HTTPS origin");
    }
    const token = typeof options.accessToken === "function" ? await options.accessToken() : options.accessToken;
    return {
      request: httpsRequest,
      options: { hostname: url.hostname, port: url.port || 443, rejectUnauthorized: true,
        ...(options.ca === undefined ? {} : { ca: options.ca }) },
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.expectedInstanceId ? { "x-core-instance-id": options.expectedInstanceId } : {}) },
    };
  }
  if (!options.socketPath) throw new CoreConnectionError("unreachable", "Core connection is required");
  return { request: httpRequest, options: { socketPath: options.socketPath }, headers: {} };
}
