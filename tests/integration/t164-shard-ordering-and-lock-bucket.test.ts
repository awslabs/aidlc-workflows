// covers: subcommand:aidlc-worktree:verify, subcommand:aidlc-worktree:info, subcommand:aidlc-state:fork, function:findAllEvents
//
// t164 — Stage B FIX 2 + FIX 1a regression, against REAL tools on a per-intent
// layout. Mechanism: cli (process-boundary).
//
// TWO independent residual-MAJOR closures share this file (both per-intent,
// multi-shard concerns; one fixture style):
//
//   PART A — FIX 2 (findLatestEvent multi-shard ORDERING). aidlc-worktree's
//   verify/info pick the "latest" WORKTREE_* block for a slug from the
//   readAllAuditShards buffer. That buffer concatenates per-clone shards in
//   FILENAME (lexical) order, NOT time order. The pre-fix findLatestEvent walked
//   the buffer end→start and took the last-by-POSITION match, so a chronologically
//   OLDER block living in a lexically-LATER shard was returned as "latest" —
//   `info` then reports the stale path/branch and `verify --max-age-seconds` calls
//   a fresh worktree STALE. The fix selects the MAX **Timestamp** (via the shared
//   findAllEvents, which CRLF-normalizes + timestamp-sorts). This test seeds two
//   shards OUT of lexical/time agreement and asserts the NEWER block wins.
//
//   PART B — FIX 1a (fork/merge LOCK == WRITE bucket on the omitted-intent path).
//   handleFork resolved the per-intent record for its WRITES but, pre-fix, threaded
//   the RAW --intent flag to the wrapping withAuditLock. With --intent OMITTED on a
//   per-intent layout the lock keyed the __workspace__ sentinel while the writes
//   hit the resolved per-intent shard → an omitted-intent fork and a concurrent
//   EXPLICIT-intent op on the SAME record held DIFFERENT locks → the lost-update
//   race the lock exists to prevent. The fix resolves the intent (activeIntent)
//   BEFORE locking so lock==write on both paths. This test races an omitted-intent
//   fork against an explicit-intent fork on the SAME record and asserts BOTH slugs
//   land in Bolt Refs (serialized, no clobber).
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/):
//   aidlc-worktree.ts findLatestEvent → findAllEvents (max-timestamp selection).
//   aidlc-state.ts handleFork (resolvedIntent threaded to withAuditLock + writes).
//
// FIXTURE DISCIPLINE: per-test temp project with a hand-seeded per-intent layout
// (no git needed — verify/info are read-only, fork uses --target-dir). Audit
// shards are written directly under the record's audit/ dir. Lock dir under
// tmpdir() is cleaned in afterEach. Nothing under tests/fixtures/**.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES_DIR } from "../harness/fixtures.ts";
import { auditLockDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const WORKTREE_TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-worktree.ts");
const STATE_TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-state.ts");

const SPACE = "default";
const RECORD = "auth-aaaaaaaa";

let proj: string;

function recordPath(): string {
  return join(proj, "aidlc", "spaces", SPACE, "intents", RECORD);
}
function shardDir(): string {
  return join(recordPath(), "audit");
}

/** Seed the minimal per-intent layout: active-space + active-intent cursors +
 *  a record dir with the genuine v7 construction-stage state file (it carries
 *  the Worktree Path + Bolt Refs fields handleFork's setFieldStrict requires). */
function seedLayout(): void {
  const intentsDir = join(proj, "aidlc", "spaces", SPACE, "intents");
  mkdirSync(join(intentsDir, RECORD), { recursive: true });
  const stateBody = readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8");
  writeFileSync(join(intentsDir, RECORD, "aidlc-state.md"), stateBody, "utf-8");
  writeFileSync(join(proj, "aidlc", "active-space"), `${SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${RECORD}\n`, "utf-8");
}

/** Write a WORKTREE_CREATED audit block into a named shard. */
function seedWorktreeCreatedShard(
  shardFile: string,
  slug: string,
  timestamp: string,
  wtPath: string,
  branch: string,
): void {
  mkdirSync(shardDir(), { recursive: true });
  const block = [
    "",
    "## Worktree Created",
    `**Timestamp**: ${timestamp}`,
    "**Event**: WORKTREE_CREATED",
    `**Bolt slug**: ${slug}`,
    `**Worktree path**: ${wtPath}`,
    `**Branch name**: ${branch}`,
    "",
    "---",
    "",
  ].join("\n");
  writeFileSync(join(shardDir(), shardFile), block, "utf-8");
}

function runIn(tool: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd: [BUN, tool, "--project-dir", proj, ...args],
    cwd: proj,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), "aidlc-t164-"));
  seedLayout();
});

afterEach(() => {
  for (const intent of [RECORD, undefined]) {
    try {
      rmSync(auditLockDir(proj, intent, intent ? SPACE : undefined), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
  rmSync(proj, { recursive: true, force: true });
});

describe("t164 PART A — findLatestEvent picks the chronologically-newest block across shards (FIX 2)", () => {
  const SLUG = "feat-z";

  // The lexically-LATER shard (host-zzzz.md) holds the OLDER block; the
  // lexically-EARLIER shard (host-aaaa.md) holds the NEWER block. readAllAuditShards
  // concatenates aaaa-then-zzzz, so the OLDER block is LAST in the buffer — the
  // exact arrangement where a buffer-position "last wins" reader returns the stale
  // block. Both blocks share the slug+event, so the slug filter does not save it.
  function seedOutOfOrder(newerPath: string, stalePath: string): { newerTs: string } {
    // Newer = "now" (so verify --max-age passes post-fix); stale = ~2 days ago.
    const newerTs = new Date().toISOString();
    const staleTs = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    seedWorktreeCreatedShard("host-aaaa.md", SLUG, newerTs, newerPath, "fresh-branch");
    seedWorktreeCreatedShard("host-zzzz.md", SLUG, staleTs, stalePath, "stale-branch");
    return { newerTs };
  }

  test("info returns the NEWER block's path/branch, not the lexically-last (older) shard's", () => {
    seedOutOfOrder("/fresh/wt/path", "/stale/wt/path");
    const r = runIn(WORKTREE_TOOL, ["info", "--slug", SLUG, "--intent", RECORD]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    // Pre-fix: returns "/stale/wt/path" (older block, last in buffer). Post-fix:
    // the max-timestamp block → the fresh path.
    expect(out.path).toBe("/fresh/wt/path");
    expect(out.branch_name).toBe("fresh-branch");
  });

  test("verify reports a FRESH worktree as verified, not STALE (max-timestamp wins)", () => {
    seedOutOfOrder("/fresh/wt/path", "/stale/wt/path");
    const r = runIn(WORKTREE_TOOL, [
      "verify", "--event", "WORKTREE_CREATED", "--slug", SLUG,
      "--max-age-seconds", "120", "--intent", RECORD,
    ]);
    // Pre-fix: picks the ~2-day-old block → ageMs > 120s → verified:false, exit 1.
    // Post-fix: picks the now-timestamp block → verified:true, exit 0.
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.verified).toBe(true);
  });
});

describe("t164 PART B — omitted-intent fork serializes with an explicit-intent fork on the SAME record (FIX 1a)", () => {
  // Two forks on the SAME per-intent record, fired concurrently: one with --intent
  // OMITTED (resolves to the active cursor = RECORD), one with --intent RECORD
  // explicit. Each appends its slug to the SAME Bolt Refs field (a read-modify-write
  // of main state). Pre-fix the omitted fork locked the __workspace__ sentinel and
  // the explicit fork locked RECORD's per-intent bucket → DIFFERENT locks → both
  // read the empty Bolt Refs and one clobbers the other → only ONE slug survives.
  // Post-fix both resolve RECORD before locking → SAME lock → serialized → BOTH
  // slugs land. (target-dir points each fork at a throwaway worktree dir so no git
  // is needed; the worktree-side state write is incidental to the main-side race.)
  test("both forks' slugs survive in Bolt Refs (lock==write serializes the RMW)", async () => {
    const wtA = join(proj, "wt-omitted");
    const wtB = join(proj, "wt-explicit");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });

    const procs = [
      // Omitted --intent: resolves to the active-intent cursor (RECORD).
      Bun.spawn({
        cmd: [BUN, STATE_TOOL, "--project-dir", proj, "fork", "--slug", "slug-omitted", "--target-dir", wtA],
        cwd: proj,
        stdout: "ignore",
        stderr: "ignore",
      }),
      // Explicit --intent RECORD: the SAME record the omitted one resolves to.
      Bun.spawn({
        cmd: [BUN, STATE_TOOL, "--project-dir", proj, "fork", "--slug", "slug-explicit", "--target-dir", wtB, "--intent", RECORD],
        cwd: proj,
        stdout: "ignore",
        stderr: "ignore",
      }),
    ];
    await Promise.all(procs.map((p) => p.exited));
    const codes = await Promise.all(procs.map((p) => p.exited));
    // Both forks succeed (the lock serializes them; neither errors on a dup slug —
    // the slugs differ).
    expect(codes.every((c) => c === 0)).toBe(true);

    // Both slugs are present in the SINGLE main state file under the record. A
    // lost update (pre-fix) leaves exactly one (the second writer clobbered the
    // first's Bolt Refs append against a stale snapshot).
    const mainState = readFileSync(join(recordPath(), "aidlc-state.md"), "utf-8");
    const refsLine = mainState.split("\n").find((l) => l.startsWith("- **Bolt Refs**:")) ?? "";
    expect(refsLine).toContain("slug-omitted");
    expect(refsLine).toContain("slug-explicit");
  }, 60000);
});
