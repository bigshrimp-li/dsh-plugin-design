import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_FILE_TRANSFER_BUDGET } from "@super-agent/protocol";
import type {
  CreateFileTransferRequest, FileApplyOperation, FileBranch, FileManifest, FileMergePreview,
  FileRetentionView, FileSnapshot, FileTransfer, FileTransferBudget, ManifestFile, RunFileArtifacts, RunFileState,
  ResolveFileDependencyRequest, ResolveFileDependencyResult,
  FileDependencyReview,
  FileImportInput, FileImportOperation,
  WorkspaceFileCapabilities, WorkspaceEnvironmentView,
  FileRollbackResult,
  RollbackRunFilesRequest,
} from "@super-agent/protocol";

export type FileServiceRequester = <T extends object>(method: "GET" | "POST", path: string, body?: Record<string, unknown>) => Promise<T>;
const encode = encodeURIComponent;
export function createWorkspaceFileClient(request: FileServiceRequester) {
  const post = <T extends object>(path: string, body: object): Promise<T> => request<T>("POST", path, body as Record<string, unknown>);
  return {
    capabilities: () => request<WorkspaceFileCapabilities>("GET", "/v1/files/capabilities"),
    environment: (input: { snapshotId?: string; runId?: string; presetId?: string }) => request<WorkspaceEnvironmentView>("GET", `/v1/files/environment?${new URLSearchParams(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"))}`),
    createTransfer: (body: CreateFileTransferRequest) => post<FileTransfer>("/v1/transfers", body),
    getTransfer: (id: string) => request<FileTransfer>("GET", `/v1/transfers/${encode(id)}`),
    uploadBlock: (id: string, body: { requestId: string; hash: string; dataBase64: string }) => post<FileTransfer>(`/v1/transfers/${encode(id)}:upload`, body),
    commitTransfer: (id: string, requestId: string) => post<FileSnapshot>(`/v1/transfers/${encode(id)}:commit`, { requestId }),
    cancelTransfer: (id: string, requestId: string) => post<FileTransfer>(`/v1/transfers/${encode(id)}:cancel`, { requestId }),
    getSnapshot: (id: string) => request<FileSnapshot>("GET", `/v1/file-snapshots/${encode(id)}`),
    listSnapshots: (workspaceId: string) => request<{ items: readonly FileSnapshot[] }>("GET", `/v1/workspaces/${encode(workspaceId)}/snapshots`),
    readSnapshotFile: (id: string, path: string) => request<{ path: string; size: number; dataBase64: string }>("GET", `/v1/file-snapshots/${encode(id)}/file?path=${encode(path)}`),
    snapshotDirectory: (workspaceId: string, body: { requestId: string; path: string; rules?: readonly string[] }) => post<FileSnapshot>(`/v1/workspaces/${encode(workspaceId)}/snapshots`, { ...body, mode: "server_directory" }),
    snapshotGit: (workspaceId: string, body: { requestId: string; repository: string; ref: string }) => post<FileSnapshot>(`/v1/workspaces/${encode(workspaceId)}/snapshots`, { ...body, mode: "git" }),
    startImport: (body: FileImportInput & { requestId: string }) => post<FileImportOperation>("/v1/file-import-operations", body),
    getImport: (id: string) => request<FileImportOperation>("GET", `/v1/file-import-operations/${encode(id)}`),
    listImports: () => request<{ items: readonly FileImportOperation[] }>("GET", "/v1/file-import-operations"),
    cancelImport: (id: string, requestId: string) => post<FileImportOperation>(`/v1/file-import-operations/${encode(id)}:cancel`, { requestId }),
    retryImport: (id: string, requestId: string) => post<FileImportOperation>(`/v1/file-import-operations/${encode(id)}:retry`, { requestId }),
    createBranch: (body: { requestId: string; workspaceId: string; conversationId: string; snapshotId: string }) => post<FileBranch>("/v1/file-branches", body),
    getBranch: (id: string) => request<FileBranch>("GET", `/v1/file-branches/${encode(id)}`),
    previewMerge: (id: string, body: { requestId: string; baseSnapshotId: string; incomingSnapshotId: string }) => post<FileMergePreview>(`/v1/file-branches/${encode(id)}:preview-merge`, body),
    mergeBranch: (id: string, body: { requestId: string; expectedRevision: number; baseSnapshotId: string; incomingSnapshotId: string; resolutions?: Readonly<Record<string, "current" | "incoming">> }) => post<FileBranch>(`/v1/file-branches/${encode(id)}:merge`, body),
    getRunFiles: (id: string) => request<RunFileState>("GET", `/v1/runs/${encode(id)}/files`),
    getArtifacts: (id: string) => request<RunFileArtifacts>("GET", `/v1/runs/${encode(id)}/artifacts`),
    rebindDependency: (id: string, body: { requestId: string; expectedRevision: number; snapshotId: string }) => post<RunFileState>(`/v1/runs/${encode(id)}:rebind-files`, body),
    resolveDependency: (id: string, body: ResolveFileDependencyRequest) => post<ResolveFileDependencyResult>(`/v1/runs/${encode(id)}:resolve-file-dependency`, body),
    dependencyReview: (id: string) => request<FileDependencyReview>("GET", `/v1/runs/${encode(id)}/file-dependency`),
    adoptPartial: (id: string, body: { requestId: string; expectedRevision: number; paths: readonly string[] }) => post<FileSnapshot>(`/v1/runs/${encode(id)}:adopt-partial-files`, body),
    retryBranch: (id: string, body: { requestId: string; conversationId: string }) => post<FileBranch>(`/v1/runs/${encode(id)}:retry-file-branch`, body),
    dependentRuns: (id: string) => request<{ items: readonly RunFileState[] }>("GET", `/v1/runs/${encode(id)}/file-dependents`),
    retention: () => request<FileRetentionView>("GET", "/v1/files/retention"),
    collectContent: (requestId: string) => post<{ removedObjects: number; removedBytes: number }>("/v1/files:collect", { requestId }),
    expireSnapshot: (id: string, body: { requestId: string; expectedRootHash: string }) => post<{ snapshotId: string; expiredAt: number }>(`/v1/file-snapshots/${encode(id)}:expire`, body),
    rollbackRun: (id: string, body: RollbackRunFilesRequest) => post<FileRollbackResult>(`/v1/runs/${encode(id)}:rollback-files`, body),
    applyArtifacts: (id: string, body: { requestId: string; destination: string; paths: readonly string[]; retryOperationId?: string }) => post<FileApplyOperation>(`/v1/runs/${encode(id)}/artifacts:apply`, body),
    getApplyOperation: (id: string) => request<FileApplyOperation>("GET", `/v1/artifact-applies/${encode(id)}`),
  };
}
export type WorkspaceFileClient = ReturnType<typeof createWorkspaceFileClient>;

export type LocalFileBundle = {
  readonly root: string;
  readonly manifest: FileManifest;
  readonly bytes: number;
  readonly blocks: ReadonlyMap<string, Buffer>;
};
const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const git = promisify(execFile);

/** Reads a stable local candidate once. Retrying its upload reuses these exact bytes. */
export async function packLocalDirectory(path: string, options: {
  readonly budget?: FileTransferBudget;
  readonly rules?: readonly string[];
  readonly signal?: AbortSignal;
} = {}): Promise<LocalFileBundle> {
  const root = await realpath(path), budget = options.budget ?? DEFAULT_FILE_TRANSFER_BUDGET;
  const rules = options.rules ?? [".git", "node_modules", ".cache", "dist", "build", ".env", ".env.*", "*.pem", "*.key"];
  const deadline = Date.now() + budget.timeoutMs, files: ManifestFile[] = [], blocks = new Map<string, Buffer>();
  const ignored: string[] = [], signatures = new Map<string, string>();
  const signature = (item: Awaited<ReturnType<typeof lstat>>): string => [item.dev, item.ino, item.mode, item.size, item.mtimeMs, item.ctimeMs].join(":");
  let includedByGit: Set<string> | null = null;
  const includedDirectories = new Set<string>();
  try {
    const result = await git("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000, signal: options.signal });
    includedByGit = new Set(result.stdout.split("\0").filter(Boolean));
    for (const file of includedByGit) {
      const parts = file.split("/");
      for (let index = 1; index < parts.length; index++) includedDirectories.add(parts.slice(0, index).join("/"));
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    // A non-Git directory is still a valid source. The explicit rules remain in the manifest.
    if ((error as { killed?: boolean }).killed) throw error;
  }
  const ignoredByRule = (path: string): boolean => rules.some((rule) => {
    const pattern = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return pattern.test(path) || path.split("/").some((part) => pattern.test(part));
  });
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    options.signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error("local snapshot exceeded its time budget");
    const prefix = relative(root, directory).split("\\").join("/");
    signatures.set(prefix, signature(await lstat(directory)));
    for (const name of (await readdir(directory)).sort()) {
      const filePath = prefix ? `${prefix}/${name}` : name, absolute = join(directory, name);
      if (ignoredByRule(filePath)) { ignored.push(filePath); continue; }
      const before = await lstat(absolute);
      if (before.isDirectory()) {
        if (includedByGit !== null && !includedDirectories.has(filePath)) { ignored.push(filePath); continue; }
        await visit(absolute); continue;
      }
      if (includedByGit !== null && !includedByGit.has(filePath)) { ignored.push(filePath); continue; }
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(`symlinks and special files cannot be uploaded: ${filePath}`);
      if (files.length >= budget.maxFiles || before.size > budget.maxFileBytes || bytes + before.size > budget.maxBytes) throw new Error(`snapshot budget exceeded: ${filePath}`);
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: Buffer;
      try {
        if (signature(await handle.stat()) !== signature(before)) throw new Error(`file changed while packing: ${filePath}`);
        data = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < data.length) {
          const read = await handle.read(data, offset, Math.min(1024 * 1024, data.length - offset), offset);
          if (read.bytesRead === 0) throw new Error(`file shrank while packing: ${filePath}`);
          offset += read.bytesRead;
        }
        if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new Error(`file grew while packing: ${filePath}`);
        if (signature(await handle.stat()) !== signature(before)) throw new Error(`file changed while packing: ${filePath}`);
      } finally { await handle.close(); }
      signatures.set(filePath, signature(before));
      const hashes: string[] = [];
      for (let offset = 0; offset < data.length; offset += budget.blockBytes) {
        const block = data.subarray(offset, offset + budget.blockBytes), digest = sha(block);
        hashes.push(digest); blocks.set(digest, block);
      }
      bytes += data.length;
      files.push({ path: filePath, size: data.length, hash: sha(data), mode: before.mode & 0o111 ? 0o755 : 0o644, blocks: hashes });
    }
  };
  await visit(root);
  for (const [path, expected] of signatures) {
    if (signature(await lstat(path ? join(root, path) : root)) !== expected) throw new Error(`source changed while packing: ${path || "."}`);
  }
  return { root, manifest: { version: 1, files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), ignored, rules: [...rules, ...(includedByGit ? ["gitignore:git-ls-files"] : [])] }, bytes, blocks };
}

/** Resume a transfer only with the original candidate. Publication follows complete integrity checks. */
export async function uploadLocalBundle(client: WorkspaceFileClient, bundle: LocalFileBundle, input: {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly operationId?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (operation: FileTransfer) => void;
}): Promise<FileSnapshot> {
  const operation = input.operationId ? await client.getTransfer(input.operationId) : await client.createTransfer({
    requestId: input.requestId, workspaceId: input.workspaceId, manifest: bundle.manifest, source: { mode: "local_upload", location: bundle.root },
  });
  if (operation.workspaceId !== input.workspaceId || JSON.stringify(operation.manifest) !== JSON.stringify(bundle.manifest)) throw new Error("resumed upload requires the original manifest; create a new candidate for changed source files");
  for (const digest of operation.missingBlocks) {
    input.signal?.throwIfAborted();
    const bytes = bundle.blocks.get(digest);
    if (!bytes || sha(bytes) !== digest) throw new Error("local upload candidate has missing or changed content");
    const updated = await client.uploadBlock(operation.operationId, { requestId: `${input.requestId}:block:${digest}`, hash: digest, dataBase64: bytes.toString("base64") });
    input.onProgress?.(updated);
  }
  input.signal?.throwIfAborted();
  return client.commitTransfer(operation.operationId, `${input.requestId}:commit`);
}
