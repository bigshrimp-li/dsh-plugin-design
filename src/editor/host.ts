import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import type { EditorManager } from './manager.ts';

export interface EditorHostContext {
  webServer: { register(route: {
    kind: 'exact'; path: string;
    handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  }): () => void };
  sessions: { get(id: string): { header: { cwd?: string } } | undefined };
  sessionPersistence: { open(id: string, mode: 'read'): Promise<{
    header: { cwd?: string }; close(): Promise<void>;
  }> };
  effect(fn: () => (() => void)): unknown;
}

/** Desktop's same-origin forwarder delivers dsh-app requests to this loopback route. */
export function registerEditorHost(ctx: EditorHostContext, editors: EditorManager): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/design-editor/open',
    async handler(req, res) {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      const host = req.headers.host;
      const origin = req.headers.origin;
      let trusted = false;
      try {
        const target = new URL(`http://${host}`);
        trusted = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
          && req.headers['sec-fetch-site'] !== 'cross-site'
          && (origin === undefined || origin === 'dsh-app://app' || new URL(origin).host === target.host);
      } catch { /* Invalid or opaque browser origin. */ }
      if (!trusted) return reply(403, { error: '只允许 Harness 本机窗口打开编辑器' });
      if (req.method !== 'POST') return reply(405, { error: '请使用 POST' });
      try {
        // Never accept a client-provided filesystem root or fall back to process.cwd().
        const sessionId = new URL(req.url!, 'http://localhost').searchParams.get('sessionId');
        if (!sessionId || sessionId.length > 256) return reply(400, { error: '请选择一个工作区会话' });
        let cwd = ctx.sessions.get(sessionId)?.header.cwd;
        if (!cwd) {
          const stored = await ctx.sessionPersistence.open(sessionId, 'read');
          try { cwd = stored.header.cwd; } finally { await stored.close(); }
        }
        if (!cwd || !isAbsolute(cwd)) return reply(422, { error: '当前会话没有工作区，请先在 Harness 中选择工作区' });
        if (!(await stat(cwd)).isDirectory()) return reply(422, { error: '当前工作区目录不存在' });
        const editor = await editors.open(cwd);
        reply(200, { url: editor.url, workspace: cwd });
      } catch (error) {
        reply(500, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  }));
}
