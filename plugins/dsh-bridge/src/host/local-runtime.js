// A Host owns one connection to a data instance. The Go service owns the home lock and all work.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@super-agent/client";
import { PROTOCOL_VERSION } from "@super-agent/protocol";

const caller = "dsh-super-agent-space";
const failure = (code, message) => Object.assign(new Error(message), { code });

async function normalized(file) {
  try { return await realpath(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; return resolve(file); }
}

async function stopGeneration(home) {
  try {
    const value = (await readFile(join(home, "run/stop-generation"), "utf8")).trim();
    if (!/^\d+$/.test(value)) throw failure("INVALID_REQUEST", "Go Runtime 停止记录格式错误");
    return BigInt(value);
  } catch (error) { if (error.code === "ENOENT") return 0n; throw error; }
}

async function runtimeExecutable() {
  const override = process.env.SUPER_AGENT_RUNTIME_BINARY;
  if (override) {
    if (!isAbsolute(override)) throw failure("CONFIG_INVALID", "SUPER_AGENT_RUNTIME_BINARY 需要绝对路径");
    return override;
  }
  const directory = fileURLToPath(new URL(`../runtime/${process.platform}-${process.arch}/`, import.meta.url));
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")); }
  catch (error) { throw failure("CONFIG_INVALID", `无法读取本平台的 Go Runtime 安装清单：${error.message}`); }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch || !/^[a-f0-9]{64}$/.test(manifest.sha256)
      || manifest.protocolVersion !== PROTOCOL_VERSION) throw failure("CONFIG_INVALID", "Go Runtime 平台或清单版本不匹配");
  const file = join(directory, manifest.sha256, "super-agent-runtime");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== manifest.sha256) throw failure("CONFIG_INVALID", "Go Runtime 二进制校验失败，请重新安装插件");
  return file;
}

async function launch(options) {
  const executable = await runtimeExecutable();
  const logPath = join(options.home, "logs", "runtime-launch.log");
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(executable, ["serve", "--home", options.home, "--socket", options.socketPath], {
      detached: true, stdio: ["ignore", log.fd, log.fd], shell: false,
    });
    const processState = { ended: false, error: null, busy: false };
    child.once("exit", (code, signal) => {
      processState.ended = true;
      processState.busy = code === 75;
      if (!processState.busy) processState.error = failure("RUNTIME_START_FAILED", `Go Runtime 已退出（${code ?? signal}），请查看 ${logPath}`);
    });
    child.once("error", error => { processState.ended = true; processState.error = error; });
    child.unref();
    return processState;
  } finally { await log.close(); }
}

function missingListener(error) {
  return error?.reason === "unreachable" && ["ENOENT","ECONNREFUSED"].includes(error.cause?.code);
}

export class LocalRuntime {
  #pending;
  #generation;
  #started;
  #owner = new AbortController();
  #listeners = new Set();
  #spawned;
  #info;
  #attempts = 0;
  #retryAt = 0;
  #lastFailure;
  constructor(options, { startProcess = launch, log, readyTimeoutMs = 30_000 } = {}) {
    this.options = options;
    this.log = log;
    this.startProcess = startProcess;
    this.readyTimeoutMs = readyTimeoutMs;
    this.probe = createClient({ socketPath: options.socketPath, caller, requestTimeoutMs: 1500 });
    this.#generation = stopGeneration(options.home);
    // A corrupt generation record is surfaced on the first probe, including background start.
    this.#generation.catch(() => {});
  }

  get instanceId() { return this.#info?.instanceId; }

  start() {
    if (!this.#started) {
      this.#started = this.#watch().catch(error => {
        if (!this.#owner.signal.aborted) this.log?.warn?.(error);
      });
    }
  }

  close() {
    this.#owner.abort();
    for (const listener of this.#listeners) listener.wake();
  }

  ensure() {
    if (!this.#pending) this.#pending = this.#ensure().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #ensure() {
    const signal = this.#owner.signal;
    const deadline = Date.now() + this.readyTimeoutMs;
    const baseline = await this.#generation;
    while (!signal.aborted) {
      try {
        const info = await this.probe.getServerInfo();
        if (info?.runtimeKind !== "go" || !info.instanceId || !info.runtimeFeatures?.eventsWebSocketV1
            || !(info.protocol?.min <= PROTOCOL_VERSION && PROTOCOL_VERSION <= info.protocol.max)
            || typeof info.home !== "string" || typeof info.socketPath !== "string"
            || await normalized(info.home) !== await normalized(this.options.home)
            || await normalized(info.socketPath) !== await normalized(this.options.socketPath)) {
          throw failure("PROTOCOL_MISMATCH", "本机 socket 已被不同实例或不兼容的服务占用");
        }
        if (info.state === "ready") {
          this.#info = info; this.#attempts = 0; this.#lastFailure = undefined;
          return info;
        }
        if (info.state === "degraded") throw failure("RECOVERY_BLOCKED", "Go Runtime 正在等待恢复处理");
        if (info.state !== "starting" && info.state !== "stopping") throw failure("PROTOCOL_MISMATCH", "Go Runtime 返回了未知服务状态");
      } catch (error) {
        signal.throwIfAborted();
        if (await stopGeneration(this.options.home) !== baseline) throw failure("SERVER_STOPPING", "本机 Go Runtime 已显式停止");
        if (!missingListener(error)) throw error;
        if (this.#spawned?.ended) {
          const previous = this.#spawned;
          this.#spawned = undefined;
          if (previous.busy) {
            this.#attempts--;
            this.#retryAt = Date.now() + this.readyTimeoutMs;
          } else {
            this.#retryAt = Date.now() + Math.min(30000, 500 * 2 ** Math.min(6, this.#attempts));
            this.#lastFailure = previous.error || failure("RUNTIME_START_FAILED", "Go Runtime 启动失败");
            throw this.#lastFailure;
          }
        }
        if (!this.#spawned && Date.now() >= this.#retryAt) {
          if (this.#attempts >= 4) throw this.#lastFailure ?? failure("RUNTIME_START_FAILED", "Go Runtime 连续启动失败，请检查日志后重新加载插件");
          this.#attempts++;
          try { this.#spawned = await this.startProcess(this.options); }
          catch (error) { this.#lastFailure = error; this.#retryAt = Date.now() + Math.min(30000, 500 * 2 ** this.#attempts); throw error; }
        }
      }
      if (Date.now() >= deadline) throw failure("SERVER_STARTING", "Go Runtime 启动或恢复尚未完成");
      await delay(150, undefined, { signal });
    }
    signal.throwIfAborted();
  }

  // The startup connection serves listeners that want new events. A request with a
  // cursor or a narrower scope opens its own replayable subscription.
  async #watch() {
    const signal = this.#owner.signal;
    let instance, seq;
    let backoff = 150;
    while (!signal.aborted) {
      try {
        const info = await this.ensure();
        if (instance !== info.instanceId || seq === undefined) {
          const snapshot = await this.probe.getEventSnapshot();
          instance = snapshot.instanceId;
          seq = snapshot.eventSeq;
        }
        for await (const event of this.probe.openEventSocket({ instanceId: instance, after: seq, signal })) {
          backoff = 150;
          for (const listener of this.#listeners) listener.push(event);
          if (event.kind === "resync_required") { seq = undefined; break; }
          if (event.kind === "committed") seq = event.event.seq;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (backoff === 150) this.log?.warn?.(error);
        if (error.code === "SERVER_STOPPING") return;
      } finally {
        // Connection loss invalidates provisional text. Browser EventSource
        // reconnects with the last durable id, even if no committed frame arrived.
        for (const listener of this.#listeners) listener.finish();
      }
      await delay(backoff, undefined, { signal });
      backoff = Math.min(5000, backoff * 2);
    }
  }

  async *subscribe({ after, threadId, workspaceId, live = true, signal, instanceId }) {
    const source = AbortSignal.any([this.#owner.signal, ...(signal ? [signal] : [])]);
    const info = await this.ensure();
    if (source.aborted) return;
    if (instanceId && info.instanceId !== instanceId) { yield { kind: "resync_required", code: "ACCOUNT_CHANGED" }; return; }
    if (after !== undefined || threadId || workspaceId || live === false) {
      const scope = { ...(threadId ? { threadIds: [threadId] } : {}), ...(workspaceId ? { workspaceIds: [workspaceId] } : {}) };
      const snapshot = after === undefined ? await this.probe.getEventSnapshot(scope) : null;
      yield* this.probe.openEventSocket({ ...scope, live, after: after ?? snapshot.eventSeq,
        instanceId: snapshot?.instanceId ?? info.instanceId, signal: source });
      return;
    }
    const queue = [];
    let wake, done = false;
    const listener = {
      wake: () => wake?.(),
      finish: () => { done = true; wake?.(); },
      push: event => { if (queue.length >= 64) listener.finish(); else if (!done) { queue.push(event); wake?.(); } },
    };
    this.#listeners.add(listener);
    source.addEventListener("abort", listener.wake, { once:true });
    try {
      while (!source.aborted) {
        if (queue.length) yield queue.shift();
        else if (done) break;
        else await new Promise(resolve => { wake = resolve; });
      }
    } finally {
      source.removeEventListener("abort", listener.wake);
      this.#listeners.delete(listener);
    }
  }
}
