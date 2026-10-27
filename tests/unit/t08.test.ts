// covers: hook:aidlc-validate-state
//
// Port of tests/unit/t08-hook-validate-state.sh (TAP plan 14), mechanism = none.
// The unit under test is a HOOK — aidlc-validate-state.ts, the PreCompact hook
// that validates aidlc-state.md structure and emits SESSION_COMPACTED when an
// audit.md already exists. Hooks are
// mechanism=none: they resolve the project dir from the CLAUDE_PROJECT_DIR env
// var (aidlc-lib.ts) and have no exported pure function to import. So
// every .sh assertion is preserved by SPAWNING the hook via
// node:child_process spawnSync with CLAUDE_PROJECT_DIR set, exactly as the .sh
// ran `CLAUDE_PROJECT_DIR=<p> bun "$HOOK"`. We assert on res.stderr (the .sh's
// `2>&1` WARNING grep — the hook prints warnings via console.error,
// aidlc-validate-state.ts), on the heartbeat the hook writes, and on the
// SESSION_COMPACTED row it appends to audit.md.
//
// NO STDIN: unlike the SubagentStop/PostToolUse hooks (t09/t29), this PreCompact
// hook reads NOTHING from stdin — it only consumes the state file under
// CLAUDE_PROJECT_DIR. The .sh never piped a payload (`bun "$HOOK"` with no
// `echo ... |`), so neither do we.
//
// HOOK CONTRACT (aidlc-validate-state.ts):
//   - Always writes the heartbeat aidlc-docs/.aidlc-engine/hooks-health/validate-state.last
//     (an ISO timestamp), even before the no-state-file early exit (lines 26-28).
//   - No state file -> process.exit(0) BEFORE any WARNING / audit work. So: no
//     WARNING on stderr.
//   - State file present -> validates `## Stage Progress` + `## Current Status`
//     (lines 36-37); missing sections print `WARNING: aidlc-state.md missing
//     sections: <names>` on stderr and make the row's State Validity `invalid`.
//   - It keeps no other record of the compaction: no .aidlc-engine/recovery.md.
//   - SESSION_COMPACTED emitted via appendAuditEntry ONLY when audit.md already
//     exists (lines 58-59); the hook never auto-creates audit.md. The audit row
//     renders under `## Session Compacted` with `**Event**: SESSION_COMPACTED`
//     (aidlc-audit.ts, EVENT_HEADINGS) plus Current Stage + State Validity
//     fields (hook lines 61-67).
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several STRONGER):
//   - .sh Test 1  no state -> no WARNING on stderr                    -> Test 1:
//       res.stderr has no /WARNING/i (same observable; the .sh's
//       `echo "$OUTPUT" | grep -qi WARNING` was negated).
//   - .sh Test 2  no state -> heartbeat written anyway                -> Test 2:
//       heartbeat exists (same observable) + STRONGER: its contents are an ISO
//       timestamp (hook line 28 writes isoTimestamp()).
//   - .sh Test 3  no state -> no breadcrumb: retired with the breadcrumb (Test 7).
//   - .sh Test 4  valid mid-ideation fixture -> no WARNING            -> Test 4:
//       res.stderr has no /WARNING/i (same observable).
//   - .sh Test 5  state missing `## Stage Progress` -> WARNING names it -> Test 5:
//       res.stderr contains "Stage Progress" (same observable) + STRONGER: the
//       full canonical `WARNING: aidlc-state.md missing sections: Stage Progress`
//       diagnostic, scoped to stderr.
//   - .sh Test 6  state missing `## Current Status` -> WARNING names it -> Test 6:
//       res.stderr contains "Current Status" (same observable) + STRONGER: the
//       full canonical diagnostic line.
//   - .sh Test 7  valid fixture -> writes the breadcrumb: now the opposite. Test 7
//       pins that a compaction keeps no recovery.md (its stage and validity were
//       copies of the SESSION_COMPACTED row), still writes the heartbeat and the
//       row, and that no shipped file names the breadcrumb.
//   - .sh Test 8  breadcrumb stage + "valid": retired; Test 13 pins the row's
//       Current Stage and State Validity.
//   - .sh Test 9/10 breadcrumb INVALID when sections missing -> Test 9: the row's
//       State Validity is `invalid`.
//   - .sh Test 11 corrupted fixture (missing Stage Progress) -> WARNING -> Test 11:
//       res.stderr contains "Stage Progress" (same observable) + STRONGER: the
//       full canonical diagnostic naming the corrupted fixture's missing section.
//   - .sh Test 12 completed fixture -> no WARNING                      -> Test 12:
//       res.stderr has no /WARNING/i (same observable).
//   - .sh Test 13 audit.md present -> SESSION_COMPACTED emitted         -> Test 13:
//       SESSION_COMPACTED block count goes seed(0) -> 1 (STRONGER: counts the
//       appended row against the seeded baseline — audit-sample.md carries NO
//       SESSION_COMPACTED block — not a bare presence grep) + the new block's
//       exact Current Stage / State Validity field values, block-scoped.
//   - .sh Test 14 no audit.md -> hook does NOT auto-create audit.md     -> Test 14:
//       audit.md absent (same observable) + STRONGER: the hook still exits 0.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// seed_audit_file + cleanup_test_project per case): each case uses a FRESH temp
// project dir (createTestProject -> toPortablePath on Windows so the audit.md
// the hook writes via toPosix(auditFilePath) round-trips when read back).
// seedStateFile / seedAuditFile copy the same fixtures the .sh seeded
// (state-mid-ideation.md, state-corrupted.md, state-completed.md,
// audit-sample.md). All temp dirs cleaned in afterAll.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  intentsDirOf,
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
  "aidlc-validate-state.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

// Per-intent record paths. state + heartbeat re-root under the
// default intent's record dir; the audit trail is a DIR of per-clone shards
// (read via readShards below).
const statePath = (p: string): string => join(seededRecordDir(p), "aidlc-state.md");
const heartbeatPath = (p: string): string =>
  join(seededRecordDir(p), ".aidlc-engine/hooks-health", "validate-state.last");
// With NO state file the active-intent cursor does not resolve (a record without
// aidlc-state.md is not honoured), so docsRoot() falls back to the bare SPACE
// record root, so the heartbeat lands there, not under the record.
const heartbeatPathNoState = (p: string): string =>
  join(intentsDirOf(p), ".aidlc-engine/hooks-health", "validate-state.last");

// The shard the spawned hook resolves, computed from a clone-id we pin on disk
// (mirrors auditShardName()'s `<host>-<clone>.md` shape). Used only by test 13,
// which needs the hook's audit-shard gate to pass.
const PINNED_CLONE_ID = "testcloneid08";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}
/** Pin the clone-id + create the resolved audit shard so the SESSION_COMPACTED
 *  gate (existsSync(auditFilePath)) passes; returns the audit DIR. */
function seedAuditShard(p: string): string {
  writeFileSync(join(p, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  const auditDir = seededAuditDir(p);
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, pinnedShardName()), "", "utf-8");
  return auditDir;
}
function readShards(auditDir: string): string {
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
  stdout: string;
  stderr: string;
}

/**
 * Spawn the hook with CLAUDE_PROJECT_DIR=p and no stdin payload (the hook reads
 * stdin but tolerates an empty one). resolveProjectDirFromHook reads
 * AIDLC_PROJECT_DIR, then CLAUDE_PROJECT_DIR, before deriving a project dir from
 * the hook's own path, so the absolute hook path never shadows it.
 */
function runHook(p: string): HookResult {
  const res = spawnSync(BUN, [HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function writeState(p: string, content: string): void {
  mkdirSync(seededRecordDir(p), { recursive: true });
  writeFileSync(statePath(p), content, "utf-8");
}

function sessionCompactedCount(body: string): number {
  return body
    .split("\n")
    .filter((l) => l === "**Event**: SESSION_COMPACTED").length;
}

/**
 * Field values from the LAST audit block whose `**Event**:` is SESSION_COMPACTED.
 * The seed (an empty shard) carries none, so the hook-appended block is the
 * only — and last — one. Splits `**label**: value` on the literal `**: `
 * separator (mirrors auditField in t31.test.ts / lastSubagentBlock in
 * t09.test.ts). Returns the field map; missing keys are absent.
 */
function lastCompactedBlock(body: string): Record<string, string> {
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
    if (line === "**Event**: SESSION_COMPACTED") {
      current = { Event: "SESSION_COMPACTED" };
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

// What ships: the source trees the packager projects into every harness.
const BREADCRUMB = /\.aidlc-engine\/recovery\.md|recovery breadcrumb|recoveryFilePath|recoveryExists/i;
function shippedFiles(): string[] {
  return ["core", "harness", "plugins"].flatMap((root) =>
    readdirSync(join(REPO_ROOT, root), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.parentPath.includes("node_modules"))
      .map((entry) => join(entry.parentPath, entry.name)),
  );
}

describe("t08 aidlc-validate-state hook (migrated from t08-hook-validate-state.sh, plan 14)", () => {
  test("1: no state file -> no WARNING on stderr", () => {
    const p = proj();
    rmSync(statePath(p), { force: true });
    const r = runHook(p);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/WARNING/i);
  });

  test("2: heartbeat written even without state file (ISO timestamp)", () => {
    const p = proj();
    rmSync(statePath(p), { force: true });
    runHook(p);
    expect(existsSync(heartbeatPathNoState(p))).toBe(true);
    const ts = readFileSync(heartbeatPathNoState(p), "utf-8").trim();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("4: valid mid-ideation fixture -> no WARNING", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    const r = runHook(p);
    expect(r.stderr).not.toMatch(/WARNING/i);
  });

  test("5: missing Stage Progress -> WARNING names the section", () => {
    const p = proj();
    writeState(
      p,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n",
    );
    const r = runHook(p);
    expect(r.stderr).toContain("Stage Progress");
    expect(r.stderr).toContain(
      "WARNING: aidlc-state.md missing sections: Stage Progress",
    );
  });

  test("6: missing Current Status -> WARNING names the section", () => {
    const p = proj();
    writeState(
      p,
      "# AI-DLC State Tracking\n## Stage Progress\n### IDEATION PHASE\n- [-] feasibility — EXECUTE\n",
    );
    const r = runHook(p);
    expect(r.stderr).toContain("Current Status");
    expect(r.stderr).toContain(
      "WARNING: aidlc-state.md missing sections: Current Status",
    );
  });

  test("7: a compaction keeps no recovery.md, still writes its heartbeat and SESSION_COMPACTED, and no shipped file names one", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    const auditDir = seedAuditShard(p);
    expect(runHook(p).status).toBe(0);
    expect(existsSync(join(seededRecordDir(p), ".aidlc-engine", "recovery.md"))).toBe(false);
    expect(existsSync(heartbeatPath(p))).toBe(true);
    expect(sessionCompactedCount(readShards(auditDir))).toBe(1);
    const naming = shippedFiles().filter((file) => BREADCRUMB.test(readFileSync(file, "utf-8")));
    expect(naming).toEqual([]);
  });

  test("9: missing sections -> the SESSION_COMPACTED row says invalid", () => {
    const p = proj();
    writeState(
      p,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n",
    );
    const auditDir = seedAuditShard(p);
    runHook(p);
    expect(lastCompactedBlock(readShards(auditDir))["State Validity"]).toBe("invalid");
  });

  test("11: corrupted fixture -> WARNING names missing Stage Progress", () => {
    const p = proj();
    seedStateFile(p, "state-corrupted.md");
    const r = runHook(p);
    expect(r.stderr).toContain("Stage Progress");
    // The corrupted fixture (state-corrupted.md) carries `## Current
    // Status` but no `## Stage Progress`, so the canonical diagnostic names only
    // Stage Progress.
    expect(r.stderr).toContain(
      "WARNING: aidlc-state.md missing sections: Stage Progress",
    );
  });

  test("12: completed fixture -> no WARNING", () => {
    const p = proj();
    seedStateFile(p, "state-completed.md");
    const r = runHook(p);
    expect(r.stderr).not.toMatch(/WARNING/i);
  });

  test("13: audit trail present -> emits SESSION_COMPACTED", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    const auditDir = seedAuditShard(p); // pinned shard so the gate (existsSync(auditFilePath)) passes
    const before = sessionCompactedCount(readShards(auditDir)); // seed baseline = 0 (empty shard)
    runHook(p);
    // Counts the appended row against the seeded baseline (the empty shard
    // carries NO SESSION_COMPACTED block), not a bare grep.
    expect(sessionCompactedCount(readShards(auditDir))).toBe(before + 1);
    const blk = lastCompactedBlock(readShards(auditDir));
    expect(blk.Event).toBe("SESSION_COMPACTED");
    expect(blk["Current Stage"]).toBe("feasibility");
    expect(blk["State Validity"]).toBe("valid");
  });

  test("14: no audit shard -> hook does not auto-create it", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    const auditDir = seededAuditDir(p);
    expect(existsSync(auditDir)).toBe(false);
    const r = runHook(p);
    expect(existsSync(auditDir)).toBe(false);
    expect(r.status).toBe(0);
  });
});
