// covers: stage:initialization/workspace-detection
//
// t71-stage-workspace-detection-brownfield.test.ts — SDK-harness port of
// tests/stage/t71-stage-workspace-detection-brownfield.sh (plan 10). Drives the
// real /aidlc --init --force --test-run through the Claude Agent SDK against a
// brownfield stub + a pre-workspace-detection seeded state, and asserts ONLY on
// deterministic surfaces — Bash tool_result bytes, on-disk state fields, audit
// events — NEVER on assistantText.
//
// WHY THIS PORT EXISTS. The .sh grepped the WRITTEN state file and audit log,
// which are already deterministic surfaces (it was not a prose-flake test) —
// but it reached them through a `claude -p` subprocess + exit-124 heuristic.
// The SDK driver replaces that subprocess wholesale. The init path is a single
// deterministic Bash dispatch: SKILL.md:531 routes `--init` to
// `bun .claude/tools/aidlc-utility.ts init --scope <scope> --arguments "..."`
// (with --test-run appended in TEST_RUN_MODE) and prints its stdout VERBATIM.
// handleInit (aidlc-utility.ts:1716) runs detectWorkspace (:1581) over the
// brownfield-todo stub and WRITES the classification into aidlc-state.md
// (:2044-2097) + emits WORKSPACE_SCANNED to audit.md (:1914). So every .sh
// assertion maps to a surface the TOOL produced, not the LLM's rendering.
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
// ASSERTION MAP (.sh test -> SDK surface, with the SHIPPED literal's source):
//   1 state file still exists          -> r.stateFile !== undefined (on disk, written by handleInit:2099)
//   2 Completed counter == [x] count   -> on disk: "Completed" field === count of `^- [x]` lines.
//                                          handleInit writes Completed=completedInit (3 init stages, :2009/:2071)
//                                          and marks all 3 init stages [x] (:1996). Both sides computed off the
//                                          written file — stronger than the .sh (proves the invariant, not a literal).
//   3 Project Type ~ [Bb]rownfield     -> assertStateField "Project Type" === "Brownfield"  (handleInit:2048; scan:1666)
//   4 Frameworks lists React           -> assertStateFieldContains "Frameworks" "React"     (handleInit:2066; detectFrameworks:1505)
//   5 Languages lists TypeScript       -> assertStateFieldContains "Languages" "TypeScript" (handleInit:2065; LANG_BY_EXT .ts/.tsx:1407-8)
//   6 audit has WORKSPACE_SCANNED      -> assertAuditEvent "WORKSPACE_SCANNED"              (handleInit:1914; aidlc-audit.ts:42)
//   7 [x] count >= 3 (all init stages) -> on disk: count of `^- [x]` >= 3                   (handleInit:1996, 3 init stages)
//   8 State Version is 7               -> assertStateField "State Version" === "7"          (handleInit:2051)
//   9 Languages field present          -> readStateField "Languages" !== undefined          (handleInit:2065)
//  10 Frameworks field present         -> readStateField "Frameworks" !== undefined          (handleInit:2066)
//
// STRONGER-THAN-.sh additions (parity floor, not weakening):
//   - assertToolResultContains(r,"Bash","Project type: Brownfield") etc. on the
//     verbatim init stdout block (utility.ts:2141-2156) — proves the deterministic
//     init dispatch ACTUALLY FIRED (no vacuous pass) before we trust the written
//     file, and asserts the exact full Languages/Frameworks/BuildSystem literals
//     the .sh only spot-grepped for substrings.
//   - assertStateField "Project Type"=== exact "Brownfield" (the .sh used a
//     case-insensitive [Bb]rownfield regex; the written literal is exact).
//   - assertStateField "Frameworks"/"Languages" exact-equality on the full
//     "Vite, React" / "TypeScript" values, in addition to the .sh's contains.
//
// Gates: --init STOPs after state-init (SKILL.md:138) and TEST_RUN_MODE skips
// every AskUserQuestion (SKILL.md:139), so this run poses no menu — answerScript
// is left at its "default" (option-1) policy and we assert zero menus were shown.
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
// header (lines 4-5) notes the scanner runs in <1s — `--init` is a single
// deterministic Bash dispatch + STOP, not a multi-turn workflow. Honour the
// suite's AIDLC_TEST_TIMEOUT convention (seconds) with a 300s default that is
// generous for one Opus turn; the driver aborts ~15s early so a stuck
// canUseTool surfaces a partial DriveResult instead of an opaque hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "300", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 300) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer classification literals for the brownfield-todo stub, as the
// init handler writes them (state file) / prints them (stdout block). Read from
// the SHIPPED handler + verified by running detectWorkspace() over the stub.
const PROJECT_TYPE = "Brownfield"; // scan.projectType, handleInit:2048 / :2151
const LANGUAGES = "TypeScript"; // scan.languages,  handleInit:2065 / :2152
const FRAMEWORKS = "Vite, React"; // scan.frameworks, handleInit:2066 / :2153
const BUILD_SYSTEM = "npm (package.json)"; // scan.buildSystem, handleInit:2067 / :2154
const STATE_VERSION = "7"; // handleInit:2051
const WORKSPACE_SCANNED = "WORKSPACE_SCANNED"; // handleInit:1914
// Verbatim init stdout block lines (utility.ts:2151-2154) — the deterministic
// surface that proves the init dispatch ran.
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
  // /aidlc --init --force --test-run over a brownfield stub + pre-detection
  // state. handleInit re-runs scaffold + scan + state-init deterministically;
  // the scan classifies the stub Brownfield and the written state + audit carry
  // the result. We assert on the verbatim init stdout (proves the dispatch
  // fired), then on the on-disk state fields + the WORKSPACE_SCANNED audit
  // event the tool emitted.
  // -------------------------------------------------------------------------
  test(
    "brownfield stub classifies Brownfield; state + audit record the scan",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-pre-workspace-detection.md",
        withBrownfieldStub: true,
        withAudit: true,
      });
      try {
        const r = await driveAidlc("/aidlc --init --force --test-run", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // The deterministic init dispatch ACTUALLY FIRED: SKILL.md:531 prints
        // the init tool's stdout verbatim, and assertToolResultContains refuses
        // to pass vacuously if Bash never fired. These are the tool's stdout
        // bytes (utility.ts:2151-2154), NOT the LLM's prose. This is the
        // stronger-than-.sh proof the classification came from the scanner.
        assertToolResultContains(r, "Bash", STDOUT_TYPE);
        assertToolResultContains(r, "Bash", STDOUT_LANGS);
        assertToolResultContains(r, "Bash", STDOUT_FW);
        assertToolResultContains(r, "Bash", STDOUT_BUILD);

        // .sh test 1: the state file still exists after the run. handleInit
        // writes it (utility.ts:2099); driveAidlc reads it back off disk.
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

        // .sh test 8: State Version is 7 (handleInit:2051). Exact equality is
        // stronger than the .sh's `State Version.*: 7` substring grep.
        assertStateField(r, "State Version", STATE_VERSION);

        // .sh test 2: the Completed counter equals the [x] count. Both are read
        // off the WRITTEN file: handleInit sets Completed=3 (completedInit, the
        // 3 init stages, :2009/:2071) and marks each init stage [x] (:1996).
        // Asserting the invariant (counter === marker count) is stronger than
        // the .sh — it proves the two sides agree, computed from the same file.
        const xCount = completedCheckboxCount(state);
        const completed = readStateField(state, "Completed");
        expect(completed).toBeDefined();
        expect(Number.parseInt(completed as string, 10)).toBe(xCount);

        // .sh test 7: [x] count >= 3 (all three initialization stages complete).
        expect(xCount).toBeGreaterThanOrEqual(3);

        // .sh test 6: audit recorded WORKSPACE_SCANNED (handleInit:1914). The
        // named event is stronger than the .sh's bare grep — it proves the scan
        // stage emitted, not just that the string appears somewhere.
        assertAuditEvent(r, WORKSPACE_SCANNED);

        // --init STOPs after state-init (SKILL.md:138) and TEST_RUN_MODE skips
        // every gate (SKILL.md:139): no AskUserQuestion menu should have fired.
        expect(r.askedQuestions.length).toBe(0);

        // The init tool exited 0. The driver intentionally aborts once the
        // deterministic init stdout lands, preventing unrelated post-init
        // workflow execution after the workspace-detection contract is proven.
        const initCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(STDOUT_TYPE),
        );
        expect(initCall?.isError).toBe(false);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
