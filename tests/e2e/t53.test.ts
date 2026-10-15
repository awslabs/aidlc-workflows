// covers: audit:STAGE_STARTED, scope:bugfix
//
// t53.test.ts — SDK-harness port of tests/e2e/t53-workflow-scope-routing.sh
// (plan 11). Drives the real `/aidlc bugfix` (TRAP 2: the run
// stops at the FIRST orchestrator directive, BEFORE any gate, so headless
// auto-approve was never load-bearing; both the live prompt and the
// deterministic seed are plain, human-driven)
// through the Claude Agent SDK until the deterministic orchestrator directive
// is observed, then asserts ONLY on deterministic surfaces (tool_result JSON,
// on-disk state fields, the state file's Scope-Configuration / Stage-Progress
// blocks, and the parsed + raw audit) — NEVER on assistantText.
//
// WHY THIS PORT EXISTS. The .sh asserted entirely by grepping the post-run
// aidlc-state.md on disk (plus a find over aidlc-docs/ideation/). Those greps
// are NOT prose-flaky — they read the FILE the deterministic init tool wrote,
// not the LLM's rendering. But the .sh reached that file through a `claude -p`
// subprocess + run_claude's exit-124 heuristic; this port reaches the SAME file
// through driveAidlc, so the assertions become structured reads (readStateFile /
// auditEvents) instead of shell greps. And it goes STRONGER: the .sh never
// looked at the audit at all, so the test's own thesis — "SKIP-for-scope stages
// emit zero STAGE_STARTED" — was unproven. This port asserts that invariant
// directly on the audit's STAGE_STARTED blocks (every STAGE_STARTED names only
// an EXECUTE stage; no SKIP slug ever appears in a STAGE_STARTED block).
//
// THE JOURNEY. `bugfix` is a Minimal scope whose scope-mapping marks the entire
// Ideation phase SKIP and nine stages EXECUTE: workspace-scaffold,
// workspace-detection, state-init (the 3 init stages), reverse-engineering,
// requirements-analysis (Inception), code-generation, build-and-test
// (Construction), deployment-pipeline, and deployment-execution (Operation).
// On a fresh greenfield project (--no-aidlc-docs ->
// noAidlcDocs:true) reverse-engineering is auto-downgraded to SKIP
// (aidlc-utility.ts), leaving requirements-analysis as the first
// post-init stage. The deterministic seed runs
// `aidlc-utility.ts init --scope bugfix` directly, which writes
// the full aidlc-state.md and the audit's WORKFLOW_STARTED / PHASE_STARTED /
// PHASE_SKIPPED / STAGE_STARTED+COMPLETED×3 / WORKSPACE_* events plus the
// init->Inception phase hand-off (a 4th STAGE_STARTED naming requirements-
// analysis). Crucially the init tool emits a STAGE_STARTED block for EXECUTE
// stages ONLY (aidlc-utility.ts) - the SKIP stages
// (every Ideation stage, five Operation stages, etc.) get a
// `[ ] <slug> — SKIP` row in Stage Progress and a `## Scope Configuration`
// Skip-list entry, but NO audit STAGE_STARTED. The SDK portion proves the live
// slash route asks the orchestrator for bugfix's next directive and receives
// requirements-analysis;
// full golden-path auto-advance/co-fire coverage lives in t126/t138, where that
// broader workflow behavior is the actual invariant.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface):
//   1  assert_file_exists STATE             -> readStateFile(proj) !== undefined
//                                              (init writes aidlc-state.md, utility.ts)
//   2  no ideation artifacts (empty/absent) -> no files under aidlc-docs/ideation/ on disk
//                                              (init scaffolds empty stage dirs only, utility.ts;
//                                               every Ideation stage is SKIP so no stage writes there)
//   3  0× `[x] <ideation-stage>`            -> STRONGER: each of the 7 Ideation stage rows in Stage
//                                              Progress is `[ ] <slug> — SKIP` (never [x]); asserted
//                                              per-stage on the state file (utility.ts)
//   4  grep STATE reverse-engineering|requirements-analysis (Inception present)
//                                           -> state file contains "requirements-analysis" (the first
//                                              post-init EXECUTE stage, Stage Progress row, utility.ts)
//   5  grep STATE code-generation|build-and-test (Construction present)
//                                           -> state file contains "code-generation — EXECUTE" AND
//                                              "build-and-test — EXECUTE" (the 2 Construction EXECUTE rows)
//   6  Operation routing                    -> STRONGER: deployment-pipeline and
//                                              deployment-execution are EXECUTE;
//                                              the other 5 rows are SKIP (never [x])
//   7-9 `[x] <init-stage>` × 3              -> the 3 init rows are `[x] <slug> — EXECUTE`; asserted
//                                              per-stage (utility.ts marker=[x] for init phase)
//   11 grep STATE [Bb]ugfix                 -> readStateField(state,"Scope") === "bugfix"
//                                              (## Project Information Scope line, utility.ts)
//   12 COMPLETED < 12 (`^- [x]` lines)      -> STRONGER: bugfix marks the 3 init stages [x] at init;
//                                              the count of `[x]` Stage-Progress rows is bounded < 12
//                                              the way the .sh did, AND the SKIP invariant below pins WHY.
//
//   NEW (audit, the test's own unproven thesis — .sh asserted NOTHING here):
//     SKIP stages emit zero STAGE_STARTED -> every STAGE_STARTED block in audit.md
//       names an EXECUTE stage; NO SKIP-stage slug ever appears as a STAGE_STARTED
//       `**Stage**:` field (every utility.ts call site that emits STAGE_STARTED
//       starts an EXECUTE stage). assertAuditEvent(r,"STAGE_STARTED") first proves the event class fired.
//
// Known-answer literals (read from the SHIPPED handler / scope-mapping, not guessed):
//   - bugfix scope mapping (Ideation all SKIP, EXECUTE = init×3 + reverse-engineering +
//     requirements-analysis + code-generation + build-and-test +
//     deployment-pipeline + deployment-execution): scope-mapping.json "bugfix"
//   - greenfield downgrades reverse-engineering EXECUTE->SKIP: aidlc-utility.ts
//   - Stage Progress row shape `- [x|-| ] <slug>`, an em dash, then EXECUTE|SKIP, as the
//     state file writes it and stageRow's regex reads it: aidlc-utility.ts
//   - Scope line "- **Scope**: bugfix": aidlc-utility.ts
//   - STAGE_STARTED emitted for EXECUTE stages only: aidlc-utility.ts
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc bugfix on
// Opus/Bedrock until the deterministic run-stage directive. Generous per-test
// timeout so a hung SDK stream fails LOUD.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertAuditEvent } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readAuditText } from "../harness/sdk-drive.ts";

// AIDLC_TEST_TIMEOUT bounds the entire case, including setup and cleanup.
const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
// Preserve the existing work allowance and reserve fixture/startup/cleanup separately.
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


// Known-answer stage slugs from the SHIPPED scope-grid.json "bugfix" entry.
// The Ideation phase is ENTIRELY SKIP for bugfix; the 3 init stages EXECUTE;
// Deployment Pipeline and Deployment Execution execute in Operation while the
// other five Operation stages skip. (scope-grid.json "bugfix".stages)
const IDEATION_STAGES = [
  "intent-capture",
  "market-research",
  "feasibility",
  "scope-definition",
  "team-formation",
  "rough-mockups",
  "approval-handoff",
];
const OPERATION_EXECUTE_STAGES = [
  "deployment-pipeline",
  "deployment-execution",
];
const OPERATION_SKIP_STAGES = [
  "environment-provisioning",
  "observability-setup",
  "incident-response",
  "performance-validation",
  "feedback-optimization",
];
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

/** Seed the bugfix state through the same per-project utility the slash command
 * ultimately delegates to. This test's invariant is SDK routing over an already
 * valid bugfix workflow; fresh no-state slash-command recovery is covered
 * elsewhere and can otherwise pollute audit.md before the bugfix run begins. */
function seedBugfixState(proj: string): void {
  const utility = join(proj, ".claude", "tools", "aidlc-utility.ts");
  // The seed is a plain, deterministic intent-create. The live journey stops
  // at the first run-stage directive, before any gate, so it needs no mode.
  const res = spawnSync(
    process.execPath,
    [utility, "intent-create", "--scope", "bugfix", "--project-dir", proj],
    { timeout: remainingWorkMs(), cwd: proj, encoding: "utf8" },
  );
  expect(res.status).toBe(0);
  expect(`${res.stdout}\n${res.stderr}`).toContain("State initialized");
}

/** Read the Stage-Progress row for a given stage slug from the post-run state
 *  file. Rows have the shape `- [<marker>] <slug> — <EXECUTE|SKIP>`
 *  (aidlc-utility.ts handleIntentCreateStateBuild). Returns the marker char
 *  (e.g. "x", " ", "-") and the EXECUTE/SKIP suffix, or undefined if the slug
 *  has no row. */
function stageRow(
  stateText: string,
  slug: string,
): { marker: string; action: string } | undefined {
  // Match the slug as a whole token so `code-generation` doesn't match inside
  // another row; the em-dash separator is the literal the tool writes.
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^- \\[([^\\]])\\] ${esc} — (EXECUTE|SKIP)$`, "m");
  const m = stateText.match(re);
  return m ? { marker: m[1], action: m[2] } : undefined;
}

/** Count `- [x]` Stage-Progress rows in the post-run state file. */
function completedRowCount(stateText: string): number {
  return (stateText.match(/^- \[x\] /gm) ?? []).length;
}

/** Files (not dirs) under <proj>/aidlc-docs/ideation/, recursively. This helper
 *  checks the legacy flat path; the created intent's stage directories are under
 *  its per-intent record. */
function ideationFiles(proj: string): string[] {
  const dir = join(proj, "aidlc-docs", "ideation");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Extract the `**Stage**:` slug from every STAGE_STARTED block in the raw
 *  audit shards. Each audit block is "## <Heading>\n**Timestamp**: ...\n
 *  **Event**: <TYPE>\n**Stage**: <slug>\n..." (aidlc-audit format; see
 *  aidlc-utility.ts handleIntentCreateStateBuild). We pair each STAGE_STARTED
 *  Event line with the Stage line in the SAME block so a non-STAGE_STARTED Stage
 *  field can't leak in. Returns the slugs in file order. */
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

describe("t53 /aidlc bugfix scope routing (sdk)", () => {
  test(
    "bugfix skips Ideation and most Operation stages, marks init [x], records bugfix scope; STAGE_STARTED names EXECUTE stages only",
    async () => {
      // noAidlcDocs: fresh greenfield project; intent-create creates the per-intent
      // record from scratch and downgrades reverse-engineering to SKIP (greenfield).
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        seedBugfixState(proj);

        const r = await driveAidlc("/aidlc bugfix", {
          projectDir: proj,
          timeoutMs: remainingWorkMs(),
          stopAfterToolResult: {
            toolName: "Bash",
            // The run-stage directive, not the load-steering part that
            // precedes it (that result also names the stage and would stop
            // the drive one beat early).
            resultIncludes: '"kind":"run-stage","stage":"requirements-analysis"',
          },
        });

        const directive = r.toolResults.find(
          (tr) =>
            tr.toolName === "Bash" &&
            tr.resultText.includes('"kind":"run-stage"') &&
            tr.resultText.includes('"stage":"requirements-analysis"') &&
            tr.resultText.includes('"phase":"inception"'),
        );
        expect(directive).toBeDefined();

        // driveAidlc reads it off disk into r.stateFile after the run.
        expect(r.stateFile).toBeDefined();
        const state = r.stateFile as string;

        // The ## Project Information Scope line (aidlc-utility.ts
        // handleIntentCreateStateBuild).
        const scope = state.match(/^- \*\*Scope\*\*: (\S+)$/m)?.[1];
        expect(scope).toBe("bugfix");

        for (const slug of IDEATION_STAGES) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("SKIP");
          expect(row!.marker).not.toBe("x");
        }

        for (const slug of OPERATION_EXECUTE_STAGES) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("EXECUTE");
        }
        for (const slug of OPERATION_SKIP_STAGES) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("SKIP");
          expect(row!.marker).not.toBe("x");
        }

        for (const slug of INIT_STAGES) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("EXECUTE");
          expect(row!.marker).toBe("x");
        }

        // requirements-analysis is the first post-init EXECUTE stage for bugfix
        // (reverse-engineering downgraded to SKIP on greenfield); its EXECUTE
        // row must be present.
        const reqRow = stageRow(state, "requirements-analysis");
        expect(reqRow).toBeDefined();
        expect(reqRow!.action).toBe("EXECUTE");

        for (const slug of ["code-generation", "build-and-test"]) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("EXECUTE");
        }

        // Every Ideation stage is SKIP, so no stage should write an artifact under
        // aidlc-docs/ideation/; this assertion checks only that legacy path.
        expect(ideationFiles(proj)).toEqual([]);

        // The count of `- [x]` Stage-Progress rows. bugfix marks the 3 init stages [x]
        // at init; the run stops at the first run-stage directive (before any gate), so
        // nothing beyond init can complete.
        expect(completedRowCount(state)).toBeLessThan(12);

        // ---- Audit: SKIP stages emit zero STAGE_STARTED ----
        // First prove the STAGE_STARTED class fired at all (no vacuous pass).
        assertAuditEvent(r, "STAGE_STARTED");
        // Then: no SKIP-for-scope slug from the checked Ideation or Operation sets
        // appears as a STAGE_STARTED `**Stage**:` field.
        const started = new Set(stageStartedStages(proj));
        expect(started.size).toBeGreaterThan(0);
        for (const slug of [...IDEATION_STAGES, ...OPERATION_SKIP_STAGES]) {
          expect(started.has(slug)).toBe(false);
        }
        // The init stages DID start (positive control — the surface is real).
        for (const slug of INIT_STAGES) {
          expect(started.has(slug)).toBe(true);
        }
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
