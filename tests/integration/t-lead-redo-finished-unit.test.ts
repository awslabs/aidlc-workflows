// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// A lead's checkout of team-owned Units, after a team claimed another Unit:
// the lead finished their own alpha and is building beta, and asks to redo
// alpha. The checkout no longer builds a finished Unit, and the line says so,
// with the Units it does build; it never says alpha is not one of the work's
// Units. A Unit a team has taken is named with the team, as the board names
// it. With no Unit left to build here, the lead is told the same, and is not
// offered to reopen the stage for every Unit. A name the plan does not have
// keeps its line, a Unit this checkout builds is reopened as before, and a
// lead whose work no team has taken a Unit from goes on as before.
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactFilename, loadStageGraphAll, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, createTestProject, seedAidlcMemory, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  AUTOMATIC_GIT_MAINTENANCE_OFF, ORCH, STATE, UNIT, cleanupTempDirs, clone, git, nextDirective, runMergeTool, tempDirs,
} from "../harness/team-unit-merge.ts";

process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const FD = "functional-design";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const UNITS = ["alpha", "beta", "gamma"];

function leadsCheckout(): { lead: string; remote: string } {
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

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`);
  const depDir = join(seededRecordDir(lead), "inception", "units-generation");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "unit-of-work-dependency.md"),
    `# Unit dependencies\n\n\`\`\`yaml\nunits:\n${UNITS.map((u) => `  - name: ${u}\n    depends_on: []\n`).join("")}\`\`\`\n`);
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

const unitVerb = (c: string, action: string, unit: string) => runMergeTool(STATE, ["unit", action, "--stage", FD, "--unit", unit], c);

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

// The lead built alpha and is building beta in their own checkout, and a team
// has claimed gamma; the lead's checkout has fetched the claim.
function leadAfterATeamClaimed(): string {
  const { lead, remote } = leadsCheckout();
  nextDirective(lead);
  nextDirective(lead);
  expect(unitVerb(lead, "start", "alpha").status).toBe(0);
  finish(lead, "alpha");
  nextDirective(lead);
  expect(unitVerb(lead, "start", "beta").status).toBe(0);
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "lead's work"]);
  git(lead, ["push", "origin", "main"]);
  const team = clone(remote, "team");
  expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], team).status).toBe(0);
  git(lead, ["fetch", "origin"]);
  expect(nextDirective(lead)).toMatchObject({ stage: FD, unit: "beta" });
  return lead;
}

// The lead built alpha and nothing else in their own checkout; then a team
// claims gamma (unless `claimed` is false) and the lead's checkout fetches.
function leadWithNothingLeft(claimed = true): string {
  const { lead, remote } = leadsCheckout();
  nextDirective(lead);
  nextDirective(lead);
  expect(unitVerb(lead, "start", "alpha").status).toBe(0);
  finish(lead, "alpha");
  nextDirective(lead);
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "lead's work"]);
  git(lead, ["push", "origin", "main"]);
  if (claimed) {
    const team = clone(remote, "team");
    expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], team).status).toBe(0);
    git(lead, ["fetch", "origin"]);
  }
  return lead;
}

const jump = (lead: string, unit: string, stage = FD) =>
  JSON.parse(runMergeTool(ORCH, ["next", "--stage", stage, "--unit", unit], lead).stdout) as { kind: string; message: string };

describe("the lead's own finished Unit after a team claimed another", () => {
  test("asked to redo alpha, the line says alpha is finished and names what this checkout builds", () => {
    const lead = leadAfterATeamClaimed();
    expect(jump(lead, "alpha")).toEqual({
      kind: "error",
      message: "alpha is finished, and this checkout now builds beta, so alpha is not redone here. " +
        "Name a Unit this checkout builds with `/aidlc --stage functional-design --unit <name>`.",
    });
    const asked = JSON.parse(runMergeTool(ORCH, [
      "report", "--result", "resumed", "--choice", "redo", "--unit", "alpha",
    ], lead).stdout) as { kind: string; message: string };
    expect(asked.kind).toBe("print");
    expect(asked.message).toContain(
      "\"alpha is finished, and this checkout now builds beta, so alpha is not redone here. Which one did you mean?\"",
    );
  });

  test("asked for gamma, which a team has taken, the line names the team and what this checkout builds", () => {
    const lead = leadAfterATeamClaimed();
    expect(jump(lead, "gamma")).toEqual({
      kind: "error",
      message: "gamma is taken by team-g and built in their checkout; this checkout builds beta. " +
        "Name a Unit this checkout builds with `/aidlc --stage functional-design --unit <name>`.",
    });
  });

  test("with no Unit left to build here, asked to redo alpha: told it is finished, never offered every Unit", () => {
    const lead = leadWithNothingLeft();
    const jumps = () => readAuditShardEvents(lead).filter((row) => row.event === "STAGE_JUMPED").length;
    const before = jumps();
    expect(jump(lead, "alpha")).toEqual({
      kind: "error",
      message: "alpha is finished, so it is not redone here; this checkout builds no Unit now.",
    });
    expect(jumps()).toBe(before);
  });

  test("with no Unit left to build here, a stage done once for all Units keeps its question", () => {
    const said = jump(leadWithNothingLeft(), "alpha", "build-and-test");
    expect(said.kind, JSON.stringify(said)).toBe("print");
    expect(said.message).toContain(
      "Build and Test is done once for all units, so it cannot be redone for one unit. Nothing changed. " +
        "Do you want me to redo it for every unit?",
    );
  });

  test("a lead whose work no team has taken a Unit from goes on to redo alpha as before", () => {
    const said = jump(leadWithNothingLeft(false), "alpha");
    expect(said.kind, JSON.stringify(said)).toBe("print");
    expect(said.message).toContain("aidlc-jump.ts reopen --target functional-design");
  });

  test("a name the plan does not have keeps its line, and a Unit this checkout builds is reopened", () => {
    const lead = leadAfterATeamClaimed();
    expect(jump(lead, "zeta")).toEqual({
      kind: "error",
      message: "zeta is not one of this work's units (beta). Name one of them with `/aidlc --stage functional-design --unit <name>`.",
    });
    expect(jump(lead, "beta").kind).not.toBe("error");
  });
});
