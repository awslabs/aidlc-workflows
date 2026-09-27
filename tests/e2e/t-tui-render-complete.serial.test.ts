// covers: render-surface:statusline-complete
//
// t-tui-render-complete.serial.tui.test.ts — the statusline COMPLETE sentinel
// branch (§5-C render row, §7 Phase 1), driven SEEDED-STATE in a REAL terminal
// with ZERO Bedrock tokens.
//
// The branch under test (aidlc-statusline.ts ~:230): when the seeded state's
// Status is "Completed"/"Complete" the hook prints
//   "[AIDLC] COMPLETE <completeBar>"
// where completeBar is the natural phase bar when it resolves, else a forced full
// bar. The completed fixture has OPERATION fully [x] (7/7), so progressBar(7,7)
// fills all 10 cells -> "[▓▓▓▓▓▓▓▓▓▓]". Assert the EXACT sentinel + full grid the
// branch should draw.
//
// COST: launches the claude TUI but submits NO prompt — it reaches the COMPLETE
// statusline state purely from the seeded state file, spending NO Bedrock tokens
// (the probe on 2026-06-04 verified this branch paints pre-turn on the live TUI).
// Needs the selected TUI substrate + claude + the distributable; absent any of those it SKIPs with a
// reason — never a hollow pass.
//
// Spawn tui-drive.ts using the shared runtime selector: Bun for native and
// tmux backends, Node with type stripping for explicit legacy node-pty. The
// driver subprocess remains the source of the `tui` mechanism evidence.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, remainingCleanupTimeoutMs, fileCleanupReserveMs, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTuiProjectAfterKill,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";

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
    phase: "E2E terminal work",
  })!;
}
function remainingCleanupMs(): number {
  return remainingCleanupTimeoutMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    phase: "E2E terminal cleanup",
  });
}


const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "state-completed.md");

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[]): Run {
  const { bin, prefix } = resolveTuiRuntime(DRIVER);
  const res = spawnSync(bin, [...prefix, ...args], { timeout: args[0] === "kill" ? remainingCleanupMs() : remainingWorkMs(), encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
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

function absentReason(): string | null {
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (completedStartupProbe(spawnSync("claude", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  if (!existsSync(FIXTURE)) return `fixture missing: ${FIXTURE}`;
  return null;
}
const ABSENT_REASON = absentReason();

describe("t-tui-render statusline COMPLETE sentinel (seeded completed, no tokens)", () => {
  test.skipIf(ABSENT_REASON !== null)(
    `statusline-complete paints "[AIDLC] COMPLETE [▓▓▓▓▓▓▓▓▓▓]"${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_render_complete_${process.pid}`;
      // setupTuiProject copies the distributable + sibling aidlc/ memory shell,
      // seeds the per-intent workspace shell, and writes the completed fixture
      // into the active intent's record (Status: Completed + OPERATION 7/7 -> the
      // COMPLETE branch fires with a full bar). State-driven; no prompt, no tokens.
      const sandbox = setupTuiProject({ withState: "state-completed.md" });
      try {
        // The statusLine key is what wires aidlc-statusline.ts into the TUI; a copy
        // that dropped it would render no [AIDLC] line at all.
        expect(
          readFileSync(join(sandbox, ".claude", "settings.json"), "utf8"),
        ).toContain('"statusLine"');

        // --- launch the claude TUI --------------------------------------------
        const started = drive([
          "start",
          "--session",
          session,
          "--cwd",
          sandbox,
          "--width",
          "120",
          "--height",
          "40",
          "--",
          "claude",
          "--dangerously-skip-permissions",
        ]);
        expect(started.rc).toBe(0);

        // Startup exits as soon as the target UI is ready; absent modals do not
        // consume separate timeout windows. Navigation stays fixture-scoped.
        const startup = drive([
          "startup", "--session", session,
          "--ready-pattern", "\\[AIDLC\\].*COMPLETE", "--timeout-ms", String(remainingWorkMs()),
        ]);
        if (startup.rc !== 0) throw new Error(`TUI startup failed: ${startup.stderr}`);

        // --- wait for the COMPLETE sentinel + assert the full grid ------------
        // P9: the orientation prefix ("<intent-slug> · ") sits between [AIDLC]
        // and COMPLETE, so match with .* rather than a contiguous gap.
        const sawMarker = waitFor(session, "\\[AIDLC\\].*COMPLETE", remainingWorkMs(), 1000);
        const pane = drive(["capture", "--session", session]).stdout;
        if (!sawMarker) {
          throw new Error(
            `COMPLETE statusline never appeared in the TUI.\n` +
              `---- last pane ----\n${pane}\n-------------------`,
          );
        }
        // EXACT orientation separator + sentinel + full 10-cell bar.
        expect(pane).toContain(
          "[AIDLC] fixture · COMPLETE [▓▓▓▓▓▓▓▓▓▓]",
        );
      } finally {
        cleanupTuiProjectAfterKill(
          sandbox,
          session,
          drive(["kill", "--session", session]),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});
