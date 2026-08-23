// covers: hook:aidlc-log-subagent
//
// Port of tests/unit/t09-hook-log-subagent.sh (TAP plan 8), mechanism = none.
// The unit under test is a HOOK — aidlc-log-subagent.ts, the SubagentStop hook
// that emits SUBAGENT_COMPLETED. Hooks are mechanism=none: they receive a
// Claude Code JSON payload on stdin and resolve the project dir from the
// CLAUDE_PROJECT_DIR env var. There is no exported pure
// function to import — the hook's contract is "JSON on stdin + env -> audit row
// + heartbeat file + clean exit". So every .sh assertion is preserved by
// SPAWNING the hook via node:child_process spawnSync with controlled stdin and
// CLAUDE_PROJECT_DIR, exactly as the .sh piped `echo '<json>' | CLAUDE_PROJECT_DIR=<p>
// bun "$HOOK"`. We assert on res.status (the .sh's $? in tests 3 + 5) and on the
// audit.md / heartbeat the hook writes (the .sh's assert_grep / assert_file_exists).
//
// AUDIT-ROW SHAPE (aidlc-log-subagent.ts + aidlc-audit.ts): the
// hook calls appendAuditEntry("SUBAGENT_COMPLETED", fields, projectDir) where
// fields = { "Agent Type": agentType, ["Agent ID"]: agentId?, Message: msg? }.
// appendAuditEntryUnlocked renders each as `**<key>**: <value>` under a
// `## Subagent Completed` heading with `**Event**: SUBAGENT_COMPLETED`. Message
// is sliced to the first 200 chars — the truncation the .sh's
// test 6 asserts. agentType defaults to "unknown", agentId defaults to ""
// (omitted when falsy).
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
//   - .sh Test 3  no active workflow -> exits silently, audit.md NOT created ->
//       Tests 3a-3b: no state exits 0 without changing an existing shard or
//       creating a shard/heartbeat. Tests 3c-3e prove completed and malformed
//       state also fail closed. Test 3f proves that running state opens the gate:
//       appendAuditEntry creates a missing shard.
//   - .sh Test 4  assert_file_exists .aidlc-hooks-health/log-subagent.last -> Test 4:
//       heartbeat file exists (same observable) + STRONGER: its contents are an
//       ISO timestamp (the hook writes isoTimestamp()).
//   - .sh Test 5  empty stdin -> exit 0 ($RC == 0)                     -> Test 5:
//       res.status === 0 (same observable) + STRONGER: audit.md byte-unchanged
//       (empty stdin -> JSON.parse("") throws -> process.exit(0) BEFORE any
//       append; the .sh captured BEFORE but never compared it).
//   - .sh Test 6a assert_grep audit.md "developer" (entry written)    -> Test 6a:
//       new block Agent Type === "developer" (STRONGER, exact + block-scoped).
//   - .sh Test 6b assert_not_grep audit.md "A\{500\}" (truncated)     -> Test 6b:
//       the appended Message is exactly 200 'A's (STRONGER: pins the exact 200-char
//       slice boundary, not merely "the 500-run is absent"); full 500-run absent too.
//   - .sh Test 8  assert_grep audit.md "**Event**: SUBAGENT_COMPLETED" -> Test 8:
//       new block's heading line is exactly `**Event**: SUBAGENT_COMPLETED`
//       (block-scoped via the canonical-event count delta, STRONGER).
//
// 8 .sh asserts map to the parity cases below (test 6's two asserts remain 6a +
// 6b), with additional #710 gate-regression cases around original Test 3.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file +
// cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject -> toPortablePath on Windows so the audit.md the hook writes
// via toPosix(auditFilePath) round-trips when read back). seedAuditFile copies
// the same audit-sample.md the .sh seeded. All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seededAuditDir,
  seededRecordDir,
  seedStateFile,
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

// The shard the spawned hook resolves, computed from a clone-id pinned on disk
// (mirrors auditShardName()'s `<host>-<clone>.md` shape). The pinned shard sorts
// AFTER the baseline seed shard (named `0-seed.md`) so the glob-concatenated read
// keeps the hook's NEW block LAST — preserving the .sh's end-of-file semantics.
const PINNED_CLONE_ID = "testcloneid09";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}

/**
 * Fresh project seeded for the per-intent audit layout. State is optional so
 * the hook's workflow-state gate can be tested independently from audit-shard
 * presence. When `audit` is true, a baseline shard carries the audit-sample.md
 * SUBAGENT_COMPLETED block and the hook's pinned shard starts empty. The
 * clone-id token is pinned on disk for deterministic shard resolution.
 */
type StateFixture = "running" | "completed" | "malformed" | false;

function proj(
  {
    state = "running",
    audit = true,
  }: { state?: StateFixture; audit?: boolean } = {},
): string {
  const p = createTestProject();
  tempDirs.push(p);
  if (state === "running") {
    seedStateFile(p, join(FIXTURES_DIR, "state-mid-ideation.md"));
  } else if (state === "completed") {
    seedStateFile(p, join(FIXTURES_DIR, "state-completed.md"));
  } else if (state === "malformed") {
    seedStateFile(p, join(FIXTURES_DIR, "state-mid-ideation.md"));
    writeFileSync(join(seededRecordDir(p), "aidlc-state.md"), "# malformed\n", "utf-8");
  }
  writeFileSync(join(p, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  if (audit) {
    const auditDir = seededAuditDir(p);
    mkdirSync(auditDir, { recursive: true });
    // Baseline (sorts first): the audit-sample.md SUBAGENT_COMPLETED block.
    copyFileSync(join(FIXTURES_DIR, "audit-sample.md"), join(auditDir, "0-seed.md"));
    // The hook's own shard (sorts last): empty until the hook appends.
    writeFileSync(join(auditDir, pinnedShardName()), "", "utf-8");
  }
  return p;
}

const auditDirOf = (p: string): string => seededAuditDir(p);
const heartbeatPath = (p: string): string =>
  join(seededRecordDir(p), ".aidlc-hooks-health", "log-subagent.last");

/** Concatenate every shard (sorted) — the settled per-intent audit read. */
function readShards(p: string): string {
  const auditDir = auditDirOf(p);
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return "";
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => readFileSync(join(auditDir, n), "utf-8"))
    .join("\n");
}

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

/** Count `**Event**: SUBAGENT_COMPLETED` block headings in a buffer. */
function subagentCompletedCount(body: string): number {
  return body
    .split("\n")
    .filter((l) => l === "**Event**: SUBAGENT_COMPLETED").length;
}

/**
 * Field values from the LAST audit block whose `**Event**:` is SUBAGENT_COMPLETED.
 * The seed already has one such block; the hook appends a
 * NEW one at end-of-file, so "last" isolates the row the hook just wrote — the
 * block-scoped equivalent of the .sh's file-wide grep, but pinned to the new row.
 * Splits `**label**: value` on the literal `**: ` separator (mirrors auditField in
 * t31.cli.test.ts). Returns the field map for that block; missing keys are absent.
 */
function lastSubagentBlock(body: string): Record<string, string> {
  let current: Record<string, string> | null = null;
  let last: Record<string, string> = {};
  for (const line of body.split("\n")) {
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

/** Whole-buffer presence (mirrors a bare grep with no anchor). */
function bodyContains(body: string, needle: string): boolean {
  return body.includes(needle);
}

describe("t09 aidlc-log-subagent hook (migrated from t09-hook-log-subagent.sh + #710 regressions)", () => {
  test("1: logs subagent completion as SUBAGENT_COMPLETED event", () => {
    const p = proj();
    const before = subagentCompletedCount(readShards(p)); // seed baseline = 1
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    expect(r.status).toBe(0);
    // STRONGER: counts the appended row against the seeded baseline.
    expect(subagentCompletedCount(readShards(p))).toBe(before + 1);
    // STRONGER: exact field values on the NEW (last) block.
    const blk = lastSubagentBlock(readShards(p));
    expect(blk["Agent Type"]).toBe("architect");
    expect(blk["Agent ID"]).toBe("abc-123");
    expect(blk.Message).toBe("Done");
  });

  test("2: handles missing agent_id — agent type present, no Agent ID line", () => {
    const p = proj();
    runHook('{"agent_type":"developer"}', p);
    const blk = lastSubagentBlock(readShards(p));
    // .sh grepped only that the type was present; here block-scoped exact value.
    expect(blk["Agent Type"]).toBe("developer");
    // STRONGER: the hook omits Agent ID (and Message) when falsy,
    // so the NEW block carries neither. The .sh comment named "no Agent ID line".
    expect(blk["Agent ID"]).toBeUndefined();
    expect(blk.Message).toBeUndefined();
  });

  test("3a: no state leaves an existing audit shard byte-identical", () => {
    const p = proj({ state: false });
    const shard = join(auditDirOf(p), pinnedShardName());
    const before = readFileSync(shard);
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    expect(r.status).toBe(0);
    expect(readFileSync(shard)).toEqual(before);
    expect(existsSync(heartbeatPath(p))).toBe(false);
  });

  test("3b: no state and no shard exits without creating hook artifacts", () => {
    const p = proj({ state: false, audit: false });
    expect(existsSync(auditDirOf(p))).toBe(false);
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    expect(r.status).toBe(0);
    expect(existsSync(auditDirOf(p))).toBe(false);
    expect(existsSync(heartbeatPath(p))).toBe(false);
  });

  test("3c: completed state leaves an existing audit shard byte-identical", () => {
    const p = proj({ state: "completed" });
    const shard = join(auditDirOf(p), pinnedShardName());
    const before = readFileSync(shard);
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    expect(r.status).toBe(0);
    expect(readFileSync(shard)).toEqual(before);
    expect(existsSync(heartbeatPath(p))).toBe(false);
  });

  test("3d: completed state and no shard exits without creating hook artifacts", () => {
    const p = proj({ state: "completed", audit: false });
    expect(existsSync(auditDirOf(p))).toBe(false);
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    expect(r.status).toBe(0);
    expect(existsSync(auditDirOf(p))).toBe(false);
    expect(existsSync(heartbeatPath(p))).toBe(false);
  });

  test("3e: malformed state fails closed without creating hook artifacts", () => {
    const p = proj({ state: "malformed", audit: false });
    expect(existsSync(auditDirOf(p))).toBe(false);
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    expect(r.status).toBe(0);
    expect(existsSync(auditDirOf(p))).toBe(false);
    expect(existsSync(heartbeatPath(p))).toBe(false);
  });

  test("3f: running state and no shard creates the shard and appends", () => {
    const p = proj({ audit: false });
    expect(existsSync(auditDirOf(p))).toBe(false);
    const r = runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}',
      p,
    );
    expect(r.status).toBe(0);
    expect(existsSync(join(auditDirOf(p), pinnedShardName()))).toBe(true);
    expect(subagentCompletedCount(readShards(p))).toBe(1);
    const blk = lastSubagentBlock(readShards(p));
    expect(blk["Agent Type"]).toBe("architect");
    expect(blk["Agent ID"]).toBe("abc-123");
    expect(blk.Message).toBe("Done");
  });

  test("4: writes heartbeat (ISO timestamp)", () => {
    const p = proj();
    runHook('{"agent_type":"quality"}', p);
    expect(existsSync(heartbeatPath(p))).toBe(true);
    // STRONGER: the heartbeat carries an ISO timestamp.
    const ts = readFileSync(heartbeatPath(p), "utf-8").trim();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("5: handles empty stdin gracefully (exit 0, audit unchanged)", () => {
    const p = proj();
    const before = readShards(p);
    const r = runHook("", p);
    expect(r.status).toBe(0);
    // STRONGER: empty stdin -> JSON.parse("") throws -> exit 0 before any append,
    // so the audit must be byte-identical (the .sh captured BEFORE but never diffed).
    expect(readShards(p)).toBe(before);
  });

  test("6a: truncates long messages — entry written", () => {
    const p = proj();
    const longMsg = "A".repeat(500);
    runHook(
      `{"agent_type":"developer","agent_id":"xyz","last_assistant_message":"${longMsg}"}`,
      p,
    );
    const blk = lastSubagentBlock(readShards(p));
    expect(blk["Agent Type"]).toBe("developer");
  });

  test("6b: long message was truncated to 200 chars", () => {
    const p = proj();
    const longMsg = "A".repeat(500);
    runHook(
      `{"agent_type":"developer","agent_id":"xyz","last_assistant_message":"${longMsg}"}`,
      p,
    );
    // STRONGER: pins the exact 200-char slice boundary, not merely
    // "the 500-run is absent". The Message field is exactly 200 'A's...
    const blk = lastSubagentBlock(readShards(p));
    expect(blk.Message).toBe("A".repeat(200));
    // ...and the full 500-run never reaches the trail (the .sh's assert_not_grep A{500}).
    expect(bodyContains(readShards(p), "A".repeat(500))).toBe(false);
  });

  test("8: emits canonical Event field", () => {
    const p = proj();
    const before = subagentCompletedCount(readShards(p)); // seed baseline = 1
    runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"done"}',
      p,
    );
    // The .sh grepped `**Event**: SUBAGENT_COMPLETED`; here the canonical heading
    // line count goes baseline -> baseline+1 (block-scoped proof of the new row's
    // canonical Event field) and the new block's Event value is exactly that.
    expect(subagentCompletedCount(readShards(p))).toBe(before + 1);
    expect(lastSubagentBlock(readShards(p)).Event).toBe("SUBAGENT_COMPLETED");
  });
});
