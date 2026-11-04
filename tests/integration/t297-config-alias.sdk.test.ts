// covers: subcommand:aidlc-orchestrate:next, file:skills/aidlc/SKILL.md
//
// t297: `/aidlc --config trust` reads the trust section, asks the person what to
// change, and lands their answer, live through the Claude Agent SDK. The agent
// asks in the question box or in plain words (with the same inputs it does
// both), so the test judges what the person met: asked once, nothing changed
// before they answered, and their answer in the engine's own trust record.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { judgeFolder, judgeShownQuestion } from "../harness/live-corpus.ts";
import { type DriveResult, driveAidlc } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// The person's answer, in their own words when the box offers no Acknowledge
// option or the agent asked in words.
const REPLY = "Acknowledge the trust settings.";
const ASKED = "what they want to change in their trust settings, or whether to leave them as they are";

// The trust section's record as the engine reports it: null until an answer
// lands, or why it could not be read.
function trustRecord(project: string): unknown {
  const shown = spawnSync(process.execPath, [join(project, ".claude", "tools", "aidlc.ts"), "config", "trust", "--show", "--json"], {
    cwd: project, encoding: "utf-8",
  });
  if (shown.status !== 0) return { failure: shown.stderr || shown.stdout };
  return (JSON.parse(shown.stdout) as { data: { record: unknown } }).data.record;
}

// Asked once, in the box or in words (a model reads the words), and never again
// after the answer: the reason it was not, or undefined.
function askedOnce(result: Pick<DriveResult, "turns" | "askedQuestions">, judgeDir: string): string | undefined {
  const turn1 = result.turns?.[0];
  if (turn1 === undefined) return "turn 1 never ended";
  if (turn1.askedQuestions > 1 || result.askedQuestions.length !== turn1.askedQuestions) {
    return `the box was shown ${result.askedQuestions.length} times, ${result.askedQuestions.length - turn1.askedQuestions} after the answer`;
  }
  if (turn1.askedQuestions === 1) return undefined;
  const verdict = judgeShownQuestion(ASKED, turn1.assistantText, judgeDir);
  if ("failure" in verdict) return verdict.failure;
  return verdict.shown ? undefined : `no question reached the person (${verdict.reason}): ${turn1.assistantText.slice(-1000)}`;
}

describe("t297 /aidlc --config trust (SDK live)", () => {
  test(
    "reads trust state, asks once, lands the answer, and creates no workflow state",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const project = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      const judgeDir = judgeFolder();
      // The record when the person answered: in the box, or after a turn that asked in words.
      let atAnswer: unknown;
      try {
        const result = await driveAidlc("/aidlc --config trust", {
          projectDir: project,
          answerScript: {
            kind: "pick",
            pick: (question) => {
              atAnswer ??= trustRecord(project);
              const at = question.options.findIndex((o) => /^acknowledge\b/i.test(o.label));
              return at < 0 ? { text: REPLY } : { optionIndex: at };
            },
          },
          nextMessage: (turn) => {
            if (turn.turn !== 1 || turn.askedQuestions > 0) return undefined;
            atAnswer ??= trustRecord(project);
            return REPLY;
          },
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
        });

        expect(result.timedOut).toBe(false);
        assertToolResultContains(
          result,
          "Bash",
          "Configure the trust section conversationally",
        );
        assertToolResultContains(
          result,
          "Bash",
          "trust configuration for claude",
        );
        const showCall = result.toolResults.find((item) =>
          item.toolName === "Bash" &&
          item.resultText.includes("trust configuration for claude")
        );
        expect(showCall).toBeDefined();
        expect(String(showCall?.input.command ?? "")).toContain(
          "config trust --show --json",
        );

        expect(askedOnce(result, judgeDir)).toBeUndefined();

        // Nothing was recorded before the person answered, and their answer is.
        expect(atAnswer, "the trust record before the person answered").toBeNull();
        expect(trustRecord(project), "the trust record after the answer").toMatchObject({ reviewed: true });

        const intents = join(
          project,
          "aidlc",
          "spaces",
          "default",
          "intents",
        );
        const stateFiles = existsSync(intents)
          ? readdirSync(intents).filter((name) =>
              existsSync(join(intents, name, "aidlc-state.md"))
            )
          : [];
        expect(stateFiles).toEqual([]);
        expect(result.stateFile).toBeUndefined();
      } finally {
        cleanupTestProject(judgeDir);
        cleanupTestProject(project);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // A turn that ends with no question to the person fails the same check (a
  // clean section ending silently); words that ask, as a recorded run's did,
  // pass it.
  test(
    "a turn that ends without asking the person fails; one that asks in words passes",
    () => {
      const judgeDir = judgeFolder();
      const said = (assistantText: string) => ({
        turns: [{ turn: 1, askedQuestions: 0, toolResults: 3, stopHooks: 0, assistantText }],
        askedQuestions: [],
      });
      try {
        expect(askedOnce(said("Your trust configuration is clean, no issues found."), judgeDir))
          .toContain("no question reached the person");
        expect(askedOnce(said(
          "Your trust configuration looks clean, no issues found.\n\nThe available trust settings are mostly for other harnesses (Kiro IDE, Kiro CLI, Copilot). For Claude Code, there's nothing that needs changing here.\n\nWould you like to adjust anything, or are you all set?",
        ), judgeDir)).toBeUndefined();
      } finally {
        cleanupTestProject(judgeDir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
