import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const local = value => fileURLToPath(new URL(value, import.meta.url));
const coreTests = ['test/host/local-artifacts-runtime.test.mjs', 'test/host/local-uploads.test.mjs'];
const coreRoot = process.env.SUPER_AGENT_SOURCE_ROOT;
const aliases = {
  '@super-agent/client': local('./upstream/client/src/index.ts'),
  '@super-agent/protocol': local('./upstream/protocol/src/index.ts'),
};
if (coreRoot) {
  if (!path.isAbsolute(coreRoot)) throw new Error('SUPER_AGENT_SOURCE_ROOT must be an absolute Core checkout path');
  for (const name of ['server', 'core', 'config', 'models']) {
    aliases['@super-agent/' + name] = path.join(coreRoot, 'packages', name, 'src/index.ts');
  }
  const chord = path.join(coreRoot, 'node_modules/@earendil-works/chord');
  const manifest = JSON.parse(readFileSync(path.join(chord, 'package.json'), 'utf8'));
  const exported = manifest.exports?.['./context'];
  const entry = typeof exported === 'string' ? exported : exported?.import;
  if (typeof entry !== 'string') throw new Error('Core Chord package must expose ./context for ESM imports');
  aliases['@earendil-works/chord/context'] = path.resolve(chord, entry);
}
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    environment: 'node',
    include: coreRoot ? coreTests : ['test/**/*.test.{js,mjs}'],
    exclude: coreRoot ? [] : coreTests,
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});
