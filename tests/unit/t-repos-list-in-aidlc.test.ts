// covers: function:catchUpChangedLine, function:workspaceManifestAt, function:reposManifestPath, function:moveReposManifestIntoAidlc, function:trackedReposManifestAtRoot, function:reposManifestMovedIntoAidlc, function:reposListGoingBackLine, function:readWorkspaceRepos, function:repoNotThereLine, function:aidlcOwnedSourceKey, function:sourceChangedOutsideAidlc, function:workspaceManifestChecks, subcommand:aidlc-unit:share, file:core/tools/aidlc-workspace-manifest.ts
//
// The workspace's repo list lives in aidlc/repos.json from 2.12, checked in with
// the team's record; a root repos.json an older AI-DLC wrote is still read. One
// order of places for every reader, on disk and at a commit of a workspace that
// is not here. Config's refresh moves a root list into aidlc/ (a staged rename
// when git tracks it, so a teammate who made the same move still pulls cleanly),
// says so only when a tracked file moved, and a rerun finds nothing to do; an
// earlier release's files never get the move. The move is nobody's change to the
// source. The plan's share commits the list wherever it is. A person who sets a
// project to an earlier release hears that it reads the list only at the root.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catchUpChangedLine,
  moveReposManifestIntoAidlc,
  readWorkspaceRepos,
  REPOS_LOCAL_PLACE,
  REPOS_MANIFEST_PLACES,
  REPOS_MOVED_LINE,
  repoNotThereLine,
  reposListGoingBackLine,
  reposManifestMovedIntoAidlc,
  reposManifestPath,
  trackedReposManifestAtRoot,
  workspaceManifestAt,
} from "../../dist/claude/.claude/tools/aidlc-workspace-manifest.ts";
import { aidlcOwnedSourceKey, sourceChangedOutsideAidlc, sourcePathKey } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { workspaceManifestChecks } from "../../dist/claude/.claude/tools/aidlc-workspace-doctor.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { cleanupTeamBuild, git, makeHome, run, STATE, tempDir, UNIT } from "../harness/team-build.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const list = (...names: string[]): string =>
  `${JSON.stringify({ repos: names.map((name) => ({ name })) }, null, 2)}\n`;

// A git workspace with AI-DLC's aidlc/ folder, as config leaves one.
function workspace(): string {
  const dir = tempDir("repos-in-aidlc");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "lee"]);
  git(dir, ["config", "user.email", "lee@example.test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  mkdirSync(join(dir, "aidlc"), { recursive: true });
  return dir;
}

describe("where the repo list is read", () => {
  test("aidlc/repos.json comes first, then the root one", () => {
    expect([...REPOS_MANIFEST_PLACES]).toEqual(["aidlc/repos.json", "repos.json"]);
  });

  test("a reader given both places gets aidlc/'s list, with its text kept", () => {
    const files: Record<string, string> = { "aidlc/repos.json": list("billing"), "repos.json": list("storefront") };
    const found = workspaceManifestAt((rel) => files[rel] ?? null);
    expect(found?.path).toBe("aidlc/repos.json");
    expect(found?.text).toBe(files["aidlc/repos.json"]);
    expect(found?.manifest.repos.map((repo) => repo.name)).toEqual(["billing"]);
  });

  test("a root list alone is still read", () => {
    const found = workspaceManifestAt((rel) => (rel === "repos.json" ? list("storefront") : null));
    expect(found?.path).toBe("repos.json");
    expect(found?.manifest.repos.map((repo) => repo.name)).toEqual(["storefront"]);
  });

  test("no list in either place reads as none", () => {
    expect(workspaceManifestAt(() => null)).toBeNull();
  });

  test("an invalid list in the first place is an error, never the root list instead", () => {
    const files: Record<string, string> = { "aidlc/repos.json": "{ not json", "repos.json": list("storefront") };
    expect(() => workspaceManifestAt((rel) => files[rel] ?? null)).toThrow("repos.json is not valid JSON");
  });

  test("on disk: aidlc/'s first, else the root's; a new list goes in aidlc/ only where that folder is", () => {
    const dir = workspace();
    expect(reposManifestPath(dir)).toBe(join(dir, "aidlc", "repos.json"));
    writeFileSync(join(dir, "repos.json"), list("billing"));
    expect(reposManifestPath(dir)).toBe(join(dir, "repos.json"));
    expect([...readWorkspaceRepos(dir).entries.keys()]).toEqual(["billing"]);
    writeFileSync(join(dir, "aidlc", "repos.json"), list("storefront"));
    expect(reposManifestPath(dir)).toBe(join(dir, "aidlc", "repos.json"));
    expect([...readWorkspaceRepos(dir).entries.keys()]).toEqual(["storefront"]);
    const bare = tempDir("no-aidlc");
    expect(reposManifestPath(bare)).toBe(join(bare, "repos.json"));
    expect(existsSync(join(bare, "aidlc"))).toBe(false);
  });

  // The catch-up after an update: one line for what it changed that git
  // tracks, by folder and count, the list's move in the same line.
  test("the catch-up's line names each folder with its count, AI-DLC's part of a shared file, and the move in one line", () => {
    expect(catchUpChangedLine("9.9.9", [], false)).toBeNull();
    expect(catchUpChangedLine("9.9.9", [], true)).toBe(REPOS_MOVED_LINE);
    expect(catchUpChangedLine("9.9.9", [".claude/tools/data/aidlc-stamp.json"], false)).toBe(
      "AI-DLC updated its own files in this project to 9.9.9: 1 file under .claude changed. Commit it so your team gets it.",
    );
    expect(catchUpChangedLine("9.9.9", [".kiro/a.md", ".claude/a.md", "AGENTS.md", ".claude/b.md"], false)).toBe(
      "AI-DLC updated its own files in this project to 9.9.9: 2 files under .claude, 1 under .kiro and its part of AGENTS.md changed. " +
        "Commit them so your team gets them.",
    );
    expect(catchUpChangedLine("9.9.9", ["AGENTS.md"], false)).toBe(
      "AI-DLC updated its own files in this project to 9.9.9: its part of AGENTS.md changed. Commit it so your team gets it.",
    );
    expect(catchUpChangedLine("9.9.9", [".claude/a.md", ".claude/b.md"], true)).toBe(
      "AI-DLC updated its own files in this project to 9.9.9: 2 files under .claude changed, and repos.json moved into aidlc/. " +
        "Commit them so your team gets them; teammates need AI-DLC 2.12 or newer to find repos.json there.",
    );
  });

  test("one person's repos.local.json sits beside the list in aidlc/ and is read only there", () => {
    expect(REPOS_LOCAL_PLACE).toBe("aidlc/repos.local.json");
    for (const listAt of ["aidlc/repos.json", "repos.json"]) {
      const dir = workspace();
      writeFileSync(join(dir, ...listAt.split("/")), list("storefront", "billing"));
      writeFileSync(join(dir, "aidlc", "repos.local.json"), JSON.stringify({ repos: [{ name: "storefront", path: "../mine" }] }));
      writeFileSync(join(dir, "repos.local.json"), JSON.stringify({ repos: [{ name: "billing", path: "../theirs" }] }));
      const repos = readWorkspaceRepos(dir);
      expect(repos.entries.get("storefront")?.path, listAt).toBe("../mine");
      expect(repos.entries.get("billing")?.path, listAt).toBeUndefined();
      expect(repoNotThereLine(dir, "billing"), listAt).toBe(
        "billing is not at billing in this workspace. Clone it there, or give its path in aidlc/repos.local.json.",
      );
    }
  });

  test("the shipped .gitignore blocks keep aidlc/repos.json in git and aidlc/repos.local.json out", () => {
    for (const harness of readdirSync(join(REPO_ROOT, "harness"))) {
      const block = join(REPO_ROOT, "harness", harness, "dot-gitignore");
      if (!existsSync(block)) continue;
      const dir = workspace();
      writeFileSync(join(dir, ".gitignore"), readFileSync(block, "utf-8"));
      const ignored = (path: string) => spawnSync("git", ["check-ignore", "-q", path], { cwd: dir }).status === 0;
      expect(ignored("aidlc/repos.json"), harness).toBe(false);
      expect(ignored("aidlc/repos.local.json"), harness).toBe(true);
    }
  });

  test("doctor reads the list in aidlc/ as it read the root one", () => {
    const atRoot = workspace();
    writeFileSync(join(atRoot, "repos.json"), list("billing"));
    const inRecord = workspace();
    writeFileSync(join(inRecord, "aidlc", "repos.json"), list("billing"));
    for (const dir of [atRoot, inRecord]) {
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "list"]);
    }
    const labels = (dir: string) => workspaceManifestChecks(dir).map((row) => row.label);
    expect(labels(inRecord)).toEqual(labels(atRoot));
    expect(labels(inRecord).length).toBeGreaterThan(0);
  });
});

describe("the one move into aidlc/", () => {
  test("a list git tracks moves as a staged rename with its bytes, CRLF kept, and says so", () => {
    const dir = workspace();
    const text = list("billing", "storefront").replaceAll("\n", "\r\n");
    writeFileSync(join(dir, "repos.json"), text);
    git(dir, ["add", "repos.json"]);
    git(dir, ["commit", "-q", "-m", "lead"]);
    expect(trackedReposManifestAtRoot(dir)).toBe(true);
    expect(moveReposManifestIntoAidlc(dir)).toEqual({ moved: true, tracked: true });
    expect(readFileSync(join(dir, "aidlc", "repos.json"), "utf-8")).toBe(text);
    expect(existsSync(join(dir, "repos.json"))).toBe(false);
    expect(git(dir, ["status", "--porcelain"])).toContain("R  repos.json -> aidlc/repos.json");
    expect(reposManifestMovedIntoAidlc(dir)).toBe(true);
    expect(REPOS_MOVED_LINE).toBe(
      "AI-DLC moved repos.json into aidlc/. Commit it so your team gets it; teammates need AI-DLC 2.12 or newer.",
    );
    // A second run finds nothing to move.
    expect(moveReposManifestIntoAidlc(dir)).toEqual({ moved: false, tracked: false });
  });

  test("a teammate whose AI-DLC made the same move pulls the lead's commit of it cleanly", () => {
    const host = tempDir("host");
    git(host, ["init", "-q", "--bare", "-b", "main"]);
    const lead = workspace();
    writeFileSync(join(lead, "repos.json"), list("billing"));
    writeFileSync(join(lead, "aidlc", "state.md"), "x\n");
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-q", "-m", "base"]);
    git(lead, ["remote", "add", "origin", host]);
    git(lead, ["push", "-q", "origin", "main"]);
    const mate = join(tempDir("mate"), "ws");
    git(host, ["clone", "-q", host, mate]);
    moveReposManifestIntoAidlc(lead);
    git(lead, ["commit", "-q", "-m", "move"]);
    git(lead, ["push", "-q", "origin", "main"]);
    expect(moveReposManifestIntoAidlc(mate).tracked).toBe(true);
    git(mate, ["pull", "-q", "--ff-only", "origin", "main"]);
    expect(git(mate, ["status", "--porcelain"])).toBe("");
  });

  test("an untracked list moves by a plain rename and says nothing; outside git too", () => {
    const dir = workspace();
    writeFileSync(join(dir, "repos.json"), list("billing"));
    expect(trackedReposManifestAtRoot(dir)).toBe(false);
    expect(moveReposManifestIntoAidlc(dir)).toEqual({ moved: true, tracked: false });
    expect(readFileSync(join(dir, "aidlc", "repos.json"), "utf-8")).toBe(list("billing"));
    const plain = tempDir("not-git");
    mkdirSync(join(plain, "aidlc"));
    writeFileSync(join(plain, "repos.json"), list("billing"));
    expect(moveReposManifestIntoAidlc(plain)).toEqual({ moved: true, tracked: false });
    expect(existsSync(join(plain, "aidlc", "repos.json"))).toBe(true);
  });

  test("nothing moves without an aidlc/ folder, or with a list already in aidlc/", () => {
    const bare = tempDir("no-aidlc");
    writeFileSync(join(bare, "repos.json"), list("billing"));
    expect(moveReposManifestIntoAidlc(bare)).toEqual({ moved: false, tracked: false });
    expect(existsSync(join(bare, "aidlc"))).toBe(false);
    const both = workspace();
    writeFileSync(join(both, "repos.json"), list("billing"));
    writeFileSync(join(both, "aidlc", "repos.json"), list("storefront"));
    expect(moveReposManifestIntoAidlc(both)).toEqual({ moved: false, tracked: false });
    expect(readFileSync(join(both, "repos.json"), "utf-8")).toBe(list("billing"));
    expect(readFileSync(join(both, "aidlc", "repos.json"), "utf-8")).toBe(list("storefront"));
  });

  test("a root repos.json that is not AI-DLC's list stays where it is, and stays the project's source", () => {
    const dir = workspace();
    const theirs = `${JSON.stringify({ name: "my-app", mirrors: ["a", "b"] }, null, 2)}\n`;
    writeFileSync(join(dir, "repos.json"), theirs);
    git(dir, ["add", "repos.json"]);
    git(dir, ["commit", "-q", "-m", "app"]);
    expect(moveReposManifestIntoAidlc(dir)).toEqual({ moved: false, tracked: false });
    expect(readFileSync(join(dir, "repos.json"), "utf-8")).toBe(theirs);
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(false);
    expect(aidlcOwnedSourceKey(dir)(sourcePathKey("", "repos.json"))).toBe(false);
  });

  test("the move is nobody's change to the workspace's source", () => {
    const dir = workspace();
    // After the move: the list is in aidlc/ and the root one is gone.
    writeFileSync(join(dir, "aidlc", "repos.json"), list("billing"));
    const before = new Map([[sourcePathKey("", "repos.json"), "a"], [sourcePathKey("", "src/app.ts"), "b"]]);
    const after = new Map([[sourcePathKey("", "src/app.ts"), "b"]]);
    expect(sourceChangedOutsideAidlc(dir, before, after)).toEqual([]);
    expect(aidlcOwnedSourceKey(dir)(sourcePathKey("", "repos.json"))).toBe(true);
    // A code repo's own repos.json is its source.
    expect(aidlcOwnedSourceKey(dir)(sourcePathKey("billing", "repos.json"))).toBe(false);
  });

  test("going back to an earlier release says where it reads the list, and only then", () => {
    const dir = workspace();
    writeFileSync(join(dir, "aidlc", "repos.json"), list("billing"));
    // A list git does not track goes back by a plain move.
    expect(reposListGoingBackLine(dir, "2.11.3")).toBe(
      "AI-DLC 2.11.3 reads repos.json only at the project root; to keep your repo list on it, run `mv aidlc/repos.json repos.json`.",
    );
    git(dir, ["add", "aidlc/repos.json"]);
    git(dir, ["commit", "-q", "-m", "list"]);
    expect(reposListGoingBackLine(dir, "2.11.3")).toBe(
      "AI-DLC 2.11.3 reads repos.json only at the project root; to keep your repo list on it, run `git mv aidlc/repos.json repos.json`.",
    );
    expect(reposListGoingBackLine(dir, "2.12.0")).toBeNull();
    expect(reposListGoingBackLine(dir, "3.0.0")).toBeNull();
    writeFileSync(join(dir, "repos.json"), list("billing"));
    expect(reposListGoingBackLine(dir, "2.11.3")).toBeNull();
    expect(reposListGoingBackLine(workspace(), "2.11.3")).toBeNull();
  });
});

// Config through the copy channel's own tool, as a copied project runs it.
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc.ts");
const COPY = join(REPO_ROOT, "dist", "claude");

function earlier(version: string): string {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  return patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.0`;
}

// The same tree stamped as an earlier release: config installs it as that release's.
function earlierTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-earlier-tree-")));
  cpSync(COPY, root, { recursive: true });
  const stamp = join(root, ".claude", "tools", "data", "aidlc-stamp.json");
  const value = JSON.parse(readFileSync(stamp, "utf-8")) as Record<string, unknown>;
  writeFileSync(stamp, `${JSON.stringify({ ...value, frameworkVersion: earlier(AIDLC_VERSION) }, null, 2)}\n`);
  return root;
}

function config(project: string, args: string[]) {
  const machine = tempDir("machine");
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin"), NO_COLOR: "1" };
  for (const key of ["CLAUDE_PROJECT_DIR", "AIDLC_PROJECT_DIR", "AIDLC_TEST_CONFIG_TTY"]) delete env[key];
  const r = spawnSync(process.execPath, [TOOL, "config", ...args, "--project-dir", project], {
    cwd: project,
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// A Claude Code project an earlier release set up, its root repos.json committed.
function projectBehind(): string {
  const dir = workspace();
  const tree = earlierTree();
  const setup = config(dir, ["--harness", "claude", "--mcp", "none", "--yes", "--quiet", "--from", tree]);
  expect(setup.status, setup.out).toBe(0);
  writeFileSync(join(dir, "repos.json"), list("billing"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "setup"]);
  return dir;
}

describe("config's refresh moves the list", () => {
  test("into aidlc/ when it puts this release's files in, says so once, and a rerun changes nothing", () => {
    const dir = projectBehind();
    const first = config(dir, ["--harness", "claude", "--from", COPY]);
    expect(first.status, first.out).toBe(0);
    expect(first.out).toContain(REPOS_MOVED_LINE);
    expect(git(dir, ["status", "--porcelain"])).toContain("R  repos.json -> aidlc/repos.json");
    const status = git(dir, ["status", "--porcelain"]);
    const again = config(dir, ["--harness", "claude", "--from", COPY]);
    expect(again.status, again.out).toBe(0);
    expect(again.out).not.toContain("repos.json");
    expect(git(dir, ["status", "--porcelain"])).toBe(status);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  test("never in a dry run, nor while it puts an earlier release's files in", () => {
    const dir = projectBehind();
    const dry = config(dir, ["--harness", "claude", "--from", COPY, "--dry-run"]);
    expect(dry.status, dry.out).toBe(0);
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
    const earlierAgain = config(dir, ["--harness", "claude", "--from", earlierTree()]);
    expect(earlierAgain.status, earlierAgain.out).toBe(0);
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(false);
  });
});

describe("the plan's share carries the repo list", () => {
  test("a root list the person changed, and its removal after a rename by hand, are in the share's commit", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const changed = `${JSON.stringify({ repos: [{ name: "app" }, { name: "ledger" }] }, null, 2)}\n`;
    writeFileSync(join(home.dir, "repos.json"), changed);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(git(home.dir, ["show", "HEAD:repos.json"])).toBe(changed.trim());
    renameSync(join(home.dir, "repos.json"), join(home.dir, "aidlc", "repos.json"));
    const again = run(UNIT, ["share", "--plan"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(git(home.dir, ["ls-tree", "--name-only", "HEAD"]).split("\n")).not.toContain("repos.json");
    expect(git(home.dir, ["show", "HEAD:aidlc/repos.json"])).toBe(changed.trim());
  });
});
