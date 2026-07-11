// covers: data:scope-grid.json, subcommand:aidlc-bolt:dispatch-event, doc:knowledge/aidlc-shared/state-template.md
//
// Construction worktrees per scope — FEATURE. Migrated from
// tests/e2e/t61-construction-worktrees-feature.sh (TAP plan 5).
// Mechanism: mixed.
//   - The two scope-grid.json reads (.sh tests 1 + 3) are pure structural
//     reads of a shipped JSON data file — done in-process (no spawn, no LLM).
//   - The two dispatch-event audit emits (.sh tests 2 + 4) and the init-built
//     state-template check (.sh test 5) cross the PROCESS boundary: they spawn
//     the real `aidlc-bolt.ts dispatch-event` / `aidlc-utility.ts init` tools
//     via the bun runtime and assert on the audit.md / aidlc-state.md those
//     subprocesses write. That is the same seam the .sh exercised through
//     setup_construction_project + assert_dispatch_event_runs_for_scope.
//
// The four SKILL.md prose-presence checks the original t61 family carried were
// RETIRED at the engine cutover: the
// CONSTRUCTION-Flow / parallel-batch / dispatch-instrumentation / halt-and-ask
// prose was deleted when per-Bolt dispatch routing became an engine concern.
// The surviving behaviour (the dispatch-event emit) is what this twin pins,
// exactly as the .sh's TAP plan 5 did after that retirement.
//
// Source under test:
//   dist/claude/.claude/tools/data/scope-grid.json
//     - the compiled {scope:{stages:{slug:MODE}}} grid (milestone 12 transpose of the
//       per-stage `scopes:` frontmatter; replaced scope-mapping.json). feature
//       runs code-generation = EXECUTE and practices-discovery = EXECUTE.
//   dist/claude/.claude/tools/aidlc-bolt.ts :660 handleDispatchEvent
//     - MERGE_DISPATCH_INVOKED  -> emits audit with fields "Bolt slug" +
//       "Practices section excerpt" (:670-684)
//     - MERGE_DISPATCH_RETURNED -> emits audit with fields "Bolt slug",
//       Strategy, "Target branch", Confidence, Notes (:686-711)
//     emit-only: no state mutation, no spawn; pure audit emission via emitAudit.
//   dist/claude/.claude/tools/aidlc-utility.ts :2048 init state template
//     - State Version 7 template carries the v0.4.0 Construction-worktrees
//       fields `- **Worktree Path**:` (:2057) and `- **Bolt Refs**:` (:2058).
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  assert_scope_codegen_mode feature EXECUTE   -> "1: scope-grid feature code-generation = EXECUTE"
//   .sh test 2  assert_dispatch_event_runs_for_scope feature -> "2: dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for feature"
//   .sh test 3  grid.feature.stages[practices-discovery]==EXECUTE -> "3: scope-grid feature EXECUTEs practices-discovery"
//   .sh test 4  dispatch-event MERGE_DISPATCH_RETURNED in audit -> "4: dispatch-event RETURNED post-call emit works for feature"
//   .sh test 5  state has Worktree Path AND Bolt Refs        -> "5: v7 init state carries the v0.4.0 worktree fields"
//
// STRONGER than the .sh where it costs nothing:
//   - test 2 is block-scoped: it reads the "Bolt slug" field off the
//     MERGE_DISPATCH_INVOKED audit entry specifically (the .sh grepped the
//     whole file for "Bolt slug.*t-feature-bolt-1"), AND asserts the tool's
//     JSON ack on stdout + a clean exit.
//   - test 4 is block-scoped to the MERGE_DISPATCH_RETURNED entry and pins the
//     full RETURNED field set (Strategy/Target branch/Confidence/Notes) the
//     .sh's single `grep -q MERGE_DISPATCH_RETURNED` never inspected.
//   - test 5 asserts both fields land as proper `- **<field>**:` state lines
//     (not a bare substring anywhere in the file), and that init exited 0.
//
// FIXTURE DISCIPLINE (mirrors setup_construction_project: setupIntegrationProject
// --with-greenfield-stub, then `aidlc-utility init --force --scope feature`):
// one shared FEATURE construction sandbox is built once in beforeAll and torn
// down in afterAll — the same project the .sh threaded through all 5 asserts.
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

const SCOPE = "feature";

interface Grid {
  [scope: string]: { stages: Record<string, string> };
}

let proj = "";

/** setup_construction_project("feature"): greenfield integration sandbox + real init. */
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

describe("t61 construction worktrees — feature (migrated from t61-construction-worktrees-feature.sh, plan 5)", () => {
  // --- Test 1: scope-grid.json feature code-generation = EXECUTE ---
  test("1: scope-grid feature code-generation = EXECUTE", () => {
    const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Grid;
    expect(grid[SCOPE]).toBeDefined();
    expect(grid[SCOPE].stages["code-generation"]).toBe("EXECUTE");
  });

  // --- Test 3 (ordered after 1, before the emits, as the .sh did): ---
  test("3: scope-grid feature EXECUTEs practices-discovery", () => {
    const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Grid;
    expect(grid[SCOPE].stages["practices-discovery"]).toBe("EXECUTE");
  });

  // --- Test 2: dispatch-event MERGE_DISPATCH_INVOKED emits cleanly ---
  test("2: dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for feature", () => {
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
    // .sh: grep MERGE_DISPATCH_INVOKED + "Bolt slug.*t-feature-bolt-1".
    // STRONGER: the slug is read off the MERGE_DISPATCH_INVOKED block itself.
    expect(auditEventCount("MERGE_DISPATCH_INVOKED")).toBe(1);
    expect(auditField("MERGE_DISPATCH_INVOKED", "Bolt slug")).toBe(slug);
    // STRONGER: the tool's JSON ack names the emitted event + slug.
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_INVOKED"');
    expect(r.stdout).toContain(`"slug":"${slug}"`);
  });

  // --- Test 4: dispatch-event MERGE_DISPATCH_RETURNED post-call emit works ---
  test("4: dispatch-event RETURNED post-call emit works for feature", () => {
    const slug = `t-${SCOPE}-bolt-1`;
    const r = bolt([
      "dispatch-event",
      "--event",
      "MERGE_DISPATCH_RETURNED",
      "--slug",
      slug,
      "--strategy",
      "squash",
      "--target",
      "main",
      "--confidence",
      "0.85",
      "--notes",
      "trunk-based",
    ]);
    expect(r.status).toBe(0);
    // .sh: grep -q MERGE_DISPATCH_RETURNED in audit.md.
    expect(auditEventCount("MERGE_DISPATCH_RETURNED")).toBe(1);
    // STRONGER: pin the full RETURNED field set, block-scoped to the event.
    expect(auditField("MERGE_DISPATCH_RETURNED", "Bolt slug")).toBe(slug);
    expect(auditField("MERGE_DISPATCH_RETURNED", "Strategy")).toBe("squash");
    expect(auditField("MERGE_DISPATCH_RETURNED", "Target branch")).toBe("main");
    expect(auditField("MERGE_DISPATCH_RETURNED", "Confidence")).toBe("0.85");
    expect(auditField("MERGE_DISPATCH_RETURNED", "Notes")).toBe("trunk-based");
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_RETURNED"');
  });

  // --- Test 5: v7 init state carries the v0.4.0 worktree fields ---
  test("5: v7 init state carries the v0.4.0 worktree fields", () => {
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
