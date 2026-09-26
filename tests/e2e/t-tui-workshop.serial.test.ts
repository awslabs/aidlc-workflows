// t-tui-workshop.serial.tui.test.ts — drive a mini AI-DLC workshop through a
// REAL claude TUI and prove answering its AskUserQuestion gates advances state
// ON DISK (§5.1). A REWRITE (not a port) of the shipped spike
// tests/spike/t-tui-workshop.sh, which was BROKEN and never passed live: its
// MAX_ANSWERS=3 bare-Enter loop stopped BEFORE the Submit screen, so the
// affirmation never committed, yet it asserted "Way of Working populated" —
// unreachable. This rewrite uses the `answer-gate` subcommand (§3) instead: it
// answers every tab/gate and TERMINATES on the post-approval `Last Completed
// Stage` field (written atomically with GATE_APPROVED — see the spawn below for
// why the affirmation timestamp is the WRONG terminator: the t73/t74 race).
//
// What it proves:
//   - a workshop workflow starts from a freeform prompt (statusline leaves `ready`),
//   - the answer-gate clears the multi-tab practices gate + the Code Style and
//     Approval gates by taking the Recommended default per menu,
//   - answering advances REAL state on disk (the SDK and tui paths share this
//     exact disk assertion):
//       * aidlc-state.md `Practices Affirmed Timestamp` non-empty,
//       * audit.md has GATE_APPROVED >= 1,
//       * team.md `## Way of Working` populated (trunk|merge|branch),
//   - RENDER (the tui-only value-add): the captured grid showed the multi-tab
//     `Submit` strip and the `Enter to select` footer at least once — the thing
//     the SDK path cannot see.
//
// COST: spends real Bedrock tokens (minutes-long LLM turns). Gated behind
// AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it; selected TUI substrate/claude/
// distributable absence also SKIPs with a reason.
//
// Spawn tui-drive.ts using the shared runtime selector: Bun for native and
// tmux backends, Node with type stripping for explicit legacy node-pty. The
// driver subprocess remains the source of the `tui` mechanism evidence.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, remainingCleanupTimeoutMs, fileCleanupReserveMs, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const { bin: DRIVE_BIN, prefix: DRIVE_PREFIX } = resolveTuiRuntime(DRIVER);

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration
// tier sets 600). A full practices-discovery run-through is several minutes of
// real LLM turns, so the bun:test cap is generous.
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



interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[]): Run {
  const res = spawnSync(DRIVE_BIN, [...DRIVE_PREFIX, ...args], { timeout: args[0] === "kill" ? remainingCleanupMs() : remainingWorkMs(), encoding: "utf-8" });
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

// ABSENT / opt-in gating. The token guard AIDLC_TUI_LIVE=1 is checked FIRST so a
// bare --e2e (no live opt-in) reports a clear skip reason, not a substrate miss.
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live workshop (uses Bedrock tokens)";
  }
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (completedStartupProbe(spawnSync("claude", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-tui-workshop (answering AUQ gates advances disk state)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `workshop run-through commits affirmation on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_workshop_${process.pid}`;
      // setupTuiProject copies the distributable AND the sibling aidlc/ memory
      // shell (the rule layers live there post-P5) and seeds the per-intent
      // workspace shell; noAidlcDocs strips the seeded record so the live
      // `/aidlc --scope classic` auto-creates its own intent (the `ready`
      // baseline below holds because no intent resolves until creation).
      const sandbox = setupTuiProject({ noAidlcDocs: true });
      // The render value-add: we tail the grid during the run to prove the
      // multi-tab strip + footer painted at least once (the SDK path can't see it).
      let sawSubmitStrip = false;
      let sawSelectFooter = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      try {
        // --- launch (distributable already copied by setupTuiProject) ----------
        expect(drive([
          "start",
          "--session",
          session,
          "--cwd",
          sandbox,
          "--width",
          "120",
          "--height",
          "45",
          "--",
          "claude",
          "--dangerously-skip-permissions",
        ]).rc).toBe(0);

        // clear the two startup modals (idempotent — only act if present)

        const startup = drive([
          "startup", "--session", session,
          "--ready-pattern", "\\[AIDLC\\].*ready", "--timeout-ms", String(remainingWorkMs()),
        ]);
        expect(startup.rc).toBe(0);
        expect(waitFor(session, "\\[AIDLC\\].*ready", remainingWorkMs(), 800)).toBe(true);

        // --- submit the workshop prompt ---------------------------------------
        // Use EXPLICIT `--scope classic`, not bare freeform `workshop`, so this
        // journey always proves the workshop lifecycle rather than env/default
        // routing. Slash command has spaces -> send literally with no auto-Enter,
        // then Enter as a named key.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --scope classic Build a simple React todo app",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Confirm the workflow started (statusline shows a live phase, not
        // `ready`). --stable-ms 0: the screen is streaming (live token counter /
        // spinner), so match the instant the phase text appears.
        expect(
          waitFor(session, "\\[AIDLC\\].*(INITIALIZATION|IDEATION|INCEPTION)", remainingWorkMs(), 0),
        ).toBe(true);

        // Begin tailing the grid for the render assertion BEFORE answer-gate runs,
        // so we catch the multi-tab strip + footer while the gates are up.
        pollTimer = setInterval(() => {
          const grid = drive(["capture", "--session", session]).stdout;
          if (grid.includes("Submit")) sawSubmitStrip = true;
          if (grid.includes("Enter to select")) sawSelectFooter = true;
        }, 1000);

        // --- answer the gates via the shared answer-gate primitive (§3) -------
        // It answers all tabs/gates by taking the Recommended default and
        // terminates on the POST-APPROVAL state signal — NOT the bare-Enter loop
        // the broken spike used. Run it as a long-lived subprocess; its own
        // backstops error loud, so a hang surfaces as a nonzero exit.
        //
        // Terminate on `Last Completed Stage=^practices-discovery$`, NOT the
        // default `Practices Affirmed Timestamp`. This is the t73/t74
        // terminator-race (t-tui-t74:271-283), confirmed live for this journey
        // on macOS 2026-06-13: practices-discovery runs its affirmation gate as
        // Step 5 gate-start → Step 6 promote (PRACTICES_AFFIRMED) → Step 7
        // timestamp `set` → the deferred Step 5 `report --result approved`
        // (GATE_APPROVED + STAGE_COMPLETED). The conductor writes the substantive
        // promote+timestamp BEFORE closing the gate, so the timestamp lands ~1s
        // ahead of GATE_APPROVED (captured order: PRACTICES_AFFIRMED 11:03:36 →
        // timestamp 11:03:44 → GATE_APPROVED 11:03:45). The default timestamp
        // terminator therefore stopped the loop in that gap, and the immediate
        // `audit.md` read below saw GATE_APPROVED=0 — a real 0-count, not a
        // missing gate. Within the same handleApprove invocation the GATE_APPROVED
        // row is appended to audit.md (aidlc-state.ts :799) BEFORE `Last Completed
        // Stage` is flushed to aidlc-state.md by writeStateFile (:809; the :789
        // setField is in-memory only). So the moment the terminator can observe
        // `Last Completed Stage=^practices-discovery$` on disk, GATE_APPROVED is
        // already there — the GATE_APPROVED>=1 assertion below stays honest.
        const gateRc = await new Promise<number>((resolve, reject) => {
          const child = spawn(
            DRIVE_BIN,
            [
              ...DRIVE_PREFIX,
              "answer-gate",
              "--session",
              session,
              "--project-dir",
              sandbox,
              // Post-approval terminator (see above): the affirmation gate's
              // GATE_APPROVED is guaranteed downstream of this field.
              "--until-state-field",
              "Last Completed Stage=^practices-discovery$",
              // No fixed per-gate timeout; the overall timeout is the wedge backstop.
              "--overall-timeout-ms",
              String(remainingWorkMs()),
            ],
            { timeout: remainingWorkMs(), killSignal: "SIGKILL", stdio: "inherit" },
          );
          child.on("exit", (code, signal) => {
            if (code === null) {
              reject(new Error(`workshop answer-gate terminated by signal ${signal ?? "unknown"} (pid ${child.pid})`));
            } else resolve(code);
          });
          child.on("error", (error) => reject(new Error(`workshop answer-gate spawn failed: ${error.message}`)));
        });
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        expect(gateRc).toBe(0);

        // --- assert ON DISK (shared with the SDK path) ------------------------
        const stateMd = readFileSync(stateFilePathFor(sandbox), "utf8");
        // Digit-anchored: a real ISO timestamp, not an empty field (§3).
        expect(stateMd).toMatch(/Affirmed Timestamp\*\*:[ \t]*\d[^\r\n]*/);

        const auditMd = readAllAuditShards(sandbox);
        const gateApproved = auditMd
          .split("\n")
          .filter((l) => l.startsWith("**Event**: GATE_APPROVED")).length;
        expect(gateApproved).toBeGreaterThanOrEqual(1);

        // The method relocated (P5/fe7f470) from .claude/rules/aidlc-team.md to
        // the harness-neutral workspace-root aidlc/spaces/default/memory/team.md
        // (neutral basename, no aidlc- prefix). Affirmation writes the section
        // there via memoryDirFor (aidlc-state.ts:1346-1352).
        const teamRules = readFileSync(
          join(sandbox, "aidlc", "spaces", "default", "memory", "team.md"),
          "utf8",
        );
        // The shipped template ships `## Way of Working` EMPTY; affirmation
        // promotes org defaults into it (trunk|merge|branch).
        const wowIdx = teamRules.indexOf("## Way of Working");
        expect(wowIdx).toBeGreaterThanOrEqual(0);
        const wowSection = teamRules.slice(wowIdx, wowIdx + 400);
        expect(wowSection).toMatch(/trunk|merge|branch/i);

        // --- render assertion (the tui-only value-add) ------------------------
        // The captured grid showed the multi-tab strip + the select footer at
        // least once during the run — what the SDK path is blind to.
        expect(sawSubmitStrip).toBe(true);
        expect(sawSelectFooter).toBe(true);
      } finally {
        if (pollTimer) clearInterval(pollTimer);
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
