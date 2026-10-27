/**
 * Public surface of @super-agent/client.
 *
 * The SDK is built in stages: P0 provides the UDS transport, error mapping and
 * the resumable event subscription. Nothing is exported before it is
 * implemented and covered by tests.
 */
export const CLIENT_PACKAGE_VERSION = "0.1.0";
export * from "./attachments.js";
export * from "./skill-installations.js";

export {
  createClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type ClientOptions,
  type CoreClient,
  type GetServerLogsOptions,
  type ListThreadsOptions,
  type ListWaitsOptions,
  type PageOptions,
} from "./client.js";
export {
  CoreClientError,
  CoreConnectionError,
  CursorExpiredError,
  clientErrorFromEnvelope,
  isErrorCode,
  parseErrorEnvelope,
  type ConnectionFailureReason,
  type CoreClientErrorParams,
  type CursorExpiredErrorParams,
} from "./errors.js";
export { SseParser, type SseEvent } from "./sse.js";
export { createSubscription, type SubscriptionContext, type SubscriptionOptions } from "./subscription.js";
// The stream vocabulary belongs to the protocol package; the SDK re-exports it
// so a caller that only depends on the client still sees one definition.
export { SSE_EVENT_COMMITTED, SSE_EVENT_LIVE, type SubscriptionEvent } from "@super-agent/protocol";
export {
  connectionError,
  malformedResponse,
  openEventStream,
  readBody,
  sendRequest,
  timeoutError,
  type HttpResponse,
  type RequestOptions,
} from "./transport.js";

export { createSettingsClient } from "./settings.js";

export { createWorkspaceFileClient, packLocalDirectory, uploadLocalBundle } from "./workspace-files.js";
export type { WorkspaceFileClient, LocalFileBundle } from "./workspace-files.js";

export { createSkillSourceClient } from "./skill-sources.js";
export type { SkillSourceClient } from "./skill-sources.js";
export { createManagedWorkspaceClient } from "./managed-workspaces.js";
export type { ManagedWorkspaceClient } from "./managed-workspaces.js";
