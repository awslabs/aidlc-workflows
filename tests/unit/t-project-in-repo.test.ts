// covers: function:projectInRepo, function:inRepo, function:inProject, function:gitCommonDirOf
//
// Where a project sits in its git repository has one owner, aidlc-git.ts. git
// prints and reads some paths from the repository's top (status and diff name
// lists, REV:path, update-index --cacheinfo) while AI-DLC's record paths are
// from the project folder, and git prints --git-common-dir and --git-dir
// relative to the folder it ran in. Built with real git: a project at the
// repository's top, one in apps/web of a monorepo, one in a non-ASCII folder,
// one in a linked worktree's folder, and a folder outside git. At the top the
// project's path is "" and both helpers are the identity, so a project there
// reads every path as it always has. Runs on Linux, macOS (darwin, where the
// temp folder is reached through a link and a folder name may be decomposed)
// and Windows (drive letters, git's C:/ paths).
//
// The pin at the end keeps it one owner: no other file under core/ or harness/
// passes --show-prefix or --git-common-dir to git, but the files named in
// NOT_YET_ON_THE_OWNER, each at most as often as it does now and with the
// reason it is there, and the work not on main yet named in IN_FLIGHT.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import * as ts from "typescript";
import {
  gitCommonDirOf,
  inProject,
  inRepo,
  projectInRepo,
} from "../../dist/claude/.claude/tools/aidlc-git.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-project-in-repo-")));
  roots.push(root);
  return root;
}

// git with the test's own identity and no search above the scratch root, so a
// repository the machine keeps above the temp folder is never found.
function git(cwd: string, args: string[], root: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: dirname(root),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

// A repository whose first commit holds `folders`, each with a file in it.
function repository(root: string, name: string, folders: string[]): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"], root);
  for (const folder of folders) {
    mkdirSync(join(repo, folder), { recursive: true });
    writeFileSync(join(repo, folder, "readme.md"), "hello\n");
  }
  git(repo, ["add", "-A"], root);
  git(repo, ["commit", "-q", "-m", "base"], root);
  return repo;
}

function samePath(a: string, b: string): boolean {
  return realpathSync(a) === realpathSync(b);
}

describe("projectInRepo: the project's place in its repository", () => {
  test("at the repository's top the path is empty", () => {
    const root = scratch();
    const repo = repository(root, "top", ["src"]);
    const at = projectInRepo(repo);
    expect(at).not.toBeNull();
    expect(at!.prefix).toBe("");
    expect(samePath(at!.top, repo)).toBe(true);
  });

  test("in a folder of a monorepo it is the folder's path from the top, ending in /", () => {
    const root = scratch();
    const repo = repository(root, "mono", ["apps/web", "other"]);
    const at = projectInRepo(join(repo, "apps", "web"));
    expect(at!.prefix).toBe("apps/web/");
    expect(samePath(at!.top, repo)).toBe(true);
  });

  test("a non-ASCII folder is named as git status names its files with -z", () => {
    const root = scratch();
    const folder = "pakete/wéb";
    const repo = repository(root, "accents", [folder]);
    const project = join(repo, "pakete", "wéb");
    const at = projectInRepo(project);
    expect(at!.prefix).toBe(`${folder}/`);
    writeFileSync(join(project, "new.md"), "x\n");
    const listed = git(project, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], root)
      .split("\0").filter(Boolean).map((record) => record.slice(3));
    expect(listed.map((path) => inProject(at!.prefix, path))).toEqual(["new.md"]);
  });

  test("in a folder of a linked worktree the top is the worktree's", () => {
    const root = scratch();
    const repo = repository(root, "main", ["apps/web"]);
    const worktree = join(root, "linked");
    git(repo, ["worktree", "add", "-q", "--detach", worktree], root);
    const at = projectInRepo(join(worktree, "apps", "web"));
    expect(at!.prefix).toBe("apps/web/");
    expect(samePath(at!.top, worktree)).toBe(true);
  });

  test("outside git there is no answer, and a folder made a repository later is seen", () => {
    const root = scratch();
    const plain = join(root, "plain");
    mkdirSync(plain);
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    try {
      expect(projectInRepo(plain)).toBeNull();
      git(plain, ["init", "-q"], root);
      expect(projectInRepo(plain)?.prefix).toBe("");
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
    }
  });
});

describe("inRepo and inProject: one path in either frame", () => {
  test("at the top both are the identity", () => {
    expect(inRepo("", "aidlc/spaces/default/x.md")).toBe("aidlc/spaces/default/x.md");
    expect(inProject("", "aidlc/spaces/default/x.md")).toBe("aidlc/spaces/default/x.md");
    expect(inProject("", "other/x.md")).toBe("other/x.md");
  });

  test("in a folder a project path gains the prefix and a repository path loses it", () => {
    expect(inRepo("apps/web/", "aidlc/x.md")).toBe("apps/web/aidlc/x.md");
    expect(inProject("apps/web/", "apps/web/aidlc/x.md")).toBe("aidlc/x.md");
    expect(inProject("apps/web/", "apps/web/")).toBe("");
  });

  test("a path outside the project is no project path", () => {
    expect(inProject("apps/web/", "other/x.md")).toBeNull();
    expect(inProject("apps/web/", "apps/webapp/x.md")).toBeNull();
    expect(inProject("apps/web/", ".aidlc-unit-claim.json")).toBeNull();
  });
});

describe("gitCommonDirOf: git's own folders, resolved against the folder git ran in", () => {
  test("from a folder of a monorepo both name the repository's .git", () => {
    const root = scratch();
    const repo = repository(root, "mono", ["apps/web"]);
    const dirs = gitCommonDirOf(join(repo, "apps", "web"));
    expect(dirs.ok).toBe(true);
    if (!dirs.ok) return;
    expect(samePath(dirs.common, join(repo, ".git"))).toBe(true);
    expect(samePath(dirs.own, join(repo, ".git"))).toBe(true);
  });

  test("from a folder of a linked worktree the common dir is the main checkout's", () => {
    const root = scratch();
    const repo = repository(root, "main", ["apps/web"]);
    const worktree = join(root, "linked");
    git(repo, ["worktree", "add", "-q", "--detach", worktree], root);
    const dirs = gitCommonDirOf(join(worktree, "apps", "web"));
    expect(dirs.ok).toBe(true);
    if (!dirs.ok) return;
    expect(samePath(dirs.common, join(repo, ".git"))).toBe(true);
    expect(samePath(dirs.own, join(repo, ".git", "worktrees", "linked"))).toBe(true);
  });

  test("the environment given is the one git runs with", () => {
    const root = scratch();
    const repo = repository(root, "mine", ["apps/web"]);
    const other = repository(root, "theirs", ["src"]);
    const dirs = gitCommonDirOf(join(repo, "apps", "web"), { env: { ...process.env, GIT_DIR: join(other, ".git") } });
    expect(dirs.ok).toBe(true);
    if (!dirs.ok) return;
    expect(samePath(dirs.common, join(other, ".git"))).toBe(true);
  });

  test("outside git it keeps git's own words", () => {
    const root = scratch();
    const plain = join(root, "plain");
    mkdirSync(plain);
    const dirs = gitCommonDirOf(plain, { env: { ...process.env, GIT_CEILING_DIRECTORIES: root, LC_ALL: "C" } });
    expect(dirs.ok).toBe(false);
    if (dirs.ok) return;
    expect(dirs.stderr).toMatch(/not a git repository/i);
  });
});

// Each file here still passes one of the two to git itself, at most this many
// times, and why; the fix that moves a read onto the owner lowers its count.
const NOT_YET_ON_THE_OWNER: Record<string, { reads: number; why: string }> = {
  "core/tools/aidlc-unit.ts": { reads: 1, why: "assertMainCheckout resolves the common dir against the top" },
  "core/tools/aidlc-lib.ts": { reads: 1, why: "isWalkingSkeletonUnitOnMain resolves the common dir against the top" },
  "core/tools/aidlc-orchestrate.ts": { reads: 1, why: "handleTeamBoard resolves the common dir against the top" },
  "core/tools/aidlc-runtime-paths.ts": { reads: 2, why: "findHostWorktree; the file imports node builtins only" },
  "core/tools/aidlc-worktree.ts": {
    reads: 3,
    why: "assertNotSiblingWorktree and gitCommonDirRealpath resolve the common dir against the top",
  },
};
// Work not on main yet that reads them itself, on top of the counts above:
// the line a project below its repository's top is told when team work cannot
// run there, and the team Units work; each moves onto the owner or goes before
// that work is done.
const IN_FLIGHT: Record<string, number> = {
  "core/tools/aidlc-unit.ts": 1,
  "core/tools/aidlc-unit-teams.ts": 2,
  "core/hooks/aidlc-session-start.ts": 1,
};
const OWNER = "core/tools/aidlc-git.ts";
const FLAGS = new Set(["--show-prefix", "--git-common-dir"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

// How often the two flags are a string git is given (a literal, never a
// comment). The parse runs only on a file that names one at all.
function flagReads(text: string, name: string): number {
  if (![...FLAGS].some((flag) => text.includes(flag))) return 0;
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let reads = 0;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && FLAGS.has(node.text)) reads++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

describe("one owner for the project's place in its repository", () => {
  const files = [...sourceFiles(join(REPO_ROOT, "core")), ...sourceFiles(join(REPO_ROOT, "harness"))]
    .map((path) => relative(REPO_ROOT, path).replaceAll("\\", "/"));

  const reads = (file: string): number => flagReads(readFileSync(join(REPO_ROOT, file), "utf-8"), file);

  test("the owner reads both, so the scan sees them", () => {
    expect(reads(OWNER)).toBe(2);
  });

  test("no other file reads --show-prefix or --git-common-dir, and a listed one no more than it does now", () => {
    const over = files
      .filter((file) => file !== OWNER)
      .map((file) => ({ file, reads: reads(file) }))
      .filter(({ file, reads }) => reads > (NOT_YET_ON_THE_OWNER[file]?.reads ?? 0) + (IN_FLIGHT[file] ?? 0));
    expect(over).toEqual([]);
  });

  test("every file on the list still reads one, so the list only shrinks", () => {
    const stale = Object.keys(NOT_YET_ON_THE_OWNER).filter((file) => reads(file) === 0);
    expect(stale).toEqual([]);
  });
});
