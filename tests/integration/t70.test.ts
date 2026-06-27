// covers: stage:initialization/workspace-detection, audit:WORKSPACE_SCANNED, subcommand:aidlc-utility:init
//
// t70.test.ts — SDK-harness port of tests/integration/t70-stage-workspace-detection-greenfield.sh
// (plan 8). Drives the real /aidlc --init --force (TRAP 2; init
// is a print-and-stop terminal with no gate, SKILL.md:54,138) against a project
// seeded with the greenfield-todo stub
// (a bare README.md, no source/manifest/framework config) and a pre-seeded state
// pinned at workspace-detection. Asserts ONLY on deterministic surfaces —
// on-disk state fields, audit events, and the init tool's verbatim Bash stdout —
// NEVER on assistantText.
//
// WHY THIS PORT EXISTS. The .sh asserted the classification by grepping the
// rendered state FILE (already deterministic), but hedged the Project-Type check
// with a case-insensitive `[Gg]reenfield` regex and the negative with a
// case-insensitive `brownfield` regex, and proved "init ran" only via run_claude's
// exit semantics. The whole init path is deterministic: the engine's --init
// branch (aidlc-orchestrate.ts:814-838) shells `bun .claude/tools/
// aidlc-utility.ts init [--force]` via Bash and prints its stdout verbatim.
// handleInit (aidlc-utility.ts:1716) removes the seeded state on
// --force (:1757), runs the deterministic detectWorkspace scan (:1912 -> :1581),
// and re-writes aidlc-state.md from a fixed template (:2044). The greenfield-todo
// stub carries no source files / package.json / framework config / manifest /
// app-source dir, so detectWorkspace's `brownfield` OR-chain (:1658-1663) is all
// false and projectType === "Greenfield" (:1666). Every .sh grep is re-expressed
// against that on-disk state + the typed audit event + the verbatim tool stdout.
//
// ASSERTION MAP (.sh test -> SDK surface):
//   1 state file still exists             -> r.stateFile !== undefined (sdk-drive reads aidlc-state.md off disk post-run)
//   2 Completed counter == [x] count      -> assertStateField "Completed"="3" (utility.ts:2071 completedInit) AND
//                                            on-disk `- [x]` line count === 3 (init stages marked [x], utility.ts:1996).
//                                            Stronger: pins the known-answer 3, not just internal consistency.
//   3 Project Type is greenfield          -> assertStateField "Project Type"="Greenfield"
//                                            (utility.ts:2048 <- scan.projectType, :1666). Stronger: exact, not [Gg] regex.
//   4 audit has WORKSPACE_SCANNED         -> assertAuditEvent "WORKSPACE_SCANNED" (emitted utility.ts:1914).
//                                            Stronger: typed **Event** parse, not a substring grep of audit.md.
//   5 [x] count >= 3 (all init stages)    -> on-disk `- [x]` line count >= 3 (and === completedInit === 3).
//   6 Project Root is populated           -> assertStateField "Project Root"=<projectDir> (utility.ts:2064 <- projectDir).
//                                            Stronger: exact path equality, not merely "not the em-dash placeholder".
//   7 State Version is 7                  -> assertStateField "State Version"="7" (utility.ts:2051 hard literal `7`).
//                                            Stronger: exact, not the `State Version.*: 7` regex.
//   8 Project Type is NOT brownfield      -> Project-Type field does NOT match /brownfield/i (the negative; complements 3).
//   + init actually RAN (was run_claude   -> assertToolResultContains "Bash" "Project type: Greenfield" — the init tool's
//     exit semantics)                        verbatim stdout (utility.ts:2151). Proves the deterministic tool fired
//                                            (assertToolResultContains refuses to pass vacuously if Bash never ran).
//
// Known-answer literals (read from the SHIPPED handler / fixture, not guessed):
//   - --init --force dispatch:  SKILL.md:531 -> `bun .claude/tools/aidlc-utility.ts init` via Bash, stdout verbatim
//   - --force removes seeded state then re-writes:  handleInit aidlc-utility.ts:1749-1758
//   - classification "Greenfield":         detectWorkspace :1658-1666 (all brownfield signals false for the stub)
//   - state Project Type line:             aidlc-utility.ts:2048
//   - state Completed = init stage count:  :2009 (graph init-phase count) -> :2071 (=== 3); init stages get [x] :1996
//   - state Project Root = projectDir:     :2064
//   - state State Version literal `7`:     :2051
//   - WORKSPACE_SCANNED audit emit:        :1914 (VALID_EVENT_TYPES member, aidlc-audit.ts:42)
//   - init stdout "Project type: ...":     :2151
//   - greenfield-todo stub = bare README:  tests/fixtures/greenfield-todo/README.md (no source/manifest/framework)
//   - no gate in the init path (no AskUserQuestion):  SKILL.md:82,138 (init prints state and STOPs)
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

import { describe, expect, test } from "bun:test";
import {
  assertAuditEvent,
  assertStateField,
  assertStateFieldPath,
  assertToolResultContains,
} from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  driveAidlc,
  readStateField,
  readStateFile,
} from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget — honour the suite's AIDLC_TEST_TIMEOUT convention (seconds;
// the .sh set AIDLC_TEST_TIMEOUT=180). The bun:test per-test cap is that value;
// the driver's own abort fires ~15s earlier so a stuck canUseTool surfaces as a
// clear harness failure (no result event) rather than an opaque test-timeout.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "180", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 180) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals from the SHIPPED handler / fixture (see header).
const SCANNED_EVENT = "WORKSPACE_SCANNED"; // aidlc-utility.ts:1914
const PROJECT_TYPE = "Greenfield"; // detectWorkspace :1666 for the bare-README stub
const STATE_VERSION = "7"; // aidlc-utility.ts:2051 (hard literal)
const COMPLETED_INIT = "3"; // init-phase stage count (:2009 -> :2071)
const INIT_STDOUT_TYPE_LINE = "Project type: Greenfield"; // verbatim init stdout :2151
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STDOUT_TYPE_LINE } as const;

/** Count `- [x]` completed-stage lines in a state-file string (mirrors the .sh's
 *  `grep -c '^\- \[x\]'`). */
function countCompletedCheckboxes(stateText: string): number {
  return stateText.split("\n").filter((l) => /^- \[x\]/.test(l)).length;
}

describe("t70 /aidlc birth on a greenfield stub (sdk)", () => {
  // -------------------------------------------------------------------------
  // P4: the user-facing --init is retired; naming a scope on a fresh workspace
  // BIRTHS the first intent (the engine NAMES intent-birth, the conductor runs
  // it). The deterministic birth tool classifies the greenfield-todo stub and
  // writes aidlc-state.md into the BORN intent's record. Every .sh state-grep is
  // re-expressed against the on-disk per-intent state fields / the typed audit
  // event / the verbatim tool stdout. No seeded state (a clean greenfield birth,
  // not a migration).
  // -------------------------------------------------------------------------
  test(
    "greenfield classification writes Project Type=Greenfield to the born intent's state; WORKSPACE_SCANNED fires; no gate",
    async () => {
      // A fresh greenfield-todo stub on a CLEAN workspace — noAidlcDocs strips
      // the default seeded intent record so the engine AUTO-BIRTHS a new intent
      // over the stub and the scan fires (a pre-seeded record would make the
      // engine resolve the existing intent and ask to pick one, skipping the
      // scan — same fix as t71-brownfield). The birth path has no
      // gate (it prints state and STOPs).
      const proj = setupIntegrationProject({
        withGreenfieldStub: true,
        noAidlcDocs: true,
      });
      try {
        const r = await driveAidlc('/aidlc --scope poc "build a todo app"', {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // The init path RAN: the deterministic init tool fired via Bash and its
        // verbatim stdout carries the classification line. assertToolResultContains
        // fails loudly if Bash never fired (no vacuous pass) — this is the
        // deterministic stand-in for the .sh's run_claude exit semantics, and it
        // pins the same Greenfield classification on the TOOL's own stdout.
        assertToolResultContains(r, "Bash", INIT_STDOUT_TYPE_LINE);

        // .sh test 1: state file still exists. sdk-drive reads aidlc-state.md off
        // disk post-run; r.stateFile is the verbatim contents (undefined if absent).
        expect(r.stateFile).toBeDefined();
        const stateAfter = readStateFile(proj);
        expect(stateAfter).toBeDefined();

        // .sh test 3: Project Type is greenfield. Exact value (not [Gg] regex):
        // detectWorkspace returns "Greenfield" for the bare-README stub (:1666).
        assertStateField(r, "Project Type", PROJECT_TYPE);

        // .sh test 8 (negative): Project Type is NOT brownfield. Complements test
        // 3 — the field value must not match /brownfield/i.
        const projectTypeValue = readStateField(stateAfter as string, "Project Type");
        expect(projectTypeValue).toBeDefined();
        expect(projectTypeValue).not.toMatch(/brownfield/i);

        // .sh test 4: audit has WORKSPACE_SCANNED. Typed-event parse over the
        // `**Event**:` lines (stronger than a substring grep of audit.md).
        assertAuditEvent(r, SCANNED_EVENT);

        // .sh test 7: State Version is 7. Exact (the template hard-codes `7` :2051).
        assertStateField(r, "State Version", STATE_VERSION);

        // .sh test 6: Project Root is populated. The template writes the literal
        // projectDir (:2064) — assert exact equality (stronger than "not the
        // em-dash placeholder").
        assertStateFieldPath(r, "Project Root", proj);

        // .sh test 2 + test 5: the Completed counter equals the [x] count AND
        // that count is >= 3 (all three init stages complete after --force reinit).
        // Known answer: completedInit === init-phase stage count === 3 (:2009),
        // written to the Completed field (:2071); init stages are marked [x] (:1996).
        // Assert the field is exactly "3", the on-disk [x] count is exactly 3, and
        // they agree (the .sh's internal-consistency check) — and >= 3 (test 5).
        assertStateField(r, "Completed", COMPLETED_INIT);
        const xCount = countCompletedCheckboxes(stateAfter as string);
        expect(xCount).toBe(Number.parseInt(COMPLETED_INIT, 10)); // == 3 (tests 2+5)
        expect(xCount).toBeGreaterThanOrEqual(3); // .sh test 5 floor, explicitly
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
