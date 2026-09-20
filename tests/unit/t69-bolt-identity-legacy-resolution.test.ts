// covers: function:resolveBoltIdentity
//
// Mechanism: in-process imports of resolveBoltIdentity/resolveWorkflowSelection
// from core/tools/aidlc-lib.ts against a temp project. No git is needed because
// cleanup-only resolution reads only the filesystem and audit shards.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoltIdentityError,
  boltName,
  idSuffix,
  legacyWorktreePath,
  resolveBoltIdentity,
  resolveWorkflowSelection,
} from "../../core/tools/aidlc-lib.ts";

const SPACE = "default";
const SLUG = "demo";
const UUID = "00000000000000000000000000000abc";
const RECORD = `demo-${idSuffix(UUID)}`;
const CREATED_AT = "2026-09-20T12:00:00Z";
const DISCARDED_AT = "2026-09-20T12:01:00Z";

let project: string;
let recordDir: string;

function seedRegistry(uuid: string | null = UUID): void {
  writeFileSync(join(project, "aidlc", "spaces", SPACE, "intents", "intents.json"), `${JSON.stringify([
    { ...(uuid === null ? {} : { uuid }), slug: SLUG, dirName: RECORD, status: "in-flight" },
  ], null, 2)}\n`);
}

// Mirror t164's shard blocks, including the project-relative path written by
// aidlc-worktree and the separator consumed by parseAuditShardEvents.
function lifecycleBlock(event: "WORKTREE_CREATED" | "WORKTREE_DISCARDED", timestamp: string): string {
  return [
    "",
    `## ${event}`,
    `**Timestamp**: ${timestamp}`,
    `**Event**: ${event}`,
    `**Bolt slug**: ${SLUG}`,
    "**Worktree path**: .aidlc/worktrees/bolt-demo",
    "**Branch name**: bolt-demo",
    "",
    "---",
    "",
  ].join("\n");
}

function seedShard(name: string, ...blocks: string[]): void {
  writeFileSync(join(recordDir, "audit", name), blocks.join(""));
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t69-legacy-")));
  const intentsDir = join(project, "aidlc", "spaces", SPACE, "intents");
  recordDir = join(intentsDir, RECORD);
  mkdirSync(join(recordDir, "audit"), { recursive: true });
  // Mirrors seedWorkspaceShell + setupWorktreeFixture's minimal state file.
  writeFileSync(join(project, "aidlc", "active-space"), `${SPACE}\n`);
  writeFileSync(join(intentsDir, "active-intent"), `${RECORD}\n`);
  writeFileSync(join(recordDir, "aidlc-state.md"), "# AI-DLC State\n");
  seedRegistry();
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("resolveBoltIdentity legacy provenance", () => {
  test("an open creation resolves a cleanup-only legacy Bolt", () => {
    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(true);
    expect(identity.branch).toBe("bolt-demo");
    expect(identity.dir).toBe(legacyWorktreePath(project, SLUG));
  });

  test("a newer discard closes a creation in a lexically later shard", () => {
    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_DISCARDED", DISCARDED_AT));
    seedShard("b-bbbb.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(false);
    expect(identity.name).toBe(boltName(idSuffix(UUID), SLUG));
  });

  test("a later same-shard discard closes a creation even at the same timestamp", () => {
    seedShard("a-aaaa.md",
      lifecycleBlock("WORKTREE_CREATED", CREATED_AT),
      lifecycleBlock("WORKTREE_DISCARDED", CREATED_AT));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(false);
    expect(identity.name).toBe(boltName(idSuffix(UUID), SLUG));
  });

  test("a cross-shard creation and discard timestamp tie fails closed", () => {
    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_DISCARDED", CREATED_AT));
    seedShard("b-bbbb.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(false);
    expect(identity.name).toBe(boltName(idSuffix(UUID), SLUG));
  });

  test("an unreadable selected-intent shard prevents legacy adoption", () => {
    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));
    const target = join(project, "external-audit.md");
    writeFileSync(target, "# External audit\n");
    // A regular-file target keeps refusal about the symlink, not missing bytes.
    symlinkSync(target, join(recordDir, "audit", "z-zzzz.md"), "file");

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(false);
    expect(identity.name).toBe(boltName(idSuffix(UUID), SLUG));
  });

  test("foreign live metadata is never overridden by this intent's open creation", () => {
    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));
    const metadataDir = join(legacyWorktreePath(project, SLUG), ".aidlc");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "worktree-meta.json"), JSON.stringify({
      intentRecord: "aidlc/spaces/default/intents/other-ffffffff",
    }));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(false);
    expect(identity.name).toBe(boltName(idSuffix(UUID), SLUG));
  });

  test("a selected intent without a registry UUID fails closed", () => {
    seedRegistry(null);
    let error: unknown;
    try {
      resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BoltIdentityError);
    expect(error).toHaveProperty("code", "NO_INTENT_UUID");
  });
});
