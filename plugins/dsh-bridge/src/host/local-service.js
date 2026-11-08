import { createHash } from "node:crypto";
import { join } from "node:path";
import { createCoreServiceFor, CoreServiceError } from "./core-service.js";

// Browser drafts, uncertain writes and file-transfer receipts are partitioned by
// the persistent Go instance. A database recreated at the same socket is a new target.
export function localService(runtime) {
  let binding;
  const actorId = "dsh-super-agent-space";
  const targetId = id => `local-go:${id}`;
  const target = info => ({
    local: true, generation: 0, selectedId: targetId(info.instanceId), compatibilityUds: true,
    targets: [{ id: targetId(info.instanceId), instanceId: info.instanceId, name: "本地 Go Runtime",
      baseUrl: runtime.options.socketPath, actorId, authenticated: true, connectionKind: "uds" }],
  });
  const current = async requested => {
    const info = await runtime.ensure();
    if (requested !== undefined && requested !== targetId(info.instanceId)) {
      throw new CoreServiceError("VERSION_CONFLICT", "当前 Go Runtime 数据实例与原操作不一致，请刷新工作区");
    }
    if (binding?.id !== info.instanceId) {
      const cache = createHash("sha256").update(info.instanceId).digest("hex");
      const service = createCoreServiceFor({ caller: actorId, options: {
        ...runtime.options, instanceId: info.instanceId, expectedInstanceId: info.instanceId,
        actorId, localCacheHome: join(runtime.options.home, "targets", cache),
      }});
      binding = { id: info.instanceId, service };
      service.catch(() => { if (binding?.service === service) binding = undefined; });
    }
    return { info, service: await binding.service };
  };
  return {
    options: runtime.options,
    async eventScope() { return targetId((await runtime.ensure()).instanceId); },
    observations: new Proxy({}, { get: (_, key) => typeof key === "string" && key !== "then"
      ? async (...args) => (await current()).service.observations[key](...args) : undefined }),
    async call(action, payload = {}) {
      if (action === "targets.list") return target(await runtime.ensure());
      if (action.startsWith("targets.")) throw new CoreServiceError("NOT_SUPPORTED", "本地 Go Runtime 由插件启动并连接");
      const { info, service } = await current(payload.targetId);
      if ((payload.expectedActorId && payload.expectedActorId !== actorId) ||
          (payload.expectedInstanceId && payload.expectedInstanceId !== info.instanceId)) {
        throw new CoreServiceError("TARGET_SCOPE_CHANGED", "Core 实例或操作者已变化，请重新读取目标。");
      }
      return service.call(action, payload);
    },
    async state(query) {
      try {
        const { service, info } = await current();
        return { ...await service.state(query), target: target(info) };
      } catch (error) {
        return { connection: "offline", core: { home: runtime.options.home, socketPath: runtime.options.socketPath,
          error: { code: error.code || "CONNECTION_FAILED", message: error.message } }, threads: [] };
      }
    },
    async *subscribe(input) {
      const info = await runtime.ensure();
      if (input.expectedEventScope && input.expectedEventScope !== targetId(info.instanceId)) {
        yield { kind: "resync_required", code: "ACCOUNT_CHANGED" };
        return;
      }
      yield* runtime.subscribe({ ...input, instanceId: info.instanceId });
    },
  };
}
