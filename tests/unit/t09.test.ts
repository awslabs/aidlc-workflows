// covers: hook:aidlc-log-subagent
//
// The unit under test is a HOOK — aidlc-log-subagent.ts, the SubagentStop hook
// that emits SUBAGENT_COMPLETED. Hooks are mechanism=none: they receive a
// Claude Code JSON payload on stdin and resolve the project dir from the
// CLAUDE_PROJECT_DIR env var. The hook's contract is "JSON on stdin + env ->
// audit row + heartbeat file + clean exit", so every assertion exercises it by
// SPAWNING the hook via node:child_process spawnSync with controlled stdin and
// CLAUDE_PROJECT_DIR. We assert on res.status and on the audit shard / heartbeat
// the hook writes.
//
// AUDIT-ROW SHAPE (aidlc-log-subagent.ts + aidlc-audit.ts): the
// hook calls appendAuditEntry("SUBAGENT_COMPLETED", fields, projectDir, intent, space) where
// fields = { "Agent Type": agentType, ["Agent ID"]: agentId?, Message: msg? }.
// appendAuditEntryUnlocked renders each as `**<key>**: <value>` under a
// `## Subagent Completed` heading with `**Event**: SUBAGENT_COMPLETED`. Message
// is sliced to the first 200 chars. agentType defaults to "unknown" when absent,
// malformed, or blank without rewriting nonblank values; agentId defaults to ""
// (omitted when falsy).
//
// SEED BASELINE. proj() copies audit-sample.md in as the baseline shard (named
// `0-seed.md`), and the sample ALREADY CONTAINS one SUBAGENT_COMPLETED
// block whose Agent Type is `aidlc-developer-agent` (audit-sample.md). So
// a bare presence check would PASS off the seed alone. The event-presence cases
// here COUNT SUBAGENT_COMPLETED blocks against the seeded baseline (baseline =
// 1; post-fire = 2) and assert the NEW block's exact field values block-scoped,
// not a file-wide substring grep that a stale seed row could satisfy.
//
// FIXTURE DISCIPLINE: each case uses a FRESH temp project dir (createTestProject
// -> toPortablePath on Windows so the audit shard the hook writes via
// auditFilePath round-trips when read back); proj() seeds the baseline shard and
// the hook's own empty shard. All temp dirs cleaned in afterAll.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
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
// keeps the hook's NEW block LAST.
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
  join(seededRecordDir(p), ".aidlc-engine/hooks-health", "log-subagent.last");

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
 * Spawn the hook with `payload` on stdin and CLAUDE_PROJECT_DIR=p. The hook
 * resolves CLAUDE_PROJECT_DIR before the script path (resolveProjectDirFromHook
 * in aidlc-lib.ts), so the absolute hook path never shadows it.
 */
function runHook(payload: string, p: string): HookResult {
  const res = spawnSync(BUN, [HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    input: payload,
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  return { status: res.status ?? -1 };
}

function subagentCompletedCount(body: string): number {
  return body
    .split("\n")
    .filter((l) => l === "**Event**: SUBAGENT_COMPLETED").length;
}

/**
 * Field values from the LAST audit block whose `**Event**:` is SUBAGENT_COMPLETED.
 * The seed already has one such block; the hook appends a
 * NEW one at end-of-file, so "last" isolates the row the hook just wrote.
 * Splits `**label**: value` on the literal `**: ` separator (mirrors auditField in
 * t31.test.ts). Returns the field map for that block; missing keys are absent.
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
    expect(subagentCompletedCount(readShards(p))).toBe(before + 1);
    const blk = lastSubagentBlock(readShards(p));
    expect(blk["Agent Type"]).toBe("architect");
    expect(blk["Agent ID"]).toBe("abc-123");
    expect(blk.Message).toBe("Done");
  });

  test("2: handles missing agent_id — agent type present, no Agent ID line", () => {
    const p = proj();
    runHook('{"agent_type":"developer"}', p);
    const blk = lastSubagentBlock(readShards(p));
    expect(blk["Agent Type"]).toBe("developer");
    // The hook omits Agent ID (and Message) when falsy,
    // so the NEW block carries neither.
    expect(blk["Agent ID"]).toBeUndefined();
    expect(blk.Message).toBeUndefined();
  });

  for (const {
    label,
    payload,
    expectedType,
    expectedId,
    expectedMessage,
  } of [
    {
      label: "absent",
      payload: {},
      expectedType: "unknown",
      expectedId: undefined,
      expectedMessage: undefined,
    },
    {
      label: "malformed non-string",
      payload: {
        agent_type: 28,
        agent_id: "agent-28",
        last_assistant_message: "malformed identity",
      },
      expectedType: "unknown",
      expectedId: "agent-28",
      expectedMessage: "malformed identity",
    },
    {
      label: "empty",
      payload: { agent_type: "" },
      expectedType: "unknown",
      expectedId: undefined,
      expectedMessage: undefined,
    },
    {
      label: "whitespace-only",
      payload: {
        agent_type: " \t ",
        agent_id: "agent-whitespace",
        last_assistant_message: "done",
      },
      expectedType: "unknown",
      expectedId: "agent-whitespace",
      expectedMessage: "done",
    },
    {
      label: "exact nonblank identity",
      payload: {
        agent_type: "  aidlc-developer-agent  ",
        agent_id: "agent-valid",
        last_assistant_message: "complete",
      },
      expectedType: "  aidlc-developer-agent  ",
      expectedId: "agent-valid",
      expectedMessage: "complete",
    },
  ]) {
    test(`2 identity normalization: ${label}`, () => {
      const p = proj();
      const before = subagentCompletedCount(readShards(p));
      runHook(JSON.stringify(payload), p);
      expect(subagentCompletedCount(readShards(p))).toBe(before + 1);
      const blk = lastSubagentBlock(readShards(p));
      expect(blk["Agent Type"]).toBe(expectedType);
      if (expectedId === undefined) {
        expect(blk["Agent ID"]).toBeUndefined();
      } else {
        expect(blk["Agent ID"]).toBe(expectedId);
      }
      if (expectedMessage === undefined) {
        expect(blk.Message).toBeUndefined();
      } else {
        expect(blk.Message).toBe(expectedMessage);
      }
    });
  }

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
    const ts = readFileSync(heartbeatPath(p), "utf-8").trim();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("5: handles empty stdin gracefully (exit 0, audit unchanged)", () => {
    const p = proj();
    const before = readShards(p);
    const r = runHook("", p);
    expect(r.status).toBe(0);
    // Empty stdin -> JSON.parse("") throws -> exit 0 before any append,
    // so the audit must be byte-identical.
    expect(readShards(p)).toBe(before);
  });

  test("5b: handles malformed JSON gracefully (exit 0, audit unchanged)", () => {
    const p = proj();
    const before = readShards(p);
    const r = runHook('{"agent_type":', p);
    expect(r.status).toBe(0);
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
    const blk = lastSubagentBlock(readShards(p));
    expect(blk.Message).toBe("A".repeat(200));
    expect(bodyContains(readShards(p), "A".repeat(500))).toBe(false);
  });

  test("8: emits canonical Event field", () => {
    const p = proj();
    const before = subagentCompletedCount(readShards(p)); // seed baseline = 1
    runHook(
      '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"done"}',
      p,
    );
    expect(subagentCompletedCount(readShards(p))).toBe(before + 1);
    expect(lastSubagentBlock(readShards(p)).Event).toBe("SUBAGENT_COMPLETED");
  });
});
