import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startPreview } from '../scripts/preview.mjs';
import { dataOf } from '../src/host/protocol.js';

test(
  'assistant sidebar, IME, replayed inputs, cited records, preview and invalidated cross-space totals',
  { skip: process.env.OKR_BROWSER_TEST !== '1', timeout: 80000 },
  async (t) => {
    // This test transport deliberately depends on evidence returned by the real Host, including exact IDs.
    const calls = [];
    const adapter = {
      available: true,
      async generate(request) {
        const { question, binding } = request.input;
        calls.push({ scene: binding.scene, question });
        if (binding.scene === 'calendar') {
          const answer = await request.tools[0].execute({ kind: 'schedule' });
          return {
            data: { text: '今天共 ' + answer.total + ' 项安排', refs: answer.rows.map((x) => x.ref) },
          };
        }
        if (question.includes('排版'))
          return {
            data: { text: '已准备紧凑排版预览', action: { kind: 'preview', layout: { dense: true } } },
          };
        if (question.includes('长期'))
          return {
            data: { text: '请核对新规则', action: { kind: 'policy', text: '以后先报收入，再列支出。' } },
          };
        if (question.includes('起草')) {
          const feedback = await request.tools[0].execute({ kind: 'feedback', keypoint: 'k1' });
          return {
            data: {
              text: '已根据执行起草反馈',
              refs: feedback.rows.map((e) => e.ref),
              action: { kind: 'feedback', kId: 'k1', text: '复测 20 词中 16 词达标。' },
            },
          };
        }
        throw new Error('测试收到未预期的问题');
      },
    };
    const preview = await startPreview({ calendarOnly: true, adapter });
    t.after(() => preview.close());
    const r = async (cmd, input = {}, oid = null) =>
      dataOf(
        await preview.service.execute(cmd, input, {
          trusted: true,
          userInitiated: true,
          global: !oid,
          objectiveId: oid,
        }),
      );
    const today = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'Asia/Shanghai',
    }).format(new Date());
    async function seed(name, n) {
      const goal = {
        name,
        about: '合成助手验收',
        ks: [{ id: 'k1', name: '词汇', standard: '复测 120 词', from: today, to: today, kind: '词汇' }],
        assistantRule: '先核对执行',
      };
      const events = Array.from({ length: n }, (_, i) => ({
        id: 'e' + i,
        title: name + i,
        date: today,
        time: '19:30',
        duration: 20,
        kind: '词汇',
      }));
      return (
        await r('calendar.confirm', { confirm: true, draft: { id: crypto.randomUUID(), goal, events } })
      ).objectiveId;
    }
    const english = await seed('英语', 2),
      reading = await seed('阅读', 1);
    const before = (await r('calendar.space', {}, english)).events[0];
    await r(
      'calendar.execution.save',
      { event: { ...before, note: '已复测', measure: '20 词中 16 词达标' } },
      english,
    );
    let binary = process.env.CHROME_PATH;
    for (const f of [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
    ])
      if (!binary)
        try {
          await fs.access(f);
          binary = f;
        } catch {}
    const browser = await chromium.launch({ executablePath: binary, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      timezoneId: 'Asia/Shanghai',
    });
    page.setDefaultTimeout(6500);
    const ui = page.frameLocator('iframe[title="目标日程工作区"]'),
      box = ui.getByLabel('助手消息', { exact: true }),
      panel = ui.getByRole('complementary', { name: '日程助手' });
    const btn = (text, scope = ui) => scope.getByRole('button', { name: text, exact: true });
    const err = [];
    page.on('pageerror', (e) => err.push(e.message));
    t.after(() => assert.deepEqual(err, []));
    await page.goto(preview.url, { waitUntil: 'networkidle' });
    await btn('发送问题：今天做什么', panel).waitFor();
    assert.equal(calls.length, 0);
    await box.fill('未发送草稿');
    assert.equal(await btn('发送问题：今天做什么', panel).isVisible(), false);
    await box.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
    assert.equal(calls.length, 0);
    await box.press('Shift+Enter');
    assert.ok((await box.inputValue()).includes('\n'));
    await btn('新建聊天会话', panel).click();
    await ui.locator('#session option').filter({ hasText: '会话 2' }).waitFor({ state: 'attached' });
    await btn('发送问题：今天做什么', panel).click();
    await panel.getByText('今天共 3 项安排', { exact: true }).waitFor();
    assert.equal(await panel.locator('.source:visible').count(), 2);
    await panel.getByText('展开其余 1 条').click();
    assert.equal(await panel.locator('.source:visible').count(), 3);
    if (process.env.OKR_BROWSER_SCREENSHOTS)
      await page.screenshot({
        path: path.join(process.env.OKR_BROWSER_SCREENSHOTS, 'calendar-assistant-citations.png'),
      });
    await panel.locator('.source').first().click();
    await ui.getByRole('dialog').waitFor();
    await btn('关闭').click();
    assert.equal(calls.length, 1);
    await ui.getByLabel('切换聊天会话').selectOption({ label: '会话 1' });
    await box.waitFor();
    await ui.locator('#assistant-input').evaluate(
      (el) =>
        new Promise((resolve, reject) => {
          const start = Date.now();
          const timer = setInterval(() => {
            const input = document.querySelector('#assistant-input');
            if (input?.value.includes('未发送草稿')) {
              clearInterval(timer);
              resolve();
            } else if (Date.now() - start > 4000) {
              clearInterval(timer);
              reject(Error('未恢复未发送文字'));
            }
          }, 40);
        }),
    );
    await btn('打开空间 英语').click();
    await ui.getByText('仅当前空间 · 英语').waitFor();
    assert.equal(await box.inputValue(), '');
    await box.fill('改成紧凑排版');
    await box.press('Enter');
    await btn('查看事项区预览').waitFor();
    await btn('查看事项区预览').click();
    await btn('放弃', ui.locator('.preview-note')).click();
    assert.equal(await btn('查看事项区预览').count(), 0);
    assert.equal((await r('calendar.space', {}, english)).goal.layout.dense, false);
    await btn('填写或起草反馈：词汇').click();
    await ui.getByRole('dialog').getByRole('button', { name: /起草/ }).click();
    await ui.locator('#r-text').waitFor();
    assert.match(await ui.locator('#r-text').inputValue(), /16/);
    assert.equal((await r('calendar.space', {}, english)).goal.ks[0].r, '');
    await btn('确认保存反馈').click();
    await ui.locator('.rside p').filter({ hasText: '复测 20 词中 16 词达标。' }).waitFor();
    await box.fill('以后使用新的长期规则');
    await box.press('Enter');
    await btn('在创造模式核对规则').click();
    await ui.locator('[data-df=assistantRule]').waitFor();
    assert.equal(await ui.locator('[data-df=assistantRule]').inputValue(), '以后先报收入，再列支出。');
    assert.equal((await r('calendar.space', {}, english)).goal.assistantRule, '先核对执行');
    await btn('确定应用').click();
    await ui.locator('.spacehead').waitFor();
    assert.equal((await r('calendar.space', {}, english)).goal.assistantRule, '以后先报收入，再列支出。');
    await btn('删除空间', ui.locator('.spacehead')).click();
    await ui
      .getByRole('dialog')
      .getByRole('button', { name: /确认删除/ })
      .click();
    await ui.getByText('全局 · 全部目标').waitFor();
    await ui.getByLabel('切换聊天会话').selectOption({ label: '今天做什么' });
    await panel.getByText('部分来源已失效，请重新查询。').waitFor();
    assert.equal(await panel.locator('.source').count(), 1);
    await panel.locator('.source').click();
    await ui.getByRole('dialog').getByRole('heading', { name: '阅读0' }).waitFor();
    assert.equal((await r('calendar.catalog')).spaces[0].id, reading);
    assert.equal(calls.length, 4);
  },
);
