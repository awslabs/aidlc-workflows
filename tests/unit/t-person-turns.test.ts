// The person-turn check every live drive runs: a decision recorded as the
// person's needs a turn the driver sent after its gate or question opened.
// Seeded audit rows stand in for the engine's, so each case is exact.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupTestProject, createTestProject, seededAuditShard } from "../harness/fixtures.ts";
import {
  PersonTurnLedger,
  startPersonTurnSession,
  submittedToPersonTurnSession,
  typedIntoPersonTurnSession,
  unbackedFailure,
  unbackedTuiDecisions,
} from "../harness/person-turns.ts";

const projects: string[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  delete process.env.AIDLC_PERSON_TURNS_DIR;
});

/** A private ledger folder for this case, as the driver makes its own. */
function ledgerFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "t-person-turns-ledger-"));
  folders.push(folder);
  process.env.AIDLC_PERSON_TURNS_DIR = folder;
  return folder;
}

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
    expect(problems[0]).toContain('recorded words "picked by the agent"');
  });

  test("a project type the agent changed with no turn after the work started is flagged", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("add a rate limiter");
    row(dir, "WORKSPACE_INITIALISED", { "Project Type": "Greenfield" });
    row(dir, "WORKSPACE_RECLASSIFIED", { "New Project Type": "Greenfield (you)" });
    expect(drive.unbacked()[0]).toContain("WORKSPACE_RECLASSIFIED");
    expect(drive.unbacked()[0]).toContain('recorded words "Greenfield (you)"');
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

  test.skipIf(process.platform === "win32")("the TUI ledger refuses a folder another account could write", () => {
    const folder = ledgerFolder();
    chmodSync(folder, 0o777);
    expect(() => startPersonTurnSession("t-person-turns-hostile", project())).toThrow("is not a private folder");
  });

  test("a slash command at an open gate is no reply to it, but backs what it asks for", () => {
    const dir = project();
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "requirements-analysis" });
    const drive = new PersonTurnLedger(dir);
    drive.sent("/aidlc --scope mvp");
    row(dir, "GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" });
    row(dir, "WORKSPACE_RECLASSIFIED", { "New Project Type": "Brownfield (you)" });
    row(dir, "GATE_REJECTED", { Stage: "code-generation", Unit: "alpha", Feedback: "jump" });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("GATE_APPROVED requirements-analysis");
  });

  test("a second answer to one question needs a newer turn; one menu answers several questions", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    for (const question of ["scale", "auth", "region"]) {
      row(dir, "DECISION_RECORDED", { Stage: "requirements-analysis", Decision: question });
    }
    drive.sent('{"scale":"small","auth":"Cognito","region":"us-east-1"}');
    for (const answer of ["small", "Cognito", "us-east-1"]) {
      row(dir, "QUESTION_ANSWERED", { Stage: "requirements-analysis", Details: answer });
    }
    expect(drive.unbacked()).toEqual([]);
    row(dir, "DECISION_RECORDED", { Stage: "code-generation", Checkpoint: "plan-approval" });
    drive.sent("rename the handler first");
    row(dir, "QUESTION_ANSWERED", { Stage: "code-generation", Checkpoint: "plan-approval", Details: "Request Changes" });
    row(dir, "QUESTION_ANSWERED", { Stage: "code-generation", Checkpoint: "plan-approval", Details: "Approve Plan" });
    expect(drive.unbacked()).toHaveLength(1);
    expect(drive.unbacked()[0]).toContain('QUESTION_ANSWERED code-generation');
    drive.sent("now approve it");
    row(dir, "QUESTION_ANSWERED", { Stage: "code-generation", Checkpoint: "plan-approval", Details: "Approve Plan" });
    expect(drive.unbacked()).toHaveLength(1);
    // A question another checkpoint opened later on the same stage is not this one's.
    row(dir, "DECISION_RECORDED", { Stage: "build-and-test", Checkpoint: "plan-approval" });
    drive.sent("approve the plan");
    row(dir, "DECISION_RECORDED", { Stage: "build-and-test", Checkpoint: "summary-confirmation" });
    row(dir, "QUESTION_ANSWERED", { Stage: "build-and-test", Checkpoint: "plan-approval", Details: "Approve Plan" });
    expect(drive.unbacked()).toHaveLength(1);
  });

  test("a gate in a single-stage run is not opened by the main workflow's gate", () => {
    const dir = project();
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "user-stories" });
    const drive = new PersonTurnLedger(dir);
    drive.sent("/aidlc --single user-stories");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "user-stories", Workflow: "single-stage:user-stories" });
    row(dir, "GATE_APPROVED", { Stage: "user-stories", Workflow: "single-stage:user-stories" });
    expect(drive.unbacked()).toHaveLength(1);
  });

  test("the TUI ledger spans every session of the project and goes when it is read", () => {
    const folder = ledgerFolder();
    const dir = project();
    const session = `t-person-turns-${process.pid}`;
    startPersonTurnSession(session, dir);
    submittedToPersonTurnSession(session, "/aidlc --scope mvp");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "team-formation" });
    // A restarted session keeps the first session's start and turns.
    startPersonTurnSession(session, dir);
    submittedToPersonTurnSession(session, "");
    row(dir, "GATE_APPROVED", { Stage: "team-formation", "User Input": "Approve" });
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "requirements-analysis" });
    // A slash command typed, then submitted with Enter, is still a command.
    typedIntoPersonTurnSession(session, "/aidlc ");
    typedIntoPersonTurnSession(session, "--status");
    submittedToPersonTurnSession(session, "");
    row(dir, "GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" });
    submittedToPersonTurnSession("t-person-turns-no-such-session", "");
    const problems = unbackedTuiDecisions(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("GATE_APPROVED requirements-analysis");
    expect(problems[0]).toContain('"/aidlc --status"');
    expect(readdirSync(folder)).toEqual([]);
    expect(unbackedTuiDecisions(dir)).toEqual([]);
    expect(unbackedFailure("The TUI drive", problems).message)
      .toStartWith("The TUI drive recorded 1 decision(s) as the person's that no turn from them backs:\n  GATE_APPROVED");
  });
});
