/**
 * 设计系统目录的文件布局与识别（docs/design/canvas §10.1）。格式是原格式（`design-system.json` v3、`layout: "files"`）在磁盘上的样子：
 *
 *   <system>/design-system.json     索引
 *   <system>/README.md、*.md、tokens.json、components/、assets/<组>/、fonts/、archived/   内容
 *   <system>/manifest.json、tokens.css、api/   编辑器保存时生成
 *   <system>/_blobs/<id>.<ext>      上传的素材（由 DeckStore 管，不进清单、不被监听）
 *
 * 编辑器看得到、能写的是路径合原格式规则（`explainDesignSystemPath`）的普通文件，加上索引本身；`_blobs/` 下的、以点开头的、
 * 符号链接不算。存储与路由沿用 `@baocut/slides` 的 DeckStore / SlidesServer，这里给出布局（`DESIGN_SYSTEM_LAYOUT`）。
 * 路径规则照搬原版 `isValidDesignSystemPath`、`explainToolConfigurationPath`、`explainReservedSystemPath` 与运行时路径的
 * `validateFilePath`；原版运行时保存时按这些规则拒收，检查（`checkDesignSystem`）与布局用同一套，免得「检查通过、保存失败」。
 */
// i18n-ignore-file: 路径规则的说明给模型与运行日志看
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeckLayout } from '../shared.ts';
import type { DesignSystemInfo } from '../shared.ts';

/** 设计系统目录的索引。 */
export const DESIGN_SYSTEM_FILE = 'design-system.json';
/** 上传的素材目录（原格式里 `assets/<组>/` 是内容路径，所以不叫 assets）。 */
export const BLOBS_DIR = '_blobs';

/**
 * 原格式的上限（§10.1）：一个版本至多 1,024 个文件（其中 16 个留给原平台的类型文件，自有 1,008 个）、合计 256 MiB，
 * 单个文件 15 MiB，一次发布 16 MiB；上传一个素材 20 MiB，SVG 2 MiB（原版 `BLOB_STORAGE_LIMITS`）。
 */
export const DESIGN_SYSTEM_LIMITS = {
  files: 1024,
  ownFiles: 1008,
  totalBytes: 256 * 1024 * 1024,
  fileBytes: 15 * 1024 * 1024,
  publishBytes: 16 * 1024 * 1024,
  uploadBytes: 20 * 1024 * 1024,
  svgUploadBytes: 2 * 1024 * 1024,
} as const;

/** 设计系统里的固定路径（原版 `DESIGN_SYSTEM_PATHS`）。 */
export const DESIGN_SYSTEM_PATHS = {
  readme: 'README.md',
  tokens: 'tokens.json',
  manifest: 'manifest.json',
  componentsDir: 'components/',
  libDir: 'components/lib/',
  bundleJs: 'components/bundle.js',
  bundleCss: 'components/bundle.css',
  indexDts: 'components/index.d.ts',
  fontsDir: 'fonts/',
  assetsDir: 'assets/',
  archivedDir: 'archived/',
} as const;

/** 编辑器保存时生成的文件（`design_system_check` 不查，列进 `notChecked`）。 */
export const GENERATED_TOKENS_CSS_PATH = 'tokens.css';
export const GENERATED_API_PATH_PATTERN = /^api\/(?:icons\.md|tokens\.md|(?:tokens|components|assets)\/[^/]+\.md)$/;
/** 编辑器自己的文件（迁移清单等）：可以读写，不是内容。 */
export const EDITOR_OWN_FILES = ['migration.json', 'design-system.before-files.json', 'publish-progress.json', 'migration-map.json'] as const;

/** 组件名与组件包的全局名（原版 `COMPONENT_NAME_PATTERN` / `WINDOW_NAMESPACE_PATTERN`）。 */
export const WINDOW_NAMESPACE_PATTERN = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
export const COMPONENT_NAME_PATTERN = WINDOW_NAMESPACE_PATTERN;

const MAX_DESIGN_SYSTEM_PATH_LENGTH = 300;
/** 运行时路径（`project/<路径>`）的 UTF-8 字节上限（原版 `MAX_FILE_PATH_UTF8_BYTES`）。 */
const MAX_RUNTIME_PATH_UTF8_BYTES = 512;
const UNSAFE_PATH_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2028\u2029\u2060-\u206f\u2215\u2044\ufeff\uff0f]/;
/** 运行时路径不能有的字符（原版 `validateFilePath`）。 */
const RUNTIME_PATH_RESERVED_CHARACTERS = /[%;:\\]/;
const INVISIBLE_PATH_CHARACTER_PATTERN = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const RESERVED_PROTOTYPE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const REFUSED_TOOL_DIRECTORIES = new Set(['node_modules']);
const REFUSED_TOOL_FILENAMES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'tsconfig.json',
  'jsconfig.json',
  'deno.json',
  'deno.jsonc',
  'claude.md',
  'claude.local.md',
  'agents.md',
]);
const WINDOWS_SHORT_NAME_PATTERN = /~\d/;
const IMAGE_SLOT_STATE_FILENAME = '.image-slots.state.json';

/** 比较用的段名（原版 `normalizePathSegmentForComparison`）：去掉不可见字符与 `:` 之后的部分、NFC、小写、去掉末尾的点与空格。 */
function comparableSegment(segment: string): string {
  let normalized = segment.replace(INVISIBLE_PATH_CHARACTER_PATTERN, '');
  const colon = normalized.indexOf(':');
  if (colon >= 0) normalized = normalized.slice(0, colon);
  return normalized.normalize('NFC').toUpperCase().toLowerCase().replace(/[. ]+$/, '');
}

function comparablePath(rel: string): string {
  return rel.split('/').map(comparableSegment).join('/');
}

function isImageSlotStatePath(rel: string): boolean {
  const parts = rel.split('/');
  return parts[parts.length - 1] === IMAGE_SLOT_STATE_FILENAME && !parts.slice(0, -1).some(p => comparableSegment(p).startsWith('.'));
}

/** 原版 `explainToolConfigurationPath`：以点开头的段、工具链与智能体说明文件、Windows 短名。 */
function explainToolConfigurationPath(rel: string): string | null {
  const parts = rel.split('/').map(comparableSegment);
  if (parts.some(p => p.startsWith('.')) && !isImageSlotStatePath(rel)) {
    return 'is a dot-file or dot-directory (tool, editor, VCS or agent configuration); never part of a design system';
  }
  if (REFUSED_TOOL_FILENAMES.has(parts[parts.length - 1] ?? '') || parts.some(p => REFUSED_TOOL_DIRECTORIES.has(p))) {
    return 'is a package-manager, toolchain or agent-instruction file that tools auto-load from a working directory; never part of a design system';
  }
  if (parts.some(p => WINDOWS_SHORT_NAME_PATTERN.test(p))) {
    return 'has a path segment shaped like a Windows 8.3 short name (NAME~1); rename it without the "~digit"';
  }
  return null;
}

/** 原版 `explainReservedSystemPath`：原平台的页面与类型文件占用的名字（区分别名：大小写、末尾的点）。 */
function explainReservedSystemPath(rel: string): string | null {
  const normalized = comparablePath(rel);
  const under = (name: string) => normalized === name || normalized.startsWith(`${name}/`);
  if (under(DESIGN_SYSTEM_FILE)) return `is reserved: ${DESIGN_SYSTEM_FILE} is the index; rename the file`;
  if (under('index.html')) return 'is reserved: index.html is the page itself in the original format; rename the file';
  if (under('skill.md') || under('artifact-type')) {
    return 'is reserved: SKILL.md and artifact-type/ are the design system type’s own files in the original format; rename the file';
  }
  return null;
}

/**
 * 设计系统里一个相对路径（`/` 分隔）不合原格式规则的原因；合规则时 null。不看 `_blobs/` 与索引本身（布局另外处理）。
 * 规则：≤300 个字符、运行时路径 ≤512 字节；没有控制、不可见与形似斜杠的字符，没有 `% ; : \`；没有空段与只有点的段，
 * 段名不是 `__proto__` 等原型名；不以 `.cmekshadow` 结尾；不是工具配置（`explainToolConfigurationPath`）；不占保留名。
 */
export function explainDesignSystemPath(rel: string): string | null {
  if (rel.length === 0 || rel.length > MAX_DESIGN_SYSTEM_PATH_LENGTH || Buffer.byteLength(`project/${rel}`, 'utf8') > MAX_RUNTIME_PATH_UTF8_BYTES) {
    return `is empty or longer than ${MAX_DESIGN_SYSTEM_PATH_LENGTH} characters; rename it`;
  }
  if (rel.startsWith('/') || UNSAFE_PATH_CHARACTER_PATTERN.test(rel) || RUNTIME_PATH_RESERVED_CHARACTERS.test(rel)) {
    return 'has a character a design system path cannot hold (a control or invisible character, a look-alike slash, % ; : or \\); rename it';
  }
  if (rel.endsWith('.cmekshadow')) return 'ends in .cmekshadow, which is reserved; rename it';
  for (const part of rel.split('/')) {
    if (part === '' || part === '.' || part === '..') return 'has an empty path segment or one that is only dots; rename it';
    if (RESERVED_PROTOTYPE_NAMES.has(part)) return `uses "${part}" as a path segment, which is reserved; rename it`;
  }
  return explainToolConfigurationPath(rel) ?? explainReservedSystemPath(rel);
}

/** 是不是上传的素材目录或它下面的路径。 */
export function isBlobsPath(rel: string): boolean {
  return rel === BLOBS_DIR || rel.startsWith(`${BLOBS_DIR}/`);
}

/** 设计系统目录里的相对路径是否属于编辑器可见、可写的文件：索引，或不在 `_blobs/` 下、合路径规则的文件。 */
export function isDesignSystemFile(rel: string): boolean {
  if (rel === DESIGN_SYSTEM_FILE) return true;
  return !isBlobsPath(rel) && explainDesignSystemPath(rel) === null;
}

/** 清单与监听往下走时进不进这个子目录。 */
function descendInto(rel: string): boolean {
  return !isBlobsPath(rel) && explainDesignSystemPath(rel) === null;
}

/** 上传一个素材的上限（字节）：SVG 2 MiB，其余 20 MiB。 */
export function designSystemUploadLimit(contentType: string): number {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type === 'image/svg+xml' ? DESIGN_SYSTEM_LIMITS.svgUploadBytes : DESIGN_SYSTEM_LIMITS.uploadBytes;
}

/** 编辑器服务里设计系统的布局：整棵目录树（不含 `_blobs/` 与隐藏目录），按名字排序后至多列 1,024 个文件；上传写进 `_blobs/`。 */
export const DESIGN_SYSTEM_LAYOUT: DeckLayout = {
  blobDir: BLOBS_DIR,
  isFile: isDesignSystemFile,
  roots: [{ rel: '', descend: true }],
  descendInto,
  watches: rel => isDesignSystemFile(rel) || descendInto(rel),
  maxFiles: DESIGN_SYSTEM_LIMITS.files,
  maxPublishBytes: DESIGN_SYSTEM_LIMITS.publishBytes,
  maxFileBytes: DESIGN_SYSTEM_LIMITS.fileBytes,
  maxBlobBytes: designSystemUploadLimit,
  readOnlyMessage: p => {
    const rel = p.startsWith('project/') ? p.slice('project/'.length) : p;
    if (isBlobsPath(rel)) return `${p}: ${BLOBS_DIR}/ holds uploads and can't be written; upload the file instead`;
    return `${p}: ${explainDesignSystemPath(rel) ?? 'is not a design system file'}`;
  },
};

/** 索引读入的上限：比这大的不当设计系统（原版的索引至多 2,000,000 个字符）。 */
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
/** 原版 `MAX_DESIGN_SYSTEM_INDEX_CHARS`。 */
export const MAX_DESIGN_SYSTEM_INDEX_CHARS = 2_000_000;

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 认设计系统的条件（§10.1，原版 `isFilesIndex`）：索引是对象、`content` 不是对象（那是单文件的旧格式），并且带迁移标记，
 * 或 `v` ≥ 3、`layout` 为 `"files"`。其余字段由 `checkDesignSystem` 检查。
 */
export function isDesignSystemIndex(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    !isRecord(value.content) &&
    (hasDesignSystemMarker(value) || (typeof value.v === 'number' && value.v >= 3 && value.layout === 'files'))
  );
}

/** 索引带不带原版的迁移标记（`createdOnFiles` 或 `convertedFrom` 对象）；没有时原版编辑器只读打开。 */
export function hasDesignSystemMarker(index: Record<string, unknown>): boolean {
  return isRecord(index.createdOnFiles) || isRecord(index.convertedFrom);
}

/** 读 design-system.json 并解析；没有、读不了、太大或不是 JSON 时 null。不跟随符号链接。 */
export async function readDesignSystemJson(dir: string): Promise<unknown> {
  const file = path.join(dir, DESIGN_SYSTEM_FILE);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return null;
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** 设计系统的标题：索引的 `title` 去掉首尾空白，没有时用目录名。 */
export function designSystemTitle(index: object, dir: string): string {
  const raw = (index as { title?: unknown }).title;
  const title = typeof raw === 'string' ? raw.trim() : '';
  return title || path.basename(dir);
}

/** 索引的 `namespace`：合全局名规则的字符串，否则 null。 */
export function designSystemNamespace(index: object): string | null {
  const raw = (index as { namespace?: unknown }).namespace;
  return typeof raw === 'string' && WINDOW_NAMESPACE_PATTERN.test(raw) ? raw : null;
}

/** 读一个目录的设计系统概况；不是设计系统（没有索引、读不了、不合 §10.1）时返回 null。不跟随符号链接。 */
export async function readDesignSystemInfo(dir: string): Promise<DesignSystemInfo | null> {
  const parsed = await readDesignSystemJson(dir);
  if (!isDesignSystemIndex(parsed)) return null;
  return { title: designSystemTitle(parsed, dir), namespace: designSystemNamespace(parsed) };
}

/** Space 扫描用的设计系统目录概况：大小与时间的取法与设计稿相同（目录与第一层子目录里的普通文件）。 */
export interface DesignSystemDirStat extends DesignSystemInfo {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

/** 目录是设计系统时返回它的概况，否则 null。不跟随符号链接，跳过以点开头的文件与目录。 */
export async function inspectDesignSystem(dir: string): Promise<DesignSystemDirStat | null> {
  const info = await readDesignSystemInfo(dir);
  if (!info) return null;
  const indexFile = await fs.lstat(path.join(dir, DESIGN_SYSTEM_FILE)).catch(() => null);
  if (!indexFile) return null;
  let size = 0;
  let mtimeMs = indexFile.mtimeMs;
  const add = async (folder: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0) await add(full, 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat) continue;
      size += stat.size;
      mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    }
  };
  await add(dir, 0);
  return { ...info, size, mtimeMs, birthtimeMs: indexFile.birthtimeMs };
}
