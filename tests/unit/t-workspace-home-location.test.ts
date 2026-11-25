// covers: function:workspaceHomeLocation, function:buildOutBlockedLine
//
// Where team work across repos keeps its claims: the workspace's own
// repository, read where the project sits in it (projectInRepo, the one
// reading). Its remote when the workspace is that repository's top, "local"
// with no remote, and none outside git or in a folder below the top, where the
// lead's record is not where a take reads it. Built with real git.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceHomeLocation } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function folder(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aidlc-home-${label}-`));
  dirs.push(dir);
  return dir;
}

function repository(remote?: string): string {
  const dir = folder("repo");
  git(dir, ["init", "-q", "-b", "main"]);
  if (remote !== undefined) git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

describe("the workspace's home", () => {
  test("at its repository's top: the remote's address, or local with none", () => {
    expect(workspaceHomeLocation(repository("https://git.example.test/team/checkout.git"))).toBe(
      "https://git.example.test/team/checkout.git",
    );
    expect(workspaceHomeLocation(repository())).toBe("local");
  });

  test("in a folder below the top, or outside git: none", () => {
    const top = repository("https://git.example.test/team/monorepo.git");
    const project = join(top, "apps", "x");
    mkdirSync(project, { recursive: true });
    expect(workspaceHomeLocation(project)).toBeNull();
    expect(workspaceHomeLocation(folder("plain"))).toBeNull();
  });

  // A repository git will not read here (a .git link to a folder that is gone,
  // as git refuses a repository whose owner is someone else): none, where the
  // folder's own .git once read as a home recorded as local.
  test("a .git git cannot read: none", () => {
    const dir = folder("broken");
    writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "gone")}\n`);
    expect(workspaceHomeLocation(dir)).toBeNull();
  });
});
