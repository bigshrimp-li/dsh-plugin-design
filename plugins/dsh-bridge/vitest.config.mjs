import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const local = value => fileURLToPath(new URL(value, import.meta.url));
const coreTests = ['test/host/local-artifacts-runtime.test.mjs', 'test/host/local-uploads.test.mjs', 'test/host/goal-host-core.test.mjs', 'test/host/background-host-core.test.mjs', 'test/host/delegation-host-core.test.mjs', 'test/host/workspace-navigation-host-core.test.mjs'];
const coreRoot = process.env.SUPER_AGENT_SOURCE_ROOT;
const aliases = {
  '@super-agent/client': local('./upstream/client/src/index.ts'),
  '@super-agent/protocol': local('./upstream/protocol/src/index.ts'),
};
if (coreRoot && !path.isAbsolute(coreRoot)) throw new Error('SUPER_AGENT_SOURCE_ROOT must be an absolute Core checkout path');
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
