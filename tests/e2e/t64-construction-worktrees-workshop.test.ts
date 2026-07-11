// covers: data:scope-grid.json, subcommand:aidlc-bolt:dispatch-event, doc:knowledge/aidlc-shared/state-template.md
//
// Construction worktrees per scope — WORKSHOP. Migrated from
// tests/e2e/t64-construction-worktrees-workshop.sh (TAP plan 3).
// Mechanism: mixed.
//   - The scope-grid.json read (.sh test 1, assert_scope_codegen_mode) is a
//     pure structural read of a shipped JSON data file — done in-process (no
//     spawn, no LLM).
//   - The dispatch-event audit emit (.sh test 2, assert_dispatch_event_runs_for_scope)
//     and the init-built state-template check (.sh test 3) cross the PROCESS
//     boundary: they spawn the real `aidlc-bolt.ts dispatch-event` /
//     `aidlc-utility.ts init` tools via the bun runtime and assert on the
//     audit.md / aidlc-state.md those subprocesses write. That is the same seam
//     the .sh exercised through setup_construction_project +
//     assert_dispatch_event_runs_for_scope.
//
// The four shared SKILL.md prose-presence checks AND the two inline §8
// workshop-resume / resume-mid-batch carve-out greps were RETIRED at the engine
// cutover: that SKILL.md
// prose was deleted, and the surviving behaviour lives in the engine +
// stage-protocol.md resume handling + the worktree tools (t09/t10/t11). What the
// .sh — and so this twin — pins after that retirement is the per-scope codegen
// mode, the dispatch-event tool behaviour, and the v7 state fields. (3 tests.)
//
// Source under test:
//   dist/claude/.claude/tools/data/scope-grid.json
//     - the compiled {scope:{stages:{slug:MODE}}} grid (milestone 12 transpose of the
//       per-stage `scopes:` frontmatter; replaced scope-mapping.json). workshop
//       is a skeleton-on greenfield scope that runs code-generation = EXECUTE.
//   dist/claude/.claude/tools/aidlc-bolt.ts :660 handleDispatchEvent
//     - MERGE_DISPATCH_INVOKED -> emits audit with fields "Bolt slug" +
//       "Practices section excerpt" (:670-684); emit-only (no state mutation,
//       no spawn) via emitAudit. Requires --event, --slug, --practices-excerpt.
//   dist/claude/.claude/tools/aidlc-utility.ts :2057-2058 init state template
//     - State Version 7 template carries the v0.4.0 Construction-worktrees
//       fields `- **Worktree Path**:` (:2057) and `- **Bolt Refs**:` (:2058).
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  assert_scope_codegen_mode workshop EXECUTE      -> "1: scope-grid workshop code-generation = EXECUTE"
//   .sh test 2  assert_dispatch_event_runs_for_scope workshop   -> "2: dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for workshop"
//   .sh test 3  state has Worktree Path AND Bolt Refs           -> "3: v7 init state carries the v0.4.0 worktree fields"
//
// STRONGER than the .sh where it costs nothing:
//   - test 2 is block-scoped: it reads the "Bolt slug" field off the
//     MERGE_DISPATCH_INVOKED audit entry specifically (the .sh grepped the
//     whole file for "Bolt slug.*t-workshop-bolt-1"), counts exactly one such
//     entry, AND asserts the tool's JSON ack on stdout + a clean exit.
//   - test 3 asserts both fields land as proper `- **<field>**:` state lines
//     (not a bare substring anywhere in the file), and pins State Version 7 —
//     the template that introduced them.
//
// FIXTURE DISCIPLINE (mirrors setup_construction_project: setupIntegrationProject
// --with-greenfield-stub, then `aidlc-utility init --force --scope workshop`):
// one shared WORKSHOP construction sandbox is built once in beforeAll and torn
// down in afterAll — the same project the .sh threaded through all 3 asserts.
// NOTHING is written under tests/fixtures/**; the temp dir is cleaned up.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const SCOPE = "workshop";

interface Grid {
  [scope: string]: { stages: Record<string, string> };
}

let proj = "";

/** setup_construction_project("workshop"): greenfield integration sandbox + real init. */
beforeAll(() => {
  proj = setupIntegrationProject({ withGreenfieldStub: true });
  const r = spawnSync(
    BUN,
    [UTILITY, "intent-birth", "--project-dir", proj, "--force", "--scope", SCOPE],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `init --scope ${SCOPE} failed (exit ${r.status}): ${r.stderr || r.stdout}`,
    );
  }
});

afterAll(() => {
  cleanupTestProject(proj);
});

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

const statePath = (): string => join(recordDirOf(proj), "aidlc-state.md");
/** Merged audit-shard text for the born intent (P4 shards audit per clone). */
const auditText = (): string => readAllAuditShards(proj);

/** Run a bolt subcommand against the shared project. Mirrors `bun "$BOLT" ...`. */
function bolt(args: string[]): { status: number; stdout: string; out: string } {
  const r = spawnSync(BUN, [BOLT, ...args, "--project-dir", proj], {
    encoding: "utf-8",
  });
  const stdout = r.stdout ?? "";
  return { status: r.status ?? -1, stdout, out: `${stdout}${r.stderr ?? ""}` };
}

/**
 * Read the value of <key> from the FIRST audit block whose `**Event**:`
 * matches <ev>. Block-scoped (resets at `## ` headings and `---`). Returns ""
 * when absent. STRONGER than the .sh's file-wide grep — pins the field to the
 * right event.
 */
function auditField(ev: string, key: string): string {
  let matched = false;
  for (const line of auditText().split("\n")) {
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
      if (pos > 0 && stripped.slice(0, pos) === key) {
        return stripped.slice(pos + 4);
      }
    }
  }
  return "";
}

/** Count audit blocks with `**Event**: <ev>` (exact-line). */
function auditEventCount(ev: string): number {
  return auditText()
    .split("\n")
    .filter((l) => l === `**Event**: ${ev}`).length;
}

describe("t64 construction worktrees — workshop (migrated from t64-construction-worktrees-workshop.sh, plan 3)", () => {
  // --- Test 1: scope-grid.json workshop code-generation = EXECUTE ---
  test("1: scope-grid workshop code-generation = EXECUTE", () => {
    const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Grid;
    expect(grid[SCOPE]).toBeDefined();
    expect(grid[SCOPE].stages["code-generation"]).toBe("EXECUTE");
  });

  // --- Test 2: dispatch-event MERGE_DISPATCH_INVOKED emits cleanly ---
  test("2: dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for workshop", () => {
    const slug = `t-${SCOPE}-bolt-1`;
    const r = bolt([
      "dispatch-event",
      "--event",
      "MERGE_DISPATCH_INVOKED",
      "--slug",
      slug,
      "--practices-excerpt",
      `scope=${SCOPE}`,
    ]);
    expect(r.status).toBe(0);
    // .sh: grep MERGE_DISPATCH_INVOKED + "Bolt slug.*t-workshop-bolt-1".
    // STRONGER: exactly one INVOKED block, and the slug is read off THAT block.
    expect(auditEventCount("MERGE_DISPATCH_INVOKED")).toBe(1);
    expect(auditField("MERGE_DISPATCH_INVOKED", "Bolt slug")).toBe(slug);
    // STRONGER: the tool's JSON ack names the emitted event + slug.
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_INVOKED"');
    expect(r.stdout).toContain(`"slug":"${slug}"`);
  });

  // --- Test 3: v7 init state carries the v0.4.0 worktree fields ---
  test("3: v7 init state carries the v0.4.0 worktree fields", () => {
    const lines = readFileSync(statePath(), "utf-8").split("\n");
    // .sh: grep "Worktree Path" AND grep "Bolt Refs". STRONGER: both land as
    // proper `- **<field>**:` state lines (the v7 template at
    // aidlc-utility.ts:2057-2058), not bare substrings anywhere.
    expect(lines.some((l) => l.startsWith("- **Worktree Path**:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- **Bolt Refs**:"))).toBe(true);
    // State Version 7 is the template that introduced these fields.
    expect(lines).toContain("- **State Version**: 7");
  });
});
