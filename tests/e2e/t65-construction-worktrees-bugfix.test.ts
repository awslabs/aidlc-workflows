// covers: subcommand:aidlc-bolt:dispatch-event, subcommand:aidlc-utility:init, audit:MERGE_DISPATCH_INVOKED, scope:bugfix
//
// bun:test port of tests/e2e/t65-construction-worktrees-bugfix.sh (TAP
// plan 4). Mechanism = MIXED: two of the four assertions are pure compiled-data
// reads (scope-grid.json, in-process require — mechanism none); the other two
// drive the REAL shipped tools across the process boundary (aidlc-utility init
// scaffolds the v7 state, aidlc-bolt dispatch-event emits the audit row —
// mechanism cli). Each assertion targets the surface the .sh actually probed.
//
// SUBJECT: the v0.4.0 milestone 13 Construction-worktrees per-scope contract for the
// `bugfix` scope — a skeleton-off (incremental) scope. The four SKILL.md
// prose-presence checks the original test set carried were RETIRED at the engine
// cutover (Wave 2): per-Bolt dispatch routing is now an engine concern, not
// SKILL.md prose.
// What remains is the data + tool contract this twin pins.
//
// Source under test:
//   dist/claude/.claude/tools/data/scope-grid.json
//     - the compiled transpose of every stage's `scopes:` frontmatter; the
//       runtime source of truth for per-scope stage mode (milestone 12 retired
//       scope-mapping.json). bugfix.stages["code-generation"] === "EXECUTE"
//       (incremental scopes still build code) and
//       bugfix.stages["practices-discovery"] === "SKIP" (incremental scopes
//       don't rebuild practices each workflow).
//   dist/claude/.claude/tools/aidlc-utility.ts
//     :2048 init's state template (State Version 7) writes the v0.4.0 fields
//       `- **Worktree Path**:` (:2057) and `- **Bolt Refs**:` (:2058) used by
//       Construction worktrees + practices-discovery.
//   dist/claude/.claude/tools/aidlc-bolt.ts
//     :660 handleDispatchEvent — `dispatch-event --event MERGE_DISPATCH_INVOKED
//       --slug <slug> --practices-excerpt <text>` emits a MERGE_DISPATCH_INVOKED
//       audit row carrying `**Bolt slug**: <slug>` and a Practices section
//       excerpt field (:670-684). Emit-only: no state mutation, no spawn.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh assert_scope_codegen_mode "bugfix" "EXECUTE"   -> "1 (none): scope-grid bugfix code-generation = EXECUTE"
//   .sh assert_dispatch_event_runs_for_scope bugfix    -> "2 (cli): dispatch-event MERGE_DISPATCH_INVOKED emits for bugfix"
//   .sh PD_MODE == SKIP                                 -> "3 (none): scope-grid bugfix practices-discovery = SKIP"
//   .sh grep Worktree Path && grep Bolt Refs on state   -> "4 (cli): init writes v7 state with v0.4.0 Worktree Path + Bolt Refs fields"
//
// STRONGER than the .sh where it costs nothing:
//   - Assert 1/3 read the exact compiled value and assert strict equality on the
//     mode string (the .sh's bun -e require + string compare), AND additionally
//     pin State Version 7 absence-of-ambiguity by reading the field as exactly
//     "EXECUTE"/"SKIP".
//   - Assert 2 checks the MERGE_DISPATCH_INVOKED row AND the `**Bolt slug**:`
//     line are co-located in the SAME audit block (not merely both present
//     somewhere), mirroring the .sh's two greps but block-scoping the slug to
//     the event the .sh only asserted globally. It also asserts the tool's exit
//     code and the emitted JSON `{ emitted, slug }` contract.
//   - Assert 4 reads the two fields off the REAL init-produced state file (not a
//     fixture) and asserts each appears as a `- **<field>**:` bullet line, AND
//     that the file carries `State Version: 7` (the version that introduced the
//     fields the .sh greps for) — proving the fields came from the current
//     template, not a stale fixture.
//
// FIXTURE DISCIPLINE (mirrors the .sh's setup_construction_project: a greenfield-
// stub integration project + `aidlc-utility init --force --scope bugfix`, then
// cleanup_test_project): the cli assertions share ONE freshly-scaffolded +
// inited project (beforeAll), torn down in afterAll. The data assertions read
// the shipped scope-grid.json directly and need no project. NOTHING is written
// under tests/fixtures/**.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  resetAidlcEnv,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
// P4: init BIRTHS a per-intent record; state lives under
// aidlc/spaces/<space>/intents/<slug>-<id8>/ and audit is SHARDED per clone
// under <record>/audit/. Read state through the resolved record dir and audit
// through the shipped merge helper (default-resolves the active intent, falls
// back to flat aidlc-docs for a not-yet-born project).
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
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

describe("t65 Construction-worktrees per-scope contract — bugfix (migrated from t65-construction-worktrees-bugfix.sh, plan 4)", () => {
  // ===========================================================================
  // Data assertions (mechanism none): read the compiled scope-grid.json.
  // ===========================================================================
  test("1 (none): scope-grid bugfix code-generation = EXECUTE [.sh assert_scope_codegen_mode]", () => {
    // The .sh ran `bun -e "require(grid).bugfix.stages['code-generation']"` and
    // compared to "EXECUTE". Incremental scopes still build code.
    expect(grid[SCOPE]).toBeDefined();
    expect(grid[SCOPE].stages["code-generation"]).toBe("EXECUTE");
  });

  test("3 (none): scope-grid bugfix practices-discovery = SKIP [.sh PD_MODE check]", () => {
    // The .sh ran `bun -e "require(MAPPING).bugfix.stages['practices-discovery']"`
    // and asserted == "SKIP". Incremental scopes don't rebuild practices each
    // workflow (the skeleton-off stance is data, not SKILL.md U3 prose).
    expect(grid[SCOPE].stages["practices-discovery"]).toBe("SKIP");
  });

  // ===========================================================================
  // CLI assertions (mechanism cli): one shared inited bugfix project.
  // Mirrors setup_construction_project("bugfix"):
  //   setup_integration_project --with-greenfield-stub
  //   bun aidlc-utility init --project-dir <p> --force --scope bugfix
  // ===========================================================================
  let proj: string;

  beforeAll(() => {
    resetAidlcEnv();
    proj = setupIntegrationProject({ withGreenfieldStub: true });
    const init = spawnSync(
      BUN,
      [UTIL, "intent-birth", "--project-dir", proj, "--force", "--scope", SCOPE],
      { encoding: "utf-8" },
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
      { encoding: "utf-8" },
    );
    // The tool exits 0 and prints the { emitted, slug } JSON contract
    // (aidlc-bolt.ts:683). STRONGER than the .sh, which swallowed exit/output.
    expect(r.status).toBe(0);
    const printed = JSON.parse((r.stdout ?? "").trim());
    expect(printed.emitted).toBe("MERGE_DISPATCH_INVOKED");
    expect(printed.slug).toBe(slug);

    // The .sh grepped the audit file for "MERGE_DISPATCH_INVOKED" AND for a
    // "Bolt slug.*<slug>" line, independently. STRONGER here: assert both land
    // in the SAME audit block (the dispatch-event entry), block-scoping the slug
    // to the event the .sh only matched globally.
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
    // The .sh grepped the init-produced aidlc-state.md for both "Worktree Path"
    // and "Bolt Refs". Read the REAL state file (not a fixture).
    const state = readFileSync(
      join(recordDirOf(proj), "aidlc-state.md"),
      "utf-8",
    );
    const lines = state.split("\n");
    // STRONGER than a bare substring grep: each field appears as a Project
    // Information bullet line `- **<field>**:` (the template at
    // aidlc-utility.ts:2057-2058), not merely as prose somewhere in the file.
    expect(lines.some((l) => l.startsWith("- **Worktree Path**:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- **Bolt Refs**:"))).toBe(true);
    // Pin the template version that introduced these fields, proving they came
    // from the current init template rather than a stale state shape.
    expect(state).toContain("**State Version**: 7");
  });
});
