import type { ManagedWorkspaceBrowseView, OpenManagedWorkspaceRequest, OpenManagedWorkspaceResult } from "@super-agent/protocol";
import type { FileServiceRequester } from "./workspace-files.js";

export function createManagedWorkspaceClient(request: FileServiceRequester) {
  return {
    browse: (relativePath = "", limit?: number) => request<ManagedWorkspaceBrowseView>("GET", `/v1/workspaces/managed?${new URLSearchParams({ relativePath, ...(limit === undefined ? {} : { limit: String(limit) }) })}`),
    open: (body: OpenManagedWorkspaceRequest) => request<OpenManagedWorkspaceResult>("POST", "/v1/workspaces/managed:open", body as unknown as Record<string, unknown>),
  };
}
export type ManagedWorkspaceClient = ReturnType<typeof createManagedWorkspaceClient>;
