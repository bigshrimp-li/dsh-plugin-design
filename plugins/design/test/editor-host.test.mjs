import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditorManager } from '../dist/editor/manager.js';
import { registerEditorHost } from '../dist/editor/host.js';

test('native route boots the session workspace, reuses it and releases all listeners', async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), 'design-host-a-'));
  const b = await mkdtemp(path.join(os.tmpdir(), 'design-host-b-'));
  const pool = new EditorManager();
  let route, closed = 0;
  registerEditorHost({
    effect: fn => fn(),
    webServer: { register: value => { route = value; return () => {}; } },
    sessions: { get: id => id === 'live' ? { header: { cwd: a } } : undefined },
    sessionPersistence: { open: async id => {
      if (id === 'unknown') throw new Error('会话不存在');
      return { header: { cwd: id === 'cold' ? b : undefined }, close: async () => { closed++; } };
    } },
  }, pool);
  const server = http.createServer(route.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = (id, headers = {}, method = 'POST') => fetch(`${base}/design-editor/open?sessionId=${id}`, { method, headers });
  try {
    const first = await (await open('live')).json();
    assert.equal(first.workspace, a);
    assert.equal((await fetch(first.url + 'api/workspace')).status, 200);
    assert.equal((await (await open('live')).json()).url, first.url);
    const cold = await (await open('cold')).json();
    assert.equal(cold.workspace, b);
    assert.notEqual(cold.url, first.url);
    assert.equal(closed, 1);
    assert.equal((await open('empty')).status, 422);
    assert.equal((await open('unknown')).status, 500);
    assert.equal((await open('live', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await open('live', { origin: 'dsh-app://app' })).status, 200);
    assert.equal((await open('live', {}, 'GET')).status, 405);
    await pool.close();
    await assert.rejects(fetch(first.url));
    await assert.rejects(fetch(cold.url));
    await assert.rejects(pool.open(a));
  } finally {
    await pool.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.all([rm(a, { recursive: true }), rm(b, { recursive: true })]);
  }
});
