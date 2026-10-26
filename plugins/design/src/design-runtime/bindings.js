// Bindings deliberately accept data paths and literals, never template expressions.
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
export function lookup(path, scope) {
  path = path.trim();
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (path === 'null') return null;
  if (path === 'undefined') return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(path)) return Number(path);
  if (/^"(?:[^"\\]|\\.)*"$/.test(path)) return JSON.parse(path);
  if (/^'[^']*'$/.test(path)) return path.slice(1, -1);
  if (!/^[\w$]+(?:\.[\w$]+)*$/.test(path)) throw new Error(`Unsupported binding expression: ${path}`);
  return path.split('.').reduce((value, key) => {
    if (forbidden.has(key)) throw new Error(`Reserved binding key: ${key}`);
    return value == null ? undefined : value[key];
  }, scope);
}
export function bind(value, scope) {
  const exact = /^{{\s*([\s\S]*?)\s*}}$/.exec(value);
  if (exact) return lookup(exact[1], scope);
  return value.replace(/{{([\s\S]*?)}}/g, (_, path) => String(lookup(path, scope) ?? ''));
}
export function defaults(schema) {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !key.startsWith('$')).map(([key, value]) =>
    [key, value && typeof value === 'object' && Object.hasOwn(value, 'default') ? value.default : value && typeof value === 'object' && Object.hasOwn(value, 'editor') ? undefined : value]));
}
