// The golden journey's person on a tool that runs one typed line per process
// (codex exec, copilot -p, opencode run): what they type after each turn comes
// from the engine steps of that session, the plan question left for the day
// comes back first in a new session and counts once, and the path checks read
// only what the journey covers. Seeded audit rows and engine output stand in
// for a live run, so each case is exact.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { codexToolResults } from "../harness/exec-drive.ts";
import { cleanupTestProject, createTestProject, seededAuditShard, seededStateFile } from "../harness/fixtures.ts";
import { type GoldenJourney, type GoldenRun, goldenPathProblems, GoldenPerson } from "../harness/golden-journey.ts";
import type { CapturedToolResult } from "../harness/sdk-drive.ts";

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

/** A project; with `stage`, its work is under way there (the audit is read for the work in progress). */
function project(stage?: string): string {
  const dir = createTestProject();
  projects.push(dir);
  if (stage) writeFileSync(seededStateFile(dir), `# AI-DLC State\n\n- **Current Stage**: ${stage}\n`);
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
