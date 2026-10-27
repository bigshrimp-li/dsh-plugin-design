import { HEADER_CALLER, HEADER_PROTOCOL_VERSION, HEADER_REQUEST_ID, PROTOCOL_VERSION } from "@super-agent/protocol";
import type { ApplySettingsRequest, CoreIdentity, CoreLogin, SettingsOperation, SettingsView, McpServerSettings, StagedCredential, CheckCredentialRequest, CredentialCheckResult } from "@super-agent/protocol";
import type { ClientOptions } from "./client.js";
import { clientErrorFromEnvelope, parseErrorEnvelope } from "./errors.js";
import { malformedResponse, sendRequest } from "./transport.js";

export function createSettingsClient(options: ClientOptions) {
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<T> {
    const response = await sendRequest({ ...options, method, path, timeoutMs: options.requestTimeoutMs ?? 30000,
      headers: { [HEADER_CALLER]: options.caller, [HEADER_PROTOCOL_VERSION]: String(PROTOCOL_VERSION),
        ...(requestId === undefined ? {} : { [HEADER_REQUEST_ID]: requestId }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status < 200 || response.status >= 300) {
      let parsed: unknown; try { parsed = JSON.parse(response.body); } catch { throw malformedResponse(response.status); }
      const error = parseErrorEnvelope(parsed); if (error) throw clientErrorFromEnvelope(response.status, error);
      throw malformedResponse(response.status);
    }
    try { return JSON.parse(response.body) as T; } catch { throw malformedResponse(response.status); }
  }
  return {
    getIdentity: () => request<CoreIdentity>("GET", "/v1/identity"),
    pair: (input: { pairingCode: string; actorId: string }) => request<CoreLogin>("POST", "/v1/auth/pair", input),
    logout: () => request<{ loggedOut: true }>("POST", "/v1/auth/logout", {}),
    getMcpStatus: () => request<{ items: Record<string, unknown>[] }>("GET", "/v1/mcp/status"),
    checkMcp: (server: McpServerSettings) => request<Record<string, unknown>>("POST", "/v1/mcp:check", { server }),
    getModelHistory: () => request<Record<string, unknown>>("GET", "/v1/models/history"),
    listCredentials: () => request<{ items: StagedCredential[] }>("GET", "/v1/credentials"),
    checkCredential: (credentialRef: string, input: CheckCredentialRequest) => request<CredentialCheckResult>("POST", `/v1/credentials/${encodeURIComponent(credentialRef)}:check`, input, input.requestId),
    revokeCredential: (input: { requestId: string; credentialRef: string }) => request<{ credentialRef: string; status: "revoked"; actorId: string; revokedAt: number }>("POST", "/v1/credentials:revoke", input, input.requestId),
    getSettings: () => request<SettingsView>("GET", "/v1/settings"),
    applySettings: (input: ApplySettingsRequest) => request<SettingsOperation>("POST", "/v1/settings:apply", input, input.requestId),
    getOperation: (id: string) => request<SettingsOperation>("GET", `/v1/operations/${encodeURIComponent(id)}`),
    stageCredential: (input: { requestId: string; secret: string }) => request<StagedCredential>("POST", "/v1/credentials:stage", input, input.requestId),
    releaseCredential: (credentialRef: string) => request<{ released: true }>("POST", "/v1/credentials:release", { credentialRef }),
  };
}
