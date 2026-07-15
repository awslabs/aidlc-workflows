// covers: hook:aidlc-runtime-compile
//
// Mechanism = none. Port of tests/integration/t91-runtime-compile-hook.sh (TAP
// plan 13). The unit under test is the PostToolUse Bash hook
// dist/claude/.claude/hooks/aidlc-runtime-compile.ts. A hook is mechanism=none
// — it has no CLI arg surface; it is driven by feeding Claude Code's
// PostToolUse JSON on stdin. So every .sh case is preserved here by SPAWNING
// the hook via node:child_process spawnSync with the JSON piped through
// `input:`, exactly as the .sh did
//   `echo '<json>' | CLAUDE_PROJECT_DIR=<p> bun "$proj/.claude/hooks/...ts"`.
//
// HOOK CONTRACT (aidlc-runtime-compile.ts):
//   1. TTY guard / empty-or-malformed stdin -> process.exit(0), no work.
//   2. Command filter: direct transition tools
//      (`aidlc-(state|jump|bolt|utility).ts`) OR `aidlc-orchestrate.ts report`
//      must match AND `aidlc-runtime\.ts` must NOT appear (the explicit
//      recursion-guard reject fires FIRST, defeating composites).
//   3. Audit-existence guard before the heartbeat write.
//   4. Heartbeat at aidlc-docs/.aidlc-hooks-health/runtime-compile.last (only
//      written once the command filter passes).
//   5. Tail-read the LAST 3 audit blocks (split on /\n---\n/); if any carries
//      `**Event**: (GATE_APPROVED|STAGE_STARTED|STAGE_AWAITING_APPROVAL|
//      AUDIT_MERGED|WORKFLOW_COMPLETED)` -> dispatch
//      `bun run <projectDir>/.claude/tools/aidlc-runtime.ts compile` (which
//      writes aidlc-docs/runtime-graph.json). MEMORY_EMPTY is deliberately NOT
//      in the regex (recursion guard at the event level).
//   (The old step 6, test-run propagation to the spawned compile, was removed
//      per #369 when the test-run mechanism was removed.)
//
// FIXTURE DISCIPLINE — replicate the .sh's make_project (t91:36-47) EXACTLY:
// a fresh temp project under aidlc-docs/ + a self-contained .claude/ skeleton
// with the four tool files (aidlc-runtime.ts, aidlc-lib.ts, aidlc-audit.ts,
// data/stage-graph.json) and the hook copied in, plus a minimal
// aidlc-state.md ("- **Scope**: feature"). The COPY (not symlink) matters:
// the hook spawns `<projectDir>/.claude/tools/aidlc-runtime.ts`, whose
// aidlc-lib.ts resolves stage-graph.json relative to its own import.meta.url
// (aidlc-lib.ts:693 DATA_DIR) — so the data file must sit beside the copied
// lib for the compile to read it. mkdtempSync + toPortablePath (Windows path
// round-trip, since the tool writes audit/graph paths through forward-slash
// helpers). Nothing is written under tests/fixtures/**. All temp dirs cleaned
// in afterAll.
//
// PARITY MAP (every .sh `ok` / assert_eq -> one expect()-bearing test() here;
// several are STRONGER than the original presence check):
//   .sh Case 1  GATE_APPROVED in last-3 -> runtime-graph.json exists       -> T1
//        (STRONGER: also pins hook exit 0).
//   .sh Case 2  terminal-WORKFLOW (last3 = PHASE_COMPLETED+PHASE_VERIFIED+
//        WORKFLOW_COMPLETED) -> graph written via WORKFLOW_COMPLETED          -> T2.
//   .sh Case 2b STAGE_AWAITING_APPROVAL in last-3 (gate-start refresh) ->
//        graph written                                                        -> T3.
//   .sh Case 3  non-aidlc Bash (git status) -> NO graph (2 asserts: no graph
//        AND no heartbeat — cheap exit before heartbeat)                       -> T4 + T5.
//   .sh Case 4  aidlc-runtime.ts -> recursion-guarded, no graph              -> T6.
//   .sh Case 4b composite `aidlc-runtime.ts compile && aidlc-state.ts approve`
//        -> explicit reject fires first, no graph                             -> T7.
//   .sh Case 5  aidlc Bash but no transition in last-3 (QUESTION_ANSWERED /
//        DECISION_RECORDED / ARTIFACT_UPDATED) -> no graph (T8) BUT heartbeat
//        still written (T9 — the filter passed, only the event-class failed).
//   .sh Case 6  empty stdin -> exit 0 (T10) + no graph (T11).
//   .sh Case 7  malformed JSON stdin -> exit 0 (T12).
//   .sh Case 8  (Test-Run propagation -> the MEMORY_EMPTY block carries
//        Test-Run: true, T13) was dropped per #369 when the test-run mechanism
//        was removed.
//
// Each .sh `ok` / assert_eq maps to one expect()-bearing test() case here, plus
// the MR9 orchestrate-report command-filter regression.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const SRC_TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const SRC_HOOKS = join(REPO_ROOT, "dist", "claude", ".claude", "hooks");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/**
 * make_project (t91:36-47): a fresh temp project with a self-contained
 * .claude/ skeleton so the hook + the compile it spawns resolve every path
 * via CLAUDE_PROJECT_DIR. Copies (NOT symlinks) the four tool files + the hook
 * — aidlc-lib.ts resolves data/stage-graph.json relative to its own location,
 * so the data file must sit beside the copied lib. toPortablePath round-trips
 * the path on Windows.
 */
function makeProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  mkdirSync(join(proj, ".claude", "tools", "data"), { recursive: true });
  mkdirSync(join(proj, ".claude", "hooks"), { recursive: true });
  copyFileSync(
    join(SRC_TOOLS, "aidlc-runtime.ts"),
    join(proj, ".claude", "tools", "aidlc-runtime.ts"),
  );
  copyFileSync(
    join(SRC_TOOLS, "aidlc-lib.ts"),
    join(proj, ".claude", "tools", "aidlc-lib.ts"),
  );
  copyFileSync(
    join(SRC_TOOLS, "aidlc-runtime-paths.ts"),
    join(proj, ".claude", "tools", "aidlc-runtime-paths.ts"),
  );
  copyFileSync(
    join(SRC_TOOLS, "aidlc-audit.ts"),
    join(proj, ".claude", "tools", "aidlc-audit.ts"),
  );
  copyFileSync(
    join(SRC_TOOLS, "data", "stage-graph.json"),
    join(proj, ".claude", "tools", "data", "stage-graph.json"),
  );
  copyFileSync(
    join(SRC_HOOKS, "aidlc-runtime-compile.ts"),
    join(proj, ".claude", "hooks", "aidlc-runtime-compile.ts"),
  );
  // P9: write the minimal state into the default record so the active-intent
  // cursor resolves → the hook reads the record's audit shards (readAllAuditShards)
  // and writes runtime-graph.json under the record (runtimeGraphPath).
  mkdirSync(seededRecordDir(proj), { recursive: true });
  writeFileSync(seededStateFile(proj), "- **Scope**: feature", "utf-8");
  // Pre-create the record's audit/ DIR so the tests can write the AUDIT_*
  // fixture directly into a shard (auditPath → <record>/audit/fixture.md).
  mkdirSync(seededAuditDir(proj), { recursive: true });
  return proj;
}

const hookPath = (proj: string): string =>
  join(proj, ".claude", "hooks", "aidlc-runtime-compile.ts");
// The hook reads the audit via the per-clone shard GLOB; writing the AUDIT_*
// fixtures into one shard under the record's audit/ DIR is what the hook merges.
const auditPath = (proj: string): string =>
  join(seededAuditDir(proj), "fixture.md");
const graphPath = (proj: string): string =>
  join(seededRecordDir(proj), "runtime-graph.json");
const heartbeatPath = (proj: string): string =>
  join(seededRecordDir(proj), ".aidlc-hooks-health", "runtime-compile.last");

interface HookResult {
  status: number;
  out: string;
}

/** run_hook (t91:49-53): pipe the PostToolUse JSON on stdin with CLAUDE_PROJECT_DIR set. */
function runHook(proj: string, json: string): HookResult {
  const res = spawnSync(BUN, [hookPath(proj)], {
    input: json,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    timeout: 20_000,
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** Spawn the hook with EMPTY stdin (the .sh's `</dev/null`). */
function runHookEmptyStdin(proj: string): HookResult {
  const res = spawnSync(BUN, [hookPath(proj)], {
    input: "",
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    timeout: 20_000,
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

const payload = (command: string): string =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command } });

// --- Audit fixtures (t91:57-172, 202-226) ---------------------------------
// Trailing block separator matters: split('\n---\n') leaves an empty tail
// element, but slice(-3) is robust to it (the .sh comment at t91:55-56).

const AUDIT_GATE_APPROVED = `## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Gate Approved
**Timestamp**: 2026-05-27T10:05:01Z
**Event**: GATE_APPROVED
**Stage**: intent-capture

---
`;

const AUDIT_TERMINAL_WORKFLOW = `## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Gate Approved
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: GATE_APPROVED
**Stage**: intent-capture

---

## Stage Completion
**Timestamp**: 2026-05-27T10:05:01Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Phase Completion
**Timestamp**: 2026-05-27T10:05:02Z
**Event**: PHASE_COMPLETED
**From phase**: ideation
**To phase**: inception

---

## Phase Verification
**Timestamp**: 2026-05-27T10:05:03Z
**Event**: PHASE_VERIFIED
**Phase boundary**: ideation → inception

---

## Workflow Completion
**Timestamp**: 2026-05-27T10:05:04Z
**Event**: WORKFLOW_COMPLETED
**Reason**: terminal-stage-approved

---
`;

const AUDIT_GATE_START = `## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Awaiting Approval
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_AWAITING_APPROVAL
**Stage**: intent-capture
**Artifacts**: intent-statement

---
`;

const AUDIT_NO_TRANSITION = `## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Question Answered
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: QUESTION_ANSWERED
**Stage**: intent-capture

---

## Decision Recorded
**Timestamp**: 2026-05-27T10:02:00Z
**Event**: DECISION_RECORDED
**Stage**: intent-capture

---

## Artifact Updated
**Timestamp**: 2026-05-27T10:03:00Z
**Event**: ARTIFACT_UPDATED
**Tool**: Edit

---
`;

// (The AUDIT_GATE_APPROVED_TESTRUN fixture and its Test-Run-propagation case
// were dropped per #369 when the test-run mechanism was removed.)

describe("t91 aidlc-runtime-compile hook (migrated from t91-runtime-compile-hook.sh, plan 13)", () => {
  // --- Case 1: filter pass — GATE_APPROVED in last 3 -> dispatch -----------
  test("1: GATE_APPROVED in last-3 -> compile dispatched (runtime-graph.json written)", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    const r = runHook(
      p,
      payload("bun .claude/tools/aidlc-state.ts approve --stage intent-capture"),
    );
    expect(r.status).toBe(0); // STRONGER: the .sh discarded the hook exit code
    expect(existsSync(graphPath(p))).toBe(true);
  }, 30000);

  test("1b: aidlc-orchestrate report command -> compile dispatched", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    const r = runHook(
      p,
      payload(
        "bun .claude/tools/aidlc-orchestrate.ts report --stage intent-capture --result approved",
      ),
    );
    expect(r.status).toBe(0);
    expect(existsSync(graphPath(p))).toBe(true);
  }, 30000);

  // --- Case 2: terminal-WORKFLOW (WORKFLOW_COMPLETED in last 3) -> dispatch -
  test("2: terminal-WORKFLOW (WORKFLOW_COMPLETED in last-3) -> compile dispatched", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_TERMINAL_WORKFLOW, "utf-8");
    runHook(
      p,
      payload("bun .claude/tools/aidlc-state.ts approve --stage intent-capture"),
    );
    expect(existsSync(graphPath(p))).toBe(true);
  }, 30000);

  // --- Case 2b: STAGE_AWAITING_APPROVAL in last 3 (gate-start refresh) -----
  test("3: STAGE_AWAITING_APPROVAL in last-3 -> compile dispatched (gate-start refresh)", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_START, "utf-8");
    runHook(
      p,
      payload("bun .claude/tools/aidlc-state.ts gate-start intent-capture"),
    );
    expect(existsSync(graphPath(p))).toBe(true);
  }, 30000);

  // --- Case 3: non-aidlc Bash (git status) -> no dispatch + no heartbeat ---
  test("4: non-aidlc Bash -> no compile dispatched", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    runHook(p, payload("git status"));
    expect(existsSync(graphPath(p))).toBe(false);
  }, 30000);

  test("5: non-aidlc Bash -> cheap exit before heartbeat (no heartbeat file)", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    runHook(p, payload("git status"));
    // The command filter rejects before the heartbeat write (hook step 3 < 5).
    expect(existsSync(heartbeatPath(p))).toBe(false);
  }, 30000);

  // --- Case 4: aidlc-runtime.ts -> recursion guard, no dispatch -----------
  test("6: aidlc-runtime.ts -> recursion-guarded (no compile)", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    runHook(p, payload("bun .claude/tools/aidlc-runtime.ts compile"));
    expect(existsSync(graphPath(p))).toBe(false);
  }, 30000);

  // --- Case 4b: composite with aidlc-runtime.ts AND aidlc-state.ts --------
  test("7: composite Bash with aidlc-runtime.ts -> recursion-guarded (explicit reject first, no compile)", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    runHook(
      p,
      payload(
        "bun .claude/tools/aidlc-runtime.ts compile && bun .claude/tools/aidlc-state.ts approve",
      ),
    );
    expect(existsSync(graphPath(p))).toBe(false);
  }, 30000);

  // --- Case 5: aidlc Bash but no transition in last 3 ---------------------
  test("8: no transition in last-3 -> no compile dispatched", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_NO_TRANSITION, "utf-8");
    runHook(p, payload("bun .claude/tools/aidlc-state.ts session"));
    expect(existsSync(graphPath(p))).toBe(false);
  }, 30000);

  test("9: no transition in last-3 -> heartbeat still updated (filter passed, only event-class failed)", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_NO_TRANSITION, "utf-8");
    runHook(p, payload("bun .claude/tools/aidlc-state.ts session"));
    // The command filter passed (aidlc-state.ts), so the heartbeat write at
    // hook step 5 runs even though the event-class filter (step 7) bailed.
    expect(existsSync(heartbeatPath(p))).toBe(true);
  }, 30000);

  // --- Case 6: empty-stdin guard ------------------------------------------
  test("10: empty stdin -> exit 0", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    const r = runHookEmptyStdin(p);
    expect(r.status).toBe(0);
  }, 30000);

  test("11: empty stdin -> no compile (exits before work)", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    runHookEmptyStdin(p);
    expect(existsSync(graphPath(p))).toBe(false);
  }, 30000);

  // --- Case 7: malformed JSON stdin -> exit 0, no work --------------------
  test("12: malformed stdin JSON -> exit 0", () => {
    const p = makeProject();
    writeFileSync(auditPath(p), AUDIT_GATE_APPROVED, "utf-8");
    const r = runHook(p, "this is not json");
    expect(r.status).toBe(0);
  }, 30000);

  // Case 8 / test 13 (Test-Run propagation -> MEMORY_EMPTY row carries
  // Test-Run: true) was dropped per #369 when the test-run mechanism was removed.
});
