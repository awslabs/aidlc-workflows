// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, function:readUnitMergeTransaction

// An approved Unit merge whose landing was refused before git landed anything
// (a pre-commit hook here), followed by a republish of the Unit (Code
// Generation reopened), left three commands pointing at each other: gate and
// land said the claim moved and to pin again, and pin refused because the
// journal held an approved transaction. Pin now replaces that transaction when
// git never landed it and the claim has moved; the old approval stays bound to
// the old pinned candidate and never counts for the new one.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUnitMergeTransaction } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  UNIT,
  approveMerge,
  cleanupTempDirs,
  dispatchMerge,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const HOOKS = {
  // A hook that refuses every commit stops the metadata checkpoint, the first
  // commit land makes.
  "every commit": "#!/bin/sh\nexit 1\n",
  // A hook that refuses only the merge commit lets the checkpoint through, so
  // land rolls the checkpoint and the merge back.
  "the merge commit":
    '#!/bin/sh\n[ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] && exit 1\nexit 0\n',
};

function installPreCommitHook(checkout: string, body: string): string {
  const hook = join(checkout, ".git", "hooks", "pre-commit");
  writeFileSync(hook, body);
  chmodSync(hook, 0o755);
  return hook;
}

function republish(checkout: string): void {
  writeFileSync(join(checkout, "src", "alpha.ts"), 'export const alpha = "reworked";\n');
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-m", "rework alpha after a reopened Code Generation"]);
  const published = runMergeTool(UNIT, ["publish", "alpha"], checkout);
  expect(published.status, published.out).toBe(0);
}

describe("a stale approved Unit merge", () => {
  test.each(Object.entries(HOOKS))(
    "is replaced by a new pin when a hook refused %s and the Unit was republished",
    (_label, hookBody) => {
      const { seed, remote } = makeSeed();
      const candidate = prepareCandidate(remote, "alpha", "stale-approval");
      const { pinnedOid: oldOid } = approveMerge(seed, "alpha");
      const headBefore = git(seed, ["rev-parse", "HEAD"]);

      const hook = installPreCommitHook(seed, hookBody);
      const refused = runMergeTool(UNIT, ["land", "alpha"], seed);
      expect(refused.status).not.toBe(0);
      rmSync(hook);
      expect(git(seed, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(readUnitMergeTransaction(seed, "alpha")?.status).toBe("approved");

      republish(candidate.checkout);

      const reject = runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "reject", "--user-input", "Reject"],
        seed,
      );
      expect(reject.status).not.toBe(0);
      expect(reject.out).toContain("run aidlc-unit pin alpha again");

      const repin = runMergeTool(UNIT, ["pin", "alpha"], seed);
      expect(repin.status, repin.out).toBe(0);
      const payload = JSON.parse(repin.stdout);
      expect(payload.pinned_oid).not.toBe(oldOid);
      expect(payload.superseded).toEqual({ pinned_oid: oldOid, status: "approved" });
      expect(readUnitMergeTransaction(seed, "alpha")?.status).toBe("pinned");

      // The earlier approval was for the earlier candidate.
      const early = runMergeTool(UNIT, ["land", "alpha"], seed);
      expect(early.status).not.toBe(0);
      expect(early.out).toContain("merge is not approved");

      dispatchMerge(seed, "alpha", payload.pinned_oid, payload.generation);
      const gate = runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve the reworked alpha"],
        seed,
      );
      expect(gate.status, gate.out).toBe(0);
      const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
      expect(landed.status, landed.out).toBe(0);
      expect(readFileSync(join(seed, "src", "alpha.ts"), "utf-8")).toContain("reworked");
    },
  );

  test("whose claim has not moved is still landed, not re-pinned", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "unmoved-approval");
    approveMerge(seed, "alpha");
    const hook = installPreCommitHook(seed, HOOKS["every commit"]);
    expect(runMergeTool(UNIT, ["land", "alpha"], seed).status).not.toBe(0);
    rmSync(hook);

    const repin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(repin.status).not.toBe(0);
    expect(repin.out).toContain("recover it with aidlc unit land alpha");
    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status, landed.out).toBe(0);
  });
});
