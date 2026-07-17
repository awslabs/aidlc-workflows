// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-audit:append-batch, function:emitSingleRunStage, function:handleSingleReport
//
// t127 — the `--single` stage-runner invariant (v0.6.0 Wave 3 milestone 14).
// Migrated from tests/integration/t127-single-stage-invariant.sh (TAP plan 16).
// Mechanism: cli. The whole subject is the engine's PROCESS boundary —
// `next --stage <slug> --single` / `report --single --stage <slug>` argv,
// the JSON directive on stdout, the bytes the synthetic-pair commit appends
// to aidlc-docs/audit.md, AND the pointer-invariant read of the main state
// file via aidlc-state.ts get. Every assertion is observable only across
// that boundary, so each case SPAWNS the real tool via the BUN runtime
// against the .ts path (the same pattern t104.cli credits), exactly as the
// .sh shelled out to `bun "$TOOL" ...`.
//
// Source under test (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   :910  next Branch 4b — `if (flags.single)` short-circuits BEFORE the
//          jump/scope-change branches (so no mutating path is reached): rejects
//          --single+--phase (:911), requires --stage (:919), else delegates to
//   :1246 emitSingleRunStage(slug, scope, projectType): builds the lone
//          run-stage directive from the GRAPH NODE alone (stateContent: null →
//          never reads/writes the main pointer), attaches conductor_persona
//          (D-E, :1281). Rejects an initialization stage (:1258 SINGLE_INIT_ERROR)
//          and a SKIP-for-scope stage with the verbatim skip wording (:1264).
//   :1741 handleSingleReport(flags, projectDir): requires --result (:1745),
//          and the EXPLICIT half of the pointer rule — refuses a --single report
//          with NO --stage as an attempt to advance the main workflow (:1762).
//          On success spawns one atomic aidlc-audit append-batch containing
//          STAGE_STARTED (Stage+Agent+Workflow) then STAGE_COMPLETED
//          (Stage+Details+Workflow), under the synthetic id
//          `single-stage:<slug>`, then emits a `done` directive.
//          report Branch -1 (:1833) routes here before any main-workflow branch.
//   The companion never dispatches advance/approve/complete-workflow, so the
//   main pointer is structurally untouchable from a single-stage run.
//
// The state-pointer read uses aidlc-state.ts `get "Current Stage"` (the .sh's
// $STATE_TOOL), spawned the same way, asserting the field is `feasibility`
// before AND after each --single leg.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1  (main starts parked at feasibility)          -> test "1: main workflow starts parked at feasibility"
//   .sh 2  (next --single emits run-stage)              -> test "2: next --single emits a run-stage directive"
//   .sh 3  (targets requested stage, not Current Stage) -> test "3: next --single targets the requested stage"
//   .sh 4  (conductor_persona on first directive, D-E)  -> test "4: next --single delivers the conductor persona"
//   .sh 5  (next --single leaves Current Stage)         -> test "5: next --single leaves main Current Stage untouched"
//   .sh 6  (report --single emits done)                 -> test "6: report --single emits a done directive"
//   .sh 7  (report --single leaves Current Stage)       -> test "7: report --single leaves main Current Stage untouched"
//   .sh 8  (exactly one STAGE_STARTED)                  -> test "8: report --single commits exactly one STAGE_STARTED"
//   .sh 9  (exactly one STAGE_COMPLETED)                -> test "9: report --single commits exactly one STAGE_COMPLETED"
//   .sh 10 (pair tagged with single-stage workflow id)  -> test "10: synthetic pair tagged with single-stage workflow id"
//   .sh 11 (report --single no --stage errors)          -> test "11: report --single with no --stage errors"
//   .sh 12 (refused report commits no STAGE_COMPLETED)  -> test "12: refused report --single commits no STAGE_COMPLETED"
//   .sh 13 (next --single no --stage errors)            -> test "13: next --single with no --stage errors"
//   .sh 14 (next --single rejects init stage)           -> test "14: next --single rejects an initialization stage"
//   .sh 15 (next --single rejects SKIP-for-scope stage) -> test "15: next --single rejects a SKIP-for-scope stage"
//   .sh 16 (next --single --phase mutually exclusive)   -> test "16: next --single --phase errors"
//
// §6-E note: tests 11/13/14/15/16 are the tool-enforced REFUSALS — each
// asserts the `error` directive ACTUALLY fires (the verbatim refusal string),
// and test 12 proves the refused report commits NOTHING (zero STAGE_COMPLETED
// on disk). The happy-path pointer cases (5,7) additionally read the real
// state file back, proving the pointer is unmoved — not merely absent of a
// move directive.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seededAuditShard,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE_TOOL = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const STATE_FIXTURE = "state-mid-ideation.md";

const projects: string[] = [];

afterEach(() => {
  for (const p of projects.splice(0)) cleanupTestProject(p);
});

/** A fresh temp project registered for teardown (mirrors create_test_project). */
function freshProject(): string {
  const proj = createTestProject();
  projects.push(proj);
  return proj;
}

/** Combined stdout+stderr of a spawned orchestrate/state invocation (the .sh's 2>&1). */
function run(tool: string, args: string[]): { out: string; status: number } {
  const res = spawnSync(BUN, [tool, ...args], { encoding: "utf-8" });
  return {
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    status: res.status ?? -1,
  };
}

/** `aidlc-state.ts get "Current Stage"` — the main pointer the .sh read. */
function currentStage(proj: string): string {
  return run(STATE_TOOL, ["get", "Current Stage", "--project-dir", proj]).out.trim();
}

/**
 * count_event (t127:38-40): audit rows of one event type. The .sh grepped
 * `^**Event**: <TYPE>$`; here we count lines that equal `**Event**: <TYPE>`.
 */
function countEvent(proj: string, event: string): number {
  // P9: the synthetic pair lands in the seeded record's per-clone shard
  // (seedAuditFile pins the clone-id, so the report subprocess and the test
  // resolve the SAME shard), not the flat aidlc-docs/audit.md.
  const body = readFileSync(seededAuditShard(proj), "utf-8");
  return body.split("\n").filter((l) => l === `**Event**: ${event}`).length;
}

// ===========================================================================
// Tests 1-7: pointer invariant across next --single + report --single.
// Seed an ACTIVE feature workflow parked at `feasibility` (Current Stage),
// run a DIFFERENT stage (code-generation) via --single, and prove neither
// leg moves the main pointer off `feasibility`. The .sh ran these against a
// single shared project; here each test rebuilds the same seeded project so
// the cases are order-independent (STRONGER isolation, same observables).
// ===========================================================================
describe("t127 --single pointer invariant (migrated from t127-single-stage-invariant.sh, plan 16)", () => {
  test("1: main workflow starts parked at feasibility [.sh 1]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    expect(currentStage(proj)).toBe("feasibility");
  });

  test("2: next --single emits a run-stage directive [.sh 2]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "code-generation", "--single", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"kind":"run-stage"');
  });

  test("2b: next --single marks the isolated non-gated conductor branch", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "code-generation", "--single", "--project-dir", proj,
    ]);
    const directive = JSON.parse(r.out.trim()) as Record<string, unknown>;
    expect(directive.single).toBe(true);
    expect(directive.gate).toBe(false);
    expect(directive.next_stage).toBeNull();
  });

  test("3: next --single targets the requested stage, not Current Stage [.sh 3]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "code-generation", "--single", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"stage":"code-generation"');
  });

  test("4: next --single delivers the conductor persona on the first directive (D-E) [.sh 4]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "code-generation", "--single", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"conductor_persona"');
  });

  test("5: next --single leaves the main Current Stage untouched [.sh 5]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    // before
    expect(currentStage(proj)).toBe("feasibility");
    run(TOOL, ["next", "--stage", "code-generation", "--single", "--project-dir", proj]);
    // after — read the real state file back; the pointer must be unmoved.
    expect(currentStage(proj)).toBe("feasibility");
  });

  test("6: report --single emits a done directive [.sh 6]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    expect(r.out).toContain('"kind":"done"');
  });

  test("7: report --single leaves the main Current Stage untouched [.sh 7]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    expect(currentStage(proj)).toBe("feasibility");
  });

  // =========================================================================
  // Tests 8-10: the synthetic-id audit pair lands, tagged, audit-only.
  // Seed audit-sample.md (which carries ZERO STAGE_STARTED/STAGE_COMPLETED
  // rows — verified), so the post-commit counts are exactly the pair the
  // --single report wrote.
  // =========================================================================
  test("8: report --single commits exactly one STAGE_STARTED [.sh 8]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    expect(countEvent(proj, "STAGE_STARTED")).toBe(1);
  });

  test("9: report --single commits exactly one STAGE_COMPLETED [.sh 9]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    expect(countEvent(proj, "STAGE_COMPLETED")).toBe(1);
  });

  test("10: the synthetic pair is tagged with the single-stage workflow id [.sh 10]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    run(TOOL, [
      "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ]);
    const body = readFileSync(seededAuditShard(proj), "utf-8");
    // syntheticWorkflowId("code-generation") === "single-stage:code-generation".
    // STRONGER than the .sh's single grep: BOTH committed rows must carry the
    // `**Workflow**: single-stage:code-generation` tag (the .sh proved one).
    const tagged = body
      .split("\n")
      .filter((l) => l === "**Workflow**: single-stage:code-generation").length;
    expect(tagged).toBe(2);
  });

  test("10b: append-batch validates the complete pair before writing either row", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const before = readFileSync(seededAuditShard(proj), "utf-8");
    const entries = JSON.stringify([
      {
        eventType: "STAGE_STARTED",
        fields: {
          Stage: "code-generation",
          Workflow: "single-stage:code-generation",
        },
      },
      {
        eventType: "NOT_A_REAL_EVENT",
        fields: {
          Stage: "code-generation",
          Workflow: "single-stage:code-generation",
        },
      },
    ]);

    const result = run(AUDIT_TOOL, [
      "append-batch",
      entries,
      "--project-dir",
      proj,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.out).toContain("Invalid event type: NOT_A_REAL_EVENT");
    expect(readFileSync(seededAuditShard(proj), "utf-8")).toBe(before);
  });

  // =========================================================================
  // Tests 11-12: report --single with NO --stage is an attempt to advance the
  // main workflow -> error (tool-enforced refusal), committing nothing.
  // =========================================================================
  test("11: report --single with no --stage errors (refuses to advance the main workflow) [.sh 11]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const r = run(TOOL, [
      "report", "--single", "--result", "completed", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"kind":"error"');
    // STRONGER: pin the verbatim refusal wording (aidlc-orchestrate.ts:1763).
    expect(r.out).toContain("must not advance the main workflow");
  });

  test("12: the refused report --single commits no STAGE_COMPLETED [.sh 12]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    run(TOOL, ["report", "--single", "--result", "completed", "--project-dir", proj]);
    expect(countEvent(proj, "STAGE_COMPLETED")).toBe(0);
  });

  test("12b: report --single rejects skipped because it is a main-workflow routing outcome", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const r = run(TOOL, [
      "report",
      "--single",
      "--stage",
      "code-generation",
      "--result",
      "skipped",
      "--reason",
      "not applicable",
      "--project-dir",
      proj,
    ]);
    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("commits forward outcomes only");
    expect(currentStage(proj)).toBe("feasibility");
    expect(countEvent(proj, "STAGE_STARTED")).toBe(0);
    expect(countEvent(proj, "STAGE_COMPLETED")).toBe(0);
    expect(countEvent(proj, "STAGE_SKIPPED")).toBe(0);
  });

  // =========================================================================
  // Test 13: next --single requires --stage.
  // =========================================================================
  test("13: next --single with no --stage errors [.sh 13]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, ["next", "--single", "--project-dir", proj]);
    expect(r.out).toContain('"kind":"error"');
    // STRONGER: pin the verbatim wording (aidlc-orchestrate.ts:921).
    expect(r.out).toContain("--single requires --stage");
  });

  // =========================================================================
  // Test 14: an initialization stage cannot run via --single.
  // =========================================================================
  test("14: next --single rejects an initialization stage (use --init) [.sh 14]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--stage", "workspace-detection", "--single", "--project-dir", proj,
    ]);
    expect(r.out).toContain("initialization stage with --single");
  });

  // =========================================================================
  // Test 15: a SKIP-for-scope stage cannot run via --single.
  // `user-stories` is SKIP for bugfix; --single relays the verbatim skip
  // wording. Use a NO-STATE project so the explicit --scope bugfix resolves
  // (an active workflow's state Scope would win the precedence ladder).
  // =========================================================================
  test("15: next --single rejects a SKIP-for-scope stage with the verbatim skip wording [.sh 15]", () => {
    const proj = freshProject();
    // No-state project: createTestProject already leaves aidlc-docs/ empty, so
    // there is no aidlc-state.md (the .sh did `rm -f` defensively — here it
    // never existed). The flag --scope bugfix therefore resolves.
    const r = run(TOOL, [
      "next", "--stage", "user-stories", "--single", "--scope", "bugfix",
      "--project-dir", proj,
    ]);
    // The verbatim wording is `Stage "..." is skipped for scope "bugfix".`; in
    // JSON stdout the quotes are backslash-escaped, so match the quote-free
    // substring (same as the .sh).
    expect(r.out).toContain("is skipped for scope");
  });

  // =========================================================================
  // Test 16: --single + --phase is mutually exclusive.
  // =========================================================================
  test("16: next --single --phase errors (one stage, not a range) [.sh 16]", () => {
    const proj = freshProject();
    seedStateFile(proj, STATE_FIXTURE);
    const r = run(TOOL, [
      "next", "--single", "--phase", "inception", "--project-dir", proj,
    ]);
    expect(r.out).toContain("Cannot use --single with --phase");
  });
});
