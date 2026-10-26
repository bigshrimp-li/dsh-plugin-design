/** Static validation of the local canvas protocol; rendering is checked separately. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Script } from 'node:vm';
import { inventory, record, finite, safeRelative, type FileIssue } from './files.ts';
import { CANVAS_LIMITS, canvasTitle, isCanvasMetadata, isCanvasFile, isBoardPath, readCanvasJson } from './canvas-layout.ts';
import { boardDefinition, parseMarkup, templateText, decodeEntities, type MarkupNode } from '../design-runtime/markup.ts';
import { BLOB_ID_PATTERN } from '../shared.ts';
export interface CanvasIssue extends FileIssue {}
export interface CanvasCheckResult { title: string; boardCount: number; issues: CanvasIssue[] }
const id = (value: unknown) => typeof value === 'string' && /^[\w-]{1,40}$/.test(value);
const editors = new Set(['text', 'color', 'int', 'float', 'range', 'boolean', 'enum', null]);
const remote = (value: string) => /^(?:[a-z]+:)?\/\//i.test(value);
function bindingValid(value: string) {
  return /^(?:[\w$]+(?:\.[\w$]+)*|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'[^']*')$/.test(value.trim());
}
export async function checkCanvas(dir: string): Promise<CanvasCheckResult> {
  const issues: CanvasIssue[] = [];
  const add = (file: string, message: string) => issues.push({ file, message });
  const tree = await inventory(dir, issues);
  const content = [...tree.files.keys()].filter(f => !f.startsWith('assets/'));
  if (content.length > CANVAS_LIMITS.files) add('.', `A canvas permits ${CANVAS_LIMITS.files} content files`);
  if (tree.bytes > CANVAS_LIMITS.totalBytes) add('.', 'Canvas storage exceeds 256 MB');
  for (const file of content) if (!isCanvasFile(file)) add(file, 'Invalid canvas path segment');
  const value = await readCanvasJson(dir);
  if (!isCanvasMetadata(value)) {
    add('canvas.json', 'Expected a readable JSON object with v: 3 and a boards object');
    return { title: path.basename(dir), boardCount: 0, issues };
  }
  const index = value as Record<string, any>;
  const indexError = (message: string) => add('canvas.json', message);
  if (!record(index.createdOnFiles) && !record(index.convertedFrom)) indexError('Missing createdOnFiles or convertedFrom marker');
  if (index.title !== undefined && typeof index.title !== 'string') indexError('title must be text');
  const pages = new Set<string>();
  if (index.pages !== undefined) {
    if (!Array.isArray(index.pages) || index.pages.length > 40) indexError('pages must be a list with at most 40 entries');
    else for (const page of index.pages) {
      if (!record(page) || !id(page.id) || pages.has(page.id) || typeof page.name !== 'string') indexError('Each page needs a unique id and name');
      else pages.add(page.id);
    }
  }
  const checkPage = (page: unknown, where: string) => { if (page !== undefined && !pages.has(page as string)) indexError(`${where}: unknown page`); };
  const stems = new Set<string>();
  for (const [file, board] of Object.entries(index.boards)) {
    if (!isBoardPath(file)) indexError(`Invalid board path: ${file}`);
    if (!tree.files.has(file)) indexError(`${file} does not exist`);
    if (!record(board)) { indexError(`${file}: board must be an object`); continue; }
    if (!finite(board.x) || !finite(board.y)) indexError(`${file}: x and y must be finite numbers`);
    for (const dimension of ['w', 'h']) if (!finite(board[dimension]) || board[dimension] < 40 || board[dimension] > 8000) indexError(`${file}: ${dimension} must be 40 to 8000`);
    checkPage(board.page, file);
    for (const flag of ['is_interactive', 'frameless']) if (board[flag] !== undefined && typeof board[flag] !== 'boolean') indexError(`${file}: ${flag} must be boolean`);
    if (board.title !== undefined && typeof board.title !== 'string') indexError(`${file}: title must be text`);
    if (board.expand !== undefined && board.expand !== 'fill') indexError(`${file}: expand must be fill`);
    if (board.print !== undefined && board.print !== 'flow') indexError(`${file}: print must be flow`);
    if (board.paper !== undefined && !['a4', 'letter'].includes(board.paper)) indexError(`${file}: invalid paper size`);
    if (board.radius !== undefined && (!finite(board.radius) || board.radius < 0)) indexError(`${file}: radius must be nonnegative`);
    if (board.guides !== undefined && (!Array.isArray(board.guides) || board.guides.length > 6 || board.guides.some((g: unknown) => !record(g) || !['columns','rows','grid'].includes(g.kind)))) indexError(`${file}: invalid guides`);
  }
  if (!Array.isArray(index.order)) indexError('order must list every board exactly once');
  else {
    const order = new Set(index.order);
    if (order.size !== index.order.length || index.order.some((f: unknown) => typeof f !== 'string' || !Object.hasOwn(index.boards, f)) || Object.keys(index.boards).some(f => !order.has(f))) indexError('order must list every board exactly once');
  }
  if (index.launch !== undefined) {
    if (!record(index.launch) || !['canvas','focused'].includes(index.launch.view)) indexError('launch must select canvas or focused view');
    else { checkPage(index.launch.page, 'launch'); if (index.launch.view === 'focused' && !Object.hasOwn(index.boards, index.launch.file)) indexError('launch.file must name a board'); }
  }
  if (index.notes !== undefined) {
    if (!record(index.notes) || Object.keys(index.notes).length > 200) indexError('notes must be an object with at most 200 entries');
    else for (const [key, note] of Object.entries(index.notes)) {
      if (!id(key) || !record(note) || !finite(note.x) || !finite(note.y) || typeof note.text !== 'string') indexError(`notes.${key}: expected id, x, y and text`);
      else { checkPage(note.page, `notes.${key}`); if (note.kind !== undefined && !['title1','rect','oval','pen','line','arrow','image'].includes(note.kind)) indexError(`notes.${key}: invalid kind`); }
    }
  }
  if (index.designSystems !== undefined) {
    if (!Array.isArray(index.designSystems)) indexError('designSystems must be a list');
    else for (const system of index.designSystems) {
      if (!record(system) || typeof (system.folder ?? system.namespace) !== 'string' || !safeRelative(system.folder ?? system.namespace)) indexError('designSystems entries need a local folder');
      else if (![...tree.files.keys()].some(f => f.startsWith(`ds/${system.folder ?? system.namespace}/`))) indexError(`Design system ds/${system.folder ?? system.namespace}/ does not exist`);
    }
  }
  const assets = new Set([...tree.files.keys()].filter(f => f.startsWith('assets/')).map(f => path.basename(f).split('.')[0]));
  for (const file of content) {
    if (file.startsWith('ds/')) continue;
    if (!/\.(?:html|css|js|mjs|json|svg|md|txt)$/.test(file)) continue;
    if (tree.files.get(file)! > 8 * 1024 ** 2) { add(file, 'Text file exceeds 8 MB validation limit'); continue; }
    const source = await fs.readFile(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/\/_blob\/([^\s"'()<>?#]*)/g)) if (!BLOB_ID_PATTERN.test(match[1]) || !assets.has(match[1])) add(file, `Missing or invalid asset /_blob/${match[1]}`);
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) if (remote(match[1]) && !/^https:\/\/fonts\.googleapis\.com\//.test(match[1])) add(file, 'Remote CSS imports are not supported');
    if (!isBoardPath(file)) continue;
    if (!Object.hasOwn(index.boards, file)) add(file, 'Board is not registered in canvas.json');
    const stem = path.basename(file);
    if (stems.has(stem)) add(file, 'Duplicate board filename'); stems.add(stem);
    if (!source.includes('<script src="./support.js"></script>')) add(file, 'Use the exact line <script src="./support.js"></script>');
    let nodes: MarkupNode[] = [];
    try { const parsed = parseMarkup(templateText(source)); nodes = parsed.nodes; parsed.problems.forEach(p => add(file, p)); }
    catch (error) { add(file, (error as Error).message); }
    // Report malformed unquoted attributes even when an earlier broken quote hides a tag.
    if (/<[a-z][^>]*\s[\w-]+=([^\s"'`=<>][^\s>]*)/i.test(source)) add(file, 'An attribute value is not quoted');
    for (const m of source.matchAll(/{{([\s\S]*?)}}/g)) if (!bindingValid(decodeEntities(m[1]))) add(file, `Binding {{${m[1]}}} is an expression; compute it in renderVals`);
    if (/\b(?:src|href)\s*=\s*["']data:/i.test(source)) add(file, 'Use imported assets instead of a data: URI');
    if (/<(?:iframe|object|embed)\b/i.test(source)) add(file, '<iframe> is not allowed; neither are object or embed');
    if (/\b(?:innerHTML|outerHTML|appendChild|insertAdjacentHTML)\b/.test(source)) add(file, 'Logic builds UI from script; put elements in the template');
    try {
      const def = boardDefinition(source);
      const box = index.boards[file];
      if (record(box) && (!record(def.props.$preview) || def.props.$preview.width !== box.w || def.props.$preview.height !== box.h)) add(file, '$preview must match canvas.json w and h');
      for (const [name, prop] of Object.entries(def.props)) if (!name.startsWith('$') && record(prop) && Object.hasOwn(prop, 'editor') && !editors.has(prop.editor)) add(file, `Unknown prop editor: ${name}`);
      if (!/class\s+Component\s+extends\s+DCLogic\b/.test(def.logic)) add(file, 'Declare class Component extends DCLogic');
      try { new Script(`(function(DCLogic){${def.logic}\n})`); } catch (error) { add(file, `Invalid classic JavaScript: ${(error as Error).message}`); }
      if (/\b(?:innerHTML|outerHTML|appendChild|insertAdjacentHTML)\b/.test(def.logic)) add(file, 'Logic builds UI from script; put elements in the template');
      if (/\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(|\bimport\s*\(/.test(def.logic)) add(file, 'Logic must not load network resources');
      if (/(?:window|document)\s*\.\s*addEventListener\s*\(\s*['"]key/.test(def.logic)) add(file, 'Global keyboard handlers interfere with the editor');
    } catch (error) { add(file, error instanceof SyntaxError ? 'data-props is not valid JSON' : (error as Error).message); }
    function visit(list: MarkupNode[], inSvg = false) {
      for (const node of list) {
        const attrs = Object.fromEntries(Object.entries(node.attrs).map(([k, v]) => [k.toLowerCase(), decodeEntities(v)]));
        if (node.tag === 'x-import') add(file, 'x-import requires an external framework; migrate to dc-import or a local custom element');
        if (node.tag === 'dc-import') {
          const name = attrs.name ?? '';
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), name.endsWith('.dc.html') ? name : name + '.dc.html'));
          if (!safeRelative(target) || !tree.files.has(target)) add(file, `Component ${name} does not exist`);
        }
        for (const [name, value] of Object.entries(attrs)) {
          if (name.startsWith('on') && !/^{{[\s\S]*}}$/.test(value)) add(file, `Event ${name} must bind a function`);
          if (name === 'src' && node.tag === 'img' && !value.includes('{{') && !value.startsWith('/_blob/')) add(file, 'Image src must use an imported /_blob/ asset');
          if (name === 'style' && /url\(/i.test(value)) add(file, 'Put asset URLs in a helmet style rule');
          if ((name === 'href' || name === 'src') && !/{{/.test(value) && value && !value.startsWith('#') && !value.startsWith('/_blob/') && !remote(value) && !/^(?:data|mailto|tel):/.test(value) && value !== './support.js') {
            const clean = value.split(/[?#]/)[0];
            const target = clean.startsWith('/') ? clean.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
            if (!safeRelative(target) || !tree.files.has(target)) add(file, `Resource ${value} does not exist`);
          }
          if ((name === 'src' || name === 'href' && node.tag === 'link') && remote(value) && !/^https:\/\/fonts\.googleapis\.com\//.test(value)) add(file, 'Remote executable resources are not supported');
        }
        visit(node.children, inSvg || node.tag === 'svg');
      }
    }
    visit(nodes);
  }
  return { title: canvasTitle(index, dir), boardCount: Object.keys(index.boards).length, issues };
}
