import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startPreview } from '../scripts/preview.mjs';

const day = '2026-11-05';
const contextFor = (oid) => ({
  trusted: true,
  userInitiated: true,
  global: !oid,
  objectiveId: oid,
  sourceScope: oid ? { kind: 'private', id: oid } : undefined,
});
function draft(id, name, time, title) {
  return {
    id,
    goal: {
      name,
      about: '合成验收',
      ks: [{ id: 'k', name: '阶段练习', standard: '完成练习后复测', from: day, to: day }],
      assistantRule: '引用本空间练习。',
    },
    events: [{ id: 'same-id', title, kind: '练习', date: day, time, duration: 30 }],
  };
}
test(
  'calendar: prototype date, views, shared forms, occurrence identity, delete from either entry',
  { timeout: 100000 },
  async (t) => {
    const preview = await startPreview({ calendarOnly: true });
    t.after(() => preview.close());
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1420, height: 880 },
      timezoneId: 'Asia/Shanghai',
    });
    await page.clock.setFixedTime(new Date(day + 'T12:00:00+08:00'));
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.setDefaultTimeout(6000);
    async function call(cmd, input = {}, oid) {
      const r = await preview.service.execute(cmd, input, contextFor(oid));
      assert.ok(['saved', 'read'].includes(r.kind), JSON.stringify(r));
      return r.data;
    }
    const seed = async (...args) =>
      (await call('calendar.confirm', { draft: draft(...args), confirm: true })).objectiveId;
    const english = await seed('eng', '学习英语', '19:30', '词汇复测'),
      reading = await seed('read', '深度阅读', '20:30', '阅读与摘记');
    const frame = page.frameLocator('iframe[title="目标日程工作区"]');
    const button = (label, scope = frame) => scope.getByRole('button', { name: label, exact: true });
    const agenda = frame.locator('.agenda');
    const modal = frame.getByRole('dialog');
    await page.goto(preview.url, { waitUntil: 'networkidle' });
    assert.equal(await frame.locator('.caltools h2').innerText(), '2026 年 11 月');
    await frame.getByLabel('在日历中显示深度阅读').uncheck();
    assert.deepEqual(await agenda.locator('.erow time').allTextContents(), ['19:30']);
    await frame.getByLabel('在日历中显示深度阅读').check();
    assert.deepEqual(await agenda.locator('.erow strong').allTextContents(), ['词汇复测', '阅读与摘记']);
    // Compare against the unannotated prototype at the same viewport.
    const reference = await browser.newPage({ viewport: page.viewportSize() });
    await reference.goto(
      new URL('../docs/2026-11-05-calendar-creation-mode/UI设计原型/index.html', import.meta.url).href,
    );
    if (await reference.locator('.guideline').count())
      await reference.locator('[data-act=guide-toggle]').click();
    for (const selector of ['.top', '.rail', '.calpanel', '.assistant']) {
      const expected = await reference.locator(selector).boundingBox(),
        actual = await frame.locator(selector).boundingBox();
      assert.ok(Math.abs(expected.width - actual.width) < 2, selector + ' width');
      assert.ok(Math.abs(expected.x - actual.x) < 2, selector + ' position');
    }
    await reference.close();
    if (process.env.OKR_BROWSER_SCREENSHOTS) {
      await fs.mkdir(process.env.OKR_BROWSER_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OKR_BROWSER_SCREENSHOTS, 'calendar.png') });
    }
    await button('周视图').click();
    await frame.locator('.time-head .time-label').first().waitFor();
    assert.equal(await frame.locator('.time-head .time-label').count(), 7);
    await button('周四 5').click();
    await frame.locator('.block-event').filter({ hasText: '词汇复测' }).click();
    await modal.getByRole('heading', { name: '词汇复测' }).waitFor();
    await button('关闭', modal).click();
    await button('月视图').click();
    await button('下一时段').click();
    await frame.locator('.caltools h2').filter({ hasText: '12 月' }).waitFor();
    await button('今天', frame.locator('.caltools')).click();
    await button('清空', frame.locator('.rail')).click();
    await agenda.getByText('勾选目标后即可查看相应事项。').waitFor();
    await button('＋ 添加事项', agenda).click();
    assert.equal(await modal.getByLabel('日期', { exact: true }).inputValue(), day);
    assert.equal(await modal.getByLabel('开始时间').inputValue(), '19:30');
    assert.equal(await modal.getByLabel('类型', { exact: true }).inputValue(), '实践');
    await modal.getByLabel('所属 O').selectOption(english);
    await modal.getByLabel('事项名称').fill('重叠练习');
    for (const minutes of ['0', '1441']) {
      await modal.getByLabel('计划时长').fill(minutes);
      await button('保存事项', modal).click();
      await modal
        .getByRole('alert')
        .getByText(/1 至 1440/)
        .waitFor();
      assert.equal(await modal.getByLabel('事项名称').inputValue(), '重叠练习');
    }
    await modal.getByLabel('计划时长').fill('1440');
    await button('保存事项', modal).click();
    await modal.waitFor({ state: 'hidden' });
    await agenda.locator('.erow').filter({ hasText: '重叠练习' }).waitFor();
    assert.equal(await frame.getByLabel('在日历中显示学习英语').isChecked(), true);
    await frame.getByLabel('在日历中显示深度阅读').check();
    const cell = frame.locator('[data-cell="' + day + '"]');
    assert.equal(await cell.locator('.eventchip').count(), 2);
    await button('+1 项', cell).click();
    await frame.locator('.time-head').waitFor();
    const overlap = frame.locator('.block-event').filter({ hasText: '重叠练习' });
    await overlap.click();
    await modal.getByLabel('实际情况').fill('完成 20 词复测');
    await button('完成并保存', modal).click();
    await modal.waitFor({ state: 'hidden' });
    await overlap.click();
    await modal.getByLabel('实际情况').fill('独立答对 16 词');
    await button('保存执行记录', modal).click();
    await modal.waitFor({ state: 'hidden' });
    const snapshot = await call('calendar.space', {}, english);
    assert.equal(snapshot.events.filter((e) => e.title === '重叠练习').length, 1);
    assert.equal(snapshot.events.find((e) => e.title === '重叠练习').note, '独立答对 16 词');
    assert.equal(snapshot.goal.ks[0].r, '');
    assert.ok(!snapshot.goal.ks[0].achievedOn);
    await overlap.click();
    await button('打开所属空间', modal).click();
    await frame.locator('.spacehead').filter({ hasText: '学习英语' }).waitFor();
    await frame.locator('[data-act=new-event]').click();
    assert.equal(await modal.getByLabel('所属 O').isDisabled(), true);
    await modal.getByLabel('事项名称').fill('空间新增');
    await modal.getByLabel('计划时长').fill('1');
    await button('保存事项', modal).click();
    await modal.waitFor({ state: 'hidden' });
    await frame.locator('[data-act=new-event]').click();
    await modal.getByLabel('事项名称').fill('放弃的编辑');
    await modal.getByLabel('事项名称').press('Escape');
    assert.equal(
      (await call('calendar.space', {}, english)).events.some((e) => e.title === '放弃的编辑'),
      false,
    );
    await frame.locator('.top [data-act=calendar]').click();
    await agenda.locator('.erow').filter({ hasText: '空间新增' }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await agenda.locator('.erow').count(), 4);
    await button('删除空间', frame.locator('.rail')).click();
    assert.equal(await modal.locator('select').inputValue(), '');
    assert.equal(await button('确认删除整个空间', modal).isDisabled(), true);
    await modal.locator('select').selectOption(english);
    await modal.getByText(/3 件事项/).waitFor();
    await button('取消', modal).click();
    await button('打开空间 学习英语').click();
    await frame.locator('.spacehead').filter({ hasText: '学习英语' }).waitFor();
    await frame.locator('[data-act=delete-space]').click();
    await button('确认删除整个空间', modal).click();
    await modal.waitFor({ state: 'hidden' });
    await frame.getByRole('heading', { name: '日程总览' }).waitFor();
    assert.deepEqual(
      (await call('calendar.catalog')).spaces.map((s) => s.id),
      [reading],
    );
    await page.setViewportSize({ width: 390, height: 800 });
    await frame.locator('.pagehead [data-act=delete-global]').click();
    await modal.locator('select').selectOption(reading);
    // The directory can already be isolated when cleaning the old index fails.
    const index = path.join(preview.baseDir, 'global_index.json');
    await fs.writeFile(index, '{}');
    await button('确认删除整个空间', modal).click();
    await modal
      .getByRole('alert')
      .filter({ hasText: /索引|清理/ })
      .waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await button('继续清理').click();
    await fs.writeFile(index, JSON.stringify({ objectives: [{ id: reading }] }));
    await button('确认继续清理', modal).click();
    await modal.waitFor({ state: 'hidden' });
    await frame.getByText('还没有目标空间。').waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await frame.getByText('还没有目标空间。').waitFor();
    assert.deepEqual((await call('calendar.catalog')).spaces, []);
    assert.equal(await frame.getByRole('button', { name: '重置演示' }).count(), 0);
    assert.deepEqual(errors, []);
  },
);
