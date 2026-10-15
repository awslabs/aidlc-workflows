// covers: audit:ERROR_LOGGED
//
// CLI-contract port of tests/integration/t123-failure-injection.sh (renumbered to t137 for milestone 2; TAP plan 8),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-state.ts <sub> ...` / `bun aidlc-utility.ts init`
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status (== $rc) and on the
// audit shards / aidlc-state.md the tools write - the PROCESS boundary, including
// the process.exit(1) that the .sh's `$?` arm relies on (emitError ->
// process.exit(1), aidlc-lib.ts). An in-process twin would lose the
// exit-code half every failure case hinges on.
//
// THE COVERED UNIT — audit:ERROR_LOGGED. This file exercises the
// failure-injection paths whose observable is the ERROR_LOGGED audit row
// emitted by emitError (aidlc-lib.ts). emitError fires its
// ERROR_LOGGED append ONLY when the selected intent's state file exists
// (aidlc-lib.ts) - Failure 4 (read-only state.md, file present) is the
// case that lands a fresh ERROR_LOGGED row, and Test 8 asserts the count
// climbs. The row format is `**Event**: ERROR_LOGGED` (aidlc-audit.ts,
// heading "Error Logged"), Tool/Command/Error fields
// (aidlc-lib.ts).
//
// CHAOS CONTRACT under test (the .sh's four failure injections):
//   F1. Permission-denied on the audit shard during a transition - audit-first
//       means appendAuditEntry throws BEFORE writeStateFile, so the tool exits 1
//       and aidlc-state.md is byte-identical to its pre-injection snapshot.
//   F2. Missing audit shard dir - appendAuditEntry -> appendAuditEntryUnlocked ->
//       ensureAuditFile (aidlc-audit.ts) recreates it; gate-start exits 0.
//   F3. Corrupted state (no Scope) — handleAdvance refuses with an error that
//       names the missing "Scope" field (aidlc-state.ts); exits 1.
//   F4. Read-only state.md — the audit emit succeeds (ERROR_LOGGED lands) but
//       writeStateFile can't write, so the tool exits 1 AND a fresh
//       ERROR_LOGGED row is appended (the covered observable).
//
// PLATFORM SKIP: the two chmod-injection cases (F1, F4) rely on chmod 0444
// actually denying writes. On native Windows chmod is a near-no-op. We gate
// F1/F4 behind a runIfChmod guard so the file stays green on Windows CI while
// preserving full coverage on macOS/Linux. F2 and F3 carry no chmod and always
// run.
//
// FIXTURE DISCIPLINE: each case uses a FRESH temp project dir (createTestProject,
// which toPortablePath-converts on Windows so audit shards / aidlc-state.md -
// written by the tools via forward-slash path helpers - round-trip when read
// back). F3 copies tests/fixtures/audit-sample.md (read-only source copy;
// nothing is WRITTEN under tests/fixtures). All temp dirs are cleaned in
// afterAll, and every chmod is restored to 0644 in a finally so a failed
// assertion can't leave an unremovable read-only dir behind.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const UTIL = join(TOOLS, "aidlc-utility.ts");
const STATE = join(TOOLS, "aidlc-state.ts");
const LOG = join(TOOLS, "aidlc-log.ts");

// On native Windows, chmod 0444 doesn't actually deny writes, so the two
// permission-injection cases cannot be exercised faithfully. Gate them.
const CHMOD_WORKS = process.platform !== "win32";
const runIfChmod = CHMOD_WORKS ? test : test.skip;

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    // Defensive: restore writability before removal in case a case bailed
    // out after chmod-ing but before its finally ran. Cover both the per-intent
    // record locations and the flat fallback.
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

function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

// intent-create writes state into the created intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<YYMMDD>-<short-label>/) and audit into
// per-clone SHARDS under <record>/audit/<host>-<clone>.md. After creation the
// active-intent cursor points at the created record, so the later state-tool
// calls (gate-start/advance/acknowledge-compaction) read/write THAT record.
// recordDirOf follows the cursor and falls back to flat when no record state
// resolves.
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

/** The single audit shard for a newly created record. Returns "" when none. */
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
  out: string; // combined stdout+stderr
}

function init(p: string): CliResult {
  const res = spawnSync(
    BUN,
    [UTIL, "intent-create", "--scope", "bugfix", "--project-dir", p],
    { encoding: "utf-8", env: { ...process.env, AIDLC_WORKFLOW_INTENT: "chaos" } },
  );
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function state(
  args: string[],
  p: string,
  extraEnv: Record<string, string> = {},
): CliResult {
  const res = spawnSync(BUN, [STATE, ...args, "--project-dir", p], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      ...extraEnv,
    },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function recordRequirementsReview(p: string): void {
  const artifact = join(
    recordDirOf(p),
    "inception",
    "requirements-analysis",
    "requirements.md",
  );
  mkdirSync(dirname(artifact), { recursive: true });
  const current = existsSync(artifact)
    ? readFileSync(artifact, "utf-8")
    : "# Requirements\n";
  writeFileSync(
    artifact,
    `${current
      .replace(
        /(?:^|\r?\n)## Review[ \t]*(?:\r?\n|$)[\s\S]*$/,
        "",
      )
      .trimEnd()}\n`,
  );
  const args = [
    LOG,
    "review",
    "--stage",
    "requirements-analysis",
    "--reviewer",
    "aidlc-product-lead-agent",
    "--iteration",
    "1",
    "--project-dir",
    p,
  ];
  const requested = spawnSync(BUN, args, { encoding: "utf-8" });
  if ((requested.status ?? -1) !== 0) {
    throw new Error(`review request failed: ${requested.stdout}${requested.stderr}`);
  }
  appendFileSync(
    artifact,
    [
      "",
      "## Review",
      "",
      "**Verdict:** READY",
      "**Reviewer:** aidlc-product-lead-agent",
      "**Date:** 2026-08-26T00:00:00Z",
      "**Iteration:** 1",
      "",
    ].join("\n"),
  );
  const completed = spawnSync(BUN, [...args, "--verdict", "READY"], {
    encoding: "utf-8",
  });
  if ((completed.status ?? -1) !== 0) {
    throw new Error(`review verdict failed: ${completed.stdout}${completed.stderr}`);
  }
}

function errorLoggedCount(content: string): number {
  return content
    .split("\n")
    .filter((l) => /^\*\*Event\*\*: ERROR_LOGGED$/.test(l)).length;
}

function contentContains(content: string, needle: string): boolean {
  return content.includes(needle);
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>
 * in audit CONTENT. Resets at `## ` headings and `---` separators. Used by
 * Test 8's Tool-field check. Returns "" when absent.
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
// exits 1 and aidlc-state.md is unchanged.
// The audit is the per-clone shard <record>/audit/<host>-<clone>.md; the
// spawned subprocess resolves the SAME shard (the shard name embeds the stable
// per-clone token, not the PID - aidlc-lib.ts auditShardName), so chmod-ing
// that one shard read-only denies its append.
// ============================================================

describe("t137 F1 — read-only audit shard (audit-first holds)", () => {
  runIfChmod(
    "1: acknowledge-compaction exits 1 when the audit shard is read-only; 2: state unchanged",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      const shard = auditShardPath(p);
      expect(shard).not.toBe("");
      const state2 = statePath(p);

      // Inject a SESSION_COMPACTED event so acknowledge-compaction has
      // something to act on.
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

      expect(r.status).toBe(1);
      expect(readFileSync(state2, "utf-8")).toBe(stateBefore);
    },
    NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  );
});

// ============================================================
// Failure 2: missing audit - gate-start exits 0 and the audit shard is
// recreated. No chmod, always runs.
// The audit is a per-clone shard dir <record>/audit/; the next append re-mkdirs
// the dir and writes a fresh shard.
// ============================================================

describe("t137 F2 — missing audit shard (ensureAuditFile recovers)", () => {
  test(
    "3: gate-start exits 0 when the audit was missing; 4: audit shard recreated",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      rmSync(auditDirOf(p), { recursive: true, force: true });
      expect(existsSync(auditDirOf(p))).toBe(false);

      const r = state(
        ["gate-start", "requirements-analysis"],
        p,
        { AIDLC_SKIP_REVIEWER_GATE_GUARD: "1" },
      );

      expect(r.status).toBe(0);
      expect(existsSync(auditDirOf(p))).toBe(true);
      expect(auditShardPath(p)).not.toBe("");
      // The recreated shard carries the STAGE_AWAITING_APPROVAL row gate-start
      // emits, proving it was rebuilt-and-written, not merely touched.
      expect(contentContains(readAudit(p), "**Event**: STAGE_AWAITING_APPROVAL")).toBe(
        true,
      );
    },
    NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  );
});

// ============================================================
// Failure 3: corrupted state (no Scope) — advance refuses, naming the field.
// No chmod, always runs.
// ============================================================

describe("t137 F3 — corrupted state.md (advance refuses, names Scope)", () => {
  test("5: advance exits 1 on corrupted state; 6: error names Scope", () => {
    const p = proj();
    // createTestProject seeds the per-intent shell + default-record cursor, so the
    // advance SUBPROCESS resolves the seeded record (DEFAULT_RECORD_DIR). Hand-seed
    // the corrupted state INTO that record (seededStateFile) - valid markdown but
    // missing Scope / Current Stage - and the audit into the shard the subprocess
    // resolves (seededAuditShard).
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
    // Copy the fixture (read-only source copy) into the per-clone shard the
    // corrupted-state record resolves.
    const shard = seededAuditShard(p);
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(
      shard,
      readFileSync(join(FIXTURES_DIR, "audit-sample.md"), "utf-8"),
      "utf-8",
    );

    const r = state(["advance", "requirements-analysis"], p);

    expect(r.status).toBe(1);
    expect(r.out).toContain("Scope");
    expect(r.out).toContain("no Scope field");
  });
});

// ============================================================
// Failure 4: read-only state.md — emitError lands an ERROR_LOGGED row (the
// covered observable) even though writeStateFile can't write; tool exits 1.
// ============================================================

describe("t137 F4 — read-only state.md (ERROR_LOGGED emitted)", () => {
  runIfChmod(
    "7: gate-start exits 1 when state.md is read-only; 8: ERROR_LOGGED emitted",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      // state.md is the per-intent record file (statePath); the audit is the
      // per-clone shard (read via readAudit).
      const state2 = statePath(p);

      const errorBefore = errorLoggedCount(readAudit(p));
      recordRequirementsReview(p);

      chmodSync(state2, 0o444);
      let r: CliResult;
      try {
        r = state(["gate-start", "requirements-analysis"], p);
      } finally {
        chmodSync(state2, 0o644);
      }

      expect(r.status).toBe(1);

      // ERROR_LOGGED count climbed (emitError fired on the state-write failure path;
      // state.md existed so the guard in aidlc-lib.ts emitError let the row through).
      const errorAfter = errorLoggedCount(readAudit(p));
      expect(errorAfter).toBeGreaterThan(errorBefore);
      // The new ERROR_LOGGED row came from the state tool's emitError (Tool:
      // "aidlc-state", aidlc-lib.ts emitError).
      expect(auditField(readAudit(p), "ERROR_LOGGED", "Tool")).toBe("aidlc-state");
    },
    NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  );
});
