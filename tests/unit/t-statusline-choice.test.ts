// AI-DLC's status line is the person's choice (#1407). Until this change it
// shipped in the team's .claude/settings.json and .codex/config.toml, which
// outrank the status line each person set up for themselves, so setup replaced
// theirs in every AI-DLC project. Now first-run setup asks once, a switch
// (`aidlc config --statusline on|off`, `/aidlc --statusline on|off`) changes it
// any time, and a setup that asks nothing adds nothing. A project that already
// had AI-DLC's status line keeps it, and the person whose own it covers hears
// so once. Claude Code keeps the choice in each person's own
// .claude/settings.local.json; Codex has no per-person project file, so there
// it is the project's, in the shared .codex/config.toml, and every line says so.
//
// Every case runs in scratch folders: the person's own Claude Code and Codex
// settings are a file the test wrote, hashed before and after, never edited.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  applyClaudeStatusLineDefault,
  CLAUDE_STATUS_LINE_QUESTION,
  claudeUserSettingsPath,
  codexUserConfigPath,
  CODEX_STATUS_LINE_QUESTION,
  setClaudeStatusLine,
  setCodexStatusLine,
  STATUSLINE_UNASKED_DEFAULT,
  switchClaudeStatusLine,
} from "../../core/tools/aidlc-statusline-choice.ts";

setDefaultTimeout(180_000);

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const ORCHESTRATE = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");
const RUNTIME = join(REPO_ROOT, "dist-release");
const ITEMS = ["model-with-reasoning", "git-branch", "task-progress", "context-used"];
const SOURCE_STATUS_LINE = { type: "command", command: 'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine statusline' };
const NATIVE_STATUS_LINE = { type: "command", command: "aidlc engine statusline" };
const OWN = { type: "command", command: "echo mine", padding: 0 };
const HOST_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "KIRO_SESSION_ID",
  "OPENCODE", "AIDLC_PROJECT_DIR", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_ROOT",
  "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_COMPILED_EXECUTABLE", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "AIDLC_TEST_CONFIG_TTY", "AIDLC_TEST_CONFIG_DETECTION_JSON", "AIDLC_MANAGED_SETTINGS_PATH", "VSCODE_CODE_CACHE_PATH",
  "TERM_PROGRAM", "VSCODE_GIT_ASKPASS_NODE", "AWS_AIDLC_DEFAULT_SCOPE",
];

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(path);
  return path;
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
}

type Machine = { root: string; home: string; env: NodeJS.ProcessEnv; claudeUser: string; codexUser: string };

// A machine of the test's own: home, Claude Code and Codex user files (the
// person's "own" status line when asked for), AI-DLC's install root, and a
// managed-settings path no host file answers.
function machine(options: { claudeOwn?: boolean; codexOwn?: boolean } = {}): Machine {
  const root = temp("aidlc-statusline-machine-");
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const codexHome = join(home, ".codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const claudeUser = join(claudeDir, "settings.json");
  const codexUser = join(codexHome, "config.toml");
  writeFileSync(claudeUser, `${JSON.stringify(options.claudeOwn ? { statusLine: OWN, theme: "dark" } : { theme: "dark" }, null, 2)}\n`);
  writeFileSync(
    codexUser,
    `check_for_update_on_startup = false\n${options.codexOwn ? '\n[tui]\nstatus_line = ["model", "current-dir"]\n' : ""}`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of HOST_ENV) delete env[name];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(home, ".config"),
    AIDLC_INSTALL_ROOT: join(root, "aidlc"),
    AIDLC_BIN_DIR: join(root, "aidlc", "bin"),
    AIDLC_RUNTIME_ROOT: RUNTIME,
    AIDLC_MANAGED_SETTINGS_PATH: join(root, "no-managed-settings.json"),
    AWS_EC2_METADATA_DISABLED: "true",
    NO_COLOR: "1",
  });
  return { root, home, env, claudeUser, codexUser };
}

function run(m: Machine, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; tool?: string } = {}) {
  const result = spawnSync(BUN, [options.tool ?? INIT, ...args], {
    env: { ...m.env, ...options.env },
    input: options.input ?? "",
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "" };
}

function project(prefix = "aidlc-statusline-project-"): string {
  const dir = temp(prefix);
  mkdirSync(join(dir, ".git"));
  return dir;
}

function setUp(m: Machine, harness: "claude" | "codex", dir = project()): string {
  const result = run(m, ["config", "--project-dir", dir, "--from", join(RUNTIME, harness), "--harness", harness, "--yes"]);
  expect(result.status, result.out).toBe(0);
  return dir;
}

function claudeLocal(dir: string): string {
  return join(dir, ".claude", "settings.local.json");
}

function personalRecord(dir: string): unknown {
  const path = join(dir, "aidlc.settings.local.json");
  return existsSync(path) ? (json(path).flags as Record<string, unknown> | undefined)?.statusline : undefined;
}

// What a project set up by an earlier release has: AI-DLC's status line in the
// shared Claude Code settings.
function asEarlierRelease(dir: string): void {
  const team = join(dir, ".claude", "settings.json");
  const settings = json(team);
  settings.statusLine = NATIVE_STATUS_LINE;
  writeFileSync(team, `${JSON.stringify(settings, null, 2)}\n`);
}

// A project folder with only what the module reads: the shipped value.
function bareClaudeProject(): string {
  const dir = temp("aidlc-statusline-bare-");
  mkdirSync(join(dir, ".claude", "tools", "data"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "tools", "data", "harness.json"),
    `${JSON.stringify({ schemaVersion: 1, name: "claude", harnessDir: ".claude", statusLine: SOURCE_STATUS_LINE }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, ".claude", "tools", "data", "aidlc-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, files: {} }, null, 2)}\n`,
  );
  return dir;
}

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("what ships", () => {
  test("neither the team's Claude Code settings nor the shared Codex config carry AI-DLC's status line", () => {
    for (const channel of ["dist", "dist-release"]) {
      const settings = json(join(REPO_ROOT, channel, "claude", ".claude", "settings.json"));
      expect(settings.statusLine, channel).toBeUndefined();
      const codex = readFileSync(join(REPO_ROOT, channel, "codex", ".codex", "config.toml"), "utf-8");
      expect((Bun.TOML.parse(codex) as Record<string, unknown>).tui, channel).toBeUndefined();
    }
    expect(json(join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data", "harness.json")).statusLine)
      .toEqual(SOURCE_STATUS_LINE);
    expect(json(join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "data", "harness.json")).statusLine)
      .toEqual(NATIVE_STATUS_LINE);
    expect(json(join(REPO_ROOT, "dist-release", "codex", ".codex", "tools", "data", "harness.json")).statusLine)
      .toEqual({ items: ITEMS });
  });

  test("a setup that asks nothing adds nothing (Arden 2026-10-12)", () => {
    expect(STATUSLINE_UNASKED_DEFAULT).toBe("nothing");
  });
});

describe("the no-question default, both values of the constant", () => {
  test("nothing: no status line is added, whether or not the person has one", () => {
    for (const claudeOwn of [false, true]) {
      const m = machine({ claudeOwn });
      const dir = bareClaudeProject();
      const result = applyClaudeStatusLineDefault(dir, { mode: "nothing", env: m.env, marker: false });
      expect(result).toBeNull();
      expect(existsSync(claudeLocal(dir))).toBe(false);
      expect(personalRecord(dir)).toBeUndefined();
    }
  });

  test("when-they-have-none: added silently only when no status line of theirs is in reach", () => {
    const none = machine();
    const dir = bareClaudeProject();
    expect(applyClaudeStatusLineDefault(dir, { mode: "when-they-have-none", env: none.env, marker: false }))
      .toEqual({ wrote: true, line: null });
    expect(json(claudeLocal(dir)).statusLine).toEqual(SOURCE_STATUS_LINE);

    const own = machine({ claudeOwn: true });
    const theirs = bareClaudeProject();
    expect(applyClaudeStatusLineDefault(theirs, { mode: "when-they-have-none", env: own.env, marker: false })).toBeNull();
    expect(existsSync(claudeLocal(theirs))).toBe(false);
  });

  test("C1: a project that had AI-DLC's status line keeps it, says the line once when it covers theirs, and never again", () => {
    for (const mode of ["nothing", "when-they-have-none"] as const) {
      const m = machine({ claudeOwn: true });
      const dir = bareClaudeProject();
      expect(applyClaudeStatusLineDefault(dir, { mode, env: m.env, marker: true })).toEqual({
        wrote: true,
        line: "AI-DLC's status line replaces yours here; /aidlc --statusline off gives yours back.",
      });
      expect(json(claudeLocal(dir)).statusLine).toEqual(SOURCE_STATUS_LINE);
      expect(personalRecord(dir)).toBe("kept");
      expect(applyClaudeStatusLineDefault(dir, { mode, env: m.env, marker: true })).toBeNull();
    }
    const none = machine();
    const dir = bareClaudeProject();
    expect(applyClaudeStatusLineDefault(dir, { env: none.env, marker: true })).toEqual({ wrote: true, line: null });
  });

  test("an answer, a status line already in settings.local.json, or the organization's status line leaves everything alone", () => {
    const m = machine();
    const answered = bareClaudeProject();
    writeFileSync(join(answered, "aidlc.settings.local.json"), `${JSON.stringify({ schemaVersion: 1, flags: { schemaVersion: 1, statusline: "off" } })}\n`);
    expect(applyClaudeStatusLineDefault(answered, { env: m.env, marker: true })).toBeNull();
    expect(existsSync(claudeLocal(answered))).toBe(false);

    const local = bareClaudeProject();
    writeFileSync(claudeLocal(local), `${JSON.stringify({ statusLine: OWN })}\n`);
    expect(applyClaudeStatusLineDefault(local, { env: m.env, marker: true })).toBeNull();
    expect(json(claudeLocal(local)).statusLine).toEqual(OWN);

    const managedPath = join(m.root, "managed-settings.json");
    writeFileSync(managedPath, `${JSON.stringify({ statusLine: { type: "command", command: "org-line" } })}\n`);
    const managed = bareClaudeProject();
    expect(applyClaudeStatusLineDefault(managed, { env: { ...m.env, AIDLC_MANAGED_SETTINGS_PATH: managedPath }, marker: true }))
      .toBeNull();
    expect(existsSync(claudeLocal(managed))).toBe(false);
  });
});

describe("Claude Code: the personal file", () => {
  test("on and off keep every other key of settings.local.json and its byte order mark", () => {
    const dir = bareClaudeProject();
    writeFileSync(claudeLocal(dir), `\uFEFF${JSON.stringify({ env: { MY_FLAG: "1" }, disableAllHooks: false }, null, 2)}\n`);
    expect(setClaudeStatusLine(dir, true, SOURCE_STATUS_LINE as never).changed).toBe(true);
    const on = readFileSync(claudeLocal(dir), "utf-8");
    expect(on.startsWith("\uFEFF")).toBe(true);
    expect(json(claudeLocal(dir))).toEqual({ env: { MY_FLAG: "1" }, disableAllHooks: false, statusLine: SOURCE_STATUS_LINE });
    expect(setClaudeStatusLine(dir, false, SOURCE_STATUS_LINE as never).changed).toBe(true);
    expect(json(claudeLocal(dir))).toEqual({ env: { MY_FLAG: "1" }, disableAllHooks: false });
  });

  test("a status line of theirs in settings.local.json comes back after on then off", () => {
    const m = machine();
    const dir = bareClaudeProject();
    writeFileSync(claudeLocal(dir), `${JSON.stringify({ statusLine: OWN }, null, 2)}\n`);
    withEnv(m.env, () => {
      expect(switchClaudeStatusLine(dir, true, { env: m.env }).line).toBe(
        "AI-DLC's status line shows in this project in place of the one in .claude/settings.local.json; /aidlc --statusline off puts that one back.",
      );
      expect(json(claudeLocal(dir)).statusLine).toEqual(SOURCE_STATUS_LINE);
      expect(switchClaudeStatusLine(dir, false, { env: m.env }).line).toBe(
        "The status line from .claude/settings.local.json shows again in this project; /aidlc --statusline on brings AI-DLC's back.",
      );
    });
    expect(json(claudeLocal(dir)).statusLine).toEqual(OWN);
    expect((json(join(dir, "aidlc.settings.local.json")).flags as Record<string, unknown>).statuslineReplaced).toBeUndefined();
  });

  test("the person's own settings file is found the way Claude Code finds it, on Windows too", () => {
    expect(claudeUserSettingsPath({ CLAUDE_CONFIG_DIR: "C:\\Users\\a\\claude-config" }))
      .toBe(join("C:\\Users\\a\\claude-config", "settings.json"));
    expect(claudeUserSettingsPath({ USERPROFILE: "C:\\Users\\a" })).toBe(join("C:\\Users\\a", ".claude", "settings.json"));
    expect(claudeUserSettingsPath({ HOME: "/home/a", USERPROFILE: "C:\\Users\\a" })).toBe(join("/home/a", ".claude", "settings.json"));
    expect(codexUserConfigPath({ CODEX_HOME: "D:\\codex" })).toBe(join("D:\\codex", "config.toml"));
    expect(codexUserConfigPath({ USERPROFILE: "C:\\Users\\a" })).toBe(join("C:\\Users\\a", ".codex", "config.toml"));
  });
});

describe("Claude Code: setup, the switch, a refresh and a teammate", () => {
  test("setup with --yes keeps the person's own status line and adds nothing, and their file is never written", () => {
    for (const claudeOwn of [true, false]) {
      const m = machine({ claudeOwn });
      const before = sha(m.claudeUser);
      const dir = setUp(m, "claude");
      expect(json(join(dir, ".claude", "settings.json")).statusLine).toBeUndefined();
      if (STATUSLINE_UNASKED_DEFAULT === "nothing" || claudeOwn) {
        expect(existsSync(claudeLocal(dir))).toBe(false);
      } else {
        expect(json(claudeLocal(dir)).statusLine).toEqual(NATIVE_STATUS_LINE);
      }
      expect(sha(m.claudeUser)).toBe(before);
    }
  });

  test("the switch turns it on and off in one line each, and says the way back", () => {
    const m = machine({ claudeOwn: true });
    const before = sha(m.claudeUser);
    const dir = setUp(m, "claude");
    const on = run(m, ["config", "--statusline", "on", "--project-dir", dir]);
    expect(on.status, on.out).toBe(0);
    expect(on.stdout).toBe("AI-DLC's status line shows in this project; /aidlc --statusline off gives yours back.\n");
    expect(json(claudeLocal(dir)).statusLine).toEqual(NATIVE_STATUS_LINE);
    expect(personalRecord(dir)).toBe("on");
    const again = run(m, ["config", "--statusline", "on", "--project-dir", dir]);
    expect(again.stdout).toBe("AI-DLC's status line already shows in this project; /aidlc --statusline off gives yours back.\n");
    const off = run(m, ["config", "--statusline", "off", "--project-dir", dir, "--json"]);
    expect(off.status, off.out).toBe(0);
    expect(JSON.parse(off.stdout)).toEqual(expect.objectContaining({
      ok: true,
      message: "Your own status line shows again in this project; /aidlc --statusline on brings AI-DLC's back.",
      data: { statusline: [{ harness: "claude", on: false, changed: true }] },
    }));
    expect(existsSync(claudeLocal(dir))).toBe(false);
    expect(personalRecord(dir)).toBe("off");
    expect(json(join(dir, ".claude", "settings.json")).statusLine).toBeUndefined();
    expect(sha(m.claudeUser)).toBe(before);
    // A refresh after "off" adds nothing back.
    setUp(m, "claude", dir);
    expect(existsSync(claudeLocal(dir))).toBe(false);
  });

  test("a refresh keeps AI-DLC's status line where the project had it and says the line once, never again", () => {
    const m = machine({ claudeOwn: true });
    const dir = setUp(m, "claude");
    asEarlierRelease(dir);
    const refresh = run(m, ["config", "--project-dir", dir, "--from", join(RUNTIME, "claude"), "--harness", "claude", "--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(refresh.stdout).toContain("Note: AI-DLC's status line replaces yours here; /aidlc --statusline off gives yours back.");
    expect(json(join(dir, ".claude", "settings.json")).statusLine).toBeUndefined();
    expect(json(claudeLocal(dir)).statusLine).toEqual(NATIVE_STATUS_LINE);
    expect(json(join(dir, ".claude", "tools", "data", "aidlc-manifest.json")).statusLineKept).toBe(true);
    const second = run(m, ["config", "--project-dir", dir, "--from", join(RUNTIME, "claude"), "--harness", "claude", "--yes"]);
    expect(second.status, second.out).toBe(0);
    expect(second.stdout).not.toContain("status line");
    expect(json(join(dir, ".claude", "tools", "data", "aidlc-manifest.json")).statusLineKept).toBe(true);
  });

  test("a teammate's clone is untouched by one person's choice and keeps the project's status line at its first chat", () => {
    const author = machine();
    const dir = setUp(author, "claude");
    asEarlierRelease(dir);
    expect(run(author, ["config", "--project-dir", dir, "--from", join(RUNTIME, "claude"), "--harness", "claude", "--yes"]).status)
      .toBe(0);
    // The author turns it off for themselves.
    expect(run(author, ["config", "--statusline", "off", "--project-dir", dir]).status).toBe(0);
    // What the teammate clones: the committed files, none of the author's own.
    const clone = project("aidlc-statusline-clone-");
    cpSync(join(dir, ".claude"), join(clone, ".claude"), { recursive: true });
    cpSync(join(dir, "aidlc"), join(clone, "aidlc"), { recursive: true });
    for (const file of [".gitignore", "aidlc.settings.json", ".mcp.json"]) {
      if (existsSync(join(dir, file))) cpSync(join(dir, file), join(clone, file));
    }
    expect(existsSync(claudeLocal(clone))).toBe(false);
    expect(existsSync(join(clone, "aidlc.settings.local.json"))).toBe(false);
    const teammate = machine({ claudeOwn: true });
    const before = sha(teammate.claudeUser);
    const started = run(teammate, ["engine", "hook", "session-start"], {
      tool: join(clone, ".claude", "tools", "aidlc.ts"),
      env: { CLAUDE_PROJECT_DIR: clone },
      input: JSON.stringify({ session_id: "11111111-1111-4111-8111-111111111111", source: "startup", hook_event_name: "SessionStart" }),
    });
    expect(started.status, started.out).toBe(0);
    expect(started.stdout).toContain(
      'TELL ONCE: in your first reply, tell the person this, in their language: \\"AI-DLC\'s status line replaces yours here; /aidlc --statusline off gives yours back.\\"',
    );
    expect(json(claudeLocal(clone)).statusLine).toEqual(NATIVE_STATUS_LINE);
    expect(personalRecord(clone)).toBe("kept");
    // The author's own choice stays theirs.
    expect(personalRecord(dir)).toBe("off");
    expect(existsSync(claudeLocal(dir))).toBe(false);
    // The next chat says nothing.
    const next = run(teammate, ["engine", "hook", "session-start"], {
      tool: join(clone, ".claude", "tools", "aidlc.ts"),
      env: { CLAUDE_PROJECT_DIR: clone },
      input: JSON.stringify({ session_id: "22222222-2222-4222-8222-222222222222", source: "startup", hook_event_name: "SessionStart" }),
    });
    expect(next.stdout).not.toContain("status line");
    expect(sha(teammate.claudeUser)).toBe(before);
  });

  test("first-run setup asks once, recommends keeping theirs, and saves the answer in the personal file only", () => {
    for (const [claudeOwn, answer] of [[true, ""], [false, ""], [true, "2"]] as const) {
      const m = machine({ claudeOwn });
      const before = sha(m.claudeUser);
      const dir = project();
      const bin = temp("aidlc-statusline-bin-");
      const wizard = run(m, ["config", "--project-dir", dir], {
        input: `1\n${answer}\n`,
        env: {
          PATH: bin,
          AIDLC_TEST_CONFIG_TTY: "1",
          AIDLC_TEST_CONFIG_DETECTION_JSON: JSON.stringify({
            harnesses: { claude: { found: true, version: "claude 2.1.220", path: join(bin, "claude") } },
            aws: { hasCredentials: true, sources: ["instance role"], profiles: [], regions: ["us-east-2"], files: [] },
            runtimeIssues: [],
            bedrockReachable: true,
          }),
          TMPDIR: m.root,
          TMP: m.root,
          TEMP: m.root,
        },
      });
      expect(wizard.status, wizard.out).toBe(0);
      expect(wizard.stdout.split(CLAUDE_STATUS_LINE_QUESTION).length - 1).toBe(1);
      expect(wizard.stdout).toContain(claudeOwn ? "1. No, keep mine  (recommended)" : "1. Yes  (recommended)");
      const on = claudeOwn ? answer === "2" : true;
      expect(json(join(dir, ".claude", "settings.json")).statusLine).toBeUndefined();
      if (on) {
        expect(json(claudeLocal(dir)).statusLine).toEqual(NATIVE_STATUS_LINE);
        expect(personalRecord(dir)).toBe("on");
      } else {
        expect(existsSync(claudeLocal(dir))).toBe(false);
        expect(personalRecord(dir)).toBe("off");
        expect(wizard.stdout).toContain(
          "Your own status line stays in this project; /aidlc --statusline on shows AI-DLC's progress there instead.",
        );
      }
      expect(sha(m.claudeUser)).toBe(before);
      // Setting up again asks nothing.
      const again = run(m, ["config", "--project-dir", dir, "--from", join(RUNTIME, "claude"), "--harness", "claude", "--yes"]);
      expect(again.stdout).not.toContain(CLAUDE_STATUS_LINE_QUESTION);
    }
  });

  test("doctor never reads the status line as switched-off enforcement", () => {
    const m = machine();
    const dir = setUp(m, "claude");
    for (const state of ["off", "on"]) {
      expect(run(m, ["config", "--statusline", state, "--project-dir", dir]).status).toBe(0);
      const doctor = run(m, ["--doctor", "--json", "--offline"], {
        tool: join(dir, ".claude", "tools", "aidlc.ts"),
        env: { AIDLC_HARNESS_DIR: ".claude", CLAUDE_PROJECT_DIR: dir },
      });
      const checks = (JSON.parse(doctor.stdout).data?.checks ?? []) as Array<{ label: string; pass: boolean }>;
      expect(checks.some((check) => check.label.includes("aidlc-statusline.ts shipped but not wired")), state).toBe(false);
      if (state === "on") expect(checks.find((check) => check.label === "aidlc-statusline.ts present")?.pass).toBe(true);
    }
  });
});

describe("Codex CLI: the project's shared config", () => {
  test("setup writes no status line; the switch adds and removes only AI-DLC's line and says it is for everyone", () => {
    const m = machine({ codexOwn: true });
    const before = sha(m.codexUser);
    const dir = setUp(m, "codex");
    const shared = join(dir, ".codex", "config.toml");
    const installed = readFileSync(shared, "utf-8");
    expect((Bun.TOML.parse(installed) as Record<string, unknown>).tui).toBeUndefined();
    const on = run(m, ["config", "--statusline", "on", "--project-dir", dir]);
    expect(on.status, on.out).toBe(0);
    expect(on.stdout).toBe(
      "AI-DLC's progress shows in the status line for everyone working in this project (.codex/config.toml); " +
        "$aidlc --statusline off takes it out. Each person can add task progress to their own status line with Codex's /statusline instead.\n",
    );
    expect((Bun.TOML.parse(readFileSync(shared, "utf-8")) as { tui: { status_line: string[] } }).tui.status_line).toEqual(ITEMS);
    const off = run(m, ["config", "--statusline", "off", "--project-dir", dir]);
    expect(off.stdout).toBe(
      "AI-DLC's progress is out of the status line for everyone working in this project (.codex/config.toml); " +
        "$aidlc --statusline on puts it in. Each person can add task progress to their own status line with Codex's /statusline.\n",
    );
    expect(readFileSync(shared, "utf-8")).toBe(installed);
    expect(sha(m.codexUser)).toBe(before);
  });

  test("a refresh keeps the status line a project already had, and tells the person whose own it covers once", () => {
    const m = machine({ codexOwn: true });
    const before = sha(m.codexUser);
    const dir = setUp(m, "codex");
    const shared = join(dir, ".codex", "config.toml");
    writeFileSync(
      shared,
      `${readFileSync(shared, "utf-8")}\n# Statusline (D-6): predefined item IDs only; task-progress is fed by the\n` +
        `# update_plan tool, which the orchestrator skill keeps current per stage.\n[tui]\nstatus_line = ${JSON.stringify(ITEMS).replaceAll(",", ", ")}\n`,
    );
    const refresh = run(m, ["config", "--project-dir", dir, "--from", join(RUNTIME, "codex"), "--harness", "codex", "--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(refresh.stdout).toContain(
      "Note: AI-DLC's status line replaces yours in this project; $aidlc --statusline off takes it out for everyone working here, " +
        "or add task progress to your own with Codex's /statusline.",
    );
    expect((Bun.TOML.parse(readFileSync(shared, "utf-8")) as { tui: { status_line: string[] } }).tui.status_line).toEqual(ITEMS);
    const second = run(m, ["config", "--project-dir", dir, "--from", join(RUNTIME, "codex"), "--harness", "codex", "--yes"]);
    expect(second.stdout).not.toContain("status line");
    // Off takes the table and AI-DLC's comment lines out with it.
    expect(run(m, ["config", "--statusline", "off", "--project-dir", dir]).status).toBe(0);
    const after = readFileSync(shared, "utf-8");
    expect((Bun.TOML.parse(after) as Record<string, unknown>).tui).toBeUndefined();
    expect(after).not.toMatch(/^\[tui\]$/m);
    expect(after).not.toContain("Statusline (D-6)");
    expect(sha(m.codexUser)).toBe(before);
  });

  test("only AI-DLC's line is edited: the project's other [tui] keys, comments, line endings and own status line stay", () => {
    const dir = temp("aidlc-statusline-codex-file-");
    mkdirSync(join(dir, ".codex"));
    const shared = join(dir, ".codex", "config.toml");
    const original = 'model = "x"\r\n\r\n[tui]\r\n# our theme\r\ntheme = "dark"\r\n\r\n[agents]\r\nmax_depth = 1\r\n';
    writeFileSync(shared, original);
    expect(setCodexStatusLine(dir, true, ITEMS).changed).toBe(true);
    const on = readFileSync(shared, "utf-8");
    expect(on).not.toMatch(/[^\r]\n/);
    expect(Bun.TOML.parse(on)).toEqual({ model: "x", tui: { theme: "dark", status_line: ITEMS }, agents: { max_depth: 1 } });
    expect(setCodexStatusLine(dir, false, ITEMS).changed).toBe(true);
    expect(readFileSync(shared, "utf-8")).toBe(original);

    writeFileSync(shared, '[tui]\nstatus_line = ["model"]\n');
    expect(setCodexStatusLine(dir, false, ITEMS)).toEqual({ changed: false, keptOwn: true });
    expect(setCodexStatusLine(dir, true, ITEMS)).toEqual({ changed: true, replacedOwn: true });
    expect((Bun.TOML.parse(readFileSync(shared, "utf-8")) as { tui: { status_line: string[] } }).tui.status_line).toEqual(ITEMS);

    const inline = 'tui = { status_line = ["model"], theme = "dark" }\n';
    writeFileSync(shared, inline);
    expect(() => setCodexStatusLine(dir, true, ITEMS)).toThrow("does not edit");
    expect(readFileSync(shared, "utf-8")).toBe(inline);
  });

  test("first-run setup asks the Codex question once and says it applies to everyone", () => {
    const m = machine();
    const dir = project();
    const bin = temp("aidlc-statusline-bin-");
    const wizard = run(m, ["config", "--project-dir", dir], {
      input: "1\n2\n",
      env: {
        PATH: bin,
        AIDLC_TEST_CONFIG_TTY: "1",
        AIDLC_TEST_CONFIG_DETECTION_JSON: JSON.stringify({
          harnesses: { codex: { found: true, version: "codex-cli 0.160.0", path: join(bin, "codex") } },
          aws: { hasCredentials: true, sources: ["instance role"], profiles: [], regions: ["us-east-2"], files: [] },
          runtimeIssues: [],
          bedrockReachable: true,
        }),
        TMPDIR: m.root,
        TMP: m.root,
        TEMP: m.root,
      },
    });
    expect(wizard.status, wizard.out).toBe(0);
    expect(wizard.stdout.split(CODEX_STATUS_LINE_QUESTION).length - 1).toBe(1);
    expect(wizard.stdout).toContain("1. Yes, for everyone in this project  (recommended)");
    expect(wizard.stdout).toContain("Status lines stay as they are for everyone working in this project");
    expect((Bun.TOML.parse(readFileSync(join(dir, ".codex", "config.toml"), "utf-8")) as Record<string, unknown>).tui)
      .toBeUndefined();
    expect(personalRecord(dir)).toBe("off");
  });
});

describe("the chat switch", () => {
  test("/aidlc --statusline on|off runs the config switch for this tool and stops; anything else gets the usage line", () => {
    const m = machine();
    const dir = setUp(m, "claude");
    const off = run(m, ["next", "--project-dir", dir, "--statusline", "off"], { tool: ORCHESTRATE, env: { CLAUDE_PROJECT_DIR: dir } });
    const directive = JSON.parse(off.stdout.trim()) as { kind: string; message: string };
    expect(directive.kind).toBe("print");
    expect(directive.message).toContain("config --statusline off --harness claude`, print its output verbatim, then stop.");
    const bad = run(m, ["next", "--project-dir", dir, "--statusline", "maybe"], { tool: ORCHESTRATE, env: { CLAUDE_PROJECT_DIR: dir } });
    expect(JSON.parse(bad.stdout.trim())).toEqual(expect.objectContaining({ kind: "error", message: "Usage: /aidlc --statusline on|off." }));
  });

  test("a tool with no status line says so in one line", () => {
    const m = machine();
    const dir = setUp(m, "kiro" as never);
    const result = run(m, ["config", "--statusline", "on", "--project-dir", dir]);
    expect(result.status, result.out).toBe(0);
    expect(result.stdout).toBe("Kiro CLI has no status line for AI-DLC's progress; /aidlc --status shows where the work stands.\n");
  });
});
