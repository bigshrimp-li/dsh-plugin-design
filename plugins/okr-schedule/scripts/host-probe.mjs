import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
const executable = process.env.DSH_ELECTRON || '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const installRoot = process.env.DSH_INSTALL_ROOT || path.resolve(path.dirname(executable), '../Resources/app.asar/dsh');

if (!process.argv.includes('--inside')) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-host-probe-'));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || os.tmpdir(), HOME: temporary, DSH_HOME: path.join(temporary, 'dsh'), OKR_PROBE_ROOT: temporary, ELECTRON_RUN_AS_NODE: '1', DSH_INSTALL_ROOT: installRoot };
  try {
    const profile = spawnSync('dsh', ['--profile', 'okr-probe', '--from-default-profile', 'headless', '--dump-config'], { env, encoding: 'utf8', timeout: 30_000 });
    if (profile.error || profile.status !== 0) throw new Error(`临时DSH profile创建失败：${profile.error?.message || profile.stderr?.trim() || profile.status}`);
    console.log('PASS isolated DSH CLI profile: okr-probe (temporary DSH_HOME; no user configuration read)');
    const child = spawnSync(executable, ['--expose-internals', self, '--inside'], { env, stdio: 'inherit', timeout: 60_000 });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exitCode = child.status || 1;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
} else {
  const require = createRequire(path.join(installRoot, 'package.json'));
  const load = async name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const [{ Context }, { default: SessionStore }, { default: AgentRegistry }, { default: SystemPrompt }, { default: ToolRuntime }, { default: ProjectionRegistry }, { LlmRuntime, LlmAdapter }, { default: AgentLoop }, persistence] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-session-projection'), load('dsh-llm'), load('dsh-agent-loop'), load('dsh-session-persistence-jsonl'),
  ]);
  const { createDshAdapter } = await import('../src/host/dsh-adapter.js');
  const { createBotService } = await import('../src/host/bot.js');
  const { createDomainService } = await import('../src/host/domain.js');
  const temporary = process.env.OKR_PROBE_ROOT;
  assert.ok(temporary?.includes('okr-host-probe-'));
  const root = new Context();
  let host;
  const lifecycle = root.plugin({ name: 'okr-isolated-real-host-probe', apply(ctx) {
    host = ctx;
    new SessionStore(ctx); new AgentRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 1 }); new ProjectionRegistry(ctx); new LlmRuntime(ctx);
    // Loader resolves volatile configuration to this documented getter shape.
    new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } });
  } });
  await lifecycle;
  const persistencePlugin = host.plugin(persistence, { root: path.join(temporary, 'sessions'), compression: 'none' });
  await persistencePlugin;
  // This transport is deliberately synthetic. It exercises the installed loop,
  // persistence, scopes and event settlement without a real account or network.
  const requests = [];
  let activeTaskStreams = 0;
  let peakTaskStreams = 0;
  class FixtureTransport extends LlmAdapter {
    async *stream(options) {
      requests.push(options);
      const latest = options.messages.at(-1);
      let payload;
      if (latest?.role === 'user') { try { payload = JSON.parse(latest.content.filter(block => block.type === 'text').map(block => block.text).join('\n')); } catch { /* non-probe context */ } }
      let call;
      if (payload?.block_type === 'inbox_event' && options.tools.some(tool => tool.name === 'task_create')) call = { name: 'task_create', arguments: { messageId: payload.messageId, inputRefs: payload.inputRefs, title: 'Synthetic runtime task', requestId: `route:${payload.messageId}` } };
      if (payload?.block_type === 'task_context' && options.tools.some(tool => tool.name === 'task_report')) call = { name: 'task_report', arguments: { taskId: payload.task.id, runId: payload.task.runId, expectedRevision: payload.task.revision, phase: 'delivered', answer: 'Synthetic end-to-end Bot delivery', requestId: `report:${payload.task.runId}`, handoff: { summary: 'Synthetic probe completed' } } };
      if (call) {
        if (call.name === 'task_report') {
          activeTaskStreams++; peakTaskStreams = Math.max(peakTaskStreams, activeTaskStreams);
          await new Promise(resolve => setTimeout(resolve, 15));
          activeTaskStreams--;
        }
        const count = payload.text === 'Synthetic parallel request' && call.name === 'task_create' ? 3 : 1;
        for (let index = 0; index < count; index++) {
          const args = count > 1 ? { ...call.arguments, requestId: `${call.arguments.requestId}:${index}`, title: `Synthetic parallel task ${index}` } : call.arguments;
          const block = { type: 'tool-call', id: `fixture-call-${requests.length}-${index}`, name: call.name, arguments: JSON.stringify(args) };
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
          yield { type: 'block-end', index, block };
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Synthetic transport in actual DSH lifecycle' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic transport in actual DSH lifecycle' } };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  host.llm.registerAdapter(['okr-probe-fixture'], new FixtureTransport());
  let globalExecuted = false;
  host.tools.register({ name: 'fixture_global', description: 'must stay hidden', parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, async execute() { globalExecuted = true; return {}; } });
  const adapter = createDshAdapter({ ctx: host, agentOptions: { provider: 'okr-probe-fixture', model: 'fixture' }, timeoutMs: 10_000 });
  const domain = createDomainService({ baseDir: path.join(temporary, 'business') });
  try {
    const options = { sessionId: 'okr-host-probe-main', binding: { trusted: true, objectiveId: 'O_probe', sourceScope: 'private:probe' }, system: 'Only the declared synthetic probe task is authorized.', tools: [{ name: 'fixture_read', description: 'synthetic scoped read', parameters: { type: 'object' }, execute: async () => ({ kind: 'read', data: { synthetic: true } }) }] };
    const first = await adapter.open(options);
    const result = await first.deliver({ id: 'probe-message', payload: { text: 'Synthetic input' } });
    assert.equal(result.accepted, true); assert.equal(result.answers.at(-1)?.text, 'Synthetic transport in actual DSH lifecycle');
    assert.deepEqual(requests[0].tools.map(tool => tool.name), ['fixture_read']);
    const agent = host.agents.get(options.sessionId);
    const denied = await agent.ctx.tools.execute({ callId: 'probe-forbidden', name: 'fixture_global', arguments: {}, agent, signal: new AbortController().signal });
    assert.equal(denied.isError, true); assert.equal(globalExecuted, false);
    const allowed = await agent.ctx.tools.execute({ callId: 'probe-allowed', name: 'fixture_read', arguments: {}, agent, signal: new AbortController().signal });
    assert.equal(allowed.isError, false);
    await first.release();
    assert.equal(host.agents.get(options.sessionId), undefined);
    const resumed = await adapter.open({ ...options, resume: true });
    const duplicate = await resumed.deliver({ id: 'probe-message', payload: { text: 'Must not repeat' } });
    assert.equal(duplicate.duplicate, true); assert.equal(requests.length, 1);
    const child = await adapter.open({ ...options, sessionId: 'okr-host-probe-child', parentSessionId: options.sessionId });
    assert.equal(host.agents.isOwnedBy(child.sessionId, host.agents.get(options.sessionId)), true);
    assert.equal(child.readAnswers().length, 0);
    await child.release(); await resumed.release();
    console.log('PASS actual installed DSH create/resume, scoped tools/guard, committed answer capture, parent-child ownership, release and persistent duplicate detection (synthetic model transport)');
    const capability = await domain.capabilities();
    if (capability.sqlite) {
      const binding = { objectiveId: 'O_probe', trusted: true, sourceScope: 'bot' };
      const created = await domain.execute('space.create', { title: 'Synthetic probe', requestId: 'create-probe' }, binding);
      assert.equal(created.kind, 'saved', JSON.stringify(created));
      const saved = await domain.execute('runtime.store', { key: 'bot', expectedRevision: 0, value: { tasks: {} } }, binding);
      assert.equal(saved.kind, 'saved', JSON.stringify(saved));
      const loaded = await domain.execute('runtime.load', { key: 'bot' }, binding);
      assert.deepEqual(loaded.data.value, { tasks: {} });
      const conflict = await domain.execute('runtime.store', { key: 'bot', expectedRevision: 0, value: {} }, binding);
      assert.equal(conflict.kind, 'conflict');
      console.log('PASS actual Electron Host SQLite Worker, per-space state and transactional revision conflict');
      const botBinding = { objectiveId: 'O_bot_probe', trusted: true, sourceScope: 'private:bot-probe' };
      assert.equal((await domain.execute('space.create', { title: 'Synthetic Bot probe', requestId: 'create-bot-probe' }, botBinding)).kind, 'saved');
      const bot = createBotService({ baseDir: path.join(temporary, 'business'), domain, adapter });
      try {
        assert.equal((await bot.execute('chat.send', { messageId: 'bot-probe-message', text: 'Synthetic task request' }, botBinding)).kind, 'accepted');
        const delivery = await bot.execute('runtime.drain', {}, botBinding);
        if (!delivery.data?.answers?.length) {
          const debug = await domain.execute('runtime.load', { key: 'bot' }, { ...botBinding, sourceScope: 'bot' });
          console.error('Synthetic probe diagnostics:', JSON.stringify(debug.data?.value?.diagnostics || []));
        }
        assert.equal(delivery.kind, 'read', JSON.stringify(delivery));
        assert.equal(delivery.data.answers.at(-1)?.text, 'Synthetic end-to-end Bot delivery', JSON.stringify(delivery));
        assert.equal(delivery.data.tasks[0].phase, 'delivered');
        assert.equal(delivery.data.pending, 0);
        console.log('PASS actual installed AgentLoop + scoped task tools + Bot inbox/outbox + SQLite Worker + child report/publication (synthetic model transport)');
        peakTaskStreams = 0;
        await bot.execute('chat.send', { messageId: 'parallel-probe-message', text: 'Synthetic parallel request' }, botBinding);
        const parallel = await bot.execute('runtime.drain', {}, botBinding);
        assert.equal(parallel.data.tasks.length, 4); assert.equal(parallel.data.answers.length, 4); assert.equal(parallel.data.pending, 0);
        assert.equal(peakTaskStreams, 2);
        console.log('PASS actual installed AgentLoop runs separate Bot children in parallel with a two-task limit (synthetic model transport)');
      } finally { await bot.close(); }
    } else console.log(`DISABLED actual Electron Host SQLite Worker: ${capability.reason}; Node ${process.versions.node}`);
    console.log('NOT RUN live model-provider behavior, semantic routing accuracy or real provider cache hit/miss: isolated profile has no user credentials; no external model requests were made.');
    console.log(`Actual DSH ${JSON.parse(await fs.readFile(path.join(installRoot, 'package.json'), 'utf8')).version}; Electron Node ${process.versions.node}`);
  } finally { await adapter.close(); await domain.close(); await persistencePlugin.dispose(); await lifecycle.dispose(); }
}
