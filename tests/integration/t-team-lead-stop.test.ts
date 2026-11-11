// covers: subcommand:aidlc-orchestrate:park, subcommand:aidlc-orchestrate:report, function:parkWorkflow
//
// A lead's own checkout of team-owned Units while a team holds a Unit claim:
// the checkout builds no Unit, and main's own stages (Units Generation, gone
// back to before the Units, and Build and Test after them) are worked there.
// The person's stop goes through there as it does on solo work: a pause asked
// at main's own stage parks the work, the next look answers that it is
// parked, and a resume carries on at the same stage; "approve, and stop there"
// at main's own gate records the approval and stops. A pause at the board
// keeps nothing from the person: a Unit a team makes ready during it is
// offered once they are back. A checkout that holds a claim parks only its
// own Unit, there, for a pause and for an approval that asks to stop, as
// before; solo work parks as before.

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
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";
import { currentStage, makeReplanSeed, reopenUnitsGeneration } from "../harness/team-unit-replan.ts";

process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
const soloProjects: string[] = [];
afterEach(() => {
  cleanupTempDirs();
  while (soloProjects.length) cleanupTestProject(soloProjects.pop());
});

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const FD = "functional-design";
const BT = "build-and-test";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const STOP_WORDS = "Approve, and stop there for today";

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

// The lead moved main on to Build and Test while the team still builds alpha,
// with Build and Test's documents written.
function leadAtBuildAndTest(): string {
  const { seed: lead, remote } = makeSeed();
  teamClaimsAlpha(lead, remote);
  const jumped = runMergeTool(JUMP, ["execute", "--target", BT, "--direction", "forward"], lead);
  expect(jumped.status, jumped.out).toBe(0);
  expect(currentStage(lead)).toBe(BT);
  const dir = join(seededRecordDir(lead), "construction", BT);
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug(BT)!.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
  return lead;
}

describe("a lead's own checkout while a team holds a Unit claim", () => {
  test("a pause asked at Build and Test, after the Units, parks the work; the next look says so and a resume carries on there", () => {
    const lead = leadAtBuildAndTest();
    const parked = parkAsked(lead);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(stateField(lead, "Parked At Stage")).toBe(BT);
    expect(rows(lead, "WORKFLOW_PARKED", BT)).toHaveLength(1);
    expect(nextDirective(lead).kind).toBe("parked");
    const resume = directiveOf(runMergeTool(ORCH, ["next", "--resume"], lead));
    expect(resume.kind, JSON.stringify(resume)).toBe("print");
    expect(String(resume.message)).toContain("unpark");
    expect(directiveOf(runMergeTool(STATE, ["unpark"], lead)).unparked).toBe(true);
    expect(stateField(lead, "Parked")).toBe("");
    const after = nextDirective(lead);
    expect(after.kind, JSON.stringify(after)).not.toBe("error");
    expect(after.kind).not.toBe("parked");
    expect(currentStage(lead)).toBe(BT);
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

describe("a checkout that holds a Unit claim parks only its Unit, as before", () => {
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
    expect(parkAsked(p).kind).toBe("parked");
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
    expect(rows(p, "GATE_APPROVED", BT)).toHaveLength(1);
    expect(stateField(p, "Parked At Stage")).toBe(currentStage(p));
  });
});
