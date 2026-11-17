// covers: subcommand:aidlc-unit:land, subcommand:aidlc-jump:execute, subcommand:aidlc-orchestrate:next
//
// Team-owned Units with a team still building one: the lead moves main on past
// the Unit stages (to Build and Test). Once a team has taken a Unit, the move
// leaves the Unit stages open on main, as going back before them does: Build
// and Test runs there, the board and status keep working, a team's clone keeps
// its own step, and each Unit still comes up for review and lands as it
// finishes, also after the work's last stage is approved, when main's next look
// is the board until they have. A merge the lead turns down is the team's to
// redo and leaves main on its own step. The lead is told once what is still open
// and whose.
//
// Solo work and team Units no team has taken still move on with the Unit
// stages skipped, and a land onto a record an earlier release wrote that way
// merges nothing and says why. Going back to Functional Design after the move
// reopens only the Units this checkout builds (t-lead-redo-finished-unit).

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, createTestProject, seedAidlcMemory, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  artifactFilename,
  auditBlockField,
  loadStageGraphAll,
  readAuditShardEvents,
  readUnitMergeTransaction,
  setCheckbox,
  setField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AUTOMATIC_GIT_MAINTENANCE_OFF,
  ORCH,
  STATE,
  UNIT,
  approveMerge,
  builtOnce,
  cleanupTempDirs,
  cleanupWorlds,
  clone,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
  tempDirs,
} from "../harness/team-unit-merge.ts";

process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS * 2);
afterEach(cleanupTempDirs);
afterAll(cleanupWorlds);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const FD = "functional-design";
const BT = "build-and-test";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const PER_UNIT = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const LATER = [
  "ci-pipeline", "deployment-pipeline", "environment-provisioning", "deployment-execution",
  "observability-setup", "incident-response", "performance-validation", "feedback-optimization",
];
const MOVED = "Moved to Build and Test.";
const BOARD_BROKEN = "could not compose its local board";

// --- The lead's main: Units alpha, beta and gamma; Functional Design the one
// Unit stage on the plan, Build and Test the last stage. ---

function leadsCheckout(): { lead: string; remote: string } {
  const lead = createTestProject();
  tempDirs.push(lead);
  seedAidlcMemory(lead);
  writeFileSync(seededStateFile(lead), `# AI-DLC State Tracking

## Project Information
- **Project**: moving on while teams build
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: off

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: team
- **Unit Gate Rhythm**: per-stage
- **Review Override**: adversarial
- **Worktree Path**:
- **Bolt Refs**:

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design \u2014 EXECUTE
- [ ] nfr-requirements \u2014 SKIP
- [ ] nfr-design \u2014 SKIP
- [ ] infrastructure-design \u2014 SKIP
- [ ] code-generation \u2014 SKIP
- [ ] build-and-test \u2014 EXECUTE
${LATER.map((slug) => `- [ ] ${slug} \u2014 SKIP\n`).join("")}
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`);
  const depDir = join(seededRecordDir(lead), "inception", "units-generation");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "unit-of-work-dependency.md"),
    `# Unit dependencies\n\n\`\`\`yaml\nunits:\n${["alpha", "beta", "gamma"].map((u) => `  - name: ${u}\n    depends_on: []\n`).join("")}\`\`\`\n`);
  writeFileSync(join(lead, ".gitignore"), readFileSync(join(AIDLC_SRC, "..", ".gitignore"), "utf-8"));
  git(lead, ["init", "-b", "main"]);
  git(lead, ["config", "user.name", "lead"]);
  git(lead, ["config", "user.email", "lead@example.test"]);
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "the plan"]);
  const remote = mkdtempSync(join(tmpdir(), "aidlc-move-on-remote-"));
  tempDirs.push(remote);
  git(remote, ["init", "--bare"]);
  for (const [key, value] of Object.entries(AUTOMATIC_GIT_MAINTENANCE_OFF)) git(remote, ["config", key, value]);
  git(lead, ["remote", "add", "origin", remote]);
  git(lead, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  // The walk's first looks, before any Unit is worked here.
  nextDirective(lead);
  nextDirective(lead);
  return { lead, remote };
}

const unitVerb = (c: string, action: string, unit: string) =>
  runMergeTool(STATE, ["unit", action, "--stage", FD, "--unit", unit], c);

function writeAndReview(checkout: string, unit: string): void {
  const stage = loadStageGraphAll().find((entry) => entry.slug === FD)!;
  const dir = join(seededRecordDir(checkout), "construction", unit, FD);
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n\n${unit}\n`);
  for (const args of [
    ["decision", "--stage", FD, "--decision", "A choice", "--unit", unit],
    ["answer", "--stage", FD, "--details", "An answer", "--unit", unit],
  ]) expect(runMergeTool(LOG, args, checkout).status).toBe(0);
  const review = ["review", "--stage", FD, "--reviewer", REVIEWER, "--iteration", "1", "--unit", unit];
  expect(runMergeTool(LOG, review, checkout).status).toBe(0);
  appendFileSync(join(dir, artifactFilename(stage.review_artifact!)),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
  expect(runMergeTool(LOG, [...review, "--verdict", "READY"], checkout).status).toBe(0);
}

/** The Unit's Functional Design, completed and approved in `checkout`. */
function finish(checkout: string, unit: string): void {
  writeAndReview(checkout, unit);
  const done = unitVerb(checkout, "complete", unit);
  expect(done.status, done.out).toBe(0);
  nextDirective(checkout);
  for (const args of [
    ["report", "--stage", FD, "--unit", unit, "--result", "awaiting-approval"],
    ["report", "--stage", FD, "--unit", unit, "--result", "approved", "--user-input", "Approve"],
  ]) {
    const r = runMergeTool(ORCH, args, checkout);
    expect(r.status, r.out).toBe(0);
  }
}

function commitAndPush(checkout: string, message: string): void {
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-m", message]);
  git(checkout, ["push", "origin", "main"]);
}

/** The lead finished alpha on main and pushed; team-g's clone claimed gamma.
 *  The lead has not fetched since the claim. Built once, copied per case. */
const gammaClaimed = builtOnce((): { lead: string; remote: string; teamG: string } => {
  const { lead, remote } = leadsCheckout();
  expect(unitVerb(lead, "start", "alpha").status).toBe(0);
  finish(lead, "alpha");
  nextDirective(lead);
  commitAndPush(lead, "the lead's alpha");
  const teamG = clone(remote, "team-g");
  const claimed = runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], teamG);
  expect(claimed.status, claimed.out).toBe(0);
  return { lead, remote, teamG };
});

/** `next` with `args`, through its load-steering parts, and the lines the step
 *  it lands on says (the parts carry the same lines on to it). */
function nextSaying(checkout: string, args: string[]): { directive: Record<string, unknown>; said: string[] } {
  const first = runMergeTool(ORCH, args, checkout);
  expect(first.status, first.out).toBe(0);
  let directive = JSON.parse(first.stdout) as Record<string, unknown>;
  while (directive.kind === "load-steering" && typeof directive.receipt === "string") {
    const continued = runMergeTool(ORCH, ["continue", directive.receipt], checkout);
    expect(continued.status, continued.out).toBe(0);
    directive = JSON.parse(continued.stdout) as Record<string, unknown>;
  }
  const said = Array.isArray(directive.change_notices) ? (directive.change_notices as string[]) : [];
  return { directive, said };
}

const stateOf = (checkout: string) => readFileSync(seededStateFile(checkout), "utf-8");
const rowOf = (checkout: string, unit: string) =>
  stateOf(checkout).split("\n").find((line) => line.startsWith(`| ${unit} |`));
const eventsSince = (checkout: string, from: number) => readAuditShardEvents(checkout).slice(from).map((row) => row.event);
const status = (checkout: string) => runMergeTool(UTIL, ["status"], checkout);
const message = (d: Record<string, unknown>) => String(d.message ?? d.question ?? d.error ?? "");
const lastJump = (checkout: string) => readAuditShardEvents(checkout).filter((row) => row.event === "STAGE_JUMPED").at(-1)!;

function moveOn(lead: string): { directive: Record<string, unknown>; said: string[]; events: string[] } {
  const from = readAuditShardEvents(lead).length;
  const moved = nextSaying(lead, ["next", "--stage", BT]);
  return { ...moved, events: eventsSince(lead, from) };
}

/** A team's Unit, from its own step to its publish, in its own clone. */
function teamBuilds(team: string, unit: string): void {
  const own = nextDirective(team);
  expect([own.kind, own.stage, own.unit]).toEqual(["run-stage", FD, unit]);
  expect(unitVerb(team, "start", unit).status).toBe(0);
  finish(team, unit);
  const handOver = nextDirective(team);
  expect(message(handOver)).toContain("publish it for review on main");
  git(team, ["add", "-A"]);
  git(team, ["commit", "-m", `${unit} work`]);
  const published = runMergeTool(UNIT, ["publish", unit], team);
  expect(published.status, published.out).toBe(0);
}

function lands(lead: string, unit: string): void {
  git(lead, ["fetch", "origin"]);
  approveMerge(lead, unit);
  const landed = runMergeTool(UNIT, ["land", unit], lead);
  expect(landed.status, landed.out).toBe(0);
  expect(readUnitMergeTransaction(lead, unit)?.status).toBe("complete");
}

describe("a lead's main whose team holds a Unit moves on to Build and Test", () => {
  test("the Unit stages stay open, the lead is told once what is still open and whose, and Build and Test runs", () => {
    const { lead } = gammaClaimed();
    const alphaRow = rowOf(lead, "alpha");
    const moved = moveOn(lead);
    expect(moved.events).toEqual(["STAGE_JUMPED", "STAGE_STARTED"]);
    expect(stateOf(lead)).toContain("- [-] functional-design");
    expect([moved.directive.kind, moved.directive.stage]).toEqual(["run-stage", BT]);
    expect(moved.said).toEqual([
      `${MOVED} Still open on main, and landing as they finish: gamma (team-g); beta, not taken yet.`,
    ]);
    const again = nextSaying(lead, ["next"]);
    expect([again.directive.kind, again.directive.stage]).toEqual(["run-stage", BT]);
    expect(again.said.join(" ")).not.toContain("Still open");
    const shown = status(lead);
    expect(shown.status, shown.out).toBe(0);
    expect(shown.out).toContain("Build and Test");
    expect(rowOf(lead, "alpha")).toBe(alphaRow);
  });

  test("the move asked again on the way back into the work says the same, once", () => {
    const { lead } = gammaClaimed();
    const reentry = runMergeTool(ORCH, ["report", "--result", "resumed", "--choice", "jump", "--target", BT], lead);
    expect(reentry.status, reentry.out).toBe(0);
    expect(reentry.out).toContain(`next --stage ${BT}`);
    const moved = moveOn(lead);
    expect([moved.directive.kind, moved.directive.stage]).toEqual(["run-stage", BT]);
    expect(moved.said).toEqual([
      `${MOVED} Still open on main, and landing as they finish: gamma (team-g); beta, not taken yet.`,
    ]);
  });

  test("a team that pulls the pushed main keeps its own step, and its Unit lands on main", () => {
    const { lead, teamG } = gammaClaimed();
    const alphaRow = rowOf(lead, "alpha");
    moveOn(lead);
    commitAndPush(lead, "main moved on");
    git(teamG, ["fetch", "origin"]);
    git(teamG, ["merge", "--no-edit", "origin/main"]);
    teamBuilds(teamG, "gamma");
    git(lead, ["fetch", "origin"]);
    const offer = nextDirective(lead);
    expect(message(offer)).toContain("gamma is ready from team-g: review and merge it?");
    lands(lead, "gamma");
    expect(rowOf(lead, "gamma")).toMatch(/\| \[x\] \|$/);
    expect(rowOf(lead, "alpha")?.startsWith(alphaRow!.slice(0, -1))).toBe(true);
    expect(message(nextDirective(lead))).not.toContain(BOARD_BROKEN);
  });

  test("a teammate's clone with nothing left to take keeps the board", () => {
    const { lead, remote } = gammaClaimed();
    moveOn(lead);
    commitAndPush(lead, "main moved on");
    const teamB = clone(remote, "team-b");
    expect(runMergeTool(UNIT, ["claim", "beta", "--team", "team-b"], teamB).status).toBe(0);
    const teamC = clone(remote, "team-c");
    const board = nextDirective(teamC);
    expect(board.kind).toBe("notice");
    expect(message(board)).toContain("# Team Construction Board");
    expect(message(board)).not.toContain(BOARD_BROKEN);
    const mains = nextDirective(lead);
    expect([mains.kind, mains.stage]).toEqual(["run-stage", BT]);
  });

  test("a merge the lead turns down leaves main on Build and Test", () => {
    const { lead, teamG } = gammaClaimed();
    moveOn(lead);
    commitAndPush(lead, "main moved on");
    git(teamG, ["fetch", "origin"]);
    git(teamG, ["merge", "--no-edit", "origin/main"]);
    teamBuilds(teamG, "gamma");
    git(lead, ["fetch", "origin"]);
    expect(runMergeTool(UNIT, ["pin", "gamma"], lead).status).toBe(0);
    const rejected = runMergeTool(UNIT, ["gate", "gamma", "--decision", "reject", "--user-input", "Reject"], lead);
    expect(rejected.status, rejected.out).toBe(0);
    const mains = nextDirective(lead);
    expect([mains.kind, mains.stage], message(mains)).toEqual(["run-stage", BT]);
  });

  test("approving the last stage while a Unit is open finishes the work, the board stays up, and the Unit lands after", () => {
    const { lead, teamG } = gammaClaimed();
    moveOn(lead);
    for (const args of [
      ["report", "--stage", BT, "--result", "awaiting-approval"],
      ["report", "--stage", BT, "--result", "approved", "--user-input", "Approve"],
    ]) {
      const reported = runMergeTool(ORCH, args, lead);
      expect(reported.status, reported.out).toBe(0);
    }
    expect(stateOf(lead)).toContain("- **Status**: Completed");
    const end = nextDirective(lead);
    expect(end.kind).toBe("notice");
    expect(message(end)).toContain("# Team Construction Board");
    expect(String(end.narration ?? "")).not.toContain("Your work is finished");
    commitAndPush(lead, "the work's end");
    git(teamG, ["fetch", "origin"]);
    git(teamG, ["merge", "--no-edit", "origin/main"]);
    teamBuilds(teamG, "gamma");
    git(lead, ["fetch", "origin"]);
    expect(message(nextDirective(lead))).toContain("gamma is ready from team-g: review and merge it?");
    lands(lead, "gamma");
    expect(rowOf(lead, "gamma")).toMatch(/\| \[x\] \|$/);
  });

  test("going back to Functional Design after the move, with nothing built here, changes nothing and says why", () => {
    const { lead } = gammaClaimed();
    moveOn(lead);
    const back = runMergeTool(ORCH, ["next", "--stage", FD], lead);
    expect(JSON.parse(back.stdout)).toEqual({
      kind: "print",
      message: "Run nothing. Tell the person in one line: \"Functional Design is not redone for every unit once a team " +
        "has taken a unit: alpha is finished, gamma is built by team-g and beta is not taken yet.\"",
    });
    expect(stateOf(lead)).toContain("- **Current Stage**: build-and-test");
  });
});

describe("moving on where no team holds a Unit of the lead's", () => {
  test("the lead's own Unit begun before any claim is not named, and Build and Test runs", () => {
    const { lead, remote } = leadsCheckout();
    expect(unitVerb(lead, "start", "alpha").status).toBe(0);
    finish(lead, "alpha");
    nextDirective(lead);
    expect(unitVerb(lead, "start", "beta").status).toBe(0);
    writeAndReview(lead, "beta");
    commitAndPush(lead, "the lead's alpha, and beta begun");
    const teamG = clone(remote, "team-g");
    expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], teamG).status).toBe(0);
    const moved = moveOn(lead);
    expect(moved.events).toEqual(["STAGE_JUMPED", "STAGE_STARTED"]);
    expect([moved.directive.kind, moved.directive.stage]).toEqual(["run-stage", BT]);
    expect(moved.said).toEqual([`${MOVED} Still open on main, and landing as they finish: gamma (team-g).`]);
  });

  test("with the lead's own Unit still open, approving the last stage leaves the board up, not the work's end", () => {
    const { lead, remote } = leadsCheckout();
    expect(unitVerb(lead, "start", "alpha").status).toBe(0);
    finish(lead, "alpha");
    nextDirective(lead);
    expect(unitVerb(lead, "start", "beta").status).toBe(0);
    commitAndPush(lead, "the lead's alpha, and beta begun");
    const teamG = clone(remote, "team-g");
    expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], teamG).status).toBe(0);
    moveOn(lead);
    for (const args of [
      ["report", "--stage", BT, "--result", "awaiting-approval"],
      ["report", "--stage", BT, "--result", "approved", "--user-input", "Approve"],
    ]) {
      const reported = runMergeTool(ORCH, args, lead);
      expect(reported.status, reported.out).toBe(0);
    }
    const end = nextDirective(lead);
    expect(end.kind, JSON.stringify(end)).toBe("notice");
    expect(message(end)).toContain("# Team Construction Board");
    expect(String(end.narration ?? "")).not.toContain("Your work is finished");
  });

  test("team Units no team has taken: the move skips the Unit stages and says so, as before", () => {
    const { lead } = leadsCheckout();
    expect(unitVerb(lead, "start", "alpha").status).toBe(0);
    finish(lead, "alpha");
    nextDirective(lead);
    const moved = moveOn(lead);
    expect(moved.events).toEqual(["STAGE_SKIPPED", "STAGE_JUMPED", "STAGE_STARTED"]);
    expect(auditBlockField(lastJump(lead).block, "Unit Work")).toBeNull();
    expect(stateOf(lead)).toContain("- [S] functional-design");
    expect([moved.directive.kind, moved.directive.stage]).toEqual(["run-stage", BT]);
    expect(moved.said).toEqual([
      "Moved to Build and Test; skipped Functional Design. You can go back to Functional Design any time.",
    ]);
  });
});

// --- The Unit stages all five on the plan: a pinned and approved merge, then
// main moved on with the jump tool itself (the printed move, no chat). ---

function moveMainOnToBuildAndTest(seed: string): string | undefined {
  const jumped = runMergeTool(JUMP, ["execute", "--target", BT, "--direction", "forward"], seed);
  expect(jumped.status, jumped.out).toBe(0);
  return (JSON.parse(jumped.stdout) as { notice?: string }).notice;
}

function landsAndMainGoesOn(seed: string, unit: string): void {
  const landed = runMergeTool(UNIT, ["land", unit], seed);
  expect(landed.status, landed.out).toBe(0);
  expect(readUnitMergeTransaction(seed, unit)?.status).toBe("complete");
  for (const slug of PER_UNIT) expect(stateOf(seed)).not.toContain(`- [S] ${slug}`);
  const shown = status(seed);
  expect(shown.status, shown.out).toBe(0);
  // The push offer after the land comes first; then main's own step.
  const steps = [nextDirective(seed), nextDirective(seed)];
  expect(steps.map((step) => message(step)).join(" ")).not.toContain(BOARD_BROKEN);
  expect(steps.some((step) => step.kind === "run-stage" && step.stage === BT), JSON.stringify(steps)).toBe(true);
}

describe("land after main moved on past the Unit stages", () => {
  test("the move keeps the Unit stages, and the land merges and records the Unit", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    approveMerge(seed, "alpha");
    // The plan's stages, as status counts them: the Unit stages still open behind
    // Build and Test are on the plan.
    const planTotal = () => /Completion:\s+\d+\/(\d+) stages/.exec(status(seed).out)?.[1];
    const before = planTotal();
    expect(before).toBeDefined();
    expect(moveMainOnToBuildAndTest(seed)).toBe(
      `${MOVED} Still open on main, and landing as they finish: alpha (alpha-team); beta, not taken yet.`,
    );
    expect(planTotal()).toBe(before);
    landsAndMainGoesOn(seed, "alpha");
    expect(planTotal()).toBe(before);
  });

  test("a merge already on main is finished and recorded", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    approveMerge(seed, "alpha");
    const gitStep = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed);
    expect(gitStep.status, gitStep.out).toBe(0);
    moveMainOnToBuildAndTest(seed);
    landsAndMainGoesOn(seed, "alpha");
  });

  test("on a record an earlier release wrote with the Unit stages skipped, the land merges nothing and says why", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    approveMerge(seed, "alpha");
    let state = stateOf(seed);
    for (const slug of PER_UNIT) state = setCheckbox(state, slug, "skipped");
    state = setField(setCheckbox(state, BT, "in-progress"), "Current Stage", BT);
    writeFileSync(seededStateFile(seed), state);
    const head = git(seed, ["rev-parse", "HEAD"]);

    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("was not merged");
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(join(seed, ".git", "MERGE_HEAD"))).toBe(false);
    expect(readUnitMergeTransaction(seed, "alpha")?.status).toBe("approved");
  });
});

// --- After the move the teams keep their Units: the switches that would take
// them from the teams are refused as they were before it. ---

describe("after main moved on while a team holds a Unit, the teams keep their Units", () => {
  test("the move records the Unit work as kept, and building the Units alone or changing the gate rhythm is refused as before it", () => {
    const { lead } = gammaClaimed();
    const switches = [["set-unit-ownership", "solo"], ["set-unit-gate-rhythm", "unit-end"]];
    const before = switches.map((args) => runMergeTool(STATE, args, lead));
    for (const refused of before) expect(refused.status, refused.out).not.toBe(0);
    moveOn(lead);
    const moved = stateOf(lead);
    switches.forEach((args, i) => {
      const after = runMergeTool(STATE, args, lead);
      expect(after.status, after.out).not.toBe(0);
      expect(after.out).toBe(before[i].out);
    });
    expect(stateOf(lead)).toBe(moved);
    expect(auditBlockField(lastJump(lead).block, "Unit Work")).toBe("kept");
  });
});
