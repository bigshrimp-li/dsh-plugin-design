#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
const help = "okr-space tools list --json\nokr-space tool describe <tool_id> --json\nokr-space tool run <tool_id> <command\
> --input - --request-id <id>\nokr-space operation get <operation_id> --json\n由Host通过继承文件描述符OKR_CONTEXT_FD交接当前空间调用凭据。凭据不接受\
命令行或普通环境变量。";
if (argv.includes("--help") || !argv.length) {
  process.stdout.write(help + "\n");
  process.exit(0);
}
let result;
try {
  const descriptor = Number(process.env.OKR_CONTEXT_FD);
  if (!Number.isInteger(descriptor) || descriptor < 3) throw Object.assign(new Error("缺少Host继承的空间调用描述符"),
  { code: "SCOPE_REQUIRED" });
  const context = JSON.parse(fs.readFileSync(descriptor, { encoding: "utf8" }));
  const target = new URL(context.url);
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) throw new Error("Ho\
st地址无效");
  let command, input = {};
  if (argv[0] === "tools" && argv[1] === "list") command = "tools.list";
  else if (argv[0] === "tool" && argv[1] === "describe") {
    command = "tool.describe";
    input = { toolId: argv[2] };
  } else if (argv[0] === "tool" && argv[1] === "run") {
    command = "tool.run";
    const offset = argv.indexOf("--request-id");
    if (offset < 0 || !argv[offset + 1] || !argv.includes("--input") || argv[argv.indexOf("--input") + 1] !== "-") throw new Error(
    "run需要--input -和--request-id");
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 524288) throw new Error("输入过大");
    }
    input = { toolId: argv[2], command: argv[3], input: JSON.parse(text), requestId: argv[offset + 1] };
  } else if (argv[0] === "operation" && argv[1] === "get") {
    command = "operation.get";
    input = { operationId: argv[2] };
  } else throw new Error("未知命令，使用--help");
  const response = await fetch(new URL("/okr-space/api/action", target), { method: "POST", headers: { "Content-Type": "a\
pplication/json", Authorization: `Bearer ${context.token}` }, body: JSON.stringify({ command, input }), signal: AbortSignal.
  timeout(12e4) });
  result = await response.json();
  process.exitCode = response.ok ? { conflict: 4, failed: 5, error: 5, rejected: 3 }[result.kind] || 0 : 3;
} catch (error) {
  result = { kind: "failed", error: { code: error.code || "INVALID_INPUT", message: error.message } };
  process.exitCode = error.code === "SCOPE_REQUIRED" ? 3 : 2;
}
process.stdout.write(JSON.stringify(result) + "\n");
