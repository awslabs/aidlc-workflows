// covers: stage:initialization/workspace-detection
//
// t71-stage-workspace-detection-brownfield.test.ts — SDK-harness port of
// tests/integration/t71-stage-workspace-detection-brownfield.sh (plan 10).
//
// P4 MIGRATION. The user-facing --init/--force are RETIRED. Naming a scope on a
// fresh workspace BIRTHS the first intent (the engine NAMES intent-birth, the
// conductor runs it); the deterministic birth handler runs the same
// detectWorkspace scan + state/audit write the old --init did, now into the BORN
// intent's per-intent record. This test drives a CLEAN birth
// (`/aidlc --scope poc "build a todo app"`) over the brownfield stub — NO
// --init --force, and NO seeded state. A seeded flat state would trigger birth's
// migrate-flat short-circuit (handleIntentBirth aidlc-utility.ts:2022-2037 MOVES
// the flat tree into a record and RETURNS without running the scan), which would
// skip the very WORKSPACE_SCANNED classification this test pins. A clean birth on
// the brownfield stub runs the scan and writes the classification (mirrors how
// t70.test.ts was migrated for greenfield). The birth path has no
// gate to auto-approve (it prints state and STOPs). Asserts ONLY on deterministic
// surfaces — Bash tool_result bytes, on-disk per-intent state fields, audit events
// — NEVER on assistantText.
//
// WHY THIS PORT EXISTS. The .sh grepped the WRITTEN state file and audit log,
// which are already deterministic surfaces (it was not a prose-flake test) —
// but it reached them through a `claude -p` subprocess + exit-124 heuristic.
// The SDK driver replaces that subprocess wholesale, and sdk-drive's readers
// (readStateFile/readAuditEvents) resolve the BORN intent's per-intent record.
// The birth path is a single deterministic Bash dispatch: the engine names
// `bun .claude/tools/aidlc-utility.ts intent-birth --scope <scope> --arguments "..."`
// and the conductor prints its stdout VERBATIM. handleIntentBirth
// (aidlc-utility.ts:1986) runs detectWorkspace over the brownfield-todo stub and
// WRITES the classification into the per-intent aidlc-state.md + emits
// WORKSPACE_SCANNED (:2144). So every .sh assertion maps to a surface the TOOL
// produced, not the LLM's rendering.
//
// KNOWN-ANSWER classification for the brownfield-todo stub. Verified by running
// detectWorkspace() directly against tests/fixtures/brownfield-todo:
//   projectType="Brownfield"  languages="TypeScript"  frameworks="Vite, React"
//   buildSystem="npm (package.json)".
// The framework order ("Vite, React" not "React, Vite") is deterministic:
// detectFrameworks pushes Vite from vite.config.ts (utility.ts:1483) BEFORE
// React from package.json deps (:1505). The stub's package.json carries
// react@^18 as a runtime dep and vite.config.ts at the root.
//
// ASSERTION MAP (.sh test -> SDK surface). Source: handleIntentBirth
// (aidlc-utility.ts:1986) runs the SAME detectWorkspace scan + state/audit write
// the old --init did, now per-intent. The surfaces below are unchanged; only the
// dispatch (clean birth, not --init --force) and the record location (per-intent,
// resolved by sdk-drive's readers) moved.
//   1 state file still exists          -> r.stateFile !== undefined (per-intent record, written by handleIntentBirth)
//   2 Completed counter == [x] count   -> on disk: "Completed" field === count of `^- [x]` lines.
//                                          birth writes Completed=completedInit (3 init stages) and marks all 3
//                                          init stages [x]. Both sides computed off the written file — stronger
//                                          than the .sh (proves the invariant, not a literal).
//   3 Project Type ~ [Bb]rownfield     -> assertStateField "Project Type" === "Brownfield"  (state write :2377; scan:1666)
//   4 Frameworks lists React           -> assertStateFieldContains "Frameworks" "React"     (state write; detectFrameworks:1505)
//   5 Languages lists TypeScript       -> assertStateFieldContains "Languages" "TypeScript" (state write; LANG_BY_EXT .ts/.tsx)
//   6 audit has WORKSPACE_SCANNED      -> assertAuditEvent "WORKSPACE_SCANNED"              (handleIntentBirth:2144; aidlc-audit.ts)
//   7 [x] count >= 3 (all init stages) -> on disk: count of `^- [x]` >= 3                   (3 init stages marked [x])
//   8 State Version is 7               -> assertStateField "State Version" === "7"          (birth state template)
//   9 Languages field present          -> readStateField "Languages" !== undefined          (state write)
//  10 Frameworks field present         -> readStateField "Frameworks" !== undefined          (state write)
//
// STRONGER-THAN-.sh additions (parity floor, not weakening):
//   - assertToolResultContains(r,"Bash","Project type: Brownfield") etc. on the
//     verbatim birth stdout block (utility.ts:2377-2380) — proves the deterministic
//     birth dispatch ACTUALLY FIRED (no vacuous pass) before we trust the written
//     file, and asserts the exact full Languages/Frameworks/BuildSystem literals
//     the .sh only spot-grepped for substrings.
//   - assertStateField "Project Type"=== exact "Brownfield" (the .sh used a
//     case-insensitive [Bb]rownfield regex; the written literal is exact).
//   - assertStateField "Frameworks"/"Languages" exact-equality on the full
//     "Vite, React" / "TypeScript" values, in addition to the .sh's contains.
//
// Gates: the birth path prints state and STOPs (no gate on this path), so this
// run poses no menu — answerScript is left at its "default" (option-1) policy and
// we assert zero menus were shown.
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.

import { describe, expect, test } from "bun:test";
import {
  assertAuditEvent,
  assertStateField,
  assertStateFieldContains,
  assertToolResultContains,
} from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. The .sh inherited run_claude's 1800s default but its own
// header (lines 4-5) notes the scanner runs in <1s — the birth is a single
// deterministic Bash dispatch + STOP, not a multi-turn workflow. Honour the
// suite's AIDLC_TEST_TIMEOUT convention (seconds) with a 300s default that is
// generous for one Opus turn; the driver aborts ~15s early so a stuck
// canUseTool surfaces a partial DriveResult instead of an opaque hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "300", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 300) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer classification literals for the brownfield-todo stub, as the
// birth handler writes them (state file) / prints them (stdout block). Read from
// the SHIPPED handler + verified by running detectWorkspace() over the stub.
const PROJECT_TYPE = "Brownfield"; // scan.projectType, birth state write / stdout :2377
const LANGUAGES = "TypeScript"; // scan.languages,  birth state write / stdout :2378
const FRAMEWORKS = "Vite, React"; // scan.frameworks, birth state write / stdout :2379
const BUILD_SYSTEM = "npm (package.json)"; // scan.buildSystem, birth state write / stdout :2380
const STATE_VERSION = "7"; // birth state template
const WORKSPACE_SCANNED = "WORKSPACE_SCANNED"; // handleIntentBirth:2144
// Verbatim birth stdout block lines (utility.ts:2377-2380) — the deterministic
// surface that proves the birth dispatch ran.
const STDOUT_TYPE = `Project type: ${PROJECT_TYPE}`;
const STDOUT_LANGS = `Languages: ${LANGUAGES}`;
const STDOUT_FW = `Frameworks: ${FRAMEWORKS}`;
const STDOUT_BUILD = `Build System: ${BUILD_SYSTEM}`;
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: STDOUT_TYPE } as const;

/** Count `^- [x]` (completed) stage-progress lines in a state-file string —
 *  the deterministic re-expression of the .sh's `grep -c '^\- \[x\]'`. */
function completedCheckboxCount(stateText: string): number {
  return stateText.split("\n").filter((l) => /^- \[x\]/.test(l)).length;
}

describe("t71 workspace detection — brownfield classification writes state (sdk)", () => {
  // -------------------------------------------------------------------------
  // A CLEAN birth (`/aidlc --scope poc "build a todo app"`) over a brownfield
  // stub — NO --init --force, NO seeded state (a seeded flat state would trigger
  // birth's migrate-flat short-circuit and skip the scan; see header). The
  // birth path has no gate. handleIntentBirth runs the scan +
  // state write deterministically; the scan classifies the stub Brownfield and
  // the written per-intent state + audit carry the result. We assert on the
  // verbatim birth stdout (proves the dispatch fired), then on the on-disk
  // per-intent state fields + the WORKSPACE_SCANNED audit event the tool emitted.
  // -------------------------------------------------------------------------
  test(
    "brownfield stub classifies Brownfield; state + audit record the scan",
    async () => {
      // noAidlcDocs strips the default seeded intent record so this is a CLEAN
      // workspace — the engine auto-births a NEW intent over the brownfield stub
      // and the scan fires. A pre-seeded record would make birth resolve the
      // existing intent and skip the scan (see header).
      const proj = setupIntegrationProject({
        withBrownfieldStub: true,
        noAidlcDocs: true,
      });
      try {
        const r = await driveAidlc('/aidlc --scope poc "build a todo app"', {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // The deterministic birth dispatch ACTUALLY FIRED: the conductor prints
        // the birth tool's stdout verbatim, and assertToolResultContains refuses
        // to pass vacuously if Bash never fired. These are the tool's stdout
        // bytes (utility.ts:2377-2380), NOT the LLM's prose. This is the
        // stronger-than-.sh proof the classification came from the scanner.
        assertToolResultContains(r, "Bash", STDOUT_TYPE);
        assertToolResultContains(r, "Bash", STDOUT_LANGS);
        assertToolResultContains(r, "Bash", STDOUT_FW);
        assertToolResultContains(r, "Bash", STDOUT_BUILD);

        // .sh test 1: the state file still exists after the run. handleIntentBirth
        // writes it into the born intent's record; driveAidlc reads it back off
        // disk via the per-intent resolver (recordDirFor).
        expect(r.stateFile).toBeDefined();
        const state = r.stateFile as string;

        // .sh test 3: Project Type is brownfield. The .sh used a case-insensitive
        // [Bb]rownfield regex; the written literal is the exact "Brownfield".
        assertStateField(r, "Project Type", PROJECT_TYPE);

        // .sh tests 4 + 10: Frameworks lists React AND the field is present.
        // assertStateField (exact) subsumes the .sh's contains-React grep and
        // the bare field-present grep; we also assert the exact full value.
        assertStateField(r, "Frameworks", FRAMEWORKS);
        assertStateFieldContains(r, "Frameworks", "React");
        expect(readStateField(state, "Frameworks")).toBeDefined();

        // .sh tests 5 + 9: Languages lists TypeScript AND the field is present.
        assertStateField(r, "Languages", LANGUAGES);
        assertStateFieldContains(r, "Languages", "TypeScript");
        expect(readStateField(state, "Languages")).toBeDefined();

        // .sh test 8: State Version is 7 (birth state template). Exact equality is
        // stronger than the .sh's `State Version.*: 7` substring grep.
        assertStateField(r, "State Version", STATE_VERSION);

        // .sh test 2: the Completed counter equals the [x] count. Both are read
        // off the WRITTEN file: birth sets Completed=3 (completedInit, the 3 init
        // stages) and marks each init stage [x]. Asserting the invariant (counter
        // === marker count) is stronger than the .sh — it proves the two sides
        // agree, computed from the same file.
        const xCount = completedCheckboxCount(state);
        const completed = readStateField(state, "Completed");
        expect(completed).toBeDefined();
        expect(Number.parseInt(completed as string, 10)).toBe(xCount);

        // .sh test 7: [x] count >= 3 (all three initialization stages complete).
        expect(xCount).toBeGreaterThanOrEqual(3);

        // .sh test 6: audit recorded WORKSPACE_SCANNED (handleIntentBirth:2144). The
        // named event is stronger than the .sh's bare grep — it proves the scan
        // stage emitted, not just that the string appears somewhere.
        assertAuditEvent(r, WORKSPACE_SCANNED);

        // The birth path prints state and STOPs (no gate on this path): no
        // AskUserQuestion menu should have fired.
        expect(r.askedQuestions.length).toBe(0);

        // The birth tool exited 0. The driver intentionally aborts once the
        // deterministic birth stdout lands, preventing unrelated post-birth
        // workflow execution after the workspace-detection contract is proven.
        const birthCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(STDOUT_TYPE),
        );
        expect(birthCall?.isError).toBe(false);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
