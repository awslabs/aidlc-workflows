// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, audit:UNIT_SKIPPED
//
// A team claims a Unit in its own checkout and leaves out the Unit's first
// Construction stage (Functional Design) before working it. The checkout has
// no walking-skeleton stance recorded yet, which the first Construction stage
// reads (the classify step, `gate: "unresolved"`). The skip was recorded for
// the Unit, but `next` kept handing out that classify step on Functional
// Design, stage-wide with no Unit named, and the Unit's row in Unit Progress
// stayed empty: the walk never reached the Unit. A stage the claimed Unit
// skipped asks for no stance there, and the walk goes on to the Unit's next
// step. With the stance recorded, or with no skip, the walk is as it was.
//
// Mechanism: cli - spawns the shipped tools against a seeded team project, a
// bare remote and a claimed clone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORCH,
  UNIT,
  cleanupTempDirs,
  clone,
  git,
  makeSeed,
  nextDirective,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import { seededAuditDir, seededStateFile } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const FIRST = "functional-design";
const REASON = "left out at claim by the developer";

// A claimed checkout of main as the lead shared it, its walking-skeleton
// stance recorded or not.
function claimed(rhythm: "unit-end" | "per-stage", stance?: "off"): string {
  const { seed, remote } = makeSeed();
  if (stance) {
    const statePath = seededStateFile(seed);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace("- **State Version**: 8", `- **State Version**: 8\n- **Skeleton Stance**: ${stance}`),
    );
    git(seed, ["commit", "-am", "skeleton stance"]);
    git(seed, ["push", "origin", "main"]);
  }
  const checkout = clone(remote, "alpha-team");
  const claim = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team", "--rhythm", rhythm], checkout);
  expect(claim.status, claim.out).toBe(0);
  return checkout;
}

function skip(checkout: string, stage = FIRST): Record<string, unknown> {
  const res = runMergeTool(ORCH, ["report", "--stage", stage, "--unit", "alpha", "--result", "skipped", "--reason", REASON], checkout);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

// Functional Design's cell, the first stage column of the Unit's row.
function firstCell(checkout: string): string {
  return unitProgressRow(checkout, "alpha").split("|").slice(1, -1).map((cell) => cell.trim())[2] ?? "";
}

describe("t-team-unit-skip-first-stage: a claimed Unit that skips its first stage goes on to its next step", () => {
  for (const rhythm of ["unit-end", "per-stage"] as const) {
    test(`${rhythm}: no stance recorded, the skip of Functional Design hands out NFR Requirements for the Unit`, () => {
      const checkout = claimed(rhythm);
      // Before the skip: the first stage, its stance to read.
      const first = nextDirective(checkout);
      expect(first, JSON.stringify(first).slice(0, 400)).toMatchObject({ kind: "run-stage", stage: FIRST, gate: "unresolved" });

      expect(skip(checkout)).toMatchObject({ kind: "done", workflow_continues: true });
      const after = nextDirective(checkout);
      expect(after, JSON.stringify(after).slice(0, 400)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
      expect(after.gate).not.toBe("unresolved");
      expect(firstCell(checkout)).toBe("[x]");
    });
  }

  test("with the stance recorded the walk is as it was: the skip hands out the Unit's next step", () => {
    const checkout = claimed("unit-end", "off");
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: FIRST, unit: "alpha" });
    skip(checkout);
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
    expect(firstCell(checkout)).toBe("[x]");
  });

  test("a Unit that neither skipped nor built the stage is still handed it, the stance to read first", () => {
    const checkout = claimed("unit-end");
    nextDirective(checkout);
    const again = nextDirective(checkout);
    expect(again).toMatchObject({ kind: "run-stage", stage: FIRST, gate: "unresolved" });
    expect(firstCell(checkout)).toBe("[ ]");
  });

  test("a send-back to the stage after the skip moves its floor: the Unit owes the stage again", () => {
    const checkout = claimed("unit-end");
    nextDirective(checkout);
    skip(checkout);
    expect(nextDirective(checkout)).toMatchObject({ stage: "nfr-requirements", unit: "alpha" });
    // A jump back to Functional Design, as the person's change writes it: every
    // stage from its target starts a new attempt, so the skip is not current.
    const shard = join(seededAuditDir(checkout), JSON.parse(readFileSync(join(checkout, "aidlc", ".aidlc-unit-scope.json"), "utf-8")).audit_shard);
    const at = new Date(Date.now() + 2000).toISOString().replace(/\.\d+Z$/, "Z");
    appendFileSync(
      shard,
      `\n## Stage Jump\n**Timestamp**: ${at}\n**Event**: STAGE_JUMPED\n**Direction**: BACKWARD\n` +
        `**Source**: nfr-requirements\n**Target**: ${FIRST}\n**Scope**: feature\n\n---\n`,
    );
    expect(nextDirective(checkout)).toMatchObject({ kind: "run-stage", stage: FIRST, unit: "alpha" });
    expect(firstCell(checkout)).toBe("[ ]");
  });
});
