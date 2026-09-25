// covers: stage:ideation/intent-capture
//
// t-tui-kiro-intent-capture.serial.test.ts — drive the IDEATION intent-capture
// stage through a REAL keystroke-driven `kiro-cli chat` TUI against the SHIPPED
// dist/kiro tree, and prove it produces its on-disk artifacts. The Kiro twin of
// t-tui-t73-intent-capture.serial.test.ts (same seeded fixture, same disk
// asserts) with the gate loop adapted to the Kiro question protocol.
//
// WHY THE GATE LOOP DIFFERS FROM THE CLAUDE TWIN: on Kiro there is no
// AskUserQuestion widget — the Kiro question-rendering annex
// (dist/kiro/.kiro/skills/aidlc/question-rendering.md) renders every structured
// question as NUMBERED PROSE OPTIONS with the recommended option FIRST, answered
// by typing a number. So instead of tui-drive's answer-gate primitive (which
// arrow-navigates menus), this test runs a simple driver-side loop:
//   while terminator-not-on-disk:
//     wait for the TUI to go idle at the input prompt (the "ask a question or
//     describe a task" / "type to queue" footer), then send the next scripted
//     answer. Numbered menus use "1", each visible guide batch gets explicit
//     per-question selections, and prose/approval gates get labeled
//     responses.
// Disk is the terminator, never the screen (§1.1) — identical discipline to the
// Claude twin: `Last Completed Stage == intent-capture` in aidlc-state.md, the
// field the approve tool writes atomically with GATE_APPROVED+STAGE_COMPLETED.
//
// WHY THE GUIDE ANSWERS ARE EXPLICIT: the source file retains Q1..Qn with A..X
// storage labels, but the Kiro annex requires the interactive presentation to
// remap every choice to numbered prose. A bare "1" does not identify which
// batched question it answers, so the driver extracts the currently rendered,
// unanswered Q<n> IDs and sends an explicit per-question number vector. Each
// response answers only the batch currently on screen so future answers cannot be
// mistaken for an edit-mode choice or create a false contradiction. The stage
// receives its exact build description through the marked record and the
// public project-description command, as well as $ARGUMENTS, so no open-ended
// "what would you like to build?" answer is needed.
//
// WHAT IT PROVES (equal to the Claude twin's disk surface):
//   - the shipped dist/kiro tree drives a real workflow from a seeded
//     init-done state through intent-capture,
//   - the numbered-prose gate protocol is answerable by keystroke,
//   - ON DISK: questions file with >=1 [Answer]: line; intent-statement and
//     stakeholder map with source tags plus Assumptions & Open Questions;
//     state Completed == [x] count, > 3, IDEATION phase; intent-capture [x]
//     with Current Stage moved off it; audit has STAGE_COMPLETED.
//
// COST: spends real Kiro credits (minutes of LLM turns on the `auto` model).
// Gated behind AIDLC_KIRO_TUI_LIVE=1; selected TUI substrate / kiro-cli / kiro auth / dist-kiro
// absence each SKIP with a reason — never a hollow pass. Linux, macOS, and
// Windows run through the selected TUI substrate, including native Windows Kiro CLI.
//
// TRUST POSTURE: launched with --trust-all-tools so the bun tool calls and
// artifact writes run unprompted (the shipped agent's allowedCommands would
// cover the bun calls, but stage bodies also write artifacts via fs_write
// paths outside the agent's allowedPaths fixture-set — trust-all keeps the
// journey about the WORKFLOW, not the permission dialogs). The trust-all
// confirmation picker that 2.6.1 shows on launch is cleared by the prep step.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, remainingCleanupTimeoutMs, fileCleanupReserveMs, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { findIntentGroundingRegressions } from "../harness/intent-grounding-regressions.ts";
import {
  cleanupTuiProjectAfterKill,
  createKiroNumberedProseAnswerState,
  KIRO_SRC,
  markdownH2Section,
  nextKiroNumberedProseAnswer,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const PROJECT_DESCRIPTION = "Build a simple React todo app";
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
function send(session: string, keys: string, literal: boolean): void {
  const args = ["send", "--session", session, "--keys", keys, "--no-enter"];
  if (literal) args.push("--literal");
  drive(args);
  drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
}

// Kiro TUI idle detection: the input footer reads "ask a question or describe
// a task" when fully idle. While Kiro streams, the footer says "Kiro is
// working". We treat the idle footer held stable as "the model finished a turn
// and is waiting on the human".
const IDLE_PATTERN = "ask a question or describe a task";

// ABSENT / opt-in gating, token guard first (mirrors the Claude twin).
function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_TUI_LIVE !== "1") {
    return "set AIDLC_KIRO_TUI_LIVE=1 to run the live Kiro intent-capture journey (uses Kiro credits)";
  }
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (completedStartupProbe(spawnSync("kiro-cli", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "kiro-cli not found";
  }
  // whoami exits non-zero when logged out — a clean skip, not a red.
  if (completedStartupProbe(spawnSync("kiro-cli", ["whoami"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

function findArtifact(dir: string, fragments: string[], exclude: string[] = []): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const lower = entry.toLowerCase();
    if (exclude.some((x) => lower.includes(x.toLowerCase()))) continue;
    if (fragments.every((f) => lower.includes(f.toLowerCase()))) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function lastCompletedIsIntentCapture(sandbox: string): boolean {
  try {
    const s = readFileSync(seededStateFile(sandbox), "utf8");
    const m = /\*\*Last Completed Stage\*\*:[ \t]*([^\r\n]*)/.exec(s);
    return (m?.[1] ?? "").trim() === "intent-capture";
  } catch {
    return false;
  }
}

function publicProjectDescription(sandbox: string): { description: string; source: string } {
  const result = spawnSync(process.execPath, [
    join(sandbox, ".kiro", "tools", "aidlc-utility.ts"),
    "project-description",
  ], { timeout: remainingWorkMs(),
    cwd: sandbox,
    env: { ...process.env, AIDLC_PROJECT_DIR: sandbox, AIDLC_HARNESS_DIR: ".kiro" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("t-tui-kiro-intent-capture (numbered-prose gates on the shipped dist/kiro tree)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `kiro: intent-capture journey commits intent-statement + answered questions on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_kiro_ic_${process.pid}`;
      const sandbox = setupTuiProject({
        harness: "kiro",
        withState: "state-initialization-done.md",
        projectDescription: PROJECT_DESCRIPTION,
        greenfieldStub: true,
        withAudit: true,
        runtimeGraph: true,
      });
      try {
        expect(publicProjectDescription(sandbox)).toEqual({
          description: PROJECT_DESCRIPTION,
          source: "project-description.json",
        });
        // --- launch kiro-cli chat in the seeded sandbox -----------------------
        // The shipped .kiro/settings/cli.json makes `aidlc` the workspace
        // default agent, so a bare chat lands on the conductor (D-5, verified
        // in the Wave 4 smoke). --trust-all-tools: see TRUST POSTURE above.
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

        // Clear the 2.6.1 trust-all confirmation picker if it renders ("Yes, I
        // accept" is one Down from the default "No, exit").
        expect(waitFor(session, `Yes, I accept|${IDLE_PATTERN}`, remainingWorkMs(), 400)).toBe(true);
        if (drive(["capture", "--session", session]).stdout.includes("Yes, I accept")) {
          drive(["send", "--session", session, "--keys", "Down", "--no-enter"]);
          drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
        }
        // Wait for the idle input footer + the aidlc agent in the statusbar —
        // proves the workspace default-agent activation on the shipped tree.
        expect(waitFor(session, "aidlc", remainingWorkMs(), 400)).toBe(true);
        expect(waitFor(session, IDLE_PATTERN, remainingWorkMs(), 600)).toBe(true);

        // --- submit the stage-jump with the build description -----------------
        // Same trailing-freeform trick as the Claude twin: the description lands
        // in $ARGUMENTS so the stage skips its free-text "what to build?" ask.
        send(
          session,
          `/aidlc --stage intent-capture ${PROJECT_DESCRIPTION}`,
          true,
        );

        // --- the Kiro gate loop: idle ⇒ scripted answer, terminate on disk ----
        // The guide-mode choice is numbered; its Q1..Qn source questions keep
        // letter labels on disk but are presented and answered with numbers.
        // Later prompts receive explicit summary, learnings, and approval
        // responses so a bare numeric answer cannot be mistaken for prose.
        // Per-iteration: wait up to 240s for the idle footer (a long LLM turn),
        // then check disk BEFORE answering so we stop the instant the approve
        // lands (and never answer the auto-advanced next stage's gate).
        const deadline = Date.now() + remainingWorkMs();
        let terminated = false;
        const answerState = createKiroNumberedProseAnswerState();
        while (Date.now() < deadline) {
          if (lastCompletedIsIntentCapture(sandbox)) {
            terminated = true;
            break;
          }
          // Idle? (stable 1.5s so a mid-stream repaint doesn't false-trigger)
          if (!waitFor(session, IDLE_PATTERN, remainingWorkMs(), 1500)) continue;
          if (lastCompletedIsIntentCapture(sandbox)) {
            terminated = true;
            break;
          }
          const screen = drive(["capture", "--session", session]).stdout;
          const answer = nextKiroNumberedProseAnswer(screen, answerState);
          if (answer === null) {
            throw new Error(
              `Kiro stopped at an unrecognized intent-capture prompt:\n${screen.slice(-4000)}`,
            );
          }
          if (answer === "Looks correct") {
            const icDir = join(
              seededRecordDir(sandbox),
              "ideation",
              "intent-capture",
            );
            expect(findArtifact(icDir, ["intent", "statement"])).toBeNull();
          }
          send(session, answer, true);
        }
        if (!terminated) terminated = lastCompletedIsIntentCapture(sandbox);
        expect(terminated).toBe(true);
        expect(answerState.guideModeChosen).toBe(true);
        expect(answerState.answeredQuestions.size).toBeGreaterThan(0);
        expect(answerState.confirmedSummaries.size).toBeGreaterThanOrEqual(1);
        expect(answerState.learningsAnswered).toBeGreaterThanOrEqual(1);
        expect(answerState.approvalsAnswered).toBeGreaterThanOrEqual(1);

        // --- assert ON DISK (the Claude twin's surface, verbatim) -------------
        const icDir = join(seededRecordDir(sandbox), "ideation", "intent-capture");
        expect(existsSync(icDir)).toBe(true);

        const questionsFile = findArtifact(icDir, ["questions"]);
        expect(questionsFile).not.toBeNull();
        const questionsBody = readFileSync(questionsFile as string, "utf8");
        expect((questionsBody.match(/\[Answer\]:/g) ?? []).length).toBeGreaterThan(0);
        const confirmation = markdownH2Section(
          questionsBody,
          "Consolidated Summary Confirmation",
        );
        expect(confirmation).toMatch(/^\[Answer\]: Looks correct\s*$/m);
        expect(questionsBody).toContain("## Sources");
        expect(questionsBody).toContain("[desc]");
        expect(questionsBody).toContain("[scope]");
        const registeredDescription = markdownH2Section(questionsBody, "Sources")
          .match(/^- \[desc\] Initial description: ("(?:\\.|[^"\\])*")\s*$/m);
        expect(registeredDescription).not.toBeNull();
        expect(JSON.parse((registeredDescription as RegExpMatchArray)[1])).toBe(PROJECT_DESCRIPTION);
        expect(publicProjectDescription(sandbox)).toEqual({
          description: PROJECT_DESCRIPTION,
          source: "project-description.json",
        });

        const intentFile = findArtifact(icDir, ["intent", "statement"]);
        expect(intentFile).not.toBeNull();
        const intentBody = readFileSync(intentFile as string, "utf8");
        expect(Buffer.byteLength(intentBody, "utf8")).toBeGreaterThan(100);
        expect(intentBody).toMatch(/^#/m);
        expect(intentBody).toContain("## Assumptions & Open Questions");
        expect(intentBody).toMatch(
          /\[(?:desc|scope|Q\d+|memory:[A-Za-z0-9][A-Za-z0-9._-]*|assumption)\]/,
        );

        const stakeholderFile = findArtifact(icDir, ["stakeholder"]);
        expect(stakeholderFile).not.toBeNull();
        const stakeholderBody = readFileSync(stakeholderFile as string, "utf8");
        expect(stakeholderBody).toContain("## Assumptions & Open Questions");
        expect(stakeholderBody).toMatch(
          /\[(?:desc|scope|Q\d+|memory:[A-Za-z0-9][A-Za-z0-9._-]*|assumption)\]/,
        );
        const claims = spawnSync(process.execPath, [
          join(sandbox, ".kiro", "tools", "aidlc-sensor-claim-sources.ts"),
          "--stage", "intent-capture",
          "--output-path", intentFile as string,
          "--deliverables", "intent-statement,stakeholder-map",
        ], { timeout: remainingWorkMs(),
          cwd: sandbox,
          env: { ...process.env, AIDLC_PROJECT_DIR: sandbox, AIDLC_HARNESS_DIR: ".kiro" },
          encoding: "utf8",
        });
        if (process.env.AIDLC_TEST_LOG_DIR) {
          writeFileSync(join(process.env.AIDLC_TEST_LOG_DIR, "kiro-intent-claim-sources.json"), claims.stdout);
        }
        expect(claims.status, claims.stderr).toBe(0);
        const claimResult = JSON.parse(claims.stdout) as {
          pass: boolean; findings: string[]; findings_count: number; scanned_files: string[];
        };
        expect(claimResult.scanned_files).toEqual([intentFile as string, stakeholderFile as string]);
        expect(claimResult.findings).toEqual([]);
        expect(claimResult.findings_count).toBe(0);
        expect(claimResult.pass).toBe(true);

        // Citation resolution alone did not catch these two observed overclaims.
        // This bounded test assertion does not change the shipped workflow.
        const groundingRegressions = findIntentGroundingRegressions({
          description: PROJECT_DESCRIPTION,
          questions: questionsBody,
          artifacts: [
            { name: "intent-statement.md", markdown: intentBody },
            { name: "stakeholder-map.md", markdown: stakeholderBody },
          ],
        });
        if (process.env.AIDLC_TEST_LOG_DIR) {
          writeFileSync(
            join(process.env.AIDLC_TEST_LOG_DIR, "kiro-intent-grounding-regressions.json"),
            JSON.stringify(groundingRegressions, null, 2),
          );
        }
        expect(groundingRegressions, "Unsupported intent-capture claims; see captured grounding diagnostics").toEqual([]);

        const stateMd = readFileSync(seededStateFile(sandbox), "utf8");
        const xCount = (stateMd.match(/^- \[x\]/gm) ?? []).length;
        const completedMatch = /\*\*Completed\*\*:[ \t]*(\d+)/.exec(stateMd);
        expect(completedMatch).not.toBeNull();
        expect(Number.parseInt((completedMatch as RegExpExecArray)[1], 10)).toBe(xCount);
        expect(xCount).toBeGreaterThan(3);
        expect(stateMd).toContain("IDEATION");
        expect(stateMd).toMatch(/- \[x\] intent-capture/);
        const currentStageLine =
          /\*\*Current Stage\*\*:[ \t]*([^\r\n]*)/.exec(stateMd)?.[1]?.trim() ?? "";
        expect(currentStageLine.length).toBeGreaterThan(0);
        expect(currentStageLine.toLowerCase()).not.toContain("intent-capture");

        const auditMd = readAllAuditShards(sandbox);
        expect(auditMd).toMatch(/STAGE_COMPLETED/);
        expect(auditMd.toLowerCase()).toContain("intent-capture");
        const questionAnsweredAt = auditMd.lastIndexOf("**Event**: QUESTION_ANSWERED");
        const summaryConfirmedAt = auditMd.lastIndexOf(
          "**Event**: SUMMARY_CONFIRMATION_RECORDED",
        );
        const gateOpenedAt = auditMd.lastIndexOf("**Event**: STAGE_AWAITING_APPROVAL");
        expect(summaryConfirmedAt).toBeGreaterThan(-1);
        expect(questionAnsweredAt).toBeGreaterThan(summaryConfirmedAt);
        expect(gateOpenedAt).toBeGreaterThan(questionAnsweredAt);
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
