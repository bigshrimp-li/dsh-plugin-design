import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startEditor } from '../dist/editor/server.js';

async function setup(t) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'design-api-'));
  await cp(new URL('./editor-fixtures/simple-ui/', import.meta.url), path.join(workspace, 'simple-ui'), { recursive: true });
  const editor = await startEditor({ workspaceDir: workspace });
  t.after(async () => { await editor.close(); await rm(workspace, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const res = await fetch(new URL(route, editor.url), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvas: 'simple-ui', board: 'Profile.dc.html', ...body }) } : undefined);
    return { status: res.status, body: await res.json() };
  };
  const snapshot = (await request('/api/board?canvas=simple-ui&board=Profile.dc.html')).body;
  return { request, snapshot, file: path.join(workspace, 'simple-ui', 'Profile.dc.html') };
}

test('concurrent stale edits are rejected and retry uses the latest revision', async t => {
  const { request, snapshot, file } = await setup(t);
  const h = snapshot.elements.find(e => e.tag === 'h1');
  const p = snapshot.elements.find(e => e.tag === 'p');
  const results = await Promise.all([
    request('/api/edit', { tid: h.tid, style: 'color: red', revision: snapshot.revision }),
    request('/api/edit', { tid: p.tid, style: 'font-size: 22px', revision: snapshot.revision }),
  ]);
  assert.deepEqual(results.map(r=>r.status).sort(), [200,409]);
  const latest=(await request('/api/board?canvas=simple-ui&board=Profile.dc.html')).body;
  const failed=results[0].status===409 ? {tid:h.tid,style:'color: red'} : {tid:p.tid,style:'font-size: 22px'};
  assert.equal((await request('/api/edit',{...failed,revision:latest.revision})).status,200);
  const source = await readFile(file, 'utf8');
  assert.match(source, /color: red/);
  assert.match(source, /font-size: 22px/);
  assert.equal((await request('/api/undo', {})).status, 200);
  assert.equal((await request('/api/undo', {})).status, 200);
  assert.equal(await readFile(file, 'utf8'), snapshot.source);
});
test('conflicted undo retains its history entry', async t => {
  const { request, snapshot, file } = await setup(t);
  const h = snapshot.elements.find(e => e.tag === 'h1');
  await request('/api/edit', { tid: h.tid, style: 'color: red', revision: snapshot.revision });
  const changed = await readFile(file, 'utf8');
  await writeFile(file, changed + '\n<!-- outside -->');
  assert.equal((await request('/api/undo', {})).status, 409);
  await writeFile(file, changed);
  assert.equal((await request('/api/undo', {})).body.changed, true);
  assert.equal(await readFile(file, 'utf8'), snapshot.source);
});
test('no-op edits keep undo state and revision', async t => {
  const { request, snapshot } = await setup(t);
  const h = snapshot.elements.find(e => e.tag === 'h1');
  const first = await request('/api/edit', { tid: h.tid, style: 'color: red', revision:snapshot.revision });
  const next = await request('/api/edit', { tid: h.tid, style: 'color: red', revision: first.body.revision });
  assert.equal(next.body.changed, false);
  assert.equal(next.body.canUndo, true);
  assert.equal(next.body.revision, first.body.revision);
});

test('writes require a revision and reject cross-board source references', async t => {
 const {request,snapshot}=await setup(t); const h=snapshot.elements.find(e=>e.tag==='h1');
 assert.equal((await request('/api/edit',{tid:h.tid,style:'color:red'})).status,400);
 assert.equal((await request('/api/edit',{tid:h.tid,style:'color:red',revision:snapshot.revision,sourceRef:{canvas:'simple-ui',board:'Layout.dc.html',revision:snapshot.revision,tid:h.tid}})).status,409);
});
