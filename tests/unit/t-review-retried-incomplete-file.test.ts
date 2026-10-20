// covers: function:handleReview, function:backgroundAgentOutSince, function:reviewCompletionDidNotFinish,
// function:personSpokeSinceReviewRequest, subcommand:aidlc-log:review, hook:aidlc-log-subagent,
// hook:aidlc-deliver-stage-rules, hook:aidlc-record-human-turn,
// audit:REVIEW_COMPLETED, file:aidlc-common/protocols/stage-protocol-reviewer.md
//
// A review whose retried reviewer again leaves a file that is not a whole
// review (no verdict line, two verdict lines, an empty file) is an incomplete
// attempt, as the reviewer protocol says, and records the same NOT-READY
// fallback as a retried review that wrote no file (#2702): an empty record,
// `Review Finished: no`, and none of the file's text. Before, nothing could be
// recorded and `next` handed back the same refused command: a dead end.
//
// Only once the reviewer has finished: while an agent sent in the background
// since the retry has not returned and the reviewer has no completion row
// since it, the verdict waits; when it returns, its whole review records as
// its own verdict, or the fallback does. An agent stopped with no finish (Esc,
// a closed chat) never returns, so once the person has written since the
// retry their words come first and the fallback records. A whole review for
// the other verdict is never buried under the fallback.
//
// Mechanism: the real log and orchestrate tools and the shipped dispatch and
// SubagentStop hooks, spawned over a real ledger (DIST tree).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  auditBlockField,
  getField,
  GUARD_POLICY_FIELD,
  readAllAuditShards,
  REVIEW_FINISHED_FIELD,
  REVIEWER_FINISHED_FIELD,
  REVIEW_EDITED_FIELD,
  reviewCompletionDidNotFinish,
  type ReviewRecord,
  setGuardPolicyLine,
  subagentInflightMarkerPath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  runOrchestrateNext,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const LOG_TOOL = join(DIST_CLAUDE, "tools", "aidlc-log.ts");
const ORCHESTRATE_TOOL = join(DIST_CLAUDE, "tools", "aidlc-orchestrate.ts");
const SUBAGENT_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-log-subagent.ts");
const DISPATCH_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-deliver-stage-rules.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
// What Claude Code sets in its agent's shell; the test runner removes it, so a
// case is in Claude Code's shell only when it says so.
const CLAUDE_SHELL = { CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c02" };

const NOT_WHOLE: Record<string, string> = {
  "no verdict line": "## Review\n\n### Findings\n\nThe first finding, cut off\n",
  "two verdict lines":
    `## Review\n\n**Verdict:** READY\n**Verdict:** NOT-READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n`,
  "an empty file": "",
};

function wholeReview(verdict: "READY" | "NOT-READY"): string {
  return (
    `**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n**Verdict Dictated:** no\n\n### Findings\n\n` +
    "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
    "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n" +
    (verdict === "NOT-READY" ? "| Major | requirements.md > Scope | No acceptance criteria. | Add them. |\n" : "")
  );
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function project(policy: "strict" | "off" = "strict"): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
  if (policy === "off") {
    const statePath = seededStateFile(p);
    const state = setGuardPolicyLine(readFileSync(statePath, "utf-8"), "off (set by you)");
    expect(getField(state, GUARD_POLICY_FIELD)).toBe("off (set by you)");
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

/** The request, a first attempt that wrote nothing, and its one retry; returns the review file's absolute path. */
function retried(p: string): string {
  expect(logReview(p, []).status).toBe(0);
  const retry = logReview(p, ["--retry-pending"]);
  expect(retry.out, retry.out).toContain('"retry":"pending-request"');
  const { reviewFile } = JSON.parse(retry.out.slice(retry.out.indexOf("{"))) as { reviewFile: string };
  return join(p, reviewFile);
}

function writes(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf-8");
}

/** A reviewer sent in the background: the shipped dispatch hook adds its in-flight entry. */
function sentInBackground(p: string, file: string): void {
  const r = spawn([DISPATCH_HOOK], { CLAUDE_PROJECT_DIR: p }, JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: REVIEWER, description: "review", prompt: `Review and write ${file}`, run_in_background: true },
  }));
  expect(r.status, r.out).toBe(0);
  expect(existsSync(subagentInflightMarkerPath(p))).toBe(true);
}

/** The reviewer finishes: the shipped SubagentStop hook records it and clears its in-flight entry. */
function finishes(p: string): void {
  const r = spawn(
    [SUBAGENT_HOOK],
    { CLAUDE_PROJECT_DIR: p },
    JSON.stringify({ hook_event_name: "SubagentStop", agent_type: REVIEWER, agent_id: "a1" }),
  );
  expect(r.status, r.out).toBe(0);
}

/** What the person types, through the real prompt hook every harness forwards to. */
function says(p: string, prompt: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const r = spawnSync(BUN, [join(DIST_CLAUDE, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: p,
    env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CLAUDE_SHELL.CLAUDE_CODE_SESSION_ID, prompt }),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

function completions(p: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes("**Event**: REVIEW_COMPLETED"));
}

function recordOf(p: string, completion: string): ReviewRecord {
  const path = auditBlockField(completion, "Review Record");
  expect(path).not.toBeNull();
  return JSON.parse(readFileSync(join(seededRecordDir(p), path as string), "utf-8")) as ReviewRecord;
}

/** The fallback: no reviewer's verdict, an empty record, none of the file's text. */
function expectFallback(p: string, completion: string): void {
  expect(auditBlockField(completion, "Verdict")).toBe("NOT-READY");
  expect(auditBlockField(completion, REVIEW_FINISHED_FIELD)).toBe("no");
  expect(reviewCompletionDidNotFinish(p, completion)).toBe(true);
  expect(completion).not.toContain(REVIEW_EDITED_FIELD);
  expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  const record = recordOf(p, completion);
  expect(record.body).toBe("");
  expect(record.findings).toEqual([]);
}

function next(p: string): string {
  return runOrchestrateNext(ORCHESTRATE_TOOL, p, [], { env: { ...process.env, CLAUDE_PROJECT_DIR: p } }).out;
}

/** No self-loop: the step after the verdict is the stage's own, never the pass-1 verdict or retry again. */
function expectMovesOn(p: string): void {
  const after = next(p);
  expect(after).toContain('"kind":"run-stage"');
  expect(after).not.toContain("--verdict");
  expect(after).not.toContain("--retry-pending");
}

describe("a retried review whose file is not a whole review records the NOT-READY fallback", () => {
  for (const [shape, body] of Object.entries(NOT_WHOLE)) {
    test(`${shape}: NOT-READY records the fallback, and next moves on`, () => {
      const p = project();
      writes(retried(p), body);
      const before = next(p);
      expect(before).toContain("--verdict");
      const recorded = logReview(p, ["--verdict", "NOT-READY"]);
      expect(recorded.status, recorded.out).toBe(0);
      expect(recorded.out).toContain('"emitted":"REVIEW_COMPLETED"');
      const rows = completions(p);
      expect(rows).toHaveLength(1);
      expectFallback(p, rows[0]);
      expectMovesOn(p);
    });
  }

  test("READY over such a file is refused and names NOT-READY, which then records", () => {
    const p = project();
    writes(retried(p), NOT_WHOLE["no verdict line"]);
    const ready = logReview(p, ["--verdict", "READY"]);
    expect(ready.status).not.toBe(0);
    expect(ready.out).toContain("record --verdict NOT-READY");
    expect(completions(p)).toHaveLength(0);
    expect(logReview(p, ["--verdict", "NOT-READY"]).status).toBe(0);
    expectFallback(p, completions(p)[0]);
  });

  test("a whole review is never buried under the fallback: READY on disk refuses NOT-READY", () => {
    const p = project();
    writes(retried(p), wholeReview("READY"));
    const wrong = logReview(p, ["--verdict", "NOT-READY"]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.out).toContain("canonical verdict line matching --verdict");
    expect(wrong.out).not.toContain("record --verdict NOT-READY");
    expect(completions(p)).toHaveLength(0);
    expect(logReview(p, ["--verdict", "READY"]).status).toBe(0);
  });

  test("before the retry a file that is not a whole review is still refused, and the retry is still there", () => {
    const p = project();
    const requested = logReview(p, []);
    expect(requested.status, requested.out).toBe(0);
    const { reviewFile } = JSON.parse(requested.out.slice(requested.out.indexOf("{"))) as { reviewFile: string };
    writes(join(p, reviewFile), NOT_WHOLE["no verdict line"]);
    const refused = logReview(p, ["--verdict", "NOT-READY"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("canonical verdict line matching --verdict");
    expect(refused.out).not.toContain("record --verdict NOT-READY");
    expect(completions(p)).toHaveLength(0);
    const retry = logReview(p, ["--retry-pending"]);
    expect(retry.out, retry.out).toContain('"retry":"pending-request"');
    expect(existsSync(join(p, reviewFile))).toBe(false);
  });

  test("another host, or Claude Code with no agent out in the background: the fallback records at once", () => {
    for (const env of [{}, CLAUDE_SHELL]) {
      const p = project();
      writes(retried(p), NOT_WHOLE["two verdict lines"]);
      const recorded = logReview(p, ["--verdict", "NOT-READY"], env);
      expect(recorded.status, recorded.out).toBe(0);
      expectFallback(p, completions(p)[0]);
    }
  });
});

describe("only once the reviewer has finished", () => {
  for (const policy of ["strict", "off"] as const) {
    test(`${policy}: a reviewer still out in the background is waited for; when it returns with a whole review, that review records`, () => {
      const p = project(policy);
      const file = retried(p);
      sentInBackground(p, file);
      writes(file, NOT_WHOLE["no verdict line"]);
      const early = logReview(p, ["--verdict", "NOT-READY"]);
      expect(early.status).not.toBe(0);
      expect(early.out).toContain("has not returned");
      expect(early.out).toContain("Wait for it to return, then record the verdict again.");
      expect(completions(p)).toHaveLength(0);
      writes(file, wholeReview("NOT-READY"));
      finishes(p);
      const recorded = logReview(p, ["--verdict", "NOT-READY"]);
      expect(recorded.status, recorded.out).toBe(0);
      const completion = completions(p)[0];
      expect(auditBlockField(completion, REVIEW_FINISHED_FIELD)).toBeNull();
      expect(recordOf(p, completion).body).toContain("No acceptance criteria.");
      expectMovesOn(p);
    });
  }

  test("a person who writes after a background reviewer stopped with no finish (Esc, a closed chat): their words come first, and the fallback records", () => {
    const p = project();
    const file = retried(p);
    sentInBackground(p, file);
    writes(file, NOT_WHOLE["no verdict line"]);
    // No SubagentStop ever runs for it: its in-flight entry stays fresh.
    expect(logReview(p, ["--verdict", "NOT-READY"]).out).toContain("has not returned");
    says(p, "carry on with the review");
    const recorded = logReview(p, ["--verdict", "NOT-READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    expectFallback(p, completions(p)[0]);
    expect(existsSync(subagentInflightMarkerPath(p))).toBe(true);
  });

  test("a reviewer that returns with a file still not whole: the fallback records then", () => {
    const p = project();
    const file = retried(p);
    sentInBackground(p, file);
    writes(file, NOT_WHOLE["an empty file"]);
    expect(logReview(p, ["--verdict", "NOT-READY"]).status).not.toBe(0);
    finishes(p);
    const recorded = logReview(p, ["--verdict", "NOT-READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    expectFallback(p, completions(p)[0]);
    expectMovesOn(p);
  });
});
