// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-unit:status
//
// A team changes its Unit plan in the middle of Construction (merge strategy:
// back to Units Generation, a Unit changed or added, both stages approved
// again) while a Unit is claimed and its candidate is already published. A
// change that had nothing to do with that Unit sent its owner back to rebase
// and publish again. This file checks that a candidate is stale only when the
// revised plan changes the claimed Unit's own entry: the Unit lands as it is
// when the plan adds another Unit or when the plan is unchanged, and when its
// own entry changes, pin refuses and names the rebase, after which the Unit's
// finished stages still count and it pins and lands.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import {
  dagBody,
  makeReplanSeed,
  type PlannedUnit,
  reopenUnitsGeneration,
  replan,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);
afterAll(cleanupWorlds);

// The plan the team starts with: delta waits on beta.
const START: PlannedUnit[] = [
  { name: "skeleton", depends_on: [] },
  { name: "alpha", depends_on: ["skeleton"] },
  { name: "beta", depends_on: ["skeleton"] },
  { name: "delta", depends_on: ["beta"] },
];
// gamma is a new Unit on a branch beta and delta do not touch.
const WITH_GAMMA: PlannedUnit[] = [...START, { name: "gamma", depends_on: ["alpha"] }];
// beta's own entry changes: it now waits on alpha too.
const BETA_WAITS_ON_ALPHA: PlannedUnit[] = START.map((unit) =>
  unit.name === "beta" ? { ...unit, depends_on: ["skeleton", "alpha"] } : unit
);

/** The seed's hand-written Unit Progress table gets delta's row, as the engine's derived table has it. */
function addDeltaRow(main: string): void {
  const path = seededStateFile(main);
  const state = readFileSync(path, "utf-8");
  const header = state.split("\n").find((line) => line.startsWith("| unit |")) ?? "";
  const stageCells = Array(header.split("|").length - 4).fill("[ ]").join(" | ");
  writeFileSync(path, state.replace(/(\| beta \|.*\n)/, `$1| delta | - | ${stageCells} |\n`));
}

/**
 * Main with a done Inception and the START plan, alpha landed and pushed, and
 * beta claimed, worked and published by beta-team; built once, and each case
 * gets its own copy (beta's checkout included).
 */
const world = builtOnce(() => {
  const { seed, remote } = makeReplanSeed(dagBody(START));
  addDeltaRow(seed);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "delta row"]);
  git(seed, ["push", "origin", "main"]);
  prepareCandidate(remote, "alpha", "alpha-team");
  gateAndLand(seed, "alpha");
  git(seed, ["push", "origin", "main"]);
  const beta = prepareCandidate(remote, "beta", "beta-team");
  return { seed, remote, betaCheckout: beta.checkout, betaCandidateOid: beta.candidateOid };
});

/**
 * Rebases a Unit's checkout onto main. A conflict in the state file is resolved
 * as the Unit's person resolves it: main's state, with the Unit's own Unit
 * Progress row as the checkout had it.
 */
function rebaseOntoMain(checkout: string, unit: string): void {
  git(checkout, ["fetch", "origin", "main"]);
  const rebased = spawnSync("git", ["rebase", "origin/main"], { cwd: checkout, encoding: "utf-8" });
  if (rebased.status === 0) return;
  const conflicts = git(checkout, ["diff", "--name-only", "--diff-filter=U"]).split(/\r?\n/).filter(Boolean);
  const state = seededStateFile(checkout).slice(checkout.length + 1).replaceAll("\\", "/");
  expect(conflicts, `${rebased.stdout}${rebased.stderr}`).toEqual([state]);
  const ownRow = git(checkout, ["show", `:3:${state}`]).split(/\r?\n/).find((line) => line.startsWith(`| ${unit} |`));
  expect(ownRow, "the checkout's state has the Unit's row").toBeTruthy();
  git(checkout, ["checkout", "origin/main", "--", state]);
  const mainState = readFileSync(seededStateFile(checkout), "utf-8");
  writeFileSync(
    seededStateFile(checkout),
    mainState.split("\n").map((line) => line.startsWith(`| ${unit} |`) ? ownRow! : line).join("\n"),
  );
  git(checkout, ["add", state]);
  const continued = spawnSync("git", ["rebase", "--continue"], {
    cwd: checkout,
    encoding: "utf-8",
    env: { ...process.env, GIT_EDITOR: "true" },
  });
  expect(continued.status, `${continued.stdout}${continued.stderr}`).toBe(0);
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

/** The board's own list of claimable Units, as the person reads it in main's next step. */
function boardOf(directive: Record<string, unknown>): { claimable: string[]; text: string } {
  const text = String(directive.message ?? "");
  const section = /## Claimable Units\n((?:- .*\n?)+)/.exec(text)?.[1] ?? "";
  const claimable = section.split("\n").map((line) => line.replace(/^- /, "").trim()).filter((name) => name && name !== "none");
  return { claimable, text };
}

/** How many receipts the Unit's checkout holds for it, across its audit shards. */
function receiptCount(checkout: string, unit: string): number {
  const dir = seededAuditDir(checkout);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => readFileSync(join(dir, name), "utf-8").split(/(?=^## )/m))
    .filter((block) => block.includes(`**Unit**: ${unit}\n`)).length;
}

describe("t-team-unit-replan-stale-candidate: a candidate is stale only when the plan changes its own Unit", () => {
  test("a Unit claimed before the plan adds an unrelated Unit pins and lands as it is; gamma stays claimable and delta opens", () => {
    const { seed, remote, betaCandidateOid } = world();
    replan(seed, WITH_GAMMA);
    const gamma = clone(remote, "gamma-team");
    const claimed = runMergeTool(UNIT, ["claim", "gamma", "--team", "gamma-team"], gamma);
    expect(claimed.status, claimed.out).toBe(0);
    git(seed, ["fetch", "origin"]);

    expect(unitStatus(seed)).toMatchObject({
      claimable: [],
      claimed: [{ unit: "beta" }, { unit: "gamma" }],
      waiting: [{ unit: "delta", blockedBy: ["beta"] }],
    });

    // No rebase and no new publish: the candidate is the one published before the plan changed.
    const { pinnedOid } = gateAndLand(seed, "beta");
    git(seed, ["push", "origin", "main"]);
    expect(pinnedOid).toBe(betaCandidateOid);

    const row = unitProgressRow(seed, "beta").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(row[0]).toBe("beta");
    expect(row.slice(2, 8)).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[x]"]);
    expect(unitProgressRow(seed, "gamma")).toContain("| gamma |");
    expect(unitProgressRow(seed, "alpha")).toContain("[x]");

    // Status and main's board agree on who is working and what is open.
    const status = unitStatus(seed);
    expect(status.claimed.map((entry) => entry.unit)).toEqual(["gamma"]);
    expect(status.claimable).toEqual(["delta"]);
    expect(status.waiting).toEqual([]);
    const board = boardOf(nextDirective(seed));
    expect(board.text).toContain("**Claimed:** gamma");
    expect(board.claimable).toEqual(status.claimable);
  });

  test("a claim published before Units Generation reopened lands while the plan is unchanged", () => {
    const { seed } = world();
    expect(reopenUnitsGeneration(seed).status).toBe(0);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "back to Units Generation"]);
    git(seed, ["push", "origin", "main"]);
    gateAndLand(seed, "beta");
    expect(unitProgressRow(seed, "beta")).toContain("beta-team");
  });

  test("a plan that changes the claimed Unit's own entry makes pin refuse it as stale; after the rebase and a new publish it pins and lands with its finished stages counted", () => {
    const { seed, betaCheckout } = world();
    replan(seed, BETA_WAITS_ON_ALPHA);

    const stale = runMergeTool(UNIT, ["pin", "beta"], seed);
    expect(stale.status, stale.out).not.toBe(0);
    expect(stale.out).toContain("stale Construction contract");
    expect(stale.out).toContain("rebase");

    const receiptsBefore = receiptCount(betaCheckout, "beta");
    rebaseOntoMain(betaCheckout, "beta");
    const again = runMergeTool(UNIT, ["publish", "beta"], betaCheckout);
    expect(again.status, again.out).toBe(0);
    // Its stages were not run again: the receipts are the ones it had.
    expect(receiptCount(betaCheckout, "beta")).toBe(receiptsBefore);

    gateAndLand(seed, "beta");
    git(seed, ["push", "origin", "main"]);
    const row = unitProgressRow(seed, "beta").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(row[0]).toBe("beta");
    expect(row.slice(2, 8)).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[x]"]);
    // delta waited on beta and opens now.
    expect(unitStatus(seed).claimable).toContain("delta");
  });
});
