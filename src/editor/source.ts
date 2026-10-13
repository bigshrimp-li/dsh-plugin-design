/**
 * `tid` ↔ 源码位置。
 *
 * 编辑器要"改哪个元素"，靠的是运行时刻在每个渲染出来的元素上的 `data-dc-tpl` —— 实测它就是
 * 格式文档里定义的 `tid`：`<x-dc>…</x-dc>` 片段里的**元素**按文档顺序（前序、深度优先）编号，
 * 从 0 开始，`<helmet>` 是 0。
 *
 * 所以写入端要做的只有一件事：用同样的遍历顺序再走一遍**源文本**，第 N 个元素就是目标，
 * 然后替换它的 `style` 属性（或它的文字）。不需要 AST，也不需要把 React 组件树序列化回源码 ——
 * 因为这个格式的编辑模型本来就是"行内样式即真源"。
 *
 * 标签的形状沿用 `src/check/canvas-check.ts` 里那份（同一套正则常量），保证两侧看到的是同一种 HTML。
 */
import { readFile } from 'node:fs/promises';

const ATTRS = String.raw`((?:[^>"']|"[^"]*"|'[^']*')*)`;
const TAG = new RegExp(String.raw`<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][A-Za-z0-9:-]*)` + ATTRS + '>', 'g');
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
/** 内容是原始文本的元素：里面的 `<` 不算标签。 */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

export interface SourceAttr {
  name: string;
  value: string | null;
  /** 值的 [from, to)，不含引号；没有值时为 null。 */
  valueSpan: [number, number] | null;
  span: [number, number];
}

export interface SourceElement {
  /** 运行时刻的 `data-dc-tpl`。 */
  tid: number;
  tag: string;
  depth: number;
  parentTid: number | null;
  /** 开始标签 `<div …>` 的 [from, to)。 */
  startTag: [number, number];
  /** 元素的 [from, to)，含结束标签；void 元素与开始标签相同。 */
  full: [number, number];
  /** 内容的 [from, to)；void 与自闭合元素为空区间。 */
  inner: [from: number, to: number];
  attrs: SourceAttr[];
  selfClosing: boolean;
  isVoid: boolean;
  /** 行内 style 属性的值（没有就是空串）。 */
  style: string;
  /** style 属性**值**的 [from, to)；没有这个属性时为 null。 */
  styleSpan: [number, number] | null;
  /** 元素里第一段纯文字（去掉子元素与标签后），用于面板上的标题。 */
  text: string;
}

/** 属性串切成 name/value，并记下每个值在整份源码里的绝对区间。 */
function parseAttrs(raw: string, offset: number): SourceAttr[] {
  const out: SourceAttr[] = [];
  const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1]!;
    if (name === '/') continue;
    let value: string | null = null;
    let valueSpan: [number, number] | null = null;
    if (m[2] !== undefined) {
      if (m[3] !== undefined) {
        value = m[3];
        const at = offset + m.index + m[0]!.indexOf('"') + 1;
        valueSpan = [at, at + m[3].length];
      } else if (m[4] !== undefined) {
        value = m[4];
        const at = offset + m.index + m[0]!.indexOf("'") + 1;
        valueSpan = [at, at + m[4].length];
      } else {
        value = m[5]!;
        const at = offset + m.index + m[0]!.lastIndexOf(m[5]!);
        valueSpan = [at, at + m[5]!.length];
      }
    }
    out.push({ name, value, valueSpan, span: [offset + m.index, offset + m.index + m[0].length] });
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

/** 把一份画板源码里的元素按 tid 列出来。解析不出来（没有 `<x-dc>`）就返回空数组。 */
export function listElements(source: string): SourceElement[] {
  const open = /<x-dc(?:\s[^>]*)?>/i.exec(source);
  if (open === null) return [];
  const closeAt = source.lastIndexOf('</x-dc>');
  const from = open.index + open[0]!.length;
  const to = closeAt > from ? closeAt : source.length;

  const out: SourceElement[] = [];
  const stack: SourceElement[] = [];
  let tid = 0;
  let cursor = from;
  TAG.lastIndex = from;

  while (cursor < to) {
    TAG.lastIndex = cursor;
    const m = TAG.exec(source);
    if (m === null || m.index >= to) break;
    if (m[0].startsWith('<!--')) { cursor = m.index + m[0].length; continue; }
    const [whole, slash, name, rawAttrs] = [m[0]!, m[1]!, m[2]!, m[3] ?? ''];
    const tag = name.toLowerCase();
    const closing = slash === '/';
    const attrsAt = m.index + 1 + slash.length + name.length;
    const attrs = parseAttrs(rawAttrs, attrsAt);
    const styleAttr = attrs.find((a) => a.name.toLowerCase() === 'style');
    const selfClosing = /\/\s*>$/.test(whole);
    const isVoid = VOID_ELEMENTS.has(tag);
    const end = m.index + whole.length;

    if (closing) {
      // 关掉最近的同名开标签
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.tag === tag) {
          const done = stack.splice(i, 1)[0]!;
          done.full = [done.startTag[0], end];
          done.inner = [done.startTag[1], m.index];
          break;
        }
      }
      cursor = end;
      continue;
    }

    const el: SourceElement = {
      tid: tid++,
      tag,
      depth: stack.length,
      parentTid: stack.length > 0 ? stack[stack.length - 1]!.tid : null,
      startTag: [m.index, end],
      full: [m.index, end],
      inner: [end, end],
      attrs,
      selfClosing,
      isVoid,
      style: decodeAttribute(styleAttr?.value ?? ''),
      styleSpan: styleAttr?.valueSpan ?? null,
      text: '',
    };
    out.push(el);

    if (isVoid || selfClosing) {
      cursor = end;
      continue;
    }
    if (RAW_TEXT.has(tag)) {
      // 跳到配对的关标签，里面的 `<` 不算标签
      const close = new RegExp(String.raw`</${tag}\s*>`, 'i');
      const rest = source.slice(end, to);
      const hit = close.exec(rest);
      const closeEnd = hit === null ? to : end + hit.index + hit[0]!.length;
      el.inner = [end, hit === null ? to : end + hit.index];
      el.full = [m.index, closeEnd];
      cursor = closeEnd;
      continue;
    }
    stack.push(el);
    cursor = end;
  }

  // 收尾：没闭合的元素，内容到片段末尾
  for (const el of stack) {
    el.inner = [el.startTag[1], to];
    el.full = [el.startTag[0], to];
  }

  // 第一段纯文字
  for (const el of out) {
    if (el.isVoid || el.selfClosing || RAW_TEXT.has(el.tag)) continue;
    const inner = source.slice(el.inner[0], el.inner[1]);
    const first = inner.split(/<[^>]*>/).map((s) => s.trim()).find((s) => s !== '');
    el.text = first === undefined ? '' : first.replace(/\s+/g, ' ').slice(0, 60);
  }
  return out;
}

export function elementAt(source: string, tid: number): SourceElement | null {
  return listElements(source).find((el) => el.tid === tid) ?? null;
}

function decodeAttribute(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? whole;
    const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
function encodeAttribute(value: string, quote: string): string {
  return value.replace(/&/g, '&amp;').replace(quote === "'" ? /'/g : /"/g, quote === "'" ? '&#39;' : '&quot;');
}

/** 替换（或插入）某个元素的 `style` 属性。style 传空串 = 去掉这个属性。 */
export function setInlineStyle(source: string, tid: number, style: string): string {
  const el = elementAt(source, tid);
  if (el === null) throw new Error(`源码里没有 tid ${tid} 这个元素`);
  const trimmed = style.trim().replace(/;\s*$/, '');
  if (el.styleSpan !== null) {
    if (trimmed === '') {
      // 连属性一起删掉（含前面的空白）
      const attr = el.attrs.find(a => a.name.toLowerCase() === 'style')!;
      let start = attr.span[0];
      while (start > el.startTag[0] && /\s/.test(source[start - 1]!)) start--;
      return source.slice(0, start) + source.slice(attr.span[1]);
    }
    const quote = source[el.styleSpan[0] - 1]!;
    return source.slice(0, el.styleSpan[0]) + encodeAttribute(trimmed, quote) + source.slice(el.styleSpan[1]);
  }
  if (trimmed === '') return source;
  // 没有 style：插在开始标签末尾，保持引号风格与源码一致
  const at = el.selfClosing ? el.startTag[1] - 2 : el.startTag[1] - 1;
  const pad = at > 0 && /\s/.test(source[at - 1]!) ? '' : ' ';
  return `${source.slice(0, at)}${pad}style="${encodeAttribute(trimmed, '"')}"${source.slice(at)}`;
}

/** 把某个元素的**纯文字内容**换掉。元素里有子元素时拒绝（那属于结构编辑）。 */
export function setText(source: string, tid: number, text: string): string {
  const el = elementAt(source, tid);
  if (el === null) throw new Error(`源码里没有 tid ${tid} 这个元素`);
  if (el.isVoid || el.selfClosing) throw new Error(`<${el.tag}> 没有内容，改不了文字`);
  if (['script', 'style', 'helmet'].includes(el.tag)) throw new Error('样式和脚本不是可编辑文字');
  const inner = source.slice(el.inner[0], el.inner[1]);
  if (/<[A-Za-z][A-Za-z0-9:-]*/.test(inner)) {
    throw new Error(`<${el.tag}> 里还有子元素，原地改文字只支持纯文字节点`);
  }
  // hole 是数据绑定：原地改文字会把绑定改坏，拒绝
  if (/\{\{/.test(inner)) {
    throw new Error(`这段文字是 {{…}} 数据绑定，要改得改它的 prop，不能原地改字`);
  }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return source.slice(0, el.inner[0]) + escaped + source.slice(el.inner[1]);
}

/** 行内 `style="a: b; c: d"` ↔ `{a: 'b', c: 'd'}`。面板读写用这个表示。 */
export function parseInlineStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of style.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name !== '') out[name] = value;
  }
  return out;
}

export function stringifyInlineStyle(decls: Record<string, string>): string {
  return Object.entries(decls)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

/** 读一个画板文件，附上它的源码；编辑器每次写入前都要重新读一遍（可能有别人在改）。 */
export async function readBoard(file: string): Promise<string> {
  return readFile(file, 'utf8');
}
