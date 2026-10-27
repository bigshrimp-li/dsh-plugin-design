import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const local = path => fileURLToPath(new URL(path, import.meta.url));
await build({
  entryPoints: {
    index: local('../src/host/index.js'),
    'core-service': local('../src/host/core-service.js'),
  },
  outdir: local('../dist/host/'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.19',
  external: ['@deepseek-ai/*'],
  alias: {
    '@super-agent/client': local('../upstream/client/src/index.ts'),
    '@super-agent/protocol': local('../upstream/protocol/src/index.ts'),
  },
});
console.log('Built DSH Host with pinned client/protocol snapshots; Core server remains external.');
