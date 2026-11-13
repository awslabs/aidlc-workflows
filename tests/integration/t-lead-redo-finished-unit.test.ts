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
//
// A redo of a Unit stage for every Unit there (the stage named with no Unit,
// --every-unit, the re-entry Redo or jump, or a move within the Unit stages)
// reopens it only for the Units this checkout builds and says once which it
// left and why; with none, nothing changes, and that line is the whole answer:
// said once, it ends the turn with nothing owed after it. The other Units' rows and
// approvals stay, and a team's finished Unit still lands. A stage an earlier
// release's jump skipped for every Unit is gone back to as before.
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactFilename, loadStageGraphAll, readAuditShardEvents, turnEndMarkerPath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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

function leadsCheckout(codeGeneration = "SKIP"): { lead: string; remote: string } {
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
- [ ] code-generation \u2014 ${codeGeneration}
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
  return leadAndTeam(claimed).lead;
}

function leadAndTeam(claimed = true): { lead: string; remote: string; team: string | null } {
  const { lead, remote } = leadsCheckout();
  nextDirective(lead);
  nextDirective(lead);
  expect(unitVerb(lead, "start", "alpha").status).toBe(0);
  finish(lead, "alpha");
  nextDirective(lead);
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "lead's work"]);
  git(lead, ["push", "origin", "main"]);
  if (!claimed) return { lead, remote, team: null };
  const team = clone(remote, "team");
  expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], team).status).toBe(0);
  git(lead, ["fetch", "origin"]);
  return { lead, remote, team };
}

// A complete answer with nothing owed: the sentence once, and the turn ends
// there. As an error, every skill would add a pointer to the doctor after it.
const told = (line: string) => ({ kind: "print", message: `Run nothing. Tell the person in one line: "${line}"` });

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
    rmSync(turnEndMarkerPath(lead), { force: true });
    expect(jump(lead, "alpha")).toEqual(told("alpha is finished, so it is not redone here; this checkout builds no Unit now."));
    expect(existsSync(turnEndMarkerPath(lead))).toBe(true);
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

// --- A redo for every Unit once a team has taken a Unit ---

const LEFT = "alpha is finished, gamma is built by team-g and beta is not taken yet";
const NOTHING_HERE = `Functional Design is not redone for every unit once a team has taken a unit: ${LEFT}.`;
const stageJumps = (lead: string) => readAuditShardEvents(lead).filter((row) => row.event === "STAGE_JUMPED").length;
const rowOf = (checkout: string, unit: string) =>
  readFileSync(seededStateFile(checkout), "utf-8").split("\n").find((line) => line.startsWith(`| ${unit} |`));
const orch = (lead: string, args: string[]) =>
  JSON.parse(runMergeTool(ORCH, args, lead).stdout) as { kind: string; message: string; stage?: string; unit?: string };

describe("a redo for every Unit once a team has taken a Unit", () => {
  test("with nothing built here, every way of asking changes nothing and says which Units it left and why", () => {
    const lead = leadWithNothingLeft();
    const parks = () => readAuditShardEvents(lead).filter((row) => row.event === "WORKFLOW_PARKED").length;
    const before = { jumps: stageJumps(lead), alpha: rowOf(lead, "alpha"), parks: parks() };
    for (const args of [
      ["next", "--stage", FD],
      ["next", "--stage", FD, "--every-unit"],
      ["report", "--result", "resumed", "--choice", "redo"],
      // "... and stop there for now": nothing moved, so there is nothing to park after.
      ["report", "--result", "resumed", "--choice", "redo", "--park"],
    ]) {
      rmSync(turnEndMarkerPath(lead), { force: true });
      const ran = runMergeTool(ORCH, args, lead);
      expect(ran.status, ran.out).toBe(0);
      expect(JSON.parse(ran.stdout), args.join(" ")).toEqual(told(NOTHING_HERE));
      expect(existsSync(turnEndMarkerPath(lead)), args.join(" ")).toBe(true);
    }
    const reentry = orch(lead, ["report", "--result", "resumed", "--choice", "jump", "--target", FD]);
    expect(reentry.message).toContain(`next --stage ${FD}`);
    expect(orch(lead, ["next", "--stage", FD])).toEqual(told(NOTHING_HERE));
    expect({ jumps: stageJumps(lead), alpha: rowOf(lead, "alpha"), parks: parks() }).toEqual(before);
  });

  test("named for a team's Unit with nothing built here, the offer to reopen it for every unit is not made", () => {
    expect(jump(leadWithNothingLeft(), "gamma")).toEqual(told(NOTHING_HERE));
  });

  test("with the lead's own Unit in progress, the redo reopens it only and says which Units it left", () => {
    const lead = leadAfterATeamClaimed();
    const before = { jumps: stageJumps(lead), alpha: rowOf(lead, "alpha") };
    for (const args of [["next", "--stage", FD], ["next", "--stage", FD, "--every-unit"]]) {
      const said = orch(lead, args);
      expect(said.kind, args.join(" ")).toBe("print");
      expect(said.message).toContain("aidlc-jump.ts reopen --target functional-design --stages functional-design --units beta --via redo");
      expect(said.message).toContain(
        "\"Redoing Functional Design for unit beta. alpha is finished and gamma is built by team-g, so they are not redone here.\"",
      );
    }
    const command = /`[^`]*aidlc-jump\.ts (reopen [^`]+)`/.exec(orch(lead, ["next", "--stage", FD]).message)?.[1];
    expect(command).toBeDefined();
    const ran = runMergeTool(join(AIDLC_SRC, "tools", "aidlc-jump.ts"), command!.split(" ").map((arg) => arg.replace(/^'|'$/g, "")), lead);
    expect(ran.status, ran.out).toBe(0);
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", stage: FD, unit: "beta" });
    expect({ jumps: stageJumps(lead), alpha: rowOf(lead, "alpha") }).toEqual(before);
  });

  test("a team's Unit finished before the ask still lands, with no second approval asked", () => {
    const { lead, team } = leadAndTeam();
    expect(unitVerb(team!, "start", "gamma").status).toBe(0);
    finish(team!, "gamma");
    nextDirective(team!);
    git(team!, ["add", "-A"]);
    git(team!, ["commit", "-m", "gamma work"]);
    expect(runMergeTool(UNIT, ["publish", "gamma"], team!).status).toBe(0);
    expect(orch(lead, ["next", "--stage", FD])).toEqual(told(NOTHING_HERE));
    git(lead, ["fetch", "origin"]);
    for (const args of [["pin", "gamma"], ["gate", "gamma", "--decision", "approve", "--user-input", "Approve"], ["land", "gamma"]]) {
      const step = runMergeTool(UNIT, args, lead);
      expect(step.status, `${args[0]}: ${step.out}`).toBe(0);
    }
  });

  test("a move ahead within the Unit stages, with nothing built here, changes nothing and says so", () => {
    // Code Generation on the plan; the lead builds no Unit, team-g took gamma.
    const { lead, remote } = leadsCheckout("EXECUTE");
    nextDirective(lead);
    nextDirective(lead);
    const team = clone(remote, "team");
    expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], team).status).toBe(0);
    git(lead, ["fetch", "origin"]);
    const before = stageJumps(lead);
    expect(orch(lead, ["next", "--stage", "code-generation"])).toEqual(told(
      "Code Generation is not redone for every unit once a team has taken a unit: " +
        "gamma is built by team-g and alpha and beta are not taken yet.",
    ));
    expect(stageJumps(lead)).toBe(before);
  });

  test("after every Unit landed, the redo changes nothing and main goes on with its own step", () => {
    const { lead, remote, team } = leadAndTeam();
    const land = (unit: string) => {
      git(lead, ["fetch", "origin"]);
      for (const args of [["pin", unit], ["gate", unit, "--decision", "approve", "--user-input", "Approve"], ["land", unit]]) {
        const step = runMergeTool(UNIT, args, lead);
        expect(step.status, `${args[0]} ${unit}: ${step.out}`).toBe(0);
      }
      // The land commits on main itself; the push shares it.
      git(lead, ["push", "origin", "main"]);
    };
    const build = (checkout: string, unit: string) => {
      expect(unitVerb(checkout, "start", unit).status).toBe(0);
      finish(checkout, unit);
      nextDirective(checkout);
      git(checkout, ["add", "-A"]);
      git(checkout, ["commit", "-m", `${unit} work`]);
      expect(runMergeTool(UNIT, ["publish", unit], checkout).status).toBe(0);
    };
    build(team!, "gamma");
    land("gamma");
    const teamB = clone(remote, "team-b");
    expect(runMergeTool(UNIT, ["claim", "beta", "--team", "team-b"], teamB).status).toBe(0);
    build(teamB, "beta");
    land("beta");
    const before = stageJumps(lead);
    expect(orch(lead, ["next", "--stage", FD])).toEqual(told(
      "Functional Design is not redone for every unit once a team has taken a unit: alpha, beta and gamma are finished.",
    ));
    expect(stageJumps(lead)).toBe(before);
    let step = nextDirective(lead);
    if (step.kind === "ask") step = nextDirective(lead);
    expect([step.kind, step.stage]).toEqual(["run-stage", "build-and-test"]);
  });

  test("a lead who has not fetched since the team's claim is answered the same", () => {
    const { lead, remote } = leadsCheckout();
    nextDirective(lead);
    nextDirective(lead);
    expect(unitVerb(lead, "start", "alpha").status).toBe(0);
    finish(lead, "alpha");
    nextDirective(lead);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "lead's work"]);
    git(lead, ["push", "origin", "main"]);
    const team = clone(remote, "team");
    expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], team).status).toBe(0);
    const before = stageJumps(lead);
    expect(orch(lead, ["report", "--result", "resumed", "--choice", "redo"])).toEqual(told(NOTHING_HERE));
    expect(orch(lead, ["next", "--stage", FD])).toEqual(told(NOTHING_HERE));
    expect(stageJumps(lead)).toBe(before);
  });

  test("a move ahead for every Unit within the Unit stages moves the lead's own Unit on, as a bare move does", () => {
    const { lead, remote } = leadsCheckout("EXECUTE");
    nextDirective(lead);
    nextDirective(lead);
    expect(unitVerb(lead, "start", "alpha").status).toBe(0);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "alpha begun"]);
    git(lead, ["push", "origin", "main"]);
    const team = clone(remote, "team");
    expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], team).status).toBe(0);
    // The lead's checkout has not fetched since the claim.
    const said = orch(lead, ["next", "--stage", "code-generation", "--every-unit"]);
    expect(said.message).not.toContain("Redoing Code Generation");
    expect(said.message).toContain('This moves only unit "alpha" on to "code-generation"');
  });

  test("a redo for every Unit of the later Unit stage the lead's own Unit is on reopens it there", () => {
    const { lead, remote } = leadsCheckout("EXECUTE");
    nextDirective(lead);
    nextDirective(lead);
    expect(unitVerb(lead, "start", "alpha").status).toBe(0);
    finish(lead, "alpha");
    expect(nextDirective(lead)).toMatchObject({ stage: "code-generation", unit: "alpha" });
    const started = runMergeTool(STATE, ["unit", "start", "--stage", "code-generation", "--unit", "alpha"], lead);
    expect(started.status, started.out).toBe(0);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "alpha on code generation"]);
    git(lead, ["push", "origin", "main"]);
    const team = clone(remote, "team");
    expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "team-g"], team).status).toBe(0);
    git(lead, ["fetch", "origin"]);
    const said = orch(lead, ["next", "--stage", "code-generation", "--every-unit"]);
    expect(said.message).toContain("aidlc-jump.ts reopen --target code-generation --stages code-generation --units alpha --via redo");
    expect(said.message).toContain(
      "\"Redoing Code Generation for unit alpha. gamma is built by team-g and beta is not taken yet, so they are not redone here.\"",
    );
  });

  test("while main is back before the Unit stages, a finished Unit named for a redo keeps its line", () => {
    const lead = leadWithNothingLeft();
    const back = runMergeTool(join(AIDLC_SRC, "tools", "aidlc-jump.ts"), ["execute", "--target", "units-generation", "--direction", "backward"], lead);
    expect(back.status, back.out).toBe(0);
    expect(jump(lead, "alpha")).toEqual(told("alpha is finished, so it is not redone here; this checkout builds no Unit now."));
  });

  test("going back from Build and Test after the move reopens the lead's own Unit only", () => {
    const lead = leadAfterATeamClaimed();
    const moved = runMergeTool(ORCH, ["next", "--stage", "build-and-test"], lead);
    expect(moved.status, moved.out).toBe(0);
    const before = { jumps: stageJumps(lead), alpha: rowOf(lead, "alpha") };
    const said = orch(lead, ["next", "--stage", FD]);
    expect(said.message).toContain(
      "\"Redoing Functional Design for unit beta. alpha is finished and gamma is built by team-g, so they are not redone here.\"",
    );
    const command = /`[^`]*aidlc-jump\.ts (reopen [^`]+)`/.exec(said.message)?.[1];
    const ran = runMergeTool(join(AIDLC_SRC, "tools", "aidlc-jump.ts"), command!.split(" ").map((arg) => arg.replace(/^'|'$/g, "")), lead);
    expect(ran.status, ran.out).toBe(0);
    const state = readFileSync(seededStateFile(lead), "utf-8");
    expect(state).toContain("- **Current Stage**: functional-design");
    expect(state).toContain("- [ ] build-and-test");
    expect({ jumps: stageJumps(lead), alpha: rowOf(lead, "alpha") }).toEqual(before);
  });

  test("in a teammate's clone, the lead's own Unit begun in their checkout is not called not taken", () => {
    const lead = leadAfterATeamClaimed();
    git(lead, ["push", "origin", "main"]);
    const remote = git(lead, ["remote", "get-url", "origin"]);
    const teammate = clone(remote, "teammate");
    expect(orch(teammate, ["next", "--stage", FD])).toEqual(told(
      "Functional Design is not redone for every unit once a team has taken a unit: " +
        "alpha is finished and gamma is built by team-g.",
    ));
  });

  test("a stage an earlier release's jump skipped for every Unit is gone back to as before", () => {
    const lead = leadWithNothingLeft();
    const path = seededStateFile(lead);
    writeFileSync(path, readFileSync(path, "utf-8")
      .replace("- [-] functional-design", "- [S] functional-design")
      .replace("- [ ] build-and-test", "- [-] build-and-test")
      .replace("- **Current Stage**: functional-design", "- **Current Stage**: build-and-test"));
    const before = stageJumps(lead);
    runMergeTool(ORCH, ["next", "--stage", FD], lead);
    expect(stageJumps(lead)).toBe(before + 1);
  });
});
