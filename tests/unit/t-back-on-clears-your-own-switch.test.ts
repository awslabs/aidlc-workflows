// covers: function:applyIntentSettings
//
// The person asks in chat to turn a check back on while a settings file keeps
// it off. Their own aidlc.settings.local.json entry is cleared and, when
// nothing else keeps it off, one line says so, so the work goes on with the
// check on and nothing is asked. The project's shared file and the machine's
// are not changed from this request: one line names the file and that
// changing it changes it. Sensors and learnings read the same, instead of a
// line that says on while the file keeps them off.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, FIXTURES_DIR, REPO_ROOT, runOrchestrateNext, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "01995000-7a11-7000-8000-00000000e5e5";
const PLAN = "the plan approval check (it shows you the plan before any code is written)";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    if (dir.includes("aidlc-test-")) cleanupTestProject(dir);
    else rmSync(dir, { recursive: true, force: true });
  }
});

function workspace() {
  const proj = createTestProject();
  made.push(proj);
  // The machine's settings live in a home of the test's own, outside the project.
  const home = mkdtempSync(join(tmpdir(), "back-on-clears-home-"));
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
    AIDLC_INSTALL_ROOT: join(home, "machine"),
    AIDLC_BIN_DIR: join(home, "machine", "bin"),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
  // No agent host's mark from the shell that runs the suite, and no switch
  // from it either: a variable of the switch's name decides over the files.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|KIRO_|TERM_PROGRAM$|AIDLC_PROJECT_DIR$)/.test(key)) delete env[key];
    if (/^AIDLC_(DISABLE_PLAN_APPROVAL_GUARD|DISABLE_SUMMARY_CONFIRMATION|DISABLE_REVIEW_FREEZE_HOOK|DISABLE_SENSORS|DISABLE_LEARNINGS|DISABLE_USAGE_TRACKING)$/.test(key)) {
      delete env[key];
    }
  }
  const tool = join(proj, ".claude", "tools", "aidlc.ts");
  const spawn = (args: string[], stdin?: string, extra: Record<string, string | undefined> = {}) =>
    Bun.spawnSync([process.execPath, tool, ...args], {
      cwd: proj,
      env: { ...env, ...extra },
      ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
  const run = (args: string[], extra: Record<string, string | undefined> = {}): string => {
    const r = spawn(args, undefined, extra);
    expect(r.exitCode, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(0);
    return r.stdout.toString().trim();
  };
  const said = (words: string): void => {
    const r = spawn(["engine", "hook", "record-human-turn"], JSON.stringify({
      hook_event_name: "UserPromptSubmit", cwd: proj, session_id: SESSION, prompt: words,
    }));
    expect(r.exitCode, r.stderr.toString()).toBe(0);
  };
  const off = (name: string, place: "local" | "project" | "global"): void => {
    said("turn it off");
    run(["config", "flags", "--bypass", name, `--${place}`, "--yes"]);
  };
  // The person asks in chat; the agent runs the setter with their words.
  const backOn = (key: string, words: string, extra: Record<string, string | undefined> = {}): string => {
    said(words);
    return run(["engine", "config", "set", key, "on", "--person-words", words], extra);
  };
  const file = (place: "local" | "project" | "global"): string =>
    place === "local" ? join(proj, "aidlc.settings.local.json")
      : place === "project" ? join(proj, "aidlc.settings.json")
      : join(home, "machine", "aidlc.settings.json");
  const recorded = (place: "local" | "project" | "global"): string[] =>
    existsSync(file(place))
      ? (JSON.parse(readFileSync(file(place), "utf-8")) as { flags?: { bypasses?: string[] } }).flags?.bypasses ?? []
      : [];
  const stage = (): Record<string, unknown> | null =>
    runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, [], { cwd: proj, env }).directive;
  const typed = (line: string): string => {
    said(line);
    const step = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj,
      line.replace(/^\/aidlc\s+/, "").split(" "), { cwd: proj, env });
    const named = /Run `bun \.claude\/tools\/(aidlc[a-z-]*\.ts) ([^`]+)`/.exec(String(step.directive?.message));
    expect(named, step.out.slice(0, 400)).not.toBeNull();
    const r = Bun.spawnSync([process.execPath, join(proj, ".claude", "tools", named![1]), ...named![2].split(" ")], {
      cwd: proj, env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.exitCode, `${r.stdout}${r.stderr}`).toBe(0);
    return r.stdout.toString().trim();
  };
  return { run, said, off, backOn, file, recorded, stage, typed };
}

describe("t-back-on-clears-your-own-switch: back on while a settings file keeps it off", () => {
  test("only your own local file keeps it off: that entry is cleared, said in one line, and the work runs with it on", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_USAGE_TRACKING", "local");
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "local");
    const out = w.backOn("plan-approval", "turn plan approval back on");
    expect(out).toBe(
      "The plan approval check (it shows you the plan before any code is written) is back on: " +
        "aidlc.settings.local.json had kept it off for this project, and that entry is cleared.",
    );
    // Only that entry: the file keeps everything else it records.
    expect(w.recorded("local")).toEqual(["AIDLC_DISABLE_USAGE_TRACKING"]);
    expect(w.run(["engine", "config", "get", "plan-approval"])).toStartWith("on");
    const step = w.stage();
    expect(step?.kind).toBe("run-stage");
    expect((step?.ceremony as { plan_approval?: string } | undefined)?.plan_approval).toBe("on");
  });

  test("summary confirmation: the same line, and it is on", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_SUMMARY_CONFIRMATION", "local");
    expect(w.backOn("summary-confirmation", "turn summary confirmation back on")).toBe(
      "The summary confirmation (it reads your words back to you before the work goes on) is back on: " +
        "aidlc.settings.local.json had kept it off for this project, and that entry is cleared.",
    );
    expect(w.recorded("local")).toEqual([]);
    expect(w.run(["engine", "config", "get", "summary-confirmation"])).toStartWith("on");
  });

  test("typed as an /aidlc line: the step's setter clears it the same way", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "local");
    expect(w.typed("/aidlc --guard.review-freeze on")).toBe(
      "The review freeze check (it stops edits to work you already approved) is back on: " +
        "aidlc.settings.local.json had kept it off for this project, and that entry is cleared.",
    );
    expect(w.recorded("local")).toEqual([]);
    expect(w.run(["engine", "config", "get", "guard.review-freeze"])).toStartWith("on");
  });

  test("sensors and learnings: the line says what is true, never on while the file keeps them off", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_SENSORS", "local");
    const sensors = w.backOn("sensors", "turn the sensors back on");
    expect(sensors).not.toContain("Sensors changed");
    expect(sensors).toBe(
      "Sensors are back on: aidlc.settings.local.json had kept them off for this project, and that entry is cleared.",
    );
    expect(w.run(["engine", "config", "get", "sensors"])).toStartWith("on");
    w.off("AIDLC_DISABLE_LEARNINGS", "project");
    const learnings = w.backOn("learnings", "turn learnings back on");
    expect(learnings).toBe(
      "The project's shared settings in aidlc.settings.json keep learnings off for everyone on this project. Changing that file changes it.",
    );
    expect(w.run(["engine", "config", "get", "learnings"])).toStartWith("off");
  });

  test("the team's committed file keeps it off: one line names it, nothing is asked, and the file is left as it is", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "project");
    const before = readFileSync(w.file("project"), "utf-8");
    const out = w.backOn("plan-approval", "turn plan approval back on");
    expect(out).toBe(
      `The project's shared settings in aidlc.settings.json keep ${PLAN} off for everyone on this project. Changing that file changes it.`,
    );
    expect(readFileSync(w.file("project"), "utf-8")).toBe(before);
    expect(w.run(["engine", "config", "get", "plan-approval"])).toStartWith("off");
  });

  test("your local file and the shared one both keep it off: yours is cleared, so changing the shared one is the whole way back", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "project");
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "local");
    const shared = readFileSync(w.file("project"), "utf-8");
    const out = w.backOn("plan-approval", "turn plan approval back on");
    expect(out).toBe(
      `The project's shared settings in aidlc.settings.json keep ${PLAN} off for everyone on this project. ` +
        "Changing that file changes it. The entry in aidlc.settings.local.json is cleared too.",
    );
    expect(w.recorded("local")).toEqual([]);
    expect(readFileSync(w.file("project"), "utf-8")).toBe(shared);
  });

  test("the shared file and the machine's both keep it off: the line names both, since changing one leaves it off", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "project");
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "global");
    const shared = readFileSync(w.file("project"), "utf-8");
    const machine = readFileSync(w.file("global"), "utf-8");
    const both =
      `The project's shared settings in aidlc.settings.json and this machine's settings in ${w.file("global")} ` +
      `keep ${PLAN} off. Changing both changes it.`;
    expect(w.backOn("plan-approval", "turn plan approval back on")).toBe(both);
    expect(readFileSync(w.file("project"), "utf-8")).toBe(shared);
    expect(readFileSync(w.file("global"), "utf-8")).toBe(machine);
    // With their own entry on top as well, theirs is cleared and both shared holders are still named.
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "local");
    expect(w.backOn("plan-approval", "turn plan approval back on")).toBe(
      `${both} The entry in aidlc.settings.local.json is cleared too.`,
    );
    expect(w.recorded("local")).toEqual([]);
  });

  test("the machine's file keeps it off: one line names it, and it is never changed from this request", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "global");
    const before = readFileSync(w.file("global"), "utf-8");
    const out = w.backOn("plan-approval", "turn plan approval back on");
    expect(out).toBe(
      `This machine's settings in ${w.file("global")} keep ${PLAN} off for every project here. Changing that file changes it.`,
    );
    expect(out).not.toContain("?");
    expect(readFileSync(w.file("global"), "utf-8")).toBe(before);
  });

  test("the environment keeps it off: the line is as before, and the local file is left as it is", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_SUMMARY_CONFIRMATION", "local");
    const out = w.backOn("summary-confirmation", "turn summary confirmation back on", { AIDLC_DISABLE_SUMMARY_CONFIRMATION: "1" });
    expect(out).toBe(
      "The summary confirmation (it reads your words back to you before the work goes on) is still off: " +
        "AIDLC_DISABLE_SUMMARY_CONFIRMATION=1 is set in the environment this command ran in. " +
        "Start the editor or CLI without it to turn the check back on.",
    );
    expect(w.recorded("local")).toEqual(["AIDLC_DISABLE_SUMMARY_CONFIRMATION"]);
    const sensors = w.backOn("sensors", "turn the sensors back on", { AIDLC_DISABLE_SENSORS: "1" });
    expect(sensors).toBe(
      "Sensors are still off: AIDLC_DISABLE_SENSORS=1 is set in the environment this command ran in. " +
        "Start the editor or CLI without it to turn them back on.",
    );
  });

  test("an on nobody's words stand behind changes no file", () => {
    const w = workspace();
    w.off("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "local");
    w.said("what is the next stage about?");
    const out = w.run(["engine", "config", "set", "plan-approval", "on", "--person-words", "turn plan approval back on"]);
    expect(out).toContain("is still off: aidlc.settings.local.json keeps it off for this project.");
    expect(w.recorded("local")).toEqual(["AIDLC_DISABLE_PLAN_APPROVAL_GUARD"]);
    // Sensors on that path say what is true too.
    w.off("AIDLC_DISABLE_SENSORS", "local");
    w.said("what is the next stage about?");
    const sensors = w.run(["engine", "config", "set", "sensors", "on", "--person-words", "turn the sensors back on"]);
    expect(sensors).toBe(
      "Sensors are still off: aidlc.settings.local.json keeps them off for this project. Do you want it cleared there?",
    );
    expect(w.recorded("local")).toEqual(["AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "AIDLC_DISABLE_SENSORS"]);
  });

  test("at your own terminal: your local file is cleared the same way; the team's file still names its command", () => {
    const w = workspace();
    const terminal = { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_SESSION_OVERRIDE: undefined };
    w.off("AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "local");
    expect(w.run(["engine", "config", "set", "guard.review-freeze", "on"], terminal)).toBe(
      "The review freeze check (it stops edits to work you already approved) is back on: " +
        "aidlc.settings.local.json had kept it off for this project, and that entry is cleared.",
    );
    expect(w.recorded("local")).toEqual([]);
    w.off("AIDLC_DISABLE_REVIEW_FREEZE_HOOK", "project");
    const team = w.run(["engine", "config", "set", "guard.review-freeze", "on"], terminal);
    expect(team).toContain("is still off: aidlc.settings.json keeps it off for this project. To turn it back on: ");
    expect(w.recorded("project")).toEqual(["AIDLC_DISABLE_REVIEW_FREEZE_HOOK"]);
  });
});
