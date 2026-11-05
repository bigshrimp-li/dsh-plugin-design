import { parentPort, workerData } from 'node:worker_threads';
import { createStorageContext, runDomainCommand } from './domain.js';

let context;
try {
  const { DatabaseSync } = await import('node:sqlite');
  const probe = new DatabaseSync(':memory:');
  probe.exec('PRAGMA foreign_keys=ON; CREATE VIRTUAL TABLE probe_fts USING fts5(body); BEGIN; CREATE TABLE rollback_probe(id); ROLLBACK;');
  if (probe.prepare("SELECT json_extract('{\"ok\":true}', '$.ok') AS ok").get().ok !== 1) throw new Error('JSON unavailable');
  if (probe.prepare("SELECT name FROM sqlite_master WHERE name='rollback_probe'").get()) throw new Error('Rollback unavailable');
  probe.close();
  context = createStorageContext({ baseDir: workerData.baseDir, DatabaseSync });
  parentPort.postMessage({ ready: true, available: true });
} catch {
  parentPort.postMessage({ ready: true, available: false, message: 'SQLite worker capability check failed' });
}
parentPort.on('message', message => {
  if (message.command === '__close') {
    context?.close();
    parentPort.postMessage({ id: message.id, result: { kind: 'read', data: { closed: true } } });
    return;
  }
  const result = context ? runDomainCommand(context, message.command, message.input, message.binding) : { kind: 'failed', operationId: null, data: null, error: { code: 'STORAGE_UNAVAILABLE', message: 'SQLite storage is unavailable' } };
  parentPort.postMessage({ id: message.id, result });
});
