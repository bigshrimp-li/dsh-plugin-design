import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTargetUrl, openTargetService } from "../../src/host/target-store.js";

const homes = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sa-targets-")); homes.push(home);
  let instance = "core-a", logoutFailure = false; const requests = [], connections = [];
  const service = await openTargetService({ options: { home, socketPath: `${home}/core.sock` },
    send: async (target, path, input) => { requests.push({ target, path, input });
      if (path === "/v1/auth/logout" && logoutFailure) throw new Error("offline");
      if (path === "/v1/identity") return { instanceId: instance, protocolVersion: 1 };
      if (path === "/v1/auth/pair") return { instanceId: instance, accessToken: "write-only-login-token", expiresAt: Date.now() + 10000 };
      return {};
    },
    createService: async ({ options }) => { connections.push(options); return { call: async () => ({ ok: true }), state: async () => ({ connection: "ready" }), subscribe: async function* () {}, observations: {} }; },
  });
  return { service, home, requests, connections, failLogout: () => { logoutFailure = true; }, changeInstance: value => { instance = value; } };
}
describe("host-owned Core targets", () => {
  it("rejects a subscription whose target changed before it could open", async () => {
    const f = await fixture(), previous = f.service.eventScope();
    const target = await f.service.call("targets.save", { name: "Other", baseUrl: "https://localhost:7443" });
    await f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator" });
    await f.service.call("targets.select", { targetId: target.id });
    await expect(f.service.subscribe({ expectedEventScope: previous }).next()).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(f.connections).toHaveLength(0);
  });
  it.each(["http://localhost:7443", "https://name:secret@core.test", "https://core.test?token=x", "https://core.test/api"])("rejects unsafe source address %s", value => expect(() => normalizeTargetUrl(value)).toThrow());
  it("stores login credentials in a private host file and never returns them to the renderer", async () => {
    const f = await fixture();
    const target = await f.service.call("targets.save", { name: "Local", baseUrl: "https://localhost:7443", ca: "TRUSTED CA" });
    const paired = await f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator" });
    expect(paired.authenticated).toBe(true);
    expect(JSON.stringify(await f.service.call("targets.list"))).not.toContain("write-only-login-token");
    expect(JSON.stringify(await f.service.call("targets.list"))).not.toContain("TRUSTED CA");
    expect((await stat(`${f.home}/dsh-targets.json`)).mode & 0o777).toBe(0o600);
    expect(await readFile(`${f.home}/dsh-targets.json`, "utf8")).toContain("write-only-login-token");
    await f.service.call("targets.select", { targetId: target.id }); await f.service.call("server.info", {});
    expect(f.connections.at(-1)).toMatchObject({ baseUrl: "https://localhost:7443", accessToken: "write-only-login-token", ca: "TRUSTED CA" });
    expect(await Promise.resolve(f.service.observations)).toBe(f.service.observations);
  });
  it("requires pairing after instance replacement, closes access and does not fall back to another target", async () => {
    const f = await fixture(), target = await f.service.call("targets.save", { baseUrl: "https://core.test" });
    await f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator" });
    await f.service.call("targets.select", { targetId: target.id });
    f.changeInstance("core-b");
    await expect(f.service.call("targets.test", { targetId: target.id })).rejects.toMatchObject({ code: "INSTANCE_CHANGED" });
    await expect(f.service.call("server.info", {})).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await f.service.call("targets.remove", { targetId: target.id });
    await expect(f.service.call("server.info", {})).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect(f.requests.some(request => /stop|shutdown/.test(request.path))).toBe(false);
  });
  it("keeps same-instance credentials when only its address changes and preserves the old entry for another instance", async () => {
    const f = await fixture(), target = await f.service.call("targets.save", { baseUrl: "https://old.test" });
    await f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator" });
    const moved = await f.service.call("targets.save", { targetId: target.id, baseUrl: "https://new.test" });
    expect(moved).toMatchObject({ id: target.id, authenticated: true });
    f.changeInstance("different-core");
    const different = await f.service.call("targets.save", { targetId: target.id, baseUrl: "https://different.test" });
    expect(different.id).not.toBe(target.id); expect(different.authenticated).toBe(false);
    expect((await f.service.call("targets.list")).targets).toHaveLength(2);
  });
});

it("clears the host token and closes selected access even when remote logout is unknown", async () => {
  const f = await fixture(), target = await f.service.call("targets.save", { baseUrl: "https://core.test" });
  await f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator" });
  await f.service.call("targets.select", { targetId: target.id }); f.failLogout();
  expect(await f.service.call("targets.logout", { targetId: target.id })).toMatchObject({ authenticated: false, remoteRevocation: "unknown" });
  expect(await readFile(`${f.home}/dsh-targets.json`, "utf8")).not.toContain("write-only-login-token");
  await expect(f.service.call("server.info", {})).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});

it("marks an expired login explicitly and refuses new calls until the target is paired again", async () => {
  const f = await fixture(), target = await f.service.call("targets.save", { baseUrl: "https://core.test" });
  await f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator" });
  await f.service.call("targets.select", { targetId: target.id });
  const expired = Date.now() + 20_000, clock = vi.spyOn(Date, "now").mockReturnValue(expired);
  try {
    expect((await f.service.call("targets.list")).targets[0]).toMatchObject({ authenticated: false, authenticationState: "expired" });
    await expect(f.service.call("server.info", {})).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("已过期") });
    await expect(f.service.call("targets.select", { targetId: target.id })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  } finally { clock.mockRestore(); }
});

it("preserves the old instance entry and requires explicit selection when pairing a replacement instance", async () => {
  const f = await fixture(), target = await f.service.call("targets.save", { baseUrl: "https://core.test" });
  await f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator" });
  await f.service.call("targets.select", { targetId: target.id }); f.changeInstance("replacement");
  await expect(f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator", expectedInstanceId: "core-a" })).rejects.toMatchObject({ code: "INSTANCE_CHANGED" });
  const replacement = await f.service.call("targets.pair", { targetId: target.id, pairingCode: "once", actorId: "operator" });
  expect(replacement).toMatchObject({ instanceId: "replacement", authenticated: true }); expect(replacement.id).not.toBe(target.id);
  const list = await f.service.call("targets.list"); expect(list.selectedId).toBe(target.id); expect(list.targets).toHaveLength(2);
  expect(list.targets.find(item => item.id === target.id)).toMatchObject({ instanceId: "core-a", authenticated: false });
});
