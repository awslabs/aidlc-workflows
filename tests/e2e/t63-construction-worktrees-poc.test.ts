// covers: data:scope-grid(poc), cli:aidlc-bolt(dispatch-event), cli:aidlc-state(practices-event), cli:aidlc-utility(init)
//
// t63 - Construction worktrees per scope, poc. poc is the skeleton-on / rapid
// scope: code-generation EXECUTEs, practices-discovery is SKIPPED (the
// orchestrator falls back to org.md / hardcoded defaults at the practices read),
// and the PRACTICES_SECTION_EMPTY advisory fires when every practice layer leaves
// a section empty.
//
// Mechanism: mixed.
//   - The scope-grid lookups (codegen mode, practices SKIP) are STRUCTURAL data
//     checks → none (read the compiled scope-grid.json in process).
//   - The dispatch-event emit, the practices-event emit, and the v8 state-write
//     are process / audit-shard boundary seams -> cli (spawnSync the real .ts tool
//     via the bun runtime, then assert on the bytes the tool wrote to disk).
//     Each of these is a NON-GOLDEN audit-emit anchor; the emit must ACTUALLY
//     FIRE (the row must land in the audit shards), so a happy-path-only structural
//     read would not be equal-or-stronger.
//
// Source under test:
//   dist/claude/.claude/tools/data/scope-grid.json — poc.stages map
//       (transpose of per-stage `scopes:` frontmatter; runtime source of truth
//        after milestone 12 retired scope-mapping.json - helpers.sh)
//   dist/claude/.claude/tools/aidlc-bolt.ts handleDispatchEvent
//       — MERGE_DISPATCH_INVOKED requires --practices-excerpt; emits
//         emitAudit(pd, "MERGE_DISPATCH_INVOKED", {"Bolt slug": slug, ...})
//   dist/claude/.claude/tools/aidlc-state.ts handlePracticesEvent
//       - --type empty -> emitAudit(pd, "PRACTICES_SECTION_EMPTY", fields)
//   dist/claude/.claude/tools/aidlc-utility.ts handleIntentCreateStateBuild
//       - the state template emits "- **Worktree Path**:" + "- **Bolt Refs**:",
//         State Version 8

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, setupIntegrationProject } from "../harness/fixtures.ts";
// intent-create CREATES a per-intent record; state lives under
// aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/ and audit is SHARDED per clone
// under <record>/audit/. Read state through the resolved record dir and audit
// through the shipped merge helper (default-resolves the active intent, falls
// back to the space-level shard when no intent resolves).
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SCOPE_GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

// scope-grid.json is the compiled runtime source of truth — read it once, in
// process (structural / mechanism none).
const scopeGrid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Record<
  string,
  { stages: Record<string, string> }
>;

// One initialized poc project shared across the CLI cases. setupIntegrationProject
// copies the shipped .claude/ + a greenfield stub; intent-create seeds the v8
// state + audit shards.
let PROJ: string;

beforeAll(() => {
  PROJ = setupIntegrationProject({ withGreenfieldStub: true });
  const r = spawnSync(
    BUN,
    [UTILITY, "intent-create", "--project-dir", PROJ, "--force", "--scope", "poc"],
    { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
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

// resolve the created intent's record dir from the active-space + active-intent
// cursors (a record dir is the one holding aidlc-state.md), falling back to the
// flat aidlc-docs/ layout for a not-yet-created project.
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

/** Merged audit-shard text for the created intent (audit is sharded per clone). */
const auditText = () => readAllAuditShards(PROJ);
const statePath = () => join(recordDirOf(PROJ), "aidlc-state.md");

describe("t63 construction-worktrees poc (migrated from t63-construction-worktrees-poc.sh, plan 5)", () => {
  test("poc code-generation mode is EXECUTE [.sh 1]", () => {
    expect(scopeGrid.poc).toBeDefined();
    expect(scopeGrid.poc.stages["code-generation"]).toBe("EXECUTE");
  });

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
      { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    // Pin a clean exit (the emit-only contract: no state mutation, no spawn).
    expect(r.status).toBe(0);
    const audit = auditText();
    // The event line and the Bolt-slug line must BOTH be present, and the slug
    // appears on a "**Bolt slug**: <slug>" field row (aidlc-bolt.ts handleDispatchEvent
    // + appendAuditEntry's "**<key>**: <value>" format).
    expect(audit).toContain("MERGE_DISPATCH_INVOKED");
    expect(audit).toContain(`**Bolt slug**: ${slug}`);
  });

  test("poc SKIPs practices-discovery [.sh 3]", () => {
    // poc is the rapid scope - relies on the practices fallback chain (org.md /
    // hardcoded defaults) rather than running the affirmation gate.
    expect(scopeGrid.poc.stages["practices-discovery"]).toBe("SKIP");
  });

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
      { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    expect(r.status).toBe(0);
    // The non-golden emit MUST actually fire - the advisory row lands in the audit
    // shards (aidlc-state.ts handlePracticesEvent). Also pin the tool's emitted-event
    // JSON on stdout and the field rows the --field flags carried.
    expect(r.stdout).toContain('"emitted":"PRACTICES_SECTION_EMPTY"');
    const audit = auditText();
    expect(audit).toContain("PRACTICES_SECTION_EMPTY");
    expect(audit).toContain("**Section**: Walking Skeleton");
    expect(audit).toContain("**Fallback**: org.md");
  });

  test("init writes a v7 state with the v0.4.0 Worktree Path + Bolt Refs fields [.sh 5]", () => {
    // The state was written by `aidlc-utility intent-create --scope poc` in
    // beforeAll. Assert the file the tool produced carries the Construction-worktree
    // fields.
    const state = readFileSync(statePath(), "utf-8");
    // Pin the exact template field lines (aidlc-utility.ts
    // handleIntentCreateStateBuild) plus the State Version 8 marker that makes these
    // the v8 template's fields.
    expect(state).toContain("- **Worktree Path**:");
    expect(state).toContain("- **Bolt Refs**:");
    expect(state).toContain("- **State Version**: 8");
  });
});
