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
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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
  said: (words: string) => string;
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
    // The person types `words` in the chat; the id of the message the hook kept
    // is what a setter names (--message) for what they asked.
    said: (words) => {
      const r = spawn(["engine", "hook", "record-human-turn"], JSON.stringify({
        hook_event_name: "UserPromptSubmit", cwd: proj, session_id: SESSION, prompt: words,
      }));
      expect(r.exitCode, r.stderr.toString()).toBe(0);
      const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
      const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
      expect(id).not.toBeNull();
      return id as string;
    },
  };
}

// The person's own shell: both ends a terminal, no chat bound to it, and none of
// the marks an agent's host puts on the commands it runs (the runner's own
// environment may carry its host's), as commandAtPersonsTerminal reads it.
function ownTerminal(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    AIDLC_TEST_CONFIG_TTY: "1",
    AIDLC_SESSION_OVERRIDE: undefined,
    TERM_PROGRAM: undefined,
  };
  for (const key of Object.keys(process.env)) {
    if (/^(?:CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|KIRO_|OPENCODE|COPILOT_|VSCODE_)/i.test(key)) env[key] = undefined;
  }
  return env;
}

const lastLine = (out: string): string => out.split(/\r?\n/).filter((line) => line.trim() !== "").at(-1) ?? "";

describe("t-switch-offers-wider-place: the switch's own line carries the one wider-place question", () => {
  test("this piece of work: the line, then the whole project offered", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check off");
    const out = run(["engine", "config", "set", "guard.review-freeze", "off", "--message", m1]);
    expect(out).toContain("is off for this piece of work");
    expect(lastLine(out)).toEndWith(PROJECT_OFFER);
  });

  test("this piece of work, already off there: said, and the whole project offered", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check off");
    run(["engine", "config", "set", "guard.review-freeze", "off", "--message", m1]);
    const m2 = said("turn the review freeze check off");
    const out = run(["engine", "config", "set", "guard.review-freeze", "off", "--message", m2]);
    expect(out).toContain("already off");
    expect(lastLine(out)).toEndWith(PROJECT_OFFER);
  });

  test("this project: the line, then the whole machine offered", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check off for this project");
    const out = run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m1]);
    expect(out).toContain("is off for this project since");
    expect(lastLine(out)).toEndWith(MACHINE_OFFER);
  });

  test("this project, already off there: said, and the whole machine offered", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check off for this project");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m1]);
    const out = run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m1]);
    expect(out).toContain("already off for this project");
    expect(lastLine(out)).toEndWith(MACHINE_OFFER);
  });

  // The variable decides over the files, and only 1 turns the check off, so the
  // recording does nothing where it is set: no line says the check is off. Open
  // work runs in the editor's or CLI's own environment, which the command cannot
  // see, so no line says whether it picks the switch up either.
  // An empty value is not run on Windows, where setting a variable to nothing can
  // remove it.
  test.each(process.platform === "win32" ? ["0"] : ["0", ""])("with the environment's %j outranking the file, the recording is said to do nothing, the first time and again", (value) => {
    const { run, said } = workspace();
    const env = { AIDLC_DISABLE_REVIEW_FREEZE_HOOK: value };
    const m1 = said("turn the review freeze check off for this project");
    const args = ["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m1];
    const recorded = "is recorded off for this project, but AIDLC_DISABLE_REVIEW_FREEZE_HOOK is set to something other than 1";
    for (const out of [run(args, env), run(args, env)]) {
      expect(out).toContain(recorded);
      // From a chat this line is the whole print, so it carries the way back.
      expect(out).toContain("Start the editor or CLI without AIDLC_DISABLE_REVIEW_FREEZE_HOOK for the recording to turn the check off. You can clear the recording any time.");
      expect(out).not.toContain("already off");
      expect(out).not.toContain("is off for this project since");
      expect(out).not.toContain("?");
    }
    expect(run(args, { AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "1" })).toContain("already off for this project");
    // At the person's own terminal the change line's undo is the one way back.
    const { run: typedRun } = workspace();
    const typedArgs = ["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--project", "--yes"];
    const typed = typedRun(typedArgs, { ...ownTerminal(), ...env });
    expect(typed).toContain(recorded);
    expect(typed).toMatch(/Recorded AIDLC_DISABLE_REVIEW_FREEZE_HOOK in .* To undo: .*--clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK/);
    expect(typed).toEndWith("You can clear the recording any time.");
    expect(typed).not.toContain("To clear the recording:");
    expect(typed).not.toContain("open workflow");
    // Without the variable the same command does name the open work.
    if (value === "0") {
      expect(workspace().run(typedArgs, { ...ownTerminal(), AIDLC_DISABLE_REVIEW_FREEZE_HOOK: undefined }))
        .toContain("1 open workflow");
    }
    // Beside another change too, from a chat for the shared file, where the
    // change lines are shown: the line would otherwise claim the switch with it.
    const side = workspace();
    const m2 = side.said("turn the review freeze check off for the whole project, and hook debug on");
    const mixed = side.run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--hook-debug", "on",
      "--project", "--yes", "--message", m2], env);
    expect(mixed).toContain("hook debug: not set -> on");
    expect(mixed).toContain(recorded);
    expect(mixed).not.toContain("open workflow");
    if (value === "0") {
      const plain = workspace();
      const m3 = plain.said("turn the review freeze check off for the whole project, and hook debug on");
      expect(plain.run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--hook-debug", "on",
        "--project", "--yes", "--message", m3], { AIDLC_DISABLE_REVIEW_FREEZE_HOOK: undefined })).toContain("1 open workflow");
    }
    // Again, nothing is written and no change line names the clear: nobody is
    // there to ask, so this line names the command, for the file it is in.
    const again = typedRun(typedArgs, { ...ownTerminal(), ...env });
    expect(again).toContain(recorded);
    expect(again).toMatch(/To clear the recording: \S.* config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --project --yes/);
    expect(again).not.toContain("To undo: ");
  });

  test("nowhere wider to go: this machine, a check with no project place, and the Guard Policy ask nothing", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check off for this machine");
    expect(run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--global", "--yes", "--message", m1])).not.toContain("?");
    const m2 = said("turn the state transition check off");
    expect(run(["engine", "config", "set", "guard.state-transition", "off", "--message", m2]))
      .not.toContain("?");
    const m3 = said("relax the change checks");
    expect(run(["engine", "config", "set", "guard-policy", "relaxed", "--message", m3])).not.toContain("?");
  });

  test("plan approval and summary confirmation for this piece of work offer the whole project too", () => {
    const { run, said } = workspace();
    const m1 = said("stop asking me to approve the code plan");
    const plan = run(["engine", "config", "set", "plan-approval", "off", "--message", m1]);
    expect(lastLine(plan)).toEndWith(PROJECT_OFFER);
    const m2 = said("turn summary confirmation off");
    const summary = run(["engine", "config", "set", "summary-confirmation", "off", "--message", m2]);
    expect(lastLine(summary)).toEndWith(PROJECT_OFFER);
  });

  // "Do not ask me anything" beside questions left to the agent is recorded as
  // the summary confirmation and the learnings step off for this piece of work,
  // on their message (stage-protocol.md). While both stay off as theirs the
  // work's switch lines ask them nothing; the project's own switches still offer
  // the machine, and either one back on brings the work's offer back. The
  // runner keeps one machine install for the whole file, where earlier cases
  // leave the review freeze check off, so this case uses other checks.
  test("asked not to be asked: with the summary confirmation and the learnings step off as theirs, nothing more is offered for the piece of work", () => {
    const { run, said } = workspace();
    const m1 = said("Use the recommended answer for every question and finish the stage now. Do not ask me anything.");
    const waiver = run(["engine", "config", "set", "summary-confirmation", "off", "--learnings", "off", "--message", m1]);
    expect(waiver).toContain("is off for this piece of work");
    expect(waiver).not.toContain("?");
    const m2 = said("turn the reviewer read scope check off");
    const fence = run(["engine", "config", "set", "guard.reviewer-scope", "off", "--message", m2]);
    expect(fence).toContain("is off for this piece of work");
    expect(fence).not.toContain("?");
    const m3 = said("turn the reviewer read scope check off for this project");
    const project = run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK", "--local", "--yes", "--message", m3]);
    expect(lastLine(project)).toEndWith(MACHINE_OFFER);
    const m4 = said("ask me what to keep for next time again");
    run(["engine", "config", "set", "learnings", "on", "--message", m4]);
    const m5 = said("stop asking me to approve the code plan");
    expect(lastLine(run(["engine", "config", "set", "plan-approval", "off", "--message", m5]))).toEndWith(PROJECT_OFFER);
  });

  test("a scope change that turns a check off asks nothing: nobody asked to turn that check off", () => {
    const { proj, run, said } = workspace();
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(
      "- **Change Control**: strict (from scope feature)",
      "- **Change Control**: strict (from scope feature)\n- **Plan Approval**: on (from scope feature)\n" +
        "- **Summary Confirmation**: on (from scope feature)",
    ));
    const m1 = said("change the scope to express");
    const out = run(["engine", "scope", "change", "--scope", "express", "--message", m1]);
    expect(out).toContain("Plan Approval changed");
    expect(out).not.toContain("?");
  });

  test("a wider place that already has it off is not offered", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check off for this machine");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--global", "--yes", "--message", m1]);
    const m2 = said("turn the review freeze check off for this project");
    expect(run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m2])).not.toContain("?");
    const m3 = said("turn the review freeze check off");
    expect(run(["engine", "config", "set", "guard.review-freeze", "off", "--message", m3]))
      .not.toContain("?");
  });

  test("with the environment deciding, nothing wider is offered", () => {
    const { run, said } = workspace();
    const m1 = said("turn the reviewer read scope check off");
    const out = run(["engine", "config", "set", "guard.reviewer-scope", "off", "--message", m1], {
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
