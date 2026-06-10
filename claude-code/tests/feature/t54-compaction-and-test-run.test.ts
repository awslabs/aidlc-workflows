// covers: subcommand:aidlc-jump:execute, audit:WORKFLOW_COMPLETED
//
// CLI-contract port of tests/feature/t54-compaction-and-test-run.sh (TAP plan 4),
// mechanism = cli. The subject is the `--test-run` TERMINAL STATE of
// `aidlc-jump.ts execute`: a forward jump to a named target, in a project whose
// state declares `Test Run Mode: true`, ends the workflow — it emits a
// WORKFLOW_COMPLETED audit event carrying `Reason=test-run-stopped-at-<target>`
// and sets `Status=Completed`.
//
// HISTORY (verbatim intent from the .sh header, t54:2-16): the former tests 1-4
// (the compaction-awareness flow in SKILL.md) were RETIRED at the engine
// cutover — that resume/compaction dispatch prose was deleted from SKILL.md and
// the engine's resume `ask` directive (t118 corpus) replaced it. What remains
// in t54 is the test-run terminal state on aidlc-jump.ts, UNAFFECTED by the
// cutover. This twin ports exactly that residue.
//
// Source under test (dist/claude/.claude/tools/aidlc-jump.ts):
//   :229 testRunMode = (getField(content,"Test Run Mode")||"").toLowerCase()==="true"
//          — the `--test-run` recognition seam (state-persisted flag).
//   :310 willTerminate = testRunMode && direction === "forward"
//          — the terminal-state guard: ONLY a forward jump under test-run ends.
//   :316 Status set to "Completed" when willTerminate (else "Running").
//   :321 "In Progress" set to "none" when willTerminate.
//   :326 "Next Action" set to `Test-run stopped at <target>` when willTerminate.
//   :391-398 the terminal branch emits a WORKFLOW_COMPLETED audit entry with
//          Reason: `test-run-stopped-at-<targetSlug>` INSTEAD of STAGE_STARTED.
//   WORKFLOW_COMPLETED is a VALID_EVENT_TYPE (aidlc-audit.ts:34) mapped to the
//   "Workflow Completion" heading (:129); appendAuditEntry writes
//   "**Event**: WORKFLOW_COMPLETED" + a "**Reason**: ..." field line to
//   <proj>/aidlc-docs/audit.md.
//
// Why SPAWN (not in-process): the contract the .sh pins is the PROCESS-boundary
// effect — running the real `bun aidlc-jump.ts execute --test-run` against a
// seeded fixture and reading the bytes the tool wrote to audit.md (and the
// state file). handleExecute is not exported, terminates the CLI via
// process effects (console.log + writeStateFile, and process.exit on the error
// path), and the WORKFLOW_COMPLETED row is only observable on the audit.md the
// subprocess appends. An in-process twin would lose that subprocess + file
// side-effect seam. spawnCount = all.
//
// Old TAP -> new test parity (every .sh `ok` -> an expect()-bearing test;
// tests 1-2 are STRONGER — the .sh grepped the SOURCE for the flag/Reason
// substrings; this twin proves the RUNTIME behaviour those substrings exist to
// implement):
//   .sh test 1 (grep source for testRunMode|test-run flag recognition)
//        -> test "execute recognises --test-run (reports test_run_mode:true)":
//           STRONGER — the spawned tool reads the persisted Test Run Mode flag
//           and echoes test_run_mode:true on stdout, proving recognition end-to-end.
//   .sh test 2 (grep source for 'test-run-stopped-at')
//        -> test "terminal Reason renders test-run-stopped-at-<target>":
//           STRONGER — asserts the literal Reason VALUE on the audit row, not the
//           source substring.
//   .sh test 3 (runtime: --test-run jump emits WORKFLOW_COMPLETED in audit.md)
//        -> test "--test-run forward jump emits WORKFLOW_COMPLETED in audit.md".
//   .sh test 4 (runtime: Reason=test-run-stopped-at-feasibility)
//        -> test "WORKFLOW_COMPLETED Reason=test-run-stopped-at-feasibility on the same audit block".
//
// STRENGTHENING (beyond the .sh, to pin the guard the terminal state hinges on —
// §6-E: the terminal event must fire for the right reason, and NOT otherwise):
//   - "sets Status=Completed / In Progress=none / Next Action on terminal jump"
//     — the willTerminate state-field contract (jump.ts:316-326), co-located.
//   - "WORKFLOW_COMPLETED is co-located with the test-run Reason on one block"
//     — the heading + event + Reason render together, not merely present somewhere.
//   - GUARD-NEGATIVE: "no Test Run Mode flag -> no WORKFLOW_COMPLETED, Status=Running"
//     — proves the terminal state is gated on Test Run Mode, not on forward jumps.
//   - GUARD-NEGATIVE: "backward jump under test-run -> no WORKFLOW_COMPLETED"
//     — proves willTerminate requires direction==="forward" (jump.ts:310), so a
//     non-forward jump even in test-run mode keeps the workflow Running.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const SEED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-mid-ideation.md");

resetAidlcEnv();

const tempProjects: string[] = [];

afterAll(() => {
  for (const p of tempProjects) cleanupTestProject(p);
});

interface RunResult {
  status: number;
  stdout: string;
  audit: string; // bytes of <proj>/aidlc-docs/audit.md after the run
  state: string; // bytes of <proj>/aidlc-docs/aidlc-state.md after the run
}

/**
 * Mirror the .sh harness for tests 3-4: a fresh project seeded with
 * audit-sample.md + state-mid-ideation.md, the `Test Run Mode: true` field
 * injected (the .sh's `printf '\n- **Test Run Mode**: true\n'` — same field the
 * real `aidlc-utility init --test-run` / `--test-strategy --test-run` persists),
 * then `bun aidlc-jump.ts execute --target <t> --direction <d> --test-run
 * --project-dir <proj>` SPAWNED. Returns the tool's stdout plus the resulting
 * audit.md / state bytes.
 *
 * `withTestRunFlag=false` omits the injected flag (the guard-negative case);
 * `extraArgs` lets a case drop `--test-run` or change direction.
 */
function runJump(opts: {
  target: string;
  direction: "forward" | "backward" | "redo";
  withTestRunFlag?: boolean;
  passTestRunArg?: boolean;
}): RunResult {
  const { target, direction } = opts;
  const withTestRunFlag = opts.withTestRunFlag ?? true;
  const passTestRunArg = opts.passTestRunArg ?? true;

  const proj = createTestProject();
  tempProjects.push(proj);
  seedAuditFile(proj);
  seedStateFile(proj, STATE_FIXTURE);
  if (withTestRunFlag) {
    // jump's terminal behaviour triggers when state declares Test Run Mode:
    // true. Inject the field so the fixture is in the right mode without
    // running full init (byte-for-byte the .sh's printf append).
    appendFileSync(
      join(proj, "aidlc-docs", "aidlc-state.md"),
      "\n- **Test Run Mode**: true\n",
    );
  }

  const args = [
    JUMP,
    "execute",
    "--target",
    target,
    "--direction",
    direction,
    "--project-dir",
    proj,
  ];
  if (passTestRunArg) args.push("--test-run");

  const res = spawnSync(BUN, args, {
    encoding: "utf-8",
    env: { ...process.env, AIDLC_STAGE_GRAPH: SEED_GRAPH },
  });

  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    audit: readFileSync(join(proj, "aidlc-docs", "audit.md"), "utf-8"),
    state: readFileSync(join(proj, "aidlc-docs", "aidlc-state.md"), "utf-8"),
  };
}

/** Audit blocks split on the "\n---\n" separator appendAuditEntry writes. */
function auditBlocks(audit: string): string[] {
  return audit.split(/\n---\n/);
}

describe("t54 aidlc-jump execute --test-run terminal state (migrated from t54-compaction-and-test-run.sh, plan 4)", () => {
  // ---------------------------------------------------------------------------
  // Test 1 [.sh test 1] — STRONGER: prove --test-run recognition end-to-end.
  // The .sh grepped the source for `testRunMode|test-run`. The behaviour that
  // substring implements: the tool reads the persisted Test Run Mode flag and
  // echoes test_run_mode:true on its stdout JSON (aidlc-jump.ts:229,417).
  // ---------------------------------------------------------------------------
  test("execute recognises --test-run (reports test_run_mode:true on stdout)", () => {
    const r = runJump({ target: "feasibility", direction: "forward" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.test_run_mode).toBe(true);
    expect(out.workflow_stopped).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 2 [.sh test 2] — STRONGER: prove the Reason VALUE renders, not the
  // source substring. The .sh grepped the source for the literal
  // 'test-run-stopped-at'; this asserts the rendered audit Reason line carries
  // the target-bearing value (aidlc-jump.ts:396).
  // ---------------------------------------------------------------------------
  test("terminal Reason renders test-run-stopped-at-<target> in audit.md", () => {
    const r = runJump({ target: "scope-definition", direction: "forward" });
    expect(r.audit).toContain("**Reason**: test-run-stopped-at-scope-definition");
  });

  // ---------------------------------------------------------------------------
  // Test 3 [.sh test 3] — runtime: --test-run forward jump emits the
  // WORKFLOW_COMPLETED terminal event into audit.md (the .sh's
  // `grep '^\*\*Event\*\*: WORKFLOW_COMPLETED'`).
  // ---------------------------------------------------------------------------
  test("--test-run forward jump emits WORKFLOW_COMPLETED in audit.md", () => {
    const r = runJump({ target: "feasibility", direction: "forward" });
    expect(r.status).toBe(0);
    // Line-anchored, exactly as the .sh grepped (^**Event**: WORKFLOW_COMPLETED).
    const hasEvent = r.audit
      .split("\n")
      .some((l) => l === "**Event**: WORKFLOW_COMPLETED");
    expect(hasEvent).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 4 [.sh test 4] — runtime: the Reason field value is exactly
  // test-run-stopped-at-feasibility (the .sh's
  // `grep '\*\*Reason\*\*: test-run-stopped-at-feasibility'`). STRONGER: assert
  // the WORKFLOW_COMPLETED event and its Reason live on the SAME audit block,
  // proving the Reason belongs to the terminal event (not some other row).
  // ---------------------------------------------------------------------------
  test("WORKFLOW_COMPLETED Reason=test-run-stopped-at-feasibility on the same audit block", () => {
    const r = runJump({ target: "feasibility", direction: "forward" });
    const block = auditBlocks(r.audit).find((b) =>
      b.includes("**Event**: WORKFLOW_COMPLETED"),
    );
    expect(block).toBeDefined();
    expect(block as string).toContain(
      "**Reason**: test-run-stopped-at-feasibility",
    );
    // The WORKFLOW_COMPLETED block also renders under the "Workflow Completion"
    // heading (aidlc-audit.ts:129) — pin it so the event type and heading agree.
    expect(block as string).toContain("## Workflow Completion");
  });

  // ---------------------------------------------------------------------------
  // STRENGTHENING — terminal state-field contract (jump.ts:316-326), co-located.
  // Beyond the .sh, but the same willTerminate branch the WORKFLOW_COMPLETED
  // emission rides on.
  // ---------------------------------------------------------------------------
  test("terminal jump sets Status=Completed / In Progress=none / Next Action", () => {
    const r = runJump({ target: "feasibility", direction: "forward" });
    expect(r.state).toContain("- **Status**: Completed");
    expect(r.state).toContain("- **In Progress**: none");
    expect(r.state).toContain("- **Next Action**: Test-run stopped at feasibility");
    // And the stdout side of the same contract.
    const out = JSON.parse(r.stdout.trim());
    expect(out.workflow_stopped).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // GUARD-NEGATIVE (§6-E): the terminal event is GATED on Test Run Mode. With
  // the flag absent (no `Test Run Mode: true` in state), a forward jump must
  // NOT emit WORKFLOW_COMPLETED and must leave Status=Running. Proves the
  // terminal state isn't fired by `--test-run` argv alone — it requires the
  // persisted flag (aidlc-jump.ts:229 reads state, not argv).
  // ---------------------------------------------------------------------------
  test("no persisted Test Run Mode -> no WORKFLOW_COMPLETED, Status stays Running", () => {
    const r = runJump({
      target: "scope-definition",
      direction: "forward",
      withTestRunFlag: false,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.test_run_mode).toBe(false);
    expect(out.workflow_stopped).toBe(false);
    expect(r.audit.includes("**Event**: WORKFLOW_COMPLETED")).toBe(false);
    expect(r.state).toContain("- **Status**: Running");
  });

  // ---------------------------------------------------------------------------
  // GUARD-NEGATIVE (§6-E): willTerminate also requires direction==="forward"
  // (jump.ts:310). A BACKWARD jump under test-run mode must NOT terminate —
  // no WORKFLOW_COMPLETED, Status stays Running. Proves the AND in the guard.
  // ---------------------------------------------------------------------------
  test("backward jump under test-run mode does NOT emit WORKFLOW_COMPLETED", () => {
    // feasibility (current) -> intent-capture (earlier) is a backward jump.
    const r = runJump({ target: "intent-capture", direction: "backward" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.test_run_mode).toBe(true); // flag IS set...
    expect(out.workflow_stopped).toBe(false); // ...but direction guards termination
    expect(r.audit.includes("**Event**: WORKFLOW_COMPLETED")).toBe(false);
    expect(r.state).toContain("- **Status**: Running");
  });
});
