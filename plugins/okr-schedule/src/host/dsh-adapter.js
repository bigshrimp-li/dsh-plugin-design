import { randomUUID } from 'node:crypto';

const clone = value => value === undefined ? null : structuredClone(value);
const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');

/** A narrow DSH adapter. Every live scope starts with no global tools. */
export function createDshAdapter({ ctx, agentOptions = {}, timeoutMs = 60_000, maxTurns = 8 } = {}) {
  const sessions = new Map();
  const opening = new Map();
  const settlementBySession = new Map();
  let closed = false;
  const hasFactorySurface = Boolean(ctx?.agents?.create && ctx?.agents?.resume);
  function selection() {
    let defaults;
    try {
      const owner = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : ctx?.agentDefaultModel;
      defaults = owner?.currentSelection?.();
    } catch {
      defaults = null;
    }
    const merged = {};
    for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
      if (defaults?.[key] !== undefined) merged[key] = defaults[key];
      if (agentOptions?.[key] !== undefined) merged[key] = agentOptions[key];
    }
    return merged;
  }
  function capability() {
    if (closed) return { available: false, reason: 'Adapter 已关闭。' };
    if (!hasFactorySurface) return { available: false, reason: '当前宿主未提供受控 DSH Agent create/resume 能力。' };
    const route = selection();
    if (typeof route.provider !== 'string' || !route.provider.trim() || typeof route.model !== 'string' || !route.model.trim()) return { available: false, reason: '当前宿主未提供默认模型；请配置 provider 和 model。' };
    return { available: true, reason: null, route };
  }

  async function constructSession({ sessionId, resume = false, parentSessionId, binding, system, tools = [], onEvent = async () => {} }) {
    const ready = capability();
    if (!ready.available) throw Object.assign(new Error(ready.reason), { code: 'BOT_DISABLED' });
    if (!sessionId || !binding || typeof system !== 'string') throw new Error('Agent 需要固定 sessionId、可信 binding 和 system。');
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const names = new Set(tools.map(tool => tool.name));
    if (names.size !== tools.length || [...names].some(name => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name))) throw new Error('工具名必须唯一，且仅包含字母、数字和下划线。');
    const fixedBinding = Object.freeze(clone(binding));
    const answers = [];
    const accepted = new Set();
    const settlement = settlementBySession.get(sessionId) || { currentTurn: null, messages: new Map(), calls: new Set() };
    settlementBySession.set(sessionId, settlement);
    const recordEvent = event => {
      const data = event.data || {};
      if (event.type === 'turn/start') settlement.currentTurn = data.turn;
      if (event.type === 'user/message') {
        accepted.add(data.id);
        settlement.messages.set(data.id, { turn: settlement.currentTurn, outcome: 'running' });
      }
      if (event.type === 'tool/call' || event.type === 'tool/request') settlement.calls.add(data.callId);
      if (event.type === 'tool/result') settlement.calls.delete(data.callId || data.message?.source?.callId);
      if (event.type === 'turn/end') for (const [id, state] of settlement.messages) if (state.turn === data.turn) settlement.messages.set(id, { turn: data.turn, outcome: data.reason?.kind || 'unknown' });
    };
    const pending = new Set();
    let active = true;
    let releasing;
    let failure;
    let steps = 0;
    let activeDelivery = null;
    const emit = event => {
      const work = Promise.resolve().then(() => onEvent(clone(event)));
      pending.add(work);
      work.catch(error => { failure = error; }).finally(() => pending.delete(work));
    };
    const flush = async () => { while (pending.size) await Promise.all([...pending]); };
    const setup = (agentCtx, agent) => {
      if (!agentCtx?.tools?.restrict || !agentCtx?.tools?.guard || !agentCtx?.tools?.register || !agentCtx?.tools?.presentAs || !agentCtx?.systemPrompt?.section || !agentCtx?.on) {
        throw Object.assign(new Error('宿主缺少 scoped tools、guard 或完整提示词隔离，Bot 已禁用。'), { code: 'BOT_DISABLED' });
      }
      agentCtx.tools.restrict({ allow: [] });
      agentCtx.tools.presentAs('native');
      agentCtx.systemPrompt.section({ name: 'okr-bot-controlled', order: -10_000, text: system, interpolate: false, complete: true });
      agentCtx.tools.guard(exec => {
        if (!active || closed) return 'Agent 调用绑定已失效。';
        if (exec.agent !== agent || !names.has(exec.name)) return '本 Agent 无权执行该工具。';
        return undefined;
      });
      for (const tool of tools) {
        agentCtx.tools.register({
          name: tool.name, description: tool.description, parameters: tool.parameters || { type: 'object', additionalProperties: true },
          output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (args, exec) => {
            await flush();
            if (!active || closed || exec.signal?.aborted) throw new Error('Agent 调用已取消或绑定已失效。');
            return clone(await tool.execute(clone(args), fixedBinding, { signal: exec.signal, sessionId, callId: exec.callId }));
          },
        });
      }
      agentCtx.on('agent/pre-step', async (_event, next) => {
        if (!active || closed || ++steps > maxTurns * 8) return { kind: 'reject' };
        return next();
      });
      agentCtx.on('session/event', (session, event) => {
        if (session.id !== sessionId) return;
        recordEvent(event);
        if (event.type === 'user/message') accepted.add(event.data.id);
        if (event.type === 'agent/inbox/spliced') {
          for (const message of event.data.inserted || []) accepted.add(message.id);
        }
        if (event.type === 'assistant/message') {
          const answer = { id: event.data.message.id, sessionId, seq: event.seq, text: textOf(event.data.message), interrupted: Boolean(event.data.interrupted), usage: event.data.usage || null };
          answers.push(answer);
          emit({ type: 'answer', ...answer, ...clone(activeDelivery || {}) });
        }
        // Forward committed identities and safe metadata only. Native bodies remain
        // in sessionQuery; headers, credentials and model reasoning are not mirrored.
        if (event.type !== 'assistant/message' && (event.type === 'user/message' || /^(?:turn|step|tool|request|context)\//u.test(event.type))) {
          const data = event.data || {};
          emit({ type: event.type === 'user/message' ? 'input.accepted' : event.type, sessionId, seq: event.seq, at: new Date(event.time || Date.now()).toISOString(), ...clone(activeDelivery || {}), data: { callId: data.callId || data.message?.source?.callId, name: data.name || data.toolName, turn: data.turn, reason: data.reason ? { kind: data.reason.kind } : undefined, outcome: data.outcome, code: data.error?.code } });
        }
      });
      agentCtx.on('agent/inbox/claimed', event => {
        accepted.add(event.message.id);
        settlement.messages.set(event.message.id, { turn: event.turn, outcome: 'running' });
      });
      agentCtx.on('agent/error', event => { failure = event.error instanceof Error ? event.error : new Error(String(event.error)); emit({ type: 'agent/error', sessionId, ...clone(activeDelivery || {}), data: { code: event.error?.code || 'AGENT_ERROR' } }); });
      return { commit() { if (!active || closed) throw new Error('Agent setup 期间调用绑定已失效。'); } };
    };
    const parentAgent = parentSessionId ? ctx.agents.get?.(parentSessionId) : undefined;
    if (parentSessionId && !parentAgent) throw new Error('任务主 Agent 尚未恢复。');
    const options = { agentOptions: ready.route, setup, ...(parentAgent ? { parentAgent } : {}) };
    let handle;
    if (resume) handle = await ctx.agents.resume({ ...options, resumeSessionId: sessionId });
    else {
      try { handle = await ctx.agents.create({ ...options, sessionId, ...(parentAgent ? { meta: { origin: 'subagent', delegationDepth: 1 } } : {}) }); }
      catch (error) {
        // The Host persisted this exact randomly assigned intent identity before
        // create. A prior crash may have stored the session before its mapping
        // acknowledgement; reconcile that identity, never spawn a second one.
        if (error.name !== 'SessionAlreadyExistsError' && error.code !== 'SESSION_ALREADY_EXISTS') throw error;
        handle = await ctx.agents.resume({ ...options, agentOptions: selection(), resumeSessionId: sessionId });
      }
    }
    const agent = handle.agent;
    const refreshSettlement = async () => {
      const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : ctx?.sessionQuery;
      if (!query?.observeSession) return;
      let observation;
      try {
        observation = await query.observeSession(sessionId);
        settlement.currentTurn = null; settlement.messages.clear(); settlement.calls.clear();
        for (const event of observation.events || []) recordEvent(event);
      } finally {
        if (observation?.[Symbol.dispose]) observation[Symbol.dispose]();
        else if (observation?.[Symbol.asyncDispose]) await observation[Symbol.asyncDispose]();
      }
    };
    // The public derived surface, rather than deprecated synchronous raw-log reads,
    // supplies identities already accepted before a process restart.
    for (const message of agent.session?.deriveMessages?.() || []) {
      if (message.role === 'user') accepted.add(message.id);
      if (message.role === 'assistant' && !answers.some(answer => answer.id === message.id)) {
        answers.push({ id: message.id, sessionId, text: textOf(message), interrupted: false, usage: null });
      }
    }
    const api = {
      sessionId,
      get active() { return active; },
      async deliver({ id, payload, attemptId, recoveryAttempt = 0, forceContinue = false }) {
        if (!active || closed) throw new Error('Agent 已释放。');
        let deliveryId = id;
        let deliveryPayload = payload;
        if (accepted.has(id)) {
          await refreshSettlement();
          const known = settlement.messages.get(id);
          if (known?.outcome === 'completed' && !settlement.calls.size && !forceContinue) return { accepted: true, duplicate: true, settled: true, outcome: 'completed', answers: clone(answers) };
          if (!recoveryAttempt) throw Object.assign(new Error('原输入已接纳，但执行尚未完成；请恢复原工作。'), { code: 'DELIVERY_NOT_SETTLED' });
          if (settlement.calls.size || agent.status === 'running') throw Object.assign(new Error('原会话仍有运行中或未结算的工具，暂不能恢复。'), { code: 'DELIVERY_STILL_RUNNING' });
          if (!known?.outcome || known.outcome === 'running') throw Object.assign(new Error('无法核对原输入的结算记录；未重放操作，请检查宿主会话查询能力。'), { code: 'DELIVERY_STATE_UNKNOWN' });
          deliveryId = `${id}:recovery:${recoveryAttempt}`;
          if (accepted.has(deliveryId)) {
            const resumed = settlement.messages.get(deliveryId);
            if (resumed?.outcome === 'completed') return { accepted: true, duplicate: true, settled: true, outcome: 'completed', recoveryId: deliveryId, answers: clone(answers) };
            throw Object.assign(new Error('此恢复事件已接纳但尚未完成，请等待当前执行结算。'), { code: 'DELIVERY_NOT_SETTLED' });
          }
          deliveryPayload = { block_type: 'delivery_recovery', originalEventType: payload.block_type, messageId: payload.messageId || null, inputRefs: payload.inputRefs || (payload.input || []).map(item => item.ref), sourceScope: payload.sourceScope || payload.authorizationEvent?.sourceScope || null, task: payload.task || null, authorizationEvent: payload.authorizationEvent || null, deliveryRecovery: { originalDeliveryId: id, attempt: recoveryAttempt, previousOutcome: known?.outcome || 'unknown', instruction: '原输入已经接纳并保留在本会话。先查当前任务和真实操作回执，再通过获准引用读取原输入；只继续未完成的步骤，不重放已经保存的动作。' } };
        }
        steps = 0;
        failure = null;
        const before = answers.length;
        const message = { id: deliveryId, role: 'user', content: [{ type: 'text', text: JSON.stringify(deliveryPayload) }], source: { kind: 'user' } };
        activeDelivery = { deliveryId: id, attemptId: attemptId || null, ...(deliveryId !== id ? { recoveryId: deliveryId } : {}) };
        if (deliveryId !== id) emit({ type: 'delivery.recovery.prepared', sessionId, ...clone(activeDelivery) });
        agent.followup(message);
        const pendingMessages = [...(agent.inbox?.nextTurn || []), ...(agent.inbox?.nextStep || [])];
        if (pendingMessages.some(item => item.id === deliveryId)) accepted.add(deliveryId);
        let timer;
        try {
          await Promise.race([
            agent.whenIdle(),
            new Promise((_, reject) => { timer = setTimeout(() => { agent.cancel({ kind: 'user' }, { keepInbox: true }); reject(Object.assign(new Error('Bot 模型调用超时，可恢复原会话。'), { code: 'BOT_TIMEOUT' })); }, timeoutMs); timer.unref?.(); }),
          ]);
          await flush();
          if (failure) { const error = failure; failure = null; throw error; }
          const outcome = settlement.messages.get(deliveryId)?.outcome;
          if (outcome !== 'completed') throw Object.assign(new Error('Bot 本轮未完成，原工作保留，可在执行结算后恢复。'), { code: 'DELIVERY_NOT_SETTLED' });
          return { accepted: accepted.has(deliveryId), duplicate: false, settled: true, outcome, ...(deliveryId !== id ? { recoveryId: deliveryId } : {}), answers: clone(answers.slice(before)) };
        } catch (error) { if (deliveryId !== id) error.recoveryId = deliveryId; throw error; }
        finally { clearTimeout(timer); activeDelivery = null; }
      },
      inspectMessage(id) {
        if (accepted.has(id)) return { state: 'accepted', outcome: settlement.messages.get(id)?.outcome || 'unknown', unsettledTools: settlement.calls.size };
        const pendingMessages = [...(agent.inbox?.nextTurn || []), ...(agent.inbox?.nextStep || [])];
        if (pendingMessages.some(item => item.id === id)) return { state: 'accepted' };
        return { state: 'not_found' };
      },
      readAnswers() { return clone(answers); },
      cancel() { agent.cancel({ kind: 'user' }, { keepInbox: true }); },
      release() {
        if (releasing) return releasing;
        if (!active) return Promise.resolve();
        active = false;
        releasing = (async () => {
          agent.cancel({ kind: 'user' }, { keepInbox: true });
          await agent.whenIdle();
          await flush();
          await handle.dispose();
          if (sessions.get(sessionId) === api) sessions.delete(sessionId);
        })();
        return releasing;
      },
    };
    sessions.set(sessionId, api);
    return api;
  }

  async function open(options) {
    if (sessions.has(options.sessionId)) {
      const existing = sessions.get(options.sessionId);
      if (existing.active) return existing;
      await existing.release();
    }
    if (opening.has(options.sessionId)) return opening.get(options.sessionId);
    const pending = constructSession(options);
    opening.set(options.sessionId, pending);
    try { return await pending; } finally { if (opening.get(options.sessionId) === pending) opening.delete(options.sessionId); }
  }

  return {
    get available() { return capability().available; },
    get disabledReason() { return capability().reason; },
    open,
    async generate({ binding, system, input, tools = [], schema, onSession }) {
      const session = await open({ sessionId: `okr-generation-${randomUUID()}`, binding, system: `${system}\n${schema ? `仅返回符合此 JSON Schema 的 JSON：${JSON.stringify(schema)}` : ''}`, tools });
      const trace = { sessionId: session.sessionId, role: 'workflow', purpose: binding?.purpose || 'generation', startedAt: new Date().toISOString() };
      try {
        if (onSession) await onSession(clone(trace));
        const result = await session.deliver({ id: randomUUID(), payload: { block_type: 'authorized_generation_input', input } });
        const text = result.answers.filter(answer => !answer.interrupted && answer.text).at(-1)?.text;
        if (!text) throw new Error('模型没有返回可交付答案。');
        if (!schema) return { text, trace };
        const clean = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
        let data;
        try { data = JSON.parse(clean); } catch { throw Object.assign(new Error('模型返回内容不是有效 JSON，未应用结果。'), { code:'MODEL_JSON_INVALID' }); }
        return { text, data, trace };
      } catch (error) { error.trace = trace; throw error;
      } finally { await session.release(); }
    },
    async close() { closed = true; await Promise.allSettled([...opening.values()]); await Promise.allSettled([...sessions.values()].map(session => session.release())); },
  };
}
