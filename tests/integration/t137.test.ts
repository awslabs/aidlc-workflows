// covers: audit:ERROR_LOGGED
//
// CLI-contract port of tests/integration/t123-failure-injection.sh (renumbered to t137 for milestone 2; TAP plan 8),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-state.ts <sub> ...` / `bun aidlc-utility.ts init`
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status (== $rc) and on the
// audit.md / aidlc-state.md the tools write — the PROCESS boundary, including
// the process.exit(1) that the .sh's `$?` arm relies on (emitError ->
// process.exit(1), aidlc-lib.ts:1546). An in-process twin would lose the
// exit-code half every failure case hinges on.
//
// THE COVERED UNIT — audit:ERROR_LOGGED. This file exercises the
// failure-injection paths whose observable is the ERROR_LOGGED audit row
// emitted by emitError (aidlc-lib.ts:1504-1547). emitError fires its
// ERROR_LOGGED append ONLY when stateFilePath(projectDir) exists
// (aidlc-lib.ts:1513) — Failure 4 (read-only state.md, file present) is the
// case that lands a fresh ERROR_LOGGED row, and Test 8 asserts the count
// climbs. The row format is `**Event**: ERROR_LOGGED` (aidlc-audit.ts:258,
// heading "Error Logged" aidlc-audit.ts:149), Tool/Command/Error fields
// (aidlc-lib.ts:1528-1538).
//
// CHAOS CONTRACT under test (the .sh's four failure injections):
//   F1. Permission-denied on audit.md during a transition — audit-first means
//       appendAuditEntry throws BEFORE writeStateFile, so the tool exits 1 and
//       aidlc-state.md is byte-identical to its pre-injection snapshot.
//   F2. Missing audit.md — appendAuditEntry -> appendAuditEntryUnlocked ->
//       ensureAuditFile (aidlc-audit.ts:254) recreates it; gate-start exits 0.
//   F3. Corrupted state (no Scope) — handleAdvance refuses with an error that
//       names the missing "Scope" field (aidlc-state.ts:290-293); exits 1.
//   F4. Read-only state.md — the audit emit succeeds (ERROR_LOGGED lands) but
//       writeStateFile can't write, so the tool exits 1 AND a fresh
//       ERROR_LOGGED row is appended (the covered observable).
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several are
// STRONGER than the original):
//   - .sh 1  assert_eq 1 $rc (acknowledge, audit.md 0444)         -> Test 1:
//       res.status === 1 (same observable).
//   - .sh 2  state file unchanged after audit-write failure       -> Test 2:
//       readFileSync(state) === snapshot (same observable — exact byte
//       equality of the whole state file, as the .sh's string compare did).
//   - .sh 3  assert_eq 0 $rc (gate-start, audit.md missing)       -> Test 3:
//       res.status === 0 (same observable).
//   - .sh 4  audit.md recreated on demand                         -> Test 4:
//       existsSync(audit) === true (same observable). STRONGER: also assert
//       the recreated file carries the STAGE_AWAITING_APPROVAL row gate-start
//       emits, proving it was rebuilt-and-written, not merely touched.
//   - .sh 5  assert_eq 1 $rc (advance, corrupted state)           -> Test 5:
//       res.status === 1 (same observable).
//   - .sh 6  error message mentions the missing Scope field       -> Test 6:
//       combined stdout+stderr contains "Scope" (same observable as the .sh's
//       `echo "$out" | grep -q "Scope"`, out = 2>&1). STRONGER: pin the exact
//       refusal sentence "no Scope field".
//   - .sh 7  assert_eq 1 $rc (gate-start, state.md 0444)          -> Test 7:
//       res.status === 1 (same observable).
//   - .sh 8  ERROR_LOGGED emitted on state-write failure          -> Test 8:
//       errorLoggedCount(after) > errorLoggedCount(before) (same observable
//       as the .sh's grep-count delta). STRONGER: also assert the new row's
//       Tool field is "aidlc-state", proving the row came from the state
//       tool's emitError path and not some pre-seeded event.
//
// 8 .sh asserts -> 8 expect()-bearing test() cases here, one observable each.
//
// PLATFORM SKIP (mirrors the .sh's root-skip at lines 30-33): the three
// chmod-injection cases (F1, F4) rely on chmod 0444 actually denying writes.
// On native Windows chmod is a near-no-op (and the suite never runs the .sh
// there either — it's bash). We gate F1/F4 behind a runIfChmod guard so the
// file stays green on Windows CI while preserving full coverage on
// macOS/Linux. F2 and F3 carry no chmod and always run. (The .sh's root skip
// is unreachable here: tests don't run as uid 0.)
//
// FIXTURE DISCIPLINE (mirrors create_test_project + cleanup_test_project per
// case): each case uses a FRESH temp project dir (createTestProject, which
// toPortablePath-converts on Windows so audit.md / aidlc-state.md — written
// by the tools via forward-slash path helpers — round-trip when read back).
// F3 copies the SAME tests/fixtures/audit-sample.md the .sh used (read-only
// source copy; nothing is WRITTEN under tests/fixtures). All temp dirs are
// cleaned in afterAll, and every chmod is restored to 0644 in a finally so a
// failed assertion can't leave an unremovable read-only dir behind.

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
import { dirname, join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seededAuditShard,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const UTIL = join(TOOLS, "aidlc-utility.ts");
const STATE = join(TOOLS, "aidlc-state.ts");

// On native Windows, chmod 0444 doesn't actually deny writes, so the three
// permission-injection cases cannot be exercised faithfully. Gate them.
const CHMOD_WORKS = process.platform !== "win32";
const runIfChmod = CHMOD_WORKS ? test : test.skip;

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    // Defensive: restore writability before removal in case a case bailed
    // out after chmod-ing but before its finally ran. Cover both the per-intent
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
// under <record>/audit/<host>-<pid>.md — not the flat aidlc-docs/ trio. After
// init the active-intent cursor points at the born record, so the later
// state-tool calls (gate-start/advance/acknowledge-compaction) read/write THAT
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
 * --project-dir <p>` (t123:43-44). Mirrors the .sh's init.
 */
function init(p: string): CliResult {
  const res = spawnSync(
    BUN,
    [UTIL, "intent-birth", "--scope", "bugfix", "--project-dir", p],
    { encoding: "utf-8", env: { ...process.env, AIDLC_WORKFLOW_INTENT: "chaos" } },
  );
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Spawn `bun aidlc-state.ts <args...> --project-dir <p>`. Mirrors `bun "$STATE" ...`. */
function state(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [STATE, ...args, "--project-dir", p], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * Count audit blocks with `**Event**: ERROR_LOGGED` in audit CONTENT
 * (shard-concat or flat). Mirrors the .sh's
 * `grep -cE '^\*\*Event\*\*: ERROR_LOGGED'`.
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
 * Test 8's STRONGER Tool-field check. Returns "" when absent.
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
// Failure 1: permission-denied on the audit shard during a transition.
// Audit-first: appendAuditEntry throws before writeStateFile, so the tool
// exits 1 and aidlc-state.md is unchanged. (.sh Tests 1-2)
// P4: the audit is the per-clone shard <record>/audit/<host>-<clone>.md; the
// spawned subprocess resolves the SAME shard (the shard name embeds the stable
// per-clone token, not the PID — aidlc-lib.ts:955-971), so chmod-ing that one
// shard read-only denies its append. The original test chmod-ed the flat
// aidlc-docs/audit.md; here the equivalent target is the born record's shard.
// ============================================================

describe("t137 F1 — read-only audit shard (audit-first holds)", () => {
  runIfChmod(
    "1: acknowledge-compaction exits 1 when the audit shard is read-only; 2: state unchanged",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0); // sanity: scaffolding succeeded

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
        r = state(
          ["acknowledge-compaction", "--choice", "continue"],
          p,
        );
      } finally {
        chmodSync(shard, 0o644);
      }

      // .sh Test 1: assert_eq 1 $rc.
      expect(r.status).toBe(1);
      // .sh Test 2: state file byte-unchanged after the audit-write failure.
      expect(readFileSync(state2, "utf-8")).toBe(stateBefore);
    },
    30000,
  );
});

// ============================================================
// Failure 2: missing audit — ensureAuditFile recovers, gate-start exits 0
// and the audit shard is recreated. (.sh Tests 3-4) — no chmod, always runs.
// P4: the audit is now a per-clone shard dir <record>/audit/; removing the
// whole dir is the equivalent of the original `rm audit.md`. ensureAuditFile
// re-mkdirs the dir and writes a fresh shard on the next append.
// ============================================================

describe("t137 F2 — missing audit shard (ensureAuditFile recovers)", () => {
  test(
    "3: gate-start exits 0 when the audit was missing; 4: audit shard recreated",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      // Remove the entire audit shard dir (mirrors the .sh's `rm "$audit"`,
      // line 89 — the per-clone analog of deleting the flat audit.md).
      rmSync(auditDirOf(p), { recursive: true, force: true });
      expect(existsSync(auditDirOf(p))).toBe(false); // precondition

      const r = state(["gate-start", "requirements-analysis"], p);

      // .sh Test 3: assert_eq 0 $rc — ensureAuditFile recovers, no crash.
      expect(r.status).toBe(0);
      // .sh Test 4: audit recreated on demand.
      expect(existsSync(auditDirOf(p))).toBe(true);
      expect(auditShardPath(p)).not.toBe(""); // a shard reappeared
      // STRONGER than the .sh's bare `[ -f ... ]`: the recreated shard carries
      // the STAGE_AWAITING_APPROVAL row gate-start emits, proving it was
      // rebuilt-and-written, not merely touched.
      expect(contentContains(readAudit(p), "**Event**: STAGE_AWAITING_APPROVAL")).toBe(
        true,
      );
    },
    30000,
  );
});

// ============================================================
// Failure 3: corrupted state (no Scope) — advance refuses, naming the field.
// (.sh Tests 5-6) — no chmod, always runs.
// ============================================================

describe("t137 F3 — corrupted state.md (advance refuses, names Scope)", () => {
  test("5: advance exits 1 on corrupted state; 6: error names Scope", () => {
    const p = proj();
    // P9: the flat aidlc-docs/ fallback is retired. createTestProject seeds the
    // per-intent shell + default-record cursor, so the advance SUBPROCESS
    // resolves the seeded record (DEFAULT_RECORD_DIR). Hand-seed the
    // corrupted state INTO that record (seededStateFile) — valid markdown but
    // missing Scope / Current Stage (mirrors the .sh heredoc, lines 109-114) —
    // and the audit into the shard the subprocess resolves (seededAuditShard).
    const stateFile = seededStateFile(p);
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      `# AI-DLC State Tracking

## Project Information
- **Project**: corrupted test
`,
      "utf-8",
    );
    // Copy the SAME fixture the .sh used (read-only source copy) into the
    // per-clone shard the corrupted-state record resolves.
    const shard = seededAuditShard(p);
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(
      shard,
      readFileSync(join(FIXTURES_DIR, "audit-sample.md"), "utf-8"),
      "utf-8",
    );

    const r = state(["advance", "requirements-analysis"], p);

    // .sh Test 5: assert_eq 1 $rc.
    expect(r.status).toBe(1);
    // .sh Test 6: `echo "$out" | grep -q "Scope"` (out captured 2>&1).
    expect(r.out).toContain("Scope");
    // STRONGER: pin the exact refusal sentence (aidlc-state.ts:290-293).
    expect(r.out).toContain("no Scope field");
  });
});

// ============================================================
// Failure 4: read-only state.md — emitError lands an ERROR_LOGGED row (the
// covered observable) even though writeStateFile can't write; tool exits 1.
// (.sh Tests 7-8)
// ============================================================

describe("t137 F4 — read-only state.md (ERROR_LOGGED emitted)", () => {
  runIfChmod(
    "7: gate-start exits 1 when state.md is read-only; 8: ERROR_LOGGED emitted",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      // P4: state.md is the per-intent record file (statePath); the audit is the
      // per-clone shard (read via readAudit).
      const state2 = statePath(p);

      // Count pre-existing ERROR_LOGGED rows (0 on a clean init).
      const errorBefore = errorLoggedCount(readAudit(p));

      chmodSync(state2, 0o444);
      let r: CliResult;
      try {
        r = state(["gate-start", "requirements-analysis"], p);
      } finally {
        chmodSync(state2, 0o644);
      }

      // .sh Test 7: assert_eq 1 $rc.
      expect(r.status).toBe(1);

      // .sh Test 8: ERROR_LOGGED count climbed (emitError fired on the
      // state-write failure path; state.md existed so the guard at
      // aidlc-lib.ts:1513 let the row through).
      const errorAfter = errorLoggedCount(readAudit(p));
      expect(errorAfter).toBeGreaterThan(errorBefore);
      // STRONGER than the .sh's bare count delta: the new ERROR_LOGGED row
      // came from the state tool's emitError (Tool: "aidlc-state",
      // aidlc-lib.ts:1528-1538 / aidlc-state.ts:1713).
      expect(auditField(readAudit(p), "ERROR_LOGGED", "Tool")).toBe("aidlc-state");
    },
    30000,
  );
});
