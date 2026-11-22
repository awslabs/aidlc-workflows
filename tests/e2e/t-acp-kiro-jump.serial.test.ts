// covers: subcommand:aidlc-jump:execute, audit:STAGE_JUMPED
//
// t-acp-kiro-jump.serial.test.ts — Kiro ACP port of the t25 backward-jump
// contract: from a mid-INCEPTION seeded state, `/aidlc --phase ideation`
// resolves to a BACKWARD jump targeting intent-capture (first in-scope
// ideation stage for scope=feature), made by the person's `next` itself, which
// returns Intent Capture's step in that one call (no tool call runs the jump
// tool), and the audit's STAGE_JUMPED block lands with Target/Direction lines,
// all asserted on verbatim tool output + disk, never prose.
// stopAfterToolOutput cancels the turn once that step comes back (the agent
// would otherwise run the target stage inside the same turn, the ACP
// turn-boundary edge).
//
// Known-answer literals share provenance with t25 (jump.ts,
// audit.ts): the state's Current Stage and the audit block's
// **Target**/**Direction** lines.
//
// FLAKE CLASS: t26-class LLM-tier routing flake — same as the Claude twins
// (t26 is documented flaky in docs/reference/09-testing.md's class). The
// conductor occasionally takes a non-jump path on a jump prompt; the engine's
// jump and the step it returns are deterministic (probe-verified live),
// so a red here is re-run-in-isolation before being treated as a regression.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import { driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "../harness/tui-fixtures.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

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


const TARGET_STAGE = "intent-capture";
// The step the person's `next` returns once it made the jump.
const TARGET_STEP = new RegExp(`"stage":"${TARGET_STAGE}"`);
const AUDIT_TARGET_LINE = `**Target**: ${TARGET_STAGE}`;
const AUDIT_DIRECTION_LINE = "**Direction**: BACKWARD";

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP jump contract (uses Kiro credits)";
  }
  if (completedStartupProbe(spawnSync("kiro-cli", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "kiro-cli not found";
  }
  if (completedStartupProbe(spawnSync("kiro-cli", ["whoami"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-acp-kiro-jump (backward phase jump over ACP; t26-class flake policy applies)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `--phase ideation from INCEPTION: jump executes backward to intent-capture${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({
        harness: "kiro",
        withState: "state-brownfield-feature.md", // mid-inception, scope=feature
        withAudit: true,
      });
      try {
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --phase ideation",
          timeoutMs: remainingWorkMs(),
          stopAfterToolOutput: TARGET_STEP,
        });

        expect(r.toolCallIssues).toEqual([]);
        // One engine call: an AI-DLC command returned Intent Capture's step, and
        // no tool call ran the jump tool itself. Titles are display-truncated
        // (probe-verified), so the stable stems are matched.
        expect(r.toolCalls.filter((t) => t.title.includes("aidlc-jump"))).toEqual([]);
        const step = r.toolCalls.find((t) => TARGET_STEP.test(t.output.join("")));
        expect(step?.title).toContain("aidlc");

        // Disk: the STAGE_JUMPED audit block landed with the immutable
        // Target/Direction lines (tool-owned emission).
        const audit = readAllAuditShards(proj);
        expect(audit).toContain("STAGE_JUMPED");
        expect(audit).toContain(AUDIT_TARGET_LINE);
        expect(audit).toContain(AUDIT_DIRECTION_LINE);

        const state = readFileSync(seededStateFile(proj), "utf-8");
        expect(state).toMatch(/\*\*Current Stage\*\*:[ \t]*intent-capture/);
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
