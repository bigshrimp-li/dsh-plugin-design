import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDomainService } from '../src/host/domain.js';
import { createGroupService } from '../src/host/group.js';
const user = { trusted: true, userInitiated: true, groupId: 'general', sourceScope: 'group:general' };
async function fixture(t, options = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-group-'));
  let domain = createDomainService({ baseDir });
  let dropGroupCommit = options.dropGroupCommit;
  const groupDomain = { async execute(command, input, binding) {
    if (dropGroupCommit && command === 'group.state.set' && input.value.parts.some(part => part.state === 'accepted')) {
      dropGroupCommit = false;
      return { kind: 'failed', error: { code: 'INTERRUPTED', message: 'synthetic disconnect after Bot acceptance' } };
    }
    return domain.execute(command, input, binding);
  } };
  const calls = { bot: [], generation: [], schemes: [] }, rows = new Map();
  let failSport = options.failSport;
  const bot = { available: true, async execute(command, input, binding) {
    if (command === 'chat.send') {
      calls.bot.push(structuredClone({ input, binding }));
      if (binding.objectiveId === 'O_sport' && failSport) { failSport = false; throw new Error('temporary failure'); }
      if (!rows.has(input.messageId)) {
        const prior = [...rows.values()].find(row => row.answer.answerId === input.replyTo);
        const task = prior?.task || { id: `task:${input.messageId}`, inputRefs: [], phase: 'waiting_user' };
        task.inputRefs.push(`message:${input.messageId}`);
        rows.set(input.messageId, { objectiveId: binding.objectiveId, scope: binding.sourceScope, task,
          answer: { id: `publication:${input.messageId}`, answerId: `answer:${input.messageId}`, taskId: task.id,
            text: `已处理 ${input.text}`, sourceScope: binding.sourceScope, state: 'published' } });
      }
      return { kind: 'accepted', data: { messageId: input.messageId, available: true } };
    }
    const own = [...rows.values()].filter(row => row.objectiveId === binding.objectiveId && row.scope === binding.sourceScope);
    return { kind: 'read', data: { tasks: own.map(row => row.task), answers: own.map(row => row.answer) } };
  } };
  const adapter = { available: true, async generate(request) {
    calls.generation.push(structuredClone(request));
    return { data: options.route ? options.route(request) : { parts: [{ objectiveId: 'O_learn', start: 0, end: request.input.text.length }] } };
  } };
  const schemes = { async execute(command, input, binding) { calls.schemes.push({ command, input, binding }); return { kind: 'saved', data: { draftId: 'draft-only' } }; } };
  for (const [objectiveId, title] of [['O_learn', '学习'], ['O_sport', '运动']]) {
    const result = await domain.execute('space.create', { objectiveId, title, purpose: title, lifecycle: 'formal', types: [] }, { trusted: true, userInitiated: true, objectiveId });
    assert.equal(result.kind, 'saved', JSON.stringify(result));
  }
  let group = createGroupService({ baseDir, domain: groupDomain, bot, adapter, schemes });
  t.after(async () => { await group.close(); await domain.close(); await fs.rm(baseDir, { recursive: true, force: true }); });
  return { baseDir, calls, rows, group, async restart() { await group.close(); await domain.close(); domain = createDomainService({ baseDir }); group = createGroupService({ baseDir, domain: groupDomain, bot, adapter, schemes }); this.group = group; } };
}

test('explicit recipient, source-bound publication and durable deduplication', async t => {
  const f = await fixture(t), input = { requestId: 'one', text: '@学习 收藏这篇文章' };
  const first = await f.group.execute('group.send', input, user);
  assert.equal(first.kind, 'accepted', JSON.stringify(first));
  assert.equal(f.calls.generation.length, 0);
  assert.equal(f.calls.bot[0].binding.objectiveId, 'O_learn');
  assert.equal(f.calls.bot[0].binding.sourceScope, 'group:general');
  assert.equal(first.data.messages.filter(message => message.role === 'member').length, 1);
  assert.ok(f.calls.bot[0].binding.authorizedRefs.every(ref => ref.includes('general')));
  await f.restart();
  assert.equal((await f.group.execute('group.send', input, user)).kind, 'accepted');
  assert.equal(f.calls.bot.length, 1);
  assert.ok((await fs.stat(path.join(f.baseDir, 'groups/general/group.sqlite'))).isFile());
  assert.equal((await f.group.execute('group.send', { ...input, text: 'different' }, user)).error.code, 'IDEMPOTENCY_CONFLICT');
});

test('composite fragments stay separate and only failed member is retried', async t => {
  const text = '收藏文章。记录跑步。';
  const f = await fixture(t, { failSport: true, route: () => ({ parts: [
    { objectiveId: 'O_learn', start: 0, end: 5 }, { objectiveId: 'O_sport', start: 5, end: text.length },
  ] }) });
  const result = await f.group.execute('group.send', { requestId: 'composite', text }, user);
  assert.equal(result.kind, 'accepted', JSON.stringify(result));
  assert.deepEqual(result.data.parts.map(part => part.state), ['published', 'failed']);
  assert.deepEqual(f.calls.bot.map(call => call.input.text), ['收藏文章。', '记录跑步。']);
  assert.ok(f.calls.generation[0].input.members.every(member => Object.keys(member).sort().join(',') === 'objectiveId,purpose,title'));
  const retry = await f.group.execute('group.retry', { messageId: result.data.messageId }, user);
  assert.deepEqual(retry.data.parts.map(part => part.state), ['published', 'published']);
  assert.equal(f.calls.bot.filter(call => call.binding.objectiveId === 'O_learn').length, 1);
  const sport = f.calls.bot.filter(call => call.binding.objectiveId === 'O_sport');
  assert.equal(sport.length, 2);
  assert.equal(new Set(sport.map(call => call.input.messageId)).size, 1);
});

test('reply follows original member answer and task', async t => {
  const f = await fixture(t);
  const first = await f.group.execute('group.send', { requestId: 'running', recipientId: 'O_sport', text: '记录跑步5公里' }, user);
  const answer = first.data.messages.find(message => message.role === 'member');
  const followed = await f.group.execute('group.send', { requestId: 'duration', text: '35分钟', replyTo: answer.id }, user);
  assert.equal(followed.kind, 'accepted', JSON.stringify(followed));
  assert.equal(f.calls.bot.at(-1).binding.objectiveId, 'O_sport');
  assert.equal(f.calls.bot.at(-1).input.replyTo, answer.botAnswerId);
  assert.equal(followed.data.messages.filter(message => message.role === 'member').at(-1).taskId, answer.taskId);
  assert.equal((await f.group.execute('group.send', { requestId: 'wrong', text: '补充', replyTo: answer.id, recipientId: 'O_learn' }, user)).kind, 'failed');
});

test('rejects arbitrary dispatch, duplicated facts, private summaries and attachments', async t => {
  const f = await fixture(t);
  const part = { objectiveId: 'O_learn', start: 0, end: 2 };
  assert.equal((await f.group.execute('group.dispatch', { requestId: 'host', text: '原文', parts: [part] }, user)).error.code, 'FORBIDDEN');
  assert.equal((await f.group.execute('group.dispatch', { requestId: 'free', text: '原文', parts: [{ ...part, text: 'private summary' }] }, { ...user, hostDispatch: true })).kind, 'failed');
  assert.equal((await f.group.execute('group.dispatch', { requestId: 'double', text: '原文', parts: [part, { ...part, objectiveId: 'O_sport' }] }, { ...user, hostDispatch: true })).kind, 'failed');
  assert.equal((await f.group.execute('group.send', { requestId: 'attachment', text: 'text', attachments: [{}] }, user)).kind, 'failed');
  assert.equal(f.calls.bot.length, 0);
});

test('quoted @ is content and generated plans can contain only source ranges', async t => {
  const f = await fixture(t);
  assert.equal((await f.group.execute('group.send', { requestId: 'quote', text: '> @运动\n请收藏这段引文' }, user)).kind, 'accepted');
  assert.equal(f.calls.generation.length, 1);
  assert.equal(f.calls.bot[0].binding.objectiveId, 'O_learn');
  const unsafe = await fixture(t, { route: () => ({ parts: [{ objectiveId: 'O_learn', start: 0, end: 2, text: 'injected' }] }) });
  assert.equal((await unsafe.group.execute('group.send', { requestId: 'inject', text: '原文' }, user)).kind, 'failed');
  assert.equal(unsafe.calls.bot.length, 0);
});

test('cross-space plans return sourced suggestions and inherit read-only bindings on followup', async t => {
  const f = await fixture(t);
  const response = await f.group.execute('group.plan', { requestId: 'plan', objectiveIds: ['O_learn', 'O_sport'], text: '下周每天只有一小时，请各自给建议' }, user);
  assert.equal(response.kind, 'accepted', JSON.stringify(response));
  assert.equal(response.data.summaries.length, 2);
  assert.ok(response.data.summaries.every(summary => summary.sourceRef && summary.taskId));
  assert.ok(f.calls.bot.every(call => call.binding.allowedActions.join(',') === 'read,suggest'));
  const answer = response.data.messages.find(message => message.role === 'member');
  await f.group.execute('group.send', { requestId: 'followup', text: '再缩短到半小时', replyTo: answer.id }, user);
  assert.deepEqual(f.calls.bot.at(-1).binding.allowedActions, ['read', 'suggest']);
  assert.equal(f.calls.schemes.length, 0);
});

test('group scheme operations stop at draft references and require user intent', async t => {
  const f = await fixture(t);
  assert.equal((await f.group.execute('group.scheme', { action: 'create', title: '新方向' }, user)).data.reviewRequired, true);
  assert.equal((await f.group.execute('group.scheme', { action: 'generate', objectiveId: 'O_learn' }, user)).kind, 'saved');
  assert.deepEqual(f.calls.schemes.map(call => call.command), ['scheme.create', 'scheme.generate']);
  assert.equal((await f.group.execute('group.scheme', { action: 'confirm', objectiveId: 'O_learn' }, user)).kind, 'failed');
  assert.equal((await f.group.execute('group.scheme', { action: 'create' }, { trusted: true })).error.code, 'FORBIDDEN');
});

test('interruption after Bot acceptance retries the same delivery without repeating business', async t => {
  const f = await fixture(t, { dropGroupCommit: true });
  const input = { requestId: 'interrupted', recipientId: 'O_learn', text: '收藏原文' };
  assert.equal((await f.group.execute('group.send', input, user)).kind, 'failed');
  assert.equal(f.rows.size, 1);
  await f.restart();
  const retry = await f.group.execute('group.retry', {}, user);
  assert.equal(retry.kind, 'read', JSON.stringify(retry));
  assert.equal(retry.data.parts[0].state, 'published');
  assert.equal(f.rows.size, 1);
  assert.equal(f.calls.bot.length, 2);
  assert.equal(f.calls.bot[0].input.messageId, f.calls.bot[1].input.messageId);
});

test('routing failure is recoverable without losing the authoritative group message', async t => {
  let first = true;
  const f = await fixture(t, { route: request => {
    if (first) { first = false; throw new Error('synthetic model failure'); }
    return { parts: [{ objectiveId: 'O_learn', start: 0, end: request.input.text.length }] };
  } });
  assert.equal((await f.group.execute('group.send', { requestId: 'routing', text: '收藏原文' }, user)).kind, 'failed');
  const retry = await f.group.execute('group.retry', {}, user);
  assert.equal(retry.kind, 'read', JSON.stringify(retry));
  assert.equal(retry.data.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(f.rows.size, 1);
  assert.equal((await f.group.execute('group.state', {}, { ...user, objectiveId: 'O_learn' })).error.code, 'FORBIDDEN');
});
