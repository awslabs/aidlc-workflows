// covers: subcommand:aidlc-orchestrate:next, function:openGateReplyDirective, function:openQuestionReplyDirective,
// function:openPlanQuestionReplyDirective, function:openRecoveryReplyDirective, function:workQuestionReading
//
// t-question-at-an-open-decision: a question about where the work stands, typed with /aidlc while a decision is open
// (a stage's approval gate, a stage's question, the code plan question, a guard's recovery question), gets that
// decision's reading step with the status reading beside its other readings: answer from the status, run no other
// command. Nothing is recorded, the same words again get the same decision's reading, and a bare `next` after it
// returns the step any other non-answer leads to: the open decision is still the next thing the person is asked. Words
// with a setting typed beside them get the reading as before, so the setting keeps its way (the request reading). Measured on #3543's head
// bc550927f: the four readings had no reading for a question about the work, so its fit was the request reading
// (`next --request`, which asks where the words belong) or one short question; live at a gate, Sonnet 4.5 ran the
// routing command at main and showed the gate's choices without an answer at bc550927f's patch.
//
// Spawns the real engine and the Claude Code human-turn hook on the answers corpus's question states.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject } from "../harness/fixtures.ts";
import { type Directive, next } from "../harness/aidlc-input-corpus.ts";
import { CHOICE_EVENTS, choiceRowCount, projectAt, type Question, say, templateProjects } from "../harness/aidlc-answers-corpus.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { latestQuestion } from "../../dist/claude/.claude/tools/aidlc-question-store.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const projects: string[] = [];
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

const QUESTION = "how far along are we?";
const OTHER = "what does this stage do?";
const SETTING = ["--depth", "minimal"];
const STATUS = /`[^`]*\bengine status`/;
const NOTHING_ELSE = "run no other command";
const REQUEST = /`[^`]* next --request [0-9a-f]{8}`/;

// Each open decision, the words its own reading opens with, and the answer reading it keeps.
const DECISIONS: Array<{ question: Question; opens: string; keeps: RegExp }> = [
  { question: "stage-gate", opens: "is waiting for the person's approval", keeps: /--result approved/ },
  { question: "stage-question", opens: "has a question you asked that the person has not answered yet", keeps: /log\.ts answer/ },
  { question: "code-plan", opens: "The code plan question is open", keeps: /--checkpoint plan-approval/ },
  { question: "guard-recovery", opens: "The recovery question for", keeps: /--checkpoint guard-recovery/ },
];

describe("t-question-at-an-open-decision: a question about the work is answered from the status, the decision left open", () => {
  for (const { question, opens, keeps } of DECISIONS) {
    test(`${question}: the reading names the status command and no other command, beside its own readings`, async () => {
      const proj = await projectAt(question);
      projects.push(proj);
      const choices = choiceRowCount(proj);
      expect((await say(proj, `/aidlc ${QUESTION}`, "claude")).status).toBe(0);
      const before = readAuditShardEvents(proj).length;
      const step = await next(proj, [QUESTION]);
      expect(step.directive?.kind, step.out).toBe("print");
      const message = String(step.directive?.message);
      expect(message).toContain(opens);
      expect(message).toMatch(STATUS);
      expect(message).toContain(NOTHING_ELSE);
      expect(message).toMatch(keeps);
      expect(message).toMatch(REQUEST);
      // The status reading comes before the request reading, so a question about the work never reaches it first.
      expect(message.search(STATUS)).toBeLessThan(message.search(REQUEST));
      // The reading step decides nothing: the open decision has no new choice on record.
      expect(choiceRowCount(proj)).toBe(choices);
      const recorded = readAuditShardEvents(proj).slice(before).map((row) => row.event).filter((event) => CHOICE_EVENTS.includes(event));
      expect(recorded).toEqual([]);
      // The decision is still open: the same words again get the same decision's reading.
      const again = await next(proj, [QUESTION]);
      expect(String(again.directive?.message), again.out).toContain(opens);
      // And it is still what comes next: a bare `next` returns the step it returns after any other reply that does not
      // answer the decision (a twin where the person asked about the stage instead).
      const twin = await projectAt(question);
      projects.push(twin);
      expect((await say(twin, `/aidlc ${OTHER}`, "claude")).status).toBe(0);
      await next(twin, [OTHER]);
      const expected = await next(twin, []);
      const after = await next(proj, []);
      const shape = (d: Directive | null) => ({ kind: d?.kind, ask_type: d?.ask_type, stage: d?.stage });
      expect(shape(after.directive), after.out).toEqual(shape(expected.directive));
    });

    test(`${question}: with a setting typed beside the question, the reading is as before, so the setting keeps its way`, async () => {
      const proj = await projectAt(question);
      projects.push(proj);
      const choices = choiceRowCount(proj);
      expect((await say(proj, `/aidlc ${SETTING.join(" ")} ${QUESTION}`, "claude")).status).toBe(0);
      const step = await next(proj, [...SETTING, ...QUESTION.split(" ")]);
      expect(step.directive?.kind, step.out).toBe("print");
      const message = String(step.directive?.message);
      expect(message).toContain(opens);
      // No status-only reading: "run no other command" would leave the setting unset. The request reading, which the
      // setting rides, is still there.
      expect(message).not.toMatch(STATUS);
      expect(message).not.toContain(NOTHING_ELSE);
      expect(message).toMatch(REQUEST);
      // The setting still rides: the kept copy of their words carries it for the request reading's answer, and the
      // code plan reading still names it for an answer to the plan question.
      expect(JSON.stringify(latestQuestion(proj)?.settings ?? null)).toContain(SETTING[0]);
      if (question === "code-plan") expect(message).toContain(`The line also carries \`${SETTING.join(" ")}\``);
      expect(choiceRowCount(proj)).toBe(choices);
    });
  }
});
