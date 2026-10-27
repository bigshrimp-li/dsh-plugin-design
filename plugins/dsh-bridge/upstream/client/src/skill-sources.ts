import type { SkillCatalog, SkillSourceRecord, SkillSyncInput, SkillSyncOperation } from "@super-agent/protocol";
import type { FileServiceRequester } from "./workspace-files.js";

export function createSkillSourceClient(request: FileServiceRequester) {
  const path = (id: string, action: string): string => `/v1/skill-sources/${encodeURIComponent(id)}:${action}`;
  const post = <T extends object>(url: string, body: object): Promise<T> => request<T>("POST", url, body as Record<string, unknown>);
  return {
    listSources: (workspaceId?: string) => request<{ items: readonly SkillSourceRecord[] }>("GET", `/v1/skill-sources${workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`}`),
    getSource: (id: string) => request<SkillSourceRecord>("GET", `/v1/skill-sources/${encodeURIComponent(id)}`),
    scan: (workspaceId?: string) => request<SkillCatalog>("GET", `/v1/skills${workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`}`),
    catalog: (workspaceId?: string) => request<SkillCatalog>("GET", `/v1/skills${workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`}`),
    createSource: (body: { requestId: string; sourceId?: string; kind: SkillSourceRecord["kind"]; location: string; workspaceId: string | null; credentialRef?: string; expectedPackageHash?: string }) => post<SkillSourceRecord>("/v1/skill-sources", body),
    syncSource: (id: string, body: { requestId: string; expectedRevision: number; ref?: string; expectedPackageHash?: string }) => post<SkillSourceRecord>(path(id, "sync"), body),
    startSync: (id: string, body: Omit<SkillSyncInput, "sourceId"> & { requestId: string }) => post<SkillSyncOperation>(path(id, "sync-start"), body),
    getOperation: (id: string) => request<SkillSyncOperation>("GET", `/v1/skill-sync-operations/${encodeURIComponent(id)}`),
    listOperations: () => request<{ items: readonly SkillSyncOperation[] }>("GET", "/v1/skill-sync-operations"),
    cancelOperation: (id: string, body: { requestId: string }) => post<SkillSyncOperation>(`/v1/skill-sync-operations/${encodeURIComponent(id)}:cancel`, body),
    retryOperation: (id: string, body: { requestId: string }) => post<SkillSyncOperation>(`/v1/skill-sync-operations/${encodeURIComponent(id)}:retry`, body),
    recordVersion: (id: string, body: { requestId: string; snapshotId: string; expectedRevision: number; activate?: boolean }) => post<SkillSourceRecord>(path(id, "version"), body),
    updateSource: (id: string, body: { requestId: string; expectedRevision: number; enabled?: boolean; snapshotId?: string | null }) => post<SkillSourceRecord>(path(id, "update"), body),
    setPolicy: (id: string, body: { requestId: string; workspaceId: string | null; skillPath: string; enabled: boolean; alias?: string | null; expectedRevision?: number }) => post<{ enabled: boolean; alias: string | null; revision: number }>(path(id, "policy"), body),
    removeSource: (id: string, body: { requestId: string; workspaceId: string | null; expectedRevision: number }) => post<{ removed: true }>(path(id, "remove"), body),
  };
}
export type SkillSourceClient = ReturnType<typeof createSkillSourceClient>;
