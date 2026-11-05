import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createPluginService } from '../src/host/service.js';
import { createCalendarAssistant } from '../src/host/calendar-assistant.js';
import { period, makeEvidence } from '../src/host/assistant-evidence.js';
import { dataOf } from '../src/host/protocol.js';

const date = '2026-11-05',
  clock = () => new Date(date + 'T02:00:00Z');
const globalScope = { trusted: true, userInitiated: true, global: true };
const bound = (id) => ({ trusted: true, userInitiated: true, objectiveId: id });
async function setup(t) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-assistant-test-'));
  const queue = [],
    calls = [];
  const adapter = {
    available: true,
    async generate(r) {
      calls.push(r);
      return { data: await queue.shift()(r) };
    },
  };
  const service = createPluginService({ baseDir, adapter });
  const bot = createCalendarAssistant({
    domain: service.domain,
    calendar: service.execute,
    adapter,
    now: clock,
  });
  t.after(async () => {
    await service.close();
    await fs.rm(baseDir, { recursive: true, force: true });
  });
  const run = async (command, input = {}, b = globalScope) =>
    dataOf(await service.execute(command, input, b));
  const api = async (command, input = {}, b = globalScope) =>
    dataOf(await bot.execute('assistant.' + command, input, b));
  const send = (text, b = globalScope, extra = {}) =>
    api(
      'send',
      { sessionId: 'initial', text, messageId: crypto.randomUUID(), timeZone: 'Asia/Shanghai', ...extra },
      b,
    );
  async function create(name, rule, n = 1, bookkeeping = false) {
    const draft = {
      id: crypto.randomUUID(),
      goal: {
        name,
        about: '验收',
        bookkeeping,
        assistantRule: rule,
        ks: [
          {
            id: 'shared-k',
            name: '复测',
            from: '2026-11-01',
            to: '2026-11-30',
            kind: '复测',
            standard: '词汇复测 120 词',
          },
        ],
      },
      events: Array.from({ length: n }, (_, i) => ({
        id: 'shared-' + i,
        title: name + '事项' + i,
        date,
        time: '19:30',
        duration: 20,
        kind: '复测',
      })),
    };
    return (await run('calendar.confirm', { confirm: true, draft })).objectiveId;
  }
  return { queue, calls, adapter, api, run, send, create };
}
test('自然日/周/月、选中月份、跨年与时段继承', () => {
  assert.deepEqual(period('本周', date, '2027-01-02'), { from: '2026-11-02', to: '2026-11-08' });
  assert.deepEqual(period('选中周', date, '2027-01-02'), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(period('选中月', date, '2027-01-02'), { from: '2027-01-01', to: '2027-01-31' });
  assert.deepEqual(period('上个月全部', '2027-01-02', date), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(period('2028年2月全部', date, date), { from: '2028-02-01', to: '2028-02-29' });
});
test('仅发送时装配真实作用域；勾选与同名解析；删除后历史只保留有效的引用', async (t) => {
  const { create, send, queue, calls, api, run } = await setup(t);
  const ids = [await create('同名', '机密甲'), await create('同名', '机密乙')];
  assert.deepEqual((await api('list')).sessions, []);
  assert.equal(calls.length, 0);
  queue.push(async (r) => {
    assert.equal(r.binding.scene, 'calendar');
    assert.equal(r.binding.today, date);
    assert.deepEqual(
      r.tools.map((t) => t.name),
      ['read_evidence'],
    );
    assert.doesNotMatch(r.system, /机密/);
    assert.equal((await r.tools[0].execute({ kind: 'ledger' })).error, 'FORBIDDEN');
    const e = await r.tools[0].execute({ kind: 'schedule' });
    assert.equal(e.total, 2);
    assert.ok(e.complete);
    assert.equal(e.rows[0].note, undefined);
    return { text: '两项安排', refs: [e.rows[0].ref, e.rows[1].ref, e.rows[0].ref, '伪造'] };
  });
  const { message } = await send('今天做什么', globalScope, { checked: [ids[0]] });
  assert.deepEqual(new Set(message.refs.map((r) => r.oid)), new Set(ids));
  assert.equal(message.refs.length, 2);
  queue.push(async (r) => {
    const e = await r.tools[0].execute({ kind: 'schedule' });
    assert.equal(e.total, 1);
    return { text: '一项', refs: [e.rows[0].ref] };
  });
  assert.deepEqual(
    (await send('只看勾选的', globalScope, { checked: [ids[0]] })).message.refs.map((r) => r.oid),
    [ids[0]],
  );
  queue.push(async (r) => {
    const e = await r.tools[0].execute({ kind: 'schedule' });
    assert.ok(e.choose);
    assert.equal(e.rows, undefined);
    return { text: '请选择标识' };
  });
  await send('同名空间今天做什么');
  await run('calendar.delete', { confirm: true }, bound(ids[0]));
  const trimmed = (await api('list')).sessions[0].messages.find((m) => m.id === message.id);
  assert.match(trimmed.text, /来源已失效/);
  assert.deepEqual(
    trimmed.refs.map((r) => r.oid),
    [ids[1]],
  );
  const remain = await api('reference', {
    sessionId: 'initial',
    messageId: message.id,
    ref: trimmed.refs[0],
  });
  assert.equal(remain.record.oid, ids[1]);
  assert.equal(calls.length, 3);
});
test('按当前视图、全月与币种取得完整数值；未入账排期和预览均不写账', async (t) => {
  const { create, queue, send, run } = await setup(t);
  const oid = await create('账本', '按币种分别列出', 1, true),
    b = bound(oid);
  for (const [title, kind, cents, currency] of [
    ['买菜', '餐饮', 12000, 'CNY'],
    ['交通', '交通', 3000, 'CNY'],
    ['车票', '交通', 500, 'USD'],
  ]) {
    await run(
      'calendar.ledger.save',
      {
        event: {
          title,
          kind,
          date,
          time: '08:00',
          duration: 1,
          status: 'done',
          note: kind === '餐饮' ? 'Receipt A' : title,
          posting: { flow: 'expense', cents, currency },
        },
      },
      b,
    );
  }
  const before = await run('calendar.space', {}, b);
  for (const [text, expected, count, hintedCategory] of [
    ['当前视图花了多少', 12000, 1],
    ['11 月全部支出', 15000, 3, '餐饮'],
    ['保持当前筛选不变，请重新查 2026 年 11 月全部支出，不限类别，附上明细引用。', 15000, 3, '餐饮'],
    ['保持当前筛选不变，请重新查 2026 年 11 月全部支出，附上明细引用。', 15000, 3, '餐饮'],
    ['忽略当前筛选，查看 11 月的支出。', 15000, 3, '餐饮'],
    ['当前视图全部支出是多少？', 12000, 1, '交通'],
  ]) {
    queue.push(async (r) => {
      assert.match(r.system, /按币种分别列出/);
      const e = await r.tools[0].execute({
        kind: 'ledger',
        flow: 'expense',
        ...(hintedCategory ? { category: hintedCategory } : {}),
      });
      assert.equal(r.input.currentEvidence[0].amounts.CNY.expense, expected);
      assert.equal(e.amounts.CNY.expense, expected);
      assert.equal(e.total, count);
      if (count === 3) assert.equal(e.amounts.USD.expense, 500);
      return { text: '合计' + expected, refs: e.rows.map((x) => x.ref) };
    });
    const { message } = await send(text, b, { filters: { kind: '餐饮', query: 'reCEiPt' } });
    assert.equal(message.refs.length, count, message.text);
  }
  for (const unsupported of ['已统一折算成人民币 155 元。', '总计支出 155 元。']) {
    queue.push(async (r) => {
      const ledger = r.input.currentEvidence[0];
      assert.match(ledger.currencyBasis, /原币种.*没有汇率/);
      return { text: unsupported, refs: [] };
    });
    const { message } = await send('11 月全部支出是多少？', b);
    assert.match(message.text, /CNY 支出 150\.00/);
    assert.match(message.text, /USD 支出 5\.00/);
    assert.doesNotMatch(message.text, /155|折算成人民币/);
    assert.deepEqual(new Set(message.refs.map((ref) => ref.title)), new Set(['买菜', '交通', '车票']));
  }
  queue.push(async () => ({ text: '当前视图金额统一折算成人民币，共 120 元。' }));
  const filtered = await send('当前视图全部支出是多少？', b, { filters: { kind: '餐饮' } });
  assert.match(filtered.message.text, /CNY 支出 120\.00/);
  assert.doesNotMatch(filtered.message.text, /USD|折算成人民币/);
  assert.deepEqual(
    filtered.message.refs.map((ref) => ref.title),
    ['买菜'],
  );
  queue.push(async () => ({ text: '合计 155 元。' }));
  const both = await send('11 月全部收入和支出是多少？', b);
  assert.match(both.message.text, /CNY 收入 0\.00，支出 150\.00/);
  queue.push(async () => ({
    text: '请在创造模式核对汇率相关规则。',
    action: { kind: 'policy', text: '以后先报收入，再报支出；列明原币种，不推算汇率。' },
  }));
  const policy = await send('以后复盘先报收入，不推算汇率。', b);
  assert.equal(policy.message.action.kind, 'policy');
  assert.match(policy.message.action.text, /先报收入/);
  assert.deepEqual(policy.message.refs, []);
  assert.deepEqual((await run('calendar.space', {}, b)).events, before.events);
});
test('完整聚合独立于明细分页；缺金额、未知空间、超范围或非允许参数分别报告', async () => {
  const goal = { id: 'O1', name: '账本' },
    rows = Array.from({ length: 93 }, (_, i) => ({
      id: String(i),
      oid: 'O1',
      date,
      title: '菜',
      kind: '餐饮',
      status: 'done',
      posting: { cents: 100, flow: 'expense', currency: 'CNY' },
    }));
  rows.push({ ...rows[0], id: 'missing', posting: { currency: 'CNY', flow: 'expense' } });
  const evidence = makeEvidence({
    binding: bound('O1'),
    today: date,
    selected: date,
    question: '本月全部支出',
    scene: 'space',
    snapshot: { goal, events: rows, warnings: [] },
  });
  const r = await evidence.query({ kind: 'ledger' });
  assert.equal(r.rows.length, 80);
  assert.equal(r.total, 93);
  assert.equal(r.amounts.CNY.expense, 9300);
  assert.ok(r.hasMore);
  assert.equal(r.missingAmounts, 1);
  assert.equal(r.complete, false);
  assert.equal((await evidence.query({ kind: 'ledger', objectiveId: 'O2' })).error, 'FORBIDDEN');
  assert.equal((await evidence.query({ kind: 'ledger', sql: 'read sqlite' })).error, 'FORBIDDEN');
  assert.equal(
    (await evidence.query({ kind: 'ledger', from: '2026-01-01', to: '2027-01-20' })).error,
    'INVALID_DATE_RANGE',
  );
  const global = makeEvidence({
    read: async () => ({ events: [], errors: [{ objectiveId: 'x' }] }),
    scene: 'calendar',
    binding: globalScope,
    today: date,
    selected: date,
    question: '今天做什么',
    catalog: { spaces: [goal], errors: [] },
    checked: [],
  });
  assert.equal((await global.query({ kind: 'schedule' })).complete, false);
});
test('全新/调整草稿每轮重新绑定且仅局部合并；撤回、迟到规则、模型不可用', async (t) => {
  const { create, send, queue, run, adapter } = await setup(t);
  const oid = await create('英语', '旧版英语规则'),
    b = bound(oid);
  const state = await run('calendar.space', {}, b);
  const d = { id: 'D-new', goal: null, revision: 0, events: [], messages: [] };
  queue.push(async (r) => {
    assert.equal(r.binding.scene, 'new');
    assert.equal(r.input.currentDraft.confirmed, undefined);
    const e = await r.tools[0].execute({ kind: 'overlap', from: date, time: '19:30', duration: 20 });
    assert.equal(e.overlaps.length, 1);
    assert.deepEqual(Object.keys(e.overlaps[0]), ['date', 'time', 'duration']);
    assert.equal((await r.tools[0].execute({ kind: 'goals' })).error, 'FORBIDDEN');
    return {
      text: '草稿就绪',
      changes: {
        goal: { name: '跑步', about: '练习', assistantRule: '按执行记录答问' },
        keypoints: [{ name: '里程', standard: '4 公里', from: date, to: '2026-12-01' }],
        events: [{ title: '晨跑', date, time: '06:30', kind: '跑步' }],
      },
    };
  });
  const first = await send('创建跑步空间', globalScope, { draft: d });
  assert.equal(first.proposal.goal.name, '跑步');
  assert.equal(first.proposal.goal.ks[0].r, '');
  assert.equal((await run('calendar.catalog')).spaces.length, 1);
  const edit = {
    id: 'D-edit',
    goal: structuredClone(state.goal),
    events: state.events,
    messages: [],
    revision: 2,
  };
  edit.goal.about = '表单输入';
  queue.push(async (r) => {
    assert.equal(r.binding.scene, 'edit');
    assert.equal(r.input.currentDraft.confirmed.assistantRule, '旧版英语规则');
    assert.equal(r.input.currentDraft.goal.about, '表单输入');
    return { text: '待核对规则', changes: { goal: { assistantRule: '新口径' } } };
  });
  const revised = await send('以后先报成绩', b, { draft: edit });
  assert.deepEqual(revised.proposal.events, state.events);
  assert.equal(revised.proposal.goal.about, '表单输入');
  assert.equal(revised.proposal.goal.assistantRule, '新口径');
  assert.equal((await run('calendar.space', {}, b)).goal.assistantRule, '旧版英语规则');
  queue.push(async () => ({ text: '点击确定创建', changes: { goal: { assistantRule: '直接应用' } } }));
  assert.equal((await send('确认创建', globalScope, { draft: { ...d, ...first.proposal } })).proposal, null);
  queue.push(async () => {
    await run(
      'calendar.confirm',
      {
        confirm: true,
        draft: {
          id: 'changed',
          baseGoal: state.goal,
          goal: { ...state.goal, assistantRule: '新版本' },
          events: state.events,
          baseEvents: state.events,
        },
      },
      b,
    );
    return { text: '基于旧版的答复' };
  });
  assert.match((await send('旧版本提问', b)).message.text, /版本已变/);
  adapter.available = false;
  assert.equal((await send('继续', b)).message.error, true);
});

test('首次直接新建保留空会话 1；重复投递只发布一轮，删除的单空间不能读历史', async (t) => {
  const { api, send, create, run, queue, calls } = await setup(t);
  const oid = await create('空会话', '本 O'),
    b = bound(oid);
  const first = await api('new', {}, b);
  assert.deepEqual(
    first.sessions.map((s) => s.name),
    ['会话 1', '会话 2'],
  );
  await api('select', { sessionId: 'initial' }, b);
  queue.push(async () => ({ text: '请在空间页打开相应编辑入口。' }));
  const messageId = crypto.randomUUID();
  await send('怎样编辑', b, { messageId });
  await send('怎样编辑', b, { messageId });
  const group = await api('list', {}, b);
  assert.equal(group.sessions[0].messages.length, 2);
  assert.equal(calls.length, 1);
  await run('calendar.delete', { confirm: true }, b);
  await assert.rejects(() => api('list', {}, b));
});
