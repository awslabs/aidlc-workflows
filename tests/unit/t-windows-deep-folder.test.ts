// covers: file:core/tools/aidlc-folder-depth.ts, file:core/tools/aidlc-init.ts, file:core/tools/aidlc-doctor.ts
//
// On Windows a project folder deep enough that AI-DLC's records cross 260
// characters breaks: Copilot CLI asks before every read of the reviewer's
// review file and the stage's questions file (copilot -p refuses them), and
// Git without long paths refuses the committed question files. `aidlc config`
// says so once, in one line, and `aidlc doctor` shows the same as a row, from
// one helper and one number. The line reads the machine: with Windows long
// paths and Git's core.longpaths both on it is silent, except under Copilot
// CLI, whose own check asks before each read of a longer path (copilot -p
// refuses it) either way; otherwise it names a shorter folder and the setting
// still off. Nothing on Linux or macOS, nothing for a short folder, and nothing
// of the person's is changed. The Windows cases run on Windows Server.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { shortTemporaryRoot } from "../lib/e2e-workers.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const HELPER = join(REPO_ROOT, "core", "tools", "aidlc-folder-depth.ts");
const WINDOWS = process.platform === "win32";
// What the line and the row say, whatever the folder's depth: with Windows long
// paths off, with only Git's off, and under Copilot CLI.
const SAID = "characters deep; Windows tools refuse paths over 260 characters and AI-DLC's records add about";
const GIT_SAID = "characters deep; Git refuses paths over 260 characters and AI-DLC's records add about";
const COPILOT_SAID = "characters deep; Copilot CLI asks before every read of a path over 260 characters " +
  "(copilot -p refuses it), and AI-DLC's records add about";
const ANY_SAID = "characters deep;";
const KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem";
const BOTH_WAY = `, or turn long paths on: set LongPathsEnabled to 1 in ${KEY} as an administrator, ` +
  "then run git config --global core.longpaths true";
const WINDOWS_WAY = `, or turn Windows long paths on: set LongPathsEnabled to 1 in ${KEY} as an administrator`;
const GIT_WAY = ", or turn Git's long paths on: run git config --global core.longpaths true";
const shorter = (name: string): string => `move the project to a shorter folder (for example C:\\src\\${name})`;
const OFF = () => ({ windows: false, git: false });
const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"] as const;
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string, root = tmpdir()): string {
  const path = mkdtempSync(join(root, prefix));
  temporary.push(path);
  return path;
}

// A project folder `length` characters deep, with a .git of its own.
function projectFolder(length: number, root = tmpdir()): string {
  const base = temp("aidlc-t-deep-", root);
  const dir = length > base.length + 1 ? join(base, "p".repeat(length - base.length - 1)) : base;
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  return dir;
}

type Run = { status: number; out: string };

// This box's own Windows long-path setting, read through PowerShell (AI-DLC
// asks reg.exe), so a case knows which words the machine should get.
function windowsLongPathsOn(): boolean {
  const read = spawnSync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled " +
    "-ErrorAction SilentlyContinue).LongPathsEnabled",
  ], { encoding: "utf-8" });
  return read.status === 0 && Number(read.stdout.trim() || "0") !== 0;
}

// Git's long paths as the person set them: GIT_CONFIG_NOSYSTEM keeps the box
// image's system config out, and the global file is the scratch home's.
function personGit(env: Record<string, string | undefined>, longPaths: boolean): string {
  const file = join(String(env.HOME), ".gitconfig");
  if (longPaths) writeFileSync(file, "[core]\n\tlongpaths = true\n");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = file;
  if (WINDOWS) {
    const seen = spawnSync("git", ["config", "--show-origin", "--get", "core.longpaths"], { env, encoding: "utf-8" });
    console.log(`LongPathsEnabled ${windowsLongPathsOn() ? 1 : 0}; git core.longpaths: ${seen.stdout.trim() || "unset"}`);
  }
  return file;
}

function machineEnv(terminal: boolean): Record<string, string | undefined> {
  const machine = temp("aidlc-t-deep-machine-");
  const home = join(machine, "home");
  const stubs = join(machine, "stubs");
  mkdirSync(home);
  mkdirSync(stubs);
  writeFileSync(join(stubs, "copilot"), "#!/bin/sh\necho 1.0.0\n");
  chmodSync(join(stubs, "copilot"), 0o755);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
    AIDLC_BIN_DIR: join(machine, "bin"),
    AIDLC_RUNTIME_ROOT: DIST_RELEASE,
    PATH: `${stubs}${delimiter}${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
  };
  for (const name of [
    "AIDLC_PROJECT_DIR",
    "CLAUDE_PROJECT_DIR",
    "KIRO_PROJECT_DIR",
    "AIDLC_TEST_CONFIG_TTY",
    "AIDLC_TEST_CONFIG_DETECTION_JSON",
    "TERM_PROGRAM",
    "VSCODE_GIT_ASKPASS_NODE",
  ]) delete env[name];
  if (terminal) {
    env.AIDLC_TEST_CONFIG_TTY = "1";
    // Copilot is the one harness on this machine, so Enter takes it.
    env.AIDLC_TEST_CONFIG_DETECTION_JSON = JSON.stringify({
      harnesses: Object.fromEntries(HARNESSES.map((name) => [
        name,
        name === "copilot"
          ? { found: true, version: "1.0.0", path: join(stubs, "copilot") }
          : { found: false, probed: name !== "kiro-ide" },
      ])),
      aws: { hasCredentials: true, sources: ["instance role"], profiles: [], regions: ["us-east-2"], files: [] },
      runtimeIssues: [],
      bedrockReachable: true,
    });
  }
  return env;
}

function run(tool: string, args: string[], cwd: string, env: Record<string, string | undefined>, input = ""): Run {
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env,
    input,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: args.join(" ") }),
  });
  if (result.error || result.status === null) {
    throw new Error(`${args[0]} did not exit normally: ${result.status}\n${result.stdout}${result.stderr}`, {
      cause: result.error,
    });
  }
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// Copilot CLI by default; Claude Code is a harness that does not refuse a long path on its own.
function configure(project: string, env: Record<string, string | undefined>, harness = "copilot"): Run {
  return run(INIT, [
    "config",
    "--project-dir",
    project,
    "--from",
    join(DIST_RELEASE, harness),
    "--harness",
    harness,
    "--mcp",
    "none",
    "--yes",
  ], project, env);
}

function doctor(project: string, env: Record<string, string | undefined>, harness = "copilot"): Run {
  return run(join(project, harness === "copilot" ? ".aidlc" : `.${harness}`, "tools", "aidlc.ts"), [
    "doctor",
    "--no-color",
    "--project-dir",
    project,
  ], project, env);
}

const times = (out: string, text: string): number => out.split(text).length - 1;

describe("the line and the row come from one helper", () => {
  test("the number is the deepest path AI-DLC writes under the project folder", async () => {
    const { RECORD_DEPTH } = await import(HELPER);
    // The review brief AI-DLC keeps beside a stage's review record, for the
    // longest stage name that has a reviewer, under work whose label is at the
    // engine's 24-character cap:
    // aidlc/spaces/default/intents/<YYMMDD>-<label>/.aidlc-engine/reviews/requirements-analysis/stage/briefs/<sha256>.md
    expect(RECORD_DEPTH).toBe(185);
  });

  test("the review records' own paths fit inside that number", async () => {
    const { RECORD_DEPTH } = await import(HELPER);
    const lib = await import("../../core/tools/aidlc-lib.ts");
    const record = `aidlc/spaces/default/intents/${lib.intentDirNameBase("w".repeat(64))}`;
    const reviewed = readdirSync(join(REPO_ROOT, "core", "aidlc-common", "stages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((phase) =>
        readdirSync(join(REPO_ROOT, "core", "aidlc-common", "stages", phase.name))
          .filter((name) => name.endsWith(".md"))
          .map((name) => readFileSync(join(REPO_ROOT, "core", "aidlc-common", "stages", phase.name, name), "utf-8"))
      )
      .map((text) => ({
        slug: /^slug:\s*(\S+)/m.exec(text)?.[1] ?? "",
        reviewer: /^reviewer:[ \t]*(\S+)/m.exec(text)?.[1] ?? "null",
      }))
      .filter((stage) => stage.slug !== "" && stage.reviewer !== "null");
    expect(reviewed.length).toBeGreaterThan(0);
    const attempt = lib.reviewAttemptId("");
    for (const { slug } of reviewed) {
      const draft = lib.reviewDraftRelativePath(slug, undefined, attempt, 1, `review:${"0".repeat(32)}`);
      const kept = lib.reviewRecordRelativePath(slug, undefined, attempt, 1);
      const brief = `${lib.REVIEW_RECORDS_DIR}/${slug}/stage/briefs/${"0".repeat(64)}.md`;
      for (const path of [draft, kept, brief]) {
        expect(`${record}/${path}`.length, `${record}/${path}`).toBeLessThanOrEqual(RECORD_DEPTH);
      }
    }
  });

  const folder = (length: number): string => `C:\\Users\\${"u".repeat(length - "C:\\Users\\\\my-app".length)}\\my-app`;

  test("on Windows a folder too deep for the records is said, with the folder, the limit and the number", async () => {
    const { RECORD_DEPTH, deepFolder } = await import(HELPER);
    const limit = 260 - 1 - RECORD_DEPTH;
    expect(folder(100)).toHaveLength(100);
    const deep = deepFolder(folder(100), "win32", undefined, { longPaths: OFF });
    expect(deep).not.toBeNull();
    expect(deep.depth).toBe(100);
    expect(deep.adds).toBe(RECORD_DEPTH);
    expect(deep.facts).toBe(`100 ${SAID} ${RECORD_DEPTH}`);
    expect(deep.fix).toBe(`${shorter("my-app")}${BOTH_WAY}`);
    for (const text of [deep.facts, deep.fix]) {
      expect(text).not.toContain("\n");
      expect(text).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(deepFolder(folder(limit), "win32")).toBeNull();
    expect(deepFolder(folder(limit + 1), "win32", undefined, { longPaths: OFF })?.depth).toBe(limit + 1);
    expect(deepFolder(folder(40), "win32")).toBeNull();
  });

  test("Windows long paths and Git's core.longpaths both on: nothing is said, however deep the folder", async () => {
    const { deepFolder } = await import(HELPER);
    const on = () => ({ windows: true, git: true });
    expect(deepFolder(folder(100), "win32", undefined, { longPaths: on })).toBeNull();
    expect(deepFolder(folder(200), "win32", undefined, { longPaths: on, harnesses: ["claude", "codex"] })).toBeNull();
    expect(deepFolder(folder(100), "win32", { names: ["u1-order-management"] }, { longPaths: on })).toBeNull();
  });

  test("either one off: the line names a shorter folder and turning on what is still off", async () => {
    const { RECORD_DEPTH, deepFolder } = await import(HELPER);
    const said = (windows: boolean, git: boolean) => deepFolder(folder(100), "win32", undefined, {
      longPaths: () => ({ windows, git }),
    });
    expect(said(false, true)?.facts).toBe(`100 ${SAID} ${RECORD_DEPTH}`);
    expect(said(false, true)?.fix).toBe(`${shorter("my-app")}${WINDOWS_WAY}`);
    // With Windows long paths on, only Git still refuses.
    expect(said(true, false)?.facts).toBe(`100 ${GIT_SAID} ${RECORD_DEPTH}`);
    expect(said(true, false)?.fix).toBe(`${shorter("my-app")}${GIT_WAY}`);
    expect(said(true, false)?.note).toBe(`This project folder is 100 ${GIT_SAID} ${RECORD_DEPTH}, so ${shorter("my-app")}${GIT_WAY}.`);
    expect(said(false, false)?.note).toBe(`This project folder is 100 ${SAID} ${RECORD_DEPTH}, so ${shorter("my-app")}${BOTH_WAY}.`);
  });

  test("under Copilot CLI the line is said whatever the machine says, and names a shorter folder", async () => {
    const { RECORD_DEPTH, deepFolder } = await import(HELPER);
    let reads = 0;
    const on = () => {
      reads++;
      return { windows: true, git: true };
    };
    for (const harnesses of [["copilot"], ["claude", "copilot"]]) {
      const deep = deepFolder(folder(100), "win32", undefined, { longPaths: on, harnesses });
      expect(deep?.facts).toBe(`100 ${COPILOT_SAID} ${RECORD_DEPTH}`);
      expect(deep?.fix).toBe(shorter("my-app"));
      expect(deep?.note).toBe(`This project folder is 100 ${COPILOT_SAID} ${RECORD_DEPTH}, so ${shorter("my-app")}.`);
    }
    // Long paths do not move Copilot's own check, so the machine is not asked.
    expect(reads).toBe(0);
    expect(deepFolder(folder(60), "win32", undefined, { longPaths: on, harnesses: ["copilot"] })).toBeNull();
  });

  test("a short folder, and Linux or macOS, read nothing of the machine", async () => {
    const { deepFolder } = await import(HELPER);
    let reads = 0;
    const count = () => {
      reads++;
      return { windows: false, git: false };
    };
    expect(deepFolder(folder(40), "win32", undefined, { longPaths: count })).toBeNull();
    expect(deepFolder(`/home/${"u".repeat(200)}`, "linux", undefined, { longPaths: count })).toBeNull();
    expect(deepFolder(`/Users/${"u".repeat(200)}`, "darwin", undefined, { longPaths: count })).toBeNull();
    expect(reads).toBe(0);
  });

  test("on Linux and macOS nothing is said, however deep the folder", async () => {
    const { deepFolder } = await import(HELPER);
    const deep = `/home/${"u".repeat(200)}/my-app`;
    expect(deepFolder(deep, "linux")).toBeNull();
    expect(deepFolder(deep, "darwin")).toBeNull();
  });
});

describe("config and doctor in a project folder", () => {
  test("a deep folder under Copilot CLI: config says it once and doctor as a row, with Git's long paths on too, and the folder and its git are as they were", () => {
    const project = projectFolder(120);
    const env = machineEnv(false);
    const global = personGit(env, true);
    const globalConfig = readFileSync(global, "utf-8");
    const gitConfig = readFileSync(join(project, ".git", "config"), "utf-8");
    const setup = configure(project, env);
    // A refresh is the same config run, and says it the same way.
    const refresh = configure(project, env);
    const checked = doctor(project, env);
    console.log(`config in a ${project.length}-character folder:\n${setup.out}\nits refresh:\n${refresh.out}`);
    console.log(`doctor in a ${project.length}-character folder:\n${checked.out}`);
    expect(setup.status, setup.out).toBe(0);
    expect(times(setup.out, ANY_SAID), setup.out).toBe(WINDOWS ? 1 : 0);
    if (WINDOWS) {
      expect(setup.out).toContain(`Note: This project folder is ${project.length} ${COPILOT_SAID}`);
      expect(setup.out).toContain(`${shorter(basename(project))}.`);
    }
    expect(refresh.status, refresh.out).toBe(0);
    expect(times(refresh.out, ANY_SAID), refresh.out).toBe(WINDOWS ? 1 : 0);
    expect(times(checked.out, ANY_SAID), checked.out).toBe(WINDOWS ? 1 : 0);
    if (WINDOWS) {
      expect(checked.out).toContain(`warn  Project folder: ${project.length} ${COPILOT_SAID}`);
      expect(checked.out).toContain(`fix: ${shorter(basename(project))}\n`);
    }
    // An advisory row: doctor's verdict is what the other checks make it.
    const json = JSON.parse(
      run(join(project, ".aidlc", "tools", "aidlc.ts"), ["doctor", "--json", "--project-dir", project], project, env).out,
    );
    const rows = (json.data.checks as Array<{ label: string; pass: boolean; severity?: string }>)
      .filter((check) => check.label.includes(COPILOT_SAID));
    expect(rows.map((row) => [row.pass, row.severity])).toEqual(WINDOWS ? [[false, "warn"]] : []);

    expect(existsSync(project)).toBe(true);
    expect(readFileSync(join(project, ".git", "config"), "utf-8")).toBe(gitConfig);
    expect(readFileSync(global, "utf-8")).toBe(globalConfig);
  });

  test("a deep folder under Claude Code with Git's long paths off: config and doctor name a shorter folder and what this machine still has off", () => {
    const project = projectFolder(120);
    const env = machineEnv(false);
    personGit(env, false);
    const windowsOn = WINDOWS && windowsLongPathsOn();
    const setup = configure(project, env, "claude");
    const checked = doctor(project, env, "claude");
    console.log(`config under Claude Code in a ${project.length}-character folder:\n${setup.out}`);
    console.log(`doctor:\n${checked.out}`);
    expect(setup.status, setup.out).toBe(0);
    expect(times(setup.out, ANY_SAID), setup.out).toBe(WINDOWS ? 1 : 0);
    expect(times(checked.out, ANY_SAID), checked.out).toBe(WINDOWS ? 1 : 0);
    if (WINDOWS) {
      const [said, way] = windowsOn ? [GIT_SAID, GIT_WAY] : [SAID, BOTH_WAY];
      expect(setup.out).toContain(`Note: This project folder is ${project.length} ${said}`);
      expect(setup.out).toContain(`${shorter(basename(project))}${way}.`);
      expect(checked.out).toContain(`warn  Project folder: ${project.length} ${said}`);
      expect(checked.out).toContain(`fix: ${shorter(basename(project))}${way}`);
    }
  });

  test("a deep folder under Claude Code with Git's long paths on: silent when Windows long paths are on, else it names the Windows setting, and neither setting is changed", () => {
    const project = projectFolder(120);
    const env = machineEnv(false);
    const global = personGit(env, true);
    const globalConfig = readFileSync(global, "utf-8");
    const windowsOn = WINDOWS && windowsLongPathsOn();
    const setup = configure(project, env, "claude");
    const checked = doctor(project, env, "claude");
    console.log(`config under Claude Code in a ${project.length}-character folder:\n${setup.out}`);
    console.log(`doctor:\n${checked.out}`);
    expect(setup.status, setup.out).toBe(0);
    const says = WINDOWS && !windowsOn ? 1 : 0;
    expect(times(setup.out, ANY_SAID), setup.out).toBe(says);
    expect(times(checked.out, ANY_SAID), checked.out).toBe(says);
    if (says) {
      expect(setup.out).toContain(`Note: This project folder is ${project.length} ${SAID}`);
      expect(setup.out).toContain(`${shorter(basename(project))}${WINDOWS_WAY}.`);
      expect(checked.out).toContain(`fix: ${shorter(basename(project))}${WINDOWS_WAY}`);
    }
    expect(readFileSync(global, "utf-8")).toBe(globalConfig);
    if (WINDOWS) expect(windowsLongPathsOn()).toBe(windowsOn);
  });

  test("a deep folder, first run at a terminal: the line comes once, before setup says it is complete", () => {
    const project = projectFolder(120);
    const setup = run(INIT, ["config", "--project-dir", project], project, machineEnv(true), "\n\n\n\n");
    console.log(`first run in a ${project.length}-character folder:\n${setup.out}`);
    expect(setup.status, setup.out).toBe(0);
    expect(setup.out).toContain("Setup complete.");
    expect(times(setup.out, COPILOT_SAID), setup.out).toBe(WINDOWS ? 1 : 0);
    if (WINDOWS) expect(setup.out.indexOf(COPILOT_SAID)).toBeLessThan(setup.out.indexOf("Setup complete."));
  });

  test("a short folder: neither config nor doctor says anything about it", async () => {
    const { RECORD_DEPTH } = await import(HELPER);
    const project = projectFolder(0, shortTemporaryRoot());
    // Short on Windows whatever the runner's TEMP; elsewhere any depth says nothing.
    if (WINDOWS) expect(project.length, project).toBeLessThanOrEqual(260 - 1 - RECORD_DEPTH);
    const env = machineEnv(false);
    const setup = configure(project, env);
    expect(setup.status, setup.out).toBe(0);
    expect(setup.out).not.toContain(ANY_SAID);
    expect(doctor(project, env).out).not.toContain(ANY_SAID);
  });
});
