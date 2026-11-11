// covers: function:unitMergeVerdict, function:blobsAt, function:patchIdOf
//
// The home's merge check (#2410, item 5): a repo's part of a Unit is merged
// when the integration branch holds it, whichever way the team merged: a merge
// commit or a fast-forward (the head is an ancestor), a squash or a rebase (a
// first-parent commit has every changed path at the head's blob and every
// deleted path gone, a later edit to the same files aside), or the same change
// on a moved base (patch-id), in one commit or a run of them (a rebase merge of
// several commits). Git plumbing only, read the same on every
// platform: blob ids are what git stores, so a CRLF checkout reads the same.

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { blobsAt, patchIdOf, type RepoResult, unitMergeVerdict } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { cleanupTeamBuild, git, tempDir } from "../harness/team-build.ts";

afterEach(cleanupTeamBuild);

function repo(): string {
  const dir = tempDir("merge-check");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "lead"]);
  git(dir, ["config", "user.email", "lead@example.test"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "c.txt"), "gone soon\n");
  writeFileSync(join(dir, "notes.txt"), "notes\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

function commit(dir: string, message: string, files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, path));
    else writeFileSync(join(dir, path), text);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// The Unit's branch off main: a.txt changed, b.txt added, c.txt deleted.
function unitBranch(dir: string): RepoResult {
  const base = git(dir, ["rev-parse", "main"]);
  git(dir, ["switch", "-q", "-c", "refunds"]);
  const head = commit(dir, "refunds", { "a.txt": "one\nTWO\nthree\n", "b.txt": "new\n", "c.txt": null });
  git(dir, ["switch", "-q", "main"]);
  return result(dir, base, [head]);
}

function result(dir: string, base: string, heads: string[]): RepoResult {
  const changed = ["a.txt", "b.txt", "c.txt"];
  const at = blobsAt(dir, heads.at(-1)!, changed);
  return {
    repo: ".",
    branch: "refunds",
    base,
    heads,
    paths: Object.fromEntries(changed.map((path) => [path, at.get(path) ?? null])),
    patch_id: patchIdOf(dir, base, heads.at(-1)!, changed) ?? undefined,
  };
}

describe("merged, whichever way the team merges", () => {
  test("a merge commit", () => {
    const dir = repo();
    const unit = unitBranch(dir);
    git(dir, ["merge", "-q", "--no-ff", "-m", "merge refunds", "refunds"]);
    expect(unitMergeVerdict(dir, "main", unit)).toMatchObject({ merged: true, how: "ancestry" });
  });

  test("a fast-forward", () => {
    const dir = repo();
    const unit = unitBranch(dir);
    git(dir, ["merge", "-q", "--ff-only", "refunds"]);
    expect(unitMergeVerdict(dir, "main", unit)).toMatchObject({ merged: true, how: "ancestry" });
  });

  test("a squash, then a later edit to the same file", () => {
    const dir = repo();
    const unit = unitBranch(dir);
    git(dir, ["merge", "-q", "--squash", "refunds"]);
    git(dir, ["commit", "-q", "-m", "refunds (squashed)"]);
    const squashed = git(dir, ["rev-parse", "HEAD"]);
    commit(dir, "later edit", { "a.txt": "one\nTWO\nthree\nfour\n" });
    expect(unitMergeVerdict(dir, "main", unit)).toEqual({ merged: true, commit: squashed, how: "same content" });
  });

  test("a rebase onto a base that moved", () => {
    const dir = repo();
    const unit = unitBranch(dir);
    commit(dir, "elsewhere", { "notes.txt": "more notes\n" });
    git(dir, ["cherry-pick", "refunds"]);
    expect(unitMergeVerdict(dir, "main", unit)).toMatchObject({ merged: true, how: "same content" });
  });

  test("the same change on a base that moved inside the same file", () => {
    const dir = repo();
    const unit = unitBranch(dir);
    commit(dir, "header", { "a.txt": "header\n\n\n\n\none\ntwo\nthree\n" });
    git(dir, ["cherry-pick", "refunds"]);
    expect(unitMergeVerdict(dir, "main", unit)).toMatchObject({ merged: true, how: "same change" });
  });

  test("a rebase merge of two commits over a main that changed the same file far away", () => {
    const dir = repo();
    const lines = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`);
    const text = (edit: (all: string[]) => void): string => {
      const all = [...lines];
      edit(all);
      return `${all.join("\n")}\n`;
    };
    commit(dir, "long file", { "long.txt": text(() => {}) });
    const base = git(dir, ["rev-parse", "main"]);
    git(dir, ["switch", "-q", "-c", "refunds"]);
    commit(dir, "refunds one", { "long.txt": text((all) => (all[1] = "LINE 2")) });
    const head = commit(dir, "refunds two", { "long.txt": text((all) => ((all[1] = "LINE 2"), (all[2] = "LINE 3"))) });
    git(dir, ["switch", "-q", "main"]);
    const at = blobsAt(dir, head, ["long.txt"]);
    const unit: RepoResult = {
      repo: ".",
      branch: "refunds",
      base,
      heads: [head],
      paths: { "long.txt": at.get("long.txt") ?? null },
      patch_id: patchIdOf(dir, base, head, ["long.txt"]) ?? undefined,
    };
    commit(dir, "elsewhere in the file", { "long.txt": text((all) => (all[19] = "LINE 20")) });
    git(dir, ["cherry-pick", `${base}..refunds`]);
    const last = git(dir, ["rev-parse", "HEAD"]);
    expect(unitMergeVerdict(dir, "main", unit)).toEqual({ merged: true, commit: last, how: "same change" });
  });

  test("the branch deleted after a squash, read from a clone that never saw it", () => {
    const dir = repo();
    const unit = unitBranch(dir);
    git(dir, ["merge", "-q", "--squash", "refunds"]);
    git(dir, ["commit", "-q", "-m", "refunds (squashed)"]);
    git(dir, ["branch", "-q", "-D", "refunds"]);
    const home = join(tempDir("merge-check-home"), "repo");
    git(dir, ["clone", "-q", "--single-branch", "--branch", "main", dir, home]);
    expect(unitMergeVerdict(home, "origin/main", unit)).toMatchObject({ merged: true, how: "same content" });
  });

  test("a CRLF checkout reads the same", () => {
    const dir = repo();
    const unit = unitBranch(dir);
    git(dir, ["merge", "-q", "--squash", "refunds"]);
    git(dir, ["commit", "-q", "-m", "refunds (squashed)"]);
    const home = join(tempDir("merge-check-crlf"), "repo");
    git(dir, ["clone", "-q", "-c", "core.autocrlf=true", dir, home]);
    expect(unitMergeVerdict(home, "origin/main", unit)).toMatchObject({ merged: true, how: "same content" });
  });
});

describe("not merged yet", () => {
  test("nothing of it on the integration branch", () => {
    const dir = repo();
    expect(unitMergeVerdict(dir, "main", unitBranch(dir))).toEqual({ merged: false });
  });

  test("a review fix pushed after an earlier head: only the earlier head's content merged", () => {
    const dir = repo();
    const first = unitBranch(dir);
    git(dir, ["switch", "-q", "refunds"]);
    const fix = commit(dir, "review fix", { "b.txt": "new, fixed\n" });
    git(dir, ["switch", "-q", "main"]);
    const both = result(dir, first.base, [...first.heads, fix]);
    git(dir, ["cherry-pick", first.heads[0]]);
    expect(unitMergeVerdict(dir, "main", both)).toEqual({ merged: false });
    git(dir, ["cherry-pick", fix]);
    expect(unitMergeVerdict(dir, "main", both)).toMatchObject({ merged: true });
  });
});
