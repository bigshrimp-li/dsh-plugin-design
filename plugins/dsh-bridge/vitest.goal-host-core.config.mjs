import { defineConfig } from "vitest/config";

// This optional entry deliberately loads the Core's built public dist entries.
export default defineConfig({ test: { environment: "node", include: ["test/host/goal-host-core.test.mjs"],
  testTimeout: 30000, hookTimeout: 30000, pool: "forks", fileParallelism: false } });
