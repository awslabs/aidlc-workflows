// covers: function:handleReview, function:noReviewerFinishedSinceReview, hook:aidlc-log-subagent,
// audit:REVIEW_COMPLETED, audit:SUBAGENT_COMPLETED
//
// #943 follow-up to #2427. On Claude Code a verdict recorded when no reviewer
// finished since its request is marked `Reviewer Finished Before Verdict: no`
// and said to the person. Another agent finishing is not the reviewer
// finishing: only a SUBAGENT_COMPLETED row that names the reviewer the request
// named and carries the Review File Digest for that request's review file
// counts. Before, any agent's completion row (or the heartbeat its hook wrote)
// cleared the mark, so dispatching an unrelated agent after the request did.
// Nothing here refuses a verdict; the mark-not-refuse design is kept.
//
// Mechanism: the shipped log-subagent hook and the log and state tools spawned
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
const LOG_TOOL = join(DIST_CLAUDE, "tools", "aidlc-log.ts");
const STATE_TOOL = join(DIST_CLAUDE, "tools", "aidlc-state.ts");
const SUBAGENT_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-log-subagent.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const LINE = "No reviewer finished the review for Requirements Analysis; its verdict was recorded without a reviewer.";
const CLAUDE_SHELL = { CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c01" };

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

/** The main agent writes the review file itself. */
function writes(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nWritten by the main agent.\n\n` +
      "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n",
    "utf-8",
  );
}

/** An agent finishes: the shipped SubagentStop hook records SUBAGENT_COMPLETED. */
function finishes(p: string, agent: string): void {
  const r = spawn(
    [SUBAGENT_HOOK],
    { CLAUDE_PROJECT_DIR: p },
    JSON.stringify({ hook_event_name: "SubagentStop", agent_type: agent, agent_id: `${agent}-1` }),
  );
  expect(r.status, r.out).toBe(0);
}

function verdict(p: string): { notices: string[]; completion: string } {
  const r = logReview(p, ["--verdict", "READY"]);
  expect(r.status, r.out).toBe(0);
  const output = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { change_notices?: string[] };
  const completions = readAllAuditShards(p).split("\n---\n").filter((b) => b.includes("**Event**: REVIEW_COMPLETED"));
  expect(completions).toHaveLength(1);
  return { notices: output.change_notices ?? [], completion: completions[0] };
}

function gateStart(p: string): string {
  const r = spawn([STATE_TOOL, "gate-start", STAGE, "--project-dir", p], {
    ...CLAUDE_SHELL,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  });
  expect(r.status, r.out).toBe(0);
  return r.out;
}

describe("another agent finishing is not the reviewer finishing", () => {
  test("an unrelated agent finished after the request: the verdict is still marked and said, once at the gate", () => {
    const p = project();
    writes(request(p));
    finishes(p, "general-purpose");
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([LINE]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
    expect(gateStart(p).split(LINE)).toHaveLength(2);
  });

  test("several unrelated agents, and their heartbeats, leave the mark in place", () => {
    const p = project();
    writes(request(p));
    for (const agent of ["general-purpose", "Explore", "aidlc-developer-agent"]) finishes(p, agent);
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([LINE]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
  });

  test("the reviewer finishing after an unrelated agent still clears it", () => {
    const p = project();
    const file = request(p);
    finishes(p, "general-purpose");
    writes(file);
    finishes(p, REVIEWER);
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });

  test("a completion row that names no agent is still a doubt: no mark", () => {
    const p = project();
    writes(request(p));
    finishes(p, "");
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });
});
