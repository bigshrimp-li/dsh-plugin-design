/** Super Agent owns a root panel, never a native Harness Session. */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge", chunk: "client.space.js",
  factory() {
    const SPACE_ID = "@super-agent/dsh-bridge/space";
    const STORAGE_KEY = "super-agent.space.v1";
    const GOAL_TERMINAL = new Set(["completed", "cancelled", "failed"]);
    function positiveGoalNumber(value, label = "预算") {
      if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${label}必须是安全范围内的正整数`);
      return Number(value);
    }
    /** Parse user-authored composer text only. Quoted arguments and -- preserve reserved words. */
    function parseGoalCommand(text) {
      if (/^\s*\/\/goal(?:\s|$)/i.test(text)) return { kind: "literal", text: text.replace(/\/\/(goal)/i, "/$1") };
      const match = /^\s*\/goal(?:\s+([\s\S]*))?$/i.exec(text);
      if (!match) return null;
      const body = (match[1] || "").trim(), tokens = [];
      let value = "", quote = null, start = 0, active = false;
      for (let i = 0; i <= body.length; i++) {
        const ch = body[i];
        if (quote) {
          if (ch === undefined) throw new Error("goal 命令的引号未闭合");
          if (ch === quote) quote = null;
          else if (ch === "\\" && [quote, "\\"].includes(body[i + 1])) value += body[++i];
          else value += ch;
        } else if (ch === "'" || ch === '"') { if (!active) start = i; active = true; quote = ch; }
        else if (ch === undefined || /\s/.test(ch)) { if (active) tokens.push({ value, start, end: i }); active = false; value = ""; }
        else { if (!active) start = i; active = true; value += ch; }
      }
      if (!tokens.length) return { kind: "goal", operation: "status" };
      const first = tokens[0].value.toLowerCase();
      if (["status", "pause", "resume", "cancel"].includes(first)) {
        if (tokens.length !== 1) throw new Error(`/goal ${first} 不接受额外参数；目标以保留词开头时使用 /goal --budget 数量 -- 目标正文`);
        return { kind: "goal", operation: first };
      }
      if (first === "update") {
        const objective = tokens.slice(1).map(token => token.value).join(" ").trim();
        if (!objective) throw new Error("请提供新的目标说明");
        return { kind: "goal", operation: "update", objective };
      }
      if (first === "budget") {
        if (tokens.length !== 2 || !tokens[1].value.startsWith("+")) throw new Error("使用 /goal budget +数量 提高累计预算");
        return { kind: "goal", operation: "budget", increase: positiveGoalNumber(tokens[1].value.slice(1)) };
      }
      let totalTokens, literal = false; const objective = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].value;
        if (!literal && token === "--") { literal = true; continue; }
        if (!literal && token === "--budget") {
          if (totalTokens !== undefined) throw new Error("goal 预算只能指定一次");
          totalTokens = positiveGoalNumber(tokens[++i]?.value);
        } else if (!literal && token.startsWith("--")) throw new Error(`未知 goal 参数：${token}`);
        else objective.push(token);
      }
      if (!objective.join(" ").trim()) throw new Error("请提供目标正文");
      if (!totalTokens) throw new Error("持续目标需要有限预算，请添加 --budget 数量");
      return { kind: "goal", operation: "create", objective: objective.join(" "), limits: { totalTokens } };
    }
    const linesOf = value => {
      if (value.length === 0) return [];
      const lines = value.replace(/\r\n/g, "\n").split("\n");
      if (lines.at(-1) === "") lines.pop();
      return lines;
    };
    function lineDiff(before, after) {
      const a = linesOf(before), b = linesOf(after), max = a.length + b.length;
      if (max > 4000) {
        const rows = [];
        for (let index = 0; index < a.length && rows.length < 4000; index++) rows.push({ kind: "remove", oldLine: index + 1, newLine: null, text: a[index] });
        for (let index = 0; index < b.length && rows.length < 4000; index++) rows.push({ kind: "add", oldLine: null, newLine: index + 1, text: b[index] });
        return {
          rows,
          additions: null, deletions: null, limited: true,
        };
      }
      const v = new Map([[1, 0]]), trace = [];
      const at = (map, key) => map.has(key) ? map.get(key) : -Infinity;
      let found = -1;
      for (let d = 0; d <= max; d++) {
        trace.push(new Map(v));
        for (let k = -d; k <= d; k += 2) {
          let x = k === -d || k !== d && at(v, k - 1) < at(v, k + 1) ? at(v, k + 1) : at(v, k - 1) + 1;
          if (!Number.isFinite(x)) x = 0;
          let y = x - k;
          while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
          v.set(k, x);
          if (x >= a.length && y >= b.length) { found = d; break; }
        }
        if (found >= 0) break;
      }
      const rows = [];
      let x = a.length, y = b.length;
      for (let d = found; d > 0; d--) {
        const prior = trace[d], k = x - y;
        const previousK = k === -d || k !== d && at(prior, k - 1) < at(prior, k + 1) ? k + 1 : k - 1;
        const previousX = Number.isFinite(at(prior, previousK)) ? at(prior, previousK) : 0;
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) { rows.push({ kind: "same", oldLine: x, newLine: y, text: a[x - 1] }); x--; y--; }
        if (x === previousX) { rows.push({ kind: "add", oldLine: null, newLine: y, text: b[y - 1] }); y--; }
        else { rows.push({ kind: "remove", oldLine: x, newLine: null, text: a[x - 1] }); x--; }
      }
      while (x > 0 && y > 0) { rows.push({ kind: "same", oldLine: x, newLine: y, text: a[x - 1] }); x--; y--; }
      rows.reverse();
      return { rows, additions: rows.filter(row => row.kind === "add").length, deletions: rows.filter(row => row.kind === "remove").length, limited: false };
    }
    const decodeUtf8 = encoded => {
      const binary = atob(encoded), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      if (bytes.includes(0)) return null;
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
    };
    function createSpace({ kernel, services, transport, ctx, Panel, createSpaceView, ConversationTrace, primitives, directoryBrowser, fetchImpl = globalThis.fetch, storage = globalThis.localStorage, EventSourceImpl = globalThis.EventSource }) {
      const { React, h } = kernel;
      let saved = {};
      try { saved = JSON.parse(storage?.getItem(STORAGE_KEY) || "{}"); } catch {}
      const restoreAttachments = items => (Array.isArray(items) ? items : []).map(({ thumbnailUrl, ...item }) => ["preparing", "uploading", "parsing"].includes(item.status) ? { ...item, status: "failed", error: "准备操作已中断。请重试查询原结果；需要时重新选择同一文件。" } : item);
      const restoreComposer = record => ({ ...record, attachments: restoreAttachments(record?.attachments), attachmentRemovals: record?.attachmentRemovals || [], selectedSkills: record?.selectedSkills || [], attachmentDraftId: record?.attachmentDraftId || null });
      const savedViewOptions = saved.viewOptions && typeof saved.viewOptions === "object" ? saved.viewOptions : {};
      let state = { directories: Array.isArray(saved.directories) ? saved.directories : [],
        removedRoots: Array.isArray(saved.removedRoots) ? saved.removedRoots : [],
        pinnedThreadIds: Array.isArray(saved.pinnedThreadIds) ? saved.pinnedThreadIds : [],
        archivedThreadIds: Array.isArray(saved.archivedThreadIds) ? saved.archivedThreadIds : [],
        manualThreadOrder: Array.isArray(saved.manualThreadOrder) ? saved.manualThreadOrder : [],
        viewOptions: { grouping: savedViewOptions.grouping === "flat" ? "flat" : "group",
          threadOrder: savedViewOptions.threadOrder === "manual" ? "manual" : "updated",
          archiveFilter: ["hide", "all", "only", "deleted"].includes(savedViewOptions.archiveFilter) ? savedViewOptions.archiveFilter : "hide" },
        titles: saved.titles || {}, selected: saved.selected || null,
        root: saved.root || "", modelId: saved.modelId || "", modelSource: saved.modelSource || (saved.modelId ? "conversation_override" : "service_default"), thinkingLevel: typeof saved.thinkingLevel === "string" ? saved.thinkingLevel : null, defaultModelId: "", permissionMode: saved.permissionMode || null, models: [], threads: [], messages: [], live: [], materials: Array.isArray(saved.materials) ? saved.materials : [], selectedSkillIds: Array.isArray(saved.selectedSkillIds) ? saved.selectedSkillIds : [], draft: typeof saved.draft === "string" ? saved.draft : "",
        attachments: restoreAttachments(saved.attachments), attachmentRemovals: saved.attachmentRemovals || [], attachmentDraftId: saved.attachmentDraftId || null,
        attachmentCapabilities: null, attachmentCapabilityError: "", inputPreview: null, previewLoading: false, previewError: "",
        skillCatalog: [], selectedSkills: Array.isArray(saved.selectedSkills) ? saved.selectedSkills : [], skillCatalogError: "", attachmentNotice: "",
        goalsSupported: false, goal: null, goalError: "", goalNotice: "", goalBusy: false, goalInputMode: "message", goalEventSeq: 0,
        busy: false, error: "", historyError: "", ready: false, loaded: false, inspector: false, workspaceForm: false,
        coreInstanceId: null, coreTargetLabel: "当前 Core", managedWorkspaceLocation: null, workspaceLoading: false, workspaceOpening: false, workspaceError: "", workspaceRequest: saved.workspaceRequest || null,
        thread: null, runDetails: [], waits: [], executions: [], contextView: null, contextError: "", conversation: null, fileSelection: null, delivery: "new_run", targetRunId: null,
        branches: [], branchError: "", branchesLoaded: false, branchLoading: false,
        diffWidth: Number.isFinite(saved.diffWidth) ? Math.max(360, Math.min(960, saved.diffWidth)) : 480,
        diffSelection: saved.diffSelection && typeof saved.diffSelection.runId === "string" ? { runId: saved.diffSelection.runId, filePath: typeof saved.diffSelection.filePath === "string" ? saved.diffSelection.filePath : null } : null,
        targetId: saved.targetId || null };
      const restorePendingInputs = value => new Map(Object.entries(value && typeof value === "object" ? value : {}).filter(([, attempt]) =>
        attempt && typeof attempt === "object" && typeof attempt.text === "string" && typeof attempt.signature === "string" &&
        typeof attempt.requestId === "string" && attempt.payload && typeof attempt.payload === "object"));
      const listeners = new Set(), metadata = new Map(), drafts = new Map(Object.entries(saved.drafts || {})), pendingInputs = restorePendingInputs(saved.pendingInputs), pendingWaitActions = new Map(), materialDrafts = new Map(Object.entries(saved.materialDrafts || {}));
      const restoreGoalOperations = value => new Map(Object.entries(value || {}).filter(([, record]) => record && /^goal\.(update|steer|pause|resume|cancel)$/.test(record.action) && record.payload && typeof record.payload.requestId === "string" && typeof record.payload.goalId === "string"));
      const pendingGoalOperations = restoreGoalOperations(saved.pendingGoalOperations);
      let disposed = false, started = false, epoch = 0, timer, source, refreshing = null, refreshAfterCurrent = false;
      let createAttempt = saved.createAttempt && typeof saved.createAttempt.id === "string" && typeof saved.createAttempt.signature === "string" ? saved.createAttempt : null;
      const runLookups = new Map(), liveCursors = new Map(), terminalRunIds = new Set(), pendingRedos = new Map(), pendingMerges = new Map(), pendingRollbacks = new Map(), runDiffCache = new Map();
      let materialUpload = null;
      const composerDrafts = new Map(Object.entries(saved.composerDrafts || {}).map(([key, value]) => [key, restoreComposer(value)])), attachmentJobs = new Map(), attachmentFiles = new Map(), draftRequests = new Map();
      const composerKey = () => state.selected?.conversationId || `new:${state.root || ""}`;
      const composerRecord = () => ({ attachments: state.attachments, attachmentRemovals: state.attachmentRemovals, attachmentDraftId: state.attachmentDraftId, selectedSkills: state.selectedSkills });
      const serializableComposer = record => ({ ...record, attachments: (record.attachments || []).map(({ thumbnailUrl, ...item }) => item) });
      const pendingThreadDeletions = new Map();
      let workspaceReadVersion = 0, workspaceBrowseAbort = null;
      const persist = (strict = false) => {
        const cache = { directories: state.directories, titles: state.titles, removedRoots: state.removedRoots,
          pinnedThreadIds: state.pinnedThreadIds, archivedThreadIds: state.archivedThreadIds, manualThreadOrder: state.manualThreadOrder,
          viewOptions: state.viewOptions, selected: state.selected, root: state.root, modelId: state.modelId, modelSource: state.modelSource, thinkingLevel: state.thinkingLevel, permissionMode: state.permissionMode, targetId: state.targetId, workspaceRequest: state.workspaceRequest, diffSelection: state.diffSelection, diffWidth: state.diffWidth,
          draft: state.draft, materials: state.materials, selectedSkillIds: state.selectedSkillIds, selectedSkills: state.selectedSkills,
          attachments: serializableComposer(composerRecord()).attachments, attachmentRemovals: state.attachmentRemovals, attachmentDraftId: state.attachmentDraftId,
          composerDrafts: Object.fromEntries([...composerDrafts, [composerKey(), composerRecord()]].map(([key, value]) => [key, serializableComposer(value)])),
          pendingInputs: Object.fromEntries(pendingInputs), pendingGoalOperations: Object.fromEntries(pendingGoalOperations), createAttempt,
          materialDrafts: { ...Object.fromEntries(materialDrafts), [state.selected?.conversationId || "new"]: { materials: state.materials, selectedSkillIds: state.selectedSkillIds } }, drafts: { ...Object.fromEntries(drafts), [state.selected?.conversationId || "new"]: state.draft } };
        try {
          if (strict && typeof storage?.setItem !== "function") throw new Error("浏览器未提供操作恢复存储");
          const value = JSON.stringify(cache); storage?.setItem(STORAGE_KEY, value); storage?.setItem(`${STORAGE_KEY}.${state.targetId || "uds"}`, value);
        } catch (error) { if (strict) throw new Error(`无法保存原目标操作，尚未发送：${error.message}`); }
      };
      const set = patch => { if (disposed) return;
        if (["draft", "materials", "attachments", "attachmentRemovals", "selectedSkillIds", "selectedSkills", "delivery", "targetRunId", "modelId", "thinkingLevel", "permissionMode", "fileSelection", "root"].some(key => Object.hasOwn(patch, key) && JSON.stringify(patch[key]) !== JSON.stringify(state[key])) && !Object.hasOwn(patch, "inputPreview")) patch = { ...patch, inputPreview: null, previewError: "" };
        const next = { ...state, ...patch }; if (JSON.stringify(next) === JSON.stringify(state)) return; state = next; persist(); for (const fn of listeners) fn(); };
      const threadIdOf = threadOrId => typeof threadOrId === "string" ? threadOrId : threadOrId?.threadId;
      const decorateThreads = (threads, overrides = {}) => {
        const pinned = new Set(overrides.pinnedThreadIds ?? state.pinnedThreadIds);
        const archived = new Set(overrides.archivedThreadIds ?? state.archivedThreadIds);
        const manualThreadOrder = overrides.manualThreadOrder ?? state.manualThreadOrder;
        const order = new Map(manualThreadOrder.map((id, index) => [id, index]));
        return threads.map((thread, index) => ({ ...thread,
          root: thread.conversation?.config?.cwd || "",
          pinned: overrides.pinnedThreadIds ? pinned.has(thread.threadId) : thread.pinned ?? pinned.has(thread.threadId), archived: thread.status === "archived" || (thread.archived ?? archived.has(thread.threadId)),
          manualOrder: order.has(thread.threadId) ? order.get(thread.threadId) : manualThreadOrder.length + index,
        }));
      };
      const read = async (path, init) => {
        const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 20000);
        const cancel = () => abort.abort();
        init?.signal?.addEventListener("abort", cancel, { once: true });
        if (init?.signal?.aborted) abort.abort();
        try {
          const response = await fetchImpl(`/super-agent/${path}`, { credentials: "same-origin", ...init, signal: abort.signal });
          const result = await response.json();
          if (!response.ok) { const error = new Error(result?.error?.message || result?.error || `HTTP ${response.status}`); error.code = result?.error?.code; error.details = result?.error?.details; throw error; }
          return result;
        } finally { clearTimeout(timeout); init?.signal?.removeEventListener("abort", cancel); }
      };
      const call = async (action, payload = {}, signal) => (await read("action", { method: "POST", headers: { "Content-Type": "application/json" }, ...(signal ? { signal } : {}), body: JSON.stringify({ action, payload: { ...payload, targetId: Object.hasOwn(payload, "targetId") ? payload.targetId : state.targetId } }) })).result;
      const requestId = action => transport.nextRequestId(action);
      const originOfComposer = () => ({ targetId: state.targetId, key: composerKey(), root: state.root, conversationId: state.selected?.conversationId, coreInstanceId: state.coreInstanceId });
      const updateComposer = (origin, mutate) => {
        if (disposed) return;
        if (origin.targetId === state.targetId) {
          const active = origin.key === composerKey(), current = active ? composerRecord() : composerDrafts.get(origin.key) || { attachments: [], attachmentRemovals: [], selectedSkills: [], attachmentDraftId: null };
          const record = mutate(current); composerDrafts.set(origin.key, record);
          if (active) set(record); else persist();
          return record;
        }
        try {
          const key = `${STORAGE_KEY}.${origin.targetId || "uds"}`, cached = JSON.parse(storage?.getItem(key) || "{}");
          const records = cached.composerDrafts || {}, record = serializableComposer(mutate(records[origin.key] || { attachments: [], attachmentRemovals: [], selectedSkills: [], attachmentDraftId: null }));
          records[origin.key] = record; cached.composerDrafts = records;
          if ((cached.selected?.conversationId || `new:${cached.root || ""}`) === origin.key) Object.assign(cached, record);
          storage?.setItem(key, JSON.stringify(cached)); return record;
        } catch { return null; }
      };
      const updateAttachment = (origin, id, patch) => updateComposer(origin, record => ({ ...record, attachments: record.attachments.map(item => item.id === id ? { ...item, ...patch } : item) }));
      const bytesBase64 = bytes => { let value = ""; for (let offset = 0; offset < bytes.length; offset += 4096) value += String.fromCharCode(...bytes.subarray(offset, offset + 4096)); return btoa(value); };
      const digestBytes = async bytes => [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const ensureAttachmentDraft = async (origin, seed) => {
        const existing = origin.targetId === state.targetId && origin.key === composerKey() ? state.attachmentDraftId : composerDrafts.get(origin.key)?.attachmentDraftId;
        if (existing) return existing;
        const key = `${origin.targetId || "uds"}:${origin.key}`;
        if (!draftRequests.has(key)) draftRequests.set(key, (async () => {
          let workspace;
          if (origin.root) { workspace = await call("workspace.find", { targetId: origin.targetId, root: origin.root }); if (!workspace?.workspaceId) workspace = await call("workspace.register", { targetId: origin.targetId, root: origin.root, requestId: `${seed}:workspace` }); }
          const draft = await call("attachments.drafts.create", { targetId: origin.targetId, requestId: `${seed}:draft`, ...(origin.conversationId ? { conversationId: origin.conversationId } : {}), ...(workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : {}) });
          if (!draft?.draftId) throw new Error("服务未返回附件草稿身份，请重试原操作");
          updateComposer(origin, record => ({ ...record, attachmentDraftId: draft.draftId })); return draft.draftId;
        })().finally(() => draftRequests.delete(key)));
        return draftRequests.get(key);
      };
      const selectedSkillRefs = () => state.attachmentCapabilities?.skillSelection === true ? state.selectedSkills.filter(skill => state.selectedSkillIds.includes(skill.skillId)).map(skill => ({ skillId: skill.skillId, sourceId: skill.sourceId, version: skill.version || skill.snapshotId, sourceRevision: skill.sourceRevision, policyRevision: skill.policyRevision })).filter(ref => ref.sourceId && ref.version && Number.isInteger(ref.sourceRevision) && Number.isInteger(ref.policyRevision)) : [];
      const validateSelectedSkills = async capabilities => {
        const refs = selectedSkillRefs();
        if (capabilities.skillSelection !== true || !state.selectedSkillIds.length) return refs;
        if (refs.length !== state.selectedSkillIds.length) throw new Error("所选 Skill 缺少已确认的固定来源与版本，请重新选择或移除原标签；原草稿已保留");
        const catalog = await controller.loadSkillCatalog();
        if (refs.some(ref => !catalog.some(item => item.skillId === ref.skillId && ["available", "enabled"].includes(item.status) && item.sourceId === ref.sourceId && (item.version || item.snapshotId) === ref.version && item.sourceRevision === ref.sourceRevision && item.policyRevision === ref.policyRevision))) throw new Error("所选 Skill 的版本或适用范围已变化，请确认当前版本或移除原标签；原草稿已保留");
        return refs;
      };
      const identifyAttachment = (bytes, name) => {
        const starts = values => values.every((value, index) => bytes[index] === value);
        if (starts([137,80,78,71,13,10,26,10])) return { kind: "image", mediaType: "image/png" };
        if (starts([255,216,255])) return { kind: "image", mediaType: "image/jpeg" };
        if (new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) return { kind: "image", mediaType: "image/gif" };
        if (new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8,12)) === "WEBP") return { kind: "image", mediaType: "image/webp" };
        if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") return { kind: "document", mediaType: "application/pdf" };
        if (/\.docx$/i.test(name) && starts([80,75])) return { kind: "document", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
        if (/\.(?:png|jpe?g|gif|webp|pdf|docx)$/i.test(name)) throw new Error("文件内容与格式不符，请检查原文件");
        if (bytes.includes(0)) throw new Error("当前文件不是可读取的 UTF-8 文本，请导出为支持的格式");
        try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("文件不是 UTF-8 文本，请转换编码后重新选择"); }
        return { kind: "file", mediaType: "text/plain" };
      };
      let capabilityRequest = null;
      const loadAttachmentCapabilities = async ({ force = false } = {}) => {
        if (!force && state.attachmentCapabilities) return state.attachmentCapabilities;
        if (!force && capabilityRequest?.targetId === state.targetId) return capabilityRequest.promise;
        const targetId = state.targetId;
        const promise = (async () => {
          try {
            const result = await call("attachments.capabilities", { targetId });
            const capabilities = result && (typeof result.supported === "boolean" || result.runtime || result.formats || result.limits) ? result : { legacy: true, supported: true, formats: ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"] };
            if (!disposed && targetId === state.targetId) set({ attachmentCapabilities: capabilities, attachmentCapabilityError: "" });
            return capabilities;
          } catch (error) {
            if (!["NOT_FOUND", "UNSUPPORTED", "METHOD_NOT_FOUND"].includes(error.code)) {
              if (targetId === state.targetId) set({ attachmentCapabilityError: error.message });
              throw error;
            }
            const capabilities = { legacy: true, supported: true, formats: ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"] };
            if (targetId === state.targetId) set({ attachmentCapabilities: capabilities, attachmentCapabilityError: "" });
            return capabilities;
          }
        })();
        capabilityRequest = { targetId, promise };
        try { return await promise; } finally { if (capabilityRequest?.promise === promise) capabilityRequest = null; }
      };
      const discardPrepared = async (origin, card, item) => {
        const removal = { attachmentId: item.attachmentId, draftId: item.draftId || card.draftId, requestId: `${card.requestId || card.id}:remove` };
        updateComposer(origin, record => ({ ...record, attachmentRemovals: [...(record.attachmentRemovals || []).filter(value => value.requestId !== removal.requestId), removal] }));
        try {
          if (item.status === "preparing" && item.operationId) await call("attachments.cancel", { targetId: origin.targetId, operationId: item.operationId, requestId: `${card.requestId}:cancel` });
          await call("attachments.remove", { targetId: origin.targetId, ...removal });
          updateComposer(origin, record => ({ ...record, attachmentRemovals: record.attachmentRemovals.filter(value => value.requestId !== removal.requestId) }));
        } catch { if (origin.targetId === state.targetId && origin.key === composerKey()) set({ attachmentNotice: "附件已移出草稿；服务取消或移除结果待确认，请查询原操作。" }); }
      };
      const awaitPrepared = async (origin, card, initial, job = {}) => {
        let item = initial.item || initial; const deadline = Date.now() + 35000;
        if (!item?.attachmentId) throw new Error("服务未返回附件身份，请重试原准备操作");
        job.operationId = item.operationId; job.modern = true;
        if (job.cancelled) { await discardPrepared(origin, card, item); return null; }
        updateAttachment(origin, card.id, { attachmentId: item.attachmentId, operationId: item.operationId, draftId: item.draftId || card.draftId, legacy: false });
        while (item.status === "preparing" && !job.cancelled && !disposed && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 200));
          item = await call("attachments.get", { targetId: origin.targetId, attachmentId: item.attachmentId }); item = item.item || item;
        }
        if (job.cancelled) { await discardPrepared(origin, card, item); return null; }
        if (disposed) return null;
        if (item.status !== "ready" || !item.representations?.some(value => value.status === "available")) throw new Error(item.error?.message || item.error || "附件结果待确认，请重试查询原操作");
        const mediaType = item.mediaType, kind = mediaType?.startsWith("image/") ? "image" : ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(mediaType) ? "document" : "file";
        updateAttachment(origin, card.id, { status: "ready", attachmentId: item.attachmentId, operationId: item.operationId, mediaType, kind, draftId: item.draftId || card.draftId, representations: item.representations, ref: card.ref || { attachmentId: item.attachmentId }, warnings: item.warnings || [], pageCount: mediaType === "application/pdf" ? Math.max(...item.representations.map(value => value.totalUnits || 0)) : undefined, mode: card.ref?.mode || "auto", legacy: false });
        return item;
      };
      const uploadAttachment = async (origin, card, file, capabilities) => {
        const slot = `${origin.targetId || "uds"}:${card.id}`;
        if (attachmentJobs.get(slot)?.running) return;
        const job = attachmentJobs.get(slot) || { requestId: card.requestId, operationId: card.operationId, cancelled: false };
        job.running = true; attachmentJobs.set(slot, job); attachmentFiles.set(slot, file);
        const request = (action, payload) => call(action, { ...payload, targetId: origin.targetId });
        try {
          updateAttachment(origin, card.id, { status: "preparing", error: "" });
          const bytes = new Uint8Array(await file.arrayBuffer()), hash = await digestBytes(bytes), type = identifyAttachment(bytes, file.name);
          if (card.sha256 && card.sha256 !== hash) throw new Error("重新选择的文件内容已变化，请移除后作为新附件添加");
          const siblings = origin.targetId === state.targetId && origin.key === composerKey() ? state.attachments : composerDrafts.get(origin.key)?.attachments || [];
          if (siblings.some(item => item.id !== card.id && item.sha256 === hash && item.status !== "failed")) {
            updateAttachment(origin, card.id, { status: "duplicate", sha256: hash, error: "相同内容已添加，请移除重复项" }); return;
          }
          if (capabilities.supported === false) throw new Error(capabilities.reason || "当前运行时暂不支持附件，请切换到 TypeScript/Pi 服务");
          const legacy = capabilities.legacy === true || capabilities.drafts === false;
          if (!legacy && Array.isArray(capabilities.formats) && !capabilities.formats.some(format => {
            const accepted = typeof format === "string" ? format : format.mediaType;
            return accepted === type.mediaType || accepted?.endsWith("/*") && type.mediaType.startsWith(accepted.slice(0, -1));
          })) throw new Error("当前服务尚不支持该格式，请导出为能力列表中的图片或 UTF-8 文本");
          const maxFile = type.kind === "image" ? capabilities.limits?.maxImageBytes || 10 * 1048576 : type.kind === "document" ? capabilities.limits?.maxDocumentBytes || 20 * 1048576 : capabilities.limits?.maxTextBytes || 1048576;
          if (bytes.length > maxFile) throw new Error(`文件超过当前服务单项上限 ${Math.floor(maxFile / 1048576)} MiB`);
          if (legacy && type.kind === "document") throw new Error("当前服务尚不支持 PDF/DOCX 解析，请改附 UTF-8 文本或图片");
          if (job.cancelled) return;
          let thumbnailUrl;
          if (type.kind === "image" && globalThis.URL?.createObjectURL) thumbnailUrl = globalThis.URL.createObjectURL(file);
          updateAttachment(origin, card.id, { ...type, sha256: hash, thumbnailUrl, status: "uploading" });
          if (!legacy) {
            const draftId = await ensureAttachmentDraft(origin, card.requestId);
            updateAttachment(origin, card.id, { draftId, status: "parsing" });
            const prepared = await request("attachments.prepare", { requestId: card.requestId, draftId, name: file.name, dataBase64: bytesBase64(bytes) });
            await awaitPrepared(origin, { ...card, draftId }, prepared, job);
            return prepared;
          }
          const blockMap = new Map(), blocks = [];
          for (let offset = 0; offset < bytes.length; offset += 262144) { const block = bytes.slice(offset, offset + 262144), digest = await digestBytes(block); blockMap.set(digest, block); blocks.push(digest); }
          const manifest = { version: 1, files: [{ path: file.name, hash, size: bytes.length, mode: 420, blocks }], ignored: [], rules: ["explicit-message-attachments"] };
          const workspace = origin.root ? await request("workspace.find", { root: origin.root }) : null;
          let transfer = job.operationId ? await request("files.transfer.get", { operationId: job.operationId }) : await request("files.transfer.create", { requestId: card.requestId, workspaceId: workspace?.workspaceId || `message:${card.requestId}`, manifest, source: { mode: "local_upload", location: "explicit-message-attachments" } });
          job.operationId = transfer.operationId;
          updateAttachment(origin, card.id, { operationId: transfer.operationId });
          for (const digest of transfer.missingBlocks || []) {
            if (job.cancelled || disposed) return;
            if (!blockMap.has(digest)) throw new Error("原上传的内容块不匹配，请重新选择同一文件");
            await request("files.transfer.upload", { requestId: `${card.requestId}:block:${digest}`, operationId: transfer.operationId, hash: digest, dataBase64: bytesBase64(blockMap.get(digest)) });
          }
          if (job.cancelled || disposed) return;
          const snapshot = await request("files.transfer.commit", { requestId: `${card.requestId}:commit`, operationId: transfer.operationId });
          if (!snapshot?.snapshotId) throw new Error("上传结果待确认，请重试原操作");
          if (!job.cancelled) updateAttachment(origin, card.id, { status: "ready", legacy: true, mode: type.kind === "image" ? "image" : "inline", material: { kind: type.kind, snapshotId: snapshot.snapshotId, path: file.name, source: `本机消息附件:${file.name}`, ...(type.kind === "image" ? { mediaType: type.mediaType } : {}) } });
          return snapshot;
        } catch (error) { if (!job.cancelled) updateAttachment(origin, card.id, { status: "failed", error: error.message, operationId: job.operationId || null }); }
        finally { job.running = false; }
      };
      const composerSignature = () => JSON.stringify([state.targetId, state.coreInstanceId, state.selected?.conversationId || null, state.root, state.draft, state.attachments.map(({ id, sha256, status, ref, material }) => ({ id, sha256, status, ref, material })), state.materials, state.selectedSkillIds, state.selectedSkills, state.delivery, state.targetRunId, state.conversation?.pendingConfig || state.conversation?.config || state.modelId, state.thinkingLevel, state.permissionMode, state.fileSelection]);
      let inputPreviewVersion = 0;
      const previewInput = async () => {
        const previewVersion = ++inputPreviewVersion;
        const targetId = state.targetId, key = composerKey(), signature = composerSignature();
        if (state.attachments.some(item => item.status !== "ready")) throw new Error("请先重试或移除尚未准备好的附件");
        if (state.attachmentRemovals.length) throw new Error("附件移除结果待确认，请先查询原操作");
        const capabilities = await loadAttachmentCapabilities();
        set({ previewLoading: true, previewError: "" });
        try {
          const preparedAttachments = state.attachments.filter(item => item.ref).map(item => item.ref), materials = [...state.materials, ...state.attachments.filter(item => item.material).map(item => item.material)];
          const parsedCommand = parseGoalCommand(state.draft), previewDelivery = parsedCommand?.operation === "create" ? "new_run" : state.delivery;
          const previewText = parsedCommand?.objective || parsedCommand?.text || state.draft;
          const modelId = previewDelivery === "next_turn" ? state.runDetails.find(item => item.runId === state.targetRunId)?.modelId : state.conversation?.pendingConfig?.config?.modelId || state.conversation?.config?.modelId || state.modelId;
          let result;
          if (capabilities.inputPreview === true || capabilities.preview === true) {
            if (materials.length) throw new Error("旧版材料与新附件预检不能混合，请重新附加原文件后预览");
            const refs = await validateSelectedSkills(capabilities);
            const draftId = await ensureAttachmentDraft(originOfComposer(), requestId("attachment.preview"));
            result = await call("input.preview", { targetId, requestId: requestId("input.preview"), draftId, ...(state.selected?.conversationId ? { conversationId: state.selected.conversationId } : { thinkingLevel: state.thinkingLevel, ...(state.permissionMode ? { permissionMode: state.permissionMode } : {}) }), modelId, text: previewText, attachments: preparedAttachments, ...(refs.length === state.selectedSkillIds.length && refs.length ? { selectedSkillRefs: refs } : { selectedSkillIds: state.selectedSkillIds }), delivery: previewDelivery, ...(previewDelivery === "next_turn" && state.targetRunId ? { targetRunId: state.targetRunId } : {}) });
            if (!result?.planId || typeof result.signature !== "string") throw new Error("服务未返回有效的上下文预检结果，请重试");
          } else {
            if (preparedAttachments.length) throw new Error("当前服务未提供新附件预检，不能忽略附件继续发送");
            result = { legacy: true, canSend: true, items: materials.map(item => ({ name: item.path, mode: item.kind === "image" ? "image" : "inline" })), modelId, notice: "当前服务使用图片和 UTF-8 全文通路，尚无整体上下文预算预检；最终以服务校验为准。" };
          }
          if (disposed || previewVersion !== inputPreviewVersion || targetId !== state.targetId || key !== composerKey() || signature !== composerSignature()) throw Object.assign(new Error("草稿或目标已变化，请重新查看本次上下文"), { code: "PREVIEW_SUPERSEDED" });
          const plan = { ...result, inputSignature: signature }; set({ inputPreview: plan }); return plan;
        } catch (error) { if (previewVersion === inputPreviewVersion && targetId === state.targetId && key === composerKey() && signature === composerSignature()) set({ previewError: error.message }); throw error; }
        finally { if (previewVersion === inputPreviewVersion && targetId === state.targetId && key === composerKey()) set({ previewLoading: false }); }
      };
      const pageAll = async (action, payload, onPage) => {
        const targetId = state.targetId;
        const items = []; let cursor; const seen = new Set();
        do {
          const page = await call(action, { ...payload, targetId, limit: 200, ...(cursor ? { cursor } : {}) });
          if (!page || !Array.isArray(page.items)) throw new Error(`${action} 返回的数据结构无效，请重试`);
          onPage?.(page);
          items.push(...page.items.filter(item => item && typeof item === "object")); cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error("分页没有前进，请刷新后重试");
          seen.add(cursor);
        } while (cursor);
        return items;
      };
      const requireGoalSupport = async () => {
        const targetId = state.targetId, at = epoch;
        const info = await call("server.info", { targetId });
        if (disposed || at !== epoch || targetId !== state.targetId) throw new Error("连接或对话已切换，请重新确认目标操作");
        const supported = info?.runtimeFeatures?.goalsV1 === true;
        set({ goalsSupported: supported });
        if (!supported) throw Object.assign(new Error("当前 Core 不支持持久目标，请连接支持 goalsV1 的 Go runtime"), { code: "NOT_SUPPORTED" });
      };
      const readGoal = async selected => {
        if (!selected || !state.goalsSupported) return null;
        const targetId = state.targetId;
        const goals = await pageAll("goal.list", { conversationId: selected.conversationId, targetId });
        const latest = goals.find(goal => !GOAL_TERMINAL.has(goal.status)) || goals[0];
        if (!latest?.goalId) return null;
        const goal = await call("goal.get", { goalId: latest.goalId, targetId });
        if (goal?.conversationId !== selected.conversationId || !Number.isSafeInteger(goal.revision)) throw new Error("目标快照的身份或修订无效");
        return goal;
      };
      const syncSelection = async () => {
        const at = epoch, selected = state.selected;
        const query = selected ? `?${new URLSearchParams({ threadId: selected.threadId, conversationId: selected.conversationId })}` : "";
        const view = await read(`state${query}`);
        if (disposed || at !== epoch) return;
        if (view.target && view.target.selectedId !== state.targetId) { controller.targetChanged(view.target.selectedId); return; }
        // This store is private to this space; no native Session identity is involved.
        services.viewState.set({ ...view, sessionError: null, sessionId: null });
        const target = view.target?.targets?.find(item => item.id === view.target.selectedId);
        if (target) set({ coreTargetLabel: `${target.name} · ${target.baseUrl}` });
        if (view.connection !== "ready") {
          set({ ready: false, loaded: true, error: view.core?.error?.message || "Core 未连接，请检查本机服务后刷新" }); return;
        }
        let goal = null, goalError = "";
        try { goal = await readGoal(selected); } catch (error) { goalError = error.message; }
        if (disposed || at !== epoch) return;
        if (goal && state.goal?.goalId === goal.goalId && state.goal.revision > goal.revision) goal = state.goal;
        let messages = state.messages, thread = state.thread, conversation = state.conversation, runDetails = state.runDetails || [], waits = state.waits || [], executions = state.executions || [], contextView = state.contextView, contextError = "", historyError = "", historyCaughtUp = true, historySucceeded = false, branches = state.branches || [], branchError = "";
        if (selected) {
          const readWaits = async () => {
            const statuses = ["waiting", "answered", "cancelled"];
            const pages = await Promise.allSettled(statuses.map(status => pageAll("waits.list", { threadId: selected.threadId, status })));
            if (pages[0].status === "rejected") throw pages[0].reason;
            return { items: pages.flatMap(page => page.status === "fulfilled" ? page.value : []), historyError: pages.slice(1).flatMap((page, index) => page.status === "rejected" ? [`${statuses[index + 1]}：${page.reason?.message || "未知错误"}`] : []).join("；") };
          };
          const results = await Promise.allSettled([
            pageAll("messages.list", { conversationId: selected.conversationId }, page => { if (page.caughtUp !== true) historyCaughtUp = false; }),
            call("thread.get", { threadId: selected.threadId }),
            call("conversation.get", { conversationId: selected.conversationId }),
            readWaits(),
            call("executions.list", { threadId: selected.threadId }),
            call("conversation.context", { conversationId: selected.conversationId }),
          ]);
          if (results[0].status === "fulfilled") { historySucceeded = true; messages = results[0].value.filter(message => typeof message.messageId === "string").map(message => ({ ...message, text: typeof message.text === "string" ? message.text : "" })); }
          else historyError = `历史消息读取失败：${results[0].reason?.message || "未知错误"}`;
          if (results[1].status === "fulfilled") thread = results[1].value;
          else historyError += `${historyError ? "；" : ""}任务状态读取失败：${results[1].reason?.message || "未知错误"}`;
          if (results[2].status === "fulfilled") conversation = results[2].value;
          if (results[3].status === "fulfilled") {
            waits = results[3].value.items.filter(wait => wait.conversationId === selected.conversationId ||
              thread?.threadId === selected.threadId && thread.runs?.some(run => run.runId === wait.runId && run.conversationId === wait.conversationId));
            if (results[3].value.historyError) historyError += `${historyError ? "；" : ""}等待历史部分读取失败：${results[3].value.historyError}`;
          }
          else historyError += `${historyError ? "；" : ""}等待读取失败：${results[3].reason?.message || "未知错误"}`;
          if (results[4].status === "fulfilled" && Array.isArray(results[4].value)) executions = results[4].value.filter(item => item.conversationId === selected.conversationId ||
            thread?.threadId === selected.threadId && thread.runs?.some(run => run.runId === item.runId && run.conversationId === item.conversationId));
          if (results[5].status === "fulfilled" && results[5].value?.conversationId === selected.conversationId) contextView = results[5].value;
          else if (results[5].status === "rejected") contextError = results[5].reason?.message || "上下文状态读取失败";
          const ids = [...new Set([
            ...(Array.isArray(thread?.activeRuns) ? thread.activeRuns : []),
            ...(Array.isArray(thread?.queuedRuns) ? thread.queuedRuns : []),
            ...(Array.isArray(thread?.runs) ? thread.runs.map(run => run.runId) : []),
            ...state.live.map(message => message.runId),
            contextView?.latestRunId,
          ])].filter(id => typeof id === "string");
          const runs = await Promise.allSettled(ids.map(runId => call("run.get", { runId })));
          runDetails = runs.filter(result => result.status === "fulfilled" && result.value?.conversationId === selected.conversationId).map(result => result.value);
          if (at === epoch) for (const run of runDetails) if (["completed", "failed", "cancelled"].includes(run.status)) { terminalRunIds.add(run.runId); runLookups.set(run.runId, Promise.resolve(run)); }
        } else { messages = []; thread = null; conversation = null; runDetails = []; waits = []; executions = []; contextView = null; }
        if (disposed || at !== epoch) return;
        const committed = new Set(messages.map(m => m.generationKey).filter(Boolean));
        const finalRuns = new Set(messages.filter(message => message.isFinal === true).map(message => message.runId));
        set({ ready: true, loaded: true, goal, goalError, messages, thread, conversation, runDetails, waits, executions, contextView, contextError, historyError, branches, branchError,
          live: state.live.filter(m => !committed.has(m.generationKey) && !(terminalRunIds.has(m.runId) && historySucceeded && (historyCaughtUp || finalRuns.has(m.runId)))) });
      };
      const refresh = async () => {
        if (refreshing) return refreshing;
        refreshing = (async () => {
          const at = epoch;
          try {
            const [catalog, listed, settings, info] = await Promise.allSettled([call("models.list"), pageAll("thread.list", { deleted: "include" }), call("settings.get"), call("server.info")]);
            if (disposed || at !== epoch) return;
            set({ goalsSupported: info.status === "fulfilled" ? info.value?.runtimeFeatures?.goalsV1 === true : state.goalsSupported });
            const modelsResult = catalog.status === "fulfilled" ? catalog.value : state.models;
            const models = Array.isArray(modelsResult) ? modelsResult.filter(m => m && typeof m.id === "string") : Array.isArray(modelsResult?.items) ? modelsResult.items : [];
            const summaries = listed.status === "fulfilled" ? listed.value : state.threads;
            const defaults = settings.status === "fulfilled" ? settings.value?.configuration : null;
            const instanceId = settings.status === "fulfilled" ? settings.value?.instanceId : null;
            if (instanceId && instanceId !== state.coreInstanceId) {
              workspaceReadVersion++; workspaceBrowseAbort?.abort();
              set({ coreInstanceId: instanceId, attachmentCapabilities: null, managedWorkspaceLocation: null, workspaceLoading: false,
                ...(state.coreInstanceId ? { workspaceForm: false, workspaceOpening: false, workspaceError: "Core 实例已变化，请重新打开工作区选择器" } : {}) });
            }
            const defaultId = defaults?.modelConfiguration?.models?.find(item => item.id === defaults.defaultModelConfigId)?.modelId;
            const defaultModelId = defaults ? models.find(item => item.id === defaultId && item.selectable !== false)?.id || "" : state.defaultModelId;
            const threads = await Promise.all(summaries.filter(summary => typeof summary.threadId === "string").map(async summary => {
              try {
                const conversation = await call("conversation.get", { conversationId: summary.mainConversationId });
                if (!conversation?.config || typeof conversation.config !== "object") throw new Error("会话配置结构无效");
                if (disposed || at !== epoch) return { ...summary, conversation: { config: {} } };
                metadata.set(summary.mainConversationId, conversation);
                return { ...summary, conversation, loadError: null };
              } catch (error) { return { ...summary, conversation: metadata.get(summary.mainConversationId) || { config: {} }, loadError: error.message }; }
            }));
            if (disposed || at !== epoch) return;
            const removedRoots = new Set(state.removedRoots), directories = state.directories.map(directory => ({ ...directory }));
            for (const thread of threads) {
              const root = thread.conversation?.config?.cwd;
              if (root && !removedRoots.has(root) && !directories.some(d => d.root === root)) directories.push({ root });
            }
            const root = state.selected || !state.root || directories.some(directory => directory.root === state.root)
              ? state.root : directories[0]?.root || "";
            const listError = [catalog, listed].filter(result => result.status === "rejected").map(result => result.reason?.message || "读取失败").join("；");
            set({ models, defaultModelId, threads: decorateThreads(threads), directories, root, ...(listError ? { error: listError } : {}),
              modelId: state.modelSource === "service_default" ? defaultModelId : models.some(m => m.id === state.modelId && m.selectable !== false) ? state.modelId : "" });
            await syncSelection();
          } catch (error) { if (at === epoch) set({ error: error.message, ready: false, loaded: true }); }
        })().finally(() => { refreshing = null; if (refreshAfterCurrent && !disposed) { refreshAfterCurrent = false; void refresh(); } });
        return refreshing;
      };
      const rememberDraft = () => { const key = state.selected?.conversationId || "new"; drafts.set(key, state.draft); materialDrafts.set(key, { materials: state.materials, selectedSkillIds: state.selectedSkillIds }); composerDrafts.set(composerKey(), composerRecord()); };
      const selectThread = async (threadId, conversationId) => {
        rememberDraft(); epoch++; runLookups.clear(); liveCursors.clear(); terminalRunIds.clear(); runDiffCache.clear();
        const item = state.threads.find(t => t.threadId === threadId);
        set({ busy: false, goal: null, goalError: "", goalNotice: "", goalBusy: false, goalInputMode: "message", selected: { threadId, conversationId }, root: item?.conversation?.config?.cwd || "",
          ...(composerDrafts.get(conversationId) || { attachments: [], attachmentRemovals: [], attachmentDraftId: null, selectedSkills: [] }), skillCatalog: [], inputPreview: null, previewError: "", previewLoading: false,
          draft: drafts.get(conversationId) || "", materials: materialDrafts.get(conversationId)?.materials || [], selectedSkillIds: materialDrafts.get(conversationId)?.selectedSkillIds || [], fileSelection: null, targetRunId: null, diffSelection: null, messages: [], live: [], thread: null, runDetails: [], waits: [], executions: [], contextView: null, contextError: "", conversation: null, branches: [], branchError: "", branchesLoaded: false, branchLoading: false, historyError: "", error: "" });
        ctx.layout.selectPanel(SPACE_ID);
        try { await syncSelection(); } catch (error) { set({ error: error.message }); }
      };
      const newConversation = (root = state.root) => {
        if (state.busy) return;
        rememberDraft(); epoch++; runLookups.clear(); liveCursors.clear(); terminalRunIds.clear(); runDiffCache.clear(); createAttempt = null;
        const nextModelId = state.defaultModelId;
        const nextModel = state.models.find(model => model.id === nextModelId);
        const thinkingLevel = nextModelId === state.modelId && (state.thinkingLevel === null || !Array.isArray(nextModel?.supportedThinkingLevels) || nextModel.supportedThinkingLevels.includes(state.thinkingLevel)) ? state.thinkingLevel : null;
        set({ ...(composerDrafts.get(`new:${root || ""}`) || { attachments: [], attachmentRemovals: [], attachmentDraftId: null, selectedSkills: [] }), skillCatalog: [], inputPreview: null, previewLoading: false, previewError: "", goal: null, goalError: "", goalNotice: "", goalBusy: false, goalInputMode: "message", selected: null, root, modelId: nextModelId, modelSource: "service_default", thinkingLevel, delivery: "new_run", draft: drafts.get("new") || "", materials: materialDrafts.get("new")?.materials || [], selectedSkillIds: materialDrafts.get("new")?.selectedSkillIds || [], fileSelection: null, targetRunId: null, diffSelection: null, messages: [], live: [], thread: null, runDetails: [], waits: [], executions: [], contextView: null, contextError: "", conversation: null, branches: [], branchError: "", branchesLoaded: false, branchLoading: false, historyError: "", error: "" });
        services.viewState.set({ threadId: null, conversationId: null, mainConversationId: null, snapshot: null, run: null });
        ctx.layout.selectPanel(SPACE_ID);
      };
      const registerWorkspace = async root => {
        if (typeof root !== "string" || !root.startsWith("/")) throw new Error("请输入工作目录的绝对路径");
        const at = epoch, targetId = state.targetId;
        const workspace = await call("workspace.register", { targetId, root, requestId: requestId("workspace.register") });
        if (disposed || at !== epoch || targetId !== state.targetId) return workspace;
        set({ directories: [...state.directories.filter(d => d.root !== workspace.root), workspace],
          removedRoots: state.removedRoots.filter(removed => removed !== workspace.root), workspaceForm: false });
        newConversation(workspace.root);
        return workspace;
      };
      const managedRelativePath = (value, allowEmpty = false) => {
        if (typeof value !== "string" || !allowEmpty && !value.trim() || value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value) || value.includes("\\") || value.includes("\0") || value && value.split("/").some(part => !part || part.startsWith("."))) throw new Error("请输入 Core 工作区内的相对目录，例如 team/project；不能使用绝对路径、~、隐藏目录或上级目录");
        return value;
      };
      const managedWorkspaceScope = location => location?.instanceId ? `instance:${location.instanceId}` : location?.connectionKind === "uds" && Number.isInteger(location.serverPid) && typeof location.serverStartedAt === "string" ? `uds:${location.serverPid}:${location.serverStartedAt}` : null;
      const managedWorkspaceExpected = location => location?.instanceId ? { expectedInstanceId: location.instanceId } : { expectedServerPid: location.serverPid, expectedServerStartedAt: location.serverStartedAt };
      const browseManagedWorkspace = async (relativePath = "") => {
        managedRelativePath(relativePath, true);
        workspaceBrowseAbort?.abort(); const abort = new AbortController(); workspaceBrowseAbort = abort;
        const version = ++workspaceReadVersion, at = epoch, targetId = state.targetId, previous = state.managedWorkspaceLocation;
        const expected = previous ? managedWorkspaceExpected(previous) : state.coreInstanceId ? { expectedInstanceId: state.coreInstanceId } : {};
        set({ workspaceLoading: true, workspaceError: "" });
        try {
          const location = await call("workspace.managed.browse", { targetId, relativePath, ...expected }, abort.signal);
          if (disposed || at !== epoch || version !== workspaceReadVersion || targetId !== state.targetId || abort.signal.aborted) return null;
          if (!managedWorkspaceScope(location) || location.targetId !== targetId || expected.expectedInstanceId && location.instanceId !== expected.expectedInstanceId || previous && managedWorkspaceScope(location) !== managedWorkspaceScope(previous)) throw new Error("Core 实例已变化，请重新读取工作区");
          if (!location.baseRoot?.startsWith("/") || location.relativePath !== relativePath || !Array.isArray(location.directories)) throw new Error("Core 返回的工作区目录结构无效");
          set({ managedWorkspaceLocation: location, coreInstanceId: location.instanceId ?? null }); return location;
        } catch (error) { if (!disposed && at === epoch && version === workspaceReadVersion && !abort.signal.aborted) set({ workspaceError: error.message }); throw error; }
        finally { if (!disposed && at === epoch && version === workspaceReadVersion) set({ workspaceLoading: false }); }
      };
      const openManagedWorkspace = async relativePath => {
        managedRelativePath(relativePath);
        const location = state.managedWorkspaceLocation, at = epoch, targetId = state.targetId;
        if (!managedWorkspaceScope(location) || location.targetId !== targetId || state.coreInstanceId && location.instanceId !== state.coreInstanceId) throw new Error("请先读取当前 Core 的工作区目录");
        const expected = managedWorkspaceExpected(location);
        let pending = state.workspaceRequest;
        if (pending && (pending.targetId !== targetId || Object.entries(expected).some(([key, value]) => pending[key] !== value) || pending.relativePath !== relativePath)) throw new Error("原工作区创建结果尚未确认，请保留原目录和原实例重试");
        if (!pending) { pending = { targetId, ...expected, relativePath, createIfMissing: true, requestId: requestId("workspace.managed.open") }; set({ workspaceRequest: pending }); }
        set({ workspaceOpening: true, workspaceError: "" });
        try {
          const workspace = await call("workspace.managed.open", pending);
          if (disposed || at !== epoch || targetId !== state.targetId || pending.expectedInstanceId && state.coreInstanceId !== pending.expectedInstanceId) return null;
          if (workspace?.state !== "ready" || !workspace.workspaceId || managedWorkspaceScope(workspace) !== managedWorkspaceScope(location) || workspace.targetId !== targetId || workspace.relativePath !== relativePath || !workspace.root?.startsWith("/")) throw new Error("工作区创建与注册结果尚未确认，请用原请求重试");
          set({ directories: [...state.directories.filter(item => item.root !== workspace.root), workspace], removedRoots: state.removedRoots.filter(root => root !== workspace.root), workspaceRequest: null, workspaceForm: false, workspaceOpening: false });
          newConversation(workspace.root); return workspace;
        } catch (error) { if (!disposed && at === epoch) {
          const rejected = error.details?.operationAccepted === false && (!pending.uncertain || error.details.phase !== "bridge_before_core");
          set({ workspaceError: error.message, workspaceRequest: rejected ? null : { ...pending, uncertain: true } });
        } throw error; }
        finally { if (!disposed && at === epoch) set({ workspaceOpening: false }); }
      };
      const goalOperationsForSelection = () => [...pendingGoalOperations.values()].filter(record => record.payload.targetId === state.targetId && record.conversationId === state.selected?.conversationId);
      const performGoalOperation = async record => {
        const at = epoch, targetId = state.targetId, selected = state.selected;
        if (record.payload.targetId !== targetId || record.conversationId !== selected?.conversationId || record.coreInstanceId && state.coreInstanceId && record.coreInstanceId !== state.coreInstanceId) throw new Error("原目标命令属于其他连接、服务实例或对话，不能在当前目标重放");
        if (state.goalBusy) return null;
        persist(true);
        set({ goalBusy: true, goalError: "", goalNotice: "" });
        try {
          await requireGoalSupport();
          const receipt = await call(record.action, structuredClone(record.payload));
          pendingGoalOperations.delete(record.payload.requestId); persist();
          if (disposed || at !== epoch) return receipt;
          set({ goalNotice: `目标命令已接收（${receipt.state || "accepted"}）；以服务确认后的目标状态为准。` });
          await syncSelection();
          return receipt;
        } catch (error) {
          const rejected = ["INVALID_REQUEST", "NOT_SUPPORTED", "GOAL_REVISION_CONFLICT", "GOAL_STATE_CONFLICT", "GOAL_BUDGET_EXHAUSTED", "GOAL_BUDGET_UNCERTAIN", "GOAL_NOT_FOUND"].includes(error.code);
          const canRelease = rejected && !record.uncertain;
          if (canRelease) pendingGoalOperations.delete(record.payload.requestId);
          else record.uncertain = true;
          persist();
          if (!disposed && at === epoch) set({ goalError: error.message, goalNotice: canRelease ? "服务已拒绝命令，请刷新目标后重新操作。" : "原目标命令已保留。重试会发送相同目标、修订和 requestId。" });
          throw error;
        } finally { if (!disposed && at === epoch) set({ goalBusy: false }); }
      };
      const controlGoal = async (operation, fields = {}, intent = fields) => {
        const goal = state.goal ? structuredClone(state.goal) : null, selected = state.selected, targetId = state.targetId, coreInstanceId = state.coreInstanceId;
        if (!goal || !selected) throw new Error("当前对话没有目标；使用 /goal 目标 --budget 数量 创建");
        await requireGoalSupport();
        if (coreInstanceId && state.coreInstanceId && coreInstanceId !== state.coreInstanceId) throw new Error("Core 实例已变化，请重新确认目标操作");
        const action = `goal.${operation}`;
        const pending = goalOperationsForSelection().find(record => record.action === action);
        if (pending && (pending.payload.goalId !== goal.goalId || JSON.stringify(pending.intent || pending.fields) !== JSON.stringify(intent))) throw new Error("原目标命令尚未确认，请先重试原操作；不能把原命令发送给新目标或新参数");
        const record = pending || { action, fields: structuredClone(fields), intent: structuredClone(intent), conversationId: selected.conversationId, coreInstanceId: state.coreInstanceId,
          payload: { targetId, goalId: goal.goalId, expectedRevision: goal.revision, ...structuredClone(fields), requestId: requestId(action) } };
        if (!pending) { pendingGoalOperations.set(record.payload.requestId, record); persist(); }
        return performGoalOperation(record);
      };
      const increaseGoalBudget = async increase => {
        const amount = positiveGoalNumber(increase), goal = state.goal;
        const total = goal?.limits?.totalTokens;
        if (!Number.isSafeInteger(total) || !Number.isSafeInteger(total + amount)) throw new Error("目标预算未知或增加后超出安全整数范围");
        return controlGoal("update", { limits: { ...goal.limits, totalTokens: total + amount } }, { increase: amount });
      };
      const sendGoalCommand = async command => {
        const original = state.draft, at = epoch;
        if (command.operation === "steer" && !command.text?.trim()) throw new Error("请提供目标补充内容");
        if (state.materials.length || state.attachments.length || state.selectedSkillIds.length || state.fileSelection) throw new Error("目标控制和补充只发送文字。请先发送或保留所选附件、Skill 和文件输入");
        let result;
        if (command.operation === "status") { await requireGoalSupport(); await syncSelection(); set({ goalNotice: state.goal ? "目标状态已刷新" : "当前对话没有目标；使用 /goal 目标 --budget 数量 创建" }); result = state.goal; }
        else if (command.operation === "budget") result = await increaseGoalBudget(command.increase);
        else if (command.operation === "update") result = await controlGoal("update", { objective: command.objective });
        else if (command.operation === "steer") result = await controlGoal("steer", { text: command.text });
        else result = await controlGoal(command.operation);
        if (at === epoch && state.draft === original) set({ draft: "" });
        return result;
      };
      const send = async () => {
        if (state.busy || state.goalBusy) return;
        let goalCommand;
        try {
          goalCommand = parseGoalCommand(state.draft);
          if (goalCommand?.kind === "goal" && goalCommand.operation !== "create") return await sendGoalCommand(goalCommand);
          if (!goalCommand && state.goalInputMode === "steer") return await sendGoalCommand({ operation: "steer", text: state.draft });
        } catch (error) { set({ goalError: error.message, error: error.message }); return null; }
        if (!state.draft.trim() && !state.materials.length && !state.attachments.length) { if (state.selectedSkillIds.length) set({ error: "请补充任务描述；仅选择 Skill 不能发送" }); return; }
        if (state.thread?.deletedAt != null) { set({ error: "会话已删除，无法恢复。请新建会话。" }); return; }
        if (state.attachments.some(item => item.status !== "ready")) { set({ error: "请先重试或移除尚未准备好的附件，正文与其他附件已保留" }); return; }
        if (state.attachmentRemovals.length) { set({ error: "附件移除结果待确认，请先查询原操作；草稿已保留" }); return; }
        if (state.attachments.some(item => item.coreInstanceId && state.coreInstanceId && item.coreInstanceId !== state.coreInstanceId)) { set({ error: "Core 实例已变化，请重新选择附件；原草稿已保留" }); return; }
        const text = goalCommand?.objective || goalCommand?.text || state.draft, root = state.root, modelId = state.modelId, thinkingLevel = state.thinkingLevel, fileSelection = state.fileSelection, targetId = state.targetId,
          materials = structuredClone([...(state.materials || []), ...state.attachments.filter(item => item.material).map(item => item.material)]), preparedAttachments = structuredClone(state.attachments.filter(item => item.ref).map(item => item.ref)), selectedSkillIds = [...(state.selectedSkillIds || [])];
        const delivery = goalCommand?.operation === "create" || state.goal && !GOAL_TERMINAL.has(state.goal.status) ? "new_run" : state.delivery || "new_run";
        let requiresPreview = preparedAttachments.length > 0 || state.attachmentCapabilities?.inputPreview === true && selectedSkillIds.length > 0;
        const originKey = composerKey();
        let selected = state.selected, at = epoch;
        set({ busy: true, error: "" });
        try {
          if (goalCommand?.operation === "create") await requireGoalSupport();
          if (materials.length || preparedAttachments.length || selectedSkillIds.length) {
            const capabilities = await loadAttachmentCapabilities();
            if (capabilities.supported === false) throw new Error(capabilities.reason || "当前运行时暂不支持附件与 Skill，请切换到 TypeScript/Pi 服务");
            if (!pendingInputs.has(selected?.conversationId)) await validateSelectedSkills(capabilities);
            requiresPreview ||= capabilities.inputPreview === true && selectedSkillIds.length > 0;
          }
          if (delivery === "next_turn" && selectedSkillIds.length) throw new Error("补充当前任务不能更换显式 Skill；草稿已保留，请改为排队新任务");
          if (delivery === "next_turn" && fileSelection) throw new Error("补充当前任务沿用原文件输入；草稿已保留，请改为排队新任务以选择文件");
          let plan = state.inputPreview;
          if (requiresPreview && !pendingInputs.has(selected?.conversationId)) {
            if (!plan || plan.inputSignature !== composerSignature()) plan = await previewInput();
            if (plan.canSend === false || plan.issues?.some(issue => issue.blocking !== false)) throw new Error(plan.issues?.[0]?.message || plan.issues?.[0] || "上下文预检未通过，请修正后再发送");
          }
          if (!selected) {
            if (!modelId) throw new Error("请先选择可用模型；工作区可以稍后添加");
            const workspace = fileSelection?.workspaceId ? { workspaceId: fileSelection.workspaceId } : root ? await call("workspace.register", { targetId, root, requestId: requestId("workspace.register") }) : null;
            if (disposed || at !== epoch) return;
            const signature = JSON.stringify([root, modelId, state.modelSource, thinkingLevel, state.permissionMode, fileSelection]);
            if (createAttempt && createAttempt.targetId !== targetId) throw new Error("原创建命令属于其他连接目标，不能在当前目标重放");
            if (createAttempt?.signature !== signature) createAttempt = { signature, targetId, stage: "create", id: requestId("thread.create") };
            const created = await call("thread.create", { targetId, requestId: createAttempt.id, agentId: "super-agent", ...(state.modelSource === "service_default" ? {} : { modelId }), ...(thinkingLevel === null ? {} : { thinkingLevel }), ...(state.permissionMode && state.permissionMode !== "service_default" ? { permissionMode: state.permissionMode } : {}), ...(root ? { cwd: root, workspaceId: workspace.workspaceId } : {}) });
            if (disposed || at !== epoch) return;
            selected = { threadId: created.threadId, conversationId: created.mainConversationId };
            epoch++; at = epoch; set({ selected }); createAttempt = null;
          }
          const key = selected.conversationId;
          let attempt = pendingInputs.get(key);
          const activeIds = new Set(Array.isArray(state.thread?.activeRuns) ? state.thread.activeRuns : []);
          const knownRuns = new Map((state.runDetails || []).filter(run => run && run.conversationId === selected.conversationId).map(run => [run.runId, run]));
          const candidates = delivery === "next_turn"
            ? (await Promise.all([...activeIds].map(async runId => {
                if (knownRuns.has(runId)) return knownRuns.get(runId);
                try {
                  const run = await call("run.get", { runId });
                  return run?.conversationId === selected.conversationId ? run : null;
                } catch { return null; }
              }))).filter(Boolean)
            : [];
          if (delivery === "next_turn" && candidates.length === 0) throw new Error("当前对话没有可补充的运行中任务，请改为排队新任务");
          const chosenTarget = state.targetRunId && candidates.some(run => run.runId === state.targetRunId) ? state.targetRunId : candidates.length === 1 ? candidates[0].runId : null;
          if (delivery === "next_turn" && !chosenTarget) throw new Error("当前对话有多个运行中任务，请先选择补充目标");
          const frozenSkillRefs = selectedSkillRefs();
          const signature = JSON.stringify([text, materials, selectedSkillIds, fileSelection, delivery, chosenTarget || null, ...(goalCommand?.operation === "create" ? [goalCommand.limits] : []), ...(preparedAttachments.length ? [preparedAttachments] : []), ...(frozenSkillRefs.length ? [frozenSkillRefs] : [])]);
          if (attempt?.targetId !== undefined && attempt.targetId !== targetId) throw new Error("原输入回执属于其他连接目标，不能在当前目标重放");
          if (attempt && (attempt.text !== text || attempt.signature !== signature || attempt.payload?.conversationId !== selected.conversationId)) throw new Error("原输入回执尚未确认，请恢复原命令后重试；当前草稿不会被当成原命令发送");
          if (!attempt) {
            const refs = selectedSkillRefs();
            attempt = { targetId, stage: "submit", text, signature, action: goalCommand?.operation === "create" ? "goal.create" : "input.submit", requestId: requestId(goalCommand?.operation === "create" ? "goal.create" : "input.submit"), payload: { ...selected, ...(goalCommand?.operation === "create" ? { objective: text, limits: goalCommand.limits, resumePolicy: "manual_after_restart" } : { text }), ...(materials.length ? { materials } : {}), ...(preparedAttachments.length ? { preparedAttachments } : {}), ...(requiresPreview ? { previewId: plan.planId, previewSignature: plan.signature } : {}), ...(selectedSkillIds.length ? refs.length === selectedSkillIds.length ? { selectedSkillRefs: refs } : { selectedSkillIds } : {}), delivery, ...(chosenTarget ? { targetRunId: chosenTarget } : fileSelection?.branchId ? { fileBranchId: fileSelection.branchId } : fileSelection ? { fileInput: { mode: "fixed_snapshot", snapshotId: fileSelection.snapshotId } } : {}) } };
            pendingInputs.set(key, attempt); persist(attempt.action === "goal.create");
          }
          const receipt = await call(attempt.action === "goal.create" ? "goal.create" : "input.submit", { ...attempt.payload, targetId: attempt.targetId ?? targetId, requestId: attempt.requestId });
          if (disposed || at !== epoch) return;
          if (attempt.action === "goal.create") set({ goalNotice: "目标已接收；执行与完成以服务状态为准。" });
          pendingInputs.delete(key); drafts.delete(key); drafts.delete("new"); materialDrafts.delete(key); materialDrafts.delete("new");
          composerDrafts.delete(originKey); composerDrafts.delete(key);
          for (const item of state.attachments) if (item.thumbnailUrl) globalThis.URL?.revokeObjectURL?.(item.thumbnailUrl);
          set({ draft: "", materials: [], attachments: [], attachmentRemovals: [], attachmentDraftId: null, selectedSkillIds: [], selectedSkills: [], inputPreview: null, fileSelection: null, targetRunId: null, titles: { ...state.titles, [key]: state.titles[key] || text.slice(0, 32) || "附件对话" } });
          await refresh();
          return receipt;
        } catch (error) {
          const previewRejected = error.details?.reason === "INPUT_PREVIEW_STALE" && error.details.operationAccepted === false && error.details.phase === "input_preflight";
          if (previewRejected && selected?.conversationId) pendingInputs.delete(selected.conversationId);
          if (at === epoch) set(previewRejected ? { inputPreview: null, previewError: "上下文已变化，请重新检查本次上下文后发送。正文、附件与 Skill 已保留。", error: "本次输入尚未接收。请重新检查本次上下文后发送。" } : { error: error.message });
          return null;
        }
        finally { if (at === epoch) set({ busy: false }); }
      };
      const receiveLive = async frame => {
        const selected = state.selected, at = epoch;
        if (disposed || !selected || frame.threadId !== selected.threadId) return;
        if (!runLookups.has(frame.runId)) {
          const lookup = call("run.get", { runId: frame.runId }).catch(error => { runLookups.delete(frame.runId); throw error; });
          runLookups.set(frame.runId, lookup);
        }
        const run = await runLookups.get(frame.runId);
        if (disposed || at !== epoch || run.conversationId !== selected.conversationId || terminalRunIds.has(frame.runId) || ["completed", "failed", "cancelled"].includes(run.status)) return;
        const cursor = liveCursors.get(frame.messageId);
        if (cursor && frame.attempt < cursor.attempt) return;
        if (frame.type === "stream.reset") {
          liveCursors.set(frame.messageId, { attempt: frame.attempt, index: -1 });
          set({ live: state.live.filter(m => m.generationKey !== frame.messageId) }); return;
        }
        if (!["stream.text_delta", "stream.thinking_delta", "stream.tool_call_delta"].includes(frame.type)) return;
        if (state.messages.some(m => m.generationKey === frame.messageId)) return;
        if (cursor && frame.attempt === cursor.attempt && frame.index <= cursor.index) return;
        liveCursors.set(frame.messageId, { attempt: frame.attempt, index: frame.index });
        const key = `${frame.messageId}:${frame.attempt}:${frame.type}:${frame.toolCallId || ""}`;
        if (state.live.some(m => m.generationKey === frame.messageId && m.attempt > frame.attempt)) return;
        const live = state.live.filter(m => m.generationKey !== frame.messageId || m.attempt >= frame.attempt);
        const existing = live.findIndex(m => m.messageId === key);
        const segment = { messageId: key, generationKey: frame.messageId, runId: frame.runId, attempt: frame.attempt,
          role: "assistant", kind: frame.type === "stream.thinking_delta" ? "thinking" : frame.type === "stream.tool_call_delta" ? "tool_call" : "assistant",
          ...(frame.type === "stream.tool_call_delta" ? { toolCall: { callId: frame.toolCallId || null, name: frame.toolName || "工具调用", arguments: (existing < 0 ? "" : live[existing].toolCall?.arguments || "") + frame.delta }, text: "" } : { text: (existing < 0 ? "" : live[existing].text) + frame.delta }) };
        if (existing < 0) live.push(segment); else live[existing] = segment;
        set({ live });
      };
      const receiveEvent = event => {
        if (event?.type?.startsWith("goal.") && Number.isSafeInteger(event.seq)) {
          if (event.seq <= state.goalEventSeq) return;
          set({ goalEventSeq: event.seq });
        }
        if (refreshing) refreshAfterCurrent = true;
        void refresh();
      };
      const connectEvents = () => {
        if (disposed || source) return;
        if (transport.subscribe) {
          const stop = transport.subscribe({ onEvent: receiveEvent, onLive: frame => void receiveLive(frame).catch(() => {}), onError: () => { set({ live: [] }); void refresh(); } });
          source = { close: stop }; return;
        }
        if (!EventSourceImpl) return;
        source = new EventSourceImpl("/super-agent/events");
        source.addEventListener("message", event => { try { receiveEvent(JSON.parse(event.data)); } catch { receiveEvent(null); } });
        source.addEventListener("live", event => { try { void receiveLive(JSON.parse(event.data)).catch(() => {}); } catch {} });
        source.addEventListener("error", () => { set({ live: [] }); void refresh(); });
      };
      const controller = {
        getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        getThread: threadId => call("thread.get", { threadId }),
        refresh, selectThread, newConversation, registerWorkspace, browseManagedWorkspace, openManagedWorkspace, send, receiveLive,
        loadAttachmentCapabilities, previewInput, receiveEvent,
        controlGoal, increaseGoalBudget,
        updateGoalObjective: objective => { if (!objective?.trim()) throw new Error("请提供新的目标说明"); return controlGoal("update", { objective: objective.trim() }); },
        retryGoalOperation: id => { const record = pendingGoalOperations.get(id); if (!record) throw new Error("原目标命令不存在"); return performGoalOperation(record); },
        pendingGoalOperations: goalOperationsForSelection,
        setGoalInputMode: mode => { if (!["message", "steer"].includes(mode)) throw new Error("输入用途无效"); set({ goalInputMode: mode, delivery: "new_run" }); },
        async addMessageFiles(files) {
          const selected = Array.from(files || []); if (!selected.length) return [];
          const origin = originOfComposer(), capabilities = await loadAttachmentCapabilities();
          if (origin.targetId !== state.targetId || origin.key !== composerKey()) throw new Error("目标已变化，请在原会话重新选择附件");
          const maxItems = capabilities.limits?.maxAttachments || 10, maxTotal = capabilities.limits?.maxTotalBytes || 20 * 1048576;
          if (selected.length + state.attachments.length + state.materials.length > maxItems) throw new Error(`一次最多添加 ${maxItems} 个附件`);
          if (selected.reduce((sum, file) => sum + file.size, state.attachments.reduce((sum, item) => sum + item.size, 0)) > maxTotal) throw new Error(`附件总量超过 ${Math.floor(maxTotal / 1048576)} MiB`);
          const cards = selected.map(file => ({ id: requestId("attachment.card"), requestId: requestId("attachment.prepare"), name: file.name, size: file.size, status: "preparing", targetId: origin.targetId, root: origin.root, coreInstanceId: origin.coreInstanceId }));
          updateComposer(origin, record => ({ ...record, attachments: [...record.attachments, ...cards] }));
          for (let index = 0; index < cards.length; index++) await uploadAttachment(origin, cards[index], selected[index], capabilities);
          return cards;
        },
        async retryAttachment(id, replacement) {
          const card = state.attachments.find(item => item.id === id); if (!card) throw new Error("附件已不在当前草稿中");
          if (card.attachmentId) {
            const origin = originOfComposer(); updateAttachment(origin, id, { status: "parsing", error: "" });
            try { const item = await call("attachments.get", { targetId: origin.targetId, attachmentId: card.attachmentId }); await awaitPrepared(origin, card, item); }
            catch (error) { updateAttachment(origin, id, { status: "failed", error: error.message }); }
            return { needsFile: false };
          }
          if (card.projectPath) {
            const origin = originOfComposer(); updateAttachment(origin, id, { status: "parsing", error: "" });
            try { const item = await call("attachments.prepare", { targetId: origin.targetId, requestId: card.requestId, draftId: card.draftId, name: card.name.split("/").at(-1), projectPath: card.projectPath }); await awaitPrepared(origin, card, item); }
            catch (error) { updateAttachment(origin, id, { status: "failed", error: error.message }); }
            return { needsFile: false };
          }
          const file = replacement || attachmentFiles.get(`${state.targetId || "uds"}:${id}`);
          if (!file) { set({ attachmentNotice: "请重新选择同一文件；系统会校验内容是否一致" }); return { needsFile: true }; }
          if (file.name !== card.name) throw new Error("请选择原文件；新增文件请从加号添加");
          const capabilities = await loadAttachmentCapabilities();
          await uploadAttachment(originOfComposer(), card, file, capabilities); return { needsFile: false };
        },
        async removeAttachment(id) {
          const origin = originOfComposer(), card = state.attachments.find(item => item.id === id);
          if (!card) return;
          const job = attachmentJobs.get(`${origin.targetId || "uds"}:${id}`); if (job) job.cancelled = true;
          const removal = card.attachmentId ? { attachmentId: card.attachmentId, draftId: card.draftId, requestId: `${card.requestId || card.id}:remove` } : null;
          updateComposer(origin, record => ({ ...record, attachments: record.attachments.filter(item => item.id !== id), attachmentRemovals: [...(record.attachmentRemovals || []), ...(removal ? [removal] : [])] }));
          if (card.thumbnailUrl) globalThis.URL?.revokeObjectURL?.(card.thumbnailUrl);
          attachmentFiles.delete(`${origin.targetId || "uds"}:${id}`);
          const operationId = card.operationId || job?.operationId;
          if (operationId && card.status !== "ready") {
            try { await call(card.attachmentId ? "attachments.cancel" : "files.transfer.cancel", { targetId: origin.targetId, operationId, requestId: `${card.requestId}:cancel` }); }
            catch { if (origin.targetId === state.targetId && origin.key === composerKey()) set({ attachmentNotice: "附件已从草稿移除；后台取消结果待确认，不会附加到新输入" }); }
          }
          if (removal) {
            try { await call("attachments.remove", { targetId: origin.targetId, ...removal }); updateComposer(origin, record => ({ ...record, attachmentRemovals: record.attachmentRemovals.filter(item => item.requestId !== removal.requestId) })); }
            catch { if (origin.targetId === state.targetId && origin.key === composerKey()) set({ attachmentNotice: "附件已移出草稿；服务移除结果待确认，请查询原操作后发送。" }); }
          }
        },
        async resolveAttachmentRemovals() {
          const origin = originOfComposer();
          for (const removal of state.attachmentRemovals) {
            await call("attachments.remove", { targetId: origin.targetId, ...removal });
            updateComposer(origin, record => ({ ...record, attachmentRemovals: (record.attachmentRemovals || []).filter(item => item.requestId !== removal.requestId) }));
          }
          if (origin.targetId === state.targetId && origin.key === composerKey()) set({ attachmentNotice: "附件移除结果已确认" });
        },
        async attachmentPreview(id) {
          const card = state.attachments.find(item => item.id === id); if (!card) throw new Error("附件不属于当前草稿");
          const targetId = state.targetId, file = attachmentFiles.get(`${targetId || "uds"}:${id}`);
          if (file) {
            if (card.kind === "image") return { name: card.name, imageUrl: card.thumbnailUrl || `data:${card.mediaType};base64,${bytesBase64(new Uint8Array(await file.arrayBuffer()))}` };
            if (card.kind !== "document") return { name: card.name, text: new TextDecoder().decode(await file.arrayBuffer()) };
          }
          if (card.attachmentId) {
            const representation = card.representations?.find(item => item.representationId === card.ref?.representationId) || card.representations?.find(item => item.status === "available" && item.format === (card.ref?.format || (card.kind === "image" ? "image" : "text")));
            if (!representation) throw new Error("所选格式不可预览，请在本次上下文中选择有效格式");
            return call("attachments.read", { targetId, attachmentId: card.attachmentId, representationId: representation.representationId, format: representation.format, ...(card.ref?.range ? { range: card.ref.range } : {}) });
          }
          if (!card.material) throw new Error("文件尚未准备好，请稍后预览");
          const result = await call("files.read", { targetId, snapshotId: card.material.snapshotId, path: card.material.path });
          return card.kind === "image" ? { name: card.name, imageUrl: `data:${card.mediaType};base64,${result.dataBase64}` } : { name: card.name, text: decodeUtf8(result.dataBase64) };
        },
        async updateAttachmentMode(id, values) {
          const card = state.attachments.find(item => item.id === id);
          if (!card?.ref) throw new Error("当前服务仅支持图片和 UTF-8 全文，不能切换按需读取");
          if (!["inline", "range", "on_demand", "image"].includes(values.mode)) throw new Error("不支持的附件上下文模式");
          updateAttachment(originOfComposer(), id, { ref: { ...card.ref, ...values }, mode: values.mode });
          return previewInput();
        },
        async loadSkillCatalog() {
          const origin = originOfComposer();
          try {
            const capabilities = await loadAttachmentCapabilities();
            if (capabilities.supported === false) throw new Error(capabilities.reason || "当前运行时暂不支持 Skill，请切换到 TypeScript/Pi 服务");
            const workspace = origin.root ? await call("workspace.find", { targetId: origin.targetId, root: origin.root }) : null;
            const catalog = await call("skills.catalog", { targetId: origin.targetId, ...(origin.conversationId ? { conversationId: origin.conversationId } : {}), ...(workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : {}) });
            if (!Array.isArray(catalog?.items)) throw new Error("当前服务尚未提供只读 Skill 目录，请更新服务；会话不会执行磁盘扫描");
            const items = catalog.items.map(skill => ({ ...skill, sourceId: skill.sourceId || skill.primarySourceId || skill.sourceIds?.[0], scope: skill.scope || (skill.workspaceId ? "workspace" : "global"), reason: skill.reason || skill.diagnostic }));
            if (origin.targetId === state.targetId && origin.key === composerKey()) set({ skillCatalog: items, skillCatalogError: "" });
            return items;
          } catch (error) { if (origin.targetId === state.targetId && origin.key === composerKey()) set({ skillCatalogError: error.message }); throw error; }
        },
        async historyMaterialDetails(message, material, { preview = false, range } = {}) {
          if (!state.selected || message.conversationId && message.conversationId !== state.selected.conversationId) throw new Error("材料不属于当前对话，请回到原消息查看");
          const targetId = state.targetId, conversationId = state.selected.conversationId, result = { material, evidence: null, evidenceError: "" };
          if (material.attachmentId) {
            const [metadata, evidence] = await Promise.allSettled([
              call("attachments.get", { targetId, attachmentId: material.attachmentId }),
              call("attachments.evidence", { targetId, attachmentId: material.attachmentId, conversationId, ...(message.runId ? { runId: message.runId } : {}) }),
            ]);
            if (metadata.status === "fulfilled") result.metadata = metadata.value.item || metadata.value;
            else result.contentError = metadata.reason.message;
            if (evidence.status === "fulfilled" && (Array.isArray(evidence.value) || Array.isArray(evidence.value?.items))) result.evidence = (evidence.value.items || evidence.value).filter(item => (!item.conversationId || item.conversationId === conversationId) && (!message.runId || !item.runId || item.runId === message.runId));
            else result.evidenceError = evidence.status === "rejected" ? evidence.reason.message : "当前服务没有返回读取证据，不能推断已读或未读";
            if (preview && material.representationId) {
              try { result.preview = await call("attachments.read", { targetId, attachmentId: material.attachmentId, representationId: material.representationId, ...(material.format ? { format: material.format } : {}), ...(range || material.range ? { range: range || material.range } : {}) }); }
              catch (error) { result.contentError = error.message; }
            }
          } else if (preview) {
            try {
              const data = await call("files.read", { targetId, snapshotId: material.snapshotId, path: material.path });
              result.preview = material.kind === "image" ? { imageUrl: `data:${material.mediaType};base64,${data.dataBase64}` } : { text: decodeUtf8(data.dataBase64) };
            } catch (error) { result.contentError = error.message; }
          }
          if (targetId !== state.targetId || conversationId !== state.selected?.conversationId) throw new Error("目标或对话已切换，请重新查看原消息");
          return result;
        },
        selectSkill(skill, selected) {
          const id = skill.skillId;
          if (selected && state.attachmentCapabilities?.supported === false) throw new Error(state.attachmentCapabilities.reason || "当前运行时暂不支持 Skill，请切换到 TypeScript/Pi 服务");
          if (!id || selected && skill.status !== "available" && skill.status !== "enabled") throw new Error("此 Skill 当前不可用");
          set({ selectedSkillIds: selected ? [...new Set([...state.selectedSkillIds, id])] : state.selectedSkillIds.filter(value => value !== id), selectedSkills: selected ? [...state.selectedSkills.filter(item => item.skillId !== id), skill] : state.selectedSkills.filter(item => item.skillId !== id) });
        },
        async addProjectFile(snapshot, file) {
          if (!file?.path) throw new Error("请选择可读取的项目文件");
          if (file.projectPath === true) {
            const origin = originOfComposer(), capabilities = await loadAttachmentCapabilities();
            if (!capabilities.projectFiles || capabilities.supported === false) throw new Error("当前服务未提供项目文件准备能力，请更新服务或添加本机文件");
            const cardId = requestId("attachment.project"), draftId = await ensureAttachmentDraft(origin, cardId);
            const card = { id: cardId, requestId: cardId, name: file.path, projectPath: file.path, size: file.size || 0, status: "preparing", targetId: origin.targetId, root: origin.root, coreInstanceId: origin.coreInstanceId, draftId };
            updateComposer(origin, record => ({ ...record, attachments: [...record.attachments, card] }));
            try {
              const job = { requestId: cardId, running: true, modern: true, cancelled: false }; attachmentJobs.set(`${origin.targetId || "uds"}:${cardId}`, job);
              const result = await call("attachments.prepare", { targetId: origin.targetId, requestId: cardId, draftId, name: file.path.split("/").at(-1), projectPath: file.path });
              const item = await awaitPrepared(origin, card, result, job); job.running = false;
              if (item && !job.cancelled) updateAttachment(origin, card.id, { size: item.size, sha256: item.contentHash });
              return item;
            } catch (error) { updateAttachment(origin, card.id, { status: "failed", error: error.message }); throw error; }
          }
          if (!snapshot?.snapshotId) throw new Error("当前项目没有可用版本，请使用项目文件准备能力");
          const origin = originOfComposer(), result = await call("files.read", { targetId: origin.targetId, snapshotId: snapshot.snapshotId, path: file.path });
          if (origin.targetId !== state.targetId || origin.key !== composerKey()) throw new Error("对话或目标已切换，请重新引用");
          const binary = atob(result.dataBase64), bytes = Uint8Array.from(binary, value => value.charCodeAt(0)), type = identifyAttachment(bytes, file.path);
          if (type.kind === "document") throw new Error("请通过添加图片或文件准备该文档；当前项目引用通路仅支持图片与 UTF-8 文本");
          const card = { id: requestId("attachment.reference"), name: file.path, size: file.size || bytes.length, sha256: file.hash || await digestBytes(bytes), status: "ready", ...type, mode: type.kind === "image" ? "image" : "inline", targetId: origin.targetId, root: origin.root, coreInstanceId: origin.coreInstanceId,
            material: { kind: type.kind === "image" ? "image" : "reference", snapshotId: snapshot.snapshotId, path: file.path, source: snapshot.source?.location || origin.root, ...(type.kind === "image" ? { mediaType: type.mediaType } : {}) } };
          if (state.attachments.some(item => item.sha256 === card.sha256)) { set({ attachmentNotice: "相同内容已添加" }); return; }
          updateComposer(origin, record => ({ ...record, attachments: [...record.attachments, card] })); return card;
        },
        async convertSelectionToAttachment(start, end) {
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > state.draft.length) throw new Error("请先选择要作为资料的正文范围，保留任务要求");
          const origin = originOfComposer(), text = state.draft, contents = text.slice(start, end);
          const cards = await controller.addMessageFiles([new File([contents], "选中资料.txt", { type: "text/plain" })]);
          if (origin.targetId !== state.targetId || origin.key !== composerKey() || state.draft !== text) return;
          if (!cards.length || !state.attachments.some(item => item.id === cards[0].id && item.status === "ready")) throw new Error("资料未完整保存，原正文已保留");
          set({ draft: text.slice(0, start) + text.slice(end) });
        },
        useFileSnapshot(snapshot, root) {
          if (!snapshot?.snapshotId || !snapshot?.workspaceId || !root?.startsWith("/")) throw new Error("请提供可用文件版本、所属工作区和执行端项目逻辑根");
          if (!state.selected) newConversation(root);
          else if (state.root !== root) throw new Error("所选版本的项目逻辑根与当前对话不同，请新建对话验证");
          set({ fileSelection: { snapshotId: snapshot.snapshotId, workspaceId: snapshot.workspaceId, root, createdAt: snapshot.createdAt, rootHash: snapshot.rootHash }, delivery: "new_run" });
          ctx.layout.selectPanel(SPACE_ID);
        },
        async useCurrentFileBranch(branchId, expectedRevision) {
          if (!state.selected) throw new Error("请先选择要继续的对话");
          const at = epoch, selected = state.selected, targetId = state.targetId;
          const branch = await call("files.branch.get", { branchId, targetId });
          if (branch.conversationId !== selected.conversationId) throw new Error("文件分支不属于当前对话");
          if (branch.revision !== expectedRevision) throw new Error("当前分支已更新，请重新读取文件版本后再选择");
          const snapshot = await call("files.snapshot", { snapshotId: branch.currentSnapshotId, targetId });
          if (at !== epoch || state.selected?.conversationId !== selected.conversationId) throw new Error("连接或对话已切换，请重新选择当前分支");
          set({ fileSelection: { branchId: branch.branchId, snapshotId: snapshot.snapshotId, workspaceId: branch.workspaceId, root: state.root, createdAt: snapshot.createdAt, rootHash: snapshot.rootHash }, delivery: "new_run" });
          ctx.layout.selectPanel(SPACE_ID); return branch;
        },
        setDiffWidth(width) {
          if (!Number.isFinite(width)) throw new Error("审阅宽度必须是有效数字");
          set({ diffWidth: Math.max(360, Math.min(960, Math.round(width))) });
        },
        async listDiffRuns() {
          if (!state.selected) throw new Error("请先选择对话");
          const at = epoch, selected = state.selected, targetId = state.targetId;
          const tasks = state.runDetails.filter(task => task.conversationId === selected.conversationId);
          const order = state.thread?.runs?.filter(task => task.conversationId === selected.conversationId).map(task => task.runId);
          const result = await Promise.all(tasks.map(async (task, index) => {
            if (task.status !== "completed" || !task.fileBinding) return null;
            const round = order ? (order.indexOf(task.runId) + 1 || null) : index + 1;
            try {
              const artifacts = await call("files.artifacts", { runId: task.runId, targetId });
              if (artifacts?.run?.runId !== task.runId || !Array.isArray(artifacts.files)) throw new Error("任务文件结果结构无效");
              return artifacts.files.length ? { runId: task.runId, round, fileCount: artifacts.files.length } : null;
            } catch {
              return { runId: task.runId, round, fileCount: null, error: "变更信息读取失败" };
            }
          }));
          if (disposed || at !== epoch || state.selected?.conversationId !== selected.conversationId || targetId !== state.targetId) throw new Error("对话已切换，请重新查看文件变更");
          return result.filter(Boolean);
        },
        async openLatestDiff() {
          const items = await controller.listDiffRuns(), latest = items.filter(item => item.fileCount > 0).at(-1);
          if (!latest) throw new Error(items.some(item => item.error) ? "变更信息读取失败，请重试" : "当前对话暂无文件变更");
          return controller.openDiff(latest.runId);
        },
        async openDiff(runId, filePath = null) {
          if (!state.selected) throw new Error("请先选择对话");
          const at = epoch, selected = state.selected;
          let task = (state.runDetails || []).find(run => run.runId === runId && run.conversationId === selected.conversationId);
          if (!task) {
            task = await call("run.get", { runId });
            if (task?.conversationId !== selected.conversationId) throw new Error("文件改动不属于当前对话");
            if (at !== epoch || state.selected?.conversationId !== selected.conversationId) throw new Error("对话已切换，请重新查看文件改动");
            set({ runDetails: [...(state.runDetails || []).filter(run => run.runId !== runId), task] });
          }
          set({ diffSelection: { runId, filePath: typeof filePath === "string" ? filePath : null } });
          return task;
        },
        async loadBranches() {
          if (!state.selected) throw new Error("请先选择对话");
          if (!services.observations?.graph) throw new Error("当前连接没有分支查询能力");
          const at = epoch, selected = state.selected;
          set({ branchLoading: true, branchError: "" });
          try {
            const graph = await services.observations.graph(selected.threadId);
            if (disposed || at !== epoch || state.selected?.conversationId !== selected.conversationId) return [];
            const forkEdges = new Map((graph?.edges || []).filter(edge => edge.kind === "fork").map(edge => [edge.toId, edge.fromId]));
            const branches = (graph?.nodes || []).filter(node => node.kind === "conversation" && node.conversationId &&
              node.conversationId !== selected.conversationId && forkEdges.has(node.conversationId))
              .map(node => ({ conversationId: node.conversationId, forkedFromConversationId: forkEdges.get(node.conversationId) || null, startedAt: node.startedAt || null }));
            set({ branches, branchError: "", branchesLoaded: true, branchLoading: false });
            return branches;
          } catch (error) {
            if (at === epoch) set({ branchError: error.message, branchLoading: false });
            throw error;
          }
        },
        selectDiffFile(filePath) {
          if (!state.diffSelection) throw new Error("请先选择任务");
          set({ diffSelection: { ...state.diffSelection, filePath: typeof filePath === "string" ? filePath : null } });
        },
        closeDiff() { set({ diffSelection: null }); },
        async loadRunDiff(runId, { force = false } = {}) {
          if (!state.selected || !(state.runDetails || []).some(run => run.runId === runId && run.conversationId === state.selected.conversationId)) throw new Error("文件改动不属于当前对话");
          const at = epoch, targetId = state.targetId;
          const runFile = await call("files.run", { runId, targetId });
          const artifacts = await call("files.artifacts", { runId, targetId });
          if (artifacts?.run?.runId !== runId || !Array.isArray(artifacts.files)) throw new Error("任务文件结果结构无效");
          const branch = await call("files.branch.get", { branchId: artifacts.run.branchId, targetId });
          const currentSnapshot = await call("files.snapshot", { snapshotId: branch.currentSnapshotId, targetId });
          const cached = runDiffCache.get(runId);
          if (!force && cached && cached.runFile?.revision === runFile.revision &&
              cached.runFile?.resultSnapshotId === runFile.resultSnapshotId &&
              cached.branch?.revision === branch.revision &&
              cached.branch?.currentSnapshotId === branch.currentSnapshotId) return cached;
          const currentFiles = new Map((currentSnapshot?.manifest?.files || []).map(file => [file.path, file]));
          const read = async (snapshotId, path, file) => {
            if (!file) return { snapshotId, content: "", binary: false, error: null };
            try {
              const result = await call("files.read", { snapshotId, path, targetId });
              const content = decodeUtf8(result.dataBase64);
              return { snapshotId, content: content ?? "", binary: content === null, error: null };
            } catch (error) {
              return { snapshotId, content: "", binary: false, error: error.message, status: error.details?.status || (error.code === "NOT_FOUND" ? "expired" : "error") };
            }
          };
          const files = await Promise.all(artifacts.files.map(async artifact => {
            const [before, after] = await Promise.all([
              read(artifacts.inputSnapshot?.snapshotId, artifact.path, artifact.before),
              read(artifacts.resultSnapshot?.snapshotId, artifact.path, artifact.after),
            ]);
            const binary = before.binary || after.binary;
            const error = before.error || after.error;
            const diff = !binary && !error ? lineDiff(before.content, after.content) : null;
            return { ...artifact, before, after, binary, error, current: currentFiles.get(artifact.path) || null,
              status: error ? (before.status === "expired" || after.status === "expired" ? "expired" : "error") : binary ? "binary" : artifacts.run.status === "succeeded" ? "available" : "partial",
              additions: diff?.additions ?? null, deletions: diff?.deletions ?? null, rows: diff?.rows || [], limited: diff?.limited === true };
          }));
          if (disposed || at !== epoch || targetId !== state.targetId) throw new Error("连接或对话已切换，请重新读取文件改动");
          const result = { runId, runFile, branch, currentSnapshot, artifacts, files };
          runDiffCache.set(runId, result);
          return result;
        },
        async rollbackRun(runId) {
          if (!state.selected) throw new Error("请先选择对话");
          const at = epoch, selected = state.selected, targetId = state.targetId;
          const diff = await controller.loadRunDiff(runId, { force: true });
          if (!diff.files.length) throw new Error("该任务没有可回滚的文件改动");
          if (!Number.isSafeInteger(diff.branch.revision)) throw new Error("当前文件分支版本无效");
          const files = diff.files.map(file => ({ path: file.path, expectedCurrentHash: file.current?.hash ?? null }));
          const key = JSON.stringify([targetId, selected.conversationId, runId, diff.branch.revision, files]);
          let payload = pendingRollbacks.get(key);
          if (!payload) {
            payload = { runId, targetId, expectedRevision: diff.branch.revision, files, requestId: requestId("files.rollback") };
            pendingRollbacks.set(key, payload);
          }
          const result = await call("files.rollback", payload);
          pendingRollbacks.delete(key); runDiffCache.delete(runId);
          if (at !== epoch || state.selected?.conversationId !== selected.conversationId) throw new Error("回滚已提交，但对话已切换；请重新读取当前文件结果");
          await syncSelection();
          return result;
        },
        resource: (action, payload) => call(action, payload),
        async previewFileMerge({ branchId, baseSnapshotId, incomingSnapshotId }) {
          if (!state.selected) throw new Error("请先选择目标对话");
          const at = epoch, selected = state.selected, targetId = state.targetId;
          const branch = await call("files.branch.get", { branchId, targetId });
          if (branch.conversationId !== selected.conversationId) throw new Error("文件分支不属于当前对话");
          const preview = await call("files.branch.previewMerge", { branchId, baseSnapshotId, incomingSnapshotId, targetId, requestId: requestId("files.branch.previewMerge") });
          if (at !== epoch) throw new Error("连接或对话已切换，请在当前对话重新审阅合并");
          return preview;
        },
        async commitFileMerge(preview, resolutions) {
          if (!state.selected || !preview?.branchId) throw new Error("请先审阅目标分支的三方差异");
          if (preview.conflicts.some(path => !["current", "incoming"].includes(resolutions[path]))) throw new Error("每个冲突文件都须明确选择保留当前成果或采用新同步内容");
          const at = epoch, selected = state.selected, targetId = state.targetId;
          const branch = await call("files.branch.get", { branchId: preview.branchId, targetId });
          if (at !== epoch || branch.conversationId !== selected.conversationId) throw new Error("目标对话已变化，请保留草稿并重新审阅");
          const fields = { branchId: preview.branchId, expectedRevision: preview.expectedRevision, baseSnapshotId: preview.baseSnapshotId, incomingSnapshotId: preview.incomingSnapshotId, resolutions };
          const key = JSON.stringify([targetId, selected.conversationId, fields]), payload = pendingMerges.get(key) || { ...fields, targetId, requestId: requestId("files.branch.merge") };
          pendingMerges.set(key, payload);
          const result = await call("files.branch.merge", payload); pendingMerges.delete(key);
          if (at === epoch) await syncSelection().catch(error => set({ historyError: `合并已接收，刷新失败：${error.message}` })); return result;
        },
        async redoRun(runId, { acknowledgeExternalEffects = false } = {}) {
          if (!acknowledgeExternalEffects) throw new Error("请先确认：原输入重试会创建独立文件分支并重新发起业务动作");
          if (!state.selected) throw new Error("请先选择原任务所在对话");
          const at = epoch, selected = state.selected, targetId = state.targetId;
          const run = await call("run.get", { runId, targetId });
          if (at !== epoch) throw new Error("连接或对话已切换，请重新选择原任务");
          if (run.conversationId !== selected.conversationId || !["completed", "failed", "cancelled"].includes(run.status)) throw new Error("只能重试当前对话中已结束的原任务");
          const key = JSON.stringify([targetId, runId]), payload = pendingRedos.get(key) || { runId, mode: "fork", targetId, requestId: requestId("run.redo") };
          pendingRedos.set(key, payload);
          const result = await call("run.redo", payload); pendingRedos.delete(key);
          if (at === epoch) { await controller.selectThread(selected.threadId, result.conversationId).catch(error => set({ historyError: `独立重试已创建，刷新失败：${error.message}` })); set({ inspector: true }); ctx.layout.selectPanel(SPACE_ID); }
          return result;
        },
        async resolveWait(wait, values) {
          const belongs = state.selected && (wait.conversationId === state.selected.conversationId ||
            state.thread?.threadId === state.selected.threadId && state.thread.runs?.some(run => run.runId === wait.runId && run.conversationId === wait.conversationId));
          if (!belongs || wait.status !== "waiting") throw new Error("等待不属于当前 Thread 的已核实任务或已终态，请刷新");
          const at = epoch, targetId = state.targetId;
          const action = wait.kind === "file_input" ? "wait.provideFile" : wait.kind === "permission" ? "wait.resolve" : "wait.answer";
          const fields = wait.kind === "file_input" ? { snapshotId: values.snapshotId, sourcePath: values.sourcePath, conversationId: wait.conversationId, ...(values.mode ? { mode: values.mode } : {}) } : wait.kind === "permission" ? { decision: values.decision } : { answer: values.answer };
          const existing = pendingWaitActions.get(wait.waitId);
          if (existing && JSON.stringify(existing.fields) !== JSON.stringify(fields)) throw new Error("原操作回执尚未确认。请保持原内容重试，再刷新等待状态");
          const operation = existing || { fields, payload: { waitId: wait.waitId, ...fields, targetId, requestId: requestId(action) } };
          pendingWaitActions.set(wait.waitId, operation);
          try {
            const receipt = await call(action, operation.payload);
            pendingWaitActions.delete(wait.waitId);
            if (at === epoch) await syncSelection();
            return receipt;
          } catch (error) { if (["INVALID_REQUEST", "INVALID_STATE", "NOT_FOUND", "WAIT_ALREADY_RESOLVED"].includes(error.code)) pendingWaitActions.delete(wait.waitId); throw error; }
        },
        async renewApproval(wait) {
          if (!state.selected || !(wait.conversationId === state.selected.conversationId || state.thread?.threadId === state.selected.threadId && state.thread.runs?.some(run => run.runId === wait.runId && run.conversationId === wait.conversationId))) throw new Error("等待不属于当前 Thread 的已核实任务，请刷新");
          if (wait.kind !== "permission" || wait.status !== "waiting" || !wait.expiresAt || Date.parse(wait.expiresAt) > Date.now()) throw new Error("只有已过期的待审批动作可以重新核验");
          const key = `renew:${wait.waitId}`, at = epoch;
          let pending = pendingWaitActions.get(key);
          if (!pending) { pending = { payload: { waitId: wait.waitId, requestId: requestId("wait.renewApproval"), targetId: state.targetId } }; pendingWaitActions.set(key, pending); }
          const result = await call("wait.renewApproval", pending.payload); pendingWaitActions.delete(key);
          if (at === epoch) await syncSelection(); return result;
        },
        async verifyExecution(execution, values) {
          const belongs = state.selected && (execution.conversationId === state.selected.conversationId ||
            state.thread?.threadId === state.selected.threadId && state.thread.runs?.some(run => run.runId === execution.runId && run.conversationId === execution.conversationId));
          if (!belongs || execution.status !== "unknown") throw new Error("只能核验当前 Thread 已核实任务中结果未知的执行");
          if (!values.evidence?.trim()) throw new Error("请记录核验依据");
          const key = `verify:${execution.executionId}`, at = epoch, fields = { conclusion: values.conclusion, evidence: values.evidence };
          let pending = pendingWaitActions.get(key);
          if (pending && JSON.stringify(pending.fields) !== JSON.stringify(fields)) throw new Error("核验回执尚未确认，请保持原结论和依据重试");
          if (!pending) { pending = { fields, payload: { threadId: state.selected.threadId, executionId: execution.executionId, ...fields, requestId: requestId("execution.verify"), targetId: state.targetId } }; pendingWaitActions.set(key, pending); }
          const result = await call("execution.verify", pending.payload); pendingWaitActions.delete(key);
          if (at === epoch) await syncSelection(); return result;
        },
        setInspector: inspector => set({ inspector }),
        setWorkspaceForm: workspaceForm => { workspaceReadVersion++; workspaceBrowseAbort?.abort(); set({ workspaceForm, managedWorkspaceLocation: null, workspaceLoading: false, workspaceError: "" }); if (workspaceForm) ctx.layout.selectPanel(SPACE_ID); },
        reportError: error => set({ error: error?.message || String(error || "") }),
        setViewOptions(patch = {}) {
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("无效的空间视图选项");
          const next = { ...state.viewOptions };
          for (const key of ["grouping", "threadOrder", "archiveFilter"]) {
            if (patch[key] !== undefined) next[key] = patch[key];
          }
          if (!["group", "flat"].includes(next.grouping) || !["updated", "manual"].includes(next.threadOrder)
              || !["hide", "all", "only", "deleted"].includes(next.archiveFilter)) {
            throw new Error("无效的空间视图选项");
          }
          set({ viewOptions: next });
        },
        renameWorkspace(root, title) {
          const text = typeof title === "string" ? title.trim() : "";
          if (text && state.directories.some(d => d.root !== root && (d.title || d.root.split("/").filter(Boolean).pop()) === text)) {
            throw new Error(`已存在名为“${text}”的工作区。`);
          }
          const directories = state.directories.map(directory => {
            if (directory.root !== root) return directory;
            const renamed = { ...directory };
            if (text) renamed.title = text; else delete renamed.title;
            return renamed;
          });
          set({ directories });
        },
        async removeWorkspace(root) {
          if (typeof root !== "string" || !root.startsWith("/")) throw new Error("工作目录无效");
          const targetId = state.targetId, at = epoch;
          const related = state.threads.filter(thread => thread.conversation?.config?.cwd === root);
          const actual = await Promise.all(related.map(thread => call("thread.get", { threadId: thread.threadId, targetId })));
          if (at !== epoch || targetId !== state.targetId) throw new Error("目标已改变，请重新核对工作区");
          if (actual.some(thread => (thread.activeRuns?.length || thread.queuedRuns?.length || thread.pendingWaits || thread.pendingInputs || thread.activeDelegations || thread.pendingDeliveries)
            || thread.blockingReasons?.some(reason => reason.kind === "unknown_executions"))) throw new Error("工作区仍有运行、等待、排队或未核验任务。请先处理任务或在终态后归档，再移除工作区。");
          const removedRoots = state.removedRoots.includes(root) ? state.removedRoots : [...state.removedRoots, root];
          const directories = state.directories.filter(directory => directory.root !== root);
          const nextRoot = directories.some(directory => directory.root === state.root) ? state.root : directories[0]?.root || "";
          set({ directories, removedRoots, ...(!state.selected ? { root: nextRoot } : {}) });
        },
        async pinThread(threadOrId, pinned) {
          const threadId = threadIdOf(threadOrId); if (!threadId) throw new Error("线程 ID 无效");
          const thread = await call("thread.get", { threadId });
          await call("thread.metadata", { threadId, requestId: requestId("thread.metadata"), expectedControlRevision: thread.controlRevision, pinned: typeof pinned === "boolean" ? pinned : !thread.pinned });
          const confirmed = await call("thread.get", { threadId });
          set({ threads: decorateThreads(state.threads.map(item => item.threadId === threadId ? { ...item, ...confirmed } : item)) });
        },
        async archiveThread(threadOrId) {
          const threadId = threadIdOf(threadOrId);
          if (!threadId) throw new Error("线程 ID 无效");
          if (state.archivedThreadIds.includes(threadId)) return;
          if (state.selected?.threadId === threadId && state.busy) throw new Error("消息正在提交，请稍后再归档");
          const thread = await call("thread.get", { threadId });
          if (!thread || thread.threadId !== threadId) throw new Error("未能确认线程状态，归档已取消");
          const hasActiveWork = thread.status === "running" || thread.status === "waiting"
            || (Array.isArray(thread.activeRuns) && thread.activeRuns.length > 0)
            || (Array.isArray(thread.queuedRuns) && thread.queuedRuns.length > 0);
          if (hasActiveWork) throw new Error("会话仍有运行、等待或排队任务。请等待结束，或明确暂停／停止后确认实际状态，再归档。");
          await call("thread.archive", { threadId, requestId: requestId("thread.archive") });
          const confirmed = await call("thread.get", { threadId });
          if (confirmed?.status !== "archived") throw new Error("归档请求已接收，尚未确认业务状态；请刷新查看，不能仅凭回执隐藏会话。");
          const archivedThreadIds = [...new Set([...state.archivedThreadIds, threadId])];
          set({ archivedThreadIds, threads: decorateThreads(state.threads.map(item => item.threadId === threadId ? { ...item, ...confirmed } : item), { archivedThreadIds }) });
          if (state.selected?.threadId === threadId) newConversation();
        },
        async unarchiveThread(threadOrId) {
          const threadId = threadIdOf(threadOrId); if (!threadId) throw new Error("线程 ID 无效");
          const thread = await call("thread.get", { threadId });
          await call("thread.metadata", { threadId, requestId: requestId("thread.metadata"), expectedControlRevision: thread.controlRevision, archived: false });
          const confirmed = await call("thread.get", { threadId });
          if (confirmed.status === "archived") throw new Error("恢复归档请求已接收，尚未确认业务状态，请刷新查看");
          const archivedThreadIds = state.archivedThreadIds.filter(id => id !== threadId);
          set({ archivedThreadIds, threads: decorateThreads(state.threads.map(item => item.threadId === threadId ? { ...item, ...confirmed, archived: false } : item), { archivedThreadIds }) });
        },
        async deleteThread(threadOrId) { return controller.changeThreadDeletion(threadOrId, "delete"); },
        async restoreThread(threadOrId) { return controller.changeThreadDeletion(threadOrId, "restore"); },
        async changeThreadDeletion(threadOrId, action) {
          const threadId = threadIdOf(threadOrId); if (!threadId) throw new Error("线程 ID 无效");
          if (state.selected?.threadId === threadId && state.busy) throw new Error("消息正在提交，请等待回执后再删除");
          const key = `${state.targetId}:${action}:${threadId}`, targetId = state.targetId, at = epoch;
          let pending = pendingThreadDeletions.get(key);
          if (!pending) { const current = await call("thread.get", { threadId, targetId }); pending = { requestId: requestId(`thread.${action}`), threadId, targetId, expectedControlRevision: current.controlRevision }; pendingThreadDeletions.set(key, pending); }
          try {
            await call(`thread.${action}`, pending);
            const confirmed = await call("thread.get", { threadId, targetId });
            if ((confirmed.deletedAt != null) !== (action === "delete")) throw new Error("操作已接收，尚未确认删除状态；请用原请求重试");
            pendingThreadDeletions.delete(key);
            if (at !== epoch || targetId !== state.targetId) return confirmed;
            set({ threads: decorateThreads(state.threads.map(item => item.threadId === threadId ? { ...item, ...confirmed } : item)),
              ...(state.selected?.threadId === threadId ? { thread: confirmed } : {}) });
            if (action === "delete" && state.selected?.threadId === threadId) newConversation();
            return confirmed;
          } catch (error) { if (["VERSION_CONFLICT", "RUN_NOT_ACTIVE", "EXECUTION_UNKNOWN", "RECOVERY_EXPIRED"].includes(error.code)) pendingThreadDeletions.delete(key); throw error; }
        },
        setManualThreadOrder(threadIds) {
          if (!Array.isArray(threadIds)) throw new Error("线程顺序必须是数组");
          const present = new Set(state.threads.map(thread => thread.threadId));
          const ordered = [...new Set(threadIds.filter(id => typeof id === "string" && present.has(id)))];
          const orderedSet = new Set(ordered);
          for (const thread of state.threads) if (!orderedSet.has(thread.threadId)) ordered.push(thread.threadId);
          set({ manualThreadOrder: ordered, threads: decorateThreads(state.threads, { manualThreadOrder: ordered }) });
        },
        async stop() {
          if (!state.selected) return;
          try {
            await call("thread.stop", { threadId: state.selected.threadId, requestId: requestId("thread.stop") });
            await refresh();
            setTimeout(() => void refresh(), 300);
            setTimeout(() => void refresh(), 1000);
          }
          catch (error) { set({ error: error.message }); }
        },
        async renameThread(thread, title) {
          const text = title.trim(); if (!text) throw new Error("会话标题不能为空");
          const current = Number.isSafeInteger(thread.controlRevision) ? thread : await call("thread.get", { threadId: thread.threadId });
          await call("thread.metadata", { threadId: thread.threadId, requestId: requestId("thread.metadata"), expectedControlRevision: current.controlRevision, title: text });
          const confirmed = await call("thread.get", { threadId: thread.threadId });
          set({ threads: decorateThreads(state.threads.map(item => item.threadId === thread.threadId ? { ...item, ...confirmed } : item)) });
        },
        async stageMessageFiles(files, kind) {
          if (!["file", "reference", "image"].includes(kind) || !files.length || files.length + (state.materials || []).length > 10) throw new Error("一次输入最多10个材料，请选择文件");
          const at = epoch, targetId = state.targetId, blocks = new Map(), manifestFiles = [], refs = [];
          const hash = async bytes => [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
          let total = (state.materials || []).reduce((sum, item) => sum + (item.size || 0), 0);
          for (const file of files) {
            if (!file.name || /[\\/]/.test(file.name) || file.name === "." || file.name === ".." || manifestFiles.some(item => item.path === file.name)) throw new Error("文件名无效或重名，请分别上传");
            total += file.size;
            if (file.size > (kind === "image" ? 10 : 1) * 1048576 || total > 20 * 1048576) throw new Error("文件/引用正文最多1MiB，图片最多10MiB，总材料最多20MiB");
            const bytes = new Uint8Array(await file.arrayBuffer()), hashes = [];
            for (let offset = 0; offset < bytes.length; offset += 262144) {
              const block = bytes.slice(offset, offset + 262144), digest = await hash(block); hashes.push(digest); blocks.set(digest, block);
            }
            manifestFiles.push({ path: file.name, hash: await hash(bytes), size: bytes.length, mode: 420, blocks: hashes });
            refs.push({ kind, path: file.name, source: `本机消息附件:${file.name}`, ...(kind === "image" && file.type ? { mediaType: file.type } : {}) });
          }
          if (disposed || at !== epoch) throw new Error("Core目标或会话已切换，请重新选择消息材料");
          const signature = JSON.stringify([targetId, state.root, manifestFiles, kind]);
          if (!materialUpload || materialUpload.signature !== signature || materialUpload.cancelled) materialUpload = { signature, requestId: requestId("message.upload"), blocks, manifest: { version: 1, files: manifestFiles, ignored: [], rules: ["explicit-message-attachments"] }, cancelled: false };
          const job = materialUpload, request = (action, payload) => call(action, { ...payload, targetId });
          if (!job.workspaceId) job.workspaceId = state.root ? (await request("workspace.find", { root: state.root }))?.workspaceId : null;
          job.workspaceId ||= `message:${job.requestId}`;
          let transfer = job.operationId ? await request("files.transfer.get", { operationId: job.operationId }) : await request("files.transfer.create", { requestId: job.requestId, workspaceId: job.workspaceId, manifest: job.manifest, source: { mode: "local_upload", location: "explicit-message-attachments" } });
          job.operationId = transfer.operationId;
          for (const digest of transfer.missingBlocks) {
            if (disposed || job.cancelled || at !== epoch) throw new Error("消息材料上传已取消；已接收块保留供原操作查询");
            const block = job.blocks.get(digest); if (!block) throw new Error("原上传候选缺少固定内容块，请重新选择");
            let binary = ""; for (let offset = 0; offset < block.length; offset += 4096) binary += String.fromCharCode(...block.subarray(offset, offset + 4096));
            transfer = await request("files.transfer.upload", { requestId: `${job.requestId}:block:${digest}`, operationId: job.operationId, hash: digest, dataBase64: btoa(binary) });
          }
          if (disposed || job.cancelled || at !== epoch) throw new Error("消息材料上传已取消");
          const snapshot = await request("files.transfer.commit", { requestId: `${job.requestId}:commit`, operationId: job.operationId });
          if (disposed || at !== epoch) throw new Error("消息材料已发布，但当前目标或会话已切换；未添加到新输入");
          const materials = refs.map(ref => ({ ...ref, snapshotId: snapshot.snapshotId }));
          set({ materials: [...(state.materials || []), ...materials] }); materialUpload = null; return snapshot;
        },
        async cancelMaterialUpload() {
          const job = materialUpload; if (!job) return; job.cancelled = true;
          if (job.operationId) await call("files.transfer.cancel", { operationId: job.operationId, requestId: `${job.requestId}:cancel` });
        },
        setMaterials(materials) { if (!Array.isArray(materials) || materials.length > 10) throw new Error("一次输入最多选择10个材料"); set({ materials }); },
        setSelectedSkills: selectedSkillIds => set({ selectedSkillIds: [...new Set(selectedSkillIds)] }),
        setDraft: draft => set({ draft }), setDelivery: delivery => { if (!["new_run", "next_turn"].includes(delivery)) throw new Error("无效的输入用途"); set({ delivery, targetRunId: null }); },
        setTargetRun(runId) {
          if (runId !== null && (typeof runId !== "string" || !(state.runDetails || []).some(run => run.runId === runId && run.conversationId === state.selected?.conversationId))) throw new Error("补充目标不属于当前对话");
          set({ targetRunId: runId });
        },
        async setModel(modelId) {
          const model = state.models.find(m => m.id === modelId && m.selectable !== false);
          if (!model) throw new Error("模型不在可用目录中");
          const supported = model.supportedThinkingLevels;
          if (!state.selected) {
            set({ modelId, modelSource: "conversation_override",
              ...(state.thinkingLevel !== null && Array.isArray(supported) && !supported.includes(state.thinkingLevel) ? { thinkingLevel: null } : {}) });
            return;
          }
          const conversation = state.conversation || await call("conversation.get", { conversationId: state.selected.conversationId });
          await call("conversation.updateConfig", { conversationId: state.selected.conversationId, requestId: requestId("conversation.updateConfig"), expectedConfigRevision: conversation.pendingConfig?.configRevision || conversation.configRevision, patch: { provider: model.provider, modelId } });
          await syncSelection();
        },
        async restoreServiceDefaults() {
          if (!state.selected) { set({ modelSource: "service_default", modelId: state.defaultModelId, thinkingLevel: null }); return; }
          const conversation = state.conversation || await call("conversation.get", { conversationId: state.selected.conversationId });
          await call("conversation.updateConfig", { conversationId: state.selected.conversationId, requestId: requestId("conversation.updateConfig"), expectedConfigRevision: conversation.pendingConfig?.configRevision || conversation.configRevision, patch: { modelSource: "service_default" } });
          await syncSelection();
        },
        async compactConversation(runId) {
          if (!state.selected || !runId) throw new Error("请选择已完成的任务");
          const key = `compact:${state.selected.conversationId}:${runId}`, at = epoch;
          let pending = pendingWaitActions.get(key);
          if (!pending) { pending = { payload: { conversationId: state.selected.conversationId, runId, requestId: requestId("conversation.compact"), targetId: state.targetId } }; pendingWaitActions.set(key, pending); }
          const result = await call("conversation.compact", pending.payload); pendingWaitActions.delete(key);
          if (at === epoch) await syncSelection(); return result;
        },
        async discardPendingConfig() {
          if (!state.selected || !state.conversation?.pendingConfig) throw new Error("当前没有待生效选择，请刷新");
          await call("conversation.discardPending", { conversationId: state.selected.conversationId, expectedConfigRevision: state.conversation.pendingConfig.configRevision, requestId: requestId("conversation.discardPending") });
          await syncSelection();
        },
        async setPermissionMode(permissionMode) {
          if (!["service_default", "approve_all", "workspace_auto", "approve_none"].includes(permissionMode)) throw new Error("请选择有效审批策略");
          if (!state.selected) {
            set({ permissionMode });
            return;
          }
          const conversation = state.conversation || await call("conversation.get", { conversationId: state.selected.conversationId });
          await call("conversation.updateConfig", { conversationId: state.selected.conversationId, requestId: requestId("conversation.updateConfig"), expectedConfigRevision: conversation.pendingConfig?.configRevision || conversation.configRevision, patch: permissionMode === "service_default" ? { permissionSource: "service_default" } : { permissionMode } });
          await syncSelection();
        },
        async setThinking(thinkingLevel) {
          const value = thinkingLevel === "provider_default" ? null : thinkingLevel;
          const model = state.models.find(item => item.id === (state.selected ? state.conversation?.pendingConfig?.config?.modelId || state.conversation?.config?.modelId || state.modelId : state.modelId));
          if (value !== null && Array.isArray(model?.supportedThinkingLevels) && !model.supportedThinkingLevels.includes(value)) throw new Error("当前模型不支持此推理等级");
          if (!state.selected) { set({ thinkingLevel: value }); return; }
          const conversation = state.conversation || await call("conversation.get", { conversationId: state.selected.conversationId });
          await call("conversation.updateConfig", { conversationId: state.selected.conversationId, requestId: requestId("conversation.updateConfig"), expectedConfigRevision: conversation.pendingConfig?.configRevision || conversation.configRevision, patch: { thinkingLevel: value === null ? "provider_default" : value } });
          await syncSelection();
        },
        async controlThreadTarget(threadId, action) {
          if (!threadId || !["pause", "resume", "stop"].includes(action)) throw new Error("无效的线程控制目标");
          const at = epoch, targetId = state.targetId;
          await call(`thread.${action}`, { threadId, targetId, requestId: requestId(`thread.${action}`) });
          const actual = await call("thread.get", { threadId, targetId });
          if (at === epoch) await refresh(); return actual;
        },
        async controlThread(action) {
          if (!state.selected || !["pause", "resume", "stop"].includes(action)) return;
          await call(`thread.${action}`, { threadId: state.selected.threadId, requestId: requestId(`thread.${action}`) });
          await refresh();
          if (action === "stop") {
            setTimeout(() => void refresh(), 300);
            setTimeout(() => void refresh(), 1000);
          }
        },
        clearTargetCache(targetId) { try { storage?.removeItem(`${STORAGE_KEY}.${targetId || "uds"}`); } catch {} },
        targetChanged(targetId, { forget = false } = {}) {
          rememberDraft(); persist();
          workspaceReadVersion++; workspaceBrowseAbort?.abort();
          epoch++; metadata.clear(); runLookups.clear(); liveCursors.clear(); terminalRunIds.clear(); runDiffCache.clear(); pendingInputs.clear(); pendingWaitActions.clear(); pendingRollbacks.clear(); if (materialUpload) materialUpload.cancelled = true; materialUpload = null; createAttempt = null;
          source?.close(); source = null;
          let cached = {};
          try { if (forget) storage?.removeItem(`${STORAGE_KEY}.${targetId || "uds"}`); else cached = JSON.parse(storage?.getItem(`${STORAGE_KEY}.${targetId || "uds"}`) || "{}"); } catch {}
          materialDrafts.clear(); for (const [key, value] of Object.entries(cached.materialDrafts || {})) materialDrafts.set(key, value);
          composerDrafts.clear(); for (const [key, value] of Object.entries(cached.composerDrafts || {})) composerDrafts.set(key, restoreComposer(value));
          drafts.clear(); for (const [key, value] of Object.entries(cached.drafts || {})) if (typeof value === "string") drafts.set(key, value);
          pendingInputs.clear(); for (const [key, value] of restorePendingInputs(cached.pendingInputs)) pendingInputs.set(key, value);
          pendingGoalOperations.clear(); for (const [key, value] of restoreGoalOperations(cached.pendingGoalOperations)) pendingGoalOperations.set(key, value);
          createAttempt = cached.createAttempt && typeof cached.createAttempt.id === "string" && typeof cached.createAttempt.signature === "string" ? cached.createAttempt : null;
          set({ goal: null, goalsSupported: false, goalError: "", goalNotice: "", goalBusy: false, goalInputMode: "message", goalEventSeq: 0, attachments: restoreAttachments(cached.attachments), attachmentRemovals: cached.attachmentRemovals || [], attachmentDraftId: cached.attachmentDraftId || null, selectedSkills: cached.selectedSkills || [], skillCatalog: [], skillCatalogError: "", attachmentCapabilities: null, attachmentCapabilityError: "", inputPreview: null, previewLoading: false, previewError: "", attachmentNotice: "", busy: false, inspector: false, targetId, workspaceForm: false, coreInstanceId: null, coreTargetLabel: "当前 Core", managedWorkspaceLocation: null, workspaceLoading: false, workspaceOpening: false, workspaceError: "", workspaceRequest: cached.workspaceRequest || null, selected: cached.selected || null, directories: Array.isArray(cached.directories) ? cached.directories : [], removedRoots: cached.removedRoots || [], titles: cached.titles || {}, pinnedThreadIds: cached.pinnedThreadIds || [], archivedThreadIds: cached.archivedThreadIds || [], models: [], threads: [], messages: [], live: [], thread: null, runDetails: [], waits: [], executions: [], contextView: null, contextError: "", conversation: null, branches: [], branchError: "", branchesLoaded: false, branchLoading: false, root: cached.root || "", modelId: cached.modelId || "", modelSource: cached.modelSource || (cached.modelId ? "conversation_override" : "service_default"), thinkingLevel: typeof cached.thinkingLevel === "string" ? cached.thinkingLevel : null, defaultModelId: "", permissionMode: cached.permissionMode || null, delivery: "new_run", targetRunId: null, diffSelection: cached.diffSelection && typeof cached.diffSelection.runId === "string" ? cached.diffSelection : null, draft: typeof cached.draft === "string" ? cached.draft : "", materials: Array.isArray(cached.materials) ? cached.materials : [], selectedSkillIds: Array.isArray(cached.selectedSkillIds) ? cached.selectedSkillIds : [], fileSelection: null, ready: false, error: "", historyError: "" });
          services.resetForTarget?.();
          services.viewState.set({ connection: "offline", threadId: null, conversationId: null, snapshot: null, run: null, threads: [], info: null, eventSeq: null });
          if (started) connectEvents(); void refresh();
        },
        async fork(message) {
          if (!state.selected || !Number.isInteger(message.entryId)) return;
          const result = await call("conversation.fork", { conversationId: state.selected.conversationId,
            sourceEntryId: message.entryId, requestId: requestId("conversation.fork") });
          await selectThread(state.selected.threadId, result.conversationId);
        },
        start() { if (!started && !disposed) { started = true; void refresh(); timer = setInterval(() => void refresh(), 2000); connectEvents(); } return () => controller.dispose(); },
        dispose() { if (disposed) return; disposed = true; epoch++; workspaceReadVersion++; workspaceBrowseAbort?.abort(); if (materialUpload) materialUpload.cancelled = true; clearInterval(timer); source?.close(); source = null; listeners.clear(); },
      };
      const originalCall = transport.call.bind(transport);
      transport.call = async (action, payload) => {
        if (action === "core.reconnect") { await refresh(); return { status: state.ready ? "done" : "error", reason: state.error }; }
        if (action === "run.fork") {
          const result = await call("conversation.fork", { conversationId: payload.conversationId,
            sourceEntryId: payload.sourceEntryId, requestId: requestId("conversation.fork") });
          await selectThread(result.threadId, result.conversationId);
          return { status: "done", result };
        }
        const actionEpoch = epoch;
        const result = await originalCall(action, { ...payload, targetId: state.targetId });
        if (actionEpoch !== epoch) return result;
        await syncSelection();
        return result;
      };
      let views;
      const getViews = () => views ||= createSpaceView({ kernel, controller, services, ctx, Panel, SPACE_ID, primitives, directoryBrowser, ConversationTrace });
      const Space = props => h(getViews().Space, props);
      const DirectorySection = props => h(getViews().DirectorySection, props);
      const registrations = [
        { slot: "main", label: "Super Agent space", options: { name: "main", key: SPACE_ID }, component: Space },
        { slot: "sidebar.panellist", label: "Super Agent", options: { name: "sidebar.panellist", id: SPACE_ID, label: "Super Agent", order: 85 }, component: () => h(kernel.IconSuperAgent || "span", { "aria-hidden": true }) },
        { slot: "sidebar.footer.action", label: "Super Agent directories", options: { name: "sidebar.footer.action", id: SPACE_ID, order: 80 }, component: DirectorySection },
      ];
      return { registrations, controller };
    }
    return { SPACE_ID, STORAGE_KEY, createSpace, lineDiff, parseGoalCommand };
  },
});
