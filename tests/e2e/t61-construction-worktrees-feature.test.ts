// covers: data:scope-grid.json, subcommand:aidlc-bolt:dispatch-event, doc:knowledge/aidlc-shared/state-template.md
//
// Construction worktrees per scope - FEATURE.
// Mechanism: mixed.
//   - The two scope-grid.json reads are pure structural reads of a shipped JSON
//     data file - done in-process (no spawn, no LLM).
//   - The two dispatch-event audit emits and the creation-built state-template
//     check cross the PROCESS boundary: they spawn the real `aidlc-bolt.ts
//     dispatch-event` / `aidlc-utility.ts intent-create` tools via the bun
//     runtime and assert on the audit shards / aidlc-state.md those subprocesses
//     write.
//
// Source under test:
//   dist/claude/.claude/tools/data/scope-grid.json
//     - the compiled {scope:{stages:{slug:MODE}}} grid (milestone 12 transpose of the
//       per-stage `scopes:` frontmatter). feature
//       runs code-generation = EXECUTE and practices-discovery = EXECUTE.
//   dist/claude/.claude/tools/aidlc-bolt.ts handleDispatchEvent
//     - MERGE_DISPATCH_INVOKED  -> emits audit with fields "Bolt slug" +
//       "Practices section excerpt"
//     - MERGE_DISPATCH_RETURNED -> emits audit with fields "Bolt slug",
//       Strategy, "Target branch", Confidence, Notes
//     emit-only: no state mutation, no spawn; pure audit emission via emitAudit.
//   dist/claude/.claude/tools/aidlc-utility.ts handleIntentCreateStateBuild
//     - the State Version 8 template carries the Construction-worktrees fields
//       `- **Worktree Path**:` and `- **Bolt Refs**:`.
//
// Assertion shape:
//   - test 2 is block-scoped: it reads the "Bolt slug" field off the
//     MERGE_DISPATCH_INVOKED audit entry specifically, AND asserts the tool's
//     JSON ack on stdout + a clean exit.
//   - test 4 is block-scoped to the MERGE_DISPATCH_RETURNED entry and pins the
//     full RETURNED field set (Strategy/Target branch/Confidence/Notes).
//   - test 5 asserts both fields land as proper `- **<field>**:` state lines
//     (not a bare substring anywhere in the file), and that creation exited 0.
//
// FIXTURE DISCIPLINE: setupIntegrationProject with the greenfield stub, then
// `aidlc-utility intent-create --force --scope feature`: one shared FEATURE
// construction sandbox is built once in beforeAll and torn down in afterAll.
// NOTHING is written under tests/fixtures/**; the temp dir is cleaned up.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
// Intent creation CREATES a per-intent record; state lives under
// aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/ and audit is SHARDED per clone
// under <record>/audit/. Read state through the resolved record dir and audit
// through the shipped merge helper (default-resolves the active intent).
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SCOPE_GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

const SCOPE = "feature";

interface Grid {
  [scope: string]: { stages: Record<string, string> };
}

let proj = "";

beforeAll(() => {
  proj = setupIntegrationProject({ withGreenfieldStub: true });
  const r = spawnSync(
    BUN,
    [UTILITY, "intent-create", "--project-dir", proj, "--force", "--scope", SCOPE],
    { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
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

// Resolve the created intent's record dir from the active-space + active-intent
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

const statePath = (): string => join(recordDirOf(proj), "aidlc-state.md");
/** Merged audit-shard text for the created intent (audit is sharded per clone). */
const auditText = (): string => readAllAuditShards(proj);

function bolt(args: string[]): { status: number; stdout: string; out: string } {
  const r = spawnSync(BUN, [BOLT, ...args, "--project-dir", proj], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
    encoding: "utf-8",
  });
  const stdout = r.stdout ?? "";
  return { status: r.status ?? -1, stdout, out: `${stdout}${r.stderr ?? ""}` };
}

/**
 * Read the FIRST value of <key> from an audit block whose `**Event**:` matches
 * <ev>. Block-scoped (resets at `## ` headings and `---`). Returns "" when
 * absent. Pins the field to the right event.
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

function auditEventCount(ev: string): number {
  return auditText()
    .split("\n")
    .filter((l) => l === `**Event**: ${ev}`).length;
}

describe("t61 construction worktrees — feature (migrated from t61-construction-worktrees-feature.sh, plan 5)", () => {
  test("1: scope-grid feature code-generation = EXECUTE", () => {
    const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Grid;
    expect(grid[SCOPE]).toBeDefined();
    expect(grid[SCOPE].stages["code-generation"]).toBe("EXECUTE");
  });

  test("3: scope-grid feature EXECUTEs practices-discovery", () => {
    const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as Grid;
    expect(grid[SCOPE].stages["practices-discovery"]).toBe("EXECUTE");
  });

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
    // The slug is read off the MERGE_DISPATCH_INVOKED block itself.
    expect(auditEventCount("MERGE_DISPATCH_INVOKED")).toBe(1);
    expect(auditField("MERGE_DISPATCH_INVOKED", "Bolt slug")).toBe(slug);
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_INVOKED"');
    expect(r.stdout).toContain(`"slug":"${slug}"`);
  });

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
    expect(auditEventCount("MERGE_DISPATCH_RETURNED")).toBe(1);
    // Pin the full RETURNED field set, block-scoped to the event.
    expect(auditField("MERGE_DISPATCH_RETURNED", "Bolt slug")).toBe(slug);
    expect(auditField("MERGE_DISPATCH_RETURNED", "Strategy")).toBe("squash");
    expect(auditField("MERGE_DISPATCH_RETURNED", "Target branch")).toBe("main");
    expect(auditField("MERGE_DISPATCH_RETURNED", "Confidence")).toBe("0.85");
    expect(auditField("MERGE_DISPATCH_RETURNED", "Notes")).toBe("trunk-based");
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_RETURNED"');
  });

  test("5: v7 init state carries the v0.4.0 worktree fields", () => {
    const lines = readFileSync(statePath(), "utf-8").split("\n");
    // Both land as proper `- **<field>**:` state lines (the v8 template at
    // aidlc-utility.ts handleIntentCreateStateBuild), not bare substrings anywhere.
    expect(lines.some((l) => l.startsWith("- **Worktree Path**:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- **Bolt Refs**:"))).toBe(true);
    expect(lines).toContain("- **State Version**: 8");
  });
});
