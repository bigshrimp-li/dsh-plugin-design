import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDomainService } from '../src/host/domain.js';
import { createBotService } from '../src/host/bot.js';
import { createGroupService } from '../src/host/group.js';
import { appendTraceEvent, createTraceService } from '../src/host/trace.js';

const OBJECTIVE = 'O_trace_fixture';
const user = { objectiveId: OBJECTIVE, trusted: true, userInitiated: true, sourceScope: { kind: 'private', id: OBJECTIVE } };
const viewer = { ...user, traceMode: 'private' };
const host = { trusted: true, objectiveId: OBJECTIVE, sourceScope: 'bot' };
const read = result => { assert.equal(result.kind, 'read', JSON.stringify(result)); return result.data; };

/** Explicit synthetic Agent script; no provider or user sessions are accessed. */
function syntheticAdapter(onChild = async () => ({})) {
  const deliveries = [];
  const sessions = [];
  return { available: true, deliveries, sessions, async open(options) {
    sessions.push({ sessionId: options.sessionId, binding: structuredClone(options.binding), resume: options.resume });
    const tools = new Map(options.tools.map(tool => [tool.name, tool]));
    let call = 0;
    const invoke = (name, input) => tools.get(name).execute(input, options.binding, { sessionId: options.sessionId, callId: `${options.sessionId}:call:${++call}` });
    return { sessionId: options.sessionId, async release() {}, async deliver(message) {
      deliveries.push({ sessionId: options.sessionId, ...structuredClone(message) });
      const payload = message.payload;
      if (payload.block_type === 'inbox_event') {
        const created = await invoke('task_create', { requestId: `route:${payload.messageId}`, messageId: payload.messageId, inputRefs: payload.inputRefs, title: '合成资料工作' });
        assert.equal(created.kind, 'accepted', JSON.stringify(created));
      }
      if (payload.block_type === 'task_context') {
        const current = read(await invoke('task_get', { taskId: payload.task.id }));
        const outcome = await onChild({ payload, current, invoke, message, options }) || {};
        const latest = read(await invoke('task_get', { taskId: payload.task.id }));
        const report = await invoke('task_report', { requestId: `report:${message.id}`, taskId: current.id, expectedRevision: latest.revision, runId: latest.runId, phase: outcome.phase || 'delivered', answer: outcome.answer || '合成来源绑定交付', wait: outcome.wait, operationRefs: outcome.operationRefs || [], completion: { delivered: true } });
        assert.equal(report.kind, 'saved', JSON.stringify(report));
      }
      return { accepted: true, settled: true, outcome: 'completed', answers: [], ...(message.recoveryAttempt ? { recoveryId: `${message.id}:recovery:${message.recoveryAttempt}` } : {}) };
    } };
  } };
}

async function fixture(t, { onChild, create = true, adapter = syntheticAdapter(onChild) } = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-trace-'));
  const domain = createDomainService({ baseDir });
  if (create) assert.equal((await domain.execute('space.create', { title: '合成轨迹空间', lifecycle: 'formal', types: [{ id: 'article', version: 1, fields: [{ id: 'content', kind: 'text', required: true }, { id: 'url', kind: 'text', required: true }] }] }, user)).kind, 'saved');
  const bot = createBotService({ baseDir, domain, adapter, toolProvider: () => [{ name: 'space_fixture', description: '合成领域工具', async execute(input, binding) { return domain.execute(input.command, input.input, binding); } }] });
  const trace = createTraceService({ domain, baseDir });
  t.after(async () => { trace.close(); await bot.close(); await domain.close(); await fs.rm(baseDir, { recursive: true, force: true }); });
  return { baseDir, domain, bot, trace, adapter, send: (input, binding = user) => bot.execute('chat.send', input, binding), drain: (binding = user) => bot.execute('runtime.drain', {}, binding), query: (command, input = {}, binding = viewer) => trace.execute(command, input, binding), stored: () => domain.execute('runtime.load', { key: 'bot' }, host) };
}

test('trace reads do not create a Bot, a group database, an Agent or migrate legacy spaces', async t => {
  const f = await fixture(t, { create: false });
  const legacy = path.join(f.baseDir, 'O_legacy'); await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'meta.json'), JSON.stringify({ title: '合成旧空间' }));
  assert.equal(read(await f.query('trace.capabilities')).contract, 'okrTrace/v1');
  const bots = read(await f.query('trace.bots.list', {}, { trusted: true, userInitiated: true, traceMode: 'private' })).bots;
  assert.equal(bots.length, 1); assert.equal(bots[0].migrated, false);
  const old = read(await f.query('trace.task.get', {}, { ...viewer, objectiveId: 'O_legacy', sourceScope: { kind: 'private', id: 'O_legacy' } }));
  assert.equal(old.main.streamRef, null); assert.equal(old.coverage.hostEvents, 'historical_unrecorded');
  const group = read(await f.query('trace.task.get', { botId: 'group:general' }, { trusted: true, userInitiated: true, traceMode: 'group', sourceScope: 'group:general' }));
  assert.equal(group.main, null); assert.equal(group.segments.length, 0);
  assert.deepEqual(await fs.readdir(f.baseDir), ['O_legacy']);
  assert.deepEqual(await fs.readdir(legacy), ['meta.json']);
  assert.equal(f.adapter.sessions.length, 0);
});

test('source-bound streams exclude the mixed main body and reauthorize every reference', async t => {
  const f = await fixture(t);
  await f.send({ messageId: 'private-original', text: 'PRIVATE_SYNTHETIC_ONLY' }); await f.drain();
  const privateTask = read(await f.query('trace.tasks.list')).tasks[0];
  const groupUser = { ...user, sourceScope: 'group:general' };
  await f.send({ messageId: 'group-original', text: 'GROUP_SYNTHETIC_ONLY' }, groupUser); await f.drain(groupUser);
  const groupViewer = { ...groupUser, traceMode: 'group' };
  const groupTask = read(await f.query('trace.tasks.list', {}, groupViewer)).tasks[0];
  assert.notEqual(groupTask.id, privateTask.id);
  const privateTrace = read(await f.query('trace.task.get', { taskId: privateTask.id }));
  assert.equal(JSON.stringify(privateTrace).includes('GROUP_SYNTHETIC_ONLY'), false);
  assert.equal(privateTrace.main.allowNative, false);
  assert.ok(privateTrace.main.segments.every(stream => !stream.allowNative));
  assert.ok(privateTrace.segments.some(stream => stream.role === 'child' && stream.allowNative));
  const childStream = privateTrace.segments.find(stream => stream.role === 'child');
  assert.equal(read(await f.query('trace.stream.authorize', { streamRef: childStream.streamRef })).stream.allowNative, true);
  assert.equal((await f.query('trace.stream.authorize', { streamRef: childStream.streamRef }, groupViewer)).kind, 'rejected');
  assert.equal((await f.query('trace.stream.authorize', { sessionId: childStream.sessionId })).kind, 'rejected');
  assert.equal((await f.query('trace.stream.authorize', { streamRef: `${childStream.streamRef}x` })).kind, 'rejected');
  assert.equal((await f.query('trace.task.get', { taskId: privateTask.id }, groupViewer)).kind, 'rejected');
  assert.equal(read(await f.query('trace.session.resolve', { sessionId: childStream.sessionId }, groupViewer)).registered, false);
  const groupChild = read(await f.query('trace.task.get', { taskId: groupTask.id }, groupViewer)).segments.find(stream => stream.role === 'child');
  const lookup = read(await f.query('trace.session.resolve', { sessionId: groupChild.sessionId }, { trusted: true, userInitiated: true, traceMode: 'private' }));
  assert.equal(lookup.registered, true); assert.equal(lookup.task.sourceScope, 'group:general'); assert.equal(lookup.stream.allowNative, false); assert.equal(lookup.stream.streamRef, null);
  const diagnostic = read(await f.query('trace.task.get', {}, { ...viewer, traceMode: 'diagnostic' }));
  assert.equal(diagnostic.main.allowNative, true);
  assert.equal(diagnostic.segments.filter(stream => stream.role === 'child').length, 2);
  assert.equal((await f.query('trace.task.get', { objectiveId: OBJECTIVE }, { trusted: true, userInitiated: true, traceMode: 'diagnostic' })).error.code, 'SCOPE_REQUIRED');
  for (const binding of [{ ...viewer, trusted: false }, { ...viewer, role: 'main' }, { ...viewer, userInitiated: false }, { ...viewer, role: 'child' }]) assert.equal((await f.query('trace.capabilities', {}, binding)).error.code, 'FORBIDDEN');
  assert.equal((await f.query('trace.event.get', { path: '/tmp/not-a-session' })).error.code, 'FORBIDDEN');
  const before = await f.stored(); const calls = f.adapter.deliveries.length;
  await f.query('trace.task.get', { taskId: privateTask.id }); await f.query('trace.events.list', { taskId: privateTask.id });
  const after = await f.stored(); assert.deepEqual(after.data, before.data); assert.equal(f.adapter.deliveries.length, calls);
});

test('pending material supplementation retains task, material and child session while each publication links only its own receipts', async t => {
  let count = 0; let materialId;
  const f = await fixture(t, { onChild: async ({ invoke }) => {
    const result = await invoke('space_fixture', count++ === 0 ? { command: 'item.save', input: { typeId: 'article', title: '合成缺项资料', fields: { content: '合成正文' } } } : { command: 'material.complete', input: { materialId, fields: { url: 'https://example.invalid/synthetic' } } });
    if (result.kind === 'pending') { materialId = result.data.materialId; return { phase: 'waiting_user', wait: { question: '请补充链接。' }, answer: '请补充链接。', operationRefs: [result.operationId] }; }
    assert.equal(result.kind, 'saved', JSON.stringify(result)); return { phase: 'closed', operationRefs: [result.operationId], answer: '合成资料已保存。' };
  } });
  await f.send({ messageId: 'collect', text: '收藏合成资料，暂缺链接' }); const first = read(await f.drain());
  const taskId = first.tasks[0].id;
  const pending = read(await f.query('trace.task.get', { taskId }));
  await f.send({ messageId: 'supplement', text: '补充合成链接', replyTo: first.answers[0].answerId }); await f.drain();
  const saved = read(await f.query('trace.task.get', { taskId }));
  assert.equal(saved.task.id, pending.task.id); assert.equal(saved.task.phase, 'closed');
  assert.equal(saved.segments.find(stream => stream.role === 'child').sessionId, pending.segments.find(stream => stream.role === 'child').sessionId);
  const attempts = saved.attempts.filter(attempt => attempt.target === 'child');
  assert.equal(attempts.length, 2); assert.notEqual(attempts[0].deliveryId, attempts[1].deliveryId); assert.ok(attempts.every(attempt => attempt.number === 1));
  assert.deepEqual(saved.publications.map(item => item.sourceMessageId), ['collect', 'supplement']);
  assert.ok(saved.publications.every(item => item.operationRefs.length === 1));
  assert.notEqual(saved.publications[0].operationRefs[0], saved.publications[1].operationRefs[0]);
  assert.equal(saved.operations.find(item => item.operationId === saved.publications[0].operationRefs[0]).kind, 'pending');
  const operationEvent = saved.events.find(event => event.type === 'operation.receipt' && event.operationId === saved.publications[1].operationRefs[0]);
  const detail = read(await f.query('trace.event.get', { taskId, eventId: operationEvent.id }));
  const pendingEvent = saved.events.find(event => event.type === 'operation.receipt' && event.operationId === saved.publications[0].operationRefs[0]);
  assert.equal(read(await f.query('trace.event.get', { taskId, eventId: pendingEvent.id })).operation.data.materialId, materialId);
  assert.ok(detail.operation.data.itemId);
  assert.equal(detail.operation.kind, 'saved');
  const state = read(await f.domain.execute('space.read', {}, user)); assert.equal(state.items.length, 1); assert.equal(state.pending_materials.length, 0);
  assert.ok(saved.events.some(event => event.type === 'parent.notification.completed'));
  const publicationEvent = saved.events.find(event => event.type === 'answer.published' && event.messageId === 'supplement');
  assert.equal(publicationEvent.answerId, saved.publications[1].answerId);
  assert.equal(read(await f.query('trace.event.get', { taskId, eventId: publicationEvent.id })).event.output.text, '合成资料已保存。');
  assert.equal(saved.coverage.usage, 'unknown');
  const visible = read(await f.bot.execute('chat.history', {}, user));
  assert.ok(visible.tasks[0].operationLinks.some(link => link.materialId === materialId));
  assert.ok(visible.tasks[0].operationLinks.some(link => link.itemId === state.items[0].id));
  assert.ok(visible.tasks[0].operationLinks.every(link => !Object.hasOwn(link, 'body')));
});

test('timeout and recovery retain one delivery/run/session and record distinct attempts plus the physical recovery message', async t => {
  let failOnce = true;
  const f = await fixture(t, { onChild: async () => { if (failOnce) { failOnce = false; throw Object.assign(new Error('合成模型超时'), { code: 'BOT_TIMEOUT' }); } return {}; } });
  await f.send({ messageId: 'recover-original', text: '原合成工作' }); const failed = read(await f.drain());
  const taskId = failed.tasks[0].id; const deliveryId = failed.errors[0].deliveryId;
  const before = read(await f.query('trace.task.get', { taskId }));
  assert.equal(before.attempts.find(attempt => attempt.target === 'child').status, 'failed');
  await f.bot.execute('runtime.recover', { deliveryId }, user); await f.drain();
  const after = read(await f.query('trace.task.get', { taskId }));
  const attempts = after.attempts.filter(attempt => attempt.target === 'child');
  assert.equal(attempts.length, 2); assert.notEqual(attempts[0].id, attempts[1].id);
  assert.equal(attempts[0].deliveryId, attempts[1].deliveryId); assert.equal(attempts[0].runId, attempts[1].runId); assert.equal(attempts[0].sessionId, attempts[1].sessionId);
  assert.equal(attempts[1].previousAttemptId, attempts[0].id); assert.equal(attempts[1].recoveryId, `${deliveryId}:recovery:2`);
  assert.equal(after.task.inputs.length, 1); assert.equal(after.publications.length, 1);
  assert.equal(after.events.filter(event => event.type === 'delivery.recovery.requested' && event.deliveryId === deliveryId).length, 1);
});

test('legacy indexes retain unknown attempt history and unrecorded publication links without a read-time migration', async t => {
  const f = await fixture(t);
  await f.send({ messageId: 'legacy-original', text: '合成旧记录' }); const original = read(await f.drain());
  const stored = await f.stored(); const value = stored.data.value; delete value.traceLedger;
  const task = value.tasks[original.tasks[0].id];
  task.segments = [{ sessionId: 'synthetic-old-segment', reason: 'budget', at: '2026-10-01T00:00:00.000Z' }];
  for (const publication of value.publications) delete publication.operationRefs;
  for (const delivery of value.outbox) { delete delivery.attemptId; delete delivery.previousAttemptId; }
  assert.equal((await f.domain.execute('runtime.store', { key: 'bot', expectedRevision: stored.data.revision, value }, host)).kind, 'saved');
  const before = await f.stored(); const detail = read(await f.query('trace.task.get', { taskId: task.id }));
  assert.equal(detail.coverage.hostEvents, 'historical_unrecorded'); assert.deepEqual(detail.events, []); assert.deepEqual(detail.attempts, []);
  assert.equal(detail.segments.find(stream => stream.sessionId === 'synthetic-old-segment').generation, null);
  assert.equal(detail.publications[0].operationRefs, null); assert.equal(detail.publications[0].operationCoverage, 'historical_unrecorded');
  assert.deepEqual((await f.stored()).data, before.data);
});

test('bounded Host ledger exposes sequence gaps and binds incremental cursors to source/task', async t => {
  const f = await fixture(t); await f.send({ messageId: 'bounded-original', text: '合成有界轨迹' }); const status = read(await f.drain()); const taskId = status.tasks[0].id;
  const first = read(await f.query('trace.events.list', { taskId, limit: 1 }));
  const stored = await f.stored(); const value = stored.data.value;
  for (let index = 0; index < 400; index++) appendTraceEvent(value, { type: 'test.reference', title: '合成引用事件', taskId, sourceScope: JSON.stringify({ id: OBJECTIVE, kind: 'private' }), operationId: null }, { key: `bounded:${index}` });
  assert.equal(value.traceLedger.events.length, 256); assert.ok(value.traceLedger.droppedEvents > 0);
  assert.equal((await f.domain.execute('runtime.store', { key: 'bot', expectedRevision: stored.data.revision, value }, host)).kind, 'saved');
  const next = read(await f.query('trace.events.list', { taskId, cursor: first.cursor, limit: 5 }));
  assert.equal(next.events.length, 5); assert.equal(next.coverage.cursorGap, true);
  assert.ok(next.events.every((event, index) => !index || event.seq > next.events[index - 1].seq));
  assert.equal((await f.query('trace.events.list', { taskId, cursor: first.cursor }, { ...viewer, traceMode: 'group', sourceScope: 'group:general' })).kind, 'rejected');
  assert.equal((await f.query('trace.events.list', { taskId, cursor: `${first.cursor}x` })).kind, 'rejected');
});

test('group trace follows authorized fragments to member tasks and original-group publication, with no invented coordinator Agent', async t => {
  const f = await fixture(t);
  await f.send({ messageId: 'private-before-group', text: 'PRIVATE_GROUP_BOUNDARY_SENTINEL' }); await f.drain();
  const group = createGroupService({ baseDir: f.baseDir, domain: f.domain, bot: f.bot, adapter: { available: true, async generate(request) { return { data: { parts: [{ objectiveId: OBJECTIVE, start: 0, end: request.input.text.length }] }, trace: { sessionId: 'synthetic-existing-routing-session', purpose: 'group-routing', startedAt: '2026-10-27T00:00:00.000Z' } }; } } });
  t.after(() => group.close());
  const groupUser = { trusted: true, userInitiated: true, sourceScope: 'group:general', groupId: 'general' };
  const sent = await group.execute('group.send', { requestId: 'group-routing', text: '请分配这段合成原文。' }, groupUser);
  assert.equal(sent.kind, 'accepted', JSON.stringify(sent));
  await f.drain({ ...user, sourceScope: 'group:general' }); await group.execute('group.history', {}, groupUser);
  const binding = { ...groupUser, traceMode: 'group' };
  const workflow = read(await f.query('trace.task.get', { botId: 'group:general', groupMessageId: sent.data.messageId }, binding));
  assert.equal(workflow.main, null); assert.equal(workflow.bot.agent, false); assert.equal(workflow.segments.length, 1); assert.equal(workflow.segments[0].role, 'workflow');
  assert.equal(read(await f.query('trace.stream.authorize', { streamRef: workflow.segments[0].streamRef }, binding)).stream.allowNative, true);
  assert.equal(JSON.stringify(workflow).includes('PRIVATE_GROUP_BOUNDARY_SENTINEL'), false);
  assert.ok(workflow.events.some(event => event.type === 'group.part.accepted'));
  assert.ok(workflow.events.some(event => event.type === 'group.task.linked'));
  assert.ok(workflow.events.some(event => event.type === 'group.answer.published'));
  assert.equal(workflow.group.publications.length, 1);
  const tasks = read(await f.query('trace.tasks.list', { objectiveId: OBJECTIVE, groupMessageId: sent.data.messageId }, binding)).tasks;
  assert.equal(tasks.length, 1);
  assert.equal((await f.query('trace.stream.authorize', { streamRef: workflow.segments[0].streamRef }, viewer)).kind, 'rejected');
  const none = read(await f.query('trace.task.get', { botId: 'group:general', groupMessageId: 'not-a-group-message' }, binding));
  assert.deepEqual(none.events, []); assert.deepEqual(none.segments, []);
  assert.equal((await f.query('trace.task.get', { botId: 'group:general' }, { ...binding, objectiveId: OBJECTIVE })).kind, 'rejected');
});

test('internal workflow registration is bounded, idempotent and source-bound without manufacturing a Bot', async t => {
  const f = await fixture(t);
  const ref = { sessionId: 'synthetic-generation-session', purpose: 'scheme-generation', startedAt: '2026-10-27T00:00:00.000Z', status: 'running' };
  assert.equal((await f.trace.registerWorkflow(ref, user)).kind, 'saved');
  const first = await f.trace.registerWorkflow(ref, user); assert.equal(first.kind, 'read'); assert.equal(first.data.duplicate, true);
  assert.equal((await f.trace.registerWorkflow({ ...ref, status: 'completed' }, user)).kind, 'saved');
  assert.equal((await f.trace.registerWorkflow(ref, { ...user, sourceScope: 'group:general' })).kind, 'rejected');
  assert.equal(read(await f.stored()).value, null);
  const detail = read(await f.query('trace.task.get'));
  assert.equal(detail.main.streamRef, null); assert.equal(detail.segments.length, 1); assert.equal(detail.segments[0].role, 'workflow'); assert.equal(detail.segments[0].status, 'completed');
  assert.equal(read(await f.query('trace.stream.authorize', { streamRef: detail.segments[0].streamRef })).stream.sessionId, ref.sessionId);
  const groupView = read(await f.query('trace.task.get', {}, { ...viewer, traceMode: 'group', sourceScope: 'group:general' })); assert.equal(groupView.segments.length, 0);
  for (let index = 0; index < 66; index++) assert.equal((await f.trace.registerWorkflow({ sessionId: `synthetic-generation-${index}`, purpose: 'plan', status: 'completed' }, user)).kind, 'saved');
  assert.equal(read(await f.query('trace.task.get')).segments.length, 64);
  assert.equal((await f.query('trace.stream.authorize', { streamRef: detail.segments[0].streamRef })).kind, 'rejected');
  assert.equal((await f.query('trace.task.get', {}, { ...viewer, sourceScope: { kind: 'private', id: 'O_other' } })).error.code, 'FORBIDDEN');
});

test('an operation from a different task in the same space cannot be expanded through another task', async t => {
  const f = await fixture(t, { onChild: async ({ invoke }) => { const result = await invoke('space_fixture', { command: 'item.save', input: { typeId: 'article', title: '合成记录', fields: { content: '合成正文', url: 'https://example.invalid/' } } }); return { operationRefs: [result.operationId] }; } });
  await f.send({ messageId: 'first-independent', text: '第一个合成目标' }); await f.drain();
  await f.send({ messageId: 'second-independent', text: '第二个合成目标' }); await f.drain();
  const tasks = read(await f.query('trace.tasks.list')).tasks;
  const first = read(await f.query('trace.task.get', { taskId: tasks[0].id }));
  const operationEvent = first.events.find(event => event.type === 'operation.receipt');
  assert.ok(operationEvent.operationId);
  assert.equal((await f.query('trace.event.get', { taskId: tasks[1].id, eventId: operationEvent.id, operationId: operationEvent.operationId })).kind, 'rejected');
});
