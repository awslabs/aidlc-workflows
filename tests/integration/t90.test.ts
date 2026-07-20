// covers: subcommand:aidlc-runtime:compile
//
// CLI-contract port of tests/integration/t90-runtime-compile.sh (TAP plan 29),
// mechanism = cli. Equal-fidelity migration: every .sh assertion that
// shelled out to `bun aidlc-runtime.ts compile ...` (and one `read ...`
// at case 14) is preserved by SPAWNING the real CLI via node:child_process
// spawnSync, asserting on res.status / res.stdout+stderr and the file
// effects the tool writes (runtime-graph.json + the MEMORY_EMPTY rows it
// appends to audit.md). The contract under test is the PROCESS boundary
// plus those side effects, so it stays a spawn — an in-process compile()
// twin would lose the exit-0-on-missing-state half (case 8) and the
// handleCompile process.exit shell the .sh's `$?` arm relies on.
//
// SPAWN vs IN-PROCESS split: ALL cases are spawn-based. Every behaviour
// (pairing outcomes, MEMORY_EMPTY emit/suppress, re-init filtering,
// idempotency hashing, missing-state exit code, the read subcommand's
// null-tolerant parse) is observed through the real CLI subprocess + the
// runtime-graph.json / audit.md it writes. spawnCount = all; inProcess = 0.
//
// EQUAL-OR-STRONGER PARITY: the .sh used `jq -r '.stages[0].outcome'` etc.
// to project single scalars out of runtime-graph.json. In-process we
// JSON.parse the graph the tool wrote and assert against the real object
// (e.g. expect(graph.stages[0].outcome).toBe("approved")) — same observable
// (the materialised field value), expressed against the actual return shape
// rather than its jq projection. Cases that grep `^\*\*Event\*\*: MEMORY_EMPTY`
// become a line-filter count over the same audit.md the tool appended to.
// (The .sh's Case 6 --test-run check was dropped per #369 when the test-run
// mechanism was removed.) STRONGER additions are noted inline (S1..S3).
//
// FIXTURE DISCIPLINE (mirrors the .sh's make_project + mktemp -d + rm -rf):
//   - Each case uses a FRESH temp project dir (mkdtempSync) wrapped in
//     toPortablePath — `compile` WRITES runtime-graph.json + MEMORY_EMPTY
//     audit rows under CLAUDE_PROJECT_DIR, so a shared dir would
//     cross-contaminate. All temp dirs are cleaned in afterAll. The tool
//     writes audit/graph paths via forward-slash helpers, so on native
//     Windows the project dir must be cygpath-rewritten or the read-back
//     finds the wrong path (mirrors createTestProject / t92's makeProj).
//   - NOTHING is written under tests/fixtures/**; audit + state + memory.md
//     combos are built inline (the .sh's L1 rationale: too combinatorial
//     for an on-disk fixtures dir).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";
import {
  auditFilePath,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// P9: with no intent cursor seeded, the compile tool resolves the BARE space
// record root (docsRoot -> spaceRecordRoot) at aidlc/spaces/default/intents/.
// State, runtime-graph, per-stage memory, and the per-clone audit SHARD all
// live under it (the flat aidlc-docs/ root is retired — there is no fallback).
const RECORD_REL = join("aidlc", "spaces", "default", "intents");
function recordRoot(proj: string): string {
  return join(proj, RECORD_REL);
}

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const RUNTIME_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-runtime.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface SpawnResult {
  rc: number;
  out: string;
}

/** run_compile (t90:47-50): CLAUDE_PROJECT_DIR=<proj> bun RUNTIME_TS compile [args], 2>&1. */
function runCompile(proj: string, ...args: string[]): SpawnResult {
  const res = spawnSync(BUN, [RUNTIME_TS, "compile", ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** runtime read <slug> — used by case 14's schema-nullability check. */
function runRead(proj: string, slug: string): SpawnResult {
  const res = spawnSync(BUN, [RUNTIME_TS, "read", slug], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * make_project (t90:36-45): fresh temp project with the given audit.md +
 * aidlc-state.md under aidlc-docs/. toPortablePath: the tool resolves
 * audit/graph paths through forward-slash helpers, so on Windows the raw
 * mktemp path can't round-trip — mirrors createTestProject (fixtures.ts).
 */
function makeProject(audit: string, state: string): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t90-")));
  tempDirs.push(proj);
  mkdirSync(recordRoot(proj), { recursive: true });
  // Seed the DETERMINISTIC audit shard the compile tool resolves
  // (auditFilePath -> the bare space record root's audit/<host>-<clone>.md) so
  // its readAllAuditShards() merge sees this trail.
  const shard = auditFilePath(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, audit, "utf-8");
  writeFileSync(join(recordRoot(proj), "aidlc-state.md"), state, "utf-8");
  return proj;
}

/** Bare temp project with the record shell but no state/audit (case 8). */
function makeBareProject(): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t90-")));
  tempDirs.push(proj);
  mkdirSync(recordRoot(proj), { recursive: true });
  return proj;
}

const graphPath = (proj: string): string =>
  join(recordRoot(proj), "runtime-graph.json");

/** Parse the runtime-graph.json the tool wrote. */
// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary graph shape
function readGraph(proj: string): any {
  return JSON.parse(readFileSync(graphPath(proj), "utf-8"));
}

/** Append-only audit writes (case 13) target the resolved shard directly. */
const auditShardPath = (proj: string): string => auditFilePath(proj);

/** Read the merged audit trail (per-clone shards; one here). */
function readAudit(proj: string): string {
  return readAllAuditShards(proj);
}

/**
 * Count MEMORY_EMPTY rows, mirroring the .sh's
 * `grep -c "^\*\*Event\*\*: MEMORY_EMPTY"`.
 */
function memoryEmptyCount(proj: string): number {
  return readAudit(proj)
    .split("\n")
    .filter((l) => l === "**Event**: MEMORY_EMPTY").length;
}

/**
 * The .sh writes per-stage memory.md under aidlc-docs/<phase>/<slug>/; P9
 * reroots that under the bare space record root. intent-capture lives in the
 * ideation phase (stage-graph.json).
 */
function writeMemory(proj: string, phase: string, slug: string, body: string): void {
  const dir = join(recordRoot(proj), phase, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.md"), body, "utf-8");
}

const sha1 = (proj: string): string =>
  createHash("sha1").update(readFileSync(graphPath(proj))).digest("hex");

const STATE_FEATURE = ["- **Scope**: feature", "- **Current Stage**: scope-definition"].join(
  "\n",
);

// Synthetic single-stage pair, field shapes copied exactly from
// handleSingleReport's append-batch transaction (aidlc-orchestrate.ts):
// STAGE_STARTED carries Stage + Agent + Workflow; STAGE_COMPLETED carries
// Stage + Details + Workflow. The Workflow value is the synthetic
// `single-stage:<slug>` id that marks the pair as belonging to NO main
// workflow. application-design (inception, aidlc-architect-agent per
// stage-graph.json) is deliberately UNRELATED to the main workflow's slugs.
const SINGLE_STAGE_PAIR = `## Stage Start
**Timestamp**: 2026-05-27T10:20:00Z
**Event**: STAGE_STARTED
**Stage**: application-design
**Agent**: aidlc-architect-agent
**Workflow**: single-stage:application-design

---

## Stage Completion
**Timestamp**: 2026-05-27T10:25:00Z
**Event**: STAGE_COMPLETED
**Stage**: application-design
**Details**: Single-stage run of application-design completed
**Workflow**: single-stage:application-design

---
`;

// Standard 1-stage approved audit (t90:53-78).
const AUDIT_ONE_APPROVED = `## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature
**Request**: /aidlc feature

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
**Details**: done

---
`;

describe("t90 aidlc-runtime compile — CLI contract (migrated from t90-runtime-compile.sh, plan 29)", () => {
  // --- Case 1: one approved stage -> one approved row + memory_entries 1 ---
  test("1: one approved stage -> outcome approved, memory_entries 1", () => {
    const proj = makeProject(AUDIT_ONE_APPROVED, STATE_FEATURE);
    writeMemory(proj, "ideation", "intent-capture", "## Interpretations\n- entry one\n");
    const r = runCompile(proj);
    expect(r.rc).toBe(0); // S1: .sh discarded stdout; we also pin clean exit
    const g = readGraph(proj);
    expect(g.stages[0].outcome).toBe("approved");
    expect(g.stages[0].memory_entries).toBe(1);
  });

  // --- Case 2: STAGE_STARTED without COMPLETED -> pending, completed_at null ---
  test("2: STAGE_STARTED without COMPLETED -> pending, completed_at null", () => {
    const auditPending = `## Workflow Start
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
`;
    const proj = makeProject(auditPending, STATE_FEATURE);
    runCompile(proj);
    const g = readGraph(proj);
    expect(g.stages[0].outcome).toBe("pending");
    expect(g.stages[0].completed_at).toBeNull();
  });

  // --- Case 3: re-jump -> one row per slug, latest STARTED wins (pending) ---
  test("3: re-jump -> 1 row, pending, started_at = latest STARTED", () => {
    const auditRejump = `## Workflow Start
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
**Timestamp**: 2026-05-27T10:02:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Stage Start
**Timestamp**: 2026-05-27T10:10:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---
`;
    const proj = makeProject(auditRejump, STATE_FEATURE);
    runCompile(proj);
    const g = readGraph(proj);
    expect(g.stages).toHaveLength(1);
    expect(g.stages[0].outcome).toBe("pending");
    expect(g.stages[0].started_at).toBe("2026-05-27T10:10:00Z");
  });

  // --- Case 4: missing memory.md -> entries/breakdown null, no MEMORY_EMPTY ---
  test("4: missing memory.md -> memory_entries null, breakdown null, no MEMORY_EMPTY", () => {
    const proj = makeProject(AUDIT_ONE_APPROVED, STATE_FEATURE);
    // no memory.md created
    runCompile(proj);
    const g = readGraph(proj);
    expect(g.stages[0].memory_entries).toBeNull();
    expect(g.stages[0].memory_breakdown).toBeNull();
    expect(memoryEmptyCount(proj)).toBe(0);
  });

  // --- Case 5: empty memory.md -> memory_entries 0 + one MEMORY_EMPTY ---
  test("5: empty memory.md (approved) -> memory_entries 0, one MEMORY_EMPTY", () => {
    const proj = makeProject(AUDIT_ONE_APPROVED, STATE_FEATURE);
    writeMemory(proj, "ideation", "intent-capture", "\n");
    runCompile(proj);
    const g = readGraph(proj);
    expect(g.stages[0].memory_entries).toBe(0);
    expect(memoryEmptyCount(proj)).toBe(1);
  });

  // Case 6 (--test-run -> MEMORY_EMPTY carries Test-Run: true) was dropped per
  // #369: the engine removed both --test-run on compile and the Test-Run stamp.

  // --- Case 7: idempotency -> byte-equivalent runtime-graph.json ---
  test("7: two compiles -> byte-equivalent runtime-graph.json", () => {
    const proj = makeProject(AUDIT_ONE_APPROVED, STATE_FEATURE);
    writeMemory(proj, "ideation", "intent-capture", "## Interpretations\n- entry\n");
    runCompile(proj);
    const hash1 = sha1(proj);
    runCompile(proj);
    const hash2 = sha1(proj);
    expect(hash2).toBe(hash1);
  });

  // --- Case 8: missing state.md -> exit 0, no graph written ---
  test("8: missing state.md -> exit 0, no runtime-graph.json written", () => {
    const proj = makeBareProject();
    const r = runCompile(proj);
    expect(r.rc).toBe(0); // S2: .sh swallowed $? with `|| true`; we pin exit 0
    expect(existsSync(graphPath(proj))).toBe(false);
  });

  // --- Case 9: approved + non-zero entries -> NO MEMORY_EMPTY (negative cover) ---
  test("9: approved + populated memory.md -> memory_entries 2, no MEMORY_EMPTY", () => {
    const proj = makeProject(AUDIT_ONE_APPROVED, STATE_FEATURE);
    writeMemory(proj, "ideation", "intent-capture", "## Interpretations\n- one entry\n- another entry\n");
    runCompile(proj);
    const g = readGraph(proj);
    expect(g.stages[0].memory_entries).toBe(2);
    expect(memoryEmptyCount(proj)).toBe(0);
  });

  // --- Case 10: ISO-second tie -> deterministic source-order rows + stable hash ---
  test("10: ISO-second tie -> source-order rows, ordering deterministic across compiles", () => {
    const auditCollision = `## Workflow Start
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

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: scope-definition
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Stage Completion
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: scope-definition

---
`;
    const proj = makeProject(auditCollision, STATE_FEATURE);
    runCompile(proj);
    const g = readGraph(proj);
    expect(g.stages[0].stage_slug).toBe("intent-capture");
    expect(g.stages[1].stage_slug).toBe("scope-definition");
    const hash1 = sha1(proj);
    runCompile(proj);
    const hash2 = sha1(proj);
    expect(hash2).toBe(hash1);
  });

  // --- Case 11: re-init -> latest WORKFLOW_STARTED wins, prior rows filtered ---
  test("11: re-init -> workflow_id is latest WORKFLOW_STARTED, 1 row, pending", () => {
    const auditReinit = `## Workflow Start
**Timestamp**: 2026-05-27T08:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: bugfix

---

## Stage Start
**Timestamp**: 2026-05-27T08:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T08:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Workflow Start
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
`;
    const proj = makeProject(auditReinit, STATE_FEATURE);
    runCompile(proj);
    const g = readGraph(proj);
    expect(g.workflow_id).toBe("2026-05-27T10:00:00Z");
    expect(g.stages).toHaveLength(1);
    expect(g.stages[0].outcome).toBe("pending");
  });

  // --- Case 12: MEMORY_EMPTY re-emit suppression across 3 compiles ---
  // Past timestamps (2024) so compile-time wallclock is definitely after
  // completed_at, exercising the suppression scan.
  const AUDIT_PAST_APPROVED = `## Workflow Start
**Timestamp**: 2024-01-01T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2024-01-01T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2024-01-01T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---
`;

  test("12: re-emit suppression -> first compile emits, 2nd + 3rd suppress (count stays 1)", () => {
    const proj = makeProject(AUDIT_PAST_APPROVED, STATE_FEATURE);
    writeMemory(proj, "ideation", "intent-capture", "\n");
    runCompile(proj);
    expect(memoryEmptyCount(proj)).toBe(1);
    runCompile(proj);
    expect(memoryEmptyCount(proj)).toBe(1);
    runCompile(proj);
    expect(memoryEmptyCount(proj)).toBe(1);
  });

  // --- Case 13: re-approve still-empty stage -> fresh MEMORY_EMPTY emit ---
  // compile #1 emits MEMORY_EMPTY at wallclock-T1. Append a re-jump whose new
  // STAGE_COMPLETED Timestamp is "now" (wallclock-after-T1). compile #2 sees
  // prior MEMORY_EMPTY @ T1 < new completed_at -> emit fires (total 2); compile
  // #3 sees prior @ T2 >= new completed_at -> suppressed.
  test("13: re-approve still-empty -> fresh MEMORY_EMPTY (total 2), then suppressed", async () => {
    const proj = makeProject(AUDIT_PAST_APPROVED, STATE_FEATURE);
    writeMemory(proj, "ideation", "intent-capture", "\n");
    runCompile(proj);
    // Sleep 2s so wallclock advances past compile-#1's MEMORY_EMPTY Timestamp.
    await new Promise((r) => setTimeout(r, 2000));
    const newCompleted = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const rejump = `
## Stage Start
**Timestamp**: ${newCompleted}
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: ${newCompleted}
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---
`;
    const f = auditShardPath(proj);
    writeFileSync(f, readFileSync(f, "utf-8") + rejump, "utf-8");
    await new Promise((r) => setTimeout(r, 2000));
    runCompile(proj);
    expect(memoryEmptyCount(proj)).toBe(2);
    runCompile(proj);
    expect(memoryEmptyCount(proj)).toBe(2);
  }, 30000);

  // --- Case 14: schema nullability -> read parses instance-bearing graph ---
  // The TS interface must accept null started_at/agent on an instance-bearing
  // parent row. We hand-write such a graph, then exercise `read` over the CLI.
  test("14: read parses null started_at/agent + instances[] without throwing", () => {
    const proj = makeProject(AUDIT_ONE_APPROVED, STATE_FEATURE);
    const handGraph = {
      workflow_id: "2024-01-01T10:00:00Z",
      scope: "feature",
      started_at: "2024-01-01T10:00:00Z",
      stages: [
        {
          stage_slug: "code-generation",
          started_at: null,
          completed_at: null,
          agent: null,
          memory_path: "aidlc-docs/construction/code-generation/memory.md",
          memory_entries: null,
          memory_breakdown: null,
          sensor_firings: [],
          outcome: "pending",
          learnings_captured: null,
          instances: [
            {
              bolt: "auth-flow",
              worktree: ".aidlc/worktrees/bolt-auth-flow/",
              started_at: "2024-01-01T11:00:00Z",
              completed_at: null,
              memory_path:
                ".aidlc/worktrees/bolt-auth-flow/aidlc-docs/construction/code-generation/memory.md",
              memory_entries: 2,
              memory_breakdown: {
                interpretations: 1,
                deviations: 1,
                tradeoffs: 0,
                open_questions: 0,
              },
              sensor_firings: [],
              outcome: "pending",
            },
          ],
        },
      ],
    };
    writeFileSync(graphPath(proj), `${JSON.stringify(handGraph, null, 2)}\n`, "utf-8");
    const r = runRead(proj, "code-generation");
    expect(r.rc).toBe(0); // S3: .sh only checked the jq -e predicate; we also pin exit 0
    const row = JSON.parse(r.out);
    expect(row.started_at).toBeNull();
    expect(row.agent).toBeNull();
    expect(row.instances).toHaveLength(1);
  });

  // --- Case 15: --single synthetic rows never pair into the main graph ---
  // A `--single` stage-runner run commits a STAGE_STARTED/STAGE_COMPLETED
  // pair tagged `**Workflow**: single-stage:<slug>` (audit-only). The
  // pairing must skip those rows: the stage-runner contract promises a
  // single run "never advances your main workflow", and that includes its
  // compiled mirror — without the skip, the synthetic slug lands in the
  // MAIN workflow's runtime-graph.json as "approved" under the main
  // workflow_id.
  test("15: single-stage synthetic pair is absent from the main graph; real slug present", () => {
    const proj = makeProject(AUDIT_ONE_APPROVED + SINGLE_STAGE_PAIR, STATE_FEATURE);
    writeMemory(proj, "ideation", "intent-capture", "## Interpretations\n- entry one\n");
    const r = runCompile(proj);
    expect(r.rc).toBe(0);
    const g = readGraph(proj);
    const slugs = g.stages.map((s: { stage_slug: string }) => s.stage_slug);
    expect(slugs).toContain("intent-capture");
    expect(slugs).not.toContain("application-design");
    expect(g.stages).toHaveLength(1);
    expect(g.stages[0].outcome).toBe("approved");
  });

  // --- Case 16: rows WITHOUT a Workflow field are main-workflow rows ---
  // Main-workflow STAGE_* rows (aidlc-state.ts emitters) carry NO Workflow
  // field — the filter must be absence-tolerant, only skipping values that
  // start with `single-stage:`. AUDIT_ONE_APPROVED's rows have no Workflow
  // field and must keep pairing (guards against an over-eager filter that
  // requires the field).
  test("16: Workflow-field-less rows still pair (absence means main workflow)", () => {
    const proj = makeProject(AUDIT_ONE_APPROVED, STATE_FEATURE);
    const r = runCompile(proj);
    expect(r.rc).toBe(0);
    const g = readGraph(proj);
    expect(g.stages).toHaveLength(1);
    expect(g.stages[0].stage_slug).toBe("intent-capture");
    expect(g.stages[0].outcome).toBe("approved");
  });

  // --- Case 17: single-stage-only audit (no WORKFLOW_STARTED) -> empty graph ---
  // Negative guard pinning the EXISTING no-main-workflow contract: with no
  // WORKFLOW_STARTED row at all, buildWorkflowHeader returns null and compile
  // writes the empty graph (workflow_id "", stages []) — the synthetic pair
  // must not conjure a workflow or a stage row.
  test("17: synthetic-rows-only audit (no WORKFLOW_STARTED) -> empty graph, no stage rows", () => {
    const proj = makeProject(SINGLE_STAGE_PAIR, STATE_FEATURE);
    const r = runCompile(proj);
    expect(r.rc).toBe(0);
    const g = readGraph(proj);
    expect(g.workflow_id).toBe("");
    expect(g.stages).toHaveLength(0);
  });
});
