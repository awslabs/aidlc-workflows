// covers: data:scope-grid(poc), cli:aidlc-bolt(dispatch-event), cli:aidlc-state(practices-event), cli:aidlc-utility(init)
//
// t63 — Construction worktrees per scope, poc (v0.4.0 milestone 13). Migrated from
// tests/e2e/t63-construction-worktrees-poc.sh (TAP plan 5). poc is the
// skeleton-on / rapid scope: code-generation EXECUTEs, practices-discovery is
// SKIPPED (the orchestrator falls back to org.md / hardcoded defaults at the
// U1 read), and the PRACTICES_SECTION_EMPTY advisory fires for any unaffirmed
// section. The four SKILL.md prose-presence checks were RETIRED at the engine
// cutover — the SURVIVING
// behaviour is the per-scope contract this file pins.
//
// Mechanism: mixed.
//   - The scope-grid lookups (codegen mode, practices SKIP) are STRUCTURAL data
//     checks → none (read the compiled scope-grid.json in process).
//   - The dispatch-event emit, the practices-event emit, and the v7 state-write
//     are process / audit.md boundary seams → cli (spawnSync the real .ts tool
//     via the bun runtime, then assert on the bytes the tool wrote to disk).
//     Each of these is a NON-GOLDEN audit-emit anchor; the emit must ACTUALLY
//     FIRE (the row must land in audit.md), so a happy-path-only structural
//     read would not be equal-or-stronger.
//
// Source under test:
//   dist/claude/.claude/tools/data/scope-grid.json — poc.stages map
//       (transpose of per-stage `scopes:` frontmatter; runtime source of truth
//        after milestone 12 retired scope-mapping.json — helpers.sh:46-48)
//   dist/claude/.claude/tools/aidlc-bolt.ts:660 handleDispatchEvent
//       — MERGE_DISPATCH_INVOKED requires --practices-excerpt; emits
//         appendAuditEntry(pd, "MERGE_DISPATCH_INVOKED", {Bolt slug, ...}) (:670-684)
//   dist/claude/.claude/tools/aidlc-state.ts:1048 handlePracticesEvent
//       — --type empty → emitAudit(pd, "PRACTICES_SECTION_EMPTY", fields) (:1100-1102)
//   dist/claude/.claude/tools/aidlc-utility.ts init → state template
//       — emits "- **Worktree Path**:" + "- **Bolt Refs**:" (:2057-2058),
//         State Version 7 (:2055)
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh assertion 1 assert_scope_codegen_mode poc EXECUTE   -> "poc code-generation mode is EXECUTE [.sh 1]"
//   .sh assertion 2 assert_dispatch_event_runs_for_scope poc -> "dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for poc [.sh 2]"
//   .sh assertion 3 PD_MODE == SKIP                          -> "poc SKIPs practices-discovery [.sh 3]"
//   .sh assertion 4 PRACTICES_SECTION_EMPTY emit             -> "PRACTICES_SECTION_EMPTY advisory fires on the poc fallback path [.sh 4]"
//   .sh assertion 5 v7 state has Worktree Path + Bolt Refs   -> "init writes a v7 state with the v0.4.0 Worktree Path + Bolt Refs fields [.sh 5]"

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, setupIntegrationProject } from "../harness/fixtures.ts";
// P4: init BIRTHS a per-intent record; state lives under
// aidlc/spaces/<space>/intents/<slug>-<id8>/ and audit is SHARDED per clone
// under <record>/audit/. Read state through the resolved record dir and audit
// through the shipped merge helper (default-resolves the active intent, falls
// back to flat aidlc-docs for a not-yet-born project).
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SCOPE_GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

// scope-grid.json is the compiled runtime source of truth — read it once, in
// process (structural / mechanism none). Mirrors the .sh's
// `require('$MAPPING').poc.stages[...]` and the helper's `m['poc'].stages[...]`.
const scopeGrid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Record<
  string,
  { stages: Record<string, string> }
>;

// One initialized poc project shared across the CLI cases. setupIntegrationProject
// copies the shipped .claude/ + a greenfield stub; init seeds the v7 state +
// audit.md. Mirrors setup_construction_project("poc"): setupIntegrationProject
// --with-greenfield-stub then `aidlc-utility init --force --scope poc`.
let PROJ: string;

beforeAll(() => {
  PROJ = setupIntegrationProject({ withGreenfieldStub: true });
  const r = spawnSync(
    BUN,
    [UTILITY, "intent-birth", "--project-dir", PROJ, "--force", "--scope", "poc"],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `init --scope poc failed (exit ${r.status}): ${r.stderr || r.stdout}`,
    );
  }
});

afterAll(() => {
  if (PROJ && existsSync(PROJ)) rmSync(PROJ, { recursive: true, force: true });
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

/** Merged audit-shard text for the born intent (P4 shards audit per clone). */
const auditText = () => readAllAuditShards(PROJ);
const statePath = () => join(recordDirOf(PROJ), "aidlc-state.md");

describe("t63 construction-worktrees poc (migrated from t63-construction-worktrees-poc.sh, plan 5)", () => {
  // --- assertion 1: codegen mode (structural / none) ------------------------
  test("poc code-generation mode is EXECUTE [.sh 1]", () => {
    expect(scopeGrid.poc).toBeDefined();
    expect(scopeGrid.poc.stages["code-generation"]).toBe("EXECUTE");
  });

  // --- assertion 2: dispatch-event emit (audit seam / cli) ------------------
  test("dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for poc [.sh 2]", () => {
    const slug = "t-poc-bolt-1";
    const r = spawnSync(
      BUN,
      [
        BOLT,
        "dispatch-event",
        "--event",
        "MERGE_DISPATCH_INVOKED",
        "--slug",
        slug,
        "--practices-excerpt",
        "scope=poc",
        "--project-dir",
        PROJ,
      ],
      { encoding: "utf-8" },
    );
    // The .sh discarded stdout/stderr and grepped audit.md; we additionally
    // pin a clean exit (the emit-only contract: no state mutation, no spawn).
    expect(r.status).toBe(0);
    const audit = auditText();
    // STRONGER than the .sh's two independent greps: the event line and the
    // Bolt-slug line must BOTH be present (helpers.sh:108-109), and the slug
    // appears on a "**Bolt slug**: <slug>" field row (aidlc-bolt.ts:675 +
    // appendAuditEntry's "**<key>**: <value>" format).
    expect(audit).toContain("MERGE_DISPATCH_INVOKED");
    expect(audit).toContain(`**Bolt slug**: ${slug}`);
  });

  // --- assertion 3: practices-discovery SKIP (structural / none) ------------
  test("poc SKIPs practices-discovery [.sh 3]", () => {
    // poc is the rapid scope — relies on the U1 fallback chain (org.md /
    // hardcoded defaults) rather than running the affirmation gate.
    expect(scopeGrid.poc.stages["practices-discovery"]).toBe("SKIP");
  });

  // --- assertion 4: PRACTICES_SECTION_EMPTY advisory (audit seam / cli) -----
  test("PRACTICES_SECTION_EMPTY advisory fires on the poc fallback path [.sh 4]", () => {
    const r = spawnSync(
      BUN,
      [
        STATE,
        "practices-event",
        "--type",
        "empty",
        "--field",
        "Section: Walking Skeleton",
        "--field",
        "Fallback: org.md",
        "--project-dir",
        PROJ,
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(0);
    // The non-golden emit MUST actually fire — the advisory row lands in
    // audit.md (aidlc-state.ts:1100-1102). STRONGER than the .sh's lone grep:
    // also pin the tool's emitted-event JSON on stdout and the field rows the
    // --field flags carried.
    expect(r.stdout).toContain('"emitted":"PRACTICES_SECTION_EMPTY"');
    const audit = auditText();
    expect(audit).toContain("PRACTICES_SECTION_EMPTY");
    expect(audit).toContain("**Section**: Walking Skeleton");
    expect(audit).toContain("**Fallback**: org.md");
  });

  // --- assertion 5: v7 state has the v0.4.0 fields (init seam / cli) ---------
  test("init writes a v7 state with the v0.4.0 Worktree Path + Bolt Refs fields [.sh 5]", () => {
    // The state was written by `aidlc-utility init --scope poc` in beforeAll
    // (the .sh's setup_construction_project). Assert the file the tool produced
    // carries the v0.4.0 Construction-worktree fields.
    const state = readFileSync(statePath(), "utf-8");
    // STRONGER than the .sh's two `grep -q` checks: pin the exact template
    // field lines (aidlc-utility.ts:2057-2058) plus the State Version 7 marker
    // (:2055) that makes these the v7 template's fields.
    expect(state).toContain("- **Worktree Path**:");
    expect(state).toContain("- **Bolt Refs**:");
    expect(state).toContain("- **State Version**: 7");
  });
});
