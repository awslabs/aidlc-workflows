// covers: function:hooksOffAgentStep, function:fillHookActivationText, function:hookStatusPathLinked, function:hookLiveness, function:unattendedHumanPresenceHint, subcommand:aidlc-orchestrate:next
//
// When the engine KNOWS a harness's hooks have never run in the joined
// workflow, `next` does no work. It tells the agent what to do itself and the
// one line to show the person, in the tool's own words, and nothing about
// hooks, the engine, or why. The lines are the ones that worked in live runs
// on each tool. Only a hard signal stops: a harness that declares the step
// (its hook on the agent's own shell command beats before the engine runs), a
// workflow with stage progress, and no heartbeat at all in that record. There
// is no stop when the run is unattended, when the person switched the presence
// check off, when the conversation has not joined the record, or when a link
// on the way to the status files keeps any heartbeat from being written.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hooksHealthDir, unattendedHumanPresenceHint } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "11111111-2222-4333-8444-555555555555";
const DIR_LINK = process.platform === "win32" ? "junction" : "dir";
const RULES =
  "Do not run AI-DLC's hook scripts yourself, do not offer to switch any AI-DLC check off, and do not " +
  "look for another cause. While you fix this, do not take on other doctor problems, and change " +
  "nothing outside this project's folder.";

type Harness = { name: string; dir: string; lines: (proj: string) => string[] };
const root = (h: { name: string }) => join(REPO_ROOT, "dist", h.name);

// Each tool's person lines, from the live runs that got the hooks running.
const HARNESSES: Harness[] = [
  {
    name: "claude",
    dir: ".claude",
    lines: () => [
      "Choose Yes when Claude Code asks to change this project's settings, then answer the question below.",
      "Your organization's Claude Code settings block this project. Ask your Claude Code administrator to allow project hooks.",
    ],
  },
  {
    name: "codex",
    dir: ".codex",
    lines: () => ["In Codex, type /hooks, press t to trust all, then press Esc. Then carry on here."],
  },
  {
    name: "copilot",
    dir: ".aidlc",
    lines: () => [
      "Fixed. Send your next message here to carry on.",
      "Fixed. Answer the question below to carry on.",
      "Your organization has switched off Chat: Use Hooks in VS Code. Ask your administrator to turn it on.",
    ],
  },
  {
    name: "kiro",
    dir: ".kiro",
    lines: () => [
      "Type /agent and pick aidlc, then carry on.",
      "Quit Kiro and start it again in this folder with: kiro-cli chat --agent-engine v2 --agent aidlc",
    ],
  },
  {
    name: "opencode",
    dir: ".aidlc",
    lines: (proj) => [
      `Quit opencode and start it again with just \`opencode\` in ${proj}, then type /aidlc to carry on.`,
    ],
  },
];
const COPILOT = HARNESSES[2];

const projects: string[] = [];
const outsides: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
  for (const dir of outsides) rmSync(dir, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function installed(h: { name: string }): string {
  let proj = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-hooks-off-"));
  try {
    proj = realpathSync(proj);
  } catch {
    // Keep the temp path as created.
  }
  proj = toPortablePath(proj);
  projects.push(proj);
  cpSync(root(h), proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  return proj;
}

// The person's own chat: the presence check on, attended. The runner's fixture
// profile switches the check off, so each spawn says what it means.
function attendedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "AIDLC_PROJECT_DIR",
    "CLAUDE_PROJECT_DIR",
    "AIDLC_HARNESS_NAME",
    "AIDLC_HARNESS_DIR",
    "AIDLC_SESSION_OVERRIDE",
    "AIDLC_COMPILED_EXECUTABLE",
    "AIDLC_RUNTIME_ROOT",
    "AIDLC_RUNTIME_HARNESS_ROOT",
    "AIDLC_COPILOT_SESSION_ID",
    "AIDLC_UNATTENDED",
  ]) delete env[key];
  env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "0";
  return { ...env, ...extra };
}

function run(proj: string, argv: string[], env: NodeJS.ProcessEnv, input = "") {
  const r = spawnSync(process.execPath, argv, {
    cwd: proj,
    input,
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function intentCreate(proj: string, h: Harness): void {
  const r = run(proj, [
    join(proj, h.dir, "tools", "aidlc-utility.ts"),
    "intent-create",
    "--scope",
    "bugfix",
    "--label",
    "hooks off",
    "--arguments",
    "fix the flag parser",
  ], attendedEnv());
  expect(r.code, r.stderr).toBe(0);
}

type Printed = { kind: string; message?: string };

function next(proj: string, h: Harness, extra: Record<string, string> = {}, args: string[] = []): Printed {
  const r = run(proj, [join(proj, h.dir, "tools", "aidlc-orchestrate.ts"), "next", ...args], attendedEnv(extra));
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Printed;
}

// What `next` returns when it stops for hooks that never ran.
function isStop(directive: Printed): boolean {
  return directive.kind === "print" && (directive.message ?? "").startsWith(RULES);
}

function beat(proj: string, hook: string): void {
  const dir = hooksHealthDir(proj);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hook}.last`), new Date().toISOString(), "utf-8");
}

describe("next stops with the agent's step when the engine knows the hooks never ran", () => {
  for (const h of HARNESSES) {
    test(`${h.name}: the agent is told its own step and the exact line; a heartbeat lets next run`, () => {
      const proj = installed(h);
      intentCreate(proj, h);
      const stopped = next(proj, h);
      expect(isStop(stopped), JSON.stringify(stopped)).toBe(true);
      const message = stopped.message ?? "";
      for (const line of h.lines(proj)) expect(message).toContain(`"${line}"`);
      // Every placeholder is filled for this install, and no switch-off is offered.
      expect(message).not.toMatch(/<(entry|next|folder)>/);
      expect(message).not.toMatch(/AIDLC_SKIP_|--bypass|guard\.[a-z-]+ off/);
      beat(proj, "reviewer-scope");
      expect(isStop(next(proj, h))).toBe(false);
    });
  }

  test("Claude's step runs the engine's own next command again, so the waiting question shows again", () => {
    const h = HARNESSES[0];
    const proj = installed(h);
    intentCreate(proj, h);
    const message = next(proj, h).message ?? "";
    expect(message).toContain("`bun .claude/tools/aidlc.ts engine orchestrate next`");
    expect(message).toContain("do not ask for a restart and do not mention /hooks");
  });

  test("Claude's step runs the stopped command again, so what it carried goes on", () => {
    const h = HARNESSES[0];
    const proj = installed(h);
    intentCreate(proj, h);
    const message = next(proj, h, {}, ["--", "carry on with the parser"]).message ?? "";
    expect(message).toContain("`bun .claude/tools/aidlc.ts engine orchestrate next -- 'carry on with the parser'`");
  });

  test("a next that only asks runs as asked: status, help, version, doctor", () => {
    const proj = installed(COPILOT);
    intentCreate(proj, COPILOT);
    for (const ask of ["--status", "--help", "--version", "--doctor"]) {
      expect(isStop(next(proj, COPILOT, {}, [ask])), ask).toBe(false);
    }
    expect(isStop(next(proj, COPILOT))).toBe(true);
  });

  test("the hook on the agent's own command beats first, so a host that runs hooks never sees the stop", () => {
    const proj = installed(COPILOT);
    // Both checks switched off from the start of the chat: their hooks still say they ran.
    const off = { AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "1", AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" };
    const host = (target: string, payload: Record<string, unknown>) => {
      const r = run(
        proj,
        [join(proj, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target],
        attendedEnv(off),
        JSON.stringify({ session_id: SESSION, cwd: proj, ...payload }),
      );
      expect(r.code, `${target}: ${r.stderr}`).toBe(0);
    };
    host("session-start", { hook_event_name: "SessionStart", source: "new" });
    intentCreate(proj, COPILOT);
    host("guard-tool-call", {
      hook_event_name: "PreToolUse",
      tool_name: "run_in_terminal",
      tool_input: { command: "bun .aidlc/tools/aidlc-orchestrate.ts next" },
    });
    const health = hooksHealthDir(proj);
    expect(existsSync(join(health, "review-freeze.last"))).toBe(true);
    expect(existsSync(join(health, "plan-approval-guard.last"))).toBe(true);
    expect(isStop(next(proj, COPILOT))).toBe(false);
  });

  test("the person carries on: unattended, or with the presence check switched off", () => {
    const proj = installed(COPILOT);
    intentCreate(proj, COPILOT);
    expect(isStop(next(proj, COPILOT, { AIDLC_UNATTENDED: "1" }))).toBe(false);
    expect(isStop(next(proj, COPILOT, { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" }))).toBe(false);
    expect(isStop(next(proj, COPILOT))).toBe(true);
  });

  test("a conversation that has not joined the workflow is not stopped", () => {
    const proj = installed(COPILOT);
    intentCreate(proj, COPILOT);
    // A teammate's clone: the record is there, this machine never selected it.
    rmSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), { force: true });
    expect(isStop(next(proj, COPILOT))).toBe(false);
  });

  test("a link on the way to the status files is not read as hooks that never ran", () => {
    const proj = installed(COPILOT);
    intentCreate(proj, COPILOT);
    const health = hooksHealthDir(proj);
    mkdirSync(dirname(health), { recursive: true });
    rmSync(health, { recursive: true, force: true });
    const outside = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-hooks-off-outside-"));
    outsides.push(outside);
    symlinkSync(outside, health, DIR_LINK);
    expect(isStop(next(proj, COPILOT))).toBe(false);
    try {
      unlinkSync(health);
    } catch {
      rmSync(health, { force: true });
    }
  });

  for (const name of ["kiro-ide", "cursor"]) {
    test(`${name} declares no step yet, so next never stops for this there`, () => {
      const h: Harness = { name, dir: name === "cursor" ? ".cursor" : ".kiro", lines: () => [] };
      const proj = installed(h);
      intentCreate(proj, h);
      expect(isStop(next(proj, h))).toBe(false);
    });
  }
});

describe("a refusal for a reply that was not recorded carries the same step", () => {
  test("it never asks the person to answer again, and gives the tool's own line", () => {
    const saved = process.env.AIDLC_UNATTENDED;
    delete process.env.AIDLC_UNATTENDED;
    try {
      const hint = unattendedHumanPresenceHint();
      expect(hint).toContain("do not ask them to answer again");
      expect(hint).toContain(RULES);
      expect(hint).toContain(`"${HARNESSES[0].lines("")[0]}"`);
    } finally {
      if (saved !== undefined) process.env.AIDLC_UNATTENDED = saved;
    }
  });
});
