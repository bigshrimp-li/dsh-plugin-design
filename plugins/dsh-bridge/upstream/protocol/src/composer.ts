import type { AttachmentUse } from "./attachments.js";
import type { InputDelivery, SelectedSkillRef } from "./p1-contracts.js";

/** Absence of negotiated capabilities never implies support. */
export type ComposerCapabilities = {
  readonly runtime: "typescript-pi" | "go" | "unavailable"; readonly supported: boolean; readonly reason?: string;
  readonly formats: readonly { readonly mediaType: string; readonly extensions: readonly string[] }[];
  readonly limits: { readonly maxAttachments: number; readonly maxTotalBytes: number; readonly maxTextBytes: number;
    readonly maxImageBytes: number; readonly maxPixels: number; readonly maxPages: number;
    readonly inlineTokens: number; readonly readTokens: number; readonly draftTtlMs: number };
  readonly drafts: boolean; readonly inputPreview: boolean; readonly read: boolean;
  readonly skillSelection: boolean; readonly projectFiles: boolean;
};
/** The service resolves model, history and authorization; the UI cannot supply budget facts. */
export type InputPreviewRequest = {
  readonly requestId: string; readonly draftId: string; readonly text: string; readonly attachments: readonly AttachmentUse[];
  readonly conversationId?: string; readonly workspaceId?: string | null; readonly modelId?: string; readonly provider?: string;
  readonly selectedSkillRefs?: readonly SelectedSkillRef[]; readonly selectedSkillIds?: readonly string[];
  readonly thinkingLevel?: string | null; readonly permissionMode?: "approve_all" | "workspace_auto" | "approve_none" | null;
  readonly delivery?: InputDelivery; readonly targetRunId?: string;
};
