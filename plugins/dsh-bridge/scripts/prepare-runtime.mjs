// Build-time only. Desktop startup uses the immutable executable from the installed package.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";

const target = `${process.platform}-${process.arch}`;
if (!["darwin","linux"].includes(process.platform)) throw new Error(`UDS Runtime is not available for ${target}`);
const output = fileURLToPath(new URL(`../dist/runtime/${target}/`, import.meta.url));
const manifestPath = join(output, "manifest.json");
const source = process.env.SUPER_AGENT_SOURCE_ROOT;
const supplied = process.env.SUPER_AGENT_RUNTIME_BINARY;
if ((source && !isAbsolute(source)) || (supplied && !isAbsolute(supplied))) throw new Error("Runtime source and executable paths must be absolute");

async function verifyPackaged() {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.protocolVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch ||
        !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Invalid bundled Runtime manifest");
    const binary = await readFile(join(output, manifest.sha256, "super-agent-runtime"));
    if (createHash("sha256").update(binary).digest("hex") !== manifest.sha256) throw new Error("Invalid bundled Runtime checksum");
    return true;
  } catch(error) { if(error.code === "ENOENT") return false; throw error; }
}

const checkout = source || fileURLToPath(new URL("../../../../agent-loop-core/", import.meta.url));
if (!source && !supplied && await verifyPackaged()) {
  console.log(`Verified bundled Go Runtime for ${target}`);
} else {
  await mkdir(output, { recursive:true });
  const temp = join(output, ".stage-" + randomUUID());
  await mkdir(temp);
  try {
    const exe = join(temp, "super-agent-runtime");
    if (supplied) await copyFile(supplied, exe);
    else execFileSync("go", ["build", "-trimpath", "-o", exe, "./cmd/super-agent-runtime"],
      { cwd: join(checkout, "go-runtime"), stdio:"inherit", env: { ...process.env, CGO_ENABLED: "1" } });
    const sha256 = createHash("sha256").update(await readFile(exe)).digest("hex");
    await chmod(exe, 0o755);
    const dest = join(output, sha256);
    try { await rename(temp, dest); }
    catch(error) { if (!["ENOTEMPTY","EEXIST"].includes(error.code)) throw error; }
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const manifest = { platform:process.platform, arch:process.arch, pluginVersion:version, protocolVersion:1, sha256 };
    const next = join(output, ".manifest-" + randomUUID());
    await writeFile(next, JSON.stringify(manifest, null, 2) + "\n");
    await rename(next, manifestPath);
    // A checkout may hold older immutable images used by an active Host. npm packs only the current one.
    const ignore = join(output, ".pack-rules-" + randomUUID());
    await writeFile(ignore, "*\n!manifest.json\n!" + sha256 + "/\n!" + sha256 + "/super-agent-runtime\n");
    await rename(ignore, join(output, ".npmignore"));
    await verifyPackaged();
    console.log(`Bundled Go Runtime for ${target} (${sha256})`);
  } finally { await rm(temp, { recursive:true, force:true }); }
}
