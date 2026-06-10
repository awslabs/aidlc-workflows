// covers: function:worktreePath
//
// t69.none.test.ts — bun:test port of tests/unit/t69-worktree-path.sh (TAP plan 4).
//
// Mechanism: none. worktreePath() is a pure (string, string) -> string path
// composer in aidlc-lib.ts with ZERO I/O, zero validation, zero CLI shell, so
// the three behavioural assertions become direct import-and-call expects. The
// .sh batched them into one `bun -e` probe purely to amortise startup cost;
// in-process there is no spawn to amortise, so each becomes its own expect().
// No Bun.spawnSync env-seam case is retained — there is no process.exit
// boundary, argv parsing, or env read to exercise.
//
// The .sh's first assertion is a static content-lint of the repo .gitignore
// (it must carry the anchored `^/\.aidlc/$` entry so a nested `.aidlc/` is not
// silently swallowed). That is not a worktreePath() call, but it guards the
// same primitive's on-disk footprint, so it is ported faithfully as a
// readFileSync($REPO_ROOT/.gitignore) + per-line regex check.
//
// PARTIAL-PORT NOTE: the .sh used setup_integration_project --no-aidlc-docs
// ONLY to obtain an absolute projectDir to feed the helper. worktreePath()
// never touches the filesystem, so this port skips the fixture-project setup
// entirely and passes a synthetic absolute path ("/tmp/proj"). No behaviour is
// lost — the helper's output depends only on its string arguments.
//
// Sources read for this port:
//   dist/claude/.claude/tools/aidlc-lib.ts:155
//     worktreePath(projectDir, boltSlug) =>
//       toPosix(join(projectDir, ".aidlc", "worktrees", `bolt-${boltSlug}`))
//   .gitignore:29  ->  /.aidlc/
//
// Parity mapping (.sh assertion -> test below):
//   1. ".gitignore contains anchored /.aidlc/ entry"        -> describe ".gitignore"
//   2. "returns an absolute path when projectDir is absolute" -> isAbsolute check
//   3. "worktreePath(projectDir,'demo') ends with /bolt-demo" -> ends-with check
//   4. "does not validate or sanitise the slug (milestone 2 contract)" -> '/' passthrough

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { worktreePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// $REPO_ROOT in the .sh resolves to the repo root (one level above tests/).
const REPO_ROOT = join(import.meta.dir, "..", "..");

// The .sh fed worktreePath an absolute projectDir produced by
// setup_integration_project. Since the helper does no I/O, a synthetic
// absolute path is sufficient and the dir need not exist.
const PROJ = "/tmp/proj";

describe("t69 .gitignore anchored /.aidlc/ entry", () => {
  // .sh #1: assert_grep "$REPO_ROOT/.gitignore" '^/\.aidlc/$'
  // Anchored (leading /) so a nested `.aidlc/` (e.g. inside node_modules) is
  // not silently swallowed. The framework only ever writes .aidlc/ at the repo
  // root, alongside .claude/. Ported as a per-line exact-match scan to mirror
  // the grep's line-anchored ^...$ semantics.
  test("repo .gitignore has an anchored /.aidlc/ line", () => {
    const lines = readFileSync(join(REPO_ROOT, ".gitignore"), "utf-8").split("\n");
    expect(lines.some((l) => /^\/\.aidlc\/$/.test(l))).toBe(true);
  });
});

describe("worktreePath() (in-process, pure string composer)", () => {
  // .sh #2: "worktreePath() returns an absolute path when projectDir is
  //          absolute". Catches an implementation that dropped the projectDir
  //          prefix or returned a relative path.
  test("returns an absolute path when projectDir is absolute", () => {
    expect(isAbsolute(worktreePath(PROJ, "demo"))).toBe(true);
  });

  // .sh #3: "worktreePath(projectDir, 'demo') ends with /bolt-demo". Prefix
  //          contract — catches dropping the literal "bolt-", dropping the
  //          slug, or appending an extra path component. milestone 7's
  //          `git worktree add <path>` relies on the leaf being bolt-<slug>.
  test("output ends with /bolt-<slug> for a normal slug", () => {
    expect(worktreePath(PROJ, "demo").endsWith("/bolt-demo")).toBe(true);
  });

  // .sh #4: "worktreePath() does not validate or sanitise the slug (milestone 2
  //          contract)". A slug containing '/' passes through verbatim, pinning
  //          the "no validation in milestone 2" decision (validation deferred to milestone 7's
  //          aidlc-worktree.ts at create-time). If a future change adds slug
  //          sanitisation here, this fails and forces a conscious decision.
  test("does not validate or sanitise a slug containing '/'", () => {
    expect(worktreePath(PROJ, "a/b").endsWith("/bolt-a/b")).toBe(true);
  });
});
