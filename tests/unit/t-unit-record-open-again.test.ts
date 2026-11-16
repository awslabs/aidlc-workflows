// covers: subcommand:aidlc-unit:take, subcommand:aidlc-unit:release, function:takeStanding
//
// A take that has gone quiet: the lead opens the Unit again on the plan, and
// the next person's take writes over the quiet one on the record's tip, its
// generation one more. The quiet builder's later push writes nothing over the
// new take. The lead's word is the plan's (written by the lead's release); a
// take reads it on the record's view only.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupTeamBuild,
  codeGenerated,
  git,
  recordAt,
  recordHostOf,
  refundsTaken,
  run,
  teamWorkspace,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

describe("a quiet take the lead opened again", () => {
  test("the next take writes over it on the record's tip, one generation on; the quiet builder's push writes nothing over it", () => {
    const { home, alice, record } = refundsTaken();
    const ref = `refs/aidlc/claims/${home.id8}/refunds`;
    const quiet = git(recordHostOf(home, "refunds"), ["rev-parse", ref]);
    const opened = run(UNIT, ["release", "refunds"], home.dir);
    expect(opened.status, opened.out).toBe(0);
    const bob = teamWorkspace(home.hosts, "bob");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], bob);
    expect(took.status, took.out).toBe(0);
    const taken = recordAt(home, "refunds")!;
    expect(taken.parents).toEqual([quiet]);
    expect(taken.json).toMatchObject({ status: "claimed", taken_by: "bob", generation: 2 });
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(recordAt(home, "refunds")!.json).toMatchObject({ taken_by: "bob", generation: 2 });
    expect(recordAt(home, "refunds")!.json.result).toBeUndefined();
  });

  test("without the lead's word, the next take hears who builds it", () => {
    const { home } = refundsTaken();
    const bob = teamWorkspace(home.hosts, "bob");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], bob);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("refunds is already taken: alice builds it");
  });
});
