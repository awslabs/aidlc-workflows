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
//
// Every harness's shipped .gitignore part keeps that metadata out and leaves
// the Unit's own checkout (and a restored one) visible: Kiro IDE applies a
// project's .gitignore to its file reads, each file on its own, so ignoring
// those folders would stop its side-by-side workers reading their own code.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boltSlugForUnit } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { REPO_ROOT, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupCheckpointFixtures, fixtureWithShippedGitignore, git, ISOLATED_GIT_ENV, prepare, reviewRevisedSource,
  runCheckpointTool, swarm, wt, writeUnitSource,
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

describe("every harness's shipped .gitignore part", () => {
  // Each part on its own, as Kiro reads it: a scratch repository with no
  // template, so nothing but the part decides.
  const ignored = (part: string, paths: string[]): string[] => {
    const scratch = mkdtempSync(join(tmpdir(), "aidlc-shipped-ignore-"));
    try {
      expect(Bun.spawnSync(["git", "init", "-q", "--template=", scratch], { env: ISOLATED_GIT_ENV }).exitCode).toBe(0);
      const check = Bun.spawnSync(
        ["git", "-C", scratch, "-c", `core.excludesFile=${part}`, "check-ignore", "--no-index", "--stdin"],
        { env: ISOLATED_GIT_ENV, stdin: Buffer.from(`${paths.join("\n")}\n`), stdout: "pipe", stderr: "pipe" },
      );
      expect([0, 1], check.stderr.toString()).toContain(check.exitCode);
      return check.stdout.toString().split("\n").filter(Boolean);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  test("keeps a Unit checkout's metadata out and leaves the checkout itself readable", () => {
    const parts = readdirSync(join(REPO_ROOT, "harness"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(REPO_ROOT, "harness", entry.name, "dot-gitignore"));
    expect(parts.length).toBeGreaterThanOrEqual(7);
    const metadata = [".aidlc/worktree-meta.json", ".aidlc/base-source-listing.tsv"];
    const checkouts = [
      `.aidlc/worktrees/${boltSlugForUnit("alpha")}/src/alpha.ts`,
      `.aidlc/worktrees/${boltSlugForUnit("alpha")}/aidlc/spaces/default/intents/x/construction/alpha/plan.md`,
      `.aidlc/restored/${boltSlugForUnit("alpha")}-20261111T000000Z/src/alpha.ts`,
    ];
    for (const part of parts) {
      expect(ignored(part, metadata), part).toEqual(metadata);
      expect(ignored(part, checkouts), part).toEqual([]);
    }
  });
});
