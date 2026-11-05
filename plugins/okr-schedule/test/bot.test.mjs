import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createBotService } from '../src/host/bot.js';
import { createDomainService } from '../src/host/domain.js';

const clone = value => structuredClone(value);
const privateBinding = { objectiveId: 'O_fixture', sourceScope: 'private:fixture', trusted: true };

function domainFixture() {
  const states = new Map();
  const snapshot = { space: { activeBundleId: 'fixture-bundle', purpose: '合成空间用途' }, types: [], items: [] };
  return {
    states, snapshot,
    async execute(command, input, binding) {
      assert.equal(binding.trusted, true);
      if (command === 'space.read') return { kind: 'read', data: clone(snapshot) };
      assert.equal(binding.sourceScope, 'bot');
      const key = `${binding.objectiveId}:${input.key}`;
      const current = states.get(key) || { value: null, revision: 0 };
      if (command === 'runtime.load') return { kind: 'read', data: clone(current) };
      assert.equal(command, 'runtime.store');
      if (input.expectedRevision !== current.revision) return { kind: 'conflict', error: { message: '版本冲突' } };
      states.set(key, { value: clone(input.value), revision: current.revision + 1 });
      return { kind: 'saved', data: clone(states.get(key)) };
    },
  };
}

/** Explicit model script. Production has no string/keyword-based AI fallback. */
function modelFixture({ reportPhase = 'delivered', onChild, onMain, mainCount = 1 } = {}) {
  const calls = [];
  const saved = new Map();
  const active = new Map();
  const adapter = {
    available: true,
    async open(options) {
      calls.push({ type: 'open', sessionId: options.sessionId, resume: options.resume, parentSessionId: options.parentSessionId, binding: clone(options.binding), system: options.system, toolNames: options.tools.map(tool => tool.name) });
      const known = saved.get(options.sessionId) || new Map();
      saved.set(options.sessionId, known);
      const tools = new Map(options.tools.map(tool => [tool.name, tool]));
      const invoke = (name, args) => tools.get(name).execute(args, options.binding, { callId: 'fixture-call', signal: new AbortController().signal });
      const session = {
        sessionId: options.sessionId,
        async deliver(message) {
          calls.push({ type: 'deliver', sessionId: options.sessionId, payload: clone(message.payload) });
          if (known.has(message.id)) return { accepted: true, duplicate: true, answers: [] };
          known.set(message.id, true);
          const payload = message.payload;
          if (payload.block_type === 'inbox_event') {
            for (let n = 0; n < mainCount; n++) {
              const created = await invoke('task_create', { messageId: payload.messageId, inputRefs: payload.inputRefs, title: `合成解释任务${n}`, requestId: `create:${payload.messageId}:${n}` });
              assert.equal(created.kind, 'accepted');
            }
            await onMain?.({ payload, invoke });
          } else if (payload.block_type === 'task_context') {
            const current = await invoke('task_get', { taskId: payload.task.id });
            if (onChild) await onChild({ options, payload, invoke, current: current.data });
            const latest = (await invoke('task_get', { taskId: payload.task.id })).data;
            const result = await invoke('task_report', { taskId: payload.task.id, expectedRevision: latest.revision, runId: latest.runId, phase: reportPhase, answer: `已交付:${payload.task.id}`, requestId: `report:${message.id}`, handoff: { summary: '合成解释完成', ordinalMap: { '2': '第二种方法' } }, completion: { delivered: true } });
            assert.equal(result.kind, 'saved', JSON.stringify(result));
          }
          return { accepted: true, answers: [] };
        },
        inspectMessage(id) { return { state: known.has(id) ? 'accepted' : 'not_found' }; },
        readAnswers() { return []; }, cancel() {}, async release() { active.delete(options.sessionId); calls.push({ type: 'release', sessionId: options.sessionId }); },
      };
      active.set(options.sessionId, session);
      return session;
    },
  };
  return { adapter, calls, saved, active };
}

async function drain(service, binding = privateBinding) {
  const result = await service.execute('runtime.drain', {}, binding);
  assert.equal(result.kind, 'read', JSON.stringify(result));
  return result.data;
}

test('one main session routes independent children and explicit replies resume the original child', async t => {
  const domain = domainFixture(); const model = modelFixture();
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'm1', text: '请讲解合成文章' }, privateBinding);
  const first = await drain(service);
  assert.equal(first.tasks.length, 1); assert.equal(first.answers.length, 1); assert.equal(first.pending, 0);
  const taskId = first.tasks[0].id;
  const originalChild = model.calls.find(call => call.type === 'open' && call.binding.role === 'child').sessionId;
  const reply = await service.execute('chat.send', { messageId: 'm2', text: '第二种有什么缺点？', replyTo: first.answers[0].answerId }, privateBinding);
  assert.equal(reply.data.taskId, taskId);
  const second = await drain(service);
  assert.equal(second.tasks.length, 1); assert.equal(second.answers.length, 2);
  assert.ok(model.calls.some(call => call.type === 'open' && call.sessionId === originalChild && call.resume));
  assert.equal(model.calls.filter(call => call.type === 'open' && call.binding.role === 'main').length, 1);
  assert.ok(model.calls.filter(call => call.type === 'open' && call.binding.role === 'child').every(call => call.parentSessionId));
  const childPayloads = model.calls.filter(call => call.type === 'deliver' && call.payload.block_type === 'task_context').map(call => call.payload);
  assert.deepEqual(childPayloads[0].input.map(item => item.ref), ['message:m1']);
  assert.deepEqual(childPayloads[1].input.map(item => item.ref), ['message:m2']);
  assert.equal(childPayloads[1].initialInSegment, false);
});

test('duplicate messages cannot create another task and changed payloads conflict', async t => {
  const domain = domainFixture(); const model = modelFixture();
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  const input = { messageId: 'same-id', text: '合成问题' };
  await service.execute('chat.send', input, privateBinding); await drain(service);
  assert.equal((await service.execute('chat.send', input, privateBinding)).kind, 'accepted');
  assert.equal((await service.execute('chat.send', { ...input, text: '不同正文' }, privateBinding)).kind, 'conflict');
  const status = await drain(service); assert.equal(status.tasks.length, 1); assert.equal(status.answers.length, 1);
});

test('one Bot main can handle private and group inputs without crossing source scopes or grants', async t => {
  const domain = domainFixture(); const model = modelFixture();
  const bindings = [];
  const service = createBotService({ domain, adapter: model.adapter, toolProvider: binding => { bindings.push(clone(binding)); return []; } }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'private-message', text: '私聊合成内容' }, privateBinding); await drain(service);
  const groupBinding = { ...privateBinding, sourceScope: 'group:general', allowedActions: ['read', 'suggest'] };
  await service.execute('chat.send', { messageId: 'group-message', text: '群查询合成内容' }, groupBinding);
  const group = await drain(service, groupBinding);
  const personal = (await service.execute('chat.history', {}, privateBinding)).data;
  assert.equal(group.messages.length, 1); assert.equal(group.tasks.length, 1); assert.equal(group.answers.length, 1);
  assert.equal(personal.messages.length, 1); assert.equal(personal.answers.length, 1);
  assert.notEqual(group.tasks[0].id, personal.tasks[0].id);
  const groupChild = bindings.find(binding => binding.sourceScope === 'group:general');
  assert.deepEqual(groupChild.allowedActions, ['read', 'suggest']);
  assert.ok(groupChild.contextFence.runId); assert.equal(groupChild.contextFence.taskId, group.tasks[0].id);
  const childInputs = model.calls.filter(call => call.type === 'deliver' && call.payload.block_type === 'task_context');
  assert.equal(childInputs.at(-1).payload.input.some(item => item.text === '私聊合成内容'), false);
  const rejected = await service.execute('task.get', { taskId: personal.tasks[0].id }, groupBinding);
  assert.equal(rejected.kind, 'rejected');
});

test('closed tasks are immutable and late runs or wrong revisions cannot overwrite a delivery', async t => {
  const domain = domainFixture(); const model = modelFixture({ reportPhase: 'closed' });
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'close-message', text: '结束一次合成问答' }, privateBinding);
  const status = await drain(service); const task = status.tasks[0];
  const sent = await service.execute('task.send', { taskId: task.id, inputRefs: ['message:close-message'], expectedRevision: task.revision, requestId: 'bad-resend' }, privateBinding);
  assert.equal(sent.kind, 'error');
  const stale = await service.execute('task.report', { taskId: task.id, runId: 'wrong-run', expectedRevision: task.revision, requestId: 'late-report', phase: 'delivered', answer: '不应覆盖' }, { ...privateBinding, role: 'child', taskId: task.id, runId: 'wrong-run', contextGeneration: 1 });
  assert.equal(stale.kind, 'rejected');
  assert.equal((await service.execute('chat.history', {}, privateBinding)).data.answers.length, 1);
});

test('memory evidence is scoped and deletion invalidates sessions without resurrecting old evidence', async t => {
  const domain = domainFixture(); const model = modelFixture();
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'preference', text: '以后讲解都先举例。' }, privateBinding); await drain(service);
  const proposed = await service.execute('memory.propose', { text: '先举例', dimension: 'explanation', evidenceType: 'explicit_user_preference', sourceRefs: ['message:preference'], quote: '以后讲解都先举例' }, privateBinding);
  assert.equal(proposed.kind, 'saved');
  assert.equal((await service.execute('memory.recall', {}, { ...privateBinding, sourceScope: 'group:general' })).data.items.length, 0);
  const before = domain.states.get('O_fixture:bot').value;
  const deleted = await service.execute('memory.delete', { id: proposed.data.id, expectedRevision: 1 }, privateBinding);
  assert.equal(deleted.kind, 'saved');
  const after = domain.states.get('O_fixture:bot').value;
  assert.notEqual(before.main.sessionId, after.main.sessionId);
  assert.ok(after.deletedEvidence.includes('message:preference'));
  assert.equal((await service.execute('memory.recall', {}, privateBinding)).data.items.length, 0);
  const recreated = await service.execute('memory.propose', { text: '先举例', dimension: 'explanation', evidenceType: 'explicit_user_preference', sourceRefs: ['message:preference'], quote: '以后讲解都先举例' }, privateBinding);
  assert.equal(recreated.kind, 'not_activated');
});

test('messages survive a disabled adapter and can run after the host enables it', async t => {
  const domain = domainFixture(); const model = modelFixture(); model.adapter.available = false;
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  const queued = await service.execute('chat.send', { messageId: 'offline', text: '稍后处理的合成请求' }, privateBinding);
  assert.equal(queued.data.available, false); assert.equal(model.calls.length, 0);
  model.adapter.available = true;
  const status = await drain(service);
  assert.equal(service.available, true); assert.equal(status.answers.length, 1); assert.equal(status.pending, 0);
});

test('restart restores persisted main and child mappings instead of creating new work', async () => {
  const domain = domainFixture(); const model = modelFixture();
  let service = createBotService({ domain, adapter: model.adapter });
  await service.execute('chat.send', { messageId: 'restart-first', text: '第一条合成请求' }, privateBinding);
  const before = await drain(service); await service.close();
  const mainId = domain.states.get('O_fixture:bot').value.main.sessionId;
  service = createBotService({ domain, adapter: model.adapter });
  await service.execute('chat.send', { messageId: 'restart-reply', text: '接着解释', replyTo: before.answers[0].answerId }, privateBinding);
  const after = await drain(service);
  assert.equal(after.tasks.length, 1); assert.equal(after.answers.length, 2);
  assert.ok(model.calls.some(call => call.type === 'open' && call.sessionId === mainId && call.resume));
  await service.close();
});

test('one input can start two independently deliverable tasks without an outbox identity collision', async t => {
  const domain = domainFixture(); const model = modelFixture({ mainCount: 2 });
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'two-goals', text: '讲解文章，另外给出学习计划。' }, privateBinding);
  const status = await drain(service);
  assert.equal(status.tasks.length, 2); assert.equal(status.answers.length, 2); assert.equal(status.pending, 0);
  assert.equal(new Set(status.answers.map(answer => answer.taskId)).size, 2);
});

test('cooling and sleeping change residency without inventing task completion, and a reply wakes the same task', async t => {
  const domain = domainFixture(); const model = modelFixture(); let time = Date.now();
  const service = createBotService({ domain, adapter: model.adapter, clock: () => time }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'sleepable', text: '讲解后我会继续追问。' }, privateBinding); const first = await drain(service);
  time += 31 * 60_000;
  const cooled = await service.execute('runtime.sweep', {}, privateBinding); assert.equal(cooled.data.tasks[0].residency, 'cool'); assert.equal(cooled.data.tasks[0].phase, 'delivered');
  time += 24 * 60 * 60_000;
  const sleeping = await service.execute('runtime.sweep', {}, privateBinding); assert.equal(sleeping.data.tasks[0].residency, 'sleeping'); assert.equal(sleeping.data.tasks[0].phase, 'delivered');
  await service.execute('chat.send', { messageId: 'wake', text: '继续刚才的讲解。', replyTo: first.answers[0].answerId }, privateBinding);
  const resumed = await drain(service); assert.equal(resumed.tasks.length, 1); assert.equal(resumed.tasks[0].id, first.tasks[0].id); assert.equal(resumed.answers.length, 2);
});

test('long dialogue starts a new physical segment while preserving logical work and source-bound references', async t => {
  const domain = domainFixture(); const model = modelFixture();
  const service = createBotService({ domain, adapter: model.adapter, contextBudgetChars: 40 }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'long-first', text: '这是一条用于验证长对话换段与指代保留的合成消息。' }, privateBinding); const first = await drain(service);
  const before = (await service.execute('context.metrics', {}, privateBinding)).data;
  await service.execute('chat.send', { messageId: 'long-followup', text: '请继续解释第二种方法，并保留此前编号的对应关系。', replyTo: first.answers[0].answerId }, privateBinding); const after = await drain(service);
  const metrics = (await service.execute('context.metrics', {}, privateBinding)).data;
  assert.equal(after.tasks.length, 1); assert.equal(after.tasks[0].id, first.tasks[0].id);
  assert.equal(metrics.logicalBotId, before.logicalBotId); assert.ok(metrics.generation > before.generation); assert.notEqual(metrics.mainSegmentId, before.mainSegmentId);
  const childInput = model.calls.filter(call => call.type === 'deliver' && call.payload.block_type === 'task_context').at(-1).payload;
  assert.equal(childInput.checkpoint.needsStateRefresh, true);
  assert.ok(childInput.input.some(item => item.ref === 'message:long-followup'));
  assert.equal(metrics.cacheGuarantee, false);
});

test('different children run in parallel within budget while the main Agent continues to accept new work', async t => {
  const domain = domainFixture();
  let active = 0; let peak = 0; let started = 0;
  let release; const gate = new Promise(resolve => { release = resolve; });
  let bothStarted; const ready = new Promise(resolve => { bothStarted = resolve; });
  let routedNewInput; const newInput = new Promise(resolve => { routedNewInput = resolve; });
  const model = modelFixture({ mainCount: 2, onChild: async () => { active++; peak = Math.max(peak, active); started++; if (started === 2) bothStarted(); await gate; active--; }, onMain: async ({ payload }) => { if (payload.messageId === 'while-running') routedNewInput(); } });
  const service = createBotService({ domain, adapter: model.adapter, maxParallelTasks: 2 }); t.after(async () => { release(); await service.close(); });
  await service.execute('chat.send', { messageId: 'parallel', text: '两个可独立交付的合成目标。' }, privateBinding);
  const deadline = (promise, message) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(message)), 1000); timer.unref?.(); })]);
  await deadline(ready, '两个子任务未能同时开始');
  assert.equal(active, 2);
  await service.execute('chat.send', { messageId: 'while-running', text: '在子任务执行期间新增两项工作。' }, privateBinding);
  await deadline(newInput, '主Agent被子任务阻塞，未能接纳新输入');
  release();
  const status = await drain(service);
  assert.equal(status.tasks.length, 4); assert.equal(status.answers.length, 4); assert.equal(status.pending, 0); assert.equal(peak, 2);
});

test('new replies to a running task remain serial and each segment appends only newly accepted input', async t => {
  const domain = domainFixture(); let active = 0; let peak = 0;
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const ready = new Promise(resolve => { started = resolve; });
  const model = modelFixture({ onChild: async ({ payload }) => {
    active++; peak = Math.max(peak, active);
    if (payload.input.some(item => item.ref === 'message:serial-second')) { started(); await gate; }
    active--;
  } });
  const service = createBotService({ domain, adapter: model.adapter, maxParallelTasks: 2 }); t.after(async () => { release(); await service.close(); });
  await service.execute('chat.send', { messageId: 'serial-first', text: '原始合成资料' }, privateBinding); const first = await drain(service);
  await service.execute('chat.send', { messageId: 'serial-second', text: '第一个追问', replyTo: first.answers[0].answerId }, privateBinding);
  await ready;
  await service.execute('chat.send', { messageId: 'serial-third', text: '第二个追问', replyTo: first.answers[0].answerId }, privateBinding);
  await service.execute('chat.status', {}, privateBinding);
  assert.equal(model.calls.some(call => call.type === 'deliver' && call.payload.input?.some(item => item.ref === 'message:serial-third')), false);
  release(); const result = await drain(service);
  const deliveries = model.calls.filter(call => call.type === 'deliver' && call.payload.block_type === 'task_context').map(call => call.payload);
  assert.deepEqual(deliveries.map(payload => payload.input.map(item => item.ref)), [['message:serial-first'], ['message:serial-second'], ['message:serial-third']]);
  assert.deepEqual(result.answers.map(answer => answer.sourceMessageId), ['serial-first', 'serial-second', 'serial-third']);
  assert.equal(peak, 1); assert.equal(result.tasks.length, 1); assert.equal(result.pending, 0);
});

test('a failed DSH acceptance does not advance the segment input watermark', async t => {
  const domain = domainFixture(); const model = modelFixture(); let rejectOnce = true;
  const originalOpen = model.adapter.open.bind(model.adapter);
  model.adapter.open = async options => {
    const session = await originalOpen(options);
    const deliver = session.deliver.bind(session);
    session.deliver = async message => {
      if (message.payload.block_type === 'task_context' && rejectOnce) { rejectOnce = false; return { accepted: false, answers: [] }; }
      return deliver(message);
    };
    return session;
  };
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'acceptance-retry', text: '合成待重投输入' }, privateBinding);
  const first = await drain(service); assert.equal(first.answers.length, 0);
  const before = Object.values(domain.states.get('O_fixture:bot').value.tasks)[0]; assert.deepEqual(before.segmentAcceptedRefs || [], []);
  await service.execute('runtime.recover', {}, privateBinding); const recovered = await service.execute('runtime.drain', {}, privateBinding); assert.equal(recovered.data.answers.length, 1);
  const after = Object.values(domain.states.get('O_fixture:bot').value.tasks)[0]; assert.deepEqual(after.segmentAcceptedRefs, ['message:acceptance-retry']);
});

test('space UP stays stable across ordinary turns, excludes business contents and changes generation with the active bundle', async t => {
  const domain = domainFixture(); const model = modelFixture();
  domain.snapshot.types = [{ id: 'z_type', version: 1, description: '后一个合成能力' }, { id: 'a_type', version: 1, description: '前一个合成能力' }];
  domain.snapshot.items = [{ body: 'SYNTHETIC_RAW_BUSINESS_FACT' }];
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'baseline-first', text: '合成初始问题' }, privateBinding); const first = await drain(service);
  const original = model.calls.find(call => call.type === 'open' && call.binding.role === 'main');
  assert.ok(original.system.includes('合成空间用途')); assert.ok(original.system.includes('memoryDimensions')); assert.ok(original.system.indexOf('a_type') < original.system.indexOf('z_type'));
  assert.equal(original.system.includes('SYNTHETIC_RAW_BUSINESS_FACT'), false);
  domain.snapshot.types.reverse(); domain.snapshot.items.push({ body: 'SYNTHETIC_NEW_FACT' });
  await service.execute('chat.send', { messageId: 'baseline-second', text: '普通追问', replyTo: first.answers[0].answerId }, privateBinding); const second = await drain(service);
  assert.equal(model.calls.filter(call => call.type === 'open' && call.binding.role === 'main').length, 1);
  domain.snapshot.space.activeBundleId = 'fixture-bundle-2';
  await service.execute('chat.send', { messageId: 'baseline-third', text: '方案变化后的追问', replyTo: second.answers.at(-1).answerId }, privateBinding); const third = await drain(service);
  const mainSessions = model.calls.filter(call => call.type === 'open' && call.binding.role === 'main');
  assert.equal(mainSessions.length, 2); assert.notEqual(mainSessions[0].sessionId, mainSessions[1].sessionId);
  assert.ok(mainSessions[1].system.includes('fixture-bundle-2')); assert.equal(third.tasks.length, 1);
});

test('real SQLite object scopes survive key reordering and legacy scope strings migrate without losing an original delivery', async t => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-object-scope-'));
  const domain = createDomainService({ baseDir }); const model = modelFixture(); model.adapter.available = false;
  const binding = { trusted: true, objectiveId: 'O_object_scope', sourceScope: { kind: 'private', id: 'O_object_scope' } };
  assert.equal((await domain.execute('space.create', { title: '合成对象来源' }, binding)).kind, 'saved');
  let service = createBotService({ domain, adapter: model.adapter });
  t.after(async () => { await service.close(); await domain.close(); await fs.rm(baseDir, { recursive: true, force: true }); });
  const input = { messageId: 'original-object-scope', text: '合成资料收藏，不猜链接。' };
  const initial = await service.execute('chat.send', input, binding); assert.equal(initial.kind, 'accepted');
  await service.close();
  const host = { objectiveId: binding.objectiveId, trusted: true, sourceScope: 'bot' };
  const stored = await domain.execute('runtime.load', { key: 'bot' }, host);
  const legacy = stored.data.value;
  const oldScope = JSON.stringify({ kind: 'private', id: binding.objectiveId });
  legacy.inbox[0].sourceScope = oldScope;
  legacy.idempotency[`chat:${input.messageId}`].hash = createHash('sha256').update(JSON.stringify({ text: input.text, replyTo: null, materials: [], sourceScope: oldScope, allowedActions: null })).digest('hex');
  legacy.outbox[0].attempts = 1; legacy.outbox[0].error = { code: 'BOT_TIMEOUT', message: '合成旧版超时' };
  assert.equal((await domain.execute('runtime.store', { key: 'bot', expectedRevision: stored.data.revision, value: legacy }, host)).kind, 'saved');
  model.adapter.available = true; service = createBotService({ domain, adapter: model.adapter });
  const reordered = { ...binding, sourceScope: { id: binding.objectiveId, kind: 'private' } };
  const status = await service.execute('chat.status', {}, reordered);
  assert.equal(status.data.messages.length, 1); assert.equal(status.data.errors[0].code, 'BOT_TIMEOUT'); assert.equal(status.data.errors[0].retryable, true);
  const foreign = await service.execute('chat.status', {}, { ...binding, sourceScope: 'group:general' }); assert.equal(foreign.data.errors.length, 0); assert.equal(foreign.data.pending, 0);
  const forbidden = await service.execute('runtime.recover', { deliveryId: initial.data.deliveryId }, { ...binding, sourceScope: 'group:general' }); assert.equal(forbidden.kind, 'rejected');
  assert.equal((await service.execute('chat.send', input, reordered)).kind, 'accepted');
  await service.execute('runtime.recover', { deliveryId: initial.data.deliveryId }, reordered);
  const recovered = await service.execute('runtime.drain', {}, reordered);
  assert.equal(recovered.data.messages.length, 1); assert.equal(recovered.data.tasks.length, 1); assert.equal(recovered.data.answers.length, 1); assert.equal(recovered.data.errors.length, 0); assert.equal(recovered.data.pending, 0);
  assert.equal(model.calls.filter(call => call.type === 'open' && call.binding.role === 'main').length, 1);
});

test('a settled model turn without task dispatch remains an explicit recoverable failure', async t => {
  const domain = domainFixture(); let deliveries = 0;
  const adapter = { available: true, async open(options) { return { sessionId: options.sessionId, async deliver() { deliveries++; return { accepted: true, duplicate: deliveries > 1, settled: true, answers: [{ text: '不能当成业务成功的合成回答' }] }; }, async release() {} }; } };
  const service = createBotService({ domain, adapter }); t.after(() => service.close());
  const sent = await service.execute('chat.send', { messageId: 'undispatched', text: '合成记录要求' }, privateBinding); const first = await drain(service);
  assert.equal(first.errors[0].code, 'MISSING_TASK_DISPATCH'); assert.equal(first.retryable, true); assert.equal(first.pending, 1);
  await service.execute('runtime.recover', { deliveryId: sent.data.deliveryId }, privateBinding);
  const retried = await service.execute('runtime.drain', {}, privateBinding);
  assert.equal(retried.data.pending, 1); assert.equal(retried.data.errors[0].code, 'MISSING_TASK_DISPATCH'); assert.equal(retried.data.tasks.length, 0); assert.equal(retried.data.answers.length, 0); assert.equal(retried.data.messages.length, 1);
});

test('a committed child report reconciles a lost delivery response without repeating the child', async t => {
  const domain = domainFixture(); const model = modelFixture(); let drop = true;
  const originalOpen = model.adapter.open.bind(model.adapter);
  model.adapter.open = async options => { const session = await originalOpen(options); const original = session.deliver.bind(session); session.deliver = async message => { const result = await original(message); if (message.payload.block_type === 'task_context' && drop) { drop = false; throw Object.assign(new Error('合成交付响应丢失'), { code: 'CONNECTION_LOST' }); } return result; }; return session; };
  const service = createBotService({ domain, adapter: model.adapter }); t.after(() => service.close());
  await service.execute('chat.send', { messageId: 'lost-report-response', text: '合成资料解释' }, privateBinding); const first = await drain(service);
  assert.equal(first.answers.length, 1); assert.equal(first.errors[0].code, 'CONNECTION_LOST');
  await service.execute('runtime.recover', { deliveryId: first.errors[0].deliveryId }, privateBinding);
  const recovered = await service.execute('runtime.drain', {}, privateBinding);
  assert.equal(recovered.data.answers.length, 1); assert.equal(recovered.data.tasks.length, 1); assert.equal(recovered.data.pending, 0); assert.equal(recovered.data.errors.length, 0);
  assert.equal(model.calls.filter(call => call.type === 'deliver' && call.payload.block_type === 'task_context').length, 1);
});

test('recover returns immediately while parent notification remains in progress and drain still waits', async t => {
  const domain = domainFixture(); const model = modelFixture(); let rejectOnce = true;
  let releaseNotification; const notificationGate = new Promise(resolve => { releaseNotification = resolve; });
  let notificationStarted; const notificationReady = new Promise(resolve => { notificationStarted = resolve; });
  const originalOpen = model.adapter.open.bind(model.adapter);
  model.adapter.open = async options => {
    const session = await originalOpen(options); const deliver = session.deliver.bind(session);
    session.deliver = async message => {
      if (message.payload.block_type === 'task_context' && rejectOnce) { rejectOnce = false; return { accepted: false, answers: [] }; }
      const result = await deliver(message);
      if (message.payload.block_type === 'task_state_event') { notificationStarted(); await notificationGate; }
      return result;
    };
    return session;
  };
  const service = createBotService({ domain, adapter: model.adapter }); t.after(async () => { releaseNotification(); await service.close(); });
  await service.execute('chat.send', { messageId: 'background-recovery', text: '合成恢复原工作' }, privateBinding);
  const failed = await drain(service); assert.equal(failed.errors.length, 1);
  let deadline;
  const recovered = await Promise.race([
    service.execute('runtime.recover', { deliveryId: failed.errors[0].deliveryId }, privateBinding),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('recover等待了整个后台工作')), 1000); }),
  ]).finally(() => clearTimeout(deadline));
  assert.equal(recovered.kind, 'read'); assert.equal(recovered.data.messages.length, 1);
  await notificationReady;
  let drained = false;
  const waiting = service.execute('runtime.drain', {}, privateBinding).then(result => { drained = true; return result; });
  const visible = await service.execute('chat.status', {}, privateBinding);
  assert.equal(visible.data.answers.length, 1); assert.equal(visible.data.messages.length, 1); assert.equal(drained, false);
  releaseNotification();
  const completed = await waiting;
  assert.equal(completed.data.pending, 0); assert.equal(completed.data.errors.length, 0); assert.equal(completed.data.answers.length, 1);
});

test('real SQLite periodic empty sweeps preserve operations and runtime revision while real residency changes commit once', async t => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-sweep-readonly-'));
  const domain = createDomainService({ baseDir }); const model = modelFixture(); model.adapter.available = false;
  const binding = { trusted: true, objectiveId: 'O_sweep_fixture', sourceScope: { kind: 'private', id: 'O_sweep_fixture' } };
  const runtimeHost = { ...binding, sourceScope: 'bot' };
  assert.equal((await domain.execute('space.create', { title: '合成空扫验收' }, binding)).kind, 'saved');
  let time = Date.now();
  const service = createBotService({ baseDir, domain, adapter: model.adapter, coolAfterMs: 25, sleepAfterMs: 1000, clock: () => time });
  t.after(async () => { await service.close(); await domain.close(); await fs.rm(baseDir, { recursive: true, force: true }); });
  // The inspection uses a separate read-only SQLite Worker and only this test's DB.
  async function snapshot() {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(workerData.file, { readOnly: true });
      const count = db.prepare('SELECT COUNT(*) AS total FROM operations').get().total;
      const row = db.prepare("SELECT revision,value FROM hosted_state WHERE namespace='runtime' AND key='bot' AND scope='bot'").get();
      parentPort.postMessage({ count, revision: row?.revision || 0, value: row ? JSON.parse(row.value) : null });
      db.close();
    `)}`), { workerData: { file: path.join(baseDir, binding.objectiveId, 'space.sqlite') }, execArgv: [] });
    return new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error(`inspection Worker exited ${code}`)); }); });
  }
  const emptyBefore = await snapshot();
  assert.equal((await service.execute('chat.status', {}, binding)).kind, 'read');
  await new Promise(resolve => setTimeout(resolve, 80));
  await service.execute('runtime.sweep', {}, binding);
  assert.deepEqual(await snapshot(), emptyBefore);
  model.adapter.available = true;
  await service.execute('chat.send', { messageId: 'residency-original', text: '合成驻留工作' }, binding);
  await service.execute('runtime.drain', {}, binding);
  const hot = await snapshot(); const task = Object.values(hot.value.tasks)[0];
  assert.equal(task.residency, 'hot');
  for (let index = 0; index < 3; index++) await service.execute('runtime.sweep', {}, binding);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(await snapshot(), hot);
  time = Date.parse(task.updatedAt) + 26;
  await service.execute('runtime.sweep', {}, binding);
  const cool = await snapshot();
  assert.equal(cool.count, hot.count + 1); assert.equal(cool.revision, hot.revision + 1);
  assert.equal(cool.value.tasks[task.id].residency, 'cool'); assert.equal(cool.value.tasks[task.id].phase, task.phase);
  assert.equal(cool.value.traceLedger.events.filter(event => event.type === 'task.residency.changed').length, 1);
  await service.execute('runtime.sweep', {}, binding); assert.deepEqual(await snapshot(), cool);
  time = Date.parse(task.updatedAt) + 1001;
  await service.execute('runtime.sweep', {}, binding);
  const sleeping = await snapshot();
  assert.equal(sleeping.count, cool.count + 1); assert.equal(sleeping.revision, cool.revision + 1);
  assert.equal(sleeping.value.tasks[task.id].residency, 'sleeping');
  assert.equal(sleeping.value.traceLedger.events.filter(event => event.type === 'task.residency.changed').length, 2);
  await service.execute('runtime.sweep', {}, binding); assert.deepEqual(await snapshot(), sleeping);
  const running = sleeping.value; running.tasks[task.id].phase = 'running'; running.tasks[task.id].residency = 'hot'; running.tasks[task.id].lease = { owner: 'synthetic-owner', expiresAt: time + 120000 };
  assert.equal((await domain.execute('runtime.store', { key: 'bot', expectedRevision: sleeping.revision, value: running }, runtimeHost)).kind, 'saved');
  const leased = await snapshot(); await service.execute('runtime.sweep', {}, binding); assert.deepEqual(await snapshot(), leased);
});
