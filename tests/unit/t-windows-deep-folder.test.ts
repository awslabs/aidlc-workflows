// covers: file:core/tools/aidlc-folder-depth.ts, file:core/tools/aidlc-init.ts, file:core/tools/aidlc-doctor.ts
//
// On Windows a project folder deep enough that AI-DLC's records cross 260
// characters breaks: Copilot CLI's own permission check refuses the reviewer's
// review file and the stage's questions file, and Git without long paths
// refuses the committed question files. `aidlc config` says so once, in one
// line, and `aidlc doctor` shows the same as a row, from one helper and one
// number. Nothing on Linux or macOS, nothing for a short folder, and nothing of
// the person's is changed. The Windows cases run on Windows Server.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
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
// What the line and the row say, whatever the folder's depth.
const SAID = "characters deep; Windows tools refuse paths over 260 characters and AI-DLC's records add about";
const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"] as const;
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

// A project folder `length` characters deep, with a .git of its own.
function projectFolder(length: number): string {
  const base = temp("aidlc-t-deep-");
  const dir = length > base.length + 1 ? join(base, "p".repeat(length - base.length - 1)) : base;
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  return dir;
}

type Run = { status: number; out: string };

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

function configure(project: string, env: Record<string, string | undefined>): Run {
  return run(INIT, [
    "config",
    "--project-dir",
    project,
    "--from",
    join(DIST_RELEASE, "copilot"),
    "--harness",
    "copilot",
    "--mcp",
    "none",
    "--yes",
  ], project, env);
}

function doctor(project: string, env: Record<string, string | undefined>): Run {
  return run(join(project, ".aidlc", "tools", "aidlc.ts"), [
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

  test("on Windows a folder too deep for the records is said, with the folder, the limit and the number", async () => {
    const { RECORD_DEPTH, deepFolder } = await import(HELPER);
    const limit = 260 - 1 - RECORD_DEPTH;
    const folder = (length: number): string => `C:\\Users\\${"u".repeat(length - "C:\\Users\\\\my-app".length)}\\my-app`;
    expect(folder(100)).toHaveLength(100);
    const deep = deepFolder(folder(100), "win32");
    expect(deep).not.toBeNull();
    expect(deep.depth).toBe(100);
    expect(deep.adds).toBe(RECORD_DEPTH);
    expect(deep.facts).toBe(`100 ${SAID} ${RECORD_DEPTH}`);
    expect(deep.fix).toBe("move the project to a shorter folder (for example C:\\src\\my-app)");
    for (const text of [deep.facts, deep.fix]) {
      expect(text).not.toContain("\n");
      expect(text).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(deepFolder(folder(limit), "win32")).toBeNull();
    expect(deepFolder(folder(limit + 1), "win32")?.depth).toBe(limit + 1);
    expect(deepFolder(folder(40), "win32")).toBeNull();
  });

  test("on Linux and macOS nothing is said, however deep the folder", async () => {
    const { deepFolder } = await import(HELPER);
    const deep = `/home/${"u".repeat(200)}/my-app`;
    expect(deepFolder(deep, "linux")).toBeNull();
    expect(deepFolder(deep, "darwin")).toBeNull();
  });
});

describe("config and doctor in a project folder", () => {
  test("a deep folder: config says it once, doctor shows it as a row, and the folder and its git are as they were", () => {
    const project = projectFolder(120);
    const env = machineEnv(false);
    const gitConfig = readFileSync(join(project, ".git", "config"), "utf-8");
    const setup = configure(project, env);
    // A refresh is the same config run, and says it the same way.
    const refresh = configure(project, env);
    const checked = doctor(project, env);
    console.log(`config in a ${project.length}-character folder:\n${setup.out}\nits refresh:\n${refresh.out}`);
    console.log(`doctor in a ${project.length}-character folder:\n${checked.out}`);
    expect(setup.status, setup.out).toBe(0);
    expect(times(setup.out, SAID), setup.out).toBe(WINDOWS ? 1 : 0);
    if (WINDOWS) {
      expect(setup.out).toContain(`Note: This project folder is ${project.length} ${SAID}`);
      expect(setup.out).toContain(`move the project to a shorter folder (for example C:\\src\\${basename(project)})`);
    }
    expect(refresh.status, refresh.out).toBe(0);
    expect(times(refresh.out, SAID), refresh.out).toBe(WINDOWS ? 1 : 0);
    expect(times(checked.out, SAID), checked.out).toBe(WINDOWS ? 1 : 0);
    if (WINDOWS) {
      expect(checked.out).toContain(`warn  Project folder: ${project.length} ${SAID}`);
      expect(checked.out).toContain(`fix: move the project to a shorter folder (for example C:\\src\\${basename(project)})`);
    }
    // An advisory row: doctor's verdict is what the other checks make it.
    const json = JSON.parse(
      run(join(project, ".aidlc", "tools", "aidlc.ts"), ["doctor", "--json", "--project-dir", project], project, env).out,
    );
    const rows = (json.data.checks as Array<{ label: string; pass: boolean; severity?: string }>)
      .filter((check) => check.label.includes(SAID));
    expect(rows.map((row) => [row.pass, row.severity])).toEqual(WINDOWS ? [[false, "warn"]] : []);

    expect(existsSync(project)).toBe(true);
    expect(readFileSync(join(project, ".git", "config"), "utf-8")).toBe(gitConfig);
  });

  test("a deep folder, first run at a terminal: the line comes once, before setup says it is complete", () => {
    const project = projectFolder(120);
    const setup = run(INIT, ["config", "--project-dir", project], project, machineEnv(true), "\n\n\n\n");
    console.log(`first run in a ${project.length}-character folder:\n${setup.out}`);
    expect(setup.status, setup.out).toBe(0);
    expect(setup.out).toContain("Setup complete.");
    expect(times(setup.out, SAID), setup.out).toBe(WINDOWS ? 1 : 0);
    if (WINDOWS) expect(setup.out.indexOf(SAID)).toBeLessThan(setup.out.indexOf("Setup complete."));
  });

  test("a short folder: neither config nor doctor says anything about it", async () => {
    const { RECORD_DEPTH } = await import(HELPER);
    const project = projectFolder(0);
    // On Windows short only because the runner's temp folder is (run-tests picks the shorter of the user's and
    // the system's): a TEMP deeper than that is the rig, not AI-DLC. Elsewhere any depth says nothing.
    if (WINDOWS) expect(project.length, project).toBeLessThanOrEqual(260 - 1 - RECORD_DEPTH);
    const env = machineEnv(false);
    const setup = configure(project, env);
    expect(setup.status, setup.out).toBe(0);
    expect(setup.out).not.toContain(SAID);
    expect(doctor(project, env).out).not.toContain(SAID);
  });
});
