// covers: function:ownFilesToCommit, function:writtenByInstall, function:reposMoveToCommit, function:recordCommitBlock, function:updateCommitStep, subcommand:aidlc-unit:commit-record, file:core/tools/aidlc-brought-files.ts
//
// After an update, AI-DLC's own files that git shows changed are worked out
// from the install record and git alone: the ones that still hold exactly what
// AI-DLC wrote, with nothing of the person's changed since the last commit, are
// what the update's own commit takes; every other file of AI-DLC's that changed
// is left for the person. Their uncommitted words in a shared file, their own
// scope file rendered into the stage tables, and a file they edited after the
// refresh are never taken. The same release committed from an LF checkout and
// from a CRLF one (Git for Windows' default) is the same tree, so two machines
// that both commit an update commit the same bytes. `unit commit-record --update`
// makes that commit on the person's branch through their own git, hooks
// included, with the message drafted for it, pushes nothing, and takes a
// settings file config merges only where the update's offer drafted its message.
// A root repos.json git tracks stays where the refresh found it, nothing staged,
// and that commit moves it into aidlc/ only where its offer named the move; a
// commit that does not go through leaves the list at the root as it was.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ownFilesToCommit } from "../../dist/claude/.claude/tools/aidlc-brought-files.ts";
import { catchUpChangedLine } from "../../dist/claude/.claude/tools/aidlc-workspace-manifest.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { FIXTURES_DIR, REPO_ROOT, seededStateFile, seedWorkspaceShell } from "../harness/fixtures.ts";
import { cleanupTeamBuild, ENV, git, ORCH, run, tempDir, UNIT } from "../harness/team-build.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const DIRS = { claude: ".claude", codex: ".codex", cursor: ".cursor" } as const;
type Harness = keyof typeof DIRS;

function earlier(version: string): string {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  return patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.0`;
}

// This release's tree stamped as the one before, with a few files that release
// wrote otherwise, as a real step changes them; with `codexConfig`, Codex's
// config.toml too.
function earlierTree(harness: Harness, codexConfig = false): string {
  const root = tempDir(`earlier-${harness}`);
  cpSync(join(REPO_ROOT, "dist", harness), root, { recursive: true });
  const data = join(root, DIRS[harness], "tools", "data");
  const stamp = join(data, "aidlc-stamp.json");
  writeFileSync(stamp, `${JSON.stringify({ ...JSON.parse(readFileSync(stamp, "utf-8")), frameworkVersion: earlier(AIDLC_VERSION) }, null, 2)}\n`);
  const skills = [join(root, DIRS[harness], "skills"), join(root, ".agents", "skills")].find((dir) => existsSync(join(dir, "aidlc", "SKILL.md")));
  appendFileSync(join(skills ?? "", "aidlc", "SKILL.md"), "\n<!-- the release before -->\n");
  for (const name of ["stage-graph.json", "scope-grid.json"]) appendFileSync(join(data, name), "\n");
  const harnessJson = join(data, "harness.json");
  writeFileSync(harnessJson, `${JSON.stringify({ ...JSON.parse(readFileSync(harnessJson, "utf-8")), productName: "The release before" }, null, 2)}\n`);
  writeFileSync(join(root, DIRS[harness], "aidlc-common", "retired-note.md"), "A file the next release does not ship.\n");
  if (harness === "cursor") appendFileSync(join(root, "AGENTS.md"), "\nA line the next release drops.\n");
  if (harness === "codex" && codexConfig) {
    const toml = join(root, DIRS[harness], "config.toml");
    writeFileSync(toml, readFileSync(toml, "utf-8").replace("# AI-DLC on Codex CLI\n", "# AI-DLC on Codex CLI\n\nThe release before.\n"));
  }
  if (harness === "claude") {
    // Its own announcement, and an allow entry this release no longer ships (the refresh keeps that one, as it
    // keeps the person's own), as 2.11.3's settings.json differs from 2.11.4's.
    const settings = join(root, DIRS[harness], "settings.json");
    const value = JSON.parse(readFileSync(settings, "utf-8")) as { permissions: { allow: string[] } };
    writeFileSync(settings, `${JSON.stringify({ ...value, companyAnnouncements: ["The release before."], permissions: { ...value.permissions, allow: [...value.permissions.allow, "Bash(aidlc retired)"] } }, null, 2)}\n`);
  }
  return root;
}

function config(project: string, harness: Harness, from: string): void {
  const home = tempDir("home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    AIDLC_INSTALL_ROOT: join(home, "machine"),
    AIDLC_BIN_DIR: join(home, "machine", "bin"),
    NO_COLOR: "1",
  };
  for (const key of ["CLAUDE_PROJECT_DIR", "AIDLC_PROJECT_DIR", "AIDLC_TEST_CONFIG_TTY"]) delete env[key];
  const tool = join(REPO_ROOT, "dist", harness, DIRS[harness], "tools", "aidlc.ts");
  const r = spawnSync(process.execPath, [tool, "config", "--harness", harness, "--mcp", "none", "--yes", "--quiet", "--from", from, "--project-dir", project], {
    cwd: project,
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

function repo(dir: string, autocrlf = "false"): void {
  git(dir, ["config", "user.name", "lee"]);
  git(dir, ["config", "user.email", "lee@example.test"]);
  git(dir, ["config", "core.autocrlf", autocrlf]);
}

// A project the earlier release set up, all committed; `before` runs first.
function projectBehind(harness: Harness, before?: (dir: string) => void): { dir: string; tree: string } {
  const dir = tempDir(`update-${harness}`);
  git(dir, ["init", "-q", "-b", "main"]);
  repo(dir);
  const tree = earlierTree(harness);
  config(dir, harness, tree);
  before?.(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "setup"]);
  return { dir, tree };
}

// What git shows changed against HEAD, and new files it does not ignore.
const changed = (dir: string): Set<string> =>
  new Set([...git(dir, ["diff", "--name-only", "HEAD"]).split("\n"), ...git(dir, ["ls-files", "--others", "--exclude-standard"]).split("\n")].filter(Boolean));

// The refresh, as the session start runs it: git's changes listed first.
function refresh(dir: string, harness: Harness): (path: string) => boolean {
  const before = changed(dir);
  config(dir, harness, join(REPO_ROOT, "dist", harness));
  return (path) => before.has(path);
}

describe("what the update's own commit takes", () => {
  test("every file the refresh wrote, the data files and a file it removed; nothing left", () => {
    const { dir } = projectBehind("claude");
    const changedBefore = refresh(dir, "claude");
    const { commit, left } = ownFilesToCommit(dir, changedBefore);
    for (const path of [
      ".claude/skills/aidlc/SKILL.md",
      ".claude/tools/data/aidlc-stamp.json",
      ".claude/tools/data/aidlc-manifest.json",
      ".claude/tools/data/harness.json",
      ".claude/tools/data/stage-graph.json",
      ".claude/tools/data/scope-grid.json",
      ".claude/aidlc-common/retired-note.md",
      ".claude/settings.json",
    ]) expect(commit).toContain(path);
    expect(left).toEqual([]);
    // What git shows changed is exactly what it takes.
    expect([...commit].sort()).toEqual([...changed(dir)].sort());
  });

  test("the person's uncommitted words in .gitignore and settings.json leave those two files out", () => {
    const { dir } = projectBehind("claude");
    appendFileSync(join(dir, ".gitignore"), "\n# ours\nnode_modules/\n");
    const settings = join(dir, ".claude", "settings.json");
    const value = JSON.parse(readFileSync(settings, "utf-8")) as { permissions?: { allow?: string[] } };
    writeFileSync(settings, `${JSON.stringify({ ...value, permissions: { ...value.permissions, allow: [...(value.permissions?.allow ?? []), "Bash(make test)"] } }, null, 2)}\n`);
    const changedBefore = refresh(dir, "claude");
    const { commit, left, held } = ownFilesToCommit(dir, changedBefore);
    expect(left).toEqual([".claude/settings.json", ".gitignore"]);
    expect(held).toEqual([".claude/settings.json"]);
    expect(commit).not.toContain(".gitignore");
    expect(commit).not.toContain(".claude/settings.json");
    expect(commit).toContain(".claude/skills/aidlc/SKILL.md");
    expect(readFileSync(settings, "utf-8")).toContain("Bash(make test)");
  });

  test("AI-DLC's part of AGENTS.md goes in unless the person's own part changed too", () => {
    const clean = projectBehind("cursor");
    expect(ownFilesToCommit(clean.dir, refresh(clean.dir, "cursor")).commit).toContain("AGENTS.md");
    const ours = projectBehind("cursor", (dir) => writeFileSync(join(dir, "AGENTS.md"), `# Our project\n\n${readFileSync(join(dir, "AGENTS.md"), "utf-8")}`));
    appendFileSync(join(ours.dir, "AGENTS.md"), "\nOur own line, not committed yet.\n");
    const { commit, left } = ownFilesToCommit(ours.dir, refresh(ours.dir, "cursor"));
    expect(left).toContain("AGENTS.md");
    expect(commit).not.toContain("AGENTS.md");
  });

  test("asked with nothing known of before the refresh, a settings file config merges is left and the rest goes", () => {
    const { dir } = projectBehind("claude");
    refresh(dir, "claude");
    const { commit, left } = ownFilesToCommit(dir, null);
    expect(left).toEqual([".claude/settings.json"]);
    expect(commit).toContain(".claude/skills/aidlc/SKILL.md");
  });

  test("a file edited after the refresh is left; the rest still goes", () => {
    const { dir } = projectBehind("claude");
    const changedBefore = refresh(dir, "claude");
    appendFileSync(join(dir, ".claude", "skills", "aidlc", "SKILL.md"), "\nmine\n");
    const { commit, left } = ownFilesToCommit(dir, changedBefore);
    expect(left).toEqual([".claude/skills/aidlc/SKILL.md"]);
    expect(commit).toContain(".claude/tools/data/aidlc-stamp.json");
  });

  test("the person's own scope file rendered into the tables leaves the tables, the graph and the grid out", () => {
    const { dir } = projectBehind("claude");
    const shipped = readFileSync(join(dir, ".claude", "scopes", "aidlc-feature.md"), "utf-8");
    writeFileSync(join(dir, ".claude", "scopes", "aidlc-ours.md"), shipped.replace(/^name: .*$/m, "name: ours"));
    const { commit, left } = ownFilesToCommit(dir, refresh(dir, "claude"));
    for (const path of [".claude/tools/data/stage-graph.json", ".claude/tools/data/scope-grid.json", ".claude/skills/aidlc/tables.md"]) {
      expect(left).toContain(path);
      expect(commit).not.toContain(path);
    }
    expect(commit).not.toContain(".claude/scopes/aidlc-ours.md");
    expect(left).not.toContain(".claude/scopes/aidlc-ours.md");
  });

  test("the repo list's move, still to make, goes with the files, and nothing else of aidlc/", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing" }] }, null, 2)}\n`));
    writeFileSync(join(dir, "aidlc", "notes.md"), "work not shared yet\n");
    const changedBefore = refresh(dir, "claude");
    expect(git(dir, ["status", "--porcelain", "--", "repos.json", "aidlc/repos.json"])).toBe("");
    const { commit } = ownFilesToCommit(dir, changedBefore);
    expect(commit).toContain("repos.json");
    expect(commit).toContain("aidlc/repos.json");
    expect(commit.filter((path: string) => path.startsWith("aidlc/"))).toEqual(["aidlc/repos.json"]);

  });
});

// Every hash the committed record names is the sha256 of the blob committed at
// that path, and its keys are "/"-separated in the order a refresh walks them.
function recordMatchesCommit(dir: string, harness: Harness): void {
  const manifest = JSON.parse(git(dir, ["show", `HEAD:${DIRS[harness]}/tools/data/aidlc-manifest.json`])) as { files: Record<string, string> };
  const keys = Object.keys(manifest.files);
  expect(keys.filter((key) => key.includes("\\"))).toEqual([]);
  for (const [path, hash] of Object.entries(manifest.files)) {
    const blob = spawnSync("git", ["cat-file", "blob", `HEAD:${path}`], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    expect(blob.status, path).toBe(0);
    expect(`sha256:${createHash("sha256").update(blob.stdout).digest("hex")}`, path).toBe(hash);
  }
  const byFolder = (a: string, b: string): number => {
    const x = a.split("/");
    const y = b.split("/");
    for (let at = 0; at < Math.min(x.length, y.length); at++) {
      if (x[at] === y[at]) continue;
      // A folder's files come after the files beside it only by name, as the walk sorts each folder's entries.
      return x[at] < y[at] ? -1 : 1;
    }
    return x.length - y.length;
  };
  const inFolder = (prefix: string) => keys.filter((key) => key.startsWith(prefix));
  const own = inFolder(`${DIRS[harness]}/`);
  expect(own).toEqual([...own].sort(byFolder));
}

describe("two machines commit the same bytes for the same release", () => {
  for (const harness of ["claude", "codex"] as const) {
    test(`${harness}: an LF checkout and a CRLF checkout commit the same tree`, () => {
      const { dir: origin } = projectBehind(harness);
      const trees: string[] = [];
      for (const autocrlf of ["false", "true"]) {
        const clone = tempDir(`clone-${harness}-${autocrlf}`);
        git(clone, ["-c", `core.autocrlf=${autocrlf}`, "clone", "-q", origin, "."]);
        repo(clone, autocrlf);
        const { commit, left } = ownFilesToCommit(clone, refresh(clone, harness));
        expect(left).toEqual([]);
        expect(commit.length).toBeGreaterThan(0);
        git(clone, ["add", "--", ...commit]);
        git(clone, ["commit", "-q", "-m", "Update AI-DLC"]);
        expect(git(clone, ["status", "--porcelain"])).toBe("");
        recordMatchesCommit(clone, harness);
        trees.push(git(clone, ["rev-parse", "HEAD^{tree}"]));
      }
      const release = spawnSync("git", ["--git-dir", join(origin, ".git"), "rev-parse", "HEAD^{tree}"], { encoding: "utf-8" }).stdout.trim();
      console.log(`${harness} on ${process.platform}: start tree ${release}, update tree ${trees[0]}`);
      expect(trees[1]).toBe(trees[0]);
    });
  }

  // An origin the earlier release set up, cloned with an LF and a CRLF checkout, each refreshed and its update
  // committed as the offer takes it; `check` reads each clone after its refresh. Returns the two update trees.
  function bothCheckouts(origin: string, harness: Harness, check: (clone: string, commit: string[]) => void): string[] {
    return ["false", "true"].map((autocrlf) => {
      const clone = tempDir(`clone-${harness}-${autocrlf}`);
      git(clone, ["-c", `core.autocrlf=${autocrlf}`, "clone", "-q", origin, "."]);
      repo(clone, autocrlf);
      const { commit, left } = ownFilesToCommit(clone, refresh(clone, harness));
      expect(left).toEqual([]);
      check(clone, commit);
      git(clone, ["add", "--", ...commit]);
      git(clone, ["commit", "-q", "-m", "Update AI-DLC"]);
      recordMatchesCommit(clone, harness);
      return git(clone, ["rev-parse", "HEAD^{tree}"]);
    });
  }

  function originAt(harness: Harness, tree: string, before?: (dir: string) => void): string {
    const origin = tempDir(`update-${harness}-origin`);
    git(origin, ["init", "-q", "-b", "main"]);
    repo(origin);
    config(origin, harness, tree);
    before?.(origin);
    git(origin, ["add", "-A"]);
    git(origin, ["commit", "-q", "-m", "setup"]);
    return origin;
  }

  test("codex: a release that changes config.toml, refreshed on an LF and a CRLF checkout, commits the same tree", () => {
    const origin = originAt("codex", earlierTree("codex", true));
    const trees = bothCheckouts(origin, "codex", (_clone, commit) => expect(commit).toContain(".codex/config.toml"));
    expect(trees[1]).toBe(trees[0]);
  });

  test("cursor: a release that changes AI-DLC's part of AGENTS.md commits the same tree from both checkouts", () => {
    const origin = originAt("cursor", earlierTree("cursor"));
    const trees = bothCheckouts(origin, "cursor", (_clone, commit) => expect(commit).toContain("AGENTS.md"));
    expect(trees[1]).toBe(trees[0]);
  });

  test("codex: config.toml with the team's own table, recorded in CRLF by an earlier release on Windows, keeps the table and commits the same tree", () => {
    const tree = earlierTree("codex", true);
    const origin = originAt("codex", tree, (dir) => {
      appendFileSync(join(dir, ".codex", "config.toml"), "\n[profiles.ours]\nmodel = \"ours\"\n");
      config(dir, "codex", tree);
      const manifestPath = join(dir, ".codex", "tools", "data", "aidlc-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { files: Record<string, string> };
      const crlf = readFileSync(join(dir, ".codex", "config.toml"), "utf-8").replaceAll("\n", "\r\n");
      manifest.files[".codex/config.toml"] = `sha256:${createHash("sha256").update(crlf).digest("hex")}`;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    });
    const trees = bothCheckouts(origin, "codex", (clone, commit) => {
      expect(readFileSync(join(clone, ".codex", "config.toml"), "utf-8")).toContain("[profiles.ours]");
      expect(commit).toContain(".codex/config.toml");
    });
    expect(trees[1]).toBe(trees[0]);
  });
});

describe("unit commit-record --update", () => {
  const draft = `aidlc/.aidlc-engine/request-text/unit-record-message-update-${AIDLC_VERSION}.txt`;
  const shown = (dir: string): string[] => git(dir, ["show", "--name-only", "--no-renames", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
  const LIST = `${JSON.stringify({ repos: [{ name: "billing" }] }, null, 2)}\n`;
  // The draft the session start's offer writes, its sign that the offer was made.
  const drafted = (dir: string): void => {
    mkdirSync(join(dir, "aidlc", ".aidlc-engine", "request-text"), { recursive: true });
    writeFileSync(join(dir, ...draft.split("/")), `Update AI-DLC to ${AIDLC_VERSION}\n`);
  };

  test("one commit of AI-DLC's own files on the branch, with the drafted message, a file staged elsewhere kept staged, nothing pushed", () => {
    const { dir } = projectBehind("claude");
    const remote = tempDir("remote");
    git(remote, ["init", "-q", "--bare"]);
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["push", "-q", "origin", "main"]);
    const pushed = git(remote, ["rev-parse", "main"]);
    const changedBefore = refresh(dir, "claude");
    const expected = [...ownFilesToCommit(dir, changedBefore).commit].sort();
    expect(expected).toContain(".claude/settings.json");
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    git(dir, ["add", "notes.txt"]);
    // The draft the offer writes, which the person's own words replace.
    mkdirSync(join(dir, "aidlc", ".aidlc-engine", "request-text"), { recursive: true });
    writeFileSync(join(dir, ...draft.split("/")), "chore: take AI-DLC's update\n");
    const yes = run(UNIT, ["commit-record", "--update", "--commit-message-file", draft], dir);
    expect(yes.status, yes.out).toBe(0);
    const commit = git(dir, ["rev-parse", "--short", "HEAD"]);
    expect(yes.json).toEqual({
      committed: true,
      commit,
      notice: `AI-DLC's own files are committed on main as ${commit} (${expected.length} files); nothing is pushed.`,
    });
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe("chore: take AI-DLC's update");
    expect(shown(dir)).toEqual(expected);
    const again = run(UNIT, ["commit-record", "--update"], dir);
    expect(again.status, again.out).toBe(0);
    expect(again.json).toEqual({ committed: false, notice: "AI-DLC's own files here have nothing new to commit." });
    expect(git(dir, ["status", "--porcelain"])).toBe("A  notes.txt");
    expect(existsSync(join(dir, ...draft.split("/")))).toBe(false);
    expect(git(remote, ["rev-parse", "main"])).toBe(pushed);
  });

  test("asked with no offer drafted for this release, the settings file config merges stays out", () => {
    const { dir } = projectBehind("claude");
    refresh(dir, "claude");
    const yes = run(UNIT, ["commit-record", "--update"], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toEndWith("; nothing is pushed. I left .claude/settings.json for you to look over and commit.");
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe(`Update AI-DLC to ${AIDLC_VERSION}`);
    expect(shown(dir)).not.toContain(".claude/settings.json");
    expect(git(dir, ["status", "--porcelain"])).toBe("M .claude/settings.json");
  });

  test("in a checkout that builds a Unit it commits AI-DLC's files and the list's move, nothing else of aidlc/", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing" }] }, null, 2)}\n`));
    seedWorkspaceShell(dir);
    writeFileSync(seededStateFile(dir), readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8")
      .replace("- **Revision Count**: 0\n", "- **Revision Count**: 0\n- **Unit Build**: refunds\n"));
    refresh(dir, "claude");
    drafted(dir);
    const yes = run(UNIT, ["commit-record", "--update", "--commit-message-file", draft], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(shown(dir).filter((path) => path.startsWith("aidlc/"))).toEqual(["aidlc/repos.json"]);
    expect(shown(dir)).toContain("repos.json");
    expect(shown(dir)).toContain(".claude/skills/aidlc/SKILL.md");
  });

  // More than any platform's command line holds (Linux and macOS a few hundred kilobytes to 2 MB, Windows 32,767
  // characters), as an update to two harnesses on Windows can be.
  test("an update naming more files than a command line holds is committed in one go", () => {
    const { dir } = projectBehind("claude");
    refresh(dir, "claude");
    const manifestPath = join(dir, ".claude", "tools", "data", "aidlc-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { files: Record<string, string> };
    const folder = join(dir, ".claude", "aidlc-common", "many");
    mkdirSync(folder, { recursive: true });
    const pad = "x".repeat(160);
    for (let at = 0; at < 12_000; at++) {
      const name = `file-${String(at).padStart(5, "0")}-${pad}.md`;
      const text = `${at}\n`;
      writeFileSync(join(folder, name), text);
      manifest.files[`.claude/aidlc-common/many/${name}`] = `sha256:${createHash("sha256").update(text).digest("hex")}`;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const yes = run(UNIT, ["commit-record", "--update"], dir);
    expect(yes.status, yes.out.slice(0, 2000)).toBe(0);
    expect(Number(/\((\d+) files\)/.exec(String(yes.json?.notice))?.[1])).toBeGreaterThan(12_000);
    expect(git(dir, ["status", "--porcelain", "--", ".claude"])).toBe("M .claude/settings.json");
  });

  test("in a checkout that builds a Unit, the move alone is committed as one commit of its own", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing" }] }, null, 2)}\n`));
    seedWorkspaceShell(dir);
    writeFileSync(seededStateFile(dir), readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8")
      .replace("- **Revision Count**: 0\n", "- **Revision Count**: 0\n- **Unit Build**: refunds\n"));
    const changedBefore = refresh(dir, "claude");
    // The files went in already; only the move is left to make and commit.
    git(dir, ["add", "--", ".claude"]);
    git(dir, ["commit", "-q", "-m", "the files", "--", ".claude"]);
    expect(ownFilesToCommit(dir, changedBefore).commit).toEqual(["repos.json", "aidlc/repos.json"]);
    drafted(dir);
    const yes = run(UNIT, ["commit-record", "--update", "--commit-message-file", draft], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(shown(dir)).toEqual(["aidlc/repos.json", "repos.json"]);
  });

  // The refresh leaves a list git tracks at the root; the yes to the offer that named the move makes it, in the
  // commit's own index, so nothing is staged before the yes or after it, and a file staged elsewhere stays staged.
  test("the yes to the offer moves the list into aidlc/ and commits it with the files; nothing is staged before or after", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), LIST));
    refresh(dir, "claude");
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    git(dir, ["add", "notes.txt"]);
    drafted(dir);
    const yes = run(UNIT, ["commit-record", "--update", "--commit-message-file", draft], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(yes.json?.committed).toBe(true);
    expect(git(dir, ["show", "--name-status", "--format=", "HEAD", "--", "repos.json", "aidlc/repos.json"]))
      .toMatch(/^R\d*\trepos\.json\taidlc\/repos\.json$/);
    expect(readFileSync(join(dir, "aidlc", "repos.json"), "utf-8")).toBe(LIST);
    expect(existsSync(join(dir, "repos.json"))).toBe(false);
    expect(git(dir, ["status", "--porcelain", "--", "repos.json", "aidlc/repos.json"])).toBe("");
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("notes.txt");
    const again = run(UNIT, ["commit-record", "--update"], dir);
    expect(again.json?.committed).toBe(false);
  });

  // With no offer drafted, nothing named the move, so the yes leaves the list where it is.
  test("asked with no offer drafted, a list git tracks stays at the root and nothing of it is staged", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), LIST));
    refresh(dir, "claude");
    const yes = run(UNIT, ["commit-record", "--update"], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(shown(dir)).not.toContain("repos.json");
    expect(shown(dir)).not.toContain("aidlc/repos.json");
    expect(readFileSync(join(dir, "repos.json"), "utf-8")).toBe(LIST);
    expect(git(dir, ["status", "--porcelain", "--", "repos.json", "aidlc/repos.json"])).toBe("");
  });

  // The answer "commit them, but leave repos.json": the offer's command with --leave for the list takes the files
  // and leaves the list at the root. That commit spends the offer's draft, so a later move on their word is git's own.
  test("commit them but leave repos.json: the files go in, the list stays at the root; a later move is git's own two commands", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), LIST));
    refresh(dir, "claude");
    drafted(dir);
    const kept = run(UNIT, ["commit-record", "--update", "--leave", "repos.json", "--commit-message-file", draft], dir);
    expect(kept.status, kept.out).toBe(0);
    const commit = git(dir, ["rev-parse", "--short", "HEAD"]);
    expect(kept.json).toEqual({
      committed: true,
      commit,
      notice: `AI-DLC's own files are committed on main as ${commit} (${shown(dir).length} files); nothing is pushed.`,
    });
    expect(shown(dir)).not.toContain("repos.json");
    expect(readFileSync(join(dir, "repos.json"), "utf-8")).toBe(LIST);
    expect(git(dir, ["status", "--porcelain", "--", "repos.json", "aidlc/repos.json"])).toBe("");
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
    expect(existsSync(join(dir, ...draft.split("/")))).toBe(false);
    // Later, "move it now", with the draft spent: AI-DLC's command has nothing to take, and git's own two do it.
    const later = run(UNIT, ["commit-record", "--update"], dir);
    expect(later.json).toEqual({ committed: false, notice: "AI-DLC's own files here have nothing new to commit." });
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    git(dir, ["add", "notes.txt"]);
    git(dir, ["mv", "repos.json", "aidlc/repos.json"]);
    git(dir, ["commit", "-q", "-m", "Move repos.json into aidlc/", "--", "repos.json", "aidlc/repos.json"]);
    expect(git(dir, ["show", "--name-status", "--format=", "HEAD"])).toMatch(/^R\d*\trepos\.json\taidlc\/repos\.json$/);
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("notes.txt");
  });

  // The list's two paths go together: naming either one with --leave leaves the whole list where it is.
  test("--leave with either of the list's paths leaves the list at the root, and HEAD still has it", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), LIST));
    refresh(dir, "claude");
    drafted(dir);
    const kept = run(UNIT, ["commit-record", "--update", "--leave", "aidlc/repos.json", "--commit-message-file", draft], dir);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.json?.committed).toBe(true);
    // Nothing of the list changed, so the notice says nothing of it.
    expect(String(kept.json?.notice)).toEndWith("; nothing is pushed.");
    expect(shown(dir)).not.toContain("repos.json");
    expect(git(dir, ["show", "HEAD:repos.json"])).toBe(LIST.trimEnd());
    expect(readFileSync(join(dir, "repos.json"), "utf-8")).toBe(LIST);
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(false);
    expect(git(dir, ["status", "--porcelain", "--", "repos.json", "aidlc/repos.json"])).toBe("");
  });

  // A change of the person's to the list stays theirs: staged, with the working file put back as HEAD has it, it
  // is neither moved nor committed, and their staged bytes stay staged.
  test("a list the person staged a change to is not moved or committed, and stays staged as they left it", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), LIST));
    writeFileSync(join(dir, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing" }, { name: "ledger" }] }, null, 2)}\n`);
    git(dir, ["add", "repos.json"]);
    const staged = git(dir, ["rev-parse", ":repos.json"]);
    writeFileSync(join(dir, "repos.json"), LIST);
    const changedBefore = refresh(dir, "claude");
    expect(ownFilesToCommit(dir, changedBefore).commit).not.toContain("repos.json");
    drafted(dir);
    const yes = run(UNIT, ["commit-record", "--update", "--commit-message-file", draft], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(shown(dir)).not.toContain("repos.json");
    expect(git(dir, ["rev-parse", ":repos.json"])).toBe(staged);
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(false);
  });

  // Their hook refusing the commit, or git refusing it for want of a name: the list goes back where it was.
  test("a commit that does not go through leaves the list at the root, as it was", () => {
    const { dir } = projectBehind("claude", (d) => writeFileSync(join(d, "repos.json"), LIST));
    refresh(dir, "claude");
    const head = git(dir, ["rev-parse", "HEAD"]);
    drafted(dir);
    const status = git(dir, ["status", "--porcelain"]);
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho no commits today >&2\nexit 1\n", { mode: 0o755 });
    const refused = run(UNIT, ["commit-record", "--update", "--commit-message-file", draft], dir);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("no commits today");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(dir, "repos.json"), "utf-8")).toBe(LIST);
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(false);
    expect(git(dir, ["status", "--porcelain"])).toBe(status);
    unlinkSync(join(dir, ".git", "hooks", "pre-commit"));
    git(dir, ["config", "--unset", "user.name"]);
    git(dir, ["config", "--unset", "user.email"]);
    git(dir, ["config", "user.useConfigOnly", "true"]);
    const noName: NodeJS.ProcessEnv = { ...ENV, GIT_CONFIG_GLOBAL: join(dir, "no-global-gitconfig") };
    for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete noName[key];
    const nameless = run(UNIT, ["commit-record", "--update", "--commit-message-file", draft], dir, noName);
    expect(nameless.status).not.toBe(0);
    expect(nameless.out).toContain("Git has no name and email for your commits yet.");
    expect(readFileSync(join(dir, "repos.json"), "utf-8")).toBe(LIST);
    expect(existsSync(join(dir, "aidlc", "repos.json"))).toBe(false);
    expect(git(dir, ["status", "--porcelain"])).toBe(status);
  });

  test("with two harnesses, --leave keeps out the settings file that held their words and the clean one goes in", () => {
    const dir = tempDir("update-two");
    git(dir, ["init", "-q", "-b", "main"]);
    repo(dir);
    config(dir, "claude", earlierTree("claude"));
    config(dir, "codex", earlierTree("codex", true));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "setup"]);
    const settings = join(dir, ".claude", "settings.json");
    const value = JSON.parse(readFileSync(settings, "utf-8")) as { permissions?: { allow?: string[] } };
    writeFileSync(settings, `${JSON.stringify({ ...value, permissions: { ...value.permissions, allow: [...(value.permissions?.allow ?? []), "Bash(make test)"] } }, null, 2)}\n`);
    const before = changed(dir);
    config(dir, "claude", join(REPO_ROOT, "dist", "claude"));
    config(dir, "codex", join(REPO_ROOT, "dist", "codex"));
    const own = ownFilesToCommit(dir, (path) => before.has(path));
    expect(own.held).toEqual([".claude/settings.json"]);
    expect(own.commit).toContain(".codex/config.toml");
    mkdirSync(join(dir, "aidlc", ".aidlc-engine", "request-text"), { recursive: true });
    writeFileSync(join(dir, ...draft.split("/")), "chore: take AI-DLC's update\n");
    const yes = run(UNIT, ["commit-record", "--update", "--leave", ".claude/settings.json", "--commit-message-file", draft], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(shown(dir)).toContain(".codex/config.toml");
    expect(shown(dir)).not.toContain(".claude/settings.json");
    expect(String(yes.json?.notice)).toEndWith("I left .claude/settings.json for you to look over and commit.");
    expect(readFileSync(settings, "utf-8")).toContain("Bash(make test)");
  });

  test("--leave refuses a path that is not one inside the project, before anything is committed", () => {
    const { dir } = projectBehind("claude");
    refresh(dir, "claude");
    const head = git(dir, ["rev-parse", "HEAD"]);
    for (const path of ["-x", "../outside.json", "/etc/hosts", "C:/Windows/win.ini", ".claude/../../outside.json"]) {
      const refused = run(UNIT, ["commit-record", "--update", "--leave", path], dir);
      expect(refused.status, path).not.toBe(0);
      expect(refused.status, path).toBe(2);
      expect(refused.out).toContain("unit commit-record --leave takes a path inside this project, as the session start wrote it (such as .claude/settings.json)");
      expect(refused.out).toContain("run the command exactly as it was written. Nothing was committed.");
    }
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("on no branch, with a merge under way, or when their hook refuses, nothing is committed", () => {
    const { dir } = projectBehind("claude");
    refresh(dir, "claude");
    const head = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "--detach"]);
    const detached = run(UNIT, ["commit-record", "--update"], dir);
    expect(detached.status).not.toBe(0);
    expect(detached.out).toContain("This checkout is not on a branch, so nothing was committed. Switch to a branch, then I can commit AI-DLC's own files.");
    git(dir, ["checkout", "-q", "main"]);
    writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${head}\n`);
    const merging = run(UNIT, ["commit-record", "--update"], dir);
    expect(merging.status).not.toBe(0);
    expect(merging.out).toContain("This checkout is in the middle of a merge, so nothing was committed.");
    expect(merging.out).toContain("then I can commit AI-DLC's own files.");
    unlinkSync(join(dir, ".git", "MERGE_HEAD"));
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho no commits today >&2\nexit 1\n", { mode: 0o755 });
    const refused = run(UNIT, ["commit-record", "--update"], dir);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("no commits today");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
  });
});

// opencode carries no session-start context, so the engine's next step puts the same question, with the agent's
// draft before it and the same yes, once; the other harnesses keep the session start's own.
describe("on opencode, the engine's next step puts the update's question", () => {
  const draft = `aidlc/.aidlc-engine/request-text/unit-record-message-update-${AIDLC_VERSION}.txt`;
  const opencode = { ...ENV, AIDLC_HARNESS_NAME: "opencode" };

  // A project the earlier release set up, with work under way in it, just refreshed by the session start, which
  // wrote the update's draft as its sign that it worked the offer out.
  function updatedWithWork(list = false): string {
    const { dir } = projectBehind("claude", (d) => {
      seedWorkspaceShell(d);
      writeFileSync(seededStateFile(d), readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8"));
      if (list) writeFileSync(join(d, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing" }] }, null, 2)}\n`);
    });
    refresh(dir, "claude");
    mkdirSync(join(dir, "aidlc", ".aidlc-engine", "request-text"), { recursive: true });
    writeFileSync(join(dir, ...draft.split("/")), `Update AI-DLC to ${AIDLC_VERSION}\n`);
    return dir;
  }

  const step = (dir: string, env: NodeJS.ProcessEnv = opencode): Record<string, unknown> => {
    const r = run(ORCH, ["next"], dir, env);
    expect(r.json, r.out).not.toBeNull();
    return r.json ?? {};
  };

  test("the step drafts the message, asks the passed question and gives the yes; it is not given again", () => {
    const dir = updatedWithWork();
    // The person's own words in a file AI-DLC wrote, after the refresh: left and named, never counted.
    appendFileSync(join(dir, ".claude", "skills", "aidlc", "SKILL.md"), "\nOur own note.\n");
    const own = ownFilesToCommit(dir, () => true);
    expect(own.held).toContain(".claude/settings.json");
    expect(own.left).toContain(".claude/skills/aidlc/SKILL.md");
    const first = step(dir);
    expect(first.kind, JSON.stringify(first)).toBe("print");
    const message = String(first.message);
    expect(message).toContain(String(catchUpChangedLine(AIDLC_VERSION, own.commit, false, true, { branch: "main", left: own.left })));
    expect(message).toContain(`over the message in \`${draft}\``);
    expect(message).toContain("with the message from that file after it");
    expect(message).toContain("When they give their own commit message, write it to that file first");
    expect(message).toMatch(new RegExp(`On yes, run \`[^\`]* unit commit-record --update --leave \\.claude/settings\\.json --commit-message-file ${draft.replaceAll(".", "\\.")}\``));
    expect(message).toContain("On no, leave it. Do not ask again.");
    const again = step(dir);
    expect(JSON.stringify(again)).not.toContain("AI-DLC updated its own files");
  });

  test("not on another harness, not unattended, and not while a merge is under way, which it waits out", () => {
    const dir = updatedWithWork();
    expect(JSON.stringify(step(dir, ENV))).not.toContain("AI-DLC updated its own files");
    expect(JSON.stringify(step(dir, { ...opencode, AIDLC_UNATTENDED: "1" }))).not.toContain("AI-DLC updated its own files");
    const head = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${head}\n`);
    expect(JSON.stringify(step(dir))).not.toContain("AI-DLC updated its own files");
    unlinkSync(join(dir, ".git", "MERGE_HEAD"));
    expect(String(step(dir).message)).toContain("AI-DLC updated its own files");
  });

  test("with a list git tracks, the question names the move its yes makes, and the yes makes it", () => {
    const dir = updatedWithWork(true);
    expect(existsSync(join(dir, "repos.json"))).toBe(true);
    const message = String(step(dir).message);
    expect(message).toContain(", and it now keeps repos.json in aidlc/. Want me to commit them on main, as one commit of their own, " +
      "and move repos.json into aidlc/ in that commit? Nothing is pushed.");
    const yes = run(UNIT, ["commit-record", "--update", "--commit-message-file", draft], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(git(dir, ["show", "--name-status", "--format=", "HEAD", "--", "repos.json", "aidlc/repos.json"]))
      .toMatch(/^R\d*\trepos\.json\taidlc\/repos\.json$/);
  });

  test("with no draft from the session start, nothing is put", () => {
    const dir = updatedWithWork();
    unlinkSync(join(dir, ...draft.split("/")));
    expect(JSON.stringify(step(dir))).not.toContain("AI-DLC updated its own files");
  });
});

describe("the question after an update", () => {
  const head = "AI-DLC updated its own files in this project to 2.12.1:";
  test("the files, as one commit of their own on the branch, with what it leaves and the message after it", () => {
    expect(catchUpChangedLine("2.12.1", [".claude/a.md"], false, true, { branch: "main", left: [] })).toBe(
      `${head} 1 file under .claude changed. Want me to commit it on main, as one commit of its own? Nothing is pushed. ` +
        "I'd use this commit message:",
    );
    expect(catchUpChangedLine("2.12.1", [".claude/a.md", ".claude/b.md", "AGENTS.md"], false, false, { branch: "work", left: ["AGENTS.md"] })).toBe(
      `${head} 2 files under .claude and its part of AGENTS.md changed. Want me to commit them on work, as one commit of their own? ` +
        "Nothing is pushed. I'd leave AGENTS.md out, as I cannot be sure it holds only AI-DLC's changes: it is yours to look over and commit.",
    );
    const many = Array.from({ length: 12 }, (_, at) => `.claude/f${at}.md`);
    expect(catchUpChangedLine("2.12.1", many, false, true, { branch: "main", left: many })).toContain(
      "I'd leave .claude/f0.md, .claude/f1.md, .claude/f2.md, .claude/f3.md, .claude/f4.md, .claude/f5.md, .claude/f6.md, .claude/f7.md, " +
        ".claude/f8.md, .claude/f9.md and 2 more out, as I cannot be sure they hold only AI-DLC's changes: they are yours to look over and commit. " +
        "I'd use this commit message:",
    );
  });

  // Where no question is put: what AI-DLC did, and where the commit can run later (no branch, a git operation of
  // theirs under way, once it is over), that it can make it when they say. The list's move is made only by the
  // question's yes, so no line without that question says it.
  test("the line where no question is put, with the offer for later where the commit can run then, and no move", () => {
    expect(catchUpChangedLine("2.12.1", [".claude/a.md"], false)).toBe(`${head} 1 file under .claude changed. AI-DLC did not commit it.`);
    expect(catchUpChangedLine("2.12.1", [".claude/a.md", ".claude/b.md"], false, false, undefined, true)).toBe(
      `${head} 2 files under .claude changed. AI-DLC did not commit them. Say when you want me to commit them.`,
    );
    expect(catchUpChangedLine("2.12.1", [".claude/a.md"], true, false, undefined, true)).toBe(
      `${head} 1 file under .claude changed. AI-DLC did not commit it. Say when you want me to commit it.`,
    );
    expect(catchUpChangedLine("2.12.1", [], true)).toBeNull();
    expect(catchUpChangedLine("2.12.1", [], true, false, undefined, true)).toBeNull();
  });

  test("the move alone where the record's commit does not run: the yes makes it", () => {
    expect(catchUpChangedLine("2.12.1", [], true, true, { branch: "refunds", left: [] })).toBe(
      "AI-DLC now keeps repos.json in aidlc/, and this project's is at the root. Want me to move it there on refunds, as one " +
        "commit of its own? Nothing is pushed. Teammates need AI-DLC 2.12 or newer to find it there. I'd use this commit message:",
    );
  });

  test("with the repo list's move, the yes makes it with them and teammates are told what they need", () => {
    expect(catchUpChangedLine("2.12.1", [".claude/a.md", ".claude/b.md"], true, true, { branch: "refunds", left: [] })).toBe(
      `${head} 2 files under .claude changed, and it now keeps repos.json in aidlc/. Want me to commit them on refunds, as one ` +
        "commit of their own, and move repos.json into aidlc/ in that commit? Nothing is pushed. Teammates need AI-DLC 2.12 or " +
        "newer to find repos.json there. I'd use this commit message:",
    );
    expect(catchUpChangedLine("2.12.1", [".claude/a.md"], true, false, { branch: "main", left: [".claude/a.md"] })).toBe(
      `${head} 1 file under .claude changed, and it now keeps repos.json in aidlc/. Want me to commit them on main, as one ` +
        "commit of their own, and move repos.json into aidlc/ in that commit? Nothing is pushed. I'd leave .claude/a.md out, as I " +
        "cannot be sure it holds only AI-DLC's changes: it is yours to look over and commit. Teammates need AI-DLC 2.12 or newer " +
        "to find repos.json there.",
    );
  });
});
