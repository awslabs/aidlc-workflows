// covers: cli:aidlc-audit(append-reserved,append-batch-reserved), hook:aidlc-log-subagent,
// function:handleReview, function:noAgentFinishedSinceReview, audit:SUBAGENT_COMPLETED,
// audit:REVIEW_COMPLETED
//
// A verdict recorded with no agent finished since its request is marked
// `Reviewer Finished Before Verdict: no` (#2427, issue #943). Any
// SUBAGENT_COMPLETED row since the request clears that mark, so the row has
// to come from the host: the SubagentStop hook that saw an agent finish. The
// public audit CLI is the main agent's own shell command, so it must not be
// able to write one. SUBAGENT_COMPLETED is reserved there the way HUMAN_TURN
// is, and the reservation holds even with AIDLC_ALLOW_DIRECT_AUDIT_EVENTS=1
// (the test runner sets it for the whole suite).
//
// Mechanism: the shipped audit tool, SubagentStop hook and log tool spawned
// over a real ledger (DIST tree).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAllAuditShards, REVIEWER_FINISHED_FIELD } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const AUDIT_TOOL = join(DIST_CLAUDE, "tools", "aidlc-audit.ts");
const LOG_TOOL = join(DIST_CLAUDE, "tools", "aidlc-log.ts");
const SUBAGENT_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-log-subagent.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const RESERVED = "SUBAGENT_COMPLETED is reserved for its owning hook/tool";
// What Claude Code sets in its agent's shell; the test runner removes it, so a
// case is in Claude Code's shell only when it says so.
const CLAUDE_SHELL = { CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c01" };
// The bypass the suite sets for fixtures that simulate owning emitters: the
// reservation must not read it.
const DIRECT = { AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function project(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
  const dir = join(seededRecordDir(p), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n");
  writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Requirements Questions\n");
  return p;
}

function spawn(args: string[], env: Record<string, string>, input?: string): { status: number; out: string } {
  const r = spawnSync(BUN, args, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", ...env },
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function blocks(p: string, event: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
}

function logReview(p: string, extra: string[]): { status: number; out: string } {
  return spawn([LOG_TOOL, "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", ...extra, "--project-dir", p], CLAUDE_SHELL);
}

/** The request; returns the review file's absolute path. */
function request(p: string): string {
  const r = logReview(p, []);
  expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
  const { reviewFile } = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { reviewFile: string };
  return join(p, reviewFile);
}

/** The main agent writes the review itself, as a failed reviewer dispatch leaves it to. */
function writes(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nWritten in the chat.\n\n` +
      "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n",
    "utf-8",
  );
}

/** The main agent's forge attempts, from its own shell, under the suite's bypass. */
function forgeThroughCli(p: string): { append: { status: number; out: string }; batch: { status: number; out: string } } {
  const append = spawn(
    [AUDIT_TOOL, "append", "SUBAGENT_COMPLETED", "--field", `Agent Type=${REVIEWER}`, "--project-dir", p],
    { ...CLAUDE_SHELL, ...DIRECT },
  );
  const entries = JSON.stringify([
    { eventType: "ERROR_LOGGED", fields: { Details: "cover" } },
    { eventType: "SUBAGENT_COMPLETED", fields: { "Agent Type": REVIEWER } },
  ]);
  const batch = spawn([AUDIT_TOOL, "append-batch", entries, "--project-dir", p], { ...CLAUDE_SHELL, ...DIRECT });
  return { append, batch };
}

describe("SUBAGENT_COMPLETED is the SubagentStop hook's row, not the audit CLI's", () => {
  test("the public audit CLI refuses SUBAGENT_COMPLETED through append and append-batch", () => {
    const p = project();
    const { append, batch } = forgeThroughCli(p);
    expect(append.status, append.out).not.toBe(0);
    expect(append.out).toContain(RESERVED);
    expect(append.out).not.toContain('"appended"');
    expect(batch.status, batch.out).not.toBe(0);
    expect(batch.out).toContain(RESERVED);
    expect(blocks(p, "SUBAGENT_COMPLETED")).toHaveLength(0);
    // The batch is refused whole: its harmless entry did not land either.
    expect(blocks(p, "ERROR_LOGGED")).toHaveLength(0);
  });

  test("the shipped SubagentStop hook still records SUBAGENT_COMPLETED", () => {
    const p = project();
    const r = spawn(
      [SUBAGENT_HOOK],
      { CLAUDE_PROJECT_DIR: p },
      JSON.stringify({ hook_event_name: "SubagentStop", agent_type: REVIEWER, agent_id: "a1" }),
    );
    expect(r.status, r.out).toBe(0);
    const rows = blocks(p, "SUBAGENT_COMPLETED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`**Agent Type**: ${REVIEWER}`);
  });

  test("a forge attempt through the CLI leaves the verdict marked no reviewer finished (#2427)", () => {
    const p = project();
    writes(request(p));
    const { append, batch } = forgeThroughCli(p);
    expect(append.status, append.out).not.toBe(0);
    expect(batch.status, batch.out).not.toBe(0);
    const r = logReview(p, ["--verdict", "READY"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('"emitted":"REVIEW_COMPLETED"');
    const completion = blocks(p, "REVIEW_COMPLETED");
    expect(completion).toHaveLength(1);
    expect(completion[0]).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
    expect(blocks(p, "SUBAGENT_COMPLETED")).toHaveLength(0);
  });
});
