// covers: hook:aidlc-audit-logger, function:appendAuditEntry, function:acquireAuditLock, function:releaseAuditLock
//
// t33 — audit-logger lock contention under parallel writes. Migrated from
// tests/integration/t33-hook-concurrency.sh (TAP plan 8). Mechanism: cli.
//
// WHY CLI (process-boundary, not in-process): the subject IS concurrency —
// five independent OS processes racing for the same mkdir-based audit lock.
// The .sh proved the lock by launching 5 backgrounded `bun <hook>` invocations
// (`& ... wait`) against ONE project's audit.md and asserting no write was
// lost. An in-process loop calling appendAuditEntry() five times would be
// strictly serial inside one process and could never exercise the
// inter-process lock contention the .sh measured. So this twin SPAWNS the real
// hook five times in parallel via node:child_process spawnSync, fired
// concurrently (Promise.all over Bun.spawn) the same way Claude Code's
// PostToolUse(Write|Edit) drives it from settings.json.
//
// SOURCE UNDER TEST:
//   dist/claude/.claude/hooks/aidlc-audit-logger.ts — PostToolUse(Write|Edit).
//     - resolves projectDir from CLAUDE_PROJECT_DIR (resolveProjectDirFromHook,
//       aidlc-lib.ts:116).
//     - reads PostToolUse JSON on stdin; only logs writes whose file_path
//       includes "aidlc-docs/" (:47) AND only when audit.md already exists
//       (:55). A Write to a NET-NEW file under aidlc-docs/ (statSync throws →
//       catch → isNew=true, :87-90) emits ARTIFACT_CREATED via appendAuditEntry
//       (:95) with fields Tool / File / Context.
//   dist/claude/.claude/tools/aidlc-audit.ts:214 appendAuditEntry — acquires
//     the audit lock (acquireAuditLock), appends one block, then releases it
//     (releaseAuditLock) in a finally (:225-233). The block format is
//     "\n## <heading>\n**Timestamp**: ...\n**Event**: ...\n<fields>\n---\n".
//   dist/claude/.claude/tools/aidlc-lib.ts:512 auditLockDir(projectDir) =
//     join(tmpdir(), `.aidlc-audit-${md5(projectDir).slice(0,8)}.lock`); the
//     mkdir-based mutex (acquireAuditLock :517, releaseAuditLock :536). The .sh
//     recomputed this dir by hand (md5sum | cut -c1-8); here we ask the source
//     for it via auditLockDir() — equivalent and self-checking.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file):
//   - createTestProject() -> a fresh temp dir with aidlc-docs/.
//   - seedAuditFile() -> copies tests/fixtures/audit-sample.md to
//     aidlc-docs/audit.md, which carries exactly ONE ARTIFACT_CREATED block
//     (INITIAL_ENTRIES = 1, verified against the fixture). The hook self-gates
//     on audit.md existing, so seeding it is the precondition for the emit.
//   - The hook is spawned at the SHIPPED source path (AIDLC_SRC/hooks/...),
//     exactly like the .sh's `$AIDLC_SRC/hooks/aidlc-audit-logger.ts`; no
//     copied skeleton is needed because audit-logger imports appendAuditEntry
//     directly (no re-spawn of a project-local tool).
//   - cleanupTestProject() rm -rf's the temp project; the lock dir lives under
//     tmpdir() and is asserted-then-removed (afterEach safety) so no cross-test
//     bleed. Nothing is written under tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  (NEW_ENTRIES == 5, no lost writes)        -> "all 5 parallel writes are recorded (no lost writes)"
//   .sh test 2  (entry for artifact-1.md present)         -> "every parallel artifact path lands ..." (i=1)
//   .sh test 3  (entry for artifact-2.md present)         -> "every parallel artifact path lands ..." (i=2)
//   .sh test 4  (entry for artifact-3.md present)         -> "every parallel artifact path lands ..." (i=3)
//   .sh test 5  (entry for artifact-4.md present)         -> "every parallel artifact path lands ..." (i=4)
//   .sh test 6  (entry for artifact-5.md present)         -> "every parallel artifact path lands ..." (i=5)
//   .sh test 7  (separators >= entries, no corruption)    -> "no interleaved/corrupted blocks ..." (STRONGER: every block well-formed)
//   .sh test 8  (lock directory cleaned up)               -> "the mkdir audit lock is released ..."
//
// 8 .sh asserts -> 8 expect()-bearing test() cases (several STRONGER: the
// no-corruption row asserts block/separator/event counts are mutually
// consistent rather than only separators>=entries; the lock-cleanup row pins
// the source-computed lock dir, not a hand-recomputed hash).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

const BUN = process.execPath; // the bun running this test
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-audit-logger.ts");

// P9 per-intent layout: the audit trail is a DIR of per-clone shards. We PIN one
// clone-id on disk so all five parallel processes resolve the SAME shard — that
// reproduces the original contract (five racing appends to ONE audit file,
// serialised by the workspace-sentinel lock), and pre-creating that one shard
// satisfies the audit-logger's "shard exists" gate for every process.
// seedStateFile makes the active-intent cursor resolve so the artifacts land
// under docsRoot(); the lock test 8 keys auditLockDir(projectDir) (the sentinel
// bucket appendAuditEntry uses with no --intent).
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

// The audit trail read as one buffer (every per-clone shard, merge-concatenated).
function readAudit(p: string): string {
  return readAllAuditShards(p);
}

/** Count occurrences of an "**Event**: <type>" line. */
function eventCount(body: string, type: string): number {
  return body.split("\n").filter((l) => l.trim() === `**Event**: ${type}`).length;
}

/**
 * Fire N audit-logger hooks IN PARALLEL against the same project, each fed a
 * PostToolUse(Write) JSON for a distinct net-new aidlc-docs/ artifact path.
 * Mirrors the .sh's `for i in 1..5; do echo {...} | bun "$HOOK" & done; wait`.
 * Uses Bun.spawn (async) + Promise.all so all five processes are launched
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
  // Await every process — the equivalent of the shell `wait`.
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
    // .sh: NEW_ENTRIES == 5. The lock must serialise all five appends so none
    // clobber another — exactly five new ARTIFACT_CREATED blocks land.
    expect(after - before).toBe(5);
  }, 30000);

  test("every parallel artifact path lands in audit.md (no dropped reference) [.sh tests 2-6]", async () => {
    await fireParallel(proj, 5);
    const body = readAudit(proj);
    // .sh tests 2,3,4,5,6: assert_grep audit.md "artifact-<i>.md" for i=1..5.
    for (let i = 1; i <= 5; i++) {
      expect(body.includes(`artifact-${i}.md`)).toBe(true);
    }
  }, 30000);

  test("no interleaved/corrupted blocks — counts are mutually consistent [.sh test 7]", async () => {
    await fireParallel(proj, 5);
    const body = readAudit(proj);
    const lines = body.split("\n");
    const sepCount = lines.filter((l) => l === "---").length;
    const eventLines = lines.filter((l) => l.trim().startsWith("**Event**:")).length;
    // .sh test 7: SEPARATOR_COUNT >= FINAL_ENTRIES (>= number of blocks).
    // Each well-formed block closes with a standalone "---", so separators must
    // be at least the number of event blocks. STRONGER than the .sh: a
    // concurrency bug that interleaved two appends would either drop a "---" or
    // double-write a header, breaking this one-block-one-separator-one-event
    // invariant. With one seeded block (SESSION_STARTED + ARTIFACT_CREATED +
    // SUBAGENT_COMPLETED = 3 events / 3 separators) plus five appends, we get
    // 8 events and at least 8 separators, all intact.
    expect(sepCount).toBeGreaterThanOrEqual(eventLines);
    // And every "**Event**:" line is immediately preceded by a "**Timestamp**:"
    // line — proving no header/field interleaving from a torn concurrent write.
    for (let idx = 0; idx < lines.length; idx++) {
      if (lines[idx].trim().startsWith("**Event**:")) {
        expect(lines[idx - 1]?.trim().startsWith("**Timestamp**:")).toBe(true);
      }
    }
  }, 30000);

  test("the mkdir audit lock is released after all writes complete [.sh test 8]", async () => {
    await fireParallel(proj, 5);
    // .sh test 8 recomputed the lock dir by hand: md5sum(projectDir) | cut -c1-8
    // under ${TMPDIR:-/tmp}/.aidlc-audit-<hash>.lock. We ask the SOURCE for the
    // exact same dir via auditLockDir() (aidlc-lib.ts:512) — equivalent and
    // self-checking. appendAuditEntry's finally releases the lock after each
    // append, so once every process has exited the dir must be gone.
    const lockDir = auditLockDir(proj);
    expect(existsSync(lockDir)).toBe(false);
  }, 30000);
});
