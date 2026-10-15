// covers: function:validScopes, subcommand:aidlc-utility:scope-table
//
// Mechanism = cli. DROPPING ONE .claude/scopes/aidlc-<name>.md file
// (frontmatter name/depth/keywords/description) makes <name> a valid scope
// that flows through EVERY tool that validates scopes (intent-create,
// scope-change, doctor) AND through the summary surface (scope-table) with no
// source edit and NO JSON file. The engine does not read the person's words
// for a plan; the agent proposes it (t-plan-proposed-by-the-agent). Every
// case SPAWNS the real binary (BUN + the tool .ts) against a fresh project
// whose .claude/scopes/ has a dropped fixture-scope.md, asserting on
// res.status / combined stdout+stderr / the state.md + audit shards the tool
// writes, the PROCESS boundary incl. exit codes.
//
// CURRENT SURFACE: AIDLC_SCOPE_MAPPING is the LEGACY
// TEST SEAM: when set, loadScopeMapping() reads the JSON VERBATIM and SKIPS the
// real derivation (aidlc-lib.ts). v0.6.0 DELETED scope-mapping.json from
// the shipped tree (verified absent on disk); the compiled scope-grid.json is now
// the EXECUTE/SKIP source and `.claude/scopes/*.md` frontmatter is the
// depth/keywords/description source (aidlc-lib.ts). The .sh
// authors a NEW scope the way a harness engineer actually does — it DROPS a
// .claude/scopes/aidlc-fixture-scope.md file and sets NO env var (t60.sh),
// exercising the real shipped derivation. This test mirrors that EXACTLY:
// it writes the fixture .md into each temp project's COPIED .claude/scopes/ and
// never sets AIDLC_SCOPE_MAPPING (it is even deleted from each spawn env so a
// developer's leaked shell var can't shadow the derivation). Test 0 below pins
// the current surface (scope-grid.json present, scope-mapping.json gone) so the
// obsolete old-source path can never silently come back as the seam under test.
//
// MECHANISM SPLIT - why this file spawns even though Test 2 imports a
// function symbol:
//   - The covers header credits function:validScopes precisely because the
//     .sh exercised it via a `bun -e "import { validScopes } ..."` SUBPROCESS
//     (t60.sh). We preserve that exact mechanism (a spawned `bun -e`
//     importing the shipped lib.ts symbol) so the function-unit credit is
//     earned the same way — same observable (the sorted scope list printed to
//     stdout).
//   - scope-table is exercised through the real aidlc-utility.ts CLI
//     subprocess and the table it prints — the .sh's `bun "$TOOL" scope-table`
//     (t60.sh).
//   - intent-create, scope-change, doctor: real-CLI spawns too (the .sh shelled
//     out to the same aidlc-utility.ts subcommands at t60.sh),
//     credited transitively to the derivation contract under test.
//
// FIXTURE DISCIPLINE: each case builds a FRESH integration sandbox via
// setupIntegrationProject (which copies dist/claude/.claude/ incl. the
// .claude/scopes/*.md set + tools/data/scope-grid.json + stage-graph.json),
// then DROPS one .claude/scopes/aidlc-fixture-scope.md into the COPIED tree.
// No env var, no JSON edit, no source edit. Nothing under tests/fixtures/** is
// written; the file lands in each temp project's own .claude/scopes/. All temp
// dirs cleaned in afterAll. State-reading cases use setupIntegrationProject
// (which routes the temp path through toPortablePath) so audit shards/state.md
// round-trip on Windows.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;

const toolIn = (proj: string, name: string): string =>
  join(proj, ".claude", "tools", name);

const utilityIn = (proj: string): string => toolIn(proj, "aidlc-utility.ts");

const fixtureScopeFile = (proj: string): string =>
  join(proj, ".claude", "scopes", "aidlc-fixture-scope.md");

// intent-create writes aidlc-state.md into a per-intent record
// (aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/), not the flat aidlc-docs/.
// Resolve the record dir from the active-space + active-intent cursors,
// falling back to the flat layout for a seeded-flat project.
function recordDirOf(proj: string): string {
  const spaceCursor = join(proj, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(proj, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(proj, "aidlc-docs");
}
const statePath = (proj: string): string =>
  join(recordDirOf(proj), "aidlc-state.md");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string;
  stdout: string;
}

/**
 * Spawn `bun <tool.ts> <args...>`, optionally with extra env.
 * AIDLC_SCOPE_MAPPING is force-DELETED from the child env so
 * the spawn always takes the real .claude/scopes/ derivation path, never the
 * legacy JSON test seam — even if a developer's shell leaks the var.
 */
function run(
  tool: string,
  args: string[],
  env: Record<string, string> = {},
): CliResult {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };
  delete childEnv.AIDLC_SCOPE_MAPPING;
  const res = spawnSync(BUN, [tool, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: childEnv as Record<string, string>,
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

function runEval(src: string, env: Record<string, string> = {}): CliResult {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };
  delete childEnv.AIDLC_SCOPE_MAPPING;
  const res = spawnSync(BUN, ["-e", src], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: childEnv as Record<string, string>,
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/**
 * DROP one .claude/scopes/aidlc-fixture-scope.md into the project's COPIED
 * scopes dir. Frontmatter carries name/depth/keywords/description. No JSON, no
 * grid edit, no code change - the EXECUTE/SKIP grid column stays empty (no
 * stage frontmatter names this scope), which intent-create tolerates (it stamps
 * the scope name + the always-EXECUTE init stages), the sole behaviour tests
 * 3-6 assert. Optionally attaches the `fixturetrigger` keyword.
 */
function setupFixtureScope(proj: string, withKeyword = false): void {
  const kwBlock = withKeyword
    ? "keywords:\n  - fixturetrigger"
    : "keywords: []";
  const body = `---
name: fixture-scope
depth: Minimal
${kwBlock}
description: Fixture scope for t60 derivation tests
---

# fixture-scope

Test-only scope dropped to prove validScopes() derives from
.claude/scopes/*.md presence with no code change.
`;
  writeFileSync(fixtureScopeFile(proj), body, "utf-8");
}

function freshProject(opts: {
  withState?: string;
  withAudit?: boolean;
} = {}): string {
  const proj = setupIntegrationProject({
    noAidlcDocs: !opts.withState && !opts.withAudit ? true : undefined,
    withState: opts.withState,
    withAudit: opts.withAudit,
    stripEnvScope: true,
  });
  tempDirs.push(proj);
  return proj;
}

// The 11 alphabetically-sorted default scopes. Pins the derivation
// baseline: validScopes() == sorted scope names from the shipped
// .claude/scopes/*.md set.
const EXPECTED_DEFAULT_SCOPES =
  "bugfix,classic,enterprise,express,feature,infra,mvp,poc,refactor,security-patch,workshop";

describe("t60 valid-scopes derived from .claude/scopes/*.md (migrated from t60-valid-scopes-derived.sh, plan 9)", () => {
  // --- Test 0: current-surface pin ---
  // Locks the surface this test asserts against: the compiled
  // scope-grid.json is present and the retired scope-mapping.json is ABSENT
  // from the shipped tree. Guards against a regression that would resurrect
  // the deleted JSON source-of-truth or remove the compiled grid.
  test("0: shipped tree has scope-grid.json and no scope-mapping.json", () => {
    const dataDir = join(AIDLC_SRC, "tools", "data");
    expect(existsSync(join(dataDir, "scope-grid.json"))).toBe(true);
    expect(existsSync(join(dataDir, "scope-mapping.json"))).toBe(false);
    // The .claude/scopes/*.md set is the scope-NAME source; confirm one of the
    // shipped scope files exists so the derivation has real metadata to read.
    expect(existsSync(join(AIDLC_SRC, "scopes", "aidlc-feature.md"))).toBe(true);
  });

  test("1: no VALID_SCOPES references in shipped tools/", () => {
    const toolsDir = join(AIDLC_SRC, "tools");
    const res = spawnSync("grep", ["-rE", "VALID_SCOPES", toolsDir], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    // grep exits 1 (no lines) on a clean tree, 0 (with output) if found.
    expect(res.status).not.toBe(0);
    expect(res.stdout ?? "").toBe("");
  });

  test("2: validScopes() returns 9 alphabetically-sorted scopes", () => {
    // Spawn `bun -e import { validScopes } from <shipped lib.ts>` against the
    // shipped tree (no fixture scope dropped). The fresh process reads
    // .claude/scopes/*.md, no cache.
    const lib = join(AIDLC_SRC, "tools", "aidlc-lib.ts");
    const r = runEval(
      `import { validScopes } from ${JSON.stringify(lib)}; console.log([...validScopes()].join(","));`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").pop()).toBe(EXPECTED_DEFAULT_SCOPES);
  });

  test("3: init --scope fixture-scope succeeds against dropped .claude/scopes/ file", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(utilityIn(proj), [
      "intent-create",
      "--scope",
      "fixture-scope",
      "--project-dir",
      proj,
    ]);
    expect(r.status).toBe(0);
    const state = readFileSync(statePath(proj), "utf-8");
    expect(state.split("\n")).toContain("- **Scope**: fixture-scope");
  });

  test("4: init --scope bogus error message lists fixture-scope", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(utilityIn(proj), [
      "intent-create",
      "--scope",
      "bogus-notascope",
      "--project-dir",
      proj,
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("fixture-scope");
  });

  test("5: scope-change --scope fixture-scope succeeds (covers state-write surface)", () => {
    const proj = freshProject({
      withState: join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md"),
      withAudit: true,
    });
    setupFixtureScope(proj);
    const r = run(utilityIn(proj), [
      "scope-change",
      "--scope",
      "fixture-scope",
      "--project-dir",
      proj,
    ]);
    expect(r.status).toBe(0);
    const state = readFileSync(statePath(proj), "utf-8");
    expect(state.split("\n")).toContain("- **Scope**: fixture-scope");
  });

  test("6: doctor fix hint for invalid AWS_AIDLC_DEFAULT_SCOPE lists fixture-scope", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(utilityIn(proj), ["doctor", "--project-dir", proj], {
      AWS_AIDLC_DEFAULT_SCOPE: "still-bogus",
    });
    // doctor reports the invalid env-scope row with a fix line enumerating the
    // valid scopes — fixture-scope among them. (Doctor exits non-zero when any
    // check fails; the observable is the fixture-scope mention.)
    expect(r.out).toContain("fixture-scope");
  });

  test("8: scope-table includes fixture-scope row from dropped .claude/scopes/ file", () => {
    const proj = freshProject();
    setupFixtureScope(proj, /* withKeyword */ true);
    const r = run(utilityIn(proj), ["scope-table"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("| fixture-scope");
  });

});
