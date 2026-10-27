/** One DSH host owns this cache. Upload retries always read captured bytes, never the live source. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packLocalDirectory } from "@super-agent/client";

const hash = value => createHash("sha256").update(value).digest("hex");
const active = new Set(["queued", "uploading", "cancelling"]);
const terminal = status => !active.has(status);
const failure = (code, message) => Object.assign(new Error(message), { code });
export function createLocalUploadService({ files, home, targetKey, actorId = "local-user", now = Date.now }) {
  const root = join(home, "dsh-content-uploads", hash(`${targetKey}:${actorId}`)), running = new Map();
  let queue = Promise.resolve(), lastMaintenance = 0;
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  const persist = async (path, value) => { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); const file = await open(temporary, "r"); try { await file.sync(); } finally { await file.close(); } await rename(temporary, path); };
  const initialize = async () => { for (const name of ["candidates", "blocks", "operations", "receipts"]) await mkdir(join(root, name), { recursive: true, mode: 0o700 }); };
  const operationPath = id => { if (!/^[a-f0-9]{64}$/.test(id)) throw failure("INVALID_REQUEST", "本机上传操作 ID 无效"); return join(root, "operations", `${id}.json`); };
  const loadOperation = async id => {
    const path = operationPath(id); let operation;
    try { operation = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") throw failure("NOT_FOUND", "本机上传操作不存在，请检查当前连接和电脑"); throw error; }
    if (active.has(operation.status) && !running.has(id)) { operation = { ...operation, status: "interrupted", updatedAt: now(), error: "DSH 宿主已重启。可查询云端原操作，再续传已捕获的相同内容。" }; await persist(path, operation); }
    return operation;
  };
  const maintain = async () => {
    if (now() - lastMaintenance < 60 * 60_000) return;
    const protectedCandidates = new Set(), keep = new Set();
    for (const name of await readdir(join(root, "operations"))) if (/^[a-f0-9]{64}\.json$/.test(name)) { const operation = await loadOperation(name.slice(0, -5)); if (active.has(operation.status) && running.has(operation.operationId)) protectedCandidates.add(operation.candidateId); }
    for (const name of await readdir(join(root, "candidates"))) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
      const path = join(root, "candidates", name), record = JSON.parse(await readFile(path, "utf8"));
      if (record.expiresAt < now() && !protectedCandidates.has(record.candidateId)) { await rm(path); continue; }
      for (const file of record.manifest.files) for (const digest of file.blocks) keep.add(digest);
    }
    for (const name of await readdir(join(root, "blocks"))) if (/^[a-f0-9]{64}$/.test(name) && !keep.has(name)) await rm(join(root, "blocks", name));
    lastMaintenance = now();
  };
  const candidate = async id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw failure("INVALID_REQUEST", "本机候选 ID 无效");
    let record; try { record = JSON.parse(await readFile(join(root, "candidates", `${id}.json`), "utf8")); } catch (error) { if (error.code === "ENOENT") throw failure("NOT_FOUND", "本机候选不存在，不能用当前来源替代原内容续传"); throw error; }
    if (record.expiresAt < now()) throw failure("NOT_FOUND", "本机候选的 24 小时保留期已过。请显式重新预览，新来源不会冒充原候选。");
    return record;
  };
  const update = (id, fn) => serial(async () => { const operation = await loadOperation(id), next = await fn(operation); await persist(operationPath(id), next); return next; });
  const control = (action, id, requestId) => serial(async () => {
    if (!requestId) throw failure("INVALID_REQUEST", "本机上传控制需要请求 ID");
    const path = join(root, "receipts", `${hash(requestId)}.json`), input = JSON.stringify({ action, id });
    try { const prior = JSON.parse(await readFile(path, "utf8")); if (prior.input !== input) throw failure("IDEMPOTENCY_CONFLICT", "本机上传请求 ID 的动作不同"); return prior; } catch (error) { if (error.code !== "ENOENT") throw error; }
    const operation = await loadOperation(id), receipt = { input, operationId: id, attempt: operation.attempt }; await persist(path, receipt); return receipt;
  });
  const launch = id => {
    if (running.has(id)) return;
    const controller = new AbortController(); running.set(id, controller);
    void perform(id, controller).catch(() => {}).finally(() => running.delete(id));
  };
  const perform = async (id, controller) => {
    let operation = await update(id, current => current.status === "queued" ? { ...current, status: "uploading", updatedAt: now(), error: null } : current);
    if (operation.status !== "uploading") return;
    const signal = controller.signal;
    try {
      const captured = await candidate(operation.candidateId); signal.throwIfAborted();
      let remote = operation.transferId ? await files.getTransfer(operation.transferId) : null;
      if (!remote || remote.status === "cancelled" || remote.status === "uploading" && now() > remote.expiresAt) remote = await files.createTransfer({ requestId: `${operation.requestId}:transfer:${operation.attempt}`, workspaceId: operation.workspaceId, manifest: captured.manifest, source: { mode: "local_upload", location: captured.localRoot } });
      if (remote.workspaceId !== operation.workspaceId || JSON.stringify(remote.manifest) !== JSON.stringify(captured.manifest)) throw failure("FILE_CONFLICT", "云端原传输清单与本机捕获内容不同，已拒绝替换来源");
      operation = await update(id, current => ({ ...current, transferId: remote.operationId, transferIds: [...new Set([...current.transferIds, remote.operationId])], missingBlocks: remote.missingBlocks.length, updatedAt: now() }));
      for (const digest of remote.missingBlocks) {
        signal.throwIfAborted(); const bytes = await readFile(join(root, "blocks", digest));
        if (hash(bytes) !== digest) throw failure("FILE_CONFLICT", "本机已捕获内容校验失败，请保留原操作并重新获取原版本");
        remote = await files.uploadBlock(remote.operationId, { requestId: `${operation.requestId}:block:${digest}`, hash: digest, dataBase64: bytes.toString("base64") });
        await update(id, current => ({ ...current, missingBlocks: remote.missingBlocks.length, updatedAt: now() }));
      }
      signal.throwIfAborted();
      const snapshot = remote.status === "published" ? await files.getSnapshot(remote.snapshotId) : await files.commitTransfer(remote.operationId, `${operation.requestId}:commit:${operation.attempt}`);
      await update(id, current => ({ ...current, status: "succeeded", snapshot, missingBlocks: 0, updatedAt: now(), error: null }));
    } catch (error) {
      if (signal.aborted) {
        try {
          const current = await serial(() => loadOperation(id));
          const remote = current.transferId ? await files.getTransfer(current.transferId) : null;
          if (remote?.status === "published") { const snapshot = await files.getSnapshot(remote.snapshotId); await update(id, item => ({ ...item, status: "succeeded", snapshot, missingBlocks: 0, updatedAt: now(), error: "取消生效前，版本已完成校验发布。" })); }
          else { if (remote?.status === "uploading") await files.cancelTransfer(remote.operationId, `${current.requestId}:cancel:${current.attempt}`); await update(id, item => ({ ...item, status: "cancelled", updatedAt: now(), error: null })); }
        } catch { await update(id, item => ({ ...item, status: "interrupted", updatedAt: now(), error: "取消结果尚未确认。请查询云端原传输，不能假报取消或自动换来源。" })); }
      } else await update(id, current => ({ ...current, status: "failed", updatedAt: now(), error: error.message || "上传失败，原候选和原操作已保留。" }));
    }
  };
  return {
    async preview(path, rules) {
      await initialize(); const budget = (await files.capabilities()).budget, bundle = await packLocalDirectory(path, { budget, ...(rules ? { rules } : {}) });
      return serial(async () => {
      await maintain();
      for (const [digest, bytes] of bundle.blocks) { try { await writeFile(join(root, "blocks", digest), bytes, { mode: 0o600, flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; if (hash(await readFile(join(root, "blocks", digest))) !== digest) throw failure("FILE_CONFLICT", "已有本机缓存内容校验失败"); } }
      const record = { candidateId: randomUUID(), manifest: bundle.manifest, bytes: bundle.bytes, localRoot: bundle.root, createdAt: now(), expiresAt: now() + 24 * 60 * 60_000 };
      await persist(join(root, "candidates", `${record.candidateId}.json`), record); return record;
      });
    },
    async start(input) {
      if (!input.requestId || !input.workspaceId) throw failure("INVALID_REQUEST", "上传需要请求 ID 和项目");
      await initialize();
      const operation = await serial(async () => {
        const receiptPath = join(root, "receipts", `${hash(input.requestId)}.json`), encoded = JSON.stringify({ candidateId: input.candidateId, workspaceId: input.workspaceId });
        try { const prior = JSON.parse(await readFile(receiptPath, "utf8")); if (prior.input !== encoded) throw failure("IDEMPOTENCY_CONFLICT", "本机上传请求 ID 的内容不同"); return loadOperation(prior.operationId); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const captured = await candidate(input.candidateId), id = hash(encoded); let current;
        try { current = await loadOperation(id); } catch (error) { if (error.code !== "NOT_FOUND") throw error; }
        if (!current) { current = { operationId: id, requestId: input.requestId, candidateId: input.candidateId, workspaceId: input.workspaceId, localRoot: captured.localRoot, bytes: captured.bytes, expiresAt: captured.expiresAt, totalBlocks: new Set(captured.manifest.files.flatMap(file => file.blocks)).size, missingBlocks: null, status: "queued", attempt: 1, transferId: null, transferIds: [], snapshot: null, error: null, actorId, createdAt: now(), updatedAt: now() }; await persist(operationPath(id), current); }
        await persist(receiptPath, { input: encoded, operationId: id }); return current;
      });
      if (operation.status === "queued") launch(operation.operationId); return operation;
    },
    get: id => serial(async () => { await initialize(); return loadOperation(id); }),
    async inspect(id) { const operation = await serial(() => loadOperation(id)); if (!operation.transferId) return operation; const remote = await files.getTransfer(operation.transferId); const snapshot = remote.status === "published" ? await files.getSnapshot(remote.snapshotId) : null; return update(id, current => ({ ...current, ...(snapshot ? { status: "succeeded", snapshot, error: null } : remote.status === "cancelled" && ["interrupted", "cancelling"].includes(current.status) ? { status: "cancelled" } : {}), transferStatus: remote.status, missingBlocks: remote.missingBlocks.length, updatedAt: now() })); },
    async list() { return serial(async () => { await initialize(); await maintain(); const items = []; for (const name of await readdir(join(root, "operations"))) if (/^[a-f0-9]{64}\.json$/.test(name)) items.push(await loadOperation(name.slice(0, -5))); return { items: items.sort((a, b) => b.createdAt - a.createdAt) }; }); },
    async cancel(id, requestId) { const receipt = await control("cancel", id, requestId); const operation = await update(id, current => current.attempt === receipt.attempt && (active.has(current.status) || current.status === "interrupted") ? { ...current, status: current.status === "queued" ? "cancelled" : "cancelling", updatedAt: now() } : current); if (operation.attempt !== receipt.attempt) return operation; running.get(id)?.abort(); if (operation.status === "cancelling" && !running.has(id)) { const remote = operation.transferId ? await files.getTransfer(operation.transferId) : null; if (remote?.status === "published") { const snapshot = await files.getSnapshot(remote.snapshotId); return update(id, current => ({ ...current, status: "succeeded", snapshot, updatedAt: now() })); } if (remote?.status === "uploading") await files.cancelTransfer(remote.operationId, `${operation.requestId}:cancel:${operation.attempt}`); return update(id, current => ({ ...current, status: "cancelled", updatedAt: now() })); } return operation; },
    async resume(id, requestId) { const receipt = await control("resume", id, requestId); const operation = await update(id, async current => { if (current.attempt !== receipt.attempt || !["failed", "cancelled", "interrupted"].includes(current.status)) return current; await candidate(current.candidateId); return { ...current, status: "queued", attempt: current.attempt + 1, updatedAt: now(), error: null }; }); if (operation.status === "queued") launch(id); return operation; },
    async wait(id) { for (;;) { const operation = await serial(() => loadOperation(id)); if (terminal(operation.status)) { if (operation.status === "succeeded") return operation.snapshot; throw failure(operation.status === "cancelled" ? "CANCELLED" : "FILE_CONFLICT", operation.error || "上传尚未完成，请查看原操作"); } await new Promise(resolve => setTimeout(resolve, 50)); } },
  };
}
