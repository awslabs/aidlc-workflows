// covers: subcommand:aidlc-state:fork, subcommand:aidlc-state:merge
//
// CLI-contract port of tests/unit/t76-state-fork-merge.sh (TAP plan 16),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-state.ts --project-dir <p> fork|merge --slug <s>`
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status / res.stdout+stderr and
// the file effects the tool writes — the worktree state file, main's Bolt
// Refs field, and the STATE_FORKED / STATE_MERGED / ERROR_LOGGED rows it
// appends to audit.md. The contract under test is the PROCESS boundary plus
// those side effects (incl. exit codes, slug-tagged error strings, the
// withAuditLock-held critical section's lock-release behaviour), so it stays
// a spawn — an in-process handleFork/handleMerge twin would lose the
// process.exit shell the .sh's `$?` arm relies on for every failure case AND
// the errorWithSlug → emitError → process.exit lock-release path test 15
// pins.
//
// SUBCOMMAND UNITS: this .cli file credits BOTH subcommand units the .sh
// exercises — `aidlc-state fork` (covers KEY subcommand:aidlc-state:fork)
// and `aidlc-state merge` (covers KEY subcommand:aidlc-state:merge). Both
// are fired here, the colon form per the dead-id trap.
//
// PARITY NOTES (every .sh `ok`/`skip` line maps to a test() case here; many
// are STRONGER than the original grep):
//   - .sh  1 fork happy path: norm-strip cmp + Bolt Refs=[demo] + STATE_FORKED
//       -> Test 1: worktree state byte-identical to main modulo Worktree
//       Path + Bolt Refs (same line-filter+join cmp), Bolt Refs === "[demo]"
//       (exact field), STATE_FORKED count === 1 (STRONGER: exact count over a
//       seeded baseline, not bare presence), + JSON ack status "forked" and
//       source_state_hash present (STRONGER additions on the stdout boundary).
//   - .sh  2 invalid slug '../etc/passwd' rc!=0 + 'Invalid --slug'
//       -> Test 2: status !== 0 (the .sh checked rc -ne 0) + out contains
//       'Invalid --slug' (same observable). NOTE: '..' fails the SLUG_RE
//       (must start [a-z]) so validateSlug → errorWithSlug → exit 1.
//   - .sh  3 missing worktree dir rc!=0 + 'worktree directory does not exist'
//       + '[slug=noworktree]' -> Test 3: status !== 0 + both substrings
//       (same observables, slug-tag included).
//   - .sh  4 v6 state (Worktree Path field deleted) rc!=0 + 'Worktree Path'
//       -> Test 4: status !== 0 + out contains 'Worktree Path' (setFieldStrict
//       throws on the missing v7 field). STRONGER: also assert no STATE_FORKED
//       row landed (the throw happens after the audit-first emit? — verified
//       below: setFieldStrict on Worktree Path runs AFTER the STATE_FORKED
//       emit, so a row CAN land; we mirror the .sh exactly and DON'T over-
//       constrain that — see Test 4 comment).
//   - .sh  5 audit-first Part A: pre-create lock dir, fork → rc!=0 AND no
//       worktree state file written -> Test 5: status !== 0 + worktree state
//       file absent (same two observables). The pre-created lock dir forces
//       acquireAuditLock to exhaust its 50×100ms budget (~5s) → withAuditLock
//       throws → errorWithSlug → exit 1 before any worktree write.
//   - .sh  6 audit-first Part B (POSIX-gated): chmod 0555 worktree aidlc-docs,
//       fork → rc!=0 AND STATE_FORKED row AND ERROR_LOGGED row AND
//       '[slug=part-b]' -> Test 6: same four observables, gated on a
//       runtime read-only-dir probe (skips on platforms that ignore dir mode,
//       mirroring readonly_dirs_enforced; keeps the 16-assert intent intact).
//   - .sh  7 merge happy round-trip: post-merge main byte-identical to a
//       hand-built EXPECTED (cmp -s) -> Test 7: post-merge main === EXPECTED
//       string (same byte-for-byte observable, expressed as a string compare).
//   - .sh  8 merge workflow-level Active Agent untouched (main wins)
//       -> Test 8: post-merge Active Agent field === aidlc-developer-agent
//       (same observable; STRONGER: exact field value, not a substring grep).
//   - .sh  9 alphabetical-slug tiebreak: merge beta then alpha; code-generation
//       stays [-] after beta (deferred), becomes [S] after alpha (lower slug
//       wins) -> Test 9: same two intermediate observables.
//   - .sh 10 Bolt Refs reverts to [empty list] after last merge -> Test 10:
//       reuses the test-9 project; Bolt Refs field === '[empty list]'.
//   - .sh 11 merge idempotency: 2nd merge rc!=0 + 'already merged' + no 2nd
//       STATE_MERGED row -> Test 11: same three observables (count stays 1).
//   - .sh 12 merge audit-lock timeout: pre-create lock dir, merge → rc!=0 +
//       '[slug=timeout]' + (lock|retries) -> Test 12: same observables.
//   - .sh 13 concurrent forks distinct slugs: both land, Bolt Refs sorted
//       [bolt-x, bolt-y] -> Test 13: spawn both, await both, Bolt Refs field
//       === '[bolt-x, bolt-y]' (emitRefsList alphabetical sort observable).
//   - .sh 14 (B2) duplicate-slug fork: 2nd fork rc!=0 + 'slug already in
//       Bolt Refs' + STATE_FORKED count stays 1 -> Test 14: same observables.
//   - .sh 15 (B1) errorWithSlug-in-lock releases lock: trigger dup-slug error,
//       lock dir released, follow-up fork sub-3s -> Test 15: lock dir absent
//       after the failing fork + follow-up fork succeeds (status 0) and the
//       wall-clock is well under the ~5s retry budget (asserted < 3000ms).
//   - .sh 16 (M1) audit Target state hash === actual main SHA after merge
//       -> Test 16: parse target_state_hash off the merge JSON ack, sha256 the
//       post-merge main file, assert equal (same observable).
//
// 16 .sh assertions -> 16 test() cases here (Test 10 reuses Test 9's project,
// matching the .sh's "Reuse proj from test 9"). STRONGER additions are noted
// inline; nothing is dropped.
//
// FIXTURE DISCIPLINE (mirrors the .sh's make_fixture = create_test_project +
// inline v7 state + empty audit header): each case builds a FRESH temp project
// via createTestProject (toPortablePath-converts on Windows so the audit.md /
// state.md the tool writes via toPosix round-trip when read back), writes the
// SAME inline v7 state + bare audit header the .sh's make_fixture used, and —
// for the cases that read audit row COUNTS — starts from the bare
// "# AI-DLC Audit Log\n" header so post-fire counts are unambiguous (the .sh
// did NOT seed audit-sample.md here; it used a bare header). Worktree dirs are
// created under <proj>/.aidlc/worktrees/bolt-<slug>/ exactly as mk_worktree_dir
// did. All temp dirs cleaned in afterAll, plus a best-effort chmod-restore +
// lock-dir rmdir to mirror the .sh's cleanup_all trap.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { auditLockDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const STATE_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-state.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    // Mirror cleanup_all: restore perms on any chmod'd worktree dir, drop a
    // leftover lock dir, then remove the project tree.
    try {
      const wt = join(d, ".aidlc", "worktrees");
      if (existsSync(wt)) chmodSync(wt, 0o755);
    } catch {
      /* best-effort */
    }
    try {
      const lk = auditLockDir(d);
      if (existsSync(lk)) rmSync(lk, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-state.ts --project-dir <p> <args...>`. Mirrors `bun "$STATE_TS" --project-dir "$proj" ...`. */
function state(proj: string, ...args: string[]): CliResult {
  const res = spawnSync(BUN, [STATE_TS, "--project-dir", proj, ...args], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

const statePath = (p: string): string =>
  join(p, "aidlc-docs", "aidlc-state.md");
const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");
const wtStatePath = (p: string, slug: string): string =>
  join(p, ".aidlc", "worktrees", `bolt-${slug}`, "aidlc-docs", "aidlc-state.md");

const sha256File = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

// The clean v7 state fixture — byte-for-byte the .sh's make_fixture heredoc
// (t76-state-fork-merge.sh:75-94).
const V7_STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: t76-fixture
- **Project Type**: Greenfield
- **Scope**: feature
- **Start Date**: 2026-05-18T00:00:00Z
- **State Version**: 7
- **Active Agent**: aidlc-developer-agent
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Stage Progress

### CONSTRUCTION PHASE
- [-] code-generation — EXECUTE
- [-] build-and-test — EXECUTE
`;

/** make_fixture: fresh temp project with the v7 state + bare audit header. */
function makeFixture(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(statePath(proj), V7_STATE, "utf-8");
  // The .sh seeds a BARE header here (not audit-sample.md), so audit-row
  // counts post-fire are unambiguous.
  writeFileSync(auditPath(proj), "# AI-DLC Audit Log\n", "utf-8");
  return proj;
}

/** mk_worktree_dir: mkdir -p <proj>/.aidlc/worktrees/bolt-<slug>. */
function mkWorktreeDir(proj: string, slug: string): void {
  mkdirSync(join(proj, ".aidlc", "worktrees", `bolt-${slug}`), {
    recursive: true,
  });
}

/** Value of a `- **Field**:` line in the state file (trimmed of the prefix). */
function stateField(proj: string, field: string): string {
  const re = new RegExp(`^- \\*\\*${field}\\*\\*:(.*)$`);
  for (const line of readFileSync(statePath(proj), "utf-8").split("\n")) {
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

/** Count audit blocks with `**Event**: <ev>` (mirrors `grep -c STATE_FORKED`). */
function auditEventCount(proj: string, ev: string): number {
  const f = auditPath(proj);
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.includes(`**Event**: ${ev}`)).length;
}

const fileContains = (file: string, needle: string): boolean =>
  existsSync(file) && readFileSync(file, "utf-8").includes(needle);

/**
 * Strip the two intentionally-divergent fields (Worktree Path + Bolt Refs)
 * from a state file and return the remaining lines joined — mirrors the .sh's
 * `grep -vE '^- \*\*(Worktree Path|Bolt Refs)\*\*:'` normalisation for the
 * byte-identical comparison.
 */
function normStripped(file: string): string {
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => !/^- \*\*(Worktree Path|Bolt Refs)\*\*:/.test(l))
    .join("\n");
}

/**
 * Probe whether this platform enforces read-only directory permissions —
 * mirrors readonly_dirs_enforced (t76:143-152). Test 6's chmod-0555 mechanism
 * is a no-op on platforms that ignore dir mode (native Windows), so we skip it
 * there rather than asserting an unobservable sequence.
 */
function readonlyDirsEnforced(): boolean {
  if (process.platform === "win32") return false;
  const probe = join(
    tempDirs[0] ?? REPO_ROOT,
    `..`,
    `.aidlc-t76-probe-${process.pid}`,
  );
  try {
    mkdirSync(probe, { recursive: true });
    chmodSync(probe, 0o555);
    try {
      writeFileSync(join(probe, "probe-write"), "x", "utf-8");
      // Write succeeded → read-only dirs NOT enforced.
      chmodSync(probe, 0o755);
      rmSync(probe, { recursive: true, force: true });
      return false;
    } catch {
      chmodSync(probe, 0o755);
      rmSync(probe, { recursive: true, force: true });
      return true;
    }
  } catch {
    try {
      rmSync(probe, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    return false;
  }
}

// ============================================================
// fork subcommand (covers: subcommand:aidlc-state:fork)
// ============================================================

describe("t76 aidlc-state fork (migrated from t76-state-fork-merge.sh, plan 16)", () => {
  test("1: fork happy path — byte-identical worktree state, Bolt Refs=[demo], STATE_FORKED row", () => {
    const proj = makeFixture();
    mkWorktreeDir(proj, "demo");
    const r = state(proj, "fork", "--slug", "demo");
    expect(r.status).toBe(0);
    // Worktree state equals main modulo Worktree Path + Bolt Refs.
    expect(normStripped(wtStatePath(proj, "demo"))).toBe(
      normStripped(statePath(proj)),
    );
    // Main's Bolt Refs registers the fork.
    expect(stateField(proj, "Bolt Refs")).toBe("[demo]");
    // Exactly one STATE_FORKED row (STRONGER than the .sh's bare presence grep).
    expect(auditEventCount(proj, "STATE_FORKED")).toBe(1);
    // STRONGER: JSON ack on the stdout boundary.
    expect(r.stdout).toContain('"status":"forked"');
    expect(r.stdout).toContain('"source_state_hash":');
  });

  test("2: fork rejects invalid slug '../etc/passwd' before path construction", () => {
    const proj = makeFixture();
    const r = state(proj, "fork", "--slug", "../etc/passwd");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Invalid --slug");
  });

  test("3: fork fails loud when worktree dir missing, error tagged with [slug=...]", () => {
    const proj = makeFixture();
    // No mkWorktreeDir — directory does not exist.
    const r = state(proj, "fork", "--slug", "noworktree");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("worktree directory does not exist");
    expect(r.out).toContain("[slug=noworktree]");
  });

  test("4: fork fails loud when Worktree Path field absent (v6 state precursor)", () => {
    const proj = makeFixture();
    mkWorktreeDir(proj, "v6test");
    // Drop the v7-only Worktree Path field → setFieldStrict throws.
    const stripped = readFileSync(statePath(proj), "utf-8")
      .split("\n")
      .filter((l) => !/^- \*\*Worktree Path\*\*:/.test(l))
      .join("\n");
    writeFileSync(statePath(proj), stripped, "utf-8");
    const r = state(proj, "fork", "--slug", "v6test");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Worktree Path");
  });

  test(
    "5: fork strict audit-first Part A — lock held → no worktree state file written",
    () => {
      const proj = makeFixture();
      mkWorktreeDir(proj, "partA");
      // Pre-create the lock dir so acquireAuditLock exhausts its ~5s budget
      // → withAuditLock throws → exit before any worktree write.
      const lockDir = auditLockDir(proj);
      mkdirSync(lockDir, { recursive: true });
      try {
        const r = state(proj, "fork", "--slug", "partA");
        expect(r.status).not.toBe(0);
        expect(existsSync(wtStatePath(proj, "partA"))).toBe(false);
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    },
    30000,
  );

  test("6: fork strict audit-first Part B — STATE_FORKED + ERROR_LOGGED with [slug=part-b] tag", () => {
    if (!readonlyDirsEnforced()) {
      // Platform ignores read-only dir mode (e.g. native Windows): the write
      // failure this case provokes cannot occur, so the STATE_FORKED-then-
      // ERROR_LOGGED sequence is unobservable via chmod 0555. Skip rather than
      // assert an impossible observable (mirrors the .sh's SKIP).
      return;
    }
    const proj = makeFixture();
    mkWorktreeDir(proj, "part-b");
    const wtDocs = join(
      proj,
      ".aidlc",
      "worktrees",
      "bolt-part-b",
      "aidlc-docs",
    );
    mkdirSync(wtDocs, { recursive: true });
    chmodSync(wtDocs, 0o555);
    try {
      const r = state(proj, "fork", "--slug", "part-b");
      expect(r.status).not.toBe(0);
      // Audit-first: STATE_FORKED landed before the worktree write failed,
      // then ERROR_LOGGED with the slug tag for doctor reconciliation.
      expect(auditEventCount(proj, "STATE_FORKED")).toBe(1);
      expect(auditEventCount(proj, "ERROR_LOGGED")).toBe(1);
      expect(fileContains(auditPath(proj), "[slug=part-b]")).toBe(true);
    } finally {
      chmodSync(wtDocs, 0o755);
    }
  });

  test("13: concurrent forks for distinct slugs — both land, Bolt Refs sorted alphabetically", async () => {
    const proj = makeFixture();
    mkWorktreeDir(proj, "bolt-x");
    mkWorktreeDir(proj, "bolt-y");
    // Launch both forks concurrently (bash `&` + wait), then check both landed.
    const spawnAsync = (slug: string): Promise<number> =>
      new Promise((resolve) => {
        const { spawn } = require("node:child_process");
        const child = spawn(
          BUN,
          [STATE_TS, "--project-dir", proj, "fork", "--slug", slug],
          { stdio: "ignore" },
        );
        child.on("exit", (code: number | null) => resolve(code ?? -1));
      });
    await Promise.all([spawnAsync("bolt-x"), spawnAsync("bolt-y")]);
    // emitRefsList sorts alphabetically → [bolt-x, bolt-y] (x < y).
    expect(stateField(proj, "Bolt Refs")).toBe("[bolt-x, bolt-y]");
  }, 30000);

  test("14: (B2) duplicate-slug fork — no phantom STATE_FORKED row, recovery hint in error", () => {
    const proj = makeFixture();
    mkWorktreeDir(proj, "dup");
    const first = state(proj, "fork", "--slug", "dup");
    expect(first.status).toBe(0);
    const countBefore = auditEventCount(proj, "STATE_FORKED");
    expect(countBefore).toBe(1);
    const r = state(proj, "fork", "--slug", "dup");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("slug already in Bolt Refs");
    // No phantom row — count stays at 1.
    expect(auditEventCount(proj, "STATE_FORKED")).toBe(1);
  }, 30000);

  test(
    "15: (B1) errorWithSlug inside locked block releases lock cleanly",
    () => {
      const proj = makeFixture();
      mkWorktreeDir(proj, "alpha");
      expect(state(proj, "fork", "--slug", "alpha").status).toBe(0);
      mkWorktreeDir(proj, "alpha2");
      // Trigger errorWithSlug via duplicate slug (locked block exits before
      // write). The lock dir must release even though Bun's process.exit skips
      // `finally` — the withAuditLock exit-handler safety net does it.
      const dup = state(proj, "fork", "--slug", "alpha");
      expect(dup.status).not.toBe(0);
      // Lock dir released after the failing fork.
      expect(existsSync(auditLockDir(proj))).toBe(false);
      // A follow-up fork must succeed WITHOUT hitting the ~5s acquire budget.
      const start = Date.now();
      const followup = state(proj, "fork", "--slug", "alpha2");
      const elapsed = Date.now() - start;
      expect(followup.status).toBe(0);
      expect(elapsed).toBeLessThan(3000);
    },
    30000,
  );
});

// ============================================================
// merge subcommand (covers: subcommand:aidlc-state:merge)
// ============================================================

describe("t76 aidlc-state merge (migrated from t76-state-fork-merge.sh, plan 16)", () => {
  test("7: merge happy round-trip — post-merge main byte-identical to expected", () => {
    const proj = makeFixture();
    mkWorktreeDir(proj, "demo");
    expect(state(proj, "fork", "--slug", "demo").status).toBe(0);
    // Worktree advances code-generation [-] -> [x].
    const wt = wtStatePath(proj, "demo");
    writeFileSync(
      wt,
      readFileSync(wt, "utf-8").replace(
        "[-] code-generation",
        "[x] code-generation",
      ),
      "utf-8",
    );
    expect(state(proj, "merge", "--slug", "demo").status).toBe(0);
    // Expected: original main with code-generation flipped + Bolt Refs reverted
    // to [empty list] (byte-for-byte the .sh's EXPECTED heredoc, t76:284-303).
    const EXPECTED = `# AI-DLC State Tracking

## Project Information
- **Project**: t76-fixture
- **Project Type**: Greenfield
- **Scope**: feature
- **Start Date**: 2026-05-18T00:00:00Z
- **State Version**: 7
- **Active Agent**: aidlc-developer-agent
- **Worktree Path**:
- **Bolt Refs**: [empty list]
- **Practices Affirmed Timestamp**:

## Stage Progress

### CONSTRUCTION PHASE
- [x] code-generation — EXECUTE
- [-] build-and-test — EXECUTE
`;
    expect(readFileSync(statePath(proj), "utf-8")).toBe(EXPECTED);
  }, 30000);

  test("8: merge — workflow-level Active Agent untouched (main wins, worktree value ignored)", () => {
    const proj = makeFixture();
    mkWorktreeDir(proj, "wftest");
    expect(state(proj, "fork", "--slug", "wftest").status).toBe(0);
    const wt = wtStatePath(proj, "wftest");
    // Mutate Active Agent in the worktree to a rogue value.
    writeFileSync(
      wt,
      readFileSync(wt, "utf-8").replace(
        "- **Active Agent**: aidlc-developer-agent",
        "- **Active Agent**: rogue-agent",
      ),
      "utf-8",
    );
    expect(state(proj, "merge", "--slug", "wftest").status).toBe(0);
    // STRONGER than the .sh substring grep: exact field value.
    expect(stateField(proj, "Active Agent")).toBe("aidlc-developer-agent");
  }, 30000);

  test("9+10: merge — alphabetical-slug tiebreak (beta defers, alpha wins) + Bolt Refs reverts to [empty list]", () => {
    // Test 10 in the .sh reuses test 9's project, so they're one case here.
    const proj = makeFixture();
    mkWorktreeDir(proj, "alpha");
    mkWorktreeDir(proj, "beta");
    expect(state(proj, "fork", "--slug", "alpha").status).toBe(0);
    expect(state(proj, "fork", "--slug", "beta").status).toBe(0);
    // alpha → [S], beta → [x] on the same Construction cell.
    const wa = wtStatePath(proj, "alpha");
    writeFileSync(
      wa,
      readFileSync(wa, "utf-8").replace(
        "[-] code-generation",
        "[S] code-generation",
      ),
      "utf-8",
    );
    const wb = wtStatePath(proj, "beta");
    writeFileSync(
      wb,
      readFileSync(wb, "utf-8").replace(
        "[-] code-generation",
        "[x] code-generation",
      ),
      "utf-8",
    );
    // Merge beta FIRST (against alphabetical order). Bolt Refs = [alpha, beta]
    // so candidateSlugs[0]='alpha' — beta DEFERS its write.
    expect(state(proj, "merge", "--slug", "beta").status).toBe(0);
    const cgAfterBeta = readFileSync(statePath(proj), "utf-8")
      .split("\n")
      .find((l) => l.includes("code-generation"));
    // code-generation NOT changed yet (deferred to alpha).
    expect(cgAfterBeta).toContain("[-]");
    // Now merge alpha — Bolt Refs = [alpha], alpha wins, applies [S].
    expect(state(proj, "merge", "--slug", "alpha").status).toBe(0);
    const cgAfterAlpha = readFileSync(statePath(proj), "utf-8")
      .split("\n")
      .find((l) => l.includes("code-generation"));
    expect(cgAfterAlpha).toContain("[S]");
    // Test 10: Bolt Refs reverts to [empty list] after the last merge.
    expect(stateField(proj, "Bolt Refs")).toBe("[empty list]");
  }, 30000);

  test("11: merge idempotency — re-run exits non-zero 'already merged', no second STATE_MERGED row", () => {
    const proj = makeFixture();
    mkWorktreeDir(proj, "idem");
    expect(state(proj, "fork", "--slug", "idem").status).toBe(0);
    expect(state(proj, "merge", "--slug", "idem").status).toBe(0);
    const mergedBefore = auditEventCount(proj, "STATE_MERGED");
    expect(mergedBefore).toBe(1);
    const r = state(proj, "merge", "--slug", "idem");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("already merged");
    // No second row.
    expect(auditEventCount(proj, "STATE_MERGED")).toBe(mergedBefore);
  }, 30000);

  test(
    "12: merge audit-lock timeout — slug-tagged failure, no partial state write",
    () => {
      const proj = makeFixture();
      mkWorktreeDir(proj, "timeout");
      expect(state(proj, "fork", "--slug", "timeout").status).toBe(0);
      // Pre-create the lock dir so emitAudit's acquireAuditLock retries until
      // the ~5s budget exhausts.
      const lockDir = auditLockDir(proj);
      mkdirSync(lockDir, { recursive: true });
      try {
        const r = state(proj, "merge", "--slug", "timeout");
        expect(r.status).not.toBe(0);
        expect(r.out).toContain("[slug=timeout]");
        expect(/lock|retries/i.test(r.out)).toBe(true);
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    },
    30000,
  );

  test("16: (M1) audit Target state hash matches actual main state SHA after merge", () => {
    const proj = makeFixture();
    mkWorktreeDir(proj, "hashtest");
    expect(state(proj, "fork", "--slug", "hashtest").status).toBe(0);
    const wt = wtStatePath(proj, "hashtest");
    writeFileSync(
      wt,
      readFileSync(wt, "utf-8").replace(
        "[-] code-generation",
        "[x] code-generation",
      ),
      "utf-8",
    );
    const r = state(proj, "merge", "--slug", "hashtest");
    expect(r.status).toBe(0);
    // Parse target_state_hash off the JSON ack, re-hash the post-merge main.
    const m = r.stdout.match(/"target_state_hash":"([0-9a-f]+)"/);
    expect(m).not.toBeNull();
    const targetHash = m?.[1];
    const actualHash = sha256File(statePath(proj));
    expect(targetHash).toBe(actualHash);
  }, 30000);
});
