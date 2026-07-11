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
// Ideation phase SKIP and only six stages EXECUTE: workspace-scaffold,
// workspace-detection, state-init (the 3 init stages), reverse-engineering,
// requirements-analysis (Inception), code-generation, build-and-test
// (Construction). On a fresh greenfield project (--no-aidlc-docs ->
// noAidlcDocs:true) reverse-engineering is auto-downgraded to SKIP
// (aidlc-utility.ts:1958-1968), leaving requirements-analysis as the first
// post-init stage. The deterministic seed runs
// `aidlc-utility.ts init --scope bugfix` directly, which writes
// the full aidlc-state.md and the audit's WORKFLOW_STARTED / PHASE_STARTED /
// PHASE_SKIPPED×2 / STAGE_STARTED+COMPLETED×3 / WORKSPACE_* events plus the
// init->Inception phase hand-off (a 4th STAGE_STARTED naming requirements-
// analysis). Crucially the init tool emits a STAGE_STARTED block for EXECUTE
// stages ONLY (aidlc-utility.ts:1813,1907,1928,2134) — the SKIP stages
// (every Ideation stage, all Operation stages, etc.) get a `[ ] <slug> — SKIP`
// row in Stage Progress and a `## Scope Configuration` Skip-list entry, but NO
// audit STAGE_STARTED. The SDK portion proves the live slash route asks the
// orchestrator for bugfix's next directive and receives requirements-analysis;
// full golden-path auto-advance/co-fire coverage lives in t126/t138, where that
// broader workflow behavior is the actual invariant.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface):
//   1  assert_file_exists STATE             -> readStateFile(proj) !== undefined
//                                              (init writes aidlc-state.md, utility.ts:2099)
//   2  no ideation artifacts (empty/absent) -> no files under aidlc-docs/ideation/ on disk
//                                              (init scaffolds empty stage dirs only, utility.ts:1818-1838;
//                                               every Ideation stage is SKIP so no stage writes there)
//   3  0× `[x] <ideation-stage>`            -> STRONGER: each of the 7 Ideation stage rows in Stage
//                                              Progress is `[ ] <slug> — SKIP` (never [x]); asserted
//                                              per-stage on the state file (utility.ts:1996-1998)
//   4  grep STATE reverse-engineering|requirements-analysis (Inception present)
//                                           -> state file contains "requirements-analysis" (the first
//                                              post-init EXECUTE stage, Stage Progress row, utility.ts:1998)
//   5  grep STATE code-generation|build-and-test (Construction present)
//                                           -> state file contains "code-generation — EXECUTE" AND
//                                              "build-and-test — EXECUTE" (the 2 Construction EXECUTE rows)
//   6  0× `[x] <operation-stage>`           -> STRONGER: each of the 7 Operation stage rows is
//                                              `[ ] <slug> — SKIP` (never [x]); asserted per-stage
//   7-9 `[x] <init-stage>` × 3              -> the 3 init rows are `[x] <slug> — EXECUTE`; asserted
//                                              per-stage (utility.ts:1995-1998 marker=[x] for init phase)
//   11 grep STATE [Bb]ugfix                 -> readStateField(state,"Scope") === "bugfix"
//                                              (## Project Information Scope line, utility.ts:2049)
//   12 COMPLETED < 12 (`^- [x]` lines)      -> STRONGER: bugfix marks the 3 init stages [x] at init;
//                                              the count of `[x]` Stage-Progress rows is bounded < 12
//                                              the way the .sh did, AND the SKIP invariant below pins WHY.
//
//   NEW (audit, the test's own unproven thesis — .sh asserted NOTHING here):
//     SKIP stages emit zero STAGE_STARTED -> every STAGE_STARTED block in audit.md
//       names an EXECUTE stage; NO SKIP-stage slug ever appears as a STAGE_STARTED
//       `**Stage**:` field (utility.ts emits STAGE_STARTED only at :1813/:1907/:1928/:2134,
//       all EXECUTE). assertAuditEvent(r,"STAGE_STARTED") first proves the event class fired.
//
// Known-answer literals (read from the SHIPPED handler / scope-mapping, not guessed):
//   - bugfix scope mapping (Ideation all SKIP, EXECUTE = init×3 + reverse-engineering +
//     requirements-analysis + code-generation + build-and-test): scope-mapping.json "bugfix"
//   - greenfield downgrades reverse-engineering EXECUTE->SKIP: aidlc-utility.ts:1958-1968
//   - Stage Progress row shape `- [x|-| ] <slug> — EXECUTE|SKIP`: aidlc-utility.ts:1996-1998
//   - Scope line "- **Scope**: bugfix": aidlc-utility.ts:2049
//   - STAGE_STARTED emitted for EXECUTE stages only: aidlc-utility.ts:1813,1907,1928,2134
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc bugfix on
// Opus/Bedrock until the deterministic run-stage directive. Generous per-test
// timeout so a hung SDK stream fails LOUD.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertAuditEvent } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { auditFilePathFor, driveAidlc } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. `/aidlc bugfix` is live SDK traffic even though the
// test stops after the deterministic orchestrator directive.
// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the .sh family
// allotted generous workflow budgets). The drive aborts a hair before bun
// kills the test so a stuck run surfaces a partial DriveResult to diagnose.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer stage slugs from the SHIPPED scope-mapping.json "bugfix" entry.
// The Ideation phase is ENTIRELY SKIP for bugfix; the 3 init stages EXECUTE; the
// Operation phase is entirely SKIP. (scope-mapping.json "bugfix".stages)
const IDEATION_STAGES = [
  "intent-capture",
  "market-research",
  "feasibility",
  "scope-definition",
  "team-formation",
  "rough-mockups",
  "approval-handoff",
];
const OPERATION_STAGES = [
  "deployment-pipeline",
  "environment-provisioning",
  "deployment-execution",
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
  // The seed is a plain, deterministic init (TRAP 2). The live journey stops
  // at the first orchestrator directive, before any gate, so it needs no mode.
  const res = spawnSync(
    process.execPath,
    [utility, "intent-birth", "--scope", "bugfix", "--project-dir", proj],
    { cwd: proj, encoding: "utf8" },
  );
  expect(res.status).toBe(0);
  expect(`${res.stdout}\n${res.stderr}`).toContain("State initialized");
}

/** Read the Stage-Progress row for a given stage slug from the post-run state
 *  file. Rows have the shape `- [<marker>] <slug> — <EXECUTE|SKIP>`
 *  (aidlc-utility.ts:1996-1998). Returns the marker char (e.g. "x", " ", "-")
 *  and the EXECUTE/SKIP suffix, or undefined if the slug has no row. */
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

/** Count `- [x]` Stage-Progress rows in the post-run state file — the
 *  deterministic equivalent of the .sh's `grep -c '^\- \[x\]'`. */
function completedRowCount(stateText: string): number {
  return (stateText.match(/^- \[x\] /gm) ?? []).length;
}

/** Files (not dirs) under <proj>/aidlc-docs/ideation/, recursively. The init
 *  tool scaffolds EMPTY stage dirs; because every Ideation stage is SKIP for
 *  bugfix, nothing should ever write a file there. Mirrors the .sh's
 *  `find aidlc-docs/ideation -type f`. */
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
 *  audit.md. Each audit block is "## <Heading>\n**Timestamp**: ...\n
 *  **Event**: <TYPE>\n**Stage**: <slug>\n..." (aidlc-audit format; see
 *  aidlc-utility.ts:1813 etc.). We pair each STAGE_STARTED Event line with the
 *  Stage line in the SAME block so a non-STAGE_STARTED Stage field can't leak
 *  in. Returns the slugs in file order. */
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

describe("t53 /aidlc bugfix scope routing (sdk)", () => {
  test(
    "bugfix skips Ideation+Operation, marks init [x], records bugfix scope; STAGE_STARTED names EXECUTE stages only",
    async () => {
      // --no-aidlc-docs: fresh greenfield project; init creates aidlc-docs/ from
      // scratch and downgrades reverse-engineering to SKIP (greenfield).
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        seedBugfixState(proj);

        const r = await driveAidlc("/aidlc bugfix", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: {
            toolName: "Bash",
            resultIncludes: '"stage":"requirements-analysis"',
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

        // ---- .sh test 1: state file created ----
        // driveAidlc reads it off disk into r.stateFile after the run.
        expect(r.stateFile).toBeDefined();
        const state = r.stateFile as string;

        // ---- .sh test 11: bugfix scope recorded ----
        // The ## Project Information Scope line (aidlc-utility.ts:2049). Stronger
        // than the .sh's case-insensitive [Bb]ugfix grep: an exact field read.
        const scope = state.match(/^- \*\*Scope\*\*: (\S+)$/m)?.[1];
        expect(scope).toBe("bugfix");

        // ---- .sh test 3: no Ideation stage marked [x] ----
        // STRONGER: every Ideation stage row is `[ ] <slug> — SKIP`, asserted
        // per-stage (the .sh only counted [x] occurrences == 0).
        for (const slug of IDEATION_STAGES) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("SKIP");
          expect(row!.marker).not.toBe("x");
        }

        // ---- .sh test 6: no Operation stage executed ----
        // Same per-stage SKIP assertion over the Operation phase.
        for (const slug of OPERATION_STAGES) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("SKIP");
          expect(row!.marker).not.toBe("x");
        }

        // ---- .sh tests 7-9: all 3 init stages marked [x] ----
        for (const slug of INIT_STAGES) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("EXECUTE");
          expect(row!.marker).toBe("x");
        }

        // ---- .sh test 4: Inception stages present ----
        // requirements-analysis is the first post-init EXECUTE stage for bugfix
        // (reverse-engineering downgraded to SKIP on greenfield); its EXECUTE
        // row must be present.
        const reqRow = stageRow(state, "requirements-analysis");
        expect(reqRow).toBeDefined();
        expect(reqRow!.action).toBe("EXECUTE");

        // ---- .sh test 5: Construction stages present ----
        // Both Construction EXECUTE stages for bugfix.
        for (const slug of ["code-generation", "build-and-test"]) {
          const row = stageRow(state, slug);
          expect(row).toBeDefined();
          expect(row!.action).toBe("EXECUTE");
        }

        // ---- .sh test 2: no Ideation artifacts created ----
        // init scaffolds empty stage dirs; every Ideation stage is SKIP, so no
        // stage ever writes a file under aidlc-docs/ideation/.
        expect(ideationFiles(proj)).toEqual([]);

        // ---- .sh test 12: completed stages < 12 (bugfix scope constraint) ----
        // The count of `- [x]` Stage-Progress rows. bugfix marks the 3 init
        // stages [x] at init; the run stops at the first directive (before any
        // gate), so nothing beyond init can complete. The .sh bounded this < 12.
        expect(completedRowCount(state)).toBeLessThan(12);

        // ---- NEW (audit): SKIP stages emit zero STAGE_STARTED ----
        // First prove the STAGE_STARTED class fired at all (no vacuous pass).
        assertAuditEvent(r, "STAGE_STARTED");
        // Then: every STAGE_STARTED block names an EXECUTE stage. No SKIP-for-
        // scope slug (any Ideation or Operation stage) ever appears as a
        // STAGE_STARTED `**Stage**:` field — the test's own thesis, made data.
        const started = new Set(stageStartedStages(proj));
        expect(started.size).toBeGreaterThan(0); // the audit DID record starts
        for (const slug of [...IDEATION_STAGES, ...OPERATION_STAGES]) {
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
