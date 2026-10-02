// covers: function:lowerFenceRemedy, function:lowerFenceSentence, function:personSpokeSinceGate
//
// The person drives. When a guard offers turning a check off and the person
// picks it, or asks for it in their own words, the agent runs the existing
// setter itself and says in one line what changed. The setter accepts it
// because a person's turn is on record; nothing is printed for the person to
// type. A team's memory-held strict Guard Policy still wins, with its one-line
// reason, and with no person on record the setter refuses.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateGuardRefusal,
  getField,
  guardRecoveryAskForRefusal,
  lowerFenceSentence,
  personSpokeSinceGate,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { guardOperationMatchesCommand } from "../../dist/claude/.claude/tools/aidlc-guard-operation.ts";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seedAidlcMemory } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "t-agent-runs-the-check-switch";
const ENV = {
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "0",
  AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "0",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function run(tool: string, args: string[], proj: string): { status: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [BUN, tool, ...args, "--project-dir", proj],
    env: { ...process.env, ...ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// What the person types, through the real UserPromptSubmit route.
function says(proj: string, prompt: string): void {
  const result = Bun.spawnSync({
    cmd: [BUN, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
    cwd: proj,
    env: { ...process.env, ...ENV, CLAUDE_PROJECT_DIR: proj },
    stdin: Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: proj, session_id: SESSION, prompt })),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function project(): { proj: string; state: string } {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  const created = run(UTILITY, ["intent-create", "--scope", "enterprise", "--arguments", "check switch", "--label", "check-switch-fixture"], proj);
  expect(created.status, created.stderr).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return { proj, state: join(intents, active, "aidlc-state.md") };
}

function refusalError(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/).reverse().find((entry) => entry.startsWith("{"));
  return line ? (JSON.parse(line) as { error?: string }).error ?? stderr : stderr;
}

const turnOff = ["config-change", "--guard.review-freeze", "off"];

describe("a guard's turn-it-off choice is a command the agent runs", () => {
  const refusal = () => evaluateGuardRefusal({
    code: "REVIEW_FREEZE_ACTIVE",
    blockedAction: "artifact-write:requirements.md",
    stage: "requirements-analysis",
    stateContent: "# State\n",
    invariant: "A terminal review continues to cover the bytes it certified.",
    userMessage: "The reviewed artifact is frozen.",
    attempt: { recovery: "spent", summaryCoverage: "current", reviewCoverage: "current", sourceCoverage: "current" },
    humanAuthority: { freshTurn: true, unattended: false },
    fence: "review-freeze",
    fenceSwitch: "offer",
  });

  test("its command is the setter, and it never tells the person to type anything", () => {
    const remedy = refusal().remedies.at(-1)!;
    expect(remedy).toMatchObject({
      op: "lower-fence",
      interaction: "command",
      operation: { kind: "lower-fence", fence: "review-freeze" },
      requiresHuman: true,
      executableNow: true,
    });
    expect(guardOperationMatchesCommand(remedy.operation!, remedy.command!)).toBe(true);
    expect(remedy.action).toStartWith("Turn the review-freeze check off for this piece of work.");
    expect(remedy.action).toContain("tell the person in one line");
    expect(remedy.action).not.toMatch(/\/aidlc|\$aidlc|typ(e|ing)|yourself/);
  });

  test("the recovery question that offers it is a valid directive", () => {
    const ask = guardRecoveryAskForRefusal(refusal())!;
    expect(ask.remedies.some((remedy) => remedy.op === "lower-fence")).toBe(true);
    expect(validateDirective(ask)).toMatchObject({ valid: true });
  });

  test("a prose refusal tells the agent to offer it and run the setter itself", () => {
    const sentence = lowerFenceSentence("state-transition");
    expect(sentence).toContain("offer to turn the state-transition check off for this piece of work");
    expect(sentence).toMatch(/run `[^`]+config-change --guard\.state-transition off` yourself|run `aidlc engine config set guard\.state-transition off` yourself/);
    // No slash command for the person to type (the setter's own path is fine).
    expect(sentence).not.toMatch(/(^|[\s`])[/$]aidlc\b/);
  });
});

describe("the setter carries out the person's choice", () => {
  test("with the person's turn on record, the agent's setter turns the check off", () => {
    const { proj, state } = project();
    expect(personSpokeSinceGate(proj)).toBe(false);
    says(proj, "yes, turn the review freeze off for this");
    expect(personSpokeSinceGate(proj)).toBe(true);
    const lowered = run(UTILITY, turnOff, proj);
    expect(lowered.status, lowered.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Guards Off")).toContain("review-freeze");
    expect(readAuditShardEvents(proj).some((row) => row.event === "GUARD_DISABLED")).toBe(true);
  });

  test("with no person on record, the setter refuses and changes nothing", () => {
    const { proj, state } = project();
    const before = readFileSync(state, "utf-8");
    const refused = run(UTILITY, turnOff, proj);
    expect(refused.status).toBe(1);
    expect(refusalError(refused.stderr)).toContain(
      "Turning the review-freeze check off is the person's call. No reply from the person has arrived since the last decision",
    );
    expect(readFileSync(state, "utf-8")).toBe(before);
  });

  test("a team's strict Guard Policy wins, with its one-line reason", () => {
    const { proj, state } = project();
    const memory = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
    writeFileSync(memory, readFileSync(memory, "utf-8").replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n"));
    says(proj, "turn the review freeze off");
    const before = readFileSync(state, "utf-8");
    const refused = run(UTILITY, turnOff, proj);
    expect(refused.status).toBe(1);
    expect(refusalError(refused.stderr)).toBe(
      `Your team set Guard Policy to strict in ${memory} (section: Guard Policy), so review-freeze stays on for ` +
        "everyone on this repo. Changing that line there changes it.",
    );
    expect(readFileSync(state, "utf-8")).toBe(before);
  });

  test("recording a pick from a refusal that opened no question is a no-op, not an error", () => {
    const { proj } = project();
    says(proj, "turn it off");
    const recorded = run(LOG, [
      "answer", "--stage", "requirements-analysis", "--checkpoint", "guard-recovery",
      "--details", "Turn the review-freeze check off for this piece of work.",
    ], proj);
    expect(recorded.status, recorded.stderr).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ recorded: null });
  });
});
