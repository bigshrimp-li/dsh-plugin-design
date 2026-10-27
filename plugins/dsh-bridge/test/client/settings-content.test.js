import { describe, expect, it } from "vitest";

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: definition => loaded.push(definition) } };
await import("../../src/client/client.settings-content.js");
const { createSettingsContent } = loaded.pop().factory();
const h = (type, props, ...children) => ({ type, props: { ...props, children } });
const text = value => Array.isArray(value) ? value.map(text).join(" ") : value && typeof value === "object" ? text(value.props?.children) : String(value ?? "");

function fixture(handler, section = "workspace", executeEffects = false) {
  const hooks = [], effects = [], calls = [], errors = [], notes = [], snapshots = [], runtime = { root: "/project", contextView: { latestRunId: "run-a" }, selected: { conversationId: "conversation-a" } };
  let cursor = 0, nextId = 0;
  const React = { Fragment: Symbol("fragment"), useSyncExternalStore: (_subscribe, read) => read(), useEffect(fn, deps) {
    if (!executeEffects) return;
    const at = cursor++, previous = hooks[at];
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) effects.push(() => { previous?.cleanup?.(); hooks[at] = { deps, cleanup: fn() }; });
  },
    useState(initial) { const at = cursor++; if (!(at in hooks)) hooks[at] = initial; return [hooks[at], value => { hooks[at] = typeof value === "function" ? value(hooks[at]) : value; }]; },
    useRef(initial) { const at = cursor++; return hooks[at] ||= { current: initial }; } };
  const Button = () => {}, Modal = () => {}, state = { selectedId: "target-a" };
  const settings = { nextRequestId: name => `${name}-${++nextId}`, report: error => { if (error) errors.push(error.message || error); }, note: text => notes.push(text),
    call: async (action, payload) => { calls.push({ action, payload }); return handler(action, payload); } };
  const space = { controller: { subscribe() {}, getSnapshot: () => runtime, useFileSnapshot: (...args) => snapshots.push(args) } };
  const content = createSettingsContent({ kernel: { React, h }, primitives: { Button, Modal }, space });
  const render = node => {
    if (Array.isArray(node)) return node.map(render);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function" && ![Button, Modal].includes(node.type)) return render(node.type(node.props));
    return { ...node, props: { ...node.props, children: render(node.props?.children), footer: render(node.props?.footer) } };
  };
  const nodes = (node, out = []) => { if (Array.isArray(node)) node.forEach(item => nodes(item, out)); else if (node && typeof node === "object") { out.push(node); nodes(node.props?.children, out); nodes(node.props?.footer, out); } return out; };
  const tree = () => { cursor = 0; return render(content[section]({ settings, state })); };
  const all = () => nodes(tree());
  const click = async label => { const button = all().find(node => node.type === Button && text(node) === label); expect(button, label).toBeTruthy(); expect(button.props.disabled, label).toBeFalsy(); button.props.onClick(); await new Promise(resolve => setTimeout(resolve, 0)); };
  const field = label => { const owner = all().find(node => node.type === "label" && text(node).startsWith(label)); expect(owner, label).toBeTruthy(); return nodes(owner).find(node => ["input", "select", "textarea"].includes(node.type)); };
  const change = (label, value) => field(label).props.onChange({ target: { value } });
  const flush = async () => { for (let index = 0; index < 5; index++) { all(); for (const effect of effects.splice(0)) effect(); await new Promise(resolve => setTimeout(resolve, 0)); } };
  const dispose = () => { for (const hook of hooks) hook?.cleanup?.(); };
  return { calls, errors, notes, snapshots, state, click, change, all, field, flush, dispose };
}
const artifacts = { inputSnapshot: { snapshotId: "input-a" }, resultSnapshot: { snapshotId: "result-a" }, files: [{ path: "edit.md", kind: "modified", before: { hash: "before" }, after: { hash: "after" } }] };
const operation = { operationId: "operation-a", runId: "run-a", destination: "/destination", items: [{ path: "edit.md", status: "conflict" }] };

describe("production file settings user actions", () => {
  it.each(["keep_local", "save_as", "merge"])("submits the reviewed %s conflict choice through the actual Host route", async choice => {
    let resolved = false;
    const ui = fixture((action, payload) => {
      if (action === "files.artifacts") return artifacts;
      if (action === "files.applyLocal") return operation;
      if (action === "files.applyConflict.preview") return { operationId: operation.operationId, path: "edit.md", destination: "/destination", actualHash: "reviewed-local-hash", localText: "local", baseText: "base", cloudText: "cloud", canSaveAs: true, suggestedPath: "edit.md.cloud", binary: false };
      if (action === "files.applyConflict.resolve") { resolved = true; return { operationId: "resolution-a", items: [{ status: choice === "merge" ? "applied" : "skipped" }] }; }
      if (action === "files.applyOperation") return { ...operation, items: [{ path: "edit.md", status: resolved ? choice === "merge" ? "applied" : "skipped" : "conflict" }] };
      throw new Error(`Unexpected action ${action}`);
    });
    await ui.click("审阅产物"); ui.change("回传到本机目录", "/destination"); await ui.click("将所选产物应用到本机"); await ui.click("审阅并处理此冲突");
    ui.change("冲突处理", choice);
    if (choice === "save_as") ui.change("另存相对路径", "reviewed/cloud.md");
    if (choice === "merge") ui.change("审阅后的完整合并文本", "reviewed merge");
    await ui.click("确认所选冲突处理");
    expect(ui.calls.find(call => call.action === "files.applyConflict.resolve").payload).toMatchObject({ targetId: "target-a", operationId: operation.operationId, path: "edit.md", expectedLocalHash: "reviewed-local-hash", choice,
      ...(choice === "save_as" ? { saveAsPath: "reviewed/cloud.md" } : {}), ...(choice === "merge" ? { mergedText: "reviewed merge" } : {}) });
    expect(ui.all().find(node => node.type === "input" && node.props.type === "checkbox").props.disabled).toBe(true);
    expect(ui.errors).toEqual([]);
  });

  it("reuses the original writeback request after a lost receipt", async () => {
    let submissions = 0;
    const ui = fixture(action => { if (action === "files.artifacts") return artifacts; if (action === "files.applyLocal") { if (++submissions === 1) throw new Error("receipt lost"); return operation; } throw new Error(action); });
    await ui.click("审阅产物"); ui.change("回传到本机目录", "/destination"); await ui.click("将所选产物应用到本机");
    expect(ui.field("回传到本机目录").props.disabled).toBe(true);
    await ui.click("查询／恢复原回传");
    const requests = ui.calls.filter(call => call.action === "files.applyLocal"); expect(requests).toHaveLength(2); expect(requests[0].payload).toEqual(requests[1].payload);
  });

  it("allows correcting a definitively refused save-as path without replaying an unknown request", async () => {
    let attempts = 0;
    const ui = fixture(action => {
      if (action === "files.artifacts") return artifacts;
      if (action === "files.applyLocal") return operation;
      if (action === "files.applyConflict.preview") return { operationId: operation.operationId, path: "edit.md", actualHash: "reviewed", localText: "local", canSaveAs: true, suggestedPath: "existing.md" };
      if (action === "files.applyConflict.resolve") { if (++attempts === 1) throw Object.assign(new Error("save-as target exists; no file write was admitted"), { code: "LOCAL_ARTIFACT_REJECTED" }); return { operationId: "resolved", items: [{ status: "applied" }] }; }
      if (action === "files.applyOperation") return { ...operation, items: [{ path: "edit.md", status: "skipped" }] };
      throw new Error(action);
    });
    await ui.click("审阅产物"); ui.change("回传到本机目录", "/destination"); await ui.click("将所选产物应用到本机"); await ui.click("审阅并处理此冲突"); ui.change("冲突处理", "save_as");
    await ui.click("确认所选冲突处理"); expect(ui.field("另存相对路径").props.disabled).toBeFalsy();
    ui.change("另存相对路径", "new-reviewed.md"); await ui.click("确认所选冲突处理");
    const attemptsSent = ui.calls.filter(call => call.action === "files.applyConflict.resolve");
    expect(attemptsSent[0].payload.requestId).not.toBe(attemptsSent[1].payload.requestId); expect(attemptsSent[1].payload.saveAsPath).toBe("new-reviewed.md");
  });

  it("retains the exact original conflict resolution when the response is unknown", async () => {
    let attempts = 0;
    const ui = fixture(action => {
      if (action === "files.artifacts") return artifacts;
      if (action === "files.applyLocal") return operation;
      if (action === "files.applyConflict.preview") return { operationId: operation.operationId, path: "edit.md", actualHash: "reviewed", localText: "local", canSaveAs: true, suggestedPath: "new.md" };
      if (action === "files.applyConflict.resolve") { if (++attempts === 1) throw new Error("receipt lost after the Host may have written"); return { operationId: "resolved", items: [{ status: "skipped" }] }; }
      if (action === "files.applyOperation") return { ...operation, items: [{ path: "edit.md", status: "skipped" }] };
      throw new Error(action);
    });
    await ui.click("审阅产物"); ui.change("回传到本机目录", "/destination"); await ui.click("将所选产物应用到本机"); await ui.click("审阅并处理此冲突");
    await ui.click("确认所选冲突处理"); expect(ui.field("冲突处理").props.disabled).toBe(true);
    await ui.click("恢复原冲突处理");
    const attemptsSent = ui.calls.filter(call => call.action === "files.applyConflict.resolve"); expect(attemptsSent[0].payload).toEqual(attemptsSent[1].payload);
  });

  it("binds the selected immutable snapshot to the next input instead of creating an unused branch", async () => {
    const snapshot = { snapshotId: "selected-a", workspaceId: "workspace-a" };
    const ui = fixture(action => { if (action === "files.snapshots") return { items: [snapshot] }; throw new Error(action); });
    ui.change("项目 Workspace ID", "workspace-a"); await ui.click("刷新可用版本"); ui.change("可用不可变版本", snapshot.snapshotId);
    await ui.click("将版本用于本对话的新执行分支");
    expect(ui.snapshots).toEqual([[snapshot, "/project"]]); expect(ui.calls.some(call => call.action === "files.branch.create")).toBe(false);
  });
});

describe("reviewed Skill installation settings", () => {
  const item = { installationId: "installed", sourceId: "managed", sourceSkillPath: "review/SKILL.md", name: "review", skillId: "review", description: "Review a patch", targetPath: "/project/.agent/skills/review", digest: "fixed", expectedTargetDigest: null, added: ["SKILL.md", "references/guide.md"], modified: [], removed: [], warnings: [], errors: [] };
  const plan = { planId: "plan", originSourceId: "origin", sourceSnapshotId: "fixed-source", workspaceId: "project", kind: "import", ready: true, items: [item] };
  const origin = { sourceId: "origin", kind: "local", location: "/local/skill", workspaceId: "project", revision: 0, versions: [], activeSnapshotId: null };
  function service(handler = () => undefined) {
    return (action, payload) => {
      const result = handler(action, payload); if (result !== undefined) return result;
      if (action === "workspaces.lookup") return { workspaceId: "project", root: "/project", name: "Project" };
      if (action === "skills.locations") return { items: [{ workspaceId: "project", rootPath: "/project/.agent/skills", writable: true, machineId: "core-host", executionUser: "alice" }, { workspaceId: null, rootPath: "/home/alice/.agent/skills", writable: true, machineId: "core-host", executionUser: "alice" }] };
      if (["skills.installations", "skills.list", "skills.installOperations", "skills.operations", "files.localUploads"].includes(action)) return { items: [] };
      if (action === "skills.catalog") return { items: [], counts: { available: 0, conflict: 0, invalid: 0, disabled: 0 } };
      if (action === "skills.create") return origin;
      if (action === "files.previewLocal") return { candidateId: "local-candidate", bytes: 15, manifest: { files: [{ path: "review/SKILL.md" }, { path: "review/references/guide.md" }], ignored: [] } };
      if (action === "files.syncLocal") return { snapshotId: "fixed-source" };
      if (action === "skills.recordVersion") return { ...origin, revision: 1, versions: ["fixed-source"] };
      if (["skills.previewImport", "skills.previewMigration"].includes(action)) return plan;
      if (action === "skills.applyInstall") return { operationId: "install-op", requestId: payload.requestId, status: "succeeded", completedInstallationIds: ["installed"] };
      throw new Error(`Unexpected Skill action ${action}`);
    };
  }
  it("resolves the project and previews a complete local package before the only adopting action", async () => {
    const ui = fixture(service(), "skills", true);
    try {
      await ui.flush();
      expect(ui.field("实际导入根目录").props.value).toBe("/project/.agent/skills");
      expect(ui.all().filter(node => node.type === "label").some(node => /Workspace ID|快照 ID/.test(text(node)))).toBe(false);
      await ui.click("来源与更新"); ui.change("DSH 本机来源目录", "/local/skill"); await ui.click("准备完整包并审阅");
      expect(ui.calls.find(call => call.action === "skills.create").payload.workspaceId).toBe("project");
      expect(ui.calls.find(call => call.action === "files.previewLocal").payload.rules).toEqual([]);
      expect(ui.calls.find(call => call.action === "skills.recordVersion").payload).toMatchObject({ activate: false, snapshotId: "fixed-source", sourceId: "origin" });
      expect(ui.calls.some(call => call.action === "skills.applyInstall" || call.action === "skills.update")).toBe(false);
      await ui.click("导入并启用 1 个 Skill");
      expect(ui.calls.find(call => call.action === "skills.applyInstall").payload).toMatchObject({ planId: "plan", targetId: "target-a" });
      expect(ui.notes.at(-1)).toContain("已可用 1 个 Skill"); expect(ui.errors).toEqual([]);
    } finally { ui.dispose(); }
  });

  it("invalidates the reviewed plan when the alias changes and requires another server preview", async () => {
    const ui = fixture(service((action, payload) => action === "skills.previewImport" && payload.aliases ? { ...plan, planId: "alias-plan", items: [{ ...item, skillId: payload.aliases[item.sourceSkillPath] }] } : undefined), "skills", true);
    try {
      await ui.flush(); await ui.click("来源与更新"); ui.change("DSH 本机来源目录", "/local/skill"); await ui.click("准备完整包并审阅");
      ui.change("采用名称／新别名", "alternate");
      expect(ui.all().find(node => node.props?.children && text(node) === "导入并启用 1 个 Skill" && node.props?.onClick)?.props.disabled).toBe(true);
      await ui.click("按所选项重新预检");
      const request = ui.calls.filter(call => call.action === "skills.previewImport").at(-1).payload;
      expect(request).toMatchObject({ sourceId: "origin", snapshotId: "fixed-source", workspaceId: "project", aliases: { "review/SKILL.md": "alternate" }, skillPaths: ["review/SKILL.md"] });
      await ui.click("导入并启用 1 个 Skill");
      expect(ui.calls.find(call => call.action === "skills.applyInstall").payload.planId).toBe("alias-plan");
    } finally { ui.dispose(); }
  });

  it("returns focus to the opening control after Escape or explicit review cancellation", async () => {
    const originalDocument = window.document;
    let focused = 0;
    const trigger = { isConnected: true, focus: () => { focused++; } };
    window.document = { activeElement: trigger };
    const ui = fixture(service(action => action === "skills.list" ? { items: [{ ...origin, versions: ["fixed-source"] }] } : undefined), "skills", true);
    try {
      await ui.flush(); await ui.click("来源与更新"); await ui.click("审阅固定候选");
      const dialog = ui.all().find(node => node.props?.title === "审阅完整 Skill 包");
      expect(dialog).toBeTruthy();
      dialog.props.onClose(); await new Promise(resolve => setTimeout(resolve, 0));
      expect(focused).toBe(1);
      await ui.click("审阅固定候选"); await ui.click("取消审阅");
      expect(focused).toBe(2);
    } finally { ui.dispose(); window.document = originalDocument; }
  });

  it("queries the original operation after a lost adoption receipt without re-reading the source", async () => {
    let submitted;
    const ui = fixture(service((action, payload) => {
      if (action === "skills.applyInstall") { submitted = payload; throw new Error("receipt lost"); }
      if (action === "skills.installOperations") return { items: submitted ? [{ operationId: "original", requestId: submitted.requestId, status: "unknown", stage: "published", completedInstallationIds: [] }] : [] };
      if (action === "skills.installOperation") return { operationId: "original", status: "unknown" };
    }), "skills", true);
    try {
      await ui.flush(); await ui.click("来源与更新"); ui.change("DSH 本机来源目录", "/local/skill"); await ui.click("准备完整包并审阅"); await ui.click("导入并启用 1 个 Skill");
      await ui.click("查询原导入结果");
      expect(ui.calls.filter(call => call.action === "skills.applyInstall")).toHaveLength(1);
      expect(ui.calls.filter(call => call.action === "files.previewLocal")).toHaveLength(1);
      expect(ui.calls.find(call => call.action === "skills.installOperation").payload.operationId).toBe("original");
    } finally { ui.dispose(); }
  });

  it("restores the same captured local candidate and upload command after a lost preparation receipt", async () => {
    const originalStorage = window.localStorage, saved = new Map(), sent = [];
    window.localStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
    const handler = service((action, payload) => {
      if (action === "files.syncLocal") { sent.push(payload); if (sent.length === 1) throw new Error("upload receipt lost"); return { snapshotId: "fixed-source" }; }
    });
    let ui = fixture(handler, "skills", true);
    try {
      await ui.flush(); await ui.click("来源与更新"); ui.change("DSH 本机来源目录", "/local/skill"); await ui.click("准备完整包并审阅");
      expect(ui.errors.at(-1)).toContain("upload receipt lost");
      const first = [...ui.calls];
      ui.dispose(); ui = fixture(handler, "skills", true); await ui.flush();
      await ui.click("查询并继续原准备");
      expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
      expect(first.filter(call => call.action === "files.previewLocal")).toHaveLength(1);
      expect(ui.calls.some(call => call.action === "files.previewLocal" || call.action === "skills.create")).toBe(false);
      expect(ui.calls.find(call => call.action === "skills.recordVersion").payload.snapshotId).toBe("fixed-source");
      expect(saved.has("sa-skill-prepare:target-a")).toBe(false);
    } finally { ui.dispose(); window.localStorage = originalStorage; }
  });

  it("does not silently capture changed local source bytes when the first capture receipt is unknown", async () => {
    let captures = 0;
    const ui = fixture(service(action => {
      if (action === "files.previewLocal") { captures++; throw new Error("capture receipt lost"); }
    }), "skills", true);
    try {
      await ui.flush(); await ui.click("来源与更新"); ui.change("DSH 本机来源目录", "/local/skill"); await ui.click("准备完整包并审阅");
      await ui.click("查询并继续原准备");
      expect(captures).toBe(1);
      expect(ui.errors.at(-1)).toContain("不能暗中重新读取");
      expect(ui.calls.some(call => call.action === "files.syncLocal" || call.action === "skills.recordVersion")).toBe(false);
    } finally { ui.dispose(); }
  });

  it("reviews the original uploaded snapshot after a lost version receipt even when the source has newer content", async () => {
    const ui = fixture(service(action => {
      if (action === "skills.list") return { items: [{ ...origin, revision: 3, versions: ["original-upload", "newer-source"] }] };
      if (action === "files.localUploads") return { items: [{ operationId: "local-original", workspaceId: "skill:origin", status: "succeeded", snapshot: { snapshotId: "original-upload" } }] };
    }), "skills", true);
    try {
      await ui.flush(); await ui.click("继续审阅已上传的原内容");
      expect(ui.calls.some(call => call.action === "skills.recordVersion")).toBe(false);
      expect(ui.calls.find(call => call.action === "skills.previewImport").payload).toMatchObject({ sourceId: "origin", snapshotId: "original-upload" });
      expect(ui.errors).toEqual([]);
    } finally { ui.dispose(); }
  });

  it("keeps an update a fixed-package update instead of converting alias edits into a new import", async () => {
    const record = { installationId: "installed", originSourceId: "origin", sourceId: "managed", workspaceId: "project", revision: 1,
      name: "review", skillId: "review", description: "Review a patch", targetPath: item.targetPath, enabled: false };
    const ui = fixture(service(action => {
      if (action === "skills.installations") return { items: [record] };
      if (action === "skills.list") return { items: [origin] };
      if (action === "skills.previewUpdate") return { ...plan, kind: "update" };
    }), "skills", true);
    try {
      await ui.flush(); await ui.click("检查更新");
      expect(ui.field("采用名称／新别名").props.readOnly).toBe(true);
      ui.change("采用名称／新别名", "unreviewed-new-import");
      expect(ui.calls.some(call => call.action === "skills.previewImport")).toBe(false);
      expect(ui.all().some(node => node.type === "input" && node.props.type === "checkbox" && node.props.disabled)).toBe(true);
      expect(ui.all().some(node => text(node) === "按所选项重新预检")).toBe(false);
    } finally { ui.dispose(); }
  });
});
