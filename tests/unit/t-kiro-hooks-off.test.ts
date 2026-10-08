// covers: file:tools/aidlc-kiro-hooks-off.ts, subcommand:aidlc-utility:doctor, subcommand:aidlc-orchestrate:next
//
// Kiro IDE's Agent Hooks panel switches a project hook off by writing
// `"enabled": false` into its file under .kiro/hooks/; Kiro CLI's .kiro.hook
// files carry the same key. A person who did that after a flood of hook cards
// ran six Units with no plan or approval guard and no word from anyone, and a
// switched-off reply hook read as "your reply was not recorded, trust the
// folder and reload" (#2203). The person's switch stands (nothing turns a hook
// back on): doctor names each hook that is off and the step in Kiro's words,
// the engine's next step says it once per change, and a reply hook that is off
// is named as the cause instead of the trust step.

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
  kiroHooksOffDoctorChecks,
  kiroHooksOffNotices,
  kiroHooksSwitchedOff,
  kiroReplyHookSwitchedOff,
  markKiroHooksOffSaid,
} from "../../core/tools/aidlc-kiro-hooks-off.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
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

// What Kiro writes when the person switches a hook off in Agent Hooks: the
// same file with `"enabled": false` on the hook entry.
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

describe("t-kiro-hooks-off: a hook the person switched off in Kiro is named, never turned back on", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedKiroIde();
  });
  afterEach(() => cleanupTestProject(proj));

  test("the shipped hook files are all on, and a hook Kiro switched off is found by name with the file time", () => {
    expect(kiroHooksSwitchedOff(proj)).toEqual([]);
    const at = new Date("2026-10-06T23:09:18.000Z");
    switchOff(GUARD, at);
    const off = kiroHooksSwitchedOff(proj);
    expect(off.map((hook) => hook.name)).toEqual([GUARD]);
    expect(off[0].file).toBe(`.kiro/hooks/${GUARD}.json`);
    expect(off[0].since).toBe(at.toISOString());
    // The person's switch stands: reading never writes the file.
    expect(JSON.parse(readFileSync(join(proj, ".kiro", "hooks", `${GUARD}.json`), "utf-8")).hooks[0].enabled).toBe(false);
  });

  test("a Kiro CLI .kiro.hook file with enabled false is found too; another harness has nothing", () => {
    writeFileSync(
      join(proj, ".kiro", "hooks", "aidlc-plan-approval-guard.kiro.hook"),
      // Kiro CLI's shape, as a string: its "then" key is Kiro's, not a thenable.
      '{"version":"1.0.0","enabled":false,"name":"aidlc-plan-approval-guard","when":{"type":"preToolUse"},"then":{"type":"runCommand","command":"x"}}',
    );
    expect(kiroHooksSwitchedOff(proj).map((hook) => hook.name)).toEqual(["aidlc-plan-approval-guard"]);
    expect(kiroHooksSwitchedOff(proj, ".claude")).toEqual([]);
    expect(kiroHooksOffDoctorChecks(proj, ".claude")).toEqual([]);
  });

  test("the line says what the hook does, since when, what stops, and the Agent Hooks step", () => {
    switchOff(GUARD, new Date("2026-10-06T23:09:18.000Z"));
    const [hook] = kiroHooksSwitchedOff(proj);
    const line = kiroHookOffLine(hook, new Date("2026-10-08T06:46:00.000Z"));
    expect(line).toContain("is switched off in Kiro's Agent Hooks (aidlc-guard-tool-call) since 2026-10-0");
    expect(line).toContain("approvals, the approved plan and AI-DLC's records are not protected while it is off.");
    expect(line.endsWith(KIRO_HOOKS_OFF_STEP)).toBe(true);
    expect(line).not.toMatch(/hook file|enabled|json/i);
  });

  test("doctor fails one row per hook that is off, with the step, and passes silently when all are on", () => {
    const before = run(UTILITY, ["doctor", "--verbose"]).out;
    expect(before).not.toContain("switched off in Kiro's Agent Hooks");
    switchOff(GUARD);
    switchOff(REPLY);
    const after = run(UTILITY, ["doctor", "--verbose"]).out;
    expect(after).toContain(`AI-DLC hook ${GUARD} is switched off in Kiro's Agent Hooks: approvals, the approved plan and AI-DLC's records are not protected while it is off`);
    expect(after).toContain(`AI-DLC hook ${REPLY} is switched off in Kiro's Agent Hooks: your answers to AI-DLC's questions are not seen while it is off`);
    expect(after).toContain("turn it back on under Agent Hooks in Kiro");
    switchOn(GUARD);
    switchOn(REPLY);
    expect(run(UTILITY, ["doctor", "--verbose"]).out).not.toContain("switched off in Kiro's Agent Hooks");
  });

  test("the engine's next step says a switch-off once, and again only after the hook was on and off again", () => {
    seedStateFile(proj, "state-mid-ideation.md");
    seedAidlcMemory(proj);
    switchOff(GUARD, new Date("2026-10-06T23:09:18.000Z"));
    const first = nextDirective();
    const notices = (first.change_notices as string[] | undefined) ?? [];
    expect(notices.some((line) => line.includes("switched off in Kiro's Agent Hooks (aidlc-guard-tool-call)")), JSON.stringify(first)).toBe(true);
    const second = nextDirective();
    expect(((second.change_notices as string[] | undefined) ?? []).some((line) => line.includes("Agent Hooks"))).toBe(false);
    // Back on, then off again later: a new change, said again.
    switchOn(GUARD);
    expect(((nextDirective().change_notices as string[] | undefined) ?? []).some((line) => line.includes("Agent Hooks"))).toBe(false);
    switchOff(GUARD, new Date("2026-10-07T01:00:00.000Z"));
    expect(((nextDirective().change_notices as string[] | undefined) ?? []).some((line) => line.includes("Agent Hooks"))).toBe(true);
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
