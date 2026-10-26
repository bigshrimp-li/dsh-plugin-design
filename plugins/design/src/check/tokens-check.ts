/** Validate token values without importing a design-system parser or CSS engine. */
import { record, finite, safeRelative } from './files.ts';
export interface TokensCheck { problems: string[]; notes: string[] }
export const TOKENS_LIMITS = { bytes: 512 * 1024, themes: 8, colors: 600, fontFaces: 4096, fontFamilies: 12, typographyGroups: 12, typographyStyles: 80, tokensPerFamily: 60, extraFamilies: 12, colorAliasDepth: 16 };
const nameOK = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][\w.-]{0,63}$/.test(v) && !['__proto__','constructor','prototype'].includes(v);
const lengthOK = (v: unknown) => typeof v === 'string' && /^(?:0|-?\d+(?:\.\d+)?(?:px|rem|em|%))$/.test(v);
const safeCSS = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 400 && !/[;{}<>\\]|(?:url|expression|image-set)\s*\(/i.test(v)) || finite(v);
const colorOK = (v: unknown) => typeof v === 'string' && (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(v) || /^(?:rgb|hsl|oklch|oklab|lab|lch|color)a?\([\da-z.% ,/+-]+\)$/i.test(v));
export function checkTokensText(text: string): TokensCheck {
  const result: TokensCheck = { problems: [], notes: [] };
  const bad = (value: string) => result.problems.push(value);
  if (Buffer.byteLength(text) > TOKENS_LIMITS.bytes) { bad('tokens.json exceeds 512 KiB'); return result; }
  let data: any;
  try { data = JSON.parse(text); } catch { bad('tokens.json is not valid JSON'); return result; }
  if (!record(data)) { bad('Token document must be an object'); return result; }
  const themes = new Set<string>(), colors = new Map<string, any>();
  if (data.color !== undefined) {
    if (!record(data.color) || !Array.isArray(data.color.tokens)) bad('color has no "tokens" list');
    if (!Array.isArray(data.color?.themes) || !data.color.themes.length) bad('color.themes must contain at least one theme');
    else {
      if (data.color.themes.length > TOKENS_LIMITS.themes) bad('Too many color themes');
      for (const theme of data.color.themes) {
        if (!record(theme) || !nameOK(theme.id) || themes.has(theme.id) || typeof theme.name !== 'string') bad('Invalid or duplicate color theme');
        else themes.add(theme.id);
      }
    }
  }
  const families = Object.entries(data).filter(([key, value]) => !['version','name','type','meta'].includes(key) && (['color','spacing','radius','shadow','motion'].includes(key) || record(value) && 'tokens' in value));
  if (families.length > TOKENS_LIMITS.extraFamilies + 5) bad('Too many token families');
  for (const [family, value] of families) {
    if (!record(value) || !Array.isArray(value.tokens)) { if (family !== 'color') bad(`${family} has no "tokens" list`); continue; }
    const names = new Set<string>();
    if (value.tokens.length > (family === 'color' ? TOKENS_LIMITS.colors : TOKENS_LIMITS.tokensPerFamily)) bad(`${family}: too many tokens`);
    for (const token of value.tokens) {
      if (!record(token) || !nameOK(token.name) || names.has(token.name)) { bad(`${family}: bad or duplicate name`); continue; }
      names.add(token.name);
      if (family === 'color') {
        colors.set(token.name, token.value);
        if (!record(token.value) && !(typeof token.value === 'string' && /^\{[^{}]+\}$/.test(token.value))) bad(`color.${token.name}: value must map theme IDs to colors or name an alias`);
      } else if (family === 'spacing' || family === 'radius') {
        if (!lengthOK(token.value)) bad(`${family}.${token.name}: expected a CSS length with units`);
      } else if (!(record(token.value) ? Object.values(token.value).every(safeCSS) : safeCSS(token.value))) bad(`${family}.${token.name}: invalid CSS value`);
      if (token.usage !== undefined && typeof token.usage !== 'string') bad(`${family}.${token.name}: usage must be text`);
    }
  }
  function resolve(name: string, theme: string, chain: string[]): boolean {
    if (chain.includes(name) || chain.length > TOKENS_LIMITS.colorAliasDepth) return false;
    const values = colors.get(name), value = record(values) ? values[theme] : values;
    if (colorOK(value)) return true;
    const alias = typeof value === 'string' ? /^\{([^{}]+)\}$/.exec(value) : null;
    return !!alias && resolve(alias[1], theme, [...chain, name]);
  }
  for (const [name] of colors) for (const theme of themes) if (!resolve(name, theme, [])) bad(`color.${name}.${theme}: missing color, invalid value or cyclic alias`);
  if (data.type !== undefined) {
    if (!record(data.type)) bad('type must be an object');
    else {
      const type = data.type;
      if (type.families !== undefined && !record(type.families)) bad('type.families must be an object');
      const families = record(type.families) ? type.families : {};
      if (Object.keys(families).length > TOKENS_LIMITS.fontFamilies) bad('Too many font families');
      for (const [name, value] of Object.entries(families)) if (!nameOK(name) || typeof value !== 'string' || !safeCSS(value)) bad(`Invalid font family: ${name}`);
      if (type.fonts !== undefined && (!Array.isArray(type.fonts) || type.fonts.length > TOKENS_LIMITS.fontFaces)) bad('Invalid font list');
      else for (const font of type.fonts ?? []) if (!record(font) || typeof font.family !== 'string' || !safeRelative(font.file) || !/^fonts\/.+\.(?:woff2?|ttf|otf)$/.test(font.file)) bad('Font entries need a family and local fonts/ file');
      if (type.groups !== undefined && (!Array.isArray(type.groups) || type.groups.length > TOKENS_LIMITS.typographyGroups)) bad('Invalid typography groups');
      else {
        const names = new Set<string>(); let count = 0;
        for (const group of type.groups ?? []) {
          if (!record(group) || !Array.isArray(group.styles)) { bad('Typography group needs a styles list'); continue; }
          if (group.family && !Object.hasOwn(families, group.family)) bad(`Unknown typography family: ${group.family}`);
          for (const style of group.styles) {
            count++;
            if (!record(style) || !nameOK(style.name) || names.has(style.name)) { bad('Typography style: bad or duplicate name'); continue; }
            names.add(style.name);
            if (!lengthOK(style.fontSize)) bad(`${style.name}: invalid fontSize`);
            if (style.lineHeight !== undefined && !lengthOK(style.lineHeight) && !finite(style.lineHeight) && style.lineHeight !== 'normal') bad(`${style.name}: invalid lineHeight`);
            if (style.fontWeight !== undefined && !(Number(style.fontWeight) >= 1 && Number(style.fontWeight) <= 1000)) bad(`${style.name}: invalid fontWeight`);
          }
        }
        if (count > TOKENS_LIMITS.typographyStyles) bad('Too many typography styles');
      }
    }
  }
  return result;
}
export function tokenFontFiles(text: string): string[] {
  try { const data = JSON.parse(text); return Array.isArray(data?.type?.fonts) ? data.type.fonts.filter((v: any) => record(v) && safeRelative(v.file)).map((v: any) => v.file) : []; } catch { return []; }
}
