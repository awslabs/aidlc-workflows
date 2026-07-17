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
//           grant), then continues into intent-birth - stop at the birth
//           tool title.
//
// Disk assertions (the same P2 contract as t192/SDK + t-tui):
//   - .kiro/scopes/ gained a 10th aidlc-*.md AND scope-grid.json a 10th key
//     (the write landed THROUGH the Kiro sandbox);
//   - the born aidlc-state.md carries the composed (non-stock) scope.
//
// KNOWN RISK (plan §7): Kiro-ACP conductor forwarding is fragile (prior live
// runs dropped $ARGUMENTS / ran the wrong tool). If this leg proves flaky the
// plan authorizes an ACP-skip at P2 with re-evaluation at P5 - a red here is
// a finding to triage, never to paper over.
//
// SPENDS Kiro credits - gated AIDLC_KIRO_ACP_LIVE=1; skip-with-reason when
// unset or kiro-cli absent/unauthenticated. Serial: one live ACP session.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTuiProject,
  KIRO_SRC,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { AcpSession, driveKiroAcp } from "../harness/kiro-acp-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1800", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1800) * 1000;
// Turn 1 carries the composer dispatch (detect + read scopes + propose);
// turn 2 carries the write + birth. Split the budget.
const TURN_MS = Math.max(300_000, Math.floor((TEST_TIMEOUT_MS - 60_000) / 2));

const TASK =
  "harden the deployment pipeline and add observability for our existing service - no new features, compose a custom plan for exactly this";

const STOCK_SCOPES = new Set([
  "bugfix", "enterprise", "feature", "infra", "mvp", "poc", "refactor",
  "security-patch", "workshop",
]);

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP compose journey (uses Kiro credits)";
  }
  if (spawnSync("kiro-cli", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not found";
  }
  if (spawnSync("kiro-cli", ["whoami"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-acp-kiro compose front journey (live Kiro ACP)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `compose dispatches the composer on Kiro; approve lands the sandbox-granted write + birth${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
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
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(9);

        // --- turn 1: compose -> proposal -> gate (turn ends at the ask) -----
        const r1 = await driveKiroAcp({
          projectDir: root,
          session,
          prompt: `/aidlc compose "${TASK}"`,
          timeoutMs: TURN_MS,
          keepAlive: true,
        });
        // No write and no birth before approval (P0's no-write contract).
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(9);

        // --- turn 2: approve -> composer writes -> same-turn birth ----------
        const r2 = await driveKiroAcp({
          projectDir: root,
          session,
          prompt:
            "1 (Approve the composed plan as-is - write the scope files and start the workflow)",
          timeoutMs: TURN_MS,
          stopAfterToolTitle: /aidlc-utility\.ts intent-birth/,
          keepAlive: true,
        });
        expect([...r1.toolCallIssues, ...r2.toolCallIssues]).toEqual([]);
        const birthOut = r2.toolCalls
          .filter((t) => t.title.includes("intent-birth"))
          .map((t) => t.output.join(""))
          .join("");
        expect(birthOut).toContain("State initialized:");

        // The two-file write landed THROUGH the Kiro sandbox.
        const scopeFiles = readdirSync(scopesDir).filter(
          (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
        );
        expect(scopeFiles.length).toBe(10);
        const grid = JSON.parse(readFileSync(gridPath, "utf-8")) as Record<string, unknown>;
        expect(Object.keys(grid).length).toBe(10);
        const composed = Object.keys(grid).find((k) => !STOCK_SCOPES.has(k));
        expect(composed).toBeDefined();

        // The born state froze the composed scope.
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
