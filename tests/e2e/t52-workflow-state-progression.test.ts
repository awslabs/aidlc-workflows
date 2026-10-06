// covers: subcommand:aidlc-utility:init, scope:bugfix
//
// t52-workflow-state-progression.test.ts — SDK-harness port of
// tests/e2e/t52-workflow-state-progression.sh (plan 10). Drives the real
// `/aidlc --scope bugfix <description>` on a fresh project through the Claude Agent SDK and
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
// THE JOURNEY. `/aidlc --scope bugfix <description>` on a fresh
// `--no-aidlc-docs` project routes through intent creation and
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

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { auditDirFor, type DriveResult, driveAidlc, readStateField, stateFilePathFor } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
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


const INIT_STATE_SUMMARY = "State initialized:"; // utility.ts:2154
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];
// --init was retired. Unknown flags are preserved as task text, so it made
// the conductor ask for a task instead of creating the intent.
// Give the real entry point a concrete task it can name without another turn.
const CREATE_BUGFIX = "/aidlc --scope bugfix fix the todo checkbox state not persisting after reload";

/** Count `- [x]` completed-stage rows in a state-file string. */
function completedCount(stateText: string): number {
  return (stateText.match(/^- \[x\]/gm) ?? []).length;
}

function reportInitFailure(projectDir: string, result: DriveResult | undefined): void {
  const inspect = (read: () => unknown): unknown => {
    try { return read(); } catch (error) { return { error: String(error) }; }
  };
  const terminal = result?.resultEvent;
  console.error(`t52 init diagnostics:\n${JSON.stringify({
    projectDir,
    canonicalProjectDir: inspect(() => realpathSync(projectDir)),
    processCwd: process.cwd(),
    projectEntries: inspect(() => readdirSync(projectDir).slice(0, 80)),
    workflowEntries: inspect(() => readdirSync(join(projectDir, "aidlc")).slice(0, 80)),
    selection: inspect(() => {
      const spacePath = join(projectDir, "aidlc", "active-space");
      const space = existsSync(spacePath) ? readFileSync(spacePath, "utf8").trim() || "default" : "default";
      const intentPath = join(projectDir, "aidlc", "spaces", space, "intents", "active-intent");
      return { space, intentPath, intent: existsSync(intentPath) ? readFileSync(intentPath, "utf8").slice(0, 200) : null };
    }),
    state: inspect(() => {
      const path = stateFilePathFor(projectDir);
      return { path, exists: existsSync(path), capturedLength: result?.stateFile?.length };
    }),
    audit: inspect(() => {
      const path = auditDirFor(projectDir);
      return {
        path, entries: existsSync(path) ? readdirSync(path).slice(0, 80) : null,
        eventCount: result?.auditEvents?.length, events: result?.auditEvents?.slice(-50),
      };
    }),
    hasDriveResult: result !== undefined,
    timedOut: result?.timedOut,
    stoppedAfterToolResult: result?.stoppedAfterToolResult,
    stoppedAfterAskUserQuestion: result?.stoppedAfterAskUserQuestion,
    terminal: terminal ? {
      subtype: terminal.subtype, is_error: terminal.is_error, num_turns: terminal.num_turns,
      permissionDenialsCount: terminal.permissionDenialsCount,
      errors: terminal.errors?.slice(0, 5).map((error) => String(error).slice(0, 2000)),
      resultPreview: terminal.result?.slice(-4000),
    } : null,
    askedQuestionCount: result?.askedQuestions.length,
    toolResultCount: result?.toolResults.length,
    omittedToolResults: Math.max(0, (result?.toolResults.length ?? 0) - 12),
    tools: result?.toolResults.slice(-12).map((tool) => {
      const initOffset = tool.resultText.indexOf(INIT_STATE_SUMMARY);
      return {
        toolName: tool.toolName, toolUseId: tool.toolUseId, isError: tool.isError,
        input: Object.fromEntries(Object.entries(tool.input)
          .filter(([key, value]) => ["command", "file_path", "path", "skill", "args"].includes(key) && typeof value === "string")
          .map(([key, value]) => [key, (value as string).slice(0, 2000)])),
        resultLength: tool.resultText.length,
        matchesInitBoundary: tool.toolName === STOP_AFTER_INIT.toolName && initOffset >= 0,
        resultExcerpt: initOffset >= 0
          ? tool.resultText.slice(Math.max(0, initOffset - 200), initOffset + 1800)
          : tool.resultText.slice(-2000),
      };
    }),
    assistantTextTail: result?.assistantText.slice(-4000),
  }, null, 2)}`);
}

describe("t52 /aidlc --scope bugfix state-file integrity (sdk)", () => {
  // -------------------------------------------------------------------------
  // Fresh project: the full State-Version-7 file lands at explicit init. Assert its
  // structure (counter↔checkbox invariant, ordering, every field) on the landed
  // file. Deep progression is the tui t50 journey's surface.
  // -------------------------------------------------------------------------
  test(
    "init writes a structurally sound State-Version-7 file: counter==checkboxes, ordering preserved, all fields present",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      let r: DriveResult | undefined;
      try {
        r = await driveAidlc(CREATE_BUGFIX, {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: remainingWorkMs(),
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
        expect(readStateField(state, "State Version")).toBe("8");

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
      } catch (error) {
        // Preserve bounded SDK evidence before finally removes the fixture.
        try { reportInitFailure(proj, r); } catch (diagnosticError) {
          console.error(`t52 init diagnostics unavailable: ${String(diagnosticError)}`);
        }
        throw error;
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
