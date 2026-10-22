// covers: subcommand:aidlc-swarm:prepare
//
// `prepare` refuses while the approved parent source is not committed. The refusal
// names the first differing paths (at most three) and what is wrong with each, so
// the person is not left to guess which file, or which nested repository, to commit.
// Uses the native worktree/approval fixture pattern from t344; no live agent.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvePlan, CHECK, cleanupCheckpointFixtures, fixture, git, prepare } from "../harness/swarm-checkpoint.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const IDENTITY = ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com"];

// The refusal once the person has changed the repository and approved the plan against it.
function refusal(dirty: (repo: string) => void, withSubmodule = false): string {
  const pd = fixture(["alpha"], CHECK, withSubmodule);
  dirty(pd);
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
});
