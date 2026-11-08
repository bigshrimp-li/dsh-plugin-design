import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { nativeFixture, textOf, waitFor } from "./native-core-fixture.mjs";

let createSpace;
const originalWindow = globalThis.window;
globalThis.window = { __ModuleLoader__: { load(definition) { ({ createSpace } = definition.factory()); } } };
try { await import("../../src/client/client.space.js"); } finally { globalThis.window = originalWindow; }

const reply = (content, tool) => ({ id: "navigation", choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop",
  message: { role: "assistant", content, ...(tool ? { tool_calls: [tool] } : {}) } }] });
const send = async (f, threadId, text) => {
  const { runId } = await f.bridge.call("input.submit", { threadId, requestId: randomUUID(), text });
  return waitFor(() => f.sdk.getRun(runId), r => ["failed", "completed"].includes(r.status), "Run settlement");
};
function profile(f, saved = new Map()) {
  const transport = { nextRequestId: () => randomUUID(), call: () => { throw Error("unexpected transport"); } };
  const services = { viewState: { set() {}, get: () => ({}) }, observations: { graph: id => f.sdk.getObservationThreadGraph(id) } };
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url, "http://fixture");
    if (route.pathname.endsWith("/state")) return { ok: true, json: () => f.bridge.state(Object.fromEntries(route.searchParams)) };
    const { action, payload } = JSON.parse(init.body);
    try { return { ok: true, json: async () => ({ result: await f.bridge.call(action, payload) }) }; }
    catch (error) { return { ok: false, status: 400, json: async () => ({ error: { code: error.code, message: error.message } }) }; }
  };
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  return createSpace({ kernel: { React: {}, h() {} }, services, transport, ctx: { layout: { selectPanel() {} } }, fetchImpl, storage, EventSourceImpl: null }).controller;
}

describe.skipIf(!process.versions.electron || !process.env.SUPER_AGENT_SOURCE_ROOT)("two DSH workspace profiles against one Go Worker", () => {
  it("derives one title, follows a durable rename and restores the main draft after a fork and reload", async () => {
    const f = await nativeFixture(async () => reply("done"));
    const { threadId, mainConversationId } = f.thread, initial = "第一次已持久接收的输入";
    expect((await send(f, threadId, initial)).status).toBe("completed");
    const store = new Map(), first = profile(f, store), second = profile(f);
    const title = c => { const t = c.getSnapshot().threads.find(row => row.threadId === threadId); return t.title || t.fallbackTitle; };
    try {
      await Promise.all([first.refresh(), second.refresh()]);
      expect([title(first), title(second)]).toEqual([initial, initial]);
      await first.selectThread(threadId, mainConversationId);
      expect((await send(f, threadId, "后续输入不会成为标题")).status).toBe("completed");
      await second.refresh(); expect(title(second)).toBe(initial);
      await first.renameThread(first.getSnapshot().threads.find(row => row.threadId === threadId), "共同审阅");
      await second.refresh(); expect(title(second)).toBe("共同审阅");
      const entry = (await f.sdk.listMessages(mainConversationId)).items.find(m => m.role === "user" && m.text === initial);
      expect(entry.entryId).toBeTypeOf("number");
      const mainDraft = "  主对话的草稿\n第二行  ";
      first.setDraft(mainDraft);
      const branch = await first.fork(entry);
      expect(first.getSnapshot().selected.conversationId).toBe(branch.conversationId);
      first.setDraft("分支单独草稿");
      first.dispose();
      const reloaded = profile(f, store);
      try {
        await reloaded.refresh();
        expect(reloaded.getSnapshot()).toMatchObject({ selected: { threadId, conversationId: branch.conversationId }, draft: "分支单独草稿" });
        await second.selectThread(threadId, mainConversationId);
        expect(await second.loadBranches()).toContainEqual(expect.objectContaining({ conversationId: branch.conversationId, forkedFromConversationId: mainConversationId }));
        await second.selectThread(threadId, branch.conversationId);
        for (const c of [reloaded, second]) {
          const branches = await c.loadBranches();
          expect(branches).toContainEqual(expect.objectContaining({ conversationId: branch.conversationId, forkedFromConversationId: mainConversationId }));
          expect(c.getSnapshot().messages.some(m => m.role === "user" && m.text === "后续输入不会成为标题")).toBe(false);
        }
        await reloaded.selectThread(threadId, mainConversationId);
        expect(reloaded.getSnapshot().draft).toBe(mainDraft);
        expect(reloaded.getSnapshot().messages.some(m => m.text === "后续输入不会成为标题")).toBe(true);
      } finally { reloaded.dispose(); }
    } finally { first.dispose(); second.dispose(); }
  });

  it("reads two immutable Run results and resolves a conflict against only the selected Run", async () => {
    const paths = { first: "alpha.txt", second: "beta.txt" };
    const f = await nativeFixture(async body => {
      const users = body.messages.filter(m => m.role === "user");
      const label = textOf(users.at(-1)), path = paths[label];
      if (!path || body.messages.slice(body.messages.lastIndexOf(users.at(-1)) + 1).some(m => m.role === "tool")) return reply("done");
      return reply("", { id: "write-" + label, type: "function", function: { name: "write", arguments: JSON.stringify({ path, content: label, mode: "create" }) } });
    });
    const registered = await f.sdk.registerWorkspace({ requestId: "artifact-harness", root: f.workspaceRoot });
    const baseline = await f.sdk.files.snapshotDirectory(registered.workspaceId, { requestId: "artifact-baseline", path: f.workspaceRoot });
    const thread = await f.sdk.createThread({ requestId: "artifact-thread", agentId: "main", modelId: "native-goal-model", workspaceId: registered.workspaceId,
      cwd: f.workspaceRoot, permissionMode: "approve_none", fileInput: { mode: "fixed_snapshot", snapshotId: baseline.snapshotId } });
    const [first, second] = [await send(f, thread.threadId, "first"), await send(f, thread.threadId, "second")];
    expect([first.status, second.status]).toEqual(["completed", "completed"]);
    const c = profile(f);
    const dest = join(f.home, "destination"); await mkdir(dest); await writeFile(join(dest, paths.second), "independent local change");
    try {
      await c.refresh(); await c.selectThread(thread.threadId, thread.mainConversationId);
      const firstDiff = await c.loadRunDiff(first.runId), secondDiff = await c.loadRunDiff(second.runId);
      expect(firstDiff.artifacts.files.map(i => i.path)).toEqual([paths.first]);
      expect(secondDiff.artifacts.files.map(i => i.path)).toEqual([paths.second]);
      expect(await readFile(join(dest, paths.second), "utf8")).toBe("independent local change");
      const result = await c.resource("files.applyLocal", { runId: second.runId, destination: dest, paths: [paths.second], requestId: "apply-second" });
      expect(result).toMatchObject({ runId: second.runId, items: [{ path: paths.second, status: "conflict" }] });
      expect((await c.resource("files.applyOperations", { runId: first.runId })).items).toHaveLength(0);
      const review = await c.resource("files.applyConflict.preview", { operationId: result.operationId, path: paths.second });
      expect(review).toMatchObject({ localText: "independent local change", cloudText: "second" });
      await c.resource("files.applyConflict.resolve", { requestId: "reviewed-second", operationId: result.operationId, path: paths.second, choice: "save_as",
        saveAsPath: "second-reviewed.txt", expectedLocalHash: review.actualHash });
      expect(await readFile(join(dest, paths.second), "utf8")).toBe("independent local change");
      expect(await readFile(join(dest, "second-reviewed.txt"), "utf8")).toBe("second");
      await expect(readFile(join(dest, paths.first))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { c.dispose(); }
  });
});
