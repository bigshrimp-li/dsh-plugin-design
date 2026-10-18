import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DesignSpaceService } from '../dist/design-space/service.js';
import { checkCanvas } from '../dist/check/canvas-check.js';
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'design-space-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const service = new DesignSpaceService(path.join(root, 'registry.json'));
  const entry = await service.register(workspace);
  return { root, workspace, service, entry };
}
test('directory identity, display name, hidden discovery root and remove preserve files', async (t) => {
  const { service, entry, workspace, root } = await setup(t);
  await fs.symlink(workspace, path.join(root, 'alias'));
  assert.equal((await service.register(path.join(root, 'alias'))).id, entry.id);
  await service.rename(entry.id, '界面设计');
  assert.equal((await service.list()).directories[0].label, '界面设计');
  await service.remove(entry.id);
  assert.equal((await service.list()).directories.length, 0);
  assert.ok((await fs.stat(workspace)).isDirectory());
  await service.register(workspace, workspace, true);
  assert.equal((await service.list()).directories.length, 0);
  await service.register(workspace, workspace);
  assert.equal((await service.list()).directories.length, 1);
});
test('all presets produce valid canvases; retries and conflicts do not overwrite', async (t) => {
  const { service, entry, workspace } = await setup(t);
  for (const preset of ['blank', 'mobile', 'web', 'a4', 'a3']) {
    const id = 'operation-' + preset;
    const created = await service.create(entry.id, preset, '测试 <标题>', preset, id);
    assert.equal(created.status, 'ready');
    assert.deepEqual((await checkCanvas(created.target)).issues, []);
    assert.equal(
      (await service.create(entry.id, preset, '测试 <标题>', preset, id)).identity,
      created.identity
    );
  }
  const before = await fs.readFile(path.join(workspace, 'blank', 'Main.dc.html'), 'utf8');
  await assert.rejects(service.create(entry.id, 'blank', '其他', 'web', 'new-operation'), /已存在/);
  assert.equal(await fs.readFile(path.join(workspace, 'blank', 'Main.dc.html'), 'utf8'), before);
  await assert.rejects(service.create(entry.id, 'other', '标题', 'web', 'operation-blank'), /同一操作/);
  assert.equal((await service.discover(entry.id)).items.length, 5);
});
test('creation resumes after sidecar installation failed without duplicate files', async (t) => {
  const { service, entry, workspace } = await setup(t);
  const file = path.join(workspace, '.dsh', 'design-tabs.json');
  await service.create(entry.id, 'demo', '测试', 'blank', 'retry-operation');
  const s = JSON.parse(await fs.readFile(file));
  s.operations = {};
  await fs.writeFile(file, JSON.stringify(s));
  assert.equal(
    (await service.create(entry.id, 'demo', '测试', 'blank', 'retry-operation')).status,
    'ready'
  );
  s.operations = {};
  await fs.writeFile(file, JSON.stringify(s));
  await fs.appendFile(path.join(workspace, 'demo', 'Main.dc.html'), '<!-- user change -->');
  await assert.rejects(service.create(entry.id, 'demo', '测试', 'blank', 'retry-operation'), /已被修改/);
});
test('sidecar binds only same workspace; expected revision detects conflict; corrupt config preserved', async (t) => {
  const { service, entry, workspace, root } = await setup(t);
  await service.create(entry.id, 'demo', '测试', 'blank', 'binding-operation');
  await assert.rejects(service.bind(entry.id, 'demo', 's1', root), /不属于/);
  const prior = await service.links(workspace);
  await service.bind(entry.id, 'demo', 's1', workspace, prior.revision);
  await assert.rejects(service.bind(entry.id, 'demo', 's2', workspace, prior.revision), /其他窗口/);
  assert.equal((await service.describe(entry.id, 'demo')).sessionId, 's1');
  const file = path.join(workspace, '.dsh', 'design-tabs.json');
  await fs.writeFile(file, '{"version":1,"revision":2,"links":[],"operations":{}}');
  await assert.rejects(service.bind(entry.id, 'demo', 's2', workspace), /损坏/);
  assert.ok((await service.describe(entry.id, 'demo')).linkError);
  assert.match(await fs.readFile(file, 'utf8'), /"links":\[\]/);
});
test('path traversal, symlink escape, exclusive lock and malformed registry rejected', async (t) => {
  const { service, entry, workspace, root } = await setup(t);
  await fs.symlink(root, path.join(workspace, 'escape'));
  await assert.rejects(service.locate(entry.id, '../'), /无效/);
  await assert.rejects(service.locate(entry.id, 'escape'), /越界/);
  await fs.writeFile(service.stateFile + '.lock', 'another process');
  await assert.rejects(service.rename(entry.id, '新名称'), /另一个窗口/);
  await fs.rm(service.stateFile + '.lock');
  await fs.writeFile(service.stateFile, 'null');
  await assert.rejects(service.remove(entry.id), /无效/);
  assert.equal(await fs.readFile(service.stateFile, 'utf8'), 'null');
});

test('Design Space Host accepts trusted requests and binds session cwd on server', async (t) => {
  const { service, workspace } = await setup(t);
  const { registerDesignSpaceHost } = await import('../dist/design-space/host.js');
  const { EditorManager } = await import('../dist/editor/manager.js');
  const http = await import('node:http');
  const editors = new EditorManager();
  let handler;
  registerDesignSpaceHost(
    {
      effect: (fn) => fn(),
      webServer: {
        register: (route) => {
          handler = route.handler;
          return () => {};
        },
      },
      sessions: { get: (id) => (id === 'same' ? { header: { cwd: workspace } } : undefined) },
      sessionPersistence: {
        open: async () => ({ header: { cwd: path.dirname(workspace) }, close: async () => {} }),
      },
    },
    editors,
    service
  );
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await editors.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const call = async (body, headers = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call({ action: 'list' }, { Origin: 'https://example.org' })).status, 403);
  const { data: d } = await call({ action: 'register', path: workspace });
  const { data: c } = await call({
    action: 'create',
    id: d.id,
    name: 'host-demo',
    title: 'Host 测试',
    preset: 'web',
    operationId: 'host-operation',
  });
  assert.equal(c.status, 'ready');
  assert.equal(
    (await call({ action: 'bind', id: d.id, rel: 'host-demo', sessionId: 'foreign' })).status,
    409
  );
  assert.equal(
    (await call({ action: 'bind', id: d.id, rel: 'host-demo', sessionId: 'same' })).status,
    200
  );
  const result = await call({ action: 'open', id: d.id, rel: 'host-demo' });
  assert.equal(result.status, 200);
  assert.equal(result.data.canvas, 'host-demo');
  assert.equal(result.data.sessionId, 'same');
  assert.ok(result.data.url.startsWith('http://127.0.0.1:'));
  assert.equal((await call({ action: 'open', id: d.id, rel: '..' })).status, 400);
});

test('observer ignores committed editor bytes but detects an external edit on another board', async t => {
  const {workspace} = await setup(t);
  await fs.cp(new URL('./editor-fixtures/simple-ui/', import.meta.url), path.join(workspace,'canvas'), {recursive:true});
  const {startEditor}=await import('../dist/editor/server.js');
  const editor=await startEditor({workspaceDir:workspace});
  const abort=new AbortController(),events=[];
  const response=await fetch(new URL('/api/events',editor.url),{signal:abort.signal});
  const reading=(async()=>{const reader=response.body.getReader();let pending='';while(true){const {value,done}=await reader.read();if(done)return;pending+=new TextDecoder().decode(value);let end;while((end=pending.indexOf('\n\n'))>=0){const message=pending.slice(0,end);pending=pending.slice(end+2);if(message.startsWith('data: '))events.push(JSON.parse(message.slice(6)));}}})().catch(()=>{});
  t.after(async()=>{abort.abort();await reading;await editor.close();});
  const snapshot=await (await fetch(new URL('/api/board?canvas=canvas&board=Profile.dc.html',editor.url))).json();
  const heading=snapshot.elements.find(e=>e.tag==='h1');
  const result=await fetch(new URL('/api/edit',editor.url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({canvas:'canvas',board:'Profile.dc.html',tid:heading.tid,style:'color:red',revision:snapshot.revision,origin:'test'})});
  assert.equal(result.status,200);
  await new Promise(resolve=>setTimeout(resolve,1750));assert.equal(events.filter(e=>e.external).length,0);
  await fs.appendFile(path.join(workspace,'canvas','Layout.dc.html'),'\n<!-- another writer -->');
  const deadline=Date.now()+4000;while(!events.some(e=>e.external)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(events.some(e=>e.external&&e.canvas==='canvas'));
});

test('concurrent workspace registration queues writes without losing directories', async (t) => {
  const { service, root } = await setup(t);
  const roots = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const directory = path.join(root, `project-${index}`);
    await fs.mkdir(directory);
    return directory;
  }));
  const entries = await Promise.all(roots.map(directory => service.register(directory, directory, true)));
  const state = await service.state();
  assert.equal(state.directories.length, 9);
  for (const entry of entries) assert.ok(state.directories.some(item => item.id === entry.id));
  await assert.rejects(fs.stat(service.stateFile + '.lock'), { code: 'ENOENT' });
});


test('legacy single-session links migrate to multiple sessions without replacing earlier bindings', async (t) => {
  const { service, entry, workspace } = await setup(t);
  await service.create(entry.id, 'multi', '多会话设计', 'blank', 'multi-session-operation');
  const file = path.join(workspace, '.dsh', 'design-tabs.json');
  const legacy = await service.links(workspace);
  legacy.links.multi = 'legacy-session';
  await fs.writeFile(file, JSON.stringify(legacy));
  assert.deepEqual((await service.describe(entry.id, 'multi')).sessionIds, ['legacy-session']);
  await service.bind(entry.id, 'multi', 'second-session', workspace, legacy.revision);
  await service.bind(entry.id, 'multi', 'second-session', workspace);
  const restored = new DesignSpaceService(service.stateFile);
  const info = await restored.describe(entry.id, 'multi');
  assert.deepEqual(info.sessionIds, ['legacy-session', 'second-session']);
  assert.equal(info.sessionId, 'second-session');
  await assert.rejects(service.bind(entry.id, 'multi', 'third-session', workspace, legacy.revision), /其他窗口/);
  assert.deepEqual((await service.describe(entry.id, 'multi')).sessionIds, info.sessionIds);
  const invalid = await service.links(workspace);
  invalid.sessions.multi = [123];
  await fs.writeFile(file, JSON.stringify(invalid));
  await assert.rejects(service.bind(entry.id, 'multi', 'third-session', workspace), /损坏/);
});

test('a nested legacy directory becomes an independent space without moving designs or losing chats', async (t) => {
  const { service, entry, workspace } = await setup(t);
  const original = await service.create(entry.id, 'legacy', '原设计稿', 'blank', 'legacy-space-operation');
  await service.bind(entry.id, 'legacy', 'old-session', workspace);
  const nested = await service.register(original.target, workspace);
  const legacyBytes = await fs.readFile(path.join(workspace, '.dsh', 'design-tabs.json'), 'utf8');
  const sourceBytes = await fs.readFile(path.join(original.target, 'Main.dc.html'), 'utf8');
  const upgraded = await service.space(nested.id);
  assert.equal(upgraded.workspace, original.target);
  assert.equal(upgraded.legacyWorkspace, workspace);
  assert.deepEqual((await service.describe(nested.id)).sessionIds, ['old-session']);
  await service.bind(nested.id, '.', 'old-session', workspace); // Existing history stays usable.
  await assert.rejects(service.bind(nested.id, '.', 'unrelated', workspace), /不属于/);
  await service.bind(nested.id, '.', 'new-session', original.target);
  await assert.rejects(service.create(nested.id, 'second', '第二份', 'mobile', 'nested-space-operation'), /上级目录/);
  await assert.rejects(fs.stat(path.join(original.target, 'second')), { code: 'ENOENT' });
  assert.equal((await service.discover(nested.id)).items.length, 1);
  assert.deepEqual((await checkCanvas(original.target)).issues, []);
  assert.deepEqual((await service.describe(nested.id)).sessionIds, ['old-session', 'new-session']);
  assert.equal(await fs.readFile(path.join(workspace, '.dsh', 'design-tabs.json'), 'utf8'), legacyBytes);
  assert.equal(await fs.readFile(path.join(original.target, 'Main.dc.html'), 'utf8'), sourceBytes);
  const revision = (await service.links(original.target)).revision;
  await service.space(nested.id);
  assert.equal((await service.links(original.target)).revision, revision);
});

test('each canvas keeps render and export products inside its own folder', async (t) => {
  const { service, entry, workspace } = await setup(t);
  const { renderCanvas } = await import('../dist/render.js');
  const { exportCanvas } = await import('../dist/export.js');
  const first = await service.create(entry.id, 'first', '第一份', 'blank', 'output-first-operation');
  const second = await service.create(entry.id, 'second', '第二份', 'blank', 'output-second-operation');
  for (const item of [first, second]) {
    const rendered = await renderCanvas({ canvasDir: item.target, scale: 1 });
    assert.equal(rendered.outDir, path.join(item.target, '.design-preview'));
    assert.equal(rendered.boards[0].mounted, true);
    assert.ok(rendered.boards[0].pngBytes > 0);
    assert.ok(rendered.boards[0].png.startsWith(item.target + path.sep));
    const exported = await exportCanvas({ canvasDir: item.target });
    assert.equal(exported.outDir, path.join(item.target, '.design-preview', 'view'));
    assert.ok(exported.files[0].html.startsWith(item.target + path.sep));
    assert.ok(exported.files[0].bytes > 0);
    assert.deepEqual((await checkCanvas(item.target)).issues, []);
  }
  await assert.rejects(fs.stat(path.join(workspace, '.design-preview')), { code: 'ENOENT' });
});
