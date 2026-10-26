import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DesignSpaceService } from '../dist/design-space/service.js';
import { checkCanvas } from '../dist/check/canvas-check.js';
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'design-space-')));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const workspace = path.join(root, '.design');
  const service = new DesignSpaceService(workspace);
  await service.list();
  return { root, workspace, service };
}
test('fixed root reflects immediate folders and filesystem changes without registering paths', async t => {
  const { service, workspace, root } = await setup(t);
  await fs.mkdir(path.join(workspace, '外部设计'));
  await fs.mkdir(path.join(workspace, '.hidden'));
  await fs.mkdir(path.join(root, 'unrelated'));
  await fs.symlink(path.join(root, 'unrelated'), path.join(workspace, 'escape'));
  let list = await service.list();
  assert.equal(list.root, workspace);
  assert.deepEqual(list.directories.map(d => d.label), ['外部设计']);
  const id = list.directories[0].id;
  await fs.rename(path.join(workspace, '外部设计'), path.join(workspace, '文件系统改名'));
  list = await service.list();
  assert.equal(list.directories[0].id, id);
  assert.equal(list.directories[0].label, '文件系统改名');
  assert.equal((await service.ensure(id)).status, 'ready');
  await fs.rm(path.join(workspace, '文件系统改名'), { recursive:true });
  assert.equal((await service.list()).directories.length, 0);
});
test('all presets create valid drafts; repeated clicks and retries never replace content', async t => {
  const { service } = await setup(t);
  for (const preset of ['blank', 'mobile', 'web', 'a4', 'a3']) {
    const created = await service.create('operation-' + preset, preset, preset);
    assert.equal(created.status, 'ready');
    assert.deepEqual((await checkCanvas(created.target)).issues, []);
    assert.equal((await service.create('operation-' + preset, preset, preset)).identity, created.identity);
  }
  const a = await service.create('automatic-one'), b = await service.create('automatic-two');
  assert.equal(a.title, '未命名设计稿'); assert.equal(b.title, '未命名设计稿 2');
  const file = path.join(a.target, 'Main.dc.html');
  await fs.appendFile(file, '<!-- user edit -->');
  assert.equal((await service.create('automatic-one')).identity, a.identity);
  assert.match(await fs.readFile(file, 'utf8'), /user edit/);
  await assert.rejects(service.create('different-op', a.title), /已存在/);
  await assert.rejects(service.create('automatic-one', 'different'), /同一操作/);
});
test('creation receipt resumes an interrupted final save without creating a duplicate', async t => {
  const { service, workspace } = await setup(t);
  const a = await service.create('retry-operation');
  const file = path.join(workspace, '.dsh', 'operations.json');
  const state = JSON.parse(await fs.readFile(file)); state.operations = {};
  await fs.writeFile(file, JSON.stringify(state));
  assert.equal((await service.create('retry-operation')).id, a.id);
  assert.equal((await service.list()).directories.length, 1);
});
test('rename changes the folder and preserves identity, content, links and conversation copies; archive retains files', async t => {
  const { service, workspace } = await setup(t);
  const a = await service.create('rename-operation');
  await service.bind(a.id, '.', 's1', workspace);
  await service.saveConversation(a.id, 's1', { cwd:workspace }, [{ type:'user/message', data:'hello' }]);
  const original = await fs.readFile(path.join(a.target, 'Main.dc.html'));
  const renamed = await service.rename(a.id, '订单 界面');
  assert.equal(renamed.identity, a.identity);
  assert.equal(renamed.title, '订单 界面');
  assert.equal(renamed.sessionId, 's1');
  assert.equal(renamed.target, path.join(workspace, '订单 界面'));
  assert.deepEqual(await fs.readFile(path.join(renamed.target, 'Main.dc.html')), original);
  assert.equal((await fs.readdir(path.join(renamed.target, '.dsh', 'conversations'))).length, 1);
  await service.archive(a.id);
  assert.equal((await service.list()).directories.length, 0);
  assert.ok((await fs.stat(renamed.target)).isDirectory());
  assert.equal((await service.links(renamed.target)).links['.'], 's1');
  await assert.rejects(service.locate(a.id), /已归档/);
});
test('invalid names, collisions, cross-root links, relative traversal and exclusive locks preserve files', async t => {
  const { service, workspace, root } = await setup(t);
  const a = await service.create('validation-operation');
  for (const name of ['', '..', '../escape', '/tmp/demo', '.hidden', 'a\\b']) await assert.rejects(service.rename(a.id, name), /名称/);
  await fs.mkdir(path.join(workspace, '已有设计'));
  await assert.rejects(service.rename(a.id, '已有设计'), /已存在/);
  await assert.rejects(service.bind(a.id, '.', 'foreign', root), /不属于设计区/);
  await assert.rejects(service.locate(a.id, '..'), /直接子文件夹/);
  const lock = path.join(workspace, '.dsh', 'operations.json.lock');
  await fs.writeFile(lock, 'other process');
  await assert.rejects(service.rename(a.id, '新名称'), /另一个窗口/);
  assert.ok((await fs.stat(a.target)).isDirectory());
});
test('multiple sessions persist per draft with optimistic revision checks and invalid sidecars preserved', async t => {
  const { service, workspace } = await setup(t);
  const a = await service.create('session-operation'), b = await service.create('isolated-operation');
  const initial = await service.links(a.target);
  initial.links['.'] = 'legacy';
  const file = path.join(a.target, '.dsh', 'design-tabs.json');
  await fs.mkdir(path.dirname(file), { recursive:true });
  await fs.writeFile(file, JSON.stringify(initial));
  await service.bind(a.id, '.', 'second', workspace, initial.revision);
  await service.bind(a.id, '.', 'second', workspace);
  const restored = new DesignSpaceService(workspace);
  assert.deepEqual((await restored.describe(a.id)).sessionIds, ['legacy', 'second']);
  assert.deepEqual((await restored.describe(b.id)).sessionIds, []);
  await assert.rejects(service.bind(a.id, '.', 'third', workspace, initial.revision), /其他窗口/);
  await fs.writeFile(file, '{"version":1,"revision":2,"links":[],"operations":{}}');
  await assert.rejects(service.bind(a.id, '.', 'third', workspace), /损坏/);
  assert.ok((await service.describe(a.id)).linkError);
  assert.match(await fs.readFile(file, 'utf8'), /"links":\[\]/);
});
test('Host restricts creation to the fixed root, checks actual session cwd and saves host event logs', async t => {
  const { service, workspace, root } = await setup(t);
  const { registerDesignSpaceHost } = await import('../dist/design-space/host.js');
  const { EditorManager } = await import('../dist/editor/manager.js');
  const http = await import('node:http');
  const editors = new EditorManager();
  let handler, eventListener;
  const disposals = [];
  const events = [{ seq:0, type:'user/message', data:{ text:'设计订单页' } }];
  registerDesignSpaceHost({
    effect:fn => { disposals.push(fn()); },
    on:(name, fn) => { eventListener = fn; return () => {}; },
    webServer:{ register:route => { handler = route.handler; return () => {}; } },
    sessions:{ get:id => ({ header:{ cwd:id === 'same' ? workspace : root } }) },
    sessionPersistence:{ open:async () => ({ header:{ cwd:workspace }, read:async () => ({ events }), close:async () => {} }) },
  }, editors, service);
  const server = http.createServer((req,res) => handler(req,res));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { for(const dispose of disposals) dispose(); await editors.close(); await new Promise(resolve => server.close(resolve)); });
  const call = async (body, headers = {}) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port, { method:'POST', headers:{ 'Content-Type':'application/json', ...headers }, body:JSON.stringify(body) });
    return { status:response.status, data:await response.json() };
  };
  assert.equal((await call({ action:'list' }, { Origin:'https://example.org' })).status,403);
  assert.equal((await call({ action:'register', path:root })).status,400);
  const { data:a } = await call({ action:'create', operationId:'host-operation', path:root });
  assert.ok(a.target.startsWith(workspace + path.sep));
  assert.equal((await call({ action:'bind', id:a.id, rel:'.', sessionId:'foreign' })).status,409);
  assert.equal((await call({ action:'bind', id:a.id, rel:'.', sessionId:'same' })).status,200);
  const opened = await call({ action:'open', id:a.id });
  assert.equal(opened.status,200); assert.equal(opened.data.sessionId,'same');
  assert.equal((await call({ action:'open', id:a.id, rel:'..' })).status,400);
  const copies = path.join(a.target,'.dsh','conversations');
  let file = path.join(copies,(await fs.readdir(copies))[0]);
  assert.deepEqual(JSON.parse(await fs.readFile(file)).events,events);
  events.push({ seq:1, type:'assistant/message', data:{ text:'完成' } });
  eventListener({ id:'same' });
  const deadline = Date.now()+4000;
  while(JSON.parse(await fs.readFile(file)).events.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,50));
  assert.equal(JSON.parse(await fs.readFile(file)).events.length,2);
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
