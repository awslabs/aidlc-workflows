// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:release, subcommand:aidlc-unit:status, subcommand:aidlc-log:review, subcommand:aidlc-orchestrate:next
//
// A revised Unit plan could drop, rename or split a Unit that had already landed
// or was claimed, name a Unit that git cannot hold as a claim, or add a root Unit
// that took over the walking skeleton, and the plan was approved all the same:
// the Unit's claim or landed work then belonged to a name nobody could reach.
// This file checks the shapes of a plan change in the middle of Construction on
// a team intent (back to Units Generation on main, a revised Unit DAG, Units
// Generation and Delivery Planning approved again). Units Generation's review
// request reads the revised plan against what the team already did: a landed
// or claimed Unit keeps its name, every name can be a claim ref, and with the
// walking skeleton on, the skeleton stays the Unit built first. Each refusal
// names the Unit and the step that fixes the plan; after the step, the plan
// goes through. Dropping a landed or claimed Unit is the person's call: their
// own request (--person-asked with the message they asked in) lets the plan
// through, and the review request records that they asked. A plan that keeps
// every Unit asks nothing of the claim registry. Also checked: duplicate
// names, two checkouts changing the plan at once, and the stage-artifact guard
// on.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { auditBlockField, readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approveMerge,
  builtOnce,
  cleanupTempDirs,
  cleanupWorlds,
  clone,
  git,
  ORCH,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import {
  approveDeliveryPlanning,
  approveUnitsGeneration,
  currentStage,
  LOG,
  makeReplanSeed,
  type PlannedUnit,
  reopenUnitsGeneration,
  replan,
  reviewReady,
  stageLine,
  writeUnitPlan,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);
afterAll(cleanupWorlds);

const U = (name: string, ...dependsOn: string[]): PlannedUnit => ({ name, depends_on: dependsOn });
const BASE = [U("skeleton"), U("alpha", "skeleton"), U("beta", "skeleton")];

type Seed = { seed: string; remote: string };

// Each world below is built once, and each case gets its own copy.
const seedWithParallelUnits = builtOnce((): Seed => makeReplanSeed(parallelDependencyBody()));

/** What main's own steps wrote is committed and pushed, as the person commits it. */
function settle(main: string): void {
  git(main, ["add", "-A"]);
  git(main, ["commit", "--allow-empty", "-m", "main bookkeeping"]);
  git(main, ["push", "origin", "main"]);
}

/** A team claims a Unit and has done nothing yet; returns the claiming checkout. */
function claimOnly(remote: string, unit: string, label: string): string {
  const checkout = clone(remote, label);
  const claim = runMergeTool(UNIT, ["claim", unit, "--team", label], checkout);
  expect(claim.status, claim.out).toBe(0);
  return checkout;
}

/** Pin, gate and land on main, committing what the tools write between the steps. */
function landOnMain(main: string, unit: string): { status: number; out: string } {
  settle(main);
  try {
    approveMerge(main, unit);
  } catch (error) {
    return { status: 1, out: String(error) };
  }
  git(main, ["add", "-A"]);
  git(main, ["commit", "--allow-empty", "-m", "engine bookkeeping"]);
  let landed = runMergeTool(UNIT, ["land", unit], main);
  // The tools rewrite tracked engine files between the landing's steps; the
  // landing resumes where it stopped once those are committed.
  if (landed.status !== 0 && landed.out.includes("clean source worktree")) {
    git(main, ["add", "-A"]);
    git(main, ["commit", "--allow-empty", "-m", "engine bookkeeping"]);
    landed = runMergeTool(UNIT, ["land", unit], main);
  }
  return landed;
}

/** Units Generation's review request, as the tool answers it (no expectation on the answer). */
function askReview(main: string): { status: number; stdout: string; out: string } {
  return runMergeTool(
    LOG,
    ["review", "--stage", "units-generation", "--reviewer", "aidlc-architecture-reviewer-agent", "--iteration", "1"],
    main,
  );
}

/** The person types `words` in main's chat (the prompt hook keeps them); the kept message's id. */
function personTyped(main: string, words: string): string {
  const typed = spawnSync(process.execPath, [join(dirname(LOG), "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: main,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: main, AIDLC_UNATTENDED: "" },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "plan-edits-person", prompt: words }),
  });
  expect(typed.status, `${typed.stdout}${typed.stderr}`).toBe(0);
  const id = auditBlockField(auditBlocks(main, "HUMAN_TURN").at(-1) ?? "", "Message Id");
  expect(id, "the prompt hook kept the message").toBeTruthy();
  return id!;
}

function auditBlocks(main: string, event: string): string[] {
  return readAllAuditShards(main).replace(/\r\n/g, "\n").split(/\n---\n/)
    .filter((block) => auditBlockField(block, "Event") === event);
}

/** Units Generation's review request the person asked for in `message`. */
function askReviewAsked(main: string, message: string): { status: number; stdout: string; out: string } {
  return runMergeTool(
    LOG,
    [
      "review", "--stage", "units-generation", "--reviewer", "aidlc-architecture-reviewer-agent", "--iteration", "1",
      "--person-asked", "--message", message,
    ],
    main,
  );
}

/** The request went through (no plan to fix) and its row says the person asked for it. */
function requestedAsPersonAsked(main: string, review: { status: number; stdout: string; out: string }): void {
  expect(review.status, review.out).toBe(0);
  expect((JSON.parse(review.stdout) as { kind: string }).kind, review.out).not.toBe("print");
  const request = auditBlocks(main, "REVIEW_REQUESTED")
    .filter((block) => auditBlockField(block, "Stage") === "units-generation").at(-1) ?? "";
  expect(auditBlockField(request, "Person Asked"), request).toBe("true");
}

/** What the review request tells the person to fix, or null when it lets the plan through. */
function planRefusal(main: string): string | null {
  const review = askReview(main);
  expect(review.status, review.out).toBe(0);
  const answer = JSON.parse(review.stdout) as { kind: string; message?: string };
  return answer.kind === "print" ? (answer.message ?? "") : null;
}

/** Back to Units Generation with `units` written; the review request has not been made yet. */
function reopenWithPlan(main: string, units: PlannedUnit[]): void {
  const reopened = reopenUnitsGeneration(main);
  expect(reopened.status, reopened.out).toBe(0);
  writeUnitPlan(main, units);
}

/**
 * The plan already written is reviewed, approved with Delivery Planning, committed and pushed.
 * A review request that still refuses the plan fails here; a request that lets it through is
 * recorded, so a case asks it once, here, and not beforehand.
 */
function approveWrittenPlan(main: string): void {
  approveUnitsGeneration(main);
  approveDeliveryPlanning(main);
  settle(main);
}

function statusOf(checkout: string): {
  claimable: string[];
  claimed: Array<{ unit: string; owner: string; generation: number }>;
  out: string;
} {
  const status = runMergeTool(UNIT, ["status"], checkout);
  expect(status.status, status.out).toBe(0);
  return { ...JSON.parse(status.stdout), out: status.out };
}

function boardOf(main: string): string {
  const board = runMergeTool(ORCH, ["team-board", "--snapshot"], main);
  expect(board.status, board.out).toBe(0);
  return board.stdout;
}

/** alpha landed on main before any plan change. */
const alphaLanded = builtOnce((): Seed => {
  const made = seedWithParallelUnits();
  prepareCandidate(made.remote, "alpha", "alpha-team");
  settle(made.seed);
  const landed = landOnMain(made.seed, "alpha");
  expect(landed.status, landed.out).toBe(0);
  settle(made.seed);
  return made;
});

describe("t-team-unit-replan-plan-edits: shapes of a plan change", () => {
  describe("a Unit that nobody claimed is removed", () => {
    test("it leaves status and the board, and claiming it is refused", () => {
      const { seed, remote } = seedWithParallelUnits();
      replan(seed, [U("skeleton"), U("alpha", "skeleton")]);
      expect(statusOf(seed).claimable).toEqual(["alpha"]);
      expect(boardOf(seed)).not.toContain("beta");
      const claim = runMergeTool(UNIT, ["claim", "beta", "--team", "late"], clone(remote, "late"));
      expect(claim.status, claim.out).not.toBe(0);
      expect(claim.out).toContain("not in the authoritative Unit DAG");
    });

    test("a Unit that others still depend on cannot be removed: the review request names the dangling dependency", () => {
      const { seed } = makeReplanSeed(
        "# Unit dependencies\n\n```yaml\nunits:\n  - name: skeleton\n    depends_on: []\n  - name: alpha\n    depends_on: [skeleton]\n  - name: beta\n    depends_on: [alpha]\n```\n",
      );
      reopenWithPlan(seed, [U("skeleton"), U("beta", "alpha", "skeleton")]);
      const review = askReview(seed);
      expect(JSON.parse(review.stdout).message).toContain('depends on unknown unit "alpha"');
      expect(review.out).toContain("unit-of-work-dependency.md");
    });
  });

  describe("a claimed Unit is removed, renamed or split", () => {
    // beta is claimed by beta-team with nothing done yet; main is the person's checkout.
    const claimedBeta = builtOnce((): Seed => {
      const made = seedWithParallelUnits();
      claimOnly(made.remote, "beta", "beta-team");
      return made;
    });
    const names = (seed: string, units: PlannedUnit[]): string => {
      reopenWithPlan(seed, units);
      return planRefusal(seed) ?? "";
    };
    const keepsClaimed = (message: string): void => {
      expect(message).toContain('Unit "beta" is claimed by beta-team (attempt 1)');
      expect(message).toContain("which ends beta-team's claim on it");
      expect(message).toContain(" unit release beta`");
      expect(message).not.toContain("`aidlc unit release beta`");
      expect(message).toContain("Then run");
      expect(message).toContain("If the person asked for this plan themselves, run it with --person-asked --message <id>");
    };

    test("removing it is refused at the review request naming the claim, its owner and the release; after the release the plan goes through", () => {
      const { seed, remote } = claimedBeta();
      keepsClaimed(names(seed, [U("skeleton"), U("alpha", "skeleton")]));
      const released = runMergeTool(UNIT, ["release", "beta"], seed);
      expect(released.status, released.out).toBe(0);
      expect(JSON.parse(released.stdout)).toMatchObject({ released: true, unit: "beta" });
      approveWrittenPlan(seed);
      expect(statusOf(seed).claimable).toEqual(["alpha"]);
      expect(statusOf(seed).claimed).toEqual([]);
      const claim = runMergeTool(UNIT, ["claim", "beta", "--team", "late"], clone(remote, "late"));
      expect(claim.status, claim.out).not.toBe(0);
      expect(claim.out).toContain("not in the authoritative Unit DAG");
    });

    test("renaming it is refused at the review request naming the claim; the claim stays open in status", () => {
      const { seed } = claimedBeta();
      keepsClaimed(names(seed, [U("skeleton"), U("alpha", "skeleton"), U("delta", "skeleton")]));
      expect(statusOf(seed).claimed.map((entry) => `${entry.unit}:${entry.owner}`)).toEqual(["beta:beta-team"]);
    });

    test("splitting it is refused at the review request naming the claim", () => {
      const { seed } = claimedBeta();
      keepsClaimed(
        names(seed, [U("skeleton"), U("alpha", "skeleton"), U("beta-api", "skeleton"), U("beta-ui", "skeleton")]),
      );
    });

    test("the person's own request to remove it lets the plan through, and the request records that they asked", () => {
      const { seed } = claimedBeta();
      reopenWithPlan(seed, [U("skeleton"), U("alpha", "skeleton")]);
      keepsClaimed(planRefusal(seed) ?? "");
      const message = personTyped(seed, "Take beta out of the plan, the beta team will release it");
      requestedAsPersonAsked(seed, askReviewAsked(seed, message));
    });

    test("keeping it under its name while the plan changes around it goes through", () => {
      const { seed } = claimedBeta();
      reopenWithPlan(seed, [...BASE, U("gamma", "alpha")]);
      approveWrittenPlan(seed);
      expect(statusOf(seed).claimed.map((entry) => entry.unit)).toEqual(["beta"]);
    });
  });

  describe("a landed Unit is dropped or renamed", () => {
    const keepsLanded = (message: string): void => {
      expect(message).toContain('Unit "alpha" has landed on main');
      expect(message).toContain("keep \"alpha\" in the units block under that name");
      expect(message).toContain("If the person asked for this plan themselves, run it with --person-asked --message <id>");
    };

    test("dropping it is refused at the review request naming the Unit; keeping it goes through and its row stays landed", () => {
      const { seed } = alphaLanded();
      reopenWithPlan(seed, [U("skeleton"), U("beta", "skeleton")]);
      keepsLanded(planRefusal(seed) ?? "");
      writeUnitPlan(seed, [...BASE, U("gamma", "alpha")]);
      approveWrittenPlan(seed);
      expect(unitProgressRow(seed, "alpha")).toContain("[x]");
      expect(statusOf(seed).claimable).toContain("gamma");
    });

    test("the person's own request to drop it lets the plan through, and the request records that they asked", () => {
      const { seed } = alphaLanded();
      reopenWithPlan(seed, [U("skeleton"), U("beta", "skeleton")]);
      keepsLanded(planRefusal(seed) ?? "");
      const message = personTyped(seed, "Drop alpha from the plan, we no longer need it");
      requestedAsPersonAsked(seed, askReviewAsked(seed, message));
    });

    test("renaming it is refused at the review request, so the new name is never handed out as fresh work", () => {
      const { seed, remote } = alphaLanded();
      reopenWithPlan(seed, [U("skeleton"), U("alpha2", "skeleton"), U("beta", "skeleton")]);
      keepsLanded(planRefusal(seed) ?? "");
      const claim = runMergeTool(UNIT, ["claim", "alpha2", "--team", "again"], clone(remote, "again"));
      expect(claim.status, claim.out).not.toBe(0);
    });
  });

  describe("a plan that keeps every Unit", () => {
    test("asks nothing of the claim registry: with two remotes and no origin, the review request goes through", () => {
      const { seed } = seedWithParallelUnits();
      reopenWithPlan(seed, [...BASE, U("gamma", "alpha")]);
      const url = git(seed, ["remote", "get-url", "origin"]).trim();
      git(seed, ["remote", "rename", "origin", "upstream"]);
      git(seed, ["remote", "add", "mirror", url]);
      expect(planRefusal(seed)).toBeNull();
    });
  });

  describe("an unclaimed Unit is renamed", () => {
    test("the new name is claimable and the old one is gone", () => {
      const { seed, remote } = seedWithParallelUnits();
      replan(seed, [U("skeleton"), U("alpha", "skeleton"), U("delta", "skeleton")]);
      expect(statusOf(seed).claimable).toEqual(["alpha", "delta"]);
      const old = runMergeTool(UNIT, ["claim", "beta", "--team", "late"], clone(remote, "late"));
      expect(old.status, old.out).not.toBe(0);
    });
  });

  describe("names", () => {
    test("a duplicate Unit name, or two names that differ only in case, is refused at the review request", () => {
      const { seed } = seedWithParallelUnits();
      reopenWithPlan(seed, [U("skeleton"), U("alpha", "skeleton"), U("alpha", "skeleton")]);
      expect(askReview(seed).out).toContain("duplicate unit name: alpha");
      writeUnitPlan(seed, [U("skeleton"), U("alpha", "skeleton"), U("Alpha", "skeleton")]);
      expect(askReview(seed).out).toContain("case-folding unit name collision");
    });

    test("a Unit name git cannot hold as a claim ref (x.lock) is refused at the review request; a name it can hold goes through", () => {
      const { seed, remote } = seedWithParallelUnits();
      reopenWithPlan(seed, [...BASE, U("x.lock", "skeleton")]);
      const message = planRefusal(seed) ?? "";
      expect(message).toContain('Unit "x.lock" is not claim-ref safe');
      expect(message).toContain("Rename it in the units block");
      expect(message).not.toContain("--person-asked");
      writeUnitPlan(seed, [...BASE, U("x-lock", "skeleton")]);
      approveWrittenPlan(seed);
      const claim = runMergeTool(UNIT, ["claim", "x-lock", "--team", "lock-team"], clone(remote, "lock"));
      expect(claim.status, claim.out).toBe(0);
    });
  });

  describe("with the walking skeleton on", () => {
    // Units wait on the first Unit of the DAG's first batch, which the skeleton is.
    test("a new root Unit that sorts before the built skeleton is refused; with the skeleton in its depends_on the plan goes through", () => {
      const { seed, remote } = makeReplanSeed(parallelDependencyBody(), "on");
      reopenWithPlan(seed, [...BASE, U("api")]);
      const message = planRefusal(seed) ?? "";
      expect(message).toContain('Unit "api" depends on nothing and its name sorts before "skeleton"');
      expect(message).toContain('Add "skeleton" to "api"\'s depends_on');
      writeUnitPlan(seed, [...BASE, U("api", "skeleton")]);
      approveWrittenPlan(seed);
      expect([...statusOf(seed).claimable].sort()).toEqual(["alpha", "api", "beta"]);
      const claim = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team"], clone(remote, "alpha-team"));
      expect(claim.status, claim.out).toBe(0);
    });
  });

  describe("two checkouts change the plan at once", () => {
    // The team seed tracks .aidlc-engine/, which the shipped .gitignore ignores: stop tracking
    // the per-checkout token so a rebase conflict in it (a fixture artifact) cannot appear.
    function seedWithoutTrackedToken(): Seed {
      const made = seedWithParallelUnits();
      const tokens = git(made.seed, ["ls-files"]).split("\n").filter((path) => path.endsWith("/steering-token-key"));
      for (const path of tokens) git(made.seed, ["rm", "--cached", "-q", path]);
      const ignore = join(made.seed, ".gitignore");
      writeFileSync(ignore, `${readFileSync(ignore, "utf-8")}**/.aidlc-engine/steering-token-key\n`);
      git(made.seed, ["add", "-A"]);
      git(made.seed, ["commit", "-m", "do not track the steering token"]);
      git(made.seed, ["push", "origin", "main"]);
      return made;
    }

    // main moved on from the base both started from: gamma (after alpha) was approved and pushed.
    const secondPlanBehindFirst = builtOnce((): { seed: string; remote: string; second: string; pushError: string; rebase: string; unmerged: string[] } => {
      const { seed, remote } = seedWithoutTrackedToken();
      const second = clone(remote, "second");
      replan(seed, [...BASE, U("gamma", "alpha")]);
      reopenWithPlan(second, [...BASE, U("delta", "beta")]);
      approveUnitsGeneration(second);
      approveDeliveryPlanning(second);
      git(second, ["add", "-A"]);
      git(second, ["commit", "-m", "second plan change"]);
      let pushError = "";
      try {
        git(second, ["push", "origin", "main"]);
      } catch (error) {
        pushError = String(error);
      }
      let rebase = "";
      try {
        git(second, ["pull", "--rebase", "origin", "main"]);
      } catch (error) {
        rebase = String(error);
      }
      const unmerged = git(second, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
      return { seed, remote, second, pushError, rebase, unmerged };
    });

    test("the second checkout's push is rejected and its rebase stops on the plan documents and the state file", () => {
      const run = secondPlanBehindFirst();
      expect(run.pushError).toContain("rejected");
      expect(run.rebase).toContain("could not apply");
      expect(run.unmerged.some((path) => path.endsWith("unit-of-work-dependency.md"))).toBe(true);
      expect(run.unmerged.some((path) => path.endsWith("aidlc-state.md"))).toBe(true);
    });

    test("the rebase conflicts only in the plan documents, not in the engine's own bookkeeping files", () => {
      const run = secondPlanBehindFirst();
      const engineOwned = run.unmerged.filter((path) => path.includes("/.aidlc-engine/"));
      expect(engineOwned, `a person resolves files only the engine reads: ${engineOwned.join(", ")}`).toEqual([]);
    });

    test("giving up the second change and redoing it on the pulled main goes through", () => {
      const run = secondPlanBehindFirst();
      git(run.second, ["rebase", "--abort"]);
      git(run.second, ["reset", "--hard", "origin/main"]);
      replan(run.second, [...BASE, U("gamma", "alpha"), U("delta", "beta")]);
      expect(currentStage(run.second)).toBe("functional-design");
      expect(stageLine(run.second, "units-generation")).toContain("[x]");
      expect(statusOf(run.second).claimable).toEqual(["alpha", "beta"]);
    });
  });

  describe("the stage guards", () => {
    test("with the stage-artifact guard on, the jump, Units Generation's approval and Delivery Planning's approval all go through", () => {
      const { seed } = seedWithParallelUnits();
      const guard = { AIDLC_SKIP_ARTIFACT_GUARD: "0" };
      const reopened = runMergeTool(ORCH, ["next", "--stage", "units-generation"], seed, false, guard);
      expect(reopened.status, reopened.out).toBe(0);
      expect(JSON.parse(reopened.stdout)).toMatchObject({ kind: "load-steering", stage: "units-generation" });
      writeUnitPlan(seed, [...BASE, U("gamma", "alpha")]);
      reviewReady(seed, "units-generation");
      const awaiting = runMergeTool(ORCH, ["report", "--stage", "units-generation", "--result", "awaiting-approval"], seed, false, guard);
      expect(awaiting.status, awaiting.out).toBe(0);
      const approved = runMergeTool(
        ORCH,
        ["report", "--stage", "units-generation", "--result", "approved", "--user-input", "Approve"],
        seed,
        false,
        guard,
      );
      expect(approved.status, approved.out).toBe(0);
      expect(JSON.parse(approved.stdout)).toMatchObject({ kind: "done" });
      // Delivery Planning without its documents is refused, and the refusal names the way on.
      const missing = runMergeTool(ORCH, ["report", "--stage", "delivery-planning", "--result", "approved", "--user-input", "Approve"], seed, false, guard);
      expect(missing.out).toContain("REQUIRED_ARTIFACTS_MISSING");
      expect(missing.out).toContain("produce-stage-output");
      approveDeliveryPlanning(seed);
      expect(currentStage(seed)).toBe("functional-design");
    });
  });
});
