import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// This optional entry deliberately loads the Core's built public dist entries.
const upstream = name => fileURLToPath(new URL("./upstream/" + name + "/src/index.ts", import.meta.url));
export default defineConfig({ resolve: { alias: { "@super-agent/client": upstream("client"), "@super-agent/protocol": upstream("protocol") } }, test: { environment: "node", include: ["test/host/goal-host-core.test.mjs", "test/host/background-host-core.test.mjs", "test/host/settings-host-core.test.mjs", "test/host/delegation-host-core.test.mjs", "test/host/workspace-navigation-host-core.test.mjs"],
  testTimeout: 30000, hookTimeout: 30000, pool: "forks", fileParallelism: false } });
