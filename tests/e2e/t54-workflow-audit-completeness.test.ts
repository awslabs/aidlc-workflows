// covers: subcommand:aidlc-utility:init, audit:WORKFLOW_STARTED
//
// t54-workflow-audit-completeness.test.ts — SDK-harness port of
// tests/e2e/t54-workflow-audit-completeness.sh (plan 10). Drives the real
// `/aidlc --scope bugfix <description>` on a fresh project through the Claude Agent SDK and
// asserts ONLY on deterministic surfaces — the on-disk audit.md structure (the
// AI-DLC Audit Log header, the canonical **Event**:/**Timestamp**: field shapes,
// the `---` block separators, ISO timestamps, no duplicate SESSION_STARTED) and
// the parsed audit events — NEVER on assistantText.
//
// ⛔ TRAP 2 (no headless auto-approve). This twin's subject is "audit trail
// COMPLETENESS: structure, timestamps, no duplicates":
// the audit.md STRUCTURE is written DETERMINISTICALLY by explicit init + the
// audit emitter (aidlc-audit.ts block format), BEFORE any gate. So this twin
// drives the init turn, stops the instant the init stdout lands, and asserts the
// audit STRUCTURE on the landed file.
//
// THE ONE DROPPED .sh ASSERTION (faithfully, not weakened). The .sh's test 4
// tagged canonical events with an extra per-event field that the engine no
// longer emits, so there is nothing to assert. Dropping it here loses NO real
// coverage: the field is gone from the engine entirely.
//
// THE JOURNEY. `/aidlc --scope bugfix <description>` on a fresh
// `--no-aidlc-docs` project routes through intent creation and
// `aidlc-utility.ts init --scope bugfix` (SKILL.md). init bootstraps audit.md
// with the `# AI-DLC Audit Log`
// header (utility.ts:1777), then appends WORKFLOW_STARTED + the init-phase events
// (PHASE_STARTED, STAGE_STARTED/COMPLETED ×3, WORKSPACE_*), each a canonical
// aidlc-audit block (## heading / **Timestamp**: / **Event**: / fields / `---`).
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 audit file exists            -> the per-intent audit shard text is non-empty
//                                     (P4 shards audit under <record>/audit/; read
//                                     via readAuditText, NOT flat aidlc-docs/audit.md).
//   2 audit > 200 bytes            -> the merged audit-shard text length > 200.
//   3 >= 3 STAGE_COMPLETED entries -> the parsed auditEvents carry >= 3
//                                     STAGE_COMPLETED (the 3 init stages complete
//                                     at init; the .sh's assert_gt 2). Stronger:
//                                     typed **Event** parse, not a substring grep.
//   5 entries have ISO timestamps  -> the raw audit.md contains >= 1 ISO timestamp
//                                     (YYYY-MM-DDThh:mm:ssZ); the .sh's assert_gt 0.
//   6 no duplicate SESSION_STARTED -> the count of SESSION_STARTED in the parsed
//                                     events is <= 1 (the .sh's exact bound; init
//                                     no longer emits a bootstrap SESSION_STARTED,
//                                     utility.ts:1770-1774).
//   7 Audit Log header             -> raw audit.md contains "AI-DLC Audit Log"
//                                     (utility.ts:1777).
//   8 Timestamp fields             -> raw audit.md contains "**Timestamp**:"
//                                     (audit block format; the .sh's grep).
//   9 horizontal-rule separators   -> raw audit.md contains >= 1 line starting `---`.
//   10 multiple audit events       -> the parsed auditEvents length > 2 (the .sh's
//                                     `grep -ciE '**Event**:'` assert_gt 2).
//   4 (per-event tag): DROPPED, the field is gone from the engine (see header).
//   + WORKFLOW_STARTED fired (the creation event, the audit's reason to exist):
//       -> assertAuditEvent(r,"WORKFLOW_STARTED").
//
// Known-answer literals (read from the SHIPPED tool, not guessed):
//   - init dispatch:            SKILL.md -> `aidlc-utility.ts init --scope bugfix`
//   - audit header bootstrap:   aidlc-utility.ts:1777 ("# AI-DLC Audit Log")
//   - no bootstrap SESSION_STARTED: aidlc-utility.ts:1770-1774
//   - WORKFLOW_STARTED emit:    aidlc-utility.ts:1784
//   - audit block shape:        aidlc-audit.ts (## heading / **Timestamp**: / **Event**: / --- )
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout; the driver aborts a hair early so a stuck run
// surfaces a partial DriveResult, not a hang.

import { liveCaseTimeoutMs } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertAuditEvent } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { auditDirFor, type DriveResult, driveAidlc, readAuditEvents, readAuditText, stateFilePathFor } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Work allowance follows AIDLC_TEST_TIMEOUT (seconds). Existing per-turn
// limits are preserved; the shared profile adds fixture, startup and teardown
// reserves before Bun's case ceiling.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const LIVE_WORK_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, LIVE_WORK_TIMEOUT_MS - 15_000);
// Preserve the existing work allowance and reserve fixture/startup/cleanup separately.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(Math.max(LIVE_WORK_TIMEOUT_MS, DRIVE_TIMEOUT_MS));

const INIT_STATE_SUMMARY = "State initialized:"; // utility.ts:2154
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
// The retired --init flag became an unknown task word and elicited a question
// instead of intent creation. Exercise the supported entry point with a task.
const CREATE_BUGFIX = "/aidlc --scope bugfix fix the todo checkbox state not persisting after reload";

/** Count occurrences of a specific event type in a parsed event-type list. */
function countEvent(events: string[], event: string): number {
  return events.filter((e) => e === event).length;
}

function reportInitFailure(projectDir: string, result: DriveResult | undefined): void {
  const inspect = (read: () => unknown): unknown => {
    try { return read(); } catch (error) { return { error: String(error) }; }
  };
  const terminal = result?.resultEvent;
  console.error(`t54 init diagnostics:\n${JSON.stringify({
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

describe("t54 /aidlc --scope bugfix audit completeness (sdk)", () => {
  // -------------------------------------------------------------------------
  // Fresh project: the audit.md structure lands at explicit init. Assert the header,
  // canonical field shapes, separators, ISO timestamps, no duplicate
  // SESSION_STARTED, and the init-phase event population on the landed file.
  // -------------------------------------------------------------------------
  test(
    "init writes a structurally complete audit log: header, canonical fields, separators, ISO timestamps, no duplicate SESSION_STARTED",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      let r: DriveResult | undefined;
      try {
        r = await driveAidlc(CREATE_BUGFIX, {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // P4: audit is SHARDED per clone under <record>/audit/ (the active
        // intent's record dir), NOT the flat aidlc-docs/audit.md. readAuditText
        // resolves the created intent and concatenates its shards.
        const auditRaw = readAuditText(proj);

        // .sh test 1: audit exists (the merged shard text is non-empty).
        expect(auditRaw.length).toBeGreaterThan(0);

        // .sh test 2: audit > 200 bytes (merged shard text length).
        expect(auditRaw.length).toBeGreaterThan(200);

        const events = readAuditEvents(proj) ?? [];

        // .sh test 7: the AI-DLC Audit Log header.
        expect(auditRaw).toContain("AI-DLC Audit Log");

        // .sh test 8: canonical **Timestamp**: field shape present.
        expect(auditRaw).toContain("**Timestamp**:");

        // .sh test 9: horizontal-rule block separators present.
        expect(auditRaw.split("\n").some((l) => l.startsWith("---"))).toBe(true);

        // .sh test 5: at least one ISO timestamp (YYYY-MM-DDThh:mm:ssZ).
        expect(auditRaw).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);

        // .sh test 10: multiple audit events logged (the .sh's assert_gt 2).
        expect(events.length).toBeGreaterThan(2);

        // .sh test 3: >= 3 STAGE_COMPLETED (the 3 init stages; assert_gt 2). Typed
        // **Event** parse, stronger than a substring grep.
        expect(countEvent(events, "STAGE_COMPLETED")).toBeGreaterThanOrEqual(3);

        // .sh test 6: no duplicate SESSION_STARTED (the .sh's <= 1 bound).
        expect(countEvent(events, "SESSION_STARTED")).toBeLessThanOrEqual(1);

        // The audit's reason to exist: the WORKFLOW_STARTED creation event fired.
        assertAuditEvent(r, "WORKFLOW_STARTED");
      } catch (error) {
        // Preserve bounded SDK evidence before finally removes the fixture.
        try { reportInitFailure(proj, r); } catch (diagnosticError) {
          console.error(`t54 init diagnostics unavailable: ${String(diagnosticError)}`);
        }
        throw error;
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
