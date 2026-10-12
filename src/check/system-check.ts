/**
 * 设计系统的结构校验（`design_system_check` 工具，docs/design/canvas §10.5）。只看文件，不渲染，按原格式（design-system skill 的
 * SKILL.md 与 references/format.md，常量取自原版运行时）逐条查：
 *   - design-system.json：v3、`layout: "files"`、`createdOnFiles` / `convertedFrom` 标记（没有时编辑器只读）、不是旧的单文件信封、
 *     各字段的形状、`namespace`、`libraries`、`groups` 与 `assetGroups`、素材记录（`{name, blob, size, type}`，blob 在 `_blobs/` 里）
 *   - tokens.json：语法、列表形状与上限（tokens-check.ts）
 *   - 路径规则（layout.ts 的 `explainDesignSystemPath`）、文件数（自有 ≤1,008）、合计 ≤256 MiB、单个文件 ≤15 MiB
 *   - 按类别的大小：README ≤200 KB，章节 *.md 每个 ≤512 KB 且至多 24 个，组件 README ≤64 KB，preview.html ≤256 KB，bundle.js ≤6 MB，
 *     bundle.css ≤2 MB，*.d.ts 合计 ≤1.5 MB，lib/*.js 每个 ≤2 MB，src/** 每个 ≤512 KB，assets/<组>/<文件> 每个 ≤12 MB，其他 ≤512 KB
 *     （原版 `DESIGN_SYSTEM_INLINE_LIMITS`；原版编辑器对 files 布局不再按类别封顶，format.md 仍把它们列为格式规则，这里照 format.md）
 *   - preview.html：第一行 `<!-- @dsCard … -->`，不用 iframe / frame / object / embed / portal / noscript，不链接 bundle.js 与库
 *   - bundle.js：经典脚本（不 import / export）、赋值 `window.<namespace>`、不连网、不含 `</script` 与 `<!--`；`@ds-bundle` 头行
 *   - 字体：fonts/ 里只放 woff2 / woff / ttf / otf，扩展名与文件头一致，tokens.json 的 `type.fonts` 列出的都在、在的都列出
 *   - 预览与 lib/ 里指向网上的脚本、样式与图片（BaoCut 的 CSP 不放行 CDN，§10.2）；`/_blob/<id>` 引用都在 `_blobs/` 里
 * manifest.json、tokens.css、api/ 由编辑器保存时生成，不查（`notChecked`）。组件能不能渲染不在检查范围内。问题是给智能体看的英文，不进界面文案目录。
 */
// i18n-ignore-file: 给模型的校验结果
import fs from 'node:fs/promises';
import path from 'node:path';
import { BLOB_ID_PATTERN } from '../shared.ts';
import {
  BLOBS_DIR,
  COMPONENT_NAME_PATTERN,
  DESIGN_SYSTEM_FILE,
  DESIGN_SYSTEM_LIMITS,
  DESIGN_SYSTEM_PATHS,
  EDITOR_OWN_FILES,
  GENERATED_API_PATH_PATTERN,
  GENERATED_TOKENS_CSS_PATH,
  MAX_DESIGN_SYSTEM_INDEX_CHARS,
  WINDOW_NAMESPACE_PATTERN,
  designSystemTitle,
  explainDesignSystemPath,
  hasDesignSystemMarker,
  isDesignSystemIndex,
  isRecord,
} from './system-layout.ts';
import { TOKENS_LIMITS, checkTokensText, tokenFontFiles } from './tokens-check.ts';

export interface DesignSystemIssue {
  /** 相对设计系统目录的文件（`/` 分隔）；整个目录的问题是 `.`。 */
  file: string;
  message: string;
  /** 少数要按种类处理的问题带一个代码（`DESIGN_SYSTEM_ISSUE_CODES`）；其余没有。 */
  code?: DesignSystemIssueCode;
}

/**
 * 带代码的问题：
 * - `ASSET_RECORD_MISSING_UPLOAD`：索引里的素材记录（`assetGroups.<组>.files.*` 或 `blobs.*`）指向的上传不在 `_blobs/` 里，
 *   它还原到的路径上也没有文件，编辑器里这个素材打不开（`/_blob/<id>` 回 404）。
 */
export const DESIGN_SYSTEM_ISSUE_CODES = ['ASSET_RECORD_MISSING_UPLOAD'] as const;
export type DesignSystemIssueCode = (typeof DESIGN_SYSTEM_ISSUE_CODES)[number];

export interface DesignSystemCheckResult {
  /** 索引的标题（没有时是目录名）。 */
  title: string;
  /** 索引的 `namespace`（没有或不合规则时 null）。 */
  namespace: string | null;
  issues: DesignSystemIssue[];
  /**
   * 说明：原版能读、不用改，但编辑器不显示或会改写的地方（tokens.json 里不是 token 族的键；路径上已有文件的素材记录——
   * 文件优先，编辑器下次保存时去掉记录）。不算问题，`issues` 为空时照样算通过。
   */
  notes: DesignSystemIssue[];
  /** 编辑器保存时生成、不查的文件。 */
  notChecked: string[];
}

/** 不查的生成物（§10.5）。 */
export const DESIGN_SYSTEM_NOT_CHECKED = [DESIGN_SYSTEM_PATHS.manifest, GENERATED_TOKENS_CSS_PATH, 'api/'] as const;

const KIB = 1024;
const MIB = 1024 * 1024;
/** 按类别的大小上限（原版 `DESIGN_SYSTEM_INLINE_LIMITS`）。 */
export const DESIGN_SYSTEM_FILE_LIMITS = {
  readme: 200 * KIB,
  tokens: 512 * KIB,
  bundleJs: 6 * MIB,
  bundleCss: 2 * MIB,
  dtsTotal: 1.5 * MIB,
  preview: 256 * KIB,
  componentReadme: 64 * KIB,
  componentLib: 2 * MIB,
  asset: 12 * MIB,
  other: 512 * KIB,
} as const;
/** 章节（README 以外的 *.md）至多显示几个（原版 `MAX_DISPLAYED_DOCUMENTS`）。 */
export const MAX_SECTION_DOCUMENTS = 24;

/** 扫描目录时最多看这么多个条目（超过时只报文件数超限）。 */
const MAX_SCAN_ENTRIES = 20_000;
/** 读入检查内容的上限：比这大的只按大小报。 */
const MAX_READ_BYTES = 8 * MIB;
const FONT_EXTENSIONS: Record<string, string> = { woff2: 'WOFF2', woff: 'WOFF', ttf: 'TrueType', otf: 'OpenType' };
const FORBIDDEN_PREVIEW_ELEMENTS = ['iframe', 'frame', 'object', 'embed', 'portal', 'noscript'];
/** 原版 `COMPONENT_CARD_HEADER_PATTERN`。 */
const CARD_HEADER_PATTERN = /^[ \t]*<!--\s*@dsCard\b((?:(?!--)[^\r\n])*)(?:[\r\n]\s*)?-->/;
const ASSET_TILE_SIZES = new Set(['xs', 's', 'm', 'l', 'xl']);
const MAX_ASSET_GROUP_NAME_LENGTH = 80;
const RESERVED_PROTOTYPE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const TEXT_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'txt', 'json', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'svg', 'xml', 'csv', 'yml', 'yaml', 'toml']);
/** 原版的 `blob` 记录只认上传给的 id；BaoCut 的 id 是 32 位小写十六进制（docs/design/canvas §2.1）。 */
const BLOB_ID = BLOB_ID_PATTERN;

type FileKind =
  | 'index'
  | 'own'
  | 'generated'
  | 'readme'
  | 'tokens'
  | 'doc'
  | 'bundleJs'
  | 'bundleCss'
  | 'dts'
  | 'preview'
  | 'componentReadme'
  | 'componentSource'
  | 'componentLib'
  | 'componentOther'
  | 'font'
  | 'asset'
  | 'archived'
  | 'other';

function extensionOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  if (base.endsWith('.d.ts')) return 'd.ts';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1);
}

/** 原版 `isAdditionalMarkdownPath`，另不算生成的 api/ 卡片。 */
function isSectionDocument(rel: string): boolean {
  return (
    rel !== DESIGN_SYSTEM_PATHS.readme &&
    !rel.startsWith(DESIGN_SYSTEM_PATHS.componentsDir) &&
    !rel.startsWith(DESIGN_SYSTEM_PATHS.assetsDir) &&
    !rel.startsWith(DESIGN_SYSTEM_PATHS.fontsDir) &&
    !rel.startsWith(DESIGN_SYSTEM_PATHS.archivedDir) &&
    !GENERATED_API_PATH_PATTERN.test(rel) &&
    /\.(?:mdx?|markdown)$/i.test(rel)
  );
}

/** 原版 `classifyDesignSystemFile`，另分出索引、编辑器自己的文件、生成物与 archived/。 */
function classify(rel: string): FileKind {
  if (rel === DESIGN_SYSTEM_FILE) return 'index';
  if ((EDITOR_OWN_FILES as readonly string[]).includes(rel)) return 'own';
  if (rel === DESIGN_SYSTEM_PATHS.manifest || rel === GENERATED_TOKENS_CSS_PATH || rel.startsWith('api/')) return 'generated';
  if (rel === DESIGN_SYSTEM_PATHS.readme) return 'readme';
  if (rel === DESIGN_SYSTEM_PATHS.tokens) return 'tokens';
  if (rel.startsWith(DESIGN_SYSTEM_PATHS.archivedDir)) return 'archived';
  if (isSectionDocument(rel)) return 'doc';
  if (rel === DESIGN_SYSTEM_PATHS.bundleJs) return 'bundleJs';
  if (rel === DESIGN_SYSTEM_PATHS.bundleCss) return 'bundleCss';
  if (rel.startsWith(DESIGN_SYSTEM_PATHS.componentsDir)) {
    if (rel.startsWith(DESIGN_SYSTEM_PATHS.libDir)) return 'componentLib';
    if (extensionOf(rel) === 'd.ts') return 'dts';
    const parts = rel.slice(DESIGN_SYSTEM_PATHS.componentsDir.length).split('/');
    if (parts.length === 2 && parts[1] === 'preview.html') return 'preview';
    if (parts.length === 2 && parts[1] === 'README.md') return 'componentReadme';
    if (parts[0] === 'src' && parts.length >= 2) return 'componentSource';
    return 'componentOther';
  }
  if (rel.startsWith(DESIGN_SYSTEM_PATHS.fontsDir)) return 'font';
  if (rel.startsWith(DESIGN_SYSTEM_PATHS.assetsDir)) return 'asset';
  if (extensionOf(rel) === 'd.ts') return 'dts';
  return 'other';
}

/** 每个类别的上限与说法；没有单独上限的类别是 null（只受 15 MiB 的单文件上限约束）。 */
function limitOf(kind: FileKind): { bytes: number; label: string } | null {
  switch (kind) {
    case 'readme':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.readme, label: 'README.md' };
    case 'tokens':
      return { bytes: TOKENS_LIMITS.bytes, label: 'tokens.json' };
    case 'doc':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.other, label: 'a section document' };
    case 'bundleJs':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.bundleJs, label: 'bundle.js' };
    case 'bundleCss':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.bundleCss, label: 'bundle.css' };
    case 'preview':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.preview, label: 'a preview.html' };
    case 'componentReadme':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.componentReadme, label: "a component's README.md" };
    case 'componentLib':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.componentLib, label: 'a components/lib/ file' };
    case 'componentSource':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.other, label: 'a components/src/ file' };
    case 'componentOther':
    case 'other':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.other, label: 'a file the format has no place for' };
    case 'asset':
      return { bytes: DESIGN_SYSTEM_FILE_LIMITS.asset, label: 'an asset' };
    default:
      return null;
  }
}

interface SystemTree {
  /** 编辑器看得到的文件（相对路径）→ 字节数。不含 `_blobs/`。 */
  files: Map<string, number>;
  /** `_blobs/` 里的素材 id。 */
  blobs: Set<string>;
  /** `_blobs/` 以外文件的合计字节数。 */
  totalBytes: number;
  truncated: boolean;
}

async function scanTree(dir: string, issues: DesignSystemIssue[]): Promise<SystemTree> {
  const tree: SystemTree = { files: new Map(), blobs: new Set(), totalBytes: 0, truncated: false };
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
      // 以点开头的（.DS_Store、.git）编辑器看不到，原格式也拒收：不进清单、不报
      if (entry.name.startsWith('.')) continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (rel === '' && entry.name === BLOBS_DIR && entry.isDirectory()) {
        await scanBlobs(path.join(dir, BLOBS_DIR), tree);
        continue;
      }
      if (entry.isSymbolicLink()) {
        issues.push({ file: child, message: 'is a symbolic link; the editor ignores symbolic links. Replace it with a regular file or folder' });
        continue;
      }
      if (child !== DESIGN_SYSTEM_FILE) {
        const reason = explainDesignSystemPath(child);
        if (reason !== null) {
          issues.push({ file: child, message: `${reason}. The editor can't see it` });
          continue;
        }
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

async function scanBlobs(dir: string, tree: SystemTree): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const id = entry.name.split('.')[0]!;
    if (BLOB_ID.test(id)) tree.blobs.add(id);
  }
}

const isRemote = (url: string) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url.trim()) && !/^data:/i.test(url.trim());
const isGoogleFonts = (url: string) => /^(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com\//i.test(url.trim());

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|([^\\s>]+))`, 'i').exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** 文本里的 `/_blob/<id>` 引用：id 不在 `_blobs/` 里或写错格式的记成问题。 */
function checkBlobRefs(file: string, text: string, blobs: ReadonlySet<string>, issues: DesignSystemIssue[]): void {
  const reported = new Set<string>();
  for (const match of text.matchAll(/\/_blob\/([^\s"'()<>?#`\\]*)/g)) {
    const id = match[1]!;
    if (reported.has(id)) continue;
    reported.add(id);
    if (!BLOB_ID.test(id)) {
      issues.push({ file, message: `/_blob/${id} is not a valid upload reference: use the /_blob/<id> that design_system_import_asset returned (32 lowercase hex digits)` });
    } else if (!blobs.has(id)) {
      issues.push({ file, message: `/_blob/${id} is not in ${BLOBS_DIR}/: import the file with design_system_import_asset and use the src it returns` });
    }
  }
}

const NO_CDN = 'BaoCut previews load nothing from the network but Google Fonts (no CDN in the page CSP)';

/** 脚本里指向网上的加载：`import()`、`fetch()`、`importScripts()`、给 `src` 赋网址、`<script src>` 字符串。 */
function remoteScriptLoads(code: string): string[] {
  const urls: string[] = [];
  const patterns = [
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /\bimportScripts\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /\.src\s*=\s*['"`]([^'"`]+)['"`]/g,
    /<script\b[^>]*\bsrc\s*=\s*\\?['"]([^'"\\]+)/gi,
    /^\s*import\s+(?:[\w$*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const url = match[1]!;
      if (isRemote(url) && !isGoogleFonts(url) && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/** css 里指向网上的 `@import` 与 `url()`（Google Fonts 除外）。 */
function remoteCssLoads(css: string): string[] {
  const urls: string[] = [];
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) urls.push(match[1]!);
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) urls.push((match[1] ?? match[2] ?? match[3] ?? '').trim());
  return [...new Set(urls.filter(url => isRemote(url) && !isGoogleFonts(url)))];
}

/** 一个 preview.html：头行、禁用元素、链接 bundle.js 与库、指向网上的脚本 / 样式 / 图片。 */
function checkPreview(file: string, html: string, issues: DesignSystemIssue[]): void {
  const add = (message: string) => issues.push({ file, message });
  const text = html.replace(/^\uFEFF/, '');
  if (!CARD_HEADER_PATTERN.test(text)) {
    add('line 1 must be the marker <!-- @dsCard group="…" height=N … --> (height 40–4000); without it the card has no group or height');
  }
  const markup = text.replace(/<!--[\s\S]*?-->/g, comment => ' '.repeat(comment.length));
  const forbidden = new Set<string>();
  for (const match of markup.matchAll(/<([A-Za-z][A-Za-z0-9-]*)\b/g)) {
    const name = match[1]!.toLowerCase();
    if (FORBIDDEN_PREVIEW_ELEMENTS.includes(name)) forbidden.add(name);
  }
  for (const name of forbidden) add(`uses <${name}>; a preview may not contain <iframe>, <frame>, <object>, <embed>, <portal> or <noscript>`);
  for (const match of markup.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = attr(match[1] ?? '', 'src');
    if (src !== null) {
      const clean = src.trim();
      if (isRemote(clean)) add(`loads the script ${clean} from the network; ${NO_CDN}. Copy the library into components/lib/ and list it in the index's libraries`);
      else if (/(?:^|\/)(?:bundle\.js|lib\/[^/]+\.js|_vendor\/)/.test(clean.split(/[?#]/)[0]!)) {
        add(`links ${clean}; bundle.js and the libraries are preloaded in every preview, and a preview that links them doesn't load. Remove the <script src>`);
      }
    }
    for (const url of remoteScriptLoads(match[2] ?? '')) add(`its script loads ${url} from the network; ${NO_CDN}`);
  }
  for (const match of markup.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const href = attr(match[1] ?? '', 'href');
    if (href !== null && isRemote(href) && !isGoogleFonts(href)) add(`links ${href.trim()} from the network; ${NO_CDN}`);
  }
  for (const match of markup.matchAll(/<(?:img|source|video|audio)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const src = attr(match[1] ?? '', 'src');
    if (src !== null && isRemote(src)) add(`loads ${src.trim()} from the network; ${NO_CDN}. Put the file under assets/ and use a relative path, or import it with design_system_import_asset`);
  }
  for (const match of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    for (const url of remoteCssLoads(match[1] ?? '')) add(`its style loads ${url} from the network; ${NO_CDN}`);
  }
}

/** bundle.js 的 `@ds-bundle` 头行（原版 `parseBundleHeader`）：没有时 null，写坏了时 'invalid'。 */
function bundleHeader(script: string): { namespace: string | null } | 'invalid' | null {
  const prefix = script.slice(0, 262144);
  const offset = prefix.indexOf('@ds-bundle:');
  if (offset < 0) return null;
  const start = prefix.lastIndexOf('/*', offset);
  const end = prefix.indexOf('*/', offset);
  if (start < 0 || end < 0 || prefix.slice(0, start).trim() !== '') return 'invalid';
  try {
    const header: unknown = JSON.parse(prefix.slice(offset + 11, end).trim());
    if (!isRecord(header)) return 'invalid';
    const ns = header.namespace;
    return { namespace: typeof ns === 'string' && WINDOW_NAMESPACE_PATTERN.test(ns) ? ns : null };
  } catch {
    return 'invalid';
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** bundle.js：经典脚本、赋值 `window.<namespace>`、不连网、不含 `</script` 与 `<!--`。 */
function checkBundle(file: string, code: string, namespace: string | null, issues: DesignSystemIssue[]): void {
  const add = (message: string) => issues.push({ file, message });
  if (/^\s*import\s*(?:[\w$*{},\s]+\s*from\s*)?['"]|^\s*export\s+(?:default\b|\{|\*|const\b|let\b|var\b|function\b|class\b|async\b)|\bimport\.meta\b|\bimport\s*\(/m.test(code)) {
    add('is not a classic script: it uses import / export; bundle it into ONE classic script (an IIFE) that reads window.React and window.ReactDOM');
  }
  if (/<\/script/i.test(code)) add('contains a literal </script, which ends the inline <script> previews and consumers put it in; write it "<\\/script"');
  if (code.includes('<!--')) add('contains a literal <!--, which can escape the inline <script> previews and consumers put it in; write it "\\x3C!--"');
  if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+(?:WebSocket|EventSource)\s*\(|\bsendBeacon\s*\(|\bimportScripts\s*\(/.test(code)) {
    add('makes network requests (fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon); the bundle fetches nothing');
  }
  const header = bundleHeader(code);
  if (header === 'invalid') add('line 1 has an @ds-bundle header that is not /* @ds-bundle: {JSON} */ at the very start; fix it or remove it');
  const declared = header !== null && header !== 'invalid' ? header.namespace : null;
  if (declared !== null && namespace !== null && declared !== namespace) {
    add(`its @ds-bundle header names the namespace ${declared}, but design-system.json says ${namespace}; make them the same`);
  }
  const ns = namespace ?? declared;
  if (ns === null) return;
  const body = header !== null && header !== 'invalid' ? code.slice(code.indexOf('*/') + 2) : code;
  const name = escapeRegExp(ns);
  if (!new RegExp(`\\.\\s*${name}\\b|\\[\\s*['"\`]${name}['"\`]\\s*\\]|\\bvar\\s+${name}\\b`).test(body)) {
    add(`never assigns window.${ns}: the bundle must set window.${ns} = { …components } (the index's namespace)`);
  }
}

/** 字体文件：扩展名与文件头（woff2 `wOF2`、woff `wOFF`、ttf / otf 的 sfnt 头）。 */
async function checkFont(dir: string, file: string, issues: DesignSystemIssue[]): Promise<void> {
  const ext = extensionOf(file);
  const format = FONT_EXTENSIONS[ext];
  if (format === undefined) {
    issues.push({ file, message: 'fonts/ holds font files only (woff2, woff, ttf, otf); move it elsewhere' });
    return;
  }
  const handle = await fs.open(path.join(dir, ...file.split('/')), 'r').catch(() => null);
  if (handle === null) return;
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    const magic = head.subarray(0, bytesRead).toString('latin1');
    const sfnt = magic === '\u0000\u0001\u0000\u0000' || magic === 'OTTO' || magic === 'true' || magic === 'typ1';
    const ok = ext === 'woff2' ? magic === 'wOF2' : ext === 'woff' ? magic === 'wOFF' : sfnt;
    if (!ok) issues.push({ file, message: `is not a ${format} font: its first bytes don't match a .${ext} file. Use the real font file` });
  } finally {
    await handle.close();
  }
}

/** 原版 `isAssetGroupName`：素材组的文件夹名。 */
export function isAssetGroupName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_ASSET_GROUP_NAME_LENGTH &&
    !/[/\\\u0000-\u001f\u007f]/.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !RESERVED_PROTOTYPE_NAMES.has(name) &&
    name.trim() === name
  );
}

/** 索引的键：`[A-Za-z0-9_./-]` 以外的 UTF-8 字节写成 `~` 加两位小写十六进制（原版 `encodeFileIndexKey`）。 */
export function encodeIndexKey(key: string): string {
  let encoded = '';
  for (const byte of Buffer.from(key, 'utf8')) {
    const ch = String.fromCharCode(byte);
    encoded += byte < 128 && /[A-Za-z0-9_./-]/.test(ch) ? ch : `~${byte.toString(16).padStart(2, '0')}`;
  }
  return encoded;
}

/** `encodeIndexKey` 的反过程（原版 `decodeFileIndexKey`）：`~` 加两位十六进制换回字节；写坏了时原样返回。 */
export function decodeIndexKey(key: string): string {
  if (!key.includes('~')) return key;
  const bytes: number[] = [];
  for (let i = 0; i < key.length; i++) {
    const hex = key[i] === '~' ? key.slice(i + 1, i + 3) : '';
    if (/^[0-9a-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      for (const byte of Buffer.from(key[i]!, 'utf8')) bytes.push(byte);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

interface IndexContext {
  tree: SystemTree;
  add: (message: string, code?: DesignSystemIssueCode) => void;
  /** 路径上已有文件的记录（文件优先，见 `checkRecord`）：最后合成一条说明。 */
  shadowed: string[];
  /** 由记录还原出来、上传也在 `_blobs/` 里的路径：编辑器里看得到，按文件算（例如 tokens.json 列的字体）。 */
  restored: Set<string>;
}

/**
 * 一条素材记录 `{name, blob, size, type}`；`where` 是它在索引里的位置，`filePath` 是它还原到的路径。
 * 原版打开时先读文件、再还原记录（`restoreFilesFromIndex`）：路径上已有文件时文件优先、记录被跳过，下次保存时从索引里去掉
 * （`buildFilesIndex` 只为仍是上传的文件写记录）。原版导出的设计系统就是这样：素材按 `assets/<组>/<名字>` 写成文件，索引里的
 * 记录原样保留，没有 `_blobs/`。所以这种记录只记一条说明；路径上没有文件、上传也不在 `_blobs/` 里的才是问题。
 */
function checkRecord(ctx: IndexContext, where: string, record: unknown, filePath: (name: string) => string): void {
  const { add, shadowed, restored, tree } = ctx;
  if (!isRecord(record)) {
    add(`${where}: each record is {"name","blob","size","type"}`);
    return;
  }
  const { name, blob, size, type } = record;
  if (typeof name !== 'string' || name === '') {
    add(`${where}: "name" must be the file's path (below the group folder for a group's files)`);
    return;
  }
  const target = filePath(name);
  const reason = explainDesignSystemPath(target);
  if (reason !== null) add(`${where}: ${target} ${reason}; the editor skips the record`);
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) add(`${where}: "size" must be the file's size in bytes`);
  if (typeof type !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) add(`${where}: "type" must be the file's media type`);
  if (reason === null && tree.files.has(target)) {
    shadowed.push(target);
    return;
  }
  if (typeof blob !== 'string' || !BLOB_ID.test(blob)) {
    add(`${where}: "blob" must be the upload's id (the 32 hex digits after /_blob/ that design_system_import_asset returned)`);
  } else if (tree.blobs.has(blob)) {
    if (reason === null) restored.add(target);
  } else {
    add(
      `${where}: the upload ${blob} is not in ${BLOBS_DIR}/ and there is no file at ${target}, so the asset can't be shown. Put the file at ${target} (and delete the record), or import it with design_system_import_asset`,
      'ASSET_RECORD_MISSING_UPLOAD',
    );
  }
}

/** design-system.json 的字段（标记、形状、namespace、libraries、groups、assetGroups、blobs、docs）。 */
function checkIndex(index: Record<string, unknown>, ctx: IndexContext, note: (message: string) => void): void {
  checkIndexFields(index, ctx, note);
  const { shadowed } = ctx;
  if (shadowed.length > 0) {
    note(
      `${shadowed.length} asset ${shadowed.length === 1 ? 'record points' : 'records point'} at a path that is a file (${shadowed.slice(0, 3).join(', ')}${shadowed.length > 3 ? ', …' : ''}): the files are used and the records ignored, as in an exported system; the editor drops the records when it next rewrites the index`,
    );
  }
}

/**
 * 索引各字段的形状。原版打开时（`restoreFilesFromIndex`）缺了的字段按空值读（`libraries` []、`groups` []、`assetGroups` {}、
 * `blobs` {}、`sections` {}；分组缺 `name` 时从键解出），所以只查给了的字段写得对不对：刚建好、只有标记、title 与
 * namespace 的索引没有问题。`docs` 是编辑器保存时写的，原版不读，只查形状。
 */
function checkIndexFields(index: Record<string, unknown>, ctx: IndexContext, note: (message: string) => void): void {
  const { add, tree } = ctx;
  if (isRecord(index.content)) {
    add('has a "content" object: that is the old one-file envelope, not a files index. Move the files out of it into the folder');
  }
  if (!hasDesignSystemMarker(index)) {
    add('has no createdOnFiles or convertedFrom marker: the editor opens it read-only. A system you start gets "createdOnFiles": {"v": 1, "at": "<ISO time>"}');
  }
  if (Object.hasOwn(index, 'title') && typeof index.title !== 'string') add('"title" must be a string (the system\'s name)');
  else if (typeof index.title !== 'string' || index.title.trim() === '') note('has no "title": the system is shown under its folder name; the title is the system\'s name');
  if (Object.hasOwn(index, 'namespace') && (typeof index.namespace !== 'string' || !WINDOW_NAMESPACE_PATTERN.test(index.namespace))) {
    add('"namespace" must be the bundle\'s global: a JavaScript identifier of at most 64 characters (not __proto__, constructor or prototype)');
  }
  if (Object.hasOwn(index, 'libraries') && !Array.isArray(index.libraries)) add('"libraries" must be a list ([] when there is no bundle)');
  else if (Array.isArray(index.libraries)) {
    index.libraries.forEach((library, i) => {
      const where = `libraries[${i}]`;
      if (!isRecord(library) || typeof library.name !== 'string' || typeof library.version !== 'string') {
        add(`${where}: each library is {"name","version","global"?,"file"?}`);
        return;
      }
      const file = library.file;
      if (file !== undefined) {
        if (typeof file !== 'string' || !file.startsWith(DESIGN_SYSTEM_PATHS.libDir)) add(`${where}: "file" must be a path under ${DESIGN_SYSTEM_PATHS.libDir}`);
        else if (!tree.files.has(file)) add(`${where}: ${file} is not in the system`);
        if (library.global !== undefined && (typeof library.global !== 'string' || !WINDOW_NAMESPACE_PATTERN.test(library.global))) {
          add(`${where}: "global" must be the window global the library defines`);
        }
      } else if (library.name !== 'react' && library.name !== 'react-dom') {
        add(`${where}: ${library.name} has no "file", so previews can't load it (${NO_CDN}); copy it into ${DESIGN_SYSTEM_PATHS.libDir} and set "file" and "global"`);
      }
    });
  }
  if (Object.hasOwn(index, 'sections') && (!isRecord(index.sections) || Object.values(index.sections).some(v => typeof v !== 'string'))) {
    add('"sections" must be an object of card titles ({} in a new index)');
  }
  // groups 里的键不一定在 assetGroups 里（原版跳过；只有文件夹的组没有条目）
  if (Object.hasOwn(index, 'groups') && (!Array.isArray(index.groups) || index.groups.some(g => typeof g !== 'string'))) {
    add('"groups" must be a list of asset group keys');
  }
  if (Object.hasOwn(index, 'assetGroups') && !isRecord(index.assetGroups)) add('"assetGroups" must be an object keyed by group');
  for (const [key, group] of Object.entries(isRecord(index.assetGroups) ? index.assetGroups : {})) {
    const where = `assetGroups.${key}`;
    if (!isRecord(group)) {
      add(`${where}: each group is {"name","order","files","tile"?}`);
      continue;
    }
    const name = group.name === undefined ? decodeIndexKey(key) : group.name;
    if (!isAssetGroupName(name)) {
      add(`${where}: "name" must be the group folder's name (at most ${MAX_ASSET_GROUP_NAME_LENGTH} characters, no slashes or control characters)`);
      continue;
    }
    if (group.order !== undefined && (!Array.isArray(group.order) || group.order.some(n => typeof n !== 'string'))) add(`${where}: "order" must be a list of file names`);
    if (group.tile !== undefined && !ASSET_TILE_SIZES.has(group.tile as string)) add(`${where}: "tile" is one of "xs", "s", "m", "l", "xl"`);
    if (group.files === undefined) continue;
    if (!isRecord(group.files)) {
      add(`${where}: "files" must be an object of upload records ({} when the group's files are files)`);
      continue;
    }
    for (const [fileKey, record] of Object.entries(group.files)) {
      checkRecord(ctx, `${where}.files.${fileKey}`, record, n => `${DESIGN_SYSTEM_PATHS.assetsDir}${name}/${n}`);
    }
  }
  if (Object.hasOwn(index, 'blobs') && !isRecord(index.blobs)) add('"blobs" must be an object ({} in a new index)');
  for (const [key, record] of Object.entries(isRecord(index.blobs) ? index.blobs : {})) checkRecord(ctx, `blobs.${key}`, record, n => n);
  const docs = index.docs;
  if (
    docs !== undefined &&
    (!isRecord(docs) ||
      (docs.sections !== undefined && (!Array.isArray(docs.sections) || docs.sections.some(s => typeof s !== 'string'))) ||
      (docs.readme !== undefined && typeof docs.readme !== 'string'))
  ) {
    add('"docs" must be {"readme"?, "sections": […]} ({"sections": []} in a new index)');
  }
}

async function readText(dir: string, rel: string): Promise<string | null> {
  return fs.readFile(path.join(dir, ...rel.split('/')), 'utf8').catch(() => null);
}

/**
 * 校验一个设计系统目录。问题按文件给出，`file` 为 `.` 的是整个目录的问题。不是设计系统（没有索引或不合 §10.1）时
 * 也照常检查其余文件，并报一条 design-system.json 的问题。
 */
export async function checkDesignSystem(dir: string): Promise<DesignSystemCheckResult> {
  const issues: DesignSystemIssue[] = [];
  const notes: DesignSystemIssue[] = [];
  const tree = await scanTree(dir, issues);
  const notChecked = [...DESIGN_SYSTEM_NOT_CHECKED];

  // 索引
  let index: Record<string, unknown> | null = null;
  const indexText = tree.files.has(DESIGN_SYSTEM_FILE) ? await readText(dir, DESIGN_SYSTEM_FILE) : null;
  const addIndex = (message: string, code?: DesignSystemIssueCode) => issues.push({ file: DESIGN_SYSTEM_FILE, message, ...(code ? { code } : {}) });
  const noteIndex = (message: string) => notes.push({ file: DESIGN_SYSTEM_FILE, message });
  if (indexText === null) {
    addIndex('missing: a design system needs design-system.json with "v": 3, "layout": "files" and a createdOnFiles marker, written last');
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(indexText);
    } catch (error) {
      addIndex(`is not valid JSON: ${(error as Error).message}`);
    }
    // 只有标记也认得（原版 `isFilesIndex`），但写的人要按格式写全；带 "content" 对象的旧信封认不出，照样逐项检查，说清原因。
    const envelope = isRecord(parsed) && isRecord(parsed.content);
    const fields = isRecord(parsed) && (envelope || isDesignSystemIndex(parsed)) ? parsed : null;
    if (parsed !== undefined && (!fields || typeof fields.v !== 'number' || fields.v < 3 || fields.layout !== 'files')) {
      addIndex('must be an object with "v": 3 and "layout": "files"');
    }
    if (fields) index = fields;
    if (indexText.length > MAX_DESIGN_SYSTEM_INDEX_CHARS) addIndex(`has ${indexText.length} characters; the editor reads at most ${MAX_DESIGN_SYSTEM_INDEX_CHARS}`);
  }
  const restored = new Set<string>();
  if (index) checkIndex(index, { tree, add: addIndex, shadowed: [], restored }, noteIndex);
  const namespace = index && typeof index.namespace === 'string' && WINDOW_NAMESPACE_PATTERN.test(index.namespace) ? index.namespace : null;

  // 文件数与大小
  let ownFiles = 0;
  let dtsTotal = 0;
  const sections: string[] = [];
  for (const [file, bytes] of tree.files) {
    const kind = classify(file);
    ownFiles++;
    if (bytes > DESIGN_SYSTEM_LIMITS.fileBytes) {
      issues.push({ file, message: `is ${bytes} bytes; a file can be at most ${DESIGN_SYSTEM_LIMITS.fileBytes} (15 MiB)` });
      continue;
    }
    if (kind === 'dts') dtsTotal += bytes;
    if (kind === 'doc') sections.push(file);
    const limit = limitOf(kind);
    if (limit !== null && bytes > limit.bytes) issues.push({ file, message: `is ${bytes} bytes; ${limit.label} can be at most ${limit.bytes}` });
  }
  if (tree.truncated || ownFiles > DESIGN_SYSTEM_LIMITS.ownFiles) {
    issues.push({
      file: '.',
      message: `${tree.truncated ? `has more than ${MAX_SCAN_ENTRIES}` : `has ${ownFiles}`} files outside ${BLOBS_DIR}/; a design system holds at most ${DESIGN_SYSTEM_LIMITS.ownFiles} (the editor lists only the first ${DESIGN_SYSTEM_LIMITS.files})`,
    });
  }
  if (tree.totalBytes > DESIGN_SYSTEM_LIMITS.totalBytes) {
    issues.push({ file: '.', message: `files outside ${BLOBS_DIR}/ add up to ${tree.totalBytes} bytes; a design system holds at most ${DESIGN_SYSTEM_LIMITS.totalBytes} (256 MiB)` });
  }
  if (dtsTotal > DESIGN_SYSTEM_FILE_LIMITS.dtsTotal) {
    issues.push({ file: DESIGN_SYSTEM_PATHS.componentsDir.slice(0, -1), message: `the .d.ts files add up to ${dtsTotal} bytes; at most ${DESIGN_SYSTEM_FILE_LIMITS.dtsTotal} (1.5 MB)` });
  }
  if (sections.length > MAX_SECTION_DOCUMENTS) {
    issues.push({ file: '.', message: `has ${sections.length} section documents (*.md outside components/, assets/, fonts/ and archived/); the editor shows at most ${MAX_SECTION_DOCUMENTS}, the rest stay files` });
  }

  // 组件目录名
  for (const file of tree.files.keys()) {
    if (!file.startsWith(DESIGN_SYSTEM_PATHS.componentsDir)) continue;
    const parts = file.slice(DESIGN_SYSTEM_PATHS.componentsDir.length).split('/');
    if (parts.length === 2 && (parts[1] === 'preview.html' || parts[1] === 'README.md') && !COMPONENT_NAME_PATTERN.test(parts[0]!)) {
      issues.push({ file, message: `components/${parts[0]}/ is not a component name: an ASCII JavaScript identifier of at most 64 characters` });
    }
  }

  // tokens.json 与字体
  const tokensText = tree.files.has(DESIGN_SYSTEM_PATHS.tokens) ? await readText(dir, DESIGN_SYSTEM_PATHS.tokens) : null;
  if (tokensText !== null && (tree.files.get(DESIGN_SYSTEM_PATHS.tokens) ?? 0) <= TOKENS_LIMITS.bytes) {
    const tokens = checkTokensText(tokensText);
    for (const message of tokens.problems) issues.push({ file: DESIGN_SYSTEM_PATHS.tokens, message });
    for (const message of tokens.notes) notes.push({ file: DESIGN_SYSTEM_PATHS.tokens, message });
  }
  const listedFonts = new Set(tokensText === null ? [] : tokenFontFiles(tokensText));
  for (const font of listedFonts) {
    if (!tree.files.has(font) && !restored.has(font)) issues.push({ file: DESIGN_SYSTEM_PATHS.tokens, message: `type.fonts names ${font}, which is not in the system` });
  }
  for (const file of tree.files.keys()) {
    if (classify(file) !== 'font') continue;
    await checkFont(dir, file, issues);
    if (FONT_EXTENSIONS[extensionOf(file)] !== undefined && !listedFonts.has(file)) {
      issues.push({ file, message: 'is not listed in tokens.json type.fonts, so it gets no @font-face; list it ({"family","file","weight","style"})' });
    }
  }

  // assets/ 的组名
  for (const file of tree.files.keys()) {
    if (!file.startsWith(DESIGN_SYSTEM_PATHS.assetsDir)) continue;
    const rest = file.slice(DESIGN_SYSTEM_PATHS.assetsDir.length);
    const slash = rest.indexOf('/');
    if (slash > 0 && !isAssetGroupName(rest.slice(0, slash))) {
      issues.push({ file, message: `assets/${rest.slice(0, slash)}/ is not a valid group name (at most ${MAX_ASSET_GROUP_NAME_LENGTH} characters, no leading or trailing spaces)` });
    }
  }

  // 内容
  for (const [file, bytes] of tree.files) {
    const kind = classify(file);
    if (kind === 'generated' || kind === 'own' || kind === 'archived' || bytes > MAX_READ_BYTES || bytes > DESIGN_SYSTEM_LIMITS.fileBytes) continue;
    if (!TEXT_EXTENSIONS.has(extensionOf(file)) && kind !== 'componentLib') continue;
    const text = await readText(dir, file);
    if (text === null) continue;
    if (kind !== 'componentLib' && kind !== 'bundleJs') checkBlobRefs(file, text, tree.blobs, issues);
    if (kind === 'preview') checkPreview(file, text, issues);
    else if (kind === 'bundleJs') checkBundle(file, text, namespace, issues);
    else if (kind === 'bundleCss') {
      if (/<\/style/i.test(text)) issues.push({ file, message: 'contains a literal </style, which ends the inline <style> previews put it in' });
      for (const url of remoteCssLoads(text)) issues.push({ file, message: `loads ${url} from the network; ${NO_CDN}` });
    } else if (kind === 'componentLib' && /\.m?js$/i.test(file)) {
      if (/<\/script/i.test(text)) issues.push({ file, message: 'contains a literal </script, which ends the inline <script> previews put it in' });
      for (const url of remoteScriptLoads(text)) issues.push({ file, message: `loads ${url} from the network; ${NO_CDN}. Copy what it loads into components/lib/` });
    }
  }
  if (tree.files.has(DESIGN_SYSTEM_PATHS.bundleJs) && namespace === null && index !== null) {
    const bundle = await readText(dir, DESIGN_SYSTEM_PATHS.bundleJs);
    const header = bundle === null ? null : bundleHeader(bundle);
    if (header === null || header === 'invalid' || header.namespace === null) {
      addIndex('has no "namespace", and bundle.js has no @ds-bundle header naming one: set "namespace" to the bundle\'s window global');
    }
  }

  return { title: index ? designSystemTitle(index, dir) : path.basename(dir), namespace, issues, notes, notChecked };
}
