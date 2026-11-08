// Snapshot only the published SDK/protocol sources used in the Host build.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.env.SUPER_AGENT_SOURCE_ROOT;
if (!source || !isAbsolute(source)) throw new Error("SUPER_AGENT_SOURCE_ROOT must identify the upstream checkout");
const plugin = fileURLToPath(new URL("../", import.meta.url));
const record = { formatVersion: 1, repository: "agent-loop-core",
  baseCommit: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), packages: {} };
for (const name of ["client", "protocol"]) {
  const from = join(source, "packages", name), into = join(plugin, "upstream", name);
  await mkdir(join(into, "src"), { recursive:true });
  const files = {};
  const entries = await readdir(join(from, "src"), { withFileTypes:true });
  const names = entries.filter(entry => entry.isFile() && entry.name.endsWith(".ts")).map(entry => "src/" + entry.name);
  for (const relative of ["package.json", ...names.sort()]) {
    const bytes = await readFile(join(from, relative));
    files[relative] = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(into, relative), bytes);
  }
  record.packages[name] = files;
}
await writeFile(join(plugin, "provenance/sdk-local-runtime.json"), JSON.stringify(record, null, 2) + "\n");
