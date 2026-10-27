/** Reviewed installation of immutable Skill packages into execution-owned directories. */
export type SkillInstallLocation = {
  readonly targetId: string; readonly workspaceId: string | null; readonly scope: "global" | "workspace";
  readonly machineId: string; readonly executionUser: string; readonly rootPath: string; readonly writable: boolean;
};
export type SkillDiscoveryCandidate = {
  readonly candidateId: string; readonly agent: string; readonly path: string; readonly realPath: string;
  readonly workspaceId: string | null; readonly name: string | null; readonly description: string;
  readonly files: number; readonly bytes: number; readonly digest: string | null;
  readonly warnings: readonly string[]; readonly errors: readonly string[];
};
export type SkillInstallationRecord = {
  readonly installationId: string; readonly actorId: string; readonly workspaceId: string | null;
  readonly sourceId: string; readonly originSourceId: string; readonly sourceSkillPath: string;
  readonly sourceSnapshotId: string; readonly adoptedSnapshotId: string; readonly name: string;
  readonly skillId: string; readonly description: string; readonly targetPath: string;
  readonly sourceDigest: string; readonly installedDigest: string; readonly enabled: boolean;
  readonly sourceRevision: number;
  readonly removed: boolean; readonly revision: number; readonly createdAt: number; readonly updatedAt: number;
  readonly lastCheckedAt?: number;
};
export type SkillInstallPlanItem = {
  readonly installationId: string; readonly sourceId: string; readonly sourceSkillPath: string;
  readonly name: string; readonly skillId: string; readonly description: string; readonly targetPath: string;
  readonly digest: string; readonly sourceDigest: string; readonly expectedTargetDigest: string | null; readonly previousSourceDigest: string | null;
  readonly expectedInstallationRevision: number; readonly expectedSourceRevision: number; readonly expectedPolicyRevision: number; readonly expectedOriginPolicyRevision: number;
  readonly added: readonly string[]; readonly modified: readonly string[]; readonly removed: readonly string[];
  readonly warnings: readonly string[]; readonly errors: readonly string[];
};
export type SkillInstallPlan = {
  readonly planId: string; readonly actorId: string; readonly kind: "import" | "update" | "migration";
  readonly workspaceId: string | null; readonly originSourceId: string; readonly sourceSnapshotId: string;
  readonly sourceRevision: number; readonly createdAt: number; readonly expiresAt: number;
  readonly ready: boolean; readonly items: readonly SkillInstallPlanItem[];
};
export type SkillInstallationOperation = {
  readonly operationId: string; readonly actorId: string; readonly requestId: string; readonly planId: string;
  readonly status: "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  readonly stage: "prepared" | "publishing" | "published" | "adopting" | "completed";
  readonly completedInstallationIds: readonly string[]; readonly currentInstallationId: string | null;
  readonly createdAt: number; readonly updatedAt: number;
  readonly error: { readonly code: string; readonly message: string } | null;
};
export type PreviewSkillImportRequest = {
  readonly requestId: string; readonly workspaceId: string | null; readonly sourceId: string; readonly snapshotId: string;
  readonly skillPaths?: readonly string[]; readonly aliases?: Readonly<Record<string, string>>; readonly replace?: boolean;
};
export type PreviewSkillUpdateRequest = {
  readonly requestId: string; readonly installationId: string; readonly expectedRevision: number;
  readonly snapshotId?: string; readonly ref?: string; readonly expectedPackageHash?: string;
  readonly resolution?: "source" | "local";
};
export type ApplySkillInstallRequest = { readonly requestId: string; readonly planId: string };
export type DiscoverSkillsRequest = { readonly workspaceId: string | null; readonly cwd?: string };
