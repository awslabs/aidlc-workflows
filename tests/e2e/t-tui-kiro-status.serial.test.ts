// covers: file:skills/aidlc/SKILL.md
//
// t-tui-kiro-status.serial.test.ts — drive `/aidlc --status` through a REAL
// `kiro-cli chat` TUI on the shipped dist/kiro tree, both with and without an
// active workflow. The Kiro twin of the t20 sdk-driver contract (status is
// read-only: it reports the state fields and mutates NOTHING), exercised
// through the print-directive arm of the forwarding loop:
//   next --status → {"kind":"print", message: run aidlc-utility status …}
//   conductor runs the named tool and prints its output, then STOPS.
//
// Cheap by design: one engine roundtrip per case, no gates, no artifacts —
// the affordable breadth-builder beside the full intent-capture journey.
// Still LIVE (real Kiro credits) so it stays behind the same opt-in flag.
//
// What each case proves on the SHIPPED tree:
//   with state    — the conductor surfaces the seeded mid-ideation fields
//                   (scope/stage strings render in the pane) and the per-intent
//                   record's state file is byte-untouched afterwards.
//   without state — the run reports no active workflow (and does NOT
//                   birth an intent or invent state).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { seededStateFile } from "../harness/fixtures.ts";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;

function drive(args: string[]): { rc: number; stdout: string } {
  const res = spawnSync(process.execPath, [DRIVER, ...args], { encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "" };
}
function waitFor(session: string, pattern: string, timeoutMs: number, stableMs: number): boolean {
  return (
    drive([
      "wait",
      "--session",
      session,
      "--pattern",
      pattern,
      "--timeout-ms",
      String(timeoutMs),
      "--stable-ms",
      String(stableMs),
    ]).rc === 0
  );
}

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_TUI_LIVE !== "1") {
    return "set AIDLC_KIRO_TUI_LIVE=1 to run the live Kiro status journeys (uses Kiro credits)";
  }
  if (IS_WIN) return "kiro TUI journey is tmux-backend only (no Windows kiro-cli path)";
  if (spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status !== 0) return "tmux not found";
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

function launch(session: string, sandbox: string): void {
  expect(
    drive([
      "start",
      "--session",
      session,
      "--cwd",
      sandbox,
      "--width",
      "200",
      "--height",
      "50",
      "--",
      "kiro-cli",
      "chat",
      "--trust-all-tools",
    ]).rc,
  ).toBe(0);
  if (waitFor(session, "Yes, I accept", 30000, 400)) {
    drive(["send", "--session", session, "--keys", "Down", "--no-enter"]);
    drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
  }
  expect(waitFor(session, "ask a question or describe a task", 60000, 600)).toBe(true);
}
function submitStatus(session: string): void {
  drive(["send", "--session", session, "--keys", "/aidlc --status", "--literal", "--no-enter"]);
  drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
}

describe("t-tui-kiro-status (read-only status through the Kiro print-directive arm)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `with state: status surfaces the seeded fields and mutates nothing${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_kiro_st1_${process.pid}`;
      const sandbox = setupTuiProject({
        harness: "kiro",
        withState: "state-brownfield-feature.md",
        withAudit: true,
      });
      const statePath = seededStateFile(sandbox);
      const stateBefore = readFileSync(statePath, "utf8");
      try {
        launch(session, sandbox);
        submitStatus(session);
        // The seeded fixture is mid-inception, scope=feature, current stage
        // requirements-analysis. The status output the conductor prints must
        // surface those strings in the pane. NOTE: the status tool renders the
        // stage DISPLAY name ("Requirements Analysis"), not the slug — it prints
        // `Current Stage:  ${stageDisplay}` from the graph entry's `name`
        // (aidlc-utility.ts:347 / :267-282), so we wait on the display name, the
        // same calibration lesson the ACP twin (t-acp-kiro-utilities) encodes.
        expect(waitFor(session, "Requirements Analysis", 240000, 0)).toBe(true);
        expect(waitFor(session, "feature", 30000, 0)).toBe(true);
        // Read-only contract: the state file is byte-identical afterwards.
        expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `no state: status reports no active workflow and scaffolds nothing${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_kiro_st2_${process.pid}`;
      const sandbox = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
      try {
        launch(session, sandbox);
        submitStatus(session);
        // The engine's no-state status path prints the utility's exact wording
        // (aidlc-utility.ts:186, verified live): "No active AI-DLC workflow".
        expect(waitFor(session, "No active AI-DLC workflow", 240000, 0)).toBe(true);
        // And it must NOT scaffold: status is read-only even with no state. The
        // seeded record was stripped (noAidlcDocs); status births nothing, so the
        // per-intent state file the seeded record would hold never appears.
        expect(existsSync(seededStateFile(sandbox))).toBe(false);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
