// covers: scope:poc
//
// t-tui-t51-poc-scope.serial.test.ts - drive the POC-scope workflow through a
// REAL claude TUI and prove that answering its rendered AskUserQuestion gates by
// keystroke advances POC to a real on-disk milestone (section 5.1).
// This drives the painted TUI
// like a human, answers each gate by Enter (the Recommended default), and
// TERMINATES on the on-disk `Completed>=7` milestone.
//
// What it proves (PATTERN B — multi-gate journey, answer-gate --until-state-field):
//   - a POC workflow starts from `/aidlc --scope poc <description>` on a fresh
//     greenfield workspace (statusline leaves `ready` for a live phase),
//   - the answer-gate clears the gates by taking
//     the Recommended default per menu, with NO auto-approve,
//   - answering advances REAL state on disk
//     (POC, unlike bugfix, includes intent-capture):
//       * the intent-capture intent-statement artifact exists & is non-empty,
//       * the created intent's aidlc-state.md records the `poc` scope and a greenfield
//         classification,
//       * <record>/ideation/ exists with a questions file carrying filled
//         [Answer]: lines and at least one structured (heading-bearing) artifact,
//       * MORE than 6 stages are marked complete `- [x]`,
//       * audit shards have substantial content,
//   - RENDER (the tui-only value-add): the captured grid showed a gate menu
//     (the highlighted-option caret + the `Enter to select` / `Submit answers`
//     footer) at least once - the thing the SDK path cannot see.
//
// WHY PATTERN B (not A): poc is a MULTI-STEP journey,
// gate-by-gate, not a single landed jump. Per the driver-split invariant, every
// multi-step journey is TUI-driven; a one-shot SDK check would have to
// auto-approve the gates.
//
// WHY a MILESTONE terminator (not full poc completion):
// We terminate the answer-gate on the
// `Completed>=7` state milestone, then assert the `> 6 completed` invariant on
// disk. We do NOT crank the budget to chase full poc completion — that would be
// racy/over-reach. If a reviewer needs full poc completion
// proven, that is a SEPARATE, longer journey and the unreachable-in-budget gap is a
// FINDING, not a thing to weaken to.
//
// The intent-artifact "mentions Todo/task" check is
// NOT hard-asserted here (LLM output varies); the
// greenfield-todo stub is a React Todo README, so the domain is present, but the
// assertion is on STRUCTURE (headings + size + answers),
// not on a specific domain word.
//
// COST: spends real Bedrock tokens (minutes-long LLM turns across the lifecycle).
// Gated behind AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it;
// selected TUI substrate/claude/distributable absence also
// SKIP with a reason — never a hollow pass.
//
// Spawn tui-drive.ts using the shared runtime selector for the native Bun and
// POSIX tmux backends. The driver subprocess remains the source of the `tui`
// mechanism evidence.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, remainingCleanupTimeoutMs, fileCleanupReserveMs, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAuditText, recordDirFor, stateFilePathFor } from "../harness/sdk-drive.ts";
import { gridHasMenu } from "../harness/tui-drive.ts";
import { runTuiDriverWithinBudget } from "../harness/tui-time-budget.ts";
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

// Hang-backstop, NOT a budget. The poc `Completed>6` milestone requires driving
// the poc chain for real: intent-capture, requirements-analysis, then the heavy
// code-generation (writes the actual app) and build-and-test stages. The
// journey TERMINATES on the on-disk `Completed` signal (never a timer); this cap
// only ever fires as a loud hang-backstop. The default comes from
// liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS): the work allowance plus the
// fixture, startup and cleanup allowances. A tight per-journey budget is exactly
// what we DON'T want - it false-fires on a slow platform (the t101 900s clip).
// If this backstop fires, that is a real hang FINDING, not a knob to turn.
// AIDLC_TEST_TIMEOUT (seconds) overrides per run.
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
    return "set AIDLC_TUI_LIVE=1 to run the live poc journey (uses Bedrock tokens)";
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

describe("t-tui-t51-poc-scope (answering gates advances poc Ideation on disk)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `poc run-through produces the intent-capture artifact + > 6 completed stages on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const testDeadlineMs = performance.now() + TEST_TIMEOUT_MS;
      const session = `aidlc_tui_t51_poc_${process.pid}`;
      // greenfieldStub + noAidlcDocs: a brand-new greenfield workspace the poc
      // workflow scaffolds itself.
      const sandbox = setupTuiProject({ greenfieldStub: true, noAidlcDocs: true });
      // The render value-add: we tail the grid during the run to prove a gate
      // menu painted at least once (the SDK path can't see it).
      let sawMenu = false;
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
        // Fresh project (no seeded state) -> the no-workflow "ready" line.
        expect(waitFor(session, "\\[AIDLC\\].*ready", remainingWorkMs(), 800)).toBe(true);

        // --- submit the poc workflow command -----------------------------------
        // Send literally with no auto-Enter, then Enter as a named key (robust for
        // slash commands). Use EXPLICIT `--scope poc`. The shipped settings.json pins
        // AWS_AIDLC_DEFAULT_SCOPE=classic, so the explicit flag keeps this test on the
        // poc LIFECYCLE without relying on default-scope resolution. The trailing
        // description satisfies the free-text "what to build?" prompt up front (the
        // answer-gate cannot type free text).
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --scope poc Build a simple React todo app",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Confirm the workflow started (statusline shows a live phase, not
        // `ready`). poc begins in INITIALIZATION and advances into IDEATION.
        // --stable-ms 0: the screen is streaming (live token counter / spinner),
        // so match the instant the phase text appears.
        expect(
          waitFor(session, "\\[AIDLC\\].*(INITIALIZATION|IDEATION|INCEPTION)", remainingWorkMs(), 0),
        ).toBe(true);

        // Begin tailing the grid for the render assertion BEFORE answer-gate runs,
        // so we catch a gate menu (caret + footer) while the gates are up. Use the
        // shared gridHasMenu(), which requires the exact `❯` caret in both
        // reconstructed backends.
        pollTimer = setInterval(() => {
          const grid = drive(["capture", "--session", session]).stdout;
          if (gridHasMenu(grid)) {
            sawMenu = true;
          }
        }, 1000);

        // --- answer the gates via the shared answer-gate primitive (section 3) --------
        // It answers all tabs/gates by taking the Recommended default and
        // TERMINATES on the on-disk STATE PROGRESSION the assertions below check:
        // `Completed` reaching > 6. The intent-statement *file* lands mid-intent-capture
        // (poc's 4th EXECUTE stage) - terminating on it stops the gate loop at
        // Completed approximately 3-4, BEFORE the >6 milestone, so the assertion would
        // fail (the t73 terminator race; mirrors t50's `Completed=...` state-field
        // terminator). poc's EXECUTE chain is workspace-scaffold/detection/state-init
        // -> intent-capture -> reverse-engineering -> requirements-analysis ->
        // code-generation/build-and-test (8 total before conditional skips), so
        // requirements-analysis alone does not reach the >=7 completed milestone.
        // Anchored to a real >=7 value.
        // Run it as a long-lived subprocess; its own backstops error loud, so a
        // hang surfaces as a nonzero exit (never a manufactured pass; an unreachable
        // milestone in budget is a FINDING, not a thing to soften).
        // Startup consumes the same test deadline. Reserve time for finally;
        // the parent watchdog also bounds a driver that does not exit itself.
        const gateRc = await runTuiDriverWithinBudget(testDeadlineMs, (driverTimeoutMs) =>
          spawn(
            DRIVE_BIN,
            [
              ...DRIVE_PREFIX,
              "answer-gate",
              "--session",
              session,
              "--project-dir",
              sandbox,
              "--until-state-field",
              "Completed=^([7-9]|[1-9][0-9])$",
              // NO per-gate timeout. The pass condition is the on-disk terminator
              // (Completed>=7); the loop returns the instant it lands. poc's EXECUTE
              // chain includes the reverse-engineering `mode: pipeline` stage, which
              // legitimately runs minutes with no menu and runs slower on the Windows
              // box — a fixed per-gate value is a budget masquerading as a backstop and
              // false-fires on a working run. Omitting it defaults per-gate to the
              // overall deadline (one wedge-only backstop); the overall timeout bounds
              // the journey and bun's test cap is the hard ceiling above it.
              "--overall-timeout-ms",
              String(driverTimeoutMs),
            ],
            { timeout: remainingWorkMs(), killSignal: "SIGKILL", stdio: "inherit" },
          ),
        );
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        expect(gateRc).toBe(0);

        // --- assert ON DISK -----------
        const stateMd = readFileSync(stateFilePathFor(sandbox), "utf8");

        expect(stateMd).toMatch(/poc/i);
        expect(stateMd).toMatch(/greenfield/i);
        const completed = stateMd.split("\n").filter((l) => /^- \[x\]/.test(l)).length;
        expect(completed).toBeGreaterThan(6);

        // Ideation directory created (POC includes ideation).
        const ideationDir = join(recordDirFor(sandbox), "ideation");
        expect(existsSync(ideationDir) && statSync(ideationDir).isDirectory()).toBe(true);

        const icDir = join(ideationDir, "intent-capture");
        expect(existsSync(icDir) && statSync(icDir).isDirectory()).toBe(true);

        const intentFile = readdirSync(icDir).find(
          (f) => /intent.*statement|intent-statement/i.test(f),
        );
        expect(intentFile).toBeDefined();
        expect(
          readFileSync(join(icDir, intentFile as string), "utf8").trim().length,
        ).toBeGreaterThan(0);

        // An intent-capture questions file exists and carries
        // filled [Answer]: lines (proves the gate answers were captured to disk,
        // not auto-stubbed). Look across the ideation tree.
        const questionsFile = findFirst(ideationDir, (name) => /questions/i.test(name));
        expect(questionsFile).not.toBeNull();
        const questionsMd = readFileSync(questionsFile as string, "utf8");
        // Filled answers (an [Answer]: line with at least one letter).
        const filledAnswers = questionsMd
          .split("\n")
          .filter((l) => /\[Answer\]:.*[A-Za-z]/.test(l)).length;
        expect(filledAnswers).toBeGreaterThan(0);

        const headingFile = findFirst(
          ideationDir,
          () => true,
          (md) => /^#/m.test(md),
        );
        expect(headingFile).not.toBeNull();

        const bigArtifact = findFirst(
          ideationDir,
          (name) => name.endsWith(".md"),
          (_md, size) => size > 100,
        );
        expect(bigArtifact).not.toBeNull();

        // The audit is sharded per clone; readAuditText concatenates the shards.
        expect(readAuditText(sandbox).length).toBeGreaterThan(200);

        // --- render assertion (the tui-only value-add) ------------------------
        // The captured grid showed a gate menu (caret + footer) at least once
        // during the run — what the SDK path is blind to. NOT a racy completion
        // assertion: it only records that a menu painted while gates were up.
        expect(sawMenu).toBe(true);
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

// Walk a directory tree and return the absolute path of the first file matching
// nameMatch (on the basename) AND, optionally, contentMatch (on the file text +
// byte size). Recursive, depth-first, in readdirSync order. Returns null
// if nothing matches (so the caller's expect(...).not.toBeNull() FAILS loud
// rather than silently passing — IRON RULE: a miss is a finding).
function findFirst(
  root: string,
  nameMatch: (basename: string) => boolean,
  contentMatch?: (text: string, size: number) => boolean,
): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const hit = findFirst(p, nameMatch, contentMatch);
      if (hit) return hit;
    } else if (st.isFile() && nameMatch(entry)) {
      if (!contentMatch) return p;
      try {
        if (contentMatch(readFileSync(p, "utf8"), st.size)) return p;
      } catch {
        // unreadable — skip
      }
    }
  }
  return null;
}
