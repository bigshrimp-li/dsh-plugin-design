/**
 * Checks for `scripts/install-alc-profile.sh`.
 *
 * The script runs on a path a person takes before every browser check, so its
 * exit status is load-bearing: a non-zero exit reads as "the install failed"
 * even when every assertion passed. The harness and pnpm are stubbed here, so
 * the checks stay offline and never touch a real dsh home — the script is
 * given a temporary `DSH_HOME` and a `PATH` holding only the stubs and the
 * system directories.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = new URL("../../scripts/install-alc-profile.sh", import.meta.url).pathname;

/** A composed profile tree carrying the two rows the script asserts on. */
const COMPOSED = [
  "- id: super-agent-bridge",
  "  name: '@super-agent/dsh-bridge'",
  "- id: agent-loop",
  "  name: '@deepseek-ai/dsh-agent-loop'",
  "",
].join("\n");

/**
 * A `dsh` stand-in: it materializes the profile on `--from-default-profile` and
 * prints the composed tree on `--dump-config`, which is all the script reads.
 *
 * It also records every invocation, because the interesting property of the
 * argument handling is not what it prints but what it does *not* do: a run that
 * asks for help must not have reached the harness at all.
 */
function fakeDsh(dir, composed = COMPOSED) {
  const path = join(dir, "dsh");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_HOME/dsh-calls"
for arg in "$@"; do
  if [ "$arg" = "--from-default-profile" ]; then
    mkdir -p "$DSH_HOME/profiles/alc"
    printf '{"name":"alc"}\\n' > "$DSH_HOME/profiles/alc/package.json"
    exit 0
  fi
done
for arg in "$@"; do
  if [ "$arg" = "--dump-config" ]; then
    cat <<'COMPOSED_TREE'
${composed}COMPOSED_TREE
    exit 0
  fi
done
exit 0
`,
  );
  chmodSync(path, 0o755);
}

/** A stub for whichever tool the script reaches for. */
function stub(dir, name, body = "exit 0\n") {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

/**
 * Run the script against a temporary home and a `PATH` holding only the stubs.
 * @param options.withPnpm - whether a real `pnpm` is on the path. Without one
 *   the script borrows corepack's copy through a shim directory, which is the
 *   other arm of its cleanup.
 * @returns the child's status, stdout and stderr.
 */
function runInstall({ withPnpm, composed, home: givenHome, userHome, args = [], dropDshHome = false }) {
  const root = mkdtempSync(join(tmpdir(), "alc-install-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  fakeDsh(bin, composed);
  if (withPnpm) stub(bin, "pnpm");
  else stub(bin, "corepack", 'exec "$@"\n');

  const home = givenHome ?? join(root, "home");
  mkdirSync(home, { recursive: true });

  const env = {
    ...process.env,
    ...(userHome === undefined ? {} : { HOME: userHome }),
    PATH: `${bin}:/usr/bin:/bin`,
  };
  if (dropDshHome) delete env.DSH_HOME;
  else env.DSH_HOME = home;

  const result = spawnSync("/bin/bash", [SCRIPT, ...args], { encoding: "utf8", env });
  return {
    ...result,
    root,
    home,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    // The marker the `dsh` stand-in appends to: its absence is the proof that
    // a run never reached the harness.
    calls: existsSync(join(home, "dsh-calls")) ? readFileSync(join(home, "dsh-calls"), "utf8") : "",
  };
}

describe("install-alc-profile.sh", () => {
  it("exits 0 when pnpm is already on the path", () => {
    // The regression: the EXIT trap ended on `[ -n "$SHIM_DIR" ] && rm -rf ...`,
    // which is false — and so a failure status — whenever no shim was made, so
    // a fully successful install reported failure.
    const result = runInstall({ withPnpm: true });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("bridge row present");
    expect(result.stdout).toContain("built-in agent-loop is enabled");
    expect(result.status).toBe(0);
  });

  it("exits 0 when it has to borrow corepack's pnpm", () => {
    const result = runInstall({ withPnpm: false });

    expect(result.stdout).toContain("using corepack's pnpm via a temporary shim");
    expect(result.stdout).toContain("bridge row present");
    expect(result.stdout).toContain("built-in agent-loop is enabled");
    expect(result.status).toBe(0);
  });

  it("still fails when the composed profile is missing the bridge row", () => {
    // The assertions have to be able to fail: a script that always exits 0
    // would pass the two checks above without checking anything.
    const root = mkdtempSync(join(tmpdir(), "alc-install-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    stub(bin, "dsh", 'exit 0\n'); // never prints a tree
    stub(bin, "pnpm");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "profiles-alc-placeholder"), "");

    const result = spawnSync("/bin/bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bridge row MISSING");
  });

  it("creates the profile from the web template on first run", () => {
    const result = runInstall({ withPnpm: true });

    expect(result.stdout).toContain("creating profile 'alc' from the 'web' template");
    const manifest = JSON.parse(readFileSync(join(result.home, "profiles", "alc", "package.json"), "utf8"));
    expect(manifest.name).toBe("alc");
  });

  it("installs under the DSH_HOME it was given and never falls back to the user's own", () => {
    // The isolation AC05 asks for: with an explicit DSH_HOME the script must not
    // reach for `$HOME/.dsh` even when a home directory exists to reach for.
    const root = mkdtempSync(join(tmpdir(), "alc-install-"));
    const userHome = join(root, "user-home");
    mkdirSync(userHome);

    const result = runInstall({ withPnpm: true, userHome });

    expect(result.status).toBe(0);
    expect(existsSync(join(result.home, "profiles", "alc"))).toBe(true);
    expect(existsSync(join(userHome, ".dsh"))).toBe(false);
  });

  it("re-runs without rebuilding the profile it already made", () => {
    const first = runInstall({ withPnpm: true });
    expect(first.stdout).toContain("creating profile 'alc' from the 'web' template");

    const second = runInstall({ withPnpm: true, home: first.home });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("profile 'alc' already exists");
    expect(second.stdout).not.toContain("creating profile");
    expect(second.stdout).toContain("bridge row present");
    expect(second.stdout).toContain("built-in agent-loop is enabled");
  });

  it("fails when the composed profile disables the built-in loop", () => {
    const composed = COMPOSED.replace("  name: '@deepseek-ai/dsh-agent-loop'\n", "  name: '@deepseek-ai/dsh-agent-loop'\n  disabled: true\n");
    const result = runInstall({ withPnpm: true, composed });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("built-in agent-loop is missing or disabled");
  });

  it("fails when the composed profile is missing the built-in loop row", () => {
    const composed = COMPOSED.split("- id: agent-loop")[0];
    const result = runInstall({ withPnpm: true, composed });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("built-in agent-loop is missing or disabled");
  });
});

/**
 * Asking the script what it does must not be the same as telling it to do it.
 *
 * The install is not something a person can undo by hand — it links a working
 * tree into a profile and rewrites that profile's patch — so `--help` has to be
 * a read. The marker the `dsh` stand-in leaves behind is what makes "it did not
 * install" checkable rather than merely stated.
 */
describe("install-alc-profile.sh argument handling", () => {
  it("answers --help without touching anything", () => {
    const result = runInstall({ withPnpm: true, args: ["--help"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: DSH_HOME=");
    expect(result.stdout).toContain("--help");
    expect(result.stderr).toBe("");
    // Nothing was created and the harness was never asked to do anything.
    expect(existsSync(join(result.home, "profiles"))).toBe(false);
    expect(result.calls).toBe("");
  });

  it("answers -h the same way", () => {
    const result = runInstall({ withPnpm: true, args: ["-h"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: DSH_HOME=");
    expect(result.calls).toBe("");
  });

  it("refuses an argument it does not know, without installing", () => {
    const result = runInstall({ withPnpm: true, args: ["--force"] });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unrecognized argument "--force"');
    expect(result.stderr).toContain("usage: DSH_HOME=");
    expect(existsSync(join(result.home, "profiles"))).toBe(false);
    expect(result.calls).toBe("");
  });
});

/**
 * The isolation this script promises is a property of the file, not of the
 * caller's memory: it installs into a directory that was named, and refuses the
 * person's own `~/.dsh` even when that is what the environment points at. The
 * checks use a temporary `HOME`, so the "real home" they refuse is a temporary
 * directory that happens to be called `.dsh` — no check here reads or writes a
 * real one.
 */
describe("install-alc-profile.sh isolation", () => {
  it("refuses when DSH_HOME is not set at all", () => {
    const root = mkdtempSync(join(tmpdir(), "alc-install-"));
    const userHome = join(root, "user-home");
    mkdirSync(userHome);
    const result = runInstall({ withPnpm: true, userHome, dropDshHome: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DSH_HOME is required");
    expect(result.stderr).toContain("refusing to default to $HOME/.dsh");
    // The point of the refusal: the user's own home is untouched and empty.
    expect(existsSync(join(userHome, ".dsh"))).toBe(false);
  });

  it("refuses to install into $HOME/.dsh even when that is what DSH_HOME names", () => {
    const root = mkdtempSync(join(tmpdir(), "alc-install-"));
    const userHome = join(root, "user-home");
    const realLooking = join(userHome, ".dsh");
    mkdirSync(realLooking, { recursive: true });
    writeFileSync(join(realLooking, "keep-me"), "");

    const result = runInstall({ withPnpm: true, userHome, home: realLooking });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refusing to install into $HOME/.dsh");
    expect(existsSync(join(realLooking, "profiles"))).toBe(false);
    // Everything that was already there is still there.
    expect(existsSync(join(realLooking, "keep-me"))).toBe(true);
    expect(result.calls).toBe("");
  });

  it("refuses a relative DSH_HOME, which would resolve against whatever cwd it ran in", () => {
    const root = mkdtempSync(join(tmpdir(), "alc-install-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    fakeDsh(bin);
    stub(bin, "pnpm");
    const userHome = join(root, "user-home");
    mkdirSync(userHome);

    const result = spawnSync("/bin/bash", [SCRIPT], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, HOME: userHome, DSH_HOME: "relative-home", PATH: `${bin}:/usr/bin:/bin` },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DSH_HOME must be an absolute path");
    expect(existsSync(join(root, "relative-home"))).toBe(false);
  });
});
