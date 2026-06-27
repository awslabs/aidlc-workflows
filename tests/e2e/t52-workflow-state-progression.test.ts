// covers: subcommand:aidlc-utility:init, scope:bugfix
//
// t52-workflow-state-progression.test.ts — SDK-harness port of
// tests/e2e/t52-workflow-state-progression.sh (plan 10). Drives the real
// `/aidlc --init --scope bugfix` on a fresh project through the Claude Agent SDK and
// asserts ONLY on deterministic surfaces — the on-disk state-file structure +
// fields the init tool wrote, and the framework's counter↔checkbox invariant —
// NEVER on assistantText.
//
// ⛔ TRAP 2 (no headless auto-approve). The .sh drove the whole bugfix workflow to
// COMPLETION and asserted on the FINAL state (checkbox counts, ordering, fields)
// under a headless auto-approve mode the refactor kills. The .sh's subject is
// "state file INTEGRITY: checkbox counts, stage ordering, field updates" — and the
// state file's STRUCTURE + all its fields are written DETERMINISTICALLY by
// explicit init (`aidlc-utility.ts init`, the State-Version-7 template,
// utility.ts:2044-2097), BEFORE any gate. So this sdk twin drives the init turn,
// stops the instant the init stdout lands, and asserts the deterministic state STRUCTURE + the
// counter↔checkbox invariant on the landed file. The FULL multi-stage progression
// (the .sh's tests 2-3 "Current Stage advanced past init" / ">4 completed") is an
// LLM-paced run-to-milestone journey — that surface is owned by the live tui
// bugfix journey t-tui-t50-bugfix-scope (which drives the gates by keystroke to
// Completed>=5). FINDING surfaced, not weakened: deep
// progression lives in the tui tier; state INTEGRITY at the deterministic init
// landing lives here.
//
// THE JOURNEY (verified against the SHIPPED tool). `/aidlc --init --scope
// bugfix` on a fresh `--no-aidlc-docs` project routes through
// `aidlc-utility.ts init --scope bugfix` (SKILL.md), which writes the full
// State-Version-7 aidlc-state.md: the 3
// init stages marked [x], every other in-scope stage [ ], the Completed counter
// synced to the [x] count, and the Lifecycle Phase / Status / Last Updated /
// Active Agent / State Version fields. Init STOPs (print-terminal).
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 state file exists            -> r.stateFile !== undefined (off disk).
//   4 Completed counter == [x] count
//       -> parse the Completed field + count `- [x]` rows; assert EQUAL. This is
//          the framework integrity invariant (aidlc-state syncs them) — the .sh's
//          core "state integrity" assertion, preserved exactly.
//   5 no [x] appears after [-] (ordering preserved)
//       -> on disk: the last `- [x]` row index is BEFORE the first `- [-]` row
//          index (or no `- [-]` exists). The .sh's exact ordering check.
//   6 Lifecycle Phase field present  -> readStateField(state,"Lifecycle Phase") defined.
//   7 Status field present           -> readStateField(state,"Status") defined.
//   8 Last Updated has ISO timestamp -> the Last Updated field matches YYYY-MM-DDThh:mm:ss.
//   9 Active Agent field present     -> readStateField(state,"Active Agent") defined.
//   10 State Version is 7            -> readStateField(state,"State Version") === "7".
//   2/3 (>4 completed / advanced past init): NOT asserted here - those require
//       running the workflow to completion; the deep-progression surface is the tui
//       t50 journey. At the deterministic init landing the 3 init stages ARE [x]
//       (asserted below as the floor the .sh's >4 built on), and Current Stage is
//       a populated field (asserted via test 3's surface as "present + non-empty").
//
// Known-answer literals (read from the SHIPPED tool, not guessed):
//   - init dispatch:           SKILL.md -> `aidlc-utility.ts init --scope bugfix`
//   - State-Version-7 template: aidlc-utility.ts:2044-2097 (all the fields above)
//   - State Version literal 7:  aidlc-utility.ts:2051
//   - init-stage [x] markers:   aidlc-utility.ts:1995-1998
//   - State initialized summary: aidlc-utility.ts:2154
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout; the driver aborts a hair early so a stuck run
// surfaces a partial DriveResult, not a hang.

import { describe, expect, test } from "bun:test";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. Explicit init on Opus/Bedrock is a few minutes; honour the
// AIDLC_TEST_TIMEOUT convention. The driver aborts ~15s before bun's per-test
// cap so a stuck run surfaces a partial DriveResult to diagnose.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

const INIT_STATE_SUMMARY = "State initialized:"; // utility.ts:2154
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

/** Count `- [x]` completed-stage rows in a state-file string. */
function completedCount(stateText: string): number {
  return (stateText.match(/^- \[x\]/gm) ?? []).length;
}

describe("t52 /aidlc --init --scope bugfix state-file integrity (sdk)", () => {
  // -------------------------------------------------------------------------
  // Fresh project: the full State-Version-7 file lands at explicit init. Assert its
  // structure (counter↔checkbox invariant, ordering, every field) on the landed
  // file. Deep progression is the tui t50 journey's surface.
  // -------------------------------------------------------------------------
  test(
    "init writes a structurally sound State-Version-7 file: counter==checkboxes, ordering preserved, all fields present",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        const r = await driveAidlc("/aidlc --init --scope bugfix", {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // .sh test 1: state file exists (read off disk by sdk-drive post-run).
        expect(r.stateFile).toBeDefined();
        const state = r.stateFile as string;

        // .sh test 4: the Completed counter EQUALS the `- [x]` checkbox count —
        // the framework's core state-integrity invariant the .sh asserted.
        const counterStr = readStateField(state, "Completed");
        expect(counterStr).toBeDefined();
        const counter = Number.parseInt(counterStr as string, 10);
        expect(Number.isNaN(counter)).toBe(false);
        expect(counter).toBe(completedCount(state));

        // .sh test 5: stage ordering preserved — no `- [x]` row appears AFTER the
        // last `- [-]` in-progress row. (If there is no [-], ordering is trivially
        // valid.) Compare line indices on disk, the .sh's exact check.
        const lines = state.split("\n");
        const lastX = lines.reduce(
          (acc, l, i) => (/^- \[x\]/.test(l) ? i : acc),
          -1,
        );
        const lastInProgress = lines.reduce(
          (acc, l, i) => (/^- \[-\]/.test(l) ? i : acc),
          -1,
        );
        if (lastInProgress >= 0) {
          expect(lastX).toBeLessThan(lastInProgress);
        }

        // .sh tests 6/7/9: the Lifecycle Phase / Status / Active Agent fields are
        // present (defined) in the landed state file.
        expect(readStateField(state, "Lifecycle Phase")).toBeDefined();
        expect(readStateField(state, "Status")).toBeDefined();
        expect(readStateField(state, "Active Agent")).toBeDefined();

        // .sh test 8: Last Updated carries an ISO timestamp (YYYY-MM-DDThh:mm:ss).
        const lastUpdated = readStateField(state, "Last Updated");
        expect(lastUpdated).toBeDefined();
        expect(lastUpdated as string).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

        // .sh test 10: State Version is exactly 7.
        expect(readStateField(state, "State Version")).toBe("7");

        // The .sh's tests 2-3 floor: the 3 init stages ARE [x] (the deterministic
        // completion the ">4 completed" / "advanced past init" assertions built
        // on); Current Stage is a populated field. Deep progression past init is
        // the tui t50 journey's surface (see header), not asserted here.
        for (const stage of INIT_STAGES) {
          expect(state).toContain(`[x] ${stage}`);
        }
        const currentStage = readStateField(state, "Current Stage");
        expect(currentStage).toBeDefined();
        expect((currentStage as string).length).toBeGreaterThan(0);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
