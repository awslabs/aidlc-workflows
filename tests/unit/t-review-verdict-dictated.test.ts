// covers: function:handleReview, function:validateReviewAppendix, function:latestReviewerRowAfter,
// function:reviewCompletionDictated, function:dictatedReviewNotice, function:handleAuditMerge,
// subcommand:aidlc-state:gate-start, audit:REVIEW_COMPLETED, audit:REVIEW_VERDICT_DICTATED
//
// The reviewer says, in one fixed line of its review file, whether the brief it
// was given told it what verdict to write or to prefer: `**Verdict Dictated:**
// yes` or `**Verdict Dictated:** no`, beside the Verdict, Reviewer and Iteration
// lines. The reviewer reads its own brief for meaning; the tool reads the line as
// structure, the way it reads the other three (a rendered strong at the start of
// a paragraph, never inside code, a list, a quote, a table or HTML). `log review
// --verdict` records the value as written on REVIEW_COMPLETED (`Review Verdict
// Dictated: yes|no`); `yes` is said once with the verdict in the person's words,
// and the approval gate says it once more under strict. `no`, an absent line, or
// a line the tool cannot read as one value records nothing new and refuses
// nothing. No dispatch prompt is read for it any more: the words the conductor
// used to pass the verdict are the reviewer's to read, not a pattern's.
//
// Mechanism: the real log and state tools spawned over a real ledger (DIST
// tree), plus the pure helpers in-process.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AuditShardEvent,
  auditBlockField,
  dictatedReviewNotice,
  getField,
  GUARD_POLICY_FIELD,
  latestReviewerRowAfter,
  readAllAuditShards,
  readAuditShardEvents,
  REVIEW_DICTATED_FIELD,
  reviewCompletionDictated,
  reviewerCompletionAfter,
  setGuardPolicyLine,
  validateReviewAppendix,
  worktreePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  FIXTURES_DIR,
  fixtureIntentId8,
  REPO_ROOT,
  seedAidlcMemory,
  seedAuditFile,
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

/** The request; returns the review file's project-relative path. */
function request(p: string): string {
  const r = logReview(p, []);
  expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
  const { reviewFile } = JSON.parse(r.out) as { reviewFile: string };
  return reviewFile;
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

/** A review in the knowledge template's shape; `dictated` is the reviewer's own line, or none. */
function review(verdict: "READY" | "NOT-READY", dictated: string | null): string {
  return (
    `**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n${dictated === null ? "" : `${dictated}\n`}\n` +
    "### Findings\n\nFixture review.\n\n" +
    "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
    "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n" +
    (verdict === "NOT-READY" ? "| High | requirements.md | Missing acceptance criteria | Add them |\n" : "")
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

/** The whole flow after the request: the reviewer writes, finishes, and the verdict is recorded. */
function recorded(p: string, text: string, verdict: "READY" | "NOT-READY"): { notices: string[]; completion: string } {
  const reviewFile = request(p);
  reviewerWrites(p, reviewFile, text);
  finishes(p);
  const r = logReview(p, ["--verdict", verdict]);
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain('"emitted":"REVIEW_COMPLETED"');
  const output = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { change_notices?: string[] };
  const completion = blocks(p, "REVIEW_COMPLETED");
  expect(completion).toHaveLength(1);
  return { notices: output.change_notices ?? [], completion: completion[0] };
}

describe("the reviewer's own line says whether it was told what to conclude", () => {
  test("strict: `yes` is recorded as written, said once with the verdict, and the gate says the line", () => {
    const p = project();
    const { notices, completion } = recorded(p, review("READY", "**Verdict Dictated:** yes"), "READY");
    expect(notices).toEqual([DICTATED_LINE]);
    expect(completion).toContain("**Verdict**: READY");
    expect(completion).toContain(`**${REVIEW_DICTATED_FIELD}**: yes`);
    expect(reviewCompletionDictated(completion)).toBe(true);
    // The reviewer left the bytes it wrote: not an edited review, and nothing accepted.
    expect(completion).not.toContain("Review Edited After Reviewer");
    expect(blocks(p, "CHANGE_ACCEPTED")).toHaveLength(0);
    const gate = gateStart(p);
    expect(gate).toContain("change_notices");
    expect(gate).toContain(DICTATED_LINE);
  });

  test("relaxed: said once with the verdict, and the gate does not say it again", () => {
    const p = project("relaxed");
    const { notices, completion } = recorded(p, review("READY", "**Verdict Dictated:** yes"), "READY");
    expect(notices).toEqual([DICTATED_LINE]);
    expect(completion).toContain(`**${REVIEW_DICTATED_FIELD}**: yes`);
    expect(blocks(p, "CHANGE_ACCEPTED")).toHaveLength(0);
    expect(gateStart(p)).not.toContain(DICTATED_LINE);
  });

  test("a reviewer told one verdict that wrote the other was still told: the line is said", () => {
    const p = project();
    const { notices, completion } = recorded(p, review("NOT-READY", "**Verdict Dictated:** yes"), "NOT-READY");
    expect(notices).toEqual([DICTATED_LINE]);
    expect(completion).toContain("**Verdict**: NOT-READY");
    expect(completion).toContain(`**${REVIEW_DICTATED_FIELD}**: yes`);
  });

  test("`no` is recorded as written and nothing is said; a review without the line carries no field", () => {
    const said = project();
    const no = recorded(said, review("READY", "**Verdict Dictated:** no"), "READY");
    expect(no.notices).toEqual([]);
    expect(no.completion).toContain(`**${REVIEW_DICTATED_FIELD}**: no`);
    expect(reviewCompletionDictated(no.completion)).toBe(false);
    expect(gateStart(said)).not.toContain("was told what to conclude");

    const silent = project();
    const none = recorded(silent, review("READY", null), "READY");
    expect(none.notices).toEqual([]);
    expect(none.completion).not.toContain(REVIEW_DICTATED_FIELD);
    expect(gateStart(silent)).not.toContain("was told what to conclude");
  });

  test("the line is read as structure: inside code or a list item, or with two values, it is not the field", () => {
    for (const [label, text] of [
      ["in a fence", review("READY", "```\n**Verdict Dictated:** yes\n```")],
      ["in a list item", review("READY", "- **Verdict Dictated:** yes")],
      ["two values", review("READY", "**Verdict Dictated:** yes\n\n**Verdict Dictated:** no")],
      ["another word", review("READY", "**Verdict Dictated:** READY")],
    ] as const) {
      const p = project();
      const { notices, completion } = recorded(p, text, "READY");
      expect(notices, label).toEqual([]);
      expect(completion, label).not.toContain(REVIEW_DICTATED_FIELD);
    }
  });
});

describe("the pure helpers", () => {
  const expected = { verdict: "READY" as const, reviewer: REVIEWER, iteration: 1, reviewChallenge: null, standalone: true };

  test("validateReviewAppendix reads the line beside the other authority lines, one value or none", () => {
    const yes = validateReviewAppendix(Buffer.from(review("READY", "**Verdict Dictated:** yes")), expected);
    expect(yes).toEqual({ valid: true, verdictDictated: "yes" });
    const no = validateReviewAppendix(Buffer.from(review("READY", "**Verdict Dictated:** no")), expected);
    expect(no).toEqual({ valid: true, verdictDictated: "no" });
    const none = validateReviewAppendix(Buffer.from(review("READY", null)), expected);
    expect(none).toEqual({ valid: true, verdictDictated: null });
    // Repeated word for word is one line, as the verdict line is.
    const twice = validateReviewAppendix(Buffer.from(review("READY", "**Verdict Dictated:** yes\n\n**Verdict Dictated:** yes")), expected);
    expect(twice).toEqual({ valid: true, verdictDictated: "yes" });
    for (const text of [
      review("READY", "**Verdict Dictated:** yes\n\n**Verdict Dictated:** no"),
      review("READY", "**Verdict Dictated:** Yes, READY"),
      review("READY", "`**Verdict Dictated:** yes`"),
      review("READY", "> **Verdict Dictated:** yes"),
    ]) {
      expect(validateReviewAppendix(Buffer.from(text), expected)).toEqual({ valid: true, verdictDictated: null });
    }
    // The line never stands in for the verdict line, and a malformed verdict is still refused.
    const noVerdict = validateReviewAppendix(Buffer.from(review("READY", "**Verdict Dictated:** yes").replace("**Verdict:** READY\n", "")), expected);
    expect(noVerdict.valid).toBe(false);
  });

  test("latestReviewerRowAfter: the latest row of that event and reviewer after the anchor, filtered", () => {
    const row = (event: string, fields: Record<string, string>, pos: number): AuditShardEvent => ({
      event,
      timestamp: `2026-10-10T00:00:0${pos}Z`,
      shard: "a.md",
      pos,
      block: [`**Timestamp**: 2026-10-10T00:00:0${pos}Z`, `**Event**: ${event}`, ...Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`)].join("\n"),
    }) as AuditShardEvent;
    const REQUEST = row("REVIEW_REQUESTED", { Stage: STAGE, Reviewer: REVIEWER, "Request Id": "review:aaa" }, 1);
    const before = row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER, "Agent Id": "a0" }, 0);
    const other = row("SUBAGENT_COMPLETED", { "Agent Type": "aidlc-architecture-reviewer-agent", "Agent Id": "b1" }, 2);
    const first = row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER, "Agent Id": "a1" }, 3);
    const second = row("SUBAGENT_COMPLETED", { "Agent Type": REVIEWER, "Agent Id": "a2" }, 4);
    const events = [before, REQUEST, other, first, second];
    expect(latestReviewerRowAfter(events, "SUBAGENT_COMPLETED", REVIEWER, REQUEST)).toBe(second);
    expect(latestReviewerRowAfter(events, "SUBAGENT_COMPLETED", REVIEWER, REQUEST,
      (candidate: AuditShardEvent) => auditBlockField(candidate.block, "Agent Id") === "a1")).toBe(first);
    expect(latestReviewerRowAfter([before, REQUEST, other], "SUBAGENT_COMPLETED", REVIEWER, REQUEST)).toBeNull();
    // The completion lookup is the same walk.
    expect(reviewerCompletionAfter(events, REVIEWER, REQUEST)).toBe(second);
  });

  test("the mark and the one line the person hears", () => {
    expect(REVIEW_DICTATED_FIELD).toBe("Review Verdict Dictated");
    expect(reviewCompletionDictated(`**Event**: REVIEW_COMPLETED\n**${REVIEW_DICTATED_FIELD}**: yes`)).toBe(true);
    expect(reviewCompletionDictated(`**Event**: REVIEW_COMPLETED\n**${REVIEW_DICTATED_FIELD}**: no`)).toBe(false);
    expect(reviewCompletionDictated("**Event**: REVIEW_COMPLETED\n**Verdict**: READY")).toBe(false);
    expect(dictatedReviewNotice("Requirements Analysis")).toBe(DICTATED_LINE);
    expect(dictatedReviewNotice("Functional Design", "u2-note-tags"))
      .toBe("The reviewer for Functional Design (u2-note-tags) was told what to conclude before it looked.");
  });
});

// REVIEW_VERDICT_DICTATED is no longer written, but it stays registered: an
// audit a person already has may hold a row an earlier release's guard wrote,
// and the Bolt worktree audit merge refuses a delta with an event it does not
// know. The row still reads like any other and still merges back.
describe("a row an earlier release wrote still reads and merges", () => {
  const BOLT = join(DIST_CLAUDE, "tools", "aidlc-bolt.ts");
  const bolt = (p: string, args: string[]): { status: number; out: string } => {
    const r = spawnSync(BUN, [BOLT, ...args, "--project-dir", p], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  test("a Bolt worktree audit delta carrying REVIEW_VERDICT_DICTATED merges into the main audit and reads back", () => {
    const p = createTestProject();
    tempDirs.push(p);
    seedStateFile(p, join(FIXTURES_DIR, "state-construction.md"));
    seedAuditFile(p);
    const slug = "vd1";
    const wt = worktreePath(p, fixtureIntentId8(p), slug);
    mkdirSync(wt, { recursive: true });
    const started = bolt(p, ["start", "--name", "BoltVd1", "--batch", "1", "--worktree", "--slug", slug]);
    expect(started.status, started.out).toBe(0);
    // The forked shard inside the worktree mirror, where that release's guard appended its row.
    const auditDir = join(wt, "aidlc", "spaces", DEFAULT_SPACE, "intents", DEFAULT_RECORD_DIR, "audit");
    const shard = readdirSync(auditDir).map((name) => join(auditDir, name))
      .find((file) => readFileSync(file, "utf-8").includes("**Event**: AUDIT_FORKED"));
    expect(shard).toBeDefined();
    appendFileSync(
      shard as string,
      "\n## Review Verdict Dictated\n**Timestamp**: 2026-10-10T00:00:00Z\n**Event**: REVIEW_VERDICT_DICTATED\n" +
        `**Agent Type**: ${REVIEWER}\n**Verdict**: READY\n**Tool**: Task\n**Request Id**: review:${"a".repeat(32)}\n\n---\n`,
      "utf-8",
    );
    const merged = bolt(p, ["complete", "--name", "BoltVd1", "--batch", "1", "--merge", "--slug", slug]);
    expect(merged.status, merged.out).toBe(0);
    expect(merged.out).not.toContain("unknown event");
    const rows = blocks(p, "REVIEW_VERDICT_DICTATED");
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0], "Verdict")).toBe("READY");
    expect(readAuditShardEvents(p).some((event) => event.event === "REVIEW_VERDICT_DICTATED")).toBe(true);
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
});
