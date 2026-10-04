// The person-turn check every live drive runs: a decision recorded as the
// person's needs a turn the driver sent after its gate or question opened.
// Seeded audit rows stand in for the engine's, so each case is exact.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cleanupTestProject, createTestProject, seededAuditShard } from "../harness/fixtures.ts";
import { PersonTurnLedger } from "../harness/person-turns.ts";

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

let clock = 0;
function row(project: string, event: string, fields: Record<string, string> = {}): void {
  const shard = seededAuditShard(project);
  mkdirSync(dirname(shard), { recursive: true });
  const at = new Date(Date.UTC(2026, 9, 4, 12, 0, clock++)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = Object.entries(fields).map(([name, value]) => `**${name}**: ${value}`);
  appendFileSync(shard, [`## ${event}`, `**Timestamp**: ${at}`, `**Event**: ${event}`, ...lines, "", "---", "", ""].join("\n"));
}

function project(): string {
  const dir = createTestProject();
  projects.push(dir);
  row(dir, "WORKFLOW_STARTED");
  return dir;
}

describe("person-turn check", () => {
  test("an approval the agent recorded with no turn after the gate opened is flagged", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("/aidlc --scope mvp");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "team-formation" });
    row(dir, "GATE_APPROVED", { Stage: "team-formation", "User Input": "approve" });
    const [problem, ...rest] = drive.unbacked();
    expect(rest).toEqual([]);
    expect(problem).toContain("GATE_APPROVED team-formation");
    expect(problem).toContain('recorded words "approve"');
  });

  test("an approval after the person answered the open gate passes", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("/aidlc --scope mvp");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "team-formation" });
    drive.sent('{"Approve the team?":"Approve"}');
    row(dir, "HUMAN_TURN");
    row(dir, "GATE_APPROVED", { Stage: "team-formation", "User Input": "Approve" });
    expect(drive.unbacked()).toEqual([]);
  });

  test("a gate opened before the drive is backed by the drive's opening prompt", () => {
    const dir = project();
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "requirements-analysis" });
    const drive = new PersonTurnLedger(dir);
    drive.sent("Approve");
    row(dir, "GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" });
    expect(drive.unbacked()).toEqual([]);
  });

  test("an answer needs a turn after its question opened; another stage's turn does not count", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    row(dir, "DECISION_RECORDED", { Stage: "requirements-analysis" });
    drive.sent("an answer to the requirements question");
    row(dir, "QUESTION_ANSWERED", { Stage: "requirements-analysis" });
    row(dir, "DECISION_RECORDED", { Stage: "user-stories" });
    row(dir, "QUESTION_ANSWERED", { Stage: "user-stories", Details: "picked by the agent" });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("QUESTION_ANSWERED user-stories");
  });

  test("a project type the agent changed with no turn after the work started is flagged", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("add a rate limiter");
    row(dir, "WORKSPACE_INITIALISED", { "Project Type": "Greenfield" });
    row(dir, "WORKSPACE_RECLASSIFIED", { "New Project Type": "Greenfield (you)" });
    expect(drive.unbacked()[0]).toContain("WORKSPACE_RECLASSIFIED");
    drive.sent("it is a new project");
    row(dir, "WORKSPACE_RECLASSIFIED", { "New Project Type": "Brownfield (you)" });
    expect(drive.unbacked()).toHaveLength(1);
  });

  test("decisions written before the drive started are not this drive's", () => {
    const dir = project();
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "intent-capture" });
    row(dir, "GATE_APPROVED", { Stage: "intent-capture" });
    const drive = new PersonTurnLedger(dir);
    drive.sent("carry on");
    expect(drive.unbacked()).toEqual([]);
  });
});
