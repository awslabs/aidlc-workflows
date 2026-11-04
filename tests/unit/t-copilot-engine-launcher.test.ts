// covers: function:launcherBody, function:recordLauncherVoucher, function:spendLauncherVoucher
//
// t-copilot-engine-launcher: on Copilot CLI in a Linux or macOS terminal,
// AI-DLC's routine commands run without Copilot's "Do you want to run this
// command?" dialog. Copilot allows a shell command by its first word only, so
// AI-DLC ships its own launcher, `.aidlc/bin/aidlc-engine`, which the /aidlc
// skill allows, and the Copilot hook sends the commands it already vouches for
// (VS Code's allow list, every guard passed) on that launcher with a one-use
// voucher. The launcher runs only vouched words, so a call nobody vouched for
// (the repository's hooks switched off, say) stops with the plain command,
// which Copilot then asks about.
//
// Layers, each pinned here: (1) the launcher ships on both channels, 0755, the
// skill allows it, and an install keeps it so; (2) a vouched command goes out
// on the launcher, a command that keeps its click stays plain, and VS Code and
// a Windows terminal are unchanged; (3) a typed `.aidlc/bin/` call is the
// launcher alone or is refused before any dialog with the plain command; (4)
// only the shipped bytes count; (5) the launcher runs a voucher once and
// nothing without one. Spawns the shipped hook and launcher in a scratch
// project, as Copilot does.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launcherBody, LAUNCHER_PATH, recordLauncherVoucher,
} from "../../core/tools/aidlc-launcher-voucher.ts";
import { sessionsDir } from "../../core/tools/aidlc-record-core.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const POSIX = process.platform !== "win32";
const COPY = "bun .aidlc/tools/aidlc.ts";
const ENGINE = `${COPY} engine`;
const CHANNELS = [
  { name: "copy", root: join(REPO_ROOT, "dist", "copilot"), invocation: COPY },
  { name: "native", root: join(REPO_ROOT, "dist-release", "copilot"), invocation: "aidlc" },
];
const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** A project holding the copy channel's `.aidlc` tree, as a person copies it. */
function project(): string {
  const dir = temp("t-copilot-launcher-");
  cpSync(join(CHANNELS[0].root, ".aidlc"), join(dir, ".aidlc"), { recursive: true });
  return dir;
}

const cleanEnv = (): NodeJS.ProcessEnv =>
  ({ ...process.env, AIDLC_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined, AIDLC_ENGINE_LAUNCHER: undefined });

type HookOut = {
  modifiedArgs?: { command?: string };
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: { command?: string } };
};

/** The hook's answer to one shell call, as Copilot CLI sends it (`Bash`). */
function preToolUse(dir: string, command: string, extra: Record<string, unknown> = {}, toolName = "Bash", cwd = dir): HookOut {
  const r = spawnSync("bun", [join(dir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), "guard-tool-call"], {
    cwd,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: "launcher-session", cwd,
      tool_name: toolName, tool_input: { command, ...extra },
    }),
    encoding: "utf-8",
    env: { ...cleanEnv(), AIDLC_PROJECT_DIR: cwd === dir ? undefined : dir },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout) as HookOut : {};
}

function shell(dir: string, command: string) {
  return spawnSync("/bin/sh", ["-c", command], {
    cwd: dir, encoding: "utf-8", env: cleanEnv(), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

function vouchers(dir: string): string[] {
  const at = join(sessionsDir(dir), "launcher-vouchers");
  return existsSync(at) ? readdirSync(at) : [];
}

const refusal = (out: HookOut): string | undefined =>
  out.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined;

describe("t-copilot-engine-launcher: AI-DLC's routine commands run without a dialog on Copilot CLI (Linux, macOS)", () => {
  for (const channel of CHANNELS) {
    test(`1: the ${channel.name} channel ships the launcher, 0755, and its skill allows it`, () => {
      const bin = join(channel.root, ".aidlc", "bin");
      expect(readdirSync(bin)).toEqual(["aidlc-engine"]);
      const file = join(bin, "aidlc-engine");
      expect(readFileSync(file, "utf-8")).toBe(launcherBody(channel.invocation));
      if (POSIX) expect(statSync(file).mode & 0o777).toBe(0o755);
      const skill = readFileSync(join(channel.root, ".github", "skills", "aidlc", "SKILL.md"), "utf-8");
      expect(skill).toContain(`  - shell(${LAUNCHER_PATH})\n`);
    });
  }

  test.skipIf(!POSIX)("1: `aidlc config` installs the launcher 0755 with the shipped bytes", () => {
    const dir = temp("t-copilot-launcher-config-");
    const r = spawnSync("bun", [join(REPO_ROOT, "core", "tools", "aidlc-init.ts"), "config", "--project-dir", dir,
      "--from", CHANNELS[1].root, "--harness", "copilot", "--mcp", "none", "--yes"], {
      cwd: dir, encoding: "utf-8", env: cleanEnv(), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const file = join(dir, LAUNCHER_PATH);
    expect(readFileSync(file, "utf-8")).toBe(launcherBody("aidlc"));
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  test.skipIf(!POSIX)("2: a vouched command goes out on the launcher with a voucher, and runs", () => {
    const dir = project();
    for (const [typed, launched, prints] of [
      [`${ENGINE} orchestrate help`, `${LAUNCHER_PATH} orchestrate help`, "Usage: /aidlc"],
      [`${ENGINE} runtime summary`, `${LAUNCHER_PATH} runtime summary`, ""],
      ["bun .aidlc/tools/aidlc-runtime.ts summary", `${LAUNCHER_PATH} runtime summary`, ""],
    ]) {
      const out = preToolUse(dir, typed);
      expect(out.modifiedArgs?.command, typed).toBe(launched);
      expect(out.hookSpecificOutput?.updatedInput?.command, typed).toBe(launched);
      // No decision: Copilot's own rule, the skill's, decides.
      expect(out.hookSpecificOutput?.permissionDecision, typed).toBeUndefined();
      expect(vouchers(dir), typed).toHaveLength(1);
      // The engine ran it (an empty project has no runtime summary to show).
      const ran = shell(dir, launched);
      expect(ran.stderr, typed).not.toContain("runs only the commands");
      expect(ran.stdout, typed).toContain(prints);
      expect(vouchers(dir), typed).toEqual([]);
    }
  });

  test.skipIf(!POSIX)("2: after a launcher call that did not run, the next command goes out as typed", () => {
    // A rule denied it, or the person said no: the agent's next call meets
    // Copilot's answer for the command it typed, not the launcher's name.
    const dir = project();
    expect(preToolUse(dir, `${ENGINE} orchestrate help`).modifiedArgs?.command).toBe(`${LAUNCHER_PATH} orchestrate help`);
    expect(preToolUse(dir, `${ENGINE} orchestrate help`)).toEqual({});
    expect(preToolUse(dir, `${ENGINE} runtime summary`)).toEqual({});
    // The launcher typed by the agent goes out as typed, with its own voucher.
    expect(preToolUse(dir, `${LAUNCHER_PATH} runtime summary`).modifiedArgs?.command).toBe(`${LAUNCHER_PATH} runtime summary`);
    expect(vouchers(dir)).toHaveLength(2);
    expect(shell(dir, `${LAUNCHER_PATH} runtime summary`).stderr).not.toContain("runs only the commands");
    // Once the first voucher is past its time, the launcher is used again.
    const [left] = vouchers(dir);
    const old = new Date(Date.now() - 16 * 60_000);
    utimesSync(join(sessionsDir(dir), "launcher-vouchers", left), old, old);
    expect(preToolUse(dir, `${ENGINE} runtime summary`).modifiedArgs?.command).toBe(`${LAUNCHER_PATH} runtime summary`);
  });

  test("2: a command that keeps its click, VS Code's terminal tool, a Windows terminal and a shell below the project are not sent on the launcher", () => {
    const dir = project();
    expect(preToolUse(dir, `${ENGINE} worktree discard u1`)).toEqual({});
    expect(preToolUse(dir, `${ENGINE} runtime summary`, {}, "run_in_terminal").hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(preToolUse(dir, `${ENGINE} runtime summary`, {}, "run_in_terminal").modifiedArgs).toBeUndefined();
    expect(preToolUse(dir, `${ENGINE} runtime summary`, { shell: "powershell" })).toEqual({});
    if (!POSIX) expect(preToolUse(dir, `${ENGINE} runtime summary`)).toEqual({});
    // A shell that starts in a folder below the project would not find the launcher.
    const below = join(dir, "src");
    mkdirSync(below);
    expect(preToolUse(dir, `${ENGINE} runtime summary`, {}, "Bash", below).modifiedArgs).toBeUndefined();
    expect(vouchers(dir)).toEqual([]);
  });

  test.skipIf(!POSIX)("3: the launcher typed alone is read as AI-DLC's command and vouched", () => {
    const dir = project();
    const out = preToolUse(dir, `${LAUNCHER_PATH} orchestrate help`);
    expect(out.modifiedArgs?.command).toBe(`${LAUNCHER_PATH} orchestrate help`);
    expect(vouchers(dir)).toHaveLength(1);
  });

  test("3: any other `.aidlc/bin/` call is refused before a dialog, naming the plain command", () => {
    const dir = project();
    const alone = "AI-DLC's commands run alone, one at a time, so this did not run. Run each as `bun .aidlc/tools/aidlc.ts engine ...`, a command of its own.";
    const typedFirst = "Only `.aidlc/bin/aidlc-engine`, typed first and from the project folder, runs from `.aidlc/bin/`, so this did not run. Run `bun .aidlc/tools/aidlc.ts engine ...` instead.";
    const cases: Array<[string, string]> = [
      [`${LAUNCHER_PATH} orchestrate help | sed -n 1,5p`, alone],
      [`${LAUNCHER_PATH} orchestrate help && ${LAUNCHER_PATH} runtime summary`, alone],
      [`${LAUNCHER_PATH} orchestrate help > out.txt`, alone],
      [`./${LAUNCHER_PATH} orchestrate help`, typedFirst],
      [`${dir}/${LAUNCHER_PATH} orchestrate help`, typedFirst],
      [`sh ${LAUNCHER_PATH} orchestrate help`, typedFirst],
      [".aidlc/bin/aidlc-utility status", "`.aidlc/bin/aidlc-utility` does not exist, so this did not run. Run `bun .aidlc/tools/aidlc-utility.ts status` instead."],
      [`${LAUNCHER_PATH} review-brief --stage code-generation`, "`bun .aidlc/tools/aidlc.ts engine review-brief --stage code-generation` is not an AI-DLC command, so this did not run. Run `bun .aidlc/tools/aidlc.ts engine --help` for the list."],
    ];
    if (POSIX) for (const [typed, reason] of cases) expect(refusal(preToolUse(dir, typed)), typed).toBe(reason);
    // In a Windows terminal the launcher does not run at all.
    expect(refusal(preToolUse(dir, `${LAUNCHER_PATH} orchestrate help`, { shell: "powershell" }))).toBe(
      "`.aidlc/bin/aidlc-engine` does not run in this terminal, so this did not run. Run `bun .aidlc/tools/aidlc.ts engine orchestrate help` instead.",
    );
    expect(vouchers(dir)).toEqual([]);
  });

  test.skipIf(!POSIX)("4: an edited launcher, one that lost its mode, or a link to it is not used", () => {
    const notShipped = "`.aidlc/bin/aidlc-engine` is not the file AI-DLC installed, so this did not run. Run `bun .aidlc/tools/aidlc.ts engine orchestrate help` instead.";
    const spoilers: Array<(file: string) => void> = [
      (file) => writeFileSync(file, `${readFileSync(file, "utf-8")}echo extra\n`),
      (file) => chmodSync(file, 0o644),
      (file) => { renameSync(file, `${file}-real`); symlinkSync(`${file}-real`, file); },
    ];
    for (const spoil of spoilers) {
      const dir = project();
      const file = join(dir, LAUNCHER_PATH);
      spoil(file);
      expect(lstatSync(file).isFile() && (lstatSync(file).mode & 0o111) !== 0 && readFileSync(file, "utf-8") === launcherBody(COPY)).toBe(false);
      expect(preToolUse(dir, `${ENGINE} orchestrate help`)).toEqual({});
      expect(refusal(preToolUse(dir, `${LAUNCHER_PATH} orchestrate help`))).toBe(notShipped);
      expect(vouchers(dir)).toEqual([]);
    }
  });

  test.skipIf(!POSIX)("5: the launcher runs a voucher once, and nothing without a fresh one", () => {
    const dir = project();
    const refused = (args: string) =>
      `.aidlc/bin/aidlc-engine runs only the commands AI-DLC's Copilot hooks pass to it, so this did not run. Run \`${ENGINE} ${args}\` instead.\n`;
    const bare = shell(dir, `${LAUNCHER_PATH} orchestrate help`);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toBe(refused("orchestrate help"));
    expect(bare.stdout).toBe("");

    recordLauncherVoucher(dir, ["engine", "orchestrate", "help"]);
    expect(shell(dir, `${LAUNCHER_PATH} orchestrate help`).status).toBe(0);
    expect(shell(dir, `${LAUNCHER_PATH} orchestrate help`).stderr).toBe(refused("orchestrate help"));

    // A voucher is for its exact words, and only while fresh.
    recordLauncherVoucher(dir, ["engine", "orchestrate", "help"]);
    expect(shell(dir, `${LAUNCHER_PATH} orchestrate help --verbose`).status).toBe(1);
    const [left] = vouchers(dir);
    const old = new Date(Date.now() - 16 * 60_000);
    utimesSync(join(sessionsDir(dir), "launcher-vouchers", left), old, old);
    expect(shell(dir, `${LAUNCHER_PATH} orchestrate help`).status).toBe(1);
    expect(vouchers(dir)).toEqual([]);

    // Words the shell would read differently are quoted in the plain command.
    expect(shell(dir, `${LAUNCHER_PATH} log decision --decision 'it is "so"'`).stderr)
      .toBe(refused(`log decision --decision 'it is "so"'`));
  });
});
