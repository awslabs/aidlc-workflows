// t255-workspace-sync: aidlc-workspace-sync reconciles a workspace root against
// an optional repos.json manifest, idempotently and without ever destroying work.
//
// covers: file:core/tools/aidlc-workspace-sync.ts
//
// The orphan-safety coverage is the load-bearing part: a reconcile tool that
// clones and removes sibling repos must never delete unrecoverable work.
//
// WHAT. `bun aidlc-workspace-sync.ts --project-dir <root>` reads <root>/repos.json
// and (1) regenerates the managed .gitignore block to /{name}/ lines, (2) writes
// aidlc.code-workspace listing "." + each child repo, (3) leaves child repos
// already on disk untouched. This test drives the real tool as a subprocess
// against a throwaway workspace and asserts those outputs + idempotency + the
// preserve-outside-the-gates contract + the no-manifest error exit.
//
// Clone and orphan-safety paths use local bare remotes, so branch selection,
// multi-clone rollback, live-ref/object verification, and corrupt-remote
// rejection all run offline. Stub dirs with only a .git subdir remain useful for
// non-destructive keep/render cases, while every removal case uses real repos.
// Mechanism: subprocess spawn of bun; zero LLM.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspaceManifest } from "../../core/tools/aidlc-workspace-manifest.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "core", "tools", "aidlc-workspace-sync.ts");
const BUN = process.execPath;
const CODE_WORKSPACE_NAME = "aidlc.code-workspace";

// Hermetic git env for the throwaway fixtures. A developer's global/system git
// config can carry a `core.hooksPath` pre-push hook (corp tooling), credential
// helpers, and push defaults that stall or reshape the offline push in
// makeRepo. Neutralize global + system config and disable interactive prompts
// so every git call the fixtures (and the tool subprocess) make is deterministic
// and offline. Threaded into the tool's env too so its internal git calls are
// equally hermetic.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

// A workspace with the two example repos ALREADY on disk (so no clone runs),
// plus whatever repos.json body the caller supplies.
function freshWorkspace(manifest: string, presentRepos = ["checkout-api", "checkout-web"]): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t255-"));
  tmpRoots.push(dir);
  writeFileSync(join(dir, "repos.json"), manifest, "utf-8");
  for (const name of presentRepos) {
    mkdirSync(join(dir, name, ".git"), { recursive: true }); // looks like a clone
  }
  return dir;
}

// A workspace with only repos.json - no pre-created repo dirs. Use with
// makeRepo() to build real git checkouts for preflight-gate tests.
function freshRealWorkspace(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t255-real-"));
  tmpRoots.push(dir);
  writeFileSync(join(dir, "repos.json"), manifest, "utf-8");
  return dir;
}

// Run the sync tool against a workspace root, with optional extra args (e.g.
// ["--force"]). The workspace root is passed explicitly via --project-dir so the
// tool resolves it deterministically regardless of the harness's own layout.
function runSync(
  root: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = GIT_ENV,
): { status: number; out: string } {
  const r = spawnSync(BUN, [SCRIPT, "--project-dir", root, ...args], {
    cwd: root,
    encoding: "utf-8",
    env,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function runSyncAsync(
  root: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = GIT_ENV,
): Promise<{ status: number; out: string }> {
  const child = Bun.spawn([BUN, SCRIPT, "--project-dir", root, ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const [status, out, err] = await Promise.all([child.exited, stdout, stderr]);
  return { status, out: `${out}${err}` };
}

// Low-level git helper - throws on non-zero exit.
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

// Create a real git checkout at <ws>/<name>. Bare remotes are placed in a
// separate mkdtemp dir OUTSIDE the workspace so sibling discovery (which scans
// the workspace root for dirs with a .git child) never picks them up as orphans.
// If withRemote is true, create a local bare repo as origin and push <branch>
// so the repo is "fully pushed" (recoverable by --force). Local files + local
// bare remote => fully offline.
function makeRepo(
  ws: string,
  name: string,
  opts: { branch?: string; withRemote?: boolean } = {},
): string {
  const { branch = "main", withRemote = true } = opts;
  const dir = join(ws, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t255@example.com");
  git(dir, "config", "user.name", "t255");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`, "utf-8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  if (withRemote) {
    // Bare remote lives in a separate temp dir, never inside ws, so it's never
    // discovered as an orphan checkout by sibling discovery.
    const bareRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-bare-"));
    tmpRoots.push(bareRoot);
    const bare = join(bareRoot, `${name}.git`);
    mkdirSync(bare, { recursive: true });
    spawnSync("git", ["init", "-q", "--bare", bare], { encoding: "utf-8", env: GIT_ENV });
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "-u", "origin", branch);
    // `push -u` sets upstream tracking but does NOT set refs/remotes/origin/HEAD,
    // which detectDefaultBranch() reads. Seed it explicitly so detection tests
    // exercise the real detection path (not the null-skip path). Seeding the
    // symbolic ref directly is more deterministic than `git remote set-head`.
    git(
      dir,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${branch}`,
    );
  }
  return dir;
}

function slowGitEnv(signalPath: string): NodeJS.ProcessEnv {
  const shimRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-git-shim-"));
  tmpRoots.push(shimRoot);
  const shim = join(shimRoot, "git");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf-8",
    env: GIT_ENV,
  }).stdout.trim();
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'if [ "$1" = "clone" ]; then',
      '  : > "$AIDLC_TEST_CLONE_STARTED"',
      "  sleep 1",
      "fi",
      'exec "$AIDLC_TEST_REAL_GIT" "$@"',
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(shim, 0o755);
  return {
    ...GIT_ENV,
    PATH: `${shimRoot}:${process.env.PATH ?? ""}`,
    AIDLC_TEST_CLONE_STARTED: signalPath,
    AIDLC_TEST_REAL_GIT: realGit,
  };
}

function quarantineGitEnv(signalPath: string): NodeJS.ProcessEnv {
  const shimRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-git-shim-"));
  tmpRoots.push(shimRoot);
  const shim = join(shimRoot, "git");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf-8",
    env: GIT_ENV,
  }).stdout.trim();
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'case "$(pwd -P)" in',
      '  *".aidlc-workspace-sync-txn-"*"/orphans/"*)',
      '    if [ "$1" = "-c" ] && [ "$3" = "status" ]; then',
      '      : > "$AIDLC_TEST_QUARANTINE_STARTED"',
      "      sleep 1",
      "    fi",
      "    ;;",
      "esac",
      'exec "$AIDLC_TEST_REAL_GIT" "$@"',
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(shim, 0o755);
  return {
    ...GIT_ENV,
    PATH: `${shimRoot}:${process.env.PATH ?? ""}`,
    AIDLC_TEST_QUARANTINE_STARTED: signalPath,
    AIDLC_TEST_REAL_GIT: realGit,
  };
}

function postProofGitEnv(signalPath: string): NodeJS.ProcessEnv {
  const shimRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-git-shim-"));
  tmpRoots.push(shimRoot);
  const shim = join(shimRoot, "git");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf-8",
    env: GIT_ENV,
  }).stdout.trim();
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'case "$(pwd -P)" in',
      '  *".aidlc-workspace-sync-txn-"*"/orphans/"*)',
      '    if [ "$1" = "fsck" ]; then',
      '      "$AIDLC_TEST_REAL_GIT" "$@"',
      "      status=$?",
      '      : > "$AIDLC_TEST_FINAL_PROOF_DONE"',
      "      sleep 1",
      '      exit "$status"',
      "    fi",
      "    ;;",
      "esac",
      'exec "$AIDLC_TEST_REAL_GIT" "$@"',
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(shim, 0o755);
  return {
    ...GIT_ENV,
    PATH: `${shimRoot}:${process.env.PATH ?? ""}`,
    AIDLC_TEST_FINAL_PROOF_DONE: signalPath,
    AIDLC_TEST_REAL_GIT: realGit,
  };
}

async function waitForPath(path: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

const MANIFEST = `{
  // starter
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" },
    { "name": "checkout-web", "branch": "main" }
  ]
}
`;

describe("t255 workspace-sync - reconcile checkout against repos.json", () => {
  test("JSON comments do not rewrite comment-like content inside strings", () => {
    const manifest = parseWorkspaceManifest(`{
      // a real comment
      "org": "acme",
      "repos": [{
        "name": "checkout-api",
        "url": "https://example.com/a/*literal*/checkout-api.git" /* inline */
      }]
    }`);
    expect(manifest.repos[0].url).toBe(
      "https://example.com/a/*literal*/checkout-api.git",
    );
  });

  test("writes aidlc.code-workspace listing the root plus each child repo", () => {
    const ws = freshWorkspace(MANIFEST);
    expect(runSync(ws).status).toBe(0);
    const cw = JSON.parse(readFileSync(join(ws, "aidlc.code-workspace"), "utf-8"));
    expect(cw.folders).toEqual([
      { path: "." },
      { path: "checkout-api" },
      { path: "checkout-web" },
    ]);
  });

  test("writes a managed .gitignore block of /{name}/ entries", () => {
    const ws = freshWorkspace(MANIFEST);
    expect(runSync(ws).status).toBe(0);
    const gi = readFileSync(join(ws, ".gitignore"), "utf-8");
    expect(gi).toContain("# >>> aidlc workspace-sync managed");
    expect(gi).toContain("\n/.aidlc-workspace-sync-recovery-*/\n");
    expect(gi).toContain("\n/checkout-api/\n");
    expect(gi).toContain("\n/checkout-web/\n");
    expect(gi).toContain("# <<< aidlc workspace-sync managed <<<");
  });

  test("is idempotent and preserves hand-owned lines outside the gates", () => {
    const ws = freshWorkspace(MANIFEST);
    expect(runSync(ws).status).toBe(0);
    // A human appends their own ignore rule after the managed block.
    const giPath = join(ws, ".gitignore");
    writeFileSync(giPath, `${readFileSync(giPath, "utf-8")}\n# mine\n*.log\n`, "utf-8");
    const afterEdit = readFileSync(giPath, "utf-8");
    // Re-run: managed block unchanged, hand-owned lines survive.
    expect(runSync(ws).status).toBe(0);
    const afterRerun = readFileSync(giPath, "utf-8");
    expect(afterRerun).toBe(afterEdit);
    expect(afterRerun).toContain("# mine\n*.log\n");
  });

  test("replaced generated files are retained for recovery", () => {
    const ws = freshWorkspace(MANIFEST);
    expect(runSync(ws).status).toBe(0);
    const oldGitignore = readFileSync(join(ws, ".gitignore"), "utf-8");
    const oldWorkspace = readFileSync(join(ws, CODE_WORKSPACE_NAME), "utf-8");
    writeFileSync(
      join(ws, "repos.json"),
      `{
  "org": "acme",
  "repos": [
    { "name": "checkout-web", "branch": "main" },
    { "name": "checkout-api", "branch": "main" }
  ]
}`,
      "utf-8",
    );

    expect(runSync(ws).status).toBe(0);
    const recovery = readdirSync(ws).find((name) =>
      name.startsWith(".aidlc-workspace-sync-recovery-"),
    );
    expect(recovery).toBeDefined();
    const backups = join(ws, recovery!, "generated-file-backups");
    expect(readFileSync(join(backups, "gitignore"), "utf-8")).toBe(oldGitignore);
    expect(readFileSync(join(backups, CODE_WORKSPACE_NAME), "utf-8")).toBe(
      oldWorkspace,
    );
  });

  test("leaves a child repo that is already on disk untouched (no re-clone)", () => {
    const ws = freshWorkspace(MANIFEST);
    // Sentinel inside an existing repo dir - survives iff sync does not touch it.
    writeFileSync(join(ws, "checkout-api", "sentinel.txt"), "keep me", "utf-8");
    const r = runSync(ws);
    expect(r.status).toBe(0);
    expect(r.out).toContain("already on disk");
    expect(readFileSync(join(ws, "checkout-api", "sentinel.txt"), "utf-8")).toBe("keep me");
  });

  test("exits non-zero with a clear message when repos.json is missing", () => {
    const ws = mkdtempSync(join(tmpdir(), "aidlc-t255-nomani-"));
    tmpRoots.push(ws);
    const r = runSync(ws);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("repos.json");
  });

  test("fails clearly when a child dir exists but is not a git checkout", () => {
    // Present dir with NO .git - a broken state sync must not silently accept.
    const ws = freshWorkspace(MANIFEST, []);
    mkdirSync(join(ws, "checkout-api"), { recursive: true });
    const r = runSync(ws);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("not a git checkout");
  });

  // --- Preflight gate: orphan detection, dirty/unpushed refusal, branch warns ---

  test("orphan clean+pushed BLOCKS without --force", () => {
    // repos.json lists only checkout-api; checkout-web is a real clean+pushed
    // orphan. Without --force the tool must refuse and make zero changes.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api");
    makeRepo(ws, "checkout-web");

    const r = runSync(ws);
    expect(r.status).not.toBe(0);
    // Tool prints the orphan's name and the --force hint
    expect(r.out).toContain("checkout-web");
    expect(r.out).toContain("--force");
    // Orphan dir was NOT removed (atomic: no changes made)
    expect(existsSync(join(ws, "checkout-web"))).toBe(true);
    // aidlc.code-workspace was NOT created (mutation did not happen)
    expect(existsSync(join(ws, "aidlc.code-workspace"))).toBe(false);
  });

  test("orphan clean+pushed is removed from the active set and retained for recovery", () => {
    // Same setup as above; with --force the tool removes the orphan and
    // succeeds, writing .gitignore + aidlc.code-workspace for manifest repos only.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api");
    makeRepo(ws, "checkout-web");

    const r = runSync(ws, ["--force"]);
    expect(r.status).toBe(0);
    // Orphan was removed from the active sibling path.
    expect(existsSync(join(ws, "checkout-web"))).toBe(false);
    const recovery = readdirSync(ws).find((name) =>
      name.startsWith(".aidlc-workspace-sync-recovery-"),
    );
    expect(recovery).toBeDefined();
    expect(
      readFileSync(join(ws, recovery!, "checkout-web", "README.md"), "utf-8"),
    ).toContain("# checkout-web");
    // .gitignore managed block lists only the manifest repo
    const gi = readFileSync(join(ws, ".gitignore"), "utf-8");
    expect(gi).toContain("/checkout-api/");
    expect(gi).not.toContain("/checkout-web/");
    // aidlc.code-workspace contains only root + manifest repo
    const cw = JSON.parse(readFileSync(join(ws, "aidlc.code-workspace"), "utf-8"));
    expect(cw.folders).toEqual([{ path: "." }, { path: "checkout-api" }]);
  });

  test("dirty orphan BLOCKS even with --force", () => {
    // checkout-web is an orphan with an uncommitted file - dirty state means
    // it cannot be auto-removed even under --force (unrecoverable).
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api");
    makeRepo(ws, "checkout-web");
    // Make checkout-web dirty: add an untracked file
    writeFileSync(join(ws, "checkout-web", "dirty.txt"), "uncommitted change", "utf-8");

    const r = runSync(ws, ["--force"]);
    expect(r.status).not.toBe(0);
    // Dir survives
    expect(existsSync(join(ws, "checkout-web"))).toBe(true);
    // Output names the repo and signals a dirty/uncommitted reason
    expect(r.out).toContain("checkout-web");
    expect(r.out).toContain("dirty working tree");
  });

  test("unpushed orphan BLOCKS even with --force", () => {
    // checkout-web has commits not yet pushed to origin - unrecoverable, so
    // --force must still refuse.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api");
    makeRepo(ws, "checkout-web");
    // Add a commit that is NOT pushed to origin
    writeFileSync(join(ws, "checkout-web", "extra.md"), "unpushed", "utf-8");
    git(join(ws, "checkout-web"), "add", "-A");
    git(join(ws, "checkout-web"), "commit", "-q", "-m", "unpushed commit");

    const r = runSync(ws, ["--force"]);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(ws, "checkout-web"))).toBe(true);
    expect(r.out).toContain("checkout-web");
    expect(r.out).toContain("unpushed commits");
  });

  test("branch mismatch exits 2 (synced-with-warnings) and does not switch branch", () => {
    // checkout-api is on feature/x but the manifest's branch is main - advisory
    // only; run must exit 2 (applied-with-warnings) and leave the branch as-is.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    // Init on feature/x so current branch != the manifest's branch
    makeRepo(ws, "checkout-api", { branch: "feature/x" });

    const r = runSync(ws);
    expect(r.status).toBe(2);
    // Output contains a branch advisory naming both branches
    expect(r.out).toContain("feature/x");
    expect(r.out).toContain("main");
    // The advisory names its source: repos.json (the explicit branch is set).
    expect(r.out).toContain("repos.json");
    // Output contains the honest final line
    expect(r.out).toContain("NOT fully in sync");
    // The warning/yellow path is also escape-free when captured (non-TTY) - this
    // exercises the color gate on the exit-2 path, not just the green success path.
    expect(r.out).not.toContain("\x1b[");
    // Branch was NOT switched - repo is still on feature/x
    const head = git(join(ws, "checkout-api"), "rev-parse", "--abbrev-ref", "HEAD");
    expect(head).toBe("feature/x");
  });

  test("detached-HEAD orphan with unpushed commit BLOCKS even with --force", () => {
    // Regression test for the detached-HEAD data-loss hole.
    // Build a clean+pushed orphan (all branches fully pushed), then detach HEAD
    // and make an extra commit reachable only from HEAD (no branch points to it).
    // Under a naive `--branches` query that commit is invisible → wrongly removed.
    // Under the `--branches HEAD` query it is caught → blocks as expected.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api");
    makeRepo(ws, "checkout-web"); // orphan: pushed+clean so far

    const webDir = join(ws, "checkout-web");
    // Detach HEAD (still pointing at the pushed commit - clean, no unpushed branches)
    git(webDir, "checkout", "--detach");
    // Now make a commit reachable only from HEAD (no branch)
    writeFileSync(join(webDir, "detached.md"), "detached-head commit", "utf-8");
    git(webDir, "add", "-A");
    git(webDir, "commit", "-q", "-m", "detached HEAD commit not on any branch");

    const r = runSync(ws, ["--force"]);
    expect(r.status).not.toBe(0);
    // Orphan dir MUST survive - the detached commit would be destroyed otherwise
    expect(existsSync(join(ws, "checkout-web"))).toBe(true);
    // Output names the repo and the unpushed reason
    expect(r.out).toContain("checkout-web");
    expect(r.out).toContain("unpushed commits");
  });

  test("stashed orphan BLOCKS even with --force", () => {
    // checkout-web is an orphan that is clean+pushed on its branch, but has a
    // stash entry. Stashed work is local-only and not recoverable from remote,
    // so --force must still refuse.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api");
    makeRepo(ws, "checkout-web");

    const webDir = join(ws, "checkout-web");
    // Modify a tracked file and stash it - working tree is clean but stash list is non-empty
    writeFileSync(join(webDir, "README.md"), "stashed change\n", "utf-8");
    git(webDir, "stash");

    const r = runSync(ws, ["--force"]);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(ws, "checkout-web"))).toBe(true);
    expect(r.out).toContain("checkout-web");
    expect(r.out).toContain("stashed changes");
  });

  test("ignored, config-hidden, and index-hidden files BLOCK --force removal", () => {
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`;

    const ignoredWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ignoredWs, "checkout-api");
    const ignoredRepo = makeRepo(ignoredWs, "checkout-web");
    writeFileSync(join(ignoredRepo, ".gitignore"), "secret.env\n", "utf-8");
    git(ignoredRepo, "add", ".gitignore");
    git(ignoredRepo, "commit", "-q", "-m", "ignore local secret");
    git(ignoredRepo, "push", "-q", "origin", "main");
    writeFileSync(join(ignoredRepo, "secret.env"), "do not delete\n", "utf-8");
    const ignored = runSync(ignoredWs, ["--force"]);
    expect(ignored.status).toBe(1);
    expect(ignored.out).toContain("ignored files");
    expect(existsSync(join(ignoredRepo, "secret.env"))).toBe(true);

    const hiddenWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(hiddenWs, "checkout-api");
    const hiddenRepo = makeRepo(hiddenWs, "checkout-web");
    git(hiddenRepo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(hiddenRepo, ".hidden-local"), "do not delete\n", "utf-8");
    const hidden = runSync(hiddenWs, ["--force"]);
    expect(hidden.status).toBe(1);
    expect(hidden.out).toContain("dirty working tree");
    expect(existsSync(join(hiddenRepo, ".hidden-local"))).toBe(true);

    const indexWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(indexWs, "checkout-api");
    const indexRepo = makeRepo(indexWs, "checkout-web");
    git(indexRepo, "update-index", "--assume-unchanged", "README.md");
    writeFileSync(join(indexRepo, "README.md"), "hidden tracked edit\n", "utf-8");
    const indexHidden = runSync(indexWs, ["--force"]);
    expect(indexHidden.status).toBe(1);
    expect(indexHidden.out).toContain("assume-unchanged");
    expect(readFileSync(join(indexRepo, "README.md"), "utf-8")).toBe(
      "hidden tracked edit\n",
    );
  });

  test("empty untracked directories BLOCK --force removal", () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web");
    mkdirSync(join(orphan, "local-empty-dir"));

    const result = runSync(ws, ["--force"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("untracked filesystem entries");
    expect(existsSync(join(orphan, "local-empty-dir"))).toBe(true);
  });

  test("live remote queries reject stale refs, local tags, and reflog-only commits", () => {
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`;

    const staleWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(staleWs, "checkout-api");
    const staleRepo = makeRepo(staleWs, "checkout-web");
    const staleRemote = git(staleRepo, "remote", "get-url", "origin");
    git(staleRemote, "update-ref", "-d", "refs/heads/main");
    const stale = runSync(staleWs, ["--force"]);
    expect(stale.status).toBe(1);
    expect(stale.out).toContain("live remotes");
    expect(existsSync(staleRepo)).toBe(true);

    const tagWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(tagWs, "checkout-api");
    const tagRepo = makeRepo(tagWs, "checkout-web");
    git(tagRepo, "tag", "local-release");
    const tag = runSync(tagWs, ["--force"]);
    expect(tag.status).toBe(1);
    expect(tag.out).toContain("refs/tags/local-release");
    expect(existsSync(tagRepo)).toBe(true);

    const reflogWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(reflogWs, "checkout-api");
    const reflogRepo = makeRepo(reflogWs, "checkout-web");
    writeFileSync(join(reflogRepo, "only-in-reflog"), "local commit\n", "utf-8");
    git(reflogRepo, "add", "only-in-reflog");
    git(reflogRepo, "commit", "-q", "-m", "local then reset");
    git(reflogRepo, "reset", "-q", "--hard", "origin/main");
    const reflog = runSync(reflogWs, ["--force"]);
    expect(reflog.status).toBe(1);
    expect(reflog.out).toContain("reflog-only commits");
    expect(existsSync(reflogRepo)).toBe(true);
  });

  test("a tracking ref whose server-side branch vanished BLOCKS removal", () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web");
    git(orphan, "checkout", "-q", "-b", "remote-only");
    writeFileSync(join(orphan, "remote-only.txt"), "remote branch\n", "utf-8");
    git(orphan, "add", "remote-only.txt");
    git(orphan, "commit", "-q", "-m", "remote-only branch");
    git(orphan, "push", "-q", "-u", "origin", "remote-only");
    git(orphan, "checkout", "-q", "main");
    git(orphan, "branch", "-D", "remote-only");
    const remote = git(orphan, "remote", "get-url", "origin");
    git(remote, "update-ref", "-d", "refs/heads/remote-only");
    git(orphan, "reflog", "expire", "--expire=now", "--all");

    const result = runSync(ws, ["--force"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("refs/remotes/origin/remote-only");
    expect(existsSync(orphan)).toBe(true);
  });

  test("an advertised ref whose objects cannot be fetched BLOCKS removal", () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web");
    const remote = git(orphan, "remote", "get-url", "origin");

    // Keep refs/heads/main intact so ls-remote still advertises the matching
    // OID, but remove the object store that would make the checkout recoverable.
    rmSync(join(remote, "objects"), { recursive: true, force: true });
    mkdirSync(join(remote, "objects", "info"), { recursive: true });
    mkdirSync(join(remote, "objects", "pack"), { recursive: true });

    const result = runSync(ws, ["--force"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("object graph could not be fetched");
    expect(existsSync(orphan)).toBe(true);
  });

  test("unreachable local Git objects BLOCK removal", () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web");
    const dangling = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: orphan,
      encoding: "utf-8",
      env: GIT_ENV,
      input: "local-only object\n",
    });
    expect(dangling.status).toBe(0);

    const result = runSync(ws, ["--force"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("unreachable local Git objects");
    expect(existsSync(orphan)).toBe(true);
  });

  test("a remote stored inside its checkout cannot authorize deletion", () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web", { withRemote: false });
    git(orphan, "remote", "add", "origin", ".");

    const result = runSync(ws, ["--force"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("stores recovery data inside the checkout");
    expect(existsSync(orphan)).toBe(true);
  });

  test("a local remote whose alternates depend on the orphan BLOCKS removal", () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web", { withRemote: false });
    const externalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-alternate-"));
    tmpRoots.push(externalRoot);
    const remote = join(externalRoot, "remote.git");
    git(externalRoot, "init", "--quiet", "--bare", remote);
    mkdirSync(join(remote, "objects", "info"), { recursive: true });
    writeFileSync(
      join(remote, "objects", "info", "alternates"),
      `${join(orphan, ".git", "objects")}\n`,
      "utf-8",
    );
    mkdirSync(join(remote, "refs", "heads"), { recursive: true });
    writeFileSync(
      join(remote, "refs", "heads", "main"),
      `${git(orphan, "rev-parse", "HEAD")}\n`,
      "utf-8",
    );
    git(orphan, "remote", "add", "origin", remote);

    const result = runSync(ws, ["--force"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("object alternates depend on recovery data");
    expect(existsSync(orphan)).toBe(true);
  });

  test("relative local remote URLs are resolved from the checkout before probing", () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web");
    const absoluteRemote = git(orphan, "remote", "get-url", "origin");
    git(orphan, "remote", "set-url", "origin", relative(orphan, absoluteRemote));

    const result = runSync(ws, ["--force"]);
    expect(result.status).toBe(0);
    expect(existsSync(orphan)).toBe(false);
    expect(
      readdirSync(ws).some((name) =>
        name.startsWith(".aidlc-workspace-sync-recovery-"),
      ),
    ).toBe(true);
  });

  test("secondary worktrees, submodules, and LFS object stores BLOCK removal", () => {
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`;

    const worktreeWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(worktreeWs, "checkout-api");
    const worktreeRepo = makeRepo(worktreeWs, "checkout-web");
    const linkedRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-linked-"));
    tmpRoots.push(linkedRoot);
    git(worktreeRepo, "worktree", "add", "-q", "-b", "secondary", join(linkedRoot, "wt"));
    const worktree = runSync(worktreeWs, ["--force"]);
    expect(worktree.status).toBe(1);
    expect(worktree.out).toContain("secondary linked worktrees");
    expect(existsSync(worktreeRepo)).toBe(true);

    const subSourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const subSource = makeRepo(subSourceWs, "sub-source");
    const subRemote = git(subSource, "remote", "get-url", "origin");
    git(subRemote, "symbolic-ref", "HEAD", "refs/heads/main");
    const submoduleWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(submoduleWs, "checkout-api");
    const submoduleRepo = makeRepo(submoduleWs, "checkout-web");
    git(
      submoduleRepo,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      subRemote,
      "vendor/sub",
    );
    git(submoduleRepo, "commit", "-q", "-am", "add submodule");
    git(submoduleRepo, "push", "-q", "origin", "main");
    const submodule = runSync(submoduleWs, ["--force"]);
    expect(submodule.status).toBe(1);
    expect(submodule.out).toContain("submodule repositories");
    expect(existsSync(submoduleRepo)).toBe(true);

    const lfsWs = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(lfsWs, "checkout-api");
    const lfsRepo = makeRepo(lfsWs, "checkout-web");
    const lfsObject = join(lfsRepo, ".git", "lfs", "objects", "aa", "bb");
    mkdirSync(lfsObject, { recursive: true });
    writeFileSync(join(lfsObject, "local-object"), "not uploaded\n", "utf-8");
    const lfs = runSync(lfsWs, ["--force"]);
    expect(lfs.status).toBe(1);
    expect(lfs.out).toContain("local Git LFS objects");
    expect(existsSync(lfsRepo)).toBe(true);
  });

  test("unsafe, nested, and duplicate manifest names fail before any clone", () => {
    const cases = [
      {
        repos: [{ name: "../escaped", url: "/does/not/matter" }],
        message: "single path segment",
      },
      {
        repos: [{ name: "nested/repo", url: "/does/not/matter" }],
        message: "single path segment",
      },
      {
        repos: [{ name: "same" }, { name: "same" }],
        message: "duplicate repo name",
      },
    ];
    for (const entry of cases) {
      const ws = freshRealWorkspace(
        JSON.stringify({ org: "acme", repos: entry.repos }),
      );
      const escaped = join(ws, "..", "escaped");
      const existedBefore = existsSync(escaped);
      const result = runSync(ws);
      expect(result.status).toBe(1);
      expect(result.out).toContain(entry.message);
      expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(false);
      expect(existsSync(escaped)).toBe(existedBefore);
    }
  });

  test("failed later clone leaves no earlier clone or generated files", () => {
    const sourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const source = makeRepo(sourceWs, "source");
    const remote = git(source, "remote", "get-url", "origin");
    const ws = freshRealWorkspace(
      JSON.stringify({
        org: "acme",
        repos: [
          { name: "checkout-api", branch: "main", url: remote },
          {
            name: "checkout-web",
            branch: "main",
            url: join(sourceWs, "missing.git"),
          },
        ],
      }),
    );
    const result = runSync(ws);
    expect(result.status).toBe(1);
    expect(result.out).toContain("git clone failed for checkout-web");
    expect(existsSync(join(ws, "checkout-api"))).toBe(false);
    expect(existsSync(join(ws, "checkout-web"))).toBe(false);
    expect(existsSync(join(ws, ".gitignore"))).toBe(false);
    expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(false);
  });

  test("a .gitignore edit during a slow clone aborts without losing the edit", async () => {
    const sourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const source = makeRepo(sourceWs, "source");
    const remote = git(source, "remote", "get-url", "origin");
    const ws = freshRealWorkspace(
      JSON.stringify({
        org: "acme",
        repos: [{ name: "checkout-api", branch: "main", url: remote }],
      }),
    );
    const original = "# hand-owned\n";
    writeFileSync(join(ws, ".gitignore"), original, "utf-8");
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "clone-started");
    const running = runSyncAsync(ws, [], slowGitEnv(signal));
    await waitForPath(signal);
    const edited = `${original}# concurrent edit\n`;
    writeFileSync(join(ws, ".gitignore"), edited, "utf-8");

    const result = await running;
    expect(result.status).toBe(1);
    expect(result.out).toContain("changed while workspace-sync was staging");
    expect(readFileSync(join(ws, ".gitignore"), "utf-8")).toBe(edited);
    expect(existsSync(join(ws, "checkout-api"))).toBe(false);
    expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(false);
  });

  test("a repos.json edit during a slow clone invalidates the staged plan", async () => {
    const sourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const source = makeRepo(sourceWs, "source");
    const remote = git(source, "remote", "get-url", "origin");
    const ws = freshRealWorkspace(
      JSON.stringify({
        org: "acme",
        repos: [{ name: "checkout-api", branch: "main", url: remote }],
      }),
    );
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "clone-started");
    const running = runSyncAsync(ws, [], slowGitEnv(signal));
    await waitForPath(signal);
    const edited = '{ "org": "acme", "repos": [] }\n';
    writeFileSync(join(ws, "repos.json"), edited, "utf-8");

    const result = await running;
    expect(result.status).toBe(1);
    expect(result.out).toContain("stale plan was not applied");
    expect(readFileSync(join(ws, "repos.json"), "utf-8")).toBe(edited);
    expect(existsSync(join(ws, "checkout-api"))).toBe(false);
    expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(false);
  });

  test("a recovery-name collision never removes the prior recovery directory", async () => {
    const sourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const source = makeRepo(sourceWs, "source");
    const remote = git(source, "remote", "get-url", "origin");
    const ws = freshRealWorkspace(
      JSON.stringify({
        org: "acme",
        repos: [{ name: "checkout-api", branch: "main", url: remote }],
      }),
    );
    writeFileSync(join(ws, ".gitignore"), "# prior\n", "utf-8");
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "clone-started");
    const running = runSyncAsync(ws, [], slowGitEnv(signal));
    await waitForPath(signal);
    const transaction = readdirSync(ws).find((name) =>
      name.startsWith(".aidlc-workspace-sync-txn-"),
    );
    expect(transaction).toBeDefined();
    const recovery = join(
      ws,
      transaction!.replace(
        ".aidlc-workspace-sync-txn-",
        ".aidlc-workspace-sync-recovery-",
      ),
    );
    mkdirSync(recovery);
    writeFileSync(join(recovery, "prior.txt"), "retain me\n", "utf-8");

    const result = await running;
    expect(result.status).toBe(1);
    expect(readFileSync(join(recovery, "prior.txt"), "utf-8")).toBe("retain me\n");
    expect(readFileSync(join(ws, ".gitignore"), "utf-8")).toBe("# prior\n");
    expect(existsSync(join(ws, "checkout-api"))).toBe(false);
  });

  test("a later install failure rolls back an orphan already moved", async () => {
    const sourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const source = makeRepo(sourceWs, "source");
    const remote = git(source, "remote", "get-url", "origin");
    const ws = freshRealWorkspace(
      JSON.stringify({
        org: "acme",
        repos: [
          { name: "checkout-api", branch: "main", url: remote },
        ],
      }),
    );
    const orphan = makeRepo(ws, "checkout-web");
    writeFileSync(join(ws, ".gitignore"), "# original\n", "utf-8");
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "clone-started");
    const running = runSyncAsync(ws, ["--force"], slowGitEnv(signal));
    await waitForPath(signal);
    const transaction = readdirSync(ws).find((name) =>
      name.startsWith(".aidlc-workspace-sync-txn-"),
    );
    expect(transaction).toBeDefined();
    chmodSync(join(ws, transaction!, "backups"), 0o500);

    const result = await running;
    expect(result.status).toBe(1);
    expect(existsSync(orphan)).toBe(true);
    expect(readFileSync(join(ws, ".gitignore"), "utf-8")).toBe("# original\n");
    expect(existsSync(join(ws, "checkout-api"))).toBe(false);
    expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(false);
  });

  test("a fresh clone checks out the explicitly declared branch", () => {
    const sourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const source = makeRepo(sourceWs, "source");
    git(source, "checkout", "-q", "-b", "develop");
    writeFileSync(join(source, "develop.txt"), "develop\n", "utf-8");
    git(source, "add", "develop.txt");
    git(source, "commit", "-q", "-m", "develop");
    git(source, "push", "-q", "-u", "origin", "develop");
    const remote = git(source, "remote", "get-url", "origin");
    const ws = freshRealWorkspace(
      JSON.stringify({
        org: "acme",
        repos: [
          { name: "checkout-api", branch: "develop", url: remote },
        ],
      }),
    );
    const result = runSync(ws);
    expect(result.status).toBe(0);
    expect(git(join(ws, "checkout-api"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "develop",
    );
    expect(existsSync(join(ws, "checkout-api", "develop.txt"))).toBe(true);
  });

  test("orphan changes during a slow clone abort the transaction", async () => {
    const sourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const source = makeRepo(sourceWs, "source");
    const remote = git(source, "remote", "get-url", "origin");
    const ws = freshRealWorkspace(
      JSON.stringify({
        org: "acme",
        repos: [
          { name: "checkout-api", branch: "main", url: remote },
        ],
      }),
    );
    const orphan = makeRepo(ws, "checkout-web");
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "clone-started");
    const running = runSyncAsync(ws, ["--force"], slowGitEnv(signal));
    await waitForPath(signal);
    writeFileSync(join(orphan, "late-local.txt"), "created during clone\n", "utf-8");
    const result = await running;
    expect(result.status).toBe(1);
    expect(result.out).toContain("changed after preflight");
    expect(existsSync(join(orphan, "late-local.txt"))).toBe(true);
    expect(existsSync(join(ws, "checkout-api"))).toBe(false);
    expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(false);
  });

  test("an open-directory writer during quarantine cannot lose its file", async () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web");
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "quarantine-started");
    const env = quarantineGitEnv(signal);

    // The helper holds cwd open across the checkout rename, then writes into
    // that same inode while the quarantined-tree proof is paused.
    const writer = Bun.spawn(
      [
        "sh",
        "-c",
        'while [ ! -e "$AIDLC_TEST_QUARANTINE_STARTED" ]; do sleep 0.01; done; printf "late local work\\n" > late-local.txt',
      ],
      {
        cwd: orphan,
        env,
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const running = runSyncAsync(ws, ["--force"], env);
    const [result, writerStatus] = await Promise.all([running, writer.exited]);

    expect(writerStatus).toBe(0);
    expect(result.status).toBe(1);
    expect(result.out).toContain("changed during quarantine");
    expect(readFileSync(join(orphan, "late-local.txt"), "utf-8")).toBe(
      "late local work\n",
    );
    expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(false);
  });

  test("a clean commit made during quarantine is caught by the repeated remote proof", async () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web");
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "quarantine-started");
    const env = quarantineGitEnv(signal);
    const writer = Bun.spawn(
      [
        "sh",
        "-c",
        [
          'while [ ! -e "$AIDLC_TEST_QUARANTINE_STARTED" ]; do sleep 0.01; done',
          'printf "late commit\\n" > late-commit.txt',
          "git add late-commit.txt",
          'git -c user.name=t255 -c user.email=t255@example.com commit -q -m "late commit"',
        ].join("; "),
      ],
      {
        cwd: orphan,
        env,
        stdout: "ignore",
        stderr: "pipe",
      },
    );

    const running = runSyncAsync(ws, ["--force"], env);
    const [result, writerStatus] = await Promise.all([running, writer.exited]);
    expect(writerStatus).toBe(0);
    expect(result.status).toBe(1);
    expect(result.out).toContain("changed during quarantine");
    expect(result.out).toContain("unpushed commits");
    expect(existsSync(join(orphan, "late-commit.txt"))).toBe(true);
  });

  test("a write after the final proof remains in the retained recovery copy", async () => {
    const ws = freshRealWorkspace(`{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`);
    makeRepo(ws, "checkout-api");
    const orphan = makeRepo(ws, "checkout-web");
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "final-proof-done");
    const env = postProofGitEnv(signal);
    const writer = Bun.spawn(
      [
        "sh",
        "-c",
        'while [ ! -e "$AIDLC_TEST_FINAL_PROOF_DONE" ]; do sleep 0.01; done; printf "after proof\\n" > after-proof.txt',
      ],
      {
        cwd: orphan,
        env,
        stdout: "ignore",
        stderr: "pipe",
      },
    );

    const running = runSyncAsync(ws, ["--force"], env);
    const [result, writerStatus] = await Promise.all([running, writer.exited]);
    expect(writerStatus).toBe(0);
    expect(result.status).toBe(0);
    expect(existsSync(orphan)).toBe(false);

    const recovery = readdirSync(ws).find((name) =>
      name.startsWith(".aidlc-workspace-sync-recovery-"),
    );
    expect(recovery).toBeDefined();
    expect(
      readFileSync(join(ws, recovery!, "checkout-web", "after-proof.txt"), "utf-8"),
    ).toBe("after proof\n");
  });

  test("concurrent syncs serialize a shared clone destination", async () => {
    const sourceWs = freshRealWorkspace('{ "org": "acme", "repos": [] }');
    const source = makeRepo(sourceWs, "source");
    const remote = git(source, "remote", "get-url", "origin");
    const ws = freshRealWorkspace(
      JSON.stringify({
        org: "acme",
        repos: [
          { name: "checkout-api", branch: "main", url: remote },
        ],
      }),
    );
    const signalRoot = mkdtempSync(join(tmpdir(), "aidlc-t255-signal-"));
    tmpRoots.push(signalRoot);
    const signal = join(signalRoot, "clone-started");
    const env = {
      ...slowGitEnv(signal),
      // A live sync can legitimately exceed the generic stale threshold.
      // Keep this tiny so the test proves another sync cannot reap it by age.
      AIDLC_LOCK_STALE_MS: "25",
    };
    const first = runSyncAsync(ws, [], env);
    await waitForPath(signal);
    const second = runSyncAsync(ws, [], env);
    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe(0);
    expect(two.status).toBe(0);
    expect(git(join(ws, "checkout-api"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "main",
    );
    expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(true);
  });

  test("invalid generated-file destination cannot delete an approved orphan", () => {
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [{ "name": "checkout-api", "branch": "main" }]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api");
    makeRepo(ws, "checkout-web");
    mkdirSync(join(ws, ".gitignore"));
    const result = runSync(ws, ["--force"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("not a regular file");
    expect(existsSync(join(ws, "checkout-web"))).toBe(true);
    expect(existsSync(join(ws, CODE_WORKSPACE_NAME))).toBe(false);
  });

  test("dangling generated-file symlinks are rejected without replacement", () => {
    for (const name of [".gitignore", CODE_WORKSPACE_NAME]) {
      const ws = freshWorkspace(MANIFEST);
      const output = join(ws, name);
      symlinkSync(join(ws, "missing-target"), output);

      const result = runSync(ws);
      expect(result.status).toBe(1);
      expect(result.out).toContain("not a regular file");
      expect(lstatSync(output).isSymbolicLink()).toBe(true);
      expect(existsSync(join(ws, "missing-target"))).toBe(false);
    }
  });

  test("output contains no ANSI escape codes when captured (non-TTY = no color)", () => {
    // runSync uses spawnSync which has no TTY attached, so COLOR must be false
    // and all output must be plain text - this protects every toContain() assertion
    // in this suite from silently breaking if the TTY gate is ever mis-wired.
    const ws = freshWorkspace(MANIFEST);
    const r = runSync(ws);
    expect(r.out).not.toContain("\x1b[");
  });

  // --- Optional `branch`: detection fallback + validation --------------------

  test("omitted branch, on detected default → no warning (exit 0)", () => {
    // No "branch" in the entry; origin/HEAD → main and the checkout is on main,
    // so the detected-default fallback finds no drift.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api", { branch: "main" });

    const r = runSync(ws);
    expect(r.status).toBe(0);
    expect(r.out).toContain("workspace in sync");
    // No branch advisory of any kind.
    expect(r.out).not.toContain("is on");
    expect(r.out).not.toContain("\x1b[");
  });

  test("omitted branch, off the detected default → warning (exit 2)", () => {
    // origin/HEAD → main, but HEAD is checked out on feature/x. With "branch"
    // omitted the expected branch is the detected origin default → drift warns.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    // Origin default stays main; move HEAD onto a second branch.
    makeRepo(ws, "checkout-api", { branch: "main" });
    const dir = join(ws, "checkout-api");
    git(dir, "checkout", "-q", "-b", "feature/x");

    const r = runSync(ws);
    expect(r.status).toBe(2);
    expect(r.out).toContain("feature/x");
    expect(r.out).toContain("main");
    // Source label for the omitted case names the origin default, not repos.json.
    expect(r.out).toContain("origin default");
    expect(r.out).toContain("NOT fully in sync");
    // Branch was NOT switched.
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x");
    expect(r.out).not.toContain("\x1b[");
  });

  test("omitted branch, default undetectable → no warning (exit 0)", () => {
    // No origin (withRemote:false) ⇒ symbolic-ref refs/remotes/origin/HEAD fails
    // ⇒ detectDefaultBranch returns null ⇒ the check is skipped entirely.
    // The repo is on a SENTINEL branch no fabrication would return, so if
    // detectDefaultBranch were broken to invent a default (e.g. "main") instead
    // of returning null, expected would differ from the checkout → a warning
    // would fire → exit 2 → this test fails. That is what makes it bite on the
    // null-skip invariant rather than a coincidental match.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api", { branch: "hotfix/sentinel", withRemote: false });

    const r = runSync(ws);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("is on");
    expect(r.out).not.toContain("\x1b[");
  });

  test("explicit branch set, matching checkout → no warning (exit 0)", () => {
    // Explicit branch develop, checkout on develop → set-path compares against
    // the literal branch (independent of origin's default).
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "develop" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api", { branch: "develop" });

    const r = runSync(ws);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("is on");
    expect(r.out).not.toContain("\x1b[");
  });

  test("explicit branch set, differing checkout → warning names repos.json (exit 2)", () => {
    // Manifest expects main; origin default AND checkout are feature/x. The
    // explicit branch wins over the detected default → warns, source repos.json.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "branch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api", { branch: "feature/x" });

    const r = runSync(ws);
    expect(r.status).toBe(2);
    expect(r.out).toContain("feature/x");
    expect(r.out).toContain("main");
    // Source label proves the explicit branch was used, not the origin default.
    expect(r.out).toContain("repos.json");
    expect(r.out).not.toContain("origin default");
    expect(r.out).not.toContain("\x1b[");
  });

  test("validation rejects a non-string / empty branch when present", () => {
    // Empty-string branch and wrong-type branch both fail in readManifest,
    // before any git call - exit 1, and no aidlc.code-workspace is written.
    for (const bad of ['{ "name": "checkout-api", "branch": "" }', '{ "name": "checkout-api", "branch": 123 }']) {
      const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    ${bad}
  ]
}`;
      const ws = freshWorkspace(SINGLE_MANIFEST, ["checkout-api"]);
      const r = runSync(ws);
      expect(r.status).toBe(1);
      expect(r.out).toContain("branch");
      expect(r.out).toContain("checkout-api");
      // Validation fails before any mutation.
      expect(existsSync(join(ws, "aidlc.code-workspace"))).toBe(false);
    }
  });

  test("legacy defaultBranch key is ignored gracefully (exit 0)", () => {
    // The old key is unknown JSON now - parses fine and behaves as "branch
    // omitted": checkout on the detected origin default → no warning.
    const SINGLE_MANIFEST = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "defaultBranch": "main" }
  ]
}`;
    const ws = freshRealWorkspace(SINGLE_MANIFEST);
    makeRepo(ws, "checkout-api", { branch: "main" });

    const r = runSync(ws);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("is on");
    expect(r.out).not.toContain("\x1b[");
  });

  test("per-entry url override is accepted (validated, not derived from org)", () => {
    // A non-empty "url" is valid and does not trip validation; an empty "url"
    // is rejected before any git call. The clone path itself is network-bound
    // and covered manually, so we only assert the validation contract here.
    const GOOD = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "url": "git@example.com:team/checkout-api.git" }
  ]
}`;
    const wsGood = freshWorkspace(GOOD, ["checkout-api"]);
    expect(runSync(wsGood).status).toBe(0);

    const BAD = `{
  "org": "acme",
  "repos": [
    { "name": "checkout-api", "url": "" }
  ]
}`;
    const wsBad = freshWorkspace(BAD, ["checkout-api"]);
    const r = runSync(wsBad);
    expect(r.status).toBe(1);
    expect(r.out).toContain("url");
    expect(r.out).toContain("checkout-api");
  });
});
