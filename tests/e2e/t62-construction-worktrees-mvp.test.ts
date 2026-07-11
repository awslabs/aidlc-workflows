// covers: subcommand:aidlc-bolt:dispatch-event, subcommand:aidlc-utility:init
//
// Port of tests/e2e/t62-construction-worktrees-mvp.sh (TAP plan 5),
// mechanism = mixed. The .sh proved the v0.4.0 milestone 13 per-scope Construction-
// worktrees orchestration contract holds for the `mvp` scope (skeleton-on;
// practices-discovery EXECUTE) WITHOUT a full `claude -p` round-trip. It did so
// via three observable surfaces:
//   (a) the COMPILED scope-grid.json (tools/data/scope-grid.json) — a pure
//       structural read (`require(...)`); the .sh asserted mvp EXECUTEs both
//       code-generation and practices-discovery.
//   (b) `aidlc-bolt dispatch-event` — the deterministic merge-dispatch
//       observability tool; the .sh fired MERGE_DISPATCH_INVOKED and
//       MERGE_DISPATCH_FALLBACK for the scope and grepped the resulting
//       audit.md rows. A process-boundary seam (the tool emits via
//       appendAuditEntry then console.logs a JSON envelope and process-exits).
//   (c) the v7 state template written by `aidlc-utility init` — the .sh
//       grepped the freshly-initialised aidlc-state.md for the v0.4.0
//       `Worktree Path` + `Bolt Refs` fields.
//
// MECHANISM SPLIT — why this is a `mixed` twin:
//   * Tests 1 + 3 (scope-grid EXECUTE modes) are PURE structural reads of the
//     shipped tools/data/scope-grid.json — the exact `require($MAPPING)`
//     observable the .sh used (t62.sh:28-34 + the assert_scope_codegen_mode
//     helper). No process, no LLM → mechanism none for these.
//   * Test 2 (MERGE_DISPATCH_INVOKED) + Test 4 (MERGE_DISPATCH_FALLBACK) SPAWN
//     the real `aidlc-bolt.ts dispatch-event` CLI (BUN + the tool .ts path) and
//     assert on the audit.md it writes + the JSON envelope it prints. The
//     emit-then-process.exit / console.log contract lives only at the process
//     boundary (aidlc-bolt.ts:660-734 handleDispatchEvent). An in-process
//     handleDispatchEvent call would lose the envelope-to-stdout half the .sh
//     observed via `>/dev/null 2>&1` + the audit-row grep.
//   * Test 5 (v7 state fields) SPAWNS `aidlc-utility.ts init --force --scope
//     mvp` against a fresh integration project (mirrors the .sh's
//     setup_construction_project helper) and reads back the written aidlc-state.md. The template
//     interpolation + disk write is the CLI seam (aidlc-utility.ts:1720
//     handleInit → :2048-2059 the v7 state template carrying `Worktree Path`
//     + `Bolt Refs`).
//
// SUBCOMMAND UNITS credited (COLON form): the two CLI subcommands the .sh
// actually drives — `aidlc-bolt dispatch-event` (INVOKED + FALLBACK arms) and
// `aidlc-utility init` (the v7-state writer). The scope-grid structural reads
// are an assertion against a shipped DATA file, not a code unit, so they carry
// no covers id (same convention as the .sh, which `require()`d the JSON
// directly rather than crediting a function).
//
// RETIRED COVERAGE NOTE: the .sh header records that the four SKILL.md
// prose-presence checks (assert_construction_prose_intact /
// assert_practices_preamble_present / assert_hold_merge_invariant_present /
// assert_skill_skeleton_stance_for_scope) were RETIRED at the engine cutover.
// They are NOT part of this .sh's
// plan-5 surface and have coverage at their real homes (stage-protocol.md
// gates pinned by t47/t76, HOLD-MERGE pinned by t82). This twin ports exactly
// the 5 surviving plan-5 assertions — nothing retired is re-introduced.
//
// Old TAP -> new test parity (1:1, plan 5; STRONGER additions noted):
//   .sh test 1 (assert_scope_codegen_mode mvp EXECUTE)         -> Test 1
//       "scope-grid.json: mvp code-generation = EXECUTE"
//       (same observable: scope-grid.json mvp.stages['code-generation']).
//   .sh test 2 (assert_dispatch_event_runs_for_scope mvp)      -> Test 2
//       MERGE_DISPATCH_INVOKED in audit.md + `Bolt slug.*t-mvp-bolt-1`.
//       STRONGER: exact event count (===1) + block-scoped Bolt slug + the
//       Practices section excerpt the helper passed (`scope=mvp`) + the JSON
//       envelope on stdout — the .sh discarded stdout and grepped file-wide.
//   .sh test 3 (mvp EXECUTEs practices-discovery)              -> Test 3
//       scope-grid.json mvp.stages['practices-discovery'] === "EXECUTE".
//   .sh test 4 (FALLBACK observability path for mvp)           -> Test 4
//       MERGE_DISPATCH_FALLBACK in audit.md. STRONGER: exact event count
//       (===1) + block-scoped Fallback reason / Defaults applied / Bolt slug
//       + the JSON envelope — the .sh did a bare file-wide presence grep.
//   .sh test 5 (v7 state has v0.4.0 fields for mvp)            -> Test 5
//       init-written aidlc-state.md contains BOTH `- **Worktree Path**:` and
//       `- **Bolt Refs**:`. STRONGER: also asserts `- **State Version**: 7`
//       and `- **Scope**: mvp` co-present (the v7 template they ride on).
//
// FIXTURE DISCIPLINE: each CLI-emitting case takes a FRESH integration project
// (setupIntegrationProject({ withGreenfieldStub: true }), toPortablePath'd so
// audit.md/state.md round-trip on Windows) then runs `aidlc-utility init
// --force --scope mvp` against it — byte-for-byte setup_construction_project.
// Exact per-event audit counts demand a fresh project per emit (the .sh reused
// one PROJ across both dispatch calls, so its file-wide greps tolerated
// accumulation). The scope-grid reads need no project. All temp dirs cleaned
// in afterAll; nothing under tests/fixtures/** is written.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
// P4: init BIRTHS a per-intent record; state lives under
// aidlc/spaces/<space>/intents/<slug>-<id8>/ and audit is SHARDED per clone
// under <record>/audit/. Read state through the resolved record dir and audit
// through the shipped merge helper (default-resolves the active intent, falls
// back to flat aidlc-docs for a not-yet-born project).
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SCOPE_GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

const SCOPE = "mvp";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun <tool.ts> <args...>`. */
function run(tool: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [tool, ...args], { encoding: "utf-8" });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/**
 * setup_construction_project (mvp) — historical shell-helper parity.
 * Fresh integration sandbox with the greenfield stub, then `aidlc-utility init
 * --force --scope mvp` so aidlc-docs/aidlc-state.md exists (the dispatch tools
 * + the v7-state assertion both probe it).
 */
function setupConstructionProject(): string {
  const proj = setupIntegrationProject({ withGreenfieldStub: true });
  tempDirs.push(proj);
  const r = run(UTILITY, [
    "intent-birth",
    "--project-dir",
    proj,
    "--force",
    "--scope",
    SCOPE,
  ]);
  if (r.status !== 0) {
    throw new Error(`init --scope ${SCOPE} failed (status ${r.status}): ${r.out}`);
  }
  return proj;
}

// P4: resolve the born intent's record dir from the active-space + active-intent
// cursors (a record dir is the one holding aidlc-state.md), falling back to the
// flat aidlc-docs/ layout for a not-yet-born project.
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

/** Merged audit-shard text for the born intent (P4 shards audit per clone). */
const auditText = (p: string): string => readAllAuditShards(p);
const statePath = (p: string): string => join(recordDirOf(p), "aidlc-state.md");

/** Count audit blocks whose line is exactly `**Event**: <ev>` in audit TEXT. */
function auditEventCount(text: string, ev: string): number {
  return text.split("\n").filter((l) => l === `**Event**: ${ev}`).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Block-scoped (resets at `## ` headings and `---`). Mirrors the awk-scoped
 * block grep the sibling .cli ports use. Returns "" when absent.
 */
function auditField(text: string, ev: string, key: string): string {
  let matched = false;
  for (const line of text.split("\n")) {
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
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

/** Read the compiled scope-grid.json EXECUTE/SKIP mode for mvp.<stage>. */
function gridMode(stage: string): string {
  const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Record<
    string,
    { stages: Record<string, string> }
  >;
  return grid[SCOPE]?.stages?.[stage] ?? "MISSING";
}

describe("t62 construction-worktrees mvp (migrated from t62-construction-worktrees-mvp.sh, plan 5)", () => {
  // --- Test 1 (.sh test 1): scope-grid mvp code-generation = EXECUTE [none] ---
  test("1: scope-grid.json mvp code-generation = EXECUTE", () => {
    // The same `require($MAPPING).mvp.stages[...]` observable the .sh read
    // (t62.sh:28-34 + assert_scope_codegen_mode). mvp is skeleton-on, so it
    // EXECUTEs code-generation.
    expect(gridMode("code-generation")).toBe("EXECUTE");
  });

  // --- Test 3 (.sh test 3): mvp EXECUTEs practices-discovery [none] ---
  test("3: scope-grid.json mvp practices-discovery = EXECUTE", () => {
    expect(gridMode("practices-discovery")).toBe("EXECUTE");
  });

  // --- Test 2 (.sh test 2): MERGE_DISPATCH_INVOKED emits cleanly for mvp [cli] ---
  test("2: dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for scope=mvp", () => {
    const proj = setupConstructionProject();
    const r = run(BOLT, [
      "dispatch-event",
      "--event",
      "MERGE_DISPATCH_INVOKED",
      "--slug",
      "t-mvp-bolt-1",
      "--practices-excerpt",
      "scope=mvp",
      "--project-dir",
      proj,
    ]);
    // STRONGER than the .sh (which discarded stdout + grepped file-wide):
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_INVOKED"');
    const f = auditText(proj);
    expect(auditEventCount(f, "MERGE_DISPATCH_INVOKED")).toBe(1);
    // The .sh asserted `Bolt slug.*t-mvp-bolt-1` was present; we read the exact
    // block-scoped field values, including the excerpt the helper threaded.
    expect(auditField(f, "MERGE_DISPATCH_INVOKED", "Bolt slug")).toBe(
      "t-mvp-bolt-1",
    );
    expect(auditField(f, "MERGE_DISPATCH_INVOKED", "Practices section excerpt")).toBe(
      "scope=mvp",
    );
  });

  // --- Test 4 (.sh test 4): MERGE_DISPATCH_FALLBACK observability path [cli] ---
  test("4: dispatch-event FALLBACK observability path works for mvp", () => {
    const proj = setupConstructionProject();
    const r = run(BOLT, [
      "dispatch-event",
      "--event",
      "MERGE_DISPATCH_FALLBACK",
      "--slug",
      "t-mvp-bolt-1",
      "--reason",
      "malformed-yaml",
      "--defaults",
      "squash + main",
      "--project-dir",
      proj,
    ]);
    // STRONGER than the .sh's bare file-wide presence grep:
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_FALLBACK"');
    const f = auditText(proj);
    expect(auditEventCount(f, "MERGE_DISPATCH_FALLBACK")).toBe(1);
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Fallback reason")).toBe(
      "malformed-yaml",
    );
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Defaults applied")).toBe(
      "squash + main",
    );
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Bolt slug")).toBe(
      "t-mvp-bolt-1",
    );
  });

  // --- Test 5 (.sh test 5): v7 state has the v0.4.0 fields for mvp [cli] ---
  test("5: v7 state (init --scope mvp) carries Worktree Path + Bolt Refs", () => {
    const proj = setupConstructionProject();
    const state = readFileSync(statePath(proj), "utf-8");
    const lines = state.split("\n");
    // The .sh grepped both `Worktree Path` and `Bolt Refs`. The v7 template
    // (aidlc-utility.ts:2057-2058) emits them as empty list-shaped fields.
    expect(lines.some((l) => l.startsWith("- **Worktree Path**:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- **Bolt Refs**:"))).toBe(true);
    // STRONGER: pin the v7 template + scope these fields ride on.
    expect(lines).toContain("- **State Version**: 7");
    expect(lines).toContain(`- **Scope**: ${SCOPE}`);
  });
});
