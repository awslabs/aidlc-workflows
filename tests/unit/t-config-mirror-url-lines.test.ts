// A config line that names the person's command again leaves out the release
// mirror they gave with --release-base-url, since a mirror's path can be its
// credential, and asks for the same one back, as a section's conflict line
// does (t243). Each case runs the real config command on a native install with
// a mirror carrying a token: the token never reaches stdout or stderr, the
// line says "with the same --release-base-url", and the command it names, with
// the mirror added back, does what the line says.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const INSTALLED_EXECUTABLE = process.platform === "win32" ? "aidlc.exe" : "aidlc";
const TOKEN = "t0k3n-SECRET";
const MIRROR = `https://mirror.example/${TOKEN}/releases`;
const ASK = " with the same --release-base-url";
// Links need a privilege on Windows.
const LINKS = process.platform !== "win32";

const created: string[] = [];
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// Production prints canonical paths, so fixtures live under the canonical temp
// root (macOS aliases /var to /private/var).
function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  created.push(path);
  return path;
}

type Run = { status: number; stdout: string; stderr: string };

// A copy of Bun under the name aidlc stands in for the compiled executable, so
// the commands config prints start with `aidlc config`.
function nativeConfig(): (project: string, args: string[], options?: { input?: string; tty?: boolean }) => Run {
  const machine = temp("aidlc-mirror-lines-machine-");
  const launcher = join(temp("aidlc-mirror-lines-launcher-"), INSTALLED_EXECUTABLE);
  try {
    linkSync(BUN, launcher);
  } catch {
    cpSync(BUN, launcher);
  }
  return (project, args, options = {}) => {
    const result = spawnSync(launcher, [INIT, "config", ...args], {
      cwd: project,
      env: {
        ...process.env,
        AIDLC_RUNTIME_ROOT: join(REPO_ROOT, "dist-release"),
        AIDLC_INSTALL_ROOT: machine,
        AIDLC_BIN_DIR: join(machine, "bin"),
        ...(options.tty ? { AIDLC_TEST_CONFIG_TTY: "1" } : {}),
      },
      input: options.input ?? "",
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    if (result.error) throw result.error;
    return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function project(prefix: string): string {
  const dir = temp(prefix);
  mkdirSync(join(dir, ".git"));
  return dir;
}

function expectNoMirror(...runs: Run[]): void {
  for (const run of runs) {
    expect(run.stdout + run.stderr).not.toContain(TOKEN);
    expect(run.stdout + run.stderr).not.toContain("mirror.example");
  }
}

// The arguments after `aidlc config` in a command the line names, which these
// cases keep free of quoting, with the mirror added back.
function withMirror(named: string): string[] {
  const words = named.trim().split(/\s+/);
  expect(words.slice(0, 2)).toEqual(["aidlc", "config"]);
  return [...words.slice(2), "--release-base-url", MIRROR];
}

describe("config's lines that name the command again never print the release mirror", () => {
  test.skipIf(!LINKS)("a linked project file's line asks for the same --release-base-url", () => {
    const config = nativeConfig();
    const dir = project("aidlc-mirror-lines-linked-");
    const installed = config(dir, ["--project-dir", dir, "--harness", "claude", "--mcp", "none", "--yes"]);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const team = join(dir, "aidlc", "spaces", "default", "memory", "team.md");
    const shared = join(temp("aidlc-mirror-lines-shared-"), "team.md");
    writeFileSync(shared, readFileSync(team, "utf-8"));
    rmSync(team);
    symlinkSync(shared, team);

    const args = ["models", "--agent", "developer", "--effort", "high", "--project", "--download", "--release-base-url", MIRROR, "--yes"];
    const refused = config(dir, args);
    const json = config(dir, [...args, "--json"]);
    expect(refused.status, refused.stdout + refused.stderr).toBe(4);
    expect(json.status).toBe(4);
    expectNoMirror(refused, json);
    const named = new RegExp(
      `fix: put the file itself at aidlc/spaces/default/memory/team\\.md, then run \`([^\`]+)\`${ASK} again`,
    ).exec(refused.stdout)?.[1];
    expect(named, refused.stdout).toBe("aidlc config models --agent developer --effort high --project --download --yes");

    rmSync(team);
    writeFileSync(team, readFileSync(shared, "utf-8"));
    const again = config(dir, withMirror(named ?? ""));
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expectNoMirror(again);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("--harness kiro on a Kiro CLI (V2) project with no terminal stops with a --yes line that asks for the same --release-base-url", () => {
    const config = nativeConfig();
    const dir = project("aidlc-mirror-lines-kiro-stop-");
    const installed = config(dir, ["--project-dir", dir, "--harness", "kiro-v2", "--mcp", "none", "--yes"]);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    // Run from the project with `--project-dir .`, so the command it names
    // carries a path that needs no quoting on any platform.
    const stopped = config(dir, ["--project-dir", ".", "--harness", "kiro", "--mcp", "none", "--download", "--release-base-url", MIRROR]);
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(2);
    expectNoMirror(stopped);
    const out = `${stopped.stdout}${stopped.stderr}`;
    const named = /to switch \.kiro to Kiro in place, run `([^`]*)` with the same --release-base-url\./.exec(out)?.[1];
    expect(named, out).toBe("aidlc config --project-dir . --harness kiro --mcp none --download --yes");
    const switched = config(dir, withMirror(named ?? ""));
    expect(switched.status, switched.stdout + switched.stderr).toBe(0);
    expectNoMirror(switched);
    expect(JSON.parse(readFileSync(join(dir, ".kiro", "tools", "data", "aidlc-stamp.json"), "utf-8")).distribution)
      .toBe("kiro-ide");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the Kiro switch's --dry-run line asks for the same --release-base-url", () => {
    const config = nativeConfig();
    const dir = project("aidlc-mirror-lines-kiro-");
    const installed = config(dir, ["--project-dir", dir, "--harness", "kiro-v2", "--mcp", "none", "--yes"]);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    writeFileSync(join(dir, ".kiro", "hooks", "my-hook.json"), "{}\n");

    const switchArgs = ["--harness", "kiro-ide", "--mcp", "none", "--download", "--release-base-url", MIRROR];
    const refused = config(dir, switchArgs);
    const json = config(dir, [...switchArgs, "--json"]);
    expect(refused.status, refused.stdout + refused.stderr).toBe(4);
    expect(json.status).toBe(4);
    expectNoMirror(refused, json);
    expect(refused.stdout).toContain(`fix: aidlc config --harness kiro --mcp none --download --dry-run${ASK}\n`);
    const remediation = JSON.parse(json.stdout).remediation as string;
    expect(remediation).toBe(`aidlc config --harness kiro --mcp none --download --json --dry-run${ASK}`);

    const planned = config(dir, withMirror(remediation.slice(0, -ASK.length)));
    expect(planned.status, planned.stdout + planned.stderr).toBe(0);
    expectNoMirror(planned);
    const planToken = JSON.parse(planned.stdout).data.planToken as string;
    const switched = config(dir, [...switchArgs, "--plan-token", planToken]);
    expect(switched.status, switched.stdout + switched.stderr).toBe(0);
    expectNoMirror(switched);
    expect(JSON.parse(readFileSync(join(dir, ".kiro", "tools", "data", "aidlc-stamp.json"), "utf-8")).distribution)
      .toBe("kiro-ide");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the line for a question with no answer asks for the same --release-base-url", () => {
    const config = nativeConfig();
    const dir = project("aidlc-mirror-lines-answer-");
    // A new project with several harnesses on the machine: config asks which.
    const stopped = config(dir, ["--download", "--release-base-url", MIRROR, "--mcp", "none"], { tty: true });
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(2);
    expectNoMirror(stopped);
    const named = new RegExp(
      `Stopped: this needs an answer, and the input is closed\\. Run (.+?)${ASK} again where you can answer\\.`,
    ).exec(stopped.stdout)?.[1];
    expect(named, stopped.stdout).toBe("aidlc config --download --mcp none");

    // Run again where the person can answer: the first harness, and not now to
    // the setup map that follows.
    const answered = config(dir, withMirror(named ?? ""), { tty: true, input: "1\nn\n" });
    expect(answered.status, answered.stdout + answered.stderr).toBe(0);
    expectNoMirror(answered);
    expect(answered.stdout).toMatch(/Using .+\./);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a section's --yes line asks for the same --release-base-url", () => {
    const config = nativeConfig();
    const dir = project("aidlc-mirror-lines-yes-");
    const installed = config(dir, ["--project-dir", dir, "--harness", "claude", "--mcp", "none", "--yes"]);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const args = ["models", "--agent", "developer", "--effort", "high", "--project", "--download", "--release-base-url", MIRROR];
    const refused = config(dir, args);
    const json = config(dir, [...args, "--json"]);
    expect(refused.status, refused.stdout + refused.stderr).toBe(2);
    expect(json.status).toBe(2);
    expectNoMirror(refused, json);
    const named = new RegExp(`usage: (.+?)${ASK}\n`).exec(refused.stdout)?.[1];
    expect(named, refused.stdout).toBe("aidlc config models --agent developer --effort high --project --download --yes");

    const confirmed = config(dir, withMirror(named ?? ""));
    expect(confirmed.status, confirmed.stdout + confirmed.stderr).toBe(0);
    expectNoMirror(confirmed);
    expect(JSON.parse(readFileSync(join(dir, "aidlc.settings.json"), "utf-8")).models).toEqual(
      expect.objectContaining({ agents: expect.objectContaining({ developer: expect.objectContaining({ effort: "high" }) }) }),
    );
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
