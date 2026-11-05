import { Worker } from 'node:worker_threads';
import path from 'node:path';

/** Owns the worker only. SQLite is never imported on the Host event loop. */
export function createSqliteStorage({ baseDir } = {}) {
  if (!baseDir || !path.isAbsolute(baseDir)) throw new TypeError('baseDir must be an absolute path');
  let worker;
  let closed = false;
  let sequence = 0;
  const pending = new Map();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const [major, minor] = process.versions.node.split('.').map(Number);
  const unavailable = message => ({ kind: 'failed', operationId: null, data: null, error: { code: 'STORAGE_UNAVAILABLE', message } });
  if (major < 22 || (major === 22 && minor < 19)) {
    readyResolve({ available: false, message: 'SQLite storage requires Node.js >=22.19.0' });
  } else {
    try { worker = new Worker(new URL('./storage-worker.js', import.meta.url), { workerData: { baseDir }, execArgv: [] }); }
    catch { readyResolve({ available: false, message: 'This Host cannot start a SQLite worker' }); }
    worker?.on('message', message => {
      if (message.ready) { readyResolve(message); return; }
      const handler = pending.get(message.id);
      if (handler) { pending.delete(message.id); handler(message.result); }
    });
    const fail = () => {
      readyResolve({ available: false, message: 'SQLite worker is unavailable' });
      for (const resolve of pending.values()) resolve(unavailable('SQLite worker stopped'));
      pending.clear();
    };
    worker?.on('error', fail);
    worker?.on('exit', fail);
  }
  return {
    async capabilities() { const status = await ready; return { sqlite: status.available === true, worker: status.available === true, minimumNode: '22.19.0', reason: status.message || null }; },
    async execute(command, input = {}, binding = {}) {
      const status = await ready;
      if (closed || !status.available) return unavailable(closed ? 'Storage is closed' : status.message);
      const id = ++sequence;
      return new Promise(resolve => { pending.set(id, resolve); worker.postMessage({ id, command, input, binding }); });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (worker) {
        const status = await ready;
        if (status.available) {
          const id = ++sequence;
          await new Promise(resolve => { pending.set(id, resolve); worker.postMessage({ id, command: '__close' }); });
        }
        await worker.terminate();
      }
    }
  };
}
