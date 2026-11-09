// covers: file:core/hooks/aidlc-session-start.ts, function:moveReposManifestIntoAidlc, file:core/tools/aidlc-lifecycle.ts
//
// After `aidlc update`, each project catches up the next time it is opened: a
// native install's hooks run the machine's release, so the first chat's start in
// a project whose harness files an earlier release wrote runs config's refresh
// for it, unattended, every recorded answer kept. 2.12's refresh moves a tracked
// root repos.json into aidlc/ and the first reply says so; an untracked one moves
// silently. A second start and a later `aidlc config` change nothing. A pinned
// project, a newer stamp, the status line and a tool call's hook are left alone.
// The release comes through a served mirror, as an organisation's would; the
// project's hooks run through the shell Claude Code uses (Git Bash on Windows).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import { serveReleaseFixture, writeReleaseFixture } from "../harness/release-fixture.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SKIP_REASON = gitBashSkipReason();
const MOVED = "AI-DLC moved repos.json into aidlc/. Commit it so your team gets it; teammates need AI-DLC 2.12 or newer.";
const SESSION = "00000000-0000-4000-8000-00000000ca7c";

let root = "";
let shell = "";
let env: NodeJS.ProcessEnv = {};
let earlierTree = "";
let laterTree = "";
const timings: string[] = [];

function sh(cwd: string, command: string, input = "") {
  const r = spawnSync(shell, ["-c", command], {
    cwd,
    encoding: "utf-8",
    env,
    input,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function stampVersion(project: string): string {
  return (JSON.parse(readFileSync(join(project, ".claude", "tools", "data", "aidlc-stamp.json"), "utf-8")) as {
    frameworkVersion: string;
  }).frameworkVersion;
}

function shifted(version: string, by: -1 | 1): string {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  if (by === 1) return `${major}.${minor}.${patch + 1}`;
  return patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.0`;
}

// This release's native tree stamped as another release.
function stampedTree(version: string): string {
  const dir = realpathSync(mkdtempSync(join(root, "tree-")));
  cpSync(join(REPO_ROOT, "dist-release", "claude"), dir, { recursive: true });
  const stamp = join(dir, ".claude", "tools", "data", "aidlc-stamp.json");
  const value = JSON.parse(readFileSync(stamp, "utf-8")) as Record<string, unknown>;
  writeFileSync(stamp, `${JSON.stringify({ ...value, frameworkVersion: version }, null, 2)}\n`);
  return dir;
}

// A Claude Code project set up from `tree`, with a repo list, all committed.
function project(tree: string, options: { tracked?: boolean; pin?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(root, "project-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "lee"]);
  git(dir, ["config", "user.email", "lee@example.test"]);
  const configured = sh(dir, `aidlc config --project-dir "$P" --harness claude --mcp none --quiet --from "$T"`.replace("$P", dir.replaceAll("\\", "/")).replace("$T", tree.replaceAll("\\", "/")));
  expect(configured.status, configured.stdout + configured.stderr).toBe(0);
  if (options.pin) {
    const pinned = sh(dir, `aidlc config --pin ${AIDLC_VERSION} --project-dir "${dir.replaceAll("\\", "/")}"`);
    expect(pinned.status, pinned.stdout + pinned.stderr).toBe(0);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "setup"]);
  writeFileSync(join(dir, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing" }] }, null, 2)}\n`);
  if (options.tracked !== false) {
    git(dir, ["add", "repos.json"]);
    git(dir, ["commit", "-q", "-m", "repo list"]);
  }
  return dir;
}

function hookCommand(dir: string, event: string): string {
  const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    statusLine?: { command?: string };
  };
  if (event === "statusLine") return settings.statusLine?.command ?? "";
  return settings.hooks?.[event]?.[0]?.hooks?.[0]?.command ?? "";
}

function sessionStart(
  dir: string,
  label: string,
  extra: Record<string, unknown> = {},
): { status: number | null; stdout: string; stderr: string } {
  const payload = { session_id: SESSION, transcript_path: join(dir, "t.jsonl"), cwd: dir, hook_event_name: "SessionStart", source: "startup", ...extra };
  const started = Date.now();
  const r = sh(dir, hookCommand(dir, "SessionStart"), JSON.stringify(payload));
  timings.push(`${label}: ${Date.now() - started} ms`);
  return r;
}

beforeAll(async () => {
  if (SKIP_REASON !== null) return;
  shell = process.platform === "win32" ? gitBashPath() : "/bin/sh";
  root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-catch-up-")));
  // This checkout's compiled engine is the release's own binary, so the
  // install verifies it as it would a published one and a pin can use it.
  const engine = join(root, process.platform === "win32" ? "aidlc-engine.exe" : "aidlc-engine");
  const built = spawnSync(process.execPath, [
    "build", join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "aidlc.ts"), "--compile", "--outfile", engine,
  ], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  const release = join(root, "release");
  mkdirSync(release);
  writeReleaseFixture({ root: release, repoRoot: REPO_ROOT, version: AIDLC_VERSION, binaryFrom: engine, distributions: ["claude"] });
  const machine = join(root, "machine");
  const bin = join(machine, "bin");
  env = testGuardEnvironment(process.env, "production");
  for (const key of Object.keys(env)) {
    if (/^(?:AIDLC|CLAUDE|KIRO|CURSOR)_PROJECT_DIR$|^AIDLC_TEST_CONFIG_TTY$/i.test(key)) delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env = {
    ...env,
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: bin,
    AIDLC_GH_BIN: join(root, "no-gh", process.platform === "win32" ? "gh.exe" : "gh"),
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
    [pathKey]: [bin, env[pathKey] ?? ""].join(process.platform === "win32" ? ";" : ":"),
  };
  // The organisation's mirror serves the release.
  const mirror = serveReleaseFixture(release);
  try {
    const child = Bun.spawn([
      process.execPath, join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts"),
      "update", "--version", AIDLC_VERSION, "--release-base-url", mirror.baseUrl,
    ], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status, out + err).toBe(0);
    expect(mirror.requests.length).toBeGreaterThan(0);
  } finally {
    mirror.stop();
  }
  earlierTree = stampedTree(shifted(AIDLC_VERSION, -1));
  laterTree = stampedTree(shifted(AIDLC_VERSION, 1));
});

afterAll(() => {
  if (timings.length > 0) console.log(`session start times: ${timings.join("; ")}`);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(SKIP_REASON !== null)("each project catches up the next time it is opened", () => {
  test("the first chat's start refreshes the files, moves the tracked list and says so; the next start and config change nothing", () => {
    const dir = project(earlierTree);
    expect(stampVersion(dir)).toBe(shifted(AIDLC_VERSION, -1));
    const first = sessionStart(dir, "catch-up");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(stampVersion(dir)).toBe(AIDLC_VERSION);
    expect(first.stdout).toContain(MOVED);
    expect(git(dir, ["status", "--porcelain"])).toContain("R  repos.json -> aidlc/repos.json");
    // Recorded answers kept: --mcp none still writes no .mcp.json.
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    const status = git(dir, ["status", "--porcelain", "--", ":!aidlc"]);
    const second = sessionStart(dir, "next start");
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).not.toContain("repos.json");
    expect(git(dir, ["status", "--porcelain", "--", ":!aidlc"])).toBe(status);
    const configured = sh(dir, `aidlc config --project-dir "${dir.replaceAll("\\", "/")}" --harness claude`);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    expect(configured.stdout).not.toContain("repos.json");
    expect(git(dir, ["status", "--porcelain", "--", ":!aidlc"])).toBe(status);
  });

  test("an untracked list moves with nothing said", () => {
    const dir = project(earlierTree, { tracked: false });
    const first = sessionStart(dir, "catch-up, untracked list");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(stampVersion(dir)).toBe(AIDLC_VERSION);
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(true);
    expect(first.stdout).not.toContain("repos.json");
  });

  test("a pinned project and a newer stamp are left alone", () => {
    const pinned = project(earlierTree, { pin: true });
    expect(sessionStart(pinned, "pinned").status).toBe(0);
    expect(stampVersion(pinned)).toBe(shifted(AIDLC_VERSION, -1));
    expect(existsSync(join(pinned, "repos.json"))).toBe(true);
    const later = project(laterTree);
    expect(sessionStart(later, "newer stamp").status).toBe(0);
    expect(stampVersion(later)).toBe(shifted(AIDLC_VERSION, 1));
    expect(existsSync(join(later, "repos.json"))).toBe(true);
  });

  test("the status line, a tool call's hook, a compaction's start and Cursor's per-prompt probe never run the refresh", () => {
    const dir = project(earlierTree);
    // AI-DLC's status line command, as Claude Code runs it.
    const line = sh(dir, "aidlc engine statusline", JSON.stringify({ session_id: SESSION, cwd: dir }));
    expect(line.status, line.stdout + line.stderr).toBe(0);
    const tool = { session_id: SESSION, cwd: dir, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(dir, "repos.json") } };
    const pre = sh(dir, hookCommand(dir, "PreToolUse"), JSON.stringify(tool));
    expect(pre.status, pre.stdout + pre.stderr).toBe(0);
    expect(sessionStart(dir, "compaction", { source: "compact" }).status).toBe(0);
    expect(sessionStart(dir, "probe", { source: "resume", rebind_check: true }).status).toBe(0);
    expect(stampVersion(dir)).toBe(shifted(AIDLC_VERSION, -1));
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
  });

  test("a refresh config refuses says nothing and stops nothing", () => {
    const dir = project(earlierTree);
    // A file of AI-DLC's the person changed: config refuses to refresh over it.
    const agent = join(dir, ".claude", "agents", "aidlc-developer-agent.md");
    writeFileSync(agent, `${readFileSync(agent, "utf-8")}\nmine\n`);
    const started = sessionStart(dir, "refused refresh");
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.stdout).not.toContain("repos.json");
    expect(stampVersion(dir)).toBe(shifted(AIDLC_VERSION, -1));
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
    expect(readFileSync(agent, "utf-8")).toEndWith("\nmine\n");
  });

});
