import { afterEach, describe, expect, it, vi } from "vitest";

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
await import("../../src/client/client.space.js");
const { createSpace, SPACE_ID, lineDiff } = loaded[0].factory();

const models = [
  { provider: "local", id: "model-a", selectable: true, supportedThinkingLevels: ["off", "low", "high"] },
  { provider: "remote", id: "model-b", selectable: true, supportedThinkingLevels: ["low", "high"] },
  { provider: "remote", id: "model-disabled", selectable: false },
];

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function liveFrame(overrides = {}) {
  return {
    type: "stream.text_delta", threadId: "thread-1", runId: "run-1", turnId: "turn-1",
    requestRef: "request-1", attempt: 0, messageId: "generation-a", index: 0, delta: "x",
    ...overrides,
  };
}

function fixture({ modelResult = models, summaries = [], messagePages = {}, action = {}, state, EventSourceImpl, storage: customStorage } = {}) {
  const requests = [];
  const requestIds = [];
  const views = [];
  const selections = [];
  let nextId = 0;
  const services = {
    viewState: {
      get: () => views.at(-1) ?? {},
      set: (value) => views.push(value),
    },
  };
  const transport = {
    nextRequestId(name) {
      const id = `${name}-${++nextId}`;
      requestIds.push({ name, id });
      return id;
    },
    async call() {
      throw new Error("space actions must use the Core route");
    },
  };
  const ctx = { layout: { selectPanel: (id) => selections.push(id) } };

  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^\/super-agent\//, "");
    if (path.startsWith("state")) {
      const query = new URL(`http://space.test/${path}`).searchParams;
      const selected = { threadId: query.get("threadId"), conversationId: query.get("conversationId") };
      return response(await state?.(selected) ?? {
        connection: "ready", threadId: selected.threadId, conversationId: selected.conversationId,
        mainConversationId: selected.conversationId, snapshot: null, run: null,
      });
    }
    const { action: name, payload } = JSON.parse(init.body);
    requests.push({ action: name, payload });
    if (action[name]) return await action[name](payload, requests);
    if (name === "models.list") return response({ result: modelResult });
    if (name === "thread.list") {
      const page = payload.cursor ? 1 : 0;
      const items = summaries.filter((item) => (item.page ?? 0) === page).map(({ page: _page, ...item }) => item);
      return response({ result: { items, ...(summaries.some((item) => item.page === 1) && page === 0 ? { nextCursor: "threads-page-2" } : {}) } });
    }
    if (name === "conversation.get") {
      return response({ result: { conversationId: payload.conversationId, config: { cwd: "/workspace", modelId: "model-a" } } });
    }
    if (name === "messages.list") {
      const pages = messagePages[payload.conversationId] ?? [[
        { messageId: `${payload.conversationId}-message`, role: "assistant", text: "answer" },
      ]];
      const page = payload.cursor ? 1 : 0;
      return response({ result: { items: pages[page] ?? [], ...(pages.length > 1 && page === 0 ? { nextCursor: `${payload.conversationId}-messages-page-2` } : {}) } });
    }
    if (name === "thread.get") return response({ result: { threadId: payload.threadId, activeRuns: [] } });
    if (name === "workspace.register") return response({ result: { root: payload.root, workspaceId: "workspace-1" } });
    if (name === "thread.create") return response({ result: { threadId: "thread-new", mainConversationId: "conversation-new" } });
    if (name === "settings.get") return response({ result: { configuration: { defaultModelConfigId: "configured-a", modelConfiguration: { models: [{ id: "configured-a", modelId: "model-a" }] } } } });
    if (name === "input.submit") return response({ result: { accepted: true } });
    return response({ result: {} });
  };
  const storage = customStorage || {
    getItem: () => JSON.stringify({ directories: [{ root: "/workspace" }], root: "/workspace", modelId: "model-a" }),
    setItem() {},
  };
  const kernel = { React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }, h: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const space = createSpace({ kernel, services, transport, ctx, Panel: () => null, fetchImpl, storage, EventSourceImpl });
  return { ...space, requests, requestIds, services, selections, ctx, transport };
}

async function refreshed(options = {}) {
  const value = fixture(options);
  await value.controller.refresh();
  return value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("independent Super Agent space controller", () => {
  it("uses only the configured service default for new conversations and lets an existing conversation explicitly adopt it", async () => {
    const value = await refreshed();
    value.controller.newConversation(""); value.controller.setDraft("inherit current defaults");
    await value.controller.send();
    expect(value.requests.find(item => item.action === "thread.create").payload).not.toHaveProperty("modelId");
    await value.controller.restoreServiceDefaults();
    expect(value.requests.find(item => item.action === "conversation.updateConfig").payload.patch).toEqual({ modelSource: "service_default" });
    value.controller.dispose();
    const empty = await refreshed({ action: { "settings.get": async () => response({ result: { configuration: { defaultModelConfigId: null, modelConfiguration: { models: [] } } } }) } });
    empty.controller.newConversation(""); empty.controller.setDraft("must select a model");
    expect(await empty.controller.send()).toBeNull();
    expect(empty.requests.some(item => item.action === "thread.create")).toBe(false);
    expect(empty.controller.getSnapshot().modelId).toBe("");
    empty.controller.dispose();
  });
  it("resets a previous active-Run supplement choice when creating a new conversation", async () => {
    const value = await refreshed();
    value.controller.setDelivery("next_turn");
    value.controller.newConversation(""); value.controller.setDraft("new task");
    expect(value.controller.getSnapshot().delivery).toBe("new_run");
    await value.controller.send();
    expect(value.requests.find(item => item.action === "input.submit").payload.delivery).toBe("new_run");
    value.controller.dispose();
  });
  it("binds a supplement to the selected Run in the current Conversation instead of the first active Run", async () => {
    const value = await refreshed({ action: {
      "thread.get": async () => response({ result: { threadId: "thread-1", activeRuns: ["run-foreign", "run-a", "run-b"] } }),
      "run.get": async payload => response({ result: {
        runId: payload.runId,
        conversationId: payload.runId === "run-foreign" ? "conversation-foreign" : "conversation-1",
        status: "running",
      } }),
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    expect(value.controller.getSnapshot().runDetails.map(run => run.runId)).toEqual(["run-a", "run-b"]);

    value.controller.setDelivery("next_turn"); value.controller.setDraft("补充这个任务");
    expect(await value.controller.send()).toBeNull();
    expect(value.controller.getSnapshot().error).toContain("多个运行中任务");
    expect(value.controller.getSnapshot().draft).toBe("补充这个任务");
    expect(value.requests.some(item => item.action === "input.submit")).toBe(false);

    expect(() => value.controller.setTargetRun("run-foreign")).toThrow("不属于当前对话");
    value.controller.setTargetRun("run-b");
    await value.controller.send();
    expect(value.requests.find(item => item.action === "input.submit").payload).toMatchObject({
      conversationId: "conversation-1",
      delivery: "next_turn",
      targetRunId: "run-b",
    });
    value.controller.dispose();
  });
  it("keeps supplement restrictions inside the handled send path and preserves the draft", async () => {
    const value = await refreshed();
    value.controller.newConversation("");
    value.controller.setSelectedSkills(["skill@version"]);
    value.controller.setDelivery("next_turn");
    value.controller.setDraft("keep this draft");
    expect(await value.controller.send()).toBeNull();
    expect(value.controller.getSnapshot().error).toContain("草稿已保留");
    expect(value.controller.getSnapshot().draft).toBe("keep this draft");
    expect(value.requests.some(item => item.action === "thread.create" || item.action === "input.submit")).toBe(false);
    value.controller.dispose();
  });
  it("restores the same unconfirmed input command and request identity after a browser reload", async () => {
    const data = new Map(), storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
    let firstAttempts = 0;
    const first = await refreshed({ storage, action: {
      "input.submit": async () => ++firstAttempts === 1
        ? response({ error: { code: "TIMEOUT", message: "receipt unknown" } }, 504)
        : response({ result: { accepted: true } }),
    } });
    first.controller.newConversation(""); first.controller.setDraft("original command"); await first.controller.send();
    const original = first.requests.find(item => item.action === "input.submit").payload;
    expect(first.controller.getSnapshot().draft).toBe("original command");
    first.controller.dispose();

    const second = await refreshed({ storage });
    expect(second.controller.getSnapshot().selected).toEqual({ threadId: "thread-new", conversationId: "conversation-new" });
    second.controller.setDraft("original command"); await second.controller.send();
    const retried = second.requests.find(item => item.action === "input.submit").payload;
    expect(retried).toEqual(original);
    expect(second.requests.some(item => item.action === "thread.create")).toBe(false);
    second.controller.dispose();
  });
  it("does not replay an unconfirmed input into another Core target", async () => {
    const data = new Map(), storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
    const value = await refreshed({ storage, action: {
      "input.submit": async () => response({ error: { code: "TIMEOUT", message: "receipt unknown" } }, 504),
    } });
    value.controller.newConversation(""); value.controller.setDraft("target-a command"); await value.controller.send();
    const original = value.requests.find(item => item.action === "input.submit").payload;

    value.controller.targetChanged("target-b");
    await value.controller.refresh();
    value.controller.setDraft("target-b command"); await value.controller.send();
    const current = value.requests.filter(item => item.action === "input.submit").at(-1).payload;
    expect(current.targetId).toBe("target-b");
    expect(current.requestId).not.toBe(original.requestId);
    expect(value.requests.find(item => item.action === "thread.create" && item.payload.targetId === "target-b")).toBeTruthy();
    value.controller.dispose();
  });
  it("requires explicit retry acknowledgement, preserves the original command after a lost receipt and returns the new Run", async () => {
    let attempts = 0;
    const fx = await refreshed({ action: {
      "run.get": async payload => response({ result: { runId: payload.runId, conversationId: "conversation-1", status: "failed" } }),
      "run.redo": async () => ++attempts === 1 ? response({ error: { code: "TIMEOUT", message: "receipt was lost" } }, 504) : response({ result: { runId: "independent-retry", conversationId: "conversation-retry" } }),
    } });
    await fx.controller.selectThread("thread-1", "conversation-1");
    await expect(fx.controller.redoRun("original")).rejects.toThrow("重新发起业务动作");
    expect(fx.requests.some(item => item.action === "run.redo")).toBe(false);
    await expect(fx.controller.redoRun("original", { acknowledgeExternalEffects: true })).rejects.toThrow("receipt was lost");
    expect(await fx.controller.redoRun("original", { acknowledgeExternalEffects: true })).toEqual({ runId: "independent-retry", conversationId: "conversation-retry" });
    const commands = fx.requests.filter(item => item.action === "run.redo"); expect(commands).toHaveLength(2);
    expect(commands[0].payload).toEqual(commands[1].payload); expect(commands[1].payload).toMatchObject({ runId: "original", mode: "fork" });
    expect(fx.controller.getSnapshot().selected).toEqual({ threadId: "thread-1", conversationId: "conversation-retry" });
    fx.controller.dispose();
  });

  it("refuses cross-conversation merges, requires every conflict choice and preserves a CAS command for retry", async () => {
    let branchConversation = "another-conversation", mergeCalls = 0;
    const preview = { branchId: "branch-1", expectedRevision: 7, baseSnapshotId: "base", currentSnapshotId: "current", incomingSnapshotId: "incoming", conflicts: ["conflict.md"], files: [] };
    const fx = await refreshed({ action: {
      "files.branch.get": async () => response({ result: { branchId: "branch-1", conversationId: branchConversation } }),
      "files.branch.previewMerge": async () => response({ result: preview }),
      "files.branch.merge": async () => ++mergeCalls === 1 ? response({ error: { code: "VERSION_CONFLICT", message: "branch changed" } }, 409) : response({ result: { branchId: "branch-1", revision: 8, currentSnapshotId: "merged" } }),
    } });
    await fx.controller.selectThread("thread-1", "conversation-1");
    await expect(fx.controller.previewFileMerge({ branchId: "branch-1", baseSnapshotId: "base", incomingSnapshotId: "incoming" })).rejects.toThrow("不属于当前对话");
    branchConversation = "conversation-1";
    expect(await fx.controller.previewFileMerge({ branchId: "branch-1", baseSnapshotId: "base", incomingSnapshotId: "incoming" })).toEqual(preview);
    await expect(fx.controller.commitFileMerge(preview, {})).rejects.toThrow("每个冲突文件");
    const choices = { "conflict.md": "incoming" };
    await expect(fx.controller.commitFileMerge(preview, choices)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(choices).toEqual({ "conflict.md": "incoming" }); expect(preview.expectedRevision).toBe(7);
    expect(await fx.controller.commitFileMerge(preview, choices)).toMatchObject({ revision: 8 });
    const commands = fx.requests.filter(item => item.action === "files.branch.merge"); expect(commands[0].payload).toEqual(commands[1].payload); expect(commands[0].payload.expectedRevision).toBe(7);
    fx.controller.dispose();
  });

  it("does not apply a late original-input retry response to another target", async () => {
    const gate = deferred();
    const fx = await refreshed({ action: {
      "run.get": async payload => response({ result: { runId: payload.runId, conversationId: "conversation-1", status: "completed" } }),
      "run.redo": async () => { await gate.promise; return response({ result: { runId: "late-retry", conversationId: "conversation-1" } }); },
    } });
    await fx.controller.selectThread("thread-1", "conversation-1");
    const pending = fx.controller.redoRun("original", { acknowledgeExternalEffects: true });
    for (let i = 0; i < 10 && !fx.requests.some(item => item.action === "run.redo"); i++) await Promise.resolve();
    fx.controller.targetChanged("another-target"); gate.resolve(); await pending;
    expect(fx.controller.getSnapshot()).toMatchObject({ targetId: "another-target", selected: null, inspector: false });
    expect(fx.requests.find(item => item.action === "run.redo").payload.targetId).toBeNull(); fx.controller.dispose();
  });

  it("keeps healthy history and the main space usable when one old conversation or messages response is malformed", async () => {
    const value = await refreshed({ summaries: [{ threadId: "bad-thread", mainConversationId: "old-conversation" }, { threadId: "thread-1", mainConversationId: "conversation-1" }],
      action: {
        "conversation.get": async payload => response({ result: payload.conversationId === "old-conversation" ? { config: null } : { conversationId: payload.conversationId, configRevision: "r1", config: { cwd: "/workspace", modelId: "model-a" } } }),
        "messages.list": async () => response({ result: { items: null } }),
      } });
    expect(value.controller.getSnapshot().threads).toHaveLength(2);
    expect(value.controller.getSnapshot().threads[0].loadError).toContain("结构无效");
    await value.controller.selectThread("thread-1", "conversation-1");
    expect(value.controller.getSnapshot()).toMatchObject({ ready: true, selected: { threadId: "thread-1" }, messages: [], historyError: expect.stringContaining("历史消息读取失败") });
    value.controller.dispose();
  });

  it("creates a real pure-text conversation without registering or inventing a workspace", async () => {
    const value = await refreshed(); value.controller.newConversation(""); value.controller.setDraft("纯文本问题"); await value.controller.send();
    const create = value.requests.find(item => item.action === "thread.create");
    expect(create.payload).not.toHaveProperty("cwd"); expect(create.payload).not.toHaveProperty("workspaceId");
    expect(value.requests.some(item => item.action === "workspace.register")).toBe(false);
    expect(value.requests.find(item => item.action === "input.submit").payload.delivery).toBe("new_run");
    value.controller.dispose();
  });

  it("renders live tool argument fragments only as their paired tool call and never assistant prose", async () => {
    const value = await refreshed({ action: { "run.get": async () => response({ result: { conversationId: "conversation-1" } }) } });
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.receiveLive(liveFrame({ type: "stream.tool_call_delta", toolCallId: "call-a", toolName: "read", delta: '{"path":' }));
    await value.controller.receiveLive(liveFrame({ type: "stream.tool_call_delta", toolCallId: "call-b", toolName: "ls", index: 1, delta: '{"path":"."}' }));
    await value.controller.receiveLive(liveFrame({ type: "stream.tool_call_delta", toolCallId: "call-a", toolName: "read", index: 2, delta: '"a.md"}' }));
    expect(value.controller.getSnapshot().live).toMatchObject([
      { kind: "tool_call", text: "", toolCall: { callId: "call-a", name: "read", arguments: '{"path":"a.md"}' } },
      { kind: "tool_call", text: "", toolCall: { callId: "call-b", name: "ls", arguments: '{"path":"."}' } },
    ]);
    value.controller.dispose();
  });

  it("updates an existing conversation against the pending revision without changing old messages", async () => {
    const value = await refreshed({ action: { "conversation.get": async () => response({ result: { conversationId: "conversation-1", configRevision: "effective-r1", pendingConfig: { configRevision: "pending-r2", blockingRunId: "run-a", config: { modelId: "model-b" } }, config: { modelId: "model-a", cwd: "/workspace" } } }) } });
    await value.controller.selectThread("thread-1", "conversation-1"); const before = value.controller.getSnapshot().messages;
    await value.controller.setModel("model-b");
    expect(value.requests.find(item => item.action === "conversation.updateConfig").payload).toMatchObject({ expectedConfigRevision: "pending-r2", patch: { modelId: "model-b", provider: "remote" } });
    expect(value.controller.getSnapshot().messages).toEqual(before); value.controller.dispose();
  });
  it("pins an explicit snapshot to the submitted task and clears the one-shot selection only after durable reception", async () => {
    const value = await refreshed();
    value.controller.newConversation("");
    value.controller.useFileSnapshot({ snapshotId: "snapshot-a", workspaceId: "workspace-a", createdAt: 1, rootHash: "hash-a" }, "/workspace");
    value.controller.setDraft("验证指定内容"); await value.controller.send();
    expect(value.requests.find(item => item.action === "thread.create").payload).toMatchObject({ workspaceId: "workspace-a", cwd: "/workspace" });
    expect(value.requests.find(item => item.action === "input.submit").payload).toMatchObject({ fileInput: { mode: "fixed_snapshot", snapshotId: "snapshot-a" } });
    expect(value.controller.getSnapshot().fileSelection).toBeNull(); value.controller.dispose();
  });
  it("explicitly keeps a reviewed current branch and binds its identity to the next input", async () => {
    const branch = { branchId: "branch-keep", conversationId: "conversation-1", workspaceId: "workspace-a", currentSnapshotId: "current-a", revision: 7 };
    const value = await refreshed({ summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1", conversation: { config: { cwd: "/workspace" } } }], action: { "files.branch.get": async () => response({ result: branch }), "files.snapshot": async () => response({ result: { snapshotId: "current-a", createdAt: 1, rootHash: "current-hash" } }) } });
    await value.controller.selectThread("thread-1", "conversation-1");
    value.controller.useFileSnapshot({ snapshotId: "incoming-a", workspaceId: "workspace-a" }, "/workspace");
    await expect(value.controller.useCurrentFileBranch(branch.branchId, 6)).rejects.toThrow("分支已更新");
    expect(value.controller.getSnapshot().fileSelection.snapshotId).toBe("incoming-a");
    expect(await value.controller.useCurrentFileBranch(branch.branchId, 7)).toEqual(branch);
    value.controller.setDraft("FORMAL_J4_KEEP_CURRENT"); await value.controller.send();
    expect(value.requests.find(item => item.action === "input.submit").payload).toMatchObject({ fileBranchId: "branch-keep" });
    expect(value.requests.find(item => item.action === "input.submit").payload.fileInput).toBeUndefined();
    expect(value.controller.getSnapshot().fileSelection).toBeNull(); value.controller.dispose();
  });
  it("keeps the user's snapshot choice when the reviewed current branch has expired content", async () => {
    const value = await refreshed({ summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1", conversation: { config: { cwd: "/workspace" } } }], action: { "files.branch.get": async () => response({ result: { branchId: "expired-branch", conversationId: "conversation-1", currentSnapshotId: "expired-a", revision: 2 } }), "files.snapshot": async () => response({ error: { code: "NOT_FOUND", message: "original contents expired; select an explicit new baseline" } }, 404) } });
    await value.controller.selectThread("thread-1", "conversation-1");
    value.controller.useFileSnapshot({ snapshotId: "new-baseline", workspaceId: "workspace-a" }, "/workspace");
    await expect(value.controller.useCurrentFileBranch("expired-branch", 2)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(value.controller.getSnapshot().fileSelection.snapshotId).toBe("new-baseline"); value.controller.dispose();
  });
  it("does not let a late input response clear the other target's draft", async () => {
    const input = deferred();
    const value = await refreshed({ action: { "input.submit": async () => input.promise } });
    value.controller.setDraft("old target input"); const sending = value.controller.send();
    await vi.waitFor(() => expect(value.requests.some(item => item.action === "input.submit")).toBe(true));
    value.controller.targetChanged("target-b"); value.controller.setDraft("new target draft");
    input.resolve(response({ result: { accepted: true } })); await sending;
    expect(value.controller.getSnapshot()).toMatchObject({ targetId: "target-b", draft: "new target draft", selected: null });
    value.controller.dispose();
  });
  it.each([
    ["array", models],
    ["items envelope", { items: models }],
  ])("accepts the Core model catalog as an %s and uses the selected model for a new Thread", async (_label, modelResult) => {
    const value = await refreshed({ modelResult });
    expect(value.controller.getSnapshot().models).toEqual(models);
    value.controller.newConversation("/workspace");
    value.controller.setModel("model-b");
    value.controller.setDraft("hello from the isolated space");
    await value.controller.send();

    const create = value.requests.find((item) => item.action === "thread.create");
    const submit = value.requests.find((item) => item.action === "input.submit");
    expect(create.payload).toMatchObject({ modelId: "model-b", cwd: "/workspace", agentId: "super-agent" });
    expect(create.payload.requestId).toBeTruthy();
    expect(submit.payload).toMatchObject({ threadId: "thread-new", conversationId: "conversation-new", text: "hello from the isolated space" });
    expect(value.controller.getSnapshot().selected).toEqual({ threadId: "thread-new", conversationId: "conversation-new" });
    expect(value.selections).toEqual([SPACE_ID]);
    value.controller.dispose();
  });
  it("sends an explicitly selected first-message thinking level and resets values the next model cannot support", async () => {
    const value = await refreshed();
    value.controller.newConversation("/workspace");
    value.controller.setModel("model-a");
    value.controller.setThinking("off");
    expect(value.controller.getSnapshot().thinkingLevel).toBe("off");
    value.controller.setModel("model-b");
    expect(value.controller.getSnapshot().thinkingLevel).toBeNull();
    value.controller.setThinking("high");
    value.controller.setDraft("use high effort");
    await value.controller.send();

    const create = value.requests.find(item => item.action === "thread.create");
    expect(create.payload).toMatchObject({ modelId: "model-b", thinkingLevel: "high" });
    value.controller.dispose();
  });
  it("updates an existing conversation thinking level and represents provider default explicitly", async () => {
    const value = await refreshed();
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.setThinking("high");
    await value.controller.setThinking("provider_default");
    const updates = value.requests.filter(item => item.action === "conversation.updateConfig");
    expect(updates.map(item => item.payload.patch.thinkingLevel)).toEqual(["high", "provider_default"]);
    value.controller.dispose();
  });

  it("preserves the same create and input request IDs across transient failures", async () => {
    let createAttempts = 0;
    let inputAttempts = 0;
    const value = await refreshed({ action: {
      "thread.create": async () => {
        createAttempts += 1;
        return createAttempts === 1
          ? response({ error: { message: "temporary create failure" } }, 503)
          : response({ result: { threadId: "thread-new", mainConversationId: "conversation-new" } });
      },
      "input.submit": async () => {
        inputAttempts += 1;
        return inputAttempts === 1
          ? response({ error: { message: "temporary submit failure" } }, 503)
          : response({ result: { accepted: true } });
      },
    } });
    value.controller.setDraft("retry this exact input");

    await value.controller.send();
    const createId = value.requests.find((item) => item.action === "thread.create").payload.requestId;
    expect(value.controller.getSnapshot().error).toContain("temporary create failure");
    await value.controller.send();
    const createIds = value.requests.filter((item) => item.action === "thread.create").map((item) => item.payload.requestId);
    const submitIds = value.requests.filter((item) => item.action === "input.submit").map((item) => item.payload.requestId);
    expect(createIds).toEqual([createId, createId]);
    expect(submitIds).toHaveLength(1);

    expect(value.controller.getSnapshot().error).toContain("temporary submit failure");
    await value.controller.send();
    const retriedSubmitIds = value.requests.filter((item) => item.action === "input.submit").map((item) => item.payload.requestId);
    expect(retriedSubmitIds).toHaveLength(2);
    expect(retriedSubmitIds[1]).toBe(retriedSubmitIds[0]);
    value.controller.dispose();
  });

  it("loads every Thread and message page and keeps the selected Thread/Conversation pair", async () => {
    const value = await refreshed({
      summaries: [
        { page: 0, threadId: "thread-1", mainConversationId: "conversation-1" },
        { page: 1, threadId: "thread-2", mainConversationId: "conversation-2" },
      ],
      messagePages: {
        "conversation-1": [
          [{ messageId: "m1", role: "user", text: "first" }],
          [{ messageId: "m2", role: "assistant", text: "second" }],
        ],
      },
    });
    expect(value.controller.getSnapshot().threads.map((thread) => thread.threadId)).toEqual(["thread-1", "thread-2"]);
    await value.controller.selectThread("thread-1", "conversation-1");

    expect(value.controller.getSnapshot().selected).toEqual({ threadId: "thread-1", conversationId: "conversation-1" });
    expect(value.controller.getSnapshot().messages.map((message) => message.messageId)).toEqual(["m1", "m2"]);
    expect(value.services.viewState.get()).toMatchObject({ threadId: "thread-1", conversationId: "conversation-1" });
    expect(value.requests.filter((item) => item.action === "thread.list").map((item) => item.payload.cursor ?? null)).toEqual([null, "threads-page-2"]);
    expect(value.requests.filter((item) => item.action === "messages.list").map((item) => item.payload.cursor ?? null)).toEqual([null, "conversation-1-messages-page-2"]);
    value.controller.dispose();
  });

  it("ignores a late state and message read after another Thread is selected", async () => {
    const delayed = deferred();
    const value = await refreshed({
      summaries: [
        { threadId: "thread-1", mainConversationId: "conversation-1" },
        { threadId: "thread-2", mainConversationId: "conversation-2" },
      ],
      state: async ({ conversationId }) => conversationId === "conversation-1"
        ? delayed.promise
        : { connection: "ready", threadId: "thread-2", conversationId: "conversation-2", mainConversationId: "conversation-2" },
      messagePages: {
        "conversation-1": [[{ messageId: "stale", role: "assistant", text: "stale" }]],
        "conversation-2": [[{ messageId: "current", role: "assistant", text: "current" }]],
      },
    });
    const first = value.controller.selectThread("thread-1", "conversation-1");
    const second = value.controller.selectThread("thread-2", "conversation-2");
    await second;
    delayed.resolve({ connection: "ready", threadId: "thread-1", conversationId: "conversation-1", mainConversationId: "conversation-1" });
    await first;

    expect(value.controller.getSnapshot().selected).toEqual({ threadId: "thread-2", conversationId: "conversation-2" });
    expect(value.controller.getSnapshot().messages.map((message) => message.messageId)).toEqual(["current"]);
    expect(value.services.viewState.get()).toMatchObject({ threadId: "thread-2", conversationId: "conversation-2" });
    value.controller.dispose();
  });

  it("stops the polling timer and prevents new Core reads after disposal", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const dispose = value.controller.start();
    await value.controller.refresh();
    const before = value.requests.filter((item) => item.action === "models.list").length;
    dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(value.requests.filter((item) => item.action === "models.list")).toHaveLength(before);
    value.controller.dispose();
  });

  it("stops the active Run through the Thread stop route with a fresh request ID", async () => {
    const value = await refreshed({ action: {
      "thread.get": async ({ threadId }) => response({ result: {
        threadId, activeRuns: [{ runId: "run-active", status: "running" }],
      } }),
      "thread.stop": async () => response({ result: { stopped: true } }),
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.stop();

    const stop = value.requests.find((item) => item.action === "thread.stop");
    expect(stop.payload.threadId).toBe("thread-1");
    expect(stop.payload.requestId).toMatch(/^thread\.stop-/);
    expect(value.requests.some((item) => item.action === "run.stop")).toBe(false);
    value.controller.dispose();
  });

  it("filters live frames by selected Thread and the run's actual Conversation", async () => {
    const value = await refreshed({
      summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1" }],
      action: { "run.get": async () => response({ result: { runId: "run-1", conversationId: "fork-conversation" } }) },
    });
    await value.controller.selectThread("thread-1", "conversation-1");

    await value.controller.receiveLive(liveFrame({ threadId: "other-thread" }));
    expect(value.requests.filter((item) => item.action === "run.get")).toHaveLength(0);
    await value.controller.receiveLive(liveFrame({ threadId: "thread-1" }));

    expect(value.requests.filter((item) => item.action === "run.get")).toHaveLength(1);
    expect(value.controller.getSnapshot().live).toEqual([]);
    value.controller.dispose();
  });

  it("drops a run lookup that resolves after the selected Conversation changes", async () => {
    const lookup = deferred();
    const value = await refreshed({
      summaries: [
        { threadId: "thread-1", mainConversationId: "conversation-1" },
        { threadId: "thread-2", mainConversationId: "conversation-2" },
      ],
      action: { "run.get": async () => lookup.promise },
    });
    await value.controller.selectThread("thread-1", "conversation-1");
    const late = value.controller.receiveLive(liveFrame({ messageId: "generation-late", delta: "stale" }));
    await vi.waitFor(() => expect(value.requests.filter((item) => item.action === "run.get")).toHaveLength(1));

    await value.controller.selectThread("thread-2", "conversation-2");
    lookup.resolve(response({ result: { runId: "run-1", conversationId: "conversation-1" } }));
    await late;

    expect(value.controller.getSnapshot().selected).toEqual({ threadId: "thread-2", conversationId: "conversation-2" });
    expect(value.controller.getSnapshot().live).toEqual([]);
    expect(value.services.viewState.get()).toMatchObject({ threadId: "thread-2", conversationId: "conversation-2" });
    value.controller.dispose();
  });

  it("combines ordered deltas of one message into one live entry", async () => {
    const value = await refreshed({
      summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1" }],
      action: { "run.get": async () => response({ result: { runId: "run-1", conversationId: "conversation-1" } }) },
    });
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.receiveLive(liveFrame({ messageId: "generation-a", index: 0, delta: "Hello" }));
    await value.controller.receiveLive(liveFrame({ messageId: "generation-a", index: 1, delta: " world" }));

    const live = value.controller.getSnapshot().live;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ generationKey: "generation-a", text: "Hello world" });
    value.controller.dispose();
  });

  it("resets only the superseded generation, preserving other messages from the same Run", async () => {
    const value = await refreshed({
      summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1" }],
      action: { "run.get": async () => response({ result: { runId: "run-1", conversationId: "conversation-1" } }) },
    });
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.receiveLive(liveFrame({ messageId: "generation-a", delta: "discard me" }));
    await value.controller.receiveLive(liveFrame({ messageId: "generation-b", delta: "keep me" }));
    await value.controller.receiveLive(liveFrame({ type: "stream.reset", messageId: "generation-a", attempt: 1, delta: "" }));

    expect(value.controller.getSnapshot().live.map((item) => item.generationKey)).toEqual(["generation-b"]);
    value.controller.dispose();
  });

  it("separates retry attempts per generation without dropping another message in the Run", async () => {
    const value = await refreshed({
      summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1" }],
      action: { "run.get": async () => response({ result: { runId: "run-1", conversationId: "conversation-1" } }) },
    });
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.receiveLive(liveFrame({ messageId: "generation-a", attempt: 0, index: 0, delta: "old" }));
    await value.controller.receiveLive(liveFrame({ messageId: "generation-b", attempt: 0, index: 0, delta: "other" }));
    await value.controller.receiveLive(liveFrame({ type: "stream.reset", messageId: "generation-a", attempt: 1, delta: "" }));
    await value.controller.receiveLive(liveFrame({ messageId: "generation-a", attempt: 1, index: 0, delta: "retry" }));
    await value.controller.receiveLive(liveFrame({ messageId: "generation-b", attempt: 0, index: 1, delta: "+still valid" }));

    expect(value.controller.getSnapshot().live).toEqual(expect.arrayContaining([
      expect.objectContaining({ generationKey: "generation-a", attempt: 1, text: "retry" }),
      expect.objectContaining({ generationKey: "generation-b", attempt: 0, text: "other+still valid" }),
    ]));
    expect(value.controller.getSnapshot().live).toHaveLength(2);
    value.controller.dispose();
  });

  it("replaces a live generation with its committed message while retaining other live generations", async () => {
    let committed = [];
    const value = await refreshed({
      summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1" }],
      action: {
        "run.get": async () => response({ result: { runId: "run-1", conversationId: "conversation-1" } }),
        "messages.list": async () => response({ result: { items: committed } }),
      },
    });
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.receiveLive(liveFrame({ messageId: "generation-a", delta: "answer" }));
    await value.controller.receiveLive(liveFrame({ messageId: "generation-b", delta: "another answer" }));
    committed = [{ messageId: "message-a", generationKey: "generation-a", role: "assistant", text: "answer" }];
    await value.controller.refresh();

    expect(value.controller.getSnapshot().messages).toEqual(committed);
    expect(value.controller.getSnapshot().live.map((item) => item.generationKey)).toEqual(["generation-b"]);
    value.controller.dispose();
  });

  it("waits for durable history after Run settlement and never revives a terminal Run from late live frames", async () => {
    let status = "running", committed = [], caughtUp = false;
    const value = await refreshed({ action: {
      "run.get": async () => response({ result: { runId: "run-1", conversationId: "conversation-1", status } }),
      "messages.list": async () => response({ result: { items: committed, caughtUp } }),
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.receiveLive(liveFrame({ delta: "provisional answer" }));
    status = "completed"; await value.controller.refresh();
    expect(value.controller.getSnapshot().live).toHaveLength(1);
    await value.controller.receiveLive(liveFrame({ index: 1, delta: "late duplicate" }));
    expect(value.controller.getSnapshot().live[0].text).toBe("provisional answer");
    committed = [{ messageId: "durable-final", runId: "run-1", generationKey: null, isFinal: true, role: "assistant", text: "durable answer" }];
    await value.controller.refresh();
    expect(value.controller.getSnapshot().live).toEqual([]);
    expect(value.controller.getSnapshot().messages).toEqual(committed);
    await value.controller.receiveLive(liveFrame({ messageId: "another-late-generation", delta: "must not return" }));
    expect(value.controller.getSnapshot().live).toEqual([]);
    value.controller.dispose();
  });

  it("settles failed provisional output only when history explicitly catches up", async () => {
    let status = "running", caughtUp = false;
    const value = await refreshed({ action: {
      "run.get": async () => response({ result: { runId: "run-1", conversationId: "conversation-1", status } }),
      "messages.list": async () => response({ result: { items: [], caughtUp } }),
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.receiveLive(liveFrame()); status = "failed"; await value.controller.refresh();
    expect(value.controller.getSnapshot().live).toHaveLength(1);
    caughtUp = true; await value.controller.refresh();
    expect(value.controller.getSnapshot().live).toEqual([]);
    value.controller.dispose();
  });

  it("uses the shared transport subscription and does not leak subscriptions when started twice", async () => {
    const value = fixture();
    const close = vi.fn(); value.transport.subscribe = vi.fn(() => close);
    const stop = value.controller.start(); value.controller.start();
    expect(value.transport.subscribe).toHaveBeenCalledTimes(1);
    expect(value.transport.subscribe.mock.calls[0][0]).toMatchObject({ onEvent: expect.any(Function), onLive: expect.any(Function), onError: expect.any(Function) });
    stop(); stop(); expect(close).toHaveBeenCalledTimes(1);
  });

  it("subscribes to injectable SSE and closes the source on disposal", async () => {
    const sources = [];
    class FakeEventSource {
      constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; sources.push(this); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
      close() { this.closed = true; }
    }
    const value = fixture({
      EventSourceImpl: FakeEventSource,
      summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1" }],
      action: { "run.get": async () => response({ result: { runId: "run-1", conversationId: "conversation-1" } }) },
    });
    const dispose = value.controller.start();
    await value.controller.refresh();
    await value.controller.selectThread("thread-1", "conversation-1");
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("/super-agent/events");
    sources[0].emit("live", liveFrame({ messageId: "generation-sse", delta: "from SSE" }));
    await vi.waitFor(() => expect(value.controller.getSnapshot().live).toHaveLength(1));

    dispose();
    expect(sources[0].closed).toBe(true);
    sources[0].emit("live", liveFrame({ messageId: "generation-after-dispose", delta: "must not arrive" }));
    await Promise.resolve();
    expect(value.controller.getSnapshot().live).toHaveLength(1);
    value.controller.dispose();
  });

  it("discovers an empty fork branch from the Thread graph and opens its Conversation", async () => {
    const value = await refreshed();
    value.services.observations = {
      graph: async threadId => ({
        threadId,
        nodes: [
          { kind: "conversation", conversationId: "conversation-1", threadId },
          { kind: "conversation", conversationId: "conversation-empty", threadId },
        ],
        edges: [{ kind: "fork", fromId: "conversation-1", toId: "conversation-empty", factId: "fork-1" }],
      }),
    };
    await value.controller.selectThread("thread-1", "conversation-1");
    expect(await value.controller.loadBranches()).toEqual([
      { conversationId: "conversation-empty", forkedFromConversationId: "conversation-1", startedAt: null },
    ]);
    expect(value.controller.getSnapshot().branchesLoaded).toBe(true);
    await value.controller.selectThread("thread-1", "conversation-empty");
    expect(value.controller.getSnapshot().selected).toEqual({ threadId: "thread-1", conversationId: "conversation-empty" });
    value.controller.dispose();
  });

  it("keeps a draft and pending selection when model or thinking changes fail", async () => {
    const pending = { configRevision: "pending-r2", blockingRunId: "run-a", config: { modelId: "model-a", thinkingLevel: "low" } };
    const value = await refreshed({ action: {
      "conversation.get": async () => response({ result: {
        conversationId: "conversation-1", configRevision: "effective-r1", pendingConfig: pending,
        config: { modelId: "model-a", thinkingLevel: "low", cwd: "/workspace" },
      } }),
      "conversation.updateConfig": async () => response({ error: { code: "VERSION_CONFLICT", message: "conversation changed" } }, 409),
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    value.controller.setDraft("keep this exact draft");
    await expect(value.controller.setModel("model-b")).rejects.toThrow("conversation changed");
    await expect(value.controller.setThinking("high")).rejects.toThrow("conversation changed");
    expect(value.controller.getSnapshot().draft).toBe("keep this exact draft");
    expect(value.controller.getSnapshot().conversation.pendingConfig).toEqual(pending);
    expect(value.controller.getSnapshot().conversation.config).toMatchObject({ modelId: "model-a", thinkingLevel: "low" });
    value.controller.dispose();
  });

  it("rejects unsupported thinking levels and discards a pending selection with its exact revision", async () => {
    const pending = { configRevision: "pending-r7", blockingRunId: "run-a", config: { modelId: "model-b", thinkingLevel: "high" } };
    const value = await refreshed({ action: {
      "conversation.get": async () => response({ result: {
        conversationId: "conversation-1", configRevision: "effective-r6", pendingConfig: pending,
        config: { modelId: "model-b", thinkingLevel: "low", cwd: "/workspace" },
      } }),
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    await expect(value.controller.setThinking("off")).rejects.toThrow("不支持");
    expect(value.requests.some(item => item.action === "conversation.updateConfig")).toBe(false);
    await value.controller.discardPendingConfig();
    expect(value.requests.find(item => item.action === "conversation.discardPending").payload).toMatchObject({
      conversationId: "conversation-1", expectedConfigRevision: "pending-r7",
    });
    value.controller.dispose();
  });

  it("invalidates a Run diff when the file branch revision or current snapshot changes", async () => {
    let branchRevision = 1, currentSnapshotId = "current-1", reads = 0;
    const run = {
      runId: "run-1", conversationId: "conversation-1", status: "completed",
      fileBinding: { inputSnapshotId: "input-1", resultSnapshotId: "result-1", branchId: "branch-1", branchRevision: 1 },
    };
    const artifacts = {
      run: { runId: "run-1", status: "succeeded", branchId: "branch-1", branchRevision: 1,
        inputSnapshotId: "input-1", resultSnapshotId: "result-1" },
      inputSnapshot: { snapshotId: "input-1" }, resultSnapshot: { snapshotId: "result-1" },
      files: [{ path: "note.txt", before: { hash: "before-hash" }, after: { hash: "after-hash" } }],
    };
    const value = await refreshed({ summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1" }], action: {
      "thread.get": async () => response({ result: { threadId: "thread-1", runs: [{ runId: "run-1", conversationId: "conversation-1" }], activeRuns: [] } }),
      "run.get": async () => response({ result: run }),
      "files.run": async () => response({ result: { runId: "run-1", revision: 3, resultSnapshotId: "result-1" } }),
      "files.artifacts": async () => response({ result: artifacts }),
      "files.branch.get": async () => response({ result: { branchId: "branch-1", conversationId: "conversation-1",
        revision: branchRevision, currentSnapshotId } }),
      "files.snapshot": async payload => response({ result: { snapshotId: payload.snapshotId,
        manifest: { files: [{ path: "note.txt", hash: currentSnapshotId }] } } }),
      "files.read": async payload => {
        reads++;
        const content = payload.snapshotId === "input-1" ? "before\n" : "after\n";
        return response({ result: { dataBase64: Buffer.from(content).toString("base64") } });
      },
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    const first = await value.controller.loadRunDiff("run-1");
    expect(first).toMatchObject({ branch: { revision: 1, currentSnapshotId: "current-1" } });
    expect(first.files[0]).toMatchObject({ additions: 1, deletions: 1, status: "available" });
    expect(reads).toBe(2);

    branchRevision = 2;
    currentSnapshotId = "current-2";
    const second = await value.controller.loadRunDiff("run-1");
    expect(second).toMatchObject({ branch: { revision: 2, currentSnapshotId: "current-2" } });
    expect(second.files[0].current).toMatchObject({ hash: "current-2" });
    expect(reads).toBe(4);
    value.controller.dispose();
  });

  it("labels binary, expired and unsettled partial file results without inventing text counts", async () => {
    const run = {
      runId: "run-1", conversationId: "conversation-1", status: "running",
      fileBinding: { inputSnapshotId: "input-1", resultSnapshotId: "result-1", branchId: "branch-1", branchRevision: 1 },
    };
    const artifacts = {
      run: { runId: "run-1", status: "running", branchId: "branch-1", branchRevision: 1,
        inputSnapshotId: "input-1", resultSnapshotId: "result-1" },
      inputSnapshot: { snapshotId: "input-1" }, resultSnapshot: { snapshotId: "result-1" },
      files: [
        { path: "image.bin", before: { hash: "b1" }, after: { hash: "b2" } },
        { path: "old.txt", before: { hash: "o1" }, after: { hash: "o2" } },
        { path: "partial.txt", before: { hash: "p1" }, after: { hash: "p2" } },
      ],
    };
    const value = await refreshed({ summaries: [{ threadId: "thread-1", mainConversationId: "conversation-1" }], action: {
      "thread.get": async () => response({ result: { threadId: "thread-1", activeRuns: ["run-1"],
        runs: [{ runId: "run-1", conversationId: "conversation-1" }] } }),
      "run.get": async () => response({ result: run }),
      "files.run": async () => response({ result: { runId: "run-1", revision: 1, resultSnapshotId: "result-1" } }),
      "files.artifacts": async () => response({ result: artifacts }),
      "files.branch.get": async () => response({ result: { branchId: "branch-1", conversationId: "conversation-1",
        revision: 1, currentSnapshotId: "current-1" } }),
      "files.snapshot": async () => response({ result: { snapshotId: "current-1", manifest: { files: [] } } }),
      "files.read": async payload => {
        if (payload.path === "image.bin") return response({ result: { dataBase64: "AA==" } });
        if (payload.path === "old.txt") return response({ error: { code: "NOT_FOUND",
          message: "content expired", details: { status: "expired" } } }, 404);
        const content = payload.snapshotId === "input-1" ? "before\n" : "before\nafter\n";
        return response({ result: { dataBase64: Buffer.from(content).toString("base64") } });
      },
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    const diff = await value.controller.loadRunDiff("run-1");
    const byPath = new Map(diff.files.map(file => [file.path, file]));
    expect(byPath.get("image.bin")).toMatchObject({ status: "binary", binary: true, additions: null, deletions: null });
    expect(byPath.get("old.txt")).toMatchObject({ status: "expired", error: "content expired", additions: null, deletions: null });
    expect(byPath.get("partial.txt")).toMatchObject({ status: "partial", additions: 1, deletions: 0 });
    expect(value.requests.some(item => ["files.rollback", "run.redo", "conversation.fork", "input.submit"].includes(item.action))).toBe(false);
    value.controller.dispose();
  });
});

describe("conversation file review", () => {
  async function reviewFixture(extra = {}) {
    const runs = [
      { runId: "read", status: "completed" },
      { runId: "write", status: "completed" },
      { runId: "answer", status: "completed" },
      { runId: "running", status: "running" },
      { runId: "foreign", status: "completed", conversationId: "other" },
    ].map(run => ({ conversationId: "conversation-1", fileBinding: { inputSnapshotId: "input" }, ...run }));
    const value = await refreshed({ action: {
      "thread.get": async () => response({ result: { runs, activeRuns: [] } }),
      "run.get": async ({ runId }) => response({ result: runs.find(run => run.runId === runId) }),
      "files.artifacts": async ({ runId }) => response({ result: { run: { runId }, files: runId === "write" ? [{ path: "src/retry.ts" }] : [] } }),
      ...extra,
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    return value;
  }

  it("opens the most recent nonempty completed change, not the most recent answer", async () => {
    const value = await reviewFixture();
    expect(await value.controller.listDiffRuns()).toEqual([{ runId: "write", round: 2, fileCount: 1 }]);
    await value.controller.openLatestDiff();
    expect(value.controller.getSnapshot().diffSelection).toEqual({ runId: "write", filePath: null });
    expect(value.requests.filter(item => item.action === "files.artifacts").every(item => !["running", "foreign"].includes(item.payload.runId))).toBe(true);
    expect(value.requests.some(item => ["files.read", "files.rollback", "input.submit"].includes(item.action))).toBe(false);
    value.controller.dispose();
  });

  it("keeps exact card selection and reports an empty conversation without opening the wrong round", async () => {
    const value = await reviewFixture({ "files.artifacts": async ({ runId }) => response({ result: { run: { runId }, files: [] } }) });
    await value.controller.openDiff("read", "exact.txt");
    await expect(value.controller.openLatestDiff()).rejects.toThrow("当前对话暂无文件变更");
    expect(value.controller.getSnapshot().diffSelection).toEqual({ runId: "read", filePath: "exact.txt" });
    value.controller.dispose();
  });

  it("rejects a late change index after switching conversations", async () => {
    const pending = deferred();
    const value = await reviewFixture({ "files.artifacts": async ({ runId }) => { await pending.promise; return response({ result: { run: { runId }, files: [{ path: "a" }] } }); } });
    const result = value.controller.openLatestDiff();
    const rejected = expect(result).rejects.toThrow("对话已切换");
    value.controller.newConversation("/workspace");
    pending.resolve();
    await rejected;
    expect(value.controller.getSnapshot().diffSelection).toBeNull();
    value.controller.dispose();
  });

  it("keeps healthy changes reachable when another round's metadata is unavailable", async () => {
    const value = await reviewFixture({ "files.artifacts": async ({ runId }) => {
      if (runId === "read") throw new Error("expired old result");
      return response({ result: { run: { runId }, files: runId === "write" ? [{ path: "a" }] : [] } });
    } });
    expect(await value.controller.listDiffRuns()).toEqual([
      { runId: "read", round: 1, fileCount: null, error: "变更信息读取失败" },
      { runId: "write", round: 2, fileCount: 1 },
    ]);
    await value.controller.openLatestDiff();
    expect(value.controller.getSnapshot().diffSelection.runId).toBe("write");
    value.controller.dispose();
  });

  it("persists a bounded review width without submitting a Core command", async () => {
    const records = new Map();
    const storage = { getItem: key => records.get(key), setItem: (key, value) => records.set(key, value) };
    const value = fixture({ storage });
    value.controller.setDiffWidth(567.8);
    expect(JSON.parse(records.get("super-agent.space.v1")).diffWidth).toBe(568);
    expect(fixture({ storage }).controller.getSnapshot().diffWidth).toBe(568);
    value.controller.setDiffWidth(2000);
    expect(value.controller.getSnapshot().diffWidth).toBe(960);
    expect(() => value.controller.setDiffWidth(NaN)).toThrow("有效数字");
    expect(value.requests).toEqual([]);
    value.controller.dispose();
  });
});

describe("task file line diff", () => {
  it("keeps source order and does not invent a trailing empty line", () => {
    const diff = lineDiff("a\n", "a\nb\n");
    expect(diff.rows).toEqual([
      { kind: "same", oldLine: 1, newLine: 1, text: "a" },
      { kind: "add", oldLine: null, newLine: 2, text: "b" },
    ]);
    expect(diff).toMatchObject({ additions: 1, deletions: 0, limited: false });
  });

  it("reports additions, removals, replacements, empty files and CRLF input exactly once", () => {
    expect(lineDiff("one\r\nthree\r\n", "one\r\ntwo\r\nthree\r\n")).toMatchObject({
      additions: 1,
      deletions: 0,
      rows: [
        { kind: "same", oldLine: 1, newLine: 1, text: "one" },
        { kind: "add", oldLine: null, newLine: 2, text: "two" },
        { kind: "same", oldLine: 2, newLine: 3, text: "three" },
      ],
    });
    expect(lineDiff("a\nb\n", "")).toMatchObject({
      additions: 0,
      deletions: 2,
      rows: [
        { kind: "remove", oldLine: 1, newLine: null, text: "a" },
        { kind: "remove", oldLine: 2, newLine: null, text: "b" },
      ],
    });
    expect(lineDiff("", "a\n")).toMatchObject({
      additions: 1,
      deletions: 0,
      rows: [{ kind: "add", oldLine: null, newLine: 1, text: "a" }],
    });
    const replaced = lineDiff("a\nold\nc\n", "a\nnew\nc\n");
    expect(replaced.rows.filter(row => row.kind === "same")).toHaveLength(2);
    expect(replaced).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("limits very large files without claiming exact counts", () => {
    const before = Array.from({ length: 2200 }, (_, index) => `before-${index}`).join("\n");
    const after = Array.from({ length: 2200 }, (_, index) => `after-${index}`).join("\n");
    const diff = lineDiff(before, after);
    expect(diff.limited).toBe(true);
    expect(diff.rows.length).toBeLessThanOrEqual(4000);
    expect(diff.additions).toBeNull();
    expect(diff.deletions).toBeNull();
  });
});


describe("materials and independent wait actions", () => {
  it("shows and resolves a verified child Run's independent wait without accepting another Thread's wait", async () => {
    const child = { runId: "child-run", conversationId: "child-conversation" };
    const wait = { waitId: "child-wait", ...child, kind: "permission", status: "waiting", expiresAt: "2020-01-01T00:00:00Z" };
    const value = await refreshed({ action: {
      "thread.get": async () => response({ result: { threadId: "thread-1", runs: [child], activeRuns: [child.runId] } }),
      "waits.list": async payload => response({ result: { items: payload.status === "waiting" ? [wait, { ...wait, waitId: "foreign", conversationId: "foreign-conversation" }] : [] } }),
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    expect(value.controller.getSnapshot().waits.map(w => w.waitId)).toEqual(["child-wait"]);
    await value.controller.renewApproval(wait);
    await value.controller.resolveWait(wait, { decision: "allow" });
    await value.controller.resolveWait({ ...wait, kind: "file_input" }, { snapshotId: "child-snapshot", sourcePath: "README.md" });
    expect(value.requests.find(r => r.action === "wait.provideFile").payload.conversationId).toBe("child-conversation");
    expect(value.requests.find(r => r.action === "wait.resolve").payload.waitId).toBe("child-wait");
    await expect(value.controller.resolveWait({ ...wait, conversationId: "foreign-conversation" }, { decision: "allow" })).rejects.toThrow("已核实任务");
    await expect(value.controller.renewApproval({ ...wait, runId: "foreign-run" })).rejects.toThrow("已核实任务");
    value.controller.newConversation("");
    await expect(value.controller.resolveWait(wait, { decision: "allow" })).rejects.toThrow("已核实任务");
    value.controller.dispose();
  });
  it("returns a confirmed input receipt and returns null while retaining a failed original input", async () => {
    let fail = true;
    const value = await refreshed({ action: { "input.submit": async () => fail ? response({ error: { code: "TIMEOUT", message: "unknown original receipt" } }, 504) : response({ result: { requestId: "accepted-input", resourceId: "run-accepted", state: "accepted" } }) } });
    value.controller.newConversation(""); value.controller.setDraft("real validation");
    expect(await value.controller.send()).toBeNull();
    expect(value.controller.getSnapshot().draft).toBe("real validation");
    fail = false;
    expect(await value.controller.send()).toMatchObject({ requestId: "accepted-input", state: "accepted" });
    const inputs = value.requests.filter(item => item.action === "input.submit");
    expect(inputs[0].payload).toEqual(inputs[1].payload);
  });

  it("freezes material versions and explicit Skills with the original input request", async () => {
    let fail = true;
    const value = await refreshed({ action: { "input.submit": async () => fail ? response({ error: { code: "TIMEOUT", message: "receipt unknown" } }, 504) : response({ result: { accepted: true } }) } });
    const materials = [{ kind: "image", snapshotId: "fixed-snapshot", path: "diagram.png", mediaType: "image/png" }];
    value.controller.setMaterials(materials); value.controller.setSelectedSkills(["skill@hash"]); value.controller.setDraft("read fixed input");
    await value.controller.send();
    const first = value.requests.find(request => request.action === "input.submit").payload;
    expect(first).toMatchObject({ materials, selectedSkillIds: ["skill@hash"] });
    value.controller.setMaterials([{ ...materials[0], snapshotId: "different-version" }]); await value.controller.send();
    expect(value.requests.filter(request => request.action === "input.submit")).toHaveLength(1);
    expect(value.controller.getSnapshot().error).toContain("原输入回执");
    value.controller.setMaterials(materials); fail = false; await value.controller.send();
    expect(value.requests.filter(request => request.action === "input.submit")[1].payload).toEqual(first);
    expect(value.controller.getSnapshot().materials).toEqual([]);
  });

  it("keeps questions, approvals, and real file provision as distinct commands", async () => {
    const value = await refreshed(); await value.controller.selectThread("thread-1", "conversation-1");
    const wait = { waitId: "wait", conversationId: "conversation-1", status: "waiting" };
    await value.controller.resolveWait({ ...wait, kind: "user" }, { answer: "yes" });
    await value.controller.resolveWait({ ...wait, kind: "permission" }, { decision: "deny" });
    await value.controller.resolveWait({ ...wait, kind: "file_input" }, { snapshotId: "published", sourcePath: "evidence.txt" });
    expect(value.requests.filter(item => item.action.startsWith("wait.")).map(item => item.action)).toEqual(["wait.answer", "wait.resolve", "wait.provideFile"]);
    const provision = value.requests.find(item => item.action === "wait.provideFile").payload;
    expect(provision).toMatchObject({ conversationId: "conversation-1", snapshotId: "published", sourcePath: "evidence.txt" });
    expect(provision).not.toHaveProperty("answer");
  });

  it("provisions a new branch without resolving or retrying the original task", async () => {
    const value = await refreshed({ action: { "wait.provideFile": async () => response({ result: { requestId: "r", newBranch: { runId: "branch-run", conversationId: "branch-conversation" } } }) } });
    await value.controller.selectThread("thread-1", "conversation-1");
    const receipt = await value.controller.resolveWait({ waitId: "file-wait", kind: "file_input", conversationId: "conversation-1", status: "waiting" }, { snapshotId: "next-version", sourcePath: "required.txt", mode: "new_branch" });
    expect(value.requests.find(item => item.action === "wait.provideFile").payload).toMatchObject({ mode: "new_branch", snapshotId: "next-version", sourcePath: "required.txt" });
    expect(receipt.newBranch.runId).toBe("branch-run");
    expect(value.requests.some(item => ["wait.answer", "wait.resolve", "run.redo", "thread.resume"].includes(item.action))).toBe(false);
  });

  it("records unknown-execution evidence and renews expired approvals without resuming or replaying", async () => {
    const value = await refreshed(); await value.controller.selectThread("thread-1", "conversation-1");
    await value.controller.verifyExecution({ executionId: "exec", conversationId: "conversation-1", status: "unknown" }, { conclusion: "not_executed", evidence: "checked actual filesystem" });
    await value.controller.renewApproval({ waitId: "expired", conversationId: "conversation-1", kind: "permission", status: "waiting", expiresAt: "2020-01-01T00:00:00Z" });
    expect(value.requests.find(item => item.action === "execution.verify").payload).toMatchObject({ threadId: "thread-1", executionId: "exec", conclusion: "not_executed", evidence: "checked actual filesystem" });
    expect(value.requests.some(item => ["thread.resume", "run.redo", "input.submit"].includes(item.action))).toBe(false);
  });

  it("shows and verifies a child unknown execution by its real Thread ownership and retains an uncertain verification request", async () => {
    const child = { runId: "child-run", conversationId: "child-conversation" };
    const execution = { executionId: "child-execution", ...child, status: "unknown" };
    let fail = true;
    const value = await refreshed({ action: {
      "thread.get": async () => response({ result: { threadId: "thread-1", runs: [child], activeRuns: [child.runId] } }),
      "executions.list": async () => response({ result: [execution, { ...execution, executionId: "foreign-execution", conversationId: "foreign-conversation" },
        { ...execution, executionId: "wrong-pair", runId: "foreign-run" }] }),
      "execution.verify": async () => fail ? response({ error: { code: "TIMEOUT", message: "verification receipt unknown" } }, 504) : response({ result: { state: "accepted" } }),
    } });
    await value.controller.selectThread("thread-1", "conversation-1");
    expect(value.controller.getSnapshot().executions.map(item => item.executionId)).toEqual(["child-execution"]);
    const evidence = { conclusion: "not_executed", evidence: "Checked the real child execution scope after restart." };
    await expect(value.controller.verifyExecution(execution, evidence)).rejects.toThrow("verification receipt unknown");
    await expect(value.controller.verifyExecution(execution, { ...evidence, conclusion: "succeeded" })).rejects.toThrow("核验回执尚未确认");
    fail = false;
    await value.controller.verifyExecution(execution, evidence);
    const submitted = value.requests.filter(item => item.action === "execution.verify");
    expect(submitted).toHaveLength(2); expect(submitted[0].payload).toEqual(submitted[1].payload);
    expect(submitted[1].payload).toMatchObject({ threadId: "thread-1", executionId: "child-execution", ...evidence });
    await expect(value.controller.verifyExecution({ ...execution, conversationId: "foreign-conversation" }, evidence)).rejects.toThrow("已核实任务");
    await expect(value.controller.verifyExecution({ ...execution, runId: "foreign-run" }, evidence)).rejects.toThrow("已核实任务");
    await expect(value.controller.verifyExecution({ ...execution, status: "running" }, evidence)).rejects.toThrow("结果未知");
    expect(value.requests.some(item => ["thread.resume", "wait.resolve", "run.redo", "input.submit"].includes(item.action))).toBe(false);
    value.controller.newConversation("");
    await expect(value.controller.verifyExecution(execution, evidence)).rejects.toThrow("已核实任务");
    value.controller.dispose();
  });

  it("reads answered and cancelled waits explicitly and keeps pending actions when one history state fails", async () => {
    const value = await refreshed({ action: { "waits.list": async payload => payload.status === "cancelled" ? response({ error: { code: "UNAVAILABLE", message: "history failed" } }, 503) : response({ result: { items: [{ waitId: payload.status, status: payload.status, kind: "user", conversationId: "conversation-1", ...(payload.status === "answered" ? { answer: "real answer", answeredBy: "user-b", answeredAt: "2026-10-22T00:00:00Z" } : {}) }] } }) } });
    await value.controller.selectThread("thread-1", "conversation-1");
    expect(value.requests.filter(item => item.action === "waits.list").map(item => item.payload.status)).toEqual(["waiting", "answered", "cancelled"]);
    expect(value.controller.getSnapshot().waits).toEqual([expect.objectContaining({ waitId: "waiting" }), expect.objectContaining({ waitId: "answered", answer: "real answer", answeredBy: "user-b" })]);
    expect(value.controller.getSnapshot().historyError).toContain("等待历史部分读取失败");
  });
});


it("uploads browser-selected message bytes in original resumable blocks without binding a project", async () => {
  let manifest, fail = true; const received = new Map();
  const transfer = () => ({ operationId: "message-transfer", missingBlocks: [...new Set(manifest.files.flatMap(file => file.blocks))].filter(hash => !received.has(hash)) });
  const value = await refreshed({ action: {
    "files.transfer.create": async payload => { manifest = payload.manifest; expect(payload.workspaceId).toMatch(/^message:/); return response({ result: transfer() }); },
    "files.transfer.get": async () => response({ result: transfer() }),
    "files.transfer.upload": async payload => { if (fail) { fail = false; return response({ error: { code: "TIMEOUT", message: "receipt unknown" } }, 504); } received.set(payload.hash, Buffer.from(payload.dataBase64, "base64")); return response({ result: transfer() }); },
    "files.transfer.commit": async () => response({ result: { snapshotId: "fixed-message-snapshot", manifest } }),
  } });
  value.controller.newConversation("");
  const bytes = new Uint8Array(300000).fill(65), file = new File([bytes], "message.txt", { type: "text/plain" });
  await expect(value.controller.stageMessageFiles([file], "reference")).rejects.toThrow("receipt unknown");
  await value.controller.stageMessageFiles([file], "reference");
  const uploads = value.requests.filter(item => item.action === "files.transfer.upload");
  expect(uploads[0].payload.requestId).toBe(uploads[1].payload.requestId);
  expect(Buffer.concat(manifest.files[0].blocks.map(hash => received.get(hash)))).toEqual(Buffer.from(bytes));
  expect(value.controller.getSnapshot().materials).toEqual([{ kind: "reference", path: "message.txt", source: "本机消息附件:message.txt", snapshotId: "fixed-message-snapshot" }]);
  expect(value.requests.some(item => ["workspace.register", "files.branch.create"].includes(item.action))).toBe(false);
});

it("uses the SDK's unwrapped registered workspace for a message upload without creating a file branch", async () => {
  let manifest;
  const value = await refreshed({ action: {
    "workspace.find": async () => response({ result: { workspaceId: "ws-registered", root: "/workspace", configRevision: "revision" } }),
    "files.transfer.create": async payload => { manifest = payload.manifest; expect(payload.workspaceId).toBe("ws-registered"); return response({ result: { operationId: "registered-upload", missingBlocks: [] } }); },
    "files.transfer.get": async () => response({ result: { operationId: "registered-upload", missingBlocks: [] } }),
    "files.transfer.commit": async () => response({ result: { snapshotId: "registered-message", manifest } }),
  } });
  await value.controller.stageMessageFiles([new File(["test input"], "input.txt", { type: "text/plain" })], "file");
  expect(value.controller.getSnapshot().materials[0].snapshotId).toBe("registered-message");
  expect(value.requests.some(item => ["workspace.register", "files.branch.create"].includes(item.action))).toBe(false);
});

describe("composer attachment drafts", () => {
  const newCapabilities = { runtime: "typescript-pi", supported: true, drafts: true, inputPreview: true, read: true, skillSelection: true, projectFiles: true,
    formats: [{ mediaType: "text/plain", extensions: ["txt"] }, { mediaType: "image/png", extensions: ["png"] }], limits: { maxAttachments: 10, maxTotalBytes: 20 * 1048576 } };
  const prepared = (id, name = "资料.txt") => ({ attachmentId: id, name, draftId: "draft-fixed", status: "ready", mediaType: "text/plain", size: 7, contentHash: `hash-${id}`, representations: [{ representationId: `rep-${id}`, format: "text", status: "available", totalUnits: 1, units: [{ index: 1, kind: "line", text: "资料正文" }] }], warnings: [] });
  const newActions = extra => ({
    "attachments.capabilities": async () => response({ result: newCapabilities }),
    "attachments.drafts.create": async () => response({ result: { draftId: "draft-fixed", expiresAt: Date.now() + 86400000 } }),
    "attachments.prepare": async payload => response({ result: prepared(payload.requestId, payload.name) }),
    "input.preview": async () => response({ result: { planId: "plan-fixed", signature: "signed-plan", canSend: true, targetModel: "model-a", issues: [], items: [], estimatedTokens: 30 } }),
    ...extra,
  });
  it("negotiates unsupported runtimes before listing or selecting Skills and never submits material fields", async () => {
    const value = await refreshed({ action: { "attachments.capabilities": async () => response({ result: { runtime: "go", supported: false, reason: "Go 暂不支持附件与 Skill" } }) } });
    value.controller.newConversation("");
    await expect(value.controller.loadSkillCatalog()).rejects.toThrow("暂不支持");
    expect(value.requests.some(item => item.action === "skills.catalog")).toBe(false);
    expect(() => value.controller.selectSkill({ skillId: "skill", status: "available" }, true)).toThrow("暂不支持");
    expect(() => value.controller.selectSkill({ skillId: "skill" }, false)).not.toThrow();
    value.controller.setDraft("保留任务"); value.controller.setMaterials([{ kind: "file", snapshotId: "old", path: "old.txt" }]);
    await value.controller.send();
    expect(value.controller.getSnapshot().draft).toBe("保留任务");
    expect(value.requests.some(item => ["thread.create", "input.preview", "input.submit"].includes(item.action))).toBe(false); value.controller.dispose();
  });
  it("negotiates restored explicit Skills before sending and runs modern preview while preserving legacy text support", async () => {
    const skill = { skillId: "skill-fixed", status: "available", sourceId: "reviewed-source", snapshotId: "frozen-v1", sourceRevision: 1, policyRevision: 1 };
    const value = await refreshed({ action: newActions({ "skills.catalog": async () => response({ result: { items: [skill] } }) }) }); value.controller.newConversation("");
    value.controller.setDraft("用已选 Skill 完成任务"); value.controller.selectSkill(skill, true);
    await value.controller.send();
    expect(value.requests.find(item => item.action === "input.submit").payload.previewId).toBe("plan-fixed"); value.controller.dispose();
    const legacy = await refreshed(); legacy.controller.newConversation(""); legacy.controller.setDraft("纯文本任务");
    await legacy.controller.send();
    expect(legacy.requests.some(item => item.action === "input.submit")).toBe(true);
    expect(legacy.requests.some(item => item.action === "attachments.capabilities")).toBe(false); legacy.controller.dispose();
  });
  it("rejects a retained modern Skill id without its reviewed source instead of resolving a different workspace version", async () => {
    const value = await refreshed({ action: newActions() }); value.controller.newConversation("");
    value.controller.setDraft("范围变化后保留任务"); value.controller.setSelectedSkills(["skill-fixed"]);
    await expect(value.controller.previewInput()).rejects.toThrow("固定来源与版本");
    await value.controller.send();
    expect(value.controller.getSnapshot()).toMatchObject({ draft: "范围变化后保留任务", selectedSkillIds: ["skill-fixed"], error: expect.stringContaining("固定来源与版本") });
    expect(value.requests.some(item => ["attachments.drafts.create", "input.preview", "thread.create", "input.submit"].includes(item.action))).toBe(false); value.controller.dispose();
  });
  it("rejects an old workspace source even when all its frozen reference fields are still present", async () => {
    const old = { skillId: "scope-check", status: "available", workspaceId: "workspace-a", sourceId: "source-a", snapshotId: "a-v1", sourceRevision: 1, policyRevision: 1 };
    const value = await refreshed({ action: newActions({ "skills.catalog": async () => response({ result: { items: [{ ...old, workspaceId: null, sourceId: "global", snapshotId: "global-v1" }] } }) }) });
    value.controller.newConversation("/workspace-b"); value.controller.selectSkill(old, true); value.controller.setDraft("保留旧范围选择");
    await expect(value.controller.previewInput()).rejects.toThrow("适用范围已变化"); await value.controller.send();
    expect(value.controller.getSnapshot().selectedSkills[0].sourceId).toBe("source-a");
    expect(value.requests.some(item => ["attachments.drafts.create", "input.preview", "thread.create", "input.submit"].includes(item.action))).toBe(false); value.controller.dispose();
  });
  it("keeps the latest context preview when an earlier mode calculation finishes late", async () => {
    const old = deferred(); let count = 0;
    const value = await refreshed({ action: newActions({ "input.preview": async () => { const current = ++count; if (current === 1) await old.promise; return response({ result: { planId: current === 1 ? "old-plan" : "new-plan", signature: "signed", canSend: true, items: [] } }); } }) });
    value.controller.newConversation(""); value.controller.setDraft("原正文");
    const earlier = value.controller.previewInput(); const rejected = expect(earlier).rejects.toMatchObject({ code: "PREVIEW_SUPERSEDED" });
    await vi.waitFor(() => expect(count).toBe(1)); value.controller.setDraft("新正文");
    await value.controller.previewInput(); old.resolve(); await rejected;
    expect(value.controller.getSnapshot()).toMatchObject({ inputPreview: { planId: "new-plan" }, previewError: "", previewLoading: false }); value.controller.dispose();
  });
  it("accepts an identified PNG when the service advertises image wildcards", async () => {
    const value = await refreshed({ action: newActions({ "attachments.capabilities": async () => response({ result: { ...newCapabilities, formats: [{ mediaType: "image/*", extensions: [".png"] }] } }) }) });
    value.controller.newConversation("");
    await value.controller.addMessageFiles([new File([new Uint8Array([137,80,78,71,13,10,26,10])], "pasted.png", { type: "image/png" })]);
    expect(value.requests.filter(item => item.action === "attachments.prepare")).toHaveLength(1);
    expect(value.controller.getSnapshot().attachments[0].status).toBe("ready"); value.controller.dispose();
  });
  it("sends real empty text with negotiated prepared references and preserves the original plan on a lost receipt", async () => {
    let first = true;
    const value = await refreshed({ action: newActions({ "input.submit": async () => { if (first) { first = false; return response({ error: { code: "TIMEOUT", message: "receipt lost" } }, 504); } return response({ result: { accepted: true } }); } }) });
    value.controller.newConversation("");
    await value.controller.addMessageFiles([new File(["资料正文"], "资料.txt", { type: "text/plain" })]);
    expect(value.controller.getSnapshot().attachments[0]).toMatchObject({ status: "ready", mode: "auto" });
    await value.controller.send();
    const submitted = value.requests.filter(item => item.action === "input.submit");
    expect(submitted).toHaveLength(1);
    expect(submitted[0].payload).toMatchObject({ text: "", previewId: "plan-fixed", previewSignature: "signed-plan", preparedAttachments: [{ attachmentId: expect.any(String) }] });
    expect(submitted[0].payload).not.toHaveProperty("materials");
    const preview = value.requests.find(item => item.action === "input.preview").payload;
    expect(preview).toMatchObject({ text: "", draftId: "draft-fixed", attachments: [{ attachmentId: expect.any(String) }] });
    expect(preview).not.toHaveProperty("preparedAttachments"); expect(preview).not.toHaveProperty("model");
    await value.controller.send();
    expect(value.requests.filter(item => item.action === "input.submit")[1].payload).toEqual(submitted[0].payload);
    expect(value.requests.filter(item => item.action === "thread.create")).toHaveLength(1);
    expect(value.requests.filter(item => item.action === "input.preview")).toHaveLength(1);
    expect(value.controller.getSnapshot().attachments).toEqual([]); value.controller.dispose();
  });
  it("releases only a confirmed stale preflight rejection so the preserved draft can be reviewed and submitted again", async () => {
    let first = true;
    const value = await refreshed({ action: newActions({ "input.submit": async () => {
      if (first) { first = false; return response({ error: { code: "INVALID_REQUEST", message: "preview changed", details: { reason: "INPUT_PREVIEW_STALE", operationAccepted: false, phase: "input_preflight" } } }, 400); }
      return response({ result: { accepted: true } });
    } }) });
    value.controller.newConversation(""); await value.controller.addMessageFiles([new File(["资料正文"], "资料.txt")]);
    await value.controller.send();
    expect(value.controller.getSnapshot()).toMatchObject({ inputPreview: null, error: expect.stringContaining("尚未接收") });
    expect(value.controller.getSnapshot().attachments).toHaveLength(1);
    value.controller.setDraft("重新审阅后发送"); await value.controller.previewInput(); await value.controller.send();
    const submitted = value.requests.filter(item => item.action === "input.submit");
    expect(submitted).toHaveLength(2); expect(submitted[1].payload.requestId).not.toBe(submitted[0].payload.requestId);
    expect(submitted[1].payload.text).toBe("重新审阅后发送"); expect(value.controller.getSnapshot().attachments).toEqual([]); value.controller.dispose();
  });
  it("keeps per-file failures and the text, blocks partial sends, and retries with the original prepare request", async () => {
    let fail = true;
    const value = await refreshed({ action: newActions({ "attachments.prepare": async payload => payload.name === "bad.txt" && fail ? response({ error: { code: "UNAVAILABLE", message: "prepare interrupted" } }, 503) : response({ result: prepared(payload.requestId, payload.name) }) }) });
    value.controller.newConversation(""); value.controller.setDraft("请分析两份资料");
    await value.controller.addMessageFiles([new File(["first"], "good.txt"), new File(["second"], "bad.txt")]);
    const cards = value.controller.getSnapshot().attachments;
    expect(cards.map(item => item.status)).toEqual(["ready", "failed"]);
    await value.controller.send(); expect(value.requests.some(item => item.action === "input.submit")).toBe(false);
    expect(value.controller.getSnapshot().draft).toBe("请分析两份资料");
    fail = false; await value.controller.retryAttachment(cards[1].id);
    const attempts = value.requests.filter(item => item.action === "attachments.prepare" && item.payload.name === "bad.txt");
    expect(attempts[0].payload.requestId).toBe(attempts[1].payload.requestId);
    await value.controller.send(); expect(value.requests.find(item => item.action === "input.submit").payload.preparedAttachments).toHaveLength(2); value.controller.dispose();
  });
  it("allows same names with distinct content and detects duplicate bytes rather than overwriting", async () => {
    const value = await refreshed({ action: newActions() }); value.controller.newConversation("");
    await value.controller.addMessageFiles([new File(["one"], "same.txt"), new File(["two"], "same.txt"), new File(["one"], "other.txt")]);
    const cards = value.controller.getSnapshot().attachments;
    expect(cards.map(item => item.status)).toEqual(["ready", "ready", "duplicate"]);
    expect(cards[0].sha256).not.toBe(cards[1].sha256);
    expect(value.requests.filter(item => item.action === "attachments.prepare")).toHaveLength(2);
    await value.controller.removeAttachment(cards[2].id);
    expect(value.controller.getSnapshot().attachments).toHaveLength(2); value.controller.dispose();
  });
  it("returns late preparation to the original conversation while leaving the new conversation untouched", async () => {
    const pending = deferred();
    const value = await refreshed({ action: newActions({ "attachments.prepare": async payload => { await pending.promise; return response({ result: prepared(payload.requestId, payload.name) }); } }) });
    await value.controller.selectThread("thread-one", "conversation-one");
    const upload = value.controller.addMessageFiles([new File(["fixed old content"], "old.txt")]);
    await vi.waitFor(() => expect(value.requests.some(item => item.action === "attachments.prepare")).toBe(true));
    await value.controller.selectThread("thread-two", "conversation-two");
    pending.resolve(); await upload;
    expect(value.controller.getSnapshot().attachments).toEqual([]);
    await value.controller.selectThread("thread-one", "conversation-one");
    expect(value.controller.getSnapshot().attachments[0]).toMatchObject({ name: "old.txt", status: "ready" }); value.controller.dispose();
  });
  it("rejects a changed replacement after refresh without mixing its bytes into the original operation", async () => {
    const cache = new Map(), storage = { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value) };
    const first = await refreshed({ storage, action: newActions({ "attachments.prepare": async () => response({ error: { code: "TIMEOUT", message: "unknown" } }, 504) }) });
    first.controller.newConversation(""); await first.controller.addMessageFiles([new File(["original"], "file.txt")]);
    const id = first.controller.getSnapshot().attachments[0].id; first.controller.dispose();
    const restored = await refreshed({ storage, action: newActions() });
    expect(await restored.controller.retryAttachment(id)).toEqual({ needsFile: true });
    await restored.controller.retryAttachment(id, new File(["changed"], "file.txt"));
    expect(restored.controller.getSnapshot().attachments[0]).toMatchObject({ status: "failed", error: expect.stringContaining("内容已变化") });
    expect(restored.requests.some(item => item.action === "attachments.prepare")).toBe(false); restored.controller.dispose();
  });
  it("blocks a rejected context plan before creating a task and preserves the fixed attachments", async () => {
    const value = await refreshed({ action: newActions({ "input.preview": async () => response({ result: { planId: "blocked", signature: "signature", canSend: false, issues: ["The target model does not support images"], items: [] } }) }) });
    value.controller.newConversation(""); await value.controller.addMessageFiles([new File(["fixed"], "file.txt")]);
    await value.controller.send();
    expect(value.controller.getSnapshot().error).toContain("does not support images");
    expect(value.requests.some(item => ["thread.create", "input.submit"].includes(item.action))).toBe(false);
    expect(value.controller.getSnapshot().attachments[0].status).toBe("ready"); value.controller.dispose();
  });
  it("uses only the read-only Skill catalog and freezes the selected source, package and revisions", async () => {
    const skill = { skillId: "review", name: "Review", sourceIds: ["source"], sourceId: "source", snapshotId: "fixed-package", sourceRevision: 3, policyRevision: 4, status: "available" };
    const value = await refreshed({ action: newActions({ "skills.catalog": async () => response({ result: { items: [skill] } }) }) });
    value.controller.newConversation(""); await value.controller.loadAttachmentCapabilities();
    const [catalogSkill] = await value.controller.loadSkillCatalog(); value.controller.selectSkill(catalogSkill, true); value.controller.setDraft("审查这段逻辑"); await value.controller.send();
    expect(value.requests.some(item => item.action === "skills.scan")).toBe(false);
    const refs = [{ skillId: "review", sourceId: "source", version: "fixed-package", sourceRevision: 3, policyRevision: 4 }];
    expect(value.requests.find(item => item.action === "input.preview").payload.selectedSkillRefs).toEqual(refs);
    expect(value.requests.find(item => item.action === "input.submit").payload.selectedSkillRefs).toEqual(refs); value.controller.dispose();
  });
  it("converts only the selected material after complete preparation and leaves task instructions on failure", async () => {
    const value = await refreshed({ action: newActions() }); value.controller.newConversation(""); value.controller.setDraft("任务：总结。资料正文。保留要求");
    await value.controller.convertSelectionToAttachment(6, 11);
    expect(value.controller.getSnapshot().draft).toBe("任务：总结。保留要求");
    expect(Buffer.from(value.requests.find(item => item.action === "attachments.prepare").payload.dataBase64, "base64").toString("utf8")).toBe("资料正文。"); value.controller.dispose();
    const failed = await refreshed({ action: newActions({ "attachments.prepare": async () => response({ error: { code: "UNAVAILABLE", message: "storage unavailable" } }, 503) }) });
    failed.controller.newConversation(""); failed.controller.setDraft("任务与完整资料");
    await expect(failed.controller.convertSelectionToAttachment(2, 5)).rejects.toThrow("原正文已保留");
    expect(failed.controller.getSnapshot().draft).toBe("任务与完整资料"); expect(failed.requests.some(item => item.action === "input.submit")).toBe(false); failed.controller.dispose();
  });
  it("prepares an authorized project path without requiring a published snapshot or changing a branch", async () => {
    const value = await refreshed({ action: newActions() });
    await value.controller.addProjectFile(null, { projectPath: true, path: "notes/example.txt", size: 7 });
    expect(value.requests.find(item => item.action === "attachments.prepare").payload).toMatchObject({ draftId: "draft-fixed", projectPath: "notes/example.txt" });
    expect(value.requests.some(item => item.action.startsWith("files.branch"))).toBe(false);
    expect(value.controller.getSnapshot().attachments[0]).toMatchObject({ status: "ready", name: "notes/example.txt" }); value.controller.dispose();
  });
  it("waits for real preparation status and queries the same attachment after an interrupted parse", async () => {
    const value = await refreshed({ action: newActions({
      "attachments.prepare": async payload => response({ result: { ...prepared(payload.requestId, payload.name), status: "preparing", representations: [], operationId: "parse-operation" } }),
      "attachments.get": async payload => response({ result: { ...prepared(payload.attachmentId), operationId: "parse-operation" } }),
    }) });
    value.controller.newConversation(""); await value.controller.addMessageFiles([new File(["fixed"], "file.txt")]);
    expect(value.controller.getSnapshot().attachments[0]).toMatchObject({ status: "ready", operationId: "parse-operation" });
    expect(value.requests.filter(item => item.action === "attachments.prepare")).toHaveLength(1);
    expect(value.requests.filter(item => item.action === "attachments.get")).toHaveLength(1); value.controller.dispose();
  });
  it("blocks a draft after an unknown removal and queries it with the stable original command", async () => {
    let fail = true;
    const value = await refreshed({ action: newActions({ "attachments.remove": async () => { if (fail) { fail = false; return response({ error: { code: "TIMEOUT", message: "unknown remove result" } }, 504); } return response({ result: { removed: true } }); } }) });
    value.controller.newConversation(""); value.controller.setDraft("保留任务"); await value.controller.addMessageFiles([new File(["fixed"], "file.txt")]);
    const card = value.controller.getSnapshot().attachments[0]; await value.controller.removeAttachment(card.id);
    expect(value.controller.getSnapshot().attachments).toEqual([]); expect(value.controller.getSnapshot().attachmentRemovals).toHaveLength(1);
    await value.controller.send(); expect(value.requests.some(item => item.action === "input.submit")).toBe(false);
    await value.controller.resolveAttachmentRemovals();
    const removals = value.requests.filter(item => item.action === "attachments.remove"); expect(removals[0].payload).toEqual(removals[1].payload);
    expect(value.controller.getSnapshot().attachmentRemovals).toEqual([]); value.controller.dispose();
  });
  it("removes a prepared draft item even when its identity arrives after the card was removed", async () => {
    const wait = deferred();
    const value = await refreshed({ action: newActions({ "attachments.prepare": async payload => { await wait.promise; return response({ result: prepared(payload.requestId, payload.name) }); } }) });
    value.controller.newConversation(""); const pending = value.controller.addMessageFiles([new File(["fixed"], "late.txt")]);
    await vi.waitFor(() => expect(value.requests.some(item => item.action === "attachments.prepare")).toBe(true));
    await value.controller.removeAttachment(value.controller.getSnapshot().attachments[0].id); wait.resolve(); await pending;
    expect(value.controller.getSnapshot().attachments).toEqual([]);
    expect(value.requests.find(item => item.action === "attachments.remove").payload).toMatchObject({ draftId: "draft-fixed", attachmentId: expect.any(String) }); value.controller.dispose();
  });
});

it("retries a deletion with the original CAS request after a lost receipt, then restores the same Thread", async () => {
  let current = { threadId: "thread-1", mainConversationId: "conversation-1", controlRevision: 3, status: "completed", activeRuns: [], queuedRuns: [] }, first = true;
  const value = await refreshed({ summaries: [current], action: {
    "thread.get": async () => response({ result: current }),
    "thread.delete": async () => { current = { ...current, controlRevision: 4, deletedAt: "2026-10-22T00:00:00Z", recoverUntil: "2026-11-21T00:00:00Z" }; if (first) { first = false; return response({ error: { code: "TIMEOUT", message: "receipt lost" } }, 504); } return response({ result: { state: "accepted" } }); },
    "thread.restore": async () => { current = { ...current, controlRevision: 5, deletedAt: null, recoverUntil: null }; return response({ result: { state: "accepted" } }); },
  } });
  await expect(value.controller.deleteThread("thread-1")).rejects.toThrow("receipt lost");
  expect(value.controller.getSnapshot().threads[0].deletedAt).toBeUndefined();
  await value.controller.deleteThread("thread-1");
  const deletes = value.requests.filter(item => item.action === "thread.delete");
  expect(deletes[0].payload).toEqual(deletes[1].payload);
  expect(value.controller.getSnapshot().threads[0].deletedAt).toBeTruthy();
  value.controller.setViewOptions({ archiveFilter: "deleted" });
  expect(value.controller.getSnapshot().viewOptions.archiveFilter).toBe("deleted");
  await value.controller.restoreThread("thread-1");
  expect(value.requests.find(item => item.action === "thread.restore").payload).toMatchObject({ threadId: "thread-1", expectedControlRevision: 4 });
  expect(value.controller.getSnapshot().threads[0]).toMatchObject({ threadId: "thread-1", deletedAt: null, recoverUntil: null });
  expect(value.requests.some(item => ["thread.stop", "thread.archive", "thread.create"].includes(item.action))).toBe(false);
});

it("keeps active Threads visible when deletion fails and refuses workspace removal without stopping work", async () => {
  const active = { threadId: "thread-1", mainConversationId: "conversation-1", controlRevision: 2, status: "waiting", activeRuns: ["run"], queuedRuns: [] };
  const value = await refreshed({ summaries: [active], action: { "thread.get": async () => response({ result: active }),
    "thread.delete": async () => response({ error: { code: "RUN_NOT_ACTIVE", message: "wait for terminal work" } }, 409) } });
  await expect(value.controller.deleteThread("thread-1")).rejects.toThrow("wait for terminal work");
  expect(value.controller.getSnapshot().threads[0].deletedAt).toBeUndefined();
  await expect(value.controller.removeWorkspace("/workspace")).rejects.toThrow("仍有运行");
  expect(value.controller.getSnapshot().directories).toEqual([{ root: "/workspace" }]);
  expect(value.requests.some(item => ["thread.stop", "thread.pause", "thread.archive"].includes(item.action))).toBe(false);
});

const managedLocation = (relativePath = "", extra = {}) => ({
  targetId: null, instanceId: "managed-instance-a", connectionKind: "https", baseRoot: "/core-home/workspaces",
  relativePath, root: `/core-home/workspaces${relativePath ? `/${relativePath}` : ""}`, exists: true,
  directories: [], workspaces: [], ...extra,
});
const managedReady = (relativePath, extra = {}) => ({ ...managedLocation(relativePath), workspaceId: "managed-workspace", state: "ready", directoryCreated: true, ...extra });

describe("current Core managed workspace selection", () => {
  it("only browses on open/cancel and selects the returned Core root after registration is ready", async () => {
    const opened = deferred();
    const value = await refreshed({ action: {
      "workspace.managed.browse": async payload => response({ result: managedLocation(payload.relativePath) }),
      "workspace.managed.open": async () => opened.promise,
    } });
    value.controller.setWorkspaceForm(true);
    await value.controller.browseManagedWorkspace("");
    expect(value.controller.getSnapshot().root).toBe("/workspace");
    expect(value.requests.filter(item => item.action === "workspace.managed.open")).toHaveLength(0);
    value.controller.setWorkspaceForm(false);
    expect(value.controller.getSnapshot().root).toBe("/workspace");
    value.controller.setWorkspaceForm(true); await value.controller.browseManagedWorkspace("");
    const pending = value.controller.openManagedWorkspace("team/project");
    expect(value.controller.getSnapshot().root).toBe("/workspace");
    expect(value.controller.getSnapshot().workspaceForm).toBe(true);
    const command = value.requests.find(item => item.action === "workspace.managed.open").payload;
    expect(command).toMatchObject({ targetId: null, expectedInstanceId: "managed-instance-a", relativePath: "team/project", createIfMissing: true });
    opened.resolve(response({ result: managedReady("team/project") }));
    await pending;
    expect(value.controller.getSnapshot()).toMatchObject({ root: "/core-home/workspaces/team/project", workspaceForm: false, workspaceRequest: null });
    expect(value.requests.some(item => ["workspace.register", "thread.create", "input.submit"].includes(item.action))).toBe(false);
    value.controller.dispose();
  });

  it.each(["VERSION_CONFLICT", "INTERNAL", "UPSTREAM_TIMEOUT"])("keeps the original request after an unknown or partial %s response", async code => {
    let attempts = 0;
    const value = await refreshed({ action: {
      "workspace.managed.browse": async payload => response({ result: managedLocation(payload.relativePath) }),
      "workspace.managed.open": async payload => ++attempts === 1 ? response({ error: { code, message: "registration outcome unknown", details: { operationAccepted: true } } }, 500) : response({ result: managedReady(payload.relativePath) }),
    } });
    await value.controller.browseManagedWorkspace("");
    await expect(value.controller.openManagedWorkspace("team/project")).rejects.toThrow("outcome unknown");
    const original = value.controller.getSnapshot().workspaceRequest.requestId;
    expect(value.controller.getSnapshot().root).toBe("/workspace");
    await expect(value.controller.openManagedWorkspace("different/project")).rejects.toThrow("原工作区创建结果尚未确认");
    await value.controller.openManagedWorkspace("team/project");
    const commands = value.requests.filter(item => item.action === "workspace.managed.open");
    expect(commands).toHaveLength(2);
    expect(commands.map(item => item.payload.requestId)).toEqual([original, original]);
    expect(value.controller.getSnapshot().workspaceRequest).toBeNull();
    value.controller.dispose();
  });

  it.each(["validation", "bridge_before_core"])("releases an initial request when %s explicitly confirms that no operation was accepted", async phase => {
    const value = await refreshed({ action: {
      "workspace.managed.browse": async () => response({ result: managedLocation() }),
      "workspace.managed.open": async () => response({ error: { code: "INVALID_REQUEST", message: "pre-admission rejection", details: { operationAccepted: false, phase } } }, 400),
    } });
    await value.controller.browseManagedWorkspace();
    await expect(value.controller.openManagedWorkspace("team/project")).rejects.toThrow("pre-admission");
    expect(value.controller.getSnapshot().workspaceRequest).toBeNull();
    expect(value.controller.getSnapshot().root).toBe("/workspace");
    value.controller.dispose();
  });

  it("keeps an already unknown original id when a later retry is blocked before the Bridge sends it", async () => {
    let count = 0;
    const value = await refreshed({ action: {
      "workspace.managed.browse": async () => response({ result: managedLocation() }),
      "workspace.managed.open": async payload => {
        count++;
        if (count === 1) throw new Error("response lost after Core acceptance");
        if (count === 2) return response({ error: { code: "INSTANCE_CHANGED", message: "Bridge did not send this retry", details: { operationAccepted: false, phase: "bridge_before_core" } } }, 409);
        return response({ result: managedReady(payload.relativePath) });
      },
    } });
    await value.controller.browseManagedWorkspace();
    await expect(value.controller.openManagedWorkspace("team/project")).rejects.toThrow("response lost");
    const original = value.controller.getSnapshot().workspaceRequest.requestId;
    await expect(value.controller.openManagedWorkspace("team/project")).rejects.toThrow("Bridge did not send");
    expect(value.controller.getSnapshot().workspaceRequest).toMatchObject({ requestId: original, uncertain: true });
    await expect(value.controller.openManagedWorkspace("different/project")).rejects.toThrow("原工作区创建结果尚未确认");
    await value.controller.openManagedWorkspace("team/project");
    expect(value.requests.filter(item => item.action === "workspace.managed.open").map(item => item.payload.requestId)).toEqual([original, original, original]);
    value.controller.dispose();
  });

  it("keeps an unresolved request across a browser reload in its original target partition", async () => {
    const data = new Map(), storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
    const first = await refreshed({ storage, action: {
      "workspace.managed.browse": async () => response({ result: managedLocation() }),
      "workspace.managed.open": async () => { throw new Error("connection reset after submission"); },
    } });
    await first.controller.browseManagedWorkspace();
    await expect(first.controller.openManagedWorkspace("team/project")).rejects.toThrow("connection reset");
    const original = first.controller.getSnapshot().workspaceRequest.requestId;
    first.controller.dispose();
    const second = await refreshed({ storage, action: {
      "workspace.managed.browse": async () => response({ result: managedLocation() }),
      "workspace.managed.open": async payload => response({ result: managedReady(payload.relativePath) }),
    } });
    await second.controller.browseManagedWorkspace(); await second.controller.openManagedWorkspace("team/project");
    expect(second.requests.find(item => item.action === "workspace.managed.open").payload.requestId).toBe(original);
    second.controller.dispose();
  });

  it("aborts and discards a late browse when the Core target changes", async () => {
    const late = deferred();
    const value = await refreshed({ action: { "workspace.managed.browse": async () => late.promise } });
    value.controller.setWorkspaceForm(true);
    const browse = value.controller.browseManagedWorkspace();
    value.controller.targetChanged("target-b");
    late.resolve(response({ result: managedLocation() }));
    expect(await browse).toBeNull();
    expect(value.controller.getSnapshot()).toMatchObject({ targetId: "target-b", workspaceForm: false, managedWorkspaceLocation: null });
    expect(value.requests.some(item => item.action === "workspace.managed.open")).toBe(false);
    value.controller.dispose();
  });

  it("does not select an old Core workspace when its open response arrives after a target switch", async () => {
    const late = deferred();
    const value = await refreshed({ action: {
      "workspace.managed.browse": async () => response({ result: managedLocation() }),
      "workspace.managed.open": async () => late.promise,
    } });
    await value.controller.browseManagedWorkspace();
    const open = value.controller.openManagedWorkspace("team/project");
    value.controller.targetChanged("target-b");
    late.resolve(response({ result: managedReady("team/project") }));
    expect(await open).toBeNull();
    expect(value.controller.getSnapshot().directories.some(item => item.workspaceId === "managed-workspace")).toBe(false);
    expect(value.controller.getSnapshot().workspaceForm).toBe(false);
    value.controller.dispose();
  });

  it("discards a late open when the same target reports a different authenticated instance", async () => {
    let instanceId = "managed-instance-a"; const late = deferred();
    const value = await refreshed({ action: {
      "settings.get": async () => response({ result: { instanceId, configuration: {} } }),
      "workspace.managed.browse": async () => response({ result: managedLocation() }),
      "workspace.managed.open": async () => late.promise,
    } });
    value.controller.setWorkspaceForm(true); await value.controller.browseManagedWorkspace();
    const open = value.controller.openManagedWorkspace("team/project");
    instanceId = "managed-instance-b"; await value.controller.refresh();
    late.resolve(response({ result: managedReady("team/project") }));
    expect(await open).toBeNull();
    expect(value.controller.getSnapshot()).toMatchObject({ coreInstanceId: "managed-instance-b", workspaceForm: false });
    expect(value.controller.getSnapshot().directories.some(item => item.workspaceId === "managed-workspace")).toBe(false);
    value.controller.dispose();
  });

  it.each(["", "/outside", "~/project", "../project", "team/../project", "team/.hidden", "team//project", "team\\project", "C:project"])("rejects invalid relative path %s without submitting open", async path => {
    const value = await refreshed({ action: { "workspace.managed.browse": async () => response({ result: managedLocation() }) } });
    await value.controller.browseManagedWorkspace();
    await expect(value.controller.openManagedWorkspace(path)).rejects.toThrow("相对目录");
    expect(value.requests.some(item => item.action === "workspace.managed.open")).toBe(false);
    value.controller.dispose();
  });

  it("uses a real UDS process version without inventing an authenticated instance id", async () => {
    const scope = { instanceId: null, connectionKind: "uds", serverPid: 42, serverStartedAt: "2026-10-22T00:00:00.000Z" };
    const value = await refreshed({ action: {
      "workspace.managed.browse": async () => response({ result: managedLocation("", scope) }),
      "workspace.managed.open": async payload => response({ result: managedReady(payload.relativePath, scope) }),
    } });
    await value.controller.browseManagedWorkspace(); await value.controller.openManagedWorkspace("project");
    const command = value.requests.find(item => item.action === "workspace.managed.open").payload;
    expect(command).toMatchObject({ expectedServerPid: 42, expectedServerStartedAt: scope.serverStartedAt });
    expect(command).not.toHaveProperty("expectedInstanceId");
    expect(value.controller.getSnapshot().root).toBe("/core-home/workspaces/project");
    value.controller.dispose();
  });
});

it("applies a pre-conversation permission choice to its first persistent Thread", async () => {
  const value = await refreshed();
  value.controller.newConversation("");
  await value.controller.setPermissionMode("workspace_auto");
  value.controller.setDraft("hello");
  await value.controller.send();
  expect(value.requests.find(item => item.action === "thread.create").payload.permissionMode).toBe("workspace_auto");
  value.controller.dispose();
});

it("allows switching permission during a Run using the pending configuration revision", async () => {
  const value = await refreshed({ action: {
    "conversation.get": async () => response({ result: { conversationId: "conversation-1", configRevision: "current", pendingConfig: { configRevision: "pending" }, config: { modelId: "model-a" } } }),
  } });
  await value.controller.selectThread("thread-1", "conversation-1");
  await value.controller.setPermissionMode("approve_all");
  expect(value.requests.find(item => item.action === "conversation.updateConfig").payload).toMatchObject({ expectedConfigRevision: "pending", patch: { permissionMode: "approve_all" } });
  value.controller.dispose();
});
