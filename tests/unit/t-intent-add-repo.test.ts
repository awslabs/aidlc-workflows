// covers: cli:aidlc-utility(intent add-repo, intent remove-repo), function:handleIntentRepos
//
// A piece of work that already records sibling repos gains or loses one by the
// person's own word, until Units Generation is approved. The engine checks the
// name and the folder (a real .git entry, which a commit can never carry),
// writes the registry row under the workspace lock, records
// INTENT_REPOS_CHANGED first, and says one line in the person's words.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  intentsDirOf,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { readUnitSourceManifest } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
let proj: string;

function utility(args: string[]): { rc: number; out: string } {
  const r = spawnSync(process.execPath, [UTIL, ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function git(dir: string, args: string[]): void {
  const r = spawnSync(
    "git",
    ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

// A sibling code repo: an immediate child of the workspace with its own .git.
function siblingRepo(name: string): void {
  const dir = join(proj, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "seed"]);
}

function registry(): string {
  return join(intentsDirOf(proj), "intents.json");
}

function recordRepos(repos: string[]): void {
  const rows = JSON.parse(readFileSync(registry(), "utf-8")) as Array<Record<string, unknown>>;
  writeFileSync(registry(), `${JSON.stringify(rows.map((row) => ({ ...row, repos })), null, 2)}\n`);
}

function repos(): string[] | undefined {
  return (JSON.parse(readFileSync(registry(), "utf-8")) as Array<{ repos?: string[] }>)[0].repos;
}

function audit(): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf-8")).join("\n");
}

function setCheckbox(slug: string, mark: string): void {
  const statePath = seededStateFile(proj);
  const state = readFileSync(statePath, "utf-8");
  writeFileSync(statePath, state.replace(new RegExp(`^- \\[.\\] ${slug} `, "m"), `- [${mark}] ${slug} `));
}

describe("intent add-repo / remove-repo", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md"); // Current Stage: feasibility; Units Generation pending
    siblingRepo("app-a");
    siblingRepo("app-b");
    recordRepos(["app-a"]);
  });

  afterEach(() => cleanupTestProject(proj));

  test("adds a sibling repo: the registry row, the audit row, one line", () => {
    const r = utility(["intent", "add-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a", "app-b"]);
    expect(r.out).toContain("Added app-b to this piece of work's repos.");
    expect(r.out).toContain("You can remove it again any time.");
    const rows = audit();
    expect(rows).toContain("**Event**: INTENT_REPOS_CHANGED");
    expect(rows).toContain("**Added**: app-b");
    expect(rows).toContain("**Repos**: app-a, app-b");
  });

  test("the Construction manifest that named the repo is accepted once the repo is recorded", () => {
    const dir = join(seededRecordDir(proj), "construction", "alpha", "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "source-manifest.json"),
      `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [{ repo: "app-b", path: "src/" }] })}\n`,
    );
    const before = readUnitSourceManifest(proj, "code-generation", "alpha");
    expect(before.ok).toBe(false);
    if (!before.ok) {
      expect(before.reason).toContain('"app-b" is not recorded for this intent');
      expect(before.unrecordedRepo).toBe("app-b");
    }
    expect(utility(["intent", "add-repo", "app-b"]).rc).toBe(0);
    expect(readUnitSourceManifest(proj, "code-generation", "alpha").ok).toBe(true);
  });

  test("a repo already recorded changes nothing and says so", () => {
    const r = utility(["intent", "add-repo", "app-a"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a"]);
    expect(r.out).toContain("app-a is already one of this piece of work's repos; nothing changed.");
    expect(audit()).not.toContain("INTENT_REPOS_CHANGED");
  });

  test("refuses a name that is not a repo name", () => {
    const r = utility(["intent", "add-repo", "../outside"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("is not a repo name");
    expect(repos()).toEqual(["app-a"]);
  });

  test("refuses a folder without a real .git entry, including a committed folder shaped like a repo", () => {
    const shaped = join(proj, "vendor");
    mkdirSync(join(shaped, "objects"), { recursive: true });
    mkdirSync(join(shaped, "refs"), { recursive: true });
    writeFileSync(join(shaped, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(shaped, "config"), "[core]\n\tbare = false\n\tworktree = .\n");
    const r = utility(["intent", "add-repo", "vendor"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("is not a Git checkout under the workspace folder");
    expect(repos()).toEqual(["app-a"]);
    const missing = utility(["intent", "add-repo", "nowhere"]);
    expect(missing.rc).not.toBe(0);
    expect(missing.out).toContain("is not a Git checkout under the workspace folder");
  });

  test("refuses when the piece of work records no repos: the workspace folder is its repo", () => {
    recordRepos([]);
    const r = utility(["intent", "add-repo", "app-b"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("treats the workspace folder itself as its code repo");
    expect(repos()).toEqual([]);
  });

  test("removes a repo, never the last one", () => {
    recordRepos(["app-a", "app-b"]);
    const r = utility(["intent", "remove-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a"]);
    expect(r.out).toContain("Removed app-b from this piece of work's repos. You can add it back any time.");
    expect(audit()).toContain("**Removed**: app-b");
    const last = utility(["intent", "remove-repo", "app-a"]);
    expect(last.rc).not.toBe(0);
    expect(last.out).toContain("is the only repo this piece of work records");
    expect(repos()).toEqual(["app-a"]);
    const absent = utility(["intent", "remove-repo", "app-b"]);
    expect(absent.rc, absent.out).toBe(0);
    expect(absent.out).toContain("app-b is not one of this piece of work's repos");
  });

  test("after Units Generation is approved nothing changes and the go-back question is asked", () => {
    setCheckbox("units-generation", "x");
    const r = utility(["intent", "add-repo", "app-b"]);
    expect(r.rc, r.out).toBe(0);
    expect(repos()).toEqual(["app-a"]);
    expect(r.out).toContain(
      "Units Generation is already approved, so its Units do not cover app-b. Do you want me to go back to Units Generation with app-b added?",
    );
    expect(audit()).not.toContain("INTENT_REPOS_CHANGED");
  });

  test("the line says what Reverse Engineering will do for the new repo", () => {
    const pending = utility(["intent", "add-repo", "app-b"]);
    expect(pending.out).toContain("Reverse Engineering will cover app-b when it runs.");
    recordRepos(["app-a"]);
    setCheckbox("reverse-engineering", "x");
    const done = utility(["intent", "add-repo", "app-b"]);
    expect(done.out).toContain(
      "Reverse Engineering has not documented app-b yet, so it and the stages that read the code knowledge may show as behind until you revisit them.",
    );
  });
});
