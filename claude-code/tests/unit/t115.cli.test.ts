// covers: subcommand:aidlc-state:approve
//
// CLI-contract port of tests/unit/t115-orchestrate-report.sh (TAP plan 22),
// mechanism = cli. The .sh drives `aidlc-orchestrate.ts report` — the
// commit-the-transition half of the orchestration engine. report is a THIN
// DISPATCHER that shells out to EXACTLY ONE of `aidlc-state.ts approve /
// advance / complete-workflow` per the acted stage's gate status (then
// finality). The covers UNIT credited here is `aidlc-state.ts approve` — the
// committing subcommand report dispatches to on every GATED stage (the
// gated-approve round-trip, and the final gated approve that self-delegates to
// complete-workflow). The .sh also fires `aidlc-state.ts gate-start` (to flip
// [-] -> [?] so approve's validateSlugInState passes) and `aidlc-state.ts
// advance` (the non-gated path + the replay-guard cases) directly.
//
// MECHANISM: this is a .cli file, so every observable is taken at the PROCESS
// boundary — SPAWN the real binaries via node:child_process spawnSync (BUN +
// the tool .ts path) and assert on res.status / res.stdout / res.stderr and the
// audit.md / aidlc-state.md the tools write. An in-process twin would lose the
// directive-JSON-to-stdout half (every "kind":"done"/"kind":"error" assertion)
// and the cross-process atomic-lock / audit-row-order effects the .sh relies on.
//
// PARITY NOTES — every .sh assertion has an equal-or-stronger counterpart:
//   .sh T1  report no --result -> '"kind":"error"'        -> Test 1 (same).
//   .sh T2  report unknown --result -> 'commits forward transitions only'
//                                                         -> Test 2 (same).
//   .sh T3  report no state file -> '"kind":"error"'      -> Test 3 (same).
//   .sh T4  next before report -> '"stage":"feasibility"' -> Test 4 (same).
//   .sh T5  report gated stage -> '"kind":"done"'         -> Test 5 (same).
//   .sh T6  gated approve emits "GATE_APPROVED STAGE_COMPLETED STAGE_STARTED"
//           in order                                      -> Test 6 (same: the
//           full space-joined event sequence is asserted to contain that run).
//   .sh T7  exactly one STAGE_STARTED (no double-advance) -> Test 7 (same).
//   .sh T8  next after report -> '"stage":"scope-definition"' -> Test 8 (same).
//   .sh T9  no orphan audit lock dir after report (gated) -> Test 9 (same: the
//           md5(projectDir)[:8] lock dir under TMPDIR must not exist).
//   .sh T10 non-gated -> 'Committed advance for'          -> Test 10 (STRONGER:
//           also asserts kind:done and exit 0).
//   .sh T11 non-gated advance -> "STAGE_COMPLETED STAGE_STARTED" -> Test 11.
//   .sh T12 phase boundary PHASE_COMPLETED == 1           -> Test 12.
//   .sh T13 phase boundary PHASE_VERIFIED == 1            -> Test 13.
//   .sh T14 phase boundary PHASE_STARTED == 1             -> Test 14.
//   .sh T15 phase boundary order "STAGE_COMPLETED PHASE_COMPLETED PHASE_VERIFIED
//           PHASE_STARTED STAGE_STARTED"                  -> Test 15.
//   .sh T16 final gated approve -> WORKFLOW_COMPLETED == 1 -> Test 16.
//   .sh T17 final order "STAGE_COMPLETED PHASE_COMPLETED PHASE_VERIFIED
//           WORKFLOW_COMPLETED"                           -> Test 17.
//   .sh T18 final -> Status=Completed (via aidlc-state.ts get) -> Test 18 (same
//           observable: spawn `get Status` and assert stdout === "Completed").
//   .sh T19 advance replay guard -> '"replay":true'       -> Test 19.
//   .sh T20 replay guard emits zero new audit events      -> Test 20 (same: the
//           total **Event**: row count is unchanged across the replay).
//   .sh T21 replayed commit is not an error (ERROR_LOGGED == 0) -> Test 21.
//   .sh T22 re-report on a completed workflow -> '"kind":"error"' (clean error,
//           not a crash)                                  -> Test 22 (STRONGER:
//           also asserts no '"kind":"done"' leaked to stdout).
//
// 22 .sh asserts -> 22 expect()-bearing test() cases. STRONGER additions are
// noted inline (S1..S3).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so audit.md —
// written by the tools via toPosix() helpers — round-trips when read back),
// seeded from the SAME on-disk state fixtures the .sh used. All temp dirs are
// cleaned in afterAll. Nothing is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const ORCH_TOOL = join(TOOLS_DIR, "aidlc-orchestrate.ts");
const STATE_TOOL = join(TOOLS_DIR, "aidlc-state.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh temp project seeded from one of the on-disk state fixtures. */
function projWithState(fixture: string): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedStateFile(p, join(FIXTURES_DIR, fixture));
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-orchestrate.ts <args...> --project-dir <p>`. Mirrors `bun "$TOOL" ...`. */
function orchestrate(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [ORCH_TOOL, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

/** Spawn `bun aidlc-state.ts <args...> --project-dir <p>`. Mirrors `bun "$STATE_TOOL" ...`. */
function state(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [STATE_TOOL, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

/**
 * The audit event types in file order, space-joined. Mirrors the .sh's
 * `grep '\*\*Event\*\*:' | sed 's/.*: //' | tr '\n' ' '` — a trailing space
 * matches the `tr '\n' ' '` shape, but every assertion uses .toContain so the
 * trailing space is immaterial.
 */
function auditEvents(p: string): string {
  const f = auditPath(p);
  if (!existsSync(f)) return "";
  const events: string[] = [];
  for (const line of readFileSync(f, "utf-8").split("\n")) {
    const m = line.match(/^\*\*Event\*\*: (.+)$/);
    if (m) events.push(m[1]);
  }
  return events.length > 0 ? `${events.join(" ")} ` : "";
}

/** Count audit rows of one event type. Mirrors the .sh's count_event grep -c. */
function countEvent(p: string, ev: string): number {
  const f = auditPath(p);
  if (!existsSync(f)) return 0;
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/** Total **Event**: rows (any type). Mirrors the .sh's `grep -c '\*\*Event\*\*:'`. */
function totalEvents(p: string): number {
  const f = auditPath(p);
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.startsWith("**Event**:")).length;
}

/**
 * The per-project audit lock dir. Mirrors the .sh's lock_dir helper, which in
 * turn mirrors aidlc-lib.ts auditLockDir:
 *   $TMPDIR/.aidlc-audit-<md5(projectDir)[:8]>.lock
 * The .sh shells out to `md5`/`md5sum`; createHash("md5") is the bun parity the
 * .sh comment notes is verified. TMPDIR falls back to /tmp exactly as the .sh's
 * `${TMPDIR:-/tmp}`.
 */
function lockDir(p: string): string {
  const hash = createHash("md5").update(p).digest("hex").slice(0, 8);
  const base = process.env.TMPDIR || "/tmp";
  return join(base, `.aidlc-audit-${hash}.lock`);
}

// ============================================================
// Argument / precondition errors (.sh Tests 1-3)
// ============================================================

describe("t115 aidlc-orchestrate report — preconditions (migrated from t115-orchestrate-report.sh, plan 22)", () => {
  test("1: report with no --result emits an error directive", () => {
    const p = projWithState("state-mid-ideation.md");
    const r = orchestrate(["report"], p);
    expect(r.out).toContain('"kind":"error"');
  });

  test("2: report rejects an unknown --result outcome", () => {
    const p = projWithState("state-mid-ideation.md");
    const r = orchestrate(["report", "--result", "rejected"], p);
    expect(r.out).toContain("commits forward transitions only");
  });

  test("3: report with no state file emits an error directive", () => {
    // create_test_project scaffolds aidlc-docs but no state file; the .sh then
    // rm -f's the state file. Here we use a bare project (no seed) for the
    // identical effect — aidlc-state.md is absent.
    const p = createTestProject();
    tempDirs.push(p);
    const r = orchestrate(["report", "--result", "approved"], p);
    expect(r.out).toContain('"kind":"error"');
  });
});

// ============================================================
// GATED APPROVE round-trip (.sh Tests 4-9) — feasibility, mid-ideation.
// report --result approved dispatches `aidlc-state.ts approve`, which OWNS the
// full transition (GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED), no separate
// advance. This is the core unit credited: subcommand:aidlc-state:approve.
// ============================================================

describe("t115 gated approve round-trip (report -> aidlc-state approve)", () => {
  test("4: next before report points at the active gated stage", () => {
    const p = projWithState("state-mid-ideation.md");
    const r = orchestrate(["next"], p);
    expect(r.out).toContain('"stage":"feasibility"');
  });

  test("5-9: gated approve commits the full transition in order, once, no orphan lock", () => {
    const p = projWithState("state-mid-ideation.md");

    // next emits run-stage(feasibility, gate:true); the conductor "acts"; the
    // gate opens via aidlc-state.ts gate-start (flips [-] -> [?] so approve's
    // validateSlugInState(awaiting-approval) passes).
    const gs = state(["gate-start", "feasibility"], p);
    expect(gs.status).toBe(0);

    // report --result approved -> dispatches `aidlc-state.ts approve feasibility`.
    const report = orchestrate(
      ["report", "--result", "approved", "--user-input", "looks good"],
      p,
    );

    // .sh T5: report on a gated stage emits a done directive.
    expect(report.out).toContain('"kind":"done"');

    // .sh T6: gated approve emits GATE_APPROVED then STAGE_COMPLETED then
    // STAGE_STARTED in taxonomy order (approve self-delegates to advance, which
    // emits STAGE_STARTED for scope-definition).
    expect(auditEvents(p)).toContain("GATE_APPROVED STAGE_COMPLETED STAGE_STARTED");

    // .sh T7: exactly one STAGE_STARTED (no double-advance after approve).
    expect(countEvent(p, "STAGE_STARTED")).toBe(1);

    // .sh T8: the follow-up next reflects the advanced stage.
    const after = orchestrate(["next"], p);
    expect(after.out).toContain('"stage":"scope-definition"');

    // .sh T9: no orphan audit lock dir after report (gated path).
    expect(existsSync(lockDir(p))).toBe(false);
  }, 30000);
});

// ============================================================
// NON-GATED ADVANCE (.sh Tests 10-11) — workspace-detection, an init stage.
// report --result completed dispatches `aidlc-state.ts advance` (NOT approve),
// emitting STAGE_COMPLETED then STAGE_STARTED, with no GATE_APPROVED.
// ============================================================

describe("t115 non-gated advance (report -> aidlc-state advance)", () => {
  test("10-11: non-gated stage dispatches advance, emits STAGE_COMPLETED then STAGE_STARTED", () => {
    const p = projWithState("state-pre-workspace-detection.md");
    const report = orchestrate(["report", "--result", "completed"], p);

    // .sh T10: the done reason names the dispatched subcommand. quotes are
    // JSON-escaped in stdout, so match the quote-free substring.
    expect(report.out).toContain("Committed advance for");
    // S1: STRONGER — also pin the directive kind and a clean exit.
    expect(report.out).toContain('"kind":"done"');
    expect(report.status).toBe(0);

    // .sh T11: non-gated advance emits STAGE_COMPLETED then STAGE_STARTED.
    expect(auditEvents(p)).toContain("STAGE_COMPLETED STAGE_STARTED");
  }, 30000);
});

// ============================================================
// NON-GATED PHASE BOUNDARY (.sh Tests 12-15) — state-init -> ideation.
// state-init is the last initialization stage; advancing it crosses the
// init -> ideation boundary, so advance emits the full boundary quartet
// PHASE_COMPLETED + PHASE_VERIFIED + PHASE_STARTED around the stage events.
// ============================================================

describe("t115 non-gated phase-boundary advance (report -> aidlc-state advance)", () => {
  test("12-15: phase-boundary advance emits the boundary events, once each, in order", () => {
    const p = projWithState("state-init-active.md");
    const report = orchestrate(["report", "--result", "completed"], p);
    expect(report.status).toBe(0);

    // .sh T12-T14: each boundary event emitted exactly once.
    expect(countEvent(p, "PHASE_COMPLETED")).toBe(1);
    expect(countEvent(p, "PHASE_VERIFIED")).toBe(1);
    expect(countEvent(p, "PHASE_STARTED")).toBe(1);

    // .sh T15: the events land in taxonomy order.
    expect(auditEvents(p)).toContain(
      "STAGE_COMPLETED PHASE_COMPLETED PHASE_VERIFIED PHASE_STARTED STAGE_STARTED",
    );
  }, 30000);
});

// ============================================================
// FINAL COMPLETE-WORKFLOW (.sh Tests 16-18) — feedback-optimization, gated.
// Its gate approval routes approve -> complete-workflow in-process (finality),
// emitting STAGE_COMPLETED + PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED
// and setting Status=Completed. No STAGE_STARTED — there is no next stage.
// ============================================================

describe("t115 final gated approve -> complete-workflow (report -> aidlc-state approve)", () => {
  test("16-18: final gated approve completes the workflow, in order, Status=Completed", () => {
    const p = projWithState("state-final-stage.md");

    const gs = state(["gate-start", "feedback-optimization"], p);
    expect(gs.status).toBe(0);

    const report = orchestrate(["report", "--result", "approved"], p);
    expect(report.out).toContain('"kind":"done"'); // committed cleanly

    // .sh T16: final gated approve emits WORKFLOW_COMPLETED exactly once.
    expect(countEvent(p, "WORKFLOW_COMPLETED")).toBe(1);

    // .sh T17: final completion event order.
    expect(auditEvents(p)).toContain(
      "STAGE_COMPLETED PHASE_COMPLETED PHASE_VERIFIED WORKFLOW_COMPLETED",
    );

    // .sh T18: final completion sets Status=Completed (read back via the tool's
    // get subcommand — the .sh's `aidlc-state.ts get "Status"`).
    const status = state(["get", "Status"], p);
    expect(status.stdout.trim()).toBe("Completed");
  }, 30000);
});

// ============================================================
// DOUBLE-COMMIT REPLAY GUARD (.sh Tests 19-21).
// report shells out to `aidlc-state.ts advance <slug>`, whose replay guard
// short-circuits a re-commit of the same completed slug: it emits ZERO new audit
// events and returns "replay":true rather than erroring. Exercised at the exact
// subcommand report dispatches (advance), driven directly as the .sh does.
// ============================================================

describe("t115 advance replay guard (aidlc-state advance double-commit)", () => {
  test("19-21: a double-commit returns replay:true, emits zero new events, no ERROR_LOGGED", () => {
    const p = projWithState("state-pre-workspace-detection.md");

    // First commit succeeds.
    const first = state(["advance", "workspace-detection"], p);
    expect(first.status).toBe(0);

    const before = totalEvents(p);

    // Second commit of the same completed slug -> replay guard fires.
    const replay = state(["advance", "workspace-detection"], p);

    // .sh T19: replay guard returns replay:true on a double-commit.
    expect(replay.out).toContain('"replay":true');

    // .sh T20: replay guard emits zero new audit events.
    expect(totalEvents(p)).toBe(before);

    // .sh T21: a replayed commit is not an error (no ERROR_LOGGED).
    expect(countEvent(p, "ERROR_LOGGED")).toBe(0);
  }, 30000);
});

// ============================================================
// RE-REPORT ON A COMPLETED WORKFLOW (.sh Test 22).
// Once Completed, the active stage is [x]; a stray second report dispatches
// approve on an already-completed stage, which aidlc-state.ts rejects. The engine
// surfaces a clean error directive — no crash, no half-emitted directive.
// ============================================================

describe("t115 re-report on a completed workflow (report -> aidlc-state approve rejects)", () => {
  test("22: re-report on a completed workflow emits an error directive, not a crash", () => {
    const p = projWithState("state-final-stage.md");

    const gs = state(["gate-start", "feedback-optimization"], p);
    expect(gs.status).toBe(0);

    // First report completes the workflow.
    const first = orchestrate(["report", "--result", "approved"], p);
    expect(first.out).toContain('"kind":"done"');

    // Second report: approve on an already-completed stage is rejected; the
    // engine surfaces a clean error directive.
    const second = orchestrate(["report", "--result", "approved"], p);
    expect(second.out).toContain('"kind":"error"');
    // S2: STRONGER — confirm no done directive leaked to stdout (clean
    // boundaries: a rejected transition never emits a half-done directive).
    expect(second.stdout).not.toContain('"kind":"done"');
  }, 30000);
});
