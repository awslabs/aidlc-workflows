// covers: data:scope-grid.json(enterprise), cli:aidlc-bolt(dispatch-event), cli:aidlc-utility(init)
//
// t60 — Construction worktrees per scope, ENTERPRISE (v0.4.0 milestone 13).
// Migrated from tests/e2e/t60-construction-worktrees-enterprise.sh
// (TAP plan 5; the four SKILL.md prose-presence checks were RETIRED at the
// engine cutover, so the .sh already stood at 5 behavioural assertions). Two
// assertions lived in the sourced construction helper (assert_scope_codegen_mode and
// assert_dispatch_event_runs_for_scope); three inline in the .sh body.
//
// Mechanism: cli. The .sh's surviving assertions exercise PROCESS-boundary
// seams — the `aidlc-bolt dispatch-event` subcommand (audit emission via
// process), the `aidlc-utility init` subcommand (writes aidlc-state.md), and
// the shipped scope-grid.json data file the orchestrator reads at runtime. The
// dispatch-event/init contracts are observable only on disk after the spawned
// tool runs (audit.md rows, aidlc-state.md fields); the .sh shelled out to
// `bun aidlc-bolt.ts ...` / `bun aidlc-utility.ts init ...` exactly so. We
// preserve that by SPAWNING the real tools via the bun runtime against the .ts
// paths (the milestone 3 broadened-cli arm). The grid read is a JSON.parse of the same
// shipped file the .sh `require()`d — a structural data check, kept cli-tier
// because it shares the construction-project fixture with the spawn cases.
//
// SOURCE UNDER TEST (verified this session):
//   - scope grid: dist/claude/.claude/tools/data/scope-grid.json — enterprise
//     maps code-generation=EXECUTE and practices-discovery=EXECUTE (read at
//     test time; the runtime source of truth, the transpose of per-stage
//     `scopes:` frontmatter — milestone 12 retired scope-mapping.json).
//   - dispatch-event: aidlc-bolt.ts:660 handleDispatchEvent. Three literal
//     emit cases (t48 emitter-pairing). MERGE_DISPATCH_INVOKED (:670) requires
//     --practices-excerpt; emits {Bolt slug, Practices section excerpt}.
//     MERGE_DISPATCH_RETURNED (:686) requires --strategy/--target/--confidence/
//     --notes; emits {Bolt slug, Strategy, Target branch, Confidence, Notes}.
//     Each emits via appendAuditEntry → audit.md, then prints
//     {"emitted":<EVENT>,"slug":<slug>} to stdout. Emit-only: no state mutation.
//   - init: aidlc-utility.ts:1720 handleInit → writeStateFile (:2103). The v7
//     state template (:2049-2059) carries State Version 7 plus the three
//     v0.4.0 fields: **Worktree Path**, **Bolt Refs**, **Practices Affirmed
//     Timestamp**. setup_construction_project ran `init --force --scope <s>`.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (helper assert_scope_codegen_mode "enterprise" "EXECUTE")
//        -> "scope-grid.json: enterprise code-generation = EXECUTE"
//   .sh test 2 (helper assert_dispatch_event_runs_for_scope: INVOKED emits +
//               Bolt slug row present)
//        -> "dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for enterprise"
//   .sh test 3 (inline: grid enterprise.practices-discovery == EXECUTE)
//        -> "scope-grid.json: enterprise practices-discovery = EXECUTE (skeleton-on)"
//   .sh test 4 (inline: dispatch-event MERGE_DISPATCH_RETURNED brackets the
//               dispatch, post-call emit, row in audit.md)
//        -> "dispatch-event MERGE_DISPATCH_RETURNED brackets the dispatch (post-call emit)"
//   .sh test 5 (inline: v7 state has Worktree Path + Bolt Refs + Practices
//               Affirmed Timestamp)
//        -> "v7 state carries the three v0.4.0 fields after init --scope enterprise"
//
// Equal-or-stronger: STRONGER than the .sh on three rows —
//   - test 2 asserts the INVOKED block carries the exact `**Bolt slug**:
//     t-enterprise-bolt-1` AND the Practices-excerpt field co-located in the
//     SAME audit block (the .sh grepped the slug anywhere in the file), and
//     asserts the stdout JSON contract. The .sh only grepped two independent
//     substrings.
//   - test 4 asserts RETURNED's block carries Strategy=squash / Target=main /
//     Confidence=0.9 co-located with the slug (the .sh grepped only the event
//     name), and the post-call ordering (RETURNED's block comes AFTER the
//     INVOKED block in file order — the "brackets the dispatch" contract).
//   - test 5 asserts State Version is exactly 7 in addition to the three field
//     labels (the .sh checked only the three labels).
//
// SCOPE = "enterprise" throughout (the per-scope test's single scope, the .sh's
// $PROJ=$(setup_construction_project "enterprise")).

import { afterEach, describe, expect, test } from "bun:test";
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
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SCOPE_GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

const SCOPE = "enterprise";

let projects: string[] = [];

afterEach(() => {
  for (const p of projects) cleanupTestProject(p);
  projects = [];
});

/**
 * setup_construction_project (helper :39): a bare temp project with aidlc-docs/,
 * then `aidlc-utility init --force --scope <scope>` so aidlc-state.md exists
 * (both the orchestrator and dispatch-event probe that path). We spawn the real
 * init tool, exactly as the helper shelled out to `bun aidlc-utility.ts init`.
 */
function setupConstructionProject(scope: string): string {
  const proj = createTestProject();
  projects.push(proj);
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  const r = spawnSync(
    BUN,
    [UTIL, "intent-birth", "--project-dir", proj, "--force", "--scope", scope],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `aidlc-utility init --scope ${scope} failed (exit ${r.status}): ${r.stderr || r.stdout}`,
    );
  }
  return proj;
}

/** Parse the shipped scope-grid.json (the same file the .sh require()'d). */
function gridStageMode(scope: string, stage: string): string {
  const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Record<
    string,
    { stages: Record<string, string> }
  >;
  const entry = grid[scope];
  if (!entry) return "MISSING";
  return entry.stages[stage] ?? "UNDEFINED";
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

function statePath(proj: string): string {
  return join(recordDirOf(proj), "aidlc-state.md");
}

/** Merged audit-shard text for the born intent (P4 shards audit per clone). */
function auditText(proj: string): string {
  return readAllAuditShards(proj);
}

/** The `\n---\n`-delimited audit blocks (mirrors t138's block split). */
function auditBlocks(proj: string): string[] {
  return auditText(proj).split(/\n---\n/);
}

/** The block whose **Event**: line names `event` (first match, file order). */
function blockForEvent(proj: string, event: string): string {
  return (
    auditBlocks(proj).find((b) =>
      new RegExp(`^\\*\\*Event\\*\\*:\\s*${event}\\s*$`, "m").test(b),
    ) ?? ""
  );
}

describe("t60 Construction worktrees per scope — enterprise (cli)", () => {
  // .sh test 1 (helper assert_scope_codegen_mode "enterprise" "EXECUTE")
  test("scope-grid.json: enterprise code-generation = EXECUTE [.sh test 1]", () => {
    // The compiled grid entry's code-generation mode is the per-scope codegen
    // mode the .sh asserted via assert_scope_codegen_mode. EXECUTE = the
    // Construction codegen stage runs for this scope.
    expect(gridStageMode(SCOPE, "code-generation")).toBe("EXECUTE");
  });

  // .sh test 3 (inline grid read: enterprise.practices-discovery == EXECUTE)
  test("scope-grid.json: enterprise practices-discovery = EXECUTE (skeleton-on) [.sh test 3]", () => {
    // enterprise has the full Inception phase; practices-discovery EXECUTEs,
    // which drives the skeleton-on stance (the .sh's "drives skeleton-on" note).
    expect(gridStageMode(SCOPE, "practices-discovery")).toBe("EXECUTE");
  });

  // .sh test 2 (helper assert_dispatch_event_runs_for_scope)
  test("dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for enterprise [.sh test 2]", () => {
    const proj = setupConstructionProject(SCOPE);
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
    // Clean exit + the emit-only stdout contract (aidlc-bolt.ts:683).
    expect(r.status).toBe(0);
    const parsed = JSON.parse((r.stdout ?? "").trim());
    expect(parsed.emitted).toBe("MERGE_DISPATCH_INVOKED");
    expect(parsed.slug).toBe(slug);

    // STRONGER than the .sh's two independent greps: the INVOKED audit block
    // carries the event, the exact Bolt slug, AND the practices-excerpt field,
    // all co-located in the SAME `\n---\n`-delimited block.
    const block = blockForEvent(proj, "MERGE_DISPATCH_INVOKED");
    expect(block).toContain("**Event**: MERGE_DISPATCH_INVOKED");
    expect(block).toContain(`**Bolt slug**: ${slug}`);
    expect(block).toContain(`**Practices section excerpt**: scope=${SCOPE}`);
  });

  // .sh test 4 (inline: MERGE_DISPATCH_RETURNED post-call bracket emit)
  test("dispatch-event MERGE_DISPATCH_RETURNED brackets the dispatch (post-call emit) [.sh test 4]", () => {
    const proj = setupConstructionProject(SCOPE);
    const slug = `t-${SCOPE}-bolt-1`;

    // Full audit-of-intent bracket: INVOKED was emitted first (pre-call), then
    // RETURNED on successful parse (post-call). Emit INVOKED, then RETURNED, and
    // assert RETURNED's block lands AFTER INVOKED's in file order.
    const invoked = spawnSync(
      BUN,
      [
        BOLT, "dispatch-event", "--event", "MERGE_DISPATCH_INVOKED",
        "--slug", slug, "--practices-excerpt", `scope=${SCOPE}`,
        "--project-dir", proj,
      ],
      { encoding: "utf-8" },
    );
    expect(invoked.status).toBe(0);

    const r = spawnSync(
      BUN,
      [
        BOLT, "dispatch-event", "--event", "MERGE_DISPATCH_RETURNED",
        "--slug", slug,
        "--strategy", "squash",
        "--target", "main",
        "--confidence", "0.9",
        "--notes", "trunk-based per rules/aidlc-team.md",
        "--project-dir", proj,
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse((r.stdout ?? "").trim());
    expect(parsed.emitted).toBe("MERGE_DISPATCH_RETURNED");
    expect(parsed.slug).toBe(slug);

    // STRONGER: the RETURNED block carries the slug + Strategy/Target/Confidence
    // fields co-located (aidlc-bolt.ts:698-704), not merely the event name.
    const block = blockForEvent(proj, "MERGE_DISPATCH_RETURNED");
    expect(block).toContain("**Event**: MERGE_DISPATCH_RETURNED");
    expect(block).toContain(`**Bolt slug**: ${slug}`);
    expect(block).toContain("**Strategy**: squash");
    expect(block).toContain("**Target branch**: main");
    expect(block).toContain("**Confidence**: 0.9");

    // The "brackets the dispatch" contract: RETURNED is the post-call emit, so
    // its block appears AFTER the pre-call INVOKED block in audit.md.
    const text = auditText(proj);
    const invokedIdx = text.indexOf("**Event**: MERGE_DISPATCH_INVOKED");
    const returnedIdx = text.indexOf("**Event**: MERGE_DISPATCH_RETURNED");
    expect(invokedIdx).toBeGreaterThanOrEqual(0);
    expect(returnedIdx).toBeGreaterThan(invokedIdx);
  });

  // .sh test 5 (inline: v7 state has the three v0.4.0 fields)
  test("v7 state carries the three v0.4.0 fields after init --scope enterprise [.sh test 5]", () => {
    const proj = setupConstructionProject(SCOPE);
    const state = readFileSync(statePath(proj), "utf-8");
    // STRONGER: pin State Version 7 in addition to the three field labels.
    expect(state).toContain("**State Version**: 7");
    expect(state).toContain("**Worktree Path**:");
    expect(state).toContain("**Bolt Refs**:");
    expect(state).toContain("**Practices Affirmed Timestamp**:");
  });
});
