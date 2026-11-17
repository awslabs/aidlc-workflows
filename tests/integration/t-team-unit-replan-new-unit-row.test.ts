// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-unit:claim, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land
//
// A team changes its Unit plan in the middle of Construction and the revised
// plan adds a Unit. A Unit landing next was refused ("Cannot preserve
// non-target Unit Progress row gamma") when main's Unit Progress table had no
// row for the new Unit. This file checks that approving Units Generation
// gives each new Unit its row on main at once, that a Unit claimed from the
// revised plan lands while the new Unit has not landed, and that the two
// halves of a split Unit land one after the other.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupTempDirs,
  gateAndLand,
  git,
  parallelDependencyBody,
  prepareCandidate,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import {
  approveUnitsGeneration,
  makeReplanSeed,
  type PlannedUnit,
  PLAN_WITH_GAMMA,
  reopenUnitsGeneration,
  replan,
  writeUnitPlan,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const U = (name: string, ...dependsOn: string[]): PlannedUnit => ({ name, depends_on: dependsOn });

/** A Unit Progress row as its cells after the Unit and owner columns. */
function cells(checkout: string, unit: string): string[] {
  return unitProgressRow(checkout, unit).split("|").slice(1, -1).map((cell) => cell.trim()).slice(2);
}

describe("t-team-unit-replan-new-unit-row: a Unit the revised plan adds has its row on main", () => {
  test("approving Units Generation gives the added Unit a not-started row before anything lands", () => {
    const { seed } = makeReplanSeed(parallelDependencyBody());
    expect(unitProgressRow(seed, "gamma")).toBe("");
    expect(reopenUnitsGeneration(seed).status).toBe(0);
    writeUnitPlan(seed, PLAN_WITH_GAMMA);
    approveUnitsGeneration(seed);

    const row = cells(seed, "gamma");
    expect(row.length, unitProgressRow(seed, "gamma")).toBeGreaterThan(0);
    expect(row.every((cell) => cell === "[ ]"), unitProgressRow(seed, "gamma")).toBe(true);
    expect(unitProgressRow(seed, "alpha"), "the Units already on the table stay").toContain("| alpha |");
  });

  test("a Unit claimed after the plan added gamma lands while gamma has not landed", () => {
    const { seed, remote } = makeReplanSeed(parallelDependencyBody());
    replan(seed, PLAN_WITH_GAMMA);
    prepareCandidate(remote, "beta", "beta-team");

    gateAndLand(seed, "beta");
    expect(cells(seed, "beta").every((cell) => cell === "[x]"), unitProgressRow(seed, "beta")).toBe(true);
    expect(unitProgressRow(seed, "beta")).toContain("beta-team");
    expect(cells(seed, "gamma"), "gamma is still to do").not.toContain("[x]");
  });

  test("a Unit split in two lands both halves, one after the other", () => {
    const { seed, remote } = makeReplanSeed(parallelDependencyBody());
    replan(seed, [U("skeleton"), U("alpha", "skeleton"), U("beta-api", "skeleton"), U("beta-ui", "skeleton")]);

    for (const [unit, label] of [["beta-api", "api-team"], ["beta-ui", "ui-team"]] as const) {
      git(seed, ["pull", "--ff-only"]);
      prepareCandidate(remote, unit, label);
      git(seed, ["pull", "--ff-only"]);
      gateAndLand(seed, unit);
      git(seed, ["push", "origin", "main"]);
      expect(cells(seed, unit).every((cell) => cell === "[x]"), unitProgressRow(seed, unit)).toBe(true);
    }
    expect(unitProgressRow(seed, "beta-api")).toContain("api-team");
    expect(unitProgressRow(seed, "beta-ui")).toContain("ui-team");
  });
});
