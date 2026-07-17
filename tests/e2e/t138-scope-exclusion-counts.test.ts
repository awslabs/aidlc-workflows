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
// scope: `security-patch` (Minimal; its SKIP set differs from bugfix — e.g.
// the deployment stages are EXECUTE for security-patch but SKIP for bugfix), so it
// exercises a distinct exclusion shape rather than re-proving bugfix's.
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

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertAuditEvent,
  assertResultOk,
  assertToolResultContains,
} from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { auditFilePathFor, driveAidlc } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

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
  const p = auditFilePathFor(proj);
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf8");
  const blocks = text.split(/\n---\n/);
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
      const { skip, execute } = deriveStageSets(SCOPE);
      // VACUOUS-PASS GUARD (pre-run): the derived SKIP set must be non-empty, or
      // the disjointness check is meaningless. security-patch is Minimal — it
      // SKIPs most stages — so this is a tripwire against a mapping/parse change.
      expect(skip.length).toBeGreaterThan(0);

      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        // `/aidlc <scope>` on a no-state project is a pinned no-state error
        // (t118), so this journey first performs the explicit human move for a
        // new scoped workflow. The invariant remains the full-workflow audit
        // check below; we just avoid measuring the model's recovery strategy.
        const init = await driveAidlc(
          `/aidlc --init --scope ${SCOPE}`,
          {
            projectDir: proj,
            timeoutMs: Math.min(120_000, DRIVE_TIMEOUT_MS),
            stopAfterToolResult: {
              toolName: "Bash",
              resultIncludes: "State initialized:",
            },
          },
        );
        assertToolResultContains(init, "Bash", "State initialized:");
        expect(init.stateFile).toContain(`- **Scope**: ${SCOPE}`);

        const r = await driveAidlc(
          `/aidlc ${SCOPE} This is a synthetic test fixture. Remediate CVE-2021-23337 ` +
            "by scaffolding the smallest sensible Node.js CLI with lodash 4.17.20, then upgrade " +
            "lodash to 4.17.21 and add a regression check. Choose recommended answers, approve " +
            "each gate, and continue through workflow completion.",
          {
            projectDir: proj,
            timeoutMs: DRIVE_TIMEOUT_MS,
          },
        );
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
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
