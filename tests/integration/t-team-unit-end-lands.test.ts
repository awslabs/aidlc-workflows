// covers: subcommand:aidlc-unit:land, subcommand:aidlc-state:fold-unit-merge
//
// A team Unit claimed with the unit-end rhythm approves once, at the end of its
// walk. Main derived that Unit's row with main's own rhythm (per-stage), found
// no per-stage approvals and showed every step awaiting approval, so the state
// fold refused the landing: "state fold has not applied the authoritative
// merged row". Main now derives each Unit's row with the rhythm the Unit was
// claimed with, as its unit-end gate row records it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cleanupTempDirs, gateAndLand, makeSeed, prepareCandidate, unitProgressRow } from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

describe("t-team-unit-end-lands: a Unit claimed with the unit-end rhythm lands on a per-stage main", () => {
  test("pin, gate and land fold the Unit's row as merged, every step done", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", { unitEnd: true });
    gateAndLand(seed, "alpha");
    const cells = unitProgressRow(seed, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(cells[0]).toBe("alpha");
    expect(cells.slice(2)).toEqual(cells.slice(2).map(() => "[x]"));
  });
});
