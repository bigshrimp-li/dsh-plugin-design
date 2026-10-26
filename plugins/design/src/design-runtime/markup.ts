/** Local design file grammar. Template IDs follow source opening-tag order. */
export interface MarkupNode {
  tag: string;
  tid: number;
  attrs: Record<string, string>;
  children: MarkupNode[];
  text?: string;
}
export const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
export const RAW_TAGS = new Set(['style', 'script', 'textarea', 'title']);
export function parseMarkup(input: string): { nodes: MarkupNode[]; problems: string[] } {
  const root: MarkupNode = { tag: '', tid: -1, attrs: {}, children: [] };
  const stack = [root];
  const problems: string[] = [];
  const tokens = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  let cursor = 0, tid = 0;
  const text = (value: string) => { if (value) stack.at(-1)!.children.push({ tag: '#text', tid: -1, attrs: {}, children: [], text: value }); };
  while (cursor < input.length) {
    tokens.lastIndex = cursor;
    const token = tokens.exec(input);
    if (!token) { text(input.slice(cursor)); break; }
    text(input.slice(cursor, token.index));
    cursor = tokens.lastIndex;
    if (token[0].startsWith('<!--')) continue;
    const match = /^<(\/?)([\w:-]+)([\s\S]*?)>$/.exec(token[0])!;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      if (stack.length === 1 || stack.at(-1)!.tag !== tag) problems.push(`Unexpected closing tag </${tag}>`);
      const at = stack.map(n => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const node: MarkupNode = { tag, tid: tid++, attrs: Object.create(null), children: [] };
    if (tag !== match[2] && !stack.some(n => n.tag === 'svg')) problems.push(`Use lowercase tag <${tag}>`);
    const attrs = match[3].replace(/\/\s*$/, '');
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const a of attrs.matchAll(attrPattern)) {
      node.attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? '';
      if (a[4] !== undefined) problems.push(`Attribute ${a[1]} is not quoted`);
    }
    stack.at(-1)!.children.push(node);
    if (RAW_TAGS.has(tag)) {
      const end = new RegExp(`</${tag}\\s*>`, 'ig'); end.lastIndex = cursor;
      const close = end.exec(input);
      node.children.push({ tag: '#text', tid: -1, attrs: {}, children: [], text: input.slice(cursor, close?.index ?? input.length) });
      cursor = close ? end.lastIndex : input.length;
      if (!close) problems.push(`Missing closing tag </${tag}>`);
    } else if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token[0])) stack.push(node);
    else if (!VOID_TAGS.has(tag) && tag !== 'svg' && !stack.some(n => n.tag === 'svg')) problems.push(`Non-SVG <${tag}> must have a closing tag`);
  }
  for (const n of stack.slice(1)) problems.push(`Missing closing tag </${n.tag}>`);
  return { nodes: root.children, problems };
}
export function templateText(source: string): string {
  const open = /<x-dc(?:\s[^>]*)?>/i.exec(source);
  const end = source.toLowerCase().lastIndexOf('</x-dc>');
  if (!open || end < open.index) throw new Error('A design file needs one <x-dc> template');
  return source.slice(open.index + open[0].length, end);
}
export function decodeEntities(value: string): string {
  const names: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' };
  return value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, key: string) => {
    if (key[0] !== '#') return names[key] ?? all;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  });
}
export function boardDefinition(source: string) {
  const script = [...source.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m => /\bdata-dc-script\b/.test(m[1]));
  if (script.length !== 1) throw new Error('A design file needs exactly one data-dc-script');
  const node = parseMarkup(`<script${script[0][1]}></script>`).nodes[0];
  const props = JSON.parse(decodeEntities(node.attrs['data-props'] ?? '{}'));
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('data-props must be an object');
  return { template: templateText(source), logic: script[0][2], props };
}
