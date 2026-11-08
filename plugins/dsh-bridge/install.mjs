#!/usr/bin/env node
// Install an extracted platform release using only Node and the installed DSH CLI.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: { profile } } = parseArgs({ options:{ profile:{type:"string",default:"desktop"} } });
if (!/^[a-zA-Z0-9][\w.-]*$/.test(profile)) throw Error("请输入有效的 DSH profile 名称");
const directory = fileURLToPath(new URL("./",import.meta.url));
const runtime = join(directory,"dist/runtime",process.platform+"-"+process.arch);
const manifest = JSON.parse(await readFile(join(runtime,"manifest.json"),"utf8"));
const descriptor = JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.protocolVersion !== 1 ||
    manifest.pluginVersion !== descriptor.version || !/^[0-9a-f]{64}$/.test(manifest.sha256)) throw Error("本机平台或运行时清单不匹配");
const binary = join(runtime,manifest.sha256,"super-agent-runtime"), hash = createHash("sha256");
for await (const block of createReadStream(binary)) hash.update(block);
if (hash.digest("hex") !== manifest.sha256) throw Error("运行时二进制校验失败");
await chmod(binary,0o755);
for (const file of ["dist/host/index.js","src/client/index.js","cordis.patch.yml"]) await access(join(directory,file));

const dshHome = resolve(process.env.DSH_HOME || join(homedir(),".dsh"));
const profileDir = join(dshHome,"profiles",profile);
const backups = join(dshHome,"plugin-backups");
await mkdir(backups,{recursive:true,mode:0o700});
const backup = await mkdtemp(join(backups,"super-agent-"));
const files = ["package.json","pnpm-lock.yaml","cordis.patch.yml","cordis.yml","pnpm-workspace.yaml"];
const present = [];
for (const file of files) {
  try { await copyFile(join(profileDir,file),join(backup,file)); present.push(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
await writeFile(join(backup,"receipt.json"),JSON.stringify({profile,plugins:["dsh-bridge"],present})+"\n",{mode:0o600});
try {
  execFileSync(process.env.DSH_BIN || "dsh",["plugin","--profile",profile,"add",directory],{stdio:"inherit"});
  const target = join(profileDir,"package.json"), data = JSON.parse(await readFile(target,"utf8"));
  data.dsh ??= {}; data.dsh.profile ??= {};
  data.dsh.profile.bundles = [...new Set([...(data.dsh.profile.bundles || []),descriptor.name])];
  const next = join(profileDir,".dsh-bundle-"+randomUUID());
  await writeFile(next,JSON.stringify(data,null,2)+"\n");
  await rename(next,target);
} catch(error) {
  await mkdir(profileDir,{recursive:true});
  for (const file of files) {
    if (present.includes(file)) await copyFile(join(backup,file),join(profileDir,file));
    else await rm(join(profileDir,file),{force:true});
  }
  throw error;
}
console.log("已安装 Super Agent。重新打开 DSH 后将自动连接本机 Go Runtime。配置备份位于 " + backup);
