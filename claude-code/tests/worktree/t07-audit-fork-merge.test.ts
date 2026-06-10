// covers: subcommand:aidlc-audit:audit-fork, subcommand:aidlc-audit:audit-merge
//
// CLI-contract port of tests/worktree/t07-audit-fork-merge.sh (TAP plan 31),
// mechanism = cli. The .sh drives the `aidlc-audit.ts audit-fork` /
// `audit-merge` primitives — the Bolt-worktree audit fork→merge pair. Both
// subcommands are still UNCOVERED in tests/.coverage-registry.json as of this
// migration; the credited units are subcommand:aidlc-audit:audit-fork and
// subcommand:aidlc-audit:audit-merge.
//
// MECHANISM = cli (every observable is a PROCESS-boundary contract):
//   - exit code (handleAuditFork/Merge call jsonError → process.exit(1), or
//     jsonSuccess and fall off the end → exit 0)              [aidlc-audit.ts:205-208]
//   - stdout JSON ('"emitted":"AUDIT_FORKED"', '"entries_merged":0')  [:424,:620]
//   - stderr error strings ("main audit not found", "prefix-hash", "Failed to
//     acquire audit lock", the slug-length message)            [:368,:520-529,:556,:312]
//   - the literal bytes the tool copies / appends to audit.md on disk
//   - the AIDLC_AUDIT_LOCK_RETRIES / _RETRY_MS env-var seam            [:548-555]
//   - the planted-mkdir-lock contention path (auditLockDir = md5(projectDir)[0:8]) [aidlc-lib.ts:512-514]
//   - the chmod-readonly post-emit failure path → ERROR_LOGGED [fork-emitted:<ts>]  [:407-422]
// An in-process twin would lose the process.exit shell, the env seam, the
// JSON-on-stdout contract, and the cross-process lock contention the .sh
// proves. So every case SPAWNS the real binary (BUN + the .ts path) and the
// audit-fork/merge prerequisites use the real `aidlc-worktree.ts create`
// subcommand against a genuine git fixture — exactly the .sh's shape.
//
// FIXTURE (mirrors make_fixture, t07:53-61): aidlc-audit audit-fork resolves a
// worktree via worktreePath(projectDir, slug) = <proj>/.aidlc/worktrees/bolt-<slug>
// (aidlc-lib.ts:148) and refuses if the dir is absent (aidlc-audit.ts:371). The
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
// Old TAP -> new test parity (31 .sh assertions -> 31 expect()s):
//   A1  audit-fork exits 0                                  -> "A: fork happy path" expect 1
//   A2  stdout '"emitted":"AUDIT_FORKED"'                   -> "A: fork happy path" expect 2
//   A3  main audit contains AUDIT_FORKED row                -> "A: fork happy path" expect 3
//   A4  main audit carries Fork Boundary field              -> "A: fork happy path" expect 4
//   A5  worktree audit file created                         -> "A: fork happy path" expect 5
//   A6  worktree audit byte-identical at fork instant       -> "A: fork happy path" expect 6
//   A7  Fork Boundary matches main vs worktree              -> "A: fork happy path" expect 7
//   A8  audit-merge exits 0                                 -> "A: merge happy path" expect 1
//   A9  main audit contains merged STAGE_STARTED row        -> "A: merge happy path" expect 2
//   A10 main audit contains AUDIT_MERGED row                -> "A: merge happy path" expect 3
//   A11 worktree audit does NOT contain AUDIT_MERGED        -> "A: merge happy path" expect 4
//   B1.1 empty-delta merge exits 0                          -> "B1 empty-delta" expect 1
//   B1.2 reports entries_merged=0                           -> "B1 empty-delta" expect 2
//   B1.3 appends exactly one --- block to main              -> "B1 empty-delta" expect 3
//   B2.1 worktree aidlc-docs/ absent pre-fork               -> "B2 mkdir -p" expect 1
//   B2.2 fork created <wt>/aidlc-docs/audit.md              -> "B2 mkdir -p" expect 2
//   B3.1 fork exits non-zero, main audit missing            -> "B3 missing main audit" expect 1
//   B3.2 error names "main audit not found"                 -> "B3 missing main audit" expect 2
//   B4.1 merge exits non-zero, prefix edited                -> "B4 prefix-hash" expect 1
//   B4.2 error names "prefix-hash"                          -> "B4 prefix-hash" expect 2
//   B5.1 staggered N=2 mergers both exit 0                  -> "B5 lock contention" expect 1+2
//   B5.2 exactly 2 AUDIT_MERGED rows                        -> "B5 lock contention" expect 3
//   B6  lock-timeout: non-zero + "Failed to acquire audit lock" -> "B6 lock timeout" expect 1+2
//   B7  65-char slug rejected, "65 chars|max is 64"         -> "B7 slug length" expect 1+2
//   B8  failed fork ERROR_LOGGED [fork-emitted:<iso-ts>]    -> "B8 ERROR_LOGGED correlation" expect 1
//   C1  alphabetical N=4 bracket order                      -> "C1 alphabetical" expect 1
//   C2  reverse-alphabetical N=4 bracket order              -> "C2 reverse" expect 1
//   C3  same-second-timestamps N=4 bracket order            -> "C3 same-second" expect 1
//   C4  N=4 one-empty-delta bracket order                   -> "C4 one-empty-delta" expect 1
//   C5  C4 main audit has exactly 4 AUDIT_MERGED rows        -> "C5/C6 structural" expect 1
//   C6  C4 main audit has exactly 4 AUDIT_FORKED rows        -> "C5/C6 structural" expect 2
//
// STRONGER than the .sh in several places: B3/B7 also assert NO side effect
// landed (no worktree audit, no AUDIT_FORKED row); B8 asserts the ISO-timestamp
// shape on the SAME [fork-emitted:...] tag AND that an integer Fork-Boundary
// value was NOT used as the correlation key.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  FIXTURES_DIR,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const WORKTREE_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) {
    // chmod the parent (and any chmod'd children) back to writable so cleanup
    // (and the readonly-worktree B8 case) doesn't leave undeletable dirs.
    try {
      chmodSync(f, 0o755);
    } catch {
      /* best effort */
    }
    cleanupWorktreeFixture(f);
  }
});

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");
const wtDir = (p: string, slug: string): string =>
  join(p, ".aidlc", "worktrees", `bolt-${slug}`);
const wtAuditPath = (p: string, slug: string): string =>
  join(wtDir(p, slug), "aidlc-docs", "audit.md");

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

function runAudit(args: string[], env?: Record<string, string>): CliResult {
  const res = spawnSync(BUN, [AUDIT_TOOL, ...args], {
    encoding: "utf-8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

/** Real `aidlc-worktree.ts create` — the same prerequisite the .sh ran. */
function createWorktree(p: string, slug: string): void {
  const res = spawnSync(
    BUN,
    [WORKTREE_TOOL, "create", "--slug", slug, "--base", "main", "--project-dir", p],
    { cwd: p, encoding: "utf-8" },
  );
  if ((res.status ?? -1) !== 0) {
    throw new Error(
      `aidlc-worktree create --slug ${slug} failed: ${res.stderr ?? res.stdout ?? `exit ${res.status}`}`,
    );
  }
}

/**
 * make_fixture (t07:53-61): a git fixture on main + a seeded state file
 * (so emitError's stateFilePath existsSync check passes) + a one-line
 * "# AI-DLC Audit Log\n" main audit. Returns the fixture path.
 */
function makeFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  mkdirSync(join(p, "aidlc-docs"), { recursive: true });
  writeFileSync(
    join(p, "aidlc-docs", "aidlc-state.md"),
    readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8"),
    "utf-8",
  );
  writeFileSync(auditPath(p), "# AI-DLC Audit Log\n", "utf-8");
  return p;
}

/** Count rows of the form `**Event**: <EVENT>` in a file. */
function countEvent(file: string, event: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === `**Event**: ${event}`).length;
}

/** Count standalone `---` separator lines (grep -c '^---$'). */
function countSeparators(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === "---").length;
}

/**
 * assert_per_bolt_bracket_order (t07:90-129): for each AUDIT_FORKED row's Bolt
 * slug, a matching AUDIT_MERGED row for the same slug must appear LATER in the
 * document. Walks event/slug pairs in document order, exactly like the .sh awk.
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

/** auditLockDir (aidlc-lib.ts:512-514): $TMPDIR/.aidlc-audit-<md5(projectDir)[0:8]>.lock */
function auditLockDir(projectDir: string): string {
  const hash = createHash("md5").update(projectDir).digest("hex").slice(0, 8);
  const base = process.env.TMPDIR || tmpdir();
  return join(base, `.aidlc-audit-${hash}.lock`);
}

// ===========================================================================
// Phase A — primitive smoke
// ===========================================================================
describe("t07 Phase A — primitive smoke (migrated from t07-audit-fork-merge.sh, plan 31)", () => {
  test("A1-A7: fork happy path — exit 0, AUDIT_FORKED in both audits, byte-identical, matching Fork Boundary", () => {
    const p = makeFixture();
    createWorktree(p, "demo");
    const fork = runAudit(["audit-fork", "--slug", "demo", "--project-dir", p]);

    expect(fork.status).toBe(0); // A1
    expect(fork.out).toContain('"emitted":"AUDIT_FORKED"'); // A2
    expect(countEvent(auditPath(p), "AUDIT_FORKED")).toBeGreaterThanOrEqual(1); // A3
    expect(readFileSync(auditPath(p), "utf-8")).toContain("Fork Boundary"); // A4
    expect(existsSync(wtAuditPath(p, "demo"))).toBe(true); // A5

    // A6: worktree audit byte-identical to main audit at fork instant.
    const mainBytes = readFileSync(auditPath(p));
    const wtBytes = readFileSync(wtAuditPath(p, "demo"));
    expect(wtBytes.equals(mainBytes)).toBe(true);

    // A7: Fork Boundary value identical in both files.
    const fb = (file: string): string => {
      const m = readFileSync(file, "utf-8").match(/\*\*Fork Boundary\*\*:\s*(\d+)/);
      return m ? m[1] : "";
    };
    expect(fb(auditPath(p))).not.toBe("");
    expect(fb(wtAuditPath(p, "demo"))).toBe(fb(auditPath(p)));
  }, 30000);

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

    expect(merge.status).toBe(0); // A8
    // A9: the appended STAGE_STARTED row landed in main (Stage: foo).
    expect(readFileSync(auditPath(p), "utf-8")).toContain("**Stage**: foo");
    expect(countEvent(auditPath(p), "AUDIT_MERGED")).toBeGreaterThanOrEqual(1); // A10
    // A11 (Decision 5: main-only emit): worktree audit has no AUDIT_MERGED row.
    expect(countEvent(wtAuditPath(p, "demo"), "AUDIT_MERGED")).toBe(0);
  }, 30000);
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
    expect(merge.status).toBe(0); // B1.1
    expect(merge.out).toContain('"entries_merged":0'); // B1.2
    // B1.3: empty-delta merge appends exactly one block (the AUDIT_MERGED row).
    expect(countSeparators(auditPath(p)) - preSeps).toBe(1);
  }, 30000);

  test("B2: missing <wt>/aidlc-docs/ is mkdir -p'd at fork", () => {
    const p = makeFixture();
    createWorktree(p, "e2");
    // B2.1: aidlc-worktree create does NOT scaffold aidlc-docs/ in the worktree.
    expect(existsSync(join(wtDir(p, "e2"), "aidlc-docs"))).toBe(false);
    runAudit(["audit-fork", "--slug", "e2", "--project-dir", p]);
    // B2.2: audit-fork's mkdir -p created <wt>/aidlc-docs/audit.md.
    expect(existsSync(wtAuditPath(p, "e2"))).toBe(true);
  }, 30000);

  test("B3: missing main audit — fork fails loud, no side effect", () => {
    const p = makeFixture();
    createWorktree(p, "e3");
    rmSync(auditPath(p), { force: true });

    const fork = runAudit(["audit-fork", "--slug", "e3", "--project-dir", p]);
    expect(fork.status).not.toBe(0); // B3.1
    expect(fork.out).toContain("main audit not found"); // B3.2
    // STRONGER: the pre-emit guard means no worktree audit was forged.
    expect(existsSync(wtAuditPath(p, "e3"))).toBe(false);
    // Restore so the trap/afterAll cleanup doesn't choke.
    writeFileSync(auditPath(p), "# AI-DLC Audit Log\n", "utf-8");
  }, 30000);

  test("B4: prefix-hash mismatch — merge refuses after a length-preserving main-audit edit", () => {
    const p = makeFixture();
    createWorktree(p, "e4");
    runAudit(["audit-fork", "--slug", "e4", "--project-dir", p]);
    runAudit([
      "append", "STAGE_STARTED",
      "--field", "Stage=foo", "--field", "Agent=bar",
      "--project-dir", wtDir(p, "e4"),
    ]);
    // Flip one byte in the header (length-preserving) — it lives in the prefix
    // that Source Audit Hash covers, so the recomputed hash will differ.
    const edited = readFileSync(auditPath(p), "utf-8").replace(
      "# AI-DLC Audit Log",
      "# AI-DLC Audit LOG",
    );
    writeFileSync(auditPath(p), edited, "utf-8");

    const merge = runAudit(["audit-merge", "--slug", "e4", "--project-dir", p]);
    expect(merge.status).not.toBe(0); // B4.1
    expect(merge.out).toContain("prefix-hash"); // B4.2
  }, 30000);

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

    // Background the first merge, stagger 50ms, run the second; await both.
    const mergeAsync = (slug: string): Promise<number> =>
      new Promise((resolve) => {
        const r = spawnSync(BUN, [
          AUDIT_TOOL, "audit-merge", "--slug", slug, "--project-dir", p,
        ], { encoding: "utf-8" });
        resolve(r.status ?? -1);
      });

    const bg = mergeAsync("lock-a");
    await new Promise((r) => setTimeout(r, 50));
    const fgRc = await mergeAsync("lock-b");
    const bgRc = await bg;

    expect(bgRc).toBe(0); // B5.1 (bg)
    expect(fgRc).toBe(0); // B5.1 (fg)
    // B5.2: both merges landed; exactly 2 AUDIT_MERGED rows in main audit.
    expect(countEvent(auditPath(p), "AUDIT_MERGED")).toBe(2);
  }, 30000);

  test("B6: lock-timeout — planted stuck lock + dialled-down retries → non-zero with clear error", () => {
    const p = makeFixture();
    createWorktree(p, "timeout");
    runAudit(["audit-fork", "--slug", "timeout", "--project-dir", p]);
    runAudit([
      "append", "STAGE_STARTED", "--field", "Stage=t", "--field", "Agent=t",
      "--project-dir", wtDir(p, "timeout"),
    ]);
    // Plant a stuck lock by mkdir-ing the exact dir the tool acquires.
    const lock = auditLockDir(p);
    mkdirSync(lock, { recursive: true });
    try {
      const merge = runAudit(
        ["audit-merge", "--slug", "timeout", "--project-dir", p],
        { AIDLC_AUDIT_LOCK_RETRIES: "2", AIDLC_AUDIT_LOCK_RETRY_MS: "50" },
      );
      expect(merge.status).not.toBe(0); // B6 (rc)
      expect(merge.out).toContain("Failed to acquire audit lock"); // B6 (message)
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }, 30000);

  test("B7: 65-char slug rejected before any disk side effect", () => {
    const p = makeFixture();
    const longSlug = "a".repeat(65);
    const fork = runAudit(["audit-fork", "--slug", longSlug, "--project-dir", p]);

    expect(fork.status).not.toBe(0); // B7 (rc)
    expect(fork.out).toMatch(/65 chars|max is 64/); // B7 (message)
    // STRONGER: the .sh's "before any disk side-effect" intent — no worktree
    // audit, no AUDIT_FORKED row landed for the rejected slug.
    expect(existsSync(wtAuditPath(p, longSlug))).toBe(false);
    expect(countEvent(auditPath(p), "AUDIT_FORKED")).toBe(0);
  }, 30000);

  test("B8: post-emit failure path — ERROR_LOGGED carries [fork-emitted:<iso-ts>] for doctor correlation", () => {
    const p = makeFixture();
    createWorktree(p, "erro");
    // chmod the worktree dir read-only so the mkdir of <wt>/aidlc-docs/ inside
    // audit-fork fails AFTER the AUDIT_FORKED emit succeeded.
    chmodSync(wtDir(p, "erro"), 0o555);
    try {
      runAudit(["audit-fork", "--slug", "erro", "--project-dir", p]);
    } finally {
      chmodSync(wtDir(p, "erro"), 0o755);
    }
    const main = readFileSync(auditPath(p), "utf-8");
    // The correlation tag is the ISO 8601 timestamp (isoTimestamp), NOT the
    // integer Fork Boundary — doctor (milestone 15) joins the orphan AUDIT_FORKED row
    // to this ERROR_LOGGED by exact-string timestamp match.
    expect(main).toMatch(
      /\[fork-emitted:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]/,
    );
    // STRONGER: the tag is NOT a bare integer (Fork Boundary value).
    expect(main).not.toMatch(/\[fork-emitted:\d+\]/);
  }, 30000);
});

// ===========================================================================
// Phase C — property (N=4 orderings preserve per-Bolt fork→merge brackets)
// ===========================================================================
describe("t07 Phase C — property", () => {
  /** N=4 fork+append+merge cycles in the given slug order (run_n4_scenario). */
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
  }, 60000);

  test("C2: reverse-alphabetical N=4 — bracket order preserved", () => {
    const p = makeFixture();
    runN4(p, ["delta", "charlie", "bravo", "alpha"]);
    expect(bracketOrderViolation(auditPath(p))).toBeNull();
  }, 60000);

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
  }, 60000);

  test("C4-C6: N=4 with one empty delta — bracket order preserved + exactly 4 forks / 4 merges", () => {
    const p = makeFixture();
    for (const s of ["z1", "z2", "z3", "z4"]) {
      createWorktree(p, s);
      runAudit(["audit-fork", "--slug", s, "--project-dir", p]);
    }
    // Three of four append a delta; z3 stays empty.
    for (const s of ["z1", "z2", "z4"]) {
      runAudit([
        "append", "STAGE_STARTED", "--field", `Stage=${s}`, "--field", "Agent=test",
        "--project-dir", wtDir(p, s),
      ]);
    }
    for (const s of ["z1", "z2", "z3", "z4"]) {
      runAudit(["audit-merge", "--slug", s, "--project-dir", p]);
    }
    // C4: bracket order preserved across the one-empty-delta ordering.
    expect(bracketOrderViolation(auditPath(p))).toBeNull();
    // C5: exactly 4 AUDIT_MERGED rows (no merger silently dropped).
    expect(countEvent(auditPath(p), "AUDIT_MERGED")).toBe(4);
    // C6: exactly 4 AUDIT_FORKED rows.
    expect(countEvent(auditPath(p), "AUDIT_FORKED")).toBe(4);
  }, 60000);
});
