/**
 * 编辑器服务：一个只监听回环地址的小 HTTP 服务。
 *
 * 为什么走 HTTP 而不是 DSH 的 client↔host RPC：画板必须**在 iframe 里**跑（它的样式与脚本不能
 * 污染宿主界面），而 iframe 需要一个 URL。既然已经有 URL 了，界面、素材、写回 API 就都挂在同一个
 * 源上——同源还让外壳能直接读 iframe 的 DOM，省掉一整套 postMessage 协议。
 *
 * 于是：DSH 里的侧边栏面板只是一个指向它的 iframe；用浏览器直接打开它也能用。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkCanvas } from '../check/canvas-check.ts';
import { elementAt, listElements, readBoard, setInlineStyle, setText } from './source.ts';

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const SUPPORT = fileURLToPath(new URL('../../vendor/support.js', import.meta.url));
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
};
const mimeOf = (f: string) => MIME[f.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export interface EditorOptions {
  /** 工作目录：这底下的每份设计稿都能打开。 */
  workspaceDir: string;
  /** 可选首选端口；原生插件使用动态端口并通过宿主接口取得地址。 */
  preferredPort?: number;
}

export interface EditorHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** 路径必须留在根目录里面：挡掉 `..`、绝对路径与符号链接逃逸。 */
function safeJoin(root: string, rel: string): string {
  if (rel.includes('\0')) throw new Error('路径里有空字节');
  const abs = path.resolve(root, rel);
  const norm = path.resolve(root);
  if (abs !== norm && !abs.startsWith(norm + path.sep)) throw new Error(`路径跑到工作目录外面了：${rel}`);
  return abs;
}

interface UndoEntry { abs: string; before: string; after: string; at: number; label: string }
const revisionOf = (source: string) => createHash('sha256').update(source).digest('hex');

export async function startEditor(options: EditorOptions): Promise<EditorHandle> {
  const workspace = path.resolve(options.workspaceDir);
  const undo = new Map<string, UndoEntry[]>();
  const clients = new Set<http.ServerResponse>();
  // Validation reads every board in a canvas, so writes/undo share a canvas lock.
  const writes = new Map<string, Promise<void>>();
  const lock = async (key: string) => {
    const previous = writes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    writes.set(key, current);
    await previous;
    return () => { release(); if (writes.get(key) === current) writes.delete(key); };
  };
  const support = await fs.readFile(SUPPORT);

  const broadcast = (event: unknown) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  };

  /** 工作目录下所有带 canvas.json 的设计稿。 */
  const listCanvases = async () => {
    const out: { path: string; title: string; boards: { path: string; w: number; h: number; title?: string }[] }[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || out.length >= 60) return;
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      if (entries.some((e) => e.isFile() && e.name === 'canvas.json')) {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(dir, 'canvas.json'), 'utf8'));
          const rel = path.relative(workspace, dir) || '.';
          out.push({
            path: rel,
            title: typeof raw.title === 'string' ? raw.title : rel,
            boards: (raw.order ?? []).map((b: string) => ({
              path: b, w: raw.boards?.[b]?.w, h: raw.boards?.[b]?.h, title: raw.boards?.[b]?.title,
            })),
          });
        } catch { /* 坏的 canvas.json 就跳过 */ }
        return; // 设计稿不嵌套
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        await walk(path.join(dir, e.name), depth + 1);
      }
    };
    await walk(workspace, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };

  const readJsonBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4_000_000) reject(new Error('请求体过大'));
      });
      req.on('end', () => {
        try { resolve(body === '' ? {} : JSON.parse(body)); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let releaseWrite: (() => void) | undefined;
    const json = (code: number, value: unknown) => {
      if (res.headersSent) return;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };

    try {
      const route = decodeURIComponent(url.pathname);
      // ---- 静态 ----
      if (route === '/' || route === '/index.html') {
        res.writeHead(200, { 'Content-Type': MIME.html! });
        res.end(await fs.readFile(path.join(ASSETS, 'shell.html')));
        return;
      }
      if (route === '/shell.js' || route === '/shell.css') {
        res.writeHead(200, { 'Content-Type': mimeOf(route), 'Cache-Control': 'no-store' });
        res.end(await fs.readFile(path.join(ASSETS, route.slice(1))));
        return;
      }
      // 画板里那一行是 `./support.js`：在 /board/<canvas>/ 下会解析成 /board/<canvas>/support.js，
      // 所以后缀也要认。设计稿里那一行保持不变。
      if (route === '/support.js' || route.endsWith('/support.js')) {
        res.writeHead(200, { 'Content-Type': MIME.js!, 'Cache-Control': 'no-store' });
        res.end(support);
        return;
      }
      if (route === '/bridge.js') {
        res.writeHead(200, { 'Content-Type': MIME.js!, 'Cache-Control': 'no-store' });
        res.end(await fs.readFile(path.join(ASSETS, 'bridge.js')));
        return;
      }

      // ---- 画板：/board/<canvas>/<board>.dc.html ----
      if (route.startsWith('/board/')) {
        const rest = route.slice('/board/'.length);
        const abs = safeJoin(workspace, rest);
        let html = await fs.readFile(abs, 'utf8');
        const canvasRel = path.dirname(rest);
        // 素材是内容寻址的绝对路径 `/_blob/<id>`：补上设计稿前缀，不去改设计稿本身
        html = html.split('"/_blob/').join(`"/_blob/${canvasRel}/`);
        html = html.split("'/_blob/").join(`'/_blob/${canvasRel}/`);
        // 编辑器桥：注入到 head 最前面，赶在画板运行时之前
        const bridge = `<script src="/bridge.js"></script>`;
        const head = /<head[^>]*>/i.exec(html);
        html = head
          ? html.slice(0, head.index + head[0].length) + bridge + html.slice(head.index + head[0].length)
          : bridge + html;
        res.writeHead(200, { 'Content-Type': MIME.html!, 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      // ---- 素材：/_blob/<canvas>/<id> ----
      if (route.startsWith('/_blob/')) {
        const rest = route.slice('/_blob/'.length);
        const at = rest.lastIndexOf('/');
        const canvasRel = at < 0 ? '' : rest.slice(0, at);
        const id = at < 0 ? rest : rest.slice(at + 1);
        const dir = safeJoin(workspace, path.join(canvasRel, 'assets'));
        const names = await fs.readdir(dir).catch(() => [] as string[]);
        const name = names.find((n) => n.startsWith(`${id}.`) && !n.endsWith('.json'));
        if (name === undefined) { json(404, { error: `素材 ${id} 不在 ${canvasRel}/assets/ 里` }); return; }
        res.writeHead(200, { 'Content-Type': mimeOf(name), 'Cache-Control': 'no-store' });
        res.end(await fs.readFile(path.join(dir, name)));
        return;
      }

      // ---- SSE ----
      if (route === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 断开时下面会清 */ } }, 25_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      // ---- API ----
      if (route === '/api/workspace') {
        json(200, { root: workspace, canvases: await listCanvases() });
        return;
      }

      if (route === '/api/board') {
        const canvasRel = url.searchParams.get('canvas') ?? '';
        const boardRel = url.searchParams.get('board') ?? '';
        const dir = safeJoin(workspace, canvasRel);
        const index = JSON.parse(await fs.readFile(path.join(dir, 'canvas.json'), 'utf8'));
        const abs = safeJoin(dir, boardRel);
        const source = await fs.readFile(abs, 'utf8');
        const box = index.boards?.[boardRel];
        json(200, {
          canvas: canvasRel,
          board: boardRel,
          title: index.title,
          declared: box ? { w: box.w, h: box.h } : null,
          isInteractive: box?.is_interactive === true,
          source,
          revision: revisionOf(source),
          elements: listElements(source).map((e) => ({
            tid: e.tid, tag: e.tag, depth: e.depth, parentTid: e.parentTid,
            text: e.text, style: e.style, hasStyle: e.styleSpan !== null,
            isVoid: e.isVoid, selfClosing: e.selfClosing,
            hasHole: /\{\{/.test(source.slice(e.inner[0], e.inner[1])),
            editableText: !e.isVoid && !e.selfClosing && !['style', 'script', 'helmet'].includes(e.tag)
              && !/<[A-Za-z]/.test(source.slice(e.inner[0], e.inner[1])),
          })),
          canUndo: (undo.get(abs)?.length ?? 0) > 0,
        });
        return;
      }

      if (route === '/api/edit' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const canvasRel = String(body.canvas ?? '');
        const boardRel = String(body.board ?? '');
        const tid = Number(body.tid);
        if (!Number.isInteger(tid)) { json(400, { error: 'tid 必须是整数' }); return; }
        const dir = safeJoin(workspace, canvasRel);
        const abs = safeJoin(dir, boardRel);
        releaseWrite = await lock(dir);

        // 两个写者（人 + agent）：写入前当场重读，永远基于磁盘上的当前内容改
        const before = await readBoard(abs);
        if (body.revision !== undefined && body.revision !== revisionOf(before)) {
          json(409, { error: '画板已在别处修改，本次保存已停止。请重新加载后再编辑。' });
          return;
        }
        let after: string;
        try {
          after = typeof body.text === 'string'
            ? setText(before, tid, body.text)
            : setInlineStyle(before, tid, typeof body.style === 'string' ? body.style : '');
        } catch (e) {
          json(409, { error: e instanceof Error ? e.message : String(e) });
          return;
        }
        if (after === before) {
          json(200, { changed: false, style: elementAt(after, tid)?.style ?? '', revision: revisionOf(after), canUndo: (undo.get(abs)?.length ?? 0) > 0 });
          return;
        }

        // 写完先自检：编辑器不该产出不合法的画板
        await fs.writeFile(abs, after);
        const report = await checkCanvas(dir).catch((e) => ({ issues: [{ file: '', message: String(e) }] }));
        const issues = report.issues ?? [];
        if (issues.length > 0) {
          // An outside writer is not covered by our lock; never roll its newer bytes back.
          if (await fs.readFile(abs, 'utf8') === after) await fs.writeFile(abs, before);
          json(422, { error: '这次改动会让设计稿校验不过，已经回滚', problems: issues.slice(0, 6) });
          return;
        }

        const stack = undo.get(abs) ?? [];
        stack.push({ abs, before, after, at: Date.now(), label: typeof body.text === 'string' ? 'text' : 'style' });
        if (stack.length > 100) stack.shift();
        undo.set(abs, stack);

        const el = elementAt(after, tid);
        // 带上发起方：否则自己的改动会从 SSE 绕回来，被当成"别人改了"而触发一次无谓的重载
        broadcast({ type: 'edited', canvas: canvasRel, board: boardRel, tid, origin: body.origin ?? null });
        json(200, { changed: true, style: el?.style ?? '', canUndo: true, revision: revisionOf(after) });
        return;
      }

      if (route === '/api/undo' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const dir = safeJoin(workspace, String(body.canvas ?? ''));
        const abs = safeJoin(dir, String(body.board ?? ''));
        releaseWrite = await lock(dir);
        const stack = undo.get(abs) ?? [];
        const entry = stack.at(-1);
        if (entry === undefined) { json(200, { changed: false, canUndo: false }); return; }
        // 只有在文件仍是我们写下的那一版时才回退，避免抹掉 agent 之后的改动
        const current = await fs.readFile(abs, 'utf8');
        if (current !== entry.after) {
          json(409, { error: '这个文件在编辑器之外被改过（可能是 agent），撤销会覆盖掉那些改动，所以停手了', changed: false });
          return;
        }
        await fs.writeFile(abs, entry.before);
        stack.pop();
        broadcast({ type: 'edited', canvas: body.canvas, board: body.board, tid: null, origin: body.origin ?? null });
        json(200, { changed: true, canUndo: stack.length > 0, revision: revisionOf(entry.before) });
        return;
      }

      json(404, { error: `没有这个路由：${route}` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = /ENOENT/.test(message) ? 404 : 500;
      json(code, { error: message });
    } finally {
      releaseWrite?.();
    }
  });

  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
  let port = 0;
  if (options.preferredPort !== undefined) {
    try {
      await listen(options.preferredPort);
      port = options.preferredPort;
    } catch {
      // 端口被占：退回随机端口，真实 URL 会报给调用方
    }
  }
  if (port === 0) {
    await listen(0);
    port = (server.address() as { port: number }).port;
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise<void>((resolve) => {
      for (const res of clients) { try { res.end(); } catch { /* 已经断了 */ } }
      clients.clear();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
