/** Public file-format identifiers and MIME negotiation for this plugin. */
import path from 'node:path';
export const ASSETS_DIR = 'assets';
export const BLOB_ID_PATTERN = /^[a-f0-9]{32}$/;
export const DESIGN_ASSET_MAX_BYTES = 20 * 1024 ** 2;
export interface DesignCanvasInfo { title: string; boardCount: number }
export interface DesignSystemInfo { title: string; namespace: string | null }
// Each tuple declares the canonical extension followed by compatible alternatives.
const media: [string, string[]][] = [
  ['text/html', ['html', 'htm']], ['application/json', ['json']], ['text/css', ['css']],
  ['text/javascript', ['js', 'mjs']], ['text/markdown', ['md']], ['text/plain', ['txt']],
  ['application/xml', ['xml']], ['image/svg+xml', ['svg']], ['image/png', ['png']],
  ['image/jpeg', ['jpg', 'jpeg']], ['image/gif', ['gif']], ['image/webp', ['webp']],
  ['image/avif', ['avif']], ['image/x-icon', ['ico']], ['font/woff2', ['woff2']],
  ['font/woff', ['woff']], ['font/ttf', ['ttf']], ['font/otf', ['otf']],
  ['audio/mpeg', ['mp3']], ['audio/wav', ['wav']], ['video/mp4', ['mp4']],
  ['video/webm', ['webm']], ['video/quicktime', ['mov']], ['application/pdf', ['pdf']],
  ['application/wasm', ['wasm']],
];
const byExtension = new Map(media.flatMap(([type, extensions]) => extensions.map(ext => [ext, type] as const)));
const byType = new Map(media.map(([type, extensions]) => [type, extensions[0]]));
export function contentTypeOf(file: string): string {
  return byExtension.get(path.extname(file).slice(1).toLowerCase()) ?? 'application/octet-stream';
}
export function assetExtensionOf(type: string): string {
  return byType.get(type.split(';')[0].trim().toLowerCase()) ?? 'bin';
}
