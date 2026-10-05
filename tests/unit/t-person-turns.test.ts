// The person-turn check every live drive runs: a decision recorded as the
// person's needs a turn the driver sent after its gate or question opened.
// Seeded audit rows stand in for the engine's, so each case is exact.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupTestProject, createTestProject, seedBoltDag, seededAuditShard } from "../harness/fixtures.ts";
import {
  nextPersonTurnCarriesPicks,
  PersonTurnLedger,
  startPersonTurnSession,
  submittedToPersonTurnSession,
  typedIntoPersonTurnSession,
  unbackedFailure,
  unbackedTuiDecisions,
} from "../harness/person-turns.ts";
import { reviewedPicks } from "../harness/tui-drive.ts";

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

  // The check reads a turn as the human-turn hook does: words alone after the
  // AIDLC entry are a reply that backs the approval; a flag keeps it a command.
  test("\"/aidlc approve\" backs an approval; \"/aidlc --status\" does not", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "team-formation" });
    drive.sent("/aidlc --status");
    row(dir, "HUMAN_TURN", { Reply: "command" });
    row(dir, "GATE_APPROVED", { Stage: "team-formation", "User Input": "Approve" });
    expect(drive.unbacked()).toHaveLength(1);
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "user-stories" });
    drive.sent("/aidlc approve");
    row(dir, "HUMAN_TURN");
    row(dir, "GATE_APPROVED", { Stage: "user-stories", "User Input": "Approve" });
    expect(drive.unbacked()).toHaveLength(1);
  });

  test("a gate opened before the drive is backed by the drive's opening prompt", () => {
    const dir = project();
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "requirements-analysis" });
    const drive = new PersonTurnLedger(dir);
    drive.sent("Approve");
    row(dir, "GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" });
    expect(drive.unbacked()).toEqual([]);
  });

  // "Choose the recommended answers", said in the opening command before the
  // questions came: the agent's answers carry the words, and that turn backs them.
  test("a choice the person left to the agent is backed by the turn that said so", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("/aidlc build the lunch poll, and choose the  Recommended answers for the questions");
    row(dir, "DECISION_RECORDED", { Stage: "intent-capture" });
    row(dir, "QUESTION_ANSWERED", {
      Stage: "intent-capture", Details: "Q1: A; Q2: B",
      "Answer Source": "chosen by the agent as the person asked", Instruction: "choose the recommended answers",
    });
    expect(drive.unbacked()).toEqual([]);
  });

  test("a choice marked as left to the agent in words the person never sent is flagged", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("/aidlc build the lunch poll");
    row(dir, "DECISION_RECORDED", { Stage: "intent-capture" });
    row(dir, "QUESTION_ANSWERED", {
      Stage: "intent-capture", Details: "Q1: A",
      "Answer Source": "chosen by the agent as the person asked", Instruction: "up to you",
    });
    row(dir, "DECISION_RECORDED", { Stage: "requirements-analysis" });
    row(dir, "QUESTION_ANSWERED", {
      Stage: "requirements-analysis", Details: "Q1: B",
      "Answer Source": "chosen by the agent as the person asked", Instruction: "",
    });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("QUESTION_ANSWERED intent-capture");
    expect(problems[1]).toContain("QUESTION_ANSWERED requirements-analysis");
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

  test("one entry answers a question the person answered once; a second answer needs a newer turn", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    row(dir, "DECISION_RECORDED", { Stage: "requirements-analysis", Decision: "Q1-Q3: scale, auth, region" });
    drive.sent('{"scale":"small","auth":"Cognito","region":"us-east-1"}');
    row(dir, "QUESTION_ANSWERED", { Stage: "requirements-analysis", Details: "Q1: small; Q2: Cognito; Q3: us-east-1" });
    expect(drive.unbacked()).toEqual([]);
    row(dir, "DECISION_RECORDED", { Stage: "code-generation", Checkpoint: "plan-approval" });
    drive.sent("rename the handler first");
    row(dir, "QUESTION_ANSWERED", { Stage: "code-generation", Checkpoint: "plan-approval", Details: "Request Changes" });
    row(dir, "QUESTION_ANSWERED", { Stage: "code-generation", Checkpoint: "plan-approval", Details: "Approve Plan" });
    expect(drive.unbacked()).toHaveLength(1);
    expect(drive.unbacked()[0]).toContain("QUESTION_ANSWERED code-generation");
    drive.sent("now approve it");
    row(dir, "QUESTION_ANSWERED", { Stage: "code-generation", Checkpoint: "plan-approval", Details: "Approve Plan" });
    expect(drive.unbacked()).toHaveLength(1);
  });

  test("one menu submission backs as many answers as it carried picks, and no more", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    // One menu asks two questions; the person picks on both and submits once.
    row(dir, "DECISION_RECORDED", { Stage: "intent-capture", Decision: "Anything to add for next time?" });
    drive.sent('{"Keep this note?":"Keep (project)","Anything to add for next time?":"Nothing to add"}', 2);
    row(dir, "QUESTION_ANSWERED", { Stage: "intent-capture", Details: "Keep (project)" });
    row(dir, "QUESTION_ANSWERED", { Stage: "intent-capture", Details: "Nothing to add" });
    expect(drive.unbacked()).toEqual([]);
    // A third answer has no pick behind it.
    row(dir, "QUESTION_ANSWERED", { Stage: "intent-capture", Details: "Add a note" });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('recorded words "Add a note"');
  });

  test("a typed reply backs one answer per question open when it arrived", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    row(dir, "DECISION_RECORDED", { Stage: "requirements-analysis", Decision: "Q1-Q2: scale, auth" });
    drive.sent("small, and Cognito");
    row(dir, "QUESTION_ANSWERED", { Stage: "requirements-analysis", Details: "Q1: small" });
    row(dir, "QUESTION_ANSWERED", { Stage: "requirements-analysis", Details: "Q2: Cognito" });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('recorded words "Q2: Cognito"');
  });

  test("one typed reply answers every question open when it arrived; a question asked after it waits", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    for (const question of ["Way of working?", "Walking skeleton?", "How much testing?"]) {
      row(dir, "DECISION_RECORDED", { Stage: "practices-discovery", Decision: question });
    }
    drive.sent("A, B, and A with CI");
    for (const reply of ["A", "B", "A, with CI"]) {
      row(dir, "QUESTION_ANSWERED", { Stage: "practices-discovery", Details: reply });
    }
    expect(drive.unbacked()).toEqual([]);
    row(dir, "DECISION_RECORDED", { Stage: "practices-discovery", Decision: "Deploy anywhere?" });
    row(dir, "QUESTION_ANSWERED", { Stage: "practices-discovery", Details: "Deploy to staging" });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('recorded words "Deploy to staging"');
  });

  test("a later question supersedes an earlier one, as the engine pairs them", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    row(dir, "DECISION_RECORDED", { Stage: "build-and-test", Checkpoint: "plan-approval" });
    drive.sent("approve the plan");
    // A second question opened after the reply is the one an answer now closes.
    row(dir, "DECISION_RECORDED", { Stage: "build-and-test", Checkpoint: "summary-confirmation" });
    row(dir, "SUMMARY_CONFIRMATION_RECORDED", { Stage: "build-and-test", Details: "Looks correct" });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("SUMMARY_CONFIRMATION_RECORDED build-and-test");
  });

  test("a Unit checkpoint's gate row answers its own question, and needs a reply after it", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("carry on with the build");
    const question = { Stage: "code-generation", Checkpoint: "Construction Unit Approval", Unit: "alpha", Kind: "unit" };
    row(dir, "DECISION_RECORDED", question);
    row(dir, "GATE_APPROVED", { Stage: "code-generation", Checkpoint: "construction-unit", Unit: "alpha" });
    expect(drive.unbacked()).toHaveLength(1);
    row(dir, "DECISION_RECORDED", { ...question, Unit: "beta" });
    drive.sent('{"Approve Unit beta?":"Approve"}');
    row(dir, "GATE_APPROVED", { Stage: "code-generation", Checkpoint: "construction-unit", Unit: "beta" });
    expect(drive.unbacked()).toHaveLength(1);
  });

  test("the rows an approval backfills keep the gate's first opening", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "user-stories" });
    drive.sent('{"Approve the user stories?":"Approve"}');
    // The approval backfills a revision the agent never reported, then approves.
    row(dir, "GATE_REJECTED", { Stage: "user-stories", Recovered: "true" });
    row(dir, "STAGE_REVISING", { Stage: "user-stories", Recovered: "true" });
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "user-stories", Recovered: "true" });
    row(dir, "GATE_APPROVED", { Stage: "user-stories", "User Input": "Approve" });
    expect(drive.unbacked()).toEqual([]);
  });

  test("a field on a row never makes it the engine's", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "code-generation" });
    row(dir, "GATE_APPROVED", { Stage: "code-generation", Autonomous: "true" });
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "build-and-test" });
    row(dir, "GATE_APPROVED", { Stage: "build-and-test", Recovered: "true" });
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "user-stories" });
    row(dir, "GATE_REJECTED", { Stage: "user-stories", Recovered: "true" });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("GATE_APPROVED code-generation");
    expect(problems[1]).toContain("GATE_APPROVED build-and-test");
    expect(problems[2]).toContain("GATE_REJECTED user-stories");
  });

  test("under the person's autonomous grant the engine approves Construction; the walking skeleton still asks", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "units-generation" });
    drive.sent('{"Approve the units?":"Approve"}');
    row(dir, "GATE_APPROVED", { Stage: "units-generation", "User Input": "Approve" });
    drive.sent('{"How should Construction run?":"Autonomous"}');
    row(dir, "AUTONOMY_MODE_SET", { Mode: "autonomous" });
    // An ordinary stage gate and a Unit checkpoint, approved with no question.
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "functional-design" });
    row(dir, "GATE_APPROVED", { Stage: "functional-design" });
    row(dir, "DECISION_RECORDED", { Stage: "code-generation", Checkpoint: "Construction Unit Approval", Unit: "alpha", Kind: "unit" });
    row(dir, "GATE_APPROVED", { Stage: "code-generation", Checkpoint: "construction-unit", Unit: "alpha", Autonomous: "true" });
    expect(drive.unbacked()).toEqual([]);
    row(dir, "DECISION_RECORDED", { Stage: "code-generation", Checkpoint: "Construction Unit Approval", Unit: "beta", Kind: "skeleton" });
    row(dir, "GATE_APPROVED", { Stage: "code-generation", Checkpoint: "walking-skeleton", Unit: "beta", Autonomous: "true" });
    const problems = drive.unbacked();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("GATE_APPROVED code-generation (Unit beta)");
  });

  test("the autonomous grant needs a turn after the last gate, and a new workflow ends it", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "units-generation" });
    drive.sent('{"Approve the units?":"Approve"}');
    row(dir, "GATE_APPROVED", { Stage: "units-generation", "User Input": "Approve" });
    row(dir, "AUTONOMY_MODE_SET", { Mode: "autonomous" });
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "functional-design" });
    row(dir, "GATE_APPROVED", { Stage: "functional-design" });
    expect(drive.unbacked()).toHaveLength(1);
    expect(drive.unbacked()[0]).toContain('AUTONOMY_MODE_SET at');
    row(dir, "WORKFLOW_STARTED");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "code-generation" });
    row(dir, "GATE_APPROVED", { Stage: "code-generation" });
    expect(drive.unbacked()).toHaveLength(2);
    expect(drive.unbacked()[1]).toContain("GATE_APPROVED code-generation");
  });

  test("once the person approves a Unit checkpoint, the engine settles the stage gates it covers; a rejected checkpoint takes that back", () => {
    const dir = project();
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    const stages = "functional-design, code-generation";
    row(dir, "DECISION_RECORDED", { Stage: "code-generation", Checkpoint: "Construction Unit Approval", Unit: "core", Kind: "unit" });
    drive.sent('{"Approve this completed core?":"Approve"}');
    row(dir, "GATE_APPROVED", { Stage: "code-generation", Checkpoint: "construction-unit", Unit: "core", "Gate Stages": stages });
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "functional-design" });
    row(dir, "GATE_APPROVED", { Stage: "functional-design" });
    expect(drive.unbacked()).toEqual([]);
    // A stage no approved checkpoint covers still needs the person.
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "build-and-test" });
    row(dir, "GATE_APPROVED", { Stage: "build-and-test", "User Input": "Approve" });
    expect(drive.unbacked()).toHaveLength(1);
    expect(drive.unbacked()[0]).toContain("GATE_APPROVED build-and-test");
    // After the person rejects the checkpoint, its stages are theirs to approve again.
    row(dir, "DECISION_RECORDED", { Stage: "code-generation", Checkpoint: "Construction Unit Approval", Unit: "core", Kind: "unit" });
    drive.sent('{"Approve this completed core?":"Request Changes"}');
    row(dir, "GATE_REJECTED", { Stage: "code-generation", Checkpoint: "construction-unit", Unit: "core", "Gate Stages": stages });
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "functional-design" });
    row(dir, "GATE_APPROVED", { Stage: "functional-design" });
    expect(drive.unbacked()).toHaveLength(2);
    expect(drive.unbacked()[1]).toContain("GATE_APPROVED functional-design");
  });

  test("with two Units the engine settles a stage only after both checkpoints are approved; a rejection and a reopening count", () => {
    const dir = project();
    seedBoltDag(dir, ["core", { name: "extra", depends_on: ["core"] }]);
    const drive = new PersonTurnLedger(dir);
    drive.sent("start");
    const checkpoint = (unit: string, event: "GATE_APPROVED" | "GATE_REJECTED", reply: string) => {
      row(dir, "DECISION_RECORDED", { Stage: "code-generation", Checkpoint: "Construction Unit Approval", Unit: unit, Kind: "unit" });
      drive.sent(`{"Approve this completed ${unit}?":"${reply}"}`);
      row(dir, event, { Stage: "code-generation", Checkpoint: "construction-unit", Unit: unit, "Gate Stages": "code-generation" });
    };
    const stageGate = () => {
      row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "code-generation" });
      row(dir, "GATE_APPROVED", { Stage: "code-generation" });
    };
    checkpoint("core", "GATE_APPROVED", "Approve");
    // The second Unit is not approved yet: a stage approval now is nobody's.
    stageGate();
    expect(drive.unbacked()).toHaveLength(1);
    checkpoint("extra", "GATE_APPROVED", "Approve");
    stageGate();
    expect(drive.unbacked()).toHaveLength(1);
    // The person rejects the second Unit, then approves it again.
    checkpoint("extra", "GATE_REJECTED", "Request Changes");
    stageGate();
    expect(drive.unbacked()).toHaveLength(2);
    checkpoint("extra", "GATE_APPROVED", "Approve");
    stageGate();
    expect(drive.unbacked()).toHaveLength(2);
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

  test("a TUI form's Submit backs one answer per pick on it; a pick on one of its tabs backs none", () => {
    const folder = ledgerFolder();
    const dir = project();
    const session = `t-person-turns-form-${process.pid}`;
    startPersonTurnSession(session, dir);
    submittedToPersonTurnSession(session, "/aidlc --stage intent-capture");
    row(dir, "DECISION_RECORDED", { Stage: "intent-capture", Decision: "Anything to add for next time?" });
    // A pick on each of the form's two tabs, then Submit.
    nextPersonTurnCarriesPicks(session, 0);
    submittedToPersonTurnSession(session, "");
    nextPersonTurnCarriesPicks(session, 0);
    submittedToPersonTurnSession(session, "");
    nextPersonTurnCarriesPicks(session, 2, "Keep (project); Nothing to add");
    submittedToPersonTurnSession(session, "");
    row(dir, "QUESTION_ANSWERED", { Stage: "intent-capture", Details: "Keep (project)" });
    row(dir, "QUESTION_ANSWERED", { Stage: "intent-capture", Details: "Nothing to add" });
    row(dir, "QUESTION_ANSWERED", { Stage: "intent-capture", Details: "Add a note" });
    const problems = unbackedTuiDecisions(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('recorded words "Add a note"');
    expect(problems[0]).toContain('"Keep (project); Nothing to add"');
    expect(readdirSync(folder)).toEqual([]);
  });

  test("a form's picks are read off its review screen, or its ticked tabs when the review is out of view", () => {
    const review = [
      "────────────────────────────────────────",
      "←  ☒ Learning  ☒ Add note  ✔ Submit  →",
      "",
      "Review your answers",
      "",
      " │ ● I jotted one note from this stage. Keep it as a practice for next time?",
      " │   (a solo-owner personal task tracker)",
      "   → Keep (project)",
      " ● Anything to add for next time?",
      "   → Nothing to add",
      "",
      "Ready to submit your answers?",
      "",
      "❯ 1. Submit answers",
      "  2. Cancel",
    ].join("\n");
    expect(reviewedPicks(review)).toEqual(["Keep (project)", "Nothing to add"]);
    // Only the last review counts, up to its own Submit, and never more picks
    // than the form has tabs.
    const earlier = ["Review your answers", "   → A", "   → B", "   → C", "", "Ready to submit your answers?"].join("\n");
    expect(reviewedPicks(`${earlier}\n${review}\n   → Not a pick`)).toEqual(["Keep (project)", "Nothing to add"]);
    const crowded = review.replace("   → Nothing to add", "   → Nothing to add\n   → An answer the agent wrote");
    expect(reviewedPicks(crowded)).toEqual(["Keep (project)", "Nothing to add"]);
    expect(reviewedPicks("←  ☒ Stakeholders  ☒ Comms  ☐ Scope  ✔ Submit  →\n\n❯ 1. Submit answers")).toEqual(["", ""]);
  });

  test.each([
    { case: "is removed", tamper: (file: string) => rmSync(file), says: "is gone: the driver sent 2 turn(s) to 1 session(s)" },
    {
      case: "loses a turn",
      tamper: (file: string) => writeFileSync(file, readFileSync(file, "utf-8").split("\n").slice(0, 2).join("\n")),
      says: "holds 1 of the 2 turn(s) the driver sent",
    },
    {
      case: "loses its start",
      tamper: (file: string) => writeFileSync(file, readFileSync(file, "utf-8").split("\n").slice(1).join("\n")),
      says: "holds 2 of the 2 turn(s) the driver sent and no session start",
    },
    { case: "is garbled", tamper: (file: string) => appendFileSync(file, "{not json\n"), says: "cannot be read" },
  ])("a TUI ledger that $case during the drive fails it", ({ tamper, says }) => {
    const folder = ledgerFolder();
    const dir = project();
    const session = `t-person-turns-tamper-${process.pid}`;
    startPersonTurnSession(session, dir);
    submittedToPersonTurnSession(session, "/aidlc --scope mvp");
    row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "team-formation" });
    submittedToPersonTurnSession(session, "Approve");
    row(dir, "GATE_APPROVED", { Stage: "team-formation", "User Input": "Approve" });
    const [ledger] = readdirSync(folder).filter((name) => name.startsWith("ledger-"));
    tamper(join(folder, ledger));
    expect(() => unbackedTuiDecisions(dir)).toThrow(says);
    expect(readdirSync(folder)).toEqual([]);
  });
});
