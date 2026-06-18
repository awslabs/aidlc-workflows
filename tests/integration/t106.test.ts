// covers: subcommand:aidlc-runtime:summary
//
// CLI-contract port of tests/integration/t106-runtime-summary.sh (TAP plan 13),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-runtime.ts summary [...]` (and the `compile`
// fixture-build it depends on) is preserved by SPAWNING the real CLI via
// node:child_process spawnSync (the BUN running this test + the tool .ts
// path), asserting on res.status / res.stdout / res.stderr and the
// runtime-graph.json that `compile` writes — the PROCESS boundary, not an
// in-process summarize() call. An in-process twin would lose the
// missing-graph exit-1 shell (handleSummary's process.exit(1) at
// aidlc-runtime.ts:1233) that the .sh's Case-C `$?` arm relies on.
//
// summary reads ONLY the materialised runtime-graph.json — it never re-walks
// audit — so each case must `compile` a synthetic audit first to produce the
// graph summary will read. That mirrors the .sh exactly (run_compile then
// run_summary per case).
//
// SUBCOMMAND UNIT: this file credits `subcommand:aidlc-runtime:summary` —
// the summary subcommand is the sole surface under test (compile is invoked
// only as a fixture-builder, already covered by t90.cli.test.ts).
//
// PARITY NOTES (every .sh assert/ok line maps to an expect() below; several
// are STRONGER than the original `jq -r` projection — noted Sx):
//   Case A (mix: 2 approved + 1 pending across ideation):
//     - .sh `.stages.total` == 3            -> Test A1: summary.stages.total === 3
//     - .sh `.stages.approved` == 2         -> Test A2: ...approved === 2
//     - .sh `.stages.pending` == 1          -> Test A3: ...pending === 1
//     - .sh `.stages.failed` == 0           -> Test A4: ...failed === 0
//     - .sh `.by_phase.ideation.total` == 3 -> Test A5: by_phase.ideation.total === 3
//         (S1 STRONGER: also asserts approved/pending split on the phase rollup)
//     - .sh `.memory.total` == 3            -> Test A6: memory.total === 3
//     - .sh `.memory.interpretations` == 2  -> Test A7: memory.interpretations === 2
//     - .sh `.memory.tradeoffs` == 1        -> Test A8: memory.tradeoffs === 1
//     - .sh `.duration_minutes` == 40       -> Test A9: duration_minutes === 40
//     - .sh determinism: JSON == JSON2 (ok) -> Test A10: byte-identical stdout
//         across two summary calls (same observable as the .sh string compare)
//     - .sh human render contains "Session Summary" (ok) -> Test A11: exit 0 +
//         stdout contains "Session Summary" (S2 STRONGER: also pins clean exit)
//   Case B (pending-only -> duration null):
//     - .sh `.duration_minutes` == "null"   -> Test B1: duration_minutes === null
//         (S3 STRONGER: also pins .stages.pending === 1 / approved === 0 so the
//         null is for the right reason, not an empty graph)
//   Case C (missing runtime-graph.json -> exit 1):
//     - .sh `$? == 1`                       -> Test C1: res.status === 1 + the
//         "no runtime-graph.json found" stderr diagnostic (S4 STRONGER: the .sh
//         discarded stderr with 2>&1 >/dev/null; we assert the message too).
//
// 13 .sh assert/ok lines -> 13 expect()-bearing test() cases (Case A's 11,
// Case B's 1, Case C's 1), with three STRONGER additions folded in.
//
// FIXTURE DISCIPLINE (mirrors the .sh's make_project + mktemp -d + rm -rf):
//   - Each case uses a FRESH temp project dir (mkdtempSync) wrapped in
//     toPortablePath — `compile` WRITES runtime-graph.json + MEMORY_EMPTY
//     audit rows under CLAUDE_PROJECT_DIR, and `summary` reads that graph
//     back via forward-slash path helpers, so on native Windows the project
//     dir must be cygpath-rewritten or the read-back finds the wrong path
//     (mirrors createTestProject / t90's makeProject).
//   - NOTHING is written under tests/fixtures/**; audit + state + memory.md
//     are built inline (the .sh's L1 rationale: too combinatorial for an
//     on-disk fixtures dir). All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";
import { auditFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// P9: with no intent cursor seeded, compile/summary resolve the BARE space
// record root (docsRoot -> spaceRecordRoot) at aidlc/spaces/default/intents/.
// State, runtime-graph, per-stage memory, and the per-clone audit SHARD all
// live under it (the flat aidlc-docs/ root is retired — there is no fallback).
const RECORD_REL = join("aidlc", "spaces", "default", "intents");
function recordRoot(proj: string): string {
  return join(proj, RECORD_REL);
}

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const RUNTIME_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-runtime.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface SpawnResult {
  rc: number;
  stdout: string;
  stderr: string;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** run_compile (t106:42-45): CLAUDE_PROJECT_DIR=<proj> bun RUNTIME_TS compile [args]. */
function runCompile(proj: string, ...args: string[]): SpawnResult {
  const res = spawnSync(BUN, [RUNTIME_TS, "compile", ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { rc: res.status ?? -1, stdout, stderr, out: `${stdout}${stderr}` };
}

/** run_summary (t106:47-50): CLAUDE_PROJECT_DIR=<proj> bun RUNTIME_TS summary [args]. */
function runSummary(proj: string, ...args: string[]): SpawnResult {
  const res = spawnSync(BUN, [RUNTIME_TS, "summary", ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { rc: res.status ?? -1, stdout, stderr, out: `${stdout}${stderr}` };
}

/**
 * make_project (t106:31-40): fresh temp project with the given audit.md +
 * aidlc-state.md under aidlc-docs/. toPortablePath: compile/summary resolve
 * audit/graph paths through forward-slash helpers, so on Windows the raw
 * mktemp path can't round-trip — mirrors createTestProject (fixtures.ts).
 */
function makeProject(audit: string, state: string): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t106-")));
  tempDirs.push(proj);
  mkdirSync(recordRoot(proj), { recursive: true });
  // Seed the DETERMINISTIC audit shard the compile tool resolves (auditFilePath).
  const shard = auditFilePath(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, audit, "utf-8");
  writeFileSync(join(recordRoot(proj), "aidlc-state.md"), state, "utf-8");
  return proj;
}

/** Bare temp project with the record shell but no state/audit/graph (Case C). */
function makeBareProject(): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t106-")));
  tempDirs.push(proj);
  mkdirSync(recordRoot(proj), { recursive: true });
  return proj;
}

/** Per-stage memory.md under the bare space record root <phase>/<slug>/. */
function writeMemory(
  proj: string,
  phase: string,
  slug: string,
  body: string,
): void {
  const dir = join(recordRoot(proj), phase, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.md"), body, "utf-8");
}

// STATE_FEATURE (t106:52-56).
const STATE_FEATURE = [
  "- **Scope**: feature",
  "- **Current Stage**: scope-definition",
].join("\n");

// AUDIT_MIX (t106:59-107): two approved (intent-capture 10:00->10:10,
// feasibility 10:11->10:40) + one pending (scope-definition started 10:41,
// never completed). All three slugs are phase=ideation per stage-graph.json
// (lines 103-302). Duration spans first start (10:00) to latest completed
// (10:40) = 40 min.
const AUDIT_MIX = `## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:10:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture
**Details**: done

---

## Stage Start
**Timestamp**: 2026-05-27T10:11:00Z
**Event**: STAGE_STARTED
**Stage**: feasibility
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:40:00Z
**Event**: STAGE_COMPLETED
**Stage**: feasibility
**Details**: done

---

## Stage Start
**Timestamp**: 2026-05-27T10:41:00Z
**Event**: STAGE_STARTED
**Stage**: scope-definition
**Agent**: aidlc-product-agent

---
`;

// Memory body for intent-capture (t106:110-115): 2 interpretations + 1
// tradeoff = 3 total entries (canonical §13 headings, parseMemoryHeadings).
const MEMORY_INTENT = `## Interpretations
- one
- two
## Tradeoffs
- a tradeoff
`;

// AUDIT_PENDING (t106:149-164): a single STAGE_STARTED, no COMPLETED.
const AUDIT_PENDING = `## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---
`;

const AUDIT_STALE_COMPLETED = `## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:10:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture
**Details**: done

---

## Stage Start
**Timestamp**: 2026-05-27T10:11:00Z
**Event**: STAGE_STARTED
**Stage**: feasibility
**Agent**: aidlc-product-agent

---
`;

const STATE_COMPLETED_OVERLAY = [
  "- **Scope**: feature",
  "- **Status**: Completed",
  "",
  "## Stage Progress",
  "- [x] intent-capture — EXECUTE",
  "- [x] feasibility — EXECUTE",
  "- [x] scope-definition — EXECUTE",
].join("\n");

// Synthetic single-stage pair for an UNRELATED slug, field shapes copied
// exactly from handleSingleReport (aidlc-orchestrate.ts): STAGE_STARTED has
// Stage + Agent + Workflow; STAGE_COMPLETED has Stage + Details + Workflow.
// `single-stage:<slug>` marks the pair as belonging to NO main workflow —
// compile must not pair it, so summary must not count it.
const SINGLE_STAGE_PAIR = `## Stage Start
**Timestamp**: 2026-05-27T10:42:00Z
**Event**: STAGE_STARTED
**Stage**: application-design
**Agent**: aidlc-architect-agent
**Workflow**: single-stage:application-design

---

## Stage Completion
**Timestamp**: 2026-05-27T10:45:00Z
**Event**: STAGE_COMPLETED
**Stage**: application-design
**Details**: Single-stage run of application-design completed
**Workflow**: single-stage:application-design

---
`;

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary summary shape
type Summary = any;

/** Compile then parse the summary --json stdout. Asserts both exits clean. */
function compileAndSummarize(proj: string): { summary: Summary; raw: string } {
  const c = runCompile(proj);
  expect(c.rc).toBe(0); // fixture build must succeed before summary
  const s = runSummary(proj, "--json");
  expect(s.rc).toBe(0);
  return { summary: JSON.parse(s.stdout), raw: s.stdout };
}

describe("t106 aidlc-runtime summary — CLI contract (migrated from t106-runtime-summary.sh, plan 13)", () => {
  // --- Case A: two approved + one pending across ideation ------------------
  describe("Case A: 2 approved + 1 pending across ideation", () => {
    function caseAProject(): string {
      const proj = makeProject(AUDIT_MIX, STATE_FEATURE);
      writeMemory(proj, "ideation", "intent-capture", MEMORY_INTENT);
      return proj;
    }

    test("A1: three stages total", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.stages.total).toBe(3);
    });

    test("A2: two approved", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.stages.approved).toBe(2);
    });

    test("A3: one pending", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.stages.pending).toBe(1);
    });

    test("A4: zero failed", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.stages.failed).toBe(0);
    });

    test("A5: ideation phase rollup totals 3 (+ approved/pending split, S1)", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.by_phase.ideation.total).toBe(3);
      // S1 STRONGER: the .sh only checked the phase total; assert the split too.
      expect(summary.by_phase.ideation.approved).toBe(2);
      expect(summary.by_phase.ideation.pending).toBe(1);
      expect(summary.by_phase.ideation.failed).toBe(0);
    });

    test("A6: memory total = 3 (2 interp + 1 tradeoff)", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.memory.total).toBe(3);
    });

    test("A7: 2 interpretations", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.memory.interpretations).toBe(2);
    });

    test("A8: 1 tradeoff", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.memory.tradeoffs).toBe(1);
    });

    test("A9: duration 40 min (start to latest completed)", () => {
      const { summary } = compileAndSummarize(caseAProject());
      expect(summary.duration_minutes).toBe(40);
    });

    test("A10: summary --json is deterministic across calls", () => {
      const proj = caseAProject();
      runCompile(proj);
      const j1 = runSummary(proj, "--json");
      const j2 = runSummary(proj, "--json");
      expect(j1.rc).toBe(0);
      expect(j2.rc).toBe(0);
      // Same observable as the .sh's `[ "$JSON" = "$JSON2" ]` string compare.
      expect(j2.stdout).toBe(j1.stdout);
    });

    test("A11: human-readable output renders header (+ clean exit, S2)", () => {
      const proj = caseAProject();
      runCompile(proj);
      const h = runSummary(proj); // no --json -> renderSummary path
      // S2 STRONGER: the .sh only grepped; pin clean exit too.
      expect(h.rc).toBe(0);
      expect(h.stdout).toContain("Session Summary");
    });
  });

  // --- Case B: pending-only workflow -> duration null ----------------------
  test("B1: pending-only -> duration_minutes null (+ pending=1/approved=0, S3)", () => {
    const proj = makeProject(AUDIT_PENDING, STATE_FEATURE);
    const { summary } = compileAndSummarize(proj);
    expect(summary.duration_minutes).toBeNull();
    // S3 STRONGER: confirm the null is because the one stage is pending, not
    // because the graph is empty (no completed_at anywhere).
    expect(summary.stages.total).toBe(1);
    expect(summary.stages.pending).toBe(1);
    expect(summary.stages.approved).toBe(0);
  });

  // --- Case C: missing runtime-graph.json -> exit 1 ------------------------
  test("C1: missing runtime-graph.json -> exit 1 (+ diagnostic, S4)", () => {
    const proj = makeBareProject(); // no compile -> no runtime-graph.json
    const r = runSummary(proj, "--json");
    expect(r.rc).toBe(1);
    // S4 STRONGER: the .sh discarded stderr (2>&1 >/dev/null); assert the
    // diagnostic the tool emits (aidlc-runtime.ts:1230-1232).
    expect(r.stderr).toContain("no runtime-graph.json found");
  });

  // --- Case D: completed state reconciles stale runtime rows ---------------
  test("D1: completed state overrides stale pending graph rows and adds missing completed stages", () => {
    const proj = makeProject(AUDIT_STALE_COMPLETED, STATE_COMPLETED_OVERLAY);
    const { summary } = compileAndSummarize(proj);
    expect(summary.stages.total).toBe(3);
    expect(summary.stages.approved).toBe(3);
    expect(summary.stages.pending).toBe(0);
    expect(summary.by_phase.ideation.total).toBe(3);
    expect(summary.by_phase.ideation.approved).toBe(3);
    expect(summary.by_phase.ideation.pending).toBe(0);
  });

  // --- Case E: --single synthetic pair does not inflate summary counts -----
  // The synthetic `Workflow: single-stage:<slug>` pair must be excluded at
  // compile-time pairing, so summary (which reads only the compiled graph)
  // sees the same Case-A numbers with or without the pair appended. Without
  // the exclusion, the inception phase appears in by_phase and stages.total/
  // approved each over-count by one.
  test("E1: synthetic single-stage pair appended to Case A leaves all counts unchanged", () => {
    const proj = makeProject(AUDIT_MIX + SINGLE_STAGE_PAIR, STATE_FEATURE);
    writeMemory(proj, "ideation", "intent-capture", MEMORY_INTENT);
    const { summary } = compileAndSummarize(proj);
    expect(summary.stages.total).toBe(3);
    expect(summary.stages.approved).toBe(2);
    expect(summary.stages.pending).toBe(1);
    expect(summary.by_phase.ideation.total).toBe(3);
    // application-design is inception — its phase must not appear at all.
    expect(summary.by_phase.inception).toBeUndefined();
    // Duration still spans first start -> latest MAIN completed (10:40), not
    // the synthetic pair's 10:45.
    expect(summary.duration_minutes).toBe(40);
  });
});
