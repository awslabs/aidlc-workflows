// covers: hook:aidlc-log-subagent, function:handleReview, function:openReviewRequests,
// function:reviewerCompletionAfter, function:recordedReviewFileDigest,
// function:renderReviewFileDigests, function:reviewFileDigestOnDisk, function:reviewCompletionEdited,
// function:editedReviewNotice, subcommand:aidlc-state:gate-start, audit:SUBAGENT_COMPLETED,
// audit:REVIEW_COMPLETED, audit:CHANGE_ACCEPTED
//
// The review file a request opens is written by the dispatched reviewer. In one
// run the conductor rewrote a refused review, edited an open one, and recorded
// each as the reviewer's verdict: the logger checked the file's shape, never
// who wrote its bytes. Now the log-subagent hook puts the digest of every open
// review file a reviewer may be writing on that reviewer's SUBAGENT_COMPLETED
// row (what it left when it finished), and `log review --verdict` compares the
// bytes it records with that digest. Nothing is refused (the person's "do it
// anyway" is theirs to make): a changed file still records, as it reads, and
// the row says `Review Edited After Reviewer: yes`, so the verdict is on record
// as an edited review and never as the reviewer's. Under strict the approval
// gate tells the person in one line; under relaxed or off the change is
// accepted and said once with the verdict (CHANGE_ACCEPTED), as every other
// accepted change is. No completion row since the request, or a row without
// the digest, is no evidence: the verdict records as before.
//
// Mechanism: the shipped hook and the real log and state tools spawned over a
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
  editedReviewNotice,
  getField,
  GUARD_POLICY_FIELD,
  openReviewRequests,
  readAllAuditShards,
  recordedReviewFileDigest,
  renderReviewFileDigests,
  REVIEW_FILE_ABSENT,
  reviewCompletionEdited,
  reviewerCompletionAfter,
  reviewFileDigest,
  reviewFileDigestOnDisk,
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
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const EDITED_LINE = "was edited after the reviewer finished.";

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

/** The request; returns the review file's absolute path. */
function request(p: string): string {
  const r = logReview(p, []);
  expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
  const { reviewFile } = JSON.parse(r.out) as { reviewFile: string };
  return join(p, reviewFile);
}

/** The stage's approval gate opens: what the state tool prints is what the engine carries to the person. */
function gateStart(p: string): string {
  const r = spawnSync(BUN, [STATE_TOOL, "gate-start", STAGE, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" },
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout ?? "";
}

function review(verdict: "READY" | "NOT-READY", note = "Fixture review."): string {
  return (
    `**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\n${note}\n\n` +
    "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
    "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n" +
    (verdict === "NOT-READY" ? "| High | requirements.md | Missing acceptance criteria | Add them |\n" : "")
  );
}

/** The reviewer writes its review (the file the request named). */
function reviewerWrites(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
}

/** The agent finishes: the shipped SubagentStop hook records SUBAGENT_COMPLETED. */
function finishes(p: string, agent = REVIEWER): void {
  const r = spawnSync(BUN, [SUBAGENT_HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: agent, agent_id: "a1" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
    encoding: "utf-8",
  });
  expect(r.status, r.stderr).toBe(0);
}

function blocks(p: string, event: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
}

function relativeToRecord(p: string, file: string): string {
  return file.slice(seededRecordDir(p).length + 1).replaceAll("\\", "/");
}

describe("the reviewer's completion row carries what it left in its review file", () => {
  test("a reviewer with an open request records the digest; another agent records none; unchanged bytes record as before", () => {
    const p = project();
    const file = request(p);
    reviewerWrites(file, review("READY"));
    finishes(p);
    const rel = relativeToRecord(p, file);
    const completed = blocks(p, "SUBAGENT_COMPLETED");
    const block = completed[completed.length - 1];
    expect(block).toContain(`**Review File Digest**: ${rel}=${reviewFileDigest(readFileSync(file))}`);
    expect(recordedReviewFileDigest(block, rel)).toBe(reviewFileDigest(readFileSync(file)));

    finishes(p, "aidlc-developer-agent");
    expect(blocks(p, "SUBAGENT_COMPLETED").at(-1)).not.toContain("**Review File Digest**");

    const verdict = logReview(p, ["--verdict", "READY"]);
    expect(verdict.out, verdict.out).toContain('"emitted":"REVIEW_COMPLETED"');
    expect(blocks(p, "REVIEW_COMPLETED")[0]).not.toContain("Review Edited After Reviewer");
    expect(gateStart(p)).not.toContain(EDITED_LINE);
  });

  test("a reviewer that finished without writing records the file as absent", () => {
    const p = project();
    const file = request(p);
    finishes(p);
    expect(recordedReviewFileDigest(blocks(p, "SUBAGENT_COMPLETED").at(-1) ?? "", relativeToRecord(p, file))).toBe(REVIEW_FILE_ABSENT);
  });
});

describe("a review file changed after the reviewer finished records as an edited review, never as the reviewer's", () => {
  test("strict: the verdict records as the file reads, marked edited, with no refusal; the gate says it in one line", () => {
    const p = project();
    const file = request(p);
    reviewerWrites(file, review("NOT-READY"));
    finishes(p);
    // The conductor rewrites the file to READY and records the verdict (#2207).
    writeFileSync(file, review("READY"), "utf-8");
    const recorded = logReview(p, ["--verdict", "READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    expect(recorded.out).toContain('"emitted":"REVIEW_COMPLETED"');
    const output = JSON.parse(recorded.out.slice(recorded.out.indexOf("{"))) as { change_notices?: string[] };
    expect(output.change_notices ?? []).toContainEqual(expect.stringContaining(EDITED_LINE));
    const completion = blocks(p, "REVIEW_COMPLETED");
    expect(completion).toHaveLength(1);
    expect(completion[0]).toContain("**Verdict**: READY");
    expect(completion[0]).toContain("**Review Edited After Reviewer**: yes");
    expect(reviewCompletionEdited(completion[0])).toBe(true);
    // Strict accepts nothing: no CHANGE_ACCEPTED row; the gate carries the line instead.
    expect(blocks(p, "CHANGE_ACCEPTED")).toHaveLength(0);
    const gate = gateStart(p);
    expect(gate).toContain("change_notices");
    expect(gate).toContain(EDITED_LINE);
    expect(gate).toContain("The review file for Requirements Analysis was edited after the reviewer finished.");
  });

  test("relaxed: recorded with one notice and a CHANGE_ACCEPTED row; the gate does not say it again", () => {
    const p = project("relaxed");
    const file = request(p);
    reviewerWrites(file, review("NOT-READY"));
    finishes(p);
    writeFileSync(file, review("READY"), "utf-8");
    const recorded = logReview(p, ["--verdict", "READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    const output = JSON.parse(recorded.out.slice(recorded.out.indexOf("{"))) as { change_notices?: string[] };
    expect(output.change_notices ?? []).toContainEqual(expect.stringContaining(EDITED_LINE));
    const accepted = blocks(p, "CHANGE_ACCEPTED");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain("**Checkpoint**: review-receipt");
    expect(accepted[0]).toContain(`**Stage**: ${STAGE}`);
    const completion = blocks(p, "REVIEW_COMPLETED")[0];
    expect(completion).toContain("**Review Edited After Reviewer**: yes");
    expect(completion).toContain("**Verdict**: READY");
    expect(gateStart(p)).not.toContain(EDITED_LINE);
  });

  test("no completion since the request is no evidence: the verdict records as before", () => {
    const p = project();
    finishes(p); // a completion BEFORE the request does not count
    const file = request(p);
    reviewerWrites(file, review("READY"));
    const recorded = logReview(p, ["--verdict", "READY"]);
    expect(recorded.out, recorded.out).toContain('"emitted":"REVIEW_COMPLETED"');
    expect(blocks(p, "REVIEW_COMPLETED")[0]).not.toContain("Review Edited After Reviewer");
  });
});

describe("the pure helpers", () => {
  const row = (event: string, fields: Record<string, string>, pos: number, shard = "a", timestamp = "2026-10-09T01:00:00Z"): AuditShardEvent => ({
    event,
    block: [`**Event**: ${event}`, ...Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`)].join("\n"),
    pos,
    shard,
    shardIndex: 0,
    timestamp,
  });
  const FILE = ".aidlc-engine/reviews/requirements-analysis/stage/0123456789abcdef/1.00ff.review.md";
  const requested = (pos: number, extra: Record<string, string> = {}) =>
    row("REVIEW_REQUESTED", { "Request Id": "review:00ff", "Review File": FILE, Reviewer: REVIEWER, Stage: STAGE, ...extra }, pos);

  test("openReviewRequests: open until completed, a retry replaces the row, only slot files count", () => {
    expect(openReviewRequests([requested(1), row("REVIEW_COMPLETED", { "Request Id": "review:00ff" }, 2)])).toEqual([]);
    const retried = requested(3, { Retry: "pending-request" });
    const [open] = openReviewRequests([requested(1), retried]);
    expect(open.row.pos).toBe(3);
    expect(open.reviewFile).toBe(FILE);
    expect(open.unit).toBeNull();
    expect(openReviewRequests([requested(1, { "Review File": "../elsewhere/1.review.md" })])).toEqual([]);
    expect(openReviewRequests([requested(1, { "Review File": "inception/requirements-analysis/requirements.md" })])).toEqual([]);
  });

  test("reviewerCompletionAfter: the latest completion of that reviewer after the row", () => {
    const after = requested(5);
    const events = [
      row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER }, 2),
      after,
      row("SUBAGENT_COMPLETED", { "Agent Type": "aidlc-developer-agent" }, 6),
      row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER }, 7),
      row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER }, 8),
    ];
    expect(reviewerCompletionAfter(events, REVIEWER, after)?.pos).toBe(8);
    expect(reviewerCompletionAfter(events.slice(0, 3), REVIEWER, after)).toBeNull();
    // Another shard with the same timestamp is a tie: not definitely after.
    expect(reviewerCompletionAfter([after, row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER }, 1, "b")], REVIEWER, after)).toBeNull();
  });

  test("the digest field round-trips several files and reads a missing one as null", () => {
    const field = renderReviewFileDigests([
      { reviewFile: FILE, digest: "ab".repeat(32) },
      { reviewFile: `${FILE}.other`, digest: REVIEW_FILE_ABSENT },
    ]);
    const block = `**Event**: SUBAGENT_COMPLETED\n**Agent Type**: ${REVIEWER}\n**Review File Digest**: ${field}`;
    expect(recordedReviewFileDigest(block, FILE)).toBe("ab".repeat(32));
    expect(recordedReviewFileDigest(block, `${FILE}.other`)).toBe(REVIEW_FILE_ABSENT);
    expect(recordedReviewFileDigest(block, "elsewhere.md")).toBeNull();
    expect(recordedReviewFileDigest(`**Event**: SUBAGENT_COMPLETED\n**Agent Type**: ${REVIEWER}`, FILE)).toBeNull();
  });

  test("reviewFileDigestOnDisk: plain file bytes, else absent", () => {
    const p = createTestProject();
    tempDirs.push(p);
    const file = join(p, "r.md");
    expect(reviewFileDigestOnDisk(file)).toBe(REVIEW_FILE_ABSENT);
    writeFileSync(file, "x", "utf-8");
    expect(reviewFileDigestOnDisk(file)).toBe(reviewFileDigest(Buffer.from("x")));
    expect(reviewFileDigestOnDisk(p)).toBe(REVIEW_FILE_ABSENT);
  });

  test("the edited mark and the one line the person hears", () => {
    expect(reviewCompletionEdited("**Event**: REVIEW_COMPLETED\n**Review Edited After Reviewer**: yes")).toBe(true);
    expect(reviewCompletionEdited("**Event**: REVIEW_COMPLETED\n**Verdict**: READY")).toBe(false);
    expect(editedReviewNotice("Functional Design", "u2-note-tags")).toBe(
      "The review file for Functional Design (u2-note-tags) was edited after the reviewer finished.",
    );
    expect(editedReviewNotice("Requirements Analysis")).toBe(
      "The review file for Requirements Analysis was edited after the reviewer finished.",
    );
  });
});
