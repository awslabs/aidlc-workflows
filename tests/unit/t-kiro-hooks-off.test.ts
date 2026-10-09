// covers: file:tools/aidlc-kiro-hooks-off.ts, function:kiroHookFileSwitchedOff, function:kiroReplyHookSwitchedOff, subcommand:aidlc-orchestrate:next
//
// Kiro IDE's Agent Hooks panel switches a project hook off by writing
// `"enabled": false` into its file under .kiro/hooks/. A person who did that
// after a flood of hook cards ran six Units with no plan or approval guard and
// no word from anyone, and a switched-off reply hook read as "your reply was
// not recorded, trust the folder and reload" (#2203). Doctor names each hook
// that is off (its reader, kiroDisabledHooks, is shared here); the engine's
// next step says it once per change, and a reply hook that is off is named as
// the cause instead of the trust step. The person's switch stands: nothing
// turns a hook back on.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject, REPO_ROOT, resetAidlcEnv, seedAidlcMemory, seedStateFile } from "../harness/fixtures.ts";
import {
  KIRO_HOOKS_OFF_STEP,
  kiroHookOffLine,
  kiroHooksOff,
  kiroHooksOffNotices,
  markKiroHooksOffSaid,
} from "../../core/tools/aidlc-kiro-hooks-off.ts";
import { kiroDisabledHookChecks } from "../../core/tools/aidlc-utility.ts";
// The packaged Kiro IDE library: its harness data carries Kiro's own hooks-off
// agent step, which the reply-hook line must come before.
import {
  kiroHookFileSwitchedOff,
  kiroReplyHookSwitchedOff,
  unattendedHumanPresenceHint,
} from "../../dist/kiro-ide/.kiro/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/kiro-ide/.kiro/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SHIPPED_HOOKS = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks");
const GUARD = "aidlc-guard-tool-call";
const REPLY = "aidlc-record-human-turn";

let proj: string;

// A Kiro IDE project: the shipped hook files and the conductor agent file.
function seedKiroIde(): void {
  const hooks = join(proj, ".kiro", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const name of [GUARD, REPLY, "aidlc-session-start", "aidlc-continue-workflow", "aidlc-log-subagent"]) {
    writeFileSync(join(hooks, `${name}.json`), readFileSync(join(SHIPPED_HOOKS, `${name}.json`), "utf-8"));
  }
  mkdirSync(join(proj, ".kiro", "agents"), { recursive: true });
  writeFileSync(join(proj, ".kiro", "agents", "aidlc.md"), "---\nname: aidlc\n---\n# AI-DLC conductor\n");
}

// What Kiro IDE 1.2.4 writes when the person switches a hook off in Agent
// Hooks (measured): the same file with `"enabled": false` on the hook entry.
function switchOff(name: string, at?: Date): void {
  const path = join(proj, ".kiro", "hooks", `${name}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { hooks: Array<Record<string, unknown>> };
  parsed.hooks = parsed.hooks.map((hook) => ({ ...hook, enabled: false }));
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  if (at) utimesSync(path, at, at);
}

function switchOn(name: string): void {
  const path = join(proj, ".kiro", "hooks", `${name}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { hooks: Array<Record<string, unknown>> };
  parsed.hooks = parsed.hooks.map(({ enabled: _enabled, ...hook }) => hook);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

function run(tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, AIDLC_HARNESS_DIR: ".kiro", ...extra };
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function nextDirective(): Record<string, unknown> {
  const r = run(ORCHESTRATE, ["next"], { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
  const line = r.out.split("\n").find((entry) => entry.startsWith("{"));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

function withKiroHarness(body: () => void): void {
  const harness = process.env.AIDLC_HARNESS_DIR;
  process.env.AIDLC_HARNESS_DIR = ".kiro";
  try {
    body();
  } finally {
    if (harness === undefined) delete process.env.AIDLC_HARNESS_DIR;
    else process.env.AIDLC_HARNESS_DIR = harness;
  }
}

describe("t-kiro-hooks-off: a hook the person switched off in Kiro is said once by the next step, and named at a refused reply", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedKiroIde();
  });
  afterEach(() => cleanupTestProject(proj));

  test("the shipped hook files are all on; a hook Kiro switched off is found with its file time, and another harness has nothing", () => {
    expect(kiroHooksOff(proj)).toEqual([]);
    switchOff(GUARD, new Date("2026-10-06T23:09:18.000Z"));
    const off = kiroHooksOff(proj);
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ name: GUARD, file: `.kiro/hooks/${GUARD}.json`, since: "2026-10-06T23:09:18.000Z" });
    expect(off[0].protects).toContain("approvals, the approved plan");
    // The file is left as the person set it.
    expect(readFileSync(join(proj, ".kiro", "hooks", `${GUARD}.json`), "utf-8")).toContain('"enabled": false');
    expect(kiroHooksOff(proj, ".claude")).toEqual([]);
  });

  test("the step names the hooks doctor fails on, and leaves the ones doctor only warns about to doctor", () => {
    switchOff(GUARD);
    switchOff("aidlc-session-start");
    expect(kiroHooksOff(proj).map((hook) => hook.name)).toEqual([GUARD]);
    expect(kiroDisabledHookChecks(proj, ".kiro").map((row) => [row.pass, row.severity ?? "fail"])).toEqual([[false, "fail"], [true, "warn"]]);
  });

  test("a hook file saved with a byte order mark is read the same", () => {
    const path = join(proj, ".kiro", "hooks", `${GUARD}.json`);
    const text = readFileSync(path, "utf-8").replace('"hooks": [', '"hooks": [').replace(/\{\s*"name"/, '{ "enabled": false, "name"');
    expect(kiroHookFileSwitchedOff(text)).toBe(true);
    expect(kiroHookFileSwitchedOff(`\uFEFF${text}`)).toBe(true);
    expect(kiroHookFileSwitchedOff("not json")).toBe(false);
    expect(kiroHookFileSwitchedOff("null")).toBe(false);
    writeFileSync(path, `\uFEFF${text}`);
    expect(kiroHooksOff(proj).map((hook) => hook.name)).toEqual([GUARD]);
  });

  test("the line names the hook, since when, what is no longer protected, and the Agent Hooks step, in doctor's words", () => {
    switchOff(GUARD, new Date("2026-10-06T23:09:18.000Z"));
    const [hook] = kiroHooksOff(proj);
    // The clock is the person's own (local time): today's time alone, else the date too.
    const at = new Date(hook.since);
    const line = kiroHookOffLine(hook, at);
    expect(line).toMatch(/^AI-DLC hook aidlc-guard-tool-call is switched off in Kiro's Agent Hooks since \d{2}:\d{2}: /);
    expect(line).toEndWith(`${hook.protects}. ${KIRO_HOOKS_OFF_STEP}`);
    expect(kiroHookOffLine(hook, new Date(at.getTime() + 3 * 24 * 3600 * 1000))).toMatch(/ since \d{4}-\d{2}-\d{2} \d{2}:\d{2}: /);
    expect(kiroDisabledHookChecks(proj, ".kiro")[0].label).toBe(`AI-DLC hook aidlc-guard-tool-call is switched off in Kiro's Agent Hooks: ${hook.protects}`);
  });

  test("the engine's next step says a switch-off once, and again only after the hook was on and off again", () => {
    seedStateFile(proj, "state-mid-ideation.md");
    seedAidlcMemory(proj);
    switchOff(GUARD, new Date("2026-10-06T23:09:18.000Z"));
    const first = nextDirective();
    const notices = (first.change_notices as string[] | undefined) ?? [];
    expect(notices.some((line) => line.startsWith("AI-DLC hook aidlc-guard-tool-call is switched off in Kiro's Agent Hooks since")), JSON.stringify(first)).toBe(true);
    const second = nextDirective();
    expect(((second.change_notices as string[] | undefined) ?? []).some((line) => line.includes("Agent Hooks"))).toBe(false);
    // Back on, then off again later: a new change, said again.
    switchOn(GUARD);
    expect(((nextDirective().change_notices as string[] | undefined) ?? []).some((line) => line.includes("Agent Hooks"))).toBe(false);
    switchOff(GUARD, new Date("2026-10-07T01:00:00.000Z"));
    expect(((nextDirective().change_notices as string[] | undefined) ?? []).some((line) => line.includes("Agent Hooks"))).toBe(true);
  });

  test("a reply not recorded while the reply hook is off names Agent Hooks, not the trust step", () => {
    withKiroHarness(() => {
      const before = unattendedHumanPresenceHint(proj);
      expect(before).not.toContain("Agent Hooks");
      switchOff(REPLY);
      const hint = unattendedHumanPresenceHint(proj);
      expect(hint).toContain("switched off under Agent Hooks in Kiro");
      expect(hint).toContain("Do not ask them to answer again");
      expect(hint).toContain("Never offer to turn a check off for them.");
      expect(hint).not.toMatch(/Trust Folder|Reload Window|Restricted Mode/);
      switchOn(REPLY);
      expect(unattendedHumanPresenceHint(proj)).not.toContain("Agent Hooks");
    });
  });

  // With a gate open and no heartbeat at all, the hint used to reach the
  // hooks-never-ran step (trust the folder, reload) before looking at the reply
  // hook, and that step does not turn the hook back on.
  test("with a gate open and no heartbeat, the switched-off reply hook is named before the hooks-off step", () => {
    withKiroHarness(() => {
      seedStateFile(proj, "state-mid-ideation.md");
      appendAuditEntry("STAGE_AWAITING_APPROVAL", { Stage: "feasibility" }, proj);
      const hooksOff = unattendedHumanPresenceHint(proj);
      expect(hooksOff).toContain("Kiro is not running AI-DLC's hooks in this folder");
      expect(hooksOff).not.toContain("Agent Hooks");
      switchOff(REPLY);
      const hint = unattendedHumanPresenceHint(proj);
      expect(hint).toContain("switched off under Agent Hooks in Kiro");
      expect(hint).not.toContain("Kiro is not running AI-DLC's hooks");
      expect(hint).not.toMatch(/Trust Folder|Reload Window|Restricted Mode/);
    });
  });

  // The summary choice refuses for a reply not given yet (`missedReply: false`);
  // a reply not given yet is not a lost one, whatever the reply hook's state.
  test("a reply not given yet is not a lost one: with the reply hook off, that refusal says nothing about Agent Hooks", () => {
    withKiroHarness(() => {
      switchOff(REPLY);
      const notYet = unattendedHumanPresenceHint(proj, { missedReply: false });
      expect(notYet).not.toMatch(/not recorded|Agent Hooks|answer again|once more/);
      expect(unattendedHumanPresenceHint(proj)).toContain("switched off under Agent Hooks in Kiro");
    });
  });

  test("the said mark follows the file time, and the reply hook is told apart", () => {
    switchOff(GUARD, new Date("2026-10-06T23:09:18.000Z"));
    expect(kiroHooksOffNotices(proj)).toHaveLength(1);
    markKiroHooksOffSaid(proj);
    expect(kiroHooksOffNotices(proj)).toHaveLength(0);
    expect(existsSync(join(proj, "aidlc", ".aidlc-sessions", "kiro-hooks-off-said.json"))).toBe(true);
    switchOff(GUARD, new Date("2026-10-06T23:40:07.000Z"));
    expect(kiroHooksOffNotices(proj)).toHaveLength(1);
    expect(kiroReplyHookSwitchedOff(proj)).toBe(false);
    switchOff(REPLY);
    expect(kiroReplyHookSwitchedOff(proj)).toBe(true);
  });
});
