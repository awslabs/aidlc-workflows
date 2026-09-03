// t331: the preview release channel on the consumer side. `aidlc config
// --channel` persists the machine channel beside the update cache and pin
// registry; `aidlc update` follows it (or a one-shot `--channel`), resolving the
// newest published preview through the releases-list API and installing it
// through the explicit-version path; `update --check` reports "behind" against
// the channel's newest release with the documented exit codes; API failure is
// "unavailable", never a crash and never a fall back to stable; switching back
// to stable converges on the newest stable even though it sorts lower; and
// previews prune harder than stable releases.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PREVIEW_CHANNEL, STABLE_CHANNEL } from "../../core/tools/aidlc-channel.ts";
import { resolvePinnedDispatch } from "../../core/tools/aidlc-lifecycle.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  type FixtureRelease,
  type ReleaseServerFault,
  serveReleaseFixture,
  writeReleaseFixture,
} from "../harness/release-fixture.ts";

const REPO_ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const LIFECYCLE = join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts");

const [MAJOR, MINOR, PATCH] = AIDLC_VERSION.split(".").map(Number);
const NEXT_STABLE = `${MAJOR}.${MINOR}.${PATCH + 1}`;
const PREVIEW_0 = `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260902.1`;
const PREVIEW_1 = `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.1`;
const PREVIEW_2 = `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.2`;
const PREVIEW_3 = `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260904.1`;
const DRAFT_PREVIEW = `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260905.1`;

const temporary: string[] = [];
const servers: Array<{ stop(): void }> = [];
const originalPath = process.env.PATH;

beforeAll(() => {
  process.env.PATH = `${join(REPO_ROOT, "tests", "fixtures", "bin")}${delimiter}${
    originalPath ?? ""
  }`;
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const server of servers.splice(0)) server.stop();
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function fixture(version: string): string {
  const root = temp("aidlc-t331-release-");
  writeReleaseFixture({
    root,
    repoRoot: REPO_ROOT,
    version,
    distributions: ["claude"],
  });
  return root;
}

function serve(
  root: string,
  releases: readonly FixtureRelease[],
  fault: ReleaseServerFault = { kind: "none" },
): { baseUrl: string; apiUrl: string; requests: string[]; stop(): void } {
  const server = serveReleaseFixture(root, fault, releases);
  servers.push(server);
  return server;
}

// Async on purpose: the release fixture server runs in this process, and a
// blocking spawnSync would starve it while the child waits for a response.
async function run(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, tool, ...args], {
    cwd,
    env: { ...process.env, NO_PROXY: "127.0.0.1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

function machineEnv(): { machine: string; project: string; env: NodeJS.ProcessEnv } {
  const machine = temp("aidlc-t331-machine-");
  const project = temp("aidlc-t331-project-");
  mkdirSync(join(project, ".git"));
  return {
    machine,
    project,
    env: { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin") },
  };
}

function retained(machine: string): string[] {
  const root = join(machine, "versions");
  return existsSync(root) ? readdirSync(root).sort() : [];
}

describe("t331 preview release channel", () => {
  test("config --channel persists the machine channel beside the update cache and pins", async () => {
    const { machine, project, env } = machineEnv();
    const shown = await run(DISPATCHER, ["config", "--channel", "--json"], project, env);
    expect(shown.status, shown.stdout + shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout).data).toEqual({ channel: STABLE_CHANNEL, source: "default" });
    expect(existsSync(join(machine, "channel"))).toBe(false);

    const set = await run(DISPATCHER, ["config", "--channel", PREVIEW_CHANNEL, "--json"], project, env);
    expect(set.status, set.stdout + set.stderr).toBe(0);
    expect(JSON.parse(set.stdout).data).toEqual({ channel: PREVIEW_CHANNEL, source: "machine" });
    expect(readFileSync(join(machine, "channel"), "utf-8")).toBe(`${PREVIEW_CHANNEL}\n`);

    const reread = await run(DISPATCHER, ["config", "--channel"], project, env);
    expect(reread.status).toBe(0);
    expect(reread.stdout).toContain(`release channel: ${PREVIEW_CHANNEL}`);

    const invalid = await run(DISPATCHER, ["config", "--channel", "nightly"], project, env);
    expect(invalid.status).toBe(2);
    expect(invalid.stdout + invalid.stderr).toContain("--channel must be stable or preview");
    expect(readFileSync(join(machine, "channel"), "utf-8")).toBe(`${PREVIEW_CHANNEL}\n`);

    const mixed = await run(DISPATCHER, ["config", "--channel", "stable", "--pin", NEXT_STABLE], project, env);
    expect(mixed.status).toBe(2);
    expect(mixed.stdout + mixed.stderr).toContain("--channel cannot be combined with --pin or --unpin");

    const back = await run(DISPATCHER, ["config", "--channel", STABLE_CHANNEL, "--quiet"], project, env);
    expect(back.status, back.stdout + back.stderr).toBe(0);
    expect(readFileSync(join(machine, "channel"), "utf-8")).toBe(`${STABLE_CHANNEL}\n`);

    writeFileSync(join(machine, "channel"), "beta\n");
    const malformed = await run(LIFECYCLE, ["update", "--check", "--json"], project, env);
    expect(malformed.status).toBe(4);
    expect(malformed.stdout).toContain("must contain one release channel");
  }, 60_000);

  test("update --check follows the channel, ignores drafts and stable, and treats API failure as unavailable", async () => {
    const release = fixture(PREVIEW_2);
    const listed: FixtureRelease[] = [
      { tag_name: `v${DRAFT_PREVIEW}`, prerelease: true, draft: true },
      { tag_name: `v${NEXT_STABLE}`, prerelease: false },
      { tag_name: `v${PREVIEW_1}`, prerelease: true },
      { tag_name: `v${PREVIEW_2}`, prerelease: true },
      { tag_name: "v9.9.9-rc.1", prerelease: true },
    ];
    const server = serve(release, listed);
    const { machine, project, env } = machineEnv();
    const base = ["--release-base-url", server.baseUrl, "--release-api-url", server.apiUrl];

    const behind = await run(DISPATCHER, ["update", "--check", "--channel", PREVIEW_CHANNEL, ...base, "--json"], project, env);
    expect(behind.status, behind.stdout + behind.stderr).toBe(5);
    const state = JSON.parse(behind.stdout);
    expect(state.data.state).toBe("behind");
    expect(state.data.channel).toBe(PREVIEW_CHANNEL);
    expect(state.data.latestVersion).toBe(PREVIEW_2);
    expect(state.message).toContain(`${PREVIEW_CHANNEL} channel newest ${PREVIEW_2}`);
    expect(server.requests).toContain("/api/releases");
    expect(server.requests.some((path) => path.includes("/latest/download/"))).toBe(false);
    expect(server.requests).toContain(`/download/v${PREVIEW_2}/version.json`);
    const cache = JSON.parse(readFileSync(join(machine, "update-check.json"), "utf-8"));
    expect(cache.channel).toBe(PREVIEW_CHANNEL);
    expect(cache.latestVersion).toBe(PREVIEW_2);

    // The persisted channel is what a bare --check follows.
    expect((await run(DISPATCHER, ["config", "--channel", PREVIEW_CHANNEL], project, env)).status).toBe(0);
    const persisted = await run(DISPATCHER, ["update", "--check", ...base, "--json"], project, env);
    expect(persisted.status).toBe(5);
    expect(JSON.parse(persisted.stdout).data.latestVersion).toBe(PREVIEW_2);

    // Rate limiting or an outage is exit 3 with the valid cache left in place;
    // stable's latest/download is never consulted as a fallback.
    const failing = serve(release, listed, { kind: "api-failure", status: 403 });
    const before = readFileSync(join(machine, "update-check.json"), "utf-8");
    const unavailable = await run(DISPATCHER, [
      "update", "--check", "--release-base-url", failing.baseUrl, "--release-api-url", failing.apiUrl, "--json",
    ], project, env);
    expect(unavailable.status, unavailable.stdout + unavailable.stderr).toBe(3);
    expect(JSON.parse(unavailable.stdout).message).toContain("cached version");
    expect(readFileSync(join(machine, "update-check.json"), "utf-8")).toBe(before);
    expect(failing.requests.some((path) => path.includes("/latest/download/"))).toBe(false);

    // A channel with no published preview is unavailable too.
    const empty = serve(release, [{ tag_name: `v${NEXT_STABLE}`, prerelease: false }]);
    rmSync(join(machine, "update-check.json"));
    const none = await run(DISPATCHER, [
      "update", "--check", "--release-base-url", empty.baseUrl, "--release-api-url", empty.apiUrl, "--json",
    ], project, env);
    expect(none.status).toBe(3);
    expect(JSON.parse(none.stdout).message).toContain(`no ${PREVIEW_CHANNEL} release is published`);

    // A non-github.com base URL without an explicit API URL cannot be derived.
    const derived = await run(DISPATCHER, [
      "update", "--check", "--release-base-url", server.baseUrl, "--json",
    ], project, env);
    expect(derived.status).toBe(3);
    expect(JSON.parse(derived.stdout).message).toContain("--release-api-url");

    // Grammar: the channel value is closed and cannot combine with an exact version.
    const bad = await run(DISPATCHER, ["update", "--channel", "nightly"], project, env);
    expect(bad.status).toBe(2);
    expect(bad.stdout + bad.stderr).toContain("--channel must be stable or preview");
    const both = await run(DISPATCHER, ["update", "--channel", PREVIEW_CHANNEL, "--version", PREVIEW_2], project, env);
    expect(both.status).toBe(2);
    expect(both.stdout + both.stderr).toContain("--channel cannot be combined with --version");
  }, 120_000);

  test("update installs the newest preview, then switching back converges on the lower stable id", async () => {
    if (process.platform === "win32") return;
    const previewRelease = fixture(PREVIEW_2);
    const preview = serve(previewRelease, [
      { tag_name: `v${PREVIEW_1}`, prerelease: true },
      { tag_name: `v${PREVIEW_2}`, prerelease: true },
    ]);
    const stableRelease = fixture(AIDLC_VERSION);
    const stable = serve(stableRelease, []);
    const { machine, project, env } = machineEnv();

    const installed = await run(LIFECYCLE, [
      "update", "--channel", PREVIEW_CHANNEL,
      "--release-base-url", preview.baseUrl, "--release-api-url", preview.apiUrl, "--json",
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const installedData = JSON.parse(installed.stdout).data;
    expect(installedData.version).toBe(PREVIEW_2);
    expect(installedData.channel).toBe(PREVIEW_CHANNEL);
    expect(installedData.channelSwitch).toBeUndefined();
    expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(PREVIEW_2);
    expect(preview.requests).toContain(`/download/v${PREVIEW_2}/aidlc-runtime.tar.gz`);

    const noop = await run(LIFECYCLE, [
      "update", "--channel", PREVIEW_CHANNEL,
      "--release-base-url", preview.baseUrl, "--release-api-url", preview.apiUrl,
    ], project, env);
    expect(noop.status, noop.stdout + noop.stderr).toBe(0);
    expect(noop.stdout).toContain(`You're on the latest ${PREVIEW_CHANNEL} version of aidlc (${PREVIEW_2}).`);

    // Back to stable: a lower id, reported as a channel switch.
    expect((await run(DISPATCHER, ["config", "--channel", STABLE_CHANNEL], project, env)).status).toBe(0);
    const switched = await run(LIFECYCLE, ["update", "--release-base-url", stable.baseUrl], project, env);
    expect(switched.status, switched.stdout + switched.stderr).toBe(0);
    expect(switched.stdout).toContain(`Checking for releases ... ${PREVIEW_2} -> ${AIDLC_VERSION}`);
    expect(switched.stdout).toContain(
      `Switched release channel from ${PREVIEW_CHANNEL} to ${STABLE_CHANNEL}.`,
    );
    expect(switched.stdout).toContain(`Updated aidlc from ${PREVIEW_2} to ${AIDLC_VERSION}.`);
    expect(switched.stdout).not.toContain("downgrade");
    expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
    expect(stable.requests).toContain("/latest/download/version.json");
    expect(stable.requests.some((path) => path.includes("/api/releases"))).toBe(false);
    // The prior preview stays retained as the rollback target.
    expect(retained(machine)).toEqual([AIDLC_VERSION, PREVIEW_2].sort());

    const json = await run(LIFECYCLE, [
      "update", "--channel", PREVIEW_CHANNEL,
      "--release-base-url", preview.baseUrl, "--release-api-url", preview.apiUrl, "--json",
    ], project, env);
    expect(json.status, json.stdout + json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).data.channelSwitch).toEqual({
      from: STABLE_CHANNEL,
      to: PREVIEW_CHANNEL,
    });
    expect(JSON.parse(json.stdout).message).toContain(
      `updated ${AIDLC_VERSION} -> ${PREVIEW_2} (switched channel ${STABLE_CHANNEL} -> ${PREVIEW_CHANNEL})`,
    );
  }, 240_000);

  test("previews keep the newest two on top of the active, rollback, in-use, and pinned protection", async () => {
    if (process.platform === "win32") return;
    const oldest = fixture(PREVIEW_0);
    const first = fixture(PREVIEW_1);
    const second = fixture(PREVIEW_2);
    const third = fixture(PREVIEW_3);
    const stableRelease = fixture(AIDLC_VERSION);
    const { machine, project, env } = machineEnv();

    expect((await run(LIFECYCLE, ["update", "--version", AIDLC_VERSION, "--from", stableRelease], project, env)).status).toBe(0);
    expect((await run(LIFECYCLE, ["update", "--version", PREVIEW_1, "--from", first], project, env)).status).toBe(0);
    expect((await run(LIFECYCLE, ["versions", "install", PREVIEW_0, "--from", oldest], project, env)).status).toBe(0);
    expect((await run(LIFECYCLE, ["versions", "install", PREVIEW_2, "--from", second], project, env)).status).toBe(0);
    expect(retained(machine)).toEqual([AIDLC_VERSION, PREVIEW_0, PREVIEW_1, PREVIEW_2].sort());

    const updated = await run(LIFECYCLE, ["update", "--version", PREVIEW_3, "--from", third, "--json"], project, env);
    expect(updated.status, updated.stdout + updated.stderr).toBe(0);
    const data = JSON.parse(updated.stdout).data;
    // PREVIEW_3 is active and PREVIEW_1 is the rollback marker (protected as for
    // any release). PREVIEW_2 has no protection of its own but is one of the
    // two newest previews, so the window keeps it. PREVIEW_0 is an older
    // preview outside the window and the stable release lost its rollback
    // protection to PREVIEW_1: both are pruned, the stable one exactly as before.
    expect(readFileSync(join(machine, "rollback-version"), "utf-8").trim()).toBe(PREVIEW_1);
    expect(data.pruned.sort()).toEqual([AIDLC_VERSION, PREVIEW_0].sort());
    expect(retained(machine)).toEqual([PREVIEW_1, PREVIEW_2, PREVIEW_3].sort());

    const listed = await run(LIFECYCLE, ["versions", "prune", "--json"], project, env);
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    const message = JSON.parse(listed.stdout).message;
    expect(message).toContain(`${PREVIEW_1} (rollback)`);
    expect(message).toContain(`${PREVIEW_2} (recent ${PREVIEW_CHANNEL})`);
    expect(message).toContain(`${PREVIEW_3} (active, recent ${PREVIEW_CHANNEL})`);
    expect(retained(machine)).toEqual([PREVIEW_1, PREVIEW_2, PREVIEW_3].sort());
  }, 240_000);

  test("use and config --pin accept preview ids and project pins keep overriding the channel", async () => {
    if (process.platform === "win32") return;
    const previewRelease = fixture(PREVIEW_1);
    const stableRelease = fixture(AIDLC_VERSION);
    const { machine, project, env } = machineEnv();
    expect((await run(LIFECYCLE, ["update", "--version", AIDLC_VERSION, "--from", stableRelease], project, env)).status).toBe(0);

    const used = await run(LIFECYCLE, ["use", PREVIEW_1, "--from", previewRelease], project, env);
    expect(used.status, used.stdout + used.stderr).toBe(0);
    expect(used.stdout).toContain(`Now using aidlc ${PREVIEW_1} (was ${AIDLC_VERSION}`);
    expect((await run(LIFECYCLE, ["use", AIDLC_VERSION], project, env)).status).toBe(0);

    const pinned = await run(INIT, ["config", "--pin", PREVIEW_1, "--project-dir", project, "--json"], project, env);
    expect(pinned.status, pinned.stdout + pinned.stderr).toBe(0);
    expect(readFileSync(join(project, ".aidlc-version"), "utf-8")).toBe(`${PREVIEW_1}\n`);
    const pins = JSON.parse(readFileSync(join(machine, "pins.json"), "utf-8")) as Record<string, string>;
    expect(Object.values(pins)).toEqual([PREVIEW_1]);

    const saved = { root: process.env.AIDLC_INSTALL_ROOT, bin: process.env.AIDLC_BIN_DIR };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      expect(resolvePinnedDispatch(["version"], project)).toEqual({
        kind: "execute",
        executable: join(machine, "versions", PREVIEW_1, "aidlc"),
        version: PREVIEW_1,
      });
    } finally {
      if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved.root;
      if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = saved.bin;
    }

    const malformed = await run(INIT, ["config", "--pin", "2.7.2-rc.1", "--project-dir", project], project, env);
    expect(malformed.status).toBe(2);
    expect(malformed.stdout + malformed.stderr).toContain("invalid version");
  }, 240_000);
});
