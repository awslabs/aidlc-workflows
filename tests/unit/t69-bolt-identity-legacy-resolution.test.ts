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
function lifecycleBlock(event: "WORKTREE_CREATED" | "WORKTREE_MERGED" | "WORKTREE_DISCARDED", timestamp: string): string {
  return [
    "",
    `## ${event}`,
    `**Timestamp**: ${timestamp}`,
    `**Event**: ${event}`,
    `**Bolt slug**: ${SLUG}`,
    "**Worktree path**: .aidlc/worktrees/bolt-demo",
    ...(event === "WORKTREE_CREATED" ? ["**Branch name**: bolt-demo"] : []),
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

  test("a newer discard permits cleanup-only retry despite creation in a lexically later shard", () => {
    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_DISCARDED", DISCARDED_AT));
    seedShard("b-bbbb.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(true);
    expect(identity.name).toBe("bolt-demo");
  });

  test("a later same-shard discard permits cleanup-only retry even at the same timestamp", () => {
    seedShard("a-aaaa.md",
      lifecycleBlock("WORKTREE_CREATED", CREATED_AT),
      lifecycleBlock("WORKTREE_DISCARDED", CREATED_AT));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(true);
    expect(identity.name).toBe("bolt-demo");
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

  test("metadata naming this intent is corroboration, not authority: no lifecycle row, no adoption", () => {
    const metadataDir = join(legacyWorktreePath(project, SLUG), ".aidlc");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "worktree-meta.json"), JSON.stringify({
      intentRecord: `aidlc/spaces/${SPACE}/intents/${RECORD}`,
    }));

    expect(resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project)).legacy).toBe(false);

    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));
    expect(resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project)).legacy).toBe(true);
  });

  test("live metadata naming this intent permits retry after a frontier merge intent", () => {
    seedShard("a-aaaa.md",
      lifecycleBlock("WORKTREE_CREATED", CREATED_AT),
      lifecycleBlock("WORKTREE_MERGED", "2026-09-20T12:01:00Z"));
    const metadataDir = join(legacyWorktreePath(project, SLUG), ".aidlc");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "worktree-meta.json"), JSON.stringify({
      intentRecord: `aidlc/spaces/${SPACE}/intents/${RECORD}`,
    }));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(true);
    expect(identity.name).toBe("bolt-demo");
  });

  test("metadata rewritten to another intent strands the Bolt for both intents", () => {
    // A (the selected default intent) holds the open creation; the writable
    // metadata now names B. Conflicting evidence fails closed on both sides:
    // B has no creation authority and A's metadata no longer corroborates it.
    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));
    const otherUuid = "00000000000000000000000000000def";
    const otherRecord = `demo-${idSuffix(otherUuid)}`;
    const otherIntents = join(project, "aidlc", "spaces", "platform", "intents");
    mkdirSync(join(otherIntents, otherRecord, "audit"), { recursive: true });
    writeFileSync(join(otherIntents, otherRecord, "aidlc-state.md"), "# AI-DLC State\n");
    writeFileSync(join(otherIntents, "intents.json"), `${JSON.stringify([
      { uuid: otherUuid, slug: SLUG, dirName: otherRecord, status: "in-flight" },
    ], null, 2)}\n`);
    const metadataDir = join(legacyWorktreePath(project, SLUG), ".aidlc");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "worktree-meta.json"), JSON.stringify({
      intentRecord: `aidlc/spaces/platform/intents/${otherRecord}`,
    }));

    expect(resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project)).legacy).toBe(false);
    const asB = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project, { space: "platform", intent: otherRecord }));
    expect(asB.legacy).toBe(false);
    expect(asB.name).toBe(boltName(idSuffix(otherUuid), SLUG));
  });

  test("live metadata without intentRecord is adopted only on this intent's open creation", () => {
    const metadataDir = join(legacyWorktreePath(project, SLUG), ".aidlc");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "worktree-meta.json"), JSON.stringify({ version: 1, boltSlug: SLUG }));

    // No rows for this slug: the directory could belong to any intent in any
    // space, so it is not ours — even though this space holds exactly one intent.
    expect(resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project)).legacy).toBe(false);

    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));
    expect(resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project)).legacy).toBe(true);
  });

  test("live metadata without intentRecord is not adopted after a frontier discard intent", () => {
    seedShard("a-aaaa.md",
      lifecycleBlock("WORKTREE_CREATED", CREATED_AT),
      lifecycleBlock("WORKTREE_DISCARDED", DISCARDED_AT));
    const metadataDir = join(legacyWorktreePath(project, SLUG), ".aidlc");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "worktree-meta.json"), JSON.stringify({ version: 1, boltSlug: SLUG }));

    const identity = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    expect(identity.legacy).toBe(false);
    expect(identity.name).toBe(boltName(idSuffix(UUID), SLUG));
  });

  test("a second space's lone intent cannot adopt a live pre-intentRecord Bolt", () => {
    const metadataDir = join(legacyWorktreePath(project, SLUG), ".aidlc");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(metadataDir, "worktree-meta.json"), JSON.stringify({ version: 1, boltSlug: SLUG }));
    // The Bolt's real owner (default space) has the open creation.
    seedShard("a-aaaa.md", lifecycleBlock("WORKTREE_CREATED", CREATED_AT));

    const otherUuid = "00000000000000000000000000000def";
    const otherRecord = `demo-${idSuffix(otherUuid)}`;
    const otherIntents = join(project, "aidlc", "spaces", "platform", "intents");
    mkdirSync(join(otherIntents, otherRecord, "audit"), { recursive: true });
    writeFileSync(join(otherIntents, otherRecord, "aidlc-state.md"), "# AI-DLC State\n");
    writeFileSync(join(otherIntents, "intents.json"), `${JSON.stringify([
      { uuid: otherUuid, slug: SLUG, dirName: otherRecord, status: "in-flight" },
    ], null, 2)}\n`);

    const foreign = resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project, { space: "platform", intent: otherRecord }));
    expect(foreign.legacy).toBe(false);
    expect(foreign.name).toBe(boltName(idSuffix(otherUuid), SLUG));
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

  test("two registered intents sharing an eight-character uuid suffix fail closed", () => {
    // Same trailing eight hex chars as UUID, different uuid, different space.
    const twinUuid = `ffffffffffffffffffffffff${idSuffix(UUID)}`;
    const twinRecord = `twin-${idSuffix(twinUuid)}`;
    const twinIntents = join(project, "aidlc", "spaces", "platform", "intents");
    mkdirSync(join(twinIntents, twinRecord), { recursive: true });
    writeFileSync(join(twinIntents, twinRecord, "aidlc-state.md"), "# AI-DLC State\n");
    writeFileSync(join(twinIntents, "intents.json"), `${JSON.stringify([
      { uuid: twinUuid, slug: "twin", dirName: twinRecord, status: "in-flight" },
    ], null, 2)}\n`);

    let error: unknown;
    try {
      resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BoltIdentityError);
    expect(error).toHaveProperty("code", "AMBIGUOUS_INTENT_ID8");
  });

  test("a second registry record carrying the same full uuid also fails closed", () => {
    // A hand-edited or badly merged registry: same uuid, different record.
    const twinRecord = "twin-copy";
    const twinIntents = join(project, "aidlc", "spaces", "platform", "intents");
    mkdirSync(join(twinIntents, twinRecord), { recursive: true });
    writeFileSync(join(twinIntents, twinRecord, "aidlc-state.md"), "# AI-DLC State\n");
    writeFileSync(join(twinIntents, "intents.json"), `${JSON.stringify([
      { uuid: UUID, slug: "twin", dirName: twinRecord, status: "in-flight" },
    ], null, 2)}\n`);

    let error: unknown;
    try {
      resolveBoltIdentity(project, SLUG, resolveWorkflowSelection(project));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BoltIdentityError);
    expect(error).toHaveProperty("code", "AMBIGUOUS_INTENT_ID8");
  });
});
