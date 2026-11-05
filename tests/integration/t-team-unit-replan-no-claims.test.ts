// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:team-board, subcommand:aidlc-unit:claim, subcommand:aidlc-unit:status, subcommand:aidlc-unit:land, file:tools/aidlc-jump.ts
//
// A team-owned intent changes its Unit plan after some Units have landed, with
// no claim open (merge strategy): the person goes back to Units Generation on
// main (`next --stage units-generation`), revises the units block and approves
// Units Generation and Delivery Planning again. A jump that reset every Unit's
// per-Unit stages with the rest would have main's first step turn the landed
// Units back into unfinished work (a landed Unit "claimed by" its old owner,
// the board's rows reset), and main would never reach Build and Test.
//
// This file checks what the move resets and what it keeps (landed Units' rows,
// reviews, merge receipts and claim refs), that main's walk afterwards treats
// the landed Units as landed, that a Unit added by the new plan is claimed,
// worked and landed like any other, and that the intent then moves on to Build
// and Test.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, } from "node:fs";
import { join } from "node:path";
import { seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import {
  builtOnce,
  cleanupTempDirs,
  cleanupWorlds,
  clone,
  gateAndLand,
  git,
  nextDirective,
  ORCH,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import {
  currentStage,
  makeReplanSeed,
  PLAN_WITH_GAMMA,
  type PlannedUnit,
  reopenUnitsGeneration,
  replan,
  stageLine,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);
afterAll(cleanupWorlds);

const CONSTRUCTION_STAGES = [
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
  "build-and-test",
  "ci-pipeline",
];
const COMPLETE_ROW = Array(7).fill("[x]");
const UNCHANGED_PLAN: PlannedUnit[] = [
  { name: "skeleton", depends_on: [] },
  { name: "alpha", depends_on: ["skeleton"] },
  { name: "beta", depends_on: ["skeleton"] },
];

// A team main with a done Inception (its walking-skeleton stance recorded, as
// a main past its first Construction stage has it) and the skeleton landed.
function replanSeed(): { seed: string; remote: string } {
  return makeReplanSeed();
}

// alpha claimed, worked and landed on main before the plan changes; built
// once, and each case gets its own copy.
const alphaLanded = builtOnce((): { seed: string; remote: string } => {
  const made = replanSeed();
  prepareCandidate(made.remote, "alpha", "alpha-team");
  gateAndLand(made.seed, "alpha");
  git(made.seed, ["push", "origin", "main"]);
  return made;
});

/** A Unit claimed, worked and published after the plan changed, as any Unit is. */
function workAfterReplan(remote: string, unit: string): string {
  return prepareCandidate(remote, unit, `${unit}-team`).checkout;
}

function landAfterReplan(main: string, remote: string, unit: string): string {
  const checkout = workAfterReplan(remote, unit);
  gateAndLand(main, unit);
  git(main, ["push", "origin", "main"]);
  return checkout;
}

function cells(checkout: string, unit: string): string[] {
  return unitProgressRow(checkout, unit).split("|").slice(1, -1).map((cell) => cell.trim()).slice(2);
}

/** A Unit's row as the read-only team board renders it, without the unit and owner columns. */
function boardCells(main: string, unit: string): string[] {
  const board = runMergeTool(ORCH, ["team-board", "--snapshot"], main);
  expect(board.status, board.out).toBe(0);
  const row = board.stdout.split(/\r?\n/).find((line) => line.startsWith(`| ${unit} `));
  expect(row, board.stdout).toBeTruthy();
  return row!.split("|").slice(1, -1).map((cell) => cell.trim()).slice(2);
}

function auditBlocks(main: string): string[] {
  const dir = seededAuditDir(main);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => readFileSync(join(dir, name), "utf-8").replace(/\r\n/g, "\n").split("\n---\n"));
}

function eventBlocks(main: string, event: string): string[] {
  return auditBlocks(main).filter((block) => block.includes(`**Event**: ${event}`));
}

function mergedUnits(main: string): string[] {
  return eventBlocks(main, "UNIT_MERGED").map((block) => /\*\*Unit\*\*: (\S+)/.exec(block)?.[1] ?? "").sort();
}

function status(checkout: string): { claimable: string[]; claimed: unknown[]; claims: unknown } {
  const result = runMergeTool(UNIT, ["status"], checkout);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout);
}

function expectPlainClaimRefused(remote: string, unit: string): void {
  const checkout = clone(remote, `${unit}-again`);
  const plain = runMergeTool(UNIT, ["claim", unit, "--team", `${unit}-again`], checkout);
  expect(plain.status, plain.out).not.toBe(0);
  expect(plain.out).toContain("already complete");
  expect(plain.out).not.toContain("already claimed");
}

describe("t-team-unit-replan-no-claims: the Unit plan changes with no claim open", () => {
  test("going back to Units Generation resets the stage checkboxes and leaves the landed Units' rows, merge receipts and claim refs alone", () => {
    const { seed, remote } = alphaLanded();
    const mergedBefore = mergedUnits(seed);
    expect(mergedBefore).toEqual(["alpha"]);

    const reopened = reopenUnitsGeneration(seed);
    expect(reopened.status, reopened.out).toBe(0);
    expect(JSON.parse(reopened.stdout)).toMatchObject({ kind: "load-steering", stage: "units-generation" });

    expect(stageLine(seed, "units-generation")).toContain("[-]");
    expect(stageLine(seed, "delivery-planning")).toContain("[ ]");
    for (const stage of CONSTRUCTION_STAGES) expect(stageLine(seed, stage), stage).toContain("[ ]");
    expect(currentStage(seed)).toBe("units-generation");
    expect(readFileSync(seededStateFile(seed), "utf-8")).toContain("**Lifecycle Phase**: INCEPTION");
    expect(eventBlocks(seed, "STAGE_JUMPED").some((block) => block.includes("**Target**: units-generation"))).toBe(true);

    // Nothing the Units landed is undone: rows, merge receipts, claim ref.
    expect(cells(seed, "skeleton")).toEqual(COMPLETE_ROW);
    expect(cells(seed, "alpha")).toEqual(COMPLETE_ROW);
    expect(cells(seed, "beta")).toEqual(Array(7).fill("[ ]"));
    expect(mergedUnits(seed)).toEqual(mergedBefore);
    expect(git(seed, ["ls-remote", "origin", "refs/heads/claim/*"])).toContain("/alpha");

    // The landed Units are not offered again; the unlanded one still is.
    const listed = status(seed);
    expect(listed.claimable).toEqual(["beta"]);
    expect(listed.claimed).toEqual([]);
    expectPlainClaimRefused(remote, "alpha");
  });

  test("the landed Units' stages still read done on the board once Units Generation is reopened", () => {
    const { seed } = alphaLanded();
    expect(boardCells(seed, "alpha")).toEqual(COMPLETE_ROW);
    expect(boardCells(seed, "skeleton")).toEqual(COMPLETE_ROW);

    const reopened = reopenUnitsGeneration(seed);
    expect(reopened.status, reopened.out).toBe(0);

    // main's own Unit Progress table still reads complete, so the board
    // disagrees with the record it is derived from.
    expect(cells(seed, "alpha")).toEqual(COMPLETE_ROW);
    expect(boardCells(seed, "alpha"), "alpha landed before the plan changed").toEqual(COMPLETE_ROW);
    expect(boardCells(seed, "skeleton"), "skeleton landed before the plan changed").toEqual(COMPLETE_ROW);
  });

  test("the jump keeps the landed Units' reviews out of what it invalidates downstream", () => {
    const { seed } = alphaLanded();
    const reopened = reopenUnitsGeneration(seed);
    expect(reopened.status, reopened.out).toBe(0);
    const jumped = eventBlocks(seed, "STAGE_JUMPED").find((block) => block.includes("**Target**: units-generation"));
    expect(jumped).toBeTruthy();
    const invalidated = /\*\*Invalidated Downstream Reviews\*\*: (.*)/.exec(jumped!)?.[1] ?? "";
    // Their code is on main and is not being redone; only Units not yet
    // landed owe their per-stage reviews again.
    expect(invalidated, jumped).not.toContain("/construction/alpha/");
    expect(invalidated, jumped).not.toContain("/construction/skeleton/");
  });

  test("the revised plan is approved: the walk restarts at Functional Design, landed Units stay landed and are not offered, the new Unit is claimable (before main takes a step)", () => {
    const { seed, remote } = alphaLanded();
    replan(seed, PLAN_WITH_GAMMA);

    expect(stageLine(seed, "units-generation")).toContain("[x]");
    expect(stageLine(seed, "delivery-planning")).toContain("[x]");
    expect(currentStage(seed)).toBe("functional-design");
    expect(cells(seed, "skeleton")).toEqual(COMPLETE_ROW);
    expect(cells(seed, "alpha")).toEqual(COMPLETE_ROW);

    const listed = status(seed);
    expect(listed.claimable.slice().sort()).toEqual(["beta", "gamma"]);
    expect(listed.claimed).toEqual([]);
    expectPlainClaimRefused(remote, "alpha");
    expectPlainClaimRefused(remote, "skeleton");
  });

  test("a Unit the new plan adds is claimed, worked and landed like any other, with main's walk untouched before it lands", () => {
    const { seed, remote } = alphaLanded();
    replan(seed, PLAN_WITH_GAMMA);

    // gamma depends only on the landed alpha; it lands before any step of main's own walk.
    workAfterReplan(remote, "gamma");
    expect(status(seed).claimed).toEqual([{ unit: "gamma", owner: "gamma-team", generation: 1 }]);
    gateAndLand(seed, "gamma");
    git(seed, ["push", "origin", "main"]);

    expect(cells(seed, "gamma")).toEqual(COMPLETE_ROW);
    expect(cells(seed, "alpha")).toEqual(COMPLETE_ROW);
    expect(cells(seed, "skeleton")).toEqual(COMPLETE_ROW);
    expect(mergedUnits(seed)).toEqual(["alpha", "gamma"]);
    const listed = status(seed);
    expect(listed.claimable).toEqual(["beta"]);
    expect(listed.claimed).toEqual([]);
    // Landing gamma does not turn the earlier landings into open claims.
    expectPlainClaimRefused(remote, "alpha");

  });

  // main's first step in the walk after the plan change; the person commits and pushes what it wrote.
  function mainTakesItsFirstStep(seed: string): Record<string, unknown> {
    const step = nextDirective(seed);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "--allow-empty", "-m", "main's first step"]);
    git(seed, ["push", "origin", "main"]);
    return step;
  }

  function expectLandedUnitsStayLanded(seed: string, remote: string, claimable: string[]): void {
    expect(cells(seed, "skeleton"), unitProgressRow(seed, "skeleton")).toEqual(COMPLETE_ROW);
    expect(cells(seed, "alpha"), unitProgressRow(seed, "alpha")).toEqual(COMPLETE_ROW);
    const listed = status(seed);
    expect(listed.claimed, JSON.stringify(listed)).toEqual([]);
    expect(listed.claimable.slice().sort(), JSON.stringify(listed)).toEqual(claimable);
    expectPlainClaimRefused(remote, "alpha");
  }

  test("main's first step after the plan change leaves the landed Units landed", () => {
    const { seed, remote } = alphaLanded();
    replan(seed, PLAN_WITH_GAMMA);
    mainTakesItsFirstStep(seed);
    expectLandedUnitsStayLanded(seed, remote, ["beta", "gamma"]);
  });

  test("with the plan unchanged, main's first step also leaves the landed Units landed", () => {
    const { seed, remote } = alphaLanded();
    replan(seed, UNCHANGED_PLAN);
    mainTakesItsFirstStep(seed);
    expectLandedUnitsStayLanded(seed, remote, ["beta"]);
  });

  test("after every Unit has landed on a revised plan, main moves on to Build and Test", () => {
    const { seed, remote } = alphaLanded();
    replan(seed, PLAN_WITH_GAMMA);
    landAfterReplan(seed, remote, "gamma");
    landAfterReplan(seed, remote, "beta");
    for (const unit of ["skeleton", "alpha", "beta", "gamma"]) expect(cells(seed, unit), unit).toEqual(COMPLETE_ROW);

    for (const stage of CONSTRUCTION_STAGES.slice(0, 5)) {
      expect(stageLine(seed, stage), `every Unit landed: ${stage}`).toContain("[x]");
    }
    expect(currentStage(seed)).toBe("build-and-test");
    expect(nextDirective(seed)).toMatchObject({ kind: "run-stage", stage: "build-and-test" });
  });

  test("approving Units Generation with no change to the plan keeps the landed Units landed and the same Units claimable (before main takes a step)", () => {
    const { seed, remote } = alphaLanded();
    replan(seed, UNCHANGED_PLAN);

    expect(currentStage(seed)).toBe("functional-design");
    expect(stageLine(seed, "units-generation")).toContain("[x]");
    expect(stageLine(seed, "delivery-planning")).toContain("[x]");
    expect(cells(seed, "skeleton")).toEqual(COMPLETE_ROW);
    expect(cells(seed, "alpha")).toEqual(COMPLETE_ROW);
    expect(mergedUnits(seed)).toEqual(["alpha"]);
    const listed = status(seed);
    expect(listed.claimable).toEqual(["beta"]);
    expect(listed.claimed).toEqual([]);
    expectPlainClaimRefused(remote, "alpha");
  });

  test("with the plan unchanged, main moves on to Build and Test once the last Unit lands", () => {
    const { seed, remote } = alphaLanded();
    replan(seed, UNCHANGED_PLAN);
    landAfterReplan(seed, remote, "beta");
    for (const unit of ["skeleton", "alpha", "beta"]) expect(cells(seed, unit), unit).toEqual(COMPLETE_ROW);

    expect(currentStage(seed)).toBe("build-and-test");
    expect(nextDirective(seed)).toMatchObject({ kind: "run-stage", stage: "build-and-test" });
  });
});
