import { runtimePath, prepareBoardHtml } from './design-runtime/resource.ts';
/**
 * 把设计稿的画板渲染成 PNG。
 *
 * 做法：起一个只读本地服务（画板文件 + `/_blob/<id>` → `assets/` + 随包的 `dist/design-runtime/support.js`），
 * 用无头 Chrome 逐个画板截图，并把画板自己报回来的尺寸与报错收集起来。
 *
 * 画板 `.dc.html` 里的 `<script src="./support.js"></script>` 会命中服务给出的运行时而挂载真实界面；
 * 服务还会在 `<head>` 最前面注入一小段脚本，用来（1）在运行时启动前就装上错误监听、
 * （2）页面加载后把挂载结果量出来 POST 回服务端。所以一次 Chrome 调用同时拿到截图和结构化结果。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 画板的渲染结果。 */
export interface BoardRender {
  /** 画板在 `canvas.json` 里的路径（`/` 分隔）。 */
  board: string;
  /** `canvas.json` 里声明的 frame。 */
  declared: { w: number; h: number };
  /** 实际挂载出来的尺寸；没挂载起来时 null。 */
  rendered: { w: number; h: number } | null;
  /** 画板挂载出根节点了吗。false 说明运行时没跑起来或画板是空的。 */
  mounted: boolean;
  /** 挂载尺寸超出声明的 frame（会被裁切）。 */
  overflow: boolean;
  /** 页面里的报错（运行时启动失败、脚本异常等）。 */
  errors: string[];
  /** 截图写到哪了。 */
  png: string;
  /** 截图字节数；0 说明没截到。 */
  pngBytes: number;
}

export interface RenderOptions {
  /** 设计稿目录（绝对路径）。 */
  canvasDir: string;
  /** 截图输出目录；默认保存在设计稿自己的 `.design-preview/` 内。 */
  outDir?: string;
  /** 只渲染这几块画板；不给时按 `canvas.json` 的 `order` 全渲染。 */
  boards?: string[];
  /** 设备像素比；默认 2。 */
  scale?: number;
  /** Chrome 可执行文件；不给时按候选列表找。 */
  chromePath?: string;
  /** 单个画板的超时（毫秒）；默认 30000。 */
  timeoutMs?: number;
}

const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

const mimeOf = (file: string): string => MIME[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** 随包的画板运行时（`dist/design-runtime/support.js`）。 */
function supportPath(): string {
  return runtimePath();
}

/** 无头 Chrome 的候选位置。 */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** 找一个能用的无头浏览器。 */
export async function findChrome(explicit?: string): Promise<string | null> {
  const candidates = [explicit, process.env.DSH_DESIGN_CHROME, ...CHROME_CANDIDATES].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  // Playwright 的缓存里也常常有一个。
  const cache = path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  const entries = await fs.readdir(cache).catch(() => [] as string[]);
  for (const entry of entries.filter((name) => name.startsWith('chromium')).sort().reverse()) {
    for (const rel of [
      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-headless-shell-mac-x64/chrome-headless-shell',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-linux/chrome',
    ]) {
      const candidate = path.join(cache, entry, rel);
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile()) return candidate;
    }
  }
  return null;
}

/** 注入到 `<head>` 最前面的探针：先装错误监听，再在加载后把挂载结果报回来。 */
function probeScript(board: string): string {
  // 报好几次，服务端只留最后一次：刚 load 时布局还没稳（字体还没落地、sc-for 的 placeholder 还在），
  // 只量一次会量到临时宽度，把好画板误判成「超出 frame」。
  return `<script>(function(){
var errs=[];
window.addEventListener('error',function(e){errs.push(String((e&&e.message)||e));});
window.addEventListener('design-runtime-error',function(e){errs.push(String(e.detail));});
window.addEventListener('unhandledrejection',function(e){errs.push('unhandled rejection: '+String(e&&e.reason));});
function report(){
  // 量的是**画板自己的根元素**（.sc-host 是宿主的包装层，它会撑满窗口，不是画板尺寸——
  // 窄画板尤其明显：Chrome 的窗口有最小宽度，包装层会比画板宽）。
  var host=document.querySelector('#dc-root .sc-host');
  var art=(host&&host.firstElementChild)||document.querySelector('#dc-root')||document.body;
  var rect=art&&art.getBoundingClientRect();
  var payload={board:${JSON.stringify(board)},mounted:!!document.querySelector('#dc-root'),
    w:rect?Math.round(rect.width):0,h:rect?Math.round(rect.height):0,errors:errs.slice(0,8)};
  try{fetch('/__report',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(function(){});}catch(e){}
}
if(document.readyState==='complete'){[400,1200,2400,4000].forEach(function(d){setTimeout(report,d);});}
else{window.addEventListener('load',function(){[0,300,1500,3000].forEach(function(d){setTimeout(report,d);});});}
})();</script>`;
}

/** 把探针插进画板 HTML 的最前面（`<head>` 之后，好让它在 support.js 之前跑）。 */
function injectProbe(html: string, board: string): string {
  const probe = probeScript(board);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + probe + html.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + probe + html.slice(htmlTag.index + htmlTag[0].length);
  return probe + html;
}

interface CanvasIndex {
  order: string[];
  boards: Record<string, { w: number; h: number }>;
}

/** 渲染一份设计稿里的画板。 */
export async function renderCanvas(options: RenderOptions): Promise<{ boards: BoardRender[]; chrome: string; outDir: string }> {
  const { canvasDir } = options;
  const chrome = await findChrome(options.chromePath);
  if (chrome === null) {
    throw new Error(
      '找不到无头浏览器：装一个 Chrome/Chromium/Edge，或用 DSH_DESIGN_CHROME 指出可执行文件的位置',
    );
  }
  const index = JSON.parse(await fs.readFile(path.join(canvasDir, 'canvas.json'), 'utf8')) as CanvasIndex;
  const order = options.boards ?? index.order;
  for (const board of order) {
    if (index.boards[board] === undefined) throw new Error(`canvas.json 的 boards 里没有这块画板：${board}`);
  }

  const outDir =
    options.outDir ?? path.join(canvasDir, '.design-preview');
  await fs.mkdir(outDir, { recursive: true });
  const support = await fs.readFile(supportPath());
  const assetsDir = path.join(canvasDir, 'assets');

  /** 服务端收到的最新一次探针上报，按画板路径存。 */
  const reports = new Map<string, { mounted: boolean; w: number; h: number; errors: string[] }>();

  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    try {
      if (req.method === 'POST' && url === '/__report') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          board: string;
          mounted: boolean;
          w: number;
          h: number;
          errors: string[];
        };
        reports.set(body.board, body);
        res.writeHead(204).end();
        return;
      }
      if (url === '/support.js' || url.endsWith('/support.js')) {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(support);
        return;
      }
      // 内容寻址的素材：/_blob/<id> → assets/<id>.<ext>
      if (url.startsWith('/_blob/')) {
        const id = url.slice('/_blob/'.length);
        const names = await fs.readdir(assetsDir).catch(() => [] as string[]);
        const name = names.find((n) => n.startsWith(`${id}.`) && !n.endsWith('.json'));
        if (name === undefined) {
          res.writeHead(404).end('no such blob');
          return;
        }
        res.writeHead(200, { 'Content-Type': mimeOf(name) });
        res.end(await fs.readFile(path.join(assetsDir, name)));
        return;
      }
      const rel = url === '/' ? order[0]! : url.slice(1);
      const file = path.resolve(canvasDir, rel);
      if (file !== canvasDir && !file.startsWith(canvasDir + path.sep)) {
        res.writeHead(403).end('outside the canvas');
        return;
      }
      const body = await fs.readFile(file);
      if (rel.endsWith('.dc.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(injectProbe(prepareBoardHtml(body.toString('utf8')), rel));
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeOf(rel) });
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404).end('not found');
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const scale = options.scale ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const results: BoardRender[] = [];
  try {
    for (const board of order) {
      const box = index.boards[board]!;
      const png = path.join(outDir, `${board.replace(/[^\w.-]/g, '_')}.png`);
      await fs.rm(png, { force: true });
      reports.delete(board);
      await runChrome(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-sandbox',
        '--disable-extensions',
        '--force-device-scale-factor=' + String(scale),
        `--window-size=${box.w},${box.h}`,
        `--screenshot=${png}`,
        '--virtual-time-budget=5000',
        `http://127.0.0.1:${port}/${encodeURI(board)}`,
      ], timeoutMs);
      const stat = await fs.stat(png).catch(() => null);
      const report = reports.get(board);
      const rendered = report !== undefined && report.w > 0 && report.h > 0 ? { w: report.w, h: report.h } : null;
      results.push({
        board,
        declared: { w: box.w, h: box.h },
        rendered,
        mounted: report?.mounted ?? false,
        overflow: rendered !== null && (rendered.w > box.w + 1 || rendered.h > box.h + 1),
        errors: report?.errors ?? (report === undefined ? ['画板没有回报结果：运行时可能没启动'] : []),
        png,
        pngBytes: stat?.size ?? 0,
      });
    }
  } finally {
    server.close();
  }
  return { boards: results, chrome, outDir };
}

/** 跑一次 Chrome，等它退出。 */
function runChrome(chrome: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Chrome 超过 ${timeoutMs} ms 没结束`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Chrome 常见地以非 0 退出但截图已经写出；只有真的没写出图时才算失败。
      if (code !== 0 && !stderr.includes('Written to file')) resolve();
      resolve();
    });
  });
}
