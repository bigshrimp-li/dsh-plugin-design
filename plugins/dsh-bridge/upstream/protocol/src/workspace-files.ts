/** Immutable file versions are separate from configuration versions. */
export type ExecutionEnvironmentPreset = {
  readonly presetId: string; readonly name: string; readonly available: boolean;
  readonly operatingSystem: string; readonly runtime: string; readonly executionIdentity: string;
  readonly tools: readonly { readonly name: string; readonly available: boolean; readonly version: string | null }[];
};
export type WorkspaceEnvironmentView = {
  readonly preset: ExecutionEnvironmentPreset; readonly checkedAt: string;
  readonly snapshotId: string; readonly runId: string | null; readonly executionRoot: string | null;
  readonly dependencies: {
    readonly status: "ready" | "installation_required" | "unknown" | "invalid";
    readonly manifest: string | null; readonly required: readonly string[];
    readonly diagnostics: readonly string[];
  };
};
export type WorkspaceFileCapabilities = {
  readonly budget: FileTransferBudget; readonly operatingSystemSandbox: boolean;
  readonly storageQuotaBytes: number; readonly quotaScope: string; readonly quotaWarningRatio: number;
  readonly sourceModes: readonly string[]; readonly snapshotIsolation: string;
  readonly executionEnvironments: readonly ExecutionEnvironmentPreset[];
};

export type FileTransferBudget = {
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly blockBytes: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
};

export const DEFAULT_FILE_TRANSFER_BUDGET: FileTransferBudget = Object.freeze({
  maxBytes: 200 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024, maxFiles: 20_000,
  blockBytes: 256 * 1024, concurrency: 4, timeoutMs: 30 * 60 * 1000,
});

export type ManifestFile = {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly mode: 420 | 493;
  /** SHA-256 of each ordered block; the final file hash is checked at commit. */
  readonly blocks: readonly string[];
};

export type FileManifest = {
  readonly version: 1;
  readonly files: readonly ManifestFile[];
  readonly ignored: readonly string[];
  readonly rules: readonly string[];
};

export type FileSnapshotSource = {
  readonly mode: "local_upload" | "server_directory" | "git" | "package" | "run_result" | "merge";
  readonly location: string;
  readonly requestedRef?: string;
  readonly commit?: string;
  readonly packageHash?: string;
};

export type FileSnapshot = {
  readonly snapshotId: string;
  readonly workspaceId: string;
  readonly rootHash: string;
  readonly createdAt: number;
  readonly actorId: string;
  readonly source: FileSnapshotSource;
  readonly manifest: FileManifest;
  readonly bytes: number;
};

export type CreateFileTransferRequest = {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly manifest: FileManifest;
  readonly source: FileSnapshotSource;
};

export type FileTransfer = {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: "uploading" | "published" | "cancelled";
  readonly manifest: FileManifest;
  readonly source: FileSnapshotSource;
  readonly missingBlocks: readonly string[];
  readonly snapshotId: string | null;
};

export type SkillSyncInput = {
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly ref?: string;
  readonly expectedPackageHash?: string;
};

/** A source download publishes only a candidate version. Adoption is a separate command. */
export type ContentSyncOperation<TInput extends object, TResult extends object, TKind extends string> = {
  readonly operationId: string;
  readonly kind: TKind;
  readonly actorId: string;
  readonly requestId: string;
  readonly input: TInput;
  readonly status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly attempt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result: TResult | null;
  readonly error: { readonly code: string; readonly message: string } | null;
};

export type SkillSyncOperation = ContentSyncOperation<SkillSyncInput, SkillSourceRecord, "skill_sync">;
export type FileImportInput =
  | { readonly mode: "server_directory"; readonly workspaceId: string; readonly path: string; readonly rules?: readonly string[] }
  | { readonly mode: "git"; readonly workspaceId: string; readonly repository: string; readonly ref: string; readonly credentialRef?: string };
export type FileImportOperation = ContentSyncOperation<FileImportInput, FileSnapshot, "file_import">;

export type FileBranch = {
  readonly branchId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly currentSnapshotId: string;
  readonly revision: number;
  readonly activeRunId: string | null;
  readonly createdAt: number;
  readonly sourceRunId?: string;
};

export type FileInputPolicy =
  | { readonly mode: "fixed_snapshot"; readonly snapshotId: string }
  | { readonly mode: "after_run"; readonly dependsOnRunId: string };

export type RunFileState = {
  readonly runId: string;
  readonly branchId: string;
  readonly input: FileInputPolicy;
  readonly status: "waiting" | "dependency_blocked" | "ready" | "succeeded" | "failed" | "cancelled" | "unknown";
  readonly inputSnapshotId: string | null;
  readonly inputHash: string | null;
  readonly executionRoot: string | null;
  readonly resultSnapshotId: string | null;
  readonly branchRevision: number;
  readonly revision: number;
  readonly actorId: string;
  readonly verification?: FileResultVerification;
};

/** An appended review fact does not rewrite the original unknown Run or its result. */
export type FileResultVerification = {
  readonly requestId: string;
  readonly actorId: string;
  readonly verifiedAt: number;
  readonly originalResultSnapshotId: string;
  readonly verifiedSnapshotId: string;
  readonly evidenceRefs: readonly string[];
  readonly executions: readonly { readonly executionId: string; readonly verificationRequestId: string; readonly conclusion: "succeeded" | "failed" | "not_executed" }[];
};

export type FileArtifact = {
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly before: ManifestFile | null;
  readonly after: ManifestFile | null;
};

export type RunFileArtifacts = {
  readonly run: RunFileState;
  readonly inputSnapshot: FileSnapshot;
  readonly resultSnapshot: FileSnapshot;
  readonly files: readonly FileArtifact[];
};

export type RollbackRunFilesRequest = {
  readonly requestId: string;
  /** The branch revision the user reviewed before confirming the rollback. */
  readonly expectedRevision: number;
  /** Each hash is the current file the user saw; null means it was absent. */
  readonly files: readonly {
    readonly path: string;
    readonly expectedCurrentHash: string | null;
  }[];
};

export type FileRollbackItem = {
  readonly path: string;
  readonly status: "restored" | "conflict" | "already_restored" | "failed";
  readonly currentHash: string | null;
  readonly rollbackHash: string | null;
  readonly reason: string | null;
};

export type FileRollbackResult = {
  readonly rollbackId: string;
  readonly runId: string;
  readonly branchId: string;
  readonly previousSnapshotId: string;
  readonly currentSnapshotId: string;
  readonly previousRevision: number;
  readonly currentRevision: number;
  readonly restoredCount: number;
  readonly conflictCount: number;
  readonly alreadyRestoredCount: number;
  readonly failedCount: number;
  readonly items: readonly FileRollbackItem[];
  readonly createdAt: number;
};

export type FileApplyItem = {
  readonly path: string;
  readonly status: "applied" | "conflict" | "skipped" | "failed";
  readonly reason: string | null;
};

export type FileApplyOperation = {
  readonly operationId: string;
  readonly runId: string;
  readonly destination: string;
  readonly actorId: string;
  readonly items: readonly FileApplyItem[];
};

export type FileMergePreview = {
  readonly branchId: string;
  readonly expectedRevision: number;
  readonly baseSnapshotId: string;
  readonly currentSnapshotId: string;
  readonly incomingSnapshotId: string;
  readonly conflicts: readonly string[];
  readonly files: readonly FileArtifact[];
};

export type FileRetentionView = {
  readonly historyRetentionMs: number;
  readonly unfinishedUploadRetentionMs: number;
  readonly totalBytes: number;
  readonly storedBytes: number;
  readonly quotaBytes: number;
  readonly availableBytes: number;
  readonly quotaWarning: boolean;
  readonly snapshots: readonly {
    readonly snapshotId: string;
    readonly rootHash: string;
    readonly workspaceId: string;
    readonly bytes: number;
    readonly createdAt: number;
    readonly availableUntil: number;
    readonly status: "available" | "expired";
    readonly protectedBy: readonly string[];
  }[];
};

export type SkillSourceRecord = {
  readonly sourceId: string;
  readonly kind: "local" | "directory" | "git" | "package" | "host_export";
  readonly location: string;
  readonly workspaceId: string | null;
  readonly actorId: string;
  readonly enabled: boolean;
  readonly activeSnapshotId: string | null;
  readonly versions: readonly string[];
  readonly revision: number;
  readonly credentialRef?: string;
  readonly expectedPackageHash?: string;
};

export type SkillCatalogItem = {
  readonly workspaceId?: string | null;
  readonly sourceRevision?: number;
  readonly overridesSourceIds?: readonly string[];
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
  readonly snapshotId: string;
  readonly hash: string;
  readonly packageHash: string;
  readonly policyRevision: number;
  readonly path: string;
  readonly status: "available" | "disabled" | "conflict" | "invalid";
  readonly diagnostic: string | null;
};

export type SkillCatalog = {
  readonly items: readonly SkillCatalogItem[];
  readonly counts: Readonly<Record<"available" | "disabled" | "conflict" | "invalid", number>>;
};
