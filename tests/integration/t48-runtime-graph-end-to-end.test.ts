// covers: subcommand:aidlc-runtime:compile
//
// t48 - runtime-graph compile end-to-end.
// Mechanism: cli. The test drives a REAL workflow through approval gates and
// invokes `aidlc-runtime.ts compile` after each transition (simulating what
// the PostToolUse Bash hook does in a session — a bun-direct invocation does
// not trigger Claude Code's hooks). It spawns the shipped tools (aidlc-utility
// intent-create, aidlc-orchestrate report, aidlc-runtime compile) via the BUN
// runtime against the .ts paths and asserts on the bytes the tools write to
// runtime-graph.json + the audit shards on disk. An in-process import would
// lose the audit-lock regime + state-machine seam exercised across multiple
// short-lived processes, so this is deliberately cli (= all spawns).
//
// Source under test (dist/claude/.claude/tools/aidlc-runtime.ts):
//   compile({ projectDir }) walks the audit + per-stage memory.md, pairs
//        STAGE_STARTED/STAGE_COMPLETED into one row per slug
//        (pairStartedCompleted), reads memory.md (readMemory - absent file =>
//        memory_entries:null, the backfill rule), and writes runtime-graph.json
//        inside withAuditLock. The WORKFLOW_STARTED row becomes the
//        workflow_id/scope/started_at header (buildWorkflowHeader). Determinism
//        contract: re-running compile against the same audit produces a
//        byte-equivalent runtime-graph.json.
//   handleCompile - the CLI shell this test spawns; prints
//        JSON.stringify(result) on success, exit 0.
//   RuntimeGraph schema: { workflow_id, scope, started_at, stages[] }; each
//        RuntimeStage carries stage_slug, started_at, completed_at,
//        memory_entries, outcome ("approved"|"failed"|"pending"), ...
//   MEMORY_EMPTY emit in compile: emitted ONLY for an approved row whose
//        memory_entries === 0. A stage with NO memory.md has memory_entries:null
//        (NOT 0), so no MEMORY_EMPTY fires.
//
// First-stage fact: `intent-create --scope bugfix` puts requirements-analysis
// in [-] (in-progress) as the first post-initialization stage of the bugfix
// scope. The test extracts the first [-] stage from the state file rather than
// hard-coding it, so a scope-spine change re-targets automatically.
//
// Test 2 asserts each of the four header keys is present AND non-empty; test 8
// also pins that memory_entries is the JSON null, not the string "null"; test 9
// reads the audit and asserts ZERO MEMORY_EMPTY blocks; test 10 compares the
// parsed graph deep-equal as well as the raw bytes.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const RUNTIME = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");

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

// One shared project drives the whole end-to-end sequence: a single workflow
// stepped through init -> compile#1 -> gate -> compile#2 -> re-compile. Built
// once in beforeAll; the spawn results + on-disk reads are captured into module
// state so each test() asserts one slice without re-driving the (slow) real
// CLIs. Cleaned in afterAll.
let proj = "";
let firstStage = "";

// intent-create makes a per-intent record under aidlc/spaces/<space>/intents/,
// and aidlc-runtime compile writes runtime-graph.json + audit shards INSIDE
// that record, not the flat aidlc-docs/. Resolve the record dir from the
// active-space + active-intent cursors, falling back to the flat layout for a
// not-yet-created project.
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
// Audit is sharded under <record>/audit/<host>-<token>.md; concat every shard
// for a content read, falling back to the flat audit.md for a not-yet-created
// project.
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

  const init = run(
    UTIL,
    ["intent-create", "--scope", "bugfix", "--project-dir", proj],
    { AIDLC_WORKFLOW_INTENT: "runtime-graph e2e" },
  );
  initOk = init.status === 0;

  // First in-flight stage from state.md (the [-] row). State lives in the
  // created intent's record, not the flat aidlc-docs/.
  const state = readFileSync(statePathOf(proj), "utf-8");
  const inProgress = state
    .split("\n")
    .find((l) => /^- \[-\]/.test(l));
  const m = inProgress?.match(/^- \[-\] ([a-z-]+)/);
  firstStage = m ? m[1] : "";

  // --- Compile #1: pre-approve, stage 1 in flight (pending row only) ------
  // Use the explicit --project-dir form (resolveProjectDir honours it), which is
  // the deterministic path.
  run(RUNTIME, ["compile", "--project-dir", proj], { CLAUDE_PROJECT_DIR: proj });
  compile1Ok = existsSync(graphPathOf(proj));
  if (compile1Ok) graphAfterInit = readGraph();

  // --- Report gate-open -> approval through the engine-owned transition seam
  // (emits GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED for stage 2), then
  // compile #2. ---
  const transitionEnv = { AIDLC_SKIP_ARTIFACT_GUARD: "1" };
  const reviewArgs = [
    "review",
    "--stage",
    firstStage,
    "--reviewer",
    "aidlc-product-lead-agent",
    "--iteration",
    "1",
    "--project-dir",
    proj,
  ];
  const reviewArtifact = join(
    recordDirOf(proj),
    "inception",
    firstStage,
    "requirements.md",
  );
  mkdirSync(dirname(reviewArtifact), { recursive: true });
  writeFileSync(reviewArtifact, "# Requirements\n");
  const requested = run(LOG, reviewArgs);
  expect(requested.status, requested.out).toBe(0);
  expect(requested.out).toContain('"emitted":"REVIEW_REQUESTED"');
  appendFileSync(
    reviewArtifact,
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
  const reviewed = run(LOG, [
    ...reviewArgs,
    "--verdict",
    "READY",
  ]);
  expect(reviewed.status, reviewed.out).toBe(0);
  expect(reviewed.out).toContain('"emitted":"REVIEW_COMPLETED"');
  const gate = run(
    ORCHESTRATE,
    [
      "report",
      "--stage",
      firstStage,
      "--result",
      "awaiting-approval",
      "--project-dir",
      proj,
    ],
    transitionEnv,
  );
  if (gate.status !== 0 || !gate.out.includes('"kind":"print"')) {
    throw new Error(`gate report failed: ${gate.out}`);
  }
  const approval = run(
    ORCHESTRATE,
    [
      "report",
      "--stage",
      firstStage,
      "--result",
      "approved",
      "--user-input",
      "looks good",
      "--project-dir",
      proj,
    ],
    transitionEnv,
  );
  if (approval.status !== 0 || !approval.out.includes('"kind":"done"')) {
    throw new Error(`approval report failed: ${approval.out}`);
  }
  run(RUNTIME, ["compile", "--project-dir", proj], { CLAUDE_PROJECT_DIR: proj });
  graphAfterApprove = readGraph();
  rawBeforeRecompile = readFileSync(graphPathOf(proj), "utf-8");
  auditAfterApprove = readAudit(proj);

  // --- Idempotency: re-compile, assert byte-equivalent. ------
  run(RUNTIME, ["compile", "--project-dir", proj], { CLAUDE_PROJECT_DIR: proj });
  rawAfterRecompile = readFileSync(graphPathOf(proj), "utf-8");
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    // Each field is present AND populated (workflow_id/started_at are non-empty
    // ISO strings, scope is a string, stages is a non-empty array), so
    // buildWorkflowHeader fired.
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
    // STAGE_STARTED with no later STAGE_COMPLETED (pairStartedCompleted in
    // aidlc-runtime.ts).
    const row = rowFor(graphAfterInit, firstStage);
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("pending");
    // A pending row has a started_at but no completed_at.
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
    // At least one row beyond the first stage is pending (the freshly-started
    // stage 2).
    const others = graphAfterApprove.stages.filter(
      (s) => s.stage_slug !== firstStage,
    );
    expect(others.length).toBeGreaterThanOrEqual(1);
    expect(others.some((s) => s.outcome === "pending")).toBe(true);
  });

  test("8: missing memory.md → memory_entries: null (v0.4.0 backfill) [.sh test 8]", () => {
    // readMemory returns memory_entries:null (NOT 0) when no memory.md exists.
    // Assert the JSON value is the actual null, not the string "null".
    const row = rowFor(graphAfterApprove, firstStage);
    expect(row?.memory_entries).toBeNull();
    expect(row?.memory_entries).not.toBe(0);
  });

  test("9: no MEMORY_EMPTY emitted when memory.md is absent (backfill) [.sh test 9]", () => {
    // MEMORY_EMPTY fires only for an approved row with memory_entries === 0 (inside
    // compile in aidlc-runtime.ts). An absent memory.md yields null, so no emit.
    // Assert ZERO MEMORY_EMPTY blocks total.
    const emptyBlocks = auditAfterApprove
      .split("\n")
      .filter((l) => l.startsWith("**Event**: MEMORY_EMPTY")).length;
    expect(emptyBlocks).toBe(0);
    expect(auditAfterApprove.includes("**Event**: MEMORY_EMPTY")).toBe(false);
  });

  test("10: re-compile produces a byte-equivalent runtime-graph.json [.sh test 10]", () => {
    // Determinism contract (aidlc-runtime.ts file header): re-running compile
    // against the same audit log is byte-identical. Compare the raw bytes directly
    // and also deep-equal the parsed structure.
    expect(rawAfterRecompile).toBe(rawBeforeRecompile);
    expect(JSON.parse(rawAfterRecompile)).toEqual(JSON.parse(rawBeforeRecompile));
  });
});
