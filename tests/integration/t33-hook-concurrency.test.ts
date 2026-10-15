// covers: hook:aidlc-write-audit-log, function:appendAuditEntry, function:acquireAuditLock, function:releaseAuditLock
//
// t33 - audit-logger lock contention under parallel writes. Mechanism: cli.
//
// WHY CLI (process-boundary, not in-process): the subject IS concurrency —
// five independent OS processes racing for the same mkdir-based audit lock.
// An in-process loop calling appendAuditEntry() five times would be strictly
// serial inside one process and could never exercise the inter-process lock
// contention. This test SPAWNS the real
// hook five times in parallel via node:child_process spawnSync, fired
// concurrently (today through Promise.all over Bun.spawn, no spawnSync) the
// same way Claude Code's PostToolUse(Write|Edit) drives it from settings.json.
//
// SOURCE UNDER TEST:
//   dist/claude/.claude/hooks/aidlc-write-audit-log.ts — PostToolUse(Write|Edit).
//     - resolves projectDir through resolveProjectDirFromHook (as first ported,
//       aidlc-lib.ts).
//     - reads PostToolUse JSON on stdin; logs writes under the active intent
//       record or active space codekb tree, and only when the audit shard
//       exists. A Write to a NET-NEW artifact emits ARTIFACT_CREATED with
//       fields Tool / File / Context.
//   dist/claude/.claude/tools/aidlc-audit.ts appendAuditEntry - acquires
//     the audit lock (acquireAuditLock), appends one block, then releases it
//     (releaseAuditLock). The hook takes the same lock through withAuditLock
//     and appends with appendAuditEntryUnlocked. The block format is
//     "\n## <heading>\n**Timestamp**: ...\n**Event**: ...\n<fields>\n---\n".
//   dist/claude/.claude/tools/aidlc-lib.ts auditLockDir(projectDir) =
//     join(tmpdir(), `.aidlc-audit-<8 hex of md5(auditLockIdentity)>.lock`), the
//     mkdir-based mutex's directory (acquireAuditLock / releaseAuditLock); we
//     ask the source for it via auditLockDir() rather than recompute the hash.
//
// FIXTURE DISCIPLINE:
//   - createTestProject() -> a fresh temp project.
//   - seedStateFile() establishes the active intent; the test pins a clone ID
//     and copies tests/fixtures/audit-sample.md into its resolved audit shard,
//     which carries exactly ONE ARTIFACT_CREATED block (INITIAL_ENTRIES = 1,
//     verified against the fixture). The hook self-gates on the shard existing,
//     so seeding it is the precondition for the emit.
//   - The hook is spawned at the SHIPPED source path (AIDLC_SRC/hooks/...).
//     No copied skeleton is needed because audit-logger imports its audit
//     writer directly (no re-spawn of a project-local tool).
//   - cleanupTestProject() removes the temp project; the lock dir lives under
//     tmpdir() and is asserted-then-removed (afterEach safety) so no cross-test
//     bleed. Nothing is written under tests/fixtures/**.
//
// The no-corruption row checks separator counts and Timestamp/Event adjacency;
// the lock-cleanup row pins the source-computed lock dir, not a hand-recomputed
// hash.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { setDefaultTimeout, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seededAuditDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  auditLockDir,
  docsRoot,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-write-audit-log.ts");

// The audit trail is a DIR of per-clone shards. We PIN one clone-id on disk so
// all five parallel processes resolve the SAME shard - that reproduces the
// contract (five racing appends to ONE audit file, serialised by the
// workspace-sentinel lock), and pre-creating that one shard satisfies the
// audit-logger's "shard exists" gate for every process. seedStateFile makes
// the active-intent cursor resolve so the artifacts land under docsRoot(); the
// lock test keys auditLockDir(projectDir) (the sentinel bucket
// appendAuditEntry uses with no --intent).
let proj: string;

const PINNED_CLONE_ID = "testcloneid33c";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}

function readAudit(p: string): string {
  return readAllAuditShards(p);
}

function eventCount(body: string, type: string): number {
  return body.split("\n").filter((l) => l.trim() === `**Event**: ${type}`).length;
}

/**
 * Fire N audit-logger hooks IN PARALLEL against the same project, each fed a
 * PostToolUse(Write) JSON for a distinct net-new per-intent artifact path.
 * Uses Bun.spawn (async) + Promise.all so all processes are launched
 * before any is awaited — genuine inter-process lock contention, not serial.
 */
async function fireParallel(p: string, n: number): Promise<void> {
  const procs = [];
  const recordRoot = docsRoot(p);
  for (let i = 1; i <= n; i++) {
    const json = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        // Under the per-intent record so the audit-logger's docsRoot() gate fires.
        file_path: join(recordRoot, `artifact-${i}.md`),
      },
    });
    const child = Bun.spawn({
      cmd: [BUN, HOOK],
      stdin: new TextEncoder().encode(json),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, CLAUDE_PROJECT_DIR: p },
    });
    procs.push(child);
  }
  await Promise.all(procs.map((c) => c.exited));
}

describe("t33 audit-logger lock contention under parallel writes (mechanism cli — parallel spawn)", () => {
  beforeEach(() => {
    proj = createTestProject();
    // Seed state so the active-intent cursor resolves → docsRoot()/auditFilePath()
    // anchor under the record.
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    // Pin the clone-id + plant the one-block baseline INTO the resolved shard, so
    // all five processes resolve + append to this single shard (the audit-logger's
    // "shard exists" gate passes for each). audit-sample.md carries exactly one
    // ARTIFACT_CREATED block (INITIAL_ENTRIES = 1).
    writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    copyFileSync(join(FIXTURES_DIR, "audit-sample.md"), join(auditDir, pinnedShardName()));
  });

  afterEach(() => {
    // Defence-in-depth: if a test failed mid-flight leaving the lock dir, drop
    // it so it can't leak into another test. The happy path removes it via the
    // hook's releaseAuditLock; this only fires on failure.
    try {
      rmdirSync(auditLockDir(proj));
    } catch {
      /* already released — expected on the happy path */
    }
    cleanupTestProject(proj);
  });

  // The seeded fixture carries exactly one ARTIFACT_CREATED block; assert that
  // precondition so the "+5" math below is anchored to a known baseline.
  test("seed fixture starts with exactly one ARTIFACT_CREATED block [.sh INITIAL_ENTRIES]", () => {
    const body = readAudit(proj);
    expect(eventCount(body, "ARTIFACT_CREATED")).toBe(1);
  });

  test("all 5 parallel writes are recorded (no lost writes) [.sh test 1]", async () => {
    const before = eventCount(readAudit(proj), "ARTIFACT_CREATED");
    await fireParallel(proj, 5);
    const after = eventCount(readAudit(proj), "ARTIFACT_CREATED");
    // The lock must serialise all five appends so none clobber another - exactly
    // five new ARTIFACT_CREATED blocks land.
    expect(after - before).toBe(5);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("every parallel artifact path lands in audit.md (no dropped reference) [.sh tests 2-6]", async () => {
    await fireParallel(proj, 5);
    const body = readAudit(proj);
    for (let i = 1; i <= 5; i++) {
      expect(body.includes(`artifact-${i}.md`)).toBe(true);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("no interleaved/corrupted blocks — counts are mutually consistent [.sh test 7]", async () => {
    await fireParallel(proj, 5);
    const body = readAudit(proj);
    const lines = body.split("\n");
    const sepCount = lines.filter((l) => l === "---").length;
    const eventLines = lines.filter((l) => l.trim().startsWith("**Event**:")).length;
    // Each well-formed block closes with a standalone "---", so separators must
    // be at least the number of event blocks. A concurrency bug that interleaved
    // two appends could drop a "---" or corrupt header/field adjacency. With the
    // seeded fixture (SESSION_STARTED + ARTIFACT_CREATED + SUBAGENT_COMPLETED = 3
    // events / 3 separators) plus five appends, we get 8 events and at least 8
    // separators.
    expect(sepCount).toBeGreaterThanOrEqual(eventLines);
    // And every "**Event**:" line is immediately preceded by a "**Timestamp**:"
    // line — proving no header/field interleaving from a torn concurrent write.
    for (let idx = 0; idx < lines.length; idx++) {
      if (lines[idx].trim().startsWith("**Event**:")) {
        expect(lines[idx - 1]?.trim().startsWith("**Timestamp**:")).toBe(true);
      }
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the mkdir audit lock is released after all writes complete [.sh test 8]", async () => {
    await fireParallel(proj, 5);
    // We ask the SOURCE for the lock dir via auditLockDir() (aidlc-lib.ts). The
    // hook's withAuditLock releases the lock after each append, so once every
    // process has exited the dir must be gone.
    const lockDir = auditLockDir(proj);
    expect(existsSync(lockDir)).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
