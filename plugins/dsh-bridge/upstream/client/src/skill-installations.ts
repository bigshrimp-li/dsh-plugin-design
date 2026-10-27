import type { ApplySkillInstallRequest, DiscoverSkillsRequest, PreviewSkillImportRequest, PreviewSkillUpdateRequest,
  SkillDiscoveryCandidate, SkillInstallLocation, SkillInstallPlan, SkillInstallationOperation, SkillInstallationRecord } from "@super-agent/protocol";
import type { FileServiceRequester } from "./workspace-files.js";
export function createSkillInstallationClient(request: FileServiceRequester) {
  const post = <T extends object>(path: string, body: object): Promise<T> => request<T>("POST", path, body as Record<string, unknown>);
  const base = "/v1/skill-installations";
  const action = (id: string, name: string) => `${base}/${encodeURIComponent(id)}:${name}`;
  return {
    locations: (workspaceId?: string) => request<{ items: readonly SkillInstallLocation[] }>("GET", `/v1/skill-locations${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),
    list: (workspaceId?: string) => request<{ items: readonly SkillInstallationRecord[] }>("GET", `${base}${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),
    discover: (body: DiscoverSkillsRequest & { requestId: string }) => post<{ items: readonly SkillDiscoveryCandidate[] }>("/v1/skill-discovery", body),
    previewImport: (body: PreviewSkillImportRequest) => post<SkillInstallPlan>(`${base}:preview-import`, body),
    previewMigration: (body: PreviewSkillImportRequest) => post<SkillInstallPlan>(`${base}:preview-migration`, body),
    previewUpdate: (body: PreviewSkillUpdateRequest) => post<SkillInstallPlan>(`${base}:preview-update`, body),
    apply: (body: ApplySkillInstallRequest) => post<SkillInstallationOperation>(`${base}:apply`, body),
    getOperation: (id: string) => request<SkillInstallationOperation>("GET", `/v1/skill-installation-operations/${encodeURIComponent(id)}`),
    listOperations: () => request<{ items: readonly SkillInstallationOperation[] }>("GET", "/v1/skill-installation-operations"),
    retry: (id: string, body: { requestId: string }) => post<SkillInstallationOperation>(`/v1/skill-installation-operations/${encodeURIComponent(id)}:retry`, body),
    cancel: (id: string, body: { requestId: string }) => post<SkillInstallationOperation>(`/v1/skill-installation-operations/${encodeURIComponent(id)}:cancel`, body),
    setEnabled: (id: string, body: { requestId: string; expectedRevision: number; enabled: boolean }) => post<SkillInstallationRecord>(action(id, "enabled"), body),
    remove: (id: string, body: { requestId: string; expectedRevision: number }) => post<SkillInstallationRecord>(action(id, "remove"), body),
  };
}
export type SkillInstallationClient = ReturnType<typeof createSkillInstallationClient>;
