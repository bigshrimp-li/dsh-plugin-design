import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createPluginService } from '../src/host/service.js';
import { createHttpHandler } from '../src/host/http.js';
import { dataOf } from '../src/host/protocol.js';

const user = { objectiveId: 'O_fixture', trusted: true, userInitiated: true, sourceScope: 'private:fixture' };
const bundle = () => ({
  title: '合成笔记空间', description: '仅用于集成测试',
  types: [{ id: 'note', version: 1, fields: [{ id: 'content', kind: 'text', required: true }] }],
  tools: [{ id: 'notes', description: '维护合成笔记', skill: '用户明确要求记录时保存，查询不会写入。', commands: {
    save: { input: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['content'] }, program: [{ op: 'save', typeId: 'note', input: { title: { ref: 'input.title' }, fields: { content: { ref: 'input.content' } } } }], examples: [{ title: '演示', content: '合成演示记录' }] },
    query: { input: { type: 'object' }, program: [{ op: 'query', typeId: 'note', input: {} }], examples: [{}] },
  } }], page: [{ kind: 'table', typeId: 'note', title: '记录' }],
});

async function fixture(t, options = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-service-'));
  const queue = [];
  const adapter = options.adapter || { available: true, async generate() { const data = queue.shift(); if (!data) throw new Error('合成模型响应队列为空'); return { text: JSON.stringify(data), data }; } };
  const service = createPluginService({ baseDir, adapter });
  const capability = await service.domain.capabilities(); assert.equal(capability.sqlite, true, capability.reason);
  t.after(async () => { await service.close(); await fs.rm(baseDir, { recursive: true, force: true }); });
  return { baseDir, service, queue, run: (command, input = {}, binding = user) => service.execute(command, input, binding) };
}

async function draftAndReview(f) {
  assert.equal((await f.run('scheme.create', { objectiveId: user.objectiveId, title: '合成空间' })).kind, 'saved');
  f.queue.push(bundle());
  const generated = await f.run('scheme.generate', { instruction: '记录文字笔记' });
  assert.equal(generated.kind, 'saved', JSON.stringify(generated));
  const reviewed = await f.run('scheme.review');
  assert.equal(reviewed.kind, 'saved', JSON.stringify(reviewed));
  const state = (await f.run('scheme.get')).data.draft;
  assert.equal(state.value.review.passed, true, JSON.stringify(state.value.review));
  return state;
}

async function activate(f, selectedTrialIds = []) {
  const draft = (await f.run('scheme.get')).data.draft;
  const result = await f.run('scheme.confirm', { expectedRevision: draft.revision, hash: draft.value.hash, selectedTrialIds });
  assert.equal(result.kind, 'saved', JSON.stringify(result));
  return result;
}

test('first AI scheme generation is reviewed in trial storage before activation and read-only tools cannot write', async t => {
  const f = await fixture(t); const draft = await draftAndReview(f);
  assert.equal((await f.run('workspace.state')).data.space.lifecycle, 'draft');
  assert.equal((await f.run('items.query')).data.items.length, 0);
  const trials = (await f.run('trial.list', { draftId: draft.value.id })).data;
  assert.ok((trials.trials || trials.records || []).some(record => record.provenance === 'demo'));
  const confirmed = await activate(f);
  assert.ok(confirmed.data.bundleId);
  assert.equal((await f.run('workspace.state')).data.space.lifecycle, 'formal');
  assert.equal((await f.run('items.query')).data.items.length, 0);
  const blocked = await f.run('tool.run', { toolId: 'notes', command: 'save', input: { title: '禁止', content: '禁止保存' }, requestId: 'readonly' }, { ...user, sourceScope: 'group:general', allowedActions: ['read', 'suggest'] });
  assert.notEqual(blocked.kind, 'saved');
  assert.equal((await f.run('items.query')).data.items.length, 0);
  const saved = await f.run('tool.run', { toolId: 'notes', command: 'save', input: { title: '笔记', content: '应保存一次' }, requestId: 'write-once' });
  assert.equal(saved.kind, 'saved', JSON.stringify(saved));
  assert.equal((await f.run('tool.run', { toolId: 'notes', command: 'query', input: {} })).data.items.length, 1);
});

test('scheme and planning register their actual workflow sessions, including failed generation, without a Bot runtime', async t => {
  let calls = 0;
  const f = await fixture(t, { adapter: { available: true, async generate(options) {
    const ref = { sessionId: `workflow-fixture-${++calls}`, purpose: options.binding.purpose };
    await options.onSession(ref);
    if (calls === 2) throw Object.assign(new Error('合成生成失败'), { trace: ref });
    return { data: bundle(), trace: ref };
  } } });
  const binding = { ...user, sourceScope: { kind: 'private', id: user.objectiveId } };
  assert.equal((await f.run('scheme.create', { objectiveId: user.objectiveId, title: '合成工作流' }, binding)).kind, 'saved');
  assert.equal((await f.run('scheme.generate', { instruction: '合成方案' }, binding)).kind, 'saved');
  assert.equal((await f.run('plan.generate', { goal: '合成失败' }, binding)).kind, 'failed');
  const stored = (await f.service.domain.execute('host.state.get', { namespace: 'trace', key: 'workflows' }, binding)).data.value.sessions;
  assert.deepEqual(stored.map(entry => [entry.sessionId, entry.purpose, entry.status]), [
    ['workflow-fixture-1', 'scheme.generate', 'completed'],
    ['workflow-fixture-2', 'plan.generate', 'failed']
  ]);
  assert.equal((await f.service.domain.execute('runtime.load', { key: 'bot' }, { ...binding, sourceScope: 'bot' })).data.value, null);
  const trace = await f.service.trace.execute('trace.task.get', {}, { ...binding, traceMode: 'private' });
  assert.equal(trace.kind, 'read', JSON.stringify(trace));
  assert.equal(trace.data.segments.filter(segment => segment.role === 'workflow').length, 2);
});

test('confirmation transfers selected real trials once and keeps unselected real material discoverable', async t => {
  const f = await fixture(t); await draftAndReview(f);
  const real = await f.run('scheme.trial', { toolId: 'notes', command: 'save', input: { title: '真实试用一', content: '合成真实试用一' }, requestId: 'real-one' });
  const other = await f.run('scheme.trial', { toolId: 'notes', command: 'save', input: { title: '真实试用二', content: '合成真实试用二' }, requestId: 'real-two' });
  assert.equal(real.kind, 'trial', JSON.stringify(real)); assert.equal(other.kind, 'trial', JSON.stringify(other));
  assert.equal(real.data.provenance, 'real'); assert.equal(other.data.provenance, 'real');
  await activate(f, [real.data.trialId]);
  assert.equal((await f.run('items.query')).data.items.length, 1);
  const resume = await f.run('scheme.resumeTransfers'); assert.equal(resume.kind, 'read');
  assert.equal((await f.run('items.query')).data.items.length, 1);
  const state = (await f.run('workspace.state')).data;
  assert.ok(state.pending_materials.some(material => material.trialId === other.data.trialId), JSON.stringify(state.pending_materials));
});

test('migrated compatibility data supports an AI adjustment draft against its actual active version', async t => {
  const f = await fixture(t);
  const directory = path.join(f.baseDir, user.objectiveId); await fs.mkdir(directory);
  const data = { 'meta.json': { id: user.objectiveId, title: '合成旧空间' }, 'keypoints.json': [], 'schedules.json': [{ id: 'SCH_fixture', title: '旧行动', date: '2026-10-27', status: 'pending' }], 'inspirations.json': [], 'results.json': [] };
  for (const [name, value] of Object.entries(data)) await fs.writeFile(path.join(directory, name), JSON.stringify(value));
  const inspect = await f.run('space.inspect'); assert.equal(inspect.kind, 'read');
  const migration = await f.run('space.migrate', { confirmed: true, inspectionHash: inspect.data.inspectionHash }); assert.equal(migration.kind, 'saved', JSON.stringify(migration));
  f.queue.push(bundle());
  assert.equal((await f.run('scheme.generate', { instruction: '新增笔记类型' })).kind, 'saved');
  const draft = (await f.run('scheme.get')).data.draft;
  assert.equal(draft.value.baseBundleId, 'compatibility-v1');
  assert.equal((await f.run('scheme.review')).kind, 'saved');
  await activate(f);
  const items = (await f.run('items.query')).data.items;
  assert.ok(items.some(item => item.id === 'SCH_fixture'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'schedules.json'), 'utf8')), data['schedules.json']);
});

test('planning remains suggestions until adoption and saved R preserves actual execution evidence', async t => {
  const f = await fixture(t); await draftAndReview(f); await activate(f);
  f.queue.push({ title: '合成计划', assumptions: [], suggestions: [{ title: '阅读十分钟', reason: '用于测试', typeId: 'note', fields: { content: '阅读' }, body: '合成行动' }] });
  const generated = await f.run('plan.generate', { goal: '合成学习目标' }); assert.equal(generated.kind, 'saved', JSON.stringify(generated));
  assert.equal((await f.run('items.query')).data.items.length, 0);
  const plan = generated.data.value;
  const adopted = await f.run('plan.adopt', { id: plan.id, hash: plan.hash, selected: [0] }); assert.equal(adopted.kind, 'saved', JSON.stringify(adopted));
  const current = (await f.run('workspace.state')).data; assert.equal(current.items.length, 1); assert.equal(current.executions.length, 0);
  const itemId = current.items[0].id;
  const execution = await f.run('execution.save', { itemId, occurrenceKey: '2026-10-27', state: 'completed', note: '合成完成记录', requestId: 'execute-once' }); assert.equal(execution.kind, 'saved', JSON.stringify(execution));
  const executionId = execution.data.executionId;
  f.queue.push({ title: '合成复盘', summary: '基于真实合成执行', targetId: user.objectiveId, evidenceIds: [executionId], assumptions: [] });
  const reviewed = await f.run('review.generate', { question: '回顾今天' }); assert.equal(reviewed.kind, 'saved', JSON.stringify(reviewed));
  const review = reviewed.data.value;
  const saved = await f.run('review.save', { id: review.id, hash: review.hash }); assert.equal(saved.kind, 'saved', JSON.stringify(saved));
  const results = (await f.run('workspace.state')).data.results;
  assert.ok(results.at(-1).evidence.includes(executionId), JSON.stringify(results.at(-1)));
});

test('real service wiring keeps a group planning child read-only and publishes only to its source', async t => {
  const writes = [];
  const adapter = { available: true, async generate() { throw new Error('此合成场景不应生成派发计划'); }, async open(options) {
    const tools = new Map(options.tools.map(tool => [tool.name, tool]));
    const invoke = (name, args) => tools.get(name).execute(args, options.binding, { signal: new AbortController().signal, callId: 'service-fixture' });
    return { sessionId: options.sessionId, async deliver({ id, payload }) {
      if (payload.block_type === 'inbox_event') await invoke('task_create', { messageId: payload.messageId, inputRefs: payload.inputRefs, title: '合成群建议', requestId: `route:${id}` });
      if (payload.block_type === 'task_context') {
        const result = await invoke('space_execute', { toolId: 'notes', command: 'save', input: { title: '应被拒绝', content: '群计划没有记录授权' }, requestId: `write:${id}` });
        writes.push({ result, binding: structuredClone(options.binding) });
        const task = (await invoke('task_get', { taskId: payload.task.id })).data;
        await invoke('task_report', { taskId: task.id, runId: task.runId, expectedRevision: task.revision, requestId: `report:${id}`, phase: 'delivered', answer: '这是建议，未保存事项。', operationRefs: [] });
      }
      return { accepted: true, answers: [] };
    }, readAnswers() { return []; }, inspectMessage() { return { state: 'not_found' }; }, async release() {}, cancel() {} };
  } };
  const f = await fixture(t, { adapter });
  await f.run('scheme.create', { objectiveId: user.objectiveId, title: '学习' });
  assert.equal((await f.run('scheme.draft', { bundle: bundle() })).kind, 'saved');
  assert.equal((await f.run('scheme.review')).kind, 'saved'); await activate(f);
  const groupUser = { trusted: true, userInitiated: true, sourceScope: 'group:general', groupId: 'general', global: true };
  const accepted = await f.run('group.plan', { requestId: 'group-plan', objectiveIds: [user.objectiveId], text: '给出明天的建议' }, groupUser); assert.equal(accepted.kind, 'accepted', JSON.stringify(accepted));
  const drained = await f.service.bot.execute('runtime.drain', {}, { ...groupUser, objectiveId: user.objectiveId }); assert.equal(drained.kind, 'read', JSON.stringify(drained));
  assert.equal(writes.length, 1); assert.notEqual(writes[0].result.kind, 'saved');
  assert.deepEqual(writes[0].binding.allowedActions, ['read', 'suggest']);
  assert.equal((await f.run('items.query')).data.items.length, 0);
  const group = await f.run('group.state', {}, groupUser);
  assert.ok(group.data.messages.some(message => message.role === 'member' && message.text === '这是建议，未保存事项。'), JSON.stringify(group));
  const personal = await f.run('chat.history'); assert.equal(personal.data.answers.length, 0);
});

test('HTTP capabilities fix the space, forbid Host-only commands and reject cross-origin mutation', async () => {
  const calls = [];
  const handler = createHttpHandler({ service: { async execute(command, input, binding) { calls.push({ command, input, binding }); return { kind: 'read', data: {} }; } } });
  async function request(url, { method = 'GET', headers = {}, input } = {}) {
    const req = Readable.from(input ? [Buffer.from(JSON.stringify(input))] : []); Object.assign(req, { url, method, headers: { host: '127.0.0.1:3789', ...headers } });
    let status; let result;
    await handler(req, { writeHead(code) { status = code; }, end(value) { result = JSON.parse(value); } });
    return { status, result };
  }
  const bootstrap = await request('/okr-space/api/bootstrap?objectiveId=O_fixture', { headers: { 'x-okr-client': 'workbench' } });
  assert.equal(bootstrap.status, 200);
  const headers = { authorization: `Bearer ${bootstrap.result.token}`, 'content-type': 'application/json' };
  const accepted = await request('/okr-space/api/action', { method: 'POST', headers, input: { command: 'items.query', input: { binding: { objectiveId: 'O_other' } } } }); assert.equal(accepted.status, 200);
  assert.equal(calls[0].binding.objectiveId, 'O_fixture'); assert.equal(calls[0].binding.userInitiated, true);
  assert.equal((await request('/okr-space/api/action', { method: 'POST', headers, input: { command: 'runtime.store', input: {} } })).status, 403);
  assert.equal((await request('/okr-space/api/action', { method: 'POST', headers: { ...headers, origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site' }, input: { command: 'item.save', input: {} } })).status, 403);
});

test('receipt extraction does not treat rejected, disabled or failed Agent operations as success', () => {
  for (const kind of ['failed', 'conflict', 'unsupported', 'error', 'disabled', 'rejected', 'not_activated']) assert.throws(() => dataOf({ kind, data: { unsafe: true }, error: { code: 'DENIED', message: '未成功' } }), undefined, kind);
  assert.deepEqual(dataOf({ kind: 'read', data: { valid: true } }), { valid: true });
});

test('scheme confirmation replays its committed version after a lost response and detects changed confirmation input', async t => {
  const f=await fixture(t);const draft=await draftAndReview(f);
  const input={expectedRevision:draft.revision,hash:draft.value.hash,selectedTrialIds:[],requestId:'confirm-original'};
  const first=await f.run('scheme.confirm',input);assert.equal(first.kind,'saved',JSON.stringify(first));
  const replay=await f.run('scheme.confirm',input);assert.equal(replay.kind,'saved',JSON.stringify(replay));assert.equal(replay.data.bundleId,first.data.bundleId);assert.equal(replay.data.alreadyConfirmed,true);
  assert.equal((await f.run('scheme.confirm',{...input,selectedTrialIds:['changed']})).kind,'conflict');
});
test('adjustment, compatibility review, restoration and separately approved batch changes preserve facts',async t=>{
  const f=await fixture(t);await draftAndReview(f);const original=(await activate(f)).data.bundleId;
  const item=await f.run('item.save',{typeId:'note',title:'原始标题',fields:{content:'原始事实'}});assert.equal(item.kind,'saved');
  const next=bundle();next.types[0].version=2;next.types[0].fields.push({id:'tag',kind:'text'});
  assert.equal((await f.run('scheme.draft',{bundle:next})).kind,'saved');await f.run('scheme.review');
  let draft=(await f.run('scheme.get')).data.draft;assert.equal(draft.value.compatibility.affectedItems,1);
  await f.run('item.save',{typeId:'note',title:'审查期间新增',fields:{content:'独立事实'}});
  assert.equal((await f.run('scheme.confirm',{expectedRevision:draft.revision,hash:draft.value.hash})).error.code,'STALE_COMPATIBILITY');
  await f.run('scheme.review');await activate(f);
  assert.equal((await f.run('items.query')).data.items.find(value=>value.id===item.data.itemId).typeVersion,'1');
  const preview=await f.run('batch.preview',{changes:[{itemId:item.data.itemId,title:'明确采纳的修改'}]});assert.equal(preview.kind,'saved',JSON.stringify(preview));
  const plan=preview.data.value;
  assert.equal((await f.run('batch.confirm',{planId:plan.id,hash:'wrong'})).kind,'conflict');
  assert.equal((await f.run('batch.confirm',{planId:plan.id,hash:plan.hash})).kind,'saved');
  assert.equal((await f.run('scheme.restore',{bundleId:original})).kind,'saved');await f.run('scheme.review');await activate(f);
  const final=(await f.run('items.query')).data.items;assert.equal(final.length,2);assert.equal(final.find(value=>value.id===item.data.itemId).title,'明确采纳的修改');
});
