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
//
// Under Guard Policy relaxed or off a recovery review (the one pass a change
// after a review gets) is not owed at all, at `unit complete` and at the gate
// alike, so it never holds the gate.

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
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { artifactFilename, auditBlockField, findStageBySlug, getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

// The stage's checks run before each review and gate (completionChecksStep,
// t-checks-before-review); this file's fixture documents are not written for
// them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

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

function report(proj: string, args: string[], extra: Record<string, string> = {}): Record<string, unknown> {
  const r = run(ORCHESTRATE, ["report", ...args, "--project-dir", proj], extra);
  const line = r.out.split("\n").find((entry) => entry.startsWith("{"));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

// The person types `prompt` in this chat; the shipped human-turn hook keeps it.
// Returns the id of the message it kept.
function says(proj: string, prompt: string): string {
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
  const id = auditBlockField(events(proj, "HUMAN_TURN").at(-1)?.block ?? "", "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

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

// Code Generation reviews the project source too. The person asked for its
// review again after the source changed, that review never finished, and they
// said they do not need it: their approval goes over it, as at a stage with no
// source, under any Guard Policy but a team-locked strict.
describe("Code Generation: the person's approval goes over a review of changed source that never finished", () => {
  const CG = "code-generation";
  const CG_REVIEWER = "aidlc-architecture-reviewer-agent";
  const CG_NOTICE = "Approved. The Code Generation review did not finish.";
  const DASH = "\u2014"; // the state file's stage-line separator
  const cgEnv = { AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" };
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedAidlcMemory(proj);
    writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking
## Project Information
- **Project**: A bug fix with changed source
- **Project Type**: Brownfield
- **Scope**: bugfix
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Guard Policy**: strict (set by you)
- **Review Override**: advisory
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Minimal
- **Test Strategy**: Minimal
## Stage Progress
### INCEPTION PHASE
- [x] requirements-analysis ${DASH} EXECUTE
- [S] units-generation ${DASH} SKIP
### CONSTRUCTION PHASE
- [-] code-generation ${DASH} EXECUTE
- [ ] build-and-test ${DASH} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`);
  });
  afterEach(() => cleanupTestProject(proj));

  const cgReview = (iteration: number, extra: string[] = []) =>
    run(LOG, ["review", "--stage", CG, "--reviewer", CG_REVIEWER, "--iteration", String(iteration), ...extra, "--project-dir", proj], cgEnv);

  // The code reviewed READY, the source changed after it (strict makes that
  // review stale), and the person asked for the review again: that one
  // recovery pass never finished.
  // The plan the build went ahead on: `next` asks, the person approves.
  function planApproved(dir: string): void {
    writeFileSync(join(dir, "code-generation-plan.md"),
      `# Plan\n\n${renderTestingContract(resolveTestingPosture(proj))}\n## Steps\n\n- [ ] Step 1: fix the total\n`);
    writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n");
    const asked = run(ORCHESTRATE, ["next", "--project-dir", proj]);
    expect(asked.out).toContain('"ask_type":"plan-approval"');
    says(proj, "approve the plan");
    const answered = run(LOG, ["answer", "--stage", CG, "--checkpoint", "plan-approval", "--details", "Approve Plan", "--project-dir", proj]);
    expect(answered.rc, answered.out).toBe(0);
  }

  function recoveryOfChangedSource(): void {
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "app.ts"), "export const total = 1;\n");
    const dir = join(seededRecordDir(proj), "construction", CG);
    mkdirSync(dir, { recursive: true });
    planApproved(dir);
    for (const name of ["code-summary.md", "traceability.json"]) {
      writeFileSync(join(dir, name), name.endsWith(".json") ? "{}\n" : `# ${name}\n`);
    }
    const first = cgReview(1);
    expect(first.rc, first.out).toBe(0);
    const file = (JSON.parse(first.out.split("\n").find((line) => line.startsWith("{")) as string) as { reviewFile: string })
      .reviewFile;
    writeFileSync(
      join(proj, file),
      `## Review\n\n**Verdict:** READY\n**Reviewer:** ${CG_REVIEWER}\n**Iteration:** 1\n\n` +
        "### Findings\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n",
    );
    const ready = cgReview(1, ["--verdict", "READY"]);
    expect(ready.rc, ready.out).toBe(0);
    writeFileSync(join(proj, "src", "app.ts"), "export const total = 2;\n");
    says(proj, "review the code again before I approve");
    const again = cgReview(2);
    expect(again.rc, again.out).toBe(0);
    const request = events(proj, "REVIEW_REQUESTED").at(-1);
    expect(auditBlockField(request?.block ?? "", "Recovery"), request?.block).toBe("stale-receipt");
  }

  test("strict set for the work: approved, the review shown as not finished, one line", () => {
    recoveryOfChangedSource();
    says(proj, WORDS);
    const done = report(proj, ["--stage", CG, "--result", "approved", "--user-input", WORDS], cgEnv);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(JSON.stringify(done)).not.toContain("SOURCE_REVIEW_STALE");
    expect(notices(done)).toContain(CG_NOTICE);
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "Review")).toBe("not finished");
    expect(events(proj, "GATE_REJECTED")).toHaveLength(0);
  });

  test("a team-locked strict keeps the review required, and names its retry", () => {
    lockStrict(proj);
    recoveryOfChangedSource();
    says(proj, WORDS);
    const refused = report(proj, ["--stage", CG, "--result", "approved", "--user-input", WORDS], cgEnv);
    expect(refused.kind).not.toBe("done");
    expect(JSON.stringify(refused)).toContain("REVIEW_RECOVERY_PENDING");
    expect(JSON.stringify(refused)).toContain("--retry-pending");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
    const retry = cgReview(2, ["--retry-pending"]);
    expect(retry.rc, retry.out).toBe(0);
  });
});

// Under Guard Policy relaxed or off a changed input is said once and carries
// on, so a Unit's recovery review that never finished is not owed: `unit
// complete` already goes past it, and the stage's gate reads the same rule
// (recoveryReviewOwed), so it opens instead of sending the reviewer round
// again. Strict and a team-locked strict still hold it at both, and their way
// on (the review asked again, then its verdict) opens the gate.
describe("a Unit's recovery review that never finished, at unit complete and at the gate", () => {
  const FD = "functional-design";
  const FD_REVIEWER = "aidlc-architecture-reviewer-agent";
  const DASH = "\u2014"; // the state file's stage-line separator
  type Policy = "strict" | "relaxed" | "off-scope" | "off-memory" | "locked-strict";
  const LINES: Record<Policy, string> = {
    strict: "strict (set by you)",
    relaxed: "relaxed (set by you)",
    "off-scope": "off (from scope feature)",
    "off-memory": "strict (from scope feature)",
    "locked-strict": "off (from scope feature)",
  };
  let proj: string;
  afterEach(() => cleanupTestProject(proj));

  function unitProject(policy: Policy): void {
    resetAidlcEnv();
    proj = createTestProject();
    seedAidlcMemory(proj);
    writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Unit recovery reviews
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Unit Ownership**: solo
- **Skeleton Stance**: on
- **Construction Iteration**: unit-major

## Runtime State
- **Revision Count**: 0
- **Guard Policy**: ${LINES[policy]}

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design ${DASH} EXECUTE
- [S] nfr-requirements ${DASH} EXECUTE
- [S] nfr-design ${DASH} EXECUTE
- [S] infrastructure-design ${DASH} EXECUTE
- [S] code-generation ${DASH} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-07-30T00:00:00Z
`, "utf-8");
    const memory = join(proj, "aidlc", "spaces", "default", "memory");
    const under = (file: string, line: string) => {
      const text = readFileSync(join(memory, file), "utf-8");
      expect(text).toContain("## Guard Policy\n");
      writeFileSync(join(memory, file), text.replace("## Guard Policy\n", `## Guard Policy\n\n${line}\n`), "utf-8");
    };
    if (policy === "off-memory") under("project.md", "- Mode: off");
    if (policy === "locked-strict") under("team.md", "- Mode: strict");
    seedBoltDag(proj, ["unit-a", "unit-b"]);
  }

  const unitDir = (unit: string) => join(seededRecordDir(proj), "construction", unit, FD);
  function unitArtifacts(unit: string): string[] {
    const names = (findStageBySlug(FD)?.produces ?? []).map((name) => artifactFilename(name));
    expect(names.length).toBeGreaterThan(1);
    mkdirSync(unitDir(unit), { recursive: true });
    for (const name of names) writeFileSync(join(unitDir(unit), name), name.endsWith(".json") ? "{}\n" : `# ${name}\nstub\n`);
    return names;
  }
  const unitVerb = (action: string, unit: string) => state(proj, ["unit", action, "--stage", FD, "--unit", unit]);
  function unitReview(unit: string, iteration: number, verdict?: string, extra: string[] = []): void {
    const args = ["review", "--stage", FD, "--reviewer", FD_REVIEWER, "--unit", unit, "--iteration", String(iteration)];
    const asked = run(LOG, [...args, ...extra, "--project-dir", proj]);
    expect(asked.rc, asked.out).toBe(0);
    if (verdict === undefined) return;
    const file = (JSON.parse(asked.out.split("\n").find((line) => line.startsWith("{")) as string) as { reviewFile: string })
      .reviewFile;
    writeFileSync(
      join(proj, file),
      `## Review\n\n**Verdict:** ${verdict}\n**Reviewer:** ${FD_REVIEWER}\n**Iteration:** ${iteration}\n\n### Findings\n\nNo blocking findings.\n`,
    );
    const recorded = run(LOG, [...args, "--verdict", verdict, "--project-dir", proj]);
    expect(recorded.rc, recorded.out).toBe(0);
  }

  // unit-a reviewed READY, then its rules changed and its review was asked for
  // again: the one recovery pass, with no verdict. `asked`: the person asked for
  // it.
  function recoveryLeftUnfinished(asked = true): void {
    expect(unitVerb("start", "unit-a").rc).toBe(0);
    const names = unitArtifacts("unit-a");
    unitReview("unit-a", 1, "READY");
    writeFileSync(join(unitDir("unit-a"), names[1]), "# rules\n\n- A title cannot be blank.\n");
    if (asked) says(proj, "review unit-a again");
    unitReview("unit-a", 2);
    const request = events(proj, "REVIEW_REQUESTED").at(-1);
    expect(auditBlockField(request?.block ?? "", "Recovery"), request?.block).toBe("stale-receipt");
    expect(auditBlockField(request?.block ?? "", "Unit")).toBe("unit-a");
  }

  function unitBDone(): void {
    expect(unitVerb("start", "unit-b").rc).toBe(0);
    unitArtifacts("unit-b");
    unitReview("unit-b", 1, "READY");
    const done = unitVerb("complete", "unit-b");
    expect(done.rc, done.out).toBe(0);
  }

  test.each(["relaxed", "off-scope", "off-memory"] as const)("%s: unit complete goes past it, and so does the gate", (policy) => {
    unitProject(policy);
    recoveryLeftUnfinished();
    const done = unitVerb("complete", "unit-a");
    expect(done.rc, done.out).toBe(0);
    unitBDone();
    const opened = report(proj, ["--stage", FD, "--result", "completed"]);
    expect(JSON.stringify(opened)).not.toContain("REVIEW_RECOVERY_PENDING");
    expect(opened.ask_type, JSON.stringify(opened)).not.toBe("guard-recovery");
    expect(events(proj, "STAGE_AWAITING_APPROVAL"), JSON.stringify(opened)).toHaveLength(1);
    // The reviewer is not sent round again: no request after the unfinished one.
    expect(events(proj, "REVIEW_REQUESTED").filter((row) => auditBlockField(row.block, "Unit") === "unit-a")).toHaveLength(2);
    says(proj, "approve it");
    const approved = report(proj, ["--stage", FD, "--result", "approved", "--user-input", "approve it"]);
    expect(approved.kind, JSON.stringify(approved)).toBe("done");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(1);
    expect(events(proj, "GATE_REJECTED")).toHaveLength(0);
  });

  test.each(["strict", "locked-strict"] as const)("%s: unit complete and the gate both hold it, and the review's retry opens the gate", (policy) => {
    unitProject(policy);
    recoveryLeftUnfinished(false);
    const refused = unitVerb("complete", "unit-a");
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("--retry-pending");
    unitReview("unit-a", 2, "READY", ["--retry-pending"]);
    const done = unitVerb("complete", "unit-a");
    expect(done.rc, done.out).toBe(0);
    unitBDone();
    const opened = report(proj, ["--stage", FD, "--result", "completed"]);
    expect(JSON.stringify(opened)).not.toContain("REVIEW_RECOVERY_PENDING");
    expect(events(proj, "STAGE_AWAITING_APPROVAL"), JSON.stringify(opened)).toHaveLength(1);
  });

  test("strict: the gate holds a recovery review unit complete never saw, and its retry opens the gate", () => {
    unitProject("strict");
    expect(unitVerb("start", "unit-a").rc).toBe(0);
    unitArtifacts("unit-a");
    unitReview("unit-a", 1, "READY");
    expect(unitVerb("complete", "unit-a").rc).toBe(0);
    unitBDone();
    const names = (findStageBySlug(FD)?.produces ?? []).map((name) => artifactFilename(name));
    writeFileSync(join(unitDir("unit-a"), names[1]), "# rules\n\n- A title cannot be blank.\n");
    says(proj, "review unit-a again");
    unitReview("unit-a", 2);
    const held = report(proj, ["--stage", FD, "--result", "completed"]);
    expect(JSON.stringify(held)).toContain("REVIEW_RECOVERY_PENDING");
    expect(events(proj, "STAGE_AWAITING_APPROVAL")).toHaveLength(0);
    unitReview("unit-a", 2, "READY", ["--retry-pending"]);
    const opened = report(proj, ["--stage", FD, "--result", "completed"]);
    expect(JSON.stringify(opened)).not.toContain("REVIEW_RECOVERY_PENDING");
    expect(events(proj, "STAGE_AWAITING_APPROVAL"), JSON.stringify(opened)).toHaveLength(1);
  });
});

describe("a stage's recovery review that never finished, after the person turns Guard Policy off", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-mid-inception.md");
  });
  afterEach(() => cleanupTestProject(proj));

  test("the gate opens on the earlier READY review", () => {
    recoveryAskedNeverFinished(proj);
    const asked = says(proj, "turn guard policy off");
    const set = run(join(AIDLC_SRC, "tools", "aidlc-utility.ts"), [
      "config-change", "--guard-policy", "off", "--message", asked, "--project-dir", proj,
    ]);
    expect(set.rc, set.out).toBe(0);
    expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Guard Policy")).toBe("off (set by you)");
    const opened = report(proj, ["--stage", SLUG, "--result", "completed"]);
    expect(JSON.stringify(opened)).not.toContain("REVIEW_RECOVERY_PENDING");
    expect(events(proj, "STAGE_AWAITING_APPROVAL"), JSON.stringify(opened)).toHaveLength(1);
    says(proj, "approve it");
    const done = report(proj, ["--stage", SLUG, "--result", "approved", "--user-input", "approve it"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(1);
  });
});
