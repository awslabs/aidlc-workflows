// covers: scope:bugfix
//
// t-tui-kiro-bugfix-scope.serial.test.ts — the Kiro twin of
// t-tui-t50-bugfix-scope: drive the BUGFIX-scope workflow through a REAL
// keystroke-driven `kiro-cli chat` on the shipped dist/kiro tree, answering
// the known Q1-Q4 guide batch with explicit per-question numbers, confirming
// the consolidated summary, and answering the mandatory learnings prompt before
// each separate approval prompt. It then TERMINATES on the
// on-disk Completed counter crossing the post-init milestone — the same
// milestone the Claude twin (and its .sh ancestor) pinned: init=3 + >=2
// Inception stages = Completed >= 5.
//
// The gate loop is the kiro-intent-capture pattern (idle footer → classify and
// answer the visible prompt → re-check disk): disk is the terminator, never the
// screen. The shared classifier rejects a learning+approval combined prompt.
//
// What it proves on the SHIPPED tree:
//   - `/aidlc bugfix <description>` on a fresh BROWNFIELD workspace detects
//     brownfield, skips Ideation (bugfix scope), and runs Initialization +
//     early Inception with real keystroke-answered gates,
//   - state: scope=bugfix, Project Type=Brownfield, Completed >= 5 and ==
//     the count of [x] lines,
//   - audit: WORKFLOW_STARTED + >=1 GATE_APPROVED (a human-shaped approval
//     actually landed).
//
// COST: the long Kiro journey (the Claude twin budgets 2400s). Gated behind
// AIDLC_KIRO_TUI_LIVE=1 with skip-reasons; tmux-backend only.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { recordDirFor, stateFilePathFor } from "../harness/sdk-drive.ts";
import {
  cleanupTuiProject,
  createKiroNumberedProseAnswerState,
  KIRO_SRC,
  nextKiroNumberedProseAnswer,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;

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
function send(session: string, keys: string): void {
  drive(["send", "--session", session, "--keys", keys, "--literal", "--no-enter"]);
  drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
}

const IDLE_PATTERN = "ask a question or describe a task";
function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_TUI_LIVE !== "1") {
    return "set AIDLC_KIRO_TUI_LIVE=1 to run the live Kiro bugfix journey (uses Kiro credits)";
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

function completedCount(sandbox: string): number {
  try {
    const s = readFileSync(stateFilePathFor(sandbox), "utf-8");
    const m = /\*\*Completed\*\*:[ \t]*(\d+)/.exec(s);
    return m ? Number.parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

describe("t-tui-kiro-bugfix-scope (brownfield bugfix journey, numbered-prose gates)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `kiro: /aidlc bugfix advances past init into Inception with real answered gates${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_kiro_bf_${process.pid}`;
      const sandbox = setupTuiProject({
        harness: "kiro",
        noAidlcDocs: true,
        brownfieldStub: true,
      });
      try {
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
        expect(waitFor(session, IDLE_PATTERN, 60000, 600)).toBe(true);

        send(
          session,
          "/aidlc bugfix Fix the duplicate-todo bug when adding items quickly",
        );

        // Gate loop: idle => answer the next menu/batch => re-check disk, until
        // Completed >= 5 (init 3 + >=2 Inception).
        const deadline = Date.now() + Math.max(120000, TEST_TIMEOUT_MS - 120000);
        let answers = 0;
        const answerState = createKiroNumberedProseAnswerState();
        while (Date.now() < deadline) {
          if (completedCount(sandbox) >= 5) break;
          if (!waitFor(session, IDLE_PATTERN, 300000, 1500)) continue;
          if (completedCount(sandbox) >= 5) break;
          const screen = drive(["capture", "--session", session]).stdout;
          const answer = nextKiroNumberedProseAnswer(screen, answerState);
          if (answer === null) {
            throw new Error(
              `Kiro stopped at an unrecognized bugfix prompt:\n${screen.slice(-4000)}`,
            );
          }
          send(session, answer);
          answers += 1;
        }
        expect(answers).toBeGreaterThan(0);
        expect(answerState.summaryConfirmed).toBe(true);
        expect(answerState.learningsAnswered).toBeGreaterThanOrEqual(2);
        expect(answerState.approvalsAnswered).toBeGreaterThanOrEqual(2);
        expect(completedCount(sandbox)).toBeGreaterThanOrEqual(5);

        const questionsPath = join(
          recordDirFor(sandbox),
          "inception",
          "requirements-analysis",
          "requirements-analysis-questions.md",
        );
        expect(existsSync(questionsPath)).toBe(true);
        const questions = readFileSync(questionsPath, "utf-8");
        expect(questions).toMatch(
          /## Consolidated Summary Confirmation[\s\S]*\[Answer\]:[^\r\n]*Looks correct/i,
        );

        // State surface — the Claude twin's assertion shapes (t50:309-330):
        // loose scope/brownfield matches (live init writes vary the field
        // wording), strict counter-vs-grid consistency.
        const state = readFileSync(stateFilePathFor(sandbox), "utf-8");
        expect(state).toMatch(/bugfix/i);
        expect(state).toMatch(/brownfield/i);
        const xCount = (state.match(/^- \[x\]/gm) ?? []).length;
        expect(completedCount(sandbox)).toBe(xCount);

        // Audit: the workflow really started and at least one gate approval
        // landed through the numbered-prose protocol.
        const audit = readAllAuditShards(sandbox);
        expect(audit).toContain("WORKFLOW_STARTED");
        expect(audit).toContain("GATE_APPROVED");
        const questionAnsweredAt = audit.lastIndexOf("**Event**: QUESTION_ANSWERED");
        const gateOpenedAt = audit.lastIndexOf("**Event**: STAGE_AWAITING_APPROVAL");
        expect(questionAnsweredAt).toBeGreaterThan(-1);
        expect(gateOpenedAt).toBeGreaterThan(questionAnsweredAt);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
