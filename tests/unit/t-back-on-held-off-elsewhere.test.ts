// covers: subcommand:aidlc-init:config
//
// The person asks to turn a check back on for this piece of work while a
// project or machine setting, or the environment, still keeps it off. Their own
// local entry is cleared; otherwise the line says it is still off and why, and
// the way to change it, instead of "already on" (untrue: the setting keeps it
// off), "already off" (no way forward), or "now shown for approval" (untrue for
// plan approval).

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, FIXTURES_DIR, REPO_ROOT, runOrchestrateNext, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "01995000-7a11-7000-8000-00000000e4e4";
const CLEARED = "had kept it off for this project, and that entry is cleared.";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    if (dir.includes("aidlc-test-")) cleanupTestProject(dir);
    else rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): {
  run: (args: string[], extra?: Record<string, string | undefined>) => string;
  said: (words: string) => string;
  typed: (line: string) => string;
} {
  const proj = createTestProject();
  made.push(proj);
  // The machine's settings live in a home of the test's own, outside the project.
  const home = mkdtempSync(join(tmpdir(), "back-on-home-"));
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
    // The machine's settings file is the install root's: one of the test's own.
    AIDLC_INSTALL_ROOT: join(home, "machine"),
    AIDLC_BIN_DIR: join(home, "machine", "bin"),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
  // No agent host's mark from the shell that runs the suite: the chat is the
  // session named above, and the terminal case is the person's own.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|KIRO_|TERM_PROGRAM$|AIDLC_PROJECT_DIR$)/.test(key)) delete env[key];
  }
  const tool = join(proj, ".claude", "tools", "aidlc.ts");
  const spawn = (args: string[], stdin?: string, extra: Record<string, string | undefined> = {}) =>
    Bun.spawnSync([process.execPath, tool, ...args], {
      cwd: proj,
      env: { ...env, ...extra },
      ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
  return {
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
    // The person types the setting as an /aidlc line: the engine's step names
    // the setter, and the agent runs it.
    typed: (line) => {
      const step = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj,
        line.replace(/^\/aidlc\s+/, "").split(" "), { cwd: proj, env });
      const named = /Run `bun \.claude\/tools\/(aidlc[a-z-]*\.ts) ([^`]+)`/.exec(String(step.directive?.message));
      expect(named, step.out.slice(0, 400)).not.toBeNull();
      const r = Bun.spawnSync([process.execPath, join(proj, ".claude", "tools", named![1]), ...named![2].split(" ")], {
        cwd: proj, env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(r.exitCode, `${r.stdout}${r.stderr}`).toBe(0);
      return r.stdout.toString().trim();
    },
  };
}

describe("t-back-on-held-off-elsewhere: back on for this piece of work while a setting keeps it off", () => {
  test("the project's local file keeps it off: that entry is cleared, and said", () => {
    const { run, said } = workspace();
    const m1 = said("turn it off");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m1]);
    const m2 = said("turn the review freeze check back on");
    const out = run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m2]);
    expect(out).not.toContain("already on");
    expect(out).toContain(`is back on: aidlc.settings.local.json ${CLEARED}`);
    expect(out).not.toContain("?");
    expect(run(["engine", "config", "get", "guard.review-freeze"])).toStartWith("on");
  });

  test("the machine's file keeps it off: said, with the file that changes it, and nothing asked", () => {
    const { run, said } = workspace();
    const m1 = said("turn it off");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK", "--global", "--yes", "--message", m1]);
    const m2 = said("turn the reviewer read scope check back on");
    const out = run(["engine", "config", "set", "guard.reviewer-scope", "on", "--message", m2]);
    expect(out).not.toContain("already on");
    expect(out).toStartWith("This machine's settings in ");
    expect(out).toEndWith("off for every project here. Changing that file changes it.");
  });

  test("the team's project file keeps it off: said by its name", () => {
    const { run, said } = workspace();
    const m1 = said("turn it off for the team");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--project", "--yes", "--message", m1]);
    const m2 = said("turn the review freeze check back on");
    const out = run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m2]);
    expect(out).toBe(
      "The project's shared settings in aidlc.settings.json keep the review freeze check (it stops edits to work you " +
        "already approved) off for everyone on this project. Changing that file changes it.",
    );
  });

  test("the project's local file and the machine's both keep it off: the local entry is cleared, and the machine's file named", () => {
    const { run, said } = workspace();
    const m1 = said("turn it off on this machine");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--global", "--yes", "--message", m1]);
    const m2 = said("turn it off for this project");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m2]);
    const m3 = said("turn the review freeze check back on");
    const out = run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m3]);
    expect(out).toStartWith("This machine's settings in ");
    expect(out).toEndWith("Changing that file changes it. The entry in aidlc.settings.local.json is cleared too.");
  });

  test("typed as an /aidlc line: the same line", () => {
    const { said, run, typed } = workspace();
    const m1 = said("turn it off");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m1]);
    said("/aidlc --guard.review-freeze on");
    const out = typed("/aidlc --guard.review-freeze on");
    expect(out).toContain(`is back on: aidlc.settings.local.json ${CLEARED}`);
  });

  test("at the person's own terminal: the shared file's line names the command that clears it, and no question", () => {
    const { run, said } = workspace();
    const m1 = said("turn it off");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--project", "--yes", "--message", m1]);
    const out = run(["engine", "config", "set", "guard.review-freeze", "on"], {
      AIDLC_TEST_CONFIG_TTY: "1",
      AIDLC_SESSION_OVERRIDE: undefined,
    });
    expect(out).toContain("is still off: aidlc.settings.json keeps it off for this project. To turn it back on: ");
    expect(out).toContain("config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes");
    expect(out).not.toContain("?");
  });

  test("Guard Policy off and the project's local file keeps it off: cleared, and their on for this work stands", () => {
    const { run, said } = workspace();
    const m1 = said("turn it off");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m1]);
    const m2 = said("turn the guards off");
    run(["engine", "config", "set", "guard-policy", "off", "--message", m2]);
    const m3 = said("turn the review freeze check back on");
    const out = run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m3]);
    expect(out).not.toContain("back on for this piece of work");
    expect(out).toContain(`is back on: aidlc.settings.local.json ${CLEARED}`);
    expect(out).not.toContain("?");
    // Their own "on" for this piece of work stands over Guard Policy off.
    expect(run(["engine", "config", "get", "guard.review-freeze"])).toStartWith("on");
  });

  test("off for this piece of work, then the whole project, then back on: on again, with no question", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check off");
    const off = run(["engine", "config", "set", "guard.review-freeze", "off", "--message", m1]);
    expect(off).toEndWith("Do you want it off for the whole project instead?");
    const m2 = said("yes");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "--local", "--yes", "--message", m2]);
    const m3 = said("turn it back on");
    const on = run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m3]);
    expect(on).toContain(`is back on: aidlc.settings.local.json ${CLEARED}`);
    expect(on).not.toContain("?");
    expect(run(["engine", "config", "get", "guard.review-freeze"])).toStartWith("on");
  });

  test("the environment keeps it off: said, with the way back, and nothing offered the agent cannot do", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check back on");
    const out = run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m1], {
      AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "1",
    });
    expect(out).not.toContain("already off");
    expect(out).toContain("is still off: AIDLC_DISABLE_REVIEW_FREEZE_HOOK=1 is set in the environment this command ran in.");
    expect(out).not.toContain("?");
  });

  test("plan approval: the line that clears the project's local file is the only one said", () => {
    const { run, said } = workspace();
    const m1 = said("turn it off");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "--local", "--yes", "--message", m1]);
    const m2 = said("turn plan approval back on");
    const out = run(["engine", "config", "set", "plan-approval", "on", "--message", m2]);
    expect(out).not.toContain("Each code plan is now shown for approval");
    expect(out).toContain(`is back on: aidlc.settings.local.json ${CLEARED}`);
  });

  test("plan approval: an environment switch the chat's start never recorded keeps nothing off, so nothing says it does", () => {
    const { run, said } = workspace();
    const m1 = said("turn plan approval back on");
    const out = run(["engine", "config", "set", "plan-approval", "on", "--message", m1], {
      AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
    });
    expect(out).not.toContain("is still off");
  });

  test("summary confirmation: the project's local file is cleared the same way", () => {
    const { run, said } = workspace();
    const m1 = said("turn it off");
    run(["config", "flags", "--bypass", "AIDLC_DISABLE_SUMMARY_CONFIRMATION", "--local", "--yes", "--message", m1]);
    const m2 = said("turn summary confirmation back on");
    const out = run(["engine", "config", "set", "summary-confirmation", "on", "--message", m2]);
    expect(out).toContain(`is back on: aidlc.settings.local.json ${CLEARED}`);
  });

  test("on again while the plan already keeps it on: their earlier on stays on this piece of work", () => {
    const { run, said } = workspace();
    const m1 = said("change the scope to classic");
    run(["engine", "scope", "change", "--scope", "classic", "--message", m1]);
    const m2 = said("turn the review freeze check on");
    run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m2]);
    const m3 = said("change the scope to enterprise");
    run(["engine", "scope", "change", "--scope", "enterprise", "--message", m3]);
    const m4 = said("turn the review freeze check on");
    run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m4]);
    const m5 = said("change the scope back to classic");
    run(["engine", "scope", "change", "--scope", "classic", "--message", m5]);
    expect(run(["engine", "config", "get", "guard.review-freeze"])).toStartWith("on");
  });

  test("nothing else keeps it off: the lines are as before", () => {
    const { run, said } = workspace();
    const m1 = said("turn the review freeze check back on");
    expect(run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m1]))
      .toBe("The review freeze check is already on");
    const m2 = said("turn the review freeze check off");
    run(["engine", "config", "set", "guard.review-freeze", "off", "--message", m2]);
    const m3 = said("turn it back on");
    expect(run(["engine", "config", "set", "guard.review-freeze", "on", "--message", m3]))
      .toBe("The review freeze check is back on for this piece of work");
  });
});
