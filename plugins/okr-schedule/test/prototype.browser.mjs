import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const prototype = new URL('../docs/2026-11-05-calendar-creation-mode/UI设计原型/index.html', import.meta.url).href;
async function launchChrome() {
  for (const executablePath of [process.env.CHROME_PATH, chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { await access(executablePath); } catch { continue; }
    return chromium.launch({ headless:true, executablePath });
  }
  throw new Error('需要本机 Chrome 或 Chromium，请设置 CHROME_PATH。');
}
const action = (page, name) => page.locator('[data-act="' + name + '"]:visible').first();
async function addMarker(page, text) {
  await action(page, 'new-event').click();
  await page.getByLabel('事项名称').fill(text);
  await action(page, 'add-event-save').click();
  await page.getByRole('dialog').waitFor({ state:'hidden' });
}
async function inCalendar(page) {
  await page.locator('.topnav [data-act="calendar"]').click();
  await page.getByRole('heading', { name:'日程总览' }).waitFor();
}
async function markerCount(page, text) {
  return page.locator('.agenda [data-act="event"]').filter({ hasText:text }).count();
}

test('offline prototype: annotated walkthrough, simulated host and isolated demo archives', { timeout:60000 }, async t => {
  const browser = await launchChrome();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport:{ width:1440, height:1000 }, offline:true });
  const errors = [];
  async function open(hash = '') {
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(prototype + hash, { waitUntil:'networkidle' });
    return page;
  }

  const calendar = await open();
  const numbered = calendar.locator('.guideline [data-act="guide-step"]');
  assert.equal(await numbered.count(), 5);
  await action(calendar, 'guide-toggle').click();
  assert.equal(await numbered.count(), 0);
  assert.equal(await calendar.locator('.badge:visible').count(), 0);
  await action(calendar, 'guide-toggle').click();
  assert.equal(await numbered.count(), 5);
  assert.ok(await calendar.locator('.badge:visible').count() > 0);
  for (const [n, heading] of ['日历与筛选', '助手与会话', '对话创建空间', '空间与复盘', '删除整个空间'].entries()) {
    if (n === 1) await calendar.getByRole('button', { name:'收起助手', exact:true }).click();
    await numbered.nth(n).click();
    const detail = calendar.getByRole('dialog');
    assert.match(await detail.innerText(), new RegExp(heading));
    assert.ok((await detail.locator('.modalbody').innerText()).length > 15);
    await action(detail, 'jump-step').click();
    if (n === 0) assert.equal(await calendar.locator('[data-filter-goal]:focus').count(), 1);
    if (n === 1) assert.equal(await calendar.locator('#assistant-input:focus').count(), 1);
    if (n === 2) {
      await calendar.getByRole('heading', { name:'创建一个目标空间' }).waitFor();
      assert.deepEqual(await calendar.locator('.guideline .route-btn').allTextContents(), ['① 描述目标','② 多轮修改草稿','③ 点击确定才创建或应用']);
      await action(calendar, 'creator-back').click();
    }
    if (n === 3) await calendar.getByRole('heading', { name:'学习英语', exact:true }).waitFor();
    if (n === 4) {
      assert.match(await detail.innerText(), /确认删除整个空间/);
      await detail.getByRole('button', { name:'取消', exact:true }).click();
      await inCalendar(calendar);
    }
  }

  await action(calendar, 'guide').click();
  assert.equal(await calendar.getByRole('dialog').locator('[data-act="guide-step"]').count(), 5);
  await calendar.getByRole('button', { name:'从 DSH 入口开始' }).click();
  await calendar.getByRole('heading', { name:'插件工作台' }).waitFor();
  await action(calendar, 'enter-plugin').click();
  await addMarker(calendar, '默认档专用事项');

  const feedback = await open('#kr-demo');
  await feedback.getByRole('heading', { name:'学习英语', exact:true }).waitFor();
  await addMarker(feedback, '反馈档专用事项');
  await inCalendar(feedback);
  const ledger = await open('#ledger-demo');
  await ledger.getByRole('heading', { name:'日常记账', exact:true }).waitFor();
  await addMarker(ledger, '记账档专用事项');
  await inCalendar(ledger);

  const host = await open('#dsh');
  await host.getByRole('heading', { name:'插件工作台' }).waitFor();
  await action(host, 'enter-plugin').click();
  assert.equal(await markerCount(host, '默认档专用事项'), 1);
  assert.equal(await markerCount(host, '反馈档专用事项'), 0);
  assert.equal(await markerCount(ledger, '反馈档专用事项'), 0);

  const reset = async page => {
    await action(page, 'about').click();
    await action(page, 'reset-ask').click();
    await page.getByRole('dialog').getByRole('heading', { name:'重置本机演示？' }).waitFor();
  };
  await reset(feedback);
  await feedback.getByRole('dialog').getByRole('button', { name:'取消', exact:true }).click();
  assert.equal(await markerCount(feedback, '反馈档专用事项'), 1);
  await reset(feedback);
  await action(feedback.getByRole('dialog'), 'reset').click();
  assert.equal(await markerCount(feedback, '反馈档专用事项'), 0);
  await feedback.reload();
  await inCalendar(feedback);
  assert.equal(await markerCount(feedback, '反馈档专用事项'), 0);

  await ledger.reload();
  await inCalendar(ledger);
  assert.equal(await markerCount(ledger, '记账档专用事项'), 1);
  await calendar.reload();
  assert.equal(await markerCount(calendar, '默认档专用事项'), 1);
  assert.deepEqual(errors, []);
});
