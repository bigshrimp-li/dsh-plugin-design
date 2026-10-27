import { access, readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const source = process.env.SUPER_AGENT_SOURCE_ROOT;
if (!source || !path.isAbsolute(source)) throw new Error("Set SUPER_AGENT_SOURCE_ROOT to a built absolute agent-loop-core checkout");
const executable = process.env.DSH_ELECTRON || "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
const dshRoot = process.env.DSH_INSTALL_ROOT || path.resolve(path.dirname(executable), "../Resources/app.asar/dsh");
for (const target of [executable, path.join(source, "packages/server/dist/index.js"), path.join(source, "packages/client/dist/index.js"), process.env.SUPER_AGENT_GO_RUNTIME_BINARY || path.join(source, "go-runtime/bin/runtime-worker")]) await access(target);
const env = { ...process.env, SUPER_AGENT_SOURCE_ROOT: source, DSH_ELECTRON: executable, DSH_INSTALL_ROOT: dshRoot, ELECTRON_RUN_AS_NODE: "1" };
execFileSync(executable, ["--input-type=module", "-e", `
  import fs from 'node:fs';
  import { createRequire } from 'node:module';
  const root = process.env.DSH_INSTALL_ROOT;
  const require = createRequire(root + '/package.json');
  for (const name of ['dsh-session', 'dsh-scope', 'dsh-agent']) require.resolve('@deepseek-ai/' + name);
  console.log('Actual DSH Host:', JSON.parse(fs.readFileSync(root + '/package.json')).version, 'Electron:', process.versions.electron);
`], { env, stdio: "inherit" });
const require = createRequire(import.meta.url), manifestPath = require.resolve("vitest/package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const cli = path.resolve(path.dirname(manifestPath), typeof manifest.bin === "string" ? manifest.bin : manifest.bin.vitest);
const result = spawnSync(executable, ["--expose-internals", cli, "run", "--config", "vitest.goal-host-core.config.mjs"], { env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
