// covers: subcommand:aidlc-runtime:compile
//
// t48 — runtime-graph compile end-to-end. Migrated from
// tests/integration/t48-runtime-graph-end-to-end.sh (TAP plan 10).
// Mechanism: cli. The .sh drove a REAL workflow through approval gates and
// invoked `aidlc-runtime.ts compile` after each transition (simulating what
// the PostToolUse Bash hook does in a session — a bun-direct invocation does
// not trigger Claude Code's hooks). This twin keeps that process-boundary
// shape: it spawns the shipped tools (aidlc-utility init, aidlc-state
// gate-start / approve, aidlc-runtime compile) via the BUN runtime against
// the .ts paths and asserts on the bytes the tools write to
// runtime-graph.json + audit.md on disk. An in-process import would lose the
// audit-lock regime + state-machine seam the .sh exercised across multiple
// short-lived processes, so this is deliberately cli (= all spawns).
//
// Source under test (dist/claude/.claude/tools/aidlc-runtime.ts):
//   :314 compile({ projectDir }) walks audit.md + per-stage
//        memory.md, pairs STAGE_STARTED/STAGE_COMPLETED into one row per slug
//        (pairStartedCompleted, :171), reads memory.md (readMemory, :269 —
//        absent file => memory_entries:null, the v0.4.0 backfill rule), and
//        writes runtime-graph.json inside withAuditLock (:769-791). The
//        WORKFLOW_STARTED → workflow_id/scope/started_at header is
//        buildWorkflowHeader (:237). Determinism contract (file header
//        :18-23): re-running compile against the same audit produces a
//        byte-equivalent runtime-graph.json.
//   :1259 handleCompile — the CLI shell this twin spawns; prints
//        JSON.stringify(result) on success, exit 0.
//   RuntimeGraph schema (:108): { workflow_id, scope, started_at, stages[] };
//        each RuntimeStage (:75) carries stage_slug, started_at, completed_at,
//        memory_entries, outcome ("approved"|"failed"|"pending"), ...
//   MEMORY_EMPTY emit (:763-789): emitted ONLY for an approved row whose
//        memory_entries === 0. A stage with NO memory.md has
//        memory_entries:null (NOT 0), so no MEMORY_EMPTY fires — the .sh's
//        "backfill, file absent" guarantee.
//
// First-stage fact: `init --scope bugfix` puts requirements-analysis in [-]
// (in-progress) as the first stage of the bugfix scope (verified against a
// real init: state.md `- [-] requirements-analysis — EXECUTE`). The twin
// extracts the first stage from state.md exactly as the .sh did
// (grep '^- [-]' | head -1) rather than hard-coding it, so a scope-spine
// change re-targets automatically.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  (compile produced runtime-graph.json)                  -> test 1
//   .sh test 2  (graph has workflow_id, scope, started_at, stages)     -> test 2
//   .sh test 3  (scope reflects init scope == "bugfix")                -> test 3
//   .sh test 4  (first stage row outcome: pending pre-approve)         -> test 4
//   .sh test 5  (stage 1 outcome flips to approved post-approve)       -> test 5
//   .sh test 6  (stage 1 has non-null completed_at)                    -> test 6
//   .sh test 7  (graph has 2+ rows after approve)                      -> test 7
//   .sh test 8  (missing memory.md -> memory_entries: null backfill)   -> test 8
//   .sh test 9  (no MEMORY_EMPTY emitted — file absent)                -> test 9
//   .sh test 10 (re-compile byte-equivalent runtime-graph.json)        -> test 10
//
// Strengthenings over the .sh's jq/grep greps (noted inline): test 2 asserts
// each of the four header keys is present AND non-empty (not just `has()`);
// test 8 also pins that memory_entries is the JSON null, not the string
// "null"; test 9 reads the audit and asserts ZERO MEMORY_EMPTY blocks for the
// stage AND zero total; test 10 compares the parsed graph deep-equal as well
// as the raw bytes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const RUNTIME = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");

interface RuntimeStageRow {
  stage_slug: string;
  started_at: string | null;
  completed_at: string | null;
  memory_entries: number | null;
  outcome: "approved" | "failed" | "pending";
}
interface RuntimeGraphShape {
  workflow_id: string;
  scope: string;
  started_at: string;
  stages: RuntimeStageRow[];
}

// One shared project drives the whole end-to-end sequence, exactly as the .sh
// did: a single workflow stepped through init -> compile#1 -> gate -> compile#2
// -> re-compile. Built once in beforeAll; the spawn results + on-disk reads are
// captured into module state so each test() asserts one slice without re-driving
// the (slow) real CLIs. Cleaned in afterAll (mirrors cleanup_test_project).
let proj = "";
let firstStage = "";

// P4: init births a per-intent record (aidlc/spaces/<space>/intents/<slug>-<id8>/),
// and aidlc-runtime compile writes runtime-graph.json + audit shards INSIDE that
// record, not the flat aidlc-docs/. Resolve the record dir from the active-space
// + active-intent cursors, falling back to the flat layout for a not-yet-born
// project. The graph/audit CONTENT is unchanged — only the LOCATION moved.
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
const graphPathOf = (p: string): string =>
  join(recordDirOf(p), "runtime-graph.json");
const statePathOf = (p: string): string =>
  join(recordDirOf(p), "aidlc-state.md");
// Audit is sharded under <record>/audit/<host>-<pid>.md; concat every shard for
// a content read, falling back to the flat audit.md for a not-yet-born project.
function readAudit(p: string): string {
  const auditDir = join(recordDirOf(p), "audit");
  if (existsSync(auditDir)) {
    return readdirSync(auditDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(auditDir, f), "utf-8"))
      .join("\n");
  }
  const flat = join(p, "aidlc-docs", "audit.md");
  return existsSync(flat) ? readFileSync(flat, "utf-8") : "";
}

// Captured artefacts across the sequence.
let graphAfterInit: RuntimeGraphShape; // compile #1 — pre-approve
let graphAfterApprove: RuntimeGraphShape; // compile #2 — post-approve
let rawBeforeRecompile = ""; // bytes after compile #2
let rawAfterRecompile = ""; // bytes after the idempotency re-compile
let auditAfterApprove = ""; // audit.md after compile #2 (MEMORY_EMPTY check)
let initOk = false;
let compile1Ok = false;

/** Spawn a shipped tool via BUN, return {status, out (stdout+stderr)}. */
function run(
  tool: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number; out: string } {
  const r = spawnSync(BUN, [tool, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

function readGraph(): RuntimeGraphShape {
  return JSON.parse(readFileSync(graphPathOf(proj), "utf-8")) as RuntimeGraphShape;
}

function rowFor(graph: RuntimeGraphShape, slug: string): RuntimeStageRow | undefined {
  return graph.stages.find((s) => s.stage_slug === slug);
}

beforeAll(() => {
  proj = createTestProject();

  // Init the bugfix scope — fastest scope, smallest stage list (.sh:40-42).
  const init = run(
    UTIL,
    ["intent-birth", "--scope", "bugfix", "--project-dir", proj],
    { AIDLC_WORKFLOW_INTENT: "runtime-graph e2e" },
  );
  initOk = init.status === 0;

  // First in-flight stage from state.md (the [-] row), exactly as .sh:49.
  // P4: state lives in the born intent's record, not the flat aidlc-docs/.
  const state = readFileSync(statePathOf(proj), "utf-8");
  const inProgress = state
    .split("\n")
    .find((l) => /^- \[-\]/.test(l));
  const m = inProgress?.match(/^- \[-\] ([a-z-]+)/);
  firstStage = m ? m[1] : "";

  // --- Compile #1: pre-approve, stage 1 in flight (pending row only) ------
  // The .sh passes CLAUDE_PROJECT_DIR + falls back to a flag-less invocation;
  // we use the explicit --project-dir form (resolveProjectDir honours it,
  // aidlc-lib.ts:88) which is the deterministic path.
  run(RUNTIME, ["compile", "--project-dir", proj], { CLAUDE_PROJECT_DIR: proj });
  compile1Ok = existsSync(graphPathOf(proj));
  if (compile1Ok) graphAfterInit = readGraph();

  // --- Gate-start -> approve stage 1 (emits GATE_APPROVED + STAGE_COMPLETED
  // + the in-line STAGE_STARTED for stage 2), then compile #2 (.sh:75-79). ---
  run(STATE, ["gate-start", firstStage, "--project-dir", proj]);
  run(STATE, [
    "approve",
    firstStage,
    "--user-input",
    "looks good",
    "--project-dir",
    proj,
  ]);
  run(RUNTIME, ["compile", "--project-dir", proj], { CLAUDE_PROJECT_DIR: proj });
  graphAfterApprove = readGraph();
  rawBeforeRecompile = readFileSync(graphPathOf(proj), "utf-8");
  // P4: audit is sharded under the born record's audit/ dir; concat the shards.
  auditAfterApprove = readAudit(proj);

  // --- Idempotency: re-compile, assert byte-equivalent (.sh:103-107). ------
  run(RUNTIME, ["compile", "--project-dir", proj], { CLAUDE_PROJECT_DIR: proj });
  rawAfterRecompile = readFileSync(graphPathOf(proj), "utf-8");
});

afterAll(() => {
  cleanupTestProject(proj);
});

describe("t48 runtime-graph compile end-to-end (migrated from t48-runtime-graph-end-to-end.sh, plan 10)", () => {
  test("1: first compile produces runtime-graph.json [.sh test 1]", () => {
    expect(initOk).toBe(true);
    expect(compile1Ok).toBe(true);
    expect(existsSync(graphPathOf(proj))).toBe(true);
  });

  test("2: graph carries workflow_id, scope, started_at, stages [.sh test 2]", () => {
    // STRONGER than the .sh's `has(...)` four-way: each field is present AND
    // populated (workflow_id/started_at are non-empty ISO strings, scope is a
    // string, stages is a non-empty array) — buildWorkflowHeader fired.
    const g = graphAfterInit;
    expect(typeof g.workflow_id).toBe("string");
    expect(g.workflow_id.length).toBeGreaterThan(0);
    expect(typeof g.scope).toBe("string");
    expect(typeof g.started_at).toBe("string");
    expect(g.started_at.length).toBeGreaterThan(0);
    expect(Array.isArray(g.stages)).toBe(true);
    expect(g.stages.length).toBeGreaterThan(0);
  });

  test("3: scope reflects the init scope (bugfix) [.sh test 3]", () => {
    expect(graphAfterInit.scope).toBe("bugfix");
  });

  test("4: first stage row has outcome 'pending' pre-approve [.sh test 4]", () => {
    // After init the first stage is [-] (in-flight) — the row is pending: a
    // STAGE_STARTED with no later STAGE_COMPLETED (pairStartedCompleted,
    // aidlc-runtime.ts:213-227 → :360-361).
    const row = rowFor(graphAfterInit, firstStage);
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("pending");
    // STRONGER: a pending row has a started_at but no completed_at.
    expect(row?.completed_at).toBeNull();
  });

  test("5: stage 1 outcome flips to approved post-approve [.sh test 5]", () => {
    const row = rowFor(graphAfterApprove, firstStage);
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("approved");
  });

  test("6: approved stage 1 has a non-null completed_at [.sh test 6]", () => {
    const row = rowFor(graphAfterApprove, firstStage);
    expect(row?.completed_at).not.toBeNull();
    expect(typeof row?.completed_at).toBe("string");
    expect((row?.completed_at ?? "").length).toBeGreaterThan(0);
  });

  test("7: graph has 2+ rows after approve (stage 1 approved + stage 2 pending) [.sh test 7]", () => {
    // Approving stage 1 emits STAGE_COMPLETED for it AND the in-line
    // STAGE_STARTED for stage 2 in the same transition, so compile #2 sees a
    // second slug and writes a second row.
    expect(graphAfterApprove.stages.length).toBeGreaterThanOrEqual(2);
    // STRONGER: at least one row beyond the first stage is pending (the
    // freshly-started stage 2 the .sh described).
    const others = graphAfterApprove.stages.filter(
      (s) => s.stage_slug !== firstStage,
    );
    expect(others.length).toBeGreaterThanOrEqual(1);
    expect(others.some((s) => s.outcome === "pending")).toBe(true);
  });

  test("8: missing memory.md → memory_entries: null (v0.4.0 backfill) [.sh test 8]", () => {
    // readMemory returns memory_entries:null (NOT 0) when no memory.md exists
    // (aidlc-runtime.ts:275-277). STRONGER than the .sh's `== "null"` string
    // compare: assert the JSON value is the actual null, not the string.
    const row = rowFor(graphAfterApprove, firstStage);
    expect(row?.memory_entries).toBeNull();
    expect(row?.memory_entries).not.toBe(0);
  });

  test("9: no MEMORY_EMPTY emitted when memory.md is absent (backfill) [.sh test 9]", () => {
    // MEMORY_EMPTY fires only for an approved row with memory_entries === 0
    // (aidlc-runtime.ts:388, :773-789). An absent memory.md yields null, so no
    // emit. STRONGER than the .sh's count for the line: assert ZERO
    // MEMORY_EMPTY blocks total AND zero for this stage specifically.
    const emptyBlocks = auditAfterApprove
      .split("\n")
      .filter((l) => l.startsWith("**Event**: MEMORY_EMPTY")).length;
    expect(emptyBlocks).toBe(0);
    expect(auditAfterApprove.includes("**Event**: MEMORY_EMPTY")).toBe(false);
  });

  test("10: re-compile produces a byte-equivalent runtime-graph.json [.sh test 10]", () => {
    // Determinism contract (aidlc-runtime.ts:18-23): re-running compile against
    // the same audit log is byte-identical. The .sh compared shasum; we compare
    // the raw bytes directly (STRONGER: also deep-equal the parsed structure,
    // which catches a whitespace-only equality that masks a value change).
    expect(rawAfterRecompile).toBe(rawBeforeRecompile);
    expect(JSON.parse(rawAfterRecompile)).toEqual(JSON.parse(rawBeforeRecompile));
  });
});
