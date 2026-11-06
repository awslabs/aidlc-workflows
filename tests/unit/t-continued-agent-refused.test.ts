// covers: hook:aidlc-deliver-stage-rules, hook:aidlc-log-subagent, function:continuedOnOtherWork,
// function:agentWork, audit:SUBAGENT_COMPLETED, audit:STAGE_RULES_BLOCKED, file:harness/claude/settings.json
//
// On Claude Code the conductor can continue a finished agent with SendMessage
// instead of dispatching a new one (#3549). The continued agent keeps every
// earlier task in its context, and no SubagentStart runs, so it never gets the
// new stage's rules. The SubagentStop hook records the stage and Unit an agent
// worked on (`Agent Stage`, `Agent Unit`); the PreToolUse registration of
// deliver-stage-rules refuses a SendMessage that would continue that agent on
// another stage or Unit, and says to dispatch a new agent. A follow-up on the
// same stage and Unit, a message to an agent with no completion row, and a row
// an earlier release wrote (no stage) all go through.
//
// Mechanism: the shipped hooks spawned over a real ledger (DIST tree).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  readAllAuditShards,
  setFieldStrict,
  setOrInsertField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedAidlcMemory,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const SUBAGENT_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-log-subagent.ts");
const DISPATCH_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-deliver-stage-rules.ts");
const REVIEWER = "aidlc-product-lead-agent";
const FIRST_STAGE = "requirements-analysis";
const NEXT_STAGE = "user-stories";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function project(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
  return p;
}

function editState(p: string, edit: (state: string) => string): void {
  const path = seededStateFile(p);
  writeFileSync(path, edit(readFileSync(path, "utf-8")));
}

function moveTo(p: string, stage: string): void {
  editState(p, (state) => setFieldStrict(state, "Current Stage", stage));
}

function onUnit(p: string, unit: string): void {
  editState(p, (state) => setOrInsertField(state, "## Runtime State", "Active Unit", unit));
}

function hook(p: string, script: string, payload: Record<string, unknown>): { status: number; out: string } {
  const r = spawnSync(BUN, [script], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
    input: JSON.stringify(payload),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The agent finishes: the shipped SubagentStop hook records SUBAGENT_COMPLETED. */
function finishes(p: string, agentId: string): void {
  const r = hook(p, SUBAGENT_HOOK, { hook_event_name: "SubagentStop", agent_type: REVIEWER, agent_id: agentId });
  expect(r.status, r.out).toBe(0);
}

/** The conductor continues the agent with a message. */
function message(p: string, to: string): { status: number; out: string } {
  return hook(p, DISPATCH_HOOK, {
    hook_event_name: "PreToolUse",
    tool_name: "SendMessage",
    tool_input: { to, message: "New review request: stage user-stories, iteration 1." },
  });
}

function blocks(p: string, event: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
}

describe("a finished agent is not continued on other work", () => {
  test("the completion row names the stage and Unit the agent worked on", () => {
    const p = project();
    onUnit(p, "u1");
    finishes(p, "a1");
    const row = blocks(p, "SUBAGENT_COMPLETED").at(-1) ?? "";
    expect(row).toContain("**Agent ID**: a1");
    expect(row).toContain(`**Agent Stage**: ${FIRST_STAGE}`);
    expect(row).toContain("**Agent Unit**: u1");
  });

  test("a follow-up on the same stage and Unit goes through", () => {
    const p = project();
    finishes(p, "a1");
    const r = message(p, "a1");
    expect(r.status, r.out).toBe(0);
    expect(blocks(p, "STAGE_RULES_BLOCKED")).toHaveLength(0);
  });

  test("a message that would continue it on the next stage is refused, with the step to take", () => {
    const p = project();
    finishes(p, "a1");
    moveTo(p, NEXT_STAGE);
    const r = message(p, "a1");
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain(`[aidlc] Not sent: this ${REVIEWER} finished its work on ${FIRST_STAGE}`);
    expect(r.out).toContain(`the work is now ${NEXT_STAGE}`);
    expect(r.out).toContain(`Dispatch a new ${REVIEWER} instead`);
    const refused = blocks(p, "STAGE_RULES_BLOCKED");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("**Reason**: continued-agent");
  });

  test("a message that would continue it on another Unit of the same stage is refused", () => {
    const p = project();
    onUnit(p, "u1");
    finishes(p, "a1");
    onUnit(p, "u2");
    const r = message(p, "a1");
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain(`${FIRST_STAGE} (Unit u1)`);
    expect(r.out).toContain(`${FIRST_STAGE} (Unit u2)`);
  });

  test("an agent continued and finished again is judged on its last work", () => {
    const p = project();
    finishes(p, "a1");
    moveTo(p, NEXT_STAGE);
    finishes(p, "a1");
    expect(message(p, "a1").status).toBe(0);
  });

  test("a message to an agent with no completion row, or a row with no stage, goes through", () => {
    const p = project();
    moveTo(p, NEXT_STAGE);
    expect(message(p, "still-running").status).toBe(0);
    appendAuditEntry("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER, "Agent ID": "old" }, p);
    expect(message(p, "old").status).toBe(0);
    expect(blocks(p, "STAGE_RULES_BLOCKED")).toHaveLength(0);
  });

  test("the hook's Claude row sees SendMessage before the call, not after", () => {
    const settings = JSON.parse(readFileSync(join(REPO_ROOT, "harness", "claude", "settings.json"), "utf-8")) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    const rowFor = (event: string) =>
      settings.hooks[event]?.find((group) => group.hooks.some((h) => h.command.endsWith(" engine hook deliver-stage-rules")));
    expect(new RegExp(`^(?:${rowFor("PreToolUse")?.matcher})$`).test("SendMessage")).toBe(true);
    expect(new RegExp(`^(?:${rowFor("PostToolUse")?.matcher})$`).test("SendMessage")).toBe(false);
  });
});

