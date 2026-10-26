// Verifies the Super Agent chat design's interactive parts render and respond.
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startEditor } from '../dist/editor/server.js';
import { findChrome } from '../dist/render.js';

const designDir = path.resolve(process.argv[2] ?? '');
assert.ok(designDir, 'usage: node test/super-agent-interactions.mjs <design-dir>');

const canvasName = path.basename(designDir);
const server = await startEditor({ workspaceDir: path.dirname(designDir) });
const browser = await chromium.launch({ executablePath: await findChrome(), headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

const boardUrl = name => new URL(`/board/${canvasName}/${name}?preview=1`, server.url).href;
const text = () => page.locator('#dc-root').innerText();

try {
  // --- Main board: one turn = process + answer ---
  await page.goto(boardUrl('Main.dc.html'));
  await page.waitForSelector('#dc-root');
  const main = await page.evaluate(() => ({
    errors: window.__designRuntime?.errors ?? [],
    text: document.body.innerText
  }));
  assert.deepEqual(main.errors, []);
  assert.ok(main.text.includes('查看过程'), 'collapsed process entry missing');
  assert.ok(main.text.includes('正在处理'), 'running turn missing');
  assert.ok(main.text.includes('我先读了这三个文件'), 'answer body missing');
  assert.ok(!main.text.includes('本轮改动'), 'per-turn diff card must not exist');
  console.log('PASS main board shows process entry + answer body, no per-turn diff');

  // --- Process expands and collapses ---
  const before = await text();
  assert.ok(!before.includes('读取 3 个文件'), 'process steps should start collapsed');
  await page.locator('#dc-root button[aria-label="展开过程"]').first().click();
  await page.waitForTimeout(120);
  const expanded = await text();
  assert.ok(expanded.includes('读取 3 个文件'), 'expanded process should list tool steps');
  assert.ok(expanded.includes('思考'), 'expanded process should list thinking step');
  await page.locator('#dc-root button[aria-label="收起过程"]').first().click();
  await page.waitForTimeout(120);
  assert.ok(!(await text()).includes('读取 3 个文件'), 'process should collapse again');
  console.log('PASS process steps expand and collapse');

  // --- Changes card appears once, at the end ---
  const mainText = await text();
  const changesIndex = mainText.indexOf('已编辑');
  const actionsIndex = mainText.indexOf('用量');
  assert.ok(changesIndex > 0, 'changes card missing');
  assert.ok(actionsIndex > 0, 'message actions missing');
  assert.ok(changesIndex > actionsIndex, 'changes card should follow the action bar');
  assert.equal(mainText.split('已编辑').length - 1, 1, 'exactly one changes card per run');
  console.log('PASS exactly one changes card, placed after the answer action bar');

  // --- Action bar has the four required icons and no like ---
  const actions = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('#dc-root button[aria-label]')].map(b => b.getAttribute('aria-label'));
    return labels;
  });
  for (const want of ['复制', '分支', '事件', '用量']) {
    assert.ok(actions.includes(want), `missing action: ${want}`);
  }
  assert.ok(!actions.some(l => l.includes('赞') || l.includes('喜欢')), 'like action must be removed');
  console.log('PASS action bar keeps 复制/分支/事件/用量 and drops 点赞');

  // --- Sidebar holds the diff review ---
  const sidebar = await page.evaluate(() => document.body.innerText);
  assert.ok(sidebar.includes('第 2 轮变更'), 'sidebar diff panel missing');
  assert.ok(sidebar.includes('const delays = [1000, 4000, 16000]'), 'sidebar diff body missing');
  console.log('PASS sidebar carries the expanded diff review');

  // --- Composer board: model + effort drill-down ---
  await page.goto(boardUrl('Composer.dc.html'));
  await page.waitForSelector('#dc-root');
  const composer = await page.evaluate(() => ({
    errors: window.__designRuntime?.errors ?? [],
    text: document.body.innerText
  }));
  assert.deepEqual(composer.errors, []);
  assert.ok(composer.text.includes('模型'), 'model row missing');
  assert.ok(composer.text.includes('推理等级'), 'effort row missing');
  for (const level of ['关闭', '低', '高', '最高']) {
    assert.ok(composer.text.includes(level), `missing effort level ${level}`);
  }
  console.log('PASS composer menu offers model row and four effort levels');

  // --- Part boards render standalone ---
  for (const part of ['TurnBlock', 'MessageActions', 'ChangesCard', 'ComposerMenu', 'EffortMenu', 'SidebarDiff']) {
    await page.goto(boardUrl(`parts/${part}.dc.html`));
    await page.waitForSelector('#dc-root');
    const errs = await page.evaluate(() => window.__designRuntime?.errors ?? []);
    assert.deepEqual(errs, [], `${part} reported runtime errors`);
  }
  console.log('PASS all six component boards render without runtime errors');

  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  console.log('\nAll Super Agent interaction checks passed.');
} finally {
  await browser.close();
  server.close?.();
}
