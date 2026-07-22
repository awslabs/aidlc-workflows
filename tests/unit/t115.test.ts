// covers: subcommand:aidlc-state:approve, subcommand:aidlc-log:review, audit:REVIEW_REQUESTED, audit:REVIEW_COMPLETED, function:verifyReviewerPrecondition
//
// CLI-contract port of tests/unit/t115-orchestrate-report.sh (TAP plan 22),
// mechanism = cli. The .sh drives `aidlc-orchestrate.ts report` — the
// commit-the-transition half of the orchestration engine. report is a
// stage-aware dispatcher that shells out to `aidlc-state.ts` transition
// subcommands per the acted stage's gate status (then finality), with an
// explicit-stage recovery path that opens a missing gate before approve. The
// covers UNIT credited here is `aidlc-state.ts approve` — the committing
// subcommand report dispatches to on every GATED stage (the gated-approve
// round-trip, the missing-gate recovery, and the final gated approve that
// self-delegates to complete-workflow). The .sh also fires `aidlc-state.ts
// gate-start` (to flip [-] -> [?] so approve's validateSlugInState passes) and
// `aidlc-state.ts advance` (the non-gated path + the replay-guard cases)
// directly.
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
// HARDENING ADDITIONS (beyond .sh parity): the stale re-report guard describe
// block (a re-report of an already-[x] stage after the workflow moved on must
// be an idempotent done — never a gate-demoting advance — at both the report
// and the direct-advance layers, with the legit slug==Current-Stage recovery
// still advancing) and the Recovered-tagging describe block (report's
// gate-start backfill rows carry `Recovered: true`; organic gate-starts do
// not).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so audit.md —
// written by the tools via toPosix() helpers — round-trips when read back),
// seeded from the SAME on-disk state fixtures the .sh used. All temp dirs are
// cleaned in afterAll. Nothing is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditLockDir,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  FIXTURES_DIR,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const ORCH_TOOL = join(TOOLS_DIR, "aidlc-orchestrate.ts");
const STATE_TOOL = join(TOOLS_DIR, "aidlc-state.ts");
const AUDIT_TOOL = join(TOOLS_DIR, "aidlc-audit.ts");

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
    env: {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    },
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

// P9 per-intent layout: state lives in the active intent's record (seedStateFile
// seeds it so the cursor resolves for the spawned report/approve tools); the
// audit trail is a DIR of per-clone shards. report→approve threads the RESOLVED
// active intent, so its events land under the record and its audit lock keys the
// PER-INTENT bucket (see lockDir below). Reads glob every shard.
const statePath = (p: string): string => seededStateFile(p);

function replaceStateText(p: string, oldText: string, newText: string): void {
  const path = statePath(p);
  const content = readFileSync(path, "utf-8");
  if (!content.includes(oldText)) {
    throw new Error(`state fixture did not contain expected text: ${oldText}`);
  }
  writeFileSync(path, content.replace(oldText, newText), "utf-8");
}

/**
 * The audit event types in file order, space-joined. Mirrors the .sh's
 * `grep '\*\*Event\*\*:' | sed 's/.*: //' | tr '\n' ' '` — a trailing space
 * matches the `tr '\n' ' '` shape, but every assertion uses .toContain so the
 * trailing space is immaterial.
 */
function auditEvents(p: string): string {
  const events: string[] = [];
  for (const line of readAllAuditShards(p).split("\n")) {
    const m = line.match(/^\*\*Event\*\*: (.+)$/);
    if (m) events.push(m[1]);
  }
  return events.length > 0 ? `${events.join(" ")} ` : "";
}

/** Count audit rows of one event type. Mirrors the .sh's count_event grep -c. */
function countEvent(p: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readAllAuditShards(p)
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/** Total **Event**: rows (any type). Mirrors the .sh's `grep -c '\*\*Event\*\*:'`. */
function totalEvents(p: string): number {
  return readAllAuditShards(p)
    .split("\n")
    .filter((l) => l.startsWith("**Event**:")).length;
}

/** Audit blocks (split on the `\n---\n` separator) carrying the given event,
 *  in file order — for asserting per-block fields like `**Recovered**: true`. */
function auditBlocksFor(p: string, ev: string): string[] {
  return readAllAuditShards(p)
    .split("\n---\n")
    .filter((b) => b.includes(`**Event**: ${ev}`));
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
  // report→approve threads the RESOLVED active intent (the seeded default
  // record), so the lock keys the PER-INTENT bucket, NOT the workspace sentinel.
  // Use the lib's auditLockDir with the seeded record so the path matches what
  // the spawned tool acquires/releases (CRITICAL invariant: aidlc-state's
  // approve resolves the intent).
  return auditLockDir(p, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
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
    const r = orchestrate(["report", "--result", "bogus"], p);
    expect(r.out).toContain("Unknown --result");
    expect(r.out).toContain("bogus");
    expect(r.out).toContain("awaiting-approval");
    expect(r.out).toContain("rejected");
    expect(r.out).toContain("revised");
    expect(r.out).toContain("skipped");
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
// ROUTED SKIP — report owns the justified [S] transition and the route after
// it. Skip is deliberately resolved before artifact/per-unit/ensemble guards:
// it is not a completion claim and never emits STAGE_COMPLETED.
// ============================================================

describe("t115 routed skip (report -> aidlc-state skip --route)", () => {
  test("skip requires an explicit live stage pin and a nonblank reason", () => {
    for (const args of [
      ["report", "--result", "skipped", "--reason", "not applicable"],
      ["report", "--stage", "", "--result", "skipped", "--reason", "not applicable"],
      ["report", "--stage", "feasibility", "--result", "skipped"],
      ["report", "--stage", "feasibility", "--result", "skipped", "--reason", "   "],
      ["report", "--stage", "market-research", "--result", "skipped", "--reason", "stale body"],
    ]) {
      const p = projWithState("state-mid-ideation.md");
      const before = readFileSync(statePath(p), "utf-8");
      const r = orchestrate(args, p);
      expect(r.out, args.join(" ")).toContain('"kind":"error"');
      expect(readFileSync(statePath(p), "utf-8"), args.join(" ")).toBe(before);
      expect(countEvent(p, "STAGE_SKIPPED"), args.join(" ")).toBe(0);
    }
  }, 30000);

  test("ALWAYS stages cannot bypass completion by reporting skipped", () => {
    const p = projWithState("state-mid-ideation.md");
    replaceStateText(
      p,
      "- [-] feasibility — EXECUTE",
      "- [x] feasibility — EXECUTE",
    );
    replaceStateText(
      p,
      "- [ ] scope-definition — EXECUTE",
      "- [-] scope-definition — EXECUTE",
    );
    replaceStateText(
      p,
      "- **Current Stage**: feasibility",
      "- **Current Stage**: scope-definition",
    );
    replaceStateText(
      p,
      "- **In Progress**: feasibility",
      "- **In Progress**: scope-definition",
    );
    const before = readFileSync(statePath(p), "utf-8");

    const r = orchestrate([
      "report",
      "--stage",
      "scope-definition",
      "--result",
      "skipped",
      "--reason",
      "attempted bypass",
    ], p);

    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("only a CONDITIONAL stage can report skipped");
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
    expect(countEvent(p, "STAGE_SKIPPED")).toBe(0);
  }, 30000);

  test("active stage skip preserves [S], starts next once, and never completes the stage", () => {
    const p = projWithState("state-mid-ideation.md");
    const report = orchestrate([
      "report",
      "--stage",
      "feasibility",
      "--result",
      "skipped",
      "--reason",
      "No feasibility decision is needed",
    ], p);

    expect(report.status).toBe(0);
    expect(report.out).toContain('"kind":"done"');
    expect(report.out).toContain("Committed skip");
    const content = readFileSync(statePath(p), "utf-8");
    expect(content).toContain("- [S] feasibility — EXECUTE");
    expect(content).toContain("- [-] scope-definition — EXECUTE");
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe("scope-definition");
    expect(state(["get", "Completed"], p).stdout.trim()).toBe("5");
    expect(auditEvents(p)).toContain("STAGE_SKIPPED STAGE_STARTED");
    expect(countEvent(p, "STAGE_SKIPPED")).toBe(1);
    expect(countEvent(p, "STAGE_STARTED")).toBe(1);
    expect(countEvent(p, "STAGE_COMPLETED")).toBe(0);
    expect(auditBlocksFor(p, "STAGE_SKIPPED")[0]).toContain(
      "**Reason**: No feasibility decision is needed",
    );
  }, 30000);

  test("revising stage can be skipped through the same routed outcome", () => {
    const p = projWithState("state-mid-ideation.md");
    expect(orchestrate([
      "report", "--stage", "feasibility", "--result", "awaiting-approval",
    ], p).status).toBe(0);
    expect(orchestrate([
      "report",
      "--stage",
      "feasibility",
      "--result",
      "rejected",
      "--user-input",
      "Drop this analysis",
    ], p).status).toBe(0);

    const skipped = orchestrate([
      "report",
      "--stage",
      "feasibility",
      "--result",
      "skipped",
      "--reason",
      "User removed this stage during revision",
    ], p);
    expect(skipped.out).toContain('"kind":"done"');
    expect(readFileSync(statePath(p), "utf-8")).toContain(
      "- [S] feasibility — EXECUTE",
    );
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe(
      "scope-definition",
    );
    expect(countEvent(p, "STAGE_SKIPPED")).toBe(1);
    expect(countEvent(p, "STAGE_COMPLETED")).toBe(0);
  }, 30000);

  test("final-stage skip completes the workflow without STAGE_COMPLETED", () => {
    const p = projWithState("state-final-stage.md");
    const report = orchestrate([
      "report",
      "--stage",
      "feedback-optimization",
      "--result",
      "skipped",
      "--reason",
      "No feedback window exists for this one-off run",
    ], p);

    expect(report.out).toContain('"kind":"done"');
    expect(readFileSync(statePath(p), "utf-8")).toContain(
      "- [S] feedback-optimization — EXECUTE",
    );
    expect(state(["get", "Status"], p).stdout.trim()).toBe("Completed");
    expect(countEvent(p, "STAGE_SKIPPED")).toBe(1);
    expect(countEvent(p, "STAGE_COMPLETED")).toBe(0);
    expect(countEvent(p, "PHASE_COMPLETED")).toBe(1);
    expect(countEvent(p, "PHASE_VERIFIED")).toBe(1);
    expect(countEvent(p, "WORKFLOW_COMPLETED")).toBe(1);
    expect(auditEvents(p)).toContain(
      "STAGE_SKIPPED PHASE_COMPLETED PHASE_VERIFIED WORKFLOW_COMPLETED",
    );
  }, 30000);

  test("an interrupted [S] with an unmoved cursor routes without duplicating STAGE_SKIPPED", () => {
    const p = projWithState("state-mid-ideation.md");
    expect(state([
      "skip", "feasibility", "--reason", "recorded before interrupted routing",
    ], p).status).toBe(0);
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe("feasibility");
    expect(countEvent(p, "STAGE_SKIPPED")).toBe(1);

    const recovered = orchestrate([
      "report",
      "--stage",
      "feasibility",
      "--result",
      "skipped",
      "--reason",
      "recorded before interrupted routing",
    ], p);
    expect(recovered.status).toBe(0);
    expect(recovered.out).toContain("Committed skip");
    expect(readFileSync(statePath(p), "utf-8")).toContain(
      "- [S] feasibility — EXECUTE",
    );
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe(
      "scope-definition",
    );
    expect(countEvent(p, "STAGE_SKIPPED")).toBe(1);
    expect(countEvent(p, "STAGE_STARTED")).toBe(1);
    expect(countEvent(p, "STAGE_COMPLETED")).toBe(0);
  }, 30000);

  test("a backward jump starts a new skip attempt with fresh audit rows", () => {
    const p = projWithState("state-mid-ideation.md");
    const args = [
      "report",
      "--stage",
      "feasibility",
      "--result",
      "skipped",
      "--reason",
      "Not applicable in this attempt",
    ];
    expect(orchestrate(args, p).status).toBe(0);

    replaceStateText(
      p,
      "- [S] feasibility — EXECUTE",
      "- [-] feasibility — EXECUTE",
    );
    replaceStateText(
      p,
      "- [-] scope-definition — EXECUTE",
      "- [ ] scope-definition — EXECUTE",
    );
    replaceStateText(
      p,
      "- **Current Stage**: scope-definition",
      "- **Current Stage**: feasibility",
    );
    replaceStateText(
      p,
      "- **In Progress**: scope-definition",
      "- **In Progress**: feasibility",
    );
    const started = spawnSync(
      BUN,
      [
        AUDIT_TOOL,
        "append",
        "STAGE_STARTED",
        "--field",
        "Stage=feasibility",
        "--field",
        "Agent=aidlc-architect-agent",
        "--project-dir",
        p,
      ],
      { encoding: "utf-8" },
    );
    expect(started.status, `${started.stdout}${started.stderr}`).toBe(0);

    expect(orchestrate(args, p).status).toBe(0);
    expect(countEvent(p, "STAGE_SKIPPED")).toBe(2);
    expect(countEvent(p, "STAGE_STARTED")).toBe(3);
    expect(
      auditBlocksFor(p, "STAGE_STARTED").filter((block) =>
        block.includes("**Stage**: scope-definition")
      ),
    ).toHaveLength(2);
  }, 30000);
});

describe("t115 initialization stages reject gate lifecycle outcomes", () => {
  for (const outcome of [
    "awaiting-approval",
    "rejected",
    "revised",
  ] as const) {
    test(`state-init cannot report ${outcome}`, () => {
      const p = projWithState("state-init-active.md");
      if (outcome === "revised") {
        replaceStateText(
          p,
          "- [-] state-init — EXECUTE",
          "- [R] state-init — EXECUTE",
        );
      }
      const before = readFileSync(statePath(p), "utf-8");
      const r = orchestrate([
        "report",
        "--stage",
        "state-init",
        "--result",
        outcome,
      ], p);

      expect(r.out).toContain('"kind":"error"');
      expect(r.out).toContain("ungated initialization stage");
      expect(readFileSync(statePath(p), "utf-8")).toBe(before);
    }, 30000);
  }
});

// ============================================================
// GATED APPROVE round-trip (.sh Tests 4-9) — feasibility, mid-ideation.
// report --result approved dispatches `aidlc-state.ts approve`, which OWNS the
// full transition (GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED), no separate
// advance. Explicit `--stage` also lets report recover a missing gate before
// that approve. This is the core unit credited: subcommand:aidlc-state:approve.
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

  test("5b: explicit-stage report opens a missing gate before approving", () => {
    const p = projWithState("state-mid-ideation.md");

    const report = orchestrate(
      ["report", "--stage", "feasibility", "--result", "approved", "--user-input", "Approve"],
      p,
    );

    expect(report.status).toBe(0);
    expect(report.out).toContain('"kind":"done"');
    expect(report.out).toContain("Committed gate-start + approve");
    expect(auditEvents(p)).toContain(
      "STAGE_AWAITING_APPROVAL GATE_APPROVED STAGE_COMPLETED STAGE_STARTED",
    );
    expect(countEvent(p, "STAGE_STARTED")).toBe(1);
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe("scope-definition");
  }, 30000);

  test("5c: completed active-stage recovery advances and emits the missing completion event", () => {
    const p = projWithState("state-mid-ideation.md");
    replaceStateText(p, "- [-] feasibility — EXECUTE", "- [x] feasibility — EXECUTE");

    const report = orchestrate(["report", "--result", "approved"], p);

    expect(report.status).toBe(0);
    expect(report.out).toContain('"kind":"done"');
    expect(report.out).toContain("Committed advance");
    expect(auditEvents(p)).toContain("STAGE_COMPLETED STAGE_STARTED");
    expect(countEvent(p, "STAGE_COMPLETED")).toBe(1);
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe("scope-definition");
  }, 30000);

  test("5d: explicit-stage report is idempotent when Current Stage has already advanced", () => {
    const p = projWithState("state-mid-ideation.md");

    expect(state(["gate-start", "feasibility"], p).status).toBe(0);
    expect(state(["approve", "feasibility", "--user-input", "Approve"], p).status).toBe(0);
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe("scope-definition");
    const before = totalEvents(p);

    const report = orchestrate(["report", "--stage", "feasibility", "--result", "approved"], p);

    expect(report.status).toBe(0);
    expect(report.out).toContain('"kind":"done"');
    expect(totalEvents(p)).toBe(before);
    expect(countEvent(p, "GATE_APPROVED")).toBe(1);
    expect(countEvent(p, "STAGE_STARTED")).toBe(1);
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe("scope-definition");
  }, 30000);

  test("5e: report owns the full awaiting -> rejected -> revised -> approved lifecycle", () => {
    const p = projWithState("state-mid-ideation.md");

    const awaiting = orchestrate(
      ["report", "--stage", "feasibility", "--result", "awaiting-approval"],
      p,
    );
    expect(awaiting.status).toBe(0);
    expect(awaiting.out).toContain("Recorded awaiting-approval");
    expect(readFileSync(statePath(p), "utf-8")).toContain(
      "- [?] feasibility — EXECUTE",
    );

    const rejected = orchestrate(
      [
        "report",
        "--stage",
        "feasibility",
        "--result",
        "rejected",
        "--user-input",
        "Clarify the cost assumptions",
      ],
      p,
    );
    expect(rejected.status).toBe(0);
    expect(rejected.out).toContain("Recorded rejected");
    expect(readFileSync(statePath(p), "utf-8")).toContain(
      "- [R] feasibility — EXECUTE",
    );

    const revised = orchestrate(
      ["report", "--stage", "feasibility", "--result", "revised"],
      p,
    );
    expect(revised.status).toBe(0);
    expect(revised.out).toContain("Recorded revised");
    expect(readFileSync(statePath(p), "utf-8")).toContain(
      "- [?] feasibility — EXECUTE",
    );

    const approved = orchestrate(
      [
        "report",
        "--stage",
        "feasibility",
        "--result",
        "approved",
        "--user-input",
        "Approve",
      ],
      p,
    );
    expect(approved.status).toBe(0);
    expect(approved.out).toContain('"kind":"done"');
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe(
      "scope-definition",
    );
    expect(auditEvents(p)).toContain(
      "STAGE_AWAITING_APPROVAL GATE_REJECTED STAGE_REVISING " +
        "STAGE_AWAITING_APPROVAL GATE_APPROVED STAGE_COMPLETED STAGE_STARTED",
    );
    expect(countEvent(p, "STAGE_AWAITING_APPROVAL")).toBe(2);
    expect(countEvent(p, "GATE_REJECTED")).toBe(1);
    expect(countEvent(p, "GATE_APPROVED")).toBe(1);
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

describe("t115 re-report on a completed workflow", () => {
  test("22: re-report on a completed workflow is an idempotent done, not another transition", () => {
    const p = projWithState("state-final-stage.md");

    const gs = state(["gate-start", "feedback-optimization"], p);
    expect(gs.status).toBe(0);

    // First report completes the workflow.
    const first = orchestrate(["report", "--result", "approved"], p);
    expect(first.out).toContain('"kind":"done"');
    const before = totalEvents(p);

    // Second report: the workflow is already complete, so the engine returns a
    // clean idempotent done without spawning another state transition.
    const second = orchestrate(["report", "--result", "approved"], p);
    expect(second.out).toContain('"kind":"done"');
    expect(second.out).toContain("already completed");
    expect(totalEvents(p)).toBe(before);
  }, 30000);
});

// ============================================================
// STALE RE-REPORT GUARD — a re-report of an already-[x] stage after the
// workflow has moved on (Current Stage at a DIFFERENT non-pending slug) is a
// replay, not a recovery. The engine must answer with an idempotent done and
// spawn NOTHING: dispatching advance here demoted a gate-held `[?]`/`[R]`
// current stage back to `[-]` and re-emitted STAGE_STARTED. The legitimate
// recovery (approve landed but advance crashed: slug === Current Stage, next
// still pending) must still advance.
// ============================================================

describe("t115 stale re-report guard (report on a completed stage after the workflow moved on)", () => {
  /** Walk mid-ideation to: feasibility [x], scope-definition the gate-held
   *  Current Stage at [?]. Returns the project dir. */
  function projAtHeldGate(): string {
    const p = projWithState("state-mid-ideation.md");
    expect(state(["gate-start", "feasibility"], p).status).toBe(0);
    expect(state(["approve", "feasibility"], p).status).toBe(0); // auto-advances; scope-definition [-]
    expect(state(["gate-start", "scope-definition"], p).status).toBe(0); // scope-definition [?]
    return p;
  }

  test("stale re-report with next gate-held [?] is an idempotent done: no demotion, zero new rows", () => {
    const p = projAtHeldGate();
    expect(readFileSync(statePath(p), "utf-8")).toContain("[?] scope-definition");
    const before = totalEvents(p);

    // The stale replay: re-report the already-[x] feasibility.
    const replay = orchestrate(["report", "--stage", "feasibility", "--result", "approved"], p);

    expect(replay.status).toBe(0);
    expect(replay.out).toContain('"kind":"done"');
    expect(replay.out).toContain("already completed");
    expect(replay.out).toContain("idempotent re-report");
    // The held gate survives — no [?] -> [-] demotion.
    expect(readFileSync(statePath(p), "utf-8")).toContain("[?] scope-definition");
    // ZERO new audit rows — in particular no second STAGE_STARTED.
    expect(totalEvents(p)).toBe(before);
    expect(countEvent(p, "STAGE_STARTED")).toBe(1);
  }, 30000);

  test("stale re-report with next revising [R] is an idempotent done: [R] preserved, zero new rows", () => {
    const p = projAtHeldGate();
    expect(state(["reject", "scope-definition", "--feedback", "x"], p).status).toBe(0); // [?] -> [R]
    expect(readFileSync(statePath(p), "utf-8")).toContain("[R] scope-definition");
    const before = totalEvents(p);

    const replay = orchestrate(["report", "--stage", "feasibility", "--result", "approved"], p);

    expect(replay.status).toBe(0);
    expect(replay.out).toContain('"kind":"done"');
    expect(replay.out).toContain("idempotent re-report");
    expect(readFileSync(statePath(p), "utf-8")).toContain("[R] scope-definition");
    expect(totalEvents(p)).toBe(before);
  }, 30000);

  test("engine-level: direct advance replay with next gate-held [?] short-circuits, zero new rows", () => {
    const p = projAtHeldGate();
    const before = totalEvents(p);

    // Bypass report — drive the committing subcommand directly, as a crashed
    // conductor retrying its own recovery would.
    const replay = state(["advance", "feasibility"], p);

    expect(replay.status).toBe(0);
    expect(replay.out).toContain('"replay":true');
    expect(readFileSync(statePath(p), "utf-8")).toContain("[?] scope-definition");
    expect(totalEvents(p)).toBe(before);
  }, 30000);

  test("regression: legit recovery (slug [x] === Current Stage, next pending) still advances", () => {
    const p = projWithState("state-mid-ideation.md");
    // Simulate "approve landed but advance crashed": feasibility [x], Current
    // Stage still feasibility, scope-definition untouched at [ ].
    replaceStateText(p, "- [-] feasibility — EXECUTE", "- [x] feasibility — EXECUTE");

    const report = orchestrate(["report", "--stage", "feasibility", "--result", "approved"], p);

    expect(report.status).toBe(0);
    expect(report.out).toContain('"kind":"done"');
    expect(report.out).toContain("Committed advance");
    expect(state(["get", "Current Stage"], p).stdout.trim()).toBe("scope-definition");
    expect(readFileSync(statePath(p), "utf-8")).toContain("[-] scope-definition");
  }, 30000);
});

// ============================================================
// RECOVERED TAGGING — the report-path gate backfill (gate-start --recovered)
// must tag ONLY the backfilled STAGE_AWAITING_APPROVAL row with
// `**Recovered**: true`; an organic gate-start row carries no such field.
// ============================================================

describe("t115 report-path gate backfill carries Recovered", () => {
  test("explicit-stage report on [-] backfills the gate row tagged Recovered: true", () => {
    const p = projWithState("state-mid-ideation.md");

    // NO gate-start — report opens the missing gate itself.
    const report = orchestrate(
      ["report", "--stage", "feasibility", "--result", "approved", "--user-input", "Approve"],
      p,
    );
    expect(report.status).toBe(0);
    expect(report.out).toContain("Committed gate-start + approve");

    const gateRows = auditBlocksFor(p, "STAGE_AWAITING_APPROVAL");
    expect(gateRows.length).toBe(1);
    expect(gateRows[0]).toContain("**Recovered**: true");
  }, 30000);

  test("organic gate-start emits no Recovered field", () => {
    const p = projWithState("state-mid-ideation.md");
    expect(state(["gate-start", "feasibility"], p).status).toBe(0);

    const gateRows = auditBlocksFor(p, "STAGE_AWAITING_APPROVAL");
    expect(gateRows.length).toBe(1);
    expect(gateRows[0]).not.toContain("**Recovered**");
  }, 30000);
});

// ============================================================
// Reviewer precondition (RFC Track 1 / §12a). A stage that declares a
// `reviewer` cannot be approved until a terminal REVIEW_COMPLETED row for it
// exists in the audit tail. requirements-analysis declares
// reviewer: aidlc-product-lead-agent, so it is the test subject. The gate is
// HARD on the review having happened, SOFT on the verdict (NOT-READY still
// satisfies it). feasibility (no reviewer) is the negative control — its
// approve is unaffected (proven by the existing gated-approve round-trip above).
// ============================================================

const LOG_TOOL = join(TOOLS_DIR, "aidlc-log.ts");

function log(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [LOG_TOOL, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

function appendAudit(event: string, fields: Record<string, string>, p: string): CliResult {
  const fieldArgs = Object.entries(fields).flatMap(([key, value]) => [
    "--field",
    `${key}=${value}`,
  ]);
  const res = spawnSync(
    BUN,
    [AUDIT_TOOL, "append", event, ...fieldArgs, "--project-dir", p],
    { encoding: "utf-8" },
  );
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

describe("t115 reviewer precondition (report refuses approve without a recorded review)", () => {
  test("R1: approving a reviewer-bearing stage is REFUSED without a REVIEW_COMPLETED", () => {
    const p = projWithState("state-mid-inception.md");
    // Open the gate so approve's state precondition passes; the reviewer
    // precondition is the thing under test.
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);

    const r = orchestrate(
      ["report", "--stage", "requirements-analysis", "--result", "approved", "--user-input", "Approve"],
      p,
    );
    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("declares a reviewer");
    // The transition was NOT committed — no GATE_APPROVED emitted.
    expect(countEvent(p, "GATE_APPROVED")).toBe(0);
  }, 30000);

  test("R2: a recorded READY review unblocks the approve", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);

    const rev = log(
      ["review", "--stage", "requirements-analysis", "--reviewer", "aidlc-product-lead-agent", "--iteration", "1", "--verdict", "READY"],
      p,
    );
    expect(rev.stdout).toContain('"emitted":"REVIEW_COMPLETED"');

    const r = orchestrate(
      ["report", "--stage", "requirements-analysis", "--result", "approved", "--user-input", "Approve"],
      p,
    );
    expect(r.out).toContain('"kind":"done"');
    expect(countEvent(p, "GATE_APPROVED")).toBe(1);
  }, 30000);

  test("R3: a NOT-READY verdict still satisfies the precondition (soft on verdict)", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);

    log(
      ["review", "--stage", "requirements-analysis", "--reviewer", "aidlc-product-lead-agent", "--iteration", "2", "--verdict", "NOT-READY"],
      p,
    );

    const r = orchestrate(
      ["report", "--stage", "requirements-analysis", "--result", "approved", "--user-input", "Approve despite findings"],
      p,
    );
    expect(r.out).toContain('"kind":"done"');
    expect(countEvent(p, "GATE_APPROVED")).toBe(1);
  }, 30000);

  test("R4: a review recorded for a DIFFERENT stage does not unblock this one", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);

    // Review recorded for the wrong slug — must not satisfy requirements-analysis.
    log(
      ["review", "--stage", "user-stories", "--reviewer", "aidlc-product-lead-agent", "--iteration", "1", "--verdict", "READY"],
      p,
    );

    const r = orchestrate(
      ["report", "--stage", "requirements-analysis", "--result", "approved", "--user-input", "Approve"],
      p,
    );
    expect(r.out).toContain('"kind":"error"');
    expect(countEvent(p, "GATE_APPROVED")).toBe(0);
  }, 30000);

  test("R5: REVIEW_REQUESTED alone (no verdict) does NOT satisfy the precondition", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);

    // Dispatch row only — no terminal verdict yet.
    const req = log(
      ["review", "--stage", "requirements-analysis", "--reviewer", "aidlc-product-lead-agent", "--iteration", "1"],
      p,
    );
    expect(req.stdout).toContain('"emitted":"REVIEW_REQUESTED"');

    const r = orchestrate(
      ["report", "--stage", "requirements-analysis", "--result", "approved", "--user-input", "Approve"],
      p,
    );
    expect(r.out).toContain('"kind":"error"');
    expect(countEvent(p, "REVIEW_REQUESTED")).toBe(1);
    expect(countEvent(p, "REVIEW_COMPLETED")).toBe(0);
    expect(countEvent(p, "GATE_APPROVED")).toBe(0);
  }, 30000);

  // R6 (blocker 1): the guard lives in handleApprove, so a DIRECT
  // `aidlc-state.ts approve` — the recovery path that bypasses report — is
  // refused too. This is the bypass the reviewer reproduced (report errored but
  // state approve committed with GATE_APPROVED=1, REVIEW_COMPLETED=0).
  test("R6: a DIRECT aidlc-state.ts approve is also refused without a review (not just report)", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);

    const r = state(["approve", "requirements-analysis", "--user-input", "Approve"], p);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("declares a reviewer");
    expect(countEvent(p, "GATE_APPROVED")).toBe(0);
  }, 30000);

  // R7 (blocker 2): a review recorded, then the stage is rejected/revised, then
  // re-approved with NO new review — the stale review must NOT satisfy the
  // re-approve. The GATE_REJECTED floors the read past the old review.
  test("R7: a review before a GATE_REJECTED does not satisfy the re-approve", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);
    log(
      ["review", "--stage", "requirements-analysis", "--reviewer", "aidlc-product-lead-agent", "--iteration", "1", "--verdict", "READY"],
      p,
    );
    // The human requests changes: reject records GATE_REJECTED and sets the
    // stage revising ([R]). `revise` re-enters the gate ([R] → [?]).
    expect(state(["reject", "requirements-analysis", "--feedback", "revise it"], p).status).toBe(0);
    expect(state(["revise", "requirements-analysis"], p).status).toBe(0);

    // Re-approve with no fresh review → refused (the pre-reject review is stale).
    const r = state(["approve", "requirements-analysis", "--user-input", "Approve"], p);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("declares a reviewer");
    expect(countEvent(p, "GATE_APPROVED")).toBe(0);

    // A fresh review after the reject unblocks it.
    log(
      ["review", "--stage", "requirements-analysis", "--reviewer", "aidlc-product-lead-agent", "--iteration", "2", "--verdict", "READY"],
      p,
    );
    const r2 = state(["approve", "requirements-analysis", "--user-input", "Approve"], p);
    expect(r2.status).toBe(0);
    expect(countEvent(p, "GATE_APPROVED")).toBe(1);
  }, 30000);

  // R8 (finding S1): a review row naming the WRONG reviewer (a typo, or the
  // conductor self-certifying) must not satisfy the precondition — the guard
  // matches Reviewer as well as Stage.
  test("R8: a review recorded with the wrong reviewer name does not satisfy", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);
    log(
      ["review", "--stage", "requirements-analysis", "--reviewer", "not-the-real-reviewer", "--iteration", "1", "--verdict", "READY"],
      p,
    );
    const r = state(["approve", "requirements-analysis", "--user-input", "Approve"], p);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("declares a reviewer");
    expect(countEvent(p, "GATE_APPROVED")).toBe(0);
  }, 30000);

  test("R9: advance, finalize, and complete-workflow enforce the same reviewer receipt", () => {
    for (const command of ["advance", "finalize", "complete-workflow"]) {
      const refusedProject = projWithState("state-mid-inception.md");
      const before = readFileSync(statePath(refusedProject), "utf-8");
      const refused = state([command, "requirements-analysis"], refusedProject);
      expect(refused.status, command).not.toBe(0);
      expect(refused.out, command).toContain("declares a reviewer");
      expect(readFileSync(statePath(refusedProject), "utf-8"), command).toBe(before);

      const acceptedProject = projWithState("state-mid-inception.md");
      expect(log([
        "review",
        "--stage",
        "requirements-analysis",
        "--reviewer",
        "aidlc-product-lead-agent",
        "--iteration",
        "1",
        "--verdict",
        "READY",
      ], acceptedProject).status, command).toBe(0);
      expect(
        state([command, "requirements-analysis"], acceptedProject).status,
        command,
      ).toBe(0);
    }
  }, 30000);

  test("R10: a persisted autonomous Construction setting does not bypass an Inception reviewer", () => {
    const p = projWithState("state-mid-inception.md");
    writeFileSync(
      statePath(p),
      `${readFileSync(statePath(p), "utf-8")}\n- **Construction Autonomy Mode**: autonomous\n`,
      "utf-8",
    );
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);

    const r = state(["approve", "requirements-analysis"], p);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("declares a reviewer");
    expect(countEvent(p, "GATE_APPROVED")).toBe(0);
  }, 30000);

  test("R11: an isolated --single review receipt cannot satisfy the main workflow", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);
    expect(log([
      "review",
      "--single",
      "--stage",
      "requirements-analysis",
      "--reviewer",
      "aidlc-product-lead-agent",
      "--iteration",
      "1",
      "--verdict",
      "READY",
    ], p).status).toBe(0);

    expect(
      auditBlocksFor(p, "REVIEW_COMPLETED")[0],
    ).toContain("**Workflow**: single-stage:requirements-analysis");
    const r = state(["approve", "requirements-analysis", "--user-input", "Approve"], p);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("declares a reviewer");
    expect(countEvent(p, "GATE_APPROVED")).toBe(0);
  }, 30000);

  test("R12: a declared artifact create or update after review requires a fresh review", () => {
    for (const event of ["ARTIFACT_CREATED", "ARTIFACT_UPDATED"]) {
      const p = projWithState("state-mid-inception.md");
      expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);
      expect(log([
        "review",
        "--stage",
        "requirements-analysis",
        "--reviewer",
        "aidlc-product-lead-agent",
        "--verdict",
        "READY",
      ], p).status).toBe(0);
      expect(appendAudit(event, {
        Tool: event === "ARTIFACT_CREATED" ? "Write" : "Edit",
        File: join(
          seededRecordDir(p),
          "inception",
          "requirements-analysis",
          "requirements.md",
        ),
        Context: "inception > requirements-analysis > requirements.md",
      }, p).status).toBe(0);

      const refused = state(["approve", "requirements-analysis"], p);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("fresh REVIEW_COMPLETED");
      expect(countEvent(p, "GATE_APPROVED")).toBe(0);

      expect(log([
        "review",
        "--stage",
        "requirements-analysis",
        "--reviewer",
        "aidlc-product-lead-agent",
        "--verdict",
        "READY",
      ], p).status).toBe(0);
      expect(state(["approve", "requirements-analysis"], p).status).toBe(0);
    }
  }, 30000);

  test("R13: an unrelated artifact update does not invalidate the review", () => {
    const p = projWithState("state-mid-inception.md");
    expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);
    expect(log([
      "review",
      "--stage",
      "requirements-analysis",
      "--reviewer",
      "aidlc-product-lead-agent",
      "--verdict",
      "READY",
    ], p).status).toBe(0);
    expect(appendAudit("ARTIFACT_UPDATED", {
      Tool: "Edit",
      File: join(seededRecordDir(p), "inception", "user-stories", "stories.md"),
      Context: "inception > user-stories > stories.md",
    }, p).status).toBe(0);

    expect(state(["approve", "requirements-analysis"], p).status).toBe(0);
    expect(countEvent(p, "GATE_APPROVED")).toBe(1);
  }, 30000);

  test("R14: malformed REVIEW_COMPLETED verdicts do not satisfy the precondition", () => {
    for (const verdict of [undefined, "MAYBE"]) {
      const p = projWithState("state-mid-inception.md");
      expect(state(["gate-start", "requirements-analysis"], p).status).toBe(0);
      const fields: Record<string, string> = {
        Stage: "requirements-analysis",
        Reviewer: "aidlc-product-lead-agent",
      };
      if (verdict !== undefined) fields.Verdict = verdict;
      expect(appendAudit("REVIEW_COMPLETED", fields, p).status).toBe(0);

      const refused = state(["approve", "requirements-analysis"], p);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("fresh REVIEW_COMPLETED");
      expect(countEvent(p, "GATE_APPROVED")).toBe(0);
    }
  }, 30000);
});
