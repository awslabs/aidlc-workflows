// covers: function:loadScopeMapping
//
// t39 - scope EXECUTE-count validation. The authoritative source for per-scope
// stage inclusion is the compiled scope-grid.json merged with each scope's .md
// frontmatter (scope-mapping.json is only the AIDLC_SCOPE_MAPPING test seam);
// each scope carries a `stages` map of <slug> -> "EXECUTE" | "SKIP"
// (ScopeDefinition, aidlc-lib.ts:36-46). The .sh spawned `bun -e` per case to
// JSON.parse that file and count EXECUTE values; here we import the SAME pure
// loader the rest of the toolchain uses — loadScopeMapping (aidlc-lib.ts:739)
// — and assert against the real Record<string, ScopeDefinition> it returns.
//
// Mechanism: none (an in-process function call, zero subprocess, zero LLM,
// zero tokens). With no AIDLC_SCOPE_MAPPING override, loadScopeMapping reads
// the compiled scope-grid.json and the scope .md frontmatter, emits no audit
// rows and writes nothing - so there is no CLI arg-parse / process.exit shell
// to keep as a spawn seam. We call the canonical loader once and reuse the
// parsed object, exercising loadScopeMapping's default-path resolution and its
// ScopeDefinition return shape.
//
// Additions beyond the per-scope counts, labelled inline: S1 = ScopeDefinition
// shape guard; S2 = every stage value is EXECUTE or SKIP; S3 = the scope-key
// set.
//
// FIXTURE DISCIPLINE: none. loadScopeMapping reads the shipped inputs in
// place; nothing is created, copied, or written under tests/fixtures/** or a
// temp dir.

import { describe, expect, test } from "bun:test";
import {
  loadScopeMapping,
  type ScopeDefinition,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// Load once - loadScopeMapping memoises internally, so a single call is the
// canonical entrypoint; reuse the parsed object across cases.
const MAPPING: Record<string, ScopeDefinition> = loadScopeMapping();

function execCount(scope: string): number {
  return Object.values(MAPPING[scope].stages).filter((v) => v === "EXECUTE")
    .length;
}

function isExecute(scope: string, slug: string): boolean {
  return MAPPING[scope].stages[slug] === "EXECUTE";
}

describe("t39 scope EXECUTE-count validation — loadScopeMapping (migrated from t39-scope-stage-count-validation.sh, plan 9)", () => {
  // S1: the loader returns a usable map keyed by the eleven canonical scopes,
  // each carrying a `stages` record. Pin it once up front so a missing/renamed
  // scope fails loudly here rather than as a TypeError mid-case.
  test("0a: loadScopeMapping returns the eleven canonical scopes (S3)", () => {
    expect(Object.keys(MAPPING).sort()).toEqual(
      [
        "bugfix",
        "classic",
        "enterprise",
        "express",
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
    // This guards the invariant that the other value is exactly "SKIP"
    // (ScopeDefinition's Record<string,"EXECUTE"|"SKIP">), so a stray third value
    // can't silently shrink an EXECUTE count and pass a range check.
    for (const [scope, def] of Object.entries(MAPPING)) {
      for (const [slug, value] of Object.entries(def.stages)) {
        expect(value === "EXECUTE" || value === "SKIP").toBe(true);
        if (value !== "EXECUTE" && value !== "SKIP") {
          throw new Error(`${scope}.${slug} = ${value as string}`);
        }
      }
    }
  });

  // 1. Enterprise: all 33 stages EXECUTE.
  test("1: enterprise executes all 33 stages", () => {
    expect(execCount("enterprise")).toBe(33);
  });

  // 2. Feature: all 33 stages EXECUTE.
  test("2: feature executes all 33 stages", () => {
    expect(execCount("feature")).toBe(33);
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

  // 5. Bugfix: exactly 9 (init+RE+req+codegen+build+deploy pipeline/execution).
  test("5: bugfix executes exactly 9 stages", () => {
    expect(execCount("bugfix")).toBe(9);
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
  test("8: security-patch executes deployment-pipeline and deployment-execution", () => {
    expect(isExecute("security-patch", "deployment-pipeline")).toBe(true);
    expect(isExecute("security-patch", "deployment-execution")).toBe(true);
  });

  // 9. Classic: skips ideation and operation.
  test("9: classic executes exactly 18 stages", () => {
    const n = execCount("classic");
    expect(n).toBe(18);
  });

  test("9b: workshop remains a compatible 26-stage scope", () => {
    expect(execCount("workshop")).toBe(26);
  });

  // 10. Express: the fixed lightweight grid.
  test("10: express executes exactly 10 stages", () => {
    expect(execCount("express")).toBe(10);
  });
});
