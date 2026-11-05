import { randomBytes } from "node:crypto";
import { safeId, fail } from "./protocol.js";
import { clientAssetPaths, serveClientAsset } from './client-assets.js';
const assistantCommands = ['assistant.list','assistant.new','assistant.select','assistant.input','assistant.send','assistant.reference'];
const PREFIX = "/okr-space/api";
const GLOBAL = /* @__PURE__ */ new Set([...assistantCommands, "calendar.catalog","calendar.range","calendar.busy","calendar.confirm","capabilities", "calendar.query", "spaces.list", "scheme.create", "group.state",
"group.send", "group.retry", "group.plan", "group.query", "group.navigate", "group.scheme"]);
const SPACE = /* @__PURE__ */ new Set([...assistantCommands,"calendar.space","calendar.range","calendar.busy","calendar.confirm","calendar.event.get","calendar.event.save","calendar.execution.save","calendar.ledger.save","calendar.k.save","calendar.feedback.save","calendar.achievement.save","calendar.layout.save","calendar.export","calendar.delete","capabilities", "workspace.state", "calendar.query", "space.inspect", "space.back\
up", "space.migrate", "items.query", "item.save", "item.update", "material.complete", "categories.save", "action.save", "\
execution.save", "result.save", "space.archive", "space.restore", "dimension.save", "dimension.archive", "dimension.rest\
ore", "operation.get", "tools.list", "tool.describe", "tool.run", "scheme.active", "scheme.get", "scheme.history", "sche\
me.generate", "scheme.draft", "scheme.review", "scheme.trial", "scheme.confirm", "scheme.resumeTransfers", "scheme.resto\
re", "trial.list", "batch.preview", "batch.confirm", "chat.send", "chat.history", "chat.status", "task.search", "task.ge\
t", "task.control", "runtime.recover", "memory.list", "memory.read", "memory.recall", "memory.update", "memory.delete", "\
context.metrics", "plan.generate", "plan.get", "plan.adopt", "review.generate", "review.get", "review.save"]);
function sameWindow(req) {
  try {
    const host = new URL(`http://${req.headers.host}`);
    const origin = req.headers.origin;
    return ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) && req.headers["sec-fetch-site"] !== "cross-site" &&
    (!origin || origin === "dsh-app://app" || new URL(origin).host === host.host);
  } catch {
    return false;
  }
}
async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 524288) throw new Error("请求超过512KiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function createHttpHandler({ service, now = () => Date.now() }) {
  const capabilities = /* @__PURE__ */ new Map();
  const reply = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-T\
ype-Options": "nosniff" });
    res.end(JSON.stringify(value));
  };
  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (await serveClientAsset(url.pathname, req, res)) return true;
    if (!url.pathname.startsWith(PREFIX + "/")) return false;
    if (!sameWindow(req)) {
      reply(res, 403, fail("FORBIDDEN", "仅允许宿主窗口或已授权的本机CLI请求"));
      return true;
    }
    try {
      if (url.pathname === PREFIX + "/bootstrap") {
        if (req.method !== "GET" || req.headers["x-okr-client"] !== "workbench") {
          reply(res, 403, fail("FORBIDDEN", "需要宿主工作台请求"));
          return true;
        }
        const objectiveId = url.searchParams.get("objectiveId") || null;
        if (objectiveId && !safeId(objectiveId)) throw new Error("无效空间标识");
        const token2 = randomBytes(32).toString("base64url");
        const workspace = objectiveId ? await service.execute("workspace.state", {}, { objectiveId, trusted: true, userInitiated: true,
        sourceScope: { kind: "private", id: objectiveId } }) : null;
        const bundleId = workspace?.data?.space?.activeBundleId || null;
        capabilities.set(token2, { objectiveId, bundleId, expires: now() + 72e5, origin: req.headers.origin || null });
        for (const [key, value] of capabilities) if (value.expires < now()) capabilities.delete(key);
        reply(res, 200, { token: token2, objectiveId, expiresIn: 7200 });
        return true;
      }
      if (url.pathname !== PREFIX + "/action" || req.method !== "POST") {
        reply(res, 405, fail("METHOD", "使用POST action"));
        return true;
      }
      if (!String(req.headers["content-type"]).startsWith("application/json")) {
        reply(res, 415, fail("CONTENT_TYPE", "需要JSON请求"));
        return true;
      }
      const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
      const cap = capabilities.get(token);
      if (!cap || cap.expires < now() || cap.origin && cap.origin !== req.headers.origin) {
        reply(res, 403, fail("CAPABILITY_EXPIRED", "请求凭据过期，请刷新空间"));
        return true;
      }
      const input = await body(req);
      if (!(cap.objectiveId ? SPACE : GLOBAL).has(input.command)) {
        reply(res, 403, fail("FORBIDDEN", "此入口未开放该操作"));
        return true;
      }
      if (input.input?.objectiveId && cap.objectiveId && input.input.objectiveId !== cap.objectiveId) {
        reply(res, 403, fail("FORBIDDEN", "请求空间与调用凭据不一致"));
        return true;
      }
      const binding = { objectiveId: cap.objectiveId, sourceScope: { kind: "private", id: cap.objectiveId }, trusted: true,
      userInitiated: true, bundleId: cap.bundleId, global: !cap.objectiveId };
      const result = await service.execute(input.command, input.input || {}, binding);
      reply(res, 200, result);
      return true;
    } catch (error) {
      reply(res, 400, fail("INVALID_REQUEST", error.message));
      return true;
    }
  };
}
function registerRoutes({ webServer, effect, service }) {
  const handler = createHttpHandler({ service });
  for (const path of [PREFIX + "/bootstrap", PREFIX + "/action", ...clientAssetPaths]) {
    effect(() => webServer.register({ kind: "exact", path, handler }));
  }
}
export {
  createHttpHandler,
  registerRoutes
};
