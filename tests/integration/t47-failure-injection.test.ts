// covers: subcommand:aidlc-state:acknowledge-compaction, subcommand:aidlc-state:gate-start, subcommand:aidlc-state:advance
//
// Migrated from tests/integration/t47-failure-injection.sh (TAP plan 8),
// mechanism = cli. The .sh carried no `# covers:` header; the covered units
// are derived faithfully from the three aidlc-state subcommands it drives
// through chaos conditions — acknowledge-compaction (F1), gate-start (F2 + F4),
// and advance (F3). This is the INTEGRATION angle on the failure-injection
// subject: the audit-first invariant proven end-to-end across the state
// machine's subcommand dispatch. (The sibling tests/integration/t137.cli.test.ts
// covers the same four injections from the audit:ERROR_LOGGED emitter angle;
// this twin's covered units are the three subcommand dispatch surfaces, one of
// which — aidlc-state acknowledge-compaction — is otherwise UNCOVERED.)
//
// Mechanism = cli (NOT none). Every assertion the .sh makes is a process-
// boundary observable: the exit code ($rc) that emitError -> process.exit(1)
// produces (aidlc-lib.ts:1637), the chmod 0444 permission denial that only a
// real spawned process hits at appendFileSync / writeStateFile, the audit.md
// bytes the locked audit emitter appends, and the whole-file state.md snapshot
// compared before/after. An in-process import twin would lose the exit-code
// shell (a thrown EACCES in-process never exercises main()'s catch ->
// error() -> emitError -> process.exit path that F4's ERROR_LOGGED row rides
// on) and the env-seam --project-dir resolution. So we SPAWN the real tool via
// the BUN runtime against the .ts path: spawnSync(BUN, [STATE, ...]) — the same
// broadened cli pattern the suite credits. spawnCount = all.
//
// Source under test (dist/claude/.claude/tools/aidlc-state.ts):
//   :984 handleAcknowledgeCompaction — emits RECOVERY_COMPLETED via emitAudit
//          (:1032). NO writeStateFile and NO try/catch around the emit: a
//          locked audit.md makes appendAuditEntry throw (aidlc-audit.ts:272
//          appendFileSync EACCES), the throw propagates to main()'s catch
//          (:185-187) -> error() -> exit 1. The handler never writes state, so
//          state.md is structurally guaranteed byte-unchanged (F1).
//   :677 handleGateStart — emitAudit STAGE_AWAITING_APPROVAL then writeStateFile.
//          F2: appendAuditEntry -> appendAuditEntryUnlocked -> ensureAuditFile
//          (aidlc-audit.ts:189-199) recreates a missing audit.md; exit 0.
//          F4: audit emit succeeds (audit.md writable) but writeStateFile on a
//          0444 state.md throws -> main() catch -> error() -> emitError emits
//          ERROR_LOGGED (state.md exists, so the guard at aidlc-lib.ts:1604
//          lets the row through) and exits 1.
//   :317 handleAdvance — getField(content,"Scope") returns null on a corrupted
//          state -> error("State file has no Scope field...") (:332-336);
//          exit 1; the message names "Scope".
//
// emitError ERROR_LOGGED format: `**Event**: ERROR_LOGGED`, heading
// "Error Logged", with Tool/Command/Error fields (aidlc-lib.ts:1619-1629,
// aidlc-audit.ts:151).
//
// CHAOS CONTRACT (the .sh's four failure injections, lines 37-163):
//   F1. Permission-denied on audit.md during acknowledge-compaction —
//       audit-first means the emit throws BEFORE any state write, the tool
//       exits 1, and aidlc-state.md is byte-identical to its pre-injection snapshot.
//   F2. Missing audit.md before gate-start — ensureAuditFile recreates it;
//       gate-start exits 0 and the file reappears.
//   F3. Corrupted state (no Scope) before advance — advance refuses, exits 1,
//       and the error message names the missing Scope field.
//   F4. Read-only state.md before gate-start — the audit emit succeeds but
//       writeStateFile can't write, so the tool exits 1 AND a fresh
//       ERROR_LOGGED row is appended.
//
// Old TAP -> new test parity (8 .sh asserts -> 8 expect()-bearing test()s,
// one observable each; several STRONGER than the original grep):
//   .sh assert 1 (acknowledge exits non-zero, audit.md 0444)   -> "F1: acknowledge-compaction exits 1 when audit.md is read-only"
//   .sh assert 2 (state file unchanged after audit failure)    -> "F1: aidlc-state.md byte-unchanged (audit-first holds)"
//   .sh assert 3 (gate-start exit 0, audit.md missing)         -> "F2: gate-start exits 0 when audit.md was missing"
//   .sh assert 4 (audit.md recreated on demand)                -> "F2: audit.md recreated on demand"
//   .sh assert 5 (advance exit 1, corrupted state)             -> "F3: advance exits 1 on corrupted state (missing Scope)"
//   .sh assert 6 (error message mentions the missing Scope)    -> "F3: error message names the missing Scope field"
//   .sh assert 7 (gate-start exit 1, state.md 0444)            -> "F4: gate-start exits 1 when state.md is read-only"
//   .sh assert 8 (ERROR_LOGGED emitted on state-write failure) -> "F4: ERROR_LOGGED emitted on state-write failure"
//
// STRONGER than the .sh, per assertion:
//   - F1 assert 2: exact byte equality of the WHOLE state file (the .sh string-
//     compared `$state_before` vs `$state_after`); plus we sanity-assert init
//     succeeded so a never-written state isn't trivially "unchanged".
//   - F2 assert 4: beyond `[ -f ... ]`, assert the recreated audit carries the
//     STAGE_AWAITING_APPROVAL row gate-start emits — proving rebuilt-and-written.
//   - F3 assert 6: beyond `grep -q "Scope"`, pin the exact refusal sentence
//     "no Scope field" (aidlc-state.ts:334).
//   - F4 assert 8: beyond the bare count delta, pin the new row's Tool field to
//     "aidlc-state", proving the row came from the state tool's emitError path.
//
// §6-E non-golden discipline: F1/F3/F4 are FAILURE injections — the failure
// event must ACTUALLY FIRE. Each asserts exit 1 (the failure) and the specific
// failure observable (state-unchanged / Scope refusal / ERROR_LOGGED row), not
// a happy path.
//
// PLATFORM SKIP (mirrors the .sh's root-skip at lines 29-33 and its `command -v
// bun` skip at 24-27): the chmod-injection cases (F1, F4) rely on chmod 0444
// actually denying writes. The .sh skipped when `id -u` == 0 (root defeats
// chmod) and the suite never runs the .sh on native Windows (it is bash there).
// We gate F1/F4 behind a runIfChmod guard (skipped on Windows AND when running
// as uid 0) so the file stays green everywhere while preserving full coverage
// on macOS/Linux. F2 and F3 carry no chmod and always run. bun is a hard
// prerequisite of bun:test, so the .sh's `command -v bun` SKIP is moot here.
//
// FIXTURE DISCIPLINE (mirrors create_test_project + cleanup_test_project per
// case): each case uses a FRESH temp project dir (createTestProject, which
// toPortablePath-converts on Windows so the tool-written forward-slash paths
// round-trip when read back). F3 copies the SAME tests/fixtures/audit-sample.md
// the .sh used (read-only source copy; nothing is WRITTEN under tests/fixtures).
// All temp dirs are cleaned in afterAll, and every chmod is restored to 0644 in
// a finally so a failed assertion can't leave an unremovable read-only dir.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seededAuditShard,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");

resetAidlcEnv();

// The .sh skips when running as root (chmod 0444 doesn't deny writes for root,
// lines 29-33) and is only ever run under bash, never native Windows. Gate the
// chmod-injection cases (F1, F4) behind both conditions.
const isRoot =
  typeof process.getuid === "function" && process.getuid() === 0;
const CHMOD_WORKS = process.platform !== "win32" && !isRoot;
const runIfChmod = CHMOD_WORKS ? test : test.skip;

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    // Defensive: restore writability before removal in case a case bailed out
    // after chmod-ing but before its finally ran. Cover both the per-intent
    // record locations (P4) and the flat fallback (F3's hand-seeded layout).
    for (const f of [
      statePath(d),
      auditShardPath(d),
      auditDirOf(d),
      join(d, "aidlc-docs", "audit.md"),
      join(d, "aidlc-docs", "aidlc-state.md"),
    ]) {
      if (!f) continue;
      try {
        chmodSync(f, 0o755);
      } catch {
        /* file/dir may not exist */
      }
    }
    cleanupTestProject(d);
  }
});

/** Fresh temp project (create_test_project). */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

// P4: intent-birth writes state into the born intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<slug>-<id8>/) and audit into per-clone SHARDS
// under <record>/audit/<host>-<clone>.md — not the flat aidlc-docs/ trio. After
// init the active-intent cursor points at the born record, so the later
// state-tool calls (acknowledge-compaction/gate-start/advance) read/write THAT
// record. recordDirOf follows the cursor and falls back to flat for F3 (which
// hand-seeds a flat corrupted state.md and never births a record).
function recordDirOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(p, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(p, "aidlc-docs");
}

const auditDirOf = (p: string): string => join(recordDirOf(p), "audit");
const statePath = (p: string): string =>
  join(recordDirOf(p), "aidlc-state.md");

/** The single audit shard for a freshly-born record. Returns "" when none. */
function auditShardPath(p: string): string {
  const dir = auditDirOf(p);
  if (!existsSync(dir)) return "";
  const shard = readdirSync(dir).find((f) => f.endsWith(".md"));
  return shard ? join(dir, shard) : "";
}

// Concatenate every audit shard for a content read; fall back to the flat
// aidlc-docs/audit.md for a seeded-flat / pre-migration project.
function readAudit(p: string): string {
  const dir = auditDirOf(p);
  if (existsSync(dir)) {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(dir, f), "utf-8"))
      .join("\n");
  }
  const flat = join(p, "aidlc-docs", "audit.md");
  return existsSync(flat) ? readFileSync(flat, "utf-8") : "";
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/**
 * `AIDLC_WORKFLOW_INTENT=chaos bun aidlc-utility.ts init --scope bugfix
 * --project-dir <p>` (t47:43-44 / 86-87 / 131-132). Mirrors the
 * .sh's init verbatim.
 */
function init(p: string): CliResult {
  const res = spawnSync(
    BUN,
    [UTIL, "intent-birth", "--scope", "bugfix", "--project-dir", p],
    {
      encoding: "utf-8",
      env: { ...process.env, AIDLC_WORKFLOW_INTENT: "chaos" },
    },
  );
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** Spawn `bun aidlc-state.ts <args...> --project-dir <p>`. Mirrors `bun "$STATE" ...`. */
function state(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [STATE, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * Count audit blocks with `**Event**: ERROR_LOGGED` in audit CONTENT
 * (shard-concat or flat). Mirrors the .sh's
 * `grep -cE '^\*\*Event\*\*: ERROR_LOGGED'` (t47:138,154).
 */
function errorLoggedCount(content: string): number {
  return content
    .split("\n")
    .filter((l) => /^\*\*Event\*\*: ERROR_LOGGED$/.test(l)).length;
}

/** Whole-content presence (unanchored substring, mirrors a bare grep). */
function contentContains(content: string, needle: string): boolean {
  return content.includes(needle);
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>
 * in audit CONTENT. Resets at `## ` headings and `---` separators. Used by
 * F4's STRONGER Tool-field check. Returns "" when absent.
 */
function auditField(content: string, ev: string, key: string): string {
  let matched = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("## ") || line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0 && stripped.slice(0, pos) === key) {
        return stripped.slice(pos + 4);
      }
    }
  }
  return "";
}

// ============================================================
// Failure 1: permission-denied on audit.md during acknowledge-compaction.
// Audit-first: appendAuditEntry throws before any state write, so the tool
// exits 1 and aidlc-state.md is byte-unchanged. (.sh asserts 1-2)
// ============================================================

describe("t47 F1 — read-only audit shard during acknowledge-compaction (audit-first holds)", () => {
  runIfChmod(
    "F1: acknowledge-compaction exits 1 when the audit shard is read-only + aidlc-state.md byte-unchanged",
    () => {
      const p = proj();
      expect(init(p).status, "init scaffolding should succeed").toBe(0);

      // P4: the audit is the per-clone shard <record>/audit/<host>-<clone>.md;
      // the spawned subprocess resolves the SAME shard (the name embeds the
      // stable per-clone token, not the PID — aidlc-lib.ts:955-971), so chmod-ing
      // that one shard read-only denies its append. (The .sh chmod-ed the flat
      // aidlc-docs/audit.md; here the equivalent is the born record's shard.)
      const shard = auditShardPath(p);
      expect(shard).not.toBe(""); // birth wrote a shard
      const state2 = statePath(p);

      // Inject a SESSION_COMPACTED event so acknowledge-compaction has
      // something to act on (mirrors the .sh's cat >> heredoc, lines 50-57).
      writeFileSync(
        shard,
        `${readFileSync(shard, "utf-8")}
## Session Compacted
**Timestamp**: 2026-05-03T00:00:00Z
**Event**: SESSION_COMPACTED

---
`,
        "utf-8",
      );

      const stateBefore = readFileSync(state2, "utf-8");

      chmodSync(shard, 0o444);
      let r: CliResult;
      try {
        r = state(["acknowledge-compaction", "--choice", "continue"], p);
      } finally {
        chmodSync(shard, 0o644);
      }

      // .sh assert 1: assert_eq 1 $rc.
      expect(r.status).toBe(1);
      // .sh assert 2: state file byte-unchanged after the audit-write failure.
      // STRONGER: exact byte equality of the whole file, and a non-empty
      // baseline (init wrote it), so "unchanged" isn't trivially true.
      expect(stateBefore.length).toBeGreaterThan(0);
      expect(readFileSync(state2, "utf-8")).toBe(stateBefore);
    },
    30000,
  );
});

// ============================================================
// Failure 2: missing audit.md before gate-start — ensureAuditFile recovers,
// gate-start exits 0 and the audit file reappears. (.sh asserts 3-4) — no
// chmod, always runs.
// ============================================================

describe("t47 F2 — missing audit.md before gate-start (ensureAuditFile recovers)", () => {
  test(
    "F2: gate-start exits 0 when the audit was missing + audit shard recreated on demand",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      // P4: the audit is the per-clone shard dir <record>/audit/; removing the
      // whole dir is the equivalent of the .sh's `rm "$PROJ/aidlc-docs/audit.md"`
      // (line 89). ensureAuditFile re-mkdirs the dir and writes a fresh shard.
      rmSync(auditDirOf(p), { recursive: true, force: true });
      expect(existsSync(auditDirOf(p))).toBe(false); // precondition

      const r = state(["gate-start", "requirements-analysis"], p);

      // .sh assert 3: assert_eq 0 $rc — ensureAuditFile recovers, no crash.
      expect(r.status).toBe(0);
      // .sh assert 4: audit recreated on demand.
      expect(existsSync(auditDirOf(p))).toBe(true);
      expect(auditShardPath(p)).not.toBe(""); // a shard reappeared
      // STRONGER than the .sh's bare `[ -f ... ]`: the recreated shard carries
      // the STAGE_AWAITING_APPROVAL row gate-start emits, proving it was
      // rebuilt-and-written, not merely touched.
      expect(
        contentContains(readAudit(p), "**Event**: STAGE_AWAITING_APPROVAL"),
      ).toBe(true);
    },
    30000,
  );
});

// ============================================================
// Failure 3: corrupted state (no Scope) before advance — advance refuses,
// naming the missing field. (.sh asserts 5-6) — no chmod, always runs.
// ============================================================

describe("t47 F3 — corrupted state.md before advance (refuses, names Scope)", () => {
  test("F3: advance exits 1 on corrupted state + error message names the missing Scope field", () => {
    const p = proj();
    // P9: the advance tool resolves the ACTIVE INTENT's record (the cursor
    // createTestProject seeds), so the corrupted state must live in that record
    // (seededStateFile) — a flat aidlc-docs/ seed would not be the file the tool
    // reads. State file that's valid markdown but missing Scope / Current Stage
    // (mirrors the .sh heredoc, lines 109-114).
    const corruptState = seededStateFile(p);
    mkdirSync(join(corruptState, ".."), { recursive: true });
    writeFileSync(
      corruptState,
      `# AI-DLC State Tracking

## Project Information
- **Project**: corrupted test
`,
      "utf-8",
    );
    // Copy the SAME fixture the .sh used (read-only source copy; nothing is
    // written under tests/fixtures) into the record's audit shard — the trail
    // the resolved record reads, mirroring t47:115.
    const shard = seededAuditShard(p);
    mkdirSync(join(shard, ".."), { recursive: true });
    writeFileSync(
      shard,
      readFileSync(join(FIXTURES_DIR, "audit-sample.md"), "utf-8"),
      "utf-8",
    );

    const r = state(["advance", "requirements-analysis"], p);

    // .sh assert 5: assert_eq 1 $rc.
    expect(r.status).toBe(1);
    // .sh assert 6: `echo "$out" | grep -q "Scope"` (out captured 2>&1).
    expect(r.out).toContain("Scope");
    // STRONGER: pin the exact refusal sentence (aidlc-state.ts:332-336).
    expect(r.out).toContain("no Scope field");
  });
});

// ============================================================
// Failure 4: read-only state.md before gate-start — the audit emit succeeds
// (audit.md writable) but writeStateFile can't write, so emitError lands an
// ERROR_LOGGED row and the tool exits 1. (.sh asserts 7-8)
// ============================================================

describe("t47 F4 — read-only state.md before gate-start (ERROR_LOGGED emitted)", () => {
  runIfChmod(
    "F4: gate-start exits 1 when state.md is read-only + ERROR_LOGGED emitted on state-write failure",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      // P4: state.md is the per-intent record file (statePath); the audit is the
      // per-clone shard (read via readAudit).
      const state2 = statePath(p);

      // Count pre-existing ERROR_LOGGED rows (0 on a clean init), mirroring
      // t47:138's error_before.
      const errorBefore = errorLoggedCount(readAudit(p));

      chmodSync(state2, 0o444);
      let r: CliResult;
      try {
        r = state(["gate-start", "requirements-analysis"], p);
      } finally {
        chmodSync(state2, 0o644);
      }

      // .sh assert 7: assert_eq 1 $rc.
      expect(r.status).toBe(1);

      // .sh assert 8: ERROR_LOGGED count climbed (emitError fired on the
      // state-write failure path; state.md existed so the guard at
      // aidlc-lib.ts:1604 let the row through).
      const errorAfter = errorLoggedCount(readAudit(p));
      expect(errorAfter).toBeGreaterThan(errorBefore);
      // STRONGER than the .sh's bare count delta: the new ERROR_LOGGED row came
      // from the state tool's emitError (Tool: "aidlc-state",
      // aidlc-lib.ts:1619-1623 / aidlc-state.ts:1751-1756).
      expect(auditField(readAudit(p), "ERROR_LOGGED", "Tool")).toBe("aidlc-state");
    },
    30000,
  );
});
