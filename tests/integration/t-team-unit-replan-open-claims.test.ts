// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-unit:status
//
// Going back to Units Generation to change the Unit plan, while some Units are
// claimed and mid-work, left main without its own next step: `next` showed the
// board of claimable Units instead of Units Generation, so the plan could not
// be revised until every claim landed, and the jump did not say which claims
// were open.
//
// This file checks that the jump is allowed and names the open claims in its
// step; that main's next steps are Units Generation, then Delivery Planning,
// and the board is back once the revised plan is approved; that Units that
// landed stay landed and done on the board; and that a claim opened before
// the jump lands while Units Generation is still open. Claiming while the plan
// is changed is in t-team-unit-replan-claim-waits.test.ts.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  gateAndLand,
  git,
  nextDirective,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import {
  approveDeliveryPlanning,
  approveUnitsGeneration,
  currentStage,
  dagBody,
  makeReplanSeed,
  type PlannedUnit,
  reopenUnitsGeneration,
  replan,
  stageLine,
  writeUnitPlan,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

// The plan the team starts with: delta waits on beta. gamma is added later,
// after alpha, on a branch beta and delta do not touch.
const START: PlannedUnit[] = [
  { name: "skeleton", depends_on: [] },
  { name: "alpha", depends_on: ["skeleton"] },
  { name: "beta", depends_on: ["skeleton"] },
  { name: "delta", depends_on: ["beta"] },
];
const WITH_GAMMA: PlannedUnit[] = [...START, { name: "gamma", depends_on: ["alpha"] }];

/** The seed's hand-written Unit Progress table gets a row for a Unit, as the engine's derived table has. */
function addUnitRow(main: string, unit: string, after: string): void {
  const path = seededStateFile(main);
  const state = readFileSync(path, "utf-8");
  const header = state.split("\n").find((line) => line.startsWith("| unit |")) ?? "";
  const stageCells = Array(header.split("|").length - 4).fill("[ ]").join(" | ");
  writeFileSync(
    path,
    state.replace(new RegExp(`(\\| ${after} \\|.*\\n)`), `$1| ${unit} | - | ${stageCells} |\n`),
  );
}

/**
 * Main with a done Inception and the START plan, alpha landed and pushed.
 */
function world(): { seed: string; remote: string } {
  const { seed, remote } = makeReplanSeed(dagBody(START));
  addUnitRow(seed, "delta", "beta");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "delta row"]);
  git(seed, ["push", "origin", "main"]);
  prepareCandidate(remote, "alpha", "alpha-team");
  gateAndLand(seed, "alpha");
  git(seed, ["push", "origin", "main"]);
  return { seed, remote };
}

function rebaseOntoMain(checkout: string): { status: number; out: string } {
  git(checkout, ["fetch", "origin"]);
  const rebased = spawnSync("git", ["rebase", "origin/main"], { cwd: checkout, encoding: "utf-8" });
  return { status: rebased.status ?? -1, out: `${rebased.stdout}${rebased.stderr}` };
}

function unitStatus(checkout: string): {
  claimable: string[];
  claimed: Array<{ unit: string; owner: string }>;
  waiting: Array<{ unit: string; blockedBy: string[] }>;
} {
  const status = runMergeTool(UNIT, ["status"], checkout);
  expect(status.status, status.out).toBe(0);
  return JSON.parse(status.stdout);
}

/** The board's own lists, as the person reads them in main's next step. */
function boardOf(directive: Record<string, unknown>): { claimable: string[]; text: string } {
  const text = String(directive.message ?? "");
  const section = /## Claimable Units\n((?:- .*\n?)+)/.exec(text)?.[1] ?? "";
  const claimable = section.split("\n").map((line) => line.replace(/^- /, "").trim()).filter((name) => name && name !== "none");
  return { claimable, text };
}

function boardCells(board: string, unit: string): string[] {
  const row = board.split("\n").find((line) => line.startsWith(`| ${unit} `)) ?? "";
  return row.split("|").slice(1, -1).map((cell) => cell.trim()).slice(2, -1);
}

/** A person pulls: main learns which claims exist. */
function pull(main: string): void {
  git(main, ["fetch", "origin"]);
}

describe("t-team-unit-replan-open-claims: a plan change while Units are claimed and mid-work", () => {
  test("the jump to Units Generation is allowed with a claim open; landed work and the claim stay", () => {
    const { seed, remote } = world();
    prepareCandidate(remote, "beta", "beta-team", { publish: false });
    pull(seed);
    const jump = reopenUnitsGeneration(seed);
    expect(jump.status, jump.out).toBe(0);
    expect(currentStage(seed)).toBe("units-generation");
    expect(stageLine(seed, "units-generation")).toContain("[-]");
    expect(unitProgressRow(seed, "alpha")).toContain("alpha-team");
    const status = unitStatus(seed);
    expect(status.claimed.map((claim) => claim.unit)).toEqual(["beta"]);
    expect(status.claimable).not.toContain("alpha");
  });

  test("the jump's step names the claimed Unit and its owner, and says the claim carries on", () => {
    const { seed, remote } = world();
    prepareCandidate(remote, "beta", "beta-team", { publish: false });
    pull(seed);
    const jump = reopenUnitsGeneration(seed);
    expect(jump.status, jump.out).toBe(0);
    const notices = (JSON.parse(jump.stdout).change_notices ?? []) as string[];
    const line = notices.find((notice) => notice.startsWith("Still claimed:"));
    expect(line, jump.out).toContain("Still claimed: beta (beta-team).");
    expect(line, jump.out).toContain("carries on and lands as it is");
    expect(line, jump.out).toContain("No new Unit is claimed until the revised plan is approved.");
  });

  test("the jump with nothing claimed carries no Still claimed line", () => {
    const { seed } = world();
    const jump = reopenUnitsGeneration(seed);
    expect(jump.status, jump.out).toBe(0);
    expect(jump.out).not.toContain("Still claimed");
  });

  for (const published of [false, true]) {
    const claim = published ? "published" : "unpublished";

    test(`with a ${claim} claim open, main's next steps are Units Generation, then Delivery Planning, then the board is back`, () => {
      const { seed, remote } = world();
      prepareCandidate(remote, "beta", "beta-team", { publish: published });
      pull(seed);
      expect(reopenUnitsGeneration(seed).status).toBe(0);

      // Main is in Inception: its own step runs, with no board of Units.
      const first = nextDirective(seed);
      expect(first.stage, String(first.message ?? first.kind)).toBe("units-generation");
      expect(String(first.message ?? "")).not.toContain("## Claimable Units");

      writeUnitPlan(seed, WITH_GAMMA);
      approveUnitsGeneration(seed);
      const second = nextDirective(seed);
      expect(second.stage, String(second.message ?? second.kind)).toBe("delivery-planning");

      // From the per-Unit block on, the board is main's step again, with the claim on it.
      approveDeliveryPlanning(seed);
      const board = boardOf(nextDirective(seed));
      expect(board.text).toContain("**Claimed:** beta");
      expect(board.text).toContain("## Claimable Units");
    });
  }

  test("after the revised plan is approved and pushed, unit status and the board name the same claimable Units", () => {
    const { seed, remote } = world();
    prepareCandidate(remote, "beta", "beta-team", { publish: false });
    pull(seed);
    replan(seed, WITH_GAMMA);
    // `unit status` reads the pushed integration ref and the board reads
    // main's local files, so they agree once the plan is pushed.
    const status = unitStatus(seed);
    const board = boardOf(nextDirective(seed));
    expect(status.claimable).toEqual(["gamma"]);
    expect(board.claimable, board.text).toEqual(status.claimable);
    expect(board.text).toContain("**Claimed:** beta");
  });

  test("Units that landed before the jump stay landed: not claimable, not claimed, and their dependents open", () => {
    const { seed, remote } = world();
    prepareCandidate(remote, "beta", "beta-team", { publish: false });
    replan(seed, WITH_GAMMA);
    const status = unitStatus(seed);
    expect(status.claimed.map((claim) => claim.unit)).toEqual(["beta"]);
    expect(status.claimable).toEqual(["gamma"]);
    expect(unitProgressRow(seed, "alpha")).toContain("alpha-team");
  });

  test("the board shows a landed Unit's finished stages as done after the jump", () => {
    const { seed, remote } = world();
    prepareCandidate(remote, "beta", "beta-team", { publish: false });
    pull(seed);
    const before = boardOf(nextDirective(seed));
    expect(boardCells(before.text, "alpha"), before.text).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[x]"]);
    replan(seed, WITH_GAMMA);
    const after = boardOf(nextDirective(seed));
    expect(boardCells(after.text, "alpha"), after.text).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[x]"]);
  });

  test("a claim opened before the jump lands while Units Generation is still open; main stays in Inception", () => {
    const { seed, remote } = world();
    const beta = prepareCandidate(remote, "beta", "beta-team");
    expect(reopenUnitsGeneration(seed).status).toBe(0);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "back to Units Generation"]);
    git(seed, ["push", "origin", "main"]);
    // The Unit's person takes in main's new commit and publishes again; the
    // stages they finished before the jump are not run again.
    const rebased = rebaseOntoMain(beta.checkout);
    expect(rebased.status, rebased.out).toBe(0);
    const published = runMergeTool(UNIT, ["publish", "beta"], beta.checkout);
    expect(published.status, published.out).toBe(0);
    gateAndLand(seed, "beta");

    const state = readFileSync(seededStateFile(seed), "utf-8");
    expect(currentStage(seed)).toBe("units-generation");
    expect(state).toContain("- **Lifecycle Phase**: INCEPTION");
    expect(stageLine(seed, "units-generation")).toContain("[-]");
    expect(stageLine(seed, "delivery-planning")).toContain("[ ]");
    expect(unitProgressRow(seed, "beta")).toContain("beta-team");
    expect(unitProgressRow(seed, "alpha")).toContain("alpha-team");
    // The Construction stage boxes summarise the Units' work, so a landing
    // folds them to [-] even while Inception is being redone.
    expect(stageLine(seed, "functional-design")).toContain("[-]");
    expect(stageLine(seed, "code-generation")).toContain("[-]");
    const step = nextDirective(seed);
    expect(step.stage, String(step.message ?? step.kind)).toBe("units-generation");
  });
});
