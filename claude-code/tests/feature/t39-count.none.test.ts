// covers: function:loadScopeMapping
//
// t39 — scope EXECUTE-count validation. Migrated from the bash TAP test
// tests/feature/t39-scope-stage-count-validation.sh (plan 9). Post-PR-10 the
// authoritative source for per-scope stage inclusion is scope-mapping.json:
// each scope carries a `stages` map of <slug> -> "EXECUTE" | "SKIP"
// (ScopeDefinition, aidlc-lib.ts:36-46). The .sh spawned `bun -e` per case to
// JSON.parse that file and count EXECUTE values; here we import the SAME pure
// loader the rest of the toolchain uses — loadScopeMapping (aidlc-lib.ts:739)
// — and assert against the real Record<string, ScopeDefinition> it returns.
//
// Mechanism: none (a pure in-process function call, zero subprocess, zero LLM,
// zero tokens). loadScopeMapping reads the shipped data file at DATA_DIR's
// default scope-mapping.json (no AIDLC_SCOPE_MAPPING env override set), reads
// no project dir, emits no audit rows, writes nothing — so there is no CLI
// arg-parse / process.exit shell to keep as a spawn seam. The .sh's `bun -e`
// inline scripts were just a shell-friendly way to call JSON.parse + filter;
// in-process we call the canonical loader once and reuse the parsed object,
// which is STRONGER than the .sh (the .sh re-parsed the file from a literal
// path per case and never exercised loadScopeMapping's default-path resolution
// or its ScopeDefinition return shape).
//
// PARITY NOTES — every .sh `ok`/`assert_eq` line maps to an expect() below.
// The .sh helper exec_count(scope) = Object.values(m[scope].stages).filter(
//   v => v === 'EXECUTE').length; replicated verbatim as execCount() here.
// is_execute(scope, slug) = m[scope].stages[slug] === 'EXECUTE' ? 'yes':'no';
// replicated as isExecute(). Range checks ([X..Y] inclusive) stay inclusive.
//   - .sh Test 1  assert_eq "$ENT" "32"      -> Test 1: execCount("enterprise") === 32 (exact, same observable).
//   - .sh Test 2  assert_eq "$FEAT" "32"     -> Test 2: execCount("feature") === 32 (exact).
//   - .sh Test 3  mvp in 15..25              -> Test 3: 15 <= execCount("mvp") <= 25.
//   - .sh Test 4  poc in 5..12               -> Test 4: 5 <= execCount("poc") <= 12.
//   - .sh Test 5  assert_eq "$BUGFIX" "7"    -> Test 5: execCount("bugfix") === 7 (exact).
//   - .sh Test 6  refactor in 7..12          -> Test 6: 7 <= execCount("refactor") <= 12.
//   - .sh Test 7  infra in 9..16             -> Test 7: 9 <= execCount("infra") <= 16.
//   - .sh Test 8  security-patch deployment-pipeline=yes AND deployment-execution=yes
//       -> Test 8: both isExecute("security-patch", <slug>) === true (the .sh
//       collapsed both into one `ok`; kept as one test() with two expects to
//       match the single .sh assertion, observing both fields).
//   - .sh Test 9  workshop in 20..28         -> Test 9: 20 <= execCount("workshop") <= 28.
//
// 9 .sh asserts -> 9 expect()-bearing test() cases. STRONGER additions noted
// inline (S1: ScopeDefinition shape guard; S2: every stage value is EXECUTE or
// SKIP, the .sh's distinct-value invariant left implicit; S3: scope-key set).
//
// FIXTURE DISCIPLINE: none. loadScopeMapping reads the shipped data file in
// place; nothing is created, copied, or written under tests/fixtures/** or a
// temp dir. The .sh likewise read $AIDLC_SRC/tools/data/scope-mapping.json
// directly with no temp project.

import { describe, expect, test } from "bun:test";
import {
  loadScopeMapping,
  type ScopeDefinition,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// Load once — loadScopeMapping memoises internally (aidlc-lib.ts:740), so a
// single call is the canonical entrypoint; reuse the parsed object across cases
// exactly as the .sh re-derived counts from the same on-disk JSON per case.
const MAPPING: Record<string, ScopeDefinition> = loadScopeMapping();

/**
 * exec_count (t39.sh:25-31): number of stages set to "EXECUTE" for <scope>.
 * Object.values(m[scope].stages).filter(v => v === "EXECUTE").length.
 */
function execCount(scope: string): number {
  return Object.values(MAPPING[scope].stages).filter((v) => v === "EXECUTE")
    .length;
}

/**
 * is_execute (t39.sh:34-41): true iff <slug> is "EXECUTE" in <scope>.
 * The .sh returned "yes"/"no"; here a boolean (same observable predicate).
 */
function isExecute(scope: string, slug: string): boolean {
  return MAPPING[scope].stages[slug] === "EXECUTE";
}

describe("t39 scope EXECUTE-count validation — loadScopeMapping (migrated from t39-scope-stage-count-validation.sh, plan 9)", () => {
  // S1 (STRONGER, not in the .sh): the loader returns a usable map keyed by the
  // nine canonical scopes, each carrying a `stages` record. The .sh assumed
  // this shape implicitly by indexing m[scope].stages; pin it once up front so
  // a missing/renamed scope fails loudly here rather than as a TypeError mid-case.
  test("0a: loadScopeMapping returns the nine canonical scopes (S3)", () => {
    expect(Object.keys(MAPPING).sort()).toEqual(
      [
        "bugfix",
        "enterprise",
        "feature",
        "infra",
        "mvp",
        "poc",
        "refactor",
        "security-patch",
        "workshop",
      ].sort(),
    );
  });

  test("0b: every stage value is EXECUTE or SKIP across all scopes (S2)", () => {
    // The .sh's exec_count only counted "EXECUTE"; this guards the implicit
    // invariant that the other value is exactly "SKIP" (ScopeDefinition's
    // Record<string,"EXECUTE"|"SKIP">), so a stray third value can't silently
    // shrink an EXECUTE count and pass a range check.
    for (const [scope, def] of Object.entries(MAPPING)) {
      for (const [slug, value] of Object.entries(def.stages)) {
        expect(value === "EXECUTE" || value === "SKIP").toBe(true);
        // touch slug/scope so a failure message localises the offender
        if (value !== "EXECUTE" && value !== "SKIP") {
          throw new Error(`${scope}.${slug} = ${value as string}`);
        }
      }
    }
  });

  // 1. Enterprise: all 32 stages EXECUTE.
  test("1: enterprise executes all 32 stages", () => {
    expect(execCount("enterprise")).toBe(32);
  });

  // 2. Feature: all 32 stages EXECUTE.
  test("2: feature executes all 32 stages", () => {
    expect(execCount("feature")).toBe(32);
  });

  // 3. MVP: range 15-25 (operations skipped; inception+construction+init).
  test("3: mvp executes 15-25 stages", () => {
    const n = execCount("mvp");
    expect(n).toBeGreaterThanOrEqual(15);
    expect(n).toBeLessThanOrEqual(25);
  });

  // 4. POC: range 5-12 (minimal footprint).
  test("4: poc executes 5-12 stages", () => {
    const n = execCount("poc");
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(12);
  });

  // 5. Bugfix: exactly 7 (init+RE+req+codegen+build).
  test("5: bugfix executes exactly 7 stages", () => {
    expect(execCount("bugfix")).toBe(7);
  });

  // 6. Refactor: range 7-12.
  test("6: refactor executes 7-12 stages", () => {
    const n = execCount("refactor");
    expect(n).toBeGreaterThanOrEqual(7);
    expect(n).toBeLessThanOrEqual(12);
  });

  // 7. Infra: range 9-16.
  test("7: infra executes 9-16 stages", () => {
    const n = execCount("infra");
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(16);
  });

  // 8. Security-patch: includes deployment-pipeline AND deployment-execution.
  // The .sh folded both checks into one `ok` (pipeline=yes execution=yes);
  // kept as one test() asserting both observables, matching the single .sh line.
  test("8: security-patch executes deployment-pipeline and deployment-execution", () => {
    expect(isExecute("security-patch", "deployment-pipeline")).toBe(true);
    expect(isExecute("security-patch", "deployment-execution")).toBe(true);
  });

  // 9. Workshop: range 20-28 (skips ideation only).
  test("9: workshop executes 20-28 stages", () => {
    const n = execCount("workshop");
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(28);
  });
});
