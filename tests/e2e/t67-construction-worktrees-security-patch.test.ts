// covers: data:scope-grid(security-patch), cli:aidlc-bolt(dispatch-event), cli:aidlc-utility(init), data:state-template(v0.4.0-fields)
//
// t67 — Construction worktrees per scope: the security-patch contract.
// Migrated from tests/e2e/t67-construction-worktrees-security-patch.sh
// (TAP plan 4). The .sh sourced its shared construction helper and proved
// the v0.4.0 milestone 13 per-scope orchestration contract for `security-patch`
// WITHOUT a full `claude -p` round-trip. Four distinct behavioural assertions:
//
//   .sh L25 assert_scope_codegen_mode "security-patch" "EXECUTE"
//   .sh L26 assert_dispatch_event_runs_for_scope "security-patch" "$PROJ"
//   .sh L29-34 scope-grid.json security-patch SKIPs practices-discovery
//   .sh L36-41 the init-produced v7 state carries Worktree Path + Bolt Refs
//
// The four SKILL.md prose-presence checks were RETIRED at the engine cutover
// (helpers L67-95): the per-Bolt dispatch routing the .sh once grepped from
// SKILL.md is now an engine concern, so the .sh's plan dropped to 4. This twin
// covers exactly those surviving 4.
//
// Mechanism: MIXED.
//   - Assertions 1 + 3 are pure structural reads of the compiled
//     scope-grid.json (the runtime source of truth; scope-mapping.json was
//     retired in milestone 12 — helpers L46-48). Mechanism none: require the JSON and
//     assert the cell. The .sh shelled `bun -e require(...)`; the contract is
//     the data, so we read it directly with zero process spawn.
//   - Assertions 2 + 4 are process-boundary contracts: `aidlc-utility.ts init`
//     must WRITE a v7 state file with the two v0.4.0 fields, and
//     `aidlc-bolt.ts dispatch-event` must EMIT a real MERGE_DISPATCH_INVOKED
//     audit row into that initialized project. Mechanism cli: spawnSync the
//     real tools via BUN against the .ts paths and assert on the bytes they
//     write — the same seam assert_dispatch_event_runs_for_scope (helpers
//     L99-114) and the .sh's grep on aidlc-state.md exercised.
//
// Source under test:
//   - dist/claude/.claude/tools/data/scope-grid.json
//       security-patch.stages["code-generation"] === "EXECUTE"
//       security-patch.stages["practices-discovery"] === "SKIP"
//   - dist/claude/.claude/tools/aidlc-bolt.ts:660 handleDispatchEvent
//       MERGE_DISPATCH_INVOKED branch (:670-685): requires --slug +
//       --practices-excerpt; emits via emitAudit -> appendAuditEntry with
//       fields { "Bolt slug": slug, "Practices section excerpt": excerpt };
//       prints {"emitted":"MERGE_DISPATCH_INVOKED","slug":...} to stdout.
//   - dist/claude/.claude/tools/aidlc-audit.ts:168 EVENT_HEADINGS maps
//       MERGE_DISPATCH_INVOKED -> "Merge Dispatch Invoked"; the **Event**:
//       and **Bolt slug**: lines land in audit.md.
//   - aidlc-utility.ts init writes aidlc-docs/aidlc-state.md from the v7
//       template, which carries `- **Worktree Path**:` and `- **Bolt Refs**:`
//       (the v0.4.0 Construction-worktree fields).
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh assert 1 (scope codegen mode EXECUTE)       -> "scope-grid: security-patch code-generation = EXECUTE"
//   .sh assert 2 (dispatch-event emits for scope)   -> "dispatch-event emits a real MERGE_DISPATCH_INVOKED row + Bolt slug for security-patch"
//   .sh assert 3 (SKIPs practices-discovery)        -> "scope-grid: security-patch SKIPs practices-discovery"
//   .sh assert 4 (v7 state has v0.4.0 fields)       -> "init writes a v7 state carrying Worktree Path + Bolt Refs for security-patch"
//
// STRONGER than the .sh where cheap:
//   - assert 2: the .sh grepped MERGE_DISPATCH_INVOKED + a loose "Bolt slug.*"
//     pattern. Here we also pin the CLI stdout JSON {"emitted","slug"}, the
//     exact "**Bolt slug**: t-security-patch-bolt-1" line, the "Merge Dispatch
//     Invoked" heading the EVENT_HEADINGS map produces, and exit code 0.
//   - assert 4: the .sh did two independent greps; here we assert the two field
//     LABEL lines render in the state file the init tool wrote, on the v7
//     `- **<field>**:` shape.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
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
const SCOPE_GRID_PATH = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

const SCOPE = "security-patch";

// scope-grid.json: { <scope>: { stages: { <stage>: <MODE> } } } — the
// transpose of per-stage `scopes:` frontmatter, compiled at build, the runtime
// source of truth (helpers L46-48). Read once, structurally.
interface ScopeGrid {
  [scope: string]: { stages: Record<string, string> };
}
const grid = JSON.parse(readFileSync(SCOPE_GRID_PATH, "utf-8")) as ScopeGrid;

const tempProjects: string[] = [];
afterAll(() => {
  for (const p of tempProjects) cleanupTestProject(p);
});

/**
 * setup_construction_project (helpers L36-43): a project with aidlc-docs/,
 * then `aidlc-utility.ts init --force --scope <scope>` so aidlc-state.md and
 * the rest of the v7 workspace exist (the dispatch-event + state probes both
 * read that path). Returns the project dir.
 */
function setupConstructionProject(scope: string): string {
  const proj = createTestProject();
  tempProjects.push(proj);
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  const res = spawnSync(
    BUN,
    [UTILITY, "intent-birth", "--project-dir", proj, "--force", "--scope", scope],
    { encoding: "utf-8" },
  );
  expect(res.status).toBe(0);
  return proj;
}

// P4: resolve the born intent's record dir from the active-space + active-intent
// cursors (a record dir is the one holding aidlc-state.md), falling back to the
// flat aidlc-docs/ layout for a not-yet-born project. Copied verbatim from t63.
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

describe("t67 construction worktrees — security-patch (migrated from t67-construction-worktrees-security-patch.sh, plan 4)", () => {
  // === .sh assert 1 — scope-grid codegen mode (mechanism none) ===============
  test("scope-grid: security-patch code-generation = EXECUTE [.sh assert 1]", () => {
    const entry = grid[SCOPE];
    expect(entry).toBeDefined();
    expect(entry.stages["code-generation"]).toBe("EXECUTE");
  });

  // === .sh assert 3 — scope-grid practices-discovery SKIP (mechanism none) ===
  test("scope-grid: security-patch SKIPs practices-discovery [.sh assert 3]", () => {
    const entry = grid[SCOPE];
    expect(entry).toBeDefined();
    expect(entry.stages["practices-discovery"]).toBe("SKIP");
  });

  // === .sh assert 2 — dispatch-event emits for scope (mechanism cli) =========
  test("dispatch-event emits a real MERGE_DISPATCH_INVOKED row + Bolt slug for security-patch [.sh assert 2]", () => {
    const proj = setupConstructionProject(SCOPE);
    const slug = `t-${SCOPE}-bolt-1`;
    const res = spawnSync(
      BUN,
      [
        BOLT,
        "dispatch-event",
        "--event",
        "MERGE_DISPATCH_INVOKED",
        "--slug",
        slug,
        "--practices-excerpt",
        `scope=${SCOPE}`,
        "--project-dir",
        proj,
      ],
      { encoding: "utf-8" },
    );
    // STRONGER than the .sh (which only grepped audit.md): the CLI exits 0 and
    // prints the emit-confirmation JSON to stdout.
    expect(res.status).toBe(0);
    const stdout = JSON.parse((res.stdout ?? "").trim());
    expect(stdout).toEqual({ emitted: "MERGE_DISPATCH_INVOKED", slug });

    // The audit row landed in the initialized project (the .sh's two greps).
    // P4: read the merged per-clone audit shards, not the retired flat audit.md.
    const audit = readAllAuditShards(proj);
    expect(audit.includes("**Event**: MERGE_DISPATCH_INVOKED")).toBe(true);
    // STRONGER: the exact slug line, not the .sh's loose "Bolt slug.*" pattern.
    expect(audit.includes(`**Bolt slug**: ${slug}`)).toBe(true);
    // STRONGER: EVENT_HEADINGS maps the event to this ## heading (aidlc-audit.ts:168).
    expect(audit.includes("## Merge Dispatch Invoked")).toBe(true);
  });

  // === .sh assert 4 — v7 state has v0.4.0 fields (mechanism cli) =============
  test("init writes a v7 state carrying Worktree Path + Bolt Refs for security-patch [.sh assert 4]", () => {
    const proj = setupConstructionProject(SCOPE);
    const state = readFileSync(
      join(recordDirOf(proj), "aidlc-state.md"),
      "utf-8",
    );
    // The .sh grepped the two field labels independently; assert both on the
    // v7 `- **<field>**:` shape the init template writes.
    expect(state).toContain("**Worktree Path**:");
    expect(state).toContain("**Bolt Refs**:");
  });
});
