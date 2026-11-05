import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startPreview } from '../scripts/preview.mjs';
import { layoutDefault, shift } from '../src/client/common.js';

const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const tomorrow = shift(today, 1);
async function capture(page, name) {
  if (!process.env.OKR_BROWSER_SCREENSHOTS) return;
  await fs.mkdir(process.env.OKR_BROWSER_SCREENSHOTS, { recursive:true });
  await page.screenshot({ path:path.join(process.env.OKR_BROWSER_SCREENSHOTS, name + '.png') });
}

const enabled = process.env.OKR_BROWSER_TEST === '1';
const sampleK = (i, from, to) => ({ id:'K' + i, name:'阶段目标 ' + i, standard:'核对复测结果 ' + i, from, to });
const event = (id, title, date, duration, kind = '词汇') =>
  ({ id, oid:'preview', kind, title, date, time:'19:30', duration, status:'plan' });

async function setup(t, adapter = null) {
  const preview = await startPreview({ calendarOnly:true, adapter });
  t.after(() => preview.close());
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/chromium', '/usr/bin/google-chrome'];
  let executablePath;
  for (const file of candidates.filter(Boolean)) {
    try { await fs.access(file); executablePath = file; break; } catch { /* try the next browser */ }
  }
  const browser = await chromium.launch({ executablePath, headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1360, height:850 }, timezoneId:'Asia/Shanghai' });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const ui = page.frameLocator('iframe[title="目标日程工作区"]');
  const button = (name, scope = ui) => scope.getByRole('button', { name, exact:true });
  async function call(command, input = {}, oid = null) {
    const result = await preview.service.execute(command, input, { trusted:true, userInitiated:true, global:!oid,
      objectiveId:oid, sourceScope:oid ? { kind:'private', id:oid } : undefined });
    assert.ok(['saved','read'].includes(result.kind), JSON.stringify(result));
    return result.data;
  }
  async function seed(name, ks, events, extras = {}) {
    const draft = { id:'draft_' + crypto.randomUUID(), goal:{ id:'preview', name, about:'', ks,
      assistantRule:'先核对本空间的记录。', layout:layoutDefault(), ...extras }, events };
    return (await call('calendar.confirm', { draft, confirm:true })).objectiveId;
  }
  async function open(name) {
    await page.goto(preview.url, { waitUntil:'networkidle' });
    await button('打开空间 ' + name).click();
    await ui.locator('.spacehead h1').filter({ hasText:name }).waitFor();
  }
  return { preview, ui, button, page, call, seed, open };
}

test('space interaction: K/R grouping, scroll, one feedback, filters and default versus style', { skip:!enabled, timeout:90000 }, async t => {
  const { ui, button, page, call, seed, open } = await setup(t);
  const dates = [today, today, tomorrow, shift(today, 2), shift(today, 3), shift(today, -1), shift(today, -2)];
  const ks = dates.map((end, i) => sampleK(i + 1, i === 4 ? tomorrow : shift(today,-8), end));
  const oid = await seed('英语练习', ks, [
    event('ev1','词汇复测', today, 20), event('ev2','词义复述', today, 15), event('ev3','词汇巩固', today, 20)
  ]);
  const initial = await call('calendar.space', {}, oid);
  for (const e of initial.events.slice(0,2)) await call('calendar.execution.save',
    { event:{ ...e, note:'复测 20 词', measure:'达标 16 词' } }, oid);
  await open('英语练习');
  await capture(page, 'calendar-space-feedback');
  assert.equal(await ui.locator('#kr-list .krrow').count(), 5);
  assert.match(await ui.locator('#kr-list').innerText(), /今天截止/);
  assert.match(await ui.locator('#kr-list').innerText(), /未开始/);
  await ui.locator('#kr-jump').selectOption('K5');
  await ui.locator('#kr-list').press('End');
  assert.ok(await ui.locator('#kr-list').evaluate(el => el.scrollTop > 0));
  await ui.locator('#kr-list').press('Home');
  for (const id of [5,4]) {
    await button('标记已实现：阶段目标 ' + id).click();
    await ui.locator('.kr-view.pending').filter({hasText:String(id-1)}).waitFor();
    assert.equal(await ui.locator('#kr-jump').count(),id === 5 ? 1 : 0);
  }
  await ui.locator('.kr-view.achieved').click();
  for (const id of [5,4]) {
    const undo = button('撤销已实现：阶段目标 ' + id);
    await undo.click(); await undo.waitFor({state:'hidden'});
  }
  await ui.locator('.kr-view.pending').click();
  await button('标记已实现：阶段目标 1').click();
  await ui.locator('.kr-view.achieved').filter({ hasText:'1' }).waitFor();
  await ui.locator('.kr-view.achieved').click();
  await button('填写或起草反馈：阶段目标 1').click();
  await ui.locator('#r-text').fill('第一次复测结果');
  await button('确认保存反馈').click();
  await ui.locator('.rside p').filter({ hasText:'第一次复测结果' }).waitFor();
  await button('填写或起草反馈：阶段目标 1').click();
  await ui.locator('#r-text').fill('修订后的复测结果');
  await button('确认保存反馈').click();
  await ui.locator('.rside p').filter({ hasText:'修订后的复测结果' }).waitFor();
  await button('撤销已实现：阶段目标 1').click();
  await ui.locator('#kr-list .empty').waitFor();
  await ui.locator('.kr-view.expired').click();
  assert.equal(await ui.locator('#kr-jump').count(), 0);
  await button('填写或起草反馈：阶段目标 6').click();
  await ui.locator('#r-text').fill('未保存'); await button('关闭').click();
  await button('标记已实现：阶段目标 6').click();
  await ui.locator('.kr-view.expired').filter({ hasText:'1' }).waitFor();
  const changed = await call('calendar.space', {}, oid);
  assert.equal(changed.goal.ks[0].rId, initial.goal.ks[0].rId);
  assert.equal(changed.goal.ks[0].r, '修订后的复测结果');
  assert.equal(changed.goal.ks[0].achievedOn, null);
  assert.equal(changed.goal.ks[5].r, '');
  await button('视图规则').click();
  await ui.getByLabel('分组', { exact:true }).selectOption('week');
  await ui.getByLabel('统计口径').selectOption('minutes');
  await button('预览当前空间').click();
  await ui.locator('.group-title').filter({ hasText:'55 分钟' }).waitFor();
  await button('放弃', ui.locator('.preview-note')).click();
  await button('视图规则').click();
  await ui.getByLabel('统计口径').selectOption('rate');
  await button('预览当前空间').click();
  await ui.locator('.group-title').filter({ hasText:'67%' }).waitFor();
  await button('保存为默认').click();
  await ui.locator('.preview-note').waitFor({state:'hidden'});
  await ui.getByLabel('事项状态', {exact:true}).selectOption('done');
  await button('视图规则').click();
  await ui.getByLabel('展示方式').selectOption('cards');
  await button('预览当前空间').click();
  await button('应用排版').click();
  await ui.locator('.preview-note').waitFor({state:'hidden'});
  let saved = (await call('calendar.space', {}, oid)).goal.layout;
  assert.equal(saved.filters.status, 'all'); assert.equal(saved.style, 'cards');
  await button('视图规则').click();
  await ui.getByLabel('统计口径').selectOption('minutes');
  await button('预览当前空间').click();
  await ui.locator('.group-title').filter({hasText:'35 分钟'}).waitFor();
  await button('保存为默认').click();
  await ui.locator('.preview-note').waitFor({state:'hidden'});
  saved = (await call('calendar.space', {}, oid)).goal.layout;
  assert.equal(saved.filters.status, 'done'); assert.equal(saved.metric, 'minutes');
  await ui.getByRole('searchbox').fill('零匹配');
  await button('设为默认…').click(); await button('保存为默认').click();
  await ui.locator('.preview-note').waitFor({state:'hidden'});
  await open('英语练习');
  assert.equal(await ui.getByRole('searchbox').inputValue(), '零匹配');
  await ui.locator('.empty').filter({hasText:'没有符合条件的事项'}).waitFor();
  await page.setViewportSize({width:500,height:810});
  assert.equal(await ui.locator('.krrow').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
});

test('ledger month, currency, current category, actual receipt, edit and fresh Markdown', { skip:!enabled, timeout:90000 }, async t => {
  const { ui, button, page, call, seed, open } = await setup(t);
  // Historical November is usable on any later run. The fixed PRD case is replayed without advancing the Host clock.
  const year = Number(today.slice(0,4)) - (today.slice(5) < '11-05' ? 1 : 0);
  const nov = year + '-11-02', oct = year + '-10-01';
  const layout = { ...layoutDefault(), group:'month', metric:'cash', style:'cards' };
  const oid = await seed('日常记账', [sampleK(1,nov,nov)],
    [event('reconcile', '核账提醒', nov, 30, '核账')], { bookkeeping:true, layout });
  const add = (title, date, kind, cents, flow, currency='CNY') => call('calendar.ledger.save', {
    event:{ title,date,time:'12:00',kind,posting:{ flow,currency,cents } }
  }, oid);
  await add('买菜', nov,'餐饮',12000,'expense'); await add('交通',nov,'交通',3000,'expense');
  await add('工资',nov,'工资',600000,'income'); await add('外币账目',nov,'交通',2000,'expense','USD');
  await add('上月账目',oct,'交通',8888,'expense');
  await open('日常记账');
  await capture(page, 'calendar-space-ledger');
  const month = ui.locator('.cash-group').filter({hasText:year + '-11'}).filter({hasText:'CNY'});
  await month.getByText('¥150.00', {exact:true}).waitFor();
  await month.getByText('¥6,000.00', {exact:true}).waitFor();
  await ui.getByText('USD 20.00', {exact:true}).waitFor();
  await ui.locator('.calfoot').filter({hasText:'1 项未参与金额合计'}).waitFor();
  await ui.getByLabel('事项类型', {exact:true}).selectOption('餐饮');
  await month.getByText('¥120.00', {exact:true}).waitFor();
  await month.locator('details').first().locator('summary').click();
  await month.getByRole('button').filter({hasText:'买菜'}).click();
  const dialog = ui.getByRole('dialog');
  await dialog.getByRole('heading', {name:'买菜'}).waitFor();
  const amountField = dialog.getByLabel(/金额/).first();
  await amountField.fill('123.45');
  await dialog.locator('#ev-flow').selectOption('income');
  await dialog.locator('#event-note').fill('临时调整方向');
  await button('保存执行记录', dialog).click();
  const income = month.locator('details').filter({hasText:'收入'});
  await income.getByText('¥123.45', {exact:true}).waitFor();
  await income.locator('summary').click();
  await income.getByRole('button').filter({hasText:'买菜'}).click();
  assert.equal(await dialog.locator('#event-note').inputValue(),'临时调整方向');
  await dialog.locator('#ev-flow').selectOption('expense');
  await button('保存执行记录', dialog).click();
  await month.getByText('¥123.45', {exact:true}).waitFor();
  assert.equal((await call('calendar.space',{},oid)).events.filter(e => e.title === '买菜').length, 1);
  await button('清除筛选').click();
  await button('记一笔').click();
  await ui.locator('#pay-title').fill('取消账目');
  await button('取消', dialog).click();
  await button('记一笔').click();
  await ui.locator('#pay-title').fill('补记饮料'); await ui.locator('#pay-date').fill(tomorrow);
  await ui.locator('#pay-amount').fill('5.678');
  await button('确认入账').click();
  assert.equal(await ui.locator('#pay-title').inputValue(),'补记饮料');
  await ui.locator('#pay-date').fill(nov); await ui.locator('#pay-amount').fill('5.67');
  await button('确认入账').click();
  await month.getByText('¥159.12', {exact:true}).waitFor();
  await button('空间资料').click();
  const downloads = {};
  for (const name of ['空间概览.md','AGENTS.md']) {
    const pending = page.waitForEvent('download');
    await button('导出' + (name === 'AGENTS.md' ? ' ' : '') + name).click();
    const file = await pending;
    downloads[name] = await fs.readFile(await file.path(),'utf8');
    assert.equal(file.suggestedFilename(),name);
  }
  assert.match(downloads['空间概览.md'],/123\.45/);
  assert.doesNotMatch(downloads['空间概览.md'],/取消账目/);
  assert.equal(downloads['AGENTS.md'],'先核对本空间的记录。');
});

test('one resumable creation draft, edit both tabs, recheck conflicts and button commit', { skip:!enabled, timeout:90000 }, async t => {
  const { ui, button, page, call, seed, open } = await setup(t);
  const oid = await seed('已确认目标', [sampleK(1,today,tomorrow)], [event('base','基线计划',tomorrow,30)]);
  await open('已确认目标');
  await button('调整目标').click();
  await ui.getByLabel('目标说明').fill('暂存说明');
  await button('关闭创造模式').click();
  await button('创建空间',ui.getByRole('banner')).click();
  await button('取消').click();
  assert.equal((await call('calendar.space',{},oid)).goal.about,'');
  await button('创建空间',ui.getByRole('banner')).click(); await button('继续原草稿').click();
  assert.equal(await ui.getByLabel('目标说明').inputValue(),'暂存说明');
  await button('关闭创造模式').click(); await button('创建空间',ui.getByRole('banner')).click(); await button('放弃并切换').click();
  assert.equal(await button('确定创建').isDisabled(),true);
  await page.setViewportSize({width:496,height:780});
  const choice = ui.getByLabel('填写目标示例');
  assert.equal(await choice.locator('option').count(),4);
  await choice.selectOption({index:2});
  const message = ui.getByRole('textbox',{name:'创造模式消息'});
  assert.match(await message.inputValue(),/英语/);
  await message.fill('尚未发送的半句');
  assert.equal(await ui.locator('#studiolog article').count(),0);
  await button('方案预览').click();
  await ui.locator('.draft-empty').waitFor();
  await button('创造对话').click();
  assert.equal(await message.inputValue(),'尚未发送的半句');
  await button('方案预览').click();
  await button('手工填写方案').click();
  await page.setViewportSize({width:1360,height:850});
  await ui.getByLabel('空间名称').fill('手工新建空间'); await button('＋ K').click();
  assert.equal(await ui.getByLabel('开始日期').inputValue(),today);
  assert.equal(await ui.getByLabel('截止日期').inputValue(),shift(today,27));
  await ui.getByLabel('过程目标',{exact:true}).fill('词汇复测');
  await ui.getByLabel('达标标准',{exact:true}).fill('独立说出 16 个词义');
  await ui.getByLabel('空间助手规则').fill('引用复测结果。');
  await capture(page, 'calendar-creator');
  await ui.locator('.draftpane').getByRole('button',{name:'日程',exact:true}).click(); await button('＋ 一项').click();
  assert.equal(await ui.getByLabel('开始时间').inputValue(),'19:30');
  assert.equal(await ui.getByLabel('计划时长（分钟）').inputValue(),'30');
  await ui.getByLabel('事项名称').fill('另一项练习');
  await ui.locator('.draftpane .subform p.micro').filter({hasText:'重叠'}).waitFor();
  await ui.getByLabel('开始时间').fill('20:00');
  await ui.locator('.draftpane .subform p.micro').waitFor({state:'hidden'});
  await button('＋ 一项').click(); assert.equal(await button('确定创建').isDisabled(),true);
  assert.equal(await ui.getByLabel('日期',{exact:true}).last().inputValue(),shift(today,2));
  await ui.locator('[data-act="rm-draft-event"]').last().click();
  await button('关闭创造模式').click();
  await page.reload({waitUntil:'networkidle'});
  await button('创建空间',ui.getByRole('banner')).click();
  assert.equal(await ui.getByLabel('空间名称').inputValue(),'手工新建空间');
  await button('确定创建').click();
  await ui.locator('.spacehead h1').filter({hasText:'手工新建空间'}).waitFor();
  const all = await call('calendar.catalog');
  const newId = all.spaces.find(s=>s.name === '手工新建空间').id;
  const {events,goal}=await call('calendar.space',{},newId);
  assert.equal(events.length,1); assert.equal(goal.ks.length,1);
  await button('调整目标').click();
  await ui.getByLabel('分组', {exact:true}).selectOption('week');
  await button('关闭创造模式').click();
  await button('视图规则').click();
  await ui.getByLabel('展示方式').selectOption('cards');
  await button('预览当前空间').click(); await button('应用排版').click();
  await ui.locator('.preview-note').waitFor({state:'hidden'});
  await button('调整目标').click(); await button('确定应用').click();
  const conflict = ui.getByRole('dialog');
  await conflict.getByRole('heading',{name:'已确认的方案有更新'}).waitFor();
  await button('已核对，使用草稿', conflict).click();
  await ui.locator('.spacehead h1').filter({hasText:'手工新建空间'}).waitFor();
  const final = await call('calendar.space',{},newId);
  assert.equal(final.goal.layout.group,'week'); assert.equal(final.goal.layout.style,'list');
  await call('calendar.execution.save',{event:{...final.events[0],note:'已完成复测'}},newId);
  await button('调整目标').click();
  await ui.locator('.draftpane').getByRole('button',{name:'日程',exact:true}).click();
  assert.equal(await ui.locator('.draftpane .subform').count(),0);
  await ui.locator('.draftpane').getByRole('button',{name:'空间',exact:true}).click();
  await ui.getByLabel('空间助手规则').fill('以后优先报告实测结果。');
  await button('确定应用').click();
  await ui.locator('.spacehead h1').filter({hasText:'手工新建空间'}).waitFor();
  const onlyRule = await call('calendar.space',{},newId);
  assert.equal(onlyRule.goal.assistantRule,'以后优先报告实测结果。');
  assert.equal(onlyRule.events[0].note,'已完成复测');
  assert.equal(onlyRule.events.length,1);
});

test('create by conversation, revise and resume, confirm, execute from calendar, draft one R, export both files', { skip:!enabled, timeout:90000 }, async t => {
  const calls = [];
  const adapter = { available:true, async generate({input,tools}) {
    const {scene,today:date,selectedK} = input.binding;
    calls.push(scene);
    if (scene === 'new' && !input.currentDraft.goal) return { data:{
      text:'已拟定词汇与听力目标以及两项练习。',
      changes:{ goal:{ name:'英语自学',about:'每周参加复测',assistantRule:'先引用本空间的复测结果。' }, keypoints:[
        { name:'掌握 120 个新词', standard:'独立复测',from:date,to:shift(date,28),kind:'词汇' },
        { name:'听懂购物对话', standard:'回答对话问题',from:date,to:shift(date,56),kind:'听力' }
      ],events:[
        { title:'词汇复测',kind:'词汇',date,time:'19:30',duration:20 },
        { title:'对话练习',kind:'听力',date:shift(date,1),time:'19:30',duration:20 }
      ]}
    } };
    if (scene === 'new') {
      const first = input.currentDraft.events[0];
      assert.equal(input.currentDraft.goal.about,'先词汇，再听力');
      return {data:{ text:'首项改到上午十点，按周汇总计划时长。',changes:{
        goal:{layout:{group:'week',metric:'minutes'}},events:[{id:first.id,time:'10:00'}]
      }}};
    }
    assert.equal(scene,'space');
    const evidence = await tools[0].execute({kind:'feedback',keypoint:selectedK});
    assert.equal(evidence.rows.length,1);
    const row = evidence.rows[0]; assert.equal(row.status,'done'); assert.equal(row.actual,'复测 20 词，16 词达标');
    return {data:{text:'已根据本次执行起草反馈。', action:{kind:'feedback',kId:selectedK,text:row.actual+'。'}, refs:[row.ref]}};
  }};
  const {preview,page,ui,button,call} = await setup(t,adapter);
  await page.goto(preview.url,{waitUntil:'networkidle'});
  await button('创建空间',ui.getByRole('banner')).click();
  const input = ui.getByLabel('创造模式消息',{exact:true});
  await input.fill('建英语自学空间，四周掌握 120 词，八周听懂购物对话。'); await input.press('Enter');
  await ui.getByLabel('空间名称').waitFor();
  await ui.getByLabel('目标说明').fill('先词汇，再听力');
  await input.fill('首项改成 10:00，按周统计计划分钟。'); await input.press('Enter');
  await ui.locator('#studiolog .bubble').filter({hasText:'首项改到上午十点'}).waitFor();
  assert.equal((await call('calendar.catalog')).spaces.length,0);
  await button('关闭创造模式').click();
  await button('创建空间',ui.getByRole('banner')).click();
  const draft = ui.locator('.draftpane');
  assert.equal(await draft.getByLabel('分组',{exact:true}).inputValue(),'week');
  assert.equal(await draft.getByLabel('统计口径',{exact:true}).inputValue(),'minutes');
  await button('日程',draft).click();
  assert.equal(await draft.getByLabel('开始时间').first().inputValue(),'10:00');
  await button('确定创建').click();
  await ui.locator('.spacehead h1').filter({hasText:'英语自学'}).waitFor();
  const [created] = (await call('calendar.catalog')).spaces;
  assert.equal(created.name,'英语自学');
  const original = await call('calendar.space',{},created.id);
  assert.equal(original.events.length,2);
  const k = original.goal.ks.find(k=>k.kind==='词汇');
  await button('日程',ui.locator('.topnav')).click();
  const first = ui.locator('.month-grid [data-act="event"]').filter({hasText:'词汇复测'});
  await first.click();
  await ui.getByLabel('实际情况').fill('已进行独立复测'); await ui.getByLabel('实测结果').fill('复测 20 词，16 词达标');
  await button('完成并保存').click();
  await ui.getByRole('dialog').waitFor({state:'hidden'});
  await button('打开空间 英语自学').click();
  await button('填写或起草反馈：掌握 120 个新词').click();
  await button('AI 起草',ui.getByRole('dialog')).click();
  await ui.locator('#r-text').waitFor();
  assert.equal(await ui.locator('#r-text').inputValue(),'复测 20 词，16 词达标。');
  const snapshot = await call('calendar.space',{},created.id);
  assert.equal(snapshot.goal.ks.find(row=>row.id===k.id).r,'');
  await ui.locator('#r-text').fill('本次独立复测达标 16/20，继续巩固。');
  await button('确认保存反馈').click();
  await ui.locator('.rside p').filter({hasText:'继续巩固'}).waitFor();
  const final = await call('calendar.space',{},created.id);
  const feedback = final.goal.ks.find(row=>row.id===k.id);
  assert.equal(feedback.rId,k.rId); assert.equal(feedback.achievedOn,null);
  assert.equal(final.events.filter(row=>row.status==='done').length,1);
  await button('空间资料').click();
  for (const [name,label,content] of [
    ['空间概览.md','导出空间概览.md',/本次独立复测达标 16\/20/],
    ['AGENTS.md','导出 AGENTS.md',/^先引用本空间的复测结果。$/]
  ]) {
    const download = page.waitForEvent('download');
    await button(label).click();
    const file = await download; assert.equal(file.suggestedFilename(),name);
    assert.match(await fs.readFile(await file.path(),'utf8'),content);
  }
  assert.deepEqual(calls,['new','new','space']);
});
