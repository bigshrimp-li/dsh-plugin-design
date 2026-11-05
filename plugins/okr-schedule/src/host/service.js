import { createCalendarAssistant } from "./calendar-assistant.js";
import fs from "node:fs";
import path from "node:path";
import { createDomainService } from "./domain.js";
import { createLegacyStore } from "./legacy.js";
import { createToolRunner } from "./tool-runner.js";
import { createSchemeService } from "./scheme.js";
import { createPlanningService } from "./planning.js";
import { createBotService } from "./bot.js";
import { createGroupService } from "./group.js";
import { createTraceService } from "./trace.js";
import { dataOf, fail } from "./protocol.js";
function createPluginService({ baseDir, adapter }) {
  const domain = createDomainService({ baseDir }), legacy = createLegacyStore({ baseDir });
  const trace = createTraceService({ baseDir, domain });
  const workflowAdapter = purpose => ({
    get available() { return adapter?.available; },
    get disabledReason() { return adapter?.disabledReason; },
    async generate(options) {
      const binding = { ...options.binding, purpose: options.binding?.purpose || purpose };
      let session;
      const register = async (ref, status) => {
        if (ref?.sessionId) await trace.registerWorkflow({ ...ref, purpose: binding.purpose, status }, { ...binding, trusted: true });
      };
      try {
        const result = await adapter.generate({ ...options, binding, onSession: async ref => {
          session = ref;
          await register(ref, 'running');
          await options.onSession?.(ref);
        } });
        await register(result?.trace || session, 'completed');
        return result;
      } catch (error) {
        await register(error.trace || session, 'failed');
        throw error;
      }
    }
  });
  let schemes;
  const bundleFor = async (binding) => {
    const active = await schemes.getBundle(binding);
    if (active) return active;
    const current = dataOf(await domain.execute("space.read", {}, binding));
    return { id: current.space.activeBundleId, types: current.types, page: [{ kind: "table", title: "全部记录" }], tools: current.
    types.map((type) => ({ id: `records-${type.id}`, description: `保存和查询${type.title || type.name || type.id}`,
    skill: "明确记录且信息完整时保存；缺项待整理；没有对应类型时不记录。", commands: { save: {
    program: [{ op: "save", typeId: type.id, input: { title: { ref: "input.title" }, fields: { ref: "input.fields" }, body: {
    ref: "input.body" } } }] }, query: { program: [{ op: "query", typeId: type.id, input: {} }] } } })) };
  };
  const runner = createToolRunner({ domain, getBundle: bundleFor });
  schemes = createSchemeService({ baseDir, domain, adapter: workflowAdapter('scheme.generate'), runner });
  const planning = createPlanningService({ domain, adapter: workflowAdapter('planning.generate') });
  const bot = createBotService({ baseDir, domain, adapter, toolProvider: async (binding) => [
    { name: "space_query", description: "查询本空间正式事项，返回类型、时间、分类和统计口径；不创建业务内容。",
    parameters: { type: "object", properties: { typeId: { type: "string" }, limit: { type: "integer" }, dateField: { type: "\
string" }, from: { type: "string" }, to: { type: "string" }, aggregate: { type: "object" } } }, execute: (args, callBinding = binding) => domain.
    execute("items.query", args, callBinding) },
    { name: "space_tools", description: "发现本空间已确认工具、命令和使用Skill。", parameters: { type: "\
object", properties: { toolId: { type: "string" } } }, execute: (args, callBinding = binding) => runner.execute(args.toolId ?
    "tool.describe" : "tools.list", args, callBinding) },
    { name: "space_execute", description: "按已声明工具保存或修改本空间事项。仅执行本轮用户明确要求，不支持不记录；真实成功以kind=saved为准。",
    parameters: { type: "object", properties: { toolId: { type: "string" }, command: { type: "string" }, input: { type: "\
object" }, requestId: { type: "string" } }, required: ["toolId", "command", "input", "requestId"] }, execute: (args, callBinding = binding) => runner.
    execute("tool.run", args, callBinding) },
    { name: "space_complete", description: "补齐本任务此前保留的待整理材料，沿用materialId，不另建材料。",
    parameters: { type: "object", properties: { materialId: { type: "string" }, expectedRevision: { type: "integer" }, title: {
    type: "string" }, fields: { type: "object" }, body: { type: "string" } }, required: ["materialId", "fields"] }, execute: async (args, callBinding = binding) => {
      if (callBinding.allowedActions && !callBinding.allowedActions.some((action) => ["write", "record"].includes(action)))
       return fail("FORBIDDEN", "当前委托仅允许读取或建议");
      const task = await bot.execute("task.get", { taskId: callBinding.taskId }, callBinding);
      if (!task.data?.operationReceipts?.some((receipt) => receipt.data?.materialId === args.materialId)) return fail("F\
ORBIDDEN", "只能补齐本任务实际保留的待整理材料");
      return domain.execute("material.complete", args, callBinding);
    } },
    { name: "space_modify", description: "用户明确要求修正已有事项时，按最新revision修改；不得借修改重写归档内容。",
    parameters: { type: "object", properties: { itemId: { type: "string" }, expectedRevision: { type: "integer" }, title: {
    type: "string" }, fields: { type: "object" }, body: { type: "string" } }, required: ["itemId", "expectedRevision"] },
    execute: (args, callBinding = binding) => callBinding.allowedActions && !callBinding.allowedActions.some((action) => [
    "write", "record"].includes(action)) ? fail("FORBIDDEN", "当前委托仅允许读取或建议") : domain.execute("i\
tem.update", args, callBinding) },
    { name: "space_action", description: "只在用户明确采纳行动、明确排期或打卡时写入；提出建议时不要调用。",
    parameters: { type: "object", properties: { command: { type: "string", enum: ["action.save", "execution.save"] }, input: {
    type: "object" } }, required: ["command", "input"] }, execute: (args, callBinding = binding) => !["action.save", "ex\
ecution.save"].includes(args.command) || callBinding.allowedActions && !callBinding.allowedActions.some((action) => ["wr\
ite", "record"].includes(action)) ? fail("FORBIDDEN", "当前委托没有此写入权限") : domain.execute(args.command,
    args.input, callBinding) },
    { name: "space_design", description: "用户明确要求调整页面或规则时生成草稿；不能确认启用或改写历史。",
    parameters: { type: "object", properties: { instruction: { type: "string" } }, required: ["instruction"] }, execute: (args, callBinding = binding) => callBinding.
    allowedActions && !callBinding.allowedActions.includes("design") ? fail("FORBIDDEN", "当前委托未授权调整空间") :
    schemes.execute("scheme.generate", args, { ...callBinding, userInitiated: false }) },
    { name: "space_plan", description: "用户要求规划或复盘时生成待核对的建议；不会自动保存行动、排期或R。",
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["plan", "review"] }, goal: { type: "strin\
g" } }, required: ["kind", "goal"] }, execute: (args, callBinding = binding) => planning.execute(args.kind === "review" ?
    "review.generate" : "plan.generate", { goal: args.goal, question: args.goal }, callBinding) }
  ] });
  const group = createGroupService({ baseDir, domain, bot, adapter, schemes });
  const calendarAssistant = createCalendarAssistant({ domain, adapter, calendar: (...args) => execute(...args) });
  async function execute(command, input = {}, binding = {}) {
    try {
      if (command.startsWith("assistant.")) return calendarAssistant.execute(command, input, binding);
      if (["space.inspect", "space.backup", "space.migrate"].includes(command)) return legacy.withExclusive(binding.objectiveId,
      () => domain.execute(command, input, binding));
      if (command === "capabilities") return { kind: "read", data: { ...await domain.capabilities(), bot: !!adapter?.available,
      reason: adapter?.disabledReason || null, images: false } };
      if (command === "spaces.list") {
        return domain.execute("spaces.list", {}, { ...binding, trusted: true, global: true });
      }
      if (command === "calendar.query" && !binding.objectiveId) {
        const listing = dataOf(await domain.execute("spaces.list", {}, { ...binding, trusted: true, global: true }));
        const wanted = input.objectiveIds || listing.spaces.map((space) => space.id || space.objectiveId);
        const occurrences = [], errors = [];
        for (const objectiveId of wanted) {
          if (!listing.spaces.some((space) => (space.id || space.objectiveId) === objectiveId)) {
            errors.push({ objectiveId, code: "NOT_FOUND" });
            continue;
          }
          const result = await domain.execute("calendar.query", { from: input.from, to: input.to }, { ...binding, objectiveId,
          global: false });
          if (result.kind === "read") {
            occurrences.push(...(result.data.occurrences || []).map((entry) => ({ ...entry, objectiveId })));
            if (result.data.hasMore || result.data.unsupported?.length) errors.push({ objectiveId, omitted: result.data.
            total - result.data.occurrences.length, unsupported: result.data.unsupported });
          } else errors.push({ objectiveId, error: result.error });
        }
        return { kind: "read", data: { occurrences, errors, from: input.from, to: input.to } };
      }
      if (command === "workspace.state") {
        if (!binding.objectiveId) return fail("SPACE_REQUIRED", "请先选择空间");
        if (fs.existsSync(path.join(baseDir, binding.objectiveId, "space.sqlite"))) {
          const receipt = await domain.execute("space.read", {}, binding);
          if (receipt.kind !== "read") return receipt;
          return { kind: "read", data: { ...receipt.data, migrated: true, bundle: await bundleFor(binding) } };
        }
        const old = await legacy.read({ objectiveId: binding.objectiveId });
        return { kind: "read", data: { ...old, space: old.objectives[0], migrated: false, items: [], types: [], dimensions: old.
        key_points, pending_materials: [] } };
      }
      if (command.startsWith("scheme.") || command.startsWith("batch.")) return schemes.execute(command, input, binding);
      if (command.startsWith("plan.") || command.startsWith("review.")) return planning.execute(command, input, binding);
      if (command.startsWith("group.")) return group.execute(command, input, { ...binding, groupId: "general", sourceScope: "\
group:general" });
      if (/^(chat\.|task\.|history\.|memory\.|context\.|runtime\.)/.test(command)) return bot.execute(command, input, binding);
      if (command.startsWith("tool.") || command === "tools.list") return runner.execute(command, input, binding);
      return domain.execute(command, input, binding);
    } catch (error) {
      return error.receipt || fail(error.code || "SERVICE_ERROR", error.message);
    }
  }
  return { execute, domain, legacy, bot, schemes, runner, group, trace, async close() {
    trace.close();
    await group.close?.();
    await bot.close();
    await domain.close();
  } };
}
export {
  createPluginService
};
