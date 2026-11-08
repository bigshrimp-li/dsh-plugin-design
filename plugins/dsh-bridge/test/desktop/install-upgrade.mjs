// Acceptance for the real macOS installers, Desktop plugin loader and persistent renderer profile.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { withHiddenDesktop } from "./hidden-desktop.mjs";

const run = promisify(execFile);
const { values } = parseArgs({ options: {
  "previous-app": { type: "string" }, "current-app": { type: "string", default: "/Applications/DeepSeek Harness.app" },
  "legacy-archive": { type: "string" }, "core-source": { type: "string" }, report: { type: "string" },
} });
const coreSource = values["core-source"] || process.env.SUPER_AGENT_SOURCE_ROOT;
assert(values["previous-app"] && values["legacy-archive"] && coreSource,
  "Required: --previous-app '/path/to/rc.3/DeepSeek Harness.app' --legacy-archive /path/to/0.1.2.tgz --core-source /path/to/built/agent-loop-core");
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const oldArchive = await realpath(values["legacy-archive"]);
// Darwin limits Unix socket paths to 104 bytes. Use its short private temporary directory.
const temp = await realpath(await mkdtemp("/private/tmp/dsh-install-upgrade-"));
const pkg = "@super-agent/dsh-bridge", profileName = "desktop";
const coreDir = join(temp, "go-fixture");
const socket = join(coreDir, "core/run/core.sock");
const report = { nativePresentation: { verifiedHiddenProcesses: 0, visibleWindows: 0, focusTransitions: 0 }, startedAt: new Date().toISOString(), status: "running", versions: {}, archives: {}, checks: [] };
function passed(description) {
  console.log("PASS " + description);
  report.checks.push({ status: "passed", description });
}

function desktop(app) {
  return { executable: join(app, "Contents/MacOS/DeepSeek Harness"), cli: join(app, "Contents/Resources/runtime/cli/bin/dsh"),
    manifest: join(app, "Contents/Info.plist") };
}
const oldSource = resolve(values["previous-app"]), newSource = resolve(values["current-app"]);
async function privateDesktop(source, label) {
  const app = join(temp, label + ".app");
  // APFS clones preserve the signed distribution and isolate even the desktop updater's target.
  await run("cp", ["-cRp", source, app], { timeout: 90000 });
  return desktop(app);
}
const version = async host => (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", host.manifest])).stdout.trim();
async function startCore() {
  const fixtureHome = join(coreDir, "user");
  await mkdir(fixtureHome, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [join(plugin, "test/desktop/release-core.mjs"), coreDir], {
    cwd: coreDir, env: { PATH: process.env.PATH, HOME: fixtureHome, SUPER_AGENT_SOURCE_ROOT: resolve(coreSource) },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = chunk => { output = (output + String(chunk)).slice(-1500); };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  const exited = once(child, "exit");
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const drained = await Promise.race([exited.then(() => true), delay(8000, false, { ref: false })]);
    if (!drained) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await exited;
    }
  };
  try {
    for (let step = 0; step < 400; step++) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error("Dedicated Go fixture exited: " + output);
      if ((await stat(socket).catch(() => null))?.isSocket()) return stop;
      await delay(100);
    }
    throw Error("Dedicated Go fixture did not publish a socket: " + output);
  } catch (error) { await stop(); throw error; }
}
async function makeProfile(name) {
  const base = join(temp, name), home = join(base, "home"), dsh = join(base, "dsh"), chromiumHome = join(base, "chromium");
  const core = join(coreDir, "core"), scratch = join(base, "tmp");
  await Promise.all([home, dsh, chromiumHome, core, scratch].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
  const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: dsh, TMPDIR: scratch,
    SUPER_AGENT_HOME: core, SUPER_AGENT_SOCKET: socket, DEEPSEEK_API_KEY: "synthetic-install-test",
    DSH_DESKTOP_OPEN_DEVTOOLS: "0", npm_config_registry: "https://registry.npmjs.org" };
  return { base, dsh, chromiumHome, env };
}
async function cli(host, profile, args) {
  return run(host.cli, args, { env: profile.env, cwd: profile.base, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
}
async function initialize(host, p) {
  // "desktop" is owned by the native executable. Let its real first run create the profile.
  await inspect(host, p, async page => {
    await page.getByRole("button", { name: "插件", exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.locator("[data-super-agent-workspaces]").count(), 0);
  });
}
const add = (host, p, archive) => cli(host, p, ["plugin", "--profile", profileName, "add", archive, "--ignore-scripts"]);
async function installed(p) {
  return JSON.parse(await readFile(join(p.dsh, "profiles", profileName, "node_modules", pkg, "package.json"), "utf8"));
}
async function inspect(host, p, callback) {
  const result = await withHiddenDesktop({ ...p, executable: host.executable, cwd: p.base }, callback);
  report.nativePresentation.verifiedHiddenProcesses++;
  return result;
}
async function verifyWorkspace(page) {
  await page.locator("[data-super-agent-workspaces]").waitFor({ timeout: 30000 });
  const view = await page.evaluate(async () => (await fetch("/super-agent/state")).json());
  assert.equal(view.connection, "ready");
  assert.equal(view.info?.runtimeFeatures?.goalsV1, true, "expected Go Core from the explicit test socket");
}
async function bridge(page, action, payload) {
  return page.evaluate(async ({ action, payload }) => {
    const res = await fetch("/super-agent/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
    const body = await res.json();
    if (!res.ok) throw Error(action + ": " + (body.error?.message || res.status));
    return body.result;
  }, { action, payload });
}
const storageKey = "super-agent.space.v1";
const readStore = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const draft = "升级前的未发送草稿 " + randomUUID(), title = "升级验收 " + randomUUID();
async function cleanReply(page) {
  await verifyWorkspace(page);
  assert.equal((await readStore(page))?.selected || null, null);
  const models = await bridge(page, "models.list", {});
  const model = (Array.isArray(models) ? models : models.items).find(item => item.selectable !== false);
  assert(model, "dedicated Go fixture has no selectable model");
  await page.getByRole("button", { name: "Super Agent", exact: true }).click();
  await page.getByRole("button", { name: "Super Agent 模型", exact: true }).click();
  await page.getByRole("menu").getByText(model.name || model.id, { exact: true }).click();
  const input = "请完成新安装回归检查 " + randomUUID();
  await page.getByRole("textbox", { name: "Super Agent 消息" }).fill(input);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const reply = page.locator('article[data-role="assistant"]').filter({ hasText: "此轮检查完成。" }).last();
  await reply.waitFor({ timeout: 45000 });
  const runId = await reply.evaluate(el => el.closest("[data-run-id]").dataset.runId);
  const selected = (await readStore(page)).selected;
  assert(selected && runId && runId !== "unattributed");
  const group = page.locator("[data-run-id]").filter({ has: reply });
  assert((await group.innerText()).includes(input), "the displayed final answer belongs to a different input");
  await page.waitForFunction(async id => {
    const response = await fetch("/super-agent/action", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run.get", payload: { runId: id } }) });
    return response.ok && (await response.json()).result?.status === "completed";
  }, runId, { timeout: 15000, polling: 200 });
  const run = await bridge(page, "run.get", { runId });
  assert.equal(run.conversationId, selected.conversationId);
  const history = await bridge(page, "messages.list", { conversationId: selected.conversationId, limit: 50 });
  const committed = history.items.find(message => message.runId === runId && message.role === "assistant" && message.text?.includes("此轮检查完成。"));
  assert(committed, "Go must persist the same assistant answer shown on the native surface");
  report.cleanReply = { model: model.id, threadId: selected.threadId, conversationId: selected.conversationId, runId,
    userMessage: input, persistedMessageId: committed.messageId, visibleReply: (await reply.innerText()).split("\n")[0], status: run.status };
}
async function writeOldState(page) {
  await verifyWorkspace(page);
  const models = await bridge(page, "models.list", {});
  const model = (Array.isArray(models) ? models : models.items).find(item => item.selectable !== false);
  assert(model, "fixture must offer a selectable model");
  const created = await bridge(page, "thread.create", { requestId: randomUUID(), agentId: "super-agent", modelId: model.id });
  const thread = await bridge(page, "thread.get", { threadId: created.threadId });
  await bridge(page, "thread.metadata", { threadId: thread.threadId, expectedControlRevision: thread.controlRevision, requestId: randomUUID(), title });
  await page.getByRole("button", { name: title, exact: true }).click({ timeout: 15000 });
  await page.getByRole("textbox", { name: "Super Agent 消息" }).fill(draft);
  await page.waitForFunction(({ key, draft, id }) => {
    const state = JSON.parse(localStorage.getItem(key));
    return state?.draft === draft && state?.selected?.threadId === id;
  }, { key: storageKey, draft, id: created.threadId });
  const saved = await readStore(page);
  assert.equal(saved.drafts[saved.selected.conversationId], draft);
  return saved.selected;
}
async function verifyRestored(page, selection) {
  await verifyWorkspace(page);
  const store = await readStore(page);
  assert.deepEqual(store.selected, selection);
  assert.equal(store.drafts[selection.conversationId], draft);
  await page.getByRole("button", { name: title, exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Super Agent 消息" }).inputValue(), draft);
  assert.equal((await bridge(page, "thread.get", { threadId: selection.threadId })).title, title);
}

let stopCore;
try {
  stopCore = await startCore();
  const [oldHost, newHost] = await Promise.all([privateDesktop(oldSource, "Previous"), privateDesktop(newSource, "Current")]);
  assert.equal(await version(oldHost), "0.2.1-rc.3"); assert.equal(await version(newHost), "0.2.1-rc.5");
  const legacy = JSON.parse((await run("tar", ["-xOzf", oldArchive, "package/package.json"])).stdout);
  assert.equal(legacy.name, pkg); assert.equal(legacy.version, "0.1.2");
  report.versions = { previousHost: "0.2.1-rc.3", currentHost: "0.2.1-rc.5", previousPlugin: legacy.version };
  const buildEnv = { ...process.env, SUPER_AGENT_SOURCE_ROOT: resolve(coreSource) };
  await run("npm", ["run", "prepack"], { cwd: plugin, env: buildEnv });
  const pack = JSON.parse((await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: plugin, env: buildEnv })).stdout)[0];
  const candidate = join(temp, pack.filename);
  assert.equal(pack.name, pkg); assert.notEqual(pack.version, legacy.version);
  report.versions.candidatePlugin = pack.version;
  for (const [name, archive] of [["previous", oldArchive], ["candidate", candidate]]) {
    report.archives[name] = createHash("sha256").update(await readFile(archive)).digest("hex");
    console.log(`${name} SHA-256 ${report.archives[name]}`);
  }
  const fresh = await makeProfile("fresh");
  await initialize(newHost, fresh);
  const config = join(fresh.dsh, "profiles", profileName, "package.json");
  const before = JSON.parse(await readFile(config));
  const lock = join(fresh.dsh, "profiles", profileName, "pnpm-lock.yaml");
  const readLock = async () => {
    try { return await readFile(lock, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const previousLock = await readLock();
  await assert.rejects(add(newHost, fresh, oldArchive), err => {
    assert.match(err.stdout + err.stderr, /0\.1\.2 is incompatible with dsh 0\.2\.1-rc\.5/);
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(config)), before);
  assert.equal(await readLock(), previousLock);
  await assert.rejects(installed(fresh), { code: "ENOENT" });
  passed("rc.5 official installer rejects 0.1.2 and rolls back");
  await add(newHost, fresh, candidate); assert.equal((await installed(fresh)).version, pack.version);
  await inspect(newHost, fresh, cleanReply);
  passed("clean rc.5 Desktop selects a model, sends through Go, displays the committed reply and reads the completed Run");

  const upgraded = await makeProfile("upgrade");
  await initialize(oldHost, upgraded); await add(oldHost, upgraded, oldArchive);
  assert.equal((await installed(upgraded)).version, legacy.version);
  const upgradedProfile = join(upgraded.dsh, "profiles", profileName);
  const profileBefore = JSON.parse(await readFile(join(upgradedProfile, "package.json"))).dsh.profile;
  const selected = await inspect(oldHost, upgraded, writeOldState);
  assert(selected?.threadId && selected.conversationId);
  passed("rc.3 Desktop runs 0.1.2; a real Thread, Conversation and user draft were saved");
  await inspect(newHost, upgraded, async page => {
    await page.getByRole("button", { name: "插件", exact: true }).click({ timeout: 20000 });
    await page.getByText(pkg, { exact: true }).first().waitFor();
    assert.match(await page.locator("body").innerText(), /@super-agent\/dsh-bridge\s+(异常|Error|Failed)/iu);
    assert.equal(await page.locator("[data-super-agent-workspaces]").count(), 0);
    const state = await page.evaluate(async () => {
      const res = await fetch("/super-agent/state"); const text = await res.text();
      try { return { code: res.status, connected: JSON.parse(text).connection }; } catch { return { code: res.status }; }
    });
    assert.notEqual(state.connected, "ready", "the incompatible plugin registered active Go routes");
    assert.equal((await readStore(page)).draft, draft);
  });
  passed("same profile on rc.5 omits incompatible 0.1.2 UI/routes and retains old draft");
  // rc.5 may add its own defaults when it migrates an rc.3 Desktop profile.
  // Compare the user overrides immediately before and after the plugin install.
  const overridesBefore = await readFile(join(upgradedProfile, "cordis.patch.yml"), "utf8");
  await add(newHost, upgraded, candidate);
  assert.equal((await installed(upgraded)).version, pack.version);
  assert.deepEqual(JSON.parse(await readFile(join(upgradedProfile, "package.json"))).dsh.profile, profileBefore);
  assert.equal(await readFile(join(upgradedProfile, "cordis.patch.yml"), "utf8"), overridesBefore);
  await inspect(newHost, upgraded, page => verifyRestored(page, selected));
  passed("rc.5 native upgrade preserves the original Thread, Conversation and unsent draft");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  await stopCore?.();
  await rm(temp, { recursive: true, force: true });
  if (values.report) {
    report.completedAt = new Date().toISOString();
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
}
