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
const service = new DesignSpaceService(path.join(workspace, '.registry.json')),
  editors = new EditorManager();
const owner = await service.register(workspace, workspace, true);
const independent = await service.create(
  owner.id,
  'independent',
  '无会话设计稿',
  'mobile',
  'independent-operation',
);
await service.register(independent.target, workspace);
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
    sessions: { get: () => ({ header: { cwd: workspace } }) },
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
  await page.getByRole('button', { name: '收起工作区', exact: true }).waitFor();
  const workspaceRegion = page.locator('[data-ds-workspace-region]');
  const designRegion = page.getByRole('region', { name: '设计区', exact: true });
  const gap = async () => {
    const a = await workspaceRegion.boundingBox(),
      b = await designRegion.boundingBox();
    return b.y - (a.y + a.height);
  };
  assert.ok(Math.abs(await gap()) < 12, 'sections are adjacent when expanded');
  await page.getByRole('button', { name: '收起工作区', exact: true }).click();
  assert.equal(await page.getByRole('tree', { name: '工作区列表' }).isVisible(), false);
  assert.equal(await page.locator('.ds-directory-open').isVisible(), true);
  await page.getByRole('button', { name: '收起设计区', exact: true }).click();
  assert.equal(await page.locator('.ds-directory-open').isVisible(), false);
  assert.ok(Math.abs(await gap()) < 12, 'collapsed headers are adjacent');
  await page.reload();
  await page.getByRole('button', { name: '展开工作区', exact: true }).waitFor();
  await page.getByRole('button', { name: '展开设计区', exact: true }).waitFor();
  await page.getByLabel('搜索会话名称').focus();
  await page.getByRole('button', { name: '收起工作区', exact: true }).waitFor();
  assert.equal(await page.getByRole('tree', { name: '工作区列表' }).isVisible(), true);
  await page.getByRole('button', { name: '展开设计区', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.ds-directory-open').isVisible(), true);
  pass('adjacent sidebar sections collapse independently, persist and expand for search');
  await page.getByRole('button', { name: 'Design 空间', exact: true }).click();
  await page.getByRole('heading', { name: '还没有打开的设计稿' }).waitFor();
  pass('Host slot contract mounts empty Design Space');
  await page.locator('iframe[title="设计稿缩略图"]').first().waitFor();
  assert.equal(await page.locator('.ds-list > button').count(), 1);
  pass('overlapping workspaces discover each canonical design once');
  await page
    .locator('iframe[title="设计稿缩略图"]')
    .first()
    .contentFrame()
    .locator('[data-dc-tpl]')
    .first()
    .waitFor({ state: 'attached' });
  assert.ok((await page.locator('iframe[title="设计稿缩略图"]').count()) <= 4);
  if (output) await page.screenshot({ path: path.join(output, 'space-empty.png') });
  pass('directory list renders bounded sandboxed previews');
  await page.locator('.ds-directory-open').filter({ hasText: 'independent' }).click();
  await page.getByRole('tab', { name: '无会话设计稿', exact: true }).waitFor();
  await editorReady();
  assert.equal((await page.evaluate(() => window.fixture.counts())).created, 0);
  assert.equal(await page.locator('[data-native-factory-fixture]').count(), 0);
  await closeTab('无会话设计稿');
  await page.getByRole('heading', { name: '还没有打开的设计稿' }).waitFor();
  pass('registered canvas opens and edits without silently creating a session');
  async function create(name, title) {
    await page.getByRole('button', { name: '新建设计稿', exact: true }).first().click();
    await page.getByLabel('标题', { exact: true }).fill(title);
    await page.getByLabel('目录名', { exact: true }).fill(name);
    await page.getByRole('button', { name: '创建设计稿', exact: true }).click();
    await page.getByRole('tab', { name: title, exact: true }).waitFor();
    await page.getByLabel('测试会话草稿').waitFor();
    await page.waitForFunction(() => !!document.querySelector('.ds-editor iframe')?.contentWindow);
    await editorReady();
  }
  async function closeTab(title) {
    await page.getByRole('button', { name: '关闭 ' + title, exact: true }).click();
    await page.getByRole('tab', { name: title, exact: true }).waitFor({ state: 'detached' });
  }
  async function selectTab(title) {
    await page.getByRole('tab', { name: title, exact: true }).click();
    await page.waitForFunction(
      (title) =>
        [...document.querySelectorAll('[role=tab]')].some(
          (t) => t.textContent === title && t.getAttribute('aria-selected') === 'true',
        ),
      title,
    );
  }
  async function editorReady() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const f = page.frames().find((f) => f.url().includes('embedded=1'));
      if (f) {
        try {
          await f.waitForFunction(
            () => window.designEditor?.bridge()?.ready && window.designEditor.state.revision,
          );
          await f.waitForTimeout(150);
          if (!f.isDetached()) return f;
        } catch (error) {
          if (!f.isDetached()) throw error;
        }
      }
      await page.waitForTimeout(50);
    }
    throw new Error('editor did not settle after session navigation');
  }
  await create('first', '第一份设计');
  await page.getByLabel('测试会话草稿').fill('第一份独立草稿');
  pass('create legal preset and connect one session without sending');
  await create('second', '第二份设计');
  await page.getByLabel('测试会话草稿').fill('第二份独立草稿');
  await selectTab('第一份设计');
  await page.waitForFunction(
    () => document.querySelector('[aria-label="测试会话草稿"]')?.value === '第一份独立草稿',
  );
  assert.equal(await page.locator('[data-native-factory-fixture]').count(), 1);
  assert.equal(await page.locator('.ds-editor iframe').count(), 1);
  pass('two tabs retain separate drafts with a single input occurrence');
  let frame = await editorReady();
  await frame.evaluate(() =>
    window.designEditor.features.viewport.restore({ k: 0.7, x: 37, y: 42 }),
  );
  await selectTab('第二份设计');
  await editorReady();
  await selectTab('第一份设计');
  frame = await editorReady();
  assert.equal(await frame.evaluate(() => window.designEditor.features.viewport.view.k), 0.7);
  pass('tab switches restore viewport');
  await frame.evaluate(() => {
    const e = window.designEditor,
      tid = e.state.elements.find((e) => e.tag === 'div').tid;
    e.bridge().select(tid, true);
    e.features.annotations.pick(e.features.selection.getSelection());
  });
  await frame.getByLabel('用户批注', { exact: true }).fill('保留这条标注');
  await frame.locator('#annotationSave').click();
  await frame.waitForFunction(() => window.designEditor.features.annotations.items.length === 1);
  await selectTab('第二份设计');
  await editorReady();
  await selectTab('第一份设计');
  frame = await editorReady();
  assert.equal(
    await frame.evaluate(() => window.designEditor.features.annotations.items[0]?.note),
    '保留这条标注',
  );
  assert.equal(
    await frame.evaluate(() => window.designEditor.features.annotations.items[0]?.stale),
    null,
  );
  pass('annotations survive iframe replacement without invalid runtime references');
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
  await frame.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue('--ink') === '#e7e9ed',
  );
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'));
  pass('Host theme changes reach the embedded editor');
  const source = path.join(workspace, 'first', 'Main.dc.html');
  await fs.appendFile(source, '\n<!-- external file change -->');
  await frame.waitForFunction(() => window.designEditor.state.elements.length > 0);
  const rev = await frame.evaluate(() => window.designEditor.state.revision);
  await fs.appendFile(source, '\n<!-- another external change -->');
  await frame.waitForFunction((old) => window.designEditor.state.revision !== old, rev, {
    timeout: 6000,
  });
  pass('external file writes refresh the actual editor');
  assert.ok(await frame.evaluate(() => window.designEditor.features.annotations.items[0]?.stale));
  pass('external changes invalidate saved annotation locations');
  // Capture an in-progress style edit, remove the Host panel immediately, and restore it.
  await frame.evaluate(() => {
    const ed = window.designEditor;
    ed.events.dispatchEvent(
      new CustomEvent('edit-intent', {
        detail: {
          canvas: ed.state.canvas,
          board: ed.state.board,
          tid: ed.state.elements.find((e) => e.tag === 'div').tid,
          revision: ed.state.revision,
          style: 'width: 880px; height: 560px; background: rgb(1, 2, 3)',
        },
      }),
    );
  });
  await page.waitForFunction(() =>
    Object.values(
      JSON.parse(localStorage.getItem('dsh.design-space.view.v1.recovery') || '{}'),
    ).some((a) => a.length),
  );
  await page.getByRole('button', { name: '普通对话', exact: true }).click();
  assert.equal(await page.locator('[data-native-factory-fixture]').count(), 0);
  await page.getByRole('button', { name: 'Design 空间', exact: true }).click();
  frame = await editorReady();
  await frame.getByRole('button', { name: '按原版本恢复' }).click();
  await page.waitForTimeout(300);
  assert.match(await fs.readFile(source, 'utf8'), /rgb\(1, 2, 3\)/);
  pass('unconfirmed edits survive panel unmount and restore with revision guard');
  await page.getByRole('button', { name: '新建设计稿', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('恢复创建');
  await page.getByLabel('目录名', { exact: true }).fill('recover-create');
  await page.evaluate(() => window.fixture.failNextCreate());
  await page.getByRole('button', { name: '创建设计稿', exact: true }).click();
  await page.getByText('测试：会话创建暂时失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '继续连接', exact: true }).click();
  await page.getByRole('tab', { name: '恢复创建', exact: true }).waitFor();
  await editorReady();
  assert.equal((await fs.readdir(workspace)).filter((n) => n === 'recover-create').length, 1);
  assert.equal((await page.evaluate(() => window.fixture.counts())).created, 3);
  await closeTab('恢复创建');
  await editorReady();
  pass('session creation failure resumes the existing design without duplicate resources');
  await page.getByRole('button', { name: '新建设计稿', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('共用对话');
  await page.getByLabel('目录名', { exact: true }).fill('shared');
  await page.getByLabel('这段对话', { exact: true }).selectOption('fixture-session-1');
  await page.getByLabel('先描述一句（可选）', { exact: true }).fill('追加描述');
  await page.getByRole('button', { name: '创建并填入草稿', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="测试会话草稿"]')?.value.includes('追加描述'),
  );
  assert.ok((await page.getByLabel('测试会话草稿').inputValue()).startsWith('第一份独立草稿'));
  assert.equal((await page.evaluate(() => window.fixture.counts())).sends, 0);
  assert.equal(
    await page.locator('[data-conversation-session]').getAttribute('data-conversation-session'),
    'fixture-session-1',
  );
  assert.match(await page.locator('.ds-chat-head').getAttribute('title'), /共用这段对话/);
  await closeTab('共用对话');
  await selectTab('第一份设计');
  await editorReady();
  pass('explicitly shared session preserves existing draft and never auto-sends');
  await page.getByRole('tab', { name: '第一份设计', exact: true }).press('Alt+ArrowRight');
  assert.equal(await page.getByRole('tab').first().textContent(), '第二份设计');
  await page.reload();
  await page.getByRole('button', { name: 'Design 空间', exact: true }).click();
  await editorReady();
  assert.equal(await page.getByRole('tab').first().textContent(), '第二份设计');
  pass('tab ordering and active identity persist across reload');
  await page.getByRole('separator').focus();
  await page.getByRole('separator').press('ArrowLeft');
  assert.equal(await page.getByRole('separator').getAttribute('aria-valuenow'), '61');
  pass('splitter supports keyboard adjustment');
  frame = await editorReady();
  const demo = await fs.readFile(source, 'utf8');
  const beforeDemo = await frame.evaluate(() => window.designEditor.state.revision);
  await fs.writeFile(
    source,
    demo.replace(
      /<div style="[^"]*"><\/div>/,
      '<div style="width:880px;height:560px;background:#f5f6f7;padding:64px;box-sizing:border-box"><section style="width:420px;padding:28px;background:white;border:1px solid #e1e5ee;border-radius:12px;font-family:system-ui;color:#0f1115"><p style="color:#4176e6;font-size:12px">DESIGN SPACE</p><h1 style="font-size:26px">创建你的第一个设计</h1><p style="color:#61666b;line-height:1.7">编辑画布、记录标注，并在右侧继续对话。</p><button style="background:#4176e6;color:white;padding:10px 18px;border:0;border-radius:7px">开始设计</button></section></div>',
    ),
  );
  await frame.waitForFunction((old) => window.designEditor.state.revision !== old, beforeDemo);
  if (output) await page.screenshot({ path: path.join(output, 'space-main.png') });
  await page.setViewportSize({ width: 1000, height: 650 });
  await page.getByRole('button', { name: '收起对话侧栏', exact: true }).click();
  await page.locator('[data-native-factory-fixture]').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '打开对话侧栏', exact: true }).click();
  await page.locator('[data-native-factory-fixture]').waitFor();
  pass('compact window offers canvas-only and restores single conversation');
  await page.getByRole('button', { name: '新建设计稿', exact: true }).click();
  await page.getByRole('heading', { name: '新建设计稿', exact: true }).waitFor();
  if (output) await page.screenshot({ path: path.join(output, 'space-new-compact.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await page.evaluate(() => window.fixture.counts())).sends, 0);
  assert.deepEqual(errors, []);
  pass('no uncaught errors and no automatic model submissions');
  await page.getByRole('button', { name: '新建设计稿', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('首次描述测试');
  await page.getByLabel('目录名', { exact: true }).fill('initial-description');
  await page.getByLabel('先描述一句（可选）', { exact: true }).fill('测试替身消息，不连接模型');
  await page.getByRole('button', { name: '创建并发送', exact: true }).click();
  await page.waitForFunction(() => window.fixture.counts().sends === 1);
  await editorReady();
  await selectTab('第二份设计');
  await editorReady();
  await selectTab('首次描述测试');
  await editorReady();
  assert.equal((await page.evaluate(() => window.fixture.counts())).sends, 1);
  assert.deepEqual(errors, []);
  pass('explicit initial description submits once to the mock Host, never on remount');
  await page.setViewportSize({ width: 1440, height: 900 });
  await selectTab('第一份设计');
  await editorReady();
  const editorBox = await page.locator('.ds-editor').boundingBox();
  const chatBox = await page.getByRole('complementary', { name: '设计对话' }).boundingBox();
  assert.ok(
    chatBox.x >= editorBox.x + editorBox.width,
    'conversation sits to the right of the canvas',
  );
  assert.ok(Math.abs(chatBox.y - editorBox.y) < 2, 'canvas and sidebar share the same top edge');
  await page.getByLabel('测试会话草稿').fill('会话 A 的消息');
  await page.getByRole('button', { name: '测试发送', exact: true }).click();
  await page.getByLabel('测试会话草稿').fill('会话 A 的未发送草稿');
  const originalSession = await page.locator('.ds-session-tab[aria-selected=true]').textContent();
  const countsBefore = await page.evaluate(() => window.fixture.counts());
  let failBinding = true;
  const bindingFailure = async (route) => {
    if (failBinding && route.request().postDataJSON()?.action === 'bind') {
      failBinding = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '测试：关联保存暂时失败' }),
      });
    }
    return route.continue();
  };
  await page.route('**/design-space/api', bindingFailure);
  await page.getByRole('button', { name: '为当前设计稿新建对话', exact: true }).click();
  await page.waitForFunction(
    (n) => window.fixture.counts().created === n + 1,
    countsBefore.created,
  );
  await page.waitForFunction(
    () => document.querySelectorAll('.ds-session-item[data-session-id]').length === 2,
  );
  await editorReady();
  await page.getByRole('button', { name: '重试保存关联', exact: true }).click();
  await page
    .getByRole('button', { name: '重试保存关联', exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(
    (await page.evaluate(() => window.fixture.counts())).created,
    countsBefore.created + 1,
  );
  await page.unroute('**/design-space/api', bindingFailure);
  assert.equal(await page.getByLabel('测试会话草稿').inputValue(), '');
  assert.equal(await page.getByLabel('测试消息流').innerText(), '');
  assert.equal((await page.evaluate(() => window.fixture.counts())).sends, countsBefore.sends);
  await page.getByLabel('测试会话草稿').fill('会话 B 的消息');
  await page.getByRole('button', { name: '测试发送', exact: true }).click();
  await page.getByLabel('测试会话草稿').fill('会话 B 的未发送草稿');
  const secondSession = await page.locator('.ds-session-tab[aria-selected=true]').textContent();
  assert.notEqual(originalSession, secondSession);
  await selectTab(originalSession);
  await editorReady();
  assert.equal(await page.getByLabel('测试会话草稿').inputValue(), '会话 A 的未发送草稿');
  assert.equal(await page.getByLabel('测试消息流').innerText(), '会话 A 的消息');
  await selectTab(secondSession);
  await editorReady();
  assert.equal(await page.getByLabel('测试会话草稿').inputValue(), '会话 B 的未发送草稿');
  assert.equal(await page.getByLabel('测试消息流').innerText(), '会话 B 的消息');
  assert.equal(await page.locator('[data-native-factory-fixture]').count(), 1);
  const binding = await service.describe(owner.id, 'first');
  assert.equal(binding.sessionIds.length, 2);
  assert.equal(
    (await service.discover(owner.id)).items.filter((i) => i.title === '第一份设计').length,
    1,
  );
  await closeTab('第一份设计');
  await page.locator('.ds-directory-open').filter({ hasText: 'first' }).click();
  await editorReady();
  assert.equal(await page.locator('.ds-session-item[data-session-id]').count(), 2);
  assert.equal(await page.getByLabel('测试消息流').innerText(), '会话 B 的消息');
  await page.reload();
  await page.getByRole('button', { name: 'Design 空间', exact: true }).click();
  await editorReady();
  assert.equal(await page.locator('.ds-session-item[data-session-id]').count(), 2);
  await selectTab(originalSession);
  await editorReady();
  assert.equal(await page.getByLabel('测试消息流').innerText(), '会话 A 的消息');
  assert.equal(await page.getByLabel('测试会话草稿').inputValue(), '会话 A 的未发送草稿');
  pass(
    'right sidebar binds two independent sessions to one design and restores both after reopening',
  );
  pass('failed association retries the created session without duplicates and survives reload');
  // Check the same geometry for a fresh session and a long transcript.
  const docked = async (area = page.locator('.ds-chat').first()) => {
    const pane = await area.boundingBox();
    const seat = await area.locator('[data-composer-seat]').boundingBox();
    assert.ok(
      Math.abs(pane.y + pane.height - seat.y - seat.height) < 6,
      'composer stays at pane bottom',
    );
  };
  await docked();
  assert.equal(await page.getByRole('button', { name: '浏览设计目录', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '仅画布', exact: true }).count(), 0);
  await page.getByRole('button', { name: '分栏', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-native-factory-fixture]').length === 2,
  );
  const panes = page.locator('.ds-chat');
  const splitIds = await page
    .locator('[data-conversation-session]')
    .evaluateAll((els) => els.map((e) => e.dataset.conversationSession));
  assert.equal(new Set(splitIds).size, 2);
  assert.equal(await panes.nth(0).getByLabel('测试会话草稿').inputValue(), '会话 A 的未发送草稿');
  assert.equal(await panes.nth(1).getByLabel('测试会话草稿').inputValue(), '会话 B 的未发送草稿');
  await docked(panes.nth(0));
  await docked(panes.nth(1));
  await panes.nth(1).getByRole('tab', { name: originalSession, exact: true }).click();
  await page.waitForFunction(
    (sid) =>
      document.querySelectorAll('[data-conversation-session]')[1]?.dataset.conversationSession ===
      sid,
    splitIds[0],
  );
  assert.equal(
    new Set(
      await page
        .locator('[data-conversation-session]')
        .evaluateAll((els) => els.map((e) => e.dataset.conversationSession)),
    ).size,
    2,
  );
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.locator('.ds-editor').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-native-factory-fixture]').count(), 2);
  await page.getByRole('button', { name: '收起对话侧栏', exact: true }).click();
  await page.locator('[data-native-factory-fixture]').waitFor({ state: 'detached' });
  await editorReady();
  await page.getByRole('button', { name: '打开对话侧栏', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-native-factory-fixture]').length === 2,
  );
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await editorReady();
  await page.getByRole('button', { name: '取消分栏', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-native-factory-fixture]').length === 1,
  );
  pass(
    'top-right split, fullscreen and collapse preserve independent sessions without duplicate composers',
  );
  await page.getByRole('button', { name: '为当前设计稿新建对话', exact: true }).click();
  await editorReady();
  assert.equal(await page.getByLabel('测试消息流').innerText(), '');
  await docked();
  for (let i = 0; i < 12; i++) {
    await page.getByLabel('测试会话草稿').fill('滚动测试 '.repeat(30));
    await page.getByRole('button', { name: '测试发送', exact: true }).click();
  }
  await page.locator('[data-conversation-scroll]').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await docked();
  pass('fresh and long conversations keep the composer docked at the bottom');
  const thirdId = await page
    .locator('[data-conversation-session]')
    .getAttribute('data-conversation-session');
  const thirdTitle = await page
    .locator('.ds-session-tab[aria-selected=true]')
    .getAttribute('title');
  await page.evaluate(() => window.fixture.failNextArchive());
  await page.getByRole('button', { name: '关闭会话 ' + thirdTitle, exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '关闭会话失败' }).waitFor();
  assert.equal(await page.locator('.ds-session-item[data-session-id]').count(), 3);
  await page.getByRole('button', { name: '关闭会话 ' + thirdTitle, exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.ds-session-item[data-session-id]').length === 2,
  );
  assert.notEqual(
    await page.locator('[data-conversation-session]').getAttribute('data-conversation-session'),
    thirdId,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Design 空间', exact: true }).click();
  await editorReady();
  assert.equal(await page.locator('.ds-session-item[data-session-id]').count(), 2);
  await page.evaluate((sid) => window.fixture.restore(sid), thirdId);
  await page.waitForFunction(
    () => document.querySelectorAll('.ds-session-item[data-session-id]').length === 3,
  );
  await page.getByRole('tab', { name: new RegExp(thirdTitle) }).click();
  await editorReady();
  assert.ok((await page.getByLabel('测试消息流').innerText()).includes('滚动测试'));
  for (let i = 0; i < 3; i++) {
    await page.locator('.ds-session-close').first().click();
    await page.waitForFunction(
      (count) => document.querySelectorAll('.ds-session-item[data-session-id]').length === count,
      2 - i,
    );
  }
  await page.getByRole('button', { name: '连接对话', exact: true }).waitFor();
  assert.equal(await page.locator('[data-native-factory-fixture]').count(), 0);
  pass(
    'archive refusal preserves sessions; archive switches selection, persists, restores, and handles the last session',
  );
  await page.getByRole('button', { name: '连接对话', exact: true }).click();
  await editorReady();
  const beforeSplitCreate = await page.evaluate(() => window.fixture.counts());
  await page.getByRole('button', { name: '分栏', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-conversation-session]').length === 2,
  );
  assert.equal(
    (await page.evaluate(() => window.fixture.counts())).created,
    beforeSplitCreate.created + 1,
  );
  assert.equal((await page.evaluate(() => window.fixture.counts())).sends, beforeSplitCreate.sends);
  const secondaryPane = page.getByRole('complementary', { name: '第二栏设计对话', exact: true });
  const secondaryTitle = (
    await secondaryPane.locator('.ds-session-tab[aria-selected=true]').getAttribute('title')
  ).replace('未命名对话 ', '');
  await secondaryPane
    .getByRole('button', { name: '关闭会话 ' + secondaryTitle, exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-conversation-session]').length === 1,
  );
  assert.equal(await page.locator('.ds-session-item[data-session-id]').count(), 1);
  pass(
    'splitting a lone session creates one empty independent session and archiving a pane collapses the split',
  );
  assert.equal(await page.locator('.ds-chat-head').count(), 1);
  assert.equal(await page.locator('.ds-chat-head .ds-session-tab').count(), 0);
  assert.equal(await page.locator('.ds-new-session').count(), 1);
  assert.equal(await page.getByText('与 AI 的对话', { exact: true }).count(), 0);
  const headerBox = await page.locator('.ds-chat-head').boundingBox();
  assert.ok(headerBox.height < 52, 'conversation header occupies one row');
  await page.getByLabel('测试会话草稿').fill('第一轮标题测试');
  await page.getByRole('button', { name: '测试发送', exact: true }).click();
  await page.locator('.ds-session-tab[aria-selected=true]').waitFor();
  const namedId = await page
    .locator('[data-conversation-session]')
    .getAttribute('data-conversation-session');
  await page.evaluate((sid) => window.fixture.rename(sid, '宿主更新后的名称'), namedId);
  await page.getByRole('tab', { name: '宿主更新后的名称', exact: true }).waitFor();
  await page.setViewportSize({ width: 900, height: 650 });
  assert.ok((await page.locator('.ds-chat-head').boundingBox()).height < 52);
  pass('single-row header starts with one plus and follows host-generated titles and renames');

  await page.route('**/design-space/api', (route) => route.fulfill({ status: 404, body: '' }));
  await page.reload();
  await page.getByRole('button', { name: 'Design 空间', exact: true }).click();
  await page
    .getByText(
      'Design 空间服务未就绪。请在插件页停用后重新启用设计插件；若仍失败，请重启 Harness。',
      { exact: true },
    )
    .first()
    .waitFor();
  assert.deepEqual(errors, []);
  pass('an outdated Host route shows an actionable upgrade message instead of a JSON error');
} catch (error) {
  console.error(await page.locator('body').innerText());
  if (output) await page.screenshot({ path: path.join(output, 'space-failure.png') });
  throw error;
} finally {
  if (output)
    await fs.writeFile(
      path.join(output, 'space-browser-results.json'),
      JSON.stringify({ passed: results, errors }, null, 2),
    );
  await browser.close();
  await editors.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(workspace, { recursive: true, force: true });
}
