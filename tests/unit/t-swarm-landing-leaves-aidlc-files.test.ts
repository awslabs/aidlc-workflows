// covers: subcommand:aidlc-swarm:finalize, subcommand:aidlc-worktree:merge, function:shapeSourceSnapshotIndex
//
// In a project that commits its AI-DLC records, as the .gitignore AI-DLC ships
// has it, a side-by-side Unit's worker commits its work with `git add -A`, so
// the Bolt branch's commits carry AI-DLC's own files: the audit record, the
// state file, the Unit's documents. The shipped .gitignore keeps the worktree's
// own metadata out of that commit, and a worktree from an older .gitignore that
// committed it anyway changes nothing: the reviewed commit carries the Unit's
// code only, the landing goes in on the first run, and main never tracks the
// worktree's metadata or its folder in the state file. The Unit's documents
// reach main the way they always do, through finalize.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boltSlugForUnit } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupCheckpointFixtures, fixtureWithShippedGitignore, git, prepare, reviewRevisedSource, runCheckpointTool,
  swarm, wt, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const commit = (dir: string, message: string) =>
  git(dir, ["-c", "user.name=Worker", "-c", "user.email=worker@example.com", "commit", "-qm", message]);

describe("a Bolt whose commits carry AI-DLC's own files", () => {
  test("lands its code only, on the first run", () => {
    const pd = fixtureWithShippedGitignore(["alpha"]);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const child = wt(pd);

    writeUnitSource(pd, "alpha", 2);
    git(child, ["add", "-A"]);
    // The shipped .gitignore keeps the worktree's metadata out of the worker's commit.
    expect(git(child, ["diff", "--cached", "--name-only", "--", ".aidlc"])).toBe("");
    expect(git(child, ["diff", "--cached", "--name-only", "--", "aidlc"])).not.toBe("");
    commit(child, "worker: alpha");

    const checked = swarm(pd, ["check", "alpha"]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, "alpha");
    // A worktree from an older .gitignore commits its metadata too.
    git(child, ["add", "-A"]);
    git(child, ["add", "-f", ".aidlc/worktree-meta.json", ".aidlc/base-source-listing.tsv"]);
    commit(child, "worker: alpha reviewed");

    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);

    const landed = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
      "merge", "--slug", boltSlugForUnit("alpha"), "--target", "main", "--strategy", "squash", "--project-dir", pd,
    ]);
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect(git(pd, ["show", "--name-only", "--format=", "HEAD"])).toBe("src/alpha.ts");
    expect(readFileSync(join(pd, "src", "alpha.ts"), "utf-8")).toBe("export const alpha = 2;\n");
    expect(git(pd, ["ls-files", "--", ".aidlc"])).toBe("");
    expect(readFileSync(seededStateFile(pd), "utf-8")).not.toContain(".aidlc/worktrees/");
  });
});
