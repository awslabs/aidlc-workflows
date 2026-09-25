// covers: file:skills/aidlc/SKILL.md, file:agents/aidlc-composer-agent.md
//
// t-acp-kiro-compose-front.serial.test.ts - the P2 front-composer journey on
// Kiro-ACP: the leg that exercises what NO other harness can - the composer
// agent being DISPATCHABLE on Kiro (its hand-authored agent JSON + the
// subagent trustedAgents grant) and its framework-tree write LANDING through
// the per-agent fs_write sandbox (.kiro/scopes/** + scope-grid.json), which
// the conductor's own sandbox denies.
//
// Turn shape (ACP is single-turn; the compose gate renders as numbered prose,
// so the approve is a SECOND turn on the same keepAlive session):
//   turn 1: `/aidlc compose "<task>"` on a fresh workspace. The engine's
//           Branch 4c print names the composer; the conductor delegates via
//           the subagent tool; the composer detects + proposes; the conductor
//           renders the approve/edit/reject gate as numbered prose and the
//           turn ENDS there (cold start = no state file, so the Stop hook
//           allows the turn-end).
//   turn 2: "1" (Approve). The conductor re-dispatches the composer to write
//           the two scope files (INSIDE the composer agent - the sandbox
//           grant), then continues into intent-create - stop at the creation
//           tool title.
//
// Disk assertions (the same P2 contract as t192/SDK + t-tui):
//   - .kiro/scopes/ gained a 10th aidlc-*.md AND scope-grid.json a 10th key
//     (the write landed THROUGH the Kiro sandbox);
//   - the created aidlc-state.md carries the composed (non-stock) scope.
//
// KNOWN RISK (plan §7): Kiro-ACP conductor forwarding is fragile (prior live
// runs dropped $ARGUMENTS / ran the wrong tool). If this leg proves flaky the
// plan authorizes an ACP-skip at P2 with re-evaluation at P5 - a red here is
// a finding to triage, never to paper over.
//
// SPENDS Kiro credits - gated AIDLC_KIRO_ACP_LIVE=1; skip-with-reason when
// unset or kiro-cli absent/unauthenticated. Serial: one live ACP session.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTuiProject,
  KIRO_SRC,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { AcpSession, driveKiroAcp } from "../harness/kiro-acp-drive.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
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

// Turn 1 carries the composer dispatch (detect + read scopes + propose);
// turn 2 carries the write + creation. Both draw on the remaining case time.

const TASK =
  "harden the deployment pipeline and add observability for our existing service - no new features, compose a custom plan for exactly this";
const INTENT_CREATE_TOOL_TITLE =
  /\baidlc(?:\.ts)?\s+engine\s+intent\s+create(?:\s|$)/;

const STOCK_SCOPES = new Set([
  "bugfix", "enterprise", "feature", "infra", "mvp", "poc", "refactor",
  "security-patch", "classic", "workshop", "express",
]);

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP compose journey (uses Kiro credits)";
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

describe("t-acp-kiro compose front journey (live Kiro ACP)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `compose dispatches the composer on Kiro; approve lands the sandbox-granted write + creation${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const root = setupTuiProject({
        harness: "kiro",
        brownfieldStub: true,
        noAidlcDocs: true,
      });
      const session = new AcpSession(root, "aidlc", true);
      try {
        const scopesDir = join(root, ".kiro", "scopes");
        const gridPath = join(root, ".kiro", "tools", "data", "scope-grid.json");
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(11);

        // --- turn 1: compose -> proposal -> gate (turn ends at the ask) -----
        const r1 = await driveKiroAcp({
          projectDir: root,
          session,
          prompt: `/aidlc compose "${TASK}"`,
          timeoutMs: remainingWorkMs(),
          keepAlive: true,
        });
        // No write and no creation before approval (P0's no-write contract).
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(11);

        // --- turn 2: approve -> composer writes -> same-turn creation ----------
        const r2 = await driveKiroAcp({
          projectDir: root,
          session,
          prompt:
            "1 (Approve the composed plan as-is - write the scope files and start the workflow)",
          timeoutMs: remainingWorkMs(),
          stopAfterToolTitle: INTENT_CREATE_TOOL_TITLE,
          keepAlive: true,
        });
        expect([...r1.toolCallIssues, ...r2.toolCallIssues]).toEqual([]);
        const creationOutput = r2.toolCalls
          .filter((t) => INTENT_CREATE_TOOL_TITLE.test(t.title))
          .map((t) => t.output.join(""))
          .join("");
        expect(creationOutput).toContain("State initialized:");

        // The two-file write landed THROUGH the Kiro sandbox.
        const scopeFiles = readdirSync(scopesDir).filter(
          (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
        );
        expect(scopeFiles.length).toBe(12);
        const grid = JSON.parse(readFileSync(gridPath, "utf-8")) as Record<string, unknown>;
        expect(Object.keys(grid).length).toBe(12);
        const composed = Object.keys(grid).find((k) => !STOCK_SCOPES.has(k));
        expect(composed).toBeDefined();

        // The created state froze the composed scope.
        const spaceCursor = join(root, "aidlc", "active-space");
        const space = existsSync(spaceCursor)
          ? readFileSync(spaceCursor, "utf-8").trim() || "default"
          : "default";
        const intentsDir = join(root, "aidlc", "spaces", space, "intents");
        const rec = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
        const state = readFileSync(join(intentsDir, rec, "aidlc-state.md"), "utf-8");
        expect(state).toContain(`- **Scope**: ${composed}`);
      } finally {
        session.close();
        cleanupTuiProject(root);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
