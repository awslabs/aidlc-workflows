// covers: function:withAgentNotes function:questionNote function:numberedProseQuestion
//
// A question AI-DLC asks can have one choice: a guard's question with one way
// on (Request Changes alone at a gate), one piece of work to carry on in a
// teammate's clone, a paused Unit to resume, one Unit to claim. On Claude Code
// the conductor rendered it through AskUserQuestion, which takes two to four
// options, so the person saw "Invalid tool parameters" before any question.
// A skill sentence that named the one-choice case was read aloud in a live run
// ("One choice, so the numbered question is said as given."), so the engine
// makes that branch: a one-choice question's note says to say its numbered
// question, and Claude Code's skill renders a question as its note says,
// naming no count.
// Mechanism: in-process over withAgentNotes, and a read of the authored skill.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NUMBERED_REPLY_HINT, OTHER_OPTION_LINE, withAgentNotes } from "../../core/tools/aidlc-directive.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INVOCATION = "bun .claude/tools/aidlc-orchestrate.ts";
const LOG = "bun .claude/tools/aidlc-log.ts";
const SAY_NUMBERED = "say its numbered question to them as given, end your turn";
const SHOW_CHOICES = "show it to them with its choices as given, end your turn";

type Json = Record<string, unknown>;

const ONE_CHOICE_ASKS: Record<string, Json> = {
  "guard-recovery": {
    response_route: "execute-remedy",
    stage: "intent-capture",
    reason_codes: ["SUMMARY_CONTENT_STALE"],
    remedies: [{
      op: "request-changes",
      label: "Request Changes",
      description: "Tell me what should change in Intent Capture & Framing, and I'll revise it.",
      action: "Submit Request Changes with their exact text.",
      interaction: "human-input",
      requiresHuman: true,
      executableNow: true,
    }],
  },
  "intent-pick": {
    response_route: "next",
    available_intents: ["261021-hello-name-cli"],
    select_commands: [{ selector: "261021-hello-name-cli", command: `${INVOCATION} next --pick '261021-hello-name-cli'` }],
  },
  "unit-paused": {
    response_route: "command",
    stage: "code-generation",
    unit: "auth",
    resume_command: "bun .claude/tools/aidlc-state.ts unit resume --stage code-generation --unit auth",
  },
  "unit-claim": {
    response_route: "claim",
    claimable_units: ["auth"],
    claimed_units: [],
    waiting_units: [],
  },
};

const notes = (type: string, fields: Json): Json =>
  withAgentNotes({ kind: "ask", ask_type: type, question: "The question for the person.", ...fields }, INVOCATION, LOG) as Json;

describe("a question with one choice", () => {
  test("is handed its numbered form and a note to say it: the choice and its command, Other, the reply hint", () => {
    for (const [type, fields] of Object.entries(ONE_CHOICE_ASKS)) {
      const step = notes(type, fields);
      const choices = step.choices as Array<{ label: string; command?: string }>;
      expect(choices, type).toHaveLength(1);
      expect(choices[0].command, type).toBeString();
      const numbered = String(step.numbered_prose_question);
      expect(numbered, type).toContain(`1. **${choices[0].label}**`);
      expect(numbered, type).toContain(`2. ${OTHER_OPTION_LINE}`);
      expect(numbered.endsWith(NUMBERED_REPLY_HINT), type).toBe(true);
      expect(String(step.question_note), type).toContain(SAY_NUMBERED);
      expect(String(step.question_note), type).not.toContain(SHOW_CHOICES);
    }
  });

  test("a question with two choices or more keeps the note that shows its choices", () => {
    const step = notes("intent-pick", {
      response_route: "next",
      available_intents: ["auth-fix", "notes-app"],
      select_commands: [
        { selector: "auth-fix", command: `${INVOCATION} next --pick 'auth-fix'` },
        { selector: "notes-app", command: `${INVOCATION} next --pick 'notes-app'` },
      ],
    });
    expect(String(step.question_note)).toContain(SHOW_CHOICES);
    expect(String(step.question_note)).not.toContain(SAY_NUMBERED);
  });

  test("Claude Code renders a question as its note says, and its skill names no count", () => {
    const skill = readFileSync(join(REPO_ROOT, "harness", "claude", "skills", "aidlc", "SKILL.md"), "utf-8");
    const row = skill.split("\n").find((line) => line.startsWith("| `ask` |")) ?? "";
    expect(row).toContain(
      "Render it as its note says: its choices as the options through `AskUserQuestion` (this harness's binding for " +
        "structured questions: see `question-rendering.md` beside this file), or the step's numbered question as " +
        "given, its Other line included.",
    );
    expect(row).not.toContain("one choice");
  });
});
