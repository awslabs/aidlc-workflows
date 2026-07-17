// covers: file:skills/aidlc/SKILL.md
//
// t-acp-kiro-status.serial.test.ts — drive `/aidlc --status` through Kiro's
// Agent Client Protocol surface (`kiro-cli acp`) using the kiro-acp-drive
// harness driver, and assert on the DETERMINISTIC surfaces that survive the
// userPromptSubmit seam — stopReason + the on-disk outcome, never the prose.
//
// SPIKE-PROVEN (2026-06-12, kiro-cli 2.6.1): initialize → session/new
// (modes.currentModeId == the shipped `aidlc` agent) → session/prompt runs one
// full agentic turn; tool_call/tool_call_update stream the conductor's tool
// invocations with byte-verbatim output text.
//
// SEAM CHANGE (why this no longer asserts tool_calls). A Kiro userPromptSubmit
// seam (agents/aidlc.json → aidlc-kiro-adapter.ts) now classifies read-only
// flags (`--status`/`--doctor`/`--help`/`--version`) as TERMINAL and runs them
// OFF-BAND inside the hook, handing the conductor the verbatim output with a
// do-NOT-advance instruction; a turn-scoped engine `done`-guard + a preToolUse
// backstop neutralize any trailing bare `next`. CONSEQUENCE: `--status` no
// longer surfaces as an `aidlc-orchestrate.ts next` or `aidlc-utility.ts status`
// ACP tool_call — the seam ran it, and the conductor only relays prose (which is
// non-deterministic, never assertable). So the only robust surfaces for this
// seam-dispatched read-only command are stopReason === "end_turn" and the
// on-disk NO-OP (status births nothing). This mirrors how the staged
// t-acp-kiro-journey-workspace leg drives terminal verbs to end_turn and asserts
// on disk rather than on stopAfterToolTitle.
//
// SCOPE: the no-state case ONLY. With an ACTIVE workflow, the conductor may
// legitimately resume it inside the same turn (the forwarding loop lives
// in-turn on ACP — spike probe 4 watched a "status" prompt roll into real
// stage execution), so a with-state "status is read-only" assert is not
// turn-stable here; that contract is covered by the TUI twin
// (t-tui-kiro-status), where turn boundaries are human-paced.
//
// BYTE-VERBATIM status output ("No active AI-DLC workflow found.", the status
// block fields) has its deterministic home in the SDK twin t20 (drives the real
// /aidlc --status and asserts the Bash tool_result bytes) AND the CLI twin t27
// (spawns aidlc-utility.ts status directly) — so dropping the ACP tool-output
// asserts loses no coverage; that surface no longer exists on the ACP path.
//
// What this proves on the SHIPPED tree, structurally:
//   - the read-only command ran (seam-dispatched off-band) and the turn ended
//     cleanly (stopReason end_turn),
//   - nothing was scaffolded (status is read-only even with no state) — the
//     on-disk no-op.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { seededStateFile } from "../harness/fixtures.ts";
import { driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "../harness/tui-fixtures.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP round-trip (uses Kiro credits)";
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

describe("t-acp-kiro-status (structured ACP round-trip on the shipped dist/kiro)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `no state: the seam-dispatched read-only --status ends the turn cleanly and scaffolds nothing${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const sandbox = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
      try {
        const r = await driveKiroAcp({
          projectDir: sandbox,
          prompt: "/aidlc --status",
          timeoutMs: Math.max(120_000, TEST_TIMEOUT_MS - 60_000),
        });

        // The seam classifies `--status` as TERMINAL and runs it OFF-BAND, so
        // no `aidlc-orchestrate.ts next` / `aidlc-utility.ts status` ACP
        // tool_call surfaces and the conductor only relays prose (never
        // assertable). The deterministic surfaces are the clean turn end and
        // the on-disk no-op. The verbatim status bytes are covered by the SDK
        // twin t20 + the CLI twin t27 (see header).
        expect(r.toolCallIssues).toEqual([]);
        expect(r.stopReason).toBe("end_turn");

        // Read-only: no state scaffolded by a status run. The seeded record was
        // stripped (noAidlcDocs); status births nothing, so the per-intent state
        // file the seeded record would hold never appears.
        expect(r.stateFile).toBeUndefined();
        expect(existsSync(seededStateFile(sandbox))).toBe(false);
      } finally {
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
