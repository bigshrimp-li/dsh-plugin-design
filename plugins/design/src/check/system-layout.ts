/** Design-system file protocol. Identifiers remain stable for existing workspaces. */
import path from 'node:path';
import { record, readJson, safeRelative, inspectDirectory } from './files.ts';
export const DESIGN_SYSTEM_FILE = 'design-system.json';
export const BLOBS_DIR = '_blobs';
export const DESIGN_SYSTEM_LIMITS = { files: 1024, ownFiles: 1008, totalBytes: 256 * 1024 ** 2, fileBytes: 15 * 1024 ** 2, publishBytes: 16 * 1024 ** 2, uploadBytes: 20 * 1024 ** 2, svgUploadBytes: 2 * 1024 ** 2 };
export const DESIGN_SYSTEM_PATHS = { readme: 'README.md', tokens: 'tokens.json', manifest: 'manifest.json', componentsDir: 'components/', libDir: 'components/lib/', bundleJs: 'components/bundle.js', bundleCss: 'components/bundle.css', indexDts: 'components/index.d.ts', fontsDir: 'fonts/', assetsDir: 'assets/', archivedDir: 'archived/' };
export const GENERATED_TOKENS_CSS_PATH = 'tokens.css';
export const WINDOW_NAMESPACE_PATTERN = /^(?!__proto__$|constructor$|prototype$)[A-Za-z_$][\w$]{0,63}$/;
export const COMPONENT_NAME_PATTERN = WINDOW_NAMESPACE_PATTERN;
export const isRecord = record;
export function explainDesignSystemPath(rel: string): string | null { return safeRelative(rel) ? null : 'Expected a relative content path without traversal or reserved characters'; }
export function isBlobsPath(rel: string): boolean { return rel === BLOBS_DIR || rel.startsWith(BLOBS_DIR + '/'); }
export function isDesignSystemFile(rel: string): boolean { return safeRelative(rel) && !isBlobsPath(rel); }
export function designSystemUploadLimit(type: string): number { return type.split(';')[0].trim() === 'image/svg+xml' ? DESIGN_SYSTEM_LIMITS.svgUploadBytes : DESIGN_SYSTEM_LIMITS.uploadBytes; }
export function hasDesignSystemMarker(index: Record<string, unknown>): boolean { return record(index.createdOnFiles) || record(index.convertedFrom); }
export function isDesignSystemIndex(value: unknown): value is Record<string, unknown> {
  return record(value) && !record(value.content) && (hasDesignSystemMarker(value) || typeof value.v === 'number' && value.v >= 3 && value.layout === 'files');
}
export function readDesignSystemJson(dir: string): Promise<unknown> { return readJson(dir, DESIGN_SYSTEM_FILE, 8 * 1024 ** 2); }
export function designSystemTitle(index: object, dir: string): string {
  const title = (index as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title.trim() : path.basename(dir);
}
export function designSystemNamespace(index: object): string | null {
  const name = (index as Record<string, unknown>).namespace;
  return typeof name === 'string' && WINDOW_NAMESPACE_PATTERN.test(name) ? name : null;
}
export async function readDesignSystemInfo(dir: string) {
  const index = await readDesignSystemJson(dir);
  return isDesignSystemIndex(index) ? { title: designSystemTitle(index, dir), namespace: designSystemNamespace(index) } : null;
}
export async function inspectDesignSystem(dir: string) {
  const info = await readDesignSystemInfo(dir);
  return info ? { ...info, ...await inspectDirectory(dir, DESIGN_SYSTEM_FILE) } : null;
}
