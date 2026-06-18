// covers: subcommand:aidlc-runtime:compile
//
// CLI-contract port of tests/integration/t102-memory-roundtrip.sh (TAP plan 6),
// mechanism = cli. The .sh exercises the producer→consumer round-trip the PR
// 13 card implies: the producer side writes memory.md from the SHIPPED milestone 13
// template (knowledge/aidlc-shared/memory-template.md) and appends real
// entries; the milestone 8 consumer — `aidlc-runtime.ts compile`, the subcommand the
// PostToolUse hook fires — reads them. Every consumer assertion that shelled
// out to `bun aidlc-runtime.ts compile` is preserved here by SPAWNING the real
// CLI via node:child_process spawnSync (the run_compile helper, t102:79-82),
// asserting on the runtime-graph.json the tool writes + the MEMORY_EMPTY rows
// it appends to audit.md — the PROCESS boundary plus those file side effects.
//
// MECHANISM SPLIT: cases 2-6 are spawn-based (the compile contract). Case 1
// is the ONE producer-side check the .sh did NOT route through compile — it
// `cp`s the template, `grep -cE '^## '` counts the 4 H2 headings, and imports
// parseMemoryHeadings (aidlc-lib.ts) via `bun -e` to confirm a fresh template
// parses to total 0 (the MEMORY_EMPTY trigger). The .sh's Case 1 is an
// in-process import, not a compile spawn, so the faithful port imports the
// same pure function directly (same observable: the template's entry total)
// and counts headings with the same regex. spawnCount = cases 2-6;
// inProcess = case 1 (matching the .sh's own producer/consumer split).
//
// EQUAL-OR-STRONGER PARITY (every .sh case maps to a test() below):
//   - .sh Case 1 (H2==4 && FRESH_TOTAL==0)            -> test "1": headings
//       count === 4 AND parseMemoryHeadings(template).total === 0. Same two
//       observables, asserted separately (clearer than the .sh's combined &&).
//   - .sh Case 2 (3 entries -> memory_entries==3 && breakdown_sum==3) ->
//       test "2": graph.stages[0].memory_entries === 3 AND the breakdown
//       (interpretations+deviations+tradeoffs+open_questions) sums to 3.
//       STRONGER: also pins the per-heading split (2 interpretations + 1
//       tradeoff = the exact entries appended), which the .sh's bare sum
//       could not distinguish from any other 3-entry shape.
//   - .sh Case 3 (template-only approved -> EMPTY_COUNT==1)  -> test "3":
//       memoryEmptyCount === 1 (mirrors the .sh's `grep -c "^**Event**:
//       MEMORY_EMPTY"`); STRONGER: also asserts memory_entries === 0 (the
//       trigger condition the emit depends on).
//   - .sh Case 4 (N>=1 entries -> EMPTY_COUNT==0)      -> test "4":
//       memoryEmptyCount === 0 + memory_entries === 1 (the guard's input).
//   - .sh Case 5 (persists across 2 compiles, entries==1) -> test "5":
//       memory.md still exists after a 2nd compile AND memory_entries === 1
//       on the re-compiled graph. Same two observables.
//   - .sh Case 6 (absent memory.md -> entries==null && EMPTY_COUNT==0) ->
//       test "6": memory_entries === null, memory_breakdown === null
//       (STRONGER: the .sh only checked entries; breakdown is the paired
//       backfill field), AND memoryEmptyCount === 0 (no-storm).
//
// 6 .sh `ok`/`assert_eq` lines -> 6 test() cases here. exit-code STRONGER add:
// every compile spawn pins rc === 0 (the .sh discarded `run_compile`'s stdout
// with `>/dev/null` and never inspected $?; we additionally assert clean exit).
//
// FIXTURE DISCIPLINE (mirrors the .sh's make_project + mktemp -d + rm -rf):
//   - Each case uses a FRESH temp project dir (mkdtempSync) wrapped in
//     toPortablePath — `compile` WRITES runtime-graph.json + MEMORY_EMPTY
//     audit rows under CLAUDE_PROJECT_DIR, so a shared dir would
//     cross-contaminate; on native Windows the raw mktemp path can't
//     round-trip through the tool's forward-slash path helpers, so it is
//     cygpath-rewritten (mirrors createTestProject / t90's makeProject).
//   - The audit.md / aidlc-state.md combos are built inline from the .sh's
//     AUDIT_APPROVED + STATE_FEATURE heredocs (t102:37-68). memory.md is
//     seeded by copying the SHIPPED template (not a tests/fixtures/** copy)
//     and then string-replacing real entries in, exactly as the .sh's
//     `cp "$TEMPLATE"` + `bun -e ... raw.replace(...)` did. NOTHING is
//     written under tests/fixtures/**. All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// Producer-side pure function — Case 1's `bun -e import parseMemoryHeadings`.
import {
  auditFilePath,
  parseMemoryHeadings,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { toPortablePath } from "../harness/fixtures.ts";

// P9: with no intent cursor seeded, compile resolves the BARE space record root
// (docsRoot -> spaceRecordRoot) at aidlc/spaces/default/intents/. State,
// runtime-graph, the per-stage memory.md, and the per-clone audit SHARD all
// live under it (the flat aidlc-docs/ root is retired — there is no fallback);
// compile reads each stage's memory.md at the bare-space-prefixed memory_path.
const RECORD_REL = join("aidlc", "spaces", "default", "intents");
function recordRoot(proj: string): string {
  return join(proj, RECORD_REL);
}

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const RUNTIME_TS = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
// The SHIPPED milestone 13 template the .sh `cp`s (t102:29).
const TEMPLATE = join(AIDLC_SRC, "knowledge", "aidlc-shared", "memory-template.md");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface SpawnResult {
  rc: number;
  out: string;
}

/** run_compile (t102:79-82): CLAUDE_PROJECT_DIR=<proj> bun RUNTIME_TS compile [args], 2>&1. */
function runCompile(proj: string, ...args: string[]): SpawnResult {
  const res = spawnSync(BUN, [RUNTIME_TS, "compile", ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// Standard 1-stage approved audit, intent-capture / ideation (t102:37-62).
const AUDIT_APPROVED = `## Workflow Start
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

---`;

// state cursor (t102:64-68).
const STATE_FEATURE = [
  "- **Scope**: feature",
  "- **Current Stage**: scope-definition",
].join("\n");

/**
 * make_project (t102:70-77): fresh temp project with AUDIT_APPROVED +
 * STATE_FEATURE under aidlc-docs/. toPortablePath for the Windows round-trip
 * (the tool resolves audit/graph paths through forward-slash helpers).
 */
function makeProject(): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t102-")));
  tempDirs.push(proj);
  mkdirSync(recordRoot(proj), { recursive: true });
  // Seed the DETERMINISTIC audit shard the compile tool resolves (auditFilePath)
  // so readAllAuditShards() sees the WORKFLOW_STARTED trail.
  const shard = auditFilePath(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, AUDIT_APPROVED, "utf-8");
  writeFileSync(join(recordRoot(proj), "aidlc-state.md"), STATE_FEATURE, "utf-8");
  return proj;
}

/** memdir (t102:84): the per-stage memory dir for intent-capture (ideation phase). */
function memDir(proj: string): string {
  return join(recordRoot(proj), "ideation", "intent-capture");
}

/** Path to the memory.md the .sh `cp`s the template into. */
function memFile(proj: string): string {
  return join(memDir(proj), "memory.md");
}

/** Copy the SHIPPED template into the stage's memory.md (mirrors `cp "$TEMPLATE" ...`). */
function seedTemplateMemory(proj: string): void {
  mkdirSync(memDir(proj), { recursive: true });
  cpSync(TEMPLATE, memFile(proj));
}

const graphPath = (proj: string): string =>
  join(recordRoot(proj), "runtime-graph.json");

/** Parse the runtime-graph.json the tool wrote. */
// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary graph shape
function readGraph(proj: string): any {
  return JSON.parse(readFileSync(graphPath(proj), "utf-8"));
}

/**
 * Count MEMORY_EMPTY rows, mirroring the .sh's
 * `grep -c "^\*\*Event\*\*: MEMORY_EMPTY"` (t102:131,146,178). Reads the merged
 * audit shards (compile appends MEMORY_EMPTY to the resolved shard).
 */
function memoryEmptyCount(proj: string): number {
  return readAllAuditShards(proj)
    .split("\n")
    .filter((l) => l === "**Event**: MEMORY_EMPTY").length;
}

describe("t102 memory.md producer -> runtime compile round-trip (migrated from t102-memory-roundtrip.sh, plan 6)", () => {
  // --- Case 1: memory.md created from template at start ---------------------
  // PRODUCER-side, in-process: the .sh `cp`s the template, counts `## ` H2
  // headings (must be 4), and imports parseMemoryHeadings to confirm a fresh
  // template parses to total 0 (the MEMORY_EMPTY trigger). Both observables
  // preserved exactly.
  test("1: memory.md created from template at start (4 headings, parses to total 0)", () => {
    const proj = makeProject();
    seedTemplateMemory(proj);
    const raw = readFileSync(memFile(proj), "utf-8");
    const h2 = raw.split("\n").filter((l) => /^## /.test(l)).length;
    expect(h2).toBe(4);
    expect(parseMemoryHeadings(raw).total).toBe(0);
  });

  // --- Case 2: N=3 real entries -> compile records memory_entries === 3 -----
  test("2: N=3 real entries -> memory_entries === 3, breakdown sums to 3 (milestone 8 reads milestone 13's file)", () => {
    const proj = makeProject();
    seedTemplateMemory(proj);
    // Append 3 real entries: 2 interpretations + 1 tradeoff (t102:108-114).
    let raw = readFileSync(memFile(proj), "utf-8");
    raw = raw.replace(
      "## Interpretations\n",
      "## Interpretations\n- 2026-05-29T10:00:00Z — chose A over B\n- 2026-05-29T10:01:00Z — confirmed C\n",
    );
    raw = raw.replace(
      "## Tradeoffs\n",
      "## Tradeoffs\n- 2026-05-29T10:02:00Z — accepted D for E\n",
    );
    writeFileSync(memFile(proj), raw, "utf-8");
    const r = runCompile(proj);
    expect(r.rc).toBe(0); // STRONGER: .sh discarded stdout; we pin clean exit
    const g = readGraph(proj);
    expect(g.stages[0].memory_entries).toBe(3);
    const b = g.stages[0].memory_breakdown;
    expect(b.interpretations + b.deviations + b.tradeoffs + b.open_questions).toBe(3);
    // STRONGER than the .sh's bare sum: pin the exact per-heading split.
    expect(b.interpretations).toBe(2);
    expect(b.tradeoffs).toBe(1);
    expect(b.deviations).toBe(0);
    expect(b.open_questions).toBe(0);
  });

  // --- Case 3: template-only (zero-entry) approved stage emits MEMORY_EMPTY -
  test("3: template-only (zero-entry) approved stage -> one MEMORY_EMPTY (signal survives end-to-end)", () => {
    const proj = makeProject();
    seedTemplateMemory(proj);
    const r = runCompile(proj);
    expect(r.rc).toBe(0);
    const g = readGraph(proj);
    // STRONGER: the trigger condition the emit depends on.
    expect(g.stages[0].memory_entries).toBe(0);
    expect(memoryEmptyCount(proj)).toBe(1);
  });

  // --- Case 4: N>=1 entries does NOT emit MEMORY_EMPTY ----------------------
  test("4: stage with N>=1 entries -> no MEMORY_EMPTY (guard correctness)", () => {
    const proj = makeProject();
    seedTemplateMemory(proj);
    // Append 1 deviation entry (t102:139-144).
    let raw = readFileSync(memFile(proj), "utf-8");
    raw = raw.replace(
      "## Deviations\n",
      "## Deviations\n- 2026-05-29T10:00:00Z — skipped F\n",
    );
    writeFileSync(memFile(proj), raw, "utf-8");
    const r = runCompile(proj);
    expect(r.rc).toBe(0);
    const g = readGraph(proj);
    // STRONGER: the guard's input (one entry -> not empty).
    expect(g.stages[0].memory_entries).toBe(1);
    expect(memoryEmptyCount(proj)).toBe(0);
  });

  // --- Case 5: file persists across a second compile (across sessions) ------
  test("5: memory.md persists across sessions; re-compile still reads memory_entries", () => {
    const proj = makeProject();
    seedTemplateMemory(proj);
    // Append 1 open-question entry (t102:154-159).
    let raw = readFileSync(memFile(proj), "utf-8");
    raw = raw.replace(
      "## Open questions\n",
      "## Open questions\n- 2026-05-29T10:00:00Z — confirm retention window\n",
    );
    writeFileSync(memFile(proj), raw, "utf-8");
    const r1 = runCompile(proj);
    expect(r1.rc).toBe(0);
    // Run-2: a fresh compile (a later session) still reads the file.
    const r2 = runCompile(proj);
    expect(r2.rc).toBe(0);
    expect(existsSync(memFile(proj))).toBe(true);
    const g = readGraph(proj);
    expect(g.stages[0].memory_entries).toBe(1);
  });

  // --- Case 6: absent memory.md -> memory_entries: null, no MEMORY_EMPTY -----
  test("6: absent memory.md -> memory_entries: null + no MEMORY_EMPTY (no-storm backfill)", () => {
    const proj = makeProject();
    // No memory.md created (a stage the orchestrator never touched).
    const r = runCompile(proj);
    expect(r.rc).toBe(0);
    const g = readGraph(proj);
    expect(g.stages[0].memory_entries).toBeNull();
    // STRONGER: the paired backfill field the .sh did not check.
    expect(g.stages[0].memory_breakdown).toBeNull();
    expect(memoryEmptyCount(proj)).toBe(0);
  });
});
