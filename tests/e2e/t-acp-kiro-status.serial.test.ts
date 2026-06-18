// covers: file:skills/aidlc/SKILL.md
//
// t-acp-kiro-status.serial.test.ts — drive `/aidlc --status` through Kiro's
// Agent Client Protocol surface (`kiro-cli acp`) using the kiro-acp-drive
// harness driver, and assert on VERBATIM tool outputs — the structured
// "logic half" the SDK driver gives the Claude harness, no tmux, no screen.
//
// SPIKE-PROVEN (2026-06-12, kiro-cli 2.6.1): initialize → session/new
// (modes.currentModeId == the shipped `aidlc` agent) → session/prompt runs one
// full agentic turn; tool_call/tool_call_update stream the conductor's real
// engine invocations with byte-verbatim output text.
//
// SCOPE: the no-state case ONLY. With an ACTIVE workflow, the conductor may
// legitimately resume it inside the same turn (the forwarding loop lives
// in-turn on ACP — spike probe 4 watched a "status" prompt roll into real
// stage execution), so a with-state "status is read-only" assert is not
// turn-stable here; that contract is covered by the TUI twin
// (t-tui-kiro-status), where turn boundaries are human-paced.
//
// What this proves on the SHIPPED tree, structurally:
//   - the conductor ran the engine (`aidlc-orchestrate.ts next --status`) and
//     the engine emitted the print directive (verbatim JSON in tool output),
//   - the conductor then ran the named utility and its VERBATIM output carries
//     "No active AI-DLC workflow",
//   - nothing was scaffolded (status is read-only even with no state),
//   - the turn ended cleanly (stopReason end_turn).

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
    `no state: the engine's print directive and the utility's verbatim output stream through ACP${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const sandbox = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
      try {
        const r = await driveKiroAcp({
          projectDir: sandbox,
          prompt: "/aidlc --status",
          timeoutMs: Math.max(120_000, TEST_TIMEOUT_MS - 60_000),
        });

        expect(r.stopReason).toBe("end_turn");

        // The conductor consulted the engine; the print directive arrived
        // byte-verbatim in the tool output (the assertable surface — never
        // the assistant prose).
        const engineCall = r.toolCalls.find((t) =>
          t.title.includes("aidlc-orchestrate.ts next"),
        );
        expect(engineCall).toBeDefined();
        expect(engineCall!.output.join("")).toContain('"kind":"print"');

        // The conductor ran the named read-only utility; its verbatim output
        // carries the no-workflow wording (aidlc-utility.ts:186).
        const statusCall = r.toolCalls.find((t) =>
          t.title.includes("aidlc-utility.ts status"),
        );
        expect(statusCall).toBeDefined();
        expect(statusCall!.output.join("")).toContain("No active AI-DLC workflow");

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
