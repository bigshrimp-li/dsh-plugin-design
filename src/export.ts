/** Produce standalone HTML using the same local runtime as editing and screenshots. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimePath, prepareBoardHtml } from './design-runtime/resource.ts';
import { boardDefinition, parseMarkup, decodeEntities, type MarkupNode } from './design-runtime/markup.ts';
import { contentTypeOf } from './shared.ts';
export interface ExportResult { board: string; html: string; bytes: number; notes: string[] }
export interface ExportOptions { canvasDir: string; outDir?: string; boards?: string[] }
function inlineScript(source: string): string { return source.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--'); }
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
const remote = (value: string) => /^(?:[a-z]+:)?\/\//i.test(value);
export async function exportCanvas(options: ExportOptions): Promise<{ files: ExportResult[]; outDir: string }> {
  const canvasDir = await fs.realpath(options.canvasDir);
  const index = JSON.parse(await fs.readFile(path.join(canvasDir, 'canvas.json'), 'utf8'));
  const order: string[] = options.boards ?? index.order;
  if (!Array.isArray(order)) throw new Error('canvas.json needs an order list');
  const outDir = options.outDir ?? path.join(path.dirname(canvasDir), '.design-preview', path.basename(canvasDir), 'view');
  await fs.mkdir(outDir, { recursive: true });
  const runtime = await fs.readFile(runtimePath(), 'utf8');
  async function readLocal(rel: string): Promise<Buffer> {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`Invalid canvas resource path: ${rel}`);
    const file = await fs.realpath(path.join(canvasDir, rel));
    if (!file.startsWith(canvasDir + path.sep)) throw new Error(`Resource outside canvas: ${rel}`);
    return fs.readFile(file);
  }
  const assets = await fs.readdir(path.join(canvasDir, 'assets')).catch(() => [] as string[]);
  const assetCache = new Map<string, string>();
  async function inlineAssets(source: string): Promise<string> {
    for (const match of [...source.matchAll(/\/_blob\/([a-f0-9]{32})/g)]) {
      const id = match[1];
      if (!assetCache.has(id)) {
        const name = assets.find(n => n.startsWith(id + '.') && !n.endsWith('.tmp'));
        if (!name) throw new Error(`Missing export asset: ${id}`);
        assetCache.set(id, `data:${contentTypeOf(name)};base64,${(await readLocal('assets/' + name)).toString('base64')}`);
      }
      source = source.split('/_blob/' + id).join(assetCache.get(id)!);
    }
    return source;
  }
  async function inlineCss(source: string, rel: string, seen = new Set<string>()): Promise<string> {
    if (seen.has(rel)) throw new Error(`Circular CSS import: ${rel}`);
    const next = new Set([...seen, rel]);
    for (const match of [...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/gi)]) {
      if (remote(match[1])) throw new Error(`Export requires a local stylesheet: ${match[1]}`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1]));
      const css = await inlineCss((await readLocal(target)).toString('utf8'), target, next);
      source = source.replace(match[0], () => css);
    }
    source = await inlineAssets(source);
    for (const match of [...source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)]) {
      const url = match[2].trim();
      if (url.startsWith('data:') || url.startsWith('#')) continue;
      if (remote(url)) throw new Error(`Export requires a local CSS asset: ${url}`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), url));
      const uri = `data:${contentTypeOf(target)};base64,${(await readLocal(target)).toString('base64')}`;
      source = source.replace(match[0], () => `url("${uri}")`);
    }
    return source;
  }
  async function materialize(source: string, board: string, notes: string[]): Promise<string> {
    let html = await inlineAssets(source);
    html = html.replace(/href=(["'])([^"']*?)\.dc\.html((?:[?#][^"']*)?)\1/gi, (_, q, dest, suffix) => {
      notes.push('画板链接已改为导出的 HTML'); return `href=${q}${dest}.html${suffix}${q}`;
    });
    for (const match of [...html.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]) {
      if (!/rel=["']stylesheet["']/i.test(match[0])) continue;
      // Fonts are optional design assets; omit remote styles instead of introducing an offline dependency.
      if (remote(match[1])) { html = html.replace(match[0], ''); notes.push('移除了远程字体样式表；离线使用设计稿的备用字体'); continue; }
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(board), match[1]));
      const css = await inlineCss((await readLocal(rel)).toString('utf8'), rel);
      html = html.replace(match[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
    }
    for (const match of [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi)]) {
      if (match[1] === './support.js') continue;
      if (remote(match[1])) throw new Error(`Export refuses a remote script: ${match[1]}`);
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(board), match[1]));
      const script = (await readLocal(rel)).toString('utf8');
      html = html.replace(match[0], () => `<script>${inlineScript(script)}</script>`);
    }
    // Inline styles can contain uploaded assets, already converted above.
    return html;
  }
  function imports(source: string, from: string): string[] {
    const def = boardDefinition(source), list: string[] = [];
    function walk(nodes: MarkupNode[]) {
      for (const node of nodes) {
        if (node.tag === 'dc-import') {
          const name = decodeEntities(node.attrs.name ?? '');
          if (!name || /{{|[?#\\]/.test(name) || remote(name) || name.startsWith('/')) throw new Error('Component imports require static relative paths');
          list.push(path.posix.normalize(path.posix.join(path.posix.dirname(from), name.endsWith('.dc.html') ? name : name + '.dc.html')));
        }
        walk(node.children);
      }
    }
    walk(parseMarkup(def.template).nodes); return list;
  }
  const files: ExportResult[] = [];
  for (const board of order) {
    if (typeof board !== 'string' || !Object.hasOwn(index.boards, board)) throw new Error(`Unknown export board: ${board}`);
    const notes: string[] = [];
    const source = (await readLocal(board)).toString('utf8');
    const embedded: Record<string, string> = Object.create(null);
    async function collect(from: string, raw: string, chain: string[]) {
      if (chain.length > 32) throw new Error('Component import depth exceeds 32');
      for (const child of imports(raw, from)) {
        if (chain.includes(child)) throw new Error(`Circular component import: ${child}`);
        const rel = path.posix.relative(path.posix.dirname(board), child);
        if (Object.hasOwn(embedded, rel)) continue;
        const childSource = (await readLocal(child)).toString('utf8');
        embedded[rel] = await materialize(childSource, child, notes);
        await collect(child, childSource, [...chain, child]);
      }
    }
    await collect(board, source, [board]);
    let html = prepareBoardHtml(await materialize(source, board, notes));
    const support = /<script\s+src=["']\.\/support\.js["']\s*>\s*<\/script>/i;
    if (!support.test(html)) throw new Error(`${board}: missing ./support.js`);
    const registry = Object.keys(embedded).length ? `window.__designSources=Object.fromEntries(Object.entries(${json(embedded)}).map(([k,v])=>[new URL(k,location.href).href,v]));\n` : '';
    html = html.replace(support, () => `<script>${registry}${inlineScript(runtime)}</script>`);
    notes.push('内联了本地 DOM 运行时');
    if (Object.keys(embedded).length) notes.push(`内联了 ${Object.keys(embedded).length} 个设计组件`);
    const fill = index.boards[board].expand === 'fill';
    const style = `<style>html{background:#EFEEEB}#dc-root{min-height:100vh;${fill ? '' : 'display:flex;justify-content:center;padding:32px;box-sizing:border-box'}}</style>`;
    html = html.replace(/<head\b[^>]*>/i, match => match + style);
    const file = path.join(outDir, board.replace(/\.dc\.html$/, '.html'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, html);
    files.push({ board, html: file, bytes: Buffer.byteLength(html), notes: [...new Set(notes)] });
  }
  return { files, outDir };
}
