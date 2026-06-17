// covers: subcommand:aidlc-worktree:create, subcommand:aidlc-worktree:merge, subcommand:aidlc-swarm:prepare, function:resolveConstructionRepo, function:repoDir, function:intentRepos
//
// Mechanism: cli (spawned dist tools) + real git. P7 — multi-repo construction:
// `aidlc-worktree create/merge` thread `--repo <name>` so `git worktree add` and
// the sibling-worktree guard anchor to the TARGET sibling repo, not the (non-git)
// workspace root. Decouples "the repo to operate on" from "the single projectDir".
//
// WHY cli + real git: the subject IS where `git worktree add` runs. The only way
// to prove the worktree forked inside repo-a (and not repo-b, and not the
// non-git workspace root) is to run the real tool against real sibling git repos
// and inspect which repo's ref namespace gained the `bolt-<slug>` branch. An
// in-process twin would re-stage the cwd choice that is the whole point.
//
// FIXTURE: each scenario gets a FRESH workspace (createTestProject). The workspace
// root is NOT a git repo (the multi-repo model — there is no privileged repo to
// host the framework). Sibling code repos (`repo-a/`, `repo-b/`) are immediate
// children, each its own git on `main`. The intent's repo set is captured by
// spawning the real `intent-birth --repos ...` handler, which sets the
// active-intent cursor + writes intents.json.repos — exactly what the
// construction-path repo resolution reads. All temp dirs cleaned in afterAll.
//
// TIMEOUT DISCIPLINE (mirrors t78): the heavy tool spawns (intent-birth runs the
// full scope→stage state build; git init/commit per repo) run at the DESCRIBE-body
// level, NOT inside test() — so the 5s per-test default only ever wraps the cheap
// assertions, never the multi-second setup chain.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const WT_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const SWARM_TOOL = join(AIDLC_SRC, "tools", "aidlc-swarm.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface RunResult {
  status: number;
  out: string;
  stdout: string;
}

function runUtil(proj: string, ...args: string[]): RunResult {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], { encoding: "utf-8", env });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

/** Spawn aidlc-worktree from the WORKSPACE root (the conductor's cwd — NOT a git repo). */
function runWorktree(proj: string, ...args: string[]): RunResult {
  const r = spawnSync(BUN, [WT_TOOL, ...args, "--project-dir", proj], { encoding: "utf-8", cwd: proj });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

/** Spawn aidlc-swarm `prepare` from the WORKSPACE root (the conductor's cwd). */
function runSwarm(proj: string, ...args: string[]): RunResult {
  const r = spawnSync(BUN, [SWARM_TOOL, ...args, "--project-dir", proj], { encoding: "utf-8", cwd: proj });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

function git(cwd: string, ...args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A fresh workspace root (NOT a git repo). */
function freshWorkspace(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  return proj;
}

/** Create a sibling code repo `<proj>/<name>/` with its own git on `main` + one commit. */
function makeSiblingRepo(proj: string, name: string): string {
  const dir = join(proj, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** True iff branch `bolt-<slug>` exists in the repo at `<proj>/<name>`. */
function hasBoltBranch(proj: string, repoName: string, slug: string): boolean {
  return git(join(proj, repoName), "rev-parse", "--verify", `refs/heads/bolt-${slug}`).status === 0;
}

const worktreeDir = (proj: string, slug: string): string =>
  join(proj, ".aidlc", "worktrees", `bolt-${slug}`);

describe("t166 P7 multi-repo construction — --repo anchors the worktree to the sibling repo", () => {
  // ===========================================================================
  // Multi-repo intent: create --repo repo-a forks inside repo-a (and only it).
  // ===========================================================================
  describe("multi-repo: create --repo targets the named sibling repo", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    const birth = runUtil(proj, "intent-birth", "--scope", "feature", "--repos", "repo-a,repo-b");
    const created = runWorktree(proj, "create", "--slug", "alpha", "--base", "main", "--repo", "repo-a");

    test("birth records the two-repo set", () => {
      expect(birth.status).toBe(0);
    });
    test("create --repo repo-a exits 0 and produces the worktree dir", () => {
      expect(created.status).toBe(0);
      expect(existsSync(worktreeDir(proj, "alpha"))).toBe(true);
    });
    test("the bolt branch lives in repo-a's ref namespace, NOT repo-b's", () => {
      // Only true if `git worktree add` ran with cwd = repo-a (the P7 re-anchor),
      // not the workspace root or repo-b.
      expect(hasBoltBranch(proj, "repo-a", "alpha")).toBe(true);
      expect(hasBoltBranch(proj, "repo-b", "alpha")).toBe(false);
    });
  });

  describe("multi-repo: create WITHOUT --repo is refused (disambiguation required)", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-birth", "--scope", "feature", "--repos", "repo-a,repo-b");
    const created = runWorktree(proj, "create", "--slug", "beta", "--base", "main");

    test("exits non-zero with a 'spans N repos' message", () => {
      expect(created.status).not.toBe(0);
      expect(created.out).toContain("spans 2 repos");
    });
    test("no branch leaked into either repo", () => {
      expect(hasBoltBranch(proj, "repo-a", "beta")).toBe(false);
      expect(hasBoltBranch(proj, "repo-b", "beta")).toBe(false);
    });
  });

  describe("multi-repo: --repo outside the intent's set is refused", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-birth", "--scope", "feature", "--repos", "repo-a,repo-b");
    const created = runWorktree(proj, "create", "--slug", "gamma", "--base", "main", "--repo", "repo-c");

    test("exits non-zero with a 'not in this intent's repo set' message", () => {
      expect(created.status).not.toBe(0);
      expect(created.out).toContain("not in this intent's repo set");
    });
  });

  describe("multi-repo: merge --repo lands the squash commit in the right repo", () => {
    const proj = freshWorkspace();
    const repoA = makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-birth", "--scope", "feature", "--repos", "repo-a,repo-b");
    runWorktree(proj, "create", "--slug", "delta", "--base", "main", "--repo", "repo-a");
    // Make a commit on the bolt branch IN THE WORKTREE so the squash has content.
    const wt = worktreeDir(proj, "delta");
    writeFileSync(join(wt, "feature.txt"), "unit work\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "unit work");
    const before = git(repoA, "rev-parse", "main").out.trim();
    const merged = runWorktree(
      proj, "merge", "--slug", "delta", "--target", "main", "--strategy", "squash", "--repo", "repo-a",
    );
    const after = git(repoA, "rev-parse", "main").out.trim();

    test("merge --repo repo-a exits 0", () => {
      expect(merged.status).toBe(0);
    });
    test("repo-a's main advanced (the squash commit landed there)", () => {
      expect(after).not.toBe(before);
      expect(git(repoA, "cat-file", "-e", `${after}:feature.txt`).status).toBe(0);
    });
    test("the worktree + bolt branch are cleaned up in repo-a", () => {
      expect(existsSync(wt)).toBe(false);
      expect(hasBoltBranch(proj, "repo-a", "delta")).toBe(false);
    });
  });

  // ===========================================================================
  // Single-repo intent: the lone repo is inferred — no --repo needed.
  // ===========================================================================
  describe("single-repo intent infers the lone repo", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "solo");
    runUtil(proj, "intent-birth", "--scope", "feature", "--repos", "solo");
    const inferred = runWorktree(proj, "create", "--slug", "epsilon", "--base", "main");
    const explicit = runWorktree(proj, "create", "--slug", "zeta", "--base", "main", "--repo", "solo");

    test("create WITHOUT --repo forks inside the one recorded repo", () => {
      expect(inferred.status).toBe(0);
      expect(hasBoltBranch(proj, "solo", "epsilon")).toBe(true);
    });
    test("create --repo matching the lone repo is also accepted", () => {
      expect(explicit.status).toBe(0);
      expect(hasBoltBranch(proj, "solo", "zeta")).toBe(true);
    });
  });

  // ===========================================================================
  // Legacy single-repo: the workspace root IS the git repo, no repos recorded.
  // --repo is unnecessary; git runs in the projectDir cwd (today's behaviour).
  // ===========================================================================
  describe("legacy single-repo (projectDir is the git repo)", () => {
    const proj = freshWorkspace();
    // The workspace root itself is the git repo (the pre-multi-repo layout).
    git(proj, "init", "-q", "-b", "main");
    git(proj, "config", "user.email", "t@t");
    git(proj, "config", "user.name", "t");
    git(proj, "commit", "-q", "-m", "init", "--allow-empty");
    // Birth with NO --repos and no sibling repos → no repos row recorded.
    const birth = runUtil(proj, "intent-birth", "--scope", "poc");
    const created = runWorktree(proj, "create", "--slug", "legacy", "--base", "main");

    test("birth records no repos row", () => {
      expect(birth.status).toBe(0);
    });
    test("create WITHOUT --repo works (cwd = projectDir, back-compat)", () => {
      expect(created.status).toBe(0);
      // The bolt branch lives in the workspace-root repo.
      expect(git(proj, "rev-parse", "--verify", "refs/heads/bolt-legacy").status).toBe(0);
      expect(existsSync(worktreeDir(proj, "legacy"))).toBe(true);
    });
  });

  // ===========================================================================
  // M1 — the SWARM PREPARE path resolves the target sibling repo. `prepare` is
  // the conductor-facing seam the engine's invoke-swarm directive feeds: it forks
  // a worktree per unit via `aidlc-worktree create`, so the per-unit bolt branch
  // is `bolt-<unit>` (verified: aidlc-swarm.ts:387 forwards `--slug <unit>` +
  // `--repo <resolved>` to create). On a multi-repo intent, prepare WITHOUT --repo
  // dead-ends (resolveConstructionRepo throws "spans 2 repos") — proving --repo is
  // what resolves the dead-end M1 fixes the engine side of.
  // ===========================================================================
  describe("M1 multi-repo: swarm prepare --repo forks the batch inside the target sibling repo", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-birth", "--scope", "feature", "--repos", "repo-a,repo-b");
    const prepared = runSwarm(
      proj, "prepare", "--batch", "1", "--units", "swarmunit", "--base", "main", "--repo", "repo-a",
    );

    test("prepare --repo repo-a exits 0 and forks the worktree", () => {
      expect(prepared.status).toBe(0);
      expect(existsSync(worktreeDir(proj, "swarmunit"))).toBe(true);
    });
    test("the bolt branch lives in repo-a's ref namespace, NOT repo-b's", () => {
      // Only true if prepare resolved --repo and threaded it into create's cwd.
      expect(hasBoltBranch(proj, "repo-a", "swarmunit")).toBe(true);
      expect(hasBoltBranch(proj, "repo-b", "swarmunit")).toBe(false);
    });
  });

  describe("M1 multi-repo: swarm prepare WITHOUT --repo dead-ends (the bug --repo fixes)", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-birth", "--scope", "feature", "--repos", "repo-a,repo-b");
    const prepared = runSwarm(proj, "prepare", "--batch", "1", "--units", "orphanunit", "--base", "main");

    test("exits non-zero with a 'spans 2 repos' message", () => {
      expect(prepared.status).not.toBe(0);
      expect(prepared.out).toContain("spans 2 repos");
    });
    test("no worktree or branch leaked into either repo", () => {
      expect(existsSync(worktreeDir(proj, "orphanunit"))).toBe(false);
      expect(hasBoltBranch(proj, "repo-a", "orphanunit")).toBe(false);
      expect(hasBoltBranch(proj, "repo-b", "orphanunit")).toBe(false);
    });
  });
});
