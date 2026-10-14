// covers: subcommand:aidlc-bolt:dispatch-event, subcommand:aidlc-utility:init, audit:MERGE_DISPATCH_INVOKED, scope:bugfix
//
// bun:test port of tests/e2e/t65-construction-worktrees-bugfix.sh (TAP
// plan 4). Mechanism = MIXED: two of the four assertions are pure compiled-data
// reads (scope-grid.json, in-process require — mechanism none); the other two
// drive the REAL shipped tools across the process boundary (aidlc-utility
// intent-create scaffolds the v8 state, aidlc-bolt dispatch-event emits the
// audit row - mechanism cli).
//
// SUBJECT: the Construction-worktrees per-scope contract for the `bugfix` scope -
// a skeleton-off (incremental) scope: the data + tool contract this twin pins.
//
// Source under test:
//   dist/claude/.claude/tools/data/scope-grid.json
//     - the compiled transpose of every stage's `scopes:` frontmatter; the
//       runtime source of truth for per-scope stage mode.
//       bugfix.stages["code-generation"] === "EXECUTE"
//       (incremental scopes still build code) and
//       bugfix.stages["practices-discovery"] === "SKIP" (incremental scopes
//       don't rebuild practices each workflow).
//   dist/claude/.claude/tools/aidlc-utility.ts
//     handleIntentCreateStateBuild's state template (State Version 8) writes the
//       fields `- **Worktree Path**:` and `- **Bolt Refs**:` used by
//       Construction worktrees + practices-discovery.
//   dist/claude/.claude/tools/aidlc-bolt.ts
//     handleDispatchEvent - `dispatch-event --event MERGE_DISPATCH_INVOKED
//       --slug <slug> --practices-excerpt <text>` emits a MERGE_DISPATCH_INVOKED
//       audit row carrying `**Bolt slug**: <slug>` and a Practices section
//       excerpt field. Emit-only: no state mutation, no spawn.
//
// Also pinned:
//   - Assert 1/3 read the exact compiled value and assert strict equality on the
//     mode string.
//   - Assert 2 checks the MERGE_DISPATCH_INVOKED row AND the `**Bolt slug**:`
//     line are co-located in the SAME audit block (not merely both present
//     somewhere). It also asserts the tool's exit code and the emitted JSON
//     `{ emitted, slug }` contract.
//   - Assert 4 reads the two fields off the REAL intent-create-produced state
//     file (not a fixture) and asserts each appears as a `- **<field>**:` bullet
//     line, AND that the file carries `**State Version**: 8` - proving the fields
//     came from the current template, not a stale fixture.
//
// FIXTURE DISCIPLINE: the cli assertions share ONE freshly-scaffolded + inited
// project (beforeAll), torn down in afterAll. The data assertions read the
// shipped scope-grid.json directly and need no project. NOTHING is written
// under tests/fixtures/**.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  resetAidlcEnv,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
// intent-create CREATES a per-intent record; state lives under
// aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/ and audit is SHARDED per clone
// under <record>/audit/. Read state through the resolved record dir and audit
// through the shipped merge helper (default-resolves the active intent, falls
// back to the space-level shard when no intent resolves).
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const SCOPE_GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

// The compiled scope grid is the runtime source of truth for per-scope stage
// mode (the transpose of every stage's `scopes:` frontmatter). Read once.
interface ScopeGrid {
  [scope: string]: { stages: Record<string, string> };
}
const grid: ScopeGrid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8"));

const SCOPE = "bugfix";

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

describe("t65 Construction-worktrees per-scope contract — bugfix (migrated from t65-construction-worktrees-bugfix.sh, plan 4)", () => {
  // ===========================================================================
  // Data assertions (mechanism none): read the compiled scope-grid.json.
  // ===========================================================================
  test("1 (none): scope-grid bugfix code-generation = EXECUTE [.sh assert_scope_codegen_mode]", () => {
    // Incremental scopes still build code.
    expect(grid[SCOPE]).toBeDefined();
    expect(grid[SCOPE].stages["code-generation"]).toBe("EXECUTE");
  });

  test("3 (none): scope-grid bugfix practices-discovery = SKIP [.sh PD_MODE check]", () => {
    // Incremental scopes don't rebuild practices each workflow (the skeleton-off
    // stance is data, not SKILL.md U3 prose).
    expect(grid[SCOPE].stages["practices-discovery"]).toBe("SKIP");
  });

  // ===========================================================================
  // CLI assertions (mechanism cli): one shared inited bugfix project.
  // ===========================================================================
  let proj: string;

  beforeAll(() => {
    resetAidlcEnv();
    proj = setupIntegrationProject({ withGreenfieldStub: true });
    const init = spawnSync(
      BUN,
      [UTIL, "intent-create", "--project-dir", proj, "--force", "--scope", SCOPE],
      { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    if (init.status !== 0) {
      throw new Error(
        `aidlc-utility init failed (exit ${init.status}): ${init.stderr ?? ""}${init.stdout ?? ""}`,
      );
    }
  });

  afterAll(() => {
    cleanupTestProject(proj);
  });

  test("2 (cli): dispatch-event MERGE_DISPATCH_INVOKED emits for bugfix [.sh assert_dispatch_event_runs_for_scope]", () => {
    const slug = `t-${SCOPE}-bolt-1`;
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
        `scope=${SCOPE}`,
        "--project-dir",
        proj,
      ],
      { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    // The tool exits 0 and prints the { emitted, slug } JSON contract
    // (aidlc-bolt.ts handleDispatchEvent).
    expect(r.status).toBe(0);
    const printed = JSON.parse((r.stdout ?? "").trim());
    expect(printed.emitted).toBe("MERGE_DISPATCH_INVOKED");
    expect(printed.slug).toBe(slug);

    // Assert both land in the SAME audit block (the dispatch-event entry),
    // block-scoping the slug to the event.
    const audit = readAllAuditShards(proj);
    const block =
      audit
        .split(/\n(?=## )/)
        .find((b) => b.includes("**Event**: MERGE_DISPATCH_INVOKED")) ?? "";
    expect(block).toContain("**Event**: MERGE_DISPATCH_INVOKED");
    expect(block).toContain(`**Bolt slug**: ${slug}`);
    expect(block).toContain(`**Practices section excerpt**: scope=${SCOPE}`);
  });

  test("4 (cli): init writes v7 state with v0.4.0 Worktree Path + Bolt Refs fields [.sh grep Worktree Path && Bolt Refs]", () => {
    // Read the REAL state file (not a fixture).
    const state = readFileSync(
      join(recordDirOf(proj), "aidlc-state.md"),
      "utf-8",
    );
    const lines = state.split("\n");
    // Each field appears as a Project Information bullet line `- **<field>**:` (the
    // template at aidlc-utility.ts handleIntentCreateStateBuild), not merely as prose
    // somewhere in the file.
    expect(lines.some((l) => l.startsWith("- **Worktree Path**:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- **Bolt Refs**:"))).toBe(true);
    // Pin the current template version, proving they came from the current
    // intent-create template rather than a stale state shape.
    expect(state).toContain("**State Version**: 8");
  });
});
