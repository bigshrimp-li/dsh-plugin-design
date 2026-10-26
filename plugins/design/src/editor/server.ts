import { runtimePath, prepareBoardHtml } from '../design-runtime/resource.ts';
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
import { handleStructure } from './structure-routes.ts';
import { handleClipboard } from './clipboard-routes.ts';
import { handleNotes } from './notes-routes.ts';
import { handleMultiSelect } from './multiselect-routes.ts';
import { handleAnnotations } from './annotation-routes.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { EditorTransactions, revisionOf, TransactionError } from './transactions.ts';
import { elementAt, listElements, setInlineStyle, setText, validateSourceRef } from './source.ts';

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const SUPPORT = runtimePath();
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

export async function startEditor(options: EditorOptions): Promise<EditorHandle> {
  const workspace = await fs.realpath(options.workspaceDir);
  const transactions = new EditorTransactions();
  const clients = new Set<http.ServerResponse>();
  const canvasDir = (canvas: string) => {
    const dir = realpathSync(safeJoin(workspace, canvas));
    safeJoin(workspace, path.relative(workspace, dir));
    return dir;
  };
  const boardPath = async (dir: string, board: string) => {
    const index = JSON.parse(await fs.readFile(path.join(dir, 'canvas.json'), 'utf8'));
    if (!Array.isArray(index.order) || !index.order.includes(board) || !index.boards?.[board])
      throw new TransactionError(400, 'unknown_board', '画板未登记在设计稿索引中');
    const abs = realpathSync(safeJoin(dir, board));
    safeJoin(dir, path.relative(dir, abs));
    return abs;
  };
  const support = await fs.readFile(SUPPORT);

  const broadcast = (event: unknown) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  };

  // Observe only opened canvases. Hash source bytes so atomic replacement and same-size edits are detected.
  const observed = new Map<string,{dir:string; signature:Record<string,string>; seen:number}>();
  async function fingerprint(dir:string):Promise<Record<string,string>>{
    const raw=await fs.readFile(path.join(dir,'canvas.json'),'utf8');
    const index=JSON.parse(raw);const files:string[]=Array.isArray(index.order)?index.order:[];
    const values:Record<string,string>={'canvas.json':revisionOf(raw)!};
    for(const file of files.slice(0,200)){
      const target=safeJoin(dir,file);const real=await fs.realpath(target);safeJoin(dir,path.relative(dir,real));
      values[file]=revisionOf(await fs.readFile(real))!;
    }
    const assets=path.join(dir,'assets'),assetStats:string[]=[];
    try{for(const name of (await fs.readdir(assets)).slice(0,1000)){const stat=await fs.stat(path.join(assets,name));assetStats.push(name+':'+stat.size+':'+stat.mtimeMs);}}catch{/* no assets */}
    values['$assets']=revisionOf(assetStats.sort().join('\0'))!;return values;
  }
  const signatureKey=(value:Record<string,string>)=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
  // Acknowledge only bytes written by this transaction, never an unrelated concurrent external edit.
  const acknowledge=(canvas:string,result:{revisions?:Record<string,string|null>})=>{const item=observed.get(canvas);if(!item)return;for(const [file,revision] of Object.entries(result.revisions||{})){if(file!=='canvas.json'&&!file.endsWith('.dc.html'))continue;if(revision===null)delete item.signature[file];else item.signature[file]=revision;}};
  let checking=false,mutating=0,mutationEpoch=0;
  const observer=setInterval(async()=>{
    if(checking||mutating||clients.size===0)return;checking=true;const epoch=mutationEpoch;
    try{for(const [canvas,item]of observed){
      try{const signature=await fingerprint(item.dir);if(mutating||epoch!==mutationEpoch)continue;if(signatureKey(signature)!==signatureKey(item.signature)){item.signature=signature;broadcast({type:'edited',canvas,external:true});}}
      catch{/* A writer may be replacing a file; retry on the next tick without discarding local input. */}
    }}finally{checking=false;}
  },1500);observer.unref();

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
    const json = (code: number, value: unknown) => {
      if (res.headersSent) return;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };

    let mutation=false;
    try {
      const route = decodeURIComponent(url.pathname);
      if(req.method==='POST'&&route.startsWith('/api/')){mutation=true;mutating++;mutationEpoch++;}
      // ---- 静态 ----
      if (route === '/' || route === '/index.html') {
        res.writeHead(200, { 'Content-Type': MIME.html! });
        res.end(await fs.readFile(path.join(ASSETS, 'shell.html')));
        return;
      }
      if (/^\/[a-z][a-z0-9-]*\.(js|css)$/.test(route) && route !== '/support.js') {
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
        let root = path.dirname(abs);
        while (!(await fs.stat(path.join(root, 'canvas.json')).catch(() => null)) && root !== workspace) root = path.dirname(root);
        const canvasRel = path.relative(workspace, root) || '.';
        // 素材是内容寻址的绝对路径 `/_blob/<id>`：补上设计稿前缀，不去改设计稿本身
        html = html.split('"/_blob/').join(`"/_blob/${canvasRel}/`);
        html = html.split("'/_blob/").join(`'/_blob/${canvasRel}/`);
        html = prepareBoardHtml(html);
        // 编辑器桥：注入到 head 最前面，赶在画板运行时之前
        const bridge = url.searchParams.get('preview')==='1'?'':`<script src="/bridge.js"></script>`;
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
        const dir = canvasDir(canvasRel);
        const indexSource = await fs.readFile(path.join(dir, 'canvas.json'), 'utf8');
        const index = JSON.parse(indexSource);
        observed.delete(canvasRel);observed.set(canvasRel,{dir,signature:await fingerprint(dir),seen:Date.now()});
        if(observed.size>60)observed.delete(observed.keys().next().value!);
        const abs = await boardPath(dir, boardRel);
        const source = await fs.readFile(abs, 'utf8');
        const box = index.boards?.[boardRel];
        json(200, {
          canvas: canvasRel,
          board: boardRel,
          title: index.title,
          declared: box ? { w: box.w, h: box.h } : null,
          isInteractive: box?.is_interactive === true,
          source, canvasIndex: index, indexRevision: revisionOf(indexSource),
          revision: revisionOf(source),
          elements: listElements(source).map((e) => ({
            tid: e.tid, tag: e.tag, depth: e.depth, parentTid: e.parentTid,
            text: e.text, style: e.style, hasStyle: e.styleSpan !== null,
            isVoid: e.isVoid, selfClosing: e.selfClosing,
            hasHole: /\{\{/.test(source.slice(e.inner[0], e.inner[1])),
            editableText: !e.isVoid && !e.selfClosing && !['style', 'script', 'helmet'].includes(e.tag)
              && !/<[A-Za-z]/.test(source.slice(e.inner[0], e.inner[1])),
          })),
          ...transactions.status(dir),
        });
        return;
      }

      if (req.method === 'POST' && route.startsWith('/api/')) {
        const body = await readJsonBody(req);
        const canvasRel = String(body.canvas ?? '');
        const boardRel = String(body.board ?? '');
        const dir = canvasDir(canvasRel);
        if (route === '/api/edit') {
          await boardPath(dir, boardRel);
          const tid = Number(body.tid);
          if (!Number.isSafeInteger(tid) || typeof body.revision !== 'string')
            throw new TransactionError(400, 'revision_required', '保存需要有效元素编号和读取版本');
          let after = '';
          const out = await transactions.mutate(dir, {
            label: typeof body.text === 'string' ? '修改文字' : '修改样式', origin: body.origin,
            revisions: { [boardRel]: body.revision },
            build(snapshot) {
              const before = snapshot[boardRel]!.toString('utf8');
              // Legacy callers may omit sourceRef, but may never omit the revision.
              try {
                const target = validateSourceRef(before, body.sourceRef ?? {canvas:canvasRel,board:boardRel,revision:body.revision,tid}, {canvas:canvasRel,board:boardRel});
                if (target.tid !== tid) throw new Error('元素引用与目标编号不一致');
              } catch (error) { throw new TransactionError(409, 'invalid_source', String((error as Error).message)); }
              try { after = typeof body.text === 'string' ? setText(before, tid, body.text) : setInlineStyle(before, tid, String(body.style ?? '')); }
              catch(error) { throw new TransactionError(409, 'invalid_edit', (error as Error).message); }
              return { [boardRel]: after };
            },
          });
          if(out.changed)acknowledge(canvasRel,out);
          if (out.changed) broadcast({type:'edited',canvas:canvasRel,board:boardRel,tid,files:out.files,origin:body.origin});
          json(200, {...out, style:elementAt(after,tid)?.style ?? '', revision:revisionOf(after)});
          return;
        }
        if (route === '/api/undo' || route === '/api/redo') {
          const out = await transactions[route === '/api/undo' ? 'undo' : 'redo'](dir);
          if(out.changed)acknowledge(canvasRel,out);
          if (out.changed) broadcast({type:'edited',canvas:canvasRel,files:out.files,origin:body.origin});
          json(200, {...out, revision:out.revisions[boardRel]});
          return;
        }
        const ctx = {workspace,canvasDir,boardPath,transactions,broadcast,origin:body.origin};
        for (const handler of [handleStructure, handleClipboard, handleNotes, handleMultiSelect, handleAnnotations]) {
          const result = await handler(route,body,ctx);
          if (result !== undefined) { acknowledge(canvasRel,result as {revisions?:Record<string,string|null>});json(200,result); return; }
        }
      }

      json(404, { error: `没有这个路由：${route}` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const error = e as TransactionError;
      const code = error.status ?? (/ENOENT/.test(message) ? 404 : 500);
      json(code, { error: message, code:error.code, problems:error.problems });
    } finally {
      if(mutation){mutating--;mutationEpoch++;}
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
      clearInterval(observer);
      for (const res of clients) { try { res.end(); } catch { /* 已经断了 */ } }
      clients.clear();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
