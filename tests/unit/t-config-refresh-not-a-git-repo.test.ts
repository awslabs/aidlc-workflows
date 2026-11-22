// covers: tool:aidlc-init
// A folder that is not a Git repository is still the person's project once AI-DLC is set up in it. Refreshing it, or
// running the `aidlc config --harness <name>` that doctor and config print for a tree on another release, does not ask
// "Initialize AI-DLC in ...?" at a terminal and does not refuse without one. A folder with no AI-DLC in it still asks
// first, and still refuses without a terminal, and nothing is written there.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

type Run = { status: number; out: string };

function run(
  tool: string,
  args: string[],
  cwd: string,
  machine: string,
  terminal: { input: string } | null,
): Run {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: join(machine, "home"),
    XDG_CONFIG_HOME: join(machine, "home", ".config"),
    AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
    AIDLC_BIN_DIR: join(machine, "bin"),
    AIDLC_RUNTIME_ROOT: DIST_RELEASE,
  };
  // Only the folder the command runs in may name the project here.
  for (const name of ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "KIRO_PROJECT_DIR", "AIDLC_TEST_CONFIG_TTY"]) {
    delete env[name];
  }
  if (terminal) env.AIDLC_TEST_CONFIG_TTY = "1";
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env,
    input: terminal?.input ?? "",
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: args.join(" ") }),
  });
  if (result.error || result.status === null) {
    throw new Error(`config did not exit normally: ${result.status}\n${result.stdout}${result.stderr}`, {
      cause: result.error,
    });
  }
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function folder(prefix: string): { dir: string; machine: string } {
  const dir = temp(prefix);
  const machine = temp(`${prefix}machine-`);
  mkdirSync(join(machine, "home"), { recursive: true });
  return { dir, machine };
}

// Set up the way a person first does it, naming the folder; the folder has no .git.
function installedNotGit(): { dir: string; machine: string } {
  const fixture = folder("aidlc-t-refresh-not-git-");
  const setup = run(INIT, [
    "config",
    "--project-dir",
    fixture.dir,
    "--from",
    join(DIST_RELEASE, "claude"),
    "--harness",
    "claude",
    "--mcp",
    "none",
    "--yes",
  ], fixture.dir, fixture.machine, null);
  expect(setup.status, setup.out).toBe(0);
  expect(existsSync(join(fixture.dir, ".git"))).toBe(false);
  return fixture;
}

// A refresh rewrites AI-DLC's own install record even when nothing else changed.
function manifestMtime(dir: string): number {
  return statSync(join(dir, ".claude", "tools", "data", "aidlc-manifest.json")).mtimeMs;
}

describe("config in a folder that is not a Git repository", () => {
  test("AI-DLC already set up, at a terminal: the refresh runs without asking to initialize the folder", () => {
    const fixture = installedNotGit();
    const before = manifestMtime(fixture.dir);
    Bun.sleepSync(20);
    // The input closes after the refresh, so the setup walk that follows stops at its first question, as it does in a
    // Git project; the refresh itself is what this checks.
    const refresh = run(DISPATCHER, ["config", "--harness", "claude", "--no-color"], fixture.dir, fixture.machine, {
      input: "",
    });
    expect(refresh.out).not.toContain("Initialize AI-DLC in");
    expect(refresh.out).not.toContain("configuration cancelled");
    expect(manifestMtime(fixture.dir), refresh.out).toBeGreaterThan(before);
  });

  test("AI-DLC already set up, no terminal: the printed `config --harness <name>` refreshes as it says", () => {
    const fixture = installedNotGit();
    const before = manifestMtime(fixture.dir);
    Bun.sleepSync(20);
    const refresh = run(DISPATCHER, ["config", "--harness", "claude", "--no-color"], fixture.dir, fixture.machine, null);
    expect(refresh.out).not.toContain("outside a recognized project");
    expect(refresh.out).toContain(`configured ${fixture.dir} for Claude Code`);
    expect(refresh.status, refresh.out).toBe(0);
    expect(manifestMtime(fixture.dir), refresh.out).toBeGreaterThan(before);
  });

  test("nothing set up, at a terminal: it still asks first, and a no writes nothing", () => {
    const fixture = folder("aidlc-t-refresh-not-git-empty-");
    const answer = run(DISPATCHER, ["config", "--harness", "claude", "--no-color"], fixture.dir, fixture.machine, {
      input: "n\n",
    });
    expect(answer.out.split("Initialize AI-DLC in "), answer.out).toHaveLength(2);
    expect(answer.out).toContain("configuration cancelled");
    expect(answer.status).not.toBe(0);
    expect(readdirSync(fixture.dir)).toEqual([]);
  });

  test("nothing set up, no terminal: it still asks for the folder by name, and writes nothing", () => {
    const fixture = folder("aidlc-t-refresh-not-git-empty-");
    const refused = run(DISPATCHER, ["config", "--harness", "claude", "--no-color"], fixture.dir, fixture.machine, null);
    expect(refused.out).toContain("non-interactive config outside a recognized project requires --project-dir");
    expect(refused.status).not.toBe(0);
    expect(readdirSync(fixture.dir)).toEqual([]);
  });
});
