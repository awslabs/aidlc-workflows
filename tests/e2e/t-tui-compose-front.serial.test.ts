// covers: file:skills/aidlc/SKILL.md, file:agents/aidlc-composer-agent.md
//
// t-tui-compose-front.serial.test.ts - the P2 front-composer journey through a
// REAL claude TUI (the render half of what t192 proves on the SDK): drive
// `/aidlc compose "<task>"` on a fresh workspace, answer the rendered
// approve/edit/reject gate by keystroke (Enter = the leading option, which the
// SKILL.md composer block pins to Approve), and TERMINATE on the created state
// landing on disk.
//
// What it proves on the SHIPPED tree that the SDK path cannot see: the compose
// gate RENDERS as a real AskUserQuestion menu a human answers, and answering
// it drives the write + same-turn creation - one /aidlc invocation, keystrokes
// only.
//
// Disk assertions (the same P2 contract t192 pins):
//   - a 10th scope .md + a 10th scope-grid.json key exist (the two-file write),
//   - the created aidlc-state.md carries the composed (non-stock) scope.
//
// SPENDS Claude credits - gated behind AIDLC_TUI_LIVE=1 with skip-reasons;
// The selected native TUI backend supplies the terminal on each supported OS.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, remainingCleanupTimeoutMs, fileCleanupReserveMs, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateFilePathFor } from "../harness/sdk-drive.ts";
import {
  cleanupTuiProjectAfterKill,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const { bin: DRIVE_BIN, prefix: DRIVE_PREFIX } = resolveTuiRuntime(DRIVER);

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
function remainingCleanupMs(): number {
  return remainingCleanupTimeoutMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    phase: "E2E terminal cleanup",
  });
}



const TASK =
  "harden the deployment pipeline and add observability for our existing service - no new features, compose a custom plan for exactly this";

const STOCK_SCOPES = new Set([
  "bugfix", "enterprise", "feature", "infra", "mvp", "poc", "refactor",
  "security-patch", "classic", "workshop", "express",
]);

function drive(args: string[]): { rc: number; stdout: string } {
  const res = spawnSync(DRIVE_BIN, [...DRIVE_PREFIX, ...args], { timeout: args[0] === "kill" ? remainingCleanupMs() : remainingWorkMs(), encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "" };
}
function waitFor(session: string, pattern: string, timeoutMs: number, stableMs: number): boolean {
  return (
    drive([
      "wait", "--session", session, "--pattern", pattern,
      "--timeout-ms", String(timeoutMs), "--stable-ms", String(stableMs),
    ]).rc === 0
  );
}

function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live compose TUI journey (uses Claude credits)";
  }
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (completedStartupProbe(spawnSync("claude", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "claude CLI not found";
  }
  return null;
}
const SKIP_REASON = skipReason();

describe("t-tui compose front journey (live claude TUI)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `/aidlc compose renders the gate; answering creates the composed scope${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_compose_${process.pid}`;
      const sandbox = setupTuiProject({ brownfieldStub: true, noAidlcDocs: true });
      try {
        expect(drive([
          "start", "--session", session, "--cwd", sandbox,
          "--width", "120", "--height", "45",
          "--", "claude", "--dangerously-skip-permissions",
        ]).rc).toBe(0);

        const startup = drive([
          "startup", "--session", session,
          "--ready-pattern", "\\[AIDLC\\].*ready", "--timeout-ms", String(remainingWorkMs()),
        ]);
        expect(startup.rc).toBe(0);
        expect(waitFor(session, "\\[AIDLC\\].*ready", remainingWorkMs(), 800)).toBe(true);

        drive([
          "send", "--session", session, "--keys",
          `/aidlc compose "${TASK}"`,
          "--literal", "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Answer every rendered gate with the leading (Recommended/Approve)
        // option; terminate the moment the created state carries ANY Scope field
        // (creation = the journey's last deterministic mutation). No per-gate
        // timeout - the disk terminator is the pass condition.
        const gateRc = await new Promise<number>((resolve) => {
          const child = spawn(
            DRIVE_BIN,
            [
              ...DRIVE_PREFIX, "answer-gate",
              "--session", session,
              "--project-dir", sandbox,
              "--until-state-field", "Scope=\\S+",
              "--overall-timeout-ms", String(remainingWorkMs()),
            ],
            { timeout: remainingWorkMs(), killSignal: "SIGKILL", stdio: "inherit" },
          );
          child.on("exit", (code) => resolve(code ?? -1));
          child.on("error", () => resolve(-1));
        });
        expect(gateRc).toBe(0);

        // The two-file write landed: a 12th scope .md + a 12th grid key.
        const scopesDir = join(sandbox, ".claude", "scopes");
        const scopeFiles = readdirSync(scopesDir).filter(
          (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
        );
        expect(scopeFiles.length).toBe(12);
        const grid = JSON.parse(
          readFileSync(join(sandbox, ".claude", "tools", "data", "scope-grid.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect(Object.keys(grid).length).toBe(12);
        const composed = Object.keys(grid).find((k) => !STOCK_SCOPES.has(k));
        expect(composed).toBeDefined();

        // The created state froze the composed scope.
        const stateMd = readFileSync(stateFilePathFor(sandbox), "utf8");
        expect(stateMd).toContain(`- **Scope**: ${composed}`);
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
