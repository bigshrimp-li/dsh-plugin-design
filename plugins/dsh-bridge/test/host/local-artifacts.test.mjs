import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalArtifactService } from "../../src/host/local-artifacts.js";
const homes = [], hash = text => createHash("sha256").update(text).digest("hex");
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { force: true, recursive: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sa-artifacts-")); homes.push(home);
  const destination = join(home, "project"); await mkdir(destination);
  const files = [
    { path: "new.md", kind: "added", before: null, after: { hash: hash("created"), mode: 0o644 } },
    { path: "edit.md", kind: "modified", before: { hash: hash("baseline") }, after: { hash: hash("edited"), mode: 0o644 } },
    { path: "remove.md", kind: "deleted", before: { hash: hash("remove") }, after: null },
  ];
  const artifacts = { inputSnapshot: { snapshotId: "input-a" }, resultSnapshot: { snapshotId: "result-a" }, files };
  const service = createLocalArtifactService({ home, actorId: "verified-actor", files: {
    getArtifacts: async () => artifacts,
    readSnapshotFile: async (id, path) => ({ dataBase64: Buffer.from(id === "input-a" ? path === "edit.md" ? "baseline" : "remove" : path === "new.md" ? "created" : "edited").toString("base64") }),
  } });
  return { home, destination, files, service };
}
describe("DSH local artifact writeback", () => {
  it("applies additions and deletions, preserves conflicts, and never rewrites earlier successful files on retry", async () => {
    const f = await fixture(); await writeFile(join(f.destination, "edit.md"), "local change"); await writeFile(join(f.destination, "remove.md"), "remove");
    const request = { requestId: "apply-a", runId: "run-a", destination: f.destination, paths: f.files.map(file => file.path) };
    const result = await f.service.apply(request);
    expect(result.actorId).toBe("verified-actor"); expect(result.items.map(item => item.status)).toEqual(["applied", "conflict", "applied"]);
    expect(await readFile(join(f.destination, "edit.md"), "utf8")).toBe("local change");
    await writeFile(join(f.destination, "new.md"), "changed after success"); await writeFile(join(f.destination, "edit.md"), "baseline");
    const retry = await f.service.apply({ ...request, requestId: "retry-a", retryOperationId: result.operationId });
    expect(retry.items.map(item => item.status)).toEqual(["applied", "applied", "applied"]);
    expect(await readFile(join(f.destination, "new.md"), "utf8")).toBe("changed after success");
    expect(await readFile(join(f.destination, "edit.md"), "utf8")).toBe("edited");
    expect(await f.service.apply(request)).toEqual(result);
    await expect(f.service.apply({ ...request, paths: ["new.md"] })).rejects.toThrow("载荷不同");
  });
  it("rejects symlink targets and traversal without writing outside the selected directory", async () => {
    const f = await fixture(), outside = join(f.home, "outside"); await writeFile(outside, "private"); await symlink(outside, join(f.destination, "edit.md"));
    const result = await f.service.apply({ requestId: "unsafe", runId: "run-a", destination: f.destination, paths: ["edit.md"] });
    expect(result.items[0].status).toBe("failed"); expect(await readFile(outside, "utf8")).toBe("private");
    f.files.push({ path: "../outside", before: null, after: { hash: hash("changed"), mode: 0o644 } });
    const traversal = await f.service.apply({ requestId: "traversal", runId: "run-a", destination: f.destination, paths: ["../outside"] });
    expect(traversal.items[0].status).toBe("failed"); expect(await readFile(outside, "utf8")).toBe("private");
  });
});

it("reviews actual conflict contents and records keep-local without rewriting it on later retries", async () => {
  const f = await fixture(); await writeFile(join(f.destination, "edit.md"), "local change");
  const request = { requestId: "conflict-keep", runId: "run-a", destination: f.destination, paths: ["edit.md"] }, original = await f.service.apply(request);
  const preview = await f.service.previewConflict({ operationId: original.operationId, path: "edit.md" });
  expect(preview).toMatchObject({ actualHash: hash("local change"), localText: "local change", baseText: "baseline", cloudText: "edited", binary: false });
  const choice = { requestId: "keep-choice", operationId: original.operationId, path: "edit.md", choice: "keep_local", expectedLocalHash: preview.actualHash };
  expect((await f.service.resolveConflict(choice)).items[0].status).toBe("skipped");
  expect((await f.service.get(original.operationId)).items[0].status).toBe("skipped");
  await writeFile(join(f.destination, "edit.md"), "baseline");
  const retried = await f.service.apply({ ...request, requestId: "keep-retry", retryOperationId: original.operationId });
  expect(retried.items[0].status).toBe("skipped"); expect(await readFile(join(f.destination, "edit.md"), "utf8")).toBe("baseline");
  expect((await f.service.resolveConflict(choice)).items[0].status).toBe("skipped");
  await expect(f.service.resolveConflict({ ...choice, choice: "merge", mergedText: "other" })).rejects.toThrow("载荷不同");
});

it("saves the cloud version to a distinct new path and rejects existing or escaped targets", async () => {
  const f = await fixture(); await writeFile(join(f.destination, "edit.md"), "local change");
  const original = await f.service.apply({ requestId: "conflict-save", runId: "run-a", destination: f.destination, paths: ["edit.md"] });
  const choice = { requestId: "save-choice", operationId: original.operationId, path: "edit.md", choice: "save_as", expectedLocalHash: hash("local change"), saveAsPath: "saved/cloud.md" };
  await writeFile(join(f.destination, "existing.md"), "protected");
  await expect(f.service.resolveConflict({ ...choice, requestId: "existing-choice", saveAsPath: "existing.md" })).rejects.toThrow("已存在");
  await expect(f.service.resolveConflict({ ...choice, requestId: "escape-choice", saveAsPath: "../outside" })).rejects.toThrow("路径");
  await f.service.resolveConflict(choice);
  expect(await readFile(join(f.destination, "saved/cloud.md"), "utf8")).toBe("edited");
  expect(await readFile(join(f.destination, "edit.md"), "utf8")).toBe("local change");
  expect((await f.service.get(original.operationId)).items[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("saved/cloud.md") });
  await writeFile(join(f.destination, "saved/cloud.md"), "later local edit");
  await f.service.resolveConflict(choice);
  expect(await readFile(join(f.destination, "saved/cloud.md"), "utf8")).toBe("later local edit");
});

it("applies an explicitly reviewed manual merge with a local hash guard and recovers its original operation", async () => {
  const f = await fixture(); await writeFile(join(f.destination, "edit.md"), "local change");
  const original = await f.service.apply({ requestId: "conflict-merge", runId: "run-a", destination: f.destination, paths: ["edit.md"] });
  const choice = { requestId: "merge-choice", operationId: original.operationId, path: "edit.md", choice: "merge", expectedLocalHash: hash("local change"), mergedText: "reviewed local and cloud\n" };
  await writeFile(join(f.destination, "edit.md"), "concurrent change");
  await expect(f.service.resolveConflict(choice)).rejects.toThrow("本机内容已改变");
  await writeFile(join(f.destination, "edit.md"), "local change");
  const merged = await f.service.resolveConflict(choice);
  expect(await readFile(join(f.destination, "edit.md"), "utf8")).toBe(choice.mergedText);
  const childPath = join(f.home, "dsh-artifact-applies", `${merged.operationId}.json`), parentPath = join(f.home, "dsh-artifact-applies", `${original.operationId}.json`);
  const child = JSON.parse(await readFile(childPath, "utf8")), parent = JSON.parse(await readFile(parentPath, "utf8"));
  child.items[0].status = "pending"; parent.items[0].status = "conflict"; delete parent.items[0].resolutionOperationId;
  await writeFile(childPath, JSON.stringify(child)); await writeFile(parentPath, JSON.stringify(parent));
  expect((await f.service.get(original.operationId)).items[0]).toMatchObject({ status: "applied", resolutionOperationId: merged.operationId });
  await writeFile(join(f.destination, "edit.md"), "later edit"); await f.service.resolveConflict(choice);
  expect(await readFile(join(f.destination, "edit.md"), "utf8")).toBe("later edit");
});

it("recovers a crash-pending write by reading facts and refuses replay if evidence vanished", async () => {
  const f = await fixture(), request = { requestId: "crash-window", runId: "run-a", destination: f.destination, paths: ["new.md"] };
  const applied = await f.service.apply(request), journalPath = join(f.home, "dsh-artifact-applies", `${applied.operationId}.json`);
  const pending = JSON.parse(await readFile(journalPath, "utf8")); pending.items[0].status = "pending";
  await writeFile(journalPath, JSON.stringify(pending));
  const recovered = await f.service.get(applied.operationId);
  expect(recovered.items[0]).toMatchObject({ status: "applied", reason: expect.stringContaining("未重复写入") });
  await writeFile(join(f.destination, "new.md"), "edited after recovery");
  expect((await f.service.apply(request)).items[0].status).toBe("applied");
  expect(await readFile(join(f.destination, "new.md"), "utf8")).toBe("edited after recovery");
  pending.items[0].status = "pending"; await writeFile(journalPath, JSON.stringify(pending)); f.files.splice(0, 1);
  expect((await f.service.get(applied.operationId)).items[0].status).toBe("unknown");
  await expect(f.service.apply({ ...request, requestId: "forbidden-replay", retryOperationId: applied.operationId })).rejects.toThrow("不允许自动重放");
});
