import { dataOf, fail, hash, id } from "./protocol.js";
const OPS = /* @__PURE__ */ new Set(["query", "save", "update", "action", "execution", "result", "output", "if"]);
const COMMANDS = { query: "items.query", save: "item.save", update: "item.update", action: "action.save", execution: "ex\
ecution.save", result: "result.save" };
const PATH = /^[A-Za-z0-9_.-]+$/;
function readPath(value, key) {
  if (!PATH.test(key) || key.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part))) throw new Error(
  "非法字段引用");
  return key.split(".").reduce((obj, part) => obj?.[part], value);
}
function resolve(value, context, depth = 0) {
  if (depth > 20) throw new Error("表达式过深");
  if (Array.isArray(value)) return value.map((item) => resolve(item, context, depth + 1));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.ref === "string") return readPath(context, value.ref);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("非法字段");
      return [key, resolve(item, context, depth + 1)];
    }));
  }
  return value;
}
function validateTool(tool, types) {
  if (!tool || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.id) || !tool.description || !tool.commands || typeof tool.commands !==
  "object") throw new Error("工具声明缺少标识、说明或命令");
  for (const [name, command] of Object.entries(tool.commands)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !Array.isArray(command.program) || !command.program.length) throw new Error(
    "工具命令格式错误");
    let count = 0, writes = 0;
    const walk = (nodes) => {
      for (const node of nodes) {
        if (["save", "update", "action", "execution", "result"].includes(node.op) && ++writes > 1) throw new Error("每个命令\
最多一个业务写操作");
        if (++count > 100 || !OPS.has(node.op)) throw new Error("程序超出预算或使用不支持的操作");
        if (node.op === "if") {
          if (!["eq", "present"].includes(node.test)) throw new Error("不支持的条件");
          walk(node.then || []);
          walk(node.else || []);
        } else if (node.typeId && !types.some((type) => type.id === node.typeId)) throw new Error("工具引用不存在的事项类型");
      }
    };
    walk(command.program);
  }
  return true;
}
function normalizeRecordInput(input,declaration,types){
  const normalized={...input};
  const businessInputs=new Set();
  const assign=(reference,value,business=false)=>{
    if(typeof reference!=='string'||!/^input\.[A-Za-z0-9_-]+$/.test(reference))return;
    const key=reference.slice(6);
    if(['__proto__','prototype','constructor'].includes(key))throw new Error('非法命令输入字段');
    if(business)businessInputs.add(key);
    if(value===undefined||key==='fields')return;
    if(normalized[key]!==undefined&&JSON.stringify(normalized[key])!==JSON.stringify(value))throw new Error(`字段 ${key} 的两种输入表示不一致`);
    normalized[key]=value;
  };
  const walk=nodes=>{for(const node of nodes){
    if(node.op==='if'){walk(node.then||[]);walk(node.else||[]);continue;}
    if(!['save','update'].includes(node.op))continue;
    const type=types.find(type=>type.id===node.typeId);
    for(const field of type?.fields||[])if(Object.hasOwn(declaration.input?.properties||{},field.id))assign(`input.${field.id}`,input.fields?.[field.id],true);
    assign(node.input?.title?.ref,input.title);assign(node.input?.body?.ref,input.body);
    if(node.input?.fields&&typeof node.input.fields==='object'&&!node.input.fields.ref){
      for(const [fieldId,expression] of Object.entries(node.input.fields))assign(expression?.ref,input.fields?.[fieldId],true);
    }
  }};
  walk(declaration.program);
  return {input:normalized,businessInputs};
}
function createToolRunner({ domain, getBundle }) {
  async function run({ bundle, toolId, command, input = {}, requestId }, binding) {
    try {
      bundle ||= await getBundle(binding);
      if (binding.executionScope !== "trial" && binding.bundleId != null && bundle && binding.bundleId !== bundle.id) return fail(
      "BUNDLE_CONFLICT", "当前方案已变化，请重新接纳任务", "conflict");
      if (!bundle) return fail("NO_BUNDLE", "当前空间尚无已确认方案", "unsupported");
      const tool = bundle.tools?.find((item) => item.id === toolId);
      if (!tool?.commands?.[command]) return fail("UNSUPPORTED", "当前版本不支持此命令", "unsupported");
      validateTool(tool, bundle.types || []);
      const declaration = tool.commands[command];
      const normalized=normalizeRecordInput(input,declaration,bundle.types||[]);input=normalized.input;
      for (const [key, schema] of Object.entries(declaration.input?.properties || {})) {
        if (input[key] !== void 0 && schema.type && !{ string: (v) => typeof v === "string", number: (v) => typeof v ===
        "number" && Number.isFinite(v), integer: Number.isInteger, boolean: (v) => typeof v === "boolean", object: (v) => v &&
        typeof v === "object" && !Array.isArray(v), array: Array.isArray }[schema.type]?.(input[key])) return fail("INVA\
LID_INPUT", `字段 ${key} 类型不正确`);
      }
      for (const key of declaration.input?.required || []) if (!normalized.businessInputs.has(key) && (input[key] === void 0 || input[key] === null || input[key] ===
      "")) return fail("INVALID_INPUT", `缺少命令输入 ${key}`);
      const context = { input, results: {} };
      let result = { kind: "read", data: {} };
      let count = 0;
      const exec = async (nodes) => {
        for (const node of nodes) {
          if (++count > 100) throw new Error("工具程序节点超出预算");
          if (node.op === "if") {
            const value = resolve(node.value, context);
            const branch = await exec((node.test === "present" ? value !== void 0 && value !== null && value !== "" : value ===
            resolve(node.equals, context)) ? node.then || [] : node.else || []);
            if (branch === false) return false;
            continue;
          }
          if (node.op === "output") {
            result = { ...result, data: result.kind === "read" ? resolve(node.value, context) : { ...result.data, projection: resolve(
            node.value, context) } };
            continue;
          }
          const op = COMMANDS[node.op];
          if (!op) throw new Error("不支持的程序操作");
          if (op !== "items.query" && !requestId) {
            result = fail("INVALID_INPUT", "写入需要稳定requestId");
            return false;
          }
          if (binding.executionScope === "trial" && !["items.query", "item.save"].includes(op)) {
            result = fail("TRIAL_WRITE_FORBIDDEN", "此操作不支持草稿试用写入");
            return false;
          }
          if (binding.allowedActions && !binding.allowedActions.includes(op) && !binding.allowedActions.includes("*") &&
          !(op === "items.query" && binding.allowedActions.includes("read")) && !(op !== "items.query" && binding.allowedActions.
          some((action) => ["write", "record"].includes(action)))) throw new Error("任务未获准执行此动作");
          const args = { ...resolve(node.input || {}, context), ...node.typeId ? { typeId: node.typeId } : {}, requestId: `${requestId ||
          id("read")}:${count}` };
          if (op === "items.query") args.limit = Math.min(Number(args.limit) || 50, 500);
          result = await domain.execute(op, args, { ...binding, bundleId: binding.executionScope === "trial" ? void 0 : bundle.
          id, types: binding.executionScope === "trial" ? bundle.types : binding.types });
          if (["failed", "conflict", "unsupported", "pending"].includes(result.kind)) return false;
          if (node.as) context.results[node.as] = result.data;
        }
        return true;
      };
      await exec(declaration.program);
      if (Buffer.byteLength(JSON.stringify(result)) > 262144) return fail("RESULT_TOO_LARGE", "结果超过256KiB，请缩小范围或分页");
      return result;
    } catch (error) {
      return error.receipt || fail(error.code || "INVALID_PROGRAM", error.message);
    }
  }
  return { run, async execute(command, input, binding) {
    const bundle = await getBundle(binding);
    if (command === "tools.list") return { kind: "read", data: { tools: (bundle?.tools || []).map(({ id: id2, description,
    commands }) => ({ id: id2, description, commands: Object.keys(commands) })) } };
    if (command === "tool.describe") {
      const tool = bundle?.tools?.find((tool2) => tool2.id === input.toolId);
      return tool ? { kind: "read", data: { ...tool, types: bundle.types, skill: tool.skill || `${tool.description}
使用本空间已声明命令，成功以kind=saved的回执为准。`, bundleId: bundle.id } } : fail("UNSUPPORTED", "\
当前空间没有此工具", "unsupported");
    }
    if (command === "tool.run") return run(input, binding);
    return domain.execute(command, input, binding);
  } };
}
export {
  createToolRunner,
  validateTool
};
