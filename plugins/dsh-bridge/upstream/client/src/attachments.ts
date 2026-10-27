import type { AttachmentDraft, AttachmentOperation, AttachmentPreview, AttachmentReadResult,
  ComposerCapabilities, CreateAttachmentDraftRequest, InputPreviewRequest, PreparedAttachment,
  PrepareAttachmentRequest, ReadAttachmentRequest } from "@super-agent/protocol";
import type { FileServiceRequester } from "./workspace-files.js";
export function createAttachmentClient(request: FileServiceRequester) {
  const post = <T extends object>(path: string, body: object): Promise<T> => request<T>("POST", path, body as Record<string, unknown>);
  const path = (id: string) => `/v1/attachments/${encodeURIComponent(id)}`;
  return {
    capabilities: () => request<ComposerCapabilities>("GET", "/v1/attachment-capabilities"),
    projectFiles: (workspaceId: string, query?: string) => request<{ items: readonly { path: string; size: number }[]; truncated: boolean }>("GET", `/v1/workspace-attachment-files?workspaceId=${encodeURIComponent(workspaceId)}${query ? `&query=${encodeURIComponent(query)}` : ""}`),
    evidence: (id: string, conversationId?: string) => request<{ items: readonly import("@super-agent/protocol").AttachmentReadEvidence[] }>("GET", `${path(id)}/evidence${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`),
    createDraft: (body: CreateAttachmentDraftRequest) => post<AttachmentDraft>("/v1/attachment-drafts", body),
    getDraft: (id: string) => request<AttachmentDraft>("GET", `/v1/attachment-drafts/${encodeURIComponent(id)}`),
    prepare: (body: PrepareAttachmentRequest & { projectPath?: string }) => post<PreparedAttachment>("/v1/attachments:prepare", body),
    get: (id: string) => request<PreparedAttachment>("GET", path(id)),
    getOperation: (id: string) => request<AttachmentOperation>("GET", `/v1/attachment-operations/${encodeURIComponent(id)}`),
    remove: (id: string, body: { requestId: string; draftId: string }) => post<AttachmentDraft>(`${path(id)}:remove`, body),
    retry: (id: string, body: { requestId: string }) => post<PreparedAttachment>(`${path(id)}:retry`, body),
    cancel: (id: string, body: { requestId: string }) => post<AttachmentOperation>(`/v1/attachment-operations/${encodeURIComponent(id)}:cancel`, body),
    read: (input: Omit<ReadAttachmentRequest, "evidence">) => {
      const query = new URLSearchParams({ representationId: input.representationId });
      if (input.format) query.set("format", input.format);
      if (input.range) query.set("range", JSON.stringify(input.range));
      return request<AttachmentReadResult>("GET", `${path(input.attachmentId)}/content?${query}`);
    },
    previewInput: (body: InputPreviewRequest) => post<AttachmentPreview>("/v1/input-previews", body),
  };
}
export type AttachmentClient = ReturnType<typeof createAttachmentClient>;
