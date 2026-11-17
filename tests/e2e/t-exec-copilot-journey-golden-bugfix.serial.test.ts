// covers: scope:bugfix, file:skills/aidlc/SKILL.md, hook:aidlc-record-human-turn, audit:GATE_APPROVED, audit:PLAN_APPROVAL_RECORDED
//
// t-exec-copilot-journey-golden-bugfix.serial.test.ts - the "fix existing code"
// golden journey on GitHub Copilot CLI (live, in Copilot's own interactive
// terminal, tests/harness/copilot-tui.ts, each line typed at its prompt), from
// the person's first line to the fix built, with a night between. A `copilot -p`
// session tells the model it is non-interactive and must not stop to ask, which
// no person in the terminal meets.
//
// The journey: the release journey's greeter repo and its copy-channel install
// (tests/harness/release-journey.ts), in a folder Copilot trusts, with
// production guards. AI-DLC asks every question as numbered text and the person
// types each reply; what the agent ran and said is read from Copilot's own
// session record.
//   session 1: `/aidlc fix the greeter: ...`, the plan offer taken, Reverse
//              Engineering approved, Requirements answered (their own words for
//              the first question it asks, if it asks one) and approved. The
//              plan question is left unanswered for the day.
//   session 2: Copilot closed and opened again, a new session, not a resume:
//              `/aidlc`. The plan question comes first, "Approve Plan", then
//              Code Generation is approved.
//
// It fails when the person is asked anything twice, a decision is recorded
// with no turn of theirs behind it, a turn ends with nothing asked of them, the
// new session asks anything before the plan question, a stage bugfix leaves
// out runs, a stage is approved other than once, a line the person typed has
// no message record or a record holds words they never typed (a helper's
// brief is no turn of theirs), or the fix does not work. Pass/fail reads only
// what the engine and hooks recorded, the state file, the person's own turns
// and the project's own code, NEVER the agent's prose. AI-DLC ships no Copilot
// CLI permission rules, so Copilot asks before each command and file write; the
// person takes its preselected "Yes" and the report counts them by what drew
// them.
//
// The model is Copilot's own-model mode (BYOK): in CI the Full Suite points it
// at the credential broker, so no GitHub sign-in or Copilot seat is involved.
//
// LIVE GATE: AIDLC_COPILOT_EXEC_LIVE=1, a copilot >= 1.0.95 binary on PATH (or
// AIDLC_COPILOT_BIN), a model provider (BYOK variables, a GitHub token, or
// AIDLC_COPILOT_ASSUME_AUTH=1), the selected terminal backend and the
// production guard profile (--production-guards). SPENDS TOKENS. Serial.

import { liveCaseTimeoutMs, NATIVE_STARTUP_TIMEOUT_MS, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, remainingCleanupTimeoutMs, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CopilotTerminal, type CopilotPrompt, ledgeredTurn, promptCounts } from "../harness/copilot-tui.ts";
import { trustCopilotFolder } from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  driveTyped,
  GOLDEN_WORK_MS,
  type GoldenJourney,
  goldenPathProblems,
  GoldenPerson,
  GUARD_SWITCHES,
  writeGoldenReport,
} from "../harness/golden-journey.ts";
import { journeyBudgets, RELEASE_JOURNEY_REQUEST, recordedPersonLines, setupReleaseJourneyProject } from "../harness/release-journey.ts";
import { tuiUnavailableReason } from "../harness/tui-runtime.ts";

const COPILOT_BIN = process.env.AIDLC_COPILOT_BIN ?? "copilot";
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(GOLDEN_WORK_MS);
const OWN_WORDS = "Keep it small: the greeting uses the name given on the command line, and nothing else changes";

function copilotVersionOk(): boolean {
  const r = spawnSync(COPILOT_BIN, ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw r.error;
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return major > 1 || (major === 1 && (minor > 0 || patch >= 95));
}

// The runner gives this file the production guard profile on its own (it looks
// for this comparison), even in a shard of fixture-profile files.
const PRODUCTION_GUARDS = process.env.AIDLC_TEST_GUARD_PROFILE === "production";

function skipReason(): string | null {
  if (process.env.AIDLC_COPILOT_EXEC_LIVE !== "1") return "set AIDLC_COPILOT_EXEC_LIVE=1 to run the live Copilot golden journey (uses your provider)";
  if (!PRODUCTION_GUARDS) return "run with --production-guards: the journey is the person's own guard profile";
  if (!copilotVersionOk()) return `copilot >= 1.0.95 not found (AIDLC_COPILOT_BIN=${COPILOT_BIN})`;
  if (!existsSync(join(REPO_ROOT, "dist", "copilot"))) return "dist/copilot is missing: run bun scripts/package.ts";
  if (
    !process.env.COPILOT_PROVIDER_BASE_URL && !process.env.COPILOT_GITHUB_TOKEN && !process.env.GH_TOKEN &&
    !process.env.GITHUB_TOKEN && process.env.AIDLC_COPILOT_ASSUME_AUTH !== "1"
  ) {
    return "no provider visible: set COPILOT_PROVIDER_BASE_URL (BYOK), a GitHub token variable, or AIDLC_COPILOT_ASSUME_AUTH=1 for a signed-in CLI";
  }
  return tuiUnavailableReason();
}
const SKIP_REASON = skipReason();

describe("t-exec-copilot-journey-golden-bugfix: fix existing code on Copilot CLI, from the first line to the fix built", () => {
  test.skipIf(SKIP_REASON !== null)(
    `asked once at every step, every answer the person's, the plan left overnight and approved in a new session, and the fix works${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      for (const key of GUARD_SWITCHES) expect(process.env[key], `${key} disables the production contract`).not.toBe("1");
      const deadline = Date.now() + TEST_TIMEOUT_MS;
      // The journey's work keeps two minutes back for the last screen of a failed run.
      const budgets = journeyBudgets(() => deadline, TEST_TIMEOUT_MS, 120_000);
      const cleanupMs = () => remainingCleanupTimeoutMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, { deadlineMs: deadline, phase: "E2E terminal cleanup" });
      const project = setupReleaseJourneyProject("copilot");
      const { proj, root } = project;
      const copilotHome = join(root, "copilot-home");
      trustCopilotFolder(copilotHome, proj);
      const journey: GoldenJourney = {
        proj, scope: "bugfix", hasCode: true, request: `/aidlc ${RELEASE_JOURNEY_REQUEST}`,
        ownWords: { stage: "requirements-analysis", words: OWN_WORDS }, lastStage: "code-generation",
        newSessionAtPlan: "/aidlc", budget: () => undefined,
      };
      const person = new GoldenPerson(journey);
      const turns: Array<{ line: string; newSession: boolean; seconds: number }> = [];
      const tokens: Array<{ input: number; output: number }> = [];
      const prompts: CopilotPrompt[] = [];
      const problems: string[] = [];
      let terminal: CopilotTerminal | undefined;
      let sessions = 0;
      let lastScreen = "";
      try {
        const run = driveTyped(person, (line, newSession) => {
          if (newSession) {
            // A new session is Copilot closed and opened again in the same home.
            terminal?.kill();
            terminal = new CopilotTerminal({
              session: `aidlc_copilot_golden_${process.pid}_${++sessions}`, proj, copilotHome, bin: COPILOT_BIN,
              workMs: budgets.workMs, cleanupMs,
            });
            terminal.start();
            tokens.push({ input: 0, output: 0 });
          }
          const started = Date.now();
          const turn = ledgeredTurn(terminal!, proj, line, (seen) => {
            turns.push({ line, newSession, seconds: Math.round((Date.now() - started) / 1000) });
            prompts.push(...seen.prompts);
            tokens[tokens.length - 1].input += seen.tokens.input;
            tokens[tokens.length - 1].output += seen.tokens.output;
          });
          if (!turn.ended) {
            lastScreen = turn.stopped ?? "";
            throw new Error(`Copilot had not finished "${line}": ${(turn.stopped ?? "the time ran out").split("\n")[0]}`);
          }
          return { results: turn.results, words: turn.words };
        });
        problems.push(...run.problems, ...goldenPathProblems(journey, run));
        const recorded = recordedPersonLines(proj);
        const typed = turns.map(({ line }) => line);
        for (const line of typed) if (!recorded.includes(line)) problems.push(`"${line}" has no message record: Copilot did not run AI-DLC's hooks for it`);
        for (const line of recorded.filter((words) => !typed.includes(words))) {
          problems.push(`a message record holds words the person never typed: "${line.slice(0, 120)}"`);
        }
        const app = spawnSync("node", ["src/app.js", "Ada"], { cwd: proj, encoding: "utf-8", timeout: 60_000 });
        if ((app.stdout ?? "").trim() !== "Hello, Ada!") problems.push(`the greeter prints ${JSON.stringify((app.stdout ?? "").trim())} for Ada, not "Hello, Ada!"`);
        const own = spawnSync("node", ["test/app.test.js"], { cwd: proj, encoding: "utf-8", timeout: 60_000 });
        if (own.status !== 0) problems.push(`the project's own test fails: ${`${own.stdout ?? ""}${own.stderr ?? ""}`.trim().slice(0, 400)}`);
      } catch (error) {
        problems.push(`the journey stopped: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
        throw error;
      } finally {
        try {
          terminal?.kill();
        } finally {
          writeGoldenReport("copilot", { problems, person: person.said, turns, tokens, ...promptCounts(prompts), ...(lastScreen ? { screen: lastScreen } : {}) });
        }
      }
      expect(problems, `the person:\n  ${person.said.join("\n  ")}`).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    },
    TEST_TIMEOUT_MS,
  );
});
