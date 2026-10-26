/** Local design-system validation. This module does not execute component bundles. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Script } from 'node:vm';
import { record, finite, safeRelative, inventory, type FileIssue } from './files.ts';
import { DESIGN_SYSTEM_LIMITS, DESIGN_SYSTEM_FILE, readDesignSystemJson, designSystemTitle, designSystemNamespace, hasDesignSystemMarker } from './system-layout.ts';
import { checkTokensText, tokenFontFiles } from './tokens-check.ts';
import { BLOB_ID_PATTERN } from '../shared.ts';
export const DESIGN_SYSTEM_ISSUE_CODES = ['ASSET_RECORD_MISSING_UPLOAD'] as const;
export type DesignSystemIssueCode = typeof DESIGN_SYSTEM_ISSUE_CODES[number];
export interface DesignSystemIssue extends FileIssue { code?: DesignSystemIssueCode }
export interface DesignSystemCheckResult { title: string; namespace: string | null; issues: DesignSystemIssue[]; notes: DesignSystemIssue[]; notChecked: string[] }
export const DESIGN_SYSTEM_NOT_CHECKED = ['manifest.json', 'tokens.css', 'api/'];
export function isAssetGroupName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 80 && !name.includes('/') && safeRelative(name);
}
export function encodeIndexKey(key: string): string {
  return Array.from(Buffer.from(key), byte => /[\w./-]/.test(String.fromCharCode(byte)) && byte < 128 ? String.fromCharCode(byte) : '~' + byte.toString(16).padStart(2, '0')).join('');
}
export function decodeIndexKey(key: string): string {
  try { return decodeURIComponent(key.replace(/%/g, '%25').replace(/~([\da-f]{2})/gi, '%$1')); } catch { return key; }
}
export async function checkDesignSystem(dir: string): Promise<DesignSystemCheckResult> {
  const result: DesignSystemCheckResult = { title: path.basename(dir), namespace: null, issues: [], notes: [], notChecked: [...DESIGN_SYSTEM_NOT_CHECKED] };
  const add = (file: string, message: string, code?: DesignSystemIssueCode) => result.issues.push({ file, message, ...(code ? { code } : {}) });
  const tree = await inventory(dir, result.issues);
  if (tree.files.size > DESIGN_SYSTEM_LIMITS.files || tree.bytes > DESIGN_SYSTEM_LIMITS.totalBytes) add('.', 'Design system exceeds its file count or 256 MB storage limit');
  const index = await readDesignSystemJson(dir);
  if (!record(index)) { add(DESIGN_SYSTEM_FILE, 'Missing or invalid JSON index'); return result; }
  result.title = designSystemTitle(index, dir); result.namespace = designSystemNamespace(index);
  if (!hasDesignSystemMarker(index)) add(DESIGN_SYSTEM_FILE, 'no createdOnFiles or convertedFrom marker');
  if (index.v !== 3 || index.layout !== 'files') add(DESIGN_SYSTEM_FILE, 'Expected v: 3 and layout: files');
  if (index.namespace !== undefined && result.namespace === null) add(DESIGN_SYSTEM_FILE, "namespace must be the bundle's global JavaScript identifier");
  for (const field of ['sections', 'assetGroups', 'blobs', 'docs']) if (!record(index[field])) add(DESIGN_SYSTEM_FILE, `${field} must be an object`);
  for (const field of ['libraries', 'groups']) if (!Array.isArray(index[field])) add(DESIGN_SYSTEM_FILE, `${field} must be a list`);
  const blobIds = new Set([...tree.files.keys()].filter(f => f.startsWith('_blobs/')).map(f => path.basename(f).split('.')[0]));
  function assetEntries(entries: unknown, prefix: string) {
    if (!record(entries)) { add(DESIGN_SYSTEM_FILE, `${prefix}: expected an asset record map`); return; }
    for (const [key, value] of Object.entries(entries)) {
      const target = prefix + decodeIndexKey(key);
      if (!safeRelative(target) || !record(value) || !BLOB_ID_PATTERN.test(value.blob) || !finite(value.size) || value.size < 0 || typeof value.type !== 'string') { add(DESIGN_SYSTEM_FILE, `Invalid asset record: ${target}`); continue; }
      if (!blobIds.has(value.blob) && !tree.files.has(target)) add(DESIGN_SYSTEM_FILE, `Asset ${target} has no uploaded blob or local file`, 'ASSET_RECORD_MISSING_UPLOAD');
    }
  }
  assetEntries(index.blobs ?? {}, '');
  for (const [key, group] of Object.entries(record(index.assetGroups) ? index.assetGroups : {})) {
    const name = record(group) ? group.name ?? decodeIndexKey(key) : '';
    if (!isAssetGroupName(name) || !record(group)) { add(DESIGN_SYSTEM_FILE, `Invalid asset group ${key}`); continue; }
    assetEntries(group.files, `assets/${name}/`);
    if (group.order !== undefined && (!Array.isArray(group.order) || group.order.some((k: any) => !record(group.files) || !Object.hasOwn(group.files, k)))) add(DESIGN_SYSTEM_FILE, `Invalid asset group order: ${key}`);
  }
  const docs = record(index.docs) ? index.docs : {};
  for (const ref of [docs.readme, ...(Array.isArray(docs.sections) ? docs.sections.map((s: any) => typeof s === 'string' ? s : s?.file) : [])].filter(v => v !== undefined)) {
    if (!safeRelative(ref) || !tree.files.has(ref)) add(DESIGN_SYSTEM_FILE, `Document ${String(ref)} does not exist`);
  }
  for (const [file, size] of tree.files) {
    if (!safeRelative(file)) { add(file, 'Invalid relative content path'); continue; }
    if (file.startsWith('_blobs/')) continue;
    if (size > DESIGN_SYSTEM_LIMITS.fileBytes) { add(file, 'File exceeds 15 MiB'); continue; }
    if (file === 'manifest.json' || file === 'tokens.css' || file.startsWith('api/')) continue;
    if (!/\.(?:json|js|mjs|html|css|md|svg)$/.test(file)) continue;
    const source = await fs.readFile(path.join(dir, file), 'utf8');
    if (file === 'tokens.json') {
      const checked = checkTokensText(source);
      checked.problems.forEach(m => add(file, m)); checked.notes.forEach(message => result.notes.push({ file, message }));
      for (const font of tokenFontFiles(source)) if (!tree.files.has(font)) add(file, `Font ${font} does not exist`);
    }
    if (file.endsWith('preview.html')) {
      if (!/^\s*<!--\s*@dsCard\b/.test(source)) add(file, 'Preview must start with @dsCard metadata');
      if (/<(?:iframe|object|embed|frame|portal|noscript)\b/i.test(source)) add(file, 'Unsupported preview embedding element');
    }
    if (/\.(?:html|css|js)$/.test(file) && /(?:src\s*=\s*["']|@import\s+["']|url\(\s*["']?)(?:https?:)?\/\//i.test(source)) add(file, 'Keep executable preview resources local');
    if (file === 'components/bundle.js') {
      try { new Script(source); } catch (error) { add(file, `Bundle must be classic JavaScript: ${(error as Error).message}`); }
      if (/<\/script|<!--/i.test(source)) add(file, 'Bundle contains an unsafe inline-script delimiter');
      if (/\b(?:fetch|XMLHttpRequest|WebSocket|import)\s*\(/.test(source)) add(file, 'Bundle must not load remote code');
      if (result.namespace && !source.includes('window.' + result.namespace)) add(file, 'Bundle does not assign its declared window namespace');
    }
    for (const m of source.matchAll(/\/_blob\/([\da-f]{32})/g)) if (!blobIds.has(m[1])) add(file, `Missing uploaded blob ${m[1]}`);
  }
  if (!tree.files.has('tokens.json')) add('tokens.json', 'Missing token document');
  return result;
}
