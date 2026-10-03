// covers: function:switchesOff, function:switchOffLine, function:switchesOffLines, function:switchOffNotices
// covers: function:recordSwitchChange, function:clearSwitchCommand, function:latestPersonTurn, function:personSpokeSinceGate
// covers: function:PERSON_CHECK_SWITCHES, function:PERSON_CHECK_SWITCH_LABELS
//
// A recorded switch that takes a check away from the person counts the moment
// it is recorded, however it got there: asked for in the chat, typed in a
// terminal, written into the settings file, or recorded before this release.
// The engine never refuses or re-asks it. What the person gets is to hear it,
// in plain words, on the channels every harness shows: which check is off,
// since when, how it was set, and the one phrase that turns it back on. The
// engine's next directive says it once per change; every session start says it
// while it stays off; `config flags --show` and the doctor Flags row always do.
// Whether a person's chat turn stood behind the change decides only the words.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  REPO_ROOT,
  runOrchestrateNext,
  seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { flagsDoctorCheck } from "../../dist/claude/.claude/tools/aidlc-config-diagnostics.ts";
import {
  latestPersonTurn,
  personSpokeSinceGate,
  resolveProjectFlag,
  STOP_HOOK_PROBE_ENV,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  clearSwitchCommand,
  markSwitchOffNoticesSaid,
  type SwitchOff,
  switchesOff,
  switchesOffLines,
  switchOffLine,
  switchOffNotices,
} from "../../dist/claude/.claude/tools/aidlc-recorded-switches.ts";
import {
  invalidateSettingsCache,
  PERSON_CHECK_SWITCH_LABELS,
  PERSON_CHECK_SWITCHES,
  RECORDABLE_PROJECT_BYPASSES,
} from "../../dist/claude/.claude/tools/aidlc-settings.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SESSION = "01995000-7a11-7000-8000-0000000051c0";
const NAME = "AIDLC_DISABLE_REVIEW_FREEZE_HOOK";
const ASKED = "turn the review freeze check off for this project";
const OFF = "The review freeze check is off for this project since ";
const FROM_CHAT = `because you said: "${ASKED}"`;
const NOT_FROM_CHAT = "set from a terminal or a file, not from your chat";
const UNDO = `Say "turn it back on" to restore it (`;

// Nothing in the environment decides these switches here: the settings files
// do. The machine layer is a scratch install root.
let machine = "";
let installRoot = "";
const priorInstallRoot = process.env.AIDLC_INSTALL_ROOT;
beforeAll(() => {
  machine = mkdtempSync(join(tmpdir(), "aidlc-switch-notices-machine-"));
  installRoot = join(machine, "share", "aidlc");
  process.env.AIDLC_INSTALL_ROOT = installRoot;
});
afterAll(() => {
  if (priorInstallRoot === undefined) delete process.env.AIDLC_INSTALL_ROOT;
  else process.env.AIDLC_INSTALL_ROOT = priorInstallRoot;
  rmSync(machine, { recursive: true, force: true });
});

function quietEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_INSTALL_ROOT: installRoot,
    AIDLC_BIN_DIR: join(machine, "bin"),
    AIDLC_UNATTENDED: "0",
    ...extra,
  };
  for (const name of RECORDABLE_PROJECT_BYPASSES) {
    if (!Object.hasOwn(extra, name)) delete env[name];
  }
  for (const key of ["AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", STOP_HOOK_PROBE_ENV]) {
    if (!Object.hasOwn(extra, key)) delete env[key];
  }
  return env;
}
const NONE: NodeJS.ProcessEnv = {};

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  invalidateSettingsCache();
});

// A workflow in progress, so the human-turn hook records the person's turns.
function project(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  seedStateFile(proj, "state-mid-ideation.md");
  return proj;
}

// The same, with the Claude tree installed, so `config flags --local` has a
// project to record into while the work runs.
function installedProject(): string {
  const proj = project();
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(proj, ".claude"), { recursive: true });
  return proj;
}

function dispatch(proj: string, args: string[], input?: string, extra: Record<string, string | undefined> = {}) {
  const result = spawnSync(BUN, [DISPATCHER, ...args], {
    cwd: proj,
    ...(input === undefined ? {} : { input }),
    env: quietEnv({ CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...extra }),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// The person typing in the chat, through the real human-turn hook.
function says(proj: string, prompt: string): void {
  const result = dispatch(
    proj,
    ["engine", "hook", "record-human-turn"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    { AIDLC_SESSION_OVERRIDE: SESSION },
  );
  expect(result.status, result.stderr).toBe(0);
}

function flags(proj: string, ...args: string[]) {
  const result = dispatch(proj, ["config", "flags", "--project-dir", proj, ...args]);
  invalidateSettingsCache();
  return result;
}

function notices(proj: string, extra: Record<string, string | undefined> = {}): string[] {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: quietEnv(extra) });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return ((result.directive as { change_notices?: string[] }).change_notices ?? [])
    .filter((line) => line.includes(" check is off "));
}

function sessionStart(proj: string): string {
  const result = dispatch(
    proj,
    ["engine", "hook", "session-start"],
    JSON.stringify({ hook_event_name: "SessionStart", session_id: SESSION, source: "startup", cwd: proj }),
  );
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { additionalContext?: string })
    .additionalContext ?? "";
}

function writeLocal(proj: string, bypasses: string[]): string {
  const path = join(proj, "aidlc.settings.local.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, flags: { schemaVersion: 1, bypasses } }, null, 2)}\n`);
  invalidateSettingsCache();
  return path;
}

const recordFile = (proj: string) => join(proj, "aidlc", ".aidlc-sessions", "recorded-switches.json");

describe("a check switched off for the project is always said, never refused", () => {
  test("asked for in the chat: off at once, and the person hears their own words", () => {
    const proj = installedProject();
    says(proj, ASKED);
    expect(personSpokeSinceGate(proj)).toBe(true);
    expect(latestPersonTurn(proj)?.words).toBe(ASKED);

    const recorded = flags(proj, "--bypass", NAME, "--local", "--yes");
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    expect(recorded.stdout).toContain(OFF);
    expect(recorded.stdout).toContain(FROM_CHAT);
    expect(recorded.stdout).toContain(`${UNDO}${clearSwitchCommand(NAME, "local")}).`);
    expect(resolveProjectFlag(NAME, NONE, proj)).toBe("1");

    // The engine's next directive says it once; the one after does not.
    const first = notices(proj);
    expect(first).toHaveLength(1);
    expect(first[0]).toStartWith(OFF);
    expect(first[0]).toContain(FROM_CHAT);
    expect(notices(proj)).toEqual([]);

    // Every chat that starts while it stays off opens with it.
    for (let start = 0; start < 2; start++) {
      const context = sessionStart(proj);
      expect(context).toContain("CHECKS SWITCHED OFF");
      expect(context).toContain(FROM_CHAT);
    }

    // --show and doctor always name it; a warning never fails doctor.
    const show = flags(proj, "--show");
    expect(show.stdout).toContain(FROM_CHAT);
    const shown = JSON.parse(flags(proj, "--show", "--json").stdout) as { data: { switches: string[] } };
    expect(shown.data.switches).toEqual(switchesOffLines(proj, NONE));
    const row = flagsDoctorCheck(proj, ".claude", switchesOffLines(proj, NONE));
    expect(row).toMatchObject({ pass: false, severity: "warn", label: "Flags: 1 check switched off" });
    expect(row.fix).toContain(FROM_CHAT);

    // Turning it back on needs nothing, and says so in one line.
    const cleared = flags(proj, "--clear-bypass", NAME, "--local", "--yes");
    expect(cleared.status, cleared.stdout + cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain("The review freeze check is on again for this project.");
    expect(resolveProjectFlag(NAME, NONE, proj)).toBeUndefined();
    expect(notices(proj)).toEqual([]);
    expect(sessionStart(proj)).not.toContain("CHECKS SWITCHED OFF");
    expect(switchesOffLines(proj, NONE)).toEqual([]);
  });

  test("set with nobody in the chat: off at once, and said as not from the chat", () => {
    const proj = installedProject();
    const recorded = flags(proj, "--bypass", NAME, "--local", "--yes");
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    expect(recorded.stdout).toContain(NOT_FROM_CHAT);
    expect(resolveProjectFlag(NAME, NONE, proj)).toBe("1");
    const said = notices(proj);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(NOT_FROM_CHAT);
  });

  test("a line written into the file, or kept from before this release, counts and is said once", () => {
    const proj = project();
    const path = writeLocal(proj, [NAME]);
    const then = new Date();
    then.setHours(9, 5, 0, 0);
    utimesSync(path, then, then);
    invalidateSettingsCache();
    expect(resolveProjectFlag(NAME, NONE, proj)).toBe("1");

    // A read-only probe sees it but leaves it unsaid.
    expect(notices(proj, { [STOP_HOOK_PROBE_ENV]: "1" })).toHaveLength(1);
    expect(existsSync(recordFile(proj))).toBe(false);

    const said = notices(proj);
    expect(said).toEqual([
      `${OFF}09:05, ${NOT_FROM_CHAT}. ${UNDO}${clearSwitchCommand(NAME, "local")}).`,
    ]);
    expect(notices(proj)).toEqual([]);
    expect(sessionStart(proj)).toContain(`${OFF}09:05, ${NOT_FROM_CHAT}.`);
  });

  test("switches that take no decision from the person, and ones the environment decides, stay quiet", () => {
    const proj = project();
    writeLocal(proj, ["AIDLC_DISABLE_LEARNINGS", "AIDLC_DISABLE_SENSORS", "AIDLC_DISABLE_USAGE_TRACKING"]);
    expect(switchesOffLines(proj, NONE)).toEqual([]);
    writeLocal(proj, [NAME]);
    expect(switchesOffLines(proj, { [NAME]: "1" })).toEqual([]);
    expect(switchesOffLines(proj, { [NAME]: "0" })).toEqual([]);
    expect(switchesOffLines(proj, NONE)).toHaveLength(1);
    expect(PERSON_CHECK_SWITCHES).toHaveLength(9);
    expect(RECORDABLE_PROJECT_BYPASSES.filter((name) => PERSON_CHECK_SWITCH_LABELS[name] === undefined).sort())
      .toEqual(["AIDLC_DISABLE_LEARNINGS", "AIDLC_DISABLE_SENSORS", "AIDLC_DISABLE_USAGE_TRACKING"]);
  });

  test("a damaged record changes only the words, never whether the switch counts", () => {
    const proj = project();
    writeLocal(proj, [NAME]);
    mkdirSync(join(proj, "aidlc", ".aidlc-sessions"), { recursive: true });
    writeFileSync(recordFile(proj), "{ not json");
    expect(resolveProjectFlag(NAME, NONE, proj)).toBe("1");
    expect(switchesOffLines(proj, NONE)[0]).toContain(NOT_FROM_CHAT);
    expect(switchOffNotices(proj, NONE)).toHaveLength(1);
    markSwitchOffNoticesSaid(proj, NONE);
    expect(JSON.parse(readFileSync(recordFile(proj), "utf-8")).switches).toHaveLength(1);
    expect(switchOffNotices(proj, NONE)).toEqual([]);
  });

  test("the words: where it applies, the person's own words kept short, and an earlier day", () => {
    const now = new Date(2026, 9, 3, 12, 0, 0);
    const at = (hours: number, day = 3) => new Date(2026, 9, day, hours, 7, 0).toISOString();
    const off = (entry: Partial<NonNullable<SwitchOff["entry"]>>, target: SwitchOff["target"] = "local"): SwitchOff => ({
      name: "AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
      target,
      settingsPath: "/nonexistent",
      entry: { name: "AIDLC_DISABLE_PLAN_APPROVAL_GUARD", target, since: at(10), how: "chat", ...entry },
    });
    expect(switchOffLine(off({ words: 'skip the "plan" stop' }), now)).toBe(
      "The plan approval check is off for this project since 10:07, because you said: \"skip the 'plan' stop\". " +
        `${UNDO}${clearSwitchCommand("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "local")}).`,
    );
    expect(switchOffLine(off({}), now)).toContain("since 10:07, set after your last message in the chat.");
    expect(switchOffLine(off({ how: "other", since: at(8, 1) }, "global"), now)).toBe(
      `The plan approval check is off on this machine since 2026-10-01 08:07, ${NOT_FROM_CHAT}. ` +
        `${UNDO}${clearSwitchCommand("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "global")}).`,
    );
    const long = switchOffLine(off({ words: `${"word ".repeat(80)}\nend` }), now);
    expect(long).toMatch(/because you said: "(?:word ){39}word\.\.\."/);
    expect(clearSwitchCommand(NAME, "project")).toEndWith(`config flags --clear-bypass ${NAME} --project --yes`);
  });
});

// The directive and session start are the channels each harness shows: the
// engine's own output, and the context its session-start adapter returns.
describe("the line reaches the person on every harness", () => {
  const HARNESSES = [
    { name: "claude", dir: ".claude", adapter: null },
    { name: "copilot", dir: ".aidlc", adapter: "aidlc-copilot-adapter.ts" },
    { name: "kiro", dir: ".kiro", adapter: "aidlc-kiro-adapter.ts" },
    { name: "codex", dir: ".codex", adapter: "aidlc-codex-adapter.ts" },
  ] as const;

  for (const harness of HARNESSES) {
    test(`${harness.name}: the next directive and session start both carry it`, () => {
      const proj = project();
      cpSync(join(REPO_ROOT, "dist", harness.name, harness.dir), join(proj, harness.dir), { recursive: true });
      writeLocal(proj, [NAME]);
      const engine = join(proj, harness.dir, "tools", "aidlc-orchestrate.ts");
      const next = runOrchestrateNext(engine, proj, [], { env: quietEnv() });
      expect(next.status, next.out).toBe(0);
      const carried = (next.directive as { change_notices?: string[] } | null)?.change_notices ?? [];
      expect(carried.some((line) => line.startsWith(OFF) && line.includes(NOT_FROM_CHAT)), next.out).toBe(true);

      const payload = JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: SESSION,
        sessionId: SESSION,
        source: "startup",
        cwd: proj,
      });
      const hook = harness.adapter === null
        ? [join(proj, harness.dir, "hooks", "aidlc-session-start.ts")]
        : [join(proj, harness.dir, "hooks", harness.adapter), "session-start"];
      const started = spawnSync(BUN, hook, {
        cwd: proj,
        input: payload,
        env: quietEnv({ CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj }),
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout, started.stderr).toContain(OFF);
      expect(started.stdout).toContain(NOT_FROM_CHAT);
    });
  }
});

test("the shared list and the labels agree", () => {
  for (const name of PERSON_CHECK_SWITCHES) {
    expect(PERSON_CHECK_SWITCH_LABELS[name], name).toBeString();
  }
  const empty = mkdtempSync(join(tmpdir(), "aidlc-no-settings-"));
  created.push(empty);
  expect(switchesOff(empty, NONE)).toEqual([]);
});
