// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-unit:status, subcommand:aidlc-unit:claim, file:tools/aidlc-jump.ts
//
// On a team main, going back before the per-Unit block keeps every Unit's
// landed work (`Unit Work: kept` on the jump). A redo of a stage there is the
// same move: the person, back at Units Generation, asks to do it over. Every
// step here is the engine's own command, in the order a real project took
// them: back to Requirements Analysis, Inception approved forward again, Units
// Generation redone, Units Generation and Delivery Planning approved, and main
// coming into Functional Design. A redo that did not keep the Units' work
// started every per-Unit stage anew, so a landed Unit's row read empty but for
// its merged cell, the Units that wait on it were never claimable and the
// landed skeleton was offered again.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT, seededAuditDir, seededRecordDir } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
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
  approveDeliveryPlanning,
  approveUnitsGeneration,
  currentStage,
  dagBody,
  makeReplanSeed,
  type PlannedUnit,
  reviewReady,
  writeUnitPlan,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const INCEPTION_STAGES = join(REPO_ROOT, "core", "aidlc-common", "stages", "inception");
// beta waits on alpha; both wait on the skeleton, which lands with the seed.
const PLAN: PlannedUnit[] = [
  { name: "skeleton", depends_on: [] },
  { name: "alpha", depends_on: ["skeleton"] },
  { name: "beta", depends_on: ["alpha"] },
];
const ALPHA_COMPLETE = "| alpha | alpha-team | [x] | [x] | [x] | [x] | [x] | [x] | [x] |";

function stageJumps(main: string): string[] {
  const dir = seededAuditDir(main);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => readFileSync(join(dir, name), "utf-8").replace(/\r\n/g, "\n").split("\n---\n"))
    .filter((block) => block.includes("**Event**: STAGE_JUMPED"));
}

function status(checkout: string): {
  claimable: string[];
  claimed: Array<{ unit: string }>;
  waiting: Array<{ unit: string; blockedBy: string[] }>;
} {
  const result = runMergeTool(UNIT, ["status"], checkout);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout);
}

/** The stage main is on, written, reviewed when it has a reviewer, and approved. */
function approveCurrentInceptionStage(main: string): void {
  const stage = currentStage(main);
  const front = readFileSync(join(INCEPTION_STAGES, `${stage}.md`), "utf-8").split("\n---")[0];
  const reviewer = /^reviewer: (\S+)/m.exec(front)?.[1];
  const produces = (/^produces:\n((?: {2}- .*\n)+)/m.exec(`${front}\n`)?.[1] ?? "")
    .split("\n").map((line) => line.replace(/^ {2}- /, "").trim()).filter(Boolean);
  const dir = join(seededRecordDir(main), "inception", stage);
  mkdirSync(dir, { recursive: true });
  for (const artifact of produces) writeFileSync(join(dir, `${artifact}.md`), `# ${artifact}\n\nWritten.\n`);
  if (reviewer) reviewReady(main, stage, reviewer);
  const awaiting = runMergeTool(ORCH, ["report", "--stage", stage, "--result", "awaiting-approval"], main);
  expect(awaiting.status, awaiting.out).toBe(0);
  const approved = runMergeTool(ORCH, ["report", "--stage", stage, "--result", "approved", "--user-input", "Approve"], main);
  expect(approved.status, approved.out).toBe(0);
  expect(currentStage(main), approved.out).not.toBe(stage);
}

/** The person asks to redo Units Generation; the agent runs the move the engine names. */
function redoUnitsGeneration(main: string): void {
  expect(currentStage(main)).toBe("units-generation");
  const resumed = runMergeTool(ORCH, ["report", "--result", "resumed", "--choice", "redo"], main);
  expect(resumed.status, resumed.out).toBe(0);
  const command = /aidlc-jump\.ts ([^`]+)`/.exec(JSON.parse(resumed.stdout).message ?? "")?.[1];
  expect(command, resumed.out).toContain("--direction redo");
  const jumped = runMergeTool(JUMP, command!.trim().split(/\s+/).map((arg) => arg.replace(/^'(.*)'$/, "$1")), main);
  expect(jumped.status, jumped.out).toBe(0);
}

/** Units Generation and Delivery Planning approved, and main's first step in Functional Design. */
function intoFunctionalDesign(main: string): void {
  writeUnitPlan(main, PLAN);
  approveUnitsGeneration(main);
  approveDeliveryPlanning(main);
  nextDirective(main);
  expect(currentStage(main)).toBe("functional-design");
  git(main, ["add", "-A"]);
  git(main, ["commit", "--allow-empty", "-m", "Units Generation redone"]);
  git(main, ["push", "origin", "main"]);
}

describe("a redo of Units Generation on a team main keeps every Unit's work", () => {
  test("Inception run again with Units Generation redone: the landed Unit stays complete and the Units that wait on it open", () => {
    const { seed: main, remote } = makeReplanSeed(dagBody(PLAN));
    prepareCandidate(remote, "alpha", "alpha-team");
    gateAndLand(main, "alpha");
    git(main, ["push", "origin", "main"]);

    const back = runMergeTool(ORCH, ["next", "--stage", "requirements-analysis"], main);
    expect(back.status, back.out).toBe(0);
    for (let step = 0; step < 10 && currentStage(main) !== "units-generation"; step++) {
      approveCurrentInceptionStage(main);
    }
    redoUnitsGeneration(main);
    intoFunctionalDesign(main);

    expect(unitProgressRow(main, "alpha")).toBe(ALPHA_COMPLETE);
    const overview = status(main);
    expect(overview.claimable).toEqual(["beta"]);
    expect(overview.claimed).toEqual([]);
    expect(overview.waiting).toEqual([]);
    const redo = stageJumps(main).find((block) => block.includes("**Direction**: REDO"));
    expect(redo).toContain("**Target**: units-generation");
    expect(redo).toContain("**Unit Work**: kept");

    // The landed Unit is still not claimable as a fresh attempt.
    const again = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-again"], clone(remote, "alpha-again"));
    expect(again.status).not.toBe(0);
    expect(again.out).toContain("already complete");
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], clone(remote, "beta-team"));
    expect(claimed.status, claimed.out).toBe(0);
  });

  test("a Unit claimed and not landed keeps its claim through the redo, and the Units that wait on it still wait", () => {
    const { seed: main, remote } = makeReplanSeed(dagBody(PLAN));
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team"], clone(remote, "alpha-team"));
    expect(claimed.status, claimed.out).toBe(0);
    git(main, ["pull", "--ff-only"]);

    const back = runMergeTool(ORCH, ["next", "--stage", "units-generation"], main);
    expect(back.status, back.out).toBe(0);
    redoUnitsGeneration(main);
    intoFunctionalDesign(main);

    const overview = status(main);
    expect(overview.claimed.map((claim) => claim.unit)).toEqual(["alpha"]);
    expect(overview.claimable).not.toContain("beta");
    expect(overview.waiting).toEqual([{ unit: "beta", blockedBy: ["alpha"] }]);
  });
});
