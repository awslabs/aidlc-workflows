// covers: function:discoverableRuntimeHarness, function:callingHarness, function:harnessIsAGuess, function:pinRuntimeHarness, function:inHostShell, function:entrySkillInvocation, function:treeEntrySkillInvocation, function:hooksOffAgentStep, function:unattendedHumanPresenceHint, function:newChatStep, function:renderInitRunner, function:hostNamedChat, tool:aidlc, subcommand:aidlc-orchestrate:next
//
// In a project with more than one tool set up, the native `aidlc` tells each
// tool its own steps. Which tool ran a command is read from the mark the tool
// itself puts on the commands its agent runs (each manifest's hostShell), so
// the engine runs on that tool's setup, as the copy channel and a project with
// one tool set up already do. Where no tool's mark is there, or more than one
// is, it runs on the first one installed, as before, and names no tool's step:
// no hooks-off step, the plain missed-reply line, no clean-chat step, and
// /aidlc as the entry. Files written into a tree keep that tree's own entry.
//
// Measured on main 01dc30d64 with a binary built from its release tree: in a
// project with Claude Code and Kiro set up, `next` in a Kiro CLI chat before
// any work, with no hook run yet, told the agent "Claude Code is not running
// AI-DLC's hooks in this project" and to set disableAllHooks in
// .claude/settings.local.json, and work that chat started was bound to no chat.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { cleanupTestProject, REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";
import {
  NATIVE_COMPILE_TIMEOUT_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { discoverableRuntimeHarness } from "../../core/tools/aidlc-runtime-paths.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// What a native install ships: `aidlc` plus every harness runtime beside it.
const RELEASE_ROOT = join(REPO_ROOT, "dist-release");
const RULES = "Do not run AI-DLC's hook scripts yourself";
const NOTHING_YET = "Tell me what to build and I'll start it.";
const KIRO_CHAT = "01995000-7a11-7000-8000-00000000c1e1";

// Each tree, the folder it installs, and the mark its tool puts on every
// command its agent runs (the values a live chat carries are ids, so any id).
type Tree = { tree: string; dir: string; mark: Record<string, string> };
const TREES: Record<string, Tree> = {
  claude: { tree: "claude", dir: ".claude", mark: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "01995000-7a11-7000-8000-00000000c1e2" } },
  codex: { tree: "codex", dir: ".codex", mark: { CODEX_THREAD_ID: "01995000-7a11-7000-8000-00000000c1e3" } },
  copilot: { tree: "copilot", dir: ".aidlc", mark: { COPILOT_CLI: "1" } },
  cursor: { tree: "cursor", dir: ".cursor", mark: { CURSOR_AGENT: "1" } },
  kiro: { tree: "kiro", dir: ".kiro", mark: { KIRO_SESSION_ID: KIRO_CHAT } },
  "kiro-ide": { tree: "kiro-ide", dir: ".kiro", mark: { KIRO_SESSION_ID: KIRO_CHAT } },
  opencode: { tree: "opencode", dir: ".aidlc", mark: { OPENCODE: "1" } },
};
// The folders in the order a project's installs are found.
const FOUND_FIRST = [".claude", ".kiro", ".codex", ".cursor", ".aidlc"];

const temps: string[] = [];
const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// The engine's own variables and every tool's marks come from the case, never
// from the shell the tests run in (often a chat of one of these tools).
const CASE_OWNED = /^(?:CLAUDE|CODEX_|COPILOT_|CURSOR_|KIRO_|OPENCODE|VSCODE_|TERM_PROGRAM$)/i;
const ENGINE_PINS = [
  "AIDLC_PROJECT_DIR",
  "AIDLC_RUNTIME_PROJECT_DIR",
  "AIDLC_HARNESS_DIR",
  "AIDLC_HARNESS_DIR_GUESSED",
  "AIDLC_HARNESS_NAME",
  "AIDLC_COMPILED_EXECUTABLE",
  "AIDLC_RUNTIME_ROOT",
  "AIDLC_RUNTIME_HARNESS_ROOT",
  "AIDLC_SESSION_OVERRIDE",
  "AIDLC_SESSION_OVERRIDE_SOURCE",
  "AIDLC_COPILOT_SESSION_ID",
  "AIDLC_UNATTENDED",
];
function caseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!CASE_OWNED.test(key) && !ENGINE_PINS.includes(key)) env[key] = value;
  }
  // The person's own chat: the presence check on, attended.
  return { ...env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", ...extra };
}

function tempDir(prefix: string): string {
  let dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
  try {
    dir = realpathSync(dir);
  } catch {
    // Keep the path as created.
  }
  return toPortablePath(dir);
}

// A project set up for these trees as the native `aidlc config` sets it up.
function project(trees: string[]): string {
  const proj = tempDir("aidlc-caller-");
  projects.push(proj);
  for (const tree of trees) cpSync(join(RELEASE_ROOT, tree), proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  return proj;
}

// The compiled `aidlc`, built once from the release's Claude tree as
// scripts/build-binaries.ts builds it, with the runtime beside it.
let binary = "";
beforeAll(() => {
  const root = tempDir("aidlc-caller-native-");
  temps.push(root);
  binary = join(root, process.platform === "win32" ? "aidlc.exe" : "aidlc");
  const built = spawnSync(
    process.execPath,
    ["build", "--compile", join(RELEASE_ROOT, "claude", ".claude", "tools", "aidlc.ts"), "--outfile", binary],
    { cwd: REPO_ROOT, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS) },
  );
  expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
  symlinkSync(RELEASE_ROOT, join(root, "runtime"), "junction");
});

type Step = { kind: string; message?: string; narration?: string };

function aidlc(proj: string, args: string[], marks: Record<string, string>) {
  const r = spawnSync(binary, args, {
    cwd: proj,
    encoding: "utf-8",
    env: caseEnv(marks),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout;
}

// `next` before any work, the way the agent runs it, with the project's own
// folder written as <project> so two projects' steps compare.
function next(proj: string, marks: Record<string, string>): Step {
  const out = aidlc(proj, ["engine", "orchestrate", "next"], marks).trim();
  let text = out;
  for (const path of new Set([proj, normalize(proj), proj.replace(/\//g, "\\")])) {
    text = text.replaceAll(JSON.stringify(path).slice(1, -1), "<project>");
  }
  return JSON.parse(text) as Step;
}

const isStop = (step: Step) => step.kind === "print" && (step.message ?? "").startsWith(RULES);
const nothingYet = (step: Step) => step.kind === "print" && step.narration === NOTHING_YET;

// Each tree alone, read once: the step its own tool gets, and with no mark.
const alone = new Map<string, Step>();
function aloneStep(tree: string): Step {
  let step = alone.get(tree);
  if (!step) {
    step = next(project([tree]), TREES[tree].mark);
    alone.set(tree, step);
  }
  return step;
}

describe("t-native-engine-caller-lines: a native engine in a project with two tools set up tells each its own steps", () => {
  test("Claude Code and Kiro set up: a Kiro CLI chat gets Kiro's step, never Claude Code's", () => {
    const proj = project(["claude", "kiro-ide"]);
    const kiro = next(proj, TREES["kiro-ide"].mark);
    expect(isStop(kiro), JSON.stringify(kiro)).toBe(true);
    expect(kiro.message).not.toContain("Claude Code");
    expect(kiro.message).not.toContain(".claude/settings.local.json");
    expect(kiro).toEqual(aloneStep("kiro-ide"));
    // Claude Code beside it keeps its own step.
    expect(next(proj, TREES.claude.mark)).toEqual(aloneStep("claude"));
  });

  test("a chat no tool's mark is on, or two tools' marks, hears no tool's step", () => {
    const proj = project(["claude", "kiro-ide"]);
    expect(nothingYet(next(proj, {}))).toBe(true);
    expect(nothingYet(next(proj, { ...TREES.claude.mark, ...TREES["kiro-ide"].mark }))).toBe(true);
  });

  for (const [first, second] of [["kiro", "cursor"], ["claude", "codex"], ["claude", "opencode"], ["codex", "copilot"]]) {
    test(`${first} and ${second} set up: each tool's chat gets what it gets with only its own setup`, () => {
      const proj = project([first, second]);
      for (const tree of [first, second]) expect(next(proj, TREES[tree].mark), tree).toEqual(aloneStep(tree));
    });
  }

  test("one tool set up: its own mark and no mark read the same, for every tree", () => {
    for (const tree of Object.keys(TREES)) {
      const proj = project([tree]);
      expect(next(proj, {}), tree).toEqual(next(proj, TREES[tree].mark));
    }
  });

  test("work a Kiro CLI chat starts beside Claude Code's setup is bound to that Kiro chat, as with Kiro alone", () => {
    const bound = (trees: string[]): boolean => {
      const proj = project(trees);
      aidlc(proj, ["engine", "intent", "create", "--scope", "poc", "--label", "lunch-poll", "--arguments", "build a lunch poll"], TREES["kiro-ide"].mark);
      return existsSync(join(proj, "aidlc", ".aidlc-sessions", `${KIRO_CHAT}.binding.json`));
    };
    expect(bound(["kiro-ide"])).toBe(true);
    expect(bound(["claude", "kiro-ide"])).toBe(true);
  });
});

// The lines a tool-specific step rides, read in a fresh process from a tree's
// own tools, with the engine pinned to that tree as the dispatcher pins it:
// marked as a guess, or not.
function linesIn(tree: string, proj: string, guessed: boolean, extra: Record<string, string> = {}) {
  const tools = join(REPO_ROOT, "dist", tree, TREES[tree].dir, "tools");
  const code = [
    `const lib = await import(${JSON.stringify(join(tools, "aidlc-lib.ts"))});`,
    `const chat = await import(${JSON.stringify(join(tools, "aidlc-new-chat.ts"))});`,
    `const paths = await import(${JSON.stringify(join(tools, "aidlc-runtime-paths.ts"))});`,
    `const runners = await import(${JSON.stringify(join(tools, "aidlc-runner-gen.ts"))});`,
    `const proj = ${JSON.stringify(proj)};`,
    "console.log(JSON.stringify({",
    "  hooksOff: lib.hooksOffAgentStep(proj),",
    "  reply: lib.unattendedHumanPresenceHint(proj),",
    "  newChat: chat.newChatStep(),",
    "  entry: paths.entrySkillInvocation(),",
    "  runner: runners.renderInitRunner(),",
    "}));",
  ].join("\n");
  const dir = TREES[tree].dir;
  const r = spawnSync(process.execPath, ["--eval", code], {
    cwd: proj,
    encoding: "utf-8",
    env: caseEnv({
      AIDLC_PROJECT_DIR: proj,
      AIDLC_HARNESS_DIR: dir,
      AIDLC_HARNESS_NAME: tree,
      ...(guessed ? { AIDLC_HARNESS_DIR_GUESSED: dir } : {}),
      ...extra,
    }),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { hooksOff: string | null; reply: string; newChat: string | null; entry: string; runner: string };
}

describe("while the engine could only guess which tool runs a command, no tool's step is named", () => {
  test("Kiro's tree as the guess: no hooks-off step, the plain missed-reply line, no clean-chat step", () => {
    const proj = project(["kiro-ide"]);
    const own = linesIn("kiro-ide", proj, false);
    expect(own.hooksOff).toContain("kiro-cli --v3");
    expect(own.reply).toContain("Kiro");
    expect(own.newChat).toBe("type /chat new, then /aidlc");
    const guess = linesIn("kiro-ide", proj, true);
    expect(guess.hooksOff).toBeNull();
    expect(guess.reply).not.toContain("Kiro");
    expect(guess.reply).toContain("Your answer didn't reach AI-DLC.");
    expect(guess.newChat).toBeNull();
  });

  test("Kiro's switched-off reply hook is named only to Kiro", () => {
    const proj = project(["kiro-ide"]);
    const hook = join(proj, ".kiro", "hooks", "aidlc-record-human-turn.json");
    const off = { ...(JSON.parse(readFileSync(hook, "utf-8")) as Record<string, unknown>), enabled: false };
    writeFileSync(hook, `${JSON.stringify(off, null, 2)}\n`, "utf-8");
    expect(linesIn("kiro-ide", proj, false).reply).toContain("Agent Hooks");
    expect(linesIn("kiro-ide", proj, true).reply).not.toContain("Agent Hooks");
  });

  test("Codex's tree as the guess: the person is told /aidlc, and Codex's own runners still say $aidlc", () => {
    const proj = project(["codex"]);
    const own = linesIn("codex", proj, false);
    expect(own.entry).toBe("$aidlc");
    const guess = linesIn("codex", proj, true);
    expect(guess.entry).toBe("/aidlc");
    expect(guess.runner).toBe(own.runner);
    expect(guess.runner).toContain("$aidlc");
  });
});

// Only what discovery reads: each tree's harness.json and projection stamp.
function installed(trees: string[]): string {
  const proj = tempDir("aidlc-caller-pick-");
  temps.push(proj);
  for (const tree of trees) {
    const data = join(proj, TREES[tree].dir, "tools", "data");
    mkdirSync(data, { recursive: true });
    for (const file of ["harness.json", "aidlc-stamp.json"]) {
      const from = join(RELEASE_ROOT, tree, TREES[tree].dir, "tools", "data", file);
      try {
        linkSync(from, join(data, file));
      } catch {
        copyFileSync(from, join(data, file));
      }
    }
  }
  return proj;
}

describe("which tool runs a command, for every pairing of two trees", () => {
  const names = Object.keys(TREES);
  const pairs = names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b] as const))
    .filter(([a, b]) => TREES[a].dir !== TREES[b].dir);

  test("each tool's mark picks its tree; no mark or both marks pick the first found, as a guess", () => {
    expect(pairs.length).toBe(19);
    for (const [a, b] of pairs) {
      const proj = installed([a, b]);
      const first = [TREES[a].dir, TREES[b].dir].sort((x, y) => FOUND_FIRST.indexOf(x) - FOUND_FIRST.indexOf(y))[0];
      const pick = (marks: Record<string, string>) => discoverableRuntimeHarness(proj, caseEnv(marks));
      expect(pick(TREES[a].mark), `${a} beside ${b}`).toEqual({ harnessDir: TREES[a].dir, guessed: false });
      expect(pick(TREES[b].mark), `${b} beside ${a}`).toEqual({ harnessDir: TREES[b].dir, guessed: false });
      expect(pick({}), `no mark in ${a} and ${b}`).toEqual({ harnessDir: first, guessed: true });
      expect(pick({ ...TREES[a].mark, ...TREES[b].mark }), `both marks in ${a} and ${b}`)
        .toEqual({ harnessDir: first, guessed: true });
    }
  });

  test("one tree installed is never a guess, and a harness the command names is the one it runs on", () => {
    for (const tree of names) {
      expect(discoverableRuntimeHarness(installed([tree]), caseEnv()), tree).toEqual({ harnessDir: TREES[tree].dir, guessed: false });
    }
    const proj = installed(["claude", "kiro"]);
    expect(discoverableRuntimeHarness(proj, caseEnv({ AIDLC_HARNESS_DIR: ".kiro" }))).toEqual({ harnessDir: ".kiro", guessed: false });
  });
});
