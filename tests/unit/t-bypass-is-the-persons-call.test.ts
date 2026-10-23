// covers: function:personAskedForThisLowering, function:validateChoiceArgs, function:guardSwitchRefusal
// covers: function:PERSON_CHECK_SWITCHES
//
// A check the person relies on is switched off for the project only when they
// asked for it, by the rule every lowering follows: from a chat, the agent names
// the message they asked in (--message), before any work exists as after, and
// the engine proves it theirs. Seen in the nightly Copilot release journey: the
// person's only message came before the work existed, and after the engine
// refused an approval nobody gave, the agent ran `config flags --bypass AIDLC_SKIP_HUMAN_PRESENCE_GUARD
// --local --yes` itself; the person's local settings file kept the switch. A
// command no chat is named for (a script, a test), a switch that takes no
// decision from the person, and turning a check back on are unchanged.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  REPO_ROOT,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { personsWordsText, resolveProjectFlag, writeSessionBinding } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { invalidateSettingsCache, RECORDABLE_PROJECT_BYPASSES } from "../../dist/claude/.claude/tools/aidlc-settings.ts";
import { latestMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(120_000);

const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000b7a5";
const PRESENCE = "AIDLC_SKIP_HUMAN_PRESENCE_GUARD";
const REQUEST = "/aidlc fix the greeter: it says hello instead of greeting the person by name";
const ASKED = "turn the human presence check off for this project";
const NONE: NodeJS.ProcessEnv = {};

let machine = "";
let installRoot = "";
const priorInstallRoot = process.env.AIDLC_INSTALL_ROOT;
beforeAll(() => {
  machine = mkdtempSync(join(tmpdir(), "aidlc-bypass-call-machine-"));
  installRoot = join(machine, "share", "aidlc");
  process.env.AIDLC_INSTALL_ROOT = installRoot;
});
afterAll(() => {
  if (priorInstallRoot === undefined) delete process.env.AIDLC_INSTALL_ROOT;
  else process.env.AIDLC_INSTALL_ROOT = priorInstallRoot;
  rmSync(machine, { recursive: true, force: true });
});

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  invalidateSettingsCache();
});

// A project with the Claude tree installed, so `config flags --local` has a project to record into.
function installed(proj: string): string {
  created.push(proj);
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(proj, ".claude"), { recursive: true });
  return proj;
}
// The project before its first piece of work, then with the work started and
// this chat on it, as creation leaves it.
const project = (): string => installed(createOrchestrationTestProject());
const startWork = (proj: string): void => {
  seedStateFile(proj, "state-mid-ideation.md");
  writeSessionBinding(proj, SESSION, "default", basename(seededRecordDir(proj)), "create");
};

function env(proj: string, extra: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    ...process.env, AIDLC_INSTALL_ROOT: installRoot, AIDLC_BIN_DIR: join(machine, "bin"), AIDLC_UNATTENDED: "0",
    CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...extra,
  };
  for (const name of RECORDABLE_PROJECT_BYPASSES) if (!Object.hasOwn(extra, name)) delete out[name];
  for (const key of ["AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE"]) if (!Object.hasOwn(extra, key)) delete out[key];
  return out;
}

function dispatch(proj: string, args: string[], extra: Record<string, string | undefined> = {}, input?: string) {
  const r = spawnSync(process.execPath, [DISPATCHER, ...args], {
    cwd: proj, env: env(proj, extra), encoding: "utf-8", ...(input === undefined ? {} : { input }),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  invalidateSettingsCache();
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The person typing in the chat, through the real human-turn hook. Returns the
// id of the message it kept: the newest in the project's message record, which
// holds it before any work exists as after.
function says(proj: string, prompt: string): string {
  const r = dispatch(proj, ["engine", "hook", "record-human-turn"], { AIDLC_SESSION_OVERRIDE: SESSION },
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }));
  expect(r.status, r.out).toBe(0);
  const kept = latestMessage(proj, SESSION);
  expect(kept && personsWordsText(kept.text)).toBe(prompt);
  return kept?.id as string;
}

// `config flags` as the agent runs it in that chat, or (chat: false) as a script or test that names no chat.
function flags(proj: string, args: string[], chat = true) {
  return dispatch(proj, ["config", "flags", "--project-dir", proj, ...args], chat ? { AIDLC_SESSION_OVERRIDE: SESSION } : {});
}

const off = (proj: string, name = PRESENCE): boolean => resolveProjectFlag(name, NONE, proj) === "1";

describe("t-bypass-is-the-persons-call: a check switched off for the project", () => {
  test("the agent switching a check off naming no message of the person's records nothing", () => {
    const proj = project();
    // Their request came before the work existed; the agent names no message.
    says(proj, REQUEST);
    startWork(proj);
    const r = flags(proj, ["--bypass", PRESENCE, "--local", "--yes"]);
    expect(off(proj), r.out).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Turning the human presence check off is the person's call.");
    expect(r.out).toContain("Run it with --message <id>, the message they asked in, when they ask for it.");
    expect(r.out).not.toContain(REQUEST);
    const plan = flags(proj, ["--bypass", "AIDLC_DISABLE_PLAN_APPROVAL_GUARD", "--local", "--yes"]);
    expect(off(proj, "AIDLC_DISABLE_PLAN_APPROVAL_GUARD"), plan.out).toBe(false);
    expect(plan.out).toContain("Turning plan approval off lets code generation start without the person approving the plan");
  });

  test("their message asking for it, named, switches it off, and the line says it was their words", () => {
    const proj = project();
    startWork(proj);
    const asked = says(proj, ASKED);
    const r = flags(proj, ["--bypass", PRESENCE, "--local", "--yes", "--message", asked]);
    expect(r.status, r.out).toBe(0);
    expect(off(proj)).toBe(true);
    expect(r.out).toContain(`because you said: "${ASKED}"`);
  });

  test("before any work exists, their message in this chat, named, stands behind it, as for every other lowering", () => {
    const proj = project();
    const asked = says(proj, ASKED);
    const r = flags(proj, ["--bypass", PRESENCE, "--local", "--yes", "--message", asked]);
    expect(r.status, r.out).toBe(0);
    expect(off(proj)).toBe(true);
  });

  test("a script or test with no chat, a switch that takes no decision, and turning a check back on are unchanged", () => {
    const proj = project();
    startWork(proj);
    const script = flags(proj, ["--bypass", PRESENCE, "--local", "--yes"], false);
    expect(script.status, script.out).toBe(0);
    expect(off(proj)).toBe(true);
    const back = flags(proj, ["--clear-bypass", PRESENCE, "--yes"]);
    expect(back.status, back.out).toBe(0);
    expect(off(proj)).toBe(false);
    const sensors = flags(proj, ["--bypass", "AIDLC_DISABLE_SENSORS", "--local", "--yes"]);
    expect(sensors.status, sensors.out).toBe(0);
    expect(off(proj, "AIDLC_DISABLE_SENSORS")).toBe(true);
  });
});
