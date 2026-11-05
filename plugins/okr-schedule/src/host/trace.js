import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const clone = value => value === undefined ? null : structuredClone(value);
const stable = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export const traceScope = value => { if (typeof value !== 'string') return stable(value || null); try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? stable(parsed) : value; } catch { return value; } };
const bounded = (value, length = 300) => typeof value === 'string' ? value.slice(0, length) : value;
const MAX_EVENTS = 256;
const MAX_ATTEMPTS = 128;
const fields = ['type', 'title', 'at', 'status', 'sourceScope', 'objectiveId', 'taskId', 'messageId', 'answerId', 'groupMessageId', 'partId', 'deliveryId', 'attemptId', 'runId', 'sessionId', 'contextGeneration', 'childDeliveryId', 'childSessionId', 'callId', 'operationId', 'publicationId', 'recoveryId', 'previousAttemptId', 'previousSessionId', 'reason', 'tool', 'code', 'nativeSeq', 'turn', 'summary'];

/** Reference-only journal. Call only inside the owner's existing state transaction. */
export function appendTraceEvent(state, event, { key, at = new Date().toISOString() } = {}) {
  const ledger = state.traceLedger ||= { version: 1, startedAt: at, historyBeforeStart: true, nextSeq: 1, droppedEvents: 0, droppedAttempts: 0, events: [], attempts: [] };
  if (key && ledger.events.some(item => item.key === key)) return ledger.events.find(item => item.key === key);
  const seq = ledger.nextSeq++;
  const entry = { id: `host:${state.botId || `group:${state.groupId}`}:${seq}`, seq };
  for (const field of fields) if (event[field] !== undefined && event[field] !== null) entry[field] = bounded(event[field], field === 'summary' ? 500 : 300);
  entry.at ||= at;
  if (key) entry.key = bounded(key, 500);
  if (Array.isArray(event.inputRefs)) entry.inputRefs = event.inputRefs.filter(item => typeof item === 'string').slice(-24).map(item => bounded(item));
  if (Array.isArray(event.operationRefs)) entry.operationRefs = event.operationRefs.filter(item => typeof item === 'string').slice(-24).map(item => bounded(item));
  ledger.events.push(entry);
  if (ledger.events.length > MAX_EVENTS) ledger.droppedEvents += ledger.events.splice(0, ledger.events.length - MAX_EVENTS).length;
  return entry;
}

export function startTraceAttempt(state, delivery, segment, sourceScope, at = new Date().toISOString()) {
  appendTraceEvent(state, { type: 'delivery.attempt.started', title: delivery.target === 'main-state' ? '父 Agent 状态通知开始' : '投递尝试开始', at, status: 'running', sourceScope, taskId: delivery.taskId, messageId: delivery.messageId, deliveryId: delivery.id, attemptId: delivery.attemptId, runId: `run:${delivery.id}`, sessionId: segment.sessionId, contextGeneration: segment.contextGeneration, previousAttemptId: delivery.previousAttemptId }, { key: `${delivery.attemptId}:start`, at });
  const ledger = state.traceLedger;
  const attempt = { id: delivery.attemptId, deliveryId: delivery.id, number: delivery.attempts, target: delivery.target, taskId: delivery.taskId, messageId: delivery.messageId, sourceScope, runId: `run:${delivery.id}`, sessionId: segment.sessionId, contextGeneration: segment.contextGeneration, startedAt: at, endedAt: null, status: 'running', recoveryId: null, previousAttemptId: delivery.previousAttemptId || null };
  ledger.attempts.push(attempt);
  if (ledger.attempts.length > MAX_ATTEMPTS) ledger.droppedAttempts += ledger.attempts.splice(0, ledger.attempts.length - MAX_ATTEMPTS).length;
  return attempt;
}

export function finishTraceAttempt(state, delivery, outcome, at = new Date().toISOString()) {
  const attempt = state.traceLedger?.attempts.find(item => item.id === delivery.attemptId);
  if (attempt) Object.assign(attempt, clone(outcome), { endedAt: at });
  return attempt;
}

const fault = (code, message) => { throw Object.assign(new Error(message), { code }); };
const privateScope = objectiveId => traceScope({ kind: 'private', id: objectiveId });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) && !['.', '..', 'groups', 'migrations'].includes(id);
const dataOf = result => { if (result?.kind !== 'read') fault(result?.error?.code || 'TRACE_UNAVAILABLE', result?.error?.message || '轨迹索引不可用。'); return result.data || {}; };
const taskSummary = task => ({ id: task.id, taskId: task.id, title: task.title, goal: task.goal || '', sourceScope: traceScope(task.sourceScope), groupMessageId: task.groupMessageId || (task.authorizedRefs || []).find(ref => ref.startsWith('group-message:general:'))?.slice('group-message:general:'.length) || null, phase: task.phase, residency: task.residency, revision: task.revision, runId: task.runId || null, updatedAt: task.updatedAt || null, wait: clone(task.wait), lastAnswerRef: task.lastAnswerRef || null, relatedTaskId: task.relatedTaskId || null });

/** Public okrTrace/v1: reads only existing Host indexes, never creates/resumes Agents. */
export function createTraceService({ domain, baseDir = path.join(os.homedir(), '.dsh_okr'), clock = () => Date.now() } = {}) {
  if (!domain?.execute) throw new Error('Trace 需要领域只读服务。');
  const secret = randomBytes(32);
  const registrations = new Map();
  let closed = false;
  const sign = value => { const body = Buffer.from(stable(value)).toString('base64url'); return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`; };
  function decode(token) {
    if (typeof token !== 'string' || token.length > 5000) fault('INVALID_REFERENCE', '轨迹引用无效。');
    const [body, mac, extra] = token.split('.');
    if (!body || !mac || extra || createHmac('sha256', secret).update(body).digest('base64url') !== mac) fault('INVALID_REFERENCE', '轨迹引用未由当前 Host 签发。');
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return fault('INVALID_REFERENCE', '轨迹引用无效。'); }
  }
  function authorize(binding) {
    if (closed) fault('TRACE_UNAVAILABLE', '轨迹服务已关闭。');
    if (binding?.trusted !== true || binding?.userInitiated !== true || binding.role || binding.runId || binding.contextFence || !['private', 'group', 'diagnostic'].includes(binding.traceMode)) fault('FORBIDDEN', '轨迹只能由用户的可信 Host 查看入口读取。');
    if (binding.objectiveId && !validId(binding.objectiveId)) fault('FORBIDDEN', '空间范围无效。');
    if (binding.traceMode === 'group' && binding.sourceScope && traceScope(binding.sourceScope) !== 'group:general') fault('FORBIDDEN', '群轨迹只能使用综合群来源。');
    if (binding.traceMode === 'private' && typeof binding.sourceScope === 'string' && binding.sourceScope.startsWith('group:')) fault('FORBIDDEN', '私聊入口不能扩大为群来源。');
    if (binding.traceMode === 'private' && binding.objectiveId && binding.sourceScope && ![privateScope(binding.objectiveId), `private:${binding.objectiveId}`].includes(traceScope(binding.sourceScope))) fault('FORBIDDEN', '私聊来源必须属于选定空间。');
    return binding;
  }
  function objective(input, binding, required = true) {
    const requested = input.objectiveId || (typeof input.botId === 'string' ? input.botId.replace(/^bot:/u, '') : null);
    if (binding.objectiveId && requested && binding.objectiveId !== requested) fault('FORBIDDEN', '轨迹目标不属于 Host 固定的空间。');
    const id = binding.objectiveId || (binding.traceMode === 'group' ? requested : null);
    if (required && !id) fault('SCOPE_REQUIRED', '请从选定空间的轨迹入口打开。');
    if (id && !validId(id)) fault('FORBIDDEN', '空间范围无效。');
    return id;
  }
  const scope = (binding, objectiveId) => binding.traceMode === 'diagnostic' ? null : binding.traceMode === 'group' ? 'group:general' : traceScope(binding.sourceScope || privateScope(objectiveId));
  const filterKey = (input, binding, objectiveId) => stable({ mode: binding.traceMode, objectiveId, sourceScope: scope(binding, objectiveId), taskId: input.taskId || null, groupMessageId: input.groupMessageId || null });
  const coverageOf = value => ({ hostEvents: value?.traceLedger ? 'recorded' : 'historical_unrecorded', historyBeforeStart: value?.traceLedger?.historyBeforeStart ?? true, startedAt: value?.traceLedger?.startedAt || null, droppedEvents: value?.traceLedger?.droppedEvents || 0, droppedAttempts: value?.traceLedger?.droppedAttempts || 0, usage: 'unknown', nativeEvents: 'session_query_required' });
  async function directory(binding) {
    const listing = dataOf(await domain.execute('spaces.list', {}, { trusted: true, global: true }));
    return { spaces: (listing.spaces || []).filter(item => !binding.objectiveId || (item.objectiveId || item.id) === binding.objectiveId), errors: (listing.errors || []).filter(item => !binding.objectiveId || item.objectiveId === binding.objectiveId) };
  }
  async function load(objectiveId) {
    const listing = await directory({ objectiveId });
    const space = listing.spaces.find(item => (item.objectiveId || item.id) === objectiveId);
    if (!space) fault('NOT_FOUND', '空间不存在或索引不可用。');
    if (!space.migrated) return { space, value: null, revision: 0, workflows: [], workflowRevision: 0 };
    const stored = dataOf(await domain.execute('runtime.load', { key: 'bot' }, { trusted: true, objectiveId, sourceScope: 'bot' }));
    const workflows = dataOf(await domain.execute('host.state.get', { namespace: 'trace', key: 'workflows' }, { trusted: true, objectiveId }));
    return { space, value: stored.value || null, revision: stored.revision || 0, workflows: workflows.value?.sessions || [], workflowRevision: workflows.revision || 0 };
  }
  async function groupState() {
    // group.state.get opens its database. Check existence before calling it.
    try {
      const groupPath = path.join(baseDir, 'groups', 'general', 'group.sqlite');
      const [root, file] = await Promise.all([fs.realpath(baseDir), fs.realpath(groupPath)]);
      if (!file.startsWith(`${root}${path.sep}`) || !(await fs.stat(file)).isFile()) return null;
    } catch { return null; }
    const stored = dataOf(await domain.execute('group.state.get', { key: 'conversation' }, { trusted: true, groupId: 'general' }));
    return stored.value ? { ...stored.value, __revision: stored.revision || 0 } : null;
  }
  async function visibleTasks(value, input, binding, objectiveId) {
    const ownScope = scope(binding, objectiveId);
    let tasks = Object.values(value?.tasks || {}).filter(task => ownScope === null || traceScope(task.sourceScope) === ownScope);
    if (input.groupMessageId) {
      if (binding.traceMode !== 'group') fault('FORBIDDEN', '群消息筛选仅用于群轨迹。');
      const group = await groupState();
      const parts = (group?.parts || []).filter(part => part.messageId === input.groupMessageId && part.objectiveId === objectiveId);
      tasks = tasks.filter(task => parts.some(part => part.taskIds?.includes(task.id) || task.inputRefs?.includes(`message:${part.botMessageId}`)));
    }
    return tasks;
  }
  function streamFor(segment, owner, objectiveId, binding, historical) {
    const role = owner.id ? 'child' : 'main';
    const registered = Boolean(segment.created ?? (historical ? true : owner.created));
    const descriptor = { version: 1, objectiveId, sessionId: segment.sessionId, taskId: owner.id || null, role, mode: binding.traceMode, sourceScope: scope(binding, objectiveId) };
    return { streamRef: sign({ kind: 'stream', ...descriptor }), sessionId: segment.sessionId, role, taskId: owner.id || null, generation: segment.contextGeneration ?? segment.generation ?? null, historical, registered, allowNative: registered && (role === 'child' || binding.traceMode === 'diagnostic'), sourceScope: owner.id ? traceScope(owner.sourceScope) : scope(binding, objectiveId), reason: segment.reason || null, previousSessionId: segment.previousSessionId || null, startedAt: segment.startedAt || null, endedAt: historical ? segment.endedAt || segment.at || null : null, coverage: historical && !segment.contextGeneration ? 'historical_partial' : 'registered' };
  }
  const streamsFor = (owner, objectiveId, binding) => [...(owner?.segments || []).map(segment => streamFor(segment, owner, objectiveId, binding, true)), ...(owner?.sessionId ? [streamFor(owner, owner, objectiveId, binding, false)] : [])];
  function workflowStream(session, objectiveId, binding) {
    return { streamRef: sign({ kind: 'workflow-stream', version: 1, objectiveId, sessionId: session.sessionId, taskId: session.taskId || null, mode: binding.traceMode, sourceScope: scope(binding, objectiveId) }), sessionId: session.sessionId, role: 'workflow', taskId: session.taskId || null, purpose: session.purpose, workflowId: session.workflowId || null, historical: session.status !== 'running', registered: true, allowNative: true, generation: null, sourceScope: session.sourceScope, startedAt: session.startedAt || null, endedAt: session.endedAt || null, status: session.status || 'registered' };
  }
  function botSummary(snapshot, binding, tasks) {
    const id = snapshot.space.objectiveId || snapshot.space.id;
    const lastActivity = tasks.map(task => task.updatedAt).filter(Boolean).sort().at(-1) || null;
    return { id: `bot:${id}`, botId: `bot:${id}`, objectiveId: id, title: snapshot.space.title || id, taskCount: tasks.length, lastActivity, available: Boolean(snapshot.value || snapshot.workflows?.length), migrated: Boolean(snapshot.space.migrated), coverage: coverageOf(snapshot.value) };
  }
  function eventView(event) { const { key: _key, ...safe } = event; return clone(safe); }
  function hostEvents(value, tasks, input, binding, objectiveId) {
    const taskIds = new Set(tasks.map(task => task.id));
    const ownScope = scope(binding, objectiveId);
    const messageIds = new Set(tasks.flatMap(task => task.inputRefs || []).filter(ref => ref.startsWith('message:')).map(ref => ref.slice(8)));
    return (value?.traceLedger?.events || []).filter(event => (ownScope === null || traceScope(event.sourceScope) === ownScope) && (!input.taskId || event.taskId === input.taskId || (!event.taskId && messageIds.has(event.messageId))) && (!event.taskId || taskIds.has(event.taskId))).map(eventView);
  }
  function page(items, input, key, style = 'offset') {
    const limit = Math.max(1, Math.min(Number.isSafeInteger(input.limit) ? input.limit : 100, 200));
    let after = 0;
    if (input.cursor) { const decoded = decode(input.cursor); if (decoded.kind !== 'cursor' || decoded.scope !== key || decoded.style !== style) fault('INVALID_CURSOR', '游标不属于当前查看范围。'); after = decoded.after; }
    const remaining = style === 'seq' ? items.filter(item => item.seq > after) : items.slice(after);
    const selected = remaining.slice(0, limit);
    const next = style === 'seq' ? selected.at(-1)?.seq || after : after + selected.length;
    return { items: selected, cursor: sign({ kind: 'cursor', scope: key, style, after: next }), hasMore: remaining.length > selected.length, after };
  }
  async function bundle(input, binding) {
    const objectiveId = objective(input, binding);
    const snapshot = await load(objectiveId);
    const tasks = await visibleTasks(snapshot.value, input, binding, objectiveId);
    const task = input.taskId ? tasks.find(item => item.id === input.taskId) : null;
    if (input.taskId && !task) fault('NOT_FOUND', '当前来源没有该任务。');
    const chosen = task ? [task] : tasks;
    const mainStreams = streamsFor(snapshot.value?.main, objectiveId, binding);
    const workflowStreams = snapshot.workflows.filter(session => (scope(binding, objectiveId) === null || traceScope(session.sourceScope) === scope(binding, objectiveId)) && (!input.taskId || session.taskId === input.taskId) && (!input.groupMessageId || session.groupMessageId === input.groupMessageId)).map(session => workflowStream(session, objectiveId, binding));
    const segments = [...mainStreams, ...chosen.flatMap(item => streamsFor(item, objectiveId, binding)), ...workflowStreams];
    return { ...snapshot, objectiveId, tasks, task, chosen, segments, mainStreams, workflowStreams, bot: botSummary(snapshot, binding, tasks), coverage: { ...coverageOf(snapshot.value), workflowSessions: 'registered_only' } };
  }
  async function groupBundle(input, binding) {
    if (binding.traceMode !== 'group') fault('FORBIDDEN', '群协调轨迹只从综合群入口读取。');
    if (binding.objectiveId) fault('FORBIDDEN', '成员空间的固定范围不能扩大为整个群协调历史。');
    const value = await groupState();
    const messageIds = input.groupMessageId ? new Set([input.groupMessageId]) : null;
    const parts = (value?.parts || []).filter(part => !messageIds || messageIds.has(part.messageId));
    const partIds = new Set(parts.map(part => part.id));
    const messages = (value?.messages || []).filter(message => !messageIds || messageIds.has(message.id) || messageIds.has(message.replyTo) || partIds.has(message.partId));
    const segments = (value?.workflowSessions || []).filter(session => !messageIds || messageIds.has(session.messageId)).map(session => {
      const descriptor = { kind: 'group-stream', version: 1, sessionId: session.sessionId, mode: 'group', sourceScope: 'group:general', messageId: session.messageId, groupMessageId: input.groupMessageId || null };
      return { streamRef: sign(descriptor), sessionId: session.sessionId, role: 'workflow', purpose: session.purpose, taskId: null, generation: null, historical: true, registered: true, allowNative: true, sourceScope: 'group:general', groupMessageId: session.messageId, startedAt: session.startedAt || null, endedAt: null };
    });
    const events = (value?.traceLedger?.events || []).filter(event => !messageIds || messageIds.has(event.groupMessageId)).map(eventView);
    return { bot: { id: 'group:general', botId: 'group:general', objectiveId: null, title: '综合群协调与派发', kind: 'workflow', agent: false, available: Boolean(value), taskCount: parts.length, lastActivity: messages.at(-1)?.at || null }, task: null, main: null, segments, group: { groupId: 'general', sourceScope: 'group:general', messages: clone(messages), parts: clone(parts), publications: clone(messages.filter(message => message.role === 'member')) }, deliveries: [], attempts: [], publications: clone(messages.filter(message => message.role === 'member')), operations: [], events, revision: value?.__revision || 0, coverage: { ...coverageOf(value), coordinator: 'workflow_only', workflowSessions: segments.length ? 'registered_only' : 'historical_unrecorded' } };
  }
  async function execute(command, input = {}, binding = {}) {
    try {
      authorize(binding);
      if (binding.groupMessageId && input.groupMessageId && binding.groupMessageId !== input.groupMessageId) fault('FORBIDDEN', '群消息不属于当前固定查看范围。');
      input = { ...input, ...(binding.groupMessageId ? { groupMessageId: binding.groupMessageId } : {}) };
      if (Object.keys(input).some(key => /path|file/i.test(key))) fault('FORBIDDEN', '轨迹接口不接受文件路径。');
      if (command === 'trace.capabilities') return { kind: 'read', data: { contract: 'okrTrace/v1', version: 1, available: true, mode: binding.traceMode, commands: ['trace.capabilities', 'trace.bots.list', 'trace.tasks.list', 'trace.task.get', 'trace.session.resolve', 'trace.stream.authorize', 'trace.events.list', 'trace.event.get'], pollingMs: 1500, nativeReader: 'sessionQuery', nativeMain: binding.traceMode === 'diagnostic' && Boolean(binding.objectiveId), usage: 'unknown', historicalCoverage: 'partial', readonly: true } };
      if (command === 'trace.bots.list') {
        const listing = await directory(binding);
        const bots = [];
        for (const space of listing.spaces) {
          const objectiveId = space.objectiveId || space.id;
          // A directory without a selected private/diagnostic space returns metadata only.
          if (!binding.objectiveId && binding.traceMode !== 'group') { bots.push({ id: `bot:${objectiveId}`, botId: `bot:${objectiveId}`, objectiveId, title: space.title || objectiveId, taskCount: null, lastActivity: null, available: null, migrated: Boolean(space.migrated), coverage: { hostEvents: 'not_loaded', usage: 'unknown' } }); continue; }
          const snapshot = await load(objectiveId);
          bots.push(botSummary(snapshot, binding, await visibleTasks(snapshot.value, input, binding, objectiveId)));
        }
        if (binding.traceMode === 'group' && !binding.objectiveId) { const group = await groupBundle(input, binding); if (group.bot.available) bots.push(group.bot); }
        bots.sort((a, b) => String(a.objectiveId || a.id).localeCompare(String(b.objectiveId || b.id)));
        const result = page(bots, input, `bots:${filterKey(input, binding, binding.objectiveId || null)}`);
        return { kind: 'read', data: { bots: result.items, cursor: result.cursor, hasMore: result.hasMore, errors: listing.errors, coverage: { directory: true, usage: 'unknown' } } };
      }
      if (command === 'trace.session.resolve') {
        if (typeof input.sessionId !== 'string' || !input.sessionId) fault('INVALID_INPUT', '缺少宿主会话标识。');
        if (binding.traceMode === 'group' && !binding.objectiveId) {
          const group = await groupBundle(input, binding);
          const stream = group.segments.find(item => item.sessionId === input.sessionId);
          if (stream) return { kind: 'read', data: { registered: true, bot: group.bot, task: null, stream, coverage: group.coverage } };
        }
        const listing = await directory(binding);
        for (const space of listing.spaces) {
          const objectiveId = space.objectiveId || space.id;
          // Resolving an ID is a lookup, not an authorization upgrade.
          if (!binding.objectiveId && binding.traceMode !== 'group') {
            const snapshot = await load(objectiveId);
            const mainStreams = streamsFor(snapshot.value?.main, objectiveId, { ...binding, objectiveId });
            const task = Object.values(snapshot.value?.tasks || {}).find(item => streamsFor(item, objectiveId, { ...binding, objectiveId }).some(stream => stream.sessionId === input.sessionId && stream.registered));
            const taskStream = task ? streamsFor(task, objectiveId, { ...binding, objectiveId }).find(stream => stream.sessionId === input.sessionId) : null;
            const workflow = snapshot.workflows.find(item => item.sessionId === input.sessionId);
            const found = taskStream || mainStreams.find(stream => stream.sessionId === input.sessionId && stream.registered) || (workflow ? workflowStream(workflow, objectiveId, { ...binding, objectiveId }) : null);
            if (!found) continue;
            const summary = task ? taskSummary(task) : null;
            return { kind: 'read', data: { registered: true, bot: { id: `bot:${objectiveId}`, botId: `bot:${objectiveId}`, objectiveId, title: space.title || objectiveId }, task: summary ? { id: summary.id, taskId: summary.id, sourceScope: summary.sourceScope, groupMessageId: summary.groupMessageId } : null, stream: { ...found, streamRef: null, allowNative: false, sourceScope: task ? traceScope(task.sourceScope) : workflow?.sourceScope || privateScope(objectiveId) }, coverage: coverageOf(snapshot.value) } };
          }
          const localBinding = binding.objectiveId ? binding : { ...binding, objectiveId };
          const current = await bundle({ objectiveId, groupMessageId: input.groupMessageId }, localBinding);
          const stream = current.segments.find(item => item.sessionId === input.sessionId && item.registered);
          if (!stream) continue;
          if (!binding.objectiveId && binding.traceMode !== 'group') stream.allowNative = false;
          return { kind: 'read', data: { registered: true, bot: current.bot, task: stream.taskId ? taskSummary(current.tasks.find(item => item.id === stream.taskId)) : null, stream, coverage: current.coverage } };
        }
        return { kind: 'read', data: { registered: false, reason: 'unregistered_or_out_of_scope' } };
      }
      if (command === 'trace.stream.authorize') {
        const ref = decode(input.streamRef);
        if (ref.kind === 'group-stream') {
          if (binding.traceMode !== 'group' || binding.objectiveId || (input.groupMessageId && input.groupMessageId !== ref.messageId)) fault('FORBIDDEN', '群模型会话不属于当前范围。');
          const current = await groupBundle({ groupMessageId: ref.groupMessageId }, binding);
          const stream = current.segments.find(item => item.streamRef === input.streamRef);
          if (!stream) fault('NOT_FOUND', '协调会话尚未登记或已不在索引中。');
          return { kind: 'read', data: { stream } };
        }
        const objectiveId = objective({ objectiveId: ref.objectiveId }, binding);
        if (!['stream', 'workflow-stream'].includes(ref.kind) || ref.mode !== binding.traceMode || ref.sourceScope !== scope(binding, objectiveId)) fault('FORBIDDEN', '会话引用不属于当前来源。');
        const current = await bundle({ objectiveId, taskId: ref.taskId, groupMessageId: input.groupMessageId }, binding);
        const stream = current.segments.find(item => item.streamRef === input.streamRef);
        if (!stream) fault('NOT_FOUND', '会话段已不在当前授权索引中。');
        return { kind: 'read', data: { stream } };
      }
      if (input.botId === 'group:general' || (binding.traceMode === 'group' && !binding.objectiveId && !input.botId && !input.objectiveId)) {
        const current = await groupBundle(input, binding);
        if (command === 'trace.task.get') return { kind: 'read', data: current };
        if (command === 'trace.tasks.list') return { kind: 'read', data: { bot: current.bot, tasks: [], main: null, segments: current.segments, cursor: null, revision: current.revision, coverage: current.coverage } };
        if (command === 'trace.events.list') { const result = page(current.events, input, `group:${filterKey(input, binding, null)}`, 'seq'); return { kind: 'read', data: { events: result.items, cursor: result.cursor, hasMore: result.hasMore, streams: current.segments, revision: current.revision, coverage: current.coverage } }; }
        if (command === 'trace.event.get') {
          const event = current.events.find(item => item.id === input.eventId); if (!event) fault('NOT_FOUND', '群范围中没有该事件。');
          const part = current.group.parts.find(item => item.id === event.partId);
          const message = current.group.messages.find(item => item.id === event.groupMessageId);
          const publication = current.group.publications.find(item => item.id === event.publicationId);
          if (part) event.input = { sourceRef: part.sourceRef, messageId: part.messageId, text: part.text, start: part.start, end: part.end };
          else if (message && event.type === 'group.message.accepted') event.input = { messageId: message.id, text: message.text };
          if (publication) event.output = { publicationId: publication.id, answerId: publication.botAnswerId, text: publication.text, operationRefs: publication.operationRefs || [] };
          return { kind: 'read', data: { event, coverage: current.coverage } };
        }
      }
      const current = await bundle(input, binding);
      const events = hostEvents(current.value, current.chosen, input, binding, current.objectiveId);
      if (command === 'trace.tasks.list') {
        const tasks = current.tasks.filter(task => !input.phase || task.phase === input.phase).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(task => ({ ...taskSummary(task), segments: streamsFor(task, current.objectiveId, binding) }));
        const result = page(tasks, input, `tasks:${filterKey(input, binding, current.objectiveId)}`);
        return { kind: 'read', data: { bot: current.bot, tasks: result.items, main: { role: 'main', segments: current.mainStreams, streamRef: current.mainStreams.at(-1)?.streamRef || null, allowNative: binding.traceMode === 'diagnostic' }, workflows: current.workflowStreams, cursor: result.cursor, hasMore: result.hasMore, revision: current.revision, workflowRevision: current.workflowRevision, coverage: current.coverage } };
      }
      if (command === 'trace.task.get') {
        if (!current.task) {
          const allowed = new Set(current.tasks.map(task => task.id));
          return { kind: 'read', data: { bot: current.bot, task: null, main: { role: 'main', streamRef: current.mainStreams.at(-1)?.streamRef || null, segments: current.mainStreams, allowNative: binding.traceMode === 'diagnostic', projection: binding.traceMode !== 'diagnostic' }, segments: current.segments, deliveries: (current.value?.outbox || []).filter(item => item.taskId ? allowed.has(item.taskId) : scope(binding, current.objectiveId) === null || traceScope(current.value?.inbox.find(message => message.id === item.messageId)?.sourceScope) === scope(binding, current.objectiveId)).map(item => ({ id: item.id, taskId: item.taskId, target: item.target, messageId: item.messageId, state: item.state, attempts: item.attempts, attemptId: item.attemptId || null, error: clone(item.error) })), attempts: (current.value?.traceLedger?.attempts || []).filter(item => scope(binding, current.objectiveId) === null || traceScope(item.sourceScope) === scope(binding, current.objectiveId)).map(clone), publications: [], operations: [], events, revision: current.revision, coverage: current.coverage } };
        }
        const task = current.task;
        const deliveries = (current.value.outbox || []).filter(item => item.taskId === task.id || (item.target === 'main' && task.inputRefs?.includes(`message:${item.messageId}`))).map(item => ({ id: item.id, target: item.target, messageId: item.messageId, taskId: item.taskId, state: item.state, attempts: item.attempts, attemptId: item.attemptId || null, createdAt: item.createdAt, error: clone(item.error), leaseExpiresAt: item.lease?.expiresAt || null }));
        const deliveryIds = new Set(deliveries.map(item => item.id));
        const attempts = (current.value.traceLedger?.attempts || []).filter(item => deliveryIds.has(item.deliveryId)).map(clone);
        const inputs = (task.inputRefs || []).filter(ref => ref.startsWith('message:')).map(ref => current.value.inbox.find(message => message.id === ref.slice(8) && traceScope(message.sourceScope) === traceScope(task.sourceScope))).filter(Boolean).map(message => ({ id: message.id, text: message.text, at: message.receivedAt, replyTo: message.replyTo, sourceScope: traceScope(message.sourceScope) }));
        const publications = (current.value.publications || []).filter(item => item.taskId === task.id && traceScope(item.sourceScope) === traceScope(task.sourceScope)).map(item => ({ ...clone(item), text: current.value.answers[item.answerId]?.text || '', operationRefs: item.operationRefs ? clone(item.operationRefs) : null, operationCoverage: item.operationRefs ? 'recorded' : 'historical_unrecorded' }));
        const operations = (task.operationReceipts || []).map(item => ({ operationId: item.operationId, kind: item.kind, durable: !['read', 'disabled', 'error', 'rejected'].includes(item.kind), error: clone(item.error) }));
        return { kind: 'read', data: { bot: current.bot, task: { ...taskSummary(task), inputs, inputRefs: clone(task.inputRefs), handoff: clone(task.handoff), completion: clone(task.completion) }, main: { role: 'main', streamRef: current.mainStreams.at(-1)?.streamRef || null, segments: current.mainStreams, allowNative: binding.traceMode === 'diagnostic', projection: binding.traceMode !== 'diagnostic' }, segments: current.segments, deliveries, attempts, publications, operations, events, revision: current.revision, coverage: current.coverage } };
      }
      if (command === 'trace.events.list') {
        const result = page(events, input, `events:${filterKey(input, binding, current.objectiveId)}`, 'seq');
        return { kind: 'read', data: { events: result.items, cursor: result.cursor, hasMore: result.hasMore, streams: current.segments, revision: current.revision, coverage: { ...current.coverage, cursorGap: Boolean(result.after && current.value?.traceLedger?.events[0]?.seq > result.after + 1) } } };
      }
      if (command === 'trace.event.get') {
        const event = events.find(item => item.id === input.eventId);
        if (!event) fault('NOT_FOUND', '当前任务和来源没有该事件。');
        let operation = null;
        if (event.operationId) {
          const task = current.chosen.find(item => item.id === event.taskId);
          operation = task?.operationReceipts?.find(item => item.operationId === event.operationId) || null;
          if (!operation) fault('NOT_FOUND', '此事件没有本任务可验证的业务回执。');
        }
        if (event.messageId && ['message.accepted', 'task.created', 'task.continued'].includes(event.type)) {
          const message = current.value?.inbox.find(item => item.id === event.messageId && (scope(binding, current.objectiveId) === null || traceScope(item.sourceScope) === scope(binding, current.objectiveId)));
          if (message) event.input = { messageId: message.id, text: message.text, replyTo: message.replyTo || null };
        }
        if (event.publicationId && event.type === 'answer.published') {
          const publication = current.value?.publications.find(item => item.id === event.publicationId && item.taskId === event.taskId && (scope(binding, current.objectiveId) === null || traceScope(item.sourceScope) === scope(binding, current.objectiveId)));
          if (publication) event.output = { publicationId: publication.id, answerId: publication.answerId, text: current.value.answers[publication.answerId]?.text || '', operationRefs: clone(publication.operationRefs || []) };
        }
        return { kind: 'read', data: { event, operation: clone(operation), coverage: current.coverage } };
      }
      fault('UNKNOWN_COMMAND', '不支持此轨迹查询。');
    } catch (error) { return { kind: 'rejected', data: null, error: { code: error.code || 'TRACE_ERROR', message: error.message } }; }
  }
  async function registerWorkflow(ref, binding = {}) {
    if (closed || binding.trusted !== true || !validId(binding.objectiveId) || !ref?.sessionId || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(ref.sessionId) || typeof ref.purpose !== 'string' || !ref.purpose.trim()) return { kind: 'rejected', error: { code: 'FORBIDDEN', message: '工作流登记需要 Host 固定的空间和已创建会话引用。' } };
    const objectiveId = binding.objectiveId;
    const previous = registrations.get(objectiveId) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const sourceScope = traceScope(binding.sourceScope || privateScope(objectiveId));
      if (binding.taskId) {
        const bot = dataOf(await domain.execute('runtime.load', { key: 'bot' }, { trusted: true, objectiveId, sourceScope: 'bot' }));
        const task = bot.value?.tasks?.[binding.taskId];
        if (!task || traceScope(task.sourceScope) !== sourceScope) fault('FORBIDDEN', '工作流不属于当前任务和来源。');
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const stored = dataOf(await domain.execute('host.state.get', { namespace: 'trace', key: 'workflows' }, { trusted: true, objectiveId }));
        const value = clone(stored.value) || { version: 1, sessions: [], dropped: 0 };
        let current = value.sessions.find(item => item.sessionId === ref.sessionId);
        if (current && (current.sourceScope !== sourceScope || current.taskId !== (binding.taskId || null) || current.purpose !== ref.purpose)) fault('FORBIDDEN', '已登记会话的来源和归属不可改变。');
        const status = ['running', 'completed', 'failed'].includes(ref.status) ? ref.status : 'registered';
        if (current && (!ref.status || current.status === status) && (!ref.workflowId || current.workflowId === ref.workflowId)) return { kind: 'read', data: { sessionId: current.sessionId, revision: stored.revision, registered: true, duplicate: true } };
        if (!current) { current = { sessionId: ref.sessionId, purpose: bounded(ref.purpose, 100), sourceScope, taskId: binding.taskId || null, groupMessageId: binding.groupMessageId || null, startedAt: ref.startedAt || null, registeredAt: new Date(clock()).toISOString(), workflowId: ref.workflowId || null, status }; value.sessions.push(current); }
        else { current.status = status; if (ref.workflowId) current.workflowId = bounded(ref.workflowId); }
        if (['completed', 'failed'].includes(current.status)) current.endedAt ||= new Date(clock()).toISOString();
        if (value.sessions.length > 64) value.dropped += value.sessions.splice(0, value.sessions.length - 64).length;
        const result = await domain.execute('host.state.set', { namespace: 'trace', key: 'workflows', value, expectedRevision: stored.revision || 0 }, { trusted: true, objectiveId });
        if (result.kind === 'saved') return { kind: 'saved', data: { sessionId: current.sessionId, revision: result.data.revision, registered: true } };
        if (result.kind !== 'conflict') fault(result.error?.code || 'TRACE_ERROR', result.error?.message || '工作流登记失败。');
      }
      fault('CONFLICT', '工作流索引更新冲突。');
    });
    registrations.set(objectiveId, work);
    try { return await work; } catch (error) { return { kind: 'rejected', error: { code: error.code || 'TRACE_ERROR', message: error.message } }; }
    finally { if (registrations.get(objectiveId) === work) registrations.delete(objectiveId); }
  }
  return { execute, registerWorkflow, close() { closed = true; } };
}
