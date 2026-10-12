/**
 * 设计稿的结构校验（`design_check` 工具，docs/design/canvas §7.2）。只看文件，不渲染，按原格式
 * （design skill 的 SKILL.md「踩坑规则」与 references/format.md）逐条查：
 *   - canvas.json：v3、boards 的 x/y/w/h 与可选字段、guides、pages、notes、launch、order、designSystems 与 ds/<folder>/
 *   - boards 与 order 的路径都有文件；ds/ 以外的每个 .dc.html 都在 boards 里；画板文件名（不含 .dc.html）不重复
 *   - 每个画板：`<script src="./support.js"></script>` 头行、`<x-dc>`、唯一的 `data-dc-script` 块（classic JS 的
 *     `class Component extends DCLogic`）、单引号的 `data-props` 是合法 JSON、editor 取值、`$preview` 与 boards 的 w/h 一致
 *   - `<x-dc>` 标记：非空元素都闭合、属性都加引号、不自闭合（svg 里除外）、不用大写标签名、`{{ }}` 只是点号路径或字面量、
 *     `<dc-import name>` 与 `<a href="….dc.html">` 指向存在的画板
 *   - 脚本不拼界面（innerHTML、appendChild、自己的 window.X）、不装全局按键处理、不连网
 *   - 素材：`/_blob/<id>` 都在 assets/ 里；`<img src>` 与 `url(…)` 不用 data: URI、文件名或网址；行内 style 里不写 url(…)；
 *     没有 `<iframe>`/`<object>`/`<embed>`；网上的样式只认 Google Fonts；相对引用的支持文件都在设计稿里
 *   - 路径段的规则、文件数与合计大小的上限
 * ds/ 下是设计系统的原样拷贝，不查内容。画板脚本能不能跑、排版对不对不在检查范围内。问题是给智能体看的英文，不进界面文案目录。
 */
// i18n-ignore-file: 给模型的校验结果
import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR, BLOB_ID_PATTERN } from '../shared.ts';
import {
  BOARD_SUFFIX,
  CANVAS_FILE,
  CANVAS_LIMITS,
  DESIGN_SYSTEMS_DIR,
  canvasTitle,
  isBoardPath,
  isCanvasFile,
  isCanvasMetadata,
  isCanvasSegment,
} from './canvas-layout.ts';

export interface CanvasIssue {
  /** 相对设计稿目录的文件（`/` 分隔）；整个目录的问题是 `.`。 */
  file: string;
  message: string;
}

export interface CanvasCheckResult {
  /** canvas.json 的标题（没有时是目录名）。 */
  title: string;
  /** boards 里的画板数。 */
  boardCount: number;
  issues: CanvasIssue[];
}

/** 原格式的其他上限（SKILL.md 的 canvas.json 说明）。 */
const BOARD_SIZE = { min: 40, max: 8000 } as const;
const MAX_PAGES = 40;
const MAX_NOTES = 200;
const MAX_GUIDES = 6;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
/** 画板文件读入的上限：比这大的不读，只报一条。 */
const MAX_BOARD_BYTES = 8 * 1024 * 1024;
/** 扫描目录时最多看这么多个条目（超过时只报文件数超限）。 */
const MAX_SCAN_ENTRIES = 20_000;

const SUPPORT_LINE = '<script src="./support.js"></script>';
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.md', '.txt']);

interface CanvasTree {
  /** 编辑器看得到的文件（相对路径）→ 字节数。 */
  files: Map<string, number>;
  /** assets/ 里的素材 id。 */
  assets: Set<string>;
  /** 文件与素材的合计字节数。 */
  totalBytes: number;
  /** 扫描是否因为条目太多提前停下。 */
  truncated: boolean;
}

/** 扫一遍设计稿目录：可见文件、素材 id；段名不合规则的与符号链接直接记成问题。 */
async function scanTree(dir: string, issues: CanvasIssue[]): Promise<CanvasTree> {
  const tree: CanvasTree = { files: new Map(), assets: new Set(), totalBytes: 0, truncated: false };
  let seen = 0;
  const visit = async (rel: string): Promise<void> => {
    const full = rel === '' ? dir : path.join(dir, ...rel.split('/'));
    const entries = await fs.readdir(full, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++seen > MAX_SCAN_ENTRIES) {
        tree.truncated = true;
        return;
      }
      if (entry.name.startsWith('.')) continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (rel === '' && entry.name === ASSETS_DIR && entry.isDirectory()) {
        await scanAssets(path.join(dir, ASSETS_DIR), tree);
        continue;
      }
      if (entry.isSymbolicLink()) {
        issues.push({ file: child, message: 'is a symbolic link; the editor ignores symbolic links. Replace it with a regular file or folder' });
        continue;
      }
      if (!isCanvasSegment(entry.name)) {
        issues.push({
          file: child,
          message: `"${entry.name}" is not a valid path segment: start with a letter, digit or _, then use only letters, digits, _, . and - (no spaces). The editor can't see it`,
        });
        continue;
      }
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const stat = await fs.lstat(path.join(full, entry.name)).catch(() => null);
        const size = stat?.size ?? 0;
        tree.files.set(child, size);
        tree.totalBytes += size;
      }
    }
  };
  await visit('');
  return tree;
}

async function scanAssets(dir: string, tree: CanvasTree): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const id = entry.name.split('.')[0]!;
    if (BLOB_ID_PATTERN.test(id)) tree.assets.add(id);
    const stat = await fs.lstat(path.join(dir, entry.name)).catch(() => null);
    tree.totalBytes += stat?.size ?? 0;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** `data-props` 是普通的 HTML 属性：先按 HTML 解码实体，再按 JSON 解析。 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>' }[lower] ?? whole;
  });
}

const isRemote = (url: string) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url.trim()) && !/^data:/i.test(url.trim());
const isGoogleFonts = (url: string) => /^(?:https?:)?\/\/fonts\.googleapis\.com\//i.test(url.trim());

function attr(attrs: string, name: string): { value: string; quote: "'" | '"' | '' } | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|([^\\s>]+))`, 'i').exec(attrs);
  if (!match) return null;
  if (match[1] !== undefined) return { value: match[1], quote: "'" };
  if (match[2] !== undefined) return { value: match[2], quote: '"' };
  return { value: match[3]!, quote: '' };
}

/** 文本里的 `/_blob/<id>` 引用：id 不在 assets/ 里或写错格式的记成问题。 */
function checkBlobRefs(file: string, text: string, assets: ReadonlySet<string>, issues: CanvasIssue[]): void {
  const reported = new Set<string>();
  for (const match of text.matchAll(/\/_blob\/([^\s"'()<>?#]*)/g)) {
    const id = match[1]!;
    if (reported.has(id)) continue;
    reported.add(id);
    if (!BLOB_ID_PATTERN.test(id)) {
      issues.push({ file, message: `/_blob/${id} is not a valid asset reference: use the /_blob/<id> that design_import_asset returned (32 lowercase hex digits)` });
    } else if (!assets.has(id)) {
      issues.push({ file, message: `/_blob/${id} is not in assets/: import the file with design_import_asset and use the src it returns` });
    }
  }
}

/** css 里指向网上的 `@import`（Google Fonts 除外）。 */
function checkCssImports(file: string, css: string, issues: CanvasIssue[]): void {
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
    const url = match[1]!;
    if (isRemote(url) && !isGoogleFonts(url)) {
      issues.push({ file, message: `@import ${url} loads a stylesheet from the network; only Google Fonts (fonts.googleapis.com) is allowed. Keep styles inline or import the file with design_import_asset` });
    }
  }
}

interface BoardSize {
  w: number;
  h: number;
}

/** 一个画板文件校验时要的上下文。 */
interface BoardContext {
  file: string;
  size: BoardSize | null;
  tree: CanvasTree;
  /** ds/ 以外的画板文件名（不含 .dc.html）→ 路径，`<dc-import name>` 按它找。 */
  stems: ReadonlyMap<string, string>;
  issues: CanvasIssue[];
}

/** 标签的属性部分：引号里的 `>` 不算结束。 */
const ATTRS = String.raw`((?:[^>"']|"[^"]*"|'[^']*')*)`;
const TAG = new RegExp(String.raw`<(\/?)([A-Za-z][A-Za-z0-9:-]*)` + ATTRS + '>', 'g');
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
/** `data-props` 里 `editor` 的取值（format.md）。 */
const PROP_EDITORS = new Set(['text', 'color', 'int', 'float', 'range', 'boolean', 'enum']);
/** `{{ }}` 只能是点号路径或字面量（format.md：never an expression）。 */
const HOLE = /^\s*(?:[A-Za-z_$][\w$]*(?:\.[\w$]+)*|true|false|null|-?\d+(?:\.\d+)?|"[^"{}]*"|'[^'{}]*')\s*$/;

function attrList(attrs: string): { name: string; value: string | null; quoted: boolean }[] {
  const list: { name: string; value: string | null; quoted: boolean }[] = [];
  for (const match of attrs.matchAll(/([^\s=/"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
    const raw = match[2];
    if (raw === undefined) list.push({ name: match[1]!, value: null, quoted: false });
    else {
      const quoted = raw.startsWith('"') || raw.startsWith("'");
      list.push({ name: match[1]!, value: quoted ? raw.slice(1, -1) : raw, quoted });
    }
  }
  return list;
}

/** 在画板目录下解析相对引用；返回相对设计稿目录的路径，越出目录时 null。 */
function resolveRelative(file: string, ref: string): string | null {
  const clean = ref.split(/[?#]/)[0]!;
  const parts = clean.startsWith('/') ? [] : file.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

/** `/_blob/<id>`，以及设计系统 tokens.css 里的 `../_blob/<id>` 写法。 */
const isBlobUrl = (url: string) => /^(?:\.{1,2}\/)*\/?_blob\//.test(url.trim());

/** 图片与 `url(…)` 的地址：要么是上传的 `/_blob/<id>`，要么是 `{{hole}}`；data: URI 与文件名都不行。 */
function checkAssetUrl(ctx: BoardContext, url: string, where: string): void {
  const value = url.trim();
  if (value === '' || value.startsWith('#') || /^\{\{[\s\S]*\}\}$/.test(value) || isBlobUrl(value)) return;
  const add = (message: string) => ctx.issues.push({ file: ctx.file, message });
  if (/^data:/i.test(value)) add(`${where} uses a data: URI; upload the file with design_import_asset and use its /_blob/<id>`);
  else if (/^blob:/i.test(value)) add(`${where} uses a blob: URL, which only lives in one browser tab; upload the file with design_import_asset`);
  else if (isRemote(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!/^(?:https?:)?\/\/fonts\.gstatic\.com\//i.test(value)) add(`${where} loads ${value} from the network; upload the file with design_import_asset and use its /_blob/<id>`);
  } else add(`${where} names the file ${value}; upload it with design_import_asset and use the /_blob/<id> it returns`);
}

/** `<x-dc>` 里的标记：标签都要闭合、属性都要加引号、不自闭合（svg 里除外）、不用大写的标签名、`{{ }}` 只是查找。 */
function checkMarkup(ctx: BoardContext, markup: string): void {
  const add = (message: string) => ctx.issues.push({ file: ctx.file, message });
  const text = markup.replace(/<!--[\s\S]*?-->/g, comment => ' '.repeat(comment.length));
  const stack: string[] = [];
  const once = new Set<string>();
  const addOnce = (key: string, message: string) => {
    if (once.has(key)) return;
    once.add(key);
    add(message);
  };
  let svgDepth = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(text); match; match = TAG.exec(text)) {
    const closing = match[1] === '/';
    const name = match[2]!;
    const lower = name.toLowerCase();
    const attrs = match[3] ?? '';
    if (closing) {
      const at = stack.lastIndexOf(lower);
      if (at < 0) {
        addOnce(`stray:${lower}`, `</${name}> has no matching <${name}>`);
        continue;
      }
      for (const unclosed of stack.splice(at).slice(1).reverse()) addOnce(`open:${unclosed}`, `<${unclosed}> is not closed before </${name}>; close every non-void element`);
      if (lower === 'svg') svgDepth = Math.max(0, svgDepth - 1);
      continue;
    }
    if (svgDepth === 0 && /[A-Z]/.test(name)) {
      addOnce(`case:${name}`, `<${name}>: tag names are lower case; mount another artboard with <dc-import name="${name}"></dc-import>`);
    }
    const list = attrList(attrs.replace(/\/\s*$/, ''));
    for (const item of list) {
      if (item.value !== null && !item.quoted) addOnce(`quote:${item.name}`, `the attribute ${item.name}=${item.value} is not quoted; quote every attribute`);
      if (item.value !== null && /\{\{/.test(item.value)) {
        for (const hole of item.value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
          if (!HOLE.test(hole[1]!)) addOnce(`hole:${hole[1]}`, `{{${hole[1]}}} is an expression; a hole is a dotted lookup only: compute it in renderVals() and use its name`);
        }
      }
    }
    const style = list.find(item => item.name.toLowerCase() === 'style')?.value ?? '';
    if (/url\(/i.test(style)) addOnce('inline-url', 'url(…) in an inline style="…"; put it in a <helmet><style> rule');
    if (lower === 'img' || (lower === 'source' && svgDepth === 0)) {
      const src = list.find(item => item.name.toLowerCase() === 'src')?.value;
      if (src !== undefined && src !== null) checkAssetUrl(ctx, src, `<${lower} src>`);
    }
    if (lower === 'dc-import') {
      const ref = list.find(item => item.name.toLowerCase() === 'name')?.value ?? list.find(item => item.name.toLowerCase() === 'component')?.value;
      if (!ref) add('<dc-import> needs name="<artboard file name without .dc.html>"');
      else if (!/\{\{/.test(ref) && !ctx.stems.has(ref) && !ctx.tree.files.has(resolveRelative(ctx.file, `${ref}${BOARD_SUFFIX}`) ?? '')) {
        add(`<dc-import name="${ref}"> has no ${ref}${BOARD_SUFFIX} to mount`);
      }
    }
    if (lower === 'a') {
      const href = list.find(item => item.name.toLowerCase() === 'href')?.value;
      if (href && !/\{\{/.test(href) && !isRemote(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href) && href.split(/[?#]/)[0]!.endsWith(BOARD_SUFFIX)) {
        const target = resolveRelative(ctx.file, href);
        if (target === null || !ctx.tree.files.has(target)) add(`<a href="${href}"> links to an artboard that does not exist; the href is the target's path relative to this artboard (a leading / is the canvas root)`);
      }
    }
    const selfClosed = /\/\s*$/.test(attrs);
    if (RAW_TEXT.has(lower) && !selfClosed) {
      const end = new RegExp(`</${lower}\\s*>`, 'ig');
      end.lastIndex = TAG.lastIndex;
      const found = end.exec(text);
      if (!found) {
        addOnce(`open:${lower}`, `<${lower}> is never closed`);
        return;
      }
      if (lower === 'style') checkStyle(ctx, text.slice(TAG.lastIndex, found.index));
      TAG.lastIndex = end.lastIndex;
      continue;
    }
    if (VOID_ELEMENTS.has(lower)) continue;
    if (selfClosed) {
      if (svgDepth === 0) addOnce(`self:${lower}`, `<${name} /> is self-closed; write <${name}></${name}>`);
      continue;
    }
    stack.push(lower);
    if (lower === 'svg') svgDepth += 1;
  }
  for (const unclosed of stack.reverse()) addOnce(`open:${unclosed}`, `<${unclosed}> is never closed; close every non-void element`);
  for (const hole of text.replace(/<[^>]*>/g, ' ').matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    if (!HOLE.test(hole[1]!)) addOnce(`hole:${hole[1]}`, `{{${hole[1]}}} is an expression; a hole is a dotted lookup only: compute it in renderVals() and use its name`);
  }
}

/** 画板里的样式：网上的 `@import`、`url(…)` 的地址。 */
function checkStyle(ctx: BoardContext, css: string): void {
  checkCssImports(ctx.file, css, ctx.issues);
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const url = match[1] ?? match[2] ?? match[3] ?? '';
    if (/^(?:https?:)?\/\/fonts\.googleapis\.com\//i.test(url.trim())) continue;
    checkAssetUrl(ctx, url, 'url(…)');
  }
}

/** 画板里的脚本：界面不由脚本拼（innerHTML、appendChild、自己的 window.X），不装全局按键处理，不连网（format.md）。 */
function checkScript(ctx: BoardContext, code: string, logic: boolean): void {
  const add = (message: string) => ctx.issues.push({ file: ctx.file, message });
  if (logic) {
    if (!/\bclass\s+Component\s+extends\s+DCLogic\b/.test(code)) add('the data-dc-script block must define class Component extends DCLogic');
    if (/^\s*(?:import|export)\b/m.test(code)) add('the data-dc-script block is classic JS: no import or export');
  }
  if (/\.(?:inner|outer)HTML\s*=(?!=)|\binsertAdjacentHTML\s*\(|\.appendChild\s*\(|\bdocument\.write(?:ln)?\s*\(/.test(code)) {
    add('builds UI from script (innerHTML / appendChild / document.write); all UI is <x-dc> markup');
  }
  if (/\bwindow\.[A-Za-z_$][\w$]*\s*=(?!=)/.test(code)) add('sets a window.X global; keep state in the component (state / setState)');
  if (/\b(?:window|document|globalThis)\s*\.\s*(?:addEventListener\s*\(\s*['"`]key(?:down|up|press)['"`]|onkey(?:down|up|press)\s*=)/.test(code)) {
    add('installs a global keyboard handler; artboards must not handle keys on window or document');
  }
  for (const match of code.matchAll(/\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (isRemote(match[1]!)) add(`fetch("${match[1]}") goes to the network; upload the data with design_import_asset and fetch its /_blob/<id>`);
  }
  if (/\bnew\s+(?:WebSocket|EventSource)\s*\(|\bXMLHttpRequest\b/.test(code)) add('opens a network connection (WebSocket / EventSource / XMLHttpRequest); artboards stay offline');
}

function checkBoardFile(ctx: BoardContext, html: string): void {
  const { file, size } = ctx;
  const add = (message: string) => ctx.issues.push({ file, message });
  const support = html.indexOf(SUPPORT_LINE);
  const headEnd = html.search(/<\/head\s*>/i);
  if (support < 0) add(`the <head> must contain the exact line ${SUPPORT_LINE}`);
  else if (headEnd >= 0 && support > headEnd) add(`${SUPPORT_LINE} must be inside <head>`);
  const open = /<x-dc\s*>/i.exec(html);
  const close = /<\/x-dc\s*>/i.exec(html);
  if (!open || !close || close.index < open.index) add('the markup must be wrapped in <x-dc>…</x-dc>');
  else checkMarkup(ctx, html.slice(open.index + open[0].length, close.index));

  const scripts = [...html.matchAll(new RegExp(String.raw`<script\b` + ATTRS + String.raw`>([\s\S]*?)<\/script\s*>`, 'gi'))];
  const blocks = scripts.filter(m => attrList(m[1] ?? '').some(a => a.name.toLowerCase() === 'data-dc-script'));
  if (blocks.length === 0) add('missing the <script type="text/x-dc" data-dc-script data-props=\'…\'> block (class Component extends DCLogic)');
  else if (blocks.length > 1) add(`has ${blocks.length} data-dc-script blocks; an artboard has exactly one`);
  const block = blocks[0];
  if (block) {
    const attrs = block[1] ?? '';
    if (attr(attrs, 'type')?.value.toLowerCase() !== 'text/x-dc') add('the data-dc-script block must have type="text/x-dc"');
    const props = attr(attrs, 'data-props');
    if (props === null) add(`the data-dc-script block needs data-props='{"$preview":{"width":…,"height":…}}'`);
    else if (props.quote !== "'") add("data-props must be single-quoted: data-props='{…}'");
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeEntities(props.value));
      } catch (error) {
        add(`data-props is not valid JSON (${(error as Error).message}); escape & as &amp; and ' as &#39;`);
      }
      if (parsed !== undefined) {
        const preview = isRecord(parsed) ? parsed.$preview : undefined;
        if (!isRecord(preview) || !isFiniteNumber(preview.width) || !isFiniteNumber(preview.height)) {
          add('data-props needs "$preview": {"width": <number>, "height": <number>} equal to the board\'s w and h');
        } else if (size && (preview.width !== size.w || preview.height !== size.h)) {
          add(`$preview is ${preview.width}×${preview.height} but canvas.json boards gives ${size.w}×${size.h}; make them equal`);
        }
        if (isRecord(parsed)) {
          for (const [key, spec] of Object.entries(parsed)) {
            if (key === '$preview' || !isRecord(spec) || !('editor' in spec)) continue;
            if (spec.editor !== null && !(typeof spec.editor === 'string' && PROP_EDITORS.has(spec.editor))) {
              add(`data-props "${key}": editor must be one of text, color, int, float, range, boolean, enum or null`);
            }
          }
        }
      }
    }
    checkScript(ctx, block[2] ?? '', true);
  }
  for (const script of scripts) {
    if (script === block) continue;
    const list = attrList(script[1] ?? '');
    const src = list.find(a => a.name.toLowerCase() === 'src')?.value;
    if (typeof src === 'string') {
      if (src === './support.js') continue;
      if (isRemote(src)) add(`<script src="${src}"> loads a script from the network; import it with design_import_asset and use its /_blob/<id>`);
      else if (!isBlobUrl(src)) checkRelativeFile(ctx, src, '<script src>');
    } else checkScript(ctx, script[2] ?? '', false);
  }

  const embedded = new Set([...html.matchAll(/<(iframe|object|embed)\b/gi)].map(m => m[1]!.toLowerCase()));
  for (const tag of embedded) add(`<${tag}> is not allowed in an artboard`);

  for (const match of html.matchAll(new RegExp(String.raw`<link\b` + ATTRS + '>', 'gi'))) {
    const list = attrList(match[1] ?? '');
    const rel = list.find(a => a.name.toLowerCase() === 'rel')?.value?.toLowerCase() ?? '';
    const href = list.find(a => a.name.toLowerCase() === 'href')?.value;
    if (typeof href !== 'string' || !rel.split(/\s+/).some(r => r === 'stylesheet' || r === 'preload' || r === 'modulepreload')) continue;
    if (isRemote(href)) {
      if (!isGoogleFonts(href)) add(`<link href="${href}"> loads from the network; only Google Fonts (fonts.googleapis.com) is allowed. Import the file with design_import_asset instead`);
    } else if (!isBlobUrl(href)) checkRelativeFile(ctx, href, '<link href>');
  }
  checkBlobRefs(file, html, ctx.tree.assets, ctx.issues);
}

/** 画板按相对路径引用的支持文件（css、js、json，docs/design/canvas §2.1）必须在设计稿里。 */
function checkRelativeFile(ctx: BoardContext, ref: string, where: string): void {
  const target = resolveRelative(ctx.file, ref);
  if (target === null || target === '' || !ctx.tree.files.has(target)) {
    ctx.issues.push({ file: ctx.file, message: `${where} "${ref}" is not a file in this design; write it there or upload it with design_import_asset` });
  }
}

const GUIDE_KINDS = new Set(['columns', 'rows', 'grid']);
/** `title1` 是标题，没有 kind 是便签，其余是用户在画布上画的（SKILL.md 的 notes 说明）。 */
const NOTE_KINDS = new Set(['title1', 'rect', 'oval', 'pen', 'line', 'arrow', 'image']);
/** 设计系统在 ds/ 下的目录名（design-system-components.md：小写，至多 64 个字符，不以 - 或 _ 开头）。 */
const DS_FOLDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_DESIGN_SYSTEMS = 4;

/**
 * `designSystems` 与 `ds/<folder>/`：编辑器只在两者都在时才提供设计系统的颜色、文字样式与组件
 * （design-system-components.md）。拷了文件却没记录是问题；有记录、目录里还没有文件不算：skill 允许没有
 * `tokens.json` 时照装并说明（同原版），编辑器这时只是给不出设计系统的颜色。
 */
function checkDesignSystems(value: unknown, tree: CanvasTree, add: (message: string) => void): void {
  const folders = new Set<string>();
  for (const file of tree.files.keys()) {
    const parts = file.split('/');
    if (parts[0] === DESIGN_SYSTEMS_DIR && parts.length > 2) folders.add(parts[1]!);
    else if (parts[0] === DESIGN_SYSTEMS_DIR && parts.length === 2) add(`${file}: files under ${DESIGN_SYSTEMS_DIR}/ belong in ${DESIGN_SYSTEMS_DIR}/<folder>/, one folder per design system`);
  }
  for (const folder of folders) {
    if (!DS_FOLDER.test(folder)) add(`${DESIGN_SYSTEMS_DIR}/${folder}/: a design system folder is lower case letters, digits, - and _, starting with a letter or digit, 64 at most`);
  }
  const recorded = new Set<string>();
  if (value !== undefined) {
    if (!Array.isArray(value)) add('designSystems must be an array of {"title","namespace","artifact","version","copiedAt"}');
    else {
      if (value.length > MAX_DESIGN_SYSTEMS) add(`designSystems has ${value.length} entries; a design uses at most ${MAX_DESIGN_SYSTEMS}`);
      value.forEach((record, i) => {
        const where = `designSystems[${i}]`;
        if (
          !isRecord(record) ||
          typeof record.title !== 'string' ||
          typeof record.namespace !== 'string' ||
          typeof record.artifact !== 'string' ||
          !(record.version === null || typeof record.version === 'string') ||
          typeof record.copiedAt !== 'string'
        ) {
          add(`${where} must be {"title": <string>, "namespace": <folder>, "artifact": <where it was copied from>, "version": <string or null>, "copiedAt": <RFC 3339 time>}`);
          return;
        }
        if (recorded.has(record.namespace)) add(`${where}: designSystems has the namespace "${record.namespace}" more than once`);
        recorded.add(record.namespace);
      });
    }
  }
  for (const folder of folders) {
    if (!recorded.has(folder)) add(`${DESIGN_SYSTEMS_DIR}/${folder}/ has no record in designSystems; the editor offers a design system only when both are there`);
  }
}

/** 检查 canvas.json 的字段与上限；返回画板路径 → 大小（字段不对的画板也在里面，大小为 null）。 */
function checkIndex(canvas: Record<string, unknown> & { boards: Record<string, unknown> }, tree: CanvasTree, issues: CanvasIssue[]): Map<string, BoardSize | null> {
  const add = (message: string) => issues.push({ file: CANVAS_FILE, message });
  if (canvas.title !== undefined && typeof canvas.title !== 'string') add('title must be a string');
  if (canvas.createdOnFiles !== undefined) {
    const created = canvas.createdOnFiles;
    if (!isRecord(created) || created.v !== 1 || typeof created.at !== 'string') add('createdOnFiles must be {"v":1,"at":"<ISO time>"}');
  }
  checkDesignSystems(canvas.designSystems, tree, add);

  const pageIds = new Set<string>();
  if (canvas.pages !== undefined) {
    if (!Array.isArray(canvas.pages)) add('pages must be an array of {"id","name"}');
    else {
      if (canvas.pages.length > MAX_PAGES) add(`pages has ${canvas.pages.length} entries; at most ${MAX_PAGES}`);
      canvas.pages.forEach((page, i) => {
        if (!isRecord(page) || typeof page.id !== 'string' || !ID_PATTERN.test(page.id) || typeof page.name !== 'string') {
          add(`pages[${i}] must be {"id": [A-Za-z0-9_-]{1,40}, "name": <string>}`);
          return;
        }
        if (pageIds.has(page.id)) add(`pages has the id "${page.id}" more than once`);
        pageIds.add(page.id);
      });
    }
  }

  const boards = new Map<string, BoardSize | null>();
  for (const [key, value] of Object.entries(canvas.boards)) {
    const where = `boards["${key}"]`;
    if (!isCanvasFile(key) || !key.endsWith(BOARD_SUFFIX) || key.split('/')[0] === DESIGN_SYSTEMS_DIR) {
      add(`${where}: the key must be the artboard file's path, ending in ${BOARD_SUFFIX}, outside ${ASSETS_DIR}/ and ${DESIGN_SYSTEMS_DIR}/, with valid path segments`);
    } else if (!tree.files.has(key)) {
      add(`${where}: the file ${key} does not exist; write it or remove the entry`);
    }
    if (!isRecord(value)) {
      add(`${where} must be an object with x, y, w and h`);
      boards.set(key, null);
      continue;
    }
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) add(`${where}: x and y must be numbers`);
    const sizeOk = (n: unknown): n is number => isFiniteNumber(n) && n >= BOARD_SIZE.min && n <= BOARD_SIZE.max;
    if (!sizeOk(value.w) || !sizeOk(value.h)) add(`${where}: w and h must be numbers from ${BOARD_SIZE.min} to ${BOARD_SIZE.max}`);
    boards.set(key, sizeOk(value.w) && sizeOk(value.h) ? { w: value.w, h: value.h } : null);
    if (value.title !== undefined && typeof value.title !== 'string') add(`${where}: title must be a string`);
    if (value.page !== undefined && (typeof value.page !== 'string' || !pageIds.has(value.page))) add(`${where}: page must be the id of an entry in pages`);
    if (value.expand !== undefined && value.expand !== 'fill') add(`${where}: expand can only be "fill"`);
    if (value.print !== undefined && value.print !== 'flow') add(`${where}: print can only be "flow"`);
    if (value.paper !== undefined && value.paper !== 'letter' && value.paper !== 'a4') add(`${where}: paper must be "letter" or "a4"`);
    if (value.is_interactive !== undefined && typeof value.is_interactive !== 'boolean') add(`${where}: is_interactive must be true or false`);
    if (value.frameless !== undefined && typeof value.frameless !== 'boolean') add(`${where}: frameless must be true or false`);
    if (value.radius !== undefined && !(isFiniteNumber(value.radius) && value.radius >= 0)) add(`${where}: radius must be a number of px, 0 or more`);
    if (value.guides !== undefined) {
      if (!Array.isArray(value.guides) || !value.guides.every(isRecord)) add(`${where}: guides must be an array of guide objects`);
      else {
        if (value.guides.length > MAX_GUIDES) add(`${where}: guides has ${value.guides.length} entries; at most ${MAX_GUIDES}`);
        value.guides.forEach((guide, i) => {
          if (!GUIDE_KINDS.has(guide.kind as string)) add(`${where}: guides[${i}].kind must be "columns", "rows" or "grid"`);
        });
      }
    }
  }

  if (!Array.isArray(canvas.order)) add('order must be an array of the board paths, back to front');
  else {
    const listed = new Set<string>();
    canvas.order.forEach((item, i) => {
      if (typeof item !== 'string' || !boards.has(item)) {
        add(`order[${i}] (${JSON.stringify(item)}) is not a key of boards`);
        return;
      }
      if (listed.has(item)) add(`order lists ${item} more than once`);
      listed.add(item);
    });
    for (const key of boards.keys()) if (!listed.has(key)) add(`${key} is in boards but not in order`);
  }

  if (canvas.notes !== undefined) {
    if (!isRecord(canvas.notes)) add('notes must be an object {"<id>": {"x","y","text",…}}');
    else {
      const entries = Object.entries(canvas.notes);
      if (entries.length > MAX_NOTES) add(`notes has ${entries.length} entries; at most ${MAX_NOTES}`);
      for (const [id, note] of entries) {
        if (!ID_PATTERN.test(id)) add(`notes: the id "${id}" must match [A-Za-z0-9_-]{1,40}`);
        if (!isRecord(note) || !isFiniteNumber(note.x) || !isFiniteNumber(note.y) || typeof note.text !== 'string') {
          add(`notes["${id}"] needs numbers x and y and a string text`);
          continue;
        }
        if (note.kind !== undefined && !NOTE_KINDS.has(note.kind as string)) {
          add(`notes["${id}"].kind must be "title1" (a title over several artboards), left out (a sticky), or one of the user's rect, oval, pen, line, arrow, image`);
        }
        if (note.page !== undefined && (typeof note.page !== 'string' || !pageIds.has(note.page))) add(`notes["${id}"].page must be the id of an entry in pages`);
      }
    }
  }

  if (canvas.launch !== undefined) {
    const launch = canvas.launch;
    if (!isRecord(launch)) add('launch must be {"view":"canvas"} or {"view":"focused","file":"<board path>"}');
    else if (launch.view === 'canvas') {
      if (launch.page !== undefined && (typeof launch.page !== 'string' || !pageIds.has(launch.page))) add('launch.page must be the id of an entry in pages');
    } else if (launch.view === 'focused') {
      if (typeof launch.file !== 'string' || !boards.has(launch.file)) add('launch.file must be a key of boards');
    } else add('launch.view must be "canvas" or "focused"');
  }
  return boards;
}

/**
 * 校验一份设计稿目录（docs/design/canvas §7.2）。目录本身不是设计稿（canvas.json 缺失或不合 §2.1）时，issues 里只有
 * canvas.json 的问题。
 */
export async function checkCanvas(dir: string): Promise<CanvasCheckResult> {
  const issues: CanvasIssue[] = [];
  const tree = await scanTree(dir, issues);
  const fileCount = tree.files.size;
  if (tree.truncated || fileCount > CANVAS_LIMITS.files) {
    issues.push({
      file: '.',
      message: `${tree.truncated ? 'more than' : 'has'} ${tree.truncated ? MAX_SCAN_ENTRIES : fileCount} files outside assets/; a design holds at most ${CANVAS_LIMITS.files} (the editor lists only the first ${CANVAS_LIMITS.files})`,
    });
  }
  if (tree.totalBytes > CANVAS_LIMITS.totalBytes) {
    issues.push({ file: '.', message: `files and assets add up to ${tree.totalBytes} bytes; a design holds at most ${CANVAS_LIMITS.totalBytes} (256 MB)` });
  }

  let raw: string | null = null;
  const indexFile = path.join(dir, CANVAS_FILE);
  const indexStat = await fs.lstat(indexFile).catch(() => null);
  if (indexStat?.isFile()) raw = await fs.readFile(indexFile, 'utf8').catch(() => null);
  let parsed: unknown;
  if (raw === null) issues.push({ file: CANVAS_FILE, message: 'missing: a design needs canvas.json with "v": 3 and "boards"' });
  else {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      issues.push({ file: CANVAS_FILE, message: `is not valid JSON: ${(error as Error).message}` });
    }
  }
  if (raw !== null && parsed !== undefined && !isCanvasMetadata(parsed)) {
    issues.push({ file: CANVAS_FILE, message: 'must be an object with "v": 3 and "boards" as an object keyed by artboard path' });
  }
  const canvas = isCanvasMetadata(parsed) ? (parsed as Record<string, unknown> & { boards: Record<string, unknown> }) : null;
  const boards = canvas ? checkIndex(canvas, tree, issues) : new Map<string, BoardSize | null>();

  const stems = new Map<string, string>();
  for (const file of tree.files.keys()) {
    if (!isBoardPath(file)) continue;
    const stem = path.basename(file).slice(0, -BOARD_SUFFIX.length);
    const other = stems.get(stem);
    if (other !== undefined) issues.push({ file, message: `has the same name as ${other}; artboard file names (without ${BOARD_SUFFIX}) must be unique` });
    else stems.set(stem, file);
  }
  for (const [file, bytes] of tree.files) {
    const ext = path.extname(file).toLowerCase();
    const board = isBoardPath(file);
    // ds/ 下是设计系统的原样拷贝（design-system-components.md），不由智能体改，不查内容。
    if (file.split('/')[0] === DESIGN_SYSTEMS_DIR) continue;
    if (board) {
      if (canvas && !boards.has(file)) {
        issues.push({
          file,
          message: `is not in canvas.json boards; every ${BOARD_SUFFIX} outside ${DESIGN_SYSTEMS_DIR}/ shows on the canvas, so add a boards entry (w and h = its $preview) and its path in order`,
        });
      }
    }
    if (!board && !TEXT_EXTENSIONS.has(ext)) continue;
    if (bytes > MAX_BOARD_BYTES) {
      if (board) issues.push({ file, message: `is ${bytes} bytes; an artboard file should stay well under ${MAX_BOARD_BYTES}` });
      continue;
    }
    const text = await fs.readFile(path.join(dir, ...file.split('/')), 'utf8').catch(() => null);
    if (text === null) continue;
    if (board) checkBoardFile({ file, size: boards.get(file) ?? null, tree, stems, issues }, text);
    else {
      checkBlobRefs(file, text, tree.assets, issues);
      if (ext === '.css') checkCssImports(file, text, issues);
    }
  }

  return {
    title: canvas ? canvasTitle(canvas, dir) : path.basename(dir),
    boardCount: canvas ? Object.keys(canvas.boards).length : 0,
    issues,
  };
}
