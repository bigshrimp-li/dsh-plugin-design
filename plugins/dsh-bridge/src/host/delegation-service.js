// A graph node identifies a Run; only a Core delegation resource can be cancelled.
export function createDelegationActions({ client, attempt, requireText, optional, scopeFor, error }) {
  async function parent(p) {
    if (!client.delegations?.list || !client.delegations?.get || !client.delegations?.cancel)
      throw error("NOT_SUPPORTED", "当前 SDK 不支持委派管理。");
    const threadId = requireText(p, "threadId"), conversationId = requireText(p, "conversationId"), runId = requireText(p, "runId");
    const scope = await scopeFor(p);
    if (p.scope !== undefined && p.scope !== scope) throw error("INSTANCE_CHANGED", "服务或操作者已变化，请重新打开委派详情。");
    const run = await client.getRun(runId);
    if (run.runId !== runId || run.conversationId !== conversationId || run.threadId !== threadId)
      throw error("NOT_FOUND", "所选任务不属于当前对话。");
    return { scope, runId, conversationId };
  }
  async function resource(p) {
    requireText(p, "scope");
    const { conversationId, runId } = await parent(p);
    const id = requireText(p, "delegationId"), item = await client.delegations.get(id);
    if (item.id !== id || item.parentConversationId !== conversationId || item.parentRunId !== runId)
      throw error("NOT_FOUND", "所选委派不属于当前任务。");
    return item;
  }
  return {
    "delegation.list": p => attempt(async () => {
      const { scope, conversationId, runId } = await parent(p);
      const page = await client.delegations.list(conversationId, optional(p, ["limit", "cursor"]));
      return { scope, items: page.items.filter(item => item.id && item.parentConversationId === conversationId && item.parentRunId === runId), nextCursor: page.nextCursor };
    }),
    "delegation.get": p => attempt(() => resource(p)),
    "delegation.cancel": p => attempt(async () => {
      const item = await resource(p);
      // Core checks a retry against its original receipt even when the task has since ended.
      return client.delegations.cancel(item.id, { requestId: requireText(p, "requestId") });
    }),
  };
}
