/**
 * 从 BaoCut 搬运过来的常量、类型与 mime 映射。
 *
 * 来源：https://github.com/JimLiu/baocut @ 7aa049e8（BaoCut Community License 1.0）
 *   ASSETS_DIR            ← packages/slides/src/deck-store.ts
 *   BLOB_ID_PATTERN       ← packages/slides/src/file-protocol.ts
 *   MIME / EXT_BY_MIME    ← packages/slides/src/deck-store.ts
 *   DeckLayout            ← packages/slides/src/deck-store.ts
 *   DesignCanvasInfo      ← packages/protocol/src/design.ts
 *   DesignSystemInfo      ← packages/protocol/src/design-system.ts
 *
 * 这四个符号原本从 `@baocut/slides` 与 `@baocut/protocol` 导入；校验代码除此之外不依赖任何 BaoCut 包。
 */

/** 上传的素材放在哪个子目录（`<id>.<ext>` 与类型索引 `index.json`）。 */
export const ASSETS_DIR = 'assets';

/** 素材 id 的形状：sha256 十六进制的前 32 位。 */
export const BLOB_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 一个素材文件的上限（图片与字体）；再大的图片先缩小。 */
export const DESIGN_ASSET_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 目录里的相对路径（`/` 分隔）是否属于编辑器可见、可写的文件。
 * 本插件只做校验与素材导入，不提供编辑器，所以只用到该接口的形状。
 */
export interface DeckLayout {
  readonly blobDir?: string;
  isFile(rel: string): boolean;
  readonly roots: readonly { readonly rel: string; readonly descend: boolean }[];
  descendInto?(rel: string): boolean;
  watches(rel: string): boolean;
  readonly maxFiles?: number;
  readonly maxPublishBytes?: number;
  readonly maxFileBytes?: number;
  maxBlobBytes?(contentType: string): number;
  readOnlyMessage(runtimePath: string): string;
}

/** `canvas.json` 的摘要。 */
export interface DesignCanvasInfo {
  /** `canvas.json` 的 `title`，去掉首尾空白；没有时用目录名。 */
  title: string;
  /** `boards` 里的画板数。 */
  boardCount: number;
}

/** `design-system.json` 的摘要。 */
export interface DesignSystemInfo {
  /** `design-system.json` 的 `title`，去掉首尾空白；没有时用目录名。 */
  title: string;
  /** 组件包的全局名（`window.<namespace>`）；索引里没有或不合规则时为 null。 */
  namespace: string | null;
}

/** 按扩展名判 mime。 */
const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  md: 'text/markdown',
  txt: 'text/plain',
  xml: 'application/xml',
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
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};

/** mime → 存盘扩展名。 */
const EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/x-icon': 'ico',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

/** 按扩展名判 mime；未知的用 octet-stream。 */
export function contentTypeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** 按 mime 取存盘扩展名。 */
export function assetExtensionOf(contentType: string): string {
  return EXT_BY_MIME[contentType.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
}
