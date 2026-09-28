// covers: audit:STAGE_STARTED, scope:security-patch
//
// t138-scope-exclusion-counts.test.ts — METAMORPHIC INVARIANT (§5-D, Phase 4):
// scope-exclusion counts. Drive a REAL scoped workflow through the Claude Agent
// SDK (driveAidlc) and assert, as data, that a stage marked SKIP-for-this-scope
// emits ZERO STAGE_STARTED across the WHOLE workflow.
// {sdk} mechanism (the property is audit-count data, not a rendered choice).
//
// WHY THIS IS METAMORPHIC, NOT A t53 CLONE. t53 (tests/e2e/t53.test.ts)
// proves the same family for `bugfix` by HARD-CODING IDEATION_STAGES /
// OPERATION_STAGES literals. This test is the metamorphic generalisation: it
// DERIVES the SKIP set for its scope FROM scope-grid.json at test time (the
// shipped source of truth, dist/.../tools/data/scope-grid.json), so the
// invariant tracks the data — if a future scope edit moves a stage EXECUTE->SKIP,
// this test's expectation moves with it, automatically. And it runs a DIFFERENT
// scope: `security-patch` (Minimal; its SKIP set differs from bugfix because
// nfr-requirements is EXECUTE for security-patch), so it exercises a distinct
// exclusion shape rather than re-proving bugfix's.
//
// THE INVARIANT (stated as data): let SKIP(scope) = { stage : scope-grid.json
// marks it "SKIP" } (minus the greenfield reverse-engineering downgrade, which is
// a runtime EXECUTE->SKIP not authored in the mapping — see below). Then over the
// whole run, the set of stages named in any STAGE_STARTED audit block is DISJOINT
// from SKIP(scope). Equivalently: for every SKIP stage, its STAGE_STARTED count
// is exactly 0.
//
// SOURCE-PINNED FACTS (verify-never-guess):
//   - scope grid: dist/claude/.claude/tools/data/scope-grid.json (read at test
//     time; "security-patch".stages maps each of the 32 stages to EXECUTE|SKIP).
//   - STAGE_STARTED is emitted for EXECUTE stages ONLY (aidlc-utility.ts init
//     stages + aidlc-state.ts advance); a SKIP stage gets a `[ ] <slug> — SKIP`
//     state row and NO STAGE_STARTED block (audit-format.md:33; the t53 thesis,
//     here generalised across the derived SKIP set).
//   - the audit STAGE_STARTED `**Stage**:` field names the slug (audit-format.md:33).
//   - greenfield downgrades reverse-engineering EXECUTE->SKIP at runtime
//     (aidlc-utility.ts) — a stage that is EXECUTE in the mapping but SKIP at
//     runtime on greenfield. We run on a greenfield project and EXCLUDE
//     reverse-engineering from the positive "EXECUTE stages did start" control so
//     the runtime downgrade can't red the test; it's irrelevant to the SKIP
//     disjointness assertion (the mapping's SKIP set is a subset of the runtime
//     SKIP set, so disjointness from the authored SKIP set is the weaker, sound
//     claim — a downgraded stage simply doesn't appear in STAGE_STARTED either).
//
// IRON RULE: a SKIP stage that emits a STAGE_STARTED is a real scope-routing
// DEFECT (the scope did not actually exclude it), never softened. Vacuous-pass
// guards below ensure the STAGE_STARTED class fired and the SKIP set is non-empty.
//
// It SPENDS TOKENS: driveAidlc runs the real workflow on Opus/Bedrock.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertAuditEvent, assertResultOk } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  driveAidlc,
  readAuditText,
  stateFilePathFor,
} from "../harness/sdk-drive.ts";

// 2026-09-12: with the reviewer on, four live runs took 45 to 60+ minutes (two adversarial iterations at nfr-requirements in three of them). With --review none the budget below is a wedge backstop, not the expected duration.
const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(TEST_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "E2E live work",
  })!;
}


const SCOPE = "security-patch";

// Path to the SHIPPED scope grid in the distributable (the source of truth the
// orchestrator itself reads). We read the SAME file at test time so the SKIP set
// is derived, never hard-coded — the metamorphic property.
const SCOPE_GRID = join(
  import.meta.dir,
  "..",
  "..",
  "dist",
  "claude",
  ".claude",
  "tools",
  "data",
  "scope-grid.json",
);

/** Seed the scoped workflow through the project-local utility the slash command
 *  delegates to, so the live SDK run measures the workflow, not the conductor's
 *  handling of a placeholder description. On 2026-09-13, driving
 *  `/aidlc --init --scope security-patch` through the model produced a print
 *  command carrying `--arguments=--init`; the conductor twice asked for the patch
 *  target instead of running it, failing the run before the workflow began.
 *  The scope-routing invariant does not depend on the review class. Disabling
 *  the reviewer removes the largest variable cost (two adversarial iterations at
 *  nfr-requirements in three of four runs on 2026-09-12) so the journey fits its
 *  budget. */
function seedScopedState(proj: string): void {
  const utility = join(proj, ".claude", "tools", "aidlc-utility.ts");
  const res = spawnSync(
    process.execPath,
    [
      utility,
      "intent-create",
      "--scope",
      SCOPE,
      "--review",
      "none",
      "--project-dir",
      proj,
    ],
    { timeout: remainingWorkMs(), cwd: proj, encoding: "utf8" },
  );
  const output = `${res.stdout}\n${res.stderr}`;
  expect(res.status, output).toBe(0);
  expect(output).toContain("State initialized");
}

/** Derive { skip[], execute[] } for a scope straight from scope-grid.json. */
function deriveStageSets(scope: string): { skip: string[]; execute: string[] } {
  const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf8")) as Record<
    string,
    { stages: Record<string, string> }
  >;
  const entry = grid[scope];
  if (!entry) throw new Error(`scope-grid.json has no "${scope}" entry`);
  const skip: string[] = [];
  const execute: string[] = [];
  for (const [slug, action] of Object.entries(entry.stages)) {
    if (action === "SKIP") skip.push(slug);
    else if (action === "EXECUTE") execute.push(slug);
  }
  return { skip, execute };
}

/** Extract the `**Stage**:` slug from every STAGE_STARTED block in audit.md,
 *  pairing the Event line with the Stage line in the SAME block (mirrors t53's
 *  stageStartedStages). Returns slugs in file order. */
function stageStartedStages(proj: string): string[] {
  // Every shard: the audit folder can hold more than one file.
  const blocks = readAuditText(proj).split(/\n---\n/);
  const slugs: string[] = [];
  for (const block of blocks) {
    if (!/^\*\*Event\*\*:\s*STAGE_STARTED\s*$/m.test(block)) continue;
    const m = block.match(/^\*\*Stage\*\*:\s*(\S+)\s*$/m);
    if (m) slugs.push(m[1]);
  }
  return slugs;
}

describe("t138 scope-exclusion counts (metamorphic invariant, sdk)", () => {
  test(
    `every SKIP-for-${SCOPE} stage emits zero STAGE_STARTED (SKIP set derived from scope-grid.json)`,
    async () => {
      // Setup, initialization and continuation share the original case limit.
      // Keep cleanup/assertion headroom instead of granting each drive a new clock.
      const { skip, execute } = deriveStageSets(SCOPE);
      // VACUOUS-PASS GUARD (pre-run): the derived SKIP set must be non-empty, or
      // the disjointness check is meaningless. security-patch is Minimal — it
      // SKIPs most stages — so this is a tripwire against a mapping/parse change.
      expect(skip.length).toBeGreaterThan(0);

      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        // Seed the fresh scoped workflow directly: the live SDK run should
        // measure the journey, not the conductor's handling of a placeholder
        // description. The invariant remains the full-workflow audit check below.
        seedScopedState(proj);
        expect(readFileSync(stateFilePathFor(proj), "utf8")).toContain(
          `- **Scope**: ${SCOPE}`,
        );

        const r = await driveAidlc(
          `/aidlc ${SCOPE} This is a synthetic security-patch fixture. Scaffold a tiny ` +
            "dependency-free Bun CLI that prints an HTML greeting for its argument, then fix " +
            "unsafe interpolation by exporting and using escapeHtmlText. Its exact contract is " +
            "to encode & as &amp;, < as &lt;, > as &gt;, double quote as &quot;, and single " +
            "quote as &#39;, while preserving ordinary and Unicode text. Add table-driven " +
            "regression tests that call the real exported function and a CLI test proving " +
            "the greeting uses it; those tests must fail against the unescaped implementation. " +
            "Use Bun built-in APIs. Choose recommended answers, approve " +
            "each gate, and continue through workflow completion.",
          {
            projectDir: proj,
            timeoutMs: remainingWorkMs(),
            // Whole-workflow completion exercises Stop and human-choice hooks;
            // keep their session transcript available until the SDK turn ends.
            persistSession: true,
          },
        );
        expect(r.timedOut).toBe(false);
        assertResultOk(r);
        // Whole-run invariant means whole run: a parked or partially completed
        // journey cannot prove that a later SKIP stage never starts.
        assertAuditEvent(r, "WORKFLOW_COMPLETED");

        // Scope recorded correctly (the run actually ran THIS scope).
        const scope = (r.stateFile ?? "").match(/^- \*\*Scope\*\*: (\S+)$/m)?.[1];
        expect(scope).toBe(SCOPE);

        // VACUOUS-PASS GUARD (post-run): the STAGE_STARTED class fired at all.
        assertAuditEvent(r, "STAGE_STARTED");
        const started = new Set(stageStartedStages(proj));
        expect(started.size).toBeGreaterThan(0);

        // THE METAMORPHIC INVARIANT: started ∩ SKIP(scope) = ∅. Every SKIP stage
        // has a STAGE_STARTED count of exactly 0.
        const leaked = skip.filter((slug) => started.has(slug));
        expect(leaked).toEqual([]);

        // POSITIVE CONTROL: the init EXECUTE stages DID start (the surface is
        // real, not silently empty). reverse-engineering is excluded — it is
        // EXECUTE in the mapping but downgraded to SKIP at runtime on greenfield
        // (aidlc-utility.ts), so asserting it started would be wrong on this
        // greenfield project. The 3 init stages always EXECUTE for every scope.
        const initExecute = execute.filter((s) =>
          ["workspace-scaffold", "workspace-detection", "state-init"].includes(s),
        );
        expect(initExecute.length).toBe(3); // sanity: mapping marks init EXECUTE
        for (const slug of initExecute) {
          expect(started.has(slug)).toBe(true);
        }
      } finally {
        try {
          if (process.env.AIDLC_TEST_LOG_DIR) {
            for (const [path, name] of [
              [stateFilePathFor(proj), "t138-last-state.md"],
            ]) {
              if (existsSync(path)) writeFileSync(join(process.env.AIDLC_TEST_LOG_DIR, name), readFileSync(path));
            }
            writeFileSync(join(process.env.AIDLC_TEST_LOG_DIR, "t138-last-audit.md"), readAuditText(proj));
          }
        } finally {
          cleanupTestProject(proj);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
