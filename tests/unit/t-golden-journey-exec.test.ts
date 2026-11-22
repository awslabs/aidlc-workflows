// The golden journey's person on a tool that runs one typed line per process
// (codex exec, copilot -p, opencode run): what they type after each turn comes
// from the engine steps of that session, the plan question left for the day
// comes back first in a new session and counts once, and the path checks read
// only what the journey covers, and a question the agent asked from the
// stage's questions file without logging it reaches them as the Stop hook reads
// it, and a question it asked in chat with nothing on record reaches them as a
// model reads its words, and the person's files stay as they were until their
// pick of a plan starts the work. Seeded audit rows, questions files, engine
// output, shipped trees and a stand-in for the model stand in for a live run,
// so each case is exact.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addRootBlocks } from "../../dist/claude/.claude/tools/aidlc-includes.ts";
import { sourceBaselineAuditFields, workspaceBaselineStageSlugs } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codexReplies, codexToolResults, copilotToolResults, copilotTurnCommand, opencodeRunCommand, opencodeToolResults } from "../harness/exec-drive.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT, seededAuditShard, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { type GoldenJourney, type GoldenRun, goldenPathProblems, GoldenPerson } from "../harness/golden-journey.ts";
import { seedGreeter } from "../harness/release-journey.ts";
import type { CapturedToolResult } from "../harness/sdk-drive.ts";

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

/**
 * A project; with `stage`, its work is under way there (the audit is read for
 * the work in progress), and with `awaiting` that stage waits for approval.
 */
function project(stage?: string, awaiting = false): string {
  const dir = createTestProject();
  projects.push(dir);
  if (stage) {
    writeFileSync(seededStateFile(dir), `# AI-DLC State\n\n- **Current Stage**: ${stage}\n${awaiting ? `\n- [?] ${stage} inception EXECUTE\n` : ""}`);
  }
  return dir;
}

let clock = 0;
function row(dir: string, event: string, fields: Record<string, string> = {}): void {
  const shard = seededAuditShard(dir);
  mkdirSync(dirname(shard), { recursive: true });
  const at = new Date(Date.UTC(2026, 9, 16, 12, 0, clock++)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = Object.entries(fields).map(([name, value]) => `**${name}**: ${value}`);
  appendFileSync(shard, [`## ${event}`, `**Timestamp**: ${at}`, `**Event**: ${event}`, ...lines, "", "---", "", ""].join("\n"));
}

function journey(proj: string, extra: Partial<GoldenJourney> = {}): GoldenJourney {
  return {
    proj, scope: "bugfix", hasCode: true, request: "$aidlc fix the greeter",
    ownWords: { stage: "requirements-analysis", words: "Keep it small" }, lastStage: "code-generation", budget: () => undefined, ...extra,
  };
}

/** One shell call the agent made, with what it printed. */
function shell(command: string, printed: unknown): CapturedToolResult {
  return { toolName: "Bash", input: { command }, toolUseId: command, resultText: JSON.stringify(printed), isError: false };
}

const CHOICES = ["Approve Plan", "Request Changes", "I'll edit the files"];
const PLAN_ASK = shell("bun .codex/tools/aidlc.ts engine orchestrate next", {
  kind: "ask", ask_type: "plan-approval", stage: "code-generation", question: "Approve the code plan?", response_route: "next",
  choices: CHOICES.map((label) => ({ label, command: "bun .codex/tools/aidlc-log.ts answer --stage code-generation" })),
  plan_approval: { targets: [{ unit: null, plan_path: "plan.md", instructions_path: "i.md", questions_path: "q.md", summary: [] }], choices: CHOICES, editing: false },
});

function run(person: GoldenPerson, extra: Partial<GoldenRun> = {}): GoldenRun {
  return { ...person.typedRun(), ...extra };
}

describe("the person on a typed tool", () => {
  test("the plan offer the engine hands out through aidlc-orchestrate.ts reaches them", () => {
    const person = new GoldenPerson(journey(project()));
    const go = "bun .codex/tools/aidlc-orchestrate.ts next --scope bugfix --request c46934e4";
    const offer = shell("bun .codex/tools/aidlc-orchestrate.ts next --propose bugfix --request c46934e4", {
      kind: "ask", ask_type: "scope-confirm", question: "I'd run the bugfix plan. Go ahead?", response_route: "next",
      proposed_scope: "bugfix", confirm_command: go, compose_command: "compose", scope_commands: [],
      choices: [{ label: 'Go ahead with the "bugfix" plan', command: go }, { label: "Use a different plan" }],
    });
    expect(person.typedReply(1, [offer])).toEqual({ line: 'Go ahead with the "bugfix" plan', newSession: false });
    expect(person.problems).toEqual([]);
  });

  test("a print after the question they were given changes nothing waiting for them", () => {
    const person = new GoldenPerson(journey(project()));
    // The agent ran ahead after showing the offer, and the engine said nothing was started.
    const ranAhead = shell("bun .aidlc/tools/aidlc-orchestrate.ts next --scope bugfix --request c46934e4", {
      kind: "print", message: "Nothing was started: the person has not answered the plan question yet. Show them the question as it was given and end your turn.",
    });
    expect(person.typedReply(1, [PLAN_ASK, ranAhead])).toEqual({ line: "Approve Plan", newSession: false });
    expect(person.problems).toEqual([]);
  });

  test("the plan question left for the day comes back first in a new session and counts once", () => {
    const proj = project();
    const person = new GoldenPerson(journey(proj, { newSessionAtPlan: "$aidlc" }));
    expect(person.typedReply(1, [PLAN_ASK])).toEqual({ line: "$aidlc", newSession: true });
    expect(person.typedReply(2, [PLAN_ASK])).toEqual({ line: "Approve Plan", newSession: false });
    expect(person.problems).toEqual([]);
    expect(person.planAsked).toBe(1);
    expect(goldenPathProblems(journey(proj), run(person)).filter((p) => p.includes("plan question"))).toEqual([]);
    // A third offer is the plan asked twice.
    person.typedReply(3, [PLAN_ASK]);
    expect(person.problems).toEqual(["asked twice: the plan-approval question at (no work yet)"]);
  });

  test("a new session that asks nothing is a turn with nothing asked, never the old session's plan question", () => {
    const person = new GoldenPerson(journey(project(), { newSessionAtPlan: "$aidlc" }));
    person.typedReply(1, [PLAN_ASK]);
    expect(person.typedReply(2, []).line).toBeUndefined();
    expect(person.problems).toHaveLength(1);
    expect(person.problems[0]).toStartWith("turn 2 ended at (no work yet) with nothing asked of the person");
    expect(person.typedRun().problems).toContain("the plan question left for the day was never offered again in the new session");
  });

  test("a new session that asks something else first says so", () => {
    const person = new GoldenPerson(journey(project(), { newSessionAtPlan: "$aidlc" }));
    person.typedReply(1, [PLAN_ASK]);
    person.typedReply(2, [shell("bun .codex/tools/aidlc.ts engine orchestrate next", {
      kind: "ask", ask_type: "project-type", question: "Is this existing code?", response_route: "command",
      existing_code_command: "existing", new_project_command: "new",
    })]);
    expect(person.problems).toEqual(["the new session asked the project-type question at (no work yet) before the plan question left open for the day"]);
  });
});

describe("a question the stage's questions file holds", () => {
  const QUESTION = [
    "# Requirements Analysis questions",
    "",
    "## Q1. [Product] Missing-name behavior",
    "",
    "For missing-name behavior, what should the CLI do when it is run with no name?",
    "",
    "A. Keep missing-name behavior out of scope for this bugfix",
    "B. Print a generic greeting when no name is provided",
    "X. Other (please specify)",
    "",
  ].join("\n");
  const SUMMARY = "\n## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n- Looks correct\n- Request changes\n\n";

  // Requirements Analysis under way, the way to answer picked, and the questions file as the agent left it.
  function guided(questions: string): string {
    const dir = createTestProject();
    projects.push(dir);
    writeFileSync(seededStateFile(dir), [
      "# AI-DLC State", "", "- **Lifecycle Phase**: INCEPTION", "- **Current Stage**: requirements-analysis", "",
      "- [x] reverse-engineering inception EXECUTE", "- [-] requirements-analysis inception EXECUTE", "",
    ].join("\n"));
    row(dir, "DECISION_RECORDED", { Stage: "requirements-analysis", Decision: "How would you like to answer the questions?", Options: "Guide me,I'll edit the file,Chat" });
    row(dir, "QUESTION_ANSWERED", { Stage: "requirements-analysis", Details: "Guide me" });
    const file = join(seededRecordDir(dir), "inception", "requirements-analysis", "requirements-analysis-questions.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, questions);
    return dir;
  }

  test("the agent asked it in chat without logging it: the person answers it, in their own words for the first one", () => {
    const person = new GoldenPerson(journey(guided(`${QUESTION}[Answer]:\n`)));
    expect(person.typedReply(4, [])).toEqual({ line: "Keep it small", newSession: false });
    expect(person.problems).toEqual([]);
    expect(person.said).toEqual(['typed "Keep it small" for "Q1. [Product] Missing-name behavior" (in the questions file) at requirements-analysis']);
  });

  test("the same question still waiting after their answer reached them twice", () => {
    const person = new GoldenPerson(journey(guided(`${QUESTION}[Answer]:\n`)));
    person.typedReply(4, []);
    expect(person.typedReply(5, []).line).toBe("Keep missing-name behavior out of scope for this bugfix");
    expect(person.problems).toEqual(['asked twice: "Q1. [Product] Missing-name behavior" at requirements-analysis']);
  });

  test("a blank summary confirmation gets the plain choice", () => {
    const person = new GoldenPerson(journey(guided(`${QUESTION}[Answer]: B\n${SUMMARY}[Answer]: __\n`)));
    expect(person.typedReply(6, []).line).toBe("Looks correct");
    expect(person.problems).toEqual([]);
  });

  test("every answer filled in: nothing waits for the person, and the turn is still one with nothing asked", () => {
    const person = new GoldenPerson(journey(guided(`${QUESTION}[Answer]: B\n${SUMMARY}[Answer]: Looks correct\n`)));
    expect(person.typedReply(7, []).line).toBeUndefined();
    expect(person.problems).toHaveLength(1);
    expect(person.problems[0]).toStartWith("turn 7 ended at requirements-analysis with nothing asked of the person");
  });
});

describe("the plan question is one question, whichever record shows it", () => {
  // The Copilot golden of 2026-10-22 (nightly 39678180458, attempt 1): the first session ends with the plan question
  // the agent showed from the engine's note, so the person finds it in the questions file; the new session's /aidlc
  // shows it as the engine's ask. The person met it once in each session, as the journey asks.
  const PLAN_FILE = [
    "# Code Generation Plan Approval", "", "## Plan Approval", "", "Approve the code plan?", "",
    "- Builds: the greeting uses the name.", "", "- A. Approve Plan", "- B. Request Changes", "- C. I'll edit the files", "",
    "[Answer]:", "",
  ].join("\n");
  const RUN_STAGE = shell("bun .aidlc/tools/aidlc-orchestrate.ts continue EGu2NsTK", { kind: "run-stage", stage: "code-generation", phase: "construction" });

  test("left for the day from the questions file, it comes back as the engine's ask in the new session and counts once", () => {
    const dir = createTestProject();
    projects.push(dir);
    writeFileSync(seededStateFile(dir), "# AI-DLC State\n\n- **Lifecycle Phase**: CONSTRUCTION\n- **Current Stage**: code-generation\n");
    const file = join(seededRecordDir(dir), "construction", "code-generation", "code-generation-questions.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, PLAN_FILE);
    const person = new GoldenPerson(journey(dir, { newSessionAtPlan: "/aidlc" }));
    expect(person.typedReply(6, [RUN_STAGE])).toEqual({ line: "/aidlc", newSession: true });
    expect(person.typedReply(7, [PLAN_ASK])).toEqual({ line: "Approve Plan", newSession: false });
    expect(person.problems).toEqual([]);
    expect(person.planAsked).toBe(1);
    expect(person.typedRun().problems).not.toContain("the plan question left for the day was never offered again in the new session");
  });
});

describe("a question the agent asked in chat with nothing on record", () => {
  const ASKED = "Which persona should the stories start with? A) the admin B) a guest";
  const reads = (verdict: { asked: boolean; question: string; reason: string } | { failure: string }) => {
    const seen: string[] = [];
    const openQuestion = (words: string) => {
      seen.push(words);
      return verdict;
    };
    return { seen, openQuestion };
  };

  test("the person answers it as they answer an agent's question, in their own words at their stage", () => {
    const judge = reads({ asked: true, question: "Which persona first?", reason: "it asks which persona" });
    const person = new GoldenPerson(journey(project("user-stories"), { openQuestion: judge.openQuestion }));
    expect(person.typedReply(3, [], ASKED)).toEqual({ line: "Go with what you recommend", newSession: false });
    expect(judge.seen).toEqual([ASKED]);
    expect(person.problems).toEqual([]);
    expect(person.said).toEqual(['typed "Go with what you recommend" for "Which persona first?" (asked in chat) at user-stories']);
    const own = new GoldenPerson(journey(project("requirements-analysis"), { openQuestion: judge.openQuestion }));
    expect(own.typedReply(3, [], ASKED).line).toBe("Keep it small");
  });

  test("the same question again reached them twice", () => {
    const judge = reads({ asked: true, question: "Which persona first?", reason: "it asks" });
    const person = new GoldenPerson(journey(project("user-stories"), { openQuestion: judge.openQuestion }));
    person.typedReply(3, [], ASKED);
    person.typedReply(4, [], ASKED);
    expect(person.problems).toEqual(['asked twice: "Which persona first?" at user-stories']);
  });

  test("words that ask nothing leave the turn one with nothing asked, with the model's reason", () => {
    const person = new GoldenPerson(journey(project("user-stories"), { openQuestion: reads({ asked: false, question: "", reason: "it only reports what it did" }).openQuestion }));
    expect(person.typedReply(3, [], "I wrote the stories.").line).toBeUndefined();
    expect(person.problems).toEqual(["turn 3 ended at user-stories with nothing asked of the person (it only reports what it did); the engine's last step was null"]);
  });

  test("a judge that cannot answer leaves the turn as it was, saying why; no words, no judge", () => {
    const failed = new GoldenPerson(journey(project("user-stories"), { openQuestion: reads({ failure: "the judge could not run (exit 127): claude: not found" }).openQuestion }));
    failed.typedReply(3, [], ASKED);
    expect(failed.problems[0]).toStartWith("turn 3 ended at user-stories with nothing asked of the person (the judge could not run (exit 127)");
    const silent = reads({ asked: true, question: "never asked", reason: "" });
    const person = new GoldenPerson(journey(project("user-stories"), { openQuestion: silent.openQuestion }));
    expect(person.typedReply(3, []).line).toBeUndefined();
    expect(silent.seen).toEqual([]);
    expect(person.problems[0]).toStartWith("turn 3 ended at user-stories with nothing asked of the person (the agent said nothing to the person)");
  });

  test("what Codex told the person comes from its JSON stream's finished agent messages, in order", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "First." } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "ls", aggregated_output: "x", exit_code: 0 } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "  " } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Which persona first?" } }),
      "not json",
    ].join("\n");
    expect(codexReplies(stdout)).toEqual([{ text: "First." }, { text: "Which persona first?" }]);
  });
});

describe("the golden path checks", () => {
  test("a stage after the journey's last one may wait for approval: a typed turn carries on past the last approval", () => {
    const proj = project("build-and-test");
    row(proj, "STAGE_AWAITING_APPROVAL", { Stage: "code-generation" });
    row(proj, "GATE_APPROVED", { Stage: "code-generation" });
    row(proj, "STAGE_AWAITING_APPROVAL", { Stage: "build-and-test" });
    const waiting = () => goldenPathProblems(journey(proj), run(new GoldenPerson(journey(proj)), { start: 0 }))
      .filter((p) => p.includes("waited for approval"));
    expect(waiting()).toEqual([]);
    row(proj, "STAGE_AWAITING_APPROVAL", { Stage: "requirements-analysis" });
    expect(waiting()).toEqual(["requirements-analysis waited for approval and was never approved"]);
  });

  test("the own-words check applies only where the stage asked a question of its own", () => {
    const proj = project("requirements-analysis");
    const ownWords = () => goldenPathProblems(journey(proj), run(new GoldenPerson(journey(proj)), { start: 0 }))
      .filter((p) => p.includes("own words"));
    expect(ownWords()).toEqual([]);
    row(proj, "DECISION_RECORDED", { Stage: "requirements-analysis", Decision: "How would you like to answer the questions?", Options: "Guide me,I'll edit the file,Chat" });
    expect(ownWords()).toEqual([]);
    row(proj, "DECISION_RECORDED", { Stage: "requirements-analysis", Decision: "Q1: no name given", Options: "A,B,C,X" });
    expect(ownWords()).toEqual(["no question at requirements-analysis took the person's own words"]);
  });

  test("the person's own words are on the record as given: the box's reply, or beside the answer", () => {
    const kept = (proj: string) => goldenPathProblems(journey(proj), run(new GoldenPerson(journey(proj)), { start: 0, ownWordsUsed: true }))
      .filter((p) => p.includes("own words"));
    const boxed = project("requirements-analysis");
    row(boxed, "QUESTION_ANSWERED", { Stage: "requirements-analysis", Details: "B" });
    expect(kept(boxed)).toEqual(["the person's own words at requirements-analysis are not on the record"]);
    row(boxed, "QUESTION_REPLIED", { Question: "Q1: no name given", Reply: "Keep it small" });
    expect(kept(boxed)).toEqual([]);
    const typed = project("requirements-analysis");
    row(typed, "QUESTION_ANSWERED", { Stage: "requirements-analysis", Details: "B", "Person Reply": "keep it  small" });
    expect(kept(typed)).toEqual([]);
  });
});

describe("Codex exec's JSON stream", () => {
  test("each finished shell command becomes a tool call with what it printed", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "01a14429-3fbb-7731-9485-0cdf473ce4b6" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Looking." } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "/bin/bash -lc 'bun .codex/tools/aidlc.ts engine orchestrate next'", aggregated_output: '{"kind":"ask"}\n', exit_code: 0 } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "command_execution", command: "/bin/bash -lc 'false'", aggregated_output: "", exit_code: 1 } }),
      "not json",
    ].join("\n");
    expect(codexToolResults(stdout)).toEqual([
      { toolName: "Bash", input: { command: "/bin/bash -lc 'bun .codex/tools/aidlc.ts engine orchestrate next'" }, toolUseId: "item_2", resultText: '{"kind":"ask"}\n', isError: false },
      { toolName: "Bash", input: { command: "/bin/bash -lc 'false'" }, toolUseId: "item_3", resultText: "", isError: true },
    ]);
  });
});

describe("Copilot CLI's JSON stream", () => {
  test("each finished shell command, bash or powershell, becomes a tool call with what it printed", () => {
    const event = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data });
    const stdout = [
      event("user.message", { content: "/aidlc fix the greeter" }),
      event("tool.execution_start", { toolCallId: "call_1", toolName: "bash", arguments: { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next", description: "Run" } }),
      event("tool.execution_start", { toolCallId: "call_2", toolName: "view", arguments: { path: "README.md" } }),
      event("tool.execution_complete", { toolCallId: "call_2", success: true, result: { content: "# greeter" } }),
      event("tool.execution_complete", { toolCallId: "call_1", success: true, result: { content: '{"kind":"ask"}\n<shellId: 0 completed with exit code 0>' } }),
      event("tool.execution_start", { toolCallId: "call_3", toolName: "powershell", arguments: { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next" } }),
      event("tool.execution_complete", { toolCallId: "call_3", success: false, result: { content: "refused" } }),
      "not json",
    ].join("\n");
    expect(copilotToolResults(stdout)).toEqual([
      { toolName: "Bash", input: { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next" }, toolUseId: "call_1", resultText: '{"kind":"ask"}\n<shellId: 0 completed with exit code 0>', isError: false },
      { toolName: "Bash", input: { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next" }, toolUseId: "call_3", resultText: "refused", isError: true },
    ]);
  });
});

describe("a Copilot CLI turn", () => {
  const options = { copilotHome: "home", sessionId: "11111111-2222-4333-8444-555555555555", resume: true };
  const line = 'Go ahead with the "bugfix" plan';

  test("on stdin the line the person typed reaches Copilot as typed and is no argument a launcher reads", () => {
    const { argv, input } = copilotTurnCommand(line, { ...options, stdin: true });
    expect(input).toBe(line);
    expect(argv).not.toContain(line);
    expect(argv).toEqual(["-s", "--no-remote", "--allow-all-tools", "--resume", options.sessionId]);
  });

  test("without it the line rides -p, as the release journey types it", () => {
    expect(copilotTurnCommand(line, options)).toEqual({
      argv: ["-p", line, "-s", "--no-remote", "--allow-all-tools", "--resume", options.sessionId],
    });
  });
});

describe("one change request at a stage's approval", () => {
  const CHANGE = "Request changes: also say that the only test runs the command line";

  test("the person's first reply to that approval asks for the change; the gate offered again after it counts once", () => {
    const person = new GoldenPerson(journey(project("reverse-engineering", true), {
      lastStage: "reverse-engineering", changeRequest: { stage: "reverse-engineering", words: CHANGE },
    }));
    expect(person.typedReply(1, []).line).toBe(CHANGE);
    expect(person.typedReply(2, []).line).toBe("Approve");
    expect(person.problems).toEqual([]);
    person.typedReply(3, []);
    expect(person.problems).toEqual(["asked twice: the reverse-engineering approval"]);
  });

  test("the record holds that one change, in the person's words, at that stage", () => {
    const proj = project("reverse-engineering");
    const j = journey(proj, { lastStage: "reverse-engineering", changeRequest: { stage: "reverse-engineering", words: CHANGE } });
    const changes = () => goldenPathProblems(j, run(new GoldenPerson(j), { start: 0 }))
      .filter((p) => /GATE_REJECTED|STAGE_REVISING|their words/.test(p));
    expect(changes()).toEqual([
      "GATE_REJECTED recorded 0 times; the person asked for one change, at reverse-engineering",
      "STAGE_REVISING recorded 0 times; the person asked for one change, at reverse-engineering",
    ]);
    row(proj, "GATE_REJECTED", { Stage: "reverse-engineering", Feedback: `"${CHANGE}"` });
    row(proj, "STAGE_REVISING", { Stage: "reverse-engineering", Feedback: `"${CHANGE}"` });
    expect(changes()).toEqual([]);
    row(proj, "GATE_REJECTED", { Stage: "reverse-engineering", Feedback: "Request changes" });
    expect(changes()).toEqual(["GATE_REJECTED recorded 2 times; the person asked for one change, at reverse-engineering"]);
  });

  test("the record without the person's words for the change says so", () => {
    const proj = project("reverse-engineering");
    const j = journey(proj, { lastStage: "reverse-engineering", changeRequest: { stage: "reverse-engineering", words: CHANGE } });
    row(proj, "GATE_REJECTED", { Stage: "reverse-engineering", Feedback: "Request changes" });
    row(proj, "STAGE_REVISING", { Stage: "reverse-engineering" });
    expect(goldenPathProblems(j, run(new GoldenPerson(j), { start: 0 })).filter((p) => p.includes("their words")))
      .toEqual(["the change the person asked for at reverse-engineering is not on the record in their words"]);
  });
});

describe("an opencode run turn", () => {
  test("a line after the skill runs the shipped command with its words, each word an argument", () => {
    const { argv, input } = opencodeRunCommand("/aidlc fix the greeter: it says hello");
    expect(input).toBeUndefined();
    expect(argv.slice(0, 3)).toEqual(["run", "--command", "aidlc"]);
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "fix", "the", "greeter:", "it", "says", "hello"]);
    expect(argv.slice(argv.indexOf("--format"), argv.indexOf("--format") + 2)).toEqual(["--format", "json"]);
  });

  test("any other line continues the session as typed, on stdin, never as an argument a Windows launcher refuses", () => {
    const { argv, input } = opencodeRunCommand('Go ahead with the "bugfix" plan', "ses_1");
    expect(argv.slice(0, 3)).toEqual(["run", "-s", "ses_1"]);
    expect(argv).not.toContain("--command");
    expect(argv).not.toContain("--");
    expect(argv.some((arg) => arg.includes('"'))).toBe(false);
    expect(input).toBe('Go ahead with the "bugfix" plan');
  });

  test("its JSON events give the session and each tool call with what it printed", () => {
    const event = (part: Record<string, unknown>) => JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { type: "tool", ...part } });
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
      event({ tool: "bash", callID: "c1", state: { status: "completed", input: { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next" }, output: '{"kind":"ask"}\n' } }),
      event({ tool: "bash", callID: "c2", state: { status: "error", input: { command: "rm -r x" }, error: "The user rejected permission to use this specific tool call." } }),
      "not json",
    ].join("\n");
    expect(opencodeToolResults(stdout)).toEqual({
      sessionId: "ses_1",
      results: [
        { toolName: "Bash", input: { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next" }, toolUseId: "c1", resultText: '{"kind":"ask"}\n', isError: false },
        { toolName: "Bash", input: { command: "rm -r x" }, toolUseId: "c2", resultText: "The user rejected permission to use this specific tool call.", isError: true },
      ],
    });
  });
});

describe("the person's files until their pick of a plan starts the work", () => {
  const TREES = ["claude", "codex", "copilot", "opencode", "kiro", "kiro-ide", "cursor"];
  // A Copilot golden run of 2026-10-23: in its first turn, before the plan question was ever shown, the agent left
  // src/app.js like this, and WORKFLOW_STARTED's Source Baseline listed it so.
  const FIXED = `const name = process.argv[2];\nconsole.log(\`Hello, \${name}!\`);\n`;

  /** The person's greeter with `tree`'s shipped files copied in, as a copy that config never ran in. */
  function greeter(tree: string): string {
    const dir = createTestProject();
    projects.push(dir);
    cpSync(join(REPO_ROOT, "dist", tree), dir, { recursive: true });
    seedGreeter(dir);
    return dir;
  }

  /** Their pick starts the work: `intent create` writes its state and WORKFLOW_STARTED, which lists their files. */
  function picked(dir: string, baseline?: string): void {
    writeFileSync(seededStateFile(dir), "# AI-DLC State\n\n- **Current Stage**: workspace-detection\n");
    row(dir, "WORKFLOW_STARTED", {
      Scope: "bugfix", ...(baseline === undefined ? sourceBaselineAuditFields(dir, workspaceBaselineStageSlugs()) : { "Source Baseline": baseline }),
    });
  }

  const fileLines = (person: GoldenPerson, dir: string) =>
    goldenPathProblems(journey(dir), run(person)).filter((p) => /the person's files|list of the person's files/.test(p));

  test("an edit before their pick is named: the kept Copilot run", () => {
    const dir = greeter("copilot");
    const person = new GoldenPerson(journey(dir));
    writeFileSync(join(dir, "src", "app.js"), FIXED);
    picked(dir);
    expect(fileLines(person, dir)).toEqual(["the person's files changed before their pick started the work: src/app.js"]);
  });

  test("a file removed and a file added before their pick are named too", () => {
    const dir = greeter("copilot");
    const person = new GoldenPerson(journey(dir));
    unlinkSync(join(dir, "README.md"));
    writeFileSync(join(dir, "src", "name.js"), "module.exports = (name) => name;\n");
    picked(dir);
    expect(fileLines(person, dir)).toEqual(["the person's files changed before their pick started the work: README.md, src/name.js"]);
  });

  for (const tree of TREES) {
    test(`on the ${tree} tree, AI-DLC's own first session changes none of their files, and an edit is named`, () => {
      const untouched = greeter(tree);
      const person = new GoldenPerson(journey(untouched));
      addRootBlocks(untouched);
      picked(untouched);
      expect(fileLines(person, untouched)).toEqual([]);
      const edited = greeter(tree);
      const ranAhead = new GoldenPerson(journey(edited));
      addRootBlocks(edited);
      writeFileSync(join(edited, "src", "app.js"), FIXED);
      picked(edited);
      expect(fileLines(ranAhead, edited)).toEqual(["the person's files changed before their pick started the work: src/app.js"]);
    });
  }

  test("AI-DLC's part of the root files, the host's own folder and the work after their pick are not theirs changed first", () => {
    // The kept opencode run: AI-DLC's first session added its part of .gitignore and AGENTS.md, and opencode installed
    // its plugin's packages in .opencode, before the pick.
    const dir = greeter("opencode");
    const person = new GoldenPerson(journey(dir));
    expect(addRootBlocks(dir)).toEqual(expect.arrayContaining([".gitignore", "AGENTS.md"]));
    writeFileSync(join(dir, ".opencode", "package.json"), '{ "dependencies": { "@opencode-ai/plugin": "1.19.4" } }\n');
    picked(dir);
    writeFileSync(join(dir, "src", "app.js"), FIXED);
    writeFileSync(join(dir, "src", "name.js"), "module.exports = (name) => name;\n");
    expect(fileLines(person, dir)).toEqual([]);
  });

  test("with no pick in the journey, a change by its end is named", () => {
    const dir = greeter("claude");
    const person = new GoldenPerson(journey(dir));
    writeFileSync(join(dir, "src", "app.js"), FIXED);
    expect(fileLines(person, dir)).toEqual(["the person's files changed and no plan was picked: src/app.js"]);
  });

  test("a pick before the journey began leaves nothing to check", () => {
    const dir = greeter("claude");
    picked(dir);
    const person = new GoldenPerson(journey(dir));
    writeFileSync(join(dir, "src", "app.js"), FIXED);
    expect(fileLines(person, dir)).toEqual([]);
  });

  test("a pick whose record keeps no list of their files says so", () => {
    const dir = greeter("claude");
    const person = new GoldenPerson(journey(dir));
    picked(dir, "unbindable");
    expect(fileLines(person, dir)).toEqual([
      "the record keeps no list of the person's files from when their pick started the work (Source Baseline unbindable), so the journey cannot tell whether they changed before it",
    ]);
  });
});
