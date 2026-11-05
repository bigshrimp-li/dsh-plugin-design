import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';

const directory = new URL('../client/', import.meta.url);
const types = { html: 'text/html', css: 'text/css', js: 'text/javascript' };
const files = new Map(
  readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && /^[a-z][\w-]*\.(js|css|html)$/.test(file.name))
    .map((file) => ['/okr-space/ui/' + file.name, file.name]),
);

export const clientAssetPaths = [...files.keys()];
export async function serveClientAsset(pathname, req, res) {
  const file = files.get(pathname);
  if (!file) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  const bytes = await readFile(new URL(file, directory));
  res.writeHead(200, {
    'Content-Type': types[file.split('.').pop()] + '; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' dsh-app:",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : bytes);
  return true;
}
