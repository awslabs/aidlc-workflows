// covers: subcommand:aidlc-orchestrate:next, function:cachedClaimFanoutActive, function:validateLiveUnitScope, function:buildTeamConstructionBoard
//
// After a team Unit lands, its claim stays live, so the guard still counts the
// fan-out as active in every unscoped checkout. `next` reads that same check:
// it shows the dispatcher board (or a participant's claim question) instead of
// the next Unit's stage, so a claim runs only on the person's own
// `/aidlc --claim`, and the guard's refusal names that step. The board's
// header, its Claim Registry and its list of claimed Units name as claimed only
// Units still being worked, as its Claimable and Waiting lists read them; a
// landed Unit's kept claim reads as landed, and only once main has merged it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ORCH,
  STATE,
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

// A pinned landing plus four checkouts' tool calls: the generous workload backstop.
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

function claimRefs(remote: string): string {
  return git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/claim/"]);
}

// Every file in the checkout outside .git, ignored engine files included.
function checkoutFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile() || path.slice(dir.length + 1).split(/[\\/]/)[0] === ".git") continue;
    files[path] = readFileSync(path, "utf-8");
  }
  return files;
}

describe("t326 an unscoped checkout after a team Unit lands", () => {
  test("shows the board, not the next Unit's stage, and claims only on the person's word", () => {
    const { seed, remote } = makeSeed();
    const team = prepareCandidate(remote, "alpha", "alpha-team");
    // The team's own clone, its work done and published, before main merges
    // it: the claim is still being worked toward landing.
    const published = runMergeTool(ORCH, ["team-board", "--snapshot"], team.checkout);
    expect(published.status, published.out).toBe(0);
    expect(published.stdout).toContain("| alpha | claimed | alpha-team | 1 |");
    expect(published.stdout).not.toContain("| alpha | landed |");
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);
    const refsAfterLanding = claimRefs(remote);
    expect(refsAfterLanding).toContain("/alpha");
    expect(refsAfterLanding).not.toContain("/beta");

    // The lead's main, where alpha landed: the board with beta's claim step,
    // and alpha, landed, is no longer listed as claimed.
    const lead = nextDirective(seed);
    expect(lead.kind).toBe("notice");
    expect(lead.message as string).toContain("# Team Construction Dispatcher");
    expect(lead.message as string).toContain("**Claimed:** none. **Claimable:** beta. **Waiting:** none.");
    expect(lead.message as string).toContain("| alpha | landed | alpha-team | 1 |");
    expect(lead.message as string).not.toContain("| alpha | claimed |");
    expect(lead.message as string).not.toContain("`alpha` is claimed by");
    expect(lead.message as string).toContain("`/aidlc --claim beta`");
    const beforeProbe = checkoutFiles(seed);
    const probe = runMergeTool(ORCH, ["next"], seed, false, { AIDLC_STOP_HOOK_PROBE: "1" });
    expect(probe.status, probe.out).toBe(0);
    expect(JSON.parse(probe.stdout)).toMatchObject({ kind: "notice", message: lead.message });
    expect(checkoutFiles(seed)).toEqual(beforeProbe);
    const snapshot = runMergeTool(ORCH, ["team-board", "--snapshot"], seed);
    expect(snapshot.status, snapshot.out).toBe(0);
    expect(snapshot.stdout).toContain("| alpha | landed | alpha-team | 1 |");

    // The guard's refusal names the person's step.
    const unscopedStart = runMergeTool(
      STATE,
      ["unit", "start", "--stage", "functional-design", "--unit", "beta"],
      seed,
    );
    expect(unscopedStart.status).not.toBe(0);
    expect(unscopedStart.out).toContain("/aidlc --claim <unit> --team <label>");

    // A fresh clone of the landed main routes the same way.
    const fresh = clone(remote, "fresh");
    const freshNext = nextDirective(fresh);
    expect(freshNext.kind).toBe("notice");
    expect(freshNext.message as string).toContain("`/aidlc --claim beta`");
    expect(freshNext.message as string).toContain("**Claimed:** none. **Claimable:** beta.");
    expect(freshNext.message as string).toContain("| alpha | landed | alpha-team | 1 |");
    expect(freshNext.message as string).not.toContain("`alpha` is claimed by");

    // A participant clone gets the claim question.
    const participant = clone(remote, "participant");
    const joined = runMergeTool(UNIT, ["participate"], participant);
    expect(joined.status, joined.out).toBe(0);
    expect(nextDirective(participant)).toMatchObject({
      kind: "ask",
      ask_type: "unit-claim",
      claimable_units: ["beta"],
    });
    expect(claimRefs(remote)).toBe(refsAfterLanding);

    // The person's own claim goes through, and the claimed checkout routes as on main.
    const claimStep = runMergeTool(
      ORCH,
      ["next", "--claim", "beta", "--team", "beta-team"],
      fresh,
    );
    expect(claimStep.status, claimStep.out).toBe(0);
    expect(JSON.parse(claimStep.stdout).message).toContain("--claim beta --team beta-team");
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], fresh);
    expect(claimed.status, claimed.out).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ claimed: true, unit: "beta", owner: "beta-team" });
    expect(nextDirective(fresh)).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
    });

    // With beta taken and nothing left to claim, the lead's main shows the board.
    git(seed, ["fetch", "origin"]);
    const taken = nextDirective(seed);
    expect(taken.kind).toBe("notice");
    expect(taken.message as string).toContain("**Claimed:** beta (beta-team). **Claimable:** none.");
    expect(taken.message as string).toContain("| alpha | landed | alpha-team | 1 |");
    expect(taken.message as string).toContain("| beta | claimed | beta-team | 1 |");
    expect(taken.message as string).toContain("`beta` is claimed by beta-team (attempt 1)");
    expect(taken.message as string).not.toContain("`alpha` is claimed by");
  });
});
