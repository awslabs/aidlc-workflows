// covers: hook:aidlc-statusline
// Windows startup bounds are independently selectable for strict nightly coverage.
import { fileCleanupReserveMs, liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { absentReason, captureOrientationStatusline } from "../harness/tui-orientation.ts";

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);

const IS_WIN = process.platform === "win32";
const DRIVER = join(import.meta.dir, "../harness/tui-drive.ts");
const ABSENT_REASON = absentReason({ command: ["claude", "--dangerously-skip-permissions"] });
// No fixed wall-clock bound: how fast a hosted runner starts Claude Code is not
// AI-DLC's, and the startup loop returning at once is pinned by
// t-startup-state-machine. Each launch must paint and reap its process tree.
const WINDOWS_SAMPLE_COUNT = 3;
const samples = () => {
  const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
  const reserveMs = fileCleanupReserveMs(TEST_TIMEOUT_MS);
  return Array.from({ length: WINDOWS_SAMPLE_COUNT }, (_, index) => captureOrientationStatusline(index + 1, {
    driver: DRIVER,
    command: ["claude", "--dangerously-skip-permissions"],
    deadlineMs,
    reserveMs,
  }));
};

describe("t-tui-journey-orientation Windows startup", () => {
  test.skipIf(ABSENT_REASON !== null || !IS_WIN)(
    "three native Windows launches paint the orientation statusline and reap each process tree" +
      `${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : !IS_WIN ? " — SKIP: Windows-only" : ""}`,
    () => {
      // captureOrientationStatusline fails a launch that never paints within its
      // startup budget or does not reap its process tree and fixture.
      const observed = samples();
      expect(observed).toHaveLength(WINDOWS_SAMPLE_COUNT);
    },
    TEST_TIMEOUT_MS,
  );
});
