/** Host-owned HTTPS targets. Tokens never cross the renderer boundary. */
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:https";
import { createCoreServiceFor, CoreServiceError } from "./core-service.js";

const failure = (code, message) => new CoreServiceError(code, message);
export function normalizeTargetUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure("INVALID_REQUEST", "请输入完整的 HTTPS 地址"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw failure("INVALID_REQUEST", "Core 地址必须为 HTTPS 源地址，不能包含凭据、路径或查询参数");
  }
  return url.origin;
}

/** TLS verification remains enabled, including for loopback targets. */
export function requestTarget(target, path, { method = "GET", body, authenticated = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(new URL(path, target.baseUrl), {
      method, ...(target.ca ? { ca: target.ca } : {}), rejectUnauthorized: true,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        ...(authenticated && target.accessToken ? { Authorization: `Bearer ${target.accessToken}`, ...(target.instanceId ? { "x-core-instance-id": target.instanceId } : {}) } : {}) },
      timeout: 15000,
    }, res => {
      const chunks = []; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > 2_000_000) req.destroy(failure("INVALID_REQUEST", "Core 响应超出限制")); else chunks.push(chunk); });
      res.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reject(failure("PROTOCOL_INCOMPATIBLE", "Core 返回了无法识别的响应")); }
        if ((res.statusCode || 500) >= 400) return reject(failure(value?.error?.code || (res.statusCode === 401 ? "AUTH_REQUIRED" : "CONNECTION_FAILED"), value?.error?.message || `Core HTTP ${res.statusCode}`));
        resolve(value);
      });
    });
    req.on("timeout", () => req.destroy(failure("CONNECTION_FAILED", "Core 连接超时")));
    req.on("error", error => {
      if (error instanceof CoreServiceError) return reject(error);
      const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/.test(error.code || "");
      reject(failure(tls ? "CERTIFICATE_INVALID" : "CONNECTION_FAILED", tls ? "证书校验失败，请使用受信任的证书或配置签发 CA" : "无法连接 Core，请检查地址与服务状态"));
    });
    if (data) req.write(data);
    req.end();
  });
}

export async function openTargetService({ options, createService = createCoreServiceFor, send = requestTarget } = {}) {
  const path = `${options.home}/dsh-targets.json`;
  let document = { version: 1, selectedId: null, targets: [], legacyAllowed: true };
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.targets)) throw failure("INVALID_REQUEST", "本机 Core 入口记录格式错误");
    document = saved;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const services = new Map(), streams = new Set();
  let generation = 0, changing = Promise.resolve();
  const persist = async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(document), { mode: 0o600 });
    await rename(temporary, path); await chmod(path, 0o600);
  };
  const authenticated = target => !!target.accessToken && !(typeof target.expiresAt === "number" && target.expiresAt <= Date.now());
  const publicTarget = ({ accessToken: _token, ca: _ca, ...target }) => ({ ...target, authenticated: authenticated({ ...target, accessToken: _token }), authenticationState: !_token ? "unpaired" : authenticated({ ...target, accessToken: _token }) ? "paired" : "expired", customCa: !!_ca });
  const list = () => ({ selectedId: document.selectedId, generation, targets: document.targets.map(publicTarget), compatibilityUds: document.selectedId === null && document.legacyAllowed !== false });
  const eventScope = () => { const target = document.targets.find(item => item.id === document.selectedId); return target ? `${target.id}:${target.instanceId || "unpaired"}` : `uds:${options.socketPath}`; };
  const targetFor = payload => {
    const target = document.targets.find(item => item.id === payload?.targetId);
    if (!target) throw failure("NOT_FOUND", "找不到本机 Core 入口");
    return target;
  };
  const invalidate = () => { generation++; for (const controller of streams) controller.abort(); streams.clear(); services.clear(); };
  const current = async () => {
    const target = document.targets.find(item => item.id === document.selectedId);
    if (!target && document.legacyAllowed === false) throw failure("TARGET_NOT_SELECTED", "请在 Super Agent 设置中选择已配对的 HTTPS Core");
    const key = target?.id || "uds";
    if (target && !authenticated(target)) throw failure("AUTH_REQUIRED", target.accessToken ? "登录已过期，请在 Super Agent 设置中重新配对当前 Core" : "请先在 Super Agent 设置中配对当前 Core");
    if (!services.has(key)) services.set(key, createService({ options: target ? { ...options, baseUrl: target.baseUrl, accessToken: target.accessToken, expectedInstanceId: target.instanceId, ca: target.ca, actorId: target.actorId, localCacheHome: `${options.home}/targets/${createHash("sha256").update(`${target.id}:${target.instanceId}`).digest("hex")}` } : options, caller: "dsh-super-agent-space" }).catch(error => { services.delete(key); throw error; }));
    return services.get(key);
  };
  const actions = {
    "targets.list": async () => list(),
    "targets.save": async payload => {
      const baseUrl = normalizeTargetUrl(payload.baseUrl), existing = payload.targetId ? targetFor(payload) : document.targets.find(item => item.baseUrl === baseUrl) || null;
      const sameAddress = existing?.baseUrl === baseUrl;
      let sameInstance = sameAddress;
      if (existing?.instanceId && !sameAddress) {
        const identity = await send({ baseUrl, ...(payload.ca ? { ca: String(payload.ca) } : existing.ca ? { ca: existing.ca } : {}) }, "/v1/identity");
        sameInstance = identity.instanceId === existing.instanceId;
      }
      const entry = { id: existing && sameInstance ? existing.id : randomUUID(), name: String(payload.name || baseUrl).slice(0, 100), baseUrl,
        ...(payload.ca ? { ca: String(payload.ca) } : existing?.ca ? { ca: existing.ca } : {}) };
      if (existing && sameInstance) Object.assign(entry, { accessToken: existing.accessToken, instanceId: existing.instanceId, expiresAt: existing.expiresAt, actorId: existing.actorId });
      document.targets = [...document.targets.filter(item => item.id !== entry.id), entry]; await persist();
      if (document.selectedId === entry.id) invalidate();
      return publicTarget(entry);
    },
    "targets.test": async payload => {
      const target = targetFor(payload), identity = await send(target, "/v1/identity");
      if (typeof identity.instanceId !== "string") throw failure("PROTOCOL_INCOMPATIBLE", "Core 未提供实例标识");
      const { PROTOCOL_VERSION } = await import("@super-agent/protocol");
      if (identity.protocolVersion !== PROTOCOL_VERSION) throw failure("PROTOCOL_INCOMPATIBLE", "Core 协议版本与本机 Super Agent 不兼容，请更新到兼容版本");
      if (target.instanceId && target.instanceId !== identity.instanceId) {
        delete target.accessToken; delete target.expiresAt; await persist(); invalidate();
        throw failure("INSTANCE_CHANGED", "地址对应的 Core 实例已变化，请重新配对。旧历史不会迁移。");
      }
      target.checkedAt = new Date().toISOString(); target.lastIdentity = identity; await persist();
      return { ...identity, authenticated: authenticated(target), checkedAt: target.checkedAt };
    },
    "targets.pair": async payload => {
      const target = targetFor(payload);
      if (!payload.pairingCode || !payload.actorId) throw failure("INVALID_REQUEST", "请输入配对码和操作者标识");
      if (payload.expectedInstanceId) {
        const identity = await send(target, "/v1/identity");
        if (identity.instanceId !== payload.expectedInstanceId) throw failure("INSTANCE_CHANGED", "原配置操作尚未确认，不能向另一个实例重新配对。请恢复原实例地址后查询原操作");
      }
      const result = await send(target, "/v1/auth/pair", { method: "POST", body: { pairingCode: payload.pairingCode, actorId: payload.actorId } });
      if (!result.accessToken || !result.instanceId) throw failure("PROTOCOL_INCOMPATIBLE", "Core 没有返回有效的配对结果");
      if (payload.expectedInstanceId && result.instanceId !== payload.expectedInstanceId) throw failure("INSTANCE_CHANGED", "配对期间实例发生变化，原操作与入口保持不变");
      const pairedTarget = target.instanceId && target.instanceId !== result.instanceId ? { ...target, id: randomUUID() } : target;
      if (pairedTarget !== target) { delete target.accessToken; delete target.expiresAt; document.targets.push(pairedTarget); }
      Object.assign(pairedTarget, { accessToken: result.accessToken, instanceId: result.instanceId, expiresAt: result.expiresAt, actorId: payload.actorId });
      await persist(); invalidate(); return publicTarget(pairedTarget);
    },
    "targets.select": async payload => { const target = targetFor(payload); if (!authenticated(target)) throw failure("AUTH_REQUIRED", "请先配对或重新配对已过期的目标 Core"); document.selectedId = target.id; document.legacyAllowed = false; await persist(); invalidate(); return list(); },
    "targets.logout": async payload => {
      const target = targetFor(payload);
      let remoteRevocation = "confirmed";
      try { if (target.accessToken) await send(target, "/v1/auth/logout", { method: "POST", body: {}, authenticated: true }); }
      catch { remoteRevocation = "unknown"; }
      finally { delete target.accessToken; delete target.expiresAt; await persist(); invalidate(); }
      return { ...publicTarget(target), remoteRevocation };
    },
    "targets.remove": async payload => {
      const target = targetFor(payload); document.targets = document.targets.filter(item => item !== target);
      if (document.selectedId === target.id) document.selectedId = null;
      await persist(); invalidate(); return list();
    },
  };
  return {
    options,
    eventScope,
    observations: new Proxy({}, { get: (_target, method) => method === "then" || typeof method !== "string" ? undefined : async (...args) => (await current()).observations[method](...args) }),
    async call(action, payload) {
      if (actions[action]) {
        if (action === "targets.list") { await changing; return actions[action](payload || {}); }
        const result = changing.then(() => actions[action](payload || {}));
        changing = result.then(() => undefined, () => undefined);
        return result;
      }
      if (payload && Object.hasOwn(payload, "targetId") && payload.targetId !== document.selectedId) throw failure("VERSION_CONFLICT", "当前 Core 目标已切换，请刷新后重试");
      return (await current()).call(action, payload);
    },
    async state(query) { try { return { ...await (await current()).state(query), target: list() }; } catch (error) { return { connection: "offline", core: { error: { code: error.code, message: error.message } }, target: list(), threads: [] }; } },
    async *subscribe(input = {}) {
      const { expectedEventScope, ...subscription } = input;
      if (expectedEventScope !== undefined && expectedEventScope !== eventScope()) throw failure("VERSION_CONFLICT", "Core 目标已切换，请重新连接事件流");
      const controller = new AbortController(), at = generation;
      const abort = () => controller.abort(); input.signal?.addEventListener("abort", abort, { once: true }); streams.add(controller);
      try { for await (const event of await (await current()).subscribe({ ...subscription, signal: controller.signal })) { if (at !== generation) break; yield event; } }
      finally { streams.delete(controller); input.signal?.removeEventListener("abort", abort); }
    },
  };
}
