import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EditorHostContext } from '../editor/host.ts';
import type { EditorManager } from '../editor/manager.ts';
import { DesignSpaceService, SpaceError } from './service.ts';
export function registerDesignSpaceHost(
  ctx: EditorHostContext,
  editors: EditorManager,
  service = new DesignSpaceService(),
) {
  const snapshot = async (sid: string) => {
    const targets = await service.conversationTargets(sid);
    if (!targets.length) return;
    const stored = await ctx.sessionPersistence.open(sid, 'read');
    try {
      if (!stored.read) return;
      const { events } = await stored.read();
      for (const target of targets) await service.saveConversation(target, sid, stored.header, events);
    } finally { await stored.close(); }
  };
  if (ctx.on) ctx.effect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const off = ctx.on!('session/event', session => {
      clearTimeout(timers.get(session.id));
      timers.set(session.id, setTimeout(() => {
        timers.delete(session.id);
        snapshot(session.id).catch(error => ctx.logger?.warn(`设计稿对话副本保存失败：${String(error)}`));
      }, 750));
    });
    return () => { off(); for (const timer of timers.values()) clearTimeout(timer); };
  });
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/design-space/api',
      async handler(req, res) {
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(value));
        };
        try {
          const host = new URL(`http://${req.headers.host}`),
            origin = req.headers.origin;
          if (
            !['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) ||
            req.headers['sec-fetch-site'] === 'cross-site' ||
            (origin !== undefined &&
              origin !== 'dsh-app://app' &&
              new URL(origin).host !== host.host)
          )
            return reply(403, { error: '只允许 Harness 本机窗口操作设计空间' });
          if (req.method !== 'POST') return reply(405, { error: '请使用 POST' });
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 32768) throw new SpaceError(413, '请求过大');
          }
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            throw new SpaceError(400, '请求必须是有效 JSON');
          }
          if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new SpaceError(400, '请求必须是 JSON 对象');
          const str = (name: string, optional = false) => {
            const v = body[name];
            if (optional && v === undefined) return undefined;
            if (typeof v !== 'string' || v.length > 4096)
              throw new SpaceError(400, `参数 ${name} 无效`);
            return v;
          };
          let result: unknown;
          switch (body.action) {
            case 'list':
              result = await service.list();
              break;
            case 'rename':
              result = await service.rename(str('id')!, str('label')!);
              break;
            case 'reveal': {
              const d = await service.directory(str('id')!);
              if (process.platform === 'darwin') await promisify(execFile)('open', ['-R', d.path]);
              else if (process.platform === 'win32')
                await promisify(execFile)('explorer.exe', [d.path]);
              else await promisify(execFile)('xdg-open', [d.path]);
              result = { ok: true };
              break;
            }
            case 'archive':
              result = await service.archive(str('id')!);
              break;
            case 'describe':
              result = await service.describe(str('id')!, str('rel', true));
              break;
            case 'open': {
              if (str('rel', true) && str('rel') !== '.') throw new SpaceError(400, '设计稿路径无效');
              const info = await service.ensure(str('id')!);
              if (info.status !== 'ready')
                throw new SpaceError(422, '此目录没有有效设计稿，请先创建或修复 canvas.json');
              const editor = await editors.open(info.directory.workspace);
              result = { ...info, url: editor.url };
              break;
            }
            case 'create':
              result = await service.create(str('operationId')!, str('name', true), str('preset', true));
              break;
            case 'bind': {
              const sid = str('sessionId')!;
              let cwd = ctx.sessions.get(sid)?.header.cwd;
              if (!cwd) {
                const stored = await ctx.sessionPersistence.open(sid, 'read');
                try {
                  cwd = stored.header.cwd;
                } finally {
                  await stored.close();
                }
              }
              if (!cwd) throw new SpaceError(422, '会话缺少工作区');
              const expected = body.expectedRevision;
              if (expected !== undefined && (!Number.isInteger(expected) || expected < 0))
                throw new SpaceError(400, '配置版本无效');
              result = await service.bind(str('id')!, str('rel')!, sid, cwd, expected);
              await snapshot(sid).catch(error => ctx.logger?.warn(`设计稿对话副本保存失败：${String(error)}`));
              break;
            }
            default:
              throw new SpaceError(400, '未知设计空间操作');
          }
          reply(200, result);
        } catch (e) {
          reply(e instanceof SpaceError ? e.status : 500, { error: (e as Error).message });
        }
      },
    }),
  );
}
