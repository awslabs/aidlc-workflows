// covers: function:validScopes, subcommand:aidlc-utility:detect-scope, subcommand:aidlc-utility:scope-table
//
// CLI-contract port of tests/unit/t60-valid-scopes-derived.sh (TAP plan 9),
// mechanism = cli. The .sh proved that adding a scope to scope-mapping.json
// flows through EVERY tool that validates scopes (init, scope-change, doctor)
// AND through the MR 10 NL/summary surfaces (detect-scope --from-text,
// scope-table) with no source edit. Equal-or-stronger migration: every .sh
// assertion is preserved by SPAWNING the real binary (BUN + the tool .ts) and
// asserting on res.status / combined stdout+stderr / the state.md + audit.md
// the tool writes — the PROCESS boundary, incl. exit codes.
//
// MECHANISM SPLIT — why this is a .cli file even though Test 2 imports a
// function symbol:
//   - The covers header credits function:validScopes precisely because the
//     .sh exercised it via a `bun -e "import { validScopes } ..."` SUBPROCESS
//     (t60.sh:45). We preserve that exact mechanism (a spawned `bun -e`
//     importing the shipped lib.ts symbol) so the function-unit credit is
//     earned the same way — same observable (the sorted scope list printed to
//     stdout). Likewise Test 7's inferScopeFromText is a spawned `bun -e`
//     against lib.ts (_resetScopeMappingForTests) + utility.ts, mirroring the
//     .sh's env-seam reload at t60.sh:147-153.
//   - detect-scope and scope-table are exercised through the real
//     aidlc-utility.ts CLI subprocess + the audit.md it appends to and the
//     table it prints — the .sh's `bun "$TOOL" detect-scope ...` /
//     `bun "$TOOL" scope-table` (t60.sh:157-167).
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
//       -> Test 7: spawned `bun -e` (lib reset + utility infer) stdout ===
//       "fixture-scope" (same observable).
//   - t60.sh Test 8  scope-table includes "| fixture-scope" row -> Test 8:
//       scope-table stdout contains "| fixture-scope" (same) + STRONGER:
//       rc === 0.
//   - t60.sh Test 9  detect-scope --from-text emits SCOPE_DETECTED w/
//       Detected scope=fixture-scope AND Source=keyword -> Test 9: the
//       SCOPE_DETECTED audit block carries Detected scope=fixture-scope AND
//       Source=keyword (block-scoped field reads, STRONGER than the .sh's two
//       file-wide greps) + STRONGER: SCOPE_DETECTED event count === 1 and the
//       JSON ack on stdout names the scope+source.
//
// 9 .sh asserts -> 9 expect()-bearing test() cases (Test 3 keeps both its
// observables in one case to mirror the single `ok` line, as the .sh did).
//
// FIXTURE DISCIPLINE (mirrors setup_integration_project + setup_fixture_scope +
// cleanup_test_project per case): each case builds a FRESH integration sandbox
// via setupIntegrationProject (which copies dist/claude/.claude/ incl.
// tools/data/scope-grid.json + stage-graph.json), then splices a
// `fixture-scope` entry into the COPIED scope-grid.json — the v0.6.0 shape
// that replaced the old mapping file. Nothing under tests/fixtures/** is written; the mapping
// edit lands in each temp project's own copy. All temp dirs cleaned in
// afterAll. State-reading cases use setupIntegrationProject (which routes the
// temp path through toPortablePath) so audit.md/state.md round-trip on Windows.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  loadScopeMapping as loadDefaultScopeMapping,
  type ScopeDefinition,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test

/** Path to a tool inside a temp project's copied .claude/tools. */
const toolIn = (proj: string, name: string): string =>
  join(proj, ".claude", "tools", name);

/** Path to the COPIED lib.ts inside a temp project (for `bun -e` imports). */
const libIn = (proj: string): string => toolIn(proj, "aidlc-lib.ts");
const utilityIn = (proj: string): string => toolIn(proj, "aidlc-utility.ts");

/** Legacy-shape scope fixture inside a temp project, passed through AIDLC_SCOPE_MAPPING. */
const mappingIn = (proj: string): string =>
  join(proj, ".claude", "tools", "data", "scope-mapping.fixture.json");

const stagePathIn = (proj: string): string =>
  join(proj, ".claude", "tools", "data", "stage-graph.json");

const statePath = (proj: string): string =>
  join(proj, "aidlc-docs", "aidlc-state.md");
const auditPath = (proj: string): string =>
  join(proj, "aidlc-docs", "audit.md");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun <tool.ts> <args...>`, optionally with extra env. Mirrors `bun "$TOOL" ...`. */
function run(
  tool: string,
  args: string[],
  env: Record<string, string> = {},
): CliResult {
  const res = spawnSync(BUN, [tool, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Spawn `bun -e "<src>"` with env. Mirrors the .sh's inline `bun -e` reloads. */
function runEval(src: string, env: Record<string, string> = {}): CliResult {
  const res = spawnSync(BUN, ["-e", src], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/**
 * setup_fixture_scope (t60.sh:53-81): splice a `fixture-scope` entry into the
 * project's COPIED scope-grid.json. Body is the 3 INITIALIZATION stages +
 * intent-capture as EXECUTE; every other real stage slug (from the canonical
 * stage-graph.json) gets SKIP so stagesInScope() doesn't misbehave. Optionally
 * attaches a keyword (the MR 10 path, t60.sh:135-141).
 */
function setupFixtureScope(proj: string, withKeyword = false): void {
  const m = JSON.parse(JSON.stringify(loadDefaultScopeMapping())) as Record<
    string,
    ScopeDefinition
  >;
  m["fixture-scope"] = {
    depth: "Minimal",
    description: "test fixture scope",
    stages: {
      "workspace-scaffold": "EXECUTE",
      "workspace-detection": "EXECUTE",
      "state-init": "EXECUTE",
      "intent-capture": "EXECUTE",
    },
  };
  const graph = JSON.parse(readFileSync(stagePathIn(proj), "utf-8")) as Array<{
    slug: string;
  }>;
  for (const entry of graph) {
    if (!(entry.slug in m["fixture-scope"].stages)) {
      m["fixture-scope"].stages[entry.slug] = "SKIP";
    }
  }
  if (withKeyword) {
    m["fixture-scope"].keywords = ["fixturetrigger"];
  }
  writeFileSync(mappingIn(proj), JSON.stringify(m, null, 2), "utf-8");
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

// The 9 alphabetically-sorted default scopes (t60.sh:44). Pins the derivation
// baseline: validScopes() == sorted keys of the shipped scope-mapping.json.
const EXPECTED_DEFAULT_SCOPES =
  "bugfix,enterprise,feature,infra,mvp,poc,refactor,security-patch,workshop";

describe("t60 valid-scopes derived from scope-mapping.json (migrated from t60-valid-scopes-derived.sh, plan 9)", () => {
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
    // shipped tree (no fixture mapping) — exactly the .sh mechanism (t60.sh:45).
    const lib = join(AIDLC_SRC, "tools", "aidlc-lib.ts");
    const r = runEval(
      `import { validScopes } from ${JSON.stringify(lib)}; console.log([...validScopes()].join(","));`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").pop()).toBe(EXPECTED_DEFAULT_SCOPES);
  });

  // --- Test 3: init --scope fixture-scope succeeds + writes state Scope line ---
  test("3: init --scope fixture-scope succeeds against modified scope-mapping.json", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(
      utilityIn(proj),
      [
        "init",
        "--scope",
        "fixture-scope",
        "--project-dir",
        proj,
      ],
      { AIDLC_SCOPE_MAPPING: mappingIn(proj) },
    );
    expect(r.status).toBe(0);
    const state = readFileSync(statePath(proj), "utf-8");
    expect(state.split("\n")).toContain("- **Scope**: fixture-scope");
  });

  // --- Test 4: init --scope bogus error lists fixture-scope (derivation flowing) ---
  test("4: init --scope bogus error message lists fixture-scope", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(
      utilityIn(proj),
      [
        "init",
        "--scope",
        "bogus-notascope",
        "--project-dir",
        proj,
      ],
      { AIDLC_SCOPE_MAPPING: mappingIn(proj) },
    );
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
    const r = run(
      utilityIn(proj),
      [
        "scope-change",
        "--scope",
        "fixture-scope",
        "--project-dir",
        proj,
      ],
      { AIDLC_SCOPE_MAPPING: mappingIn(proj) },
    );
    expect(r.status).toBe(0); // STRONGER: .sh discarded rc
    const state = readFileSync(statePath(proj), "utf-8");
    expect(state.split("\n")).toContain("- **Scope**: fixture-scope");
  });

  // --- Test 6: doctor invalid env-scope fix hint derives from mapping ---
  test("6: doctor fix hint for invalid AWS_AIDLC_DEFAULT_SCOPE lists fixture-scope", () => {
    const proj = freshProject();
    setupFixtureScope(proj);
    const r = run(
      utilityIn(proj),
      ["doctor", "--project-dir", proj],
      {
        AIDLC_SCOPE_MAPPING: mappingIn(proj),
        AWS_AIDLC_DEFAULT_SCOPE: "still-bogus",
      },
    );
    // doctor reports the invalid env-scope row with a fix line enumerating the
    // valid scopes — fixture-scope among them. (Doctor exits non-zero when any
    // check fails; the observable the .sh pinned is the fixture-scope mention.)
    expect(r.out).toContain("fixture-scope");
  });

  // --- Test 7: inferScopeFromText picks fixture-scope from its keyword ---
  test("7: inferScopeFromText picks fixture-scope from its keyword", () => {
    const proj = freshProject();
    setupFixtureScope(proj, /* withKeyword */ true);
    // Reset lib's scope-mapping cache, then resolve via the env-seam pointing
    // at the fixture mapping — mirrors t60.sh:147-153 exactly.
    const r = runEval(
      [
        `import { _resetScopeMappingForTests } from ${JSON.stringify(libIn(proj))};`,
        `import { inferScopeFromText } from ${JSON.stringify(utilityIn(proj))};`,
        `_resetScopeMappingForTests();`,
        `console.log(inferScopeFromText(process.env.MR10_INPUT).scope);`,
      ].join("\n"),
      {
        AIDLC_SCOPE_MAPPING: mappingIn(proj),
        MR10_INPUT: "fixturetrigger test",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").pop()).toBe("fixture-scope");
  });

  // --- Test 8: scope-table includes a fixture-scope row via env-seam ---
  test("8: scope-table includes fixture-scope row when pointed at fixture mapping", () => {
    const proj = freshProject();
    setupFixtureScope(proj, /* withKeyword */ true);
    const r = run(utilityIn(proj), ["scope-table"], {
      AIDLC_SCOPE_MAPPING: mappingIn(proj),
    });
    expect(r.status).toBe(0); // STRONGER: non-check scope-table prints + exits 0
    expect(r.out).toContain("| fixture-scope");
  });

  // --- Test 9: detect-scope --from-text emits SCOPE_DETECTED (Source=keyword) ---
  test("9: detect-scope --from-text emits SCOPE_DETECTED for fixture-scope (Source=keyword)", () => {
    const proj = freshProject();
    setupFixtureScope(proj, /* withKeyword */ true);
    const r = run(
      utilityIn(proj),
      [
        "detect-scope",
        "--from-text",
        "--input",
        "fixturetrigger",
        "--project-dir",
        proj,
      ],
      { AIDLC_SCOPE_MAPPING: mappingIn(proj) },
    );
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
