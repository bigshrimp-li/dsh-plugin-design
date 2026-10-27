import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createClient } from "@super-agent/client";
import { CoreServer, createConfiguredServingFactory, WorkspaceFileService } from "@super-agent/server";
import { createLocalArtifactService } from "../../src/host/local-artifacts.js";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it("downloads actual published Run artifacts through the SDK and applies them on the DSH computer with durable per-file recovery", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "sa-local-runtime-"))); cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  const source = join(scratch, "execution-source"), destination = join(scratch, "dsh-local-destination"); await mkdir(source); await mkdir(destination);
  for (const root of [source, destination]) { await writeFile(join(root, "edit.md"), "base"); await writeFile(join(root, "delete.md"), "delete baseline"); }
  const files = new WorkspaceFileService({ directory: join(scratch, "files"), allowedRoots: [source] });
  const snapshot = await files.snapshotDirectory({ requestId: "input", workspaceId: "project", path: source }, "actor");
  const branch = await files.createBranch({ requestId: "branch", workspaceId: "project", conversationId: "conversation", snapshotId: snapshot.snapshotId }, "actor");
  const run = await files.prepareRun({ runId: "published-run", branchId: branch.branchId, input: { mode: "fixed_snapshot", snapshotId: snapshot.snapshotId } }, "actor");
  await writeFile(join(run.executionRoot, "edit.md"), "actual changed result"); await writeFile(join(run.executionRoot, "new.md"), "actual new result"); await rm(join(run.executionRoot, "delete.md"));
  await files.completeRun({ runId: run.runId, status: "succeeded" });
  const server = new CoreServer({ home: join(scratch, "core"), runtime: createConfiguredServingFactory({ context: BACKGROUND_CONTEXT, env: {}, fileService: files,
    configuration: { schemaVersion: 1, agent: { name: "Artifact test", mission: "Read actual artifacts." }, maxConcurrentRuns: 1,
      retention: { maxEvents: 1000, maxAgeMs: null }, firstAdmissionCredentialRefs: [], modelConfiguration: { schemaVersion: 1, app: { name: "Test", version: "1" }, credentials: [], providers: [], models: [], requestPolicy: { totalTimeoutMs: 60000, streamIdleTimeoutMs: 30000, maxAttempts: 1 } } },
  }) });
  await server.start(); cleanups.push(() => server.stop());
  const sdk = createClient({ socketPath: server.socketFilePath, caller: "real-dsh-host" });
  const service = createLocalArtifactService({ files: sdk.files, home: join(scratch, "dsh-state"), actorId: "real-dsh-host" });
  const artifacts = await sdk.files.getArtifacts(run.runId); expect(artifacts.files.map(item => item.path)).toEqual(["delete.md", "edit.md", "new.md"]);
  // The remote Core cannot import or apply to this local destination. Only the host service can.
  await expect(sdk.files.applyArtifacts(run.runId, { requestId: "remote-cannot-write", destination, paths: ["new.md"] })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  await writeFile(join(destination, "edit.md"), "local user change");
  const request = { requestId: "local-apply", runId: run.runId, destination, paths: artifacts.files.map(item => item.path) };
  const applied = await service.apply(request); expect(applied.items.map(item => item.status)).toEqual(["applied", "conflict", "applied"]);
  expect(await readFile(join(destination, "edit.md"), "utf8")).toBe("local user change"); expect(await readFile(join(destination, "new.md"), "utf8")).toBe("actual new result");
  await expect(readFile(join(destination, "delete.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(destination, "new.md"), "user changed after success"); await writeFile(join(destination, "edit.md"), "base");
  const reopened = createLocalArtifactService({ files: sdk.files, home: join(scratch, "dsh-state"), actorId: "real-dsh-host" });
  expect(await reopened.apply(request)).toEqual(applied);
  const retried = await reopened.apply({ ...request, requestId: "retry", retryOperationId: applied.operationId }); expect(retried.items.every(item => item.status === "applied")).toBe(true);
  expect(await readFile(join(destination, "new.md"), "utf8")).toBe("user changed after success"); expect(await readFile(join(destination, "edit.md"), "utf8")).toBe("actual changed result");
});
