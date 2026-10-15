// covers: subcommand:aidlc-audit:audit-fork, subcommand:aidlc-audit:audit-merge
//
// CLI-contract port of tests/e2e/t07-audit-fork-merge.sh (TAP plan 31), plus
// retry recovery coverage for already-landed and dead-partial fork/merge work,
// mechanism = cli. The .sh drives the `aidlc-audit.ts audit-fork` /
// `audit-merge` primitives — the Bolt-worktree audit fork→merge pair. Both
// subcommands are still UNCOVERED in tests/.coverage-registry.json as of this
// migration; the credited units are subcommand:aidlc-audit:audit-fork and
// subcommand:aidlc-audit:audit-merge.
//
// MECHANISM = cli (every observable is a PROCESS-boundary contract):
//   - exit code (handleAuditFork/Merge call jsonError → process.exit(1), or
//     jsonSuccess and fall off the end -> exit 0)              [aidlc-audit.ts]
//   - stdout JSON ('"emitted":"AUDIT_FORKED"', '"entries_merged":0')
//   - stderr error strings ("main audit not found", "prefix-hash", "Failed to
//     acquire audit lock", the slug-length message)
//   - the literal bytes the tool copies / appends to audit.md on disk
//   - the AIDLC_AUDIT_LOCK_RETRIES / _RETRY_MS env-var seam
//   - the planted-mkdir-lock contention path (auditLockDir = md5(projectDir)[0:8]) [aidlc-lib.ts]
//   - the chmod-readonly post-emit failure path -> ERROR_LOGGED [fork-emitted:<ts>]
// An in-process twin would lose the process.exit shell, the env seam, the
// JSON-on-stdout contract, and the cross-process lock contention.
// So every case SPAWNS the real binary (BUN + the .ts path) and the
// audit-fork/merge prerequisites use the real `aidlc-worktree.ts create`
// subcommand against a genuine git fixture.
//
// FIXTURE (mirrors make_fixture, t07): aidlc-audit audit-fork resolves a
// worktree via worktreePath(projectDir, intentId8, slug) and refuses if that
// intent-scoped directory is absent. The
// worktree is created with the real `aidlc-worktree.ts create` subcommand, which
// runs `git worktree add` and asserts it is invoked from the main checkout
// (assertNotSiblingWorktree). So each case needs an actual git repo on `main`
// with one commit + an aidlc-docs/ dir + a seeded audit.md and state file. The
// .sh built this with setup_worktree_fixture + a seeded state-mid-ideation.md +
// `printf "# AI-DLC Audit Log\n" > audit.md`; setupWorktreeFixture
// (tests/harness/fixtures.ts) + seedStateFile + a one-line audit.md replicate it
// byte-for-byte. cleanupWorktreeFixture prunes child worktrees then rm -rf's the
// parent. Nothing is written under tests/fixtures/**.
//
// B3/B7 also assert NO side effect landed (no worktree audit, no AUDIT_FORKED
// row); B8 asserts the ISO-timestamp shape on the SAME [fork-emitted:...] tag
// AND that an integer Fork-Boundary value was NOT used as the correlation key.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  cleanupWorktreeFixture,
  FIXTURES_DIR,
  fixtureIntentId8,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";
// The lock dir is keyed on the COMPOSITE identity (projectDir + intent |
// __workspace__ sentinel), not bare projectDir — import the real resolver so the
// planted-lock bucket matches the one audit-merge actually acquires.
import { auditLockDir as realAuditLockDir, worktreePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

// A FIXED clone-id token seeded into every clone (main + each worktree) so the
// per-clone audit shard is deterministic and SINGLE: the main shard the header
// is written to is the SAME one audit-fork copies and audit-merge reads, and a
// worktree-side `append` lands in the SAME shard the fork copied (so its delta
// merges).
const FIXED_CLONE_ID = "abcdef012345";
function shardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${FIXED_CLONE_ID}.md`;
}
/** Seed a fixed clone-id into a clone (main proj or a worktree) so its audit
 *  shard name is deterministic and shared with the main checkout. */
function seedCloneId(cloneRoot: string): void {
  mkdirSync(join(cloneRoot, "aidlc"), { recursive: true });
  writeFileSync(join(cloneRoot, "aidlc", ".aidlc-clone-id"), `${FIXED_CLONE_ID}\n`, "utf-8");
}

const BUN = process.execPath;
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const WORKTREE_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const fixtures: string[] = [];
// Serial Git worktree removal across this file's fixtures can exceed Bun's
// default 5s hook budget; bound cleanup separately from the product test cases.
afterAll(() => {
  for (const f of fixtures) {
    // chmod the parent (and any chmod'd children) back to writable so cleanup
    // doesn't leave undeletable dirs.
    try {
      chmodSync(f, 0o755);
    } catch {
      /* best effort */
    }
    cleanupWorktreeFixture(f);
  }
}, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

// The MAIN per-clone audit shard (the seeded fixed-clone-id shard). The header is
// written here so audit-fork copies it and audit-merge hashes/extends it.
const auditPath = (p: string): string => join(seededAuditDir(p), shardName());
const wtDir = (p: string, slug: string): string =>
  worktreePath(p, fixtureIntentId8(p), slug);
// The worktree mirror's per-clone audit shard — carries the SAME relative record
// dir AND (via the seeded fixed clone-id) the SAME shard name as the main checkout.
const wtAuditPath = (p: string, slug: string): string =>
  join(
    wtDir(p, slug),
    "aidlc",
    "spaces",
    DEFAULT_SPACE,
    "intents",
    DEFAULT_RECORD_DIR,
    "audit",
    shardName(),
  );

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

function runAudit(args: string[], env?: Record<string, string>): CliResult {
  const res = spawnSync(BUN, [AUDIT_TOOL, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

/** Real `aidlc-worktree.ts create`. After
 *  the real create, seed the SAME fixed clone-id into the worktree so a
 *  worktree-side `aidlc-audit append` lands in the SAME shard audit-fork copied
 *  (audit-merge reads only that one shard's post-fork delta). */
function createWorktree(p: string, slug: string): void {
  const res = spawnSync(
    BUN,
    [WORKTREE_TOOL, "create", "--slug", slug, "--base", "main", "--project-dir", p],
    { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), cwd: p, encoding: "utf-8" },
  );
  if ((res.status ?? -1) !== 0) {
    throw new Error(
      `aidlc-worktree create --slug ${slug} failed: ${JSON.stringify({
        status: res.status, signal: res.signal, error: res.error?.message,
        stdout: res.stdout ?? "", stderr: res.stderr ?? "",
      })}`,
    );
  }
  seedCloneId(wtDir(p, slug));
}

/**
 * A git fixture on main + a seeded state file (so the
 * active-intent cursor resolves AND emitError's stateFilePath check passes) + a
 * one-line "# AI-DLC Audit Log\n" main audit written into the per-clone shard
 * (the fixed clone-id makes the shard name deterministic). Returns the fixture
 * path.
 */
function makeFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  // Give the selected record an active stage for the audit-fork lifecycle.
  writeFileSync(
    seededStateFile(p),
    readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8"),
    "utf-8",
  );
  // Fixed clone-id → deterministic single shard; write the header there so the
  // tool appends to the SAME shard and audit-fork copies it.
  seedCloneId(p);
  mkdirSync(seededAuditDir(p), { recursive: true });
  writeFileSync(auditPath(p), "# AI-DLC Audit Log\n", "utf-8");
  // COMMIT the record (state) so the git worktree (branched from main) carries
  // it and resolves the SAME intent — a worktree-side `aidlc-audit append`
  // (which can't take --intent and reads the worktree's own cursor) then lands
  // in the record, the same shard audit-fork copied. The cursors + audit shards +
  // clone-id stay gitignored (per-user / machine-local); the worktree resolves
  // the lone record by the lone-intent fallback.
  writeFileSync(
    join(p, ".gitignore"),
    [
      "aidlc/active-space",
      "aidlc/.aidlc-clone-id",
      "aidlc/spaces/*/intents/active-intent",
      "aidlc/spaces/*/intents/*/runtime-graph.json",
      "aidlc/spaces/*/intents/*/.aidlc-*",
      "aidlc/spaces/*/intents/*/audit/",
      "",
    ].join("\n"),
  );
  spawnSync("git", ["-C", p, "add", "-A"], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" });
  spawnSync(
    "git",
    ["-C", p, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--amend", "--no-edit"],
    { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
  );
  return p;
}

function countEvent(file: string, event: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === `**Event**: ${event}`).length;
}

function countSeparators(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === "---").length;
}

/**
 * For each AUDIT_FORKED row's Bolt
 * slug, a matching AUDIT_MERGED row for the same slug must appear LATER in the
 * document. Walks event/slug pairs in document order.
 * Returns null on success or a human-readable failure reason.
 */
function bracketOrderViolation(file: string): string | null {
  const lines = readFileSync(file, "utf-8").split("\n");
  const pairs: Array<{ event: string; slug: string }> = [];
  let pendingEvent: string | null = null;
  for (const line of lines) {
    const evMatch = line.match(/^\*\*Event\*\*: (AUDIT_(?:FORKED|MERGED))/);
    if (evMatch) {
      pendingEvent = evMatch[1];
      continue;
    }
    const slugMatch = line.match(/^\*\*Bolt slug\*\*:\s*(\S+)/);
    if (slugMatch && pendingEvent) {
      pairs.push({ event: pendingEvent, slug: slugMatch[1] });
      pendingEvent = null;
    }
  }
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].event !== "AUDIT_FORKED") continue;
    const slug = pairs[i].slug;
    const mergedLater = pairs
      .slice(i + 1)
      .some((p) => p.event === "AUDIT_MERGED" && p.slug === slug);
    if (!mergedLater) {
      return `no AUDIT_MERGED found after AUDIT_FORKED for slug ${slug}`;
    }
  }
  return null;
}

/** The lock dir audit-merge acquires. Keyed on the composite identity
 *  (projectDir + intent | __workspace__ sentinel). handleAuditMerge threads the
 *  RAW --intent flag to acquireAuditLock (NOT the resolved active intent — unlike
 *  state-fork/merge), so a merge with NO --intent keys the WORKSPACE SENTINEL
 *  bucket even though its WRITE resolves the active record. B6 omits --intent, so
 *  plant the sentinel — realAuditLockDir(projectDir) with intent omitted. */
function auditLockDir(projectDir: string): string {
  return realAuditLockDir(projectDir);
}

// ===========================================================================
// Phase A — primitive smoke
// ===========================================================================
describe("t07 Phase A — primitive smoke (migrated from t07-audit-fork-merge.sh, plan 31)", () => {
  test("base source budget failure names its cause without a worktree or creation event", () => {
    const p = makeFixture();
    const auditBefore = readFileSync(auditPath(p), "utf8");
    const base = spawnSync("git", ["-C", p, "rev-parse", "main"], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf8" });
    expect(base.status, base.stderr).toBe(0);
    const refused = spawnSync(
      BUN,
      [WORKTREE_TOOL, "create", "--slug", "source-budget", "--base", "main", "--project-dir", p],
      { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), cwd: p, encoding: "utf8", env: { ...process.env, AIDLC_TEST_SOURCE_MAX_ENTRIES: "1" } },
    );
    expect(refused.status, refused.stderr).toBe(1);
    const message = JSON.parse(refused.stderr).error;
    expect(message).toContain("Base source listing could not be computed");
    expect(message).toContain(base.stdout.trim());
    expect(message).toContain("budget-entries");
    expect(existsSync(wtDir(p, "source-budget"))).toBe(false);
    expect(readFileSync(auditPath(p), "utf8").startsWith(auditBefore)).toBe(true);
    expect(countEvent(auditPath(p), "ERROR_LOGGED")).toBe(1);
    expect(countEvent(auditPath(p), "WORKTREE_CREATED")).toBe(0);
    expect(countEvent(auditPath(p), "AUDIT_FORKED")).toBe(0);
  });

  test("A1-A7: fork happy path — exit 0, AUDIT_FORKED in both audits, byte-identical, matching Fork Boundary", () => {
    const p = makeFixture();
    createWorktree(p, "demo");
    const fork = runAudit(["audit-fork", "--slug", "demo", "--project-dir", p]);

    expect(fork.status).toBe(0);
    expect(fork.out).toContain('"emitted":"AUDIT_FORKED"');
    expect(countEvent(auditPath(p), "AUDIT_FORKED")).toBeGreaterThanOrEqual(1);
    expect(readFileSync(auditPath(p), "utf-8")).toContain("Fork Boundary");
    expect(existsSync(wtAuditPath(p, "demo"))).toBe(true);

    const mainBytes = readFileSync(auditPath(p));
    const wtBytes = readFileSync(wtAuditPath(p, "demo"));
    expect(wtBytes.equals(mainBytes)).toBe(true);

    const fb = (file: string): string => {
      const m = readFileSync(file, "utf-8").match(/\*\*Fork Boundary\*\*:\s*(\d+)/);
      return m ? m[1] : "";
    };
    expect(fb(auditPath(p))).not.toBe("");
    expect(fb(wtAuditPath(p, "demo"))).toBe(fb(auditPath(p)));
  });

  test("A8-A11: merge happy path — exit 0, delta + AUDIT_MERGED in main, AUDIT_MERGED NOT in worktree", () => {
    const p = makeFixture();
    createWorktree(p, "demo");
    runAudit(["audit-fork", "--slug", "demo", "--project-dir", p]);
    // Append a worktree-side STAGE_STARTED so the merge has a delta to carry.
    runAudit([
      "append", "STAGE_STARTED",
      "--field", "Stage=foo", "--field", "Agent=bar",
      "--project-dir", wtDir(p, "demo"),
    ]);
    const merge = runAudit(["audit-merge", "--slug", "demo", "--project-dir", p]);

    expect(merge.status).toBe(0);
    expect(readFileSync(auditPath(p), "utf-8")).toContain("**Stage**: foo");
    expect(countEvent(auditPath(p), "AUDIT_MERGED")).toBeGreaterThanOrEqual(1);
    // Main-only emit: worktree audit has no AUDIT_MERGED row.
    expect(countEvent(wtAuditPath(p, "demo"), "AUDIT_MERGED")).toBe(0);
  });
});

// ===========================================================================
// Phase B — edge cases
// ===========================================================================
describe("t07 Phase B — edge cases", () => {
  test("B1: empty-delta merge — exit 0, entries_merged=0, exactly one new --- block", () => {
    const p = makeFixture();
    createWorktree(p, "e1");
    runAudit(["audit-fork", "--slug", "e1", "--project-dir", p]);
    const preSeps = countSeparators(auditPath(p));

    const merge = runAudit(["audit-merge", "--slug", "e1", "--project-dir", p]);
    expect(merge.status).toBe(0);
    expect(merge.out).toContain('"entries_merged":0');
    // Empty-delta merge appends exactly one block (the AUDIT_MERGED row).
    expect(countSeparators(auditPath(p)) - preSeps).toBe(1);
  });

  test("B2: missing worktree audit shard is mkdir -p'd at fork", () => {
    const p = makeFixture();
    createWorktree(p, "e2");
    // aidlc-worktree create does NOT scaffold the audit shard in the
    // worktree mirror (the audit/ dir is gitignored, so the fork branch lacks it).
    const wtAuditDir = join(
      wtDir(p, "e2"),
      "aidlc",
      "spaces",
      DEFAULT_SPACE,
      "intents",
      DEFAULT_RECORD_DIR,
      "audit",
    );
    expect(existsSync(wtAuditDir)).toBe(false);
    runAudit(["audit-fork", "--slug", "e2", "--project-dir", p]);
    expect(existsSync(wtAuditPath(p, "e2"))).toBe(true);
  });

  test("a complete current fork retries as a no-op without changing main", () => {
    const p = makeFixture();
    const slug = "retry-fork";
    createWorktree(p, slug);
    expect(runAudit(["audit-fork", "--slug", slug, "--project-dir", p]).status).toBe(0);
    const mainBefore = readFileSync(auditPath(p));

    const retry = runAudit(["audit-fork", "--slug", slug, "--project-dir", p]);
    expect(retry.status).toBe(0);
    expect(retry.out).toContain("already exists and is current");
    expect(countEvent(wtAuditPath(p, slug), "AUDIT_FORKED")).toBe(1);
    expect(readFileSync(auditPath(p)).equals(mainBefore)).toBe(true);
  });

  test("a dead-partial worktree shard is overwritten by a fresh fork", () => {
    const p = makeFixture();
    const slug = "partial-fork";
    createWorktree(p, slug);
    mkdirSync(join(wtAuditPath(p, slug), ".."), { recursive: true });
    writeFileSync(wtAuditPath(p, slug), readFileSync(auditPath(p)));

    const retry = runAudit(["audit-fork", "--slug", slug, "--project-dir", p]);
    expect(retry.status).toBe(0);
    const worktreeAudit = readFileSync(wtAuditPath(p, slug), "utf-8");
    expect(countEvent(wtAuditPath(p, slug), "AUDIT_FORKED")).toBe(1);
    expect(worktreeAudit).toMatch(/\*\*Event\*\*: AUDIT_FORKED[\s\S]*\n---\n$/);
  });

  test("re-fork refuses a shard with unmerged delta and names both remedies", () => {
    const p = makeFixture();
    const slug = "delta-fork";
    createWorktree(p, slug);
    expect(runAudit(["audit-fork", "--slug", slug, "--project-dir", p]).status).toBe(0);
    runAudit([
      "append", "STAGE_STARTED", "--field", "Stage=delta", "--field", "Agent=test",
      "--project-dir", wtDir(p, slug),
    ]);

    const retry = runAudit(["audit-fork", "--slug", slug, "--project-dir", p]);
    expect(retry.status).not.toBe(0);
    expect(retry.out).toContain("audit-merge");
    expect(retry.out).toContain("discard");
  });

  test("a repeated successful merge is a no-op and never duplicates delta rows", () => {
    const p = makeFixture();
    const slug = "retry-merge";
    createWorktree(p, slug);
    expect(runAudit(["audit-fork", "--slug", slug, "--project-dir", p]).status).toBe(0);
    runAudit([
      "append", "STAGE_STARTED", "--field", "Stage=retry-delta", "--field", "Agent=test",
      "--project-dir", wtDir(p, slug),
    ]);
    expect(runAudit(["audit-merge", "--slug", slug, "--project-dir", p]).status).toBe(0);
    const mainBefore = readFileSync(auditPath(p));

    const retry = runAudit(["audit-merge", "--slug", slug, "--project-dir", p]);
    expect(retry.status).toBe(0);
    expect(retry.out).toContain("already applied");
    expect(readFileSync(auditPath(p)).equals(mainBefore)).toBe(true);
    expect(countEvent(auditPath(p), "STAGE_STARTED")).toBe(1);
    expect(countEvent(auditPath(p), "AUDIT_MERGED")).toBe(1);
  });

  test("B3: missing main audit — fork fails loud, no side effect", () => {
    const p = makeFixture();
    createWorktree(p, "e3");
    rmSync(auditPath(p), { force: true });

    const fork = runAudit(["audit-fork", "--slug", "e3", "--project-dir", p]);
    expect(fork.status).not.toBe(0);
    expect(fork.out).toContain("main audit not found");
    // The pre-emit guard means no worktree audit was forged.
    expect(existsSync(wtAuditPath(p, "e3"))).toBe(false);
    // Restore so the afterAll cleanup doesn't choke.
    writeFileSync(auditPath(p), "# AI-DLC Audit Log\n", "utf-8");
  });

  test("B4: prefix-hash mismatch — merge refuses after a length-preserving main-audit edit", () => {
    const p = makeFixture();
    createWorktree(p, "e4");
    const fork = runAudit(["audit-fork", "--slug", "e4", "--project-dir", p]);
    expect(fork.status, fork.out).toBe(0);
    const appended = runAudit([
      "append", "STAGE_STARTED",
      "--field", "Stage=foo", "--field", "Agent=bar",
      "--project-dir", wtDir(p, "e4"),
    ]);
    expect(appended.status, appended.out).toBe(0);
    // Flip one byte in the header (length-preserving) — it lives in the prefix
    // that Source Audit Hash covers, so the recomputed hash will differ.
    const edited = readFileSync(auditPath(p), "utf-8").replace(
      "# AI-DLC Audit Log",
      "# AI-DLC Audit LOG",
    );
    writeFileSync(auditPath(p), edited, "utf-8");

    const merge = runAudit(["audit-merge", "--slug", "e4", "--project-dir", p]);
    expect(merge.status).not.toBe(0);
    expect(merge.out).toContain("prefix-hash");
    // Windows must finish fixture creation and both setup commands before the
    // negative merge assertion; the outer 30s cap was reached during this case.
  });

  test("B5: lock contention — staggered N=2 mergers both exit 0, exactly 2 AUDIT_MERGED rows", async () => {
    const p = makeFixture();
    createWorktree(p, "lock-a");
    createWorktree(p, "lock-b");
    runAudit(["audit-fork", "--slug", "lock-a", "--project-dir", p]);
    runAudit(["audit-fork", "--slug", "lock-b", "--project-dir", p]);
    runAudit([
      "append", "STAGE_STARTED", "--field", "Stage=a", "--field", "Agent=x",
      "--project-dir", wtDir(p, "lock-a"),
    ]);
    runAudit([
      "append", "STAGE_STARTED", "--field", "Stage=b", "--field", "Agent=y",
      "--project-dir", wtDir(p, "lock-b"),
    ]);

    const mergeAsync = (slug: string): Promise<number> =>
      new Promise((resolve) => {
        const child = spawn(BUN, [
          AUDIT_TOOL, "audit-merge", "--slug", slug, "--project-dir", p,
        ], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), killSignal: "SIGKILL", stdio: "ignore" });
        child.once("close", (code) => resolve(code ?? -1));
      });

    const bg = mergeAsync("lock-a");
    await new Promise((r) => setTimeout(r, 50));
    const fgRc = await mergeAsync("lock-b");
    const bgRc = await bg;

    expect(bgRc).toBe(0);
    expect(fgRc).toBe(0);
    expect(countEvent(auditPath(p), "AUDIT_MERGED")).toBe(2);
  });

  test("audit-merge refuses symlinked and hard-linked main shards before appending delta", () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const p = makeFixture();
      const slug = kind === "symlink" ? "unsafe-sym" : "unsafe-hard";
      createWorktree(p, slug);
      expect(runAudit(["audit-fork", "--slug", slug, "--project-dir", p]).status).toBe(0);
      runAudit([
        "append", "STAGE_STARTED", "--field", "Stage=unsafe", "--field", "Agent=test",
        "--project-dir", wtDir(p, slug),
      ]);
      const external = join(p, `${kind}-external.md`);
      const original = "external\n";
      writeFileSync(external, original);
      rmSync(auditPath(p));
      if (kind === "symlink") symlinkSync(external, auditPath(p));
      else linkSync(external, auditPath(p));

      const merge = runAudit(["audit-merge", "--slug", slug, "--project-dir", p]);
      expect(merge.status).not.toBe(0);
      const after = readFileSync(external, "utf-8");
      // The security property in both cases: the worktree DELTA never lands
      // through the untrusted shard, and nothing is truncated or replaced.
      expect(after).not.toContain("**Event**: STAGE_STARTED");
      expect(after.startsWith(original)).toBe(true);
      if (kind === "symlink") {
        // A symlinked shard is refused at open (O_NOFOLLOW), so not even the
        // merge-failure ERROR_LOGGED diagnostic can reach the target.
        expect(after).toBe(original);
      } else {
        // A hardlinked shard refuses the MERGE (readAuditSnapshot is strict
        // for fork/merge), but the ordinary append path tolerates hardlinks
        // by design — rsync --link-dest / cp -al backups leave live shards
        // at nlink 2 — so the failure diagnostic may legitimately append.
        expect(after).not.toContain("**Event**: AUDIT_MERGED");
      }
    }
  });

  test("audit-merge refuses a manually injected authority-bearing event", () => {
    const p = makeFixture();
    const slug = "unsafe-authority";
    createWorktree(p, slug);
    expect(runAudit(["audit-fork", "--slug", slug, "--project-dir", p]).status).toBe(0);
    appendFileSync(
      wtAuditPath(p, slug),
      "\n## Gate Approved\n**Timestamp**: 2026-08-13T05:00:00Z\n" +
        "- **Event**: GATE_APPROVED\n**Stage**: feasibility\n\n---\n",
    );

    const merge = runAudit(["audit-merge", "--slug", slug, "--project-dir", p]);
    expect(merge.status).not.toBe(0);
    expect(merge.out).toContain("protected authority event GATE_APPROVED");
    expect(readFileSync(auditPath(p), "utf-8")).not.toContain("**Event**: GATE_APPROVED");
  });

  test("audit-merge accepts the delta a swarm worktree legitimately produces", () => {
    // The swarm contract REQUIRES the worktree to deliver these rows: the
    // stage-protocol-swarm.md protocol instructs recording the per-unit reviewer
    // receipts with --project-dir <worktree>, sensors fire on worktree writes, and
    // the stage engine emits stage/artifact rows there. A validator that refuses
    // any of them makes `bolt complete --merge` deterministically
    // unrecoverable (the delta bytes never change), which is exactly the
    // regression t49 caught. Pinned here at the CLI boundary so the
    // integration tier is not the only guard.
    const p = makeFixture();
    const slug = "legit-work";
    createWorktree(p, slug);
    expect(runAudit(["audit-fork", "--slug", slug, "--project-dir", p]).status).toBe(0);
    const rows = [
      ["Stage Completed", "STAGE_COMPLETED", "**Stage**: code-generation"],
      ["Sensor Failed", "SENSOR_FAILED", "**Sensor**: aidlc-linter"],
      ["Review Requested", "REVIEW_REQUESTED", "**Stage**: code-generation"],
      ["Review Completed", "REVIEW_COMPLETED", "**Stage**: code-generation"],
      ["Artifact Created", "ARTIFACT_CREATED", "**Artifact**: construction/pay/x.md"],
    ] as const;
    for (const [heading, event, field] of rows) {
      appendFileSync(
        wtAuditPath(p, slug),
        `\n## ${heading}\n**Timestamp**: 2026-08-17T05:00:00Z\n` +
          `- **Event**: ${event}\n${field}\n\n---\n`,
      );
    }

    const merge = runAudit(["audit-merge", "--slug", slug, "--project-dir", p]);
    expect(merge.status).toBe(0);
    const main = readFileSync(auditPath(p), "utf-8");
    for (const [, event] of rows) {
      expect(main).toContain(`**Event**: ${event}`);
    }
  });

  test("audit-merge refuses a DOCUMENT_* row in a worktree delta (space-shard-only provenance)", () => {
    // Exercises the PREFIX branch of mergeEventIsProtected, which no other
    // test reaches: DocumentKB rows belong to the space-level shard, so one
    // arriving through an intent delta is a forgery that would split a
    // document's history across shards.
    const p = makeFixture();
    const slug = "doc-forgery";
    createWorktree(p, slug);
    expect(runAudit(["audit-fork", "--slug", slug, "--project-dir", p]).status).toBe(0);
    appendFileSync(
      wtAuditPath(p, slug),
      "\n## Document Indexed\n**Timestamp**: 2026-08-17T05:00:00Z\n" +
        "- **Event**: DOCUMENT_INDEXED\n**Space**: default\n\n---\n",
    );

    const merge = runAudit(["audit-merge", "--slug", slug, "--project-dir", p]);
    expect(merge.status).not.toBe(0);
    expect(merge.out).toContain("DOCUMENT_INDEXED");
    expect(readFileSync(auditPath(p), "utf-8")).not.toContain("**Event**: DOCUMENT_INDEXED");
  });

  test("audit-merge rejects tampered fork metadata and incomplete deltas", () => {
    for (const kind of ["metadata", "truncated"] as const) {
      const p = makeFixture();
      const slug = kind === "metadata" ? "tampered-meta" : "torn-delta";
      createWorktree(p, slug);
      expect(runAudit(["audit-fork", "--slug", slug, "--project-dir", p]).status).toBe(0);
      if (kind === "metadata") {
        const tampered = readFileSync(wtAuditPath(p, slug), "utf-8")
          .replace(/\*\*Fork Boundary\*\*:\s*\d+/, "**Fork Boundary**: 0")
          .replace(/\*\*Source Audit Hash\*\*:\s*[0-9a-f]+/,
            "**Source Audit Hash**: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        writeFileSync(wtAuditPath(p, slug), tampered);
      } else {
        appendFileSync(
          wtAuditPath(p, slug),
          "\n## Torn\n**Timestamp**: 2026-08-13T06:00:00Z\n**Event**: STAGE_STARTED\n",
        );
      }
      const merge = runAudit(["audit-merge", "--slug", slug, "--project-dir", p]);
      expect(merge.status).not.toBe(0);
      expect(countEvent(auditPath(p), "AUDIT_MERGED")).toBe(0);
    }
  });

  test("B6: lock-timeout — planted stuck lock + dialled-down retries → non-zero with clear error", () => {
    const p = makeFixture();
    createWorktree(p, "timeout");
    runAudit(["audit-fork", "--slug", "timeout", "--project-dir", p]);
    runAudit([
      "append", "STAGE_STARTED", "--field", "Stage=t", "--field", "Agent=t",
      "--project-dir", wtDir(p, "timeout"),
    ]);
    // Plant a stuck lock by mkdir-ing the exact dir the tool acquires. Stamp a
    // LIVE, FRESH owner (this test process) so the reaper REFUSES to reclaim
    // it — without the stamp a bare lock dir ages past the unstamped-grace window
    // and the reaper steals it, letting the merge succeed and defeating this case.
    const lock = auditLockDir(p);
    mkdirSync(lock, { recursive: true });
    const nowMs = Math.floor(performance.timeOrigin + performance.now());
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAtMs: nowMs }),
      "utf-8",
    );
    try {
      const merge = runAudit(
        ["audit-merge", "--slug", "timeout", "--project-dir", p],
        { AIDLC_AUDIT_LOCK_RETRIES: "2", AIDLC_AUDIT_LOCK_RETRY_MS: "50" },
      );
      expect(merge.status).not.toBe(0);
      expect(merge.out).toContain("Failed to acquire audit lock");
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  test("B7: 65-char slug rejected before any disk side effect", () => {
    const p = makeFixture();
    const longSlug = "a".repeat(65);
    const fork = runAudit(["audit-fork", "--slug", longSlug, "--project-dir", p]);

    expect(fork.status).not.toBe(0);
    expect(fork.out).toMatch(/65 chars|max is 64/);
    expect(existsSync(wtAuditPath(p, longSlug))).toBe(false);
    expect(countEvent(auditPath(p), "AUDIT_FORKED")).toBe(0);
  });

  test("B8: post-emit failure path — ERROR_LOGGED carries [fork-emitted:<iso-ts>] for doctor correlation", () => {
    const p = makeFixture();
    createWorktree(p, "erro");
    // Plant a FILE where audit-fork needs to mkdir the worktree mirror's audit/
    // dir. The worktree carries the committed record dir, so audit/ is the path
    // audit-fork creates — a file there makes the recursive mkdir fail (EEXIST/
    // ENOTDIR) on both POSIX and Windows; chmod-readonly is not a reliable write
    // denial on Windows under SSM.
    writeFileSync(
      join(
        wtDir(p, "erro"),
        "aidlc",
        "spaces",
        DEFAULT_SPACE,
        "intents",
        DEFAULT_RECORD_DIR,
        "audit",
      ),
      "not a directory\n",
    );
    runAudit(["audit-fork", "--slug", "erro", "--project-dir", p]);
    const main = readFileSync(auditPath(p), "utf-8");
    // The correlation tag is the ISO 8601 timestamp (isoTimestamp), NOT the
    // integer Fork Boundary - doctor joins the orphan AUDIT_FORKED row
    // to this ERROR_LOGGED by exact-string timestamp match.
    expect(main).toMatch(
      /\[fork-emitted:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]/,
    );
    expect(main).not.toMatch(/\[fork-emitted:\d+\]/);
  });
});

// ===========================================================================
// Phase C — property (N=4 orderings preserve per-Bolt fork→merge brackets)
// ===========================================================================
describe("t07 Phase C — property", () => {
  function runN4(p: string, slugs: string[]): void {
    for (const s of slugs) {
      createWorktree(p, s);
      runAudit(["audit-fork", "--slug", s, "--project-dir", p]);
      runAudit([
        "append", "STAGE_STARTED", "--field", `Stage=${s}`, "--field", "Agent=test",
        "--project-dir", wtDir(p, s),
      ]);
    }
    for (const s of slugs) {
      runAudit(["audit-merge", "--slug", s, "--project-dir", p]);
    }
  }

  test("C1: alphabetical N=4 — every AUDIT_FORKED has a later matching AUDIT_MERGED", () => {
    const p = makeFixture();
    runN4(p, ["alpha", "bravo", "charlie", "delta"]);
    expect(bracketOrderViolation(auditPath(p))).toBeNull();
  });

  test("C2: reverse-alphabetical N=4 — bracket order preserved", () => {
    const p = makeFixture();
    runN4(p, ["delta", "charlie", "bravo", "alpha"]);
    expect(bracketOrderViolation(auditPath(p))).toBeNull();
  });

  test("C3: same-second-timestamps N=4 — bracket order preserved", () => {
    const p = makeFixture();
    for (const s of ["t1", "t2", "t3", "t4"]) {
      createWorktree(p, s);
      runAudit(["audit-fork", "--slug", s, "--project-dir", p]);
      // Hand-author a delta block with a frozen identical timestamp, bypassing
      // isoTimestamp() — same shape appendAuditEntry writes (block + \n---\n).
      appendFileSync(
        wtAuditPath(p, s),
        `\n## Stage Start\n**Timestamp**: 2026-05-18T12:00:00Z\n**Event**: STAGE_STARTED\n**Stage**: ${s}\n**Agent**: test\n\n---\n`,
        "utf-8",
      );
    }
    for (const s of ["t1", "t2", "t3", "t4"]) {
      runAudit(["audit-merge", "--slug", s, "--project-dir", p]);
    }
    expect(bracketOrderViolation(auditPath(p))).toBeNull();
  });

  test("C4-C6: N=4 with one empty delta — bracket order preserved + exactly 4 forks / 4 merges", () => {
    const p = makeFixture();
    for (const s of ["z1", "z2", "z3", "z4"]) {
      createWorktree(p, s);
      runAudit(["audit-fork", "--slug", s, "--project-dir", p]);
    }
    for (const s of ["z1", "z2", "z4"]) {
      runAudit([
        "append", "STAGE_STARTED", "--field", `Stage=${s}`, "--field", "Agent=test",
        "--project-dir", wtDir(p, s),
      ]);
    }
    for (const s of ["z1", "z2", "z3", "z4"]) {
      runAudit(["audit-merge", "--slug", s, "--project-dir", p]);
    }
    expect(bracketOrderViolation(auditPath(p))).toBeNull();
    expect(countEvent(auditPath(p), "AUDIT_MERGED")).toBe(4);
    expect(countEvent(auditPath(p), "AUDIT_FORKED")).toBe(4);
  });
});
