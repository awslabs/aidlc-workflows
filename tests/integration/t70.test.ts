// covers: stage:initialization/workspace-detection, audit:WORKSPACE_SCANNED, subcommand:aidlc-utility:init
//
// t70.test.ts — SDK-harness port of tests/integration/t70-stage-workspace-detection-greenfield.sh
// (plan 8). Drives the real /aidlc --init --force (TRAP 2; init
// is a print-and-stop terminal with no gate, SKILL.md) against a project
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
// branch (aidlc-orchestrate.ts) shells `bun .claude/tools/
// aidlc-utility.ts init [--force]` via Bash and prints its stdout verbatim.
// handleInit (aidlc-utility.ts) removes the seeded state on
// --force, runs the deterministic detectWorkspace scan,
// and re-writes aidlc-state.md from a fixed template. The greenfield-todo
// stub carries no source files / package.json / framework config / manifest /
// app-source dir, so detectWorkspace's `brownfield` OR-chain is all
// false and projectType === "Greenfield". Every .sh grep is re-expressed
// against that on-disk state + the typed audit event + the verbatim tool stdout.
//
// ASSERTION MAP (.sh test -> SDK surface):
//   1 state file still exists             -> r.stateFile !== undefined (sdk-drive reads aidlc-state.md off disk post-run)
//   2 Completed counter == [x] count      -> assertStateField "Completed"="3" (utility.ts completedInit) AND
//                                            on-disk `- [x]` line count === 3 (init stages marked [x], utility.ts).
//                                            Stronger: pins the known-answer 3, not just internal consistency.
//   3 Project Type is greenfield          -> assertStateField "Project Type"="Greenfield"
//                                            (utility.ts <- scan.projectType). Stronger: exact, not [Gg] regex.
//   4 audit has WORKSPACE_SCANNED         -> assertAuditEvent "WORKSPACE_SCANNED" (emitted utility.ts).
//                                            Stronger: typed **Event** parse, not a substring grep of audit.md.
//   5 [x] count >= 3 (all init stages)    -> on-disk `- [x]` line count >= 3 (and === completedInit === 3).
//   6 Project Root is populated           -> assertStateField "Project Root"=<projectDir> (utility.ts <- projectDir).
//                                            Stronger: exact path equality, not merely "not the em-dash placeholder".
//   7 State Version is 7                  -> assertStateField "State Version"="7" (utility.ts hard literal `7`).
//                                            Stronger: exact, not the `State Version.*: 7` regex.
//   8 Project Type is NOT brownfield      -> Project-Type field does NOT match /brownfield/i (the negative; complements 3).
//   + init actually RAN (was run_claude   -> assertToolResultContains "Bash" "Project type: Greenfield" — the init tool's
//     exit semantics)                        verbatim stdout (utility.ts). Proves the deterministic tool fired
//                                            (assertToolResultContains refuses to pass vacuously if Bash never ran).
//
// Known-answer literals (read from the SHIPPED handler / fixture, not guessed):
//   - --init --force dispatch:  SKILL.md -> `bun .claude/tools/aidlc-utility.ts init` via Bash, stdout verbatim
//   - --force removes seeded state then re-writes:  handleInit aidlc-utility.ts
//   - classification "Greenfield":         detectWorkspace (all brownfield signals false for the stub)
//   - state Project Type line:             aidlc-utility.ts
//   - state Completed = init stage count:  aidlc-utility.ts (graph init-phase count === 3); init stages get [x]
//   - state Project Root = projectDir:     aidlc-utility.ts
//   - state State Version literal `7`:     aidlc-utility.ts
//   - WORKSPACE_SCANNED audit emit:        aidlc-utility.ts (VALID_EVENT_TYPES member, aidlc-audit.ts)
//   - init stdout "Project type: ...":     aidlc-utility.ts
//   - greenfield-todo stub = bare README:  tests/fixtures/greenfield-todo/README.md (no source/manifest/framework)
//   - no gate in the init path (no AskUserQuestion):  SKILL.md (init prints state and STOPs)
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
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
// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Known-answer literals from the SHIPPED handler / fixture (see header).
const SCANNED_EVENT = "WORKSPACE_SCANNED"; // aidlc-utility.ts handleIntentCreateStateBuild
const PROJECT_TYPE = "Greenfield"; // detectWorkspace for the bare-README stub
const STATE_VERSION = "8"; // aidlc-utility.ts state template (CURRENT_STATE_VERSION)
const COMPLETED_INIT = "3"; // init-phase stage count (handleIntentCreateStateBuild)
const INIT_STDOUT_TYPE_LINE = "Project type: Greenfield"; // verbatim creation stdout (handleIntentCreateStateBuild)
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STDOUT_TYPE_LINE } as const;

function countCompletedCheckboxes(stateText: string): number {
  return stateText.split("\n").filter((l) => /^- \[x\]/.test(l)).length;
}

describe("t70 /aidlc creation on a greenfield stub (sdk)", () => {
  // -------------------------------------------------------------------------
  // Naming a scope on a fresh workspace CREATES the first intent (the engine
  // NAMES intent-create, the conductor runs it). The deterministic creation tool
  // classifies the greenfield-todo stub and writes aidlc-state.md into the
  // CREATED intent's record. Assertions use the on-disk per-intent state fields /
  // the typed audit event / the verbatim tool stdout. No seeded state (a clean
  // greenfield creation).
  // -------------------------------------------------------------------------
  test(
    "greenfield classification writes Project Type=Greenfield to the created intent's state; WORKSPACE_SCANNED fires; no gate",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      // A fresh greenfield-todo stub on a CLEAN workspace — noAidlcDocs strips
      // the default seeded intent record so the engine AUTO-CREATES a new intent
      // over the stub and the scan fires (a pre-seeded record would make the
      // engine resolve the existing intent and ask to pick one, skipping the
      // scan). The driver stops after the creation stdout.
      const proj = setupIntegrationProject({
        withGreenfieldStub: true,
        noAidlcDocs: true,
      });
      try {
        const r = await driveAidlc('/aidlc --scope poc "build a todo app"', {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // The creation path RAN: the deterministic creation tool fired via Bash and its
        // verbatim stdout carries the classification line. assertToolResultContains
        // fails loudly if Bash never fired (no vacuous pass), and it pins the
        // Greenfield classification on the TOOL's own stdout.
        assertToolResultContains(r, "Bash", INIT_STDOUT_TYPE_LINE);

        // sdk-drive reads aidlc-state.md off disk post-run; r.stateFile is the
        // verbatim contents (undefined if absent).
        expect(r.stateFile).toBeDefined();
        const stateAfter = readStateFile(proj);
        expect(stateAfter).toBeDefined();

        // detectWorkspace returns "Greenfield" for the bare-README stub.
        assertStateField(r, "Project Type", PROJECT_TYPE);

        const projectTypeValue = readStateField(stateAfter as string, "Project Type");
        expect(projectTypeValue).toBeDefined();
        expect(projectTypeValue).not.toMatch(/brownfield/i);

        assertAuditEvent(r, SCANNED_EVENT);

        assertStateField(r, "State Version", STATE_VERSION);

        // The template writes a project-relative marker (`.`) rather than the
        // absolute projectDir, so the committed state carries no machine-local
        // absolute path (#937). The real root is re-derived at runtime; the field is
        // only an unreached fallback that resolve()s relative to cwd.
        assertStateFieldPath(r, "Project Root", ".");

        // The Completed counter equals the [x] count AND that count is >= 3 (all
        // three init stages complete after creation). Known answer: completedInit ===
        // init-phase stage count === 3, written to the Completed field; init stages
        // are marked [x] by handleIntentCreateStateBuild.
        assertStateField(r, "Completed", COMPLETED_INIT);
        const xCount = countCompletedCheckboxes(stateAfter as string);
        expect(xCount).toBe(Number.parseInt(COMPLETED_INIT, 10));
        expect(xCount).toBeGreaterThanOrEqual(3);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
