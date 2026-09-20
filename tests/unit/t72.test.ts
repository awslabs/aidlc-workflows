// covers: subcommand:aidlc-worktree:info
//
// Exercise the real info CLI: audit lookup must preserve the recorded branch
// spelling while exposing a namespaced intent id only for the new shape.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boltName, legacyBoltName, legacyWorktreePath, worktreePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  fixtureIntentId8,
  seededAuditShard,
  seededStateFile,
} from "../harness/fixtures.ts";

const TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
let projDir = "";

function writeAudit(content: string): void {
  const shard = seededAuditShard(projDir);
  mkdirSync(join(shard, ".."), { recursive: true });
  writeFileSync(shard, `${content}\n`, "utf-8");
}

function creation(slug: string, branch: string, path: string, timestamp = "2026-05-18T10:00:00Z"): string {
  return `## Worktree Created
**Timestamp**: ${timestamp}
**Event**: WORKTREE_CREATED
**Bolt slug**: ${slug}
**Worktree path**: ${path}
**Branch name**: ${branch}
**Base branch**: main

---`;
}

function runInfo(slug: string): { rc: number; out: string } {
  const res = spawnSync(process.execPath, [TOOL, "info", "--slug", slug, "--project-dir", projDir], {
    encoding: "utf-8",
    cwd: projDir,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

beforeEach(() => {
  projDir = createTestProject();
  writeFileSync(seededStateFile(projDir), "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: CONSTRUCTION\n");
});
afterEach(() => {
  cleanupTestProject(projDir);
  projDir = "";
});

describe("t72 info: namespaced and legacy audit entries", () => {
  test("returns the namespaced branch, canonical path, intent id, and unchanged slug", () => {
    const slug = "onboarding";
    const id8 = fixtureIntentId8(projDir);
    const branch = boltName(id8, slug);
    const path = worktreePath(projDir, id8, slug);
    writeAudit(creation(slug, branch, path));
    const result = runInfo(slug);
    expect(result.rc, result.out).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ slug, path, branch_name: branch, intent_id8: id8 });
  });

  test("preserves the legacy branch verbatim without inventing a namespace", () => {
    // Deliberate pre-upgrade audit entry; compatibility must not rename it.
    const slug = "abcdef01-api";
    const branch = legacyBoltName(slug);
    const path = legacyWorktreePath(projDir, slug);
    writeAudit(creation(slug, branch, path));
    const result = runInfo(slug);
    expect(result.rc, result.out).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ slug, path, branch_name: branch, intent_id8: null });
  });

  test("returns the latest creation for the slug across the legacy-to-new transition", () => {
    const slug = "api";
    const id8 = fixtureIntentId8(projDir);
    // Deliberate legacy predecessor in the same intent's audit history.
    writeAudit([
      creation(slug, legacyBoltName(slug), legacyWorktreePath(projDir, slug)),
      creation(slug, boltName(id8, slug), worktreePath(projDir, id8, slug), "2026-05-18T11:00:00Z"),
    ].join("\n\n"));
    const result = runInfo(slug);
    expect(result.rc, result.out).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      path: worktreePath(projDir, id8, slug), branch_name: boltName(id8, slug), intent_id8: id8,
    });
  });

  test("refuses a missing slug rather than returning another Bolt's entry", () => {
    const id8 = fixtureIntentId8(projDir);
    writeAudit(creation("other", boltName(id8, "other"), worktreePath(projDir, id8, "other")));
    expect(runInfo("missing").rc).not.toBe(0);
  });

  test("refuses a malformed creation missing its worktree path", () => {
    writeAudit(creation("broken", boltName(fixtureIntentId8(projDir), "broken"), "").replace("**Worktree path**: \n", ""));
    expect(runInfo("broken").rc).not.toBe(0);
  });
});
