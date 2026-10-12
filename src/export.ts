/**
 * 把设计稿导出成**自包含的 HTML**：双击就能在浏览器里打开，不需要本地服务，也不依赖 `support.js`。
 *
 * `.dc.html` 是**源格式**，不是能直接打开的网页：
 *   1. `<script src="./support.js"></script>` 指向画板运行时——磁盘上没有这个文件，运行时不会加载，
 *      `<x-dc>` 就不会挂载，你看到的是**没挂载的原始 markup**；
 *   2. `{{accent}}` 这类 hole 是运行时替换的，没运行时它就是字面量，浏览器把 `background: {{accent}}`
 *      当非法值丢掉 → 色块变透明 → 白字白底看不见；
 *   3. `/_blob/<id>` 要靠一个把 `<id>` 映射到 `assets/<id>.<ext>` 的服务，`file://` 下它是死链。
 *
 * 这个导出把三件事都补上：运行时内联、相对样式表/脚本内联、`/_blob/<id>` 换成 data: URI。
 * 不改变设计稿本身一个字节——导出是另一份文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
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
  css: 'text/css',
  js: 'text/javascript',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

const mimeOf = (file: string): string => MIME[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** 随包的画板运行时（`vendor/support.js`）。 */
function supportPath(): string {
  return fileURLToPath(new URL('../vendor/support.js', import.meta.url));
}

/**
 * 把一段 JS 安全地放进 `<script>…</script>` 里。
 *
 * HTML 的 script-data 状态机里有两个序列会提前结束或改变解析：`</script`，以及 `<!--`
 * （它会让解析器进入 escaped 状态，后面的 `</script>` 就不认了）。两者换成 `<\/script` / `<\!--`：
 * JS 里 `\/` 与 `\!` 都是「未知转义」，值仍然是 `/` 和 `!`，所以**字符串与正则的字面值一个字节都不变**。
 * 前提是该序列出现在字符串/正则/注释里——代码正文里的 `<!--` 本来就是语法错误。
 *
 * 另一件必须记住的事：**内联时必须用 `replace(x, () => ...)` 的函数形式**。字符串形式的替换里
 * `$&`、`` $` ``、`$'`、`$1` 都是替换模式——而运行时源码里就有 `'$&/'`（React 的 key 转义），
 * 用字符串形式会把 `$&` 展开成整个匹配到的 `<script src="./support.js"></script>`，静默改坏运行时。
 */
function safeInlineScript(js: string): string {
  const escaped = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  if (/<\/script|<!--/i.test(escaped)) throw new Error('内联脚本里仍有 </script 或 <!--：拒绝导出（会破坏 HTML 解析）');
  return escaped;
}

export interface ExportResult {
  board: string;
  html: string;
  bytes: number;
  /** 导出时替换掉的东西，给模型/用户看的说明。 */
  notes: string[];
}

export interface ExportOptions {
  /** 设计稿目录（绝对路径）。 */
  canvasDir: string;
  /** 输出目录；不给时是 `<canvas 的上一级>/.design-preview/<canvas 名>/view/`。 */
  outDir?: string;
  /** 只导出这几块画板；不给时按 `canvas.json` 的 `order` 全导出。 */
  boards?: string[];
}

/** 把设计稿的画板导出成自包含 HTML。 */
export async function exportCanvas(options: ExportOptions): Promise<{ files: ExportResult[]; outDir: string }> {
  const { canvasDir } = options;
  const index = JSON.parse(await fs.readFile(path.join(canvasDir, 'canvas.json'), 'utf8')) as {
    order: string[];
    boards: Record<string, { w: number; h: number; expand?: string }>;
  };
  const order = options.boards ?? index.order;
  for (const board of order) {
    if (index.boards[board] === undefined) throw new Error(`canvas.json 的 boards 里没有这块画板：${board}`);
  }

  const outDir = options.outDir ?? path.join(path.dirname(canvasDir), '.design-preview', path.basename(canvasDir), 'view');
  await fs.mkdir(outDir, { recursive: true });
  const runtime = await fs.readFile(supportPath(), 'utf8');
  const assetsDir = path.join(canvasDir, 'assets');

  /** `/_blob/<id>` → data: URI（同一份只读一次）。 */
  const blobCache = new Map<string, string>();
  const blobDataUri = async (id: string): Promise<string | null> => {
    const cached = blobCache.get(id);
    if (cached !== undefined) return cached;
    const names = await fs.readdir(assetsDir).catch(() => [] as string[]);
    const name = names.find((n) => n.startsWith(`${id}.`) && !n.endsWith('.json'));
    if (name === undefined) return null;
    const bytes = await fs.readFile(path.join(assetsDir, name));
    const uri = `data:${mimeOf(name)};base64,${bytes.toString('base64')}`;
    blobCache.set(id, uri);
    return uri;
  };

  const files: ExportResult[] = [];
  for (const board of order) {
    const box = index.boards[board]!;
    const source = await fs.readFile(path.join(canvasDir, board), 'utf8');
    const notes: string[] = [];
    let html = source;

    // 1. 运行时：内联，替换掉那一行 <script src="./support.js"></script>。
    const supportLine = /<script\s+src=["']\.\/support\.js["']\s*>\s*<\/script>/i;
    if (supportLine.test(html)) {
      html = html.replace(supportLine, () => `<script>\n${safeInlineScript(runtime)}\n</script>`);
      notes.push('内联了画板运行时（vendor/support.js）');
    } else {
      notes.push('画板里没有 ./support.js 那一行：没内联运行时，导出可能挂载不起来');
    }

    // 2. `/_blob/<id>`：属性值与 CSS 里的 url() 都换成 data: URI。
    const ids = new Set<string>();
    for (const match of source.matchAll(/\/_blob\/([0-9a-f]{32})/g)) ids.add(match[1]!);
    let inlined = 0;
    for (const id of ids) {
      const uri = await blobDataUri(id);
      if (uri === null) {
        notes.push(`素材 /_blob/${id} 在 assets/ 里找不到：导出里还是死链`);
        continue;
      }
      html = html.split(`/_blob/${id}`).join(uri);
      inlined += 1;
    }
    if (inlined > 0) notes.push(`内联了 ${inlined} 个素材为 data: URI`);

    // 3. 画板之间的原型链接：`X.dc.html` → 导出后的 `X.html`，否则点了跳不过去。
    //    用函数形式（`$` 在字符串替换里是替换模式，见上）。
    let links = 0;
    html = html.replace(/href=(["'])([^"']*?)\.dc\.html\1/gi, (_whole, quote: string, target: string) => {
      links += 1;
      return `href=${quote}${target}.html${quote}`;
    });
    if (links > 0) notes.push(`把 ${links} 个画板间链接指向导出后的文件名`);

    // 3. 设计稿目录里的相对样式表与脚本：内联（否则 file:// 下取不到）。
    for (const match of [...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/gi)]) {
      const rel = match[1]!;
      if (/^(?:[a-z]+:)?\/\//i.test(rel)) continue; // 网上的（Google Fonts）留着
      const css = await fs.readFile(path.resolve(canvasDir, rel), 'utf8').catch(() => null);
      if (css === null) {
        notes.push(`样式表 ${rel} 找不到：导出里还是相对链接`);
        continue;
      }
      html = html.replace(match[0], () => `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`);
      notes.push(`内联了样式表 ${rel}`);
    }
    for (const match of [...html.matchAll(/<script\b[^>]*src=["']([^"']+\.js)["'][^>]*>\s*<\/script>/gi)]) {
      const rel = match[1]!;
      if (/^(?:[a-z]+:)?\/\//i.test(rel) || rel === './support.js') continue;
      const js = await fs.readFile(path.resolve(canvasDir, rel), 'utf8').catch(() => null);
      if (js === null) {
        notes.push(`脚本 ${rel} 找不到：导出里还是相对链接`);
        continue;
      }
      html = html.replace(match[0], () => `<script>\n${safeInlineScript(js)}\n</script>`);
      notes.push(`内联了脚本 ${rel}`);
    }

    // 4. 页面底色 + 居中（fill 型画板要铺满窗口，就不套内边距）。
    const fill = box.expand === 'fill';
    const shell = [
      '<style>',
      'html{background:#EFEEEB}',
      fill
        ? '#dc-root{min-height:100vh}'
        : `#dc-root{display:flex;justify-content:center;padding:32px;box-sizing:border-box;min-height:100vh}`,
      '</style>',
    ].join('\n');
    const head = /<head[^>]*>/i.exec(html);
    html = head ? `${html.slice(0, head.index + head[0].length)}\n${shell}${html.slice(head.index + head[0].length)}` : shell + html;

    const file = path.join(outDir, `${board.replace(/\.dc\.html$/i, '')}.html`);
    await fs.writeFile(file, html);
    files.push({ board, html: file, bytes: Buffer.byteLength(html), notes });
  }
  return { files, outDir };
}
