import type { JsonObject } from "./json.js";

export type CoreIdentity = { instanceId: string; protocolVersion: number; authentication: "pairing" };
export type CoreLogin = { instanceId: string; actorId: string; accessToken: string; expiresAt: number };
export type McpServerSettings = { id: string; url: string; enabled: boolean; credentialRef: string | null;
  timeoutMs: number; allowLoopbackHttp?: boolean };
export type SettingsConfiguration = {
  modelAvailability?: { disabledProviders: string[]; disabledModels: string[] };
  mcpServers?: McpServerSettings[];
  modelConfiguration: JsonObject;
  defaultModelConfigId: string | null;
  context: { autoInstructions: boolean; maxFileBytes: number; maxTotalBytes: number; timeoutMs: number };
  tools: { enabled: string[]; approval: "approve_all" | "workspace_auto" | "approve_none" };
};
export type SettingsView = { instanceId: string; version: number; configuration: SettingsConfiguration; updatedAt: number };
export type ApplySettingsRequest = { requestId: string; expectedVersion: number; configuration: SettingsConfiguration };
export type SettingsOperation = {
  operationId: string; requestId: string; actorId: string;
  status: "accepted" | "activating" | "succeeded" | "failed" | "unknown";
  acceptedAt: number; completedAt: number | null; version: number | null; errorCode: string | null;
};
export type StagedCredential = { credentialRef: string; expiresAt: number; status: "staged" | "bound" | "expired" | "revoked" };
export type CheckCredentialRequest = { requestId: string; providerId: string; modelConfiguration?: JsonObject };
export type CredentialCheckResult = {
  readonly requestId: string; readonly actorId: string; readonly credentialRef: string; readonly providerId: string;
  readonly status: "endpoint_accepted" | "rejected" | "unsupported" | "unreachable";
  readonly checkedAt: number; readonly httpStatus: number | null; readonly errorCode: string | null;
  readonly scope: "authenticated_catalog" | "endpoint_only"; readonly generationInvoked: false;
};
