// covers: function:unbackedGitlinkWarnings

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unbackedGitlinkWarnings } from "../../dist/claude/.claude/tools/aidlc-swarm.ts";

const roots: string[] = [];

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "swarm-gitlink-"));
  roots.push(root);
  const inner = join(root, "src", "pkg");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "a.txt"), "a\n");
  git(inner, ["init", "-q"]);
  git(inner, ["add", "."]);
  git(inner, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "inner"]);
  git(root, ["init", "-q"]);
  git(root, ["add", "src/pkg"]);
  git(root, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "outer"]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("unbackedGitlinkWarnings", () => {
  test("names a nested repository recorded without a .gitmodules entry", () => {
    const warnings = unbackedGitlinkWarnings(workspace());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("src/pkg");
    expect(warnings[0]).toContain("empty folder");
    expect(warnings[0]).toContain("not staged by git");
  });

  test("says nothing once .gitmodules declares the path", () => {
    const root = workspace();
    writeFileSync(join(root, ".gitmodules"), '[submodule "pkg"]\n\tpath = src/pkg\n\turl = ../pkg\n');
    git(root, ["add", ".gitmodules"]);
    git(root, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "declare"]);
    expect(unbackedGitlinkWarnings(root)).toEqual([]);
  });

  test("says nothing for a repository with no gitlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "swarm-plain-"));
    roots.push(root);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["init", "-q"]);
    git(root, ["add", "."]);
    git(root, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "plain"]);
    expect(unbackedGitlinkWarnings(root)).toEqual([]);
  });
});
