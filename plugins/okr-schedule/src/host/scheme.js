import fs from "node:fs/promises";
import path from "node:path";
import { dataOf, stateValue, fail, hash, id, assertUser, safeId, clone } from "./protocol.js";
import { validateTool } from "./tool-runner.js";
const WIDGETS = /* @__PURE__ */ new Set(["summary", "table", "list", "trend", "categories", "markdown", "form", "actions"]);
function validateBundle(bundle) {
  if (!bundle || !Array.isArray(bundle.types) || !bundle.types.length || !Array.isArray(bundle.tools) || !Array.isArray(
  bundle.page)) throw new Error("方案必须包含事项类型、工具和页面");
  if (bundle.types.length > 32 || bundle.tools.length > 32 || bundle.page.length > 32) throw new Error("方案超出首版规模");
  const seen = /* @__PURE__ */ new Set();
  for (const type of bundle.types) {
    if (!safeId(type.id) || seen.has(type.id) || !Array.isArray(type.fields)) throw new Error("事项类型标识或字段错误");
    seen.add(type.id);
    if (!Number.isInteger(Number(type.version)) || Number(type.version) < 1) throw new Error("类型需要正整数版本");
    const fields = /* @__PURE__ */ new Set();
    for (const field of type.fields) {
      if (!safeId(field.id) || fields.has(field.id) || !["text", "boolean", "integer", "decimal", "date", "datetime", "c\
ategory", "reference"].includes(field.kind)) throw new Error("字段定义无效或尚不支持");
      fields.add(field.id);
    }
  }
  const toolIds = /* @__PURE__ */ new Set();
  for (const tool of bundle.tools) {
    if (toolIds.has(tool.id)) throw new Error("工具标识重复");
    toolIds.add(tool.id);
    validateTool(tool, bundle.types);
  }
  for (const widget of bundle.page) {
    if (!WIDGETS.has(widget.kind)) throw new Error("页面包含尚未支持的组件");
    if (widget.toolId && !bundle.tools.some((tool) => tool.id === widget.toolId && tool.commands[widget.command])) throw new Error(
    "页面操作没有有效工具");
    if (widget.typeId && !seen.has(widget.typeId)) throw new Error("页面引用未知类型");
    if (widget.kind === "markdown" && /<\/?(?:script|iframe|object)|javascript:|data:/i.test(widget.content || "")) throw new Error(
    "正文含不支持的可执行内容");
  }
  return true;
}
function compatibility(bundle, current) {
  const changes = [];
  for (const type of bundle.types) {
    const previous = current.types.find((old) => old.id === type.id);
    if (!previous) {
      changes.push({ typeId: type.id, kind: "new_type" });
      continue;
    }
    if (hash(previous.fields) !== hash(type.fields)) changes.push({ typeId: type.id, kind: "rule_change", from: previous.
    version, to: type.version, required: type.fields.filter((field) => field.required).map((field) => field.id) });
  }
  for (const type of current.types) if (!bundle.types.some((next) => next.id === type.id)) changes.push({ typeId: type.id,
  kind: "retired_type" });
  const changed = new Set(changes.filter((change) => change.kind !== "new_type").map((change) => change.typeId));
  return { changes, affectedItems: current.items.filter((item) => changed.has(item.typeId)).length, historyPolicy: "保留旧事\
项原值与类型版本；批量修改另行确认", snapshotHash: hash(current.items.map((item) => [item.id, item.revision,
  item.typeVersion])) };
}
function createSchemeService({ baseDir, domain, adapter, runner }) {
  const host = (binding) => ({ ...binding, trusted: true });
  const get = async (namespace, key, binding) => stateValue(await domain.execute("host.state.get", { namespace, key }, host(
  binding)));
  const set = async (namespace, key, value, expectedRevision, binding) => domain.execute("host.state.set", { namespace, key,
  value, expectedRevision }, host(binding));
  async function getBundle(binding) {
    const state = await get("scheme", "active", binding);
    return state?.value?.bundle || null;
  }
  async function saveDraft(bundle, binding) {
    validateBundle(bundle);
    const old = await get("scheme", "draft", binding);
    const active = await getBundle(binding);
    const current = dataOf(await domain.execute("space.read", {}, binding));
    const draft = { id: old?.value?.id || id("draft"), bundle: { ...bundle, id: id("bundle") }, baseBundleId: old?.value?.
    baseBundleId ?? active?.id ?? current.space.activeBundleId ?? null, createdAt: old?.value?.createdAt || (/* @__PURE__ */ new Date()).
    toISOString(), review: null };
    draft.hash = hash(draft.bundle);
    draft.compatibility = compatibility(draft.bundle, current);
    return set("scheme", "draft", draft, old?.revision || 0, binding);
  }
  async function prepareFiles(bundle, binding) {
    if (!safeId(binding.objectiveId) || !safeId(bundle.id)) throw new Error("空间或方案标识错误");
    const root = await fs.realpath(baseDir), space = await fs.realpath(path.join(root, binding.objectiveId));
    if (path.dirname(space) !== root) throw new Error("空间目录越界");
    const target = path.join(space, "bundles", bundle.id);
    const parent = path.dirname(target);
    for (const directory of [parent, target]) {
      try {
        if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("方案目录不能是符号链接");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await fs.mkdir(target, { recursive: true, mode: 448 });
    if (!(await fs.realpath(target)).startsWith(space + path.sep)) throw new Error("方案目录越界");
    const manifest = { id: bundle.id, hash: hash(bundle), types: bundle.types.map((type) => ({ id: type.id, version: type.
    version })) };
    const files = { "manifest.json": manifest, "bundle.json": bundle, "types.json": bundle.types, "page.json": bundle.page };
    for (const [name, value] of Object.entries(files)) {
      const text = JSON.stringify(value, null, 2), file = path.join(target, name);
      try {
        try {
          if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("方案文件不能是符号链接");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await fs.writeFile(file, text, { flag: "wx", mode: 384 });
      } catch (error) {
        if (error.code !== "EEXIST" || await fs.readFile(file, "utf8") !== text) throw error;
      }
    }
    return manifest;
  }
  async function review(binding) {
    const state = await get("scheme", "draft", binding);
    if (!state?.value) return fail("NO_DRAFT", "当前没有草稿");
    const draft = state.value;
    const results = [];
    for (const tool of draft.bundle.tools) for (const [command, decl] of Object.entries(tool.commands)) {
      const examples = decl.examples || [];
      if (!examples.length) results.push({ toolId: tool.id, command, passed: false, error: "缺少可运行样例" });
      for (let n = 0; n < examples.length; n++) {
        const result = await runner.run({ bundle: draft.bundle, toolId: tool.id, command, input: examples[n], requestId: `\
review:${draft.id}:${draft.hash}:${tool.id}:${command}:${n}` }, { ...binding, trusted: true, executionScope: "trial", provenance: "\
demo", draftId: draft.id, types: draft.bundle.types });
        results.push({ toolId: tool.id, command, passed: ["trial", "read", "saved"].includes(result.kind), result });
      }
    }
    const current = dataOf(await domain.execute("space.read", {}, binding));
    const report = { hash: draft.hash, results, passed: results.length > 0 && results.every((result) => result.passed), createdAt: (/* @__PURE__ */ new Date()).
    toISOString() };
    return set("scheme", "draft", { ...draft, compatibility: compatibility(draft.bundle, current), review: report }, state.
    revision, binding);
  }
  async function execute(command, input = {}, binding = {}) {
    try {
      if (command === "scheme.active") return { kind: "read", data: { bundle: await getBundle(binding) } };
      if (command === "scheme.get") return { kind: "read", data: { draft: await get("scheme", "draft", binding), active: await getBundle(
      binding) } };
      if (command === "scheme.history") return domain.execute("host.state.list", { namespace: "bundle" }, host(binding));
      if (command === "scheme.create") {
        assertUser(binding);
        const objectiveId = input.objectiveId || id("O");
        dataOf(await domain.execute("space.create", { objectiveId, title: input.title || "新空间", purpose: input.purpose,
        lifecycle: "draft", types: [] }, { ...binding, objectiveId, trusted: true }));
        return { kind: "saved", data: { objectiveId, lifecycle: "draft" } };
      }
      if (command === "scheme.generate") {
        if (!adapter?.available) return fail("AI_UNAVAILABLE", adapter?.disabledReason || "当前宿主没有可用的受控模型");
        let active=await getBundle(binding);
        if(!active){const snapshot=dataOf(await domain.execute('space.read',{},binding));active={id:snapshot.space.activeBundleId,title:snapshot.space.title,purpose:snapshot.space.purpose,types:snapshot.types,tools:[],page:[]};}
        const result = await adapter.generate({ binding, system: `你为空间生成受限方案，只返回一个JSON对象，包含title、description、types、tools、page。\ntypes是数组，每项{id,title,version:1,fields:[{id,title,kind,required,precision?,unit?}]}；kind仅text/boolean/integer/decimal/date/datetime/category/reference。类型与字段必须有面向用户的title。\ntools是数组，每项{id,description,skill,commands:{save或query:{input:{type:"object",properties:{title:{type:"string"},body:{type:"string"},fields:{type:"object"}}},program:[],examples:[]}}}。\n所有记录命令统一接收{title,body,fields}。业务字段只放fields，必填规则只写在types，命令input.required不要列业务字段；信息缺失由领域服务保留待整理。\n保存程序必须形如[{op:"save",typeId:"所定义的类型ID",input:{title:{ref:"input.title"},fields:{ref:"input.fields"},body:{ref:"input.body"}}}]。查询程序可形如[{op:"query",typeId:"所定义的类型ID",input:{}}]。\n引用表达式只能是一个{ref:"input.fields"}或{ref:"input.title"}这样的对象，不使用字符串插值或任意代码。每条命令都提供至少一个可实际运行的完整合成examples，字段值满足type定义。\n程序只允许query/save/update/action/execution/result/output/if，每命令最多一个业务写操作。不能执行SQL、任意源代码、路径、网络和shell。\npage是数组，每项{kind,title,typeId?,toolId?,command?}，kind仅summary/table/list/trend/categories/markdown/form/actions；toolId和command必须引用本方案已声明工具。\n只按用户需求设计类型，不预设通用兜底、财务或运动字段。保留稳定ID，改变字段含义或必填规则时提升类型version。只生成候选，不声称已启用或测试成功。`, input: JSON.stringify({ purpose: input.purpose, current: active, instruction: input.
        instruction }), schema: { type: "object" } });
        const text = typeof result === "string" ? result : result?.text || result?.answer || result?.data?.text;
        const bundle = result?.data || (typeof result === "object" && result?.types ? result : JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g,
        "")));
        return saveDraft(bundle, binding);
      }
      if (command === "scheme.draft") {
        assertUser(binding);
        return saveDraft(clone(input.bundle), binding);
      }
      if (command === "scheme.review") return review(binding);
      if (command === "scheme.trial") {
        const state = await get("scheme", "draft", binding);
        if (!state?.value) return fail("NO_DRAFT", "当前没有草稿");
        return runner.run({ ...input, bundle: state.value.bundle }, { ...binding, trusted: true, executionScope: "trial",
        provenance: "real", draftId: state.value.id, types: state.value.bundle.types });
      }
      if (command === "scheme.confirm") {
        assertUser(binding);
        const state = await get("scheme", "draft", binding), draft = state?.value;
        const previousActivation = await get("scheme", "active", binding);
        if (!draft && input.requestId && previousActivation?.value?.confirmedRequestId === input.requestId) {
          if (input.hash !== previousActivation.value.hash || hash(input.selectedTrialIds || []) !== hash(previousActivation.
          value.selectedTrialIds || [])) return fail("REQUEST_CONFLICT", "同一确认请求的内容发生变化", "con\
flict");
          const restored = await execute("scheme.resumeTransfers", {}, { ...binding, bundleId: previousActivation.value.
          bundle.id });
          return { kind: "saved", data: { bundleId: previousActivation.value.bundle.id, alreadyConfirmed: true, transfers: restored.
          data?.transfers || [] } };
        }
        if (!draft || state.revision !== input.expectedRevision || draft.hash !== input.hash) return fail("STALE_DRAFT",
        "草稿已变更，请重新审查", "conflict");
        if (!draft.review?.passed || draft.review.hash !== draft.hash) return fail("REVIEW_REQUIRED", "需要当前草稿的实际试用结果");
        const active = await get("scheme", "active", binding);
        const current = dataOf(await domain.execute("space.read", {}, binding));
        if ((active?.value?.bundle?.id || current.space.activeBundleId || null) !== draft.baseBundleId) return fail("STA\
LE_BASE", "正式方案已变化，请重算草稿", "conflict");
        if (draft.compatibility?.snapshotHash !== compatibility(draft.bundle, current).snapshotHash) return fail("STALE_\
COMPATIBILITY", "记录已变化，请重新运行试用检查并审查影响", "conflict");
        await prepareFiles(draft.bundle, binding);
        const receipt = await domain.execute("host.state.commit", { updates: [{ namespace: "bundle", key: draft.bundle.id,
        value: draft.bundle, expectedRevision: 0 }, { namespace: "scheme", key: "active", value: { bundle: draft.bundle,
        hash: draft.hash, compatibility: draft.compatibility, confirmedRequestId: input.requestId || null, confirmedAt: (/* @__PURE__ */ new Date()).
        toISOString(), selectedTrialIds: input.selectedTrialIds || [], draftId: draft.id }, expectedRevision: active?.revision ||
        0 }, { namespace: "scheme", key: "draft", value: null, expectedRevision: state.revision }], types: draft.bundle.
        types, activeBundleId: draft.bundle.id, expectedBundleId: draft.baseBundleId, lifecycle: "formal" }, host(binding));
        if (receipt.kind !== "saved") return receipt;
        const transfers = [];
        for (const trialId of input.selectedTrialIds || []) transfers.push({ trialId, result: await domain.execute("tria\
l.promote", { trialId, requestId: `promote:${trialId}` }, host({ ...binding, bundleId: draft.bundle.id })) });
        await domain.execute("trial.finalize", { draftId: draft.id, selectedTrialIds: input.selectedTrialIds || [] }, host(
        { ...binding, bundleId: draft.bundle.id }));
        return { kind: "saved", data: { bundleId: draft.bundle.id, transfers } };
      }
      if (command === "scheme.resumeTransfers") {
        assertUser(binding);
        const active = await get("scheme", "active", binding);
        const transfers = [];
        for (const trialId of active?.value?.selectedTrialIds || []) transfers.push({ trialId, result: await domain.execute(
        "trial.promote", { trialId, requestId: `promote:${trialId}` }, host({ ...binding, bundleId: active.value.bundle.
        id })) });
        if (active?.value?.draftId) await domain.execute("trial.finalize", { draftId: active.value.draftId, selectedTrialIds: active.
        value.selectedTrialIds || [] }, host({ ...binding, bundleId: active.value.bundle.id }));
        return { kind: "read", data: { transfers } };
      }
      if (command === "scheme.restore") {
        assertUser(binding);
        const state = await get("bundle", input.bundleId, binding);
        if (!state?.value) return fail("NOT_FOUND", "没有此历史方案");
        return saveDraft({ ...state.value, restoredFrom: input.bundleId }, binding);
      }
      if (command === "batch.preview") {
        assertUser(binding);
        if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 100) return fail("INVALID_B\
ATCH", "每批须包含1至100条明确修改");
        const all = dataOf(await domain.execute("space.read", {}, binding));
        const items = all.items || [];
        const changes = input.changes.map((change) => {
          const item = items.find((item2) => item2.id === change.itemId);
          if (!item) throw new Error("目标事项不存在");
          return { ...change, expectedRevision: item.revision, before: item };
        });
        const plan = { id: id("plan"), changes, hash: hash(changes), createdAt: (/* @__PURE__ */ new Date()).toISOString() };
        return set("batch", plan.id, plan, 0, binding);
      }
      if (command === "batch.confirm") {
        assertUser(binding);
        const state = await get("batch", input.planId, binding);
        if (!state?.value || state.value.hash !== input.hash) return fail("STALE_PLAN", "变更计划不匹配", "confli\
ct");
        return domain.execute("items.batch", { changes: state.value.changes.map(({ before, ...change }) => change), requestId: input.
        requestId || state.value.id, planHash: state.value.hash }, { ...binding, trusted: true, confirmationPlanHash: state.
        value.hash });
      }
      return fail("UNKNOWN_COMMAND", "不支持此方案操作");
    } catch (error) {
      return error.receipt || fail(error.code || "SCHEME_ERROR", error.message);
    }
  }
  return { execute, getBundle };
}
export {
  createSchemeService,
  validateBundle
};
