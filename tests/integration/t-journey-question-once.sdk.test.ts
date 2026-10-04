// covers: hook:aidlc-continue-workflow, file:skills/aidlc/SKILL.md
//
// t-journey-question-once.sdk.test.ts - a question the person has not answered
// yet is asked once, even when the end-of-turn reminder fires (live SDK).
//
// What a person hit without this: the agent showed a question, the turn ended
// before the person answered, AI-DLC's end-of-turn reminder fired, and the
// agent then asked the same question again (a picker after a question in chat
// on Claude Code; the question again in prose on Kiro CLI).
//
// The journey, in one live session:
//   seed:   one piece of work in progress, Feasibility started (state-mid-ideation).
//   turn 1: the person types `/aidlc "<unrelated new work>"`. The engine asks
//           where the new work goes (part of the current work, separate new
//           work, or a plan change) and the agent shows it in a picker. (The
//           skill also lets the agent offer the new work itself, as a Yes/No
//           picker, before it calls the engine; the journey takes either.) The
//           person picks the picker's "Chat about this" instead of an option
//           (Claude Code's own result for that button), so the question stays
//           open and the turn ends with nobody's answer recorded.
//   stop:   the real Stop hook runs at the end of turn 1. Either it sees the
//           open question and lets the turn end, or it re-feeds the turn with
//           the end-of-turn reminder, which must make the agent record the
//           question and end its turn without asking it again or going back to
//           Feasibility.
//   turn 2: the person answers in their own message: the number of the
//           option shown for separate new work, and those words. The drive
//           stops when that work is created.
//
// Pass/fail reads only what the engine recorded, the pickers the person was
// shown, and the Stop hook's own verdicts, NEVER the agent's prose:
//   - before the reply: one picker, the turn was let through, and no answer
//     was recorded (no answer, gate, or stage-finished row; still one piece
//     of work; Feasibility still in progress); when the engine asked, its own
//     record says the question was still open when the turn ended;
//   - after the reply: the new work was created from the person's answer with
//     no further picker.
//
// It SPENDS TOKENS: driveAidlc drives the real /aidlc through the Claude Agent
// SDK. Gated on the claude CLI (calling driveAidlc marks the file
// SDK-dependent; the runner skips with a reason when claude is absent).

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { assertToolResultContains } from "../harness/assert.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";
import { type CapturedAskUserQuestion, driveAidlc, readAuditEvents, readStateFile } from "../harness/sdk-drive.ts";
import { askTurnEndIsOpen, readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Unmistakably separate from the seeded widget work, so the engine asks where
// it goes instead of folding it into Feasibility.
const NEW_WORK =
  "build a standalone Python CLI that scrapes NOAA weather data and writes it to a SQLite database";
// The person's answer in their own message: the number of the option shown
// for separate new work (the skill leads it with "Yes"), and its words.
const SEPARATE = "it is a separate new piece of work";
// The engine's routing question, as handed to the agent.
const ENGINE_ROUTING_ASK = /"ask_type":\s*"new-work-routing"/;
// Printed only when new work is created (aidlc-utility.ts handleIntentCreate).
const CREATED = "State initialized:";

// Rows that record an answer or move the workflow on. None may appear before
// the person replies.
const ANSWER_ROWS = [
  "QUESTION_ANSWERED",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "STAGE_AWAITING_APPROVAL",
  "STAGE_COMPLETED",
  "STAGE_SKIPPED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "PLAN_APPROVAL_RECORDED",
];

const FEASIBILITY_IN_PROGRESS = /^- \[-\] feasibility\b/m;

function separateWorkReply(menu: CapturedAskUserQuestion | undefined): string {
  const options = menu?.questions[0]?.options ?? [];
  let at = options.findIndex((o) => /^yes\b/i.test(o.label));
  if (at < 0) at = options.findIndex((o) => /separate/i.test(o.label));
  return at < 0 ? SEPARATE : `${at + 1}, ${SEPARATE}`;
}

function countRows(events: string[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events ?? []) counts.set(event, (counts.get(event) ?? 0) + 1);
  return counts;
}

describe("t-journey-question-once (sdk): a question still open at the end of a turn is asked once", () => {
  test(
    "the routing question left open by Chat about this: nothing is recorded or asked again before the person answers, and their answer is taken",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({ withState: "state-mid-ideation.md", stripEnvScope: true });
      try {
        expect(readIntentRegistry(proj).length).toBe(1);
        expect(readStateFile(proj) ?? "").toMatch(FEASIBILITY_IN_PROGRESS);
        const seeded = countRows(readAuditEvents(proj));

        let replied = false;
        let firstMenu: CapturedAskUserQuestion | undefined;
        let atReply:
          | { rows: Map<string, number>; intents: number; state: string; engineAskOpen: boolean; reply: string }
          | undefined;
        const r = await driveAidlc(`/aidlc "${NEW_WORK}"`, {
          projectDir: proj,
          persistSession: true,
          captureStopHooks: true,
          // Every picker before the reply gets "Chat about this"; one after it
          // (there should be none) takes the separate-work option.
          chatAboutQuestionWhen: (menu) => {
            firstMenu ??= menu;
            return !replied;
          },
          answerScript: { kind: "byHeader", map: {}, fallback: { labelContains: "Separate" } },
          nextMessage: (turn) => {
            if (turn.turn !== 1) return undefined;
            atReply = {
              rows: countRows(readAuditEvents(proj)),
              intents: readIntentRegistry(proj).length,
              state: readStateFile(proj) ?? "",
              engineAskOpen: askTurnEndIsOpen(proj),
              reply: separateWorkReply(firstMenu),
            };
            replied = true;
            return atReply.reply;
          },
          stopAfterToolResult: { toolName: "Bash", resultIncludes: CREATED },
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
        });

        const turn1 = r.turns?.[0];
        expect(r.timedOut).toBe(false);
        expect(turn1, "turn 1 never ended, so the person never got to answer").toBeDefined();
        const shown = r.askedQuestions.slice(0, turn1!.askedQuestions).map((m) => m.questions.map((q) => q.question));

        // The person saw one picker before they answered: the routing question.
        // The Stop hook verdicts say which path ended the turn (a reminder, or
        // the hook seeing the open question); the person's outcome is the same.
        const turn1Stops = (r.stopHooks ?? []).filter((s) => s.turn === 1);
        expect(shown, `pickers before the reply: ${JSON.stringify(shown)}; Stop hooks in turn 1: ${JSON.stringify(turn1Stops)}`)
          .toHaveLength(1);
        expect(turn1Stops.at(-1)?.blocked, "the end of turn 1 was never let through").toBe(false);
        // When the engine asked the question (it has in every run so far), its
        // own record says the question was still open when the turn ended.
        const engineAsked = r.toolResults.slice(0, turn1!.toolResults)
          .some((t) => t.toolName === "Bash" && ENGINE_ROUTING_ASK.test(t.resultText));
        if (engineAsked) expect(atReply!.engineAskOpen, "the engine's question was not open when turn 1 ended").toBe(true);

        // Nothing was answered or moved on in the person's place.
        const recorded = ANSWER_ROWS.filter((row) => (atReply!.rows.get(row) ?? 0) > (seeded.get(row) ?? 0));
        expect(recorded, "rows recorded before the person answered").toEqual([]);
        expect(atReply!.intents).toBe(1);
        expect(atReply!.state).toMatch(FEASIBILITY_IN_PROGRESS);

        // Their answer was taken as given: the separate work was created, and
        // no picker came after the reply.
        expect(r.stoppedAfterToolResult).toBe(true);
        assertToolResultContains(r, "Bash", CREATED);
        expect(readIntentRegistry(proj).length, `the person's reply: ${atReply!.reply}`).toBe(2);
        expect(r.askedQuestions.length, "pickers after the reply").toBe(turn1!.askedQuestions);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
