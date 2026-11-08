// Exercise the installed plugin in real DSH web processes with disposable data.
import assert from "node:assert/strict";
import { configureModel } from "../test/host/model-fixture.mjs";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const plugin = fileURLToPath(new URL("../", import.meta.url));
const root = await realpath(await mkdtemp("/tmp/dsh-go-"));
const home = join(root, "sa");
const socketPath = join(home, "run/core.sock");
const config = join(root, "npmrc");
const env = { ...process.env, DSH_HOME: join(root, "dsh"), SUPER_AGENT_HOME: home, SUPER_AGENT_SOCKET: socketPath,
  NPM_CONFIG_USERCONFIG: config, npm_config_userconfig: config, NPM_CONFIG_CACHE: join(root,"npm"), npm_config_cache: join(root,"npm") };
const processes = new Set();
let owner, launchEnv;

function core(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ method, socketPath, path, headers: { "X-Protocol-Version": "1", "X-Caller": "startup-check" } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200) throw Error(JSON.stringify(body));
          resolve(body);
        } catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(Error("Runtime request timed out")));
    req.end();
  });
}

async function web() {
  const child = spawn(env.DSH_BIN || "dsh", ["web","--no-open","--port","0"], {
    cwd: root, env: launchEnv, detached: true, stdio: ["ignore","pipe","pipe"],
  });
  processes.add(child);
  let output = "", spawnError;
  const collect = chunk => { output = (output + chunk).slice(-16_384); };
  child.on("error", err => { spawnError = err; });
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode) throw Error("DSH process exited before serving");
    const url = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):[1-9]\d*/)?.[0];
    if (url) return { child, url };
    await delay(100);
  }
  throw Error("DSH did not announce its local UI");
}

async function action(server, name, payload = {}) {
  const response = await fetch(server.url + "/super-agent/action", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: name, payload }), signal: AbortSignal.timeout(35_000) });
  const data = await response.json();
  assert.ok(response.ok && data.result, name + " " + JSON.stringify(data));
  return data.result;
}

async function close(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  const done = once(child, "exit");
  process.kill(-child.pid, "SIGTERM");
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
  try { await done; } finally { clearTimeout(timer); processes.delete(child); }
}

async function checkFirstScopedEvent(server, scope, after, expected, other) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const query = new URLSearchParams({ workspaceId: scope, after: String(after) });
    const response = await fetch(server.url + "/super-agent/events?" + query, { signal: controller.signal });
    assert.equal(response.status, 200);
    let text = "";
    for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString();
      let boundary;
      while ((boundary = text.indexOf("\n\n")) >= 0) {
        const frame = text.slice(0,boundary); text = text.slice(boundary+2);
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        assert.notEqual(event.threadId, other);
        if (event.threadId === expected) {
          assert.ok(event.seq > after && /^id: [A-Za-z0-9_-]+:\d+/m.test(frame));
          return;
        }
      }
    }
    throw Error("Workspace event channel closed without expected Thread");
  } finally { clearTimeout(timeout); controller.abort(); }
}

try {
  await writeFile(config, "registry=https://registry.npmjs.org/\nprefer-offline=true\n", {mode:0o600});
  const run = promisify(execFile);
  let archive = process.env.SUPER_AGENT_TEST_PACKAGE;
  if (!archive) {
    await run("npm",["pack","--pack-destination",root,"--silent"],{cwd:plugin,env,timeout:180_000});
    const name = (await readdir(root)).find(file => file.endsWith(".tgz"));
    assert.ok(name,"Missing npm package");
    archive = join(root,name);
  }
  await run("tar",["-xzf",resolve(archive),"-C",root]);
  const installed = join(root,"package"), shims = join(root,"without-go");
  await mkdir(shims);
  await writeFile(join(shims,"go"),'#!/bin/sh\ntouch "$SUPER_AGENT_GO_PROBE"\nexit 127\n',{mode:0o755});
  launchEnv = {...env,HOME:root,CODEX_HOME:join(root,"codex"),PATH:shims+delimiter+env.PATH,SUPER_AGENT_GO_PROBE:join(root,"go-called")};
  delete launchEnv.SUPER_AGENT_SOURCE_ROOT;
  delete launchEnv.SUPER_AGENT_RUNTIME_BINARY;
  await run(process.execPath,[join(installed,"install.mjs"),"--profile","web"],{cwd:installed,env:launchEnv,timeout:180_000});
  const [first, second] = await Promise.all([web(),web()]);
  const [one, two] = await Promise.all([action(first,"server.info"),action(second,"server.info")]);
  owner = one;
  assert.equal(owner.runtimeKind,"go");
  assert.equal(one.pid,two.pid);
  assert.equal(one.instanceId,two.instanceId);
  const roots = [join(root,"A"),join(root,"B")];
  await Promise.all(roots.map(dir => mkdir(dir)));
  const tabs = [first,second];
  const spaces = await Promise.all(tabs.map((tab,i) => action(tab,"workspace.register",{root:roots[i],requestId:"space-"+i})));
  assert.notEqual(spaces[0].workspaceId,spaces[1].workspaceId);
  const settings = {
    getSettings: () => action(first,"settings.get"),
    stageCredential: input => action(first,"credentials.stage",input),
    applySettings: input => action(first,"settings.apply",input),
    getOperation: operationId => action(first,"settings.operation",{operationId}),
  };
  await configureModel({settings},"http://127.0.0.1:1/v1","unused-startup-model");
  const snapshot = await core("/v1/events/snapshot");
  const threads = [];
  // Send B first. An unscoped replay on A would see B before its own Thread.
  for (const i of [1,0]) {
    threads[i] = await action(tabs[i],"thread.create",{agentId:"main",workspaceId:spaces[i].workspaceId,cwd:roots[i],requestId:"thread-"+i});
  }
  await checkFirstScopedEvent(first,spaces[0].workspaceId,snapshot.eventSeq,threads[0].threadId,threads[1].threadId);
  for (const i of [0,1]) {
    const scoped = await core("/v1/events/snapshot?workspaceId=" + encodeURIComponent(spaces[i].workspaceId));
    assert.deepEqual(scoped.threads.map(thread => thread.threadId),[threads[i].threadId]);
  }
  await Promise.all(tabs.map(tab => close(tab.child)));
  assert.equal((await core("/v1/server")).pid,owner.pid);
  const reopened = await web();
  assert.equal((await action(reopened,"server.info")).pid,owner.pid);
  assert.equal((await action(reopened,"workspace.find",{root:roots[1]})).workspaceId,spaces[1].workspaceId);
  await assert.rejects(access(launchEnv.SUPER_AGENT_GO_PROBE),{code:"ENOENT"});
  console.log("Two real DSH processes shared one Go PID and two isolated workspace event views. Reopened DSH reused the instance.");
} finally {
  await Promise.allSettled([...processes].map(close));
  const current = await core("/v1/server").catch(() => null);
  if (current && current.home === home && (!owner || current.instanceId === owner.instanceId)) {
    await core("/v1/server:shutdown","POST").catch(() => {});
    for (let i = 0; i < 40 && await core("/v1/server").catch(() => null); i++) await delay(100);
  }
  await rm(root,{recursive:true,force:true});
}
