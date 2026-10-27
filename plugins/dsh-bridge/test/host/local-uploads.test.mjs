import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceFileService } from "@super-agent/server";
import { createWorkspaceFileClient } from "@super-agent/client";
import { matchWorkspaceFileRoute, handleWorkspaceFileRoute } from "@super-agent/server";
import { createLocalUploadService } from "../../src/host/local-uploads.js";

const homes = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sa-local-upload-")); homes.push(home); const source = join(home, "source"); await mkdir(source); await writeFile(join(source, "chosen.txt"), "captured original bytes");
  const server = new WorkspaceFileService({ directory: join(home, "server"), allowedRoots: [], budget: { blockBytes: 4 } });
  const sdk = createWorkspaceFileClient(async (method, path, body) => { const url = new URL(path, "http://test"); return (await handleWorkspaceFileRoute({ route: matchWorkspaceFileRoute(method, url.pathname), body: body || {}, query: url.searchParams, headerRequestId: body?.requestId }, server, "authenticated-host")).body; });
  const options = { files: sdk, home, targetKey: "core-instance", actorId: "host-actor" };
  return { home, source, server, sdk, options, upload: createLocalUploadService(options) };
}
async function settled(upload, id) {
  for (let i = 0; i < 400; i++) { const operation = await upload.get(id); if (!["queued", "uploading", "cancelling"].includes(operation.status)) return operation; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("local upload did not settle");
}
it("persists the original candidate across host restart and recovers a published transfer without rereading edited source files", async () => {
  const f = await fixture(), captured = await f.upload.preview(f.source);
  await writeFile(join(f.source, "chosen.txt"), "later source changes");
  const reopened = createLocalUploadService(f.options), request = { requestId: "upload", candidateId: captured.candidateId, workspaceId: "project" };
  const started = await reopened.start(request), completed = await settled(reopened, started.operationId);
  expect(completed.status).toBe("succeeded"); expect(completed.missingBlocks).toBe(0);
  expect((await f.server.readSnapshotFile(completed.snapshot.snapshotId, "chosen.txt")).toString()).toBe("captured original bytes");
  expect(await reopened.start(request)).toEqual(completed);
  const scope = (await readdir(join(f.home, "dsh-content-uploads")))[0], journal = join(f.home, "dsh-content-uploads", scope, "operations", `${started.operationId}.json`);
  await writeFile(journal, JSON.stringify({ ...completed, status: "uploading", snapshot: null }));
  const recovered = createLocalUploadService(f.options); expect((await recovered.get(started.operationId)).status).toBe("interrupted");
  await recovered.resume(started.operationId, "recover-original"); const restored = await settled(recovered, started.operationId);
  expect(restored.status).toBe("succeeded"); expect(restored.snapshot.snapshotId).toBe(completed.snapshot.snapshotId); expect((await f.server.listSnapshots("project"))).toHaveLength(1);
  await expect(recovered.start({ ...request, workspaceId: "different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(createLocalUploadService({ ...f.options, targetKey: "different-core" }).get(started.operationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await readFile(join(f.source, "chosen.txt"), "utf8")).toBe("later source changes");
});

it("queries progress and cancels without publishing, then explicitly resumes the same captured content", async () => {
  const f = await fixture(); let unblock; const held = new Promise(resolve => { unblock = resolve; }); let entered; const began = new Promise(resolve => { entered = resolve; }); let first = true;
  const upload = createLocalUploadService({ ...f.options, files: { ...f.sdk, uploadBlock: async (...args) => { if (first) { first = false; entered(); await held; } return f.sdk.uploadBlock(...args); } } });
  const candidate = await upload.preview(f.source), operation = await upload.start({ requestId: "upload", candidateId: candidate.candidateId, workspaceId: "project" }); await began;
  expect((await upload.get(operation.operationId)).status).toBe("uploading"); expect((await upload.list()).items[0].transferId).toBeTruthy();
  expect((await upload.cancel(operation.operationId, "cancel")).status).toBe("cancelling"); unblock();
  const cancelled = await settled(upload, operation.operationId); expect(cancelled.status).toBe("cancelled"); expect(await f.server.listSnapshots("project")).toEqual([]);
  await writeFile(join(f.source, "chosen.txt"), "different live directory");
  await upload.resume(operation.operationId, "resume-original"); const completed = await settled(upload, operation.operationId);
  expect(completed.status).toBe("succeeded"); expect(completed.operationId).toBe(operation.operationId); expect(completed.attempt).toBe(2);
  expect((await f.server.readSnapshotFile(completed.snapshot.snapshotId, "chosen.txt")).toString()).toBe("captured original bytes");
  const staleCancel = await upload.cancel(operation.operationId, "cancel"); expect(staleCancel.status).toBe("succeeded"); expect(staleCancel.attempt).toBe(2);
  await expect(upload.resume(operation.operationId, "cancel")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("reopens a partially uploaded operation after a transport failure and resumes its original remote transfer", async () => {
  const f = await fixture(); let blocks = 0;
  const failing = createLocalUploadService({ ...f.options, files: { ...f.sdk, uploadBlock: async (...args) => { if (++blocks === 2) throw new Error("simulated disconnected transport"); return f.sdk.uploadBlock(...args); } } });
  const candidate = await failing.preview(f.source), operation = await failing.start({ requestId: "partial", candidateId: candidate.candidateId, workspaceId: "project" });
  const interrupted = await settled(failing, operation.operationId); expect(interrupted.status).toBe("failed"); expect(interrupted.missingBlocks).toBeLessThan(interrupted.totalBlocks);
  await writeFile(join(f.source, "chosen.txt"), "modified while host was closed");
  const reopened = createLocalUploadService(f.options); expect((await reopened.list()).items[0].operationId).toBe(operation.operationId);
  await reopened.resume(operation.operationId, "resume-partial"); const completed = await settled(reopened, operation.operationId);
  expect(completed.status).toBe("succeeded"); expect(completed.transferId).toBe(interrupted.transferId); expect(completed.transferIds).toHaveLength(1);
  expect((await f.server.readSnapshotFile(completed.snapshot.snapshotId, "chosen.txt")).toString()).toBe("captured original bytes");
  expect((await reopened.inspect(operation.operationId)).snapshot.snapshotId).toBe(completed.snapshot.snapshotId);
});

it("expires only captured cache bytes after the advertised day and keeps the user's source directory", async () => {
  const f = await fixture(); let now = Date.now(); const upload = createLocalUploadService({ ...f.options, now: () => now });
  const captured = await upload.preview(f.source), scope = (await readdir(join(f.home, "dsh-content-uploads")))[0], cache = join(f.home, "dsh-content-uploads", scope);
  expect((await readdir(join(cache, "blocks"))).length).toBeGreaterThan(0);
  now = captured.expiresAt + 1; await upload.list();
  expect(await readdir(join(cache, "candidates"))).toEqual([]); expect(await readdir(join(cache, "blocks"))).toEqual([]);
  await expect(upload.start({ requestId: "expired", candidateId: captured.candidateId, workspaceId: "project" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await readFile(join(f.source, "chosen.txt"), "utf8")).toBe("captured original bytes"); expect(await f.server.listSnapshots("project")).toEqual([]);
});
