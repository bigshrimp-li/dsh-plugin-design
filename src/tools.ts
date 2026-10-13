/**
 * 七个设计工具：design_check / design_render / design_export / design_editor /
 * design_import_asset / design_system_check / design_system_import_asset。
 *
 * 前四个搬运自 BaoCut @ 7aa049e8 的 `packages/runtime-core/src/agent-tools/design-tools.ts`(221) 与
 * `design-system-tools.ts`(290)，把 ToolSet/ToolScope 框架换成 DSH 的 defineTool：
 *   - 工具的 description 原样保留（原文件标了 i18n-ignore：它们直接写给模型看，把画板格式规则都编码进去了）
 *   - 作用域与审批（scope.authorize / scope.confirm）去掉：DSH 侧没有等价物，见 README
 *   - 素材导入改为直接写 node:fs（DSH 的 ctx.fs 只有 writeText，写不了二进制）
 *
 * `design_render` 是这里新增的：BaoCut 靠编辑器提供预览，DSH 没有编辑器，所以用随包的画板运行时
 * （`vendor/support.js`）+ 无头 Chrome 自己渲染出 PNG，并把图作为 image 内容块交回会话。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { checkCanvas } from './check/canvas-check.ts';
import { checkDesignSystem, encodeIndexKey, isAssetGroupName } from './check/system-check.ts';
import {
  BLOBS_DIR,
  DESIGN_SYSTEM_FILE,
  DESIGN_SYSTEM_PATHS,
  designSystemUploadLimit,
  hasDesignSystemMarker,
  isDesignSystemIndex,
  readDesignSystemJson,
} from './check/system-layout.ts';
import { putBlob } from './blobs.ts';
import { startEditor, type EditorHandle } from './editor/server.ts';
import { exportCanvas } from './export.ts';
import { renderCanvas } from './render.ts';
import { ASSETS_DIR, DESIGN_ASSET_MAX_BYTES, contentTypeOf } from './shared.ts';

/** 结果里至多列这么多条问题；其余只给条数。 */
const MAX_LISTED_ISSUES = 200;
const MAX_LISTED_NOTES = 50;
/** 一次最多把几张渲染图交回会话；其余只给文件路径（图很占上下文）。 */
const MAX_RENDERED_IMAGES = 4;

/** 设计稿能导入的类型（图片与字体）。 */
const DESIGN_ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'woff2', 'woff', 'ttf', 'otf']);

/**
 * 设计系统能导入的类型（原版 `BLOB_STORAGE_MIME_TYPES`）：没有 avif、mov 与 ico——
 * 原版上传不收，导进来编辑器也存不回去。
 */
const DESIGN_SYSTEM_ASSET_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'mp4',
  'webm',
  'pdf',
  'woff2',
  'woff',
  'ttf',
  'otf',
]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** `candidate` 是否就是 `root` 或在它下面。 */
function inside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** 会话工作目录；没有工作目录时抛错（与内置 present 工具同样处理）。 */
function sessionCwd(exec: { agent?: { session: { header: { cwd?: string } } } }): string {
  const cwd = exec.agent?.session.header.cwd;
  if (cwd === undefined) throw new Error('这个工具需要工作目录（会话开在工作区里）');
  return cwd;
}

/** 工具返回的错误：带错误码，给模型看。 */
class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/**
 * 解析调用方给的目标目录：相对工作目录，必须在工作目录里，不经过符号链接。
 * @param given 相对工作目录的路径
 */
async function resolveTargetDir(cwd: string, given: string, what: string): Promise<string> {
  if (path.isAbsolute(given) || path.win32.isAbsolute(given) || given.split(/[\\/]+/).includes('..')) {
    throw new ToolFailure('PATH_OUTSIDE_WORKSPACE', `${what}要是会话工作目录里的目录（相对路径，不含 ..，不经过指向别处的符号链接）`);
  }
  const base = await fs.realpath(cwd).catch(() => cwd);
  const resolved = path.resolve(base, given);
  if (resolved === base || !inside(resolved, base)) {
    throw new ToolFailure('PATH_OUTSIDE_WORKSPACE', `${what}要是会话工作目录里的目录（相对路径，不含 ..，不经过指向别处的符号链接）`);
  }
  const stat = await fs.lstat(resolved).catch(() => null);
  if (stat === null) throw new ToolFailure(`${what === '设计稿' ? 'CANVAS_NOT_FOUND' : 'DESIGN_SYSTEM_NOT_FOUND'}`, `工作目录里没有这个目录：${given}`);
  if (stat.isSymbolicLink()) {
    throw new ToolFailure('PATH_OUTSIDE_WORKSPACE', `${what}不能是符号链接：给它指向的、在工作目录里的目录`);
  }
  if (!stat.isDirectory()) throw new ToolFailure('NOT_A_DIRECTORY', `${given} 不是一个目录`);
  const real = await fs.realpath(resolved);
  if (!inside(real, base)) {
    throw new ToolFailure('PATH_OUTSIDE_WORKSPACE', `${what}要是会话工作目录里的目录（相对路径，不含 ..，不经过指向别处的符号链接）`);
  }
  return real;
}

/** 要导入的源文件：工作目录里的普通文件（不经过符号链接），扩展名在 `extensions` 里，不超过 `limitOf`。 */
async function resolveSourceFile(
  cwd: string,
  given: string,
  extensions: ReadonlySet<string>,
  limitOf: (contentType: string) => number,
  tooLargeHint: string,
): Promise<{ path: string; size: number; ext: string }> {
  if (path.isAbsolute(given) || path.win32.isAbsolute(given) || given.split(/[\\/]+/).includes('..')) {
    throw new ToolFailure('PATH_OUTSIDE_WORKSPACE', 'path 要是这个会话工作目录里的文件（相对路径，不含 ..，不经过指向别处的符号链接）');
  }
  const base = await fs.realpath(cwd).catch(() => cwd);
  const resolved = path.resolve(base, given);
  if (resolved === base || !inside(resolved, base)) {
    throw new ToolFailure('PATH_OUTSIDE_WORKSPACE', 'path 要是这个会话工作目录里的文件（相对路径，不含 ..，不经过指向别处的符号链接）');
  }
  const stat = await fs.lstat(resolved).catch(() => null);
  if (stat === null) throw new ToolFailure('FILE_NOT_FOUND', `工作目录里没有这个文件：${given}`);
  if (stat.isSymbolicLink()) throw new ToolFailure('PATH_IS_SYMLINK', 'path 是一个符号链接：给它指向的、在工作目录里的文件');
  if (!stat.isFile()) throw new ToolFailure('NOT_A_FILE', 'path 要是一个普通文件（不是目录）');
  const dirReal = await fs.realpath(path.dirname(resolved));
  if (!inside(dirReal, base)) {
    throw new ToolFailure('PATH_OUTSIDE_WORKSPACE', 'path 要是这个会话工作目录里的文件（相对路径，不含 ..，不经过指向别处的符号链接）');
  }
  const file = path.join(dirReal, path.basename(resolved));
  const dot = file.lastIndexOf('.');
  const ext = dot < 0 ? '' : file.slice(dot + 1).toLowerCase();
  if (dot < 0 || !extensions.has(ext)) {
    throw new ToolFailure(
      'UNSUPPORTED_ASSET_TYPE',
      `只能导入 ${[...extensions].join('、')}，按扩展名判断。css、js、json、md 这类文本文件直接写进目录，用相对路径或相对路径引用`,
    );
  }
  const limit = limitOf(contentTypeOf(file));
  if (stat.size > limit) {
    throw new ToolFailure(
      'FILE_TOO_LARGE',
      `文件有 ${formatBytes(stat.size)}，超过了 ${formatBytes(limit)} 的上限${ext === 'svg' ? '（SVG）' : ''}：${tooLargeHint}`,
    );
  }
  return { path: file, size: stat.size, ext };
}

/** `canvas.json` 缺失或不合格式时也照样校验：不在这里拦，问题记进清单让智能体改。 */
async function hasCanvasIndex(dir: string): Promise<boolean> {
  const stat = await fs.lstat(path.join(dir, 'canvas.json')).catch(() => null);
  if (stat === null || !stat.isFile()) return false;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, 'canvas.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && (parsed as { v?: unknown }).v === 3;
  } catch {
    return false;
  }
}

export interface DesignToolContext {
  /** 注册工具用的上下文（`ctx.tools`）。 */
  tools: { register: (tool: unknown) => unknown };
  /** 按名字取服务；`design_render` 用它取 `attachments` 把 PNG 交回会话。没有就只给文件路径。 */
  get?: (name: string) => unknown;
}

// ---- 工具的入参与返回值（`defineTool` 的两个类型参数）----

interface Issue {
  file: string;
  message: string;
  code?: string;
}

interface DesignCheckArgs {
  path: string;
}
interface DesignCheckValue {
  path: string;
  title: string;
  boardCount: number;
  problems: number;
  issues?: Issue[];
  more?: string;
  notChecked: string;
  next: string;
}

interface DesignRenderArgs {
  path: string;
  board?: string;
  scale?: number;
}
/** `attachments.saveImage` 交回来的图片引用；原样交给 image 内容块。 */
interface ImageRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}
interface DesignRenderValue {
  path: string;
  outDir: string;
  rendered: {
    board: string;
    declared: string;
    rendered: string | null;
    mounted: boolean;
    overflow: boolean;
    errors: string[];
    png: string;
    pngBytes: number;
  }[];
  /** 能交给会话的图（太大或没有 attachments 服务时为空）。 */
  images: { board: string; attachment: ImageRef }[];
  problems: number;
  next: string;
}

interface DesignImportArgs {
  canvas: string;
  path: string;
}
interface DesignImportValue {
  src: string;
  bytes: number;
  contentType: string;
  next: string;
}

interface DesignEditorArgs {
  path?: string;
}
interface DesignEditorValue {
  url: string;
  port: number;
  workspace: string;
  canvases: { path: string; title: string; boards: number }[];
  next: string;
}

interface DesignExportArgs {
  path: string;
  board?: string;
}
interface DesignExportValue {
  path: string;
  outDir: string;
  files: { board: string; html: string; bytes: number; notes: string[] }[];
  next: string;
}

interface SystemCheckArgs {
  path: string;
}
interface SystemCheckValue {
  path: string;
  title: string;
  namespace: string | null;
  problems: number;
  issues?: Issue[];
  notes?: Issue[];
  more?: string;
  notChecked: string;
  next: string;
}

interface SystemImportArgs {
  system: string;
  path: string;
  group?: string;
}
interface SystemImportValue {
  src: string;
  record: { name: string; blob: string; size: number; type: string };
  key: string;
  groupKey?: string;
  indexPath: string[];
  restoredAs: string;
  bytes: number;
  contentType: string;
  next: string;
}

/**
 * 可视化编辑器：每个工作目录一个实例，重复调用复用同一个。
 * 端口优先用固定的那个——DSH 侧边栏里的 iframe 只拿得到 URL，两边要靠固定端口对上。
 */
const editors = new Map<string, Promise<EditorHandle>>();
const EDITOR_PORT = 17321;

function editorFor(workspaceDir: string): Promise<EditorHandle> {
  const existing = editors.get(workspaceDir);
  if (existing !== undefined) return existing;
  const started = startEditor({ workspaceDir, preferredPort: EDITOR_PORT }).catch((e: unknown) => {
    editors.delete(workspaceDir); // 起失败就别把坏 promise 留在表里
    throw e;
  });
  editors.set(workspaceDir, started);
  return started;
}

async function listEditorCanvases(url: string): Promise<{ path: string; title: string; boards: number }[]> {
  const res = await fetch(new URL('/api/workspace', url));
  const body = (await res.json()) as { canvases?: { path: string; title: string; boards?: unknown[] }[] };
  return (body.canvases ?? []).map((c) => ({ path: c.path, title: c.title, boards: (c.boards ?? []).length }));
}

/** 注册七个设计工具。 */
export function registerDesignTools(ctx: DesignToolContext): void {
  // ---- design_check ----
  ctx.tools.register(
    defineTool<DesignCheckArgs, DesignCheckValue>({
      name: 'design_check',
      description: [
        '按设计稿格式的规则校验一份设计稿，返回问题清单。只看文件，不渲染、不截图。',
        '检查 canvas.json（v 为 3；boards 每项的 x、y、w、h 与可选字段；order、pages、notes、launch、designSystems 与 ds/<folder>/），boards 与 order 的路径都有文件，ds/ 以外的每个 .dc.html 都登记在 boards 里；每个画板的 support.js 头行、<x-dc>、唯一的 data-dc-script 块（class Component extends DCLogic，没有 import/export）、单引号的 data-props 是合法 JSON 且 $preview 等于 boards 的 w/h；标签闭合、属性加引号、不自闭合、不用大写标签名，{{ }} 只是点号路径；脚本不拼界面、不装全局按键处理、不连网；图片与 url() 用 /_blob/<id>，素材都在 assets/ 里；没有 iframe/object/embed，网上的样式只认 Google Fonts；路径段规则与文件数、大小上限。',
        '画板脚本能不能跑、排版对不对不在检查范围内。写完或改完设计稿必须调用一次。issues 为 0 时说明这份设计稿通过了校验；有问题时按说明改文件再调用。',
      ].join('\n'),
      parameters: {
        path: { type: 'string', required: true, description: '设计稿目录（里面有 canvas.json），相对工作目录的路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            title: { type: 'string', required: true },
            boardCount: { type: 'integer', required: true },
            problems: { type: 'integer', required: true },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { file: { type: 'string', required: true }, message: { type: 'string', required: true } },
              },
            },
            more: { type: 'string' },
            notChecked: { type: 'string', required: true },
            next: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.problems === 0
                ? `design_check ${value.path}: 通过（${value.boardCount} 块画板）`
                : `design_check ${value.path}: ${value.problems} 个问题\n${(value.issues ?? []).map((i) => `${i.file}: ${i.message}`).join('\n')}`,
          },
        ],
      },
      async execute(args, exec) {
        const cwd = sessionCwd(exec);
        const dir = await resolveTargetDir(cwd, args.path, '设计稿');
        const result = await checkCanvas(dir);
        const problems = result.issues.length;
        return {
          path: args.path,
          title: result.title,
          boardCount: result.boardCount,
          problems,
          ...(problems > 0 ? { issues: result.issues.slice(0, MAX_LISTED_ISSUES) } : {}),
          ...(problems > MAX_LISTED_ISSUES ? { more: `另有 ${problems - MAX_LISTED_ISSUES} 条没列出：先改这些再校验` } : {}),
          notChecked: '画板脚本能不能跑、排版与视觉效果没有检查（不渲染）。',
          next:
            problems > 0
              ? '按 issues 改文件（file 是相对设计稿目录的路径，"." 是整个目录），再调用 design_check，直到 problems 为 0。'
              : '没有问题。用一两句话告诉用户做好了什么，不要再贴文件内容。',
        };
      },
    }),
  );

  // ---- design_render ----
  ctx.tools.register(
    defineTool<DesignRenderArgs, DesignRenderValue>({
      name: 'design_render',
      description: [
        '把设计稿的画板渲染成 PNG，并把图交回会话。用一个真正的浏览器跑：起一个只读本地服务，用无头 Chrome 逐个画板截图。',
        '每块画板报回：声明的 frame（canvas.json 的 w/h）、实际挂载出来的尺寸、有没有超出 frame（会被裁切）、页面里的报错、PNG 写到哪了。挂载尺寸为 null 或 mounted 为 false，说明画板没渲染出来（运行时没启动、或画板是空的）。',
        '这是唯一能看见设计的手段——design_check 只看文件、不渲染。渲染出来的图能看出排版、留白、字重、对齐、颜色的实际问题，这些 design_check 一条都查不出来。',
        '需要本机有一个 Chrome/Chromium/Edge（找不到时用 DSH_DESIGN_CHROME 指出可执行文件的位置）。PNG 默认写到设计稿旁边的 .design-preview/<设计稿名>/ 下。',
      ].join('\n'),
      parameters: {
        path: { type: 'string', required: true, description: '设计稿目录（里面有 canvas.json），相对工作目录的路径' },
        board: { type: 'string', description: '只渲染这一块画板（canvas.json 里的路径，如 Main.dc.html）；不给时按 order 全渲染' },
        scale: { type: 'number', description: '设备像素比，默认 2（更清晰、文件更大）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            outDir: { type: 'string', required: true },
            rendered: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  board: { type: 'string', required: true },
                  declared: { type: 'string', required: true },
                  rendered: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  mounted: { type: 'boolean', required: true },
                  overflow: { type: 'boolean', required: true },
                  errors: { type: 'array', items: { type: 'string' } },
                  png: { type: 'string', required: true },
                  pngBytes: { type: 'integer', required: true },
                },
              },
            },
            images: { type: 'array', required: true, items: { type: 'json' } },
            problems: { type: 'integer', required: true },
            next: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const lines = value.rendered.map((r) => {
            const size = r.rendered === null ? '没挂载出来' : `${r.rendered}${r.overflow ? ' ← 超出 frame，会被裁切' : ''}`;
            const errs = r.errors.length > 0 ? `\n    报错：${r.errors.join(' / ')}` : '';
            return `  ${r.board}：声明 ${r.declared}，实际 ${size}${errs}`;
          });
          return [
            { type: 'text', text: `design_render ${value.path}\n${lines.join('\n')}\nPNG 在 ${value.outDir}` },
            ...value.images.map((image) => ({ type: 'image' as const, attachment: image.attachment })),
          ];
        },
      },
      async execute(args, exec) {
        const cwd = sessionCwd(exec);
        const dir = await resolveTargetDir(cwd, args.path, '设计稿');
        const { boards, outDir } = await renderCanvas({
          canvasDir: dir,
          boards: args.board !== undefined ? [args.board] : undefined,
          scale: args.scale,
        });

        // 把图交给会话（前端能显示 image 内容块）。取不到 attachments 服务、或图太大时只给路径。
        const attachments = ctx.get?.('attachments') as
          | { saveImage: (input: { data: Uint8Array; mediaType: string; name: string }) => Promise<ImageRef> }
          | undefined;
        const images: { board: string; attachment: ImageRef }[] = [];
        if (attachments !== undefined) {
          for (const board of boards.slice(0, MAX_RENDERED_IMAGES)) {
            if (board.pngBytes === 0) continue;
            try {
              const data = await fs.readFile(board.png);
              const attachment = await attachments.saveImage({
                data,
                mediaType: 'image/png',
                name: `${path.basename(board.png)}`,
              });
              images.push({ board: board.board, attachment });
            } catch {
              // 图太大或存不下：跳过图，路径还在返回值里。
            }
          }
        }

        const problems = boards.filter((b) => !b.mounted || b.overflow || b.pngBytes === 0 || b.errors.length > 0).length;
        return {
          path: args.path,
          outDir,
          rendered: boards.map((b) => ({
            board: b.board,
            declared: `${b.declared.w}x${b.declared.h}`,
            rendered: b.rendered === null ? null : `${b.rendered.w}x${b.rendered.h}`,
            mounted: b.mounted,
            overflow: b.overflow,
            errors: b.errors,
            png: b.png,
            pngBytes: b.pngBytes,
          })),
          images,
          problems,
          next:
            problems > 0
              ? '看上面那些画板：没挂载出来说明画板脚本有问题（看报错）；超出 frame 说明内容比声明的 w/h 高或宽，要么把 frame 调大、要么把内容收紧。改完重新 design_check 再 design_render。'
              : '都渲染出来了。**看一眼上面那些图**：排版、留白、字重、对齐、颜色对不对，这些问题 design_check 查不出来，只有看图才发现。不对就改文件，再跑一遍。',
        };
      },
    }),
  );

  // ---- design_export ----
  ctx.tools.register(
    defineTool<DesignExportArgs, DesignExportValue>({
      name: 'design_export',
      description: [
        '把设计稿导出成**自包含的 HTML**：一个文件，双击就能在浏览器里打开，可以滚动、缩放、选中文字、发给别人看。',
        '为什么需要它：`.dc.html` 是**源格式**，不是网页。直接双击它打开会坏三件事——`<script src="./support.js">` 那个运行时不在了，`{{hole}}` 不会被替换（`background: {{accent}}` 被浏览器当非法值丢掉，色块变透明、白字白底看不见），`/_blob/<id>` 也没有服务去映射。这个工具把运行时内联、相对样式表与脚本内联、`/_blob/<id>` 换成 data: URI，产出一份真能打开的网页。',
        '不改设计稿本身一个字节：导出写到设计稿旁边的 .design-preview/<名字>/view/ 下。要判断做得对不对仍然看 design_render 的 PNG——这个 HTML 是给人看的成品。',
      ].join('\n'),
      parameters: {
        path: { type: 'string', required: true, description: '设计稿目录（里面有 canvas.json），相对工作目录的路径' },
        board: { type: 'string', description: '只导出这一块画板；不给时按 order 每块画板导出一个 HTML' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            outDir: { type: 'string', required: true },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  board: { type: 'string', required: true },
                  html: { type: 'string', required: true },
                  bytes: { type: 'integer', required: true },
                  notes: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            next: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `design_export ${value.path}`,
              ...value.files.map((f) => `  ${f.board} → ${f.html}（${Math.round(f.bytes / 1024)} KB）`),
              `在浏览器里打开上面这些文件即可（不需要本地服务）。`,
            ].join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const cwd = sessionCwd(exec);
        const dir = await resolveTargetDir(cwd, args.path, '设计稿');
        const { files, outDir } = await exportCanvas({
          canvasDir: dir,
          boards: args.board !== undefined ? [args.board] : undefined,
        });
        return {
          path: args.path,
          outDir,
          files,
          next: '告诉用户打开哪个文件。要判断设计对不对仍然看 design_render 的 PNG，不要拿这份 HTML 去替代渲染检查。',
        };
      },
    }),
  );

  // ---- design_import_asset ----
  ctx.tools.register(
    defineTool<DesignImportArgs, DesignImportValue>({
      name: 'design_import_asset',
      description: [
        '把工作目录里的一张图片或一个字体拷进设计稿的 assets/，返回写进画板的地址。',
        `按内容寻址，同一份只存一份；返回的 src 形如 /_blob/<id>，原样写进 <img src="…">、<helmet><style> 里的 url(…) 或 @font-face。只收 png、jpg、jpeg、gif、webp、avif、svg 与 woff2、woff、ttf、otf，不超过 ${formatBytes(DESIGN_ASSET_MAX_BYTES)}。`,
        'canvas 与 path 都相对工作目录，不能用 .. 或符号链接指到外面；canvas 里要先有 canvas.json。',
      ].join('\n'),
      parameters: {
        canvas: { type: 'string', required: true, description: '设计稿目录（里面有 canvas.json），相对工作目录的路径' },
        path: {
          type: 'string',
          required: true,
          description: '要导入的文件，相对工作目录的路径：图片 png、jpg、jpeg、gif、webp、avif、svg，或字体 woff2、woff、ttf、otf',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            src: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            contentType: { type: 'string', required: true },
            next: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `导入 ${value.src}（${value.contentType}, ${formatBytes(value.bytes)}）` }],
      },
      async execute(args, exec) {
        const cwd = sessionCwd(exec);
        const dir = await resolveTargetDir(cwd, args.canvas, '设计稿');
        if (!(await hasCanvasIndex(dir))) {
          throw new ToolFailure(
            'NOT_A_CANVAS',
            `${args.canvas} 还不是设计稿：先写 canvas.json（其中 v 为 3、boards 是以画板路径为键的对象），再导入素材`,
          );
        }
        const file = await resolveSourceFile(
          cwd,
          args.path,
          DESIGN_ASSET_EXTENSIONS,
          () => DESIGN_ASSET_MAX_BYTES,
          '图片先缩小',
        );
        const type = contentTypeOf(file.path);
        const bytes = await fs.readFile(file.path);
        if (bytes.byteLength !== file.size) throw new ToolFailure('FILE_CHANGED', '文件在读取期间被改了：重新调用一次');
        const uploaded = await putBlob(path.join(dir, ASSETS_DIR), bytes, type);
        return {
          src: uploaded.url,
          bytes: uploaded.sizeBytes,
          contentType: type,
          next: type.startsWith('font/')
            ? `在用到它的画板的 <helmet><style> 里写 @font-face，src: url(${uploaded.url})，原样用这个地址；改完调用 design_check。`
            : `把 src 原样写进 <img src="…"> 或 <helmet><style> 里的 url(…)（不要写成相对路径、文件名或 data: URI，也不要写进行内 style）；改完调用 design_check。`,
        };
      },
    }),
  );

  // ---- design_system_check ----
  ctx.tools.register(
    defineTool<SystemCheckArgs, SystemCheckValue>({
      name: 'design_system_check',
      description: [
        '按设计系统格式的规则校验一个设计系统，返回问题清单。只看文件，不渲染、不截图。',
        '检查 design-system.json（v 为 3、layout 为 "files"、createdOnFiles 或 convertedFrom 标记，各字段的形状，namespace，libraries，assetGroups 与 blobs 里的记录都有上传或文件）；tokens.json 的语法与上限；路径规则、文件数与大小；每个 preview.html 的 @dsCard 头行、不用 iframe/object/embed/noscript、不链接 bundle.js 与库；bundle.js 是经典脚本、赋值 window.<namespace>、不 import、不连网、不含 </script 与 <!--；fonts/ 里的字体与 tokens.json 的 type.fonts 对得上；预览与 components/lib/ 里不从网上加载脚本、样式与图片；/_blob/<id> 都在 _blobs/ 里。',
        'manifest.json、tokens.css、api/ 由编辑器保存时生成，不查（notChecked）。组件能不能渲染不在检查范围内。写完或改完设计系统必须调用一次。problems 为 0 时说明通过了校验；notes 是不用改的说明。',
      ].join('\n'),
      parameters: {
        path: { type: 'string', required: true, description: '设计系统目录（里面有 design-system.json），相对工作目录的路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            title: { type: 'string', required: true },
            namespace: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
            problems: { type: 'integer', required: true },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  file: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                  code: { type: 'string' },
                },
              },
            },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { file: { type: 'string', required: true }, message: { type: 'string', required: true } },
              },
            },
            more: { type: 'string' },
            notChecked: { type: 'string', required: true },
            next: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.problems === 0
                ? `design_system_check ${value.path}: 通过`
                : `design_system_check ${value.path}: ${value.problems} 个问题\n${(value.issues ?? []).map((i) => `${i.file}: ${i.message}`).join('\n')}`,
          },
        ],
      },
      async execute(args, exec) {
        const cwd = sessionCwd(exec);
        const dir = await resolveTargetDir(cwd, args.path, '设计系统');
        const result = await checkDesignSystem(dir);
        const problems = result.issues.length;
        return {
          path: args.path,
          title: result.title,
          namespace: result.namespace,
          problems,
          ...(problems > 0 ? { issues: result.issues.slice(0, MAX_LISTED_ISSUES) } : {}),
          ...(result.notes.length > 0 ? { notes: result.notes.slice(0, MAX_LISTED_NOTES) } : {}),
          ...(problems > MAX_LISTED_ISSUES ? { more: `另有 ${problems - MAX_LISTED_ISSUES} 条没列出：先改这些再校验` } : {}),
          notChecked: `${result.notChecked.join('、')} 由编辑器保存时生成，没有检查；组件能不能渲染、视觉效果没有检查（不渲染）。`,
          next:
            problems > 0
              ? '按 issues 改文件（file 是相对设计系统目录的路径，"." 是整个目录），再调用 design_system_check，直到 problems 为 0。notes 不用改。'
              : '没有问题。notes 不用改。用一两句话告诉用户做好了什么，不要再贴文件内容。',
        };
      },
    }),
  );

  // ---- design_system_import_asset ----
  ctx.tools.register(
    defineTool<SystemImportArgs, SystemImportValue>({
      name: 'design_system_import_asset',
      description: [
        '把工作目录里的一张图片、一段视频、一份 PDF 或一个字体拷进设计系统的 _blobs/，返回它的地址与要写进 design-system.json 的记录。',
        `按内容寻址，同一份只存一份；返回的 src 形如 /_blob/<id>，可以原样写进 README.md、preview.html 等文件；record 是 {name, blob, size, type}，按 indexPath 写进索引（给了 group 时是 assetGroups.<groupKey>.files.<key>，素材显示在 assets/<group>/ 里；不给时是 blobs.<key>）。只收 png、jpg、jpeg、gif、webp、svg、mp4、webm、pdf、woff2、woff、ttf、otf；SVG 不超过 ${formatBytes(designSystemUploadLimit('image/svg+xml'))}，其余不超过 ${formatBytes(designSystemUploadLimit('application/octet-stream'))}。`,
        'system 与 path 都相对工作目录，不能用 .. 或符号链接指到外面；system 是设计系统的目录：新建的设计系统先建好空目录，素材先导入，design-system.json 最后写。',
      ].join('\n'),
      parameters: {
        system: { type: 'string', required: true, description: '设计系统目录（里面有 design-system.json），相对工作目录的路径' },
        path: {
          type: 'string',
          required: true,
          description: '要导入的文件，相对工作目录的路径：图片 png、jpg、gif、webp、svg，视频 mp4、webm，pdf，或字体 woff2、woff、ttf、otf',
        },
        group: {
          type: 'string',
          description: '素材组的名字（assets/<组>/ 的文件夹名，例如 Logos、Icons）；不给时记录写进索引的 blobs',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            src: { type: 'string', required: true },
            record: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                name: { type: 'string', required: true },
                blob: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                type: { type: 'string', required: true },
              },
            },
            key: { type: 'string', required: true },
            groupKey: { type: 'string' },
            indexPath: { type: 'array', required: true, items: { type: 'string' } },
            restoredAs: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            contentType: { type: 'string', required: true },
            next: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `导入 ${value.src} → ${value.restoredAs}（写进 ${value.indexPath.join('.')}）` },
        ],
      },
      async execute(args, exec) {
        const cwd = sessionCwd(exec);
        if (args.group !== undefined && !isAssetGroupName(args.group)) {
          throw new ToolFailure('INVALID_GROUP', 'group 要是素材组的文件夹名：至多 80 个字符，不含 / \\ 与控制字符，首尾没有空白，不是 . 或 ..');
        }
        const dir = await resolveTargetDir(cwd, args.system, '设计系统');
        // 还没有 design-system.json 的目录是正在新建的设计系统（原版里空的设计系统也能上传）。有这个文件的，
        // 必须要是带迁移标记的索引：没有标记的编辑器只读打开，skill 也说不往里写。
        if ((await fs.lstat(path.join(dir, DESIGN_SYSTEM_FILE)).catch(() => null)) !== null) {
          const index = await readDesignSystemJson(dir);
          if (!isDesignSystemIndex(index) || !hasDesignSystemMarker(index)) {
            throw new ToolFailure(
              'NOT_A_DESIGN_SYSTEM',
              `${args.system} 里的 design-system.json 不是带 createdOnFiles 或 convertedFrom 标记的设计系统索引：编辑器只读打开它（或认不出），不要往里导入，告诉用户`,
            );
          }
        }
        const file = await resolveSourceFile(
          cwd,
          args.path,
          DESIGN_SYSTEM_ASSET_EXTENSIONS,
          (contentType) => designSystemUploadLimit(contentType),
          '先压缩或缩小',
        );
        const type = contentTypeOf(file.path);
        const bytes = await fs.readFile(file.path);
        if (bytes.byteLength !== file.size) throw new ToolFailure('FILE_CHANGED', '文件在读取期间被改了：重新调用一次');
        const uploaded = await putBlob(path.join(dir, BLOBS_DIR), bytes, type);
        const base = path.basename(file.path);
        // 记录还原到的路径（原版 `restoreFilesFromIndex`）：组里的是 assets/<组>/<name>；
        // blobs 里的 name 就是路径，字体放 fonts/，其余放 assets/。
        const name =
          args.group !== undefined ? base : `${type.startsWith('font/') ? DESIGN_SYSTEM_PATHS.fontsDir : DESIGN_SYSTEM_PATHS.assetsDir}${base}`;
        const key = encodeIndexKey(name);
        const groupKey = args.group !== undefined ? encodeIndexKey(args.group) : undefined;
        const record = { name, blob: uploaded.id, size: uploaded.sizeBytes, type };
        const restoredAs = args.group !== undefined ? `${DESIGN_SYSTEM_PATHS.assetsDir}${args.group}/${name}` : name;
        return {
          src: uploaded.url,
          record,
          key,
          ...(groupKey !== undefined ? { groupKey } : {}),
          indexPath: groupKey !== undefined ? ['assetGroups', groupKey, 'files', key] : ['blobs', key],
          restoredAs,
          bytes: uploaded.sizeBytes,
          contentType: type,
          next:
            (groupKey !== undefined
              ? `把 record 写进 design-system.json 的 assetGroups.${groupKey}.files.${key}（这个组还没有时先建 {"name": ${JSON.stringify(args.group)}, "order": [], "files": {}}，并把 "${groupKey}" 加进 groups）；`
              : `把 record 写进 design-system.json 的 blobs.${key}；`) +
            `素材在编辑器里显示为 ${restoredAs}，不要再在这个路径写同名文件（文件优先，记录会被忽略）。别的文件引用它时原样写 src（${uploaded.url}）。改完调用 design_system_check。`,
        };
      },
    }),
  );

  // ---- design_editor ----
  ctx.tools.register(
    defineTool<DesignEditorArgs, DesignEditorValue>({
      name: 'design_editor',
      description: [
        '打开**可视化编辑器**：在一个浏览器页面里直接点选画板上的元素、改行内样式、拖动、拉尺寸、原地改文字，改完写回 `.dc.html` 源码。',
        '它和你的分工：人的手在编辑器里改，你继续用 design_check / design_render / 直接改文件；两边改的是**同一份文件**。编辑器每次写入前都会重新读盘，写完自己跑一遍 design_check，校验不过就回滚——所以它不会产出不合法的画板。',
        '什么时候用：用户说「我要自己调」「打开编辑器」「让我手动改改」「我拖一下」时。调用它把 URL 给用户（在 DSH 的侧边栏 Design 标签页里，或者直接在浏览器打开这个 URL）。',
        '注意：编辑器只改**行内样式与文字**，不做增删元素、换序这类结构编辑；它也不理解设计意图，所以视觉上的判断仍然归你和用户。',
      ].join('\n'),
      parameters: {
        path: {
          type: 'string',
          description: '设计稿目录；不给时用会话工作目录（编辑器会在它下面找出所有带 canvas.json 的设计稿）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            port: { type: 'integer', required: true },
            workspace: { type: 'string', required: true },
            canvases: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  boards: { type: 'integer', required: true },
                },
              },
            },
            next: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `design_editor 已在 ${value.url} 上跑起来了（端口 ${value.port}）`,
              `工作目录：${value.workspace}`,
              ...value.canvases.map((c) => `  ${c.title}（${c.path}）· ${c.boards} 块画板`),
              '在 DSH 的侧边栏 Design 标签页里打开，或者直接在浏览器里访问上面这个 URL。',
            ].join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const cwd = sessionCwd(exec);
        const workspace = args.path !== undefined ? await resolveTargetDir(cwd, args.path, '设计稿') : cwd;
        const handle = await editorFor(workspace);
        const listed = await listEditorCanvases(handle.url);
        return {
          url: handle.url,
          port: handle.port,
          workspace,
          canvases: listed,
          next: '把 URL 给用户，并说明：编辑器改的是同一份 .dc.html，它写回前会重新读盘并自检。人改完让你接着改时，先重读文件（可能已经被改过）。',
        };
      },
    }),
  );
}
