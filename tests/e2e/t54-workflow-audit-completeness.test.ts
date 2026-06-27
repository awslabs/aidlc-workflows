// covers: subcommand:aidlc-utility:init, audit:WORKFLOW_STARTED
//
// t54-workflow-audit-completeness.test.ts — SDK-harness port of
// tests/e2e/t54-workflow-audit-completeness.sh (plan 10). Drives the real
// `/aidlc --init --scope bugfix` on a fresh project through the Claude Agent SDK and
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
// THE JOURNEY (verified against the SHIPPED tool). `/aidlc --init --scope
// bugfix` on a fresh `--no-aidlc-docs` project routes through
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
//   + WORKFLOW_STARTED fired (the birth event, the audit's reason to exist):
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

import { describe, expect, test } from "bun:test";
import { assertAuditEvent } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readAuditEvents, readAuditText } from "../harness/sdk-drive.ts";

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

/** Count occurrences of a specific event type in a parsed event-type list. */
function countEvent(events: string[], event: string): number {
  return events.filter((e) => e === event).length;
}

describe("t54 /aidlc --init --scope bugfix audit completeness (sdk)", () => {
  // -------------------------------------------------------------------------
  // Fresh project: the audit.md structure lands at explicit init. Assert the header,
  // canonical field shapes, separators, ISO timestamps, no duplicate
  // SESSION_STARTED, and the init-phase event population on the landed file.
  // -------------------------------------------------------------------------
  test(
    "init writes a structurally complete audit log: header, canonical fields, separators, ISO timestamps, no duplicate SESSION_STARTED",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        const r = await driveAidlc("/aidlc --init --scope bugfix", {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // P4: audit is SHARDED per clone under <record>/audit/ (the active
        // intent's record dir), NOT the flat aidlc-docs/audit.md. readAuditText
        // resolves the born intent and concatenates its shards.
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

        // The audit's reason to exist: the WORKFLOW_STARTED birth event fired.
        assertAuditEvent(r, "WORKFLOW_STARTED");
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
