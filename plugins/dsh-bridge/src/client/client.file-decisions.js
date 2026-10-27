/** Failed predecessor review uses immutable inputs and a versioned, durable Core decision. */
window.__ModuleLoader__.load({ id: "@super-agent/dsh-bridge", chunk: "client.file-decisions.js", factory() {
  function unifiedFileDiff(before, after, maxLines = 800) {
    const a = before.split("\n"), b = after.split("\n");
    if (a.length > maxLines || b.length > maxLines) return `内容较长，显示输入与结果供逐项核对。\n\n--- 输入\n${before}\n\n+++ 结果\n${after}`;
    const cells = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) cells[i][j] = a[i] === b[j] ? cells[i + 1][j + 1] + 1 : Math.max(cells[i + 1][j], cells[i][j + 1]);
    const lines = ["--- 任务输入", "+++ 部分结果"]; let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(` ${a[i]}`); i++; j++; }
      else if (j < b.length && (i === a.length || cells[i][j + 1] >= cells[i + 1][j])) lines.push(`+${b[j++]}`);
      else lines.push(`-${a[i++]}`);
    }
    return lines.join("\n");
  }
  function createFileDecisions({ kernel, primitives, space }) {
    const { React, h } = kernel, { Button, Modal } = primitives;
    const decode = value => value === null ? "" : new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value.dataBase64), c => c.charCodeAt(0)));
    function Dependencies({ settings, state }) {
      const runtime = React.useSyncExternalStore(space.controller.subscribe, space.controller.getSnapshot);
      const blocked = (Array.isArray(runtime.thread?.runs) ? runtime.thread.runs : []).find(run => run.fileDependencyBlocked || run.waitingFor === "file_input");
      const [runId, setRunId] = React.useState(blocked?.runId || ""), [review, setReview] = React.useState(null), [selected, setSelected] = React.useState({}), [diff, setDiff] = React.useState(null), [busy, setBusy] = React.useState(false), [result, setResult] = React.useState(null);
      const targetEpoch = React.useRef(0), pending = React.useRef(null);
      React.useEffect(() => { targetEpoch.current++; setReview(null); setResult(null); setDiff(null); setSelected({}); setBusy(false); pending.current = null; }, [state.selectedId]);
      React.useEffect(() => { if (!runId && blocked?.runId) setRunId(blocked.runId); }, [blocked?.runId]);
      const call = (action, payload = {}) => settings.call(action, { ...payload, targetId: state.selectedId });
      const work = fn => async () => {
        if (busy) return; const epoch = targetEpoch.current; setBusy(true); settings.report("");
        try { await fn(() => epoch === targetEpoch.current); }
        catch (error) { if (epoch === targetEpoch.current) settings.report(error); }
        finally { if (epoch === targetEpoch.current) setBusy(false); }
      };
      const button = (label, action, disabled = false, primary = false) => h(Button, { variant: primary ? "primary" : "outline", disabled: busy || disabled, onClick: () => void work(action)() }, label);
      const load = async alive => {
        const next = await call("files.dependency.review", { runId });
        if (!alive()) return;
        setReview(next); setSelected(Object.fromEntries((next.artifacts?.files || []).map(file => [file.path, true]))); setResult(null);
        if (next.pendingDecision) { const { snapshotId: _snapshotId, ...request } = next.pendingDecision; pending.current = request; }
      };
      const decide = choice => async alive => {
        if (!review) return;
        const paths = Object.keys(selected).filter(path => selected[path]);
        const same = pending.current?.choice === choice && JSON.stringify(pending.current.paths || []) === JSON.stringify(choice === "partial" ? paths : []);
        if (pending.current && !same) throw new Error("上一决策的结果尚未确认，请先重试同一选项或查询原任务。");
        pending.current ||= { requestId: settings.nextRequestId("files.dependency.resolve"), choice, expectedFileRevision: review.fileRevision, ...(choice === "partial" ? { paths } : {}) };
        const response = await call("files.dependency.resolve", { runId, ...pending.current });
        if (!alive()) return;
        pending.current = null; setResult(response);
        settings.note(`文件决策已持久接收：${choice === "cancel" ? "取消依赖任务" : `后续基线 ${response.snapshotId}`}。任务完成仍以 Core 状态为准。`);
        await space.controller.refresh();
      };
      return h("section", { className: "sa-settings-card", "aria-label": "前序失败与文件依赖处理" }, h("h3", null, "前序结果待处理"),
        h("p", { className: "sa-settings-muted" }, "审阅失败或停止任务的部分文件，再为原排队任务选择基线。后续任务仍依赖原任务，不会跳过失败项。"),
        h("label", null, "等待文件输入的 Run ID", h("input", { value: runId, onChange: event => { setRunId(event.target.value); setReview(null); setResult(null); pending.current = null; }, placeholder: blocked?.runId || "run_…", disabled: busy })),
        h("div", { className: "sa-settings-actions" }, button("读取依赖与实际文件差异", load, !runId.trim())),
        review && h(React.Fragment, null,
          h("p", null, `任务 ${review.run.runId} · 前序 ${review.predecessorRunId} · 文件修订 ${review.fileRevision}`),
          h("p", null, `上次成功版本 ${review.currentSuccessful.snapshotId} · hash ${review.currentSuccessful.rootHash}`),
          h("p", null, `受影响后续任务：${review.affectedRunIds.length ? review.affectedRunIds.join("、") : "无"}`),
          review.artifacts?.run.verification && h("p", { className: "sa-settings-notice" }, `原结果仍为 unknown。${review.artifacts.run.verification.actorId} 已核验外部动作，当前审阅快照 ${review.artifacts.run.verification.verifiedSnapshotId}；核验依据 ${review.artifacts.run.verification.evidenceRefs.join("、")}。文件采用仍须单独选择。`),
          review.pendingDecision && h("div", { className: "sa-settings-notice" }, h("p", null, `原决策 ${review.pendingDecision.requestId} 已选定 ${review.pendingDecision.choice}，Core 回执尚未确认。继续提交会恢复同一决策。`), button("继续提交已选决策", async alive => { const response = await call("files.dependency.resolve", { runId, ...pending.current }); if (alive()) { pending.current = null; setResult(response); await space.controller.refresh(); } })),
          h("p", { className: "sa-settings-notice" }, "使用上次成功版本会排除下列全部部分改动；采用部分结果只纳入勾选文件。取消只结束当前依赖任务，后续任务保留待处理。"),
          ...(review.artifacts?.files || []).map(file => h("div", { className: "sa-settings-row", key: file.path },
            h("label", { className: "sa-settings-check" }, h("input", { type: "checkbox", checked: !!selected[file.path], disabled: busy || !!result, onChange: event => setSelected(previous => ({ ...previous, [file.path]: event.target.checked })) }), `${file.kind} · ${file.path}`),
            h("span", { className: "sa-settings-muted" }, `${file.before?.hash || "无"} → ${file.after?.hash || "无"}`),
            button("查看实际 diff", async alive => {
              const [before, after] = await Promise.all([file.before ? call("files.read", { snapshotId: review.artifacts.inputSnapshot.snapshotId, path: file.path }) : null, file.after ? call("files.read", { snapshotId: review.artifacts.resultSnapshot.snapshotId, path: file.path }) : null]);
              if (!alive()) return;
              let content; try { content = unifiedFileDiff(decode(before), decode(after)); } catch { content = "这是二进制文件；请核对上方实际 hash、文件大小，并通过产物下载入口审阅。"; }
              setDiff({ path: file.path, content });
            }))),
          h("div", { className: "sa-settings-actions" }, button("使用上次成功版本继续", decide("last_success"), !!result || !!review.pendingDecision, true), button("采用所选部分文件继续", decide("partial"), !!result || !!review.pendingDecision || !Object.values(selected).some(Boolean)), button("取消此依赖任务", decide("cancel"), !!result || !!review.pendingDecision))),
        result && h("div", { role: "status", className: "sa-settings-notice" }, `决策回执 ${result.receipt.requestId}：${result.receipt.state}。${result.snapshotId ? `已选基线 ${result.snapshotId}` : "已取消当前依赖任务"}；后续依赖 ${result.affectedRunIds.join("、") || "无"}。`),
        diff && h(Modal, { open: true, title: `真实文件差异 · ${diff.path}`, onClose: () => setDiff(null), closeLabel: "关闭", footer: h(Button, { onClick: () => setDiff(null) }, "关闭") }, h("pre", { style: { overflow: "auto", maxHeight: "60vh", whiteSpace: "pre", fontSize: "12px" } }, diff.content)));
    }
    function Retention({ settings, state }) {
      const [view, setView] = React.useState(null), [candidate, setCandidate] = React.useState(null), [busy, setBusy] = React.useState(false);
      const epoch = React.useRef(0);
      React.useEffect(() => { epoch.current++; setView(null); setCandidate(null); setBusy(false); }, [state.selectedId]);
      const call = (action, payload = {}) => settings.call(action, { ...payload, targetId: state.selectedId });
      const work = fn => async () => { if (busy) return; const own = epoch.current; setBusy(true); settings.report(""); try { await fn(() => own === epoch.current); } catch (error) { if (own === epoch.current) settings.report(error); } finally { if (own === epoch.current) setBusy(false); } };
      const refresh = async alive => { const next = await call("files.retention"); if (alive()) setView(next); };
      return h("section", { className: "sa-settings-card", "aria-label": "文件保留与引用保护" }, h("h3", null, "文件保留与引用保护"),
        h("p", { className: "sa-settings-muted" }, "先核对版本、保护引用和已公布期限。过期后保留消息与版本标识，不能从最新来源替代原输入重试。"),
        h(Button, { variant: "outline", disabled: busy, onClick: () => void work(refresh)() }, "查询保留与保护引用"),
        view && h(Button, { variant: "outline", disabled: busy, onClick: () => void work(async alive => { const result = await call("files.collect", { requestId: settings.nextRequestId("files.collect") }); if (alive()) { settings.note(`已清理 ${result.removedObjects} 个未引用内容对象，释放 ${result.removedBytes} 字节。受保护版本未改变。`); await refresh(alive); } })() }, "清理已过期和废弃的未引用内容"),
        view && h(React.Fragment, null,
          h("p", null, `文件版本保留 ${Math.round(view.historyRetentionMs / 86400000)} 天；未完成上传内容保留 ${Math.round(view.unfinishedUploadRetentionMs / 3600000)} 小时。`),
          h("p", null, `可用快照逻辑内容 ${(view.totalBytes / 1048576).toFixed(2)} MiB${typeof view.storedBytes === "number" ? `；实际内容对象 ${(view.storedBytes / 1048576).toFixed(2)} MiB / 配额 ${(view.quotaBytes / 1048576).toFixed(0)} MiB` : ""}`),
          view.quotaWarning && h("p", { role: "status", className: "sa-settings-notice" }, "内容存储接近配额。可审阅未引用且已过保护期的版本，再执行清理。"),
          ...view.snapshots.map(item => h("div", { className: "sa-settings-row", key: item.snapshotId },
            h("div", null, h("strong", null, item.snapshotId), h("p", { className: "sa-settings-muted" }, `${item.workspaceId} · ${item.bytes} B · ${item.status} · 至少保留至 ${new Date(item.availableUntil).toLocaleString()}`),
              h("p", { className: "sa-settings-muted" }, item.protectedBy.length ? `保护引用：${item.protectedBy.join("、")}` : "没有当前保护引用")),
            h(Button, { variant: "outline", disabled: busy || item.status === "expired" || item.protectedBy.length > 0 || Date.now() < item.availableUntil,
              onClick: () => setCandidate(item) }, "审阅清理范围")))),
        candidate && h(Modal, { open: true, title: "审阅文件版本过期", closeLabel: "取消", onClose: () => setCandidate(null), footer: h("div", { className: "sa-settings-actions" },
          h(Button, { onClick: () => setCandidate(null), disabled: busy }, "取消"),
          h(Button, { variant: "primary", disabled: busy, onClick: () => void work(async alive => { await call("files.expire", { requestId: settings.nextRequestId("files.expire"), snapshotId: candidate.snapshotId, expectedRootHash: candidate.rootHash }); if (alive()) { setCandidate(null); await refresh(alive); settings.note("版本已过期，消息和版本标识仍保留；内容清理只处理未引用对象。"); } })() }, "使此版本过期")), },
          h("p", null, `将使 ${candidate.snapshotId} 的文件内容过期，逻辑大小 ${candidate.bytes} B。此操作不删除本机来源、远程仓库或其他版本；原输入重试需要重新取得同一版本或显式选择新基线。`)));
    }
    function BranchActions({ settings, state }) {
      const runtime = React.useSyncExternalStore(space.controller.subscribe, space.controller.getSnapshot);
      const [runId, setRunId] = React.useState(""), [original, setOriginal] = React.useState(null), [files, setFiles] = React.useState(null), [branch, setBranch] = React.useState(null), [snapshots, setSnapshots] = React.useState([]), [baseId, setBaseId] = React.useState(""), [incomingId, setIncomingId] = React.useState(""), [preview, setPreview] = React.useState(null), [choices, setChoices] = React.useState({}), [diff, setDiff] = React.useState(null), [merged, setMerged] = React.useState(null), [retryOpen, setRetryOpen] = React.useState(false), [acknowledged, setAcknowledged] = React.useState(false), [retry, setRetry] = React.useState(null), [busy, setBusy] = React.useState(false);
      const epoch = React.useRef(0);
      React.useEffect(() => { epoch.current++; setOriginal(null); setFiles(null); setBranch(null); setSnapshots([]); setPreview(null); setChoices({}); setDiff(null); setMerged(null); setRetry(null); setRetryOpen(false); setBusy(false); }, [state.selectedId, runtime.selected?.conversationId]);
      const call = (action, payload = {}) => settings.call(action, { ...payload, targetId: state.selectedId });
      const work = fn => async () => { if (busy) return; const own = epoch.current; setBusy(true); settings.report(""); try { await fn(() => own === epoch.current); } catch (error) { if (own === epoch.current) settings.report(error); } finally { if (own === epoch.current) setBusy(false); } };
      const button = (label, fn, disabled = false) => h(Button, { variant: "outline", disabled: busy || disabled, onClick: () => void work(fn)() }, label);
      const load = async alive => {
        const run = await call("run.get", { runId });
        if (run.conversationId !== runtime.selected?.conversationId) throw new Error("原任务不属于运行区当前对话，请先切换到原对话");
        let fileState = null, currentBranch = null, versions = [];
        try { fileState = await call("files.run", { runId }); currentBranch = await call("files.branch.get", { branchId: fileState.branchId }); versions = (await call("files.snapshots", { workspaceId: currentBranch.workspaceId })).items || []; }
        catch (error) { if (error.code !== "NOT_FOUND") throw error; }
        if (!alive()) return;
        setOriginal(run); setFiles(fileState); setBranch(currentBranch); setSnapshots(versions); setBaseId(fileState?.inputSnapshotId || ""); setIncomingId(""); setPreview(null); setChoices({}); setMerged(null); setRetry(null);
      };
      const readPreview = async alive => { const result = await space.controller.previewFileMerge({ branchId: branch.branchId, baseSnapshotId: baseId, incomingSnapshotId: incomingId }); if (alive()) { setPreview(result); setChoices(previous => Object.fromEntries(result.conflicts.filter(path => previous[path]).map(path => [path, previous[path]]))); } };
      return h("section", { className: "sa-settings-card", "aria-label": "显式合并与原输入重试" }, h("h3", null, "显式合并与原输入重试"),
        h("p", { className: "sa-settings-muted" }, "新同步内容先形成不可变版本。合并会比较共同基线、当前成果和新同步内容；原输入重试会重新发起业务动作，并使用独立文件分支。"),
        h("label", null, "当前对话的原 Run ID", h("input", { value: runId, disabled: busy, placeholder: runtime.runDetails?.at(-1)?.runId || "run_…", onChange: event => { setRunId(event.target.value); setOriginal(null); setPreview(null); setMerged(null); } })),
        button("读取原任务与文件版本", load, !runId.trim()),
        original && h(React.Fragment, null, h("p", null, `原任务 ${original.runId} · ${original.status} · 模型 ${original.frozenModel?.modelId || "原冻结模型"}`), h("p", { className: "sa-settings-muted" }, `原文件输入 ${files?.inputSnapshotId || "纯文本任务，无项目文件"} · 原结果 ${files?.resultSnapshotId || "无"}${files?.verification ? ` · 已核验快照 ${files.verification.verifiedSnapshotId}` : ""}`),
          button("审阅原输入重试", async () => { setAcknowledged(false); setRetryOpen(true); }, !["completed", "failed", "cancelled"].includes(original.status)),
          retry && h("p", { role: "status" }, `已创建新任务 ${retry.runId}，原任务和原分支未被覆盖。请在运行区查看新任务的实际状态。`)),
        branch && h(React.Fragment, null, h("p", null, `目标文件分支 ${branch.branchId} · 当前版本 ${branch.currentSnapshotId} · 修订 ${branch.revision}`),
          button("保留当前文件版本继续", async alive => { const current = await space.controller.useCurrentFileBranch(branch.branchId, branch.revision); if (alive()) { setBranch(current); setPreview(null); settings.note(`下次输入将继续分支 ${current.branchId}；已取消固定快照验证。新同步候选仍保留，原排队输入不变。`); } }),
          h("label", null, "共同基线版本", h("select", { value: baseId, disabled: busy, onChange: event => { setBaseId(event.target.value); setPreview(null); } }, h("option", { value: "" }, "选择共同基线"), ...snapshots.map(snapshot => h("option", { key: snapshot.snapshotId, value: snapshot.snapshotId }, `${snapshot.snapshotId} · ${snapshot.source.mode}`)))),
          h("label", null, "新同步版本", h("select", { value: incomingId, disabled: busy, onChange: event => { setIncomingId(event.target.value); setPreview(null); } }, h("option", { value: "" }, "明确选择新同步版本"), ...snapshots.map(snapshot => h("option", { key: snapshot.snapshotId, value: snapshot.snapshotId }, `${snapshot.snapshotId} · ${snapshot.source.mode}`)))),
          button(preview ? "刷新三方比较并保留冲突选择" : "生成三方合并预览", readPreview, !baseId || !incomingId),
          preview && h(React.Fragment, null, h("p", null, `比较基线 ${preview.baseSnapshotId} → 当前 ${preview.currentSnapshotId} / 新同步 ${preview.incomingSnapshotId} · 预期修订 ${preview.expectedRevision}`),
            ...[...new Set([...preview.files.map(file => file.path), ...preview.conflicts])].map(path => h("div", { className: "sa-settings-row", key: path }, h("strong", null, path), preview.conflicts.includes(path) && h("select", { value: choices[path] || "", disabled: busy, onChange: event => setChoices(previous => ({ ...previous, [path]: event.target.value })) }, h("option", { value: "" }, "必须选择冲突处理"), h("option", { value: "current" }, "保留当前云端成果"), h("option", { value: "incoming" }, "采用新同步内容")),
              button("审阅三方实际内容", async alive => { const read = async snapshotId => { try { return decode(await call("files.read", { snapshotId, path })); } catch (error) { if (error.code === "NOT_FOUND") return "（不存在）"; throw error; } }; const [base, current, incoming] = await Promise.all([read(preview.baseSnapshotId), read(preview.currentSnapshotId), read(preview.incomingSnapshotId)]); if (alive()) setDiff({ path, content: `共同基线：\n${base}\n\n当前成果与新同步的差异：\n${unifiedFileDiff(current, incoming)}` }); }))),
            button("提交已审阅合并", async alive => { const result = await space.controller.commitFileMerge(preview, choices); if (alive()) { setMerged(result); setBranch(result); settings.note(`合并已发布 ${result.currentSnapshotId}；版本检查通过。已接收任务的输入保持冻结。`); } }, preview.conflicts.some(path => !choices[path]))),
          merged && h("div", { role: "status", className: "sa-settings-notice" }, `合并版本 ${merged.currentSnapshotId} · 修订 ${merged.revision}。`, button("以合并版本发起新验证", async alive => { const snapshot = await call("files.snapshot", { snapshotId: merged.currentSnapshotId }); if (alive()) space.controller.useFileSnapshot(snapshot, runtime.root); }))),
        retryOpen && h(Modal, { open: true, title: "确认原输入重试", closeLabel: "取消", onClose: () => setRetryOpen(false), footer: h("div", { className: "sa-settings-actions" }, button("取消", async () => setRetryOpen(false)), button("创建独立分支并重新执行", async alive => { const result = await space.controller.redoRun(original.runId, { acknowledgeExternalEffects: acknowledged }); if (alive()) { setRetry(result); setRetryOpen(false); } }, !acknowledged)) }, h("div", { className: "sa-settings sa-settings-editor" }, h("p", null, `将保留原任务 ${original.runId}，使用原冻结模型、Skill、附件与文件输入 ${files?.inputSnapshotId || "无项目文件"} 创建新任务。原文件分支不会推进或被覆盖。`), h("p", { className: "sa-settings-notice" }, "新任务会重新调用模型和工具，并可能再次写文件或触发外部业务动作。未知结果须先核验；模型或原文件已不可用时会拒绝。"), h("label", { className: "sa-settings-check" }, h("input", { type: "checkbox", checked: acknowledged, onChange: event => setAcknowledged(event.target.checked) }), "我已核对原结果，确认重新发起业务动作。"))),
        diff && h(Modal, { open: true, title: `三方内容 · ${diff.path}`, closeLabel: "关闭", onClose: () => setDiff(null), footer: h(Button, { onClick: () => setDiff(null) }, "关闭") }, h("pre", { style: { overflow: "auto", maxHeight: "65vh", whiteSpace: "pre", fontSize: "12px" } }, diff.content)));
    }
    return { dependencies: Dependencies, retention: Retention, branches: BranchActions };
  }
  return { createFileDecisions, unifiedFileDiff };
} });
