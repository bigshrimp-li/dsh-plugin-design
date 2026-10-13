/**
 * `setupComposerBridge` 的单测。
 *
 * 这个函数是编辑器与宿主之间唯一的桥：它把「插入草稿」的请求从 iframe 里的编辑器转给宿主，
 * 再把结果转回去。它有两边都不好测的性质——既不跑在编辑器页面里，也不跑在宿主里——
 * 所以既有的浏览器用例只能把它整个换掉（用桩），真实宿主里也只在用户点下按钮时才走到。
 *
 * 好在它的依赖是**全部注入**的（`frame` / `inputActions` / `targetWindow`），所以可以用一对
 * 假的 window 把两个方向都模拟出来，把安全边界和状态机逐条钉住。
 *
 * 这里断言的是它**必须守住**的性质：来源不对就不理、会话/通道不对就不理、令牌一次性、
 * 过期不认、宿主不提供接口时给可读的错误。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// 它是模块私有的（没有 export），所以在测试里把它挂到 context 的 global 上再取出来。
// 这样不必为了可测性去改 client.js。
const SOURCE = `${readFileSync(new URL('../client.js', import.meta.url), 'utf8')}
;globalThis.__setupComposerBridge = setupComposerBridge;
`;

const EDITOR_ORIGIN = 'http://127.0.0.1:17321';
const EDITOR_URL = `${EDITOR_ORIGIN}/`;
const CHANNEL = 'channel-1';

function load() {
  const sandbox = { crypto, URL, Date, console };
  sandbox.window = {
    __ModuleLoader__: { load: () => {} },
    addEventListener() {},
    removeEventListener() {},
  };
  runInNewContext(SOURCE, sandbox, { filename: 'client.js', timeout: 2000 });
  return sandbox.__setupComposerBridge;
}

/**
 * 一对假的 window：`editor`（iframe 里）与 `host`（父窗口）。
 *
 * 方向要留意：`receive` 挂的是**父窗口**的 message 监听（iframe 发上来的请求），
 * 而回复走 `event.source.postMessage` —— 也就是回到 **editor** 那边。两边各记一份。
 */
function harness({ inputActions } = {}) {
  /** iframe 收到的回信（桥的回复走这里）。 */
  const replies = [];
  const editorSubscribers = new Set();
  const editor = {
    postMessage: (message) => { replies.push(message); for (const fn of [...editorSubscribers]) fn(message); },
  };
  /** 父窗口上的 message 监听（桥注册的 `receive`）。 */
  const listeners = new Set();
  /** 父窗口自己发出的消息（这个桥不该用，留作断言）。 */
  const sentByHost = [];
  const host = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    postMessage: (message) => sentByHost.push(message),
  };
  const frame = { current: { contentWindow: editor } };

  const teardown = load()({
    frame,
    sessionId: 'session-1',
    url: EDITOR_URL,
    channel: CHANNEL,
    inputActions,
    targetWindow: host,
  });

  /** 把一个事件投给桥，返回它的同步回复（没有就 undefined）。 */
  const dispatch = (data, overrides = {}) => {
    const event = {
      source: editor,
      origin: EDITOR_ORIGIN,
      data: { type: 'dsh-design:composer', sessionId: 'session-1', channel: CHANNEL, requestId: 'r1', ...data },
      ...overrides,
    };
    const before = replies.length;
    for (const fn of [...listeners]) fn(event);
    return replies.length > before ? replies.at(-1) : undefined;
  };

  const fromEditor = async (data, overrides = {}) => {
    const reply = dispatch(data, overrides);
    await Promise.resolve();
    return reply;
  };

  /** 走完整的请求/回复：模拟编辑器发一次请求并等结果。 */
  const roundTrip = (data) => {
    const requestId = `r${replies.length + 1}-${Math.random().toString(36).slice(2, 7)}`;
    const event = {
      source: editor,
      origin: EDITOR_ORIGIN,
      data: { type: 'dsh-design:composer', sessionId: 'session-1', channel: CHANNEL, requestId, ...data },
    };
    return new Promise((resolve, reject) => {
      const done = (message) => {
        if (message?.requestId !== requestId) return;
        editorSubscribers.delete(done);
        message.ok ? resolve(message) : reject(new Error(message.error));
      };
      editorSubscribers.add(done);
      for (const fn of [...listeners]) fn(event);
    });
  };

  return { teardown, fromEditor, roundTrip, replies, sentByHost, listeners, editorSubscribers, editor, host };
}

const workingInput = () => {
  const calls = [];
  return {
    calls,
    captureInsertion: () => { calls.push('capture'); return { start: 4, end: 9 }; },
    insertText: (text, span) => { calls.push(['insert', text, span]); return true; },
  };
};

test('捕获后插入：令牌一次有效，插入的是折叠到末尾的位置', async () => {
  const input = workingInput();
  const h = harness({ inputActions: input });

  const captured = await h.roundTrip({ action: 'capture' });
  assert.equal(captured.ok, true);
  assert.equal(typeof captured.token, 'string');

  const inserted = await h.roundTrip({ action: 'insert', token: captured.token, text: '标注内容' });
  assert.equal(inserted.ok, true);
  assert.equal(input.calls.length, 2);
  assert.equal(input.calls[0], 'capture');
  const call = input.calls[1];
  assert.equal(call[0], 'insert');
  assert.equal(call[1], '标注内容');
  // 桥把选区折叠到末尾再插入，这样不会覆盖用户已选中的草稿文字。
  // 逐字段比而不是 deepStrictEqual：这个 span 是在 vm 的 realm 里造的，原型不同。
  assert.equal(call[2].start, 9);
  assert.equal(call[2].end, 9);
  h.teardown();
});

test('令牌只能用一次：重放被拒绝', async () => {
  const input = workingInput();
  const h = harness({ inputActions: input });
  const captured = await h.roundTrip({ action: 'capture' });
  await h.roundTrip({ action: 'insert', token: captured.token, text: 'a' });

  await assert.rejects(() => h.roundTrip({ action: 'insert', token: captured.token, text: 'b' }), /插入位置已失效/);
  assert.equal(input.calls.filter((c) => Array.isArray(c)).length, 1, '第二次插入不该到达宿主');
  h.teardown();
});

test('令牌超过 30 秒后失效，边界内仍然有效', async () => {
  // load() 把外层的 Date 传进了 vm，所以这里改 Date.now 能影响桥里的过期判断。
  const real = Date.now;
  try {
    const near = harness({ inputActions: workingInput() });
    const a = await near.roundTrip({ action: 'capture' });
    Date.now = () => real() + 29_000;
    const ok = await near.roundTrip({ action: 'insert', token: a.token, text: 'a' });
    assert.equal(ok.ok, true, '29 秒时不该过期');
    near.teardown();
    Date.now = real; // 复位：下面那次捕获必须发生在"现在"，否则经过的时间算不对

    const far = harness({ inputActions: workingInput() });
    const b = await far.roundTrip({ action: 'capture' });
    Date.now = () => real() + 31_000;
    await assert.rejects(() => far.roundTrip({ action: 'insert', token: b.token, text: 'a' }), /插入位置已失效/);
    far.teardown();
  } finally {
    Date.now = real;
  }
});

test('未知令牌被拒绝', async () => {
  const h = harness({ inputActions: workingInput() });
  await assert.rejects(() => h.roundTrip({ action: 'insert', token: 'not-a-token', text: 'a' }), /插入位置已失效/);
  h.teardown();
});

test('空内容与超长内容被拒绝', async () => {
  const input = workingInput();
  const h = harness({ inputActions: input });
  const first = await h.roundTrip({ action: 'capture' });
  await assert.rejects(() => h.roundTrip({ action: 'insert', token: first.token, text: '   ' }), /为空或过长/);

  const second = await h.roundTrip({ action: 'capture' });
  await assert.rejects(
    () => h.roundTrip({ action: 'insert', token: second.token, text: 'x'.repeat(200001) }),
    /为空或过长/,
  );
  assert.equal(input.calls.filter((c) => Array.isArray(c)).length, 0, '不该把非法内容交给宿主');
  h.teardown();
});

test('宿主不接受这次插入时，错误可读且不吞掉', async () => {
  const h = harness({ inputActions: { captureInsertion: () => ({ start: 0, end: 0 }), insertText: () => false } });
  const captured = await h.roundTrip({ action: 'capture' });
  await assert.rejects(() => h.roundTrip({ action: 'insert', token: captured.token, text: 'a' }), /草稿已变化/);
  h.teardown();
});

test('宿主没有草稿接口时给出可操作的提示', async () => {
  const h = harness({ inputActions: undefined });
  await assert.rejects(() => h.roundTrip({ action: 'capture' }), /没有提供草稿接口/);
  h.teardown();
});

test('captureInsertion 返回坏形状时拒绝', async () => {
  const h = harness({ inputActions: { captureInsertion: () => null, insertText: () => true } });
  await assert.rejects(() => h.roundTrip({ action: 'capture' }), /草稿暂时不可编辑/);
  h.teardown();
});

test('来源不是那个 iframe 的消息一律不理', async () => {
  const input = workingInput();
  const h = harness({ inputActions: input });
  const reply = await h.fromEditor({ action: 'capture' }, { source: { postMessage() {} } });
  assert.equal(reply, undefined);
  assert.equal(input.calls.length, 0);
  h.teardown();
});

test('来源不是编辑器源的消息一律不理', async () => {
  const input = workingInput();
  const h = harness({ inputActions: input });
  const reply = await h.fromEditor({ action: 'capture' }, { origin: 'http://evil.example' });
  assert.equal(reply, undefined);
  assert.equal(input.calls.length, 0);
  h.teardown();
});

test('会话或通道不匹配的消息一律不理', async () => {
  const input = workingInput();
  const h = harness({ inputActions: input });
  assert.equal(await h.fromEditor({ action: 'capture', sessionId: 'other' }), undefined);
  assert.equal(await h.fromEditor({ action: 'capture', channel: 'other' }), undefined);
  assert.equal(await h.fromEditor({ action: 'capture', requestId: 'x'.repeat(101) }), undefined);
  assert.equal(input.calls.length, 0);
  h.teardown();
});

test('回复带着会话与通道回去，且只回到编辑器源', async () => {
  const h = harness({ inputActions: workingInput() });
  const reply = await h.fromEditor({ action: 'capture' });
  assert.equal(reply.type, 'dsh-design:composer-result');
  assert.equal(reply.sessionId, 'session-1');
  assert.equal(reply.channel, CHANNEL);
  assert.equal(reply.requestId, 'r1');
  assert.equal(h.sentByHost.length, 0, '桥不该用父窗口的 postMessage 回信');
  h.teardown();
});

test('不认识的 action 被拒绝而不是静默通过', async () => {
  const h = harness({ inputActions: workingInput() });
  const reply = await h.fromEditor({ action: 'send-message' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /不支持/);
  h.teardown();
});

test('卸载后不再响应，注册的监听被摘掉', async () => {
  const input = workingInput();
  const h = harness({ inputActions: input });
  assert.equal(h.listeners.size, 1);
  h.teardown();
  assert.equal(h.listeners.size, 0, '必须摘掉监听，否则侧栏反复开关会累积');
  const reply = await h.fromEditor({ action: 'capture' });
  assert.equal(reply, undefined);
  assert.equal(input.calls.length, 0);
});
