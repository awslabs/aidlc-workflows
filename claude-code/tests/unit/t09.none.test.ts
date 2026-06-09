// covers: hook:aidlc-log-subagent
//
// Port of tests/unit/t09-hook-log-subagent.sh (TAP plan 8), mechanism = none.
// The unit under test is a HOOK — aidlc-log-subagent.ts, the SubagentStop hook
// that emits SUBAGENT_COMPLETED. Hooks are mechanism=none: they receive a
// Claude Code JSON payload on stdin and resolve the project dir from the
// CLAUDE_PROJECT_DIR env var (aidlc-lib.ts:114-116). There is no exported pure
// function to import — the hook's contract is "JSON on stdin + env -> audit row
// + heartbeat file + clean exit". So every .sh assertion is preserved by
// SPAWNING the hook via node:child_process spawnSync with controlled stdin and
// CLAUDE_PROJECT_DIR, exactly as the .sh piped `echo '<json>' | CLAUDE_PROJECT_DIR=<p>
// bun "$HOOK"`. We assert on res.status (the .sh's $? in tests 3 + 5) and on the
// audit.md / heartbeat the hook writes (the .sh's assert_grep / assert_file_exists).
//
// AUDIT-ROW SHAPE (aidlc-log-subagent.ts:40-58 + aidlc-audit.ts:256-267): the
// hook calls appendAuditEntry("SUBAGENT_COMPLETED", fields, projectDir) where
// fields = { "Agent Type": agentType, ["Agent ID"]: agentId?, Message: msg? }.
// appendAuditEntryUnlocked renders each as `**<key>**: <value>` under a
// `## Subagent Completed` heading with `**Event**: SUBAGENT_COMPLETED`. Message
// is sliced to the first 200 chars (hook line 42) — the truncation the .sh's
// test 6 asserts. agentType defaults to "unknown", agentId defaults to ""
// (omitted when falsy, hook line 50).
//
// SEED BASELINE (load-bearing for parity strength). The .sh seeds audit-sample.md
// (fixtures.sh seed_audit_file) which ALREADY CONTAINS one SUBAGENT_COMPLETED
// block whose Agent Type is `aidlc-developer-agent` (audit-sample.md:19-26). So
// the .sh's bare `assert_grep "SUBAGENT_COMPLETED"` / `assert_grep "developer"` /
// `assert_grep "architect"` would PASS off the seed alone for some of them. To be
// EQUAL-OR-STRONGER, the event-presence cases here COUNT SUBAGENT_COMPLETED blocks
// against the seeded baseline (baseline = 1; post-fire = 2) and assert the NEW
// block's exact field values block-scoped — not a file-wide substring grep that a
// stale seed row could satisfy.
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several STRONGER):
//   - .sh Test 1  assert_grep audit.md "SUBAGENT_COMPLETED"            -> Test 1:
//       block count goes seed(1) -> 2 (STRONGER: counts the appended row against
//       the seeded baseline, not a bare presence grep the seed already satisfies)
//       + the NEW block's Agent Type === "architect", Agent ID === "abc-123",
//       Message === "Done" (STRONGER: exact field values, block-scoped).
//   - .sh Test 2  assert_grep audit.md "developer" (agent type present) -> Test 2:
//       new block's Agent Type === "developer" (STRONGER, exact + block-scoped)
//       AND no Agent ID / Message line in that block (the .sh comment "no Agent ID
//       line" asserted by absence — STRONGER than the original which only grepped
//       the type was present).
//   - .sh Test 3  no audit.md -> exits silently, audit.md NOT created  -> Test 3:
//       res.status === 0 (the hook's process.exit(0), STRONGER than the .sh which
//       only checked the file's absence) + audit.md still absent.
//   - .sh Test 4  assert_file_exists .aidlc-hooks-health/log-subagent.last -> Test 4:
//       heartbeat file exists (same observable) + STRONGER: its contents are an
//       ISO timestamp (the hook writes isoTimestamp(), aidlc-log-subagent.ts:24).
//   - .sh Test 5  empty stdin -> exit 0 ($RC == 0)                     -> Test 5:
//       res.status === 0 (same observable) + STRONGER: audit.md byte-unchanged
//       (empty stdin -> JSON.parse("") throws -> process.exit(0) BEFORE any
//       append, hook lines 30-38; the .sh captured BEFORE but never compared it).
//   - .sh Test 6a assert_grep audit.md "developer" (entry written)    -> Test 6a:
//       new block Agent Type === "developer" (STRONGER, exact + block-scoped).
//   - .sh Test 6b assert_not_grep audit.md "A\{500\}" (truncated)     -> Test 6b:
//       the appended Message is exactly 200 'A's (STRONGER: pins the exact 200-char
//       slice boundary, not merely "the 500-run is absent"); full 500-run absent too.
//   - .sh Test 8  assert_grep audit.md "**Event**: SUBAGENT_COMPLETED" -> Test 8:
//       new block's heading line is exactly `**Event**: SUBAGENT_COMPLETED`
//       (block-scoped via the canonical-event count delta, STRONGER).
//
// 8 .sh asserts -> 8 expect()-bearing test() cases here (test 6's two asserts
// kept as 6a + 6b to keep one observable per case, matching the .sh's two lines).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file +
// cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject -> toPortablePath on Windows so the audit.md the hook writes
// via toPosix(auditFilePath) round-trips when read back). seedAuditFile copies
// the same audit-sample.md the .sh seeded. All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOK = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "hooks",
  "aidlc-log-subagent.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh project; optionally seed audit-sample.md (matches the .sh's seed_audit_file). */
function proj(seed = true): string {
  const p = createTestProject();
  tempDirs.push(p);
  if (seed) seedAuditFile(p);
  return p;
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");
const heartbeatPath = (p: string): string =>
  join(p, "aidlc-docs", ".aidlc-hooks-health", "log-subagent.last");

interface HookResult {
  status: number;
}

/**
 * Spawn the hook with `payload` on stdin and CLAUDE_PROJECT_DIR=p. Mirrors the
 * .sh's `echo '<json>' | CLAUDE_PROJECT_DIR=<p> bun "$HOOK" 2>/dev/null`. The
 * hook resolves the project dir from CLAUDE_PROJECT_DIR first (aidlc-lib.ts:116),
 * so the absolute hook path never shadows it.
 */
function runHook(payload: string, p: string): HookResult {
  const res = spawnSync(BUN, [HOOK], {
    encoding: "utf-8",
    input: payload,
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  return { status: res.status ?? -1 };
}

/** Count `**Event**: SUBAGENT_COMPLETED` block headings. Mirrors the .sh grep, as a count. */
function subagentCompletedCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === "**Event**: SUBAGENT_COMPLETED").length;
}

/**
 * Field values from the LAST audit block whose `**Event**:` is SUBAGENT_COMPLETED.
 * The seed already has one such block (audit-sample.md:19-26); the hook appends a
 * NEW one at end-of-file, so "last" isolates the row the hook just wrote — the
 * block-scoped equivalent of the .sh's file-wide grep, but pinned to the new row.
 * Splits `**label**: value` on the literal `**: ` separator (mirrors auditField in
 * t31.cli.test.ts). Returns the field map for that block; missing keys are absent.
 */
function lastSubagentBlock(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  let current: Record<string, string> | null = null;
  let last: Record<string, string> = {};
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.startsWith("## ")) {
      current = null;
      continue;
    }
    if (line === "---") {
      current = null;
      continue;
    }
    if (line === "**Event**: SUBAGENT_COMPLETED") {
      current = { Event: "SUBAGENT_COMPLETED" };
      last = current;
      continue;
    }
    if (current && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        current[stripped.slice(0, pos)] = stripped.slice(pos + 4);
      }
    }
  }
  return last;
}

/** Whole-file presence (mirrors a bare grep with no anchor). */
function fileContains(file: string, needle: string): boolean {
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf-8").includes(needle);
}

describe("t09 aidlc-log-subagent hook (migrated from t09-hook-log-subagent.sh, plan 8)", () => {
  test("1: logs subagent completion as SUBAGENT_COMPLETED event", () => {
    const p = proj();
    const before = subagentCompletedCount(auditPath(p)); // seed baseline = 1
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    expect(r.status).toBe(0);
    // STRONGER: counts the appended row against the seeded baseline.
    expect(subagentCompletedCount(auditPath(p))).toBe(before + 1);
    // STRONGER: exact field values on the NEW (last) block.
    const blk = lastSubagentBlock(auditPath(p));
    expect(blk["Agent Type"]).toBe("architect");
    expect(blk["Agent ID"]).toBe("abc-123");
    expect(blk.Message).toBe("Done");
  });

  test("2: handles missing agent_id — agent type present, no Agent ID line", () => {
    const p = proj();
    runHook('{"agent_type":"developer"}', p);
    const blk = lastSubagentBlock(auditPath(p));
    // .sh grepped only that the type was present; here block-scoped exact value.
    expect(blk["Agent Type"]).toBe("developer");
    // STRONGER: the hook omits Agent ID (and Message) when falsy (hook lines 50-51),
    // so the NEW block carries neither. The .sh comment named "no Agent ID line".
    expect(blk["Agent ID"]).toBeUndefined();
    expect(blk.Message).toBeUndefined();
  });

  test("3: exits silently when no audit.md (status 0, audit.md not created)", () => {
    const p = proj(false);
    // No audit.md (proj created with aidlc-docs/ but never seeded).
    rmSync(auditPath(p), { force: true });
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    // STRONGER: the .sh only checked the file's absence; we also pin the clean exit.
    expect(r.status).toBe(0);
    expect(existsSync(auditPath(p))).toBe(false);
  });

  test("4: writes heartbeat (ISO timestamp)", () => {
    const p = proj();
    runHook('{"agent_type":"quality"}', p);
    expect(existsSync(heartbeatPath(p))).toBe(true);
    // STRONGER: the heartbeat carries an ISO timestamp (hook line 24).
    const ts = readFileSync(heartbeatPath(p), "utf-8").trim();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("5: handles empty stdin gracefully (exit 0, audit unchanged)", () => {
    const p = proj();
    const before = readFileSync(auditPath(p), "utf-8");
    const r = runHook("", p);
    expect(r.status).toBe(0);
    // STRONGER: empty stdin -> JSON.parse("") throws -> exit 0 before any append,
    // so the audit must be byte-identical (the .sh captured BEFORE but never diffed).
    expect(readFileSync(auditPath(p), "utf-8")).toBe(before);
  });

  test("6a: truncates long messages — entry written", () => {
    const p = proj();
    const longMsg = "A".repeat(500);
    runHook(
      `{"agent_type":"developer","agent_id":"xyz","last_assistant_message":"${longMsg}"}`,
      p,
    );
    const blk = lastSubagentBlock(auditPath(p));
    expect(blk["Agent Type"]).toBe("developer");
  });

  test("6b: long message was truncated to 200 chars", () => {
    const p = proj();
    const longMsg = "A".repeat(500);
    runHook(
      `{"agent_type":"developer","agent_id":"xyz","last_assistant_message":"${longMsg}"}`,
      p,
    );
    // STRONGER: pins the exact 200-char slice boundary (hook line 42), not merely
    // "the 500-run is absent". The Message field is exactly 200 'A's...
    const blk = lastSubagentBlock(auditPath(p));
    expect(blk.Message).toBe("A".repeat(200));
    // ...and the full 500-run never reaches the file (the .sh's assert_not_grep A{500}).
    expect(fileContains(auditPath(p), "A".repeat(500))).toBe(false);
  });

  test("8: emits canonical Event field", () => {
    const p = proj();
    const before = subagentCompletedCount(auditPath(p)); // seed baseline = 1
    runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"done"}',
      p,
    );
    // The .sh grepped `**Event**: SUBAGENT_COMPLETED`; here the canonical heading
    // line count goes baseline -> baseline+1 (block-scoped proof of the new row's
    // canonical Event field) and the new block's Event value is exactly that.
    expect(subagentCompletedCount(auditPath(p))).toBe(before + 1);
    expect(lastSubagentBlock(auditPath(p)).Event).toBe("SUBAGENT_COMPLETED");
  });
});
