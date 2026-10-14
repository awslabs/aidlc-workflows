// covers: scope:bugfix, file:skills/aidlc/SKILL.md, hook:aidlc-record-human-turn, audit:GATE_APPROVED
//
// t-tui-kiro-release-journey.serial.test.ts - a person's first day with AI-DLC
// on Kiro CLI, live in the `kiro-cli chat` terminal the person runs. This is
// the Kiro CLI release pass (#1345): a maintainer runs it on the exact commit
// to be tagged, on a machine with a signed-in Kiro CLI, and records its line
// as a comment on the release-preparation PR (docs/reference/09-testing.md).
//
// The shared journey is in tests/harness/release-journey.ts: install through
// the copy channel, doctor, the documented first step, "1" at the plan
// question, "Approve" at Reverse Engineering. Kiro starts on the aidlc agent
// with its shipped tool permissions; a permission prompt gets the answer a
// person gives by pressing Enter, and the report counts them. Every line the
// person types must have a message record (Kiro ran AI-DLC's hooks), and doctor
// must no longer say the hooks never ran. Pass/fail reads only what AI-DLC
// recorded and doctor, never the agent's prose. The report (seconds per turn,
// Kiro credits, permission prompts) lands in the test's log folder and its
// one line is printed.
//
// On Linux the person's Kiro home is a scratch HOME, so ~/.kiro is never read
// or written; XDG_DATA_HOME stays the machine's, so the existing sign-in is
// used. Elsewhere Kiro runs with the machine's own home, as the other Kiro
// terminal files do.
//
// LIVE GATE: AIDLC_KIRO_TUI_LIVE=1 and AIDLC_TUI_LIVE=1, a signed-in kiro-cli,
// the selected terminal backend, and --production-guards. Not a hosted family:
// Kiro needs a signed-in identity. SPENDS KIRO CREDITS. Serial.

import { fileCleanupReserveMs, liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, remainingCleanupTimeoutMs, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  checkReleaseJourneyTurn,
  doctorChecks,
  expectPersonFirstInJourney,
  hooksRanProblems,
  RELEASE_JOURNEY_TURNS,
  type ReleaseJourneyReport,
  releaseJourneyEvidence,
  runReleaseJourney,
  setupReleaseJourneyProject,
} from "../harness/release-journey.ts";
import { assertTuiDriveKill } from "../harness/tui-fixtures.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const { bin: DRIVE_BIN, prefix: DRIVE_PREFIX } = resolveTuiRuntime(DRIVER);
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(TEST_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "E2E live work",
  })!;
}
function remainingCleanupMs(): number {
  return remainingCleanupTimeoutMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, { deadlineMs: caseDeadlineMs, phase: "E2E terminal cleanup" });
}

function drive(args: string[]): { rc: number; stdout: string } {
  const res = spawnSync(DRIVE_BIN, [...DRIVE_PREFIX, ...args], { timeout: args[0] === "kill" ? remainingCleanupMs() : remainingWorkMs(), encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "" };
}
function screen(session: string): string {
  return drive(["capture", "--session", session]).stdout;
}
function waitFor(session: string, pattern: string, timeoutMs: number, stableMs: number): boolean {
  return drive(["wait", "--session", session, "--pattern", pattern, "--timeout-ms", String(timeoutMs), "--stable-ms", String(stableMs)]).rc === 0;
}
function type(session: string, text: string): void {
  drive(["send", "--session", session, "--keys", text, "--literal", "--no-enter"]);
  drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
}

// Kiro's input footer when it waits for the person, and the credits line it
// prints at the end of every answer (this turn's and the session's credits).
const IDLE = "ask a question or describe a task";
function sessionCredits(text: string): number | undefined {
  const all = [...text.matchAll(/Credits: turn [\d.]+ \S+ session ([\d.]+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : undefined;
}

function kiroVersion(): string | null {
  const result = spawnSync("kiro-cli", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result.status === 0 ? (result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? result.stdout.trim()) : null;
}

// The runner gives this file the production guard profile on its own (it looks
// for this comparison), even in a shard of fixture-profile files.
const PRODUCTION_GUARDS = process.env.AIDLC_TEST_GUARD_PROFILE === "production";

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_TUI_LIVE !== "1") return "set AIDLC_KIRO_TUI_LIVE=1 to run the Kiro CLI release journey (uses Kiro credits)";
  if (!PRODUCTION_GUARDS) return "run with --production-guards: the journey is the person's own guard profile";
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (!kiroVersion()) return "kiro-cli not found";
  const whoami = spawnSync("kiro-cli", ["whoami"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  if (whoami.status !== 0) return "kiro-cli not signed in (run `kiro-cli login`)";
  if (!existsSync(join(REPO_ROOT, "dist", "kiro"))) return "dist/kiro is missing: run bun scripts/package.ts";
  return null;
}
const SKIP_REASON = skipReason();

describe("t-tui-kiro-release-journey: a person's first day on Kiro CLI, before each release", () => {
  test.skipIf(SKIP_REASON !== null)(
    `every line recorded, the plan question asked, Reverse Engineering approved${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const project = setupReleaseJourneyProject("kiro");
      const session = `aidlc_tui_kiro_release_${process.pid}`;
      const kiroHome = join(project.root, "kiro-home");
      mkdirSync(kiroHome, { recursive: true });
      const launch = process.platform === "linux"
        ? ["env", `HOME=${kiroHome}`, `XDG_DATA_HOME=${process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")}`, "kiro-cli", "chat"]
        : ["kiro-cli", "chat"];
      const report: ReleaseJourneyReport = { harness: "kiro", toolVersion: kiroVersion() ?? "?", turns: [], extra: {}, problems: [] };
      let prompts = 0;
      try {
        runReleaseJourney(report, () => {
          expect(drive(["start", "--session", session, "--cwd", project.proj, "--width", "200", "--height", "50", "--", ...launch]).rc).toBe(0);
          // The shipped settings make the aidlc agent the default; its name is in the status bar.
          expect(waitFor(session, "aidlc", remainingWorkMs(), 400)).toBe(true);
          expect(waitFor(session, IDLE, remainingWorkMs(), 600)).toBe(true);
          for (const [index, line] of RELEASE_JOURNEY_TURNS.entries()) {
            const before = sessionCredits(screen(session)) ?? 0;
            const started = Date.now();
            type(session, line);
            // The turn ends when Kiro prints its credits line again and waits for the person.
            let ended = false;
            while (!ended && Date.now() < caseDeadlineMs) {
              if (!waitFor(session, `${IDLE}|requires approval`, remainingWorkMs(), 1500)) continue;
              const now = screen(session);
              const bottom = now.split("\n").slice(-14).join("\n");
              if (bottom.includes("requires approval") && !bottom.includes(IDLE)) {
                prompts++;
                drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
                continue;
              }
              ended = (sessionCredits(now) ?? 0) > before;
            }
            if (!ended) report.problems.push(`"${line}" was still running when the journey's time ran out`);
            report.turns.push({ line, seconds: Math.round((Date.now() - started) / 1000) });
            if (ended) checkReleaseJourneyTurn(report, project.proj, index + 1, line);
            if (report.problems.length) break;
          }
          if (!report.problems.length) {
            report.problems.push(...hooksRanProblems(doctorChecks(project, { ...process.env, ...(process.platform === "linux" ? { HOME: kiroHome } : {}) })));
          }
          const last = screen(session);
          report.extra = { credits: sessionCredits(last) ?? 0, "permission prompts": prompts };
          if (report.problems.length) {
            report.extra.evidence = { ...releaseJourneyEvidence(project.proj), screen: last.split("\n").slice(-60).join("\n") };
          }
        });
      } finally {
        assertTuiDriveKill(drive(["kill", "--session", session]), session);
      }
      expectPersonFirstInJourney(report);
      expect(report.problems).toEqual([]);
      rmSync(project.root, { recursive: true, force: true });
    },
    TEST_TIMEOUT_MS,
  );
});
