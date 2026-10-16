// The golden journey's person on a tool that runs one typed line per process
// (codex exec, copilot -p, opencode run): what they type after each turn comes
// from the engine steps of that session, the plan question left for the day
// comes back first in a new session and counts once, and the path checks read
// only what the journey covers. Seeded audit rows and engine output stand in
// for a live run, so each case is exact.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { codexToolResults, copilotToolResults, copilotTurnCommand, opencodeRunArgs, opencodeToolResults } from "../harness/exec-drive.ts";
import { cleanupTestProject, createTestProject, seededAuditShard, seededStateFile } from "../harness/fixtures.ts";
import { type GoldenJourney, type GoldenRun, goldenPathProblems, GoldenPerson } from "../harness/golden-journey.ts";
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
    const argv = opencodeRunArgs("/aidlc fix the greeter: it says hello");
    expect(argv.slice(0, 3)).toEqual(["run", "--command", "aidlc"]);
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "fix", "the", "greeter:", "it", "says", "hello"]);
    expect(argv.slice(argv.indexOf("--format"), argv.indexOf("--format") + 2)).toEqual(["--format", "json"]);
  });

  test("any other line continues the session as typed", () => {
    const argv = opencodeRunArgs('Go ahead with the "bugfix" plan', "ses_1");
    expect(argv.slice(0, 3)).toEqual(["run", "-s", "ses_1"]);
    expect(argv).not.toContain("--command");
    expect(argv.slice(argv.indexOf("--") + 1).join(" ")).toBe('Go ahead with the "bugfix" plan');
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
