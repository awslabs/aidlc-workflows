// covers: scope:express-plus, function:validateGrid, function:validateScope
//
// t352 - every required input of every stage in the express-plus scope has a
// producer inside the scope.
//
// express-plus runs Units Generation, Delivery Planning, and Functional Design.
// All three consume `components` with `required: true`, and Domain Design is
// the only stage that produces it. When the scope ran without Domain Design,
// those stages started with no in-scope producer for a required input (the
// same class of gap as #1227). This test pins the fix from two directions:
//
//   1. The upstream validator in strict (recompose) mode, which turns an
//      off-path required producer into a hard error, accepts the compiled
//      express-plus grid for greenfield, brownfield, and an unset project
//      type. The lenient validateScope reports no advisories either.
//   2. An independent walk of the compiled stage-graph.json and
//      scope-grid.json (no validator code) finds no required consume whose
//      producers are all SKIP in express-plus.
//   3. The stricter #1227 property also holds: each required input's producer
//      is reachable through the stage's in-scope requires_stage closure, not
//      just present somewhere in the scope.
//
// It also pins the shape the fix relies on: Domain Design is EXECUTE and sits
// between Requirements Analysis and Units Generation, the scope runs 10 of the
// 33 stages, and it stays a strict subset of mvp, feature, and enterprise so
// scope-change graduation remains additive.
//
// Mechanism: in-process imports of the packaged tools plus direct reads of the
// packaged data files (none).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateGrid,
  validateScope,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

type Consume = { artifact: string; required?: boolean; conditional_on?: string };
type Stage = {
  slug: string;
  number: string;
  phase: string;
  produces?: string[];
  consumes?: Consume[];
  requires_stage?: string[];
};

const DATA = join(AIDLC_SRC, "tools", "data");
const graph = JSON.parse(readFileSync(join(DATA, "stage-graph.json"), "utf-8"));
const stages: Stage[] = Array.isArray(graph) ? graph : graph.stages;
const scopeGrid: Record<string, { stages: Record<string, string> }> = JSON.parse(
  readFileSync(join(DATA, "scope-grid.json"), "utf-8"),
);

const SCOPE = "express-plus";
const grid = scopeGrid[SCOPE].stages;
const executing = new Set(
  Object.entries(grid)
    .filter(([, action]) => action === "EXECUTE")
    .map(([slug]) => slug),
);

const EXPECTED = [
  "workspace-scaffold",
  "workspace-detection",
  "state-init",
  "requirements-analysis",
  "domain-design",
  "units-generation",
  "delivery-planning",
  "functional-design",
  "code-generation",
  "build-and-test",
];

function stageNumber(slug: string): number[] {
  const s = stages.find((x) => x.slug === slug);
  if (!s) throw new Error(`stage ${slug} not in compiled graph`);
  return s.number.split(".").map(Number);
}

function before(a: string, b: string): boolean {
  const [x, y] = [stageNumber(a), stageNumber(b)];
  return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
}

describe("t352 express-plus: no unproduced required input", () => {
  test("the compiled grid runs exactly the 10 expected stages", () => {
    expect([...executing].sort()).toEqual([...EXPECTED].sort());
    expect(Object.keys(grid).length).toBe(stages.length);
  });

  test("Domain Design sits between Requirements Analysis and Units Generation", () => {
    expect(grid["domain-design"]).toBe("EXECUTE");
    expect(before("requirements-analysis", "domain-design")).toBe(true);
    expect(before("domain-design", "units-generation")).toBe(true);
  });

  for (const projectType of ["greenfield", "brownfield", undefined] as const) {
    test(`strict validateGrid accepts the grid (projectType=${projectType ?? "unset"})`, () => {
      const r = validateGrid(grid, { strict: true, projectType, label: SCOPE });
      expect(r.errors).toEqual([]);
      expect(r.valid).toBe(true);
    });
  }

  test("lenient validateScope reports no off-path producer advisories", () => {
    const r = validateScope(SCOPE);
    expect(r.errors).toEqual([]);
    expect(r.advisories).toEqual([]);
  });

  test("independent walk: every required consume has an EXECUTE producer in scope", () => {
    const producers = new Map<string, string[]>();
    for (const s of stages) {
      for (const a of s.produces ?? []) {
        producers.set(a, [...(producers.get(a) ?? []), s.slug]);
      }
    }
    const starved: string[] = [];
    for (const s of stages) {
      if (!executing.has(s.slug)) continue;
      for (const c of s.consumes ?? []) {
        if (!c.required) continue;
        const inScope = (producers.get(c.artifact) ?? []).filter((p) => executing.has(p));
        if (inScope.length === 0) starved.push(`${s.slug} <- ${c.artifact}`);
      }
    }
    expect(starved).toEqual([]);
  });

  test("each required input's producer is reachable through the in-scope requires_stage closure (#1227)", () => {
    const bySlug = new Map(stages.map((s) => [s.slug, s]));
    const starved: string[] = [];
    for (const s of stages) {
      if (!executing.has(s.slug)) continue;
      const closure = new Set<string>();
      const stack = [s.slug];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        for (const req of bySlug.get(cur)?.requires_stage ?? []) {
          if (executing.has(req) && !closure.has(req)) {
            closure.add(req);
            stack.push(req);
          }
        }
      }
      for (const c of s.consumes ?? []) {
        if (!c.required) continue;
        const reachable = stages.some(
          (p) => closure.has(p.slug) && (p.produces ?? []).includes(c.artifact),
        );
        if (!reachable) starved.push(`${s.slug} <- ${c.artifact}`);
      }
    }
    expect(starved).toEqual([]);
  });

  test("components is required by the design and planning stages and produced in scope", () => {
    const needsComponents = stages
      .filter((s) => executing.has(s.slug))
      .filter((s) => (s.consumes ?? []).some((c) => c.artifact === "components" && c.required))
      .map((s) => s.slug)
      .sort();
    expect(needsComponents).toEqual(["delivery-planning", "functional-design", "units-generation"]);
    const producersInScope = stages
      .filter((s) => executing.has(s.slug) && (s.produces ?? []).includes("components"))
      .map((s) => s.slug);
    expect(producersInScope).toEqual(["domain-design"]);
  });

  test("stays a strict subset of mvp, feature, and enterprise", () => {
    for (const wider of ["mvp", "feature", "enterprise"]) {
      const missing = [...executing].filter((slug) => scopeGrid[wider].stages[slug] !== "EXECUTE");
      expect({ wider, missing }).toEqual({ wider, missing: [] });
    }
  });
});
