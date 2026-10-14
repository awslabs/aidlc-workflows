// covers: subcommand:aidlc-init:config
//
// A check the person turns off from the chat is turned off first, and the line
// the switch prints then carries the one question about a wider place, when
// there is one that would change something: this whole project after this
// piece of work, this whole machine after this project. The agent relays that
// line. Before, the agent asked the wider-place question itself, from the
// onboarding table, and on a live macOS run it asked before the check was off
// (t-journey-check-off-on): a question in front of the person's own request.
//
// The setter's line is the same on every harness (the commands are the
// engine's); the onboarding paragraph every harness ships says to relay the
// line's question instead of building one.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, FIXTURES_DIR, REPO_ROOT, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "01995000-7a11-7000-8000-00000000e3e3";
const PROJECT_OFFER = "Do you want it off for the whole project instead?";
const MACHINE_OFFER = "Do you want it off for this whole machine instead?";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    if (dir.includes("aidlc-test-")) cleanupTestProject(dir);
    else rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): {
  proj: string;
  run: (args: string[], extra?: Record<string, string | undefined>) => string;
  said: (words: string) => void;
} {
  const proj = createTestProject();
  made.push(proj);
  // The machine's settings live in a home of the test's own, outside the project.
  const home = mkdtempSync(join(tmpdir(), "switch-home-"));
  made.push(home);
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(proj, ".claude"), { recursive: true });
  cpSync(join(REPO_ROOT, "dist", "claude", "aidlc"), join(proj, "aidlc"), { recursive: true });
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AIDLC_PROJECT_DIR"]) delete env[key];
  const tool = join(proj, ".claude", "tools", "aidlc.ts");
  const spawn = (args: string[], stdin?: string, extra: Record<string, string | undefined> = {}) =>
    Bun.spawnSync([process.execPath, tool, ...args], {
    cwd: proj,
    env: { ...env, ...extra },
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return {
    proj,
    run: (args, extra = {}) => {
      const r = spawn(args, undefined, extra);
      expect(r.exitCode, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(0);
      return r.stdout.toString().trim();
    },
    said: (words) => {
      const r = spawn(["engine", "hook", "record-human-turn"], JSON.stringify({
        hook_event_name: "UserPromptSubmit", cwd: proj, session_id: SESSION, prompt: words,
      }));
      expect(r.exitCode, r.stderr.toString()).toBe(0);
    },
  };
}

const lastLine = (out: string): string => out.split(/\r?\n/).filter((line) => line.trim() !== "").at(-1) ?? "";

describe("t-switch-offers-wider-place: the switch's own line carries the one wider-place question", () => {
  test("this piece of work: the line, then the whole project offered", () => {
    const { run, said } = workspace();
    said("turn the review freeze check off");
    const out = run(["engine", "config", "set", "guard.review-freeze", "off", "--person-words", "turn the review freeze check off"]);
    expect(out).toContain("is off for this piece of work");
    expect(lastLine(out)).toEndWith(PROJECT_OFFER);
  });

  test("this piece of work, already off there: said, and the whole project offered", () => {
    const { run, said } = workspace();
    said("turn the review freeze check off");
    run(["engine", "config", "set", "guard.review-freeze", "off", "--person-words", "turn the review freeze check off"]);
    said("turn the review freeze check off");
    const out = run(["engine", "config", "set", "guard.review-freeze", "off", "--person-words", "turn the review freeze check off"]);
    expect(out).toContain("already off");
    expect(lastLine(out)).toEndWith(PROJECT_OFFER);
  });

  test("this project: the line, then the whole machine offered", () => {
    const { run, said } = workspace();
    said("turn the review freeze check off for this project");
    const out = run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes"]);
    expect(out).toContain("is off for this project since");
    expect(lastLine(out)).toEndWith(MACHINE_OFFER);
  });

  test("this project, already off there: said, and the whole machine offered", () => {
    const { run, said } = workspace();
    said("turn the review freeze check off for this project");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes"]);
    const out = run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes"]);
    expect(out).toContain("already off for this project");
    expect(lastLine(out)).toEndWith(MACHINE_OFFER);
  });

  test("nowhere wider to go: this machine, a check with no project place, and the Guard Policy ask nothing", () => {
    const { run, said } = workspace();
    said("turn the review freeze check off for this machine");
    expect(run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--global", "--yes"])).not.toContain("?");
    said("turn the state transition check off");
    expect(run(["engine", "config", "set", "guard.state-transition", "off", "--person-words", "turn the state transition check off"]))
      .not.toContain("?");
    said("relax the change checks");
    expect(run(["engine", "config", "set", "guard-policy", "relaxed", "--person-words", "relax the change checks"])).not.toContain("?");
  });

  test("plan approval and summary confirmation for this piece of work offer the whole project too", () => {
    const { run, said } = workspace();
    said("stop asking me to approve the code plan");
    const plan = run(["engine", "config", "set", "plan-approval", "off", "--person-words", "stop asking me to approve the code plan"]);
    expect(lastLine(plan)).toEndWith(PROJECT_OFFER);
    said("turn summary confirmation off");
    const summary = run(["engine", "config", "set", "summary-confirmation", "off", "--person-words", "turn summary confirmation off"]);
    expect(lastLine(summary)).toEndWith(PROJECT_OFFER);
  });

  test("a scope change that turns a check off asks nothing: nobody asked to turn that check off", () => {
    const { proj, run, said } = workspace();
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(
      "- **Change Control**: strict (from scope feature)",
      "- **Change Control**: strict (from scope feature)\n- **Plan Approval**: on (from scope feature)\n" +
        "- **Summary Confirmation**: on (from scope feature)",
    ));
    said("change the scope to express");
    const out = run(["engine", "scope", "change", "--scope", "express", "--person-words", "change the scope to express"]);
    expect(out).toContain("Plan Approval changed");
    expect(out).not.toContain("?");
  });

  test("a wider place that already has it off is not offered", () => {
    const { run, said } = workspace();
    said("turn the review freeze check off for this machine");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--global", "--yes"]);
    said("turn the review freeze check off for this project");
    expect(run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes"])).not.toContain("?");
    said("turn the review freeze check off");
    expect(run(["engine", "config", "set", "guard.review-freeze", "off", "--person-words", "turn the review freeze check off"]))
      .not.toContain("?");
  });

  test("with the environment deciding, nothing wider is offered", () => {
    const { run, said } = workspace();
    said("turn the reviewer read scope check off");
    const out = run(["engine", "config", "set", "guard.reviewer-scope", "off", "--person-words", "turn the reviewer read scope check off"], {
      AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "1",
    });
    expect(out).not.toContain("?");
  });

  test("a command run at the person's own terminal asks nothing: no chat is there to answer", () => {
    const { run } = workspace();
    const out = run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes"], {
      AIDLC_TEST_CONFIG_TTY: "1",
      AIDLC_SESSION_OVERRIDE: undefined,
    });
    expect(out).toContain("is off for this project since");
    expect(out).not.toContain("?");
  });

  test("the onboarding every harness ships relays the line's question and builds none of its own", () => {
    // Where each harness ships the checks paragraph its agent reads.
    const shipped: Record<string, string> = {
      claude: ".claude/CLAUDE.md",
      codex: ".codex/onboarding.md",
      copilot: "AGENTS.md",
      cursor: ".cursor/rules/aidlc-onboarding.mdc",
      "kiro-ide": ".kiro/steering/aidlc-onboarding.md",
      kiro: ".kiro/steering/aidlc-onboarding.md",
      opencode: ".aidlc/onboarding.md",
    };
    for (const [harness, rel] of Object.entries(shipped)) {
      const text = readFileSync(join(REPO_ROOT, "dist", harness, rel), "utf-8").replace(/\s+/g, " ");
      expect(text, harness).toContain("The guards are the person's checks.");
      expect(text, harness).not.toContain("when the check has a wider place in the table, ask one plain question offering it");
      expect(text, harness).toContain("When the line ends with a question offering a wider place");
    }
  });
});
