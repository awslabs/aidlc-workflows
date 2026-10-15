// covers: data:scope-grid(security-patch), cli:aidlc-bolt(dispatch-event), cli:aidlc-utility(init), data:state-template(v0.4.0-fields)
//
// t67 — Construction worktrees per scope: the security-patch contract.
//
// Mechanism: MIXED.
//   - Assertions 1 + 3 are pure structural reads of the compiled
//     scope-grid.json (the runtime source of truth). Mechanism none: require the
//     JSON and assert the cell. The contract is the data, so we read it directly
//     with zero process spawn.
//   - Assertions 2 + 4 are process-boundary contracts: `aidlc-utility.ts
//     intent-create` must WRITE a v8 state file with the two fields, and
//     `aidlc-bolt.ts dispatch-event` must EMIT a real MERGE_DISPATCH_INVOKED
//     audit row into that initialized project. Mechanism cli: spawnSync the
//     real tools via BUN against the .ts paths and assert on the bytes they
//     write.
//
// Source under test:
//   - dist/claude/.claude/tools/data/scope-grid.json
//       security-patch.stages["code-generation"] === "EXECUTE"
//       security-patch.stages["practices-discovery"] === "SKIP"
//   - dist/claude/.claude/tools/aidlc-bolt.ts handleDispatchEvent
//       MERGE_DISPATCH_INVOKED branch: requires --slug +
//       --practices-excerpt; emits via emitAudit -> appendAuditEntry with
//       fields { "Bolt slug": slug, "Practices section excerpt": excerpt };
//       prints {"emitted":"MERGE_DISPATCH_INVOKED","slug":...} to stdout.
//   - dist/claude/.claude/tools/aidlc-audit.ts EVENT_HEADINGS maps
//       MERGE_DISPATCH_INVOKED -> "Merge Dispatch Invoked"; the **Event**:
//       and **Bolt slug**: lines land in the audit shards.
//   - aidlc-utility.ts handleIntentCreateStateBuild writes the record's
//       aidlc-state.md from the v8 template, which carries `- **Worktree Path**:`
//       and `- **Bolt Refs**:` (the Construction-worktree fields).
//
// Also pinned:
//   - assert 2: the CLI stdout JSON {"emitted","slug"}, the exact
//     "**Bolt slug**: t-security-patch-bolt-1" line, the "Merge Dispatch Invoked"
//     heading the EVENT_HEADINGS map produces, and exit code 0.
//   - assert 4: both field labels appear in the state file the intent-create
//     tool wrote.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";
// intent-create CREATES a per-intent record; state lives under
// aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/ and audit is SHARDED per clone
// under <record>/audit/. Read state through the resolved record dir and audit
// through the shipped merge helper (default-resolves the active intent, falls
// back to the space-level shard when no intent resolves).
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SCOPE_GRID_PATH = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

const SCOPE = "security-patch";

// scope-grid.json: { <scope>: { stages: { <stage>: <MODE> } } } — the
// transpose of per-stage `scopes:` frontmatter, compiled at build, the runtime
// source of truth. Read once, structurally.
interface ScopeGrid {
  [scope: string]: { stages: Record<string, string> };
}
const grid = JSON.parse(readFileSync(SCOPE_GRID_PATH, "utf-8")) as ScopeGrid;

const tempProjects: string[] = [];
afterAll(() => {
  for (const p of tempProjects) cleanupTestProject(p);
});

/**
 * A project with aidlc-docs/, then `aidlc-utility.ts intent-create --force
 * --scope <scope>` so aidlc-state.md and the rest of the v8 workspace exist (the
 * dispatch-event + state probes both read the created intent's record). Returns
 * the project dir.
 */
function setupConstructionProject(scope: string): string {
  const proj = createTestProject();
  tempProjects.push(proj);
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  const res = spawnSync(
    BUN,
    [UTILITY, "intent-create", "--project-dir", proj, "--force", "--scope", scope],
    { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
  );
  expect(res.status).toBe(0);
  return proj;
}

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

describe("t67 construction worktrees — security-patch (migrated from t67-construction-worktrees-security-patch.sh, plan 4)", () => {
  test("scope-grid: security-patch code-generation = EXECUTE [.sh assert 1]", () => {
    const entry = grid[SCOPE];
    expect(entry).toBeDefined();
    expect(entry.stages["code-generation"]).toBe("EXECUTE");
  });

  test("scope-grid: security-patch SKIPs practices-discovery [.sh assert 3]", () => {
    const entry = grid[SCOPE];
    expect(entry).toBeDefined();
    expect(entry.stages["practices-discovery"]).toBe("SKIP");
  });

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
      { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    expect(res.status).toBe(0);
    const stdout = JSON.parse((res.stdout ?? "").trim());
    expect(stdout).toEqual({ emitted: "MERGE_DISPATCH_INVOKED", slug });

    // Read the merged per-clone audit shards, not the flat audit.md.
    const audit = readAllAuditShards(proj);
    expect(audit.includes("**Event**: MERGE_DISPATCH_INVOKED")).toBe(true);
    expect(audit.includes(`**Bolt slug**: ${slug}`)).toBe(true);
    // EVENT_HEADINGS maps the event to this ## heading (aidlc-audit.ts).
    expect(audit.includes("## Merge Dispatch Invoked")).toBe(true);
  });

  test("init writes a v7 state carrying Worktree Path + Bolt Refs for security-patch [.sh assert 4]", () => {
    const proj = setupConstructionProject(SCOPE);
    const state = readFileSync(
      join(recordDirOf(proj), "aidlc-state.md"),
      "utf-8",
    );
    expect(state).toContain("**Worktree Path**:");
    expect(state).toContain("**Bolt Refs**:");
  });
});
