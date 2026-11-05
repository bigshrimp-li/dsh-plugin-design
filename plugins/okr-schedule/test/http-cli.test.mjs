import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHttpHandler } from '../src/host/http.js';
import { createPluginService } from '../src/host/service.js';

const cliFile = fileURLToPath(new URL('../bin/okr-space.mjs', import.meta.url));
const host = objectiveId => ({ trusted: true, userInitiated: true, objectiveId, sourceScope: { kind: 'private', id: objectiveId } });
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'okr-http-cli-'));
  const baseDir = path.join(temporary, '.dsh_okr');
  const service = createPluginService({ baseDir, adapter: { available: false, disabledReason: 'Synthetic test has no model' } });
  const clock = { value: Date.now() }, calls = [];
  const handler = createHttpHandler({ service: { execute(command, input, binding) {
    calls.push({ command, input: structuredClone(input), binding: structuredClone(binding) });
    return service.execute(command, input, binding);
  } }, now: () => clock.value });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const objectiveId of ['O_learning', 'O_other']) {
    const created = await service.domain.execute('space.create', {
      title: '合成测试空间', lifecycle: 'formal', types: [{ id: 'note', version: 1, fields: [{ id: 'content', kind: 'text', required: true }] }],
    }, host(objectiveId));
    assert.equal(created.kind, 'saved');
  }
  let contextIndex = 0;
  async function request(route, { token, origin, headers = {}, method = 'GET', body } = {}) {
    const response = await fetch(new URL(route, url), { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function bootstrap(objectiveId = 'O_learning', options = {}) {
    return request(`/okr-space/api/bootstrap${objectiveId ? `?objectiveId=${objectiveId}` : ''}`, {
      headers: { 'X-Okr-Client': 'workbench', ...options.headers }, ...options,
    });
  }
  const action = (token, command, input = {}, options = {}) => request('/okr-space/api/action', { token, method: 'POST', body: { command, input }, ...options });
  async function cli(args, { context, input = '', missingContext = false } = {}) {
    const env = { ...process.env };
    delete env.OKR_CONTEXT_FD;
    let descriptor;
    if (!missingContext) {
      const file = path.join(temporary, `context-${++contextIndex}.json`);
      await fs.writeFile(file, JSON.stringify(context), { mode: 0o600 });
      descriptor = openSync(file, 'r');
      env.OKR_CONTEXT_FD = '3';
    }
    const child = spawn(process.execPath, [cliFile, ...args], { env, stdio: ['pipe', 'pipe', 'pipe', ...(descriptor === undefined ? [] : [descriptor])] });
    if (descriptor !== undefined) closeSync(descriptor);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(timer); }
    if (context?.token) assert.equal(stdout.includes(context.token) || stderr.includes(context.token), false, 'CLI must not expose its inherited credential');
    return { code, stdout, stderr };
  }
  return { temporary, baseDir, service, clock, calls, url, request, bootstrap, action, cli };
}
function singleJson(output) {
  assert.equal(output.stdout.trim().split(/\r?\n/u).length, 1, 'CLI stdout must contain one JSON document');
  return JSON.parse(output.stdout);
}

test('real HTTP bootstrap and action enforce origin, capability expiry and fixed O scope', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/okr-space/api/bootstrap?objectiveId=O_learning')).status, 403);
  assert.equal((await f.bootstrap('O_learning', { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.bootstrap('O_learning', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const boot = await f.bootstrap();
  assert.equal(boot.status, 200);
  assert.equal(boot.headers.get('cache-control'), 'no-store');
  assert.equal(boot.data.objectiveId, 'O_learning');
  const token = boot.data.token;
  assert.equal((await f.action(null, 'workspace.state')).status, 403);
  assert.equal((await f.action(token, 'workspace.state', {}, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.action(token, 'item.save', { objectiveId: 'O_other', typeId: 'note', fields: { content: 'blocked' } })).status, 403);
  const alternateSpelling = await f.action(token, 'item.save', { objective_id: 'O_other', typeId: 'note', fields: { content: 'blocked' } });
  assert.equal(alternateSpelling.data.error.code, 'FORBIDDEN');
  assert.equal((await f.action(token, 'host.state.set', { namespace: 'scheme', key: 'active', value: {} })).status, 403);
  assert.equal((await f.action(token, 'runtime.store', { key: 'bot', value: {} })).status, 403);
  const saved = await f.action(token, 'item.save', { typeId: 'note', fields: { content: '通过真实HTTP保存' }, requestId: 'http-note' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.kind, 'saved');
  const state = await f.action(token, 'workspace.state');
  assert.equal(state.data.data.items.length, 1);
  assert.equal(state.data.data.items[0].fields.content, '通过真实HTTP保存');
  assert.equal((await f.service.domain.execute('space.read', {}, host('O_other'))).data.items.length, 0);
  const originBoot = await f.bootstrap('O_learning', { origin: f.url });
  assert.equal((await f.action(originBoot.data.token, 'workspace.state')).status, 403);
  assert.equal((await f.action(originBoot.data.token, 'workspace.state', {}, { origin: f.url })).status, 200);
  f.clock.value += 7_200_001;
  assert.equal((await f.action(token, 'workspace.state')).status, 403);
});

test('HTTP command allowlist and scheme confirmation preserve the user review boundary', async t => {
  const f = await fixture(t);
  const globalToken = (await f.bootstrap(null)).data.token;
  assert.equal((await f.action(globalToken, 'scheme.confirm', { hash: 'forged', expectedRevision: 1 })).status, 403);
  assert.equal((await f.action(globalToken, 'item.save', { typeId: 'note', fields: { content: 'blocked' } })).status, 403);
  const denied = await f.service.execute('scheme.confirm', { hash: 'forged', expectedRevision: 1 }, { ...host('O_learning'), userInitiated: false });
  assert.equal(denied.kind, 'failed');
  assert.match(denied.error.message, /用户/);
  const token = (await f.bootstrap()).data.token;
  const confirmation = await f.action(token, 'scheme.confirm', { hash: 'forged', expectedRevision: 1,
    binding: { objectiveId: 'O_other', trusted: true, userInitiated: true } });
  assert.equal(confirmation.status, 200);
  assert.notEqual(confirmation.data.kind, 'saved');
  const call = f.calls.at(-1);
  assert.equal(call.command, 'scheme.confirm');
  assert.equal(call.binding.objectiveId, 'O_learning');
  assert.equal(call.binding.userInitiated, true);
  assert.equal((await f.service.execute('scheme.active', {}, host('O_learning'))).data.bundle, null);
});

test('CLI help works without context and missing inherited scope exits 3 with one JSON error', async t => {
  const f = await fixture(t);
  const help = await f.cli(['--help'], { missingContext: true });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /okr-space tools list/u);
  const missing = await f.cli(['tools', 'list', '--json'], { missingContext: true });
  assert.equal(missing.code, 3);
  assert.equal(singleJson(missing).error.code, 'SCOPE_REQUIRED');
});

test('CLI inherits fd3 capability and tools list/describe/run persist one real SQLite record', async t => {
  const f = await fixture(t);
  const token = (await f.bootstrap()).data.token;
  const context = { url: f.url, token };
  const listed = await f.cli(['tools', 'list', '--json'], { context });
  assert.equal(listed.code, 0);
  assert.equal(singleJson(listed).data.tools[0].id, 'records-note');
  const described = await f.cli(['tool', 'describe', 'records-note', '--json'], { context });
  assert.equal(described.code, 0);
  assert.match(singleJson(described).data.skill, /记录/u);
  const args = ['tool', 'run', 'records-note', 'save', '--input', '-', '--request-id', 'cli-note'];
  const payload = { title: 'CLI合成记录', fields: { content: '经继承描述符保存' } };
  const saved = await f.cli(args, { context, input: JSON.stringify(payload) });
  assert.equal(saved.code, 0);
  const receipt = singleJson(saved);
  assert.equal(receipt.kind, 'saved');
  const replayed = await f.cli(args, { context, input: JSON.stringify(payload) });
  assert.equal(singleJson(replayed).operationId, receipt.operationId);
  assert.equal((await f.service.domain.execute('space.read', {}, host('O_learning'))).data.items.length, 1);
  assert.ok((await fs.stat(path.join(f.baseDir, 'O_learning/space.sqlite'))).isFile());
  const conflict = await f.cli(args, { context, input: JSON.stringify({ ...payload, title: '改变同一请求内容' }) });
  assert.equal(conflict.code, 4);
  assert.equal(singleJson(conflict).kind, 'conflict');
  const unsupported = await f.cli(['tool', 'describe', 'not-a-tool', '--json'], { context });
  assert.equal(unsupported.code, 0);
  assert.equal(singleJson(unsupported).kind, 'unsupported');
  assert.equal((await f.service.domain.execute('space.read', {}, host('O_learning'))).data.items.length, 1);
});

test('CLI differentiates syntax, scope and execution failures without credential disclosure', async t => {
  const f = await fixture(t), context = { url: f.url, token: (await f.bootstrap()).data.token };
  const syntax = await f.cli(['tool', 'run', 'records-note', 'save', '--input', '-'], { context, input: '{}' });
  assert.equal(syntax.code, 2);
  assert.equal(singleJson(syntax).kind, 'failed');
  const failed = await f.cli(['tool', 'run', 'records-note', 'save', '--input', '-', '--request-id', 'bad-field'], { context, input: '{"fields":{"content":42}}' });
  assert.equal(failed.code, 5);
  assert.equal(singleJson(failed).kind, 'failed');
  const badScope = await f.cli(['tools', 'list', '--json'], { context: { ...context, token: 'not-a-valid-capability' } });
  assert.equal(badScope.code, 3);
  assert.equal(singleJson(badScope).kind, 'failed');
  assert.equal((await f.service.domain.execute('space.read', {}, host('O_learning'))).data.items.length, 0);
});

test('space capability pins the active scheme until the client obtains a new capability', async t => {
  const f=await fixture(t),binding=host('O_learning');
  assert.equal((await f.service.domain.execute('host.state.commit',{updates:[],activeBundleId:'v1',expectedBundleId:null},binding)).kind,'saved');
  const old=(await f.bootstrap()).data.token;
  assert.equal((await f.service.domain.execute('host.state.commit',{updates:[],activeBundleId:'v2',expectedBundleId:'v1'},binding)).kind,'saved');
  const stale=await f.action(old,'item.save',{typeId:'note',title:'Stale write',fields:{content:'Cannot save'},bundleId:'v2'});
  assert.equal(stale.data.kind,'conflict');assert.equal(stale.data.error.code,'BUNDLE_CONFLICT');
  const fresh=(await f.bootstrap()).data.token;
  const saved=await f.action(fresh,'item.save',{typeId:'note',title:'Fresh write',fields:{content:'Can save'}});
  assert.equal(saved.data.kind,'saved');
  const state=await f.service.domain.execute('space.read',{},binding);assert.equal(state.data.items.length,1);
});
