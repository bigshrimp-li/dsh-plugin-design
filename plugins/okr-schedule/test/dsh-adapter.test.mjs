import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshAdapter } from '../src/host/dsh-adapter.js';

function harness() {
  const records = new Map();
  const live = new Map();
  const setups = [];
  const optionsSeen = [];
  const defaults = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'low' };
  const control = { hangNext: false, emitTool: false };
  async function construct(options, resumed) {
    optionsSeen.push({ resumed, agentOptions: structuredClone(options.agentOptions) });
    const id = options.sessionId || options.resumeSessionId;
    const record = records.get(id) || { messages: [], events: [], turn: 0 };
    if (resumed && !records.has(id)) throw new Error('session missing');
    records.set(id, record);
    const listeners = new Map();
    const config = { tools: new Map(), guards: [], restrictions: [], prompts: [], mode: null };
    setups.push(config);
    const scope = {
      tools: { restrict(value) { config.restrictions.push(value); }, presentAs(value) { config.mode = value; }, guard(fn) { config.guards.push(fn); }, register(tool) { config.tools.set(tool.name, tool); } },
      systemPrompt: { section(value) { config.prompts.push(value); } },
      on(name, listener) { listeners.set(name, listener); },
    };
    let work = Promise.resolve();
    let cancelled = false;
    let wakeHung;
    const emit = (type, data) => { const event = { seq: record.events.length, type, data, time: Date.now() }; record.events.push(event); listeners.get('session/event')?.(agent.session, event); };
    const agent = {
      id, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { deriveMessages() { return record.messages; } },
      followup(message) {
        cancelled = false;
        agent.status = 'running';
        agent.inbox.nextTurn.push(message);
        work = Promise.resolve().then(async () => {
          const turn = ++record.turn;
          emit('turn/start', { turn });
          emit('user/message', message);
          record.messages.push(message);
          agent.inbox.nextTurn = [];
          if (control.hangNext) {
            control.hangNext = false;
            await new Promise(resolve => { const timer = setTimeout(resolve, 100); wakeHung = () => { clearTimeout(timer); resolve(); }; });
          }
          if (cancelled) { emit('turn/end', { turn, reason: { kind: 'aborted' } }); agent.status = 'idle'; return; }
          const decision = await listeners.get('agent/pre-step')?.({ agent }, async () => ({ kind: 'enter', messages: [message] }));
          if (decision?.kind === 'reject') return;
          if (control.emitTool) {
            emit('request/header', { turn, headers: { authorization: 'SYNTHETIC_SECRET_HEADER' } });
            emit('tool/call', { callId: 'native-call-fixture', name: 'fixture_tool', arguments: { text: 'SYNTHETIC_TOOL_BODY' } });
            emit('tool/result', { callId: 'native-call-fixture', message: { source: { callId: 'native-call-fixture' }, content: [{ type: 'text', text: 'SYNTHETIC_RESULT_BODY' }] } });
          }
          const answer = { id: `answer-${record.messages.length}`, role: 'assistant', content: [{ type: 'text', text: '真实模型答案' }], source: { kind: 'model' } };
          record.messages.push(answer);
          emit('assistant/message', { message: answer, usage: { inputTokens: 12, cacheReadTokens: 7 } });
          emit('turn/end', { turn, reason: { kind: 'completed' } });
          agent.status = 'idle';
        });
      },
      whenIdle() { return work; }, cancel() { cancelled = true; wakeHung?.(); agent.status = 'idle'; },
    };
    agent.session.id = id;
    const commit = await options.setup(scope, agent); commit?.commit();
    live.set(id, agent);
    return { agent, async dispose() { live.delete(id); } };
  }
  return { records, live, setups, optionsSeen, defaults, control, ctx: { get: key => key === 'agentDefaultModel' ? { currentSelection: () => structuredClone(defaults) } : key === 'sessionQuery' ? { async observeSession(id) { return { events: records.get(id).events, [Symbol.dispose]() {} }; } } : undefined, agents: { create: options => construct(options, false), resume: options => construct(options, true), get: id => live.get(id) } } };
}

test('create and resume reinstall a complete prompt, native scoped tools and execution guards', async () => {
  const host = harness();
  const adapter = createDshAdapter({ ctx: host.ctx });
  const options = { sessionId: 'fixture-session', binding: { objectiveId: 'O_fixture', trusted: true }, system: '固定规则', tools: [{ name: 'fixture_tool', description: '合成工具', execute: async () => ({ kind: 'read' }) }] };
  const first = await adapter.open(options);
  const result = await first.deliver({ id: 'message-1', payload: { text: '测试' } });
  assert.equal(result.accepted, true);
  assert.equal(result.answers[0].text, '真实模型答案');
  await first.release();
  const resumed = await adapter.open({ ...options, resume: true });
  assert.equal(host.setups.length, 2);
  for (const setup of host.setups) {
    assert.deepEqual(setup.restrictions, [{ allow: [] }]);
    assert.equal(setup.mode, 'native');
    assert.equal(setup.prompts[0].complete, true);
    assert.deepEqual([...setup.tools.keys()], ['fixture_tool']);
    assert.match(setup.guards[0]({ name: 'shell', agent: host.live.get('fixture-session') }), /无权|失效/);
  }
  assert.equal(resumed.inspectMessage('message-1').state, 'accepted');
  const duplicate = await resumed.deliver({ id: 'message-1', payload: { text: '不重放' } });
  assert.equal(duplicate.duplicate, true);
  assert.equal(host.records.get('fixture-session').messages.filter(message => message.role === 'user').length, 1);
  await adapter.close();
});

test('answers and usage come from committed assistant messages, not transient stream frames', async () => {
  const host = harness();
  const events = [];
  const adapter = createDshAdapter({ ctx: host.ctx });
  const session = await adapter.open({ sessionId: 'answer-session', binding: {}, system: '规则', onEvent: event => events.push(event) });
  await session.deliver({ id: 'input', payload: { text: '测试' } });
  const answers = events.filter(event => event.type === 'answer');
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].usage, { inputTokens: 12, cacheReadTokens: 7 });
  assert.deepEqual(events.map(event => event.type), ['turn/start', 'input.accepted', 'answer', 'turn/end']);
  await adapter.close();
});

test('unsafe or unavailable hosts remain disabled rather than inheriting global tools', async () => {
  const absent = createDshAdapter();
  assert.equal(absent.available, false);
  await assert.rejects(absent.generate({ binding: {}, system: '规则', input: '测试' }), /未提供/);
  const unsafe = createDshAdapter({ agentOptions: { provider: 'fixture', model: 'fixture' }, ctx: { agents: { async create(options) { await options.setup({ tools: { register() {} } }, {}); }, async resume() {} } } });
  await assert.rejects(unsafe.open({ sessionId: 'unsafe', binding: {}, system: '规则' }), /缺少 scoped tools/);
});

test('child ownership requires an existing parent without seeding parent history', async () => {
  const host = harness();
  const adapter = createDshAdapter({ ctx: host.ctx });
  await assert.rejects(adapter.open({ sessionId: 'child', parentSessionId: 'missing', binding: {}, system: '规则' }), /主 Agent 尚未恢复/);
  const parent = await adapter.open({ sessionId: 'parent', binding: {}, system: '规则' });
  await parent.deliver({ id: 'private-input', payload: { private: '合成私聊' } });
  const child = await adapter.open({ sessionId: 'child', parentSessionId: 'parent', binding: {}, system: '规则' });
  assert.deepEqual(child.readAnswers(), []);
  assert.equal(host.records.get('child').messages.length, 0);
  await adapter.close();
});

test('concurrent opens of one intent share one scoped Agent creation', async () => {
  const host = harness(); const adapter = createDshAdapter({ ctx: host.ctx });
  const options = { sessionId: 'one-intent', binding: {}, system: '固定规则' };
  const [first, second] = await Promise.all([adapter.open(options), adapter.open(options)]);
  assert.equal(first, second); assert.equal(host.setups.length, 1);
  await Promise.all([first.release(), second.release()]);
  assert.equal(host.live.size, 0);
  await adapter.close();
});

test('create, resume and one-shot generation read the current Host default selection', async () => {
  const host = harness(); const adapter = createDshAdapter({ ctx: host.ctx });
  const options = { sessionId: 'default-route', binding: {}, system: '固定规则' };
  const first = await adapter.open(options);
  assert.deepEqual(host.optionsSeen[0].agentOptions, { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'low' });
  await first.release();
  host.defaults.model = 'fixture-next-model'; host.defaults.reasoningEffort = 'medium';
  const resumed = await adapter.open({ ...options, resume: true });
  assert.equal(host.optionsSeen[1].resumed, true);
  assert.deepEqual(host.optionsSeen[1].agentOptions, { provider: 'fixture-provider', model: 'fixture-next-model', reasoningEffort: 'medium' });
  await resumed.release();
  host.defaults.model = 'fixture-generation-model';
  await adapter.generate({ binding: {}, system: '合成生成规则', input: '合成输入' });
  assert.equal(host.optionsSeen[2].agentOptions.model, 'fixture-generation-model');
  await adapter.close();
});

test('explicit Agent options override defaults without copying unrelated Host fields', async () => {
  const host = harness(); host.defaults.unrelated = 'synthetic-unrelated-value';
  const adapter = createDshAdapter({ ctx: host.ctx, agentOptions: { provider: 'explicit-fixture', model: 'explicit-model', maxTokens: 128, reasoningEffort: undefined, unrelated: 'must-not-copy' } });
  const session = await adapter.open({ sessionId: 'explicit-route', binding: {}, system: '规则' });
  assert.deepEqual(host.optionsSeen[0].agentOptions, { provider: 'explicit-fixture', model: 'explicit-model', reasoningEffort: 'low', maxTokens: 128 });
  await session.release(); await adapter.close();
});

test('a late default-model service enables the adapter and a missing route fails closed', async () => {
  const host = harness(); let service;
  host.ctx.get = () => service;
  const adapter = createDshAdapter({ ctx: host.ctx });
  assert.equal(adapter.available, false);
  await assert.rejects(adapter.open({ sessionId: 'unconfigured', binding: {}, system: '规则' }), /默认模型/);
  assert.equal(host.optionsSeen.length, 0);
  service = { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) };
  assert.equal(adapter.available, true);
  const session = await adapter.open({ sessionId: 'configured-later', binding: {}, system: '规则' });
  assert.equal(host.optionsSeen.length, 1);
  await session.release(); await adapter.close();
});

test('accepted input that times out is resumed in its original session instead of being swallowed as a duplicate', async () => {
  const host = harness(); host.control.hangNext = true;
  let adapter = createDshAdapter({ ctx: host.ctx, timeoutMs: 5 });
  const options = { sessionId: 'timeout-original-session', binding: {}, system: '固定规则' };
  let session = await adapter.open(options);
  await assert.rejects(session.deliver({ id: 'original-delivery', payload: { block_type: 'inbox_event', messageId: 'user-original', inputRefs: ['message:user-original'] } }), error => error.code === 'BOT_TIMEOUT');
  await host.live.get(options.sessionId).whenIdle();
  await session.release(); await adapter.close();
  adapter = createDshAdapter({ ctx: host.ctx }); session = await adapter.open({ ...options, resume: true });
  await assert.rejects(session.deliver({ id: 'original-delivery', payload: {} }), error => error.code === 'DELIVERY_NOT_SETTLED');
  const recovered = await session.deliver({ id: 'original-delivery', payload: { block_type: 'inbox_event', messageId: 'user-original', inputRefs: ['message:user-original'] }, recoveryAttempt: 2, forceContinue: true });
  assert.equal(recovered.settled, true); assert.equal(recovered.recoveryId, 'original-delivery:recovery:2');
  const messages = host.records.get(options.sessionId).messages.filter(message => message.role === 'user');
  assert.deepEqual(messages.map(message => message.id), ['original-delivery', 'original-delivery:recovery:2']);
  const tail = JSON.parse(messages[1].content[0].text); assert.equal(tail.block_type, 'delivery_recovery'); assert.equal(tail.deliveryRecovery.previousOutcome, 'aborted');
  assert.equal(host.records.size, 1);
  await adapter.close();
});

test('missing settlement evidence refuses recovery without creating another input or session', async () => {
  const host = harness();
  let adapter = createDshAdapter({ ctx: host.ctx });
  const options = { sessionId: 'settlement-evidence', binding: {}, system: '固定规则' };
  const first = await adapter.open(options); await first.deliver({ id: 'evidence-input', payload: {} }); await first.release(); await adapter.close();
  const get = host.ctx.get; host.ctx.get = key => key === 'sessionQuery' ? undefined : get(key);
  adapter = createDshAdapter({ ctx: host.ctx });
  const resumed = await adapter.open({ ...options, resume: true });
  await assert.rejects(resumed.deliver({ id: 'evidence-input', payload: {}, recoveryAttempt: 2, forceContinue: true }), error => error.code === 'DELIVERY_STATE_UNKNOWN');
  assert.equal(host.records.get(options.sessionId).messages.filter(message => message.role === 'user').length, 1);
  assert.equal(host.records.size, 1);
  await adapter.close();
});

test('committed native tool/call identities and recovery attempts are forwarded without mirroring headers or tool bodies', async () => {
  const host = harness(); host.control.emitTool = true;
  const events = [];
  const adapter = createDshAdapter({ ctx: host.ctx });
  const session = await adapter.open({ sessionId: 'native-metadata-session', binding: {}, system: '规则', onEvent: event => events.push(event) });
  await session.deliver({ id: 'original-native-delivery', attemptId: 'attempt:original:1', payload: { text: '合成输入' } });
  const call = events.find(event => event.type === 'tool/call');
  assert.equal(call.sessionId, session.sessionId); assert.equal(call.data.callId, 'native-call-fixture'); assert.equal(call.data.name, 'fixture_tool');
  assert.equal(call.deliveryId, 'original-native-delivery'); assert.equal(call.attemptId, 'attempt:original:1'); assert.ok(Number.isSafeInteger(call.seq));
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_SECRET_HEADER'), false);
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_TOOL_BODY'), false); assert.equal(JSON.stringify(events).includes('SYNTHETIC_RESULT_BODY'), false);
  await session.deliver({ id: 'original-native-delivery', attemptId: 'attempt:original:2', payload: {}, recoveryAttempt: 2, forceContinue: true });
  const recovered = events.find(event => event.type === 'delivery.recovery.prepared');
  assert.equal(recovered.deliveryId, 'original-native-delivery'); assert.equal(recovered.recoveryId, 'original-native-delivery:recovery:2'); assert.equal(recovered.attemptId, 'attempt:original:2');
  await adapter.close();
});

test('one-shot generation registers its existing physical session before delivery and returns the same safe reference', async () => {
  const host = harness(); const adapter = createDshAdapter({ ctx: host.ctx });
  let registered;
  const result = await adapter.generate({ binding: { purpose: 'synthetic-scheme' }, system: '合成规则', input: '合成输入', async onSession(ref) { registered = ref; assert.ok(host.records.has(ref.sessionId)); assert.equal(host.records.get(ref.sessionId).messages.length, 0); } });
  assert.equal(result.trace.sessionId, registered.sessionId); assert.equal(result.trace.purpose, 'synthetic-scheme'); assert.equal(result.trace.role, 'workflow');
  assert.equal(host.live.size, 0); assert.ok(result.text);
  await adapter.close();
});
