// covers: subcommand:aidlc-state:approve, subcommand:aidlc-state:gate-start
//
// The person drives. A review was asked for and never finished (the chat was
// interrupted, or the reviewer's result was never recorded), and the person
// says "I don't need another review, approve it". That approval goes through:
// it is their call, recorded as theirs with the review shown as not finished,
// and they hear one line. It never goes through a rejection, so nothing they
// approved earlier is asked again.
//
// What stays: the approval must be the person's (a reply from them since the
// question, the same check every approval has), the review must have been
// asked for (skipping it is not the agent's call), and a team that locks Guard
// Policy strict keeps every review required.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { auditBlockField, getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000beef";
const SLUG = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const WORDS = "the fix looks right to me and the tests pass, I don't need another review. approve it and move on";
const NOTICE = "Approved. The Requirements Analysis review did not finish.";

function run(tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SKIP_REVIEWER_GATE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  Object.assign(env, {
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
    ...extra,
  });
  const r = spawnSync(BUN, [tool, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const state = (proj: string, args: string[], extra: Record<string, string> = {}) =>
  run(STATE, [...args, "--project-dir", proj], { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", ...extra });
const events = (proj: string, name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);

// `report` as the agent runs it.
function report(proj: string, args: string[]): Record<string, unknown> {
  const r = run(ORCHESTRATE, ["report", ...args, "--project-dir", proj]);
  const line = r.out.split("\n").find((entry) => entry.startsWith("{"));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

// What the person types, through the real UserPromptSubmit route every harness uses.
function says(proj: string, prompt: string): void {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

// The stage's outputs exist and the agent asked the reviewer, who never answered.
function reviewAskedNeverFinished(proj: string): void {
  const dir = join(seededRecordDir(proj), "inception", SLUG);
  mkdirSync(dir, { recursive: true });
  for (const name of ["requirements.md", "requirements-analysis-questions.md"]) {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, `# ${name}\n`);
  }
  const asked = run(LOG, [
    "review", "--stage", SLUG, "--reviewer", REVIEWER, "--iteration", "1", "--project-dir", proj,
  ]);
  expect(asked.rc, asked.out).toBe(0);
}

// The review finished READY, the document changed after it (so the Guard
// Policy, strict here, makes that review stale), and the person asked for it
// again: that request is the one recovery pass, and it never finished.
function recoveryAskedNeverFinished(proj: string): void {
  const dir = join(seededRecordDir(proj), "inception", SLUG);
  mkdirSync(dir, { recursive: true });
  for (const name of ["requirements.md", "requirements-analysis-questions.md"]) {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, `# ${name}\n`);
  }
  const first = run(LOG, ["review", "--stage", SLUG, "--reviewer", REVIEWER, "--iteration", "1", "--project-dir", proj]);
  expect(first.rc, first.out).toBe(0);
  const file = (JSON.parse(first.out.split("\n").find((line) => line.startsWith("{")) as string) as { reviewFile: string })
    .reviewFile;
  writeFileSync(
    join(proj, file),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
      "### Findings\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n" +
      "### Summary\n\nReady.\n",
  );
  const ready = run(LOG, [
    "review", "--stage", SLUG, "--reviewer", REVIEWER, "--iteration", "1", "--verdict", "READY", "--project-dir", proj,
  ]);
  expect(ready.rc, ready.out).toBe(0);
  writeFileSync(join(dir, "requirements.md"), "# requirements.md\n\n- A title cannot be blank.\n");
  says(proj, "review the requirements again before I approve");
  const again = run(LOG, ["review", "--stage", SLUG, "--reviewer", REVIEWER, "--iteration", "2", "--project-dir", proj]);
  expect(again.rc, again.out).toBe(0);
  const request = events(proj, "REVIEW_REQUESTED").at(-1);
  expect(auditBlockField(request?.block ?? "", "Recovery"), request?.block).toBe("stale-receipt");
}

function lockStrict(proj: string): void {
  const dir = join(proj, "aidlc", "spaces", "default", "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "project.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Project\n";
  writeFileSync(
    path,
    existing.includes("## Guard Policy\n")
      ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`,
    "utf-8",
  );
}

function completed(proj: string): boolean {
  return /- \[x\] requirements-analysis/.test(readFileSync(seededStateFile(proj), "utf-8"));
}

function notices(directive: Record<string, unknown>): string[] {
  return Array.isArray(directive.change_notices) ? directive.change_notices as string[] : [];
}

describe("the person's approval goes through over a review that never finished", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-mid-inception.md");
  });
  afterEach(() => cleanupTestProject(proj));

  test("from the stage itself: approved, the review shown as not finished, one line", () => {
    reviewAskedNeverFinished(proj);
    says(proj, WORDS);
    const done = report(proj, ["--stage", SLUG, "--result", "approved", "--user-input", WORDS]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(notices(done)).toContain(NOTICE);
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "Review")).toBe("not finished");
    expect(events(proj, "GATE_REJECTED")).toHaveLength(0);
    expect(events(proj, "STAGE_REVISING")).toHaveLength(0);
    const after = readFileSync(seededStateFile(proj), "utf-8");
    expect(completed(proj)).toBe(true);
    expect(getField(after, "Current Stage")).not.toBe(SLUG);
  });

  test("at an open gate: the same approval with their words, the same one line", () => {
    expect(state(proj, ["gate-start", SLUG], { AIDLC_SKIP_REVIEWER_GATE_GUARD: "1" }).rc).toBe(0);
    reviewAskedNeverFinished(proj);
    says(proj, WORDS);
    const done = report(proj, ["--result", "approved", "--user-input", WORDS]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(notices(done)).toContain(NOTICE);
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "Review")).toBe("not finished");
    expect(auditBlockField(approved[0].block, "Person Reply")).toBe(WORDS);
    expect(events(proj, "GATE_REJECTED")).toHaveLength(0);
  });

  test("with no reply from the person, nothing is approved and the review is still owed", () => {
    reviewAskedNeverFinished(proj);
    const refused = report(proj, ["--stage", SLUG, "--result", "approved", "--user-input", "Approve"]);
    expect(refused.kind).not.toBe("done");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
    expect(completed(proj)).toBe(false);
  });

  test("the agent cannot open the gate over the review on its own", () => {
    reviewAskedNeverFinished(proj);
    const refused = state(proj, ["gate-start", SLUG, "--recovered", "--person-approves"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("REVIEW_EVIDENCE_MISSING");
    expect(events(proj, "STAGE_AWAITING_APPROVAL")).toHaveLength(0);
  });

  test("a review never asked for is still required", () => {
    says(proj, WORDS);
    const refused = report(proj, ["--stage", SLUG, "--result", "approved", "--user-input", WORDS]);
    expect(refused.kind).not.toBe("done");
    expect(JSON.stringify(refused)).toContain("REVIEW_EVIDENCE_MISSING");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
  });

  // The person asked for the review again and then said they do not need it:
  // a recovery review is their call too.
  test("over a recovery review that never finished: approved, the review shown as not finished, one line", () => {
    recoveryAskedNeverFinished(proj);
    says(proj, WORDS);
    const done = report(proj, ["--stage", SLUG, "--result", "approved", "--user-input", WORDS]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(notices(done)).toContain(NOTICE);
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "Review")).toBe("not finished");
    expect(events(proj, "GATE_REJECTED")).toHaveLength(0);
    expect(completed(proj)).toBe(true);
  });

  test("a team that locks Guard Policy strict keeps the recovery review required, and its way on works", () => {
    lockStrict(proj);
    recoveryAskedNeverFinished(proj);
    says(proj, WORDS);
    const refused = report(proj, ["--stage", SLUG, "--result", "approved", "--user-input", WORDS]);
    expect(refused.kind).not.toBe("done");
    expect(JSON.stringify(refused)).toContain("REVIEW_RECOVERY_PENDING");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
    // The review it waits for can be asked for again: the same pass, once more.
    const retry = run(LOG, [
      "review", "--stage", SLUG, "--reviewer", REVIEWER, "--iteration", "2", "--retry-pending", "--project-dir", proj,
    ]);
    expect(retry.rc, retry.out).toBe(0);
  });

  test("a team that locks Guard Policy strict keeps the review required", () => {
    lockStrict(proj);
    reviewAskedNeverFinished(proj);
    says(proj, WORDS);
    const refused = report(proj, ["--stage", SLUG, "--result", "approved", "--user-input", WORDS]);
    expect(refused.kind).not.toBe("done");
    expect(JSON.stringify(refused)).toContain("REVIEW_EVIDENCE_MISSING");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
  });
});
