// Explicit live-provider probe. Only synthetic records and questions leave the isolated profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
const electron =
  process.env.DSH_ELECTRON || '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const runtime =
  process.env.DSH_INSTALL_ROOT || path.resolve(path.dirname(electron), '../Resources/app.asar/dsh');
if (!process.argv.includes('--inside')) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-calendar-live-'));
  try {
    const env = {
      ...process.env,
      HOME: dir,
      DSH_HOME: path.join(dir, 'dsh'),
      ELECTRON_RUN_AS_NODE: '1',
      OKR_TEST_ROOT: dir,
      OKR_MODEL_PROFILE: process.env.OKR_MODEL_PROFILE || path.join(os.homedir(), '.dsh/profiles/desktop'),
      DSH_INSTALL_ROOT: runtime,
    };
    const profile = spawnSync(
      'dsh',
      ['--profile', 'calendar-live', '--from-default-profile', 'headless', '--dump-config'],
      { env, timeout: 30000, stdio: 'ignore' },
    );
    assert.equal(profile.status, 0, '需要已安装的 DSH');
    const child = spawnSync(electron, ['--expose-internals', self, '--inside'], {
      env,
      stdio: 'inherit',
      timeout: 600000,
    });
    if (child.error) throw child.error;
    process.exitCode = child.status || (child.signal ? 1 : 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
} else {
  const resolve = createRequire(path.join(runtime, 'package.json'));
  const load = (n) => import(pathToFileURL(resolve.resolve('@deepseek-ai/' + n)).href);
  const [
    { Context },
    { default: SessionStore },
    { default: AgentRegistry },
    { default: SystemPrompt },
    { default: ToolRuntime },
    { default: ProjectionRegistry },
    { LlmRuntime },
    { default: AgentLoop },
    persistence,
    provider,
    { createLaunchEnvironmentSnapshot },
  ] = await Promise.all(
    [
      'cordis',
      'dsh-session',
      'dsh-agent',
      'dsh-system-prompt',
      'dsh-tools',
      'dsh-session-projection',
      'dsh-llm',
      'dsh-agent-loop',
      'dsh-session-persistence-jsonl',
      'dsh-llm-pi-ai',
      'dsh-launch-environment',
    ].map(load),
  );
  const { createDshAdapter } = await import('../src/host/dsh-adapter.js');
  const { createPluginService } = await import('../src/host/service.js');
  const { createCalendarAssistant } = await import('../src/host/calendar-assistant.js');
  const dir = process.env.OKR_TEST_ROOT,
    profile = process.env.OKR_MODEL_PROFILE;
  const yaml = resolve('yaml'),
    patches = yaml.parse(await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'));
  const route = patches.findLast((p) => p.id === 'agent-default-model')?.config;
  const settings = patches.findLast((p) => p.id === 'llm-pi-ai')?.config?.providers?.[route?.provider];
  assert.ok(settings && route?.model, '未找到可用的 DSH pi-ai 模型路由');
  // Supply the selected route's existing launch credential in memory only.
  const credential = settings.apiKeyEnv;
  const env = await fs.readFile(path.resolve(profile, '../../.env'), 'utf8').catch(() => '');
  const values = credential
    ? { [credential]: process.env[credential] || parseEnv(env)[credential] || '' }
    : {};
  const root = new Context();
  let host;
  const lifecycle = root.plugin({
    name: 'isolated-calendar-provider',
    apply(ctx) {
      host = ctx;
      new SessionStore(ctx);
      new AgentRegistry(ctx);
      new SystemPrompt(ctx, {});
      new ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 1 });
      new ProjectionRegistry(ctx);
      new LlmRuntime(ctx);
      new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } });
      ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'user-env', values }]));
      provider.apply(ctx, { providers: { get: () => ({ [route.provider]: settings }) } });
    },
  });
  await lifecycle;
  const logs = host.plugin(persistence, { root: path.join(dir, 'sessions'), compression: 'none' });
  await logs;
  const adapter = createDshAdapter({
    ctx: host,
    agentOptions: { provider: route.provider, model: route.model },
    timeoutMs: 120000,
  });
  const service = createPluginService({ baseDir: path.join(dir, 'business'), adapter });
  const bot = createCalendarAssistant({
    domain: service.domain,
    calendar: service.execute,
    adapter,
    now: () => new Date('2026-11-05T03:00:00Z'),
  });
  const global = { trusted: true, userInitiated: true, global: true };
  async function call(cmd, args, b = global) {
    const r = await service.execute(cmd, args, b);
    assert.ok(!r.error, JSON.stringify(r.error));
    return r.data;
  }
  async function send(text, extra = {}, oid = null) {
    const result = await bot.execute(
      'assistant.send',
      {
        sessionId: 'initial',
        messageId: crypto.randomUUID(),
        timeZone: 'Asia/Shanghai',
        selectedDate: '2026-11-05',
        text,
        ...extra,
      },
      oid ? { trusted: true, userInitiated: true, objectiveId: oid } : global,
    );
    if (result.error || result.data?.message?.error)
      throw new Error(result.error?.message || result.data.message.text);
    return result.data;
  }
  try {
    const make = async (name, title, time) => {
      const id = crypto.randomUUID();
      const goal = {
        id,
        name,
        about: '合成验收',
        bookkeeping: false,
        assistantRule: '只引用本空间已记录的执行结果。',
        ks: [
          {
            id: 'k1',
            name: '词汇',
            standard: '复测掌握 120 词',
            from: '2026-11-01',
            to: '2026-11-30',
            kind: '词汇',
          },
        ],
      };
      return (
        await call('calendar.confirm', {
          confirm: true,
          draft: {
            id,
            goal,
            events: [{ id: 'e1', title, kind: '词汇', date: '2026-11-05', time, duration: 20 }],
          },
        })
      ).objectiveId;
    };
    const english = await make('学习英语', '词汇复测', '19:30');
    await make('阅读', '阅读与摘记', '20:30');
    const state = await call('calendar.space', {}, { ...global, objectiveId: english, global: false });
    async function seedScenario(name, kind, events, bookkeeping = false) {
      const id = crypto.randomUUID();
      const goal = {
        id,
        name,
        about: '合成验收',
        bookkeeping,
        assistantRule: '复盘时从本空间执行记录查实测值，计划与实际分开。',
        ks: [
          {
            id: 'K_case',
            name: kind + '进展',
            standard: kind === '词汇' ? '累计掌握 120 个新词' : '依据实际记录核对',
            from: '2026-11-01',
            to: '2026-11-30',
            kind,
          },
        ],
      };
      return (await call('calendar.confirm', { confirm: true, draft: { id, goal, events } })).objectiveId;
    }
    const event = (id, title, kind, date, duration) => ({ id, title, kind, date, time: '07:00', duration });
    const runner = await seedScenario('跑步训练', '跑步', [
      event('run3', '河畔轻松跑', '跑步', '2026-11-03', 24),
      event('run7', '晨跑', '跑步', '2026-11-07', 32),
    ]);
    const rbind = (id) => ({ ...global, global: false, objectiveId: id });
    const running = await call('calendar.space', {}, rbind(runner));
    await call(
      'calendar.execution.save',
      { event: { ...running.events[0], note: '跑完', measure: '实测 4 公里，28 分钟' } },
      rbind(runner),
    );
    const ledger = await seedScenario(
      '日常账本',
      '财务核对',
      [event('check', '核对账本', '核账', '2026-11-08', 12)],
      true,
    );
    for (const [title, kind, cents] of [
      ['买菜', '餐饮', 12000],
      ['交通费', '交通', 3000],
    ])
      await call(
        'calendar.ledger.save',
        {
          event: {
            title,
            kind,
            date: '2026-11-03',
            time: '12:00',
            posting: { flow: 'expense', cents, currency: 'CNY' },
          },
        },
        rbind(ledger),
      );
    const practice = await seedScenario('词汇学习', '词汇', [
      event('v1', '词卡', '词汇', '2026-11-02', 15),
      event('v2', '词汇复测', '词汇', '2026-11-04', 20),
      event('v3', '单词练习', '词汇', '2026-11-08', 20),
    ]);
    const words = await call('calendar.space', {}, rbind(practice));
    for (const e of words.events.slice(0, 2))
      await call(
        'calendar.execution.save',
        {
          event: {
            ...e,
            note: '练习完成',
            measure: e.id === 'v2' ? '复测 20 词，其中 16 词达标。' : '复习词卡。',
          },
        },
        rbind(practice),
      );
    async function check(label, fn) {
      if (process.env.OKR_MODEL_CASE && !new RegExp(process.env.OKR_MODEL_CASE).test(label)) return;
      try {
        await fn();
        console.log('PASS live DSH ' + label);
      } catch (e) {
        process.exitCode = 1;
        console.error(
          'FAIL live DSH ' +
            label +
            ': ' +
            String(e.message)
              .replace(/https?:\/\/\S+/g, '[provider]')
              .slice(0, 350),
        );
      }
    }
    await Promise.all([
      check('global range and checked-only follow-up', async () => {
        const a = await send('今天做什么', { checked: [english] });
        assert.equal(a.message.refs.length, 2, a.message.text);
        const b = await send('只看勾选的', { checked: [english] });
        assert.deepEqual(
          b.message.refs.map((r) => r.oid),
          [english],
          b.message.text,
        );
      }),
      check('new draft, targeted revision and confirmation boundary', async () => {
        const d = { id: 'draft-new', mode: 'new', revision: 0, goal: null, events: [], messages: [] };
        const a = await send(
          '创建英语自学空间，四周掌握 120 个新词，八周听懂日常对话。周六 19:30 学词，周日练听力。给我可编辑的首版方案。',
          { draft: d },
        );
        assert.equal(a.proposal?.goal.ks.length, 2, a.message.text);
        assert.ok(a.proposal.events.some((e) => e.date === '2026-11-07' && e.time === '19:30'));
        assert.ok(a.proposal.events.some((e) => e.date === '2026-11-08'));
        Object.assign(d, a.proposal, { revision: 1 });
        d.messages = [a.message];
        d.goal.about = '保留表单修改';
        const b = await send('首项改到周六 10:00，按周汇总计划时长。只改这两部分。', { draft: d });
        assert.equal(b.proposal?.events[0].time, '10:00', b.message.text);
        assert.equal(b.proposal.goal.about, '保留表单修改');
        assert.equal(b.proposal.goal.layout.group, 'week');
        assert.equal(b.proposal.goal.layout.metric, 'minutes');
        Object.assign(d, b.proposal, { revision: 2 });
        const c = await send('确认创建', { draft: d });
        assert.equal(c.proposal, null);
      }),
      check('edit only the bound O rules', async () => {
        const draft = {
          id: 'draft-edit',
          revision: 0,
          goal: state.goal,
          events: state.events,
          messages: [],
          mode: 'edit',
        };
        const b = await send(
          '只调整空间助手以后复盘的规则，每次先列复测结果，再问下一步；排期不变。',
          { draft },
          english,
        );
        assert.ok(b.proposal?.goal.assistantRule.includes('复测'), b.message.text);
        assert.deepEqual(b.proposal.events, state.events);
      }),
      check('English planned versus measured progress, local feedback evidence', async () => {
        const a = await send(
          '这周三件词汇事项的计划时长、已完成事项的计划时长、实际用时和复测通过率分别是多少？',
          {},
          practice,
        );
        assert.match(a.message.text, /55/);
        assert.match(a.message.text, /35/);
        assert.match(a.message.text, /80\s*[%％]/);
        const b = await send(
          '请为词汇 K 起草一份可编辑阶段反馈，指出这次复测能说明什么。不要把它标为累计掌握。',
          { kId: 'K_case' },
          practice,
        );
        assert.equal(b.message.action?.kind, 'feedback', b.message.text);
        assert.equal(b.message.action.kId, 'K_case');
        assert.ok(b.message.refs.some((r) => r.id === 'v2'));
        assert.equal((await call('calendar.space', {}, rbind(practice))).goal.ks[0].r, '');
      }),
      check('running separates actual from plan', async () => {
        const a = await send(
          '本周最近一次跑了多少公里、实际多少分钟？本周下一次预计几分钟？分别给依据。',
          {},
          runner,
        );
        assert.match(a.message.text, /4\s*(公里|千米|km)/i);
        assert.match(a.message.text, /28/);
        assert.match(a.message.text, /32/);
        assert.ok(new Set(a.message.refs.map((r) => r.id)).size >= 2);
      }),
      check('ledger current preview 120 versus all 150, with independent sources', async () => {
        const filters = { kind: '餐饮', status: 'all', flow: 'all', range: 'all' };
        const a = await send('当前视图全部支出是多少？', { filters }, ledger);
        assert.match(a.message.text, /120/);
        assert.deepEqual(
          a.message.refs.map((r) => r.title),
          ['买菜'],
        );
        const b = await send(
          '保持当前筛选不变，请重新查 2026 年 11 月全部支出，不限类别，附上明细引用。',
          { filters },
          ledger,
        );
        assert.match(b.message.text, /150/);
        assert.deepEqual(new Set(b.message.refs.map((r) => r.title)), new Set(['买菜', '交通费']));
      }),
      check('ledger draft distinguishes display, standing rules and one-time preference', async () => {
        const draft = { id: 'bookkeeping-draft', revision: 0, goal: null, events: [], messages: [] };
        const first = await send(
          '新建记账空间，只计实际已入账的收支，页面按发生月用卡片分别展示消费和收入。每周六晚 7 点核账。',
          { draft },
        );
        assert.equal(first.proposal?.goal.bookkeeping, true, first.message.text);
        assert.equal(first.proposal.goal.layout.group, 'month');
        assert.equal(first.proposal.goal.layout.metric, 'cash');
        Object.assign(draft, first.proposal, { revision: 1, messages: [first.message] });
        const second = await send('长期规则改为以后问收支先列收入，再列支出；事项区展示不变。', { draft });
        assert.match(second.proposal?.goal.assistantRule || '', /收入/);
        assert.deepEqual(second.proposal.goal.layout, draft.goal.layout);
        Object.assign(draft, second.proposal, { revision: 2, messages: [first.message, second.message] });
        const third = await send('这一次先看支出，之后仍按照原来的长期规则。', { draft });
        assert.equal(
          third.proposal?.goal.assistantRule || draft.goal.assistantRule,
          draft.goal.assistantRule,
        );
      }),
      check('ambiguous listening move only asks for clarification', async () => {
        const draft = {
          id: 'draft-ambiguity',
          revision: 5,
          goal: state.goal,
          mode: 'edit',
          events: [
            event('listen1', '新闻精听', '听力', '2026-11-06', 30),
            event('listen2', '对话复听', '听力', '2026-11-08', 20),
          ],
          messages: [],
        };
        const a = await send('把听力挪到周六 10:00。', { draft }, english);
        assert.equal(a.proposal, null, a.message.text);
        assert.match(a.message.text, /哪|选择|确认|明确/);
        assert.match(a.message.text, /新闻精听/);
        assert.match(a.message.text, /对话复听/);
      }),
      check('cross-space inquiry stays scoped', async () => {
        const sessionId = (await bot.execute('assistant.new', {}, rbind(english))).data.active;
        const a = await send('我在英语空间，帮我查另一个日常账本空间的支出金额。', { sessionId }, english);
        assert.match(a.message.text, /切换|进入|打开|无法|不能|仅能|只.*空间/);
        assert.doesNotMatch(a.message.text, /150|120 元/);
        assert.equal(a.message.refs.length, 0);
      }),
      check('space K evidence and missing actuals', async () => {
        const a = await send(
          '词汇 K 已经达标了吗？请核对标准、现有执行证据和还缺什么。',
          { sessionId: (await bot.execute('assistant.new', {}, rbind(english))).data.active },
          english,
        );
        assert.ok(
          a.message.refs.some((r) => r.oid === english && r.kind === 'k'),
          a.message.text,
        );
        assert.match(a.message.text, /120/);
        assert.match(a.message.text, /缺|尚|未|不足|没有/);
      }),
    ]);
  } finally {
    await service.close();
    await adapter.close();
    await logs.dispose();
    await lifecycle.dispose();
  }
}
