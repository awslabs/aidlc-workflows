// covers: subcommand:aidlc-orchestrate:park, subcommand:aidlc-orchestrate:report, function:parkWorkflow
//
// A lead's own checkout of team-owned Units while a team holds a Unit claim
// (a landed Unit's claim stays live): the checkout builds no Unit, and main's
// own stages (Units Generation, gone back to before the Units, and Build and
// Test once the Units landed) are worked there.
// The person's stop goes through there as it does on solo work: a pause asked
// at main's own stage parks the work, the next look answers that it is
// parked, and a resume carries on at the same stage; "approve, and stop there"
// at main's own gate records the approval and stops, in the solo park's own
// words. A pause at the board keeps nothing from the person: a Unit a team
// makes ready during it is offered once they are back. A teammate's clone that
// has not claimed yet pauses the same way, and claims a Unit after. Where a
// Unit is in hand nothing changes: a checkout that holds a claim parks only its
// own Unit, there, for a pause and for an approval that asks to stop, and a
// lead who builds a Unit of their own parks the work; solo work parks as
// before.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  loadStageGraphAll,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  ORCH,
  STATE,
  UNIT,
  appendMainHumanTurn,
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";
import { currentStage, dagBody, makeReplanSeed, reopenUnitsGeneration } from "../harness/team-unit-replan.ts";

process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
const soloProjects: string[] = [];
afterEach(() => {
  cleanupTempDirs();
  while (soloProjects.length) cleanupTestProject(soloProjects.pop());
});

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const FD = "functional-design";
const BT = "build-and-test";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const STOP_WORDS = "Approve, and stop there for today";
// The solo park's words, which the lead's checkout says too.
const PAUSED_AT_BT = "Paused at Build and Test with everything saved. Pick it back up any time here, or with /aidlc --resume in a new chat.";
const APPROVED_AND_PAUSED = "Approved, and paused at CI Pipeline with everything saved. Pick it back up any time here, or with /aidlc --resume in a new chat.";

type Directive = Record<string, unknown> & { kind: string };

function directiveOf(r: { status: number; stdout: string; out: string }): Directive {
  expect(r.status, r.out).toBe(0);
  return JSON.parse(r.stdout) as Directive;
}

const stateField = (checkout: string, name: string): string =>
  new RegExp(`\\*\\*${name}\\*\\*: (.*)`).exec(readFileSync(seededStateFile(checkout), "utf-8"))?.[1]?.trim() ?? "";

const rows = (checkout: string, event: string, stage?: string) =>
  readAuditShardEvents(checkout).filter((row) =>
    row.event === event && (stage === undefined || auditBlockField(row.block, "Stage") === stage)
  );

const parkAsked = (checkout: string): Directive => directiveOf(runMergeTool(ORCH, ["park", "--person-asked"], checkout));

// A team clones the work and claims alpha; the lead's checkout fetches the claim.
function teamClaimsAlpha(lead: string, remote: string): void {
  const team = clone(remote, "alpha-team");
  const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team"], team);
  expect(claimed.status, claimed.out).toBe(0);
  git(lead, ["fetch", "origin"]);
}

// A plan of one team Unit: the team built alpha and the lead landed it, so main
// went on to Build and Test, with its documents written; alpha's claim is
// still live in the lead's checkout.
function leadAtBuildAndTest(): string {
  const { seed: lead, remote } = makeSeed(dagBody([
    { name: "skeleton", depends_on: [] },
    { name: "alpha", depends_on: ["skeleton"] },
  ]));
  prepareCandidate(remote, "alpha", "alpha-team");
  gateAndLand(lead, "alpha");
  git(lead, ["push", "origin", "main"]);
  expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: BT });
  const dir = join(seededRecordDir(lead), "construction", BT);
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug(BT)!.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
  return lead;
}

describe("a lead's own checkout while a team holds a Unit claim", () => {
  test("a pause asked at Build and Test, once the Units landed, parks the work; the next look says so and a resume carries on there", () => {
    const lead = leadAtBuildAndTest();
    appendMainHumanTurn(lead);
    const parked = parkAsked(lead);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(parked.narration).toBe(PAUSED_AT_BT);
    expect(stateField(lead, "Parked At Stage")).toBe(BT);
    expect(stateField(lead, "Parked By")).toBe("person");
    expect(rows(lead, "WORKFLOW_PARKED", BT)).toHaveLength(1);
    expect(nextDirective(lead).kind).toBe("parked");
    const resume = directiveOf(runMergeTool(ORCH, ["next", "--resume"], lead));
    expect(resume.kind, JSON.stringify(resume)).toBe("print");
    expect(String(resume.message)).toContain("unpark");
    expect(directiveOf(runMergeTool(STATE, ["unpark"], lead)).unparked).toBe(true);
    expect(stateField(lead, "Parked")).toBe("");
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: BT });
  });

  test("a pause asked at Units Generation, gone back to before the Units, parks the work there", () => {
    const { seed: lead, remote } = makeReplanSeed();
    teamClaimsAlpha(lead, remote);
    const reopened = reopenUnitsGeneration(lead);
    expect(reopened.status, reopened.out).toBe(0);
    expect(currentStage(lead)).toBe("units-generation");
    const parked = parkAsked(lead);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(stateField(lead, "Parked At Stage")).toBe("units-generation");
    expect(nextDirective(lead).kind).toBe("parked");
  });

  test("\"approve, and stop there\" at Build and Test records the approval and stops", () => {
    const lead = leadAtBuildAndTest();
    directiveOf(runMergeTool(ORCH, ["report", "--stage", BT, "--result", "awaiting-approval"], lead));
    const stopped = directiveOf(runMergeTool(
      ORCH,
      ["report", "--stage", BT, "--result", "approved", "--user-input", STOP_WORDS, "--park"],
      lead,
    ));
    expect(stopped.kind, JSON.stringify(stopped)).toBe("parked");
    expect(String(stopped.reason)).toContain(`Approved "${BT}"`);
    expect(stopped.narration).toBe(APPROVED_AND_PAUSED);
    expect(rows(lead, "GATE_APPROVED", BT)).toHaveLength(1);
    const at = currentStage(lead);
    expect(at).not.toBe(BT);
    expect(stateField(lead, "Parked At Stage")).toBe(at);
    expect(nextDirective(lead).kind).toBe("parked");
  });

  test("a pause at the board parks the work, and the Unit a team made ready during it is offered when the person is back", () => {
    const { seed: lead, remote } = makeSeed();
    const { checkout: team } = prepareCandidate(remote, "alpha", "alpha-team", { publish: false });
    git(lead, ["fetch", "origin"]);
    expect(nextDirective(lead).kind).toBe("notice");
    const parked = parkAsked(lead);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(stateField(lead, "Parked At Stage")).toBe(FD);
    const published = runMergeTool(UNIT, ["publish", "alpha"], team);
    expect(published.status, published.out).toBe(0);
    git(lead, ["fetch", "origin"]);
    expect(nextDirective(lead).kind).toBe("parked");
    appendMainHumanTurn(lead);
    const back = nextDirective(lead);
    expect(back.kind, JSON.stringify(back)).toBe("print");
    expect(String(back.message)).toContain("unpark");
    expect(directiveOf(runMergeTool(STATE, ["unpark"], lead)).unparked).toBe(true);
    const offered = nextDirective(lead);
    expect(offered.kind, JSON.stringify(offered)).toBe("ask");
    expect(offered.question).toBe("alpha is ready from alpha-team: review and merge it?");
  });
});

describe("a teammate's clone that has not claimed a Unit yet", () => {
  test("a pause parks the work there, and a claim after it starts that Unit's step", () => {
    const { remote } = makeReplanSeed();
    const first = clone(remote, "alpha-team");
    expect(runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team"], first).status).toBe(0);
    const teammate = clone(remote, "beta-team");
    nextDirective(teammate);
    const parked = parkAsked(teammate);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(stateField(teammate, "Parked At Stage")).toBe(FD);
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], teammate);
    expect(claimed.status, claimed.out).toBe(0);
    expect(nextDirective(teammate)).toMatchObject({ kind: "run-stage", stage: FD, unit: "beta" });
  });
});

// The team's own clone, which holds alpha's claim, approved stage by stage.
function claimedCheckout(): string {
  const { remote } = makeReplanSeed();
  const team = clone(remote, "alpha-team");
  const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team", "--rhythm", "per-stage"], team);
  expect(claimed.status, claimed.out).toBe(0);
  return team;
}

// alpha's Functional Design written, reviewed READY and put to the person.
function alphaAtItsGate(team: string): void {
  expect(nextDirective(team)).toMatchObject({ stage: FD, unit: "alpha" });
  expect(runMergeTool(STATE, ["unit", "start", "--stage", FD, "--unit", "alpha"], team).status).toBe(0);
  const stage = loadStageGraphAll().find((entry) => entry.slug === FD)!;
  const dir = join(seededRecordDir(team), "construction", "alpha", FD);
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n\nalpha\n`);
  for (const args of [
    ["decision", "--stage", FD, "--decision", "A choice", "--unit", "alpha"],
    ["answer", "--stage", FD, "--details", "An answer", "--unit", "alpha"],
  ]) expect(runMergeTool(LOG, args, team).status).toBe(0);
  const review = ["review", "--stage", FD, "--reviewer", REVIEWER, "--iteration", "1", "--unit", "alpha"];
  expect(runMergeTool(LOG, review, team).status).toBe(0);
  appendFileSync(join(dir, artifactFilename(stage.review_artifact!)),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
  expect(runMergeTool(LOG, [...review, "--verdict", "READY"], team).status).toBe(0);
  const done = runMergeTool(STATE, ["unit", "complete", "--stage", FD, "--unit", "alpha"], team);
  expect(done.status, done.out).toBe(0);
  nextDirective(team);
  directiveOf(runMergeTool(ORCH, ["report", "--stage", FD, "--unit", "alpha", "--result", "awaiting-approval"], team));
}

describe("where a Unit is in hand, a stop parks as before", () => {
  test("a lead who builds a Unit of their own while a team holds another: a pause parks the work", () => {
    const { seed: lead, remote } = makeReplanSeed();
    expect(nextDirective(lead)).toMatchObject({ kind: "ask", ask_type: "team-handover" });
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: FD, unit: "alpha" });
    expect(runMergeTool(STATE, ["unit", "start", "--stage", FD, "--unit", "alpha"], lead).status).toBe(0);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "the lead starts alpha"]);
    git(lead, ["push", "origin", "main"]);
    const team = clone(remote, "beta-team");
    expect(runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], team).status).toBe(0);
    git(lead, ["fetch", "origin"]);
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: FD, unit: "alpha" });
    const parked = parkAsked(lead);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(stateField(lead, "Parked At Stage")).toBe(FD);
    expect(existsSync(join(lead, "aidlc", ".aidlc-unit-parked"))).toBe(false);
  });

  test("a pause parks alpha in this checkout and leaves the work's state as it was", () => {
    const team = claimedCheckout();
    const before = readFileSync(seededStateFile(team), "utf-8");
    const parked = parkAsked(team);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(String(parked.reason)).toContain('Unit "alpha" is parked in this checkout');
    expect(existsSync(join(team, "aidlc", ".aidlc-unit-parked"))).toBe(true);
    expect(readFileSync(seededStateFile(team), "utf-8")).toBe(before);
  });

  test("\"approve, and stop there\" at alpha's gate records the approval and parks alpha in this checkout", () => {
    const team = claimedCheckout();
    alphaAtItsGate(team);
    const stopped = directiveOf(runMergeTool(
      ORCH,
      ["report", "--stage", FD, "--unit", "alpha", "--result", "approved", "--user-input", STOP_WORDS, "--park"],
      team,
    ));
    expect(stopped.kind, JSON.stringify(stopped)).toBe("parked");
    expect(String(stopped.reason)).toContain(`Approved "${FD}" for unit "alpha". Unit "alpha" is parked in this checkout`);
    expect(existsSync(join(team, "aidlc", ".aidlc-unit-parked"))).toBe(true);
    expect(stateField(team, "Parked")).toBe("");
  });
});

// Solo work on Build and Test, Construction one Unit at a time.
function soloAtBuildAndTest(): string {
  const p = createTestProject();
  soloProjects.push(p);
  seedAidlcMemory(p);
  const before = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: solo stop
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Unit Ownership**: solo
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Autonomy Mode**: gated
- **Review Override**: none
## Stage Progress
### CONSTRUCTION PHASE
${before.map((stage) => `- [x] ${stage} \u2014 EXECUTE`).join("\n")}
- [-] ${BT} \u2014 EXECUTE
- [ ] ci-pipeline \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${BT}
- **Status**: Running
`);
  seedBoltDag(p, ["alpha"]);
  const dir = join(seededRecordDir(p), "construction", BT);
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug(BT)!.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
  return p;
}

describe("solo work stops as before", () => {
  test("a pause parks the work at its stage", () => {
    const p = soloAtBuildAndTest();
    const parked = parkAsked(p);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(parked.narration).toBe(PAUSED_AT_BT);
    expect(stateField(p, "Parked At Stage")).toBe(BT);
  });

  test("\"approve, and stop there\" records the approval and stops", () => {
    const p = soloAtBuildAndTest();
    directiveOf(runMergeTool(ORCH, ["report", "--stage", BT, "--result", "awaiting-approval"], p));
    const stopped = directiveOf(runMergeTool(
      ORCH,
      ["report", "--stage", BT, "--result", "approved", "--user-input", STOP_WORDS, "--park"],
      p,
    ));
    expect(stopped.kind, JSON.stringify(stopped)).toBe("parked");
    expect(stopped.narration).toBe(APPROVED_AND_PAUSED);
    expect(rows(p, "GATE_APPROVED", BT)).toHaveLength(1);
    expect(stateField(p, "Parked At Stage")).toBe(currentStage(p));
  });
});
