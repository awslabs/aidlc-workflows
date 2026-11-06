// covers: subcommand:aidlc-state:unit, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, function:unitOpenCheckpoints, function:activeUnitCheckpoint, function:unitLifecycleSnapshot
//
// Which checkout holds a Unit's work (#3610). The lead's checkout starts a
// Unit before any team took one, and main is pushed with it in progress. A
// teammate's clone claims another Unit: that Unit starts, walks Functional
// Design to its gate and on, whatever the lead does with theirs meanwhile. The
// lead's Unit stays the lead's: their chat goes on with it, its records are
// written, and nobody is offered it for claiming. Solo work, and the lead's
// own walk before the teams take Units, keep one active Unit at a time; a
// claimed checkout still works only its claim.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactFilename,
  loadStageGraphAll,
  readAuditShardEvents,
  unitOpenCheckpoints,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, createTestProject, seedAidlcMemory, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  AUTOMATIC_GIT_MAINTENANCE_OFF,
  ORCH,
  STATE,
  UNIT,
  cleanupTempDirs,
  clone,
  git,
  nextDirective,
  runMergeTool,
  tempDirs,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

// The stage's checks are not this file's subject (t325 keeps them off the same way).
process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const FD = "functional-design";
const REVIEWER = "aidlc-architecture-reviewer-agent";

// The lead's own checkout at Construction with two team Units and no walking
// skeleton, pushed to the remote every team clones. The plan is made here.
function leadsCheckout(ownership: "team" | "solo" = "team"): { lead: string; remote: string } {
  const lead = createTestProject();
  tempDirs.push(lead);
  seedAidlcMemory(lead);
  writeFileSync(seededStateFile(lead), `# AI-DLC State Tracking

## Project Information
- **Project**: two checkouts
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: off

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: ${ownership}
- **Unit Gate Rhythm**: per-stage
- **Review Override**: adversarial
- **Worktree Path**:
- **Bolt Refs**:

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design \u2014 EXECUTE
- [ ] nfr-requirements \u2014 EXECUTE
- [ ] nfr-design \u2014 EXECUTE
- [ ] infrastructure-design \u2014 EXECUTE
- [ ] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`);
  const depDir = join(seededRecordDir(lead), "inception", "units-generation");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(
    join(depDir, "unit-of-work-dependency.md"),
    "# Unit dependencies\n\n```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n",
  );
  // The block AI-DLC ships, so a commit takes what a real clone's takes.
  writeFileSync(join(lead, ".gitignore"), readFileSync(join(AIDLC_SRC, "..", ".gitignore"), "utf-8"));
  git(lead, ["init", "-b", "main"]);
  git(lead, ["config", "user.name", "lead"]);
  git(lead, ["config", "user.email", "lead@example.test"]);
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "the plan"]);
  const remote = mkdtempSync(join(tmpdir(), "aidlc-two-checkouts-remote-"));
  tempDirs.push(remote);
  git(remote, ["init", "--bare"]);
  for (const [key, value] of Object.entries(AUTOMATIC_GIT_MAINTENANCE_OFF)) git(remote, ["config", key, value]);
  git(lead, ["remote", "add", "origin", remote]);
  git(lead, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { lead, remote };
}

function unitVerb(checkout: string, action: string, unit: string, extra: string[] = []) {
  return runMergeTool(STATE, ["unit", action, "--stage", FD, "--unit", unit, ...extra], checkout);
}

// The words a refused command prints, out of the JSON line it writes.
function said(result: { out: string }): string {
  for (const line of result.out.split(/\r?\n/)) {
    try {
      const error = (JSON.parse(line) as { error?: unknown }).error;
      if (typeof error === "string") return error;
    } catch {
      // Not a JSON line.
    }
  }
  return result.out;
}

// Rows of one checkout are a second apart from the other's, as two people's are.
function nextSecond(): void {
  const now = new Date().toISOString().slice(0, 19);
  while (new Date().toISOString().slice(0, 19) === now) Bun.sleepSync(20);
}

// The lead's chat, before any team took a Unit: the share question is put
// once, the walk goes on to alpha's Functional Design and the agent starts it.
// Then main is pushed with alpha in progress (the agent's own commit and push).
function leadStartsAlpha(lead: string): void {
  const share = nextDirective(lead);
  expect(share, JSON.stringify(share)).toMatchObject({ kind: "ask", ask_type: "team-handover" });
  expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: FD, unit: "alpha" });
  const started = unitVerb(lead, "start", "alpha");
  expect(started.status, started.out).toBe(0);
  pushMain(lead, "the lead starts alpha");
}

function pushMain(lead: string, message: string): void {
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", message]);
  git(lead, ["push", "origin", "main"]);
}

function teammateClaimsBeta(remote: string): string {
  const team = clone(remote, "team");
  const claim = runMergeTool(UNIT, ["claim", "beta", "--team", "team-b"], team);
  expect(claim.status, claim.out).toBe(0);
  expect(nextDirective(team)).toMatchObject({ kind: "run-stage", stage: FD, unit: "beta" });
  return team;
}

// A Unit's Functional Design written and reviewed, as the stage's own steps do it.
function writeAndReview(checkout: string, unit: string): void {
  const stage = loadStageGraphAll().find((entry) => entry.slug === FD)!;
  const dir = join(seededRecordDir(checkout), "construction", unit, FD);
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n\n${unit}\n`);
  for (const args of [
    ["decision", "--stage", FD, "--decision", "A choice", "--unit", unit],
    ["answer", "--stage", FD, "--details", "An answer", "--unit", unit],
  ]) {
    const recorded = runMergeTool(LOG, args, checkout);
    expect(recorded.status, recorded.out).toBe(0);
  }
  const review = ["review", "--stage", FD, "--reviewer", REVIEWER, "--iteration", "1", "--unit", unit];
  const requested = runMergeTool(LOG, review, checkout);
  expect(requested.status, requested.out).toBe(0);
  appendFileSync(
    join(dir, artifactFilename(stage.review_artifact!)),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
  );
  const verdict = runMergeTool(LOG, [...review, "--verdict", "READY"], checkout);
  expect(verdict.status, verdict.out).toBe(0);
}

// After the Unit's completion the walk is at its gate, never the stage body
// again; the person approves it and the walk goes on to NFR Requirements.
function gateApprovedAndOn(checkout: string, unit: string): void {
  const gate = nextDirective(checkout);
  expect(gate.kind === "run-stage" && gate.gate !== true, JSON.stringify(gate)).toBe(false);
  expect(JSON.stringify(gate)).not.toContain("Team Construction Dispatcher");
  for (const args of [
    ["report", "--stage", FD, "--unit", unit, "--result", "awaiting-approval"],
    ["report", "--stage", FD, "--unit", unit, "--result", "approved", "--user-input", "Approve"],
  ]) {
    const reported = runMergeTool(ORCH, args, checkout);
    expect(reported.status, reported.out).toBe(0);
  }
  expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit });
}

function walkFunctionalDesign(checkout: string, unit: string): void {
  writeAndReview(checkout, unit);
  const completed = unitVerb(checkout, "complete", unit);
  expect(completed.status, completed.out).toBe(0);
  gateApprovedAndOn(checkout, unit);
}

function alphaRows(checkout: string): string[] {
  return readAuditShardEvents(checkout)
    .filter((row) => row.event.startsWith("UNIT_") && row.block.includes("**Unit**: alpha"))
    .map((row) => `${row.shard}:${row.event}`);
}

function claimable(checkout: string): string[] {
  const status = runMergeTool(UNIT, ["status"], checkout);
  expect(status.status, status.out).toBe(0);
  return (JSON.parse(status.stdout) as { claimable: string[] }).claimable;
}

describe("a teammate's claimed Unit beside the lead's Unit in progress on main", () => {
  test("it starts and walks Functional Design to its gate and on; the lead's Unit stays the lead's", () => {
    const { lead, remote } = leadsCheckout();
    leadStartsAlpha(lead);
    const team = teammateClaimsBeta(remote);
    const alphaBefore = alphaRows(team);
    expect(alphaBefore.length).toBeGreaterThan(0);

    nextSecond();
    const started = unitVerb(team, "start", "beta");
    expect(started.status, started.out).toBe(0);
    walkFunctionalDesign(team, "beta");

    // The teammate's checkout wrote nothing for alpha, and shows it as a Unit
    // not in progress here; the lead's checkout still has alpha in progress.
    expect(alphaRows(team)).toEqual(alphaBefore);
    expect(unitOpenCheckpoints(team, FD).map((open) => open.unit)).toEqual([]);
    expect(unitProgressRow(team, "alpha")).not.toContain("[-]");
    expect(unitOpenCheckpoints(lead, FD)).toMatchObject([{ unit: "alpha", state: "in-progress" }]);
  });

  test("the lead's paused Unit is not put to the teammate, and their gate is approved meanwhile", () => {
    const { lead, remote } = leadsCheckout();
    leadStartsAlpha(lead);
    nextSecond();
    const paused = unitVerb(lead, "pause", "alpha", ["--reason", "a question for the product owner", "--next-action", "ask it"]);
    expect(paused.status, paused.out).toBe(0);
    pushMain(lead, "the lead pauses alpha");

    const team = teammateClaimsBeta(remote);
    nextSecond();
    const started = unitVerb(team, "start", "beta");
    expect(started.status, started.out).toBe(0);
    walkFunctionalDesign(team, "beta");
    expect(unitOpenCheckpoints(lead, FD)).toMatchObject([{ unit: "alpha", state: "paused" }]);
  });

  test("the lead's Unit touched after the teammate started does not stop the teammate's completion", () => {
    const { lead, remote } = leadsCheckout();
    leadStartsAlpha(lead);
    const team = teammateClaimsBeta(remote);
    nextSecond();
    const started = unitVerb(team, "start", "beta");
    expect(started.status, started.out).toBe(0);
    writeAndReview(team, "beta");

    // The lead pauses alpha a second later and pushes; the lead's audit shard
    // as main has it reaches the teammate's checkout (their own state file,
    // which the pull would stop on, stays theirs).
    nextSecond();
    const paused = unitVerb(lead, "pause", "alpha", ["--reason", "lunch", "--next-action", "carry on"]);
    expect(paused.status, paused.out).toBe(0);
    pushMain(lead, "the lead pauses alpha");
    git(team, ["fetch", "origin", "main"]);
    const shards = git(team, ["diff", "--name-only", "HEAD", "origin/main"]).split(/\r?\n/).filter((path) => /\/audit\/[^/]+\.md$/.test(path));
    expect(shards).toHaveLength(1);
    git(team, ["checkout", "origin/main", "--", shards[0]]);
    expect(alphaRows(team).at(-1)).toEndWith(":UNIT_PAUSED");

    const completed = unitVerb(team, "complete", "beta");
    expect(completed.status, completed.out).toBe(0);
    gateApprovedAndOn(team, "beta");
  });
});

describe("the lead's own Unit, begun before a team claimed another, stays the lead's", () => {
  test("the lead's chat goes on with it: its step, its records and its gate, never the board", () => {
    const { lead, remote } = leadsCheckout();
    leadStartsAlpha(lead);
    teammateClaimsBeta(remote);

    // The lead's next step (the claims refreshed from the remote) is alpha's.
    const step = nextDirective(lead);
    expect(step, JSON.stringify(step).slice(0, 400)).toMatchObject({ kind: "run-stage", stage: FD, unit: "alpha" });
    walkFunctionalDesign(lead, "alpha");
    // A second chat in the same checkout meets the same step.
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
  });

  test("nobody is offered the lead's Unit while the lead walks it", () => {
    const { lead, remote } = leadsCheckout();
    leadStartsAlpha(lead);
    const team = teammateClaimsBeta(remote);
    expect(claimable(team)).not.toContain("alpha");
    const third = clone(remote, "third");
    expect(claimable(third)).toEqual([]);
    const shown = JSON.stringify(nextDirective(third));
    expect(shown).not.toContain("--claim alpha");
    expect(claimable(lead)).toEqual([]);
  });
});

describe("one active Unit at a time where this checkout holds every Unit", () => {
  test("the lead's own walk, before any team took a Unit, still refuses a second Unit", () => {
    const { lead } = leadsCheckout();
    nextDirective(lead);
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: FD, unit: "alpha" });
    expect(unitVerb(lead, "start", "alpha").status).toBe(0);
    const second = unitVerb(lead, "start", "beta");
    expect(second.status).not.toBe(0);
    expect(said(second)).toContain('unit "alpha" is in-progress');
    expect(said(second)).toContain("One active unit at a time.");
  });

  test("solo work still refuses a second Unit", () => {
    const { lead } = leadsCheckout("solo");
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: FD, unit: "alpha" });
    expect(unitVerb(lead, "start", "alpha").status).toBe(0);
    const second = unitVerb(lead, "start", "beta");
    expect(second.status).not.toBe(0);
    expect(said(second)).toContain('unit "alpha" is in-progress');
    expect(said(second)).toContain("One active unit at a time.");
  });

  test("a claimed checkout still works only its claim, and the lead's only their own", () => {
    const { lead, remote } = leadsCheckout();
    leadStartsAlpha(lead);
    const team = teammateClaimsBeta(remote);
    for (const action of ["start", "complete"]) {
      const foreign = unitVerb(team, action, "alpha");
      expect(foreign.status).not.toBe(0);
      expect(said(foreign)).toContain('This checkout is scoped to Unit "beta"; refusing foreign Unit "alpha".');
    }
    const second = runMergeTool(UNIT, ["claim", "alpha", "--team", "team-b"], team);
    expect(second.status).not.toBe(0);
    expect(said(second)).toContain('This checkout is already scoped to Unit "beta".');
    // The lead's checkout, the claims refreshed, works alpha and not the teammate's beta.
    nextDirective(lead);
    const theirs = unitVerb(lead, "start", "beta");
    expect(theirs.status).not.toBe(0);
    expect(said(theirs)).toContain('This checkout works Unit "alpha" without a claim');
  });
});
