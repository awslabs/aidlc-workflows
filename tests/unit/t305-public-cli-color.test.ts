// covers: file:core/tools/aidlc-color.ts

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { writeReleaseFixture } from "../harness/release-fixture.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";

const BUN = process.execPath;
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const LIFECYCLE = join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts");
const DIST = join(REPO_ROOT, "dist");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const ESC = "\x1b[";
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function colorEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.AIDLC_INTERNAL_NO_COLOR;
  return {
    ...env,
    TERM: "xterm-256color",
    ...extra,
  };
}

function run(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env: colorEnv(env),
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function copiedProject(prefix: string): string {
  const project = temp(prefix);
  const git = spawnSync("git", ["init", "-q"], {
    cwd: project,
    encoding: "utf-8",
  });
  expect(git.status, git.stderr ?? "").toBe(0);
  cpSync(join(DIST, "claude", ".claude"), join(project, ".claude"), {
    recursive: true,
  });
  cpSync(join(DIST, "claude", "aidlc"), join(project, "aidlc"), {
    recursive: true,
  });
  return project;
}

function releaseFixture(): string {
  const root = temp("aidlc-t305-release-");
  writeReleaseFixture({
    root,
    repoRoot: REPO_ROOT,
    version: AIDLC_VERSION,
    binary: "executable",
    distributions: ["claude"],
  });
  return root;
}

function machineEnv(machine: string): NodeJS.ProcessEnv {
  return {
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: join(machine, "bin"),
    AIDLC_GH_BIN: join(
      REPO_ROOT,
      "tests",
      "fixtures",
      "bin",
      process.platform === "win32" ? "gh.cmd" : "gh",
    ),
  };
}

function expectNoEsc(result: { stdout: string; stderr: string }, label: string): void {
  expect(`${result.stdout}${result.stderr}`, label).not.toContain(ESC);
}

describe("t305 public CLI color gating", () => {
  test("every touched non-TTY surface emits zero ESC bytes", () => {
    const project = copiedProject("aidlc-t305-purity-");
    const results: Array<[string, ReturnType<typeof run>]> = [];
    results.push(["doctor", run(DISPATCHER, ["doctor"], project)]);
    results.push(["doctor verbose", run(DISPATCHER, ["doctor", "--verbose"], project)]);
    results.push(["top help", run(DISPATCHER, ["--help"], project)]);
    for (const command of [
      "config",
      "doctor",
      "version",
      "update",
      "use",
      "uninstall",
    ]) {
      results.push([
        `${command} help`,
        run(DISPATCHER, [command, "--help"], project),
      ]);
    }
    for (const section of [
      "models",
      "runtime",
      "providers",
      "trust",
      "flags",
      "project",
    ]) {
      results.push([
        `config ${section} help`,
        run(DISPATCHER, ["config", section, "--help"], project),
      ]);
    }
    results.push(["typo error", run(DISPATCHER, ["confg"], project)]);
    results.push([
      "models show",
      run(DISPATCHER, ["config", "models", "--show"], project),
    ]);
    results.push([
      "flags show",
      run(DISPATCHER, ["config", "flags", "--show"], project),
    ]);

    const configured = temp("aidlc-t305-config-");
    mkdirSync(join(configured, ".git"));
    results.push([
      "config non-TTY completion",
      run(INIT, [
        "config",
        "--project-dir",
        configured,
        "--from",
        join(DIST_RELEASE, "claude"),
        "--harness",
        "claude",
        "--mcp",
        "none",
        "--yes",
      ], configured),
    ]);

    const machine = temp("aidlc-t305-machine-");
    const release = releaseFixture();
    results.push([
      "lifecycle dry-run",
      run(LIFECYCLE, [
        "update",
        "--version",
        AIDLC_VERSION,
        "--from",
        release,
        "--dry-run",
      ], project, machineEnv(machine)),
    ]);
    results.push([
      "lifecycle success",
      run(LIFECYCLE, [
        "update",
        "--version",
        AIDLC_VERSION,
        "--from",
        release,
      ], project, machineEnv(machine)),
    ]);

    for (const [label, result] of results) {
      expectNoEsc(result, label);
    }
  }, 120_000);

  test("FORCE_COLOR applies restrained semantic SGR", () => {
    const project = copiedProject("aidlc-t305-force-");
    const harnessPath = join(project, ".claude", "tools", "data", "harness.json");
    writeFileSync(harnessPath, "{\n");
    const doctor = run(DISPATCHER, ["doctor"], project, {
      FORCE_COLOR: "1",
    });
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain("\x1b[1mMachine\x1b[0m");
    expect(doctor.stdout).toContain("\x1b[33mwarn \x1b[0m");
    expect(doctor.stdout).toContain("\x1b[31mfail \x1b[0m");
    expect(doctor.stdout).toContain("\x1b[36mfix:\x1b[0m");
    expect(doctor.stdout).toContain("\x1b[2mRun '");

    const help = run(DISPATCHER, ["--help"], project, {
      FORCE_COLOR: "1",
    });
    expect(help.stdout).toContain("\x1b[1mUSAGE\x1b[0m");
    expect(help.stdout).toContain("\x1b[1mconfig\x1b[0m");

    const error = run(DISPATCHER, ["confg"], project, {
      FORCE_COLOR: "1",
    });
    expect(error.stderr).toContain("\x1b[31merror:\x1b[0m");
    expect(error.stderr).toContain("\x1b[36mtip:\x1b[0m");
    expect(error.stderr).toContain("\x1b[1musage:\x1b[0m");

    const release = releaseFixture();
    const machine = temp("aidlc-t305-force-machine-");
    const dryRun = run(LIFECYCLE, [
      "update",
      "--version",
      AIDLC_VERSION,
      "--from",
      release,
      "--dry-run",
    ], project, {
      ...machineEnv(machine),
      FORCE_COLOR: "1",
    });
    expect(dryRun.stdout).toContain("\x1b[33mWould update aidlc");
    const updated = run(LIFECYCLE, [
      "update",
      "--version",
      AIDLC_VERSION,
      "--from",
      release,
    ], project, {
      ...machineEnv(machine),
      FORCE_COLOR: "1",
    });
    expect(updated.stdout).toContain("\x1b[32mUpdated aidlc");
  }, 120_000);

  test("NO_COLOR and --no-color override FORCE_COLOR", () => {
    const project = copiedProject("aidlc-t305-precedence-");
    const noColorEnv = run(DISPATCHER, ["--help"], project, {
      FORCE_COLOR: "1",
      NO_COLOR: "",
    });
    expectNoEsc(noColorEnv, "NO_COLOR");

    const noColorFlag = run(DISPATCHER, ["--no-color", "--help"], project, {
      FORCE_COLOR: "1",
    });
    expectNoEsc(noColorFlag, "--no-color");

    const forceZero = run(DISPATCHER, ["--help"], project, {
      FORCE_COLOR: "0",
    });
    expectNoEsc(forceZero, "FORCE_COLOR=0");
  });
});
