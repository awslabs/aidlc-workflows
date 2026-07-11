// covers: function:validScopes, subcommand:aidlc-utility:detect-scope, subcommand:aidlc-utility:scope-table
//
// CLI-contract port of tests/unit/t60-valid-scopes-derived.sh (TAP plan 9),
// mechanism = cli. The .sh proves that DROPPING ONE .claude/scopes/aidlc-<name>.md
// file (frontmatter name/depth/keywords/description) makes <name> a valid scope
// that flows through EVERY tool that validates scopes (init, scope-change,
// doctor) AND through the NL/summary surfaces (detect-scope --from-text,
// scope-table) with no source edit and NO JSON file. Equal-or-stronger
// migration: every .sh assertion is preserved by SPAWNING the real binary
// (BUN + the tool .ts) against the SAME surface the .sh exercised — a fresh
// project whose .claude/scopes/ has a dropped fixture-scope.md — and asserting
// on res.status / combined stdout+stderr / the state.md + audit.md the tool
// writes, the PROCESS boundary incl. exit codes.
//
// ── CURRENT-SURFACE CORRECTION (audit fold-in) ───────────────────────────────
// An earlier draft of this twin injected `fixture-scope` via a
// scope-mapping.fixture.json + AIDLC_SCOPE_MAPPING. That env-var is the LEGACY
// TEST SEAM: when set, loadScopeMapping() reads the JSON VERBATIM and SKIPS the
// real derivation (aidlc-lib.ts:805-825). v0.6.0 DELETED scope-mapping.json from
// the shipped tree (verified absent on disk); the compiled scope-grid.json is now
// the EXECUTE/SKIP source and `.claude/scopes/*.md` frontmatter is the
// depth/keywords/description source (aidlc-lib.ts:699-704, 827-849). The .sh
// authors a NEW scope the way a harness engineer actually does — it DROPS a
// .claude/scopes/aidlc-fixture-scope.md file and sets NO env var (t60.sh:53-81),
// exercising the real shipped derivation. This twin now mirrors that EXACTLY:
// it writes the fixture .md into each temp project's COPIED .claude/scopes/ and
// never sets AIDLC_SCOPE_MAPPING (it is even deleted from each spawn env so a
// developer's leaked shell var can't shadow the derivation). Test 0 below pins
// the current surface (scope-grid.json present, scope-mapping.json gone) so the
// obsolete old-source path can never silently come back as the seam under test.
//
// MECHANISM SPLIT — why this is a .cli file even though Test 2 imports a
// function symbol:
//   - The covers header credits function:validScopes precisely because the
//     .sh exercised it via a `bun -e "import { validScopes } ..."` SUBPROCESS
//     (t60.sh:46). We preserve that exact mechanism (a spawned `bun -e`
//     importing the shipped lib.ts symbol) so the function-unit credit is
//     earned the same way — same observable (the sorted scope list printed to
//     stdout). Likewise Test 7's inferScopeFromText is a spawned `bun -e`
//     against the project's utility.ts, mirroring the .sh's inline `bun -e`
//     at t60.sh:138-141 (a fresh process => no cache => reads the dropped .md).
//   - detect-scope and scope-table are exercised through the real
//     aidlc-utility.ts CLI subprocess + the audit.md it appends to and the
//     table it prints — the .sh's `bun "$TOOL" detect-scope ...` /
//     `bun "$TOOL" scope-table` (t60.sh:145-150).
//   - init / scope-change / doctor are also real-CLI spawns (the .sh shelled
//     out to the same aidlc-utility.ts subcommands at t60.sh:87,101,110,123),
//     credited transitively to the derivation contract under test.
//
// PARITY MAP (.sh `ok`/assert line -> test() below; STRONGER additions noted):
//   - t60.sh Test 1  grep VALID_SCOPES gone from tools/        -> Test 1:
//       a recursive scan of dist/claude/.claude/tools/ for VALID_SCOPES
//       returns zero hits (same observable — symbol absent from shipped src).
//   - t60.sh Test 2  validScopes() default == 9 sorted scopes  -> Test 2:
//       spawned `bun -e import {validScopes}` stdout === the 9-scope CSV
//       (same observable + STRONGER: also pins rc 0 on the import subprocess).
//   - t60.sh Test 3  init --scope fixture-scope succeeds + state Scope line
//       -> Test 3: res.status 0 AND state.md contains
//       `- **Scope**: fixture-scope` (same two observables).
//   - t60.sh Test 4  init --scope bogus error lists fixture-scope -> Test 4:
//       combined out contains "fixture-scope" (same) + STRONGER: status === 1.
//   - t60.sh Test 5  scope-change --scope fixture-scope -> state Scope line
//       -> Test 5: state.md `- **Scope**: fixture-scope` (same) + STRONGER:
//       res.status === 0.
//   - t60.sh Test 6  doctor invalid env-scope fix hint lists fixture-scope
//       -> Test 6: combined out contains "fixture-scope" (same observable;
//       the fix line is `valid values: …, fixture-scope, …`).
//   - t60.sh Test 7  inferScopeFromText picks fixture-scope from keyword
//       -> Test 7: spawned `bun -e` (utility infer against the project) stdout
//       === "fixture-scope" (same observable).
//   - t60.sh Test 8  scope-table includes "| fixture-scope" row -> Test 8:
//       scope-table stdout contains "| fixture-scope" (same) + STRONGER:
//       rc === 0.
//   - t60.sh Test 9  detect-scope --from-text emits SCOPE_DETECTED w/
//       Detected scope=fixture-scope AND Source=keyword -> Test 9: the
//       SCOPE_DETECTED audit block carries Detected scope=fixture-scope AND
//       Source=keyword (block-scoped field reads, STRONGER than the .sh's two
//       file-wide greps) + STRONGER: SCOPE_DETECTED event count === 1 and the
//       JSON ack on stdout names the scope+source.
//   - (no .sh row) -> Test 0: STRONGER current-surface pin — scope-grid.json
//       present, scope-mapping.json absent in the shipped tree.
//
// 9 .sh asserts -> 9 expect()-bearing test() cases + 1 added surface-pin
// (Test 0). Test 3 keeps both its observables in one case to mirror the single
// `ok` line, as the .sh did.
//
// FIXTURE DISCIPLINE (mirrors setup_integration_project + setup_fixture_scope +
// cleanup_test_project per case): each case builds a FRESH integration sandbox
// via setupIntegrationProject (which copies dist/claude/.claude/ incl. the
// .claude/scopes/*.md set + tools/data/scope-grid.json + stage-graph.json),
// then DROPS one .claude/scopes/aidlc-fixture-scope.md into the COPIED tree —
// the v0.6.0 authoring path. No env var, no JSON edit, no source edit. Nothing
// under tests/fixtures/** is written; the file lands in each temp project's own
// .claude/scopes/. All temp dirs cleaned in afterAll. State-reading cases use
// setupIntegrationProject (which routes the temp path through toPortablePath)
// so audit.md/state.md round-trip on Windows.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  seededAuditShard,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test

/** Path to a tool inside a temp project's copied .claude/tools. */
const toolIn = (proj: string, name: string): string =>
  join(proj, ".claude", "tools", name);

const utilityIn = (proj: string): string => toolIn(proj, "aidlc-utility.ts");

/** The dropped fixture scope file inside a temp project's copied .claude/scopes. */
const fixtureScopeFile = (proj: string): string =>
  join(proj, ".claude", "scopes", "aidlc-fixture-scope.md");

// P4: init births a per-intent record (aidlc/spaces/<space>/intents/<slug>-<id8>/)
// and writes aidlc-state.md there, not the flat aidlc-docs/. Resolve the record
// dir from the active-space + active-intent cursors, falling back to the flat
// layout for a seeded-flat project (Test 5 seeds flat state and never inits).
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
// P9: the per-intent audit shard a spawned tool resolves once the seeded record
// resolves (state present). Mirrors auditShardName() against the pinned clone-id.
const auditPath = (proj: string): string => seededAuditShard(proj);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/**
 * Spawn `bun <tool.ts> <args...>`, optionally with extra env. Mirrors
 * `bun "$TOOL" ...`. AIDLC_SCOPE_MAPPING is force-DELETED from the child env so
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

/** Spawn `bun -e "<src>"` with env. Mirrors the .sh's inline `bun -e` calls. */
function runEval(src: string, env: Record<string, string> = {}): CliResult {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };
  delete childEnv.AIDLC_SCOPE_MAPPING;
  const res = spawnSync(BUN, ["-e", src], {
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
 * setup_fixture_scope (t60.sh:56-81): DROP one
 * .claude/scopes/aidlc-fixture-scope.md into the project's COPIED scopes dir.
 * Frontmatter carries name/depth/keywords/description exactly as the .sh's
 * heredoc does. No JSON, no grid edit, no code change — the EXECUTE/SKIP grid
 * column stays empty (no stage frontmatter names this scope), which init
 * tolerates (it stamps the scope name + the always-EXECUTE init stages), the
 * sole behaviour tests 3-6 assert. Optionally attaches the `fixturetrigger`
 * keyword (the NL path, t60.sh:133).
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

/** Fresh integration sandbox (setup_integration_project --no-aidlc-docs --strip-env-scope). */
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

/**
 * Read the value of <key> from the FIRST audit block whose `**Event**:`
 * matches <ev>. Block-scoped (resets at `## ` headings and `---`). Mirrors the
 * audit_field helper in the sibling .cli ports. Returns "" when absent.
 */
function auditField(file: string, ev: string, key: string): string {
  if (!existsSync(file)) return "";
  let matched = false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
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
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

/** Count audit blocks with `**Event**: <ev>` (exact-line). */
function auditEventCount(file: string, ev: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === `**Event**: ${ev}`).length;
}

// The 9 alphabetically-sorted default scopes (t60.sh:45). Pins the derivation
// baseline: validScopes() == sorted scope names from the shipped
// .claude/scopes/*.md set.
const EXPECTED_DEFAULT_SCOPES =
  "bugfix,enterprise,feature,infra,mvp,poc,refactor,security-patch,workshop";

describe("t60 valid-scopes derived from .claude/scopes/*.md (migrated from t60-valid-scopes-derived.sh, plan 9)", () => {
  // --- Test 0: STRONGER current-surface pin (no .sh row) ---
  // Locks the v0.6.0 surface this twin asserts against: the compiled
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

  // --- Test 1: static scan — VALID_SCOPES symbol gone from shipped tools/ ---
  test("1: no VALID_SCOPES references in shipped tools/", () => {
    const toolsDir = join(AIDLC_SRC, "tools");
    // grep -rE 'VALID_SCOPES' over the shipped tools dir. Use grep so the scan
    // matches the .sh exactly (recursive, all files). Exit 1 == no match.
    const res = spawnSync("grep", ["-rE", "VALID_SCOPES", toolsDir], {
      encoding: "utf-8",
    });
    // grep exits 1 (no lines) on a clean tree, 0 (with output) if found.
    expect(res.status).not.toBe(0);
    expect(res.stdout ?? "").toBe("");
  });

  // --- Test 2: runtime — validScopes() default returns 9 sorted scopes ---
  test("2: validScopes() returns 9 alphabetically-sorted scopes", () => {
    // Spawn `bun -e import { validScopes } from <shipped lib.ts>` against the
    // shipped tree (no fixture scope dropped) — exactly the .sh mechanism
    // (t60.sh:46). The fresh process reads .claude/scopes/*.md, no cache.
    const lib = join(AIDLC_SRC, "tools", "aidlc-lib.ts");
    const r = runEval(
      `import { validScopes } from ${JSON.stringify(lib)}; console.log([...validScopes()].join(","));`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").pop()).toBe(EXPECTED_DEFAULT_SCOPES);
  });

  // --- Test 3: init --scope fixture-scope succeeds + writes state Scope line ---
  test("3: init --scope fixture-scope succeeds against dropped .claude/scopes/ file", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(utilityIn(proj), [
      "intent-birth",
      "--scope",
      "fixture-scope",
      "--project-dir",
      proj,
    ]);
    expect(r.status).toBe(0);
    const state = readFileSync(statePath(proj), "utf-8");
    expect(state.split("\n")).toContain("- **Scope**: fixture-scope");
  });

  // --- Test 4: init --scope bogus error lists fixture-scope (derivation flowing) ---
  test("4: init --scope bogus error message lists fixture-scope", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(utilityIn(proj), [
      "intent-birth",
      "--scope",
      "bogus-notascope",
      "--project-dir",
      proj,
    ]);
    expect(r.status).toBe(1); // STRONGER: .sh swallowed rc; the error path is process.exit(1)
    expect(r.out).toContain("fixture-scope");
  });

  // --- Test 5: scope-change --scope fixture-scope succeeds (aidlc-state surface) ---
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
    expect(r.status).toBe(0); // STRONGER: .sh discarded rc
    const state = readFileSync(statePath(proj), "utf-8");
    expect(state.split("\n")).toContain("- **Scope**: fixture-scope");
  });

  // --- Test 6: doctor invalid env-scope fix hint derives from .claude/scopes/ ---
  test("6: doctor fix hint for invalid AWS_AIDLC_DEFAULT_SCOPE lists fixture-scope", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(utilityIn(proj), ["doctor", "--project-dir", proj], {
      AWS_AIDLC_DEFAULT_SCOPE: "still-bogus",
    });
    // doctor reports the invalid env-scope row with a fix line enumerating the
    // valid scopes — fixture-scope among them. (Doctor exits non-zero when any
    // check fails; the observable the .sh pinned is the fixture-scope mention.)
    expect(r.out).toContain("fixture-scope");
  });

  // --- Test 7: inferScopeFromText picks fixture-scope from its keyword ---
  test("7: inferScopeFromText picks fixture-scope from its .md keyword", () => {
    const proj = freshProject();
    setupFixtureScope(proj, /* withKeyword */ true);
    // The keyword is read from the dropped .claude/scopes/aidlc-fixture-scope.md
    // frontmatter via loadScopeMapping()'s metadata source — no env var, no
    // reset (a fresh `bun -e` process has no cache). Mirrors t60.sh:138-141.
    const r = runEval(
      [
        `import { inferScopeFromText } from ${JSON.stringify(utilityIn(proj))};`,
        `console.log(inferScopeFromText(process.env.T60_INPUT).scope);`,
      ].join("\n"),
      { T60_INPUT: "fixturetrigger test" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").pop()).toBe("fixture-scope");
  });

  // --- Test 8: scope-table includes a fixture-scope row from the dropped .md ---
  test("8: scope-table includes fixture-scope row from dropped .claude/scopes/ file", () => {
    const proj = freshProject();
    setupFixtureScope(proj, /* withKeyword */ true);
    const r = run(utilityIn(proj), ["scope-table"]);
    expect(r.status).toBe(0); // STRONGER: non-check scope-table prints + exits 0
    expect(r.out).toContain("| fixture-scope");
  });

  // --- Test 9: detect-scope --from-text emits SCOPE_DETECTED (Source=keyword) ---
  test("9: detect-scope --from-text emits SCOPE_DETECTED for fixture-scope (Source=keyword)", () => {
    // P9: seed state so the per-intent record resolves — detect-scope's
    // appendAuditEvent then lands SCOPE_DETECTED in that record's audit shard
    // (seededAuditShard). An audit-less freshProject() strips the record, so the
    // tool falls back to the bare space root and the seeded-shard read finds nothing.
    const proj = freshProject({
      withState: join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md"),
    });
    setupFixtureScope(proj, /* withKeyword */ true);
    const r = run(utilityIn(proj), [
      "detect-scope",
      "--from-text",
      "--input",
      "fixturetrigger",
      "--project-dir",
      proj,
    ]);
    expect(r.status).toBe(0);
    // STRONGER than the .sh's two file-wide greps: block-scoped field reads on
    // the SCOPE_DETECTED entry, plus an exact event count and a JSON-ack check.
    const f = auditPath(proj);
    expect(auditEventCount(f, "SCOPE_DETECTED")).toBe(1);
    expect(auditField(f, "SCOPE_DETECTED", "Detected scope")).toBe(
      "fixture-scope",
    );
    expect(auditField(f, "SCOPE_DETECTED", "Source")).toBe("keyword");
    expect(r.stdout).toContain('"emitted":"SCOPE_DETECTED"');
    expect(r.stdout).toContain('"scope":"fixture-scope"');
    expect(r.stdout).toContain('"source":"keyword"');
  });
});
