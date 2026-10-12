// covers: function:withAgentNotes function:numberedProseQuestion function:questionNote
// function:omittedContextWarning function:validateDirective
//
// What the agent said to the person on Kiro CLI and Claude Code, in the live
// input-corpus runs, was the condition it was checking: "This is a run-stage
// directive. It carries conductor_persona and narration; answer_mode.ask is
// true, so I offer the interaction-mode choice", "the directive carried an
// empty consumes list", "I print the numbered_prose_question verbatim". The
// skill rows and the protocol were written as "when field x is y, do z", so
// the agent read the branch aloud. Here the engine makes the branch and hands
// the agent the sentence instead, beside the step, the way the agent notes
// already do for the walking-skeleton stance and the autonomy choice:
//   - every question the engine asks carries its numbered rendering and its
//     choices, each with the command that answers it;
//   - the answer mode, the files to read first, a missing input, a gate shown
//     again, a Code Generation plan's status, a dispatched brief and the
//     summary confirmation each arrive as one instruction;
//   - no instruction names a JSON field, because a note that names one is read
//     back to the person too ("The request carries a change_notices line I
//     must relay to you", t181);
//   - the one context warning the person reads names no field and no byte cap.
// Mechanism: in-process over the shipped functions; plain objects stand for
// the steps the engine builds.

import { describe, expect, test } from "bun:test";
import {
  fixedLabelArg,
  knownDirectiveFieldNames,
  numberedProseQuestion,
  questionNote,
  validateDirective,
  withAgentNotes,
} from "../../core/tools/aidlc-directive.ts";
import { omittedContextWarning } from "../../core/tools/aidlc-inline-context.ts";
import { shellArg } from "../../core/tools/aidlc-lib.ts";

const INVOCATION = "bun .claude/tools/aidlc-orchestrate.ts";
const LOG = "bun .claude/tools/aidlc-log.ts";
const OTHER = "**Other** \u2014 describe what you want instead";
const HINT = "Reply with a number (or just tell me).";

type Json = Record<string, unknown>;
const notes = (step: Json): Json => withAgentNotes(step, INVOCATION, LOG) as Json;
const str = (value: unknown): string => String(value ?? "");

/** The agent's instruction with its code spans removed: a command or a path may name anything. */
function prose(note: string): string {
  return note.replace(/`[^`]*`/g, " ");
}

/** True when the text names a JSON field (one with an underscore) as a word, outside a code span. */
function namesAField(text: string): string[] {
  const plain = prose(text);
  return knownDirectiveFieldNames()
    .filter((name) => name.includes("_"))
    .filter((name) => new RegExp(`(^|[^\\w./-])${name}(?![\\w./-])`).test(plain));
}

// --- Fixtures: the steps the engine builds, as plain objects -------------------

function runStage(extra: Json = {}): Json {
  return {
    kind: "run-stage",
    stage: "requirements-analysis",
    phase: "inception",
    lead_agent: "aidlc-product-agent",
    support_agents: [],
    mode: "inline",
    inline_context_paths: [
      ".claude/agents/aidlc-product-agent.md",
      ".claude/knowledge/aidlc-product-agent/requirements.md",
    ],
    gate: true,
    memory_path: "aidlc/spaces/default/intents/x/aidlc-docs/inception/requirements-analysis/memory.md",
    consumes: ["aidlc/spaces/default/intents/x/aidlc-docs/ideation/intent-capture/intent.md"],
    produces: ["aidlc/spaces/default/intents/x/aidlc-docs/inception/requirements-analysis/requirements.md"],
    rules_in_context: [],
    sensors_applicable: [],
    ceremony: { sensors: "on", learnings: "on", summary_confirmation: "off", plan_approval: "on", collaborators: "on" },
    stage_file: ".claude/aidlc-common/stages/inception/requirements-analysis.md",
    ...extra,
  };
}

const ASK_MODE = {
  mode: null,
  ask: true,
  reused_from: null,
  notice: "Later stages will use this way too. Say any time if you'd rather switch.",
};
const REUSED_MODE = {
  mode: "file",
  ask: false,
  reused_from: "intent-capture",
  notice: "Answering the way you chose earlier: I'll edit the file. Say if you'd rather be guided through them here or chat.",
};

function ask(type: string, extra: Json = {}): Json {
  return { ...askOf(type), ...extra };
}

function askOf(type: string): Json {
  const base: Json = { kind: "ask", ask_type: type, question: "The question for the person." };
  switch (type) {
    case "scope-confirm":
      return {
        ...base,
        response_route: "next",
        proposed_scope: "bugfix",
        confirm_command: `${INVOCATION} next --scope bugfix --request a1b2c3d4`,
        compose_command: `${INVOCATION} next compose --request a1b2c3d4`,
        scope_commands: [{ scope: "classic", command: `${INVOCATION} next --scope classic --request a1b2c3d4`, stages: "15 stages" }],
        choices: [
          { label: 'Go ahead with the "bugfix" plan', command: `${INVOCATION} next --scope bugfix --request a1b2c3d4` },
          { label: "Tailor a plan to this task", command: `${INVOCATION} next compose --request a1b2c3d4` },
        ],
      };
    case "compose-offer":
      return {
        ...base,
        response_route: "next",
        compose_command: `${INVOCATION} next compose --request a1b2c3d4`,
        scope_commands: [
          { scope: "bugfix", command: `${INVOCATION} next --scope bugfix --request a1b2c3d4`, stages: "7 stages" },
          { scope: "classic", command: `${INVOCATION} next --scope classic --request a1b2c3d4`, stages: "15 stages" },
        ],
      };
    case "intent-pick":
      return {
        ...base,
        response_route: "next",
        available_intents: ["auth-fix", "notes-app"],
        select_commands: [
          { selector: "auth-fix", command: `${INVOCATION} next --pick 'auth-fix'` },
          { selector: "notes-app", command: `${INVOCATION} next --pick 'notes-app'` },
        ],
      };
    case "unit-paused":
      return {
        ...base,
        response_route: "command",
        stage: "code-generation",
        unit: "auth",
        resume_command: "bun .claude/tools/aidlc-state.ts unit resume --stage code-generation --unit auth",
      };
    case "project-type":
      return {
        ...base,
        response_route: "command",
        existing_code_command: `${INVOCATION} next --project-type brownfield`,
        new_project_command: `${INVOCATION} next --project-type greenfield`,
      };
    case "plan-approval":
      return {
        ...base,
        response_route: "next",
        stage: "code-generation",
        unit: "auth",
        plan_approval: {
          targets: [{
            unit: "auth",
            plan_path: "aidlc/spaces/default/intents/x/aidlc-docs/construction/auth/code-generation/plan.md",
            instructions_path: "aidlc/spaces/default/intents/x/aidlc-docs/construction/auth/code-generation/test-instructions.md",
            questions_path: "aidlc/spaces/default/intents/x/aidlc-docs/construction/auth/code-generation/code-generation-questions.md",
            summary: ["Builds the login form and its session cookie.", "Tests: three unit tests on the cookie."],
          }],
          choices: ["Approve Plan", "Request Changes", "I'll edit the files"],
          editing: false,
        },
      };
    case "guard-recovery":
      return {
        ...base,
        response_route: "execute-remedy",
        stage: "domain-design",
        reason_codes: ["REVIEW_FREEZE"],
        remedies: [
          {
            op: "request-changes",
            label: "Ask for changes",
            description: "Say what should change; the stage is revised and reviewed again.",
            action: "Report rejected with their words.",
            interaction: "human-input",
            requiresHuman: true,
            executableNow: true,
          },
          {
            op: "request-review",
            label: "Review it again",
            description: "The reviewer looks at the current files.",
            action: "Request a fresh review.",
            interaction: "human-input",
            requiresHuman: true,
            executableNow: true,
          },
        ],
      };
    case "unit-claim":
      return {
        ...base,
        response_route: "claim",
        claimable_units: ["auth", "notes"],
        claimed_units: [{ unit: "search", holder: "pat" }],
        waiting_units: [{ unit: "export", blocked_by: ["notes"] }],
      };
    case "legacy-plan-approval-recovery":
      return { ...base, response_route: "next", recovery_choice: "Recover Plan Approval" };
    default:
      throw new Error(type);
  }
}

function routingAsk(records: boolean): Json {
  return {
    kind: "ask",
    ask_type: "new-work-routing",
    response_route: "next",
    question: "Continue, start separate work, or reshape the plan?",
    numbered_prose_question: "What should I do?\n\n1. **A**\n2. **B**\n3. **C**\n4. " + OTHER + "\n\n" + HINT,
    choices: [
      { label: "A", command: `${INVOCATION} next --continue --request a1b2c3d4` },
      { label: "B", command: `${INVOCATION} next --new-intent --scope feature --request a1b2c3d4` },
      { label: "C", command: `${INVOCATION} next compose --request a1b2c3d4` },
    ],
    new_work_description: "add a metrics page",
    proposed_scope: "feature",
    new_intent_command: `${INVOCATION} next --new-intent --scope feature --request a1b2c3d4`,
    scope_commands: [{ scope: "bugfix", command: `${INVOCATION} next --new-intent --scope bugfix --request a1b2c3d4` }],
    compose_command: `${INVOCATION} next compose --request a1b2c3d4`,
    ...(records
      ? {
        available_intents: ["auth-fix", "notes-app"],
        select_commands: [
          { selector: "auth-fix", command: `${INVOCATION} next --continue --request a1b2c3d4 --record 'auth-fix'` },
          { selector: "notes-app", command: `${INVOCATION} next --continue --request a1b2c3d4 --record 'notes-app'` },
        ],
        reshape_commands: [
          { selector: "auth-fix", command: `${INVOCATION} next compose --request a1b2c3d4 --record 'auth-fix'` },
          { selector: "notes-app", command: `${INVOCATION} next compose --request a1b2c3d4 --record 'notes-app'` },
        ],
      }
      : { continue_command: `${INVOCATION} next --continue --request a1b2c3d4` }),
  };
}

const ASK_TYPES = [
  "scope-confirm", "compose-offer", "intent-pick", "unit-paused", "project-type", "plan-approval", "guard-recovery",
  "unit-claim", "legacy-plan-approval-recovery",
];

// --- The numbered rendering is one builder --------------------------------------

describe("the engine renders every question it asks", () => {
  test("the numbered form is the prompt, the options, Other, and the reply hint, in the routing question's shape", () => {
    expect(numberedProseQuestion("Which?", [{ label: "A", detail: "the first" }, { label: "B" }])).toBe(
      "Which?\n\n1. **A** \u2014 the first\n2. **B**\n3. " + OTHER + "\n\n" + HINT,
    );
  });

  test.each(ASK_TYPES)("a %s question carries its numbered form and its choices, each with the command that answers it", (type) => {
    const step = notes(ask(type));
    const choices = step.choices as Array<{ label: string; command?: string; detail?: string }>;
    expect(choices.length, type).toBeGreaterThan(0);
    const rendered = str(step.numbered_prose_question);
    expect(rendered.startsWith("The question for the person.")).toBe(true);
    choices.forEach((choice, at) => {
      expect(rendered, `${type} option ${at + 1}`).toContain(`\n${at + 1}. **${choice.label}**`);
      expect(typeof choice.command, `${type} ${choice.label} runs a command`).toBe("string");
    });
    expect(rendered).toContain(`\n${choices.length + 1}. ${OTHER}\n\n${HINT}`);
    const result = validateDirective(step);
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  test("the commands are the ones the skill rows named until now", () => {
    const by = (type: string) =>
      (notes(ask(type)).choices as Array<{ label: string; command?: string }>).map((c) => [c.label, c.command]);
    expect(by("intent-pick")).toEqual([
      ["auth-fix", `${INVOCATION} next --pick 'auth-fix'`],
      ["notes-app", `${INVOCATION} next --pick 'notes-app'`],
    ]);
    expect(by("unit-paused")).toEqual([["Resume", "bun .claude/tools/aidlc-state.ts unit resume --stage code-generation --unit auth"]]);
    expect(by("project-type")).toEqual([
      ["Yes, it is existing code to work on", `${INVOCATION} next --project-type brownfield`],
      ["No, it is a new project", `${INVOCATION} next --project-type greenfield`],
    ]);
    // A fixed label on a command line is quoted the way bash, zsh, PowerShell and cmd.exe all read as one argument:
    // the POSIX apostrophe splice ('"'"') reaches the program as three arguments through PowerShell (measured on
    // Windows PowerShell), so a Kiro IDE person on Windows who picks "I'll edit the files" had a command that could
    // not record their pick.
    expect(by("plan-approval")).toEqual([
      ["Approve Plan", `${LOG} answer --stage code-generation --checkpoint plan-approval --details "Approve Plan"`],
      ["Request Changes", `${LOG} answer --stage code-generation --checkpoint plan-approval --details "Request Changes"`],
      ["I'll edit the files", `${LOG} answer --stage code-generation --checkpoint plan-approval --details "I'll edit the files"`],
    ]);
    expect(fixedLabelArg("I'll edit the files")).toBe('"I\'ll edit the files"');
    expect(fixedLabelArg("Approve all")).toBe('"Approve all"');
    for (const unsafe of ['say "hi"', "a $HOME here", "tick `x`", "back\\slash", "100% sure", "a | b"]) {
      expect(fixedLabelArg(unsafe), unsafe).toBe(shellArg(unsafe));
    }
    expect(by("guard-recovery")).toEqual([
      ["Ask for changes", `${LOG} answer --stage domain-design --checkpoint guard-recovery --details request-changes`],
      ["Review it again", `${LOG} answer --stage domain-design --checkpoint guard-recovery --details request-review`],
    ]);
    expect(by("unit-claim")).toEqual([
      ["auth", `${INVOCATION} next --claim auth`],
      ["notes", `${INVOCATION} next --claim notes`],
    ]);
    expect(by("legacy-plan-approval-recovery")).toEqual([["Recover Plan Approval", `${INVOCATION} next`]]);
    expect(by("compose-offer")).toEqual([
      ["Tailor a plan to this task", `${INVOCATION} next compose --request a1b2c3d4`],
      ["The bugfix plan", `${INVOCATION} next --scope bugfix --request a1b2c3d4`],
      ["The classic plan", `${INVOCATION} next --scope classic --request a1b2c3d4`],
    ]);
    // A plan offer shows each ready-made plan with its length, as the rows did.
    expect(str(notes(ask("compose-offer")).numbered_prose_question)).toContain("2. **The bugfix plan** \u2014 7 stages");
  });

  test("the plan question shows each plan's summary and path above the choices", () => {
    const rendered = str(notes(ask("plan-approval")).numbered_prose_question);
    expect(rendered).toContain("Unit auth: the plan is at aidlc/spaces/default/intents/x/aidlc-docs/construction/auth/code-generation/plan.md");
    expect(rendered).toContain("- Builds the login form and its session cookie.");
    expect(rendered.indexOf("- Tests: three")).toBeLessThan(rendered.indexOf("1. **Approve Plan**"));
  });

  test("a guard question offers its ways on; a terminal one has no options; the agent's own work is no question", () => {
    const shown = notes(ask("guard-recovery"));
    expect((shown.choices as Array<{ label: string }>).map((c) => c.label)).toEqual(["Ask for changes", "Review it again"]);
    expect(str(shown.numbered_prose_question)).toContain("1. **Ask for changes** \u2014 Say what should change");
    const terminal = notes(ask("guard-recovery", { remedies: [], state_signature: "sig" }));
    expect(terminal.choices).toEqual([]);
    expect(terminal.numbered_prose_question).toBe("The question for the person.");
    const own = notes(ask("guard-recovery", { agent_work: true }));
    expect(own.choices).toBeUndefined();
    expect(own.numbered_prose_question).toBeUndefined();
    expect(own.question_note).toBeUndefined();
  });

  test("the routing question keeps the rendering and choices its emit site built, and its records form says so", () => {
    const active = notes(routingAsk(false));
    expect(active.numbered_prose_question).toBe(routingAsk(false).numbered_prose_question);
    expect(active.choices).toEqual(routingAsk(false).choices);
    // With records to pick, the continue and reshape answers need the piece named first.
    const records = notes(routingAsk(true));
    expect(str(records.question_note)).toContain("pieces of work the question lists");
    expect(str(active.question_note)).not.toContain("pieces of work the question lists");
  });

  test("the question's instruction says how a pick is acted on, and names no field", () => {
    const note = questionNote(INVOCATION);
    expect(note).toContain("show it to them with its choices as given, end your turn");
    expect(note).toContain("run that choice's command");
    expect(note).toContain(`run \`${INVOCATION} next\` when it returns none`);
    expect(note).toContain("read what they meant");
    expect(namesAField(note)).toEqual([]);
    expect(str(notes(ask("scope-confirm")).question_note)).toBe(note);
  });
});

// --- The stage step says what to do --------------------------------------------

describe("a stage step carries its instructions, not the fields to branch on", () => {
  test("the answer mode: ask once, with the question, the choices and the two log commands, then the notice", () => {
    const note = str(notes(runStage({ answer_mode: ASK_MODE })).answer_mode_note);
    expect(note).toContain("ask the person once how they want to answer them");
    expect(note).toContain("I've created [N] questions at [the questions file]. How would you like to answer them?");
    for (const label of ["Guide me", "I'll edit the file", "Chat"]) expect(note).toContain(label);
    expect(note).toContain(
      `\`${LOG} decision --stage requirements-analysis --decision "How would you like to answer the questions?" --options "Guide me,I'll edit the file,Chat"\``,
    );
    expect(note).toContain(`\`${LOG} answer --stage requirements-analysis --details '<the option label>'\``);
    expect(note.endsWith(ASK_MODE.notice)).toBe(true);
    // The mode question belongs to the stage's questions: a stage with none to ask asks nothing about how to answer.
    expect(note.startsWith("Only if this stage puts questions to the person")).toBe(true);
    expect(note).toContain("with none to ask, say nothing about how to answer");
  });

  test("the answer mode reused: say the notice, take the questions their way, record nothing for the mode", () => {
    const note = str(notes(runStage({ answer_mode: REUSED_MODE })).answer_mode_note);
    // The reused line is said right before the stage's first question, never at the top of a stage, and not at all
    // on a stage that puts no questions to the person (Code Generation, Build and Test, the deployment stages).
    expect(note.startsWith("Only if this stage puts questions to the person")).toBe(true);
    expect(note).toContain(`right before the first of them, say: ${REUSED_MODE.notice}`);
    expect(note).toContain("with none to ask, say nothing about how to answer");
    expect(note.startsWith("Say to the person")).toBe(false);
    expect(note).toContain("fill in the answers in the questions file");
    expect(note).toContain("no mode question and nothing recorded for the mode");
    expect(note).not.toContain("decision --stage");
    expect(notes(runStage()).answer_mode_note).toBeUndefined();
  });

  test("what to read first, in order, then the stage file and the inputs, pointed at by meaning", () => {
    const note = str(notes(runStage()).context_note);
    expect(note).toBe(
      "Before anything else, read the persona and knowledge files this step lists, one at a time and in the order " +
        "listed, with your file tool, and wait for each result. Then read the stage file it names and the inputs it names.",
    );
    const dispatched = str(notes(runStage({ mode: "subagent", inline_context_paths: [], consumes: [] })).context_note);
    expect(dispatched).toBe("Read the stage file this step names; the agents you dispatch load their own persona and knowledge.");
    // The note never repeats the step's lists: a large step sits close to the transport cap.
    expect(note).not.toContain(".claude/");
    // A step whose body does not run here reads nothing for it, asks no mode question and says nothing about a plan.
    for (const settled of [{ gate_only: true }, { swarm_settled: true }, { swarm_checkpoint: { batch: 1 } }, { wave: { entries: [] } }]) {
      const step = notes(runStage({ ...settled, answer_mode: ASK_MODE, consumes_absent: [{ path: "x.md", expected: false }] }));
      expect(step.context_note, JSON.stringify(settled)).toBeUndefined();
      expect(step.answer_mode_note, JSON.stringify(settled)).toBeUndefined();
      expect(step.inputs_note, JSON.stringify(settled)).toBeUndefined();
    }
  });

  test("a missing input the stage needed is one line for the person, then the recovery protocol; a by-design absence is silence", () => {
    const gap = notes(runStage({
      consumes_absent: [
        { path: "aidlc/spaces/default/intents/x/aidlc-docs/ideation/market-research/research.md", expected: true },
        { path: "aidlc/spaces/default/intents/x/aidlc-docs/inception/user-stories/stories.md", expected: false },
      ],
    }));
    const note = str(gap.inputs_note);
    expect(note).toContain('Say to the person once: "Some inputs this stage usually reads are not here: ' +
      'aidlc/spaces/default/intents/x/aidlc-docs/inception/user-stories/stories.md. I\'ll go on with what is here."');
    expect(note).not.toContain("market-research");
    expect(note).toContain("stage-protocol-recovery.md");
    const byDesign = notes(runStage({ consumes_absent: [{ path: "a.md", expected: true }] }));
    expect(byDesign.inputs_note).toBeUndefined();
  });

  test("a gate shown again says so, without the body", () => {
    const note = str(notes(runStage({ gate_only: true })).gate_note);
    expect(note).toContain("work and its review are done");
    expect(note).toContain("show its approval question again and end your turn");
    expect(note).toContain("do not run the stage again");
  });

  test("a Code Generation step says whether to plan, revise, repair or build", () => {
    const plan = (status: Json) => str(notes(runStage({ stage: "code-generation", phase: "construction", plan_approval: status })).plan_note);
    expect(plan({ status: "plan" })).toContain("Write this plan and its test instructions");
    expect(plan({ status: "plan" })).toContain("AI-DLC asks the person to approve the plan itself, never you");
    expect(plan({ status: "revise", feedback: "use cookies" })).toContain("asked for changes");
    expect(plan({ status: "repair", note: "The Testing Contract block lost its heading." })).toContain("Fix what the plan's note names");
    expect(plan({ status: "approved" })).toContain("build it as it is");
    expect(plan({ status: "approved" })).toContain("never rewrite an approved plan");
    const skipped = plan({ status: "approved", skipped: true, notice: "Plan approval is off for this work." });
    expect(skipped.startsWith("Say to the person first: Plan approval is off for this work.")).toBe(true);
    expect(skipped).toContain("without asking for approval");
    expect(notes(runStage()).plan_note).toBeUndefined();
  });

  test("a dispatched step hands over the brief's lines ready to paste", () => {
    const mob = str(notes(runStage({ mode: "mob", protocol_modules: ["reviewer", "learnings"] })).brief_note);
    expect(mob).toBe(
      "Every agent brief for this stage carries these lines word for word: Sensors: on. Learnings: on. " +
        "Summary Confirmation: off. Plan Approval: on. Collaborators: on. Protocol modules: reviewer, learnings.",
    );
    expect(str(notes(runStage({ mode: "pipeline" })).brief_note)).toContain("Protocol modules: none.");
    expect(notes(runStage({ wave: { entries: [] } })).brief_note).toBeDefined();
    expect(notes(runStage()).brief_note).toBeUndefined();
  });

  test("the summary confirmation is one sentence when it is on, and nothing when off", () => {
    const on = runStage({ ceremony: { ...(runStage().ceremony as Json), summary_confirmation: "on" } });
    expect(str(notes(on).ceremony_note)).toContain("confirm the summary of the answers with the person");
    expect(notes(runStage()).ceremony_note).toBeUndefined();
    expect(notes({ ...on, gate_only: true }).ceremony_note).toBeUndefined();
  });

  test("no instruction names a JSON field", () => {
    const steps: Json[] = [
      notes(runStage({
        answer_mode: ASK_MODE,
        mode: "mob",
        protocol_modules: ["reviewer"],
        consumes_absent: [{ path: "x.md", expected: false }],
        ceremony: { ...(runStage().ceremony as Json), summary_confirmation: "on" },
        stage: "code-generation",
        plan_approval: { status: "approved", skipped: true, notice: "Plan approval is off." },
      })),
      notes(runStage({ answer_mode: REUSED_MODE, gate_only: true })),
      ...ASK_TYPES.map((type) => notes(ask(type))),
      notes(routingAsk(true)),
    ];
    const leaks: string[] = [];
    for (const step of steps) {
      for (const [field, value] of Object.entries(step)) {
        if (!/_note$/.test(field) || typeof value !== "string") continue;
        for (const name of namesAField(value)) leaks.push(`${field} names ${name}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("each instruction is a legal field only beside what it is about", () => {
    const valid = (step: Json) => validateDirective(step).valid;
    expect(valid(notes(runStage({ answer_mode: ASK_MODE, gate_only: true, consumes_absent: [{ path: "a", expected: false }] })))).toBe(true);
    expect(valid({ ...runStage(), answer_mode_note: "x" })).toBe(false);
    expect(valid({ ...runStage(), inputs_note: "x" })).toBe(false);
    expect(valid({ ...runStage(), plan_note: "x" })).toBe(false);
    expect(valid({ ...runStage(), context_note: "" })).toBe(false);
    expect(valid({ ...ask("intent-pick"), choices: [{ command: "no label" }] })).toBe(false);
    expect(valid({ ...ask("intent-pick"), choices: [{ label: "fine", detail: "with a detail" }] })).toBe(true);
  });

  test("the one context warning the person reads names no field and no byte cap", () => {
    const warning = omittedContextWarning(2);
    expect(warning).toBe("Some of this step's optional reference files were left out to fit; the work goes on without them.");
    expect(warning).not.toMatch(/inline_context_paths|bytes/);
  });
});
