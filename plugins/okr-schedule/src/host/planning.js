import { dataOf, stateValue, fail, hash, id, assertUser } from "./protocol.js";
function createPlanningService({ domain, adapter }) {
  const get = async (key, binding) => stateValue(await domain.execute("host.state.get", { namespace: "planning", key }, {
  ...binding, trusted: true }));
  const save = (key, value, revision, binding) => domain.execute("host.state.set", { namespace: "planning", key, value, expectedRevision: revision },
  { ...binding, trusted: true });
  async function generate(system, input, binding) {
    if (!adapter?.available) throw new Error(adapter?.disabledReason || "当前宿主没有可用模型");
    const result = await adapter.generate({ binding, system, input: JSON.stringify(input), schema: { type: "object" } });
    return result.data || JSON.parse(result.text);
  }
  return { async execute(command, input, binding) {
    try {
      if (command === "plan.get" || command === "review.get") return { kind: "read", data: await get(input.id, binding) };
      if (command === "plan.generate") {
        const facts = dataOf(await domain.execute("items.query", { limit: 50 }, binding));
        const plan = await generate("根据用户目标和已授权事实提出行动建议，只输出JSON {title,assumptions:[],suggestions:[{title,reason,typeId,\
fields,body}]}。引用事实标识说明依据。不能宣称已保存或排期；未知字段留空。最多12项建议。",
        { goal: input.goal, facts, types: dataOf(await domain.execute("space.read", {}, binding)).types }, { ...binding, purpose: 'plan.generate' });
        if (!Array.isArray(plan.suggestions) || plan.suggestions.length > 12 || plan.suggestions.some((s) => !s.title)) throw new Error(
        "计划格式无效");
        const value = { ...plan, id: id("plan"), kind: "plan", adopted: {}, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
        value.hash = hash(value);
        return save(value.id, value, 0, binding);
      }
      if (command === "plan.adopt") {
        assertUser(binding);
        const state = await get(input.id, binding), plan = state?.value;
        if (!plan || plan.hash !== input.hash || !Array.isArray(input.selected)) return fail("STALE_PLAN", "请重新核对计划",
        "conflict");
        const transfers = [];
        for (const n of [...new Set(input.selected)]) {
          if (!Number.isInteger(n) || !plan.suggestions[n]) throw new Error("无效建议");
          const suggestion = plan.suggestions[n];
          const item = await domain.execute("item.save", { typeId: input.typeId || suggestion.typeId, title: suggestion.
          title, fields: suggestion.fields || {}, body: suggestion.body || suggestion.reason, requestId: `adopt:${plan.id}\
:${n}` }, binding);
          if (item.kind !== "saved") {
            transfers.push({ index: n, result: item });
            continue;
          }
          const itemId = item.data.itemId || item.data.item?.id || item.data.id;
          const action = await domain.execute("action.save", { itemId, status: "pending", ...input.schedules?.[n] ? { schedule: input.
          schedules[n] } : {}, requestId: `adopt-action:${plan.id}:${n}` }, binding);
          transfers.push({ index: n, item, action });
        }
        return { kind: transfers.every((row) => row.item?.kind === "saved" && row.action?.kind === "saved") ? "saved" : "\
pending", data: { transfers } };
      }
      if (command === "review.generate") {
        const facts = dataOf(await domain.execute("space.read", {}, binding));
        const draft = await generate("根据用户选择的阶段与正式事项、执行依据生成复盘草稿。只输出JSON {title,summary,targetId,evidenceIds:[],assumptio\
ns:[]}。不虚构执行，不修改事实，不宣称已经保存。", { question: input.question, space: facts.space, items: facts.
        items, executions: facts.executions, dimensions: facts.dimensions }, { ...binding, purpose: 'review.generate' });
        const validIds = new Set([...facts.items || [], ...facts.executions || []].map((item) => item.id));
        if (!draft.title || !Array.isArray(draft.evidenceIds) || draft.evidenceIds.some((ref) => !validIds.has(ref))) throw new Error(
        "复盘包含无效依据");
        const value = { ...draft, id: id("review"), kind: "review" };
        value.hash = hash(value);
        return save(value.id, value, 0, binding);
      }
      if (command === "review.save") {
        assertUser(binding);
        const state = await get(input.id, binding), draft = state?.value;
        if (!draft || draft.hash !== input.hash) return fail("STALE_REVIEW", "请重新核对复盘", "conflict");
        return domain.execute("result.save", { title: draft.title, body: draft.summary, targetId: draft.targetId, evidence: draft.
        evidenceIds, requestId: `review:${draft.id}` }, binding);
      }
      return fail("UNKNOWN_COMMAND", "未知规划操作");
    } catch (error) {
      return error.receipt || fail(error.code || "PLAN_ERROR", error.message);
    }
  } };
}
export {
  createPlanningService
};
