import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DesignSpaceService } from '../dist/design-space/service.js';
import { registerDesignSpaceHost } from '../dist/design-space/host.js';
import { EditorManager } from '../dist/editor/manager.js';
import { findChrome } from '../dist/render.js';
const runtime = process.env.DSH_DESIGN_TEST_RUNTIME;
const { build } = await import(
  runtime ? pathToFileURL(path.join(runtime, 'esbuild/lib/main.js')).href : 'esbuild'
);
const { chromium } = await import(
  process.env.DSH_DESIGN_PLAYWRIGHT
    ? pathToFileURL(process.env.DSH_DESIGN_PLAYWRIGHT).href
    : 'playwright-core'
);
const workspace = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'design-space-browser-')),
);
const designRoot = path.join(workspace, '.design');
const service = new DesignSpaceService(designRoot), editors = new EditorManager();
const independent = await service.create('independent-operation', '已有设计稿', 'mobile');
const routes = new Map();
registerDesignSpaceHost(
  {
    effect: (fn) => fn(),
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
    },
    sessions: { get: () => ({ header: { cwd: designRoot } }) },
    sessionPersistence: {
      open: () => {
        throw new Error('unexpected');
      },
    },
  },
  editors,
  service,
);
const fixture = await build({
  entryPoints: [fileURLToPath(new URL('./design-space-host-fixture.js', import.meta.url))],
  bundle: true,
  write: false,
  format: 'iife',
  nodePaths: runtime ? [runtime] : undefined,
});
const client = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (routes.has(pathname)) {
    routes.get(pathname)(req, res);
    return;
  }
  if (pathname === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(fixture.outputFiles[0].text);
    return;
  }
  if (pathname === '/client.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(client);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%;font:13px system-ui}#root{display:flex}button{cursor:pointer}textarea{width:90%;height:75px}</style></head><body><div id="root"></div><script>window.TEST_WORKSPACE=${JSON.stringify(workspace)}</script><script src="/fixture.js"></script><script src="/client.js"></script></body></html>`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: await findChrome(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.error('PAGE', e.message);
});
page.on('console', (m) => {
  if (m.type() === 'error') console.error('CONSOLE', m.text());
});
page.setDefaultTimeout(10000);
const results = [];
const pass = (name) => {
  results.push(name);
  console.log('PASS', name);
};
const output = process.env.DSH_DESIGN_TEST_OUTPUT;
if (output) await fs.mkdir(output, { recursive: true });
try {
  await page.goto(url);
  const sidebar = page.getByRole('region', { name:'设计区', exact:true });
  await sidebar.getByRole('button', { name:'已有设计稿 1 张' }).waitFor();
  const workspaceToggle = page.getByRole('button', { name:'收起工作区', exact:true });
  const designToggle = page.getByRole('button', { name:'收起设计区', exact:true });
  const textLeft = locator => locator.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el.lastChild); return r.getBoundingClientRect().x; });
  assert.ok(Math.abs(await textLeft(workspaceToggle) - await textLeft(designToggle)) < 1, 'section text aligns');
  const a = await page.locator('[data-ds-workspace-region]').boundingBox(), b = await sidebar.boundingBox();
  assert.ok(Math.abs(b.y - a.y - a.height) < 12, 'sidebar sections remain adjacent');
  assert.equal(await sidebar.getByRole('button', { name:'添加设计目录' }).count(), 0);
  assert.equal(await sidebar.getByRole('button', { name:/管理/ }).count(), 0);
  await workspaceToggle.click();
  await designToggle.click();
  await page.reload();
  await page.getByRole('button', { name:'展开工作区', exact:true }).waitFor();
  await page.getByRole('button', { name:'展开设计区', exact:true }).click();
  pass('sidebar headings align, collapse independently and persist without folder picker or ellipsis');
  await page.getByRole('button', { name:'Design 空间', exact:true }).click();
  await page.getByRole('heading', { name:'还没有打开的设计稿' }).waitFor();
  assert.equal(await page.getByRole('button', { name:'添加设计目录…' }).count(), 0);
  assert.equal(await page.getByRole('combobox', { name:'放在哪个工作区' }).count(), 0);
  await sidebar.getByRole('button', { name:'已有设计稿 1 张' }).click();
  await editorReady();
  assert.equal((await page.evaluate(() => window.fixture.counts())).created, 0);
  pass('existing fixed-root draft opens without a session or arbitrary workspace selection');
  await sidebar.getByRole('button', { name:'新建设计稿', exact:true }).click();
  await page.getByRole('tab', { name:'未命名设计稿', exact:true }).waitFor();
  await editorReady();
  assert.ok((await fs.stat(path.join(designRoot,'未命名设计稿','canvas.json'))).isFile());
  assert.equal((await service.list()).directories.length, 2);
  assert.equal((await page.evaluate(() => window.fixture.counts())).created, 0);
  pass('sidebar plus immediately creates one folder and matching draft without a form');
  async function rename(from,to,key='Enter') {
    const row = sidebar.locator('.ds-directory-row').filter({ hasText:from });
    await row.hover();
    await row.getByRole('button', { name:'重命名 '+from, exact:true }).click();
    const input = sidebar.getByRole('textbox', { name:'设计稿名称' });
    assert.equal(await input.inputValue(), from);
    await input.fill(to); await input.press(key);
    return input;
  }
  await rename('未命名设计稿','订单界面');
  await page.getByRole('tab', { name:'订单界面', exact:true }).waitFor();
  await editorReady();
  assert.ok((await fs.stat(path.join(designRoot,'订单界面'))).isDirectory());
  await rename('订单界面','取消更名','Escape');
  await sidebar.getByRole('button', { name:'订单界面 1 张' }).waitFor();
  assert.equal(await sidebar.getByRole('textbox').count(),0);
  await rename('订单界面','已有设计稿');
  await sidebar.getByRole('alert').filter({ hasText:'同名设计稿已存在' }).waitFor();
  await sidebar.getByRole('textbox').press('Escape');
  pass('inline rename changes the folder and tab, Escape cancels, and duplicate names preserve both drafts');
  await page.getByRole('button', { name:'连接对话', exact:true }).click();
  await page.getByLabel('测试会话草稿').waitFor();
  const sid = await page.locator('[data-conversation-session]').getAttribute('data-conversation-session');
  assert.equal((await page.evaluate(() => window.fixture.counts())).created,1);
  assert.equal((await page.evaluate(() => window.fixture.counts())).sends,0);
  await page.getByLabel('测试会话草稿').fill('设计一个订单管理页面');
  await page.getByRole('button', { name:'测试发送', exact:true }).click();
  await page.getByRole('tab', { name:'测试对话 1', exact:true }).waitFor();
  await page.evaluate(sid => window.fixture.rename(sid,'订单管理界面设计'),sid);
  await page.getByRole('tab', { name:'订单管理界面设计', exact:true }).waitFor();
  const current = (await service.list()).directories.find(d => d.label === '订单界面');
  assert.deepEqual((await service.describe(current.id)).sessionIds,[sid]);
  pass('first turn shows host-generated conversation title and follows host renames');
  await rename('订单界面','订单界面 第二版');
  await page.getByRole('tab', { name:'订单界面 第二版', exact:true }).waitFor();
  await editorReady();
  await page.getByRole('tab', { name:'订单管理界面设计', exact:true }).waitFor();
  assert.equal((await service.describe(current.id)).sessionId,sid);
  await page.getByLabel('测试会话草稿').fill('重命名后保留的草稿');
  await page.getByRole('button', { name:'为当前设计稿新建对话', exact:true }).click();
  await page.waitForFunction(sid => { const el = document.querySelector('[data-conversation-session]'); return el && el.dataset.conversationSession !== sid; }, sid);
  await page.getByLabel('测试会话草稿').waitFor();
  assert.equal(await page.getByLabel('测试会话草稿').inputValue(),'');
  await page.getByRole('tab', { name:'订单管理界面设计', exact:true }).click();
  await page.waitForFunction(sid => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === sid, sid);
  assert.equal(await page.getByLabel('测试会话草稿').inputValue(),'重命名后保留的草稿');
  await page.getByRole('button', { name:'分栏', exact:true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-native-factory-fixture]').length === 2);
  assert.equal(await page.locator('[data-native-factory-fixture]').count(),2);
  await page.getByRole('button', { name:'取消分栏', exact:true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-native-factory-fixture]').length === 1);
  await page.getByRole('button', { name:'全屏', exact:true }).click();
  await page.waitForFunction(() => !document.querySelector('.ds-editor'));
  assert.equal(await page.locator('.ds-editor').count(),0);
  await page.getByRole('button', { name:'退出全屏', exact:true }).click();
  await editorReady();
  pass('rename retains linked conversations and drafts; multiple conversations, split and fullscreen still work');
  await page.reload();
  await page.getByRole('button', { name:'Design 空间', exact:true }).click();
  await page.getByRole('tab', { name:'订单界面 第二版', exact:true }).waitFor();
  await page.getByRole('tab', { name:'订单管理界面设计', exact:true }).waitFor();
  await editorReady();
  assert.equal(await page.getByLabel('测试会话草稿').inputValue(),'重命名后保留的草稿');
  pass('reload restores renamed draft and its conversation selection and draft');
  await fs.mkdir(path.join(designRoot,'外部新增'));
  await sidebar.getByRole('button', { name:'外部新增 还没画' }).waitFor();
  const external = (await service.list()).directories.find(d => d.label === '外部新增');
  await fs.rename(path.join(designRoot,'外部新增'),path.join(designRoot,'外部改名'));
  await sidebar.getByRole('button', { name:'外部改名 还没画' }).waitFor();
  assert.equal((await service.directory(external.id)).label,'外部改名');
  await sidebar.getByRole('button', { name:'外部改名 还没画' }).click();
  await editorReady();
  await page.getByRole('button', { name:'连接对话', exact:true }).waitFor();
  const choices = page.getByRole('combobox', { name:'选择关联对话' });
  assert.ok(!(await choices.textContent()).includes('fixture-session-'));
  assert.ok((await choices.textContent()).includes('订单管理界面设计'));
  await choices.selectOption(sid);
  await page.getByRole('button', { name:'连接对话', exact:true }).click();
  await page.getByRole('tab', { name:'订单管理界面设计', exact:true }).waitFor();
  pass('live filesystem additions and renames appear; empty folders initialize and old conversations use names');
  await fs.rename(path.join(designRoot,'外部改名'),path.join(designRoot,'再次外部改名'));
  await page.getByRole('tab', { name:'再次外部改名', exact:true }).waitFor();
  await editorReady();
  assert.equal(await page.getByLabel('测试会话草稿').inputValue(),'重命名后保留的草稿');
  pass('external rename updates an open draft and reloads the editor without losing conversation draft');
  const row = sidebar.locator('.ds-directory-row').filter({ hasText:'再次外部改名' });
  await row.hover();
  await row.getByRole('button', { name:'归档 再次外部改名', exact:true }).click();
  await row.waitFor({ state:'detached' });
  assert.ok((await fs.stat(path.join(designRoot,'再次外部改名','canvas.json'))).isFile());
  assert.equal((await service.links(path.join(designRoot,'再次外部改名'))).links['.'],sid);
  assert.equal(await page.getByRole('tab', { name:'再次外部改名', exact:true }).count(),0);
  await page.reload();
  await sidebar.getByRole('button', { name:'订单界面 第二版 1 张' }).waitFor();
  assert.equal(await sidebar.getByRole('button', { name:/再次外部改名/ }).count(),0);
  pass('archive hides the draft and closes its tab while keeping all files and links across reloads');
  await page.getByRole('button', { name:'Design 空间', exact:true }).click();
  await editorReady();
  await sidebar.locator('.ds-directory-row').filter({ hasText:'订单界面 第二版' }).hover();
  if(output) await page.screenshot({ path:path.join(output,'design-space-sidebar.png') });
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ passed:results.length, results },null,2));
} finally {
  await browser.close(); await editors.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(workspace,{ recursive:true, force:true });
}
async function editorReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const frame = page.frames().find(frame => frame.url().includes('embedded=1'));
    if (frame) {
      try {
        await frame.waitForFunction(() => window.designEditor?.bridge()?.ready && window.designEditor.state.revision);
        if (!frame.isDetached()) return frame;
      } catch (error) { if (!frame.isDetached()) throw error; }
    }
    await page.waitForTimeout(50);
  }
  throw new Error('editor did not settle after navigation');
}
