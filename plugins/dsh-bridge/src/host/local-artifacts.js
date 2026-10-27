/** Explicit per-file writeback on the DSH computer, never on the remote Core. */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const sha = value => createHash("sha256").update(value).digest("hex");
const refusal = (message, code = "LOCAL_ARTIFACT_REJECTED") => Object.assign(new Error(message), { code });
export function createLocalArtifactService({ files, home, actorId = "unknown" }) {
  let changing = Promise.resolve();
  const journalRoot = join(home, "dsh-artifact-applies");
  const persist = async record => { await mkdir(journalRoot, { recursive: true, mode: 0o700 }); const path = join(journalRoot, `${record.operationId}.json`), temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(record), { mode: 0o600 }); await rename(temporary, path); };
  const read = async id => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("无效的本机回传操作 ID");
    return JSON.parse(await readFile(join(journalRoot, `${id}.json`), "utf8"));
  };
  const safePath = async (root, path, create) => {
    if (typeof path !== "string" || !path || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("产物路径无效");
    const target = resolve(root, path); if (!target.startsWith(root + sep)) throw new Error("产物路径超出所选目录");
    let current = root;
    for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
      current = join(current, part);
      try { const entry = await lstat(current); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("目标目录包含符号链接或非目录项"); }
      catch (error) { if (error.code !== "ENOENT" || !create) throw error; await mkdir(current); }
    }
    try { const entry = await lstat(target); if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("目标不是普通文件"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return target;
  };
  const hashAt = async path => { try { return sha(await readFile(path)); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  const finishResolution = async record => {
    if (record.kind !== "conflict_resolution" || !["applied", "skipped"].includes(record.items[0]?.status)) return record;
    const prior = await read(record.priorOperationId), item = prior.items.find(row => row.path === record.items[0].path);
    if (prior.runId !== record.runId || prior.destination !== record.destination || !item || item.pendingResolutionId !== record.operationId) throw new Error("冲突处理与原回传不匹配，请核验原操作");
    item.status = record.choice === "merge" ? "applied" : "skipped";
    item.reason = record.choice === "keep_local" ? "已明确保留本机文件" : record.choice === "save_as" ? `已另存云端版本为 ${record.items[0].targetPath}，原本机文件保持不变` : "已按审阅时的本机内容应用人工合并";
    item.resolutionOperationId = record.operationId;
    await persist(prior); return record;
  };
  const recover = async record => {
    if (record.kind !== "conflict_resolution") {
      for (const item of record.items.filter(row => row.pendingResolutionId && !row.resolutionOperationId)) await finishResolution(await recover(await read(item.pendingResolutionId)));
      if (record.items.some(item => item.pendingResolutionId)) record = await read(record.operationId);
    }
    if (!record.items.some(item => item.status === "pending")) return finishResolution(record);
    const artifacts = record.kind === "conflict_resolution" ? null : await files.getArtifacts(record.runId);
    for (const item of record.items) {
      if (item.status !== "pending") continue;
      const artifact = artifacts?.files.find(file => file.path === item.path);
      try {
        if (!artifact && record.kind !== "conflict_resolution") throw new Error("原产物已不可读取，回传结果待核验");
        const path = await safePath(record.destination, item.targetPath || item.path, false), actual = await hashAt(path);
        item.status = actual === (record.kind === "conflict_resolution" ? item.resultHash : artifact.after?.hash || null) ? "applied" : actual === (record.kind === "conflict_resolution" ? item.beforeHash : artifact.before?.hash || null) ? "failed" : "conflict";
        item.reason = item.status === "applied" ? "恢复时核对到预期结果，未重复写入" : "原回传结果未确认；已核对当前文件，本次没有自动重放";
      } catch (error) { item.status = "unknown"; item.reason = error.message; }
    }
    await persist(record); return finishResolution(record);
  };
  const apply = async payload => {
    if (!payload.requestId || !payload.runId || !Array.isArray(payload.paths)) throw refusal("回传须提供请求 ID、任务和文件列表");
    let root; try { root = await realpath(payload.destination); } catch { throw refusal("本机目的目录不可用，请选择可访问的已有目录"); }
    const signature = JSON.stringify({ runId: payload.runId, destination: root, paths: payload.paths, retryOperationId: payload.retryOperationId || null });
    const operationId = sha(Buffer.from(payload.requestId));
    let record;
    try { record = await read(operationId); if (record.signature !== signature) throw new Error("同一回传请求 ID 的载荷不同"); return await recover(record); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const artifacts = await files.getArtifacts(payload.runId), prior = payload.retryOperationId ? await recover(await read(payload.retryOperationId)) : null;
    if (artifacts.run?.status === "unknown" && !artifacts.run.verification) throw new Error("任务存在未核验的外部结果，请先核验，再独立选择回传文件");
    if (prior && (prior.runId !== payload.runId || prior.destination !== root)) throw refusal("重试须属于相同任务和本机目录");
    if (prior?.items.some(item => payload.paths.includes(item.path) && item.status === "unknown")) throw new Error("原回传含结果未知的文件，请先核验，不允许自动重放");
    const selected = artifacts.files.filter(file => payload.paths.includes(file.path));
    if (selected.length !== new Set(payload.paths).size) throw refusal("所选产物不存在");
    record = { operationId, signature, requestId: payload.requestId, runId: payload.runId, destination: root, actorId, createdAt: Date.now(), items: selected.map(file => { const previous = prior?.items.find(item => item.path === file.path); return { path: file.path, status: ["applied", "skipped"].includes(previous?.status) ? previous.status : "pending", reason: previous?.reason || null }; }) };
    await persist(record);
    for (const item of record.items) {
      if (["applied", "skipped"].includes(item.status)) continue;
      const artifact = selected.find(file => file.path === item.path);
      try {
        const path = await safePath(root, item.path, !!artifact.after), actual = await hashAt(path), desired = artifact.after?.hash || null;
        if (actual === desired) { item.status = "applied"; item.reason = "目标已是预期结果，未重复写入"; }
        else if (actual !== (artifact.before?.hash || null)) { item.status = "conflict"; item.reason = "本机内容与任务输入基线不同，未覆盖"; }
        else if (!artifact.after) { await unlink(path); item.status = "applied"; }
        else {
          const result = await files.readSnapshotFile(artifacts.resultSnapshot.snapshotId, item.path), bytes = Buffer.from(result.dataBase64, "base64");
          if (sha(bytes) !== desired) throw new Error("远端产物 hash 不匹配");
          const temporary = `${path}.super-agent-${randomUUID()}.tmp`;
          const handle = await open(temporary, "wx", artifact.after.mode);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          if (await hashAt(path) !== actual) { await unlink(temporary); item.status = "conflict"; item.reason = "回传前本机文件发生变化，未覆盖"; }
          else {
            if (artifact.before === null) {
              try { await link(temporary, path); item.status = "applied"; }
              catch (error) { if (error.code !== "EEXIST") throw error; item.status = "conflict"; item.reason = "目标文件在回传时出现，未覆盖"; }
              finally { await unlink(temporary); }
            } else { await rename(temporary, path); item.status = "applied"; }
          }
        }
      } catch (error) { item.status = "failed"; item.reason = error.message; }
      await persist(record);
    }
    return record;
  };
  const conflict = async (operationId, path) => {
    const prior = await recover(await read(operationId)), item = prior.items.find(row => row.path === path);
    if (prior.kind === "conflict_resolution" || item?.status !== "conflict") throw refusal("请先选择原回传中尚未处理的冲突文件", "LOCAL_ARTIFACT_REVIEW_REQUIRED");
    const artifacts = await files.getArtifacts(prior.runId), artifact = artifacts.files.find(row => row.path === path);
    if (!artifact || artifacts.run?.status === "unknown" && !artifacts.run.verification) throw new Error("原产物不可用或外部结果尚未核验");
    const localPath = await safePath(prior.destination, path, false);
    return { prior, item, artifacts, artifact, localPath, actualHash: await hashAt(localPath) };
  };
  const previewConflict = async payload => {
    const current = await conflict(payload.operationId, payload.path);
    const local = current.actualHash === null ? null : await readFile(current.localPath);
    const readVersion = async (snapshotId, expected) => {
      if (!expected) return null;
      const result = await files.readSnapshotFile(snapshotId, payload.path), bytes = Buffer.from(result.dataBase64, "base64");
      if (sha(bytes) !== expected.hash) throw new Error("产物内容摘要与版本不符");
      return bytes;
    };
    const [base, cloud] = await Promise.all([readVersion(current.artifacts.inputSnapshot?.snapshotId, current.artifact.before), readVersion(current.artifacts.resultSnapshot.snapshotId, current.artifact.after)]);
    const text = bytes => { if (bytes === null) return null; try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; } };
    const localText = text(local), baseText = text(base), cloudText = text(cloud);
    return { operationId: payload.operationId, path: payload.path, destination: current.prior.destination, actualHash: current.actualHash,
      localText: localText ?? null, baseText: baseText ?? null, cloudText: cloudText ?? null, binary: [localText, baseText, cloudText].includes(undefined),
      canSaveAs: cloud !== null, suggestedPath: `${payload.path}.cloud` };
  };
  const resolveConflict = async payload => {
    if (!payload.requestId || !["keep_local", "save_as", "merge"].includes(payload.choice) || !Object.hasOwn(payload, "expectedLocalHash") || payload.expectedLocalHash !== null && !/^[a-f0-9]{64}$/.test(payload.expectedLocalHash)) throw refusal("冲突处理须提供请求、明确选择及已审阅本机摘要");
    const operationId = sha(Buffer.from(payload.requestId)), signature = JSON.stringify({ operationId: payload.operationId, path: payload.path, choice: payload.choice, expectedLocalHash: payload.expectedLocalHash, saveAsPath: payload.saveAsPath ?? null, mergedTextHash: typeof payload.mergedText === "string" ? sha(payload.mergedText) : null });
    try { const existing = await read(operationId); if (existing.signature !== signature || existing.kind !== "conflict_resolution") throw new Error("同一冲突处理请求 ID 的载荷不同"); return finishResolution(await recover(existing)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const current = await conflict(payload.operationId, payload.path);
    if (current.actualHash !== payload.expectedLocalHash) throw refusal("本机内容已改变，请重新审阅冲突后再提交", "LOCAL_ARTIFACT_REVIEW_REQUIRED");
    const targetPath = payload.choice === "save_as" ? payload.saveAsPath : payload.path;
    if (payload.choice === "save_as" && (!current.artifact.after || targetPath === payload.path)) throw refusal("另存必须选择其他相对路径，删除产物没有可另存内容");
    let target; try { target = await safePath(current.prior.destination, targetPath, payload.choice !== "keep_local"); } catch (error) { throw refusal(error.message); }
    const beforeHash = await hashAt(target);
    if (payload.choice === "save_as" && beforeHash !== null) throw refusal("另存目标已存在，请选择其他文件名");
    let bytes = null;
    if (payload.choice === "merge") { if (typeof payload.mergedText !== "string" || Buffer.byteLength(payload.mergedText) > 20 * 1024 * 1024) throw refusal("人工合并须提供不超过 20 MiB 的 UTF-8 文本"); bytes = Buffer.from(payload.mergedText); }
    if (payload.choice === "save_as") { const result = await files.readSnapshotFile(current.artifacts.resultSnapshot.snapshotId, payload.path); bytes = Buffer.from(result.dataBase64, "base64"); if (sha(bytes) !== current.artifact.after.hash) throw new Error("云端产物摘要不符"); }
    const record = { kind: "conflict_resolution", operationId, signature, requestId: payload.requestId, priorOperationId: payload.operationId, choice: payload.choice, runId: current.prior.runId, destination: current.prior.destination, actorId, createdAt: Date.now(),
      items: [{ path: payload.path, targetPath, beforeHash, resultHash: bytes ? sha(bytes) : current.actualHash, status: payload.choice === "keep_local" ? "skipped" : "pending", reason: null }] };
    await persist(record); current.item.pendingResolutionId = operationId; await persist(current.prior);
    if (bytes) {
      const temporary = `${target}.super-agent-${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", current.artifact.after?.mode || 0o644);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        if (await hashAt(current.localPath) !== current.actualHash || await hashAt(target) !== beforeHash) { record.items[0].status = "conflict"; record.items[0].reason = "提交前本机内容发生变化，未覆盖"; }
        else if (beforeHash === null) { try { await link(temporary, target); record.items[0].status = "applied"; } catch (error) { if (error.code !== "EEXIST") throw error; record.items[0].status = "conflict"; record.items[0].reason = "目标在提交时出现，未覆盖"; } }
        else { await rename(temporary, target); record.items[0].status = "applied"; }
      } catch (error) { record.items[0].status = "failed"; record.items[0].reason = error.message; }
      finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      await persist(record);
    }
    return finishResolution(record);
  };
  const serial = fn => { const result = changing.then(fn); changing = result.then(() => undefined, () => undefined); return result; };
  const list = async runId => {
    const items = [];
    for (const name of await readdir(journalRoot).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      if (!(await lstat(join(journalRoot, name))).isFile()) throw new Error("本机回传记录不是普通文件");
      const record = await read(name.slice(0, -5));
      if (record.runId === runId && record.kind !== "conflict_resolution") items.push({ operationId: record.operationId, destination: record.destination, createdAt: record.createdAt, items: record.items.map(({ path, status }) => ({ path, status })) });
    }
    return { items: items.sort((a, b) => b.createdAt - a.createdAt) };
  };
  return { get: id => serial(async () => recover(await read(id))), list: runId => serial(() => list(runId)), apply: payload => serial(() => apply(payload)), previewConflict: payload => serial(() => previewConflict(payload)), resolveConflict: payload => serial(() => resolveConflict(payload)) };
}
