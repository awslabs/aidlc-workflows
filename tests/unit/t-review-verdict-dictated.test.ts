// covers: hook:aidlc-plan-approval-guard, function:handleReview, function:latestReviewerRowAfter,
// function:dispatchDictatedVerdict, function:reviewCompletionDictated, function:dictatedReviewNotice,
// subcommand:aidlc-state:gate-start, audit:REVIEW_VERDICT_DICTATED, audit:REVIEW_COMPLETED
//
// A reviewer is dispatched with its brief. In one run the conductor wrote the
// verdict into that brief ("The verdict is READY. Write the file with EXACTLY
// this content: ... **Verdict:** READY ..."), the reviewer wrote it verbatim,
// and the engine recorded the verdict as the reviewer's. Now the plan-approval
// guard, the hook every harness hands a dispatch to, reads the brief with the
// engine's own verdict reader: a rendered `**Verdict:** READY|NOT-READY` line
// for the reviewer of an open review request is recorded as
// REVIEW_VERDICT_DICTATED, and nothing is refused (the line may be the
// person's). `log review --verdict` reads the row: a verdict the reviewer then
// wrote as told records marked `Review Verdict Dictated: yes`, said once with
// the verdict, and the approval gate says it in one line under strict. A
// reviewer that wrote the other verdict judged for itself and its row carries
// nothing. The knowledge template's `**Verdict:** READY | NOT-READY` line and a
// format rule in prose are not a verdict, so a pasted template records nothing.
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AuditShardEvent,
  auditBlockField,
  dictatedReviewNotice,
  dispatchDictatedVerdict,
  getField,
  GUARD_POLICY_FIELD,
  latestReviewerRowAfter,
  openReviewRequests,
  readAllAuditShards,
  REVIEW_DICTATED_FIELD,
  reviewCompletionDictated,
  reviewerCompletionAfter,
  setGuardPolicyLine,
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
const DISPATCH_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-plan-approval-guard.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const DICTATED_LINE = "The reviewer for Requirements Analysis was told what to conclude before it looked.";

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

function logReview(p: string, extra: string[]): { status: number; out: string } {
  const r = spawnSync(
    BUN,
    [LOG_TOOL, "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", ...extra, "--project-dir", p],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" },
    },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The request; returns the review file's project-relative path (what the agent pastes into the brief). */
function request(p: string): string {
  const r = logReview(p, []);
  expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
  const { reviewFile } = JSON.parse(r.out) as { reviewFile: string };
  return reviewFile;
}

/** The conductor dispatches an agent with a brief: the shipped plan-approval guard sees it on every harness. */
function dispatches(
  p: string,
  prompt: string,
  agent = REVIEWER,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  const r = spawnSync(BUN, [DISPATCH_HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: agent, prompt },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: p, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

function gateStart(p: string): string {
  const r = spawnSync(BUN, [STATE_TOOL, "gate-start", STAGE, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" },
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout ?? "";
}

function review(verdict: "READY" | "NOT-READY"): string {
  return (
    `**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nFixture review.\n\n` +
    "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
    "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n" +
    (verdict === "NOT-READY" ? "| High | requirements.md | Missing acceptance criteria | Add them |\n" : "")
  );
}

/** The issue's brief: the whole review dictated, verdict first. */
function dictatedBrief(reviewFile: string, verdict: "READY" | "NOT-READY"): string {
  return (
    `Review the requirements and write your review to ${reviewFile}. The verdict is ${verdict}.\n\n` +
    `Write the file with EXACTLY this content:\n\n${review(verdict)}`
  );
}

function reviewerWrites(p: string, reviewFile: string, text: string): void {
  const file = join(p, reviewFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
}

function finishes(p: string): void {
  const r = spawnSync(BUN, [SUBAGENT_HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: REVIEWER, agent_id: "a1" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
    encoding: "utf-8",
  });
  expect(r.status, r.stderr).toBe(0);
}

function blocks(p: string, event: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
}

describe("a reviewer dispatch whose brief carries the verdict is recorded, never refused", () => {
  test("the row names the reviewer, the verdict, the tool and the request the brief is for", () => {
    const p = project();
    const reviewFile = request(p);
    const requestId = auditBlockField(blocks(p, "REVIEW_REQUESTED")[0], "Request Id");
    expect(requestId).not.toBeNull();
    const r = dispatches(p, dictatedBrief(reviewFile, "READY"));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const rows = blocks(p, "REVIEW_VERDICT_DICTATED");
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0], "Agent Type")).toBe(REVIEWER);
    expect(auditBlockField(rows[0], "Verdict")).toBe("READY");
    expect(auditBlockField(rows[0], "Tool")).toBe("Task");
    expect(auditBlockField(rows[0], "Request Id")).toBe(requestId);
  });

  test("the knowledge template line, a format rule, another agent, and a brief with no verdict record nothing", () => {
    const p = project();
    const reviewFile = request(p);
    for (const [agent, prompt] of [
      [REVIEWER, `Review ${reviewFile}. Use the template:\n\n## Review\n**Verdict:** READY | NOT-READY\n**Reviewer:** <you>\n`],
      [REVIEWER, "Your review contains exactly one rendered `**Verdict:** READY|NOT-READY` line, then both tables."],
      ["aidlc-quality-agent", `Check the tests.\n\n**Verdict:** READY\n`],
      [REVIEWER, `Review the requirements at ${reviewFile}; the verdict and the findings are yours.`],
    ] as const) {
      const r = dispatches(p, prompt, agent);
      expect(r.code, `${agent}: ${r.stderr}`).toBe(0);
    }
    expect(blocks(p, "REVIEW_VERDICT_DICTATED")).toHaveLength(0);
  });

  test("the plan-approval off-switch does not silence the record: a record is not a fence", () => {
    const p = project();
    const reviewFile = request(p);
    const r = dispatches(p, dictatedBrief(reviewFile, "NOT-READY"), REVIEWER, { AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" });
    expect(r.code, r.stderr).toBe(0);
    const rows = blocks(p, "REVIEW_VERDICT_DICTATED");
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0], "Verdict")).toBe("NOT-READY");
  });
});

describe("a verdict the reviewer wrote as told records marked, never as the reviewer's own", () => {
  test("strict: the row is marked, the notice is said once with the verdict, and the gate says the line", () => {
    const p = project();
    const reviewFile = request(p);
    expect(dispatches(p, dictatedBrief(reviewFile, "READY")).code).toBe(0);
    reviewerWrites(p, reviewFile, review("READY"));
    finishes(p);
    const recorded = logReview(p, ["--verdict", "READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    expect(recorded.out).toContain('"emitted":"REVIEW_COMPLETED"');
    const output = JSON.parse(recorded.out.slice(recorded.out.indexOf("{"))) as { change_notices?: string[] };
    expect(output.change_notices ?? []).toEqual([DICTATED_LINE]);
    const completion = blocks(p, "REVIEW_COMPLETED");
    expect(completion).toHaveLength(1);
    expect(completion[0]).toContain("**Verdict**: READY");
    expect(completion[0]).toContain(`**${REVIEW_DICTATED_FIELD}**: yes`);
    expect(reviewCompletionDictated(completion[0])).toBe(true);
    // The reviewer left the bytes it wrote: not an edited review.
    expect(completion[0]).not.toContain("Review Edited After Reviewer");
    expect(blocks(p, "CHANGE_ACCEPTED")).toHaveLength(0);
    const gate = gateStart(p);
    expect(gate).toContain("change_notices");
    expect(gate).toContain(DICTATED_LINE);
  });

  test("relaxed: the notice is said once with the verdict and the gate does not say it again", () => {
    const p = project("relaxed");
    const reviewFile = request(p);
    expect(dispatches(p, dictatedBrief(reviewFile, "READY")).code).toBe(0);
    reviewerWrites(p, reviewFile, review("READY"));
    finishes(p);
    const recorded = logReview(p, ["--verdict", "READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    const output = JSON.parse(recorded.out.slice(recorded.out.indexOf("{"))) as { change_notices?: string[] };
    expect(output.change_notices ?? []).toEqual([DICTATED_LINE]);
    expect(blocks(p, "REVIEW_COMPLETED")[0]).toContain(`**${REVIEW_DICTATED_FIELD}**: yes`);
    // Nothing changed, so nothing is accepted: no CHANGE_ACCEPTED row either way.
    expect(blocks(p, "CHANGE_ACCEPTED")).toHaveLength(0);
    expect(gateStart(p)).not.toContain(DICTATED_LINE);
  });

  test("a reviewer that wrote the other verdict judged for itself: the row carries nothing", () => {
    const p = project();
    const reviewFile = request(p);
    expect(dispatches(p, dictatedBrief(reviewFile, "READY")).code).toBe(0);
    reviewerWrites(p, reviewFile, review("NOT-READY"));
    finishes(p);
    const recorded = logReview(p, ["--verdict", "NOT-READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    const output = JSON.parse(recorded.out.slice(recorded.out.indexOf("{"))) as { change_notices?: string[] };
    expect(output.change_notices ?? []).toEqual([]);
    const completion = blocks(p, "REVIEW_COMPLETED")[0];
    expect(completion).toContain("**Verdict**: NOT-READY");
    expect(completion).not.toContain(REVIEW_DICTATED_FIELD);
  });

  test("no dictation row since the request is no evidence: the verdict records as before", () => {
    const p = project();
    const reviewFile = request(p);
    expect(dispatches(p, `Review the requirements at ${reviewFile}; the verdict and the findings are yours.`).code).toBe(0);
    reviewerWrites(p, reviewFile, review("READY"));
    finishes(p);
    const recorded = logReview(p, ["--verdict", "READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    expect(blocks(p, "REVIEW_COMPLETED")[0]).not.toContain(REVIEW_DICTATED_FIELD);
    expect(gateStart(p)).not.toContain("was told what to conclude");
  });
});

describe("the pure helpers", () => {
  const row = (
    event: string,
    fields: Record<string, string>,
    pos: number,
    shard = "a.md",
    timestamp = `2026-10-10T00:00:0${pos}Z`,
  ): AuditShardEvent => ({
    event,
    timestamp,
    shard,
    pos,
    block: [`**Timestamp**: ${timestamp}`, `**Event**: ${event}`, ...Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`)].join("\n"),
  }) as AuditShardEvent;
  const REQUEST = row("REVIEW_REQUESTED", {
    Stage: STAGE, Reviewer: REVIEWER, "Request Id": "review:aaa",
    "Review File": `.aidlc-engine/reviews/${STAGE}/stage/1/1.aaa.review.md`,
  }, 1);

  test("latestReviewerRowAfter: the latest row of that event and reviewer after the anchor, filtered", () => {
    const before = row("REVIEW_VERDICT_DICTATED", { "Agent Type": REVIEWER, Verdict: "READY", "Request Id": "review:aaa" }, 0);
    const other = row("REVIEW_VERDICT_DICTATED", { "Agent Type": "aidlc-architecture-reviewer-agent", Verdict: "READY", "Request Id": "review:aaa" }, 2);
    const first = row("REVIEW_VERDICT_DICTATED", { "Agent Type": REVIEWER, Verdict: "NOT-READY", "Request Id": "review:aaa" }, 3);
    const second = row("REVIEW_VERDICT_DICTATED", { "Agent Type": REVIEWER, Verdict: "READY", "Request Id": "review:bbb" }, 4);
    const events = [before, REQUEST, other, first, second];
    expect(latestReviewerRowAfter(events, "REVIEW_VERDICT_DICTATED", REVIEWER, REQUEST)).toBe(second);
    expect(latestReviewerRowAfter(events, "REVIEW_VERDICT_DICTATED", REVIEWER, REQUEST,
      (candidate: AuditShardEvent) => auditBlockField(candidate.block, "Request Id") === "review:aaa")).toBe(first);
    expect(latestReviewerRowAfter([before, REQUEST, other], "REVIEW_VERDICT_DICTATED", REVIEWER, REQUEST)).toBeNull();
    // The completion lookup is the same walk over SUBAGENT_COMPLETED.
    const done = row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER }, 5);
    expect(reviewerCompletionAfter([REQUEST, done], REVIEWER, REQUEST)).toBe(done);
    expect(latestReviewerRowAfter([REQUEST, done], "SUBAGENT_COMPLETED", REVIEWER, REQUEST)).toBe(done);
  });

  test("dispatchDictatedVerdict: the request's own row, with the verdict being recorded", () => {
    const request = openReviewRequests([REQUEST])[0];
    expect(request.requestId).toBe("review:aaa");
    const dictated = row("REVIEW_VERDICT_DICTATED", { "Agent Type": REVIEWER, Verdict: "READY", "Request Id": "review:zzz, review:aaa" }, 2);
    expect(dispatchDictatedVerdict([REQUEST, dictated], REVIEWER, request, "READY")).toBe(true);
    expect(dispatchDictatedVerdict([REQUEST, dictated], REVIEWER, request, "NOT-READY")).toBe(false);
    const another = row("REVIEW_VERDICT_DICTATED", { "Agent Type": REVIEWER, Verdict: "READY", "Request Id": "review:bbb" }, 2);
    expect(dispatchDictatedVerdict([REQUEST, another], REVIEWER, request, "READY")).toBe(false);
    const earlier = row("REVIEW_VERDICT_DICTATED", { "Agent Type": REVIEWER, Verdict: "READY", "Request Id": "review:aaa" }, 0);
    expect(dispatchDictatedVerdict([earlier, REQUEST], REVIEWER, request, "READY")).toBe(false);
  });

  test("the mark and the one line the person hears", () => {
    expect(REVIEW_DICTATED_FIELD).toBe("Review Verdict Dictated");
    expect(reviewCompletionDictated(`**Event**: REVIEW_COMPLETED\n**${REVIEW_DICTATED_FIELD}**: yes`)).toBe(true);
    expect(reviewCompletionDictated("**Event**: REVIEW_COMPLETED\n**Verdict**: READY")).toBe(false);
    expect(dictatedReviewNotice("Requirements Analysis")).toBe(DICTATED_LINE);
    expect(dictatedReviewNotice("Functional Design", "u2-note-tags"))
      .toBe("The reviewer for Functional Design (u2-note-tags) was told what to conclude before it looked.");
  });
});
