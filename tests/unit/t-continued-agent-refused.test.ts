// covers: hook:aidlc-deliver-stage-rules, hook:aidlc-log-subagent, function:continuedOnOtherWork,
// function:workOnRecord, function:isAidlcAgent, audit:SUBAGENT_COMPLETED, audit:STAGE_RULES_BLOCKED,
// audit:GUARD_STOOD_ASIDE, file:harness/claude/settings.json
//
// On Claude Code the conductor can continue a finished agent with SendMessage
// instead of dispatching a new one. The agent resumes with every earlier task in
// its context. The agent-start hook runs again for it, but what that hook adds
// reaches an agent only at its first start, so the rules of the new stage never
// arrive. The SubagentStop hook records the stage and Unit an AI-DLC agent
// finished on (`Agent Stage`, `Agent Unit`), read from the step the engine last
// issued; the PreToolUse registration of deliver-stage-rules refuses a
// SendMessage that would continue that agent on another stage or Unit, and says
// to dispatch a new agent. The check is one of the person's own switches
// (`guard.continued-agent`): off for this piece of work, the message goes through
// and the audit trail keeps a row. A follow-up on the same stage and Unit, an
// agent that is not AI-DLC's, a message to an agent with no completion row, and a
// row with no stage all go through.
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
  setGuardsOffLine,
  stateDigest,
  writeActiveDirectiveMarker,
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
const DEVELOPER = "aidlc-developer-agent";
const FIRST_STAGE = "requirements-analysis";
const NEXT_STAGE = "user-stories";
const CODE_STAGE = "code-generation";

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

/** The engine issues a step: the marker the hooks read the work from. */
function issues(p: string, stage: string, unit?: string): void {
  writeActiveDirectiveMarker(p, {
    kind: "run-stage",
    stage,
    ...(unit ? { unit } : {}),
    state_sha256: stateDigest(readFileSync(seededStateFile(p), "utf-8")),
  });
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
function finishes(p: string, agentId: string, agentType = REVIEWER): void {
  const r = hook(p, SUBAGENT_HOOK, { hook_event_name: "SubagentStop", agent_type: agentType, agent_id: agentId });
  expect(r.status, r.out).toBe(0);
}

/** The conductor continues the agent with a message. */
function message(p: string, to: string): { status: number; out: string } {
  return hook(p, DISPATCH_HOOK, {
    hook_event_name: "PreToolUse",
    tool_name: "SendMessage",
    tool_input: { to, message: "New review request." },
  });
}

function blocks(p: string, event: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
}

describe("a finished AI-DLC agent is not continued on other work", () => {
  test("the completion row names the stage and Unit the engine issued for the agent", () => {
    const p = project();
    issues(p, CODE_STAGE, "u1");
    finishes(p, "a1", DEVELOPER);
    const row = blocks(p, "SUBAGENT_COMPLETED").at(-1) ?? "";
    expect(row).toContain("**Agent ID**: a1");
    expect(row).toContain(`**Agent Stage**: ${CODE_STAGE}`);
    expect(row).toContain("**Agent Unit**: u1");
  });

  test("a follow-up on the same stage and Unit goes through", () => {
    const p = project();
    issues(p, FIRST_STAGE);
    finishes(p, "a1");
    const r = message(p, "a1");
    expect(r.status, r.out).toBe(0);
    expect(blocks(p, "STAGE_RULES_BLOCKED")).toHaveLength(0);
  });

  test("a message that would continue it on the next stage is refused, with the step to take and the switch", () => {
    const p = project();
    issues(p, FIRST_STAGE);
    finishes(p, "a1");
    issues(p, NEXT_STAGE);
    const r = message(p, "a1");
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain(`[aidlc] Not sent: this ${REVIEWER} finished its work on ${FIRST_STAGE}`);
    expect(r.out).toContain(`the work is now ${NEXT_STAGE}`);
    expect(r.out).toContain(`Dispatch a new ${REVIEWER} instead`);
    expect(r.out).toContain("turn the continued-agent check off for this piece of work");
    const refused = blocks(p, "STAGE_RULES_BLOCKED");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("**Reason**: continued-agent");
  });

  test("it reads the issued step, so it holds when Current Stage never moved (unit-major)", () => {
    const p = project();
    const state = readFileSync(seededStateFile(p), "utf-8");
    issues(p, CODE_STAGE, "u1");
    finishes(p, "a1", DEVELOPER);
    issues(p, "functional-design", "u1");
    expect(readFileSync(seededStateFile(p), "utf-8")).toBe(state);
    const r = message(p, "a1");
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain(`${CODE_STAGE} (Unit u1)`);
    expect(r.out).toContain("functional-design (Unit u1)");
  });

  test("a message that would continue it on another Unit of the same stage is refused, each side named once", () => {
    const p = project();
    issues(p, CODE_STAGE, "u1");
    finishes(p, "a1", DEVELOPER);
    issues(p, CODE_STAGE, "u2");
    const r = message(p, "a1");
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain(`finished its work on ${CODE_STAGE} (Unit u1)`);
    expect(r.out).toContain(`the work is now ${CODE_STAGE} (Unit u2)`);
  });

  test("an agent continued and finished again is judged on its last work", () => {
    const p = project();
    issues(p, FIRST_STAGE);
    finishes(p, "a1");
    issues(p, NEXT_STAGE);
    finishes(p, "a1");
    expect(message(p, "a1").status).toBe(0);
  });

  test("an agent still running, one with no stage on its row, and work with no issued step go through", () => {
    const p = project();
    issues(p, NEXT_STAGE);
    expect(message(p, "still-running").status).toBe(0);
    appendAuditEntry("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER, "Agent ID": "old" }, p);
    expect(message(p, "old").status).toBe(0);
    const q = project();
    finishes(q, "a1");
    expect(blocks(q, "SUBAGENT_COMPLETED").at(-1)).not.toContain("Agent Stage");
    expect(message(q, "a1").status).toBe(0);
    expect(blocks(p, "STAGE_RULES_BLOCKED")).toHaveLength(0);
  });

  test("an agent that is not AI-DLC's is never refused, and its row carries no stage", () => {
    const p = project();
    issues(p, FIRST_STAGE);
    finishes(p, "g1", "general-purpose");
    expect(blocks(p, "SUBAGENT_COMPLETED").at(-1)).not.toContain("Agent Stage");
    appendAuditEntry(
      "SUBAGENT_COMPLETED",
      { "Agent Type": "general-purpose", "Agent ID": "g2", "Agent Stage": FIRST_STAGE },
      p,
    );
    issues(p, NEXT_STAGE);
    expect(message(p, "g1").status).toBe(0);
    expect(message(p, "g2").status).toBe(0);
    expect(blocks(p, "STAGE_RULES_BLOCKED")).toHaveLength(0);
  });

  test("the person's own switch lowers it: the message goes through and the audit trail keeps a row", () => {
    const p = project();
    issues(p, FIRST_STAGE);
    finishes(p, "a1");
    issues(p, NEXT_STAGE);
    expect(message(p, "a1").status).toBe(2);
    const statePath = seededStateFile(p);
    writeFileSync(statePath, setGuardsOffLine(readFileSync(statePath, "utf-8"), ["continued-agent"], "set by you"));
    const r = message(p, "a1");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("continued-agent");
    const aside = blocks(p, "GUARD_STOOD_ASIDE");
    expect(aside).toHaveLength(1);
    expect(aside[0]).toContain("**Guard**: continued-agent");
    expect(aside[0]).toContain(`**Details**: ${REVIEWER}: ${FIRST_STAGE} to ${NEXT_STAGE}`);
  });

  test("the Claude row sees SendMessage before the call, not after", () => {
    const settings = JSON.parse(readFileSync(join(REPO_ROOT, "harness", "claude", "settings.json"), "utf-8")) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    const rowFor = (event: string) =>
      settings.hooks[event]?.find((group) => group.hooks.some((h) => h.command.endsWith(" engine hook deliver-stage-rules")));
    expect(new RegExp(`^(?:${rowFor("PreToolUse")?.matcher})$`).test("SendMessage")).toBe(true);
    expect(new RegExp(`^(?:${rowFor("PostToolUse")?.matcher})$`).test("SendMessage")).toBe(false);
  });
});
