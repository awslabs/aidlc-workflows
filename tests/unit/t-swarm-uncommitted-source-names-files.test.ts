// covers: subcommand:aidlc-swarm:prepare
//
// `prepare` refuses while the approved parent source is not committed. The refusal
// names the first differing paths (at most three) and what is wrong with each, so
// the person is not left to guess which file, or which nested repository, to commit.
// Uses the native worktree/approval fixture pattern from t344; no live agent.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvePlan, CHECK, cleanupCheckpointFixtures, completeOld, fixture, git, prepare, reject,
} from "../harness/swarm-checkpoint.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const IDENTITY = ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com"];

// The refusal once the person has changed the repository and approved the plan against it.
function refusal(dirty: (repo: string) => void, withSubmodule = false, repoName: string | null = null): string {
  const pd = fixture(["alpha"], CHECK, withSubmodule, repoName);
  dirty(repoName === null ? pd : join(pd, repoName));
  approvePlan(pd, "alpha", "revised");
  const result = prepare(pd);
  expect(result.code, `${result.out}\n${result.err}`).toBe(1);
  const message = (JSON.parse(result.err) as { error: string }).error;
  expect(message).toContain("Approved parent source is not committed.");
  expect(message).toContain("No child was created and no parent commit was made.");
  return message;
}

describe("prepare names what keeps the approved source from being committed", () => {
  test("an untracked file", () => {
    const message = refusal((repo) => {
      mkdirSync(join(repo, "notes"));
      writeFileSync(join(repo, "notes", "todo.md"), "todo\n");
    });
    expect(message).toContain("notes/todo.md is not committed (new or untracked)");
  });

  test("a modified file", () => {
    const message = refusal((repo) => writeFileSync(join(repo, "src", "alpha.ts"), "export const alpha = 9;\n"));
    expect(message).toContain("src/alpha.ts differs from the last commit (modified)");
  });

  test("a deleted file", () => {
    const message = refusal((repo) => rmSync(join(repo, "src", "alpha.ts")));
    expect(message).toContain("src/alpha.ts is deleted but still committed");
  });

  test("more than three differences name three and count the rest", () => {
    const message = refusal((repo) => {
      for (const name of ["a", "b", "c", "d", "e"]) writeFileSync(join(repo, `${name}.txt`), "x\n");
    });
    expect(message).toContain("a.txt is not committed");
    expect(message).toContain("c.txt is not committed");
    expect(message).not.toContain("d.txt");
    expect(message).toContain("and 2 more");
  });

  test("an untracked file inside a nested repository names it and says where to commit", () => {
    const message = refusal((repo) => writeFileSync(join(repo, "vendor", "sub", "new.ts"), "x\n"), true);
    expect(message).toContain("vendor/sub/new.ts is not committed (new or untracked) in the nested repository vendor/sub");
    expect(message).toContain("Commit inside the nested repository first, then commit it in the parent repository.");
  });

  test("a nested repository whose HEAD moved names its changed files", () => {
    const message = refusal((repo) => {
      const sub = join(repo, "vendor", "sub");
      writeFileSync(join(sub, "lib.ts"), "export const lib = 3;\n");
      git(sub, ["add", "-A"]);
      git(sub, [...IDENTITY, "commit", "-qm", "move"]);
    }, true);
    expect(message).toContain("vendor/sub/lib.ts differs from the last commit (modified) in the nested repository vendor/sub");
  });

  test("a file git ignores is named as ignored, not as uncommitted", () => {
    const message = refusal((repo) => {
      writeFileSync(join(repo, ".gitignore"), ".env\n");
      git(repo, ["add", ".gitignore"]);
      git(repo, [...IDENTITY, "commit", "-qm", "ignore .env"]);
      writeFileSync(join(repo, ".env"), "SECRET=1\n");
    });
    expect(message).toContain(".env is ignored by git, so a commit leaves it out");
    expect(message).not.toContain(".env is not committed");
    expect(message).not.toContain("nested repository");
  });

  test.skipIf(process.platform === "win32")("a committed link to a file outside the repository is named as such", () => {
    const outside = mkdtempSync(join(tmpdir(), "t-uncommitted-link-"));
    writeFileSync(join(outside, "ext.ts"), "export const ext = 1;\n");
    const message = refusal((repo) => {
      symlinkSync(join(outside, "ext.ts"), join(repo, "src", "ext.ts"));
      git(repo, ["add", "src/ext.ts"]);
      git(repo, [...IDENTITY, "commit", "-qm", "link outside"]);
    });
    expect(message).toContain("src/ext.ts links outside the repository, so a commit cannot carry what it points to");
    expect(message).not.toContain("@target");
  });

  test("in a workspace of several repositories the path names its repository", () => {
    const message = refusal((repo) => {
      mkdirSync(join(repo, "notes"));
      writeFileSync(join(repo, "notes", "todo.md"), "todo\n");
    }, false, "app");
    expect(message).toContain("app/notes/todo.md is not committed (new or untracked)");
  });

  test("the retry of a preserved worktree names the file the same way", () => {
    const pd = fixture(["alpha", "beta"], "git diff --quiet -- src/beta.ts");
    completeOld(pd, ["alpha", "beta"]);
    writeFileSync(join(pd, "src", "beta.ts"), "export const beta = 2;\n");
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const result = prepare(pd, ["alpha"], true);
    expect(`${result.out}\n${result.err}`).toContain(
      "Clean worktree needs approved parent source that is not committed. src/beta.ts differs from the last commit (modified).",
    );
  });
});
