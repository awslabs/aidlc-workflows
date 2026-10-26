// covers: function:handleReview, function:noReviewerFinishedSinceReview, function:hostRecordsAgentFinishes,
// function:reviewCompletionWithoutReviewer, function:noReviewerNotice, hook:aidlc-log-subagent,
// hook:aidlc-deliver-stage-rules, subcommand:aidlc-state:gate-start, audit:REVIEW_COMPLETED,
// audit:SUBAGENT_COMPLETED
//
// A reviewer dispatch can fail (a quota or high-demand refusal) and the main
// agent then writes the review file itself (#943). On a host whose own stop
// event records every dispatched agent's finish before the agent that sent it
// sees the result (Claude Code declares it in harness.json), a verdict recorded
// with no agent finished since its request was recorded before any reviewer
// finished. `log review --verdict` still records it, refuses nothing, and marks
// the row `Reviewer Finished Before Verdict: no`; the person hears one line with
// the verdict, and the approval gate says it once more under strict. Only the
// reviewer finishing counts: its SUBAGENT_COMPLETED row, carrying the digest of
// the request's review file; another agent finishing is not it (see
// t-review-reviewer-finish-needs-the-reviewer). Every doubt says nothing:
// another host, a completion row that names no agent, a background agent sent
// since, a completion hook that ran since and left no row, a failure that hook
// recorded since, a delegated worktree. A missing row on a host that does not
// declare it is no evidence.
//
// Mechanism: the shipped hooks and the real log and state tools spawned over a
// real ledger (DIST tree), plus the pure helpers in-process.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AuditShardEvent,
  getField,
  GUARD_POLICY_FIELD,
  hooksHealthDir,
  hostRecordsAgentFinishes,
  noReviewerFinishedSinceReview,
  noReviewerNotice,
  readAllAuditShards,
  resolveWorkflowSelection,
  REVIEWER_FINISHED_FIELD,
  reviewCompletionWithoutReviewer,
  setGuardPolicyLine,
  subagentInflightMarkerPath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const LOG_TOOL = join(DIST_CLAUDE, "tools", "aidlc-log.ts");
const STATE_TOOL = join(DIST_CLAUDE, "tools", "aidlc-state.ts");
const SUBAGENT_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-log-subagent.ts");
const DISPATCH_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-deliver-stage-rules.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const LINE = "No reviewer finished the review for Requirements Analysis; its verdict was recorded without a reviewer.";
// What Claude Code sets in its agent's shell; the test runner removes it, so a
// case is in Claude Code's shell only when it says so.
const CLAUDE_SHELL = { CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c01" };

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function project(mode: "strict" | "relaxed" = "strict"): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
  if (mode === "relaxed") {
    const statePath = seededStateFile(p);
    const state = setGuardPolicyLine(readFileSync(statePath, "utf-8"), "relaxed (set by you)");
    expect(getField(state, GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    writeFileSync(statePath, state);
  }
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

function logReview(p: string, extra: string[], env: Record<string, string> = CLAUDE_SHELL): { status: number; out: string } {
  return spawn([LOG_TOOL, "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", ...extra, "--project-dir", p], env);
}

/** The request; returns the review file's absolute path. */
function request(p: string): string {
  const r = logReview(p, []);
  expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
  const { reviewFile } = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { reviewFile: string };
  return join(p, reviewFile);
}

function verdict(p: string, env: Record<string, string> = CLAUDE_SHELL): { notices: string[]; completion: string } {
  const r = logReview(p, ["--verdict", "READY"], env);
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain('"emitted":"REVIEW_COMPLETED"');
  const output = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { change_notices?: string[] };
  const completion = blocks(p, "REVIEW_COMPLETED");
  expect(completion).toHaveLength(1);
  return { notices: output.change_notices ?? [], completion: completion[0] };
}

/** The stage's approval gate opens: what the state tool prints is what the engine carries to the person. */
function gateStart(p: string): string {
  const r = spawn([STATE_TOOL, "gate-start", STAGE, "--project-dir", p], {
    ...CLAUDE_SHELL,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  });
  expect(r.status, r.out).toBe(0);
  return r.out;
}

function writes(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nFixture review.\n\n` +
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
    JSON.stringify({ hook_event_name: "SubagentStop", agent_type: agent, agent_id: "a1" }),
  );
  expect(r.status, r.out).toBe(0);
}

function blocks(p: string, event: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
}

/** Rows and heartbeats are second-precision: a later step lands in a later second. */
function nextSecond(): void {
  Bun.sleepSync(1100);
}

describe("a verdict no reviewer finished is marked and said once, never refused", () => {
  test("strict: the row says no reviewer had finished, the verdict says the line, and the gate says it once", () => {
    const p = project();
    writes(request(p));
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([LINE]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
    expect(reviewCompletionWithoutReviewer(completion)).toBe(true);
    expect(completion).toContain("**Verdict**: READY");
    expect(completion).not.toContain("Review Edited After Reviewer");
    const gate = gateStart(p);
    expect(gate).toContain("change_notices");
    expect(gate.split(LINE)).toHaveLength(2);
  });

  test("gate-start admits the gate twice: each review line is still said once (an edited review too)", () => {
    const p = project();
    const file = request(p);
    writes(file);
    finishes(p, REVIEWER);
    writeFileSync(file, readFileSync(file, "utf-8").replace("Fixture review.", "Edited in the chat."), "utf-8");
    const { notices } = verdict(p);
    const edited = "The review file for Requirements Analysis was edited after the reviewer finished.";
    expect(notices).toEqual([edited]);
    expect(gateStart(p).split(edited)).toHaveLength(2);
  });

  test("relaxed: said once with the verdict; the gate does not say it again", () => {
    const p = project("relaxed");
    writes(request(p));
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([LINE]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
    expect(blocks(p, "CHANGE_ACCEPTED")).toHaveLength(0);
    expect(gateStart(p)).not.toContain(LINE);
  });

  test("an agent that finished before the request does not count: the verdict is still marked", () => {
    const p = project();
    finishes(p, REVIEWER);
    nextSecond();
    writes(request(p));
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([LINE]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
  });
});

describe("every doubt says nothing", () => {
  test("the reviewer finished after the request: no mark, no line", () => {
    const p = project();
    const file = request(p);
    writes(file);
    finishes(p, REVIEWER);
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
    expect(gateStart(p)).not.toContain(LINE);
  });

  // #2427 expected any agent's completion to clear the mark. A named agent
  // that is not the reviewer now leaves it (an unrelated dispatch is the main
  // agent's own step, #943); a row naming no agent stays a doubt.
  test("an agent that finished after the request with no agent type: no mark", () => {
    const p = project();
    writes(request(p));
    finishes(p, "");
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });

  test("outside a host that declares it (no Claude Code shell): no mark", () => {
    const p = project();
    writes(request(p));
    const { notices, completion } = verdict(p, {});
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });

  test("a background agent sent after the request: no mark while it may still be writing", () => {
    const p = project();
    const file = request(p);
    const sent = spawn([DISPATCH_HOOK], { CLAUDE_PROJECT_DIR: p }, JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: REVIEWER, description: "review", prompt: `Review and write ${file}`, run_in_background: true },
    }));
    expect(sent.status, sent.out).toBe(0);
    expect(existsSync(subagentInflightMarkerPath(p))).toBe(true);
    writes(file);
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });
});

describe("the pure helpers", () => {
  const row = (event: string, fields: Record<string, string>, pos: number, shard = "a", timestamp = "2026-10-13T01:00:00Z"): AuditShardEvent => ({
    event,
    block: [`**Event**: ${event}`, ...Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`)].join("\n"),
    pos,
    shard,
    shardIndex: 0,
    timestamp,
  });

  function inClaudeShell<T>(run: () => T): T {
    const before = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = CLAUDE_SHELL.CLAUDE_CODE_SESSION_ID;
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = before;
    }
  }

  test("noReviewerFinishedSinceReview: the reviewer's row with the digest, a nameless row, a cross-shard tie, the heartbeat, the drops and the host", () => {
    const p = project();
    const selection = resolveWorkflowSelection(p);
    const reviewFile = ".aidlc-engine/reviews/requirements-analysis/stage/a1/1.r1.review.md";
    const requested = row("REVIEW_REQUESTED", { Stage: STAGE, Reviewer: REVIEWER }, 5, "a", "2026-10-13T01:00:00Z");
    const open = { reviewer: REVIEWER, reviewFile, row: requested };
    const digest = { "Review File Digest": `${reviewFile}=${"a".repeat(64)}` };
    const before = row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER, ...digest }, 2, "a", "2026-10-13T00:59:00Z");
    const after = (fields: Record<string, string>, shard = "a", timestamp = "2026-10-13T01:00:10Z") =>
      row("SUBAGENT_COMPLETED", fields, shard === "a" ? 6 : 1, shard, timestamp);
    inClaudeShell(() => {
      expect(hostRecordsAgentFinishes()).toBe(true);
      expect(noReviewerFinishedSinceReview(p, [before, requested], open, selection)).toBe(true);
      // The reviewer finished this review.
      expect(noReviewerFinishedSinceReview(p, [requested, after({ "Agent Type": REVIEWER, ...digest })], open, selection)).toBe(false);
      // A reviewer that left the file unwritten still finished.
      expect(noReviewerFinishedSinceReview(p, [requested, after({ "Agent Type": REVIEWER, "Review File Digest": `${reviewFile}=absent` })], open, selection)).toBe(false);
      // Another agent, the reviewer without the digest, or the digest of another review: not this reviewer finishing.
      expect(noReviewerFinishedSinceReview(p, [requested, after({ "Agent Type": "general-purpose", ...digest })], open, selection)).toBe(true);
      expect(noReviewerFinishedSinceReview(p, [requested, after({ "Agent Type": REVIEWER })], open, selection)).toBe(true);
      expect(noReviewerFinishedSinceReview(
        p,
        [requested, after({ "Agent Type": REVIEWER, "Review File Digest": `.aidlc-engine/reviews/other.review.md=${"b".repeat(64)}` })],
        open,
        selection,
      )).toBe(true);
      // A row that names no agent could be the reviewer's.
      expect(noReviewerFinishedSinceReview(p, [requested, after({ "Agent Type": "unknown" })], open, selection)).toBe(false);
      // Another shard in the same second is not definitely before the request.
      expect(noReviewerFinishedSinceReview(
        p,
        [requested, after({ "Agent Type": REVIEWER, ...digest }, "b", "2026-10-13T01:00:00Z")],
        open,
        selection,
      )).toBe(false);
      const health = hooksHealthDir(p, selection.intent ?? undefined, selection.space);
      mkdirSync(health, { recursive: true });
      // The completion hook ran since the request but left no row.
      writeFileSync(join(health, "log-subagent.last"), "2026-10-13T01:00:30Z");
      expect(noReviewerFinishedSinceReview(p, [requested], open, selection)).toBe(false);
      // That run's row is there (another agent's): the heartbeat is accounted for.
      expect(noReviewerFinishedSinceReview(p, [requested, after({ "Agent Type": "general-purpose" }, "a", "2026-10-13T01:00:30Z")], open, selection)).toBe(true);
      expect(noReviewerFinishedSinceReview(p, [requested, after({ "Agent Type": "general-purpose" }, "a", "2026-10-13T01:00:29Z")], open, selection)).toBe(false);
      writeFileSync(join(health, "log-subagent.last"), "2026-10-13T00:58:00Z");
      expect(noReviewerFinishedSinceReview(p, [requested], open, selection)).toBe(true);
      writeFileSync(join(health, "log-subagent.last"), "not a time");
      expect(noReviewerFinishedSinceReview(p, [requested], open, selection)).toBe(false);
      writeFileSync(join(health, "log-subagent.last"), "2026-10-13T00:58:00Z");
      // A failure the completion hook recorded since the request is a doubt; an older one is not.
      writeFileSync(join(health, "log-subagent.drops"), "2026-10-13T00:50:00Z\tolder failure\n");
      expect(noReviewerFinishedSinceReview(p, [requested], open, selection)).toBe(true);
      writeFileSync(join(health, "log-subagent.drops"), "2026-10-13T00:50:00Z\tolder failure\n2026-10-13T01:00:20Z\tappend failed\n");
      expect(noReviewerFinishedSinceReview(p, [requested], open, selection)).toBe(false);
    });
    expect(hostRecordsAgentFinishes()).toBe(false);
    expect(noReviewerFinishedSinceReview(p, [requested], open, selection)).toBe(false);
  });

  test("a chat whose hooks do not write into this record (a teammate's record in a fresh clone) says nothing", () => {
    const p = project();
    const selection = resolveWorkflowSelection(p);
    const requested = row("REVIEW_REQUESTED", { Stage: STAGE, Reviewer: REVIEWER }, 5, "a", "2026-10-13T01:00:00Z");
    const open = { reviewer: REVIEWER, reviewFile: ".aidlc-engine/reviews/r.review.md", row: requested };
    inClaudeShell(() => {
      expect(noReviewerFinishedSinceReview(p, [requested], open, selection)).toBe(true);
      // No cursor of this machine names the record: its completion rows would not be written here.
      rmSync(join(p, "aidlc", "spaces", "default", "intents", "active-intent"));
      expect(noReviewerFinishedSinceReview(p, [requested], open, resolveWorkflowSelection(p))).toBe(false);
    });
  });

  test("only Claude Code's harness data declares the host field", () => {
    const declared: string[] = [];
    for (const harness of readdirSync(join(REPO_ROOT, "dist"))) {
      const root = join(REPO_ROOT, "dist", harness);
      if (!statSync(root).isDirectory()) continue;
      for (const dir of readdirSync(root).filter((name) => name.startsWith("."))) {
        const data = join(root, dir, "tools", "data", "harness.json");
        if (!existsSync(data)) continue;
        const parsed = JSON.parse(readFileSync(data, "utf-8")) as { agentFinishRecorded?: { env: string[] } };
        if (parsed.agentFinishRecorded) declared.push(`${harness}:${parsed.agentFinishRecorded.env.join(",")}`);
      }
    }
    expect(declared).toEqual(["claude:CLAUDE_CODE_SESSION_ID"]);
  });

  test("the mark and the one line the person hears", () => {
    expect(reviewCompletionWithoutReviewer(`**Event**: REVIEW_COMPLETED\n**${REVIEWER_FINISHED_FIELD}**: no`)).toBe(true);
    expect(reviewCompletionWithoutReviewer("**Event**: REVIEW_COMPLETED\n**Review Finished**: no")).toBe(false);
    expect(noReviewerNotice("Requirements Analysis")).toBe(LINE);
    expect(noReviewerNotice("Functional Design", "u2-note-tags")).toBe(
      "No reviewer finished the review for Functional Design (u2-note-tags); its verdict was recorded without a reviewer.",
    );
  });
});
