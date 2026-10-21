// covers: function:reverseEngineeringScopeNarration, function:RE_LARGE_SCOPE_REPOS

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RE_LARGE_SCOPE_REPOS,
  reverseEngineeringScopeNarration,
} from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";

const roots: string[] = [];

function workspaceWithRepos(count: number): string {
  const root = mkdtempSync(join(tmpdir(), "re-scope-"));
  roots.push(root);
  for (let index = 0; index < count; index++) {
    const repo = join(root, `repo-${index}`);
    mkdirSync(join(repo, ".git"), { recursive: true });
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reverseEngineeringScopeNarration", () => {
  test("says nothing for a workspace that is one repository", () => {
    expect(reverseEngineeringScopeNarration(workspaceWithRepos(1))).toBeNull();
    expect(reverseEngineeringScopeNarration(workspaceWithRepos(0))).toBeNull();
  });

  test("names the repository count for a scope larger than one", () => {
    const line = reverseEngineeringScopeNarration(workspaceWithRepos(3));
    expect(line).toBe("Reverse Engineering reads 3 repositories here.");
  });

  test("explains the time and token cost at the large-scope threshold", () => {
    const line = reverseEngineeringScopeNarration(workspaceWithRepos(RE_LARGE_SCOPE_REPOS));
    expect(line).toContain(`reads ${RE_LARGE_SCOPE_REPOS} repositories`);
    expect(line).toContain("may take significant time and consume many tokens");
    expect(line).toContain("all 10 are analysed");
    expect(line).not.toContain("limit");
  });
});
