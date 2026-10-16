// covers: file:tools/aidlc-lib.ts
//
// A claimed (scoped) checkout reads another Unit's receipts the way an
// unscoped checkout reads them. Before, it refused every foreign Unit's row,
// so from inside a claim every other Unit looked unfinished, a dependent Unit
// could not be routed, and the fold wrote that view into main's table.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { deriveTeamUnitProgressModel } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

describe("t329 a scoped checkout reads other Units' receipts as an unscoped one does", () => {
  test("a dependent Unit's claimed clone sees its dependency merged and is routed", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);
    const mainModel = deriveTeamUnitProgressModel(
      seed,
      readFileSync(seededStateFile(seed), "utf-8"),
    );

    const beta = clone(remote, "beta-team");
    const claim = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], beta);
    expect(claim.status, claim.out).toBe(0);
    const scopedModel = deriveTeamUnitProgressModel(
      beta,
      readFileSync(seededStateFile(beta), "utf-8"),
    );
    expect(scopedModel.mergedUnits.has("alpha")).toBe(true);
    expect(
      scopedModel.section.split("\n").find((line) => line.startsWith("| alpha |")),
    ).toBe("| alpha | alpha-team | [x] | [x] | [x] | [x] | [x] | [x] | [x] |");
    // The same table main derived before the claim: nothing about the scope
    // changes it, only the claim's own owner cell is new.
    expect(scopedModel.section.replace("| beta | beta-team |", "| beta | - |")).toBe(mainModel.section);
    // With the skeleton stance settled, the claimed clone's next is beta's
    // first stage: its dependency is complete from here too.
    writeFileSync(
      seededStateFile(beta),
      readFileSync(seededStateFile(beta), "utf-8").replace(
        "- **Unit Gate Rhythm**: per-stage",
        "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on",
      ),
    );
    expect(nextDirective(beta)).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "beta",
    });
  });
});
