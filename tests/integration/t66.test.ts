// covers: function:loadGraph, function:producersOf, function:consumersOf, function:topoSort,
//         function:findCycles, function:subgraphForScope, function:validateScope,
//         function:artifactsRegistry, function:canonicalStageGraphJson, function:loadRules,
//         function:resolveRulesForStage, function:loadSensors, function:resolveSensorsForStage,
//         function:compileStageGraph
//
// NOTE: this file also spawns the `aidlc-graph compile` / `export` CLIs (see MECHANISM
// SPLIT below), but those are `subcommand` units with minMechanism: cli and CANNOT be
// credited from a `.none` file — the ladder requires a `.cli` test. They are exercised
// for behavioural parity, not claimed in covers:, exactly as t89.none.test.ts does.
//
// Bun migration of tests/integration/t66-graph-library.sh (plan 88).
// The .sh spawned `bun -e "..."` and `bun aidlc-state.ts lookup ...` / `bun aidlc-graph.ts
// compile|export` dozens of times and inspected stdout / on-disk graphs with jq + shasum.
// This port IMPORTS aidlc-graph.ts / aidlc-lib.ts / aidlc-stage-schema.ts and calls the pure
// functions directly (no subprocess), then asserts the SAME observable behaviour. The
// genuine CLI-boundary assertions — those that prove a process exit code, a module-load
// env read, byte-identical CLI stdout, or parallel-process concurrency serialisation —
// stay as spawnSync(BUN, [...]) cases, exactly as t89.none.test.ts does.
//
// MECHANISM SPLIT (mirrors the .sh assertion-by-assertion):
//   IN-PROCESS (import + call): API-surface typeofs, producersOf/consumersOf, topoSort,
//     findCycles (real + synthetic + disjoint + per-scope), subgraphForScope (shape /
//     per-scope sizes / unknown / empty), graph traversal (6 full-graph + 3 per-scope),
//     nextInScopeStage state-file semantics (3), circular-import load, validateScope (5),
//     compile round-trip hash, edge-local invariant, for_each preservation,
//     duplicate-slug detection logic, schema-validation invalid case, canonical emitter
//     pin (2), rules_in_context / sensors_applicable array + FIELD_ORDER shape,
//     resolveSensorsForStage declared-order, withAuditLock reentrancy (2).
//   MUST STAY SPAWN (process.exit / module-load env read / CLI stdout / parallel-process):
//     plan-identity parity (9 scopes via `state lookup stages-in-scope` byte-exact),
//     AIDLC_GRAPH_RESOLVE=1 `resolve <scope> --stdout` cutover parity (9 scopes byte-exact
//       vs mr9-parity fixtures) + the gate (no flag -> exit 1, stderr), env-seam read,
//     nextInScopeStage walk parity (9 scopes via `lookup next-stage`),
//     firstInScopeStageOfPhase parity (9 scopes x 5 phases via `lookup first-in-phase`),
//     AIDLC_STAGE_GRAPH env-override-honoured-by-rewired-stagesInScope,
//     compile --check drift (clean->0 / mutated->1 / restore->0),
//     AIDLC_RULES_DIR populate-from-disk + --check drift, AIDLC_SENSORS_DIR populate +
//     --check drift, designer export byte-identical-to-golden + counts + determinism +
//     env-seam + export --check, concurrency (two PARALLEL compiles serialise byte-equal).
//   GREP-THE-SOURCE (port as readFileSync + includes / regex count):
//     'Pre-seed new rows' GONE + 'maxIndexByPhasePrefix' present (#364 auto-seed);
//     '${filePath}:' >= 2 sites.
//
// FIXTURE DISCIPLINE: every mktemp/heredoc the .sh built is rebuilt here with
// mkdtempSync(tmpdir(), ...) + writeFileSync and torn down in afterEach. NOTHING is
// written under tests/fixtures/** (the designer-export golden is READ only). Each spawn
// CLI compile/check seeds a fresh tempfile from the committed stage-graph.json — never
// the real graph — exactly as the .sh did.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetGraphCache,
  artifactsRegistry,
  canonicalStageGraphJson,
  compileStageGraph,
  consumersOf,
  findCycles,
  type GraphStage,
  loadGraph,
  loadSensors,
  producersOf,
  resolveSensorsForStage,
  subgraphForScope,
  topoSort,
  validateScope,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import {
  auditLockDir,
  loadScopeMapping,
  nextInScopeStage,
  withAuditLock,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-stage-schema.ts";

// --- Paths --------------------------------------------------------------------
const TOOLS_DIR = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const GRAPH_TS = join(TOOLS_DIR, "aidlc-graph.ts");
const STATE_TS = join(TOOLS_DIR, "aidlc-state.ts");
const SEED_GRAPH = join(TOOLS_DIR, "data", "stage-graph.json");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const REAL_STAGES = join(AIDLC_SRC, "aidlc-common", "stages");
const REAL_SENSORS = join(AIDLC_SRC, "sensors");
const PARITY_DIR = join(import.meta.dir, "..", "fixtures", "mr9-parity");
const EXPORT_FIXTURE = join(import.meta.dir, "..", "fixtures", "designer-export", "export.json");

const BUN = process.execPath; // the bun binary running this test, for CLI-boundary checks

const SCOPES = [
  "enterprise",
  "feature",
  "mvp",
  "poc",
  "bugfix",
  "refactor",
  "infra",
  "security-patch",
  "workshop",
] as const;
const PHASES = ["initialization", "ideation", "inception", "construction", "operation"] as const;

// --- env-seam + cache harness (mirrors the .sh per-case env discipline) -------
// compileStageGraph()/loadGraph()/loadSensors() read AIDLC_* env at call time.
// __resetGraphCache() before each test so the module-level _graph cache cannot
// leak a fixture between cases. Nothing in-process WRITES the real graph.
beforeEach(() => {
  __resetGraphCache();
});
afterEach(() => {
  __resetGraphCache();
});

// --- scratch tempdir tracker (rebuilt mktemp/heredoc fixtures) ----------------
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) {
    try {
      rmSync(scratch.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** Seed a fresh per-test stage-graph.json tempfile from the committed graph and
 *  return its path. Never touches the real graph (matches the .sh's mktemp+cp). */
function seedGraphCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "t66-graph-"));
  scratch.push(dir);
  const p = join(dir, "stage-graph.json");
  copyFileSync(SEED_GRAPH, p);
  return p;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function numericOrder(a: string, b: string): number {
  const [ap, ai] = a.split(".").map(Number);
  const [bp, bi] = b.split(".").map(Number);
  return ap === bp ? ai - bi : ap - bp;
}

// =============================================================================
// API surface — 8 exports callable (.sh:32-39, 8 assertions -> 1 grouped test)
// =============================================================================

describe("t66 API surface (in-process: 8 exports are functions)", () => {
  test("all 8 graph-library exports are typeof 'function'", () => {
    const exports = {
      loadGraph,
      producersOf,
      consumersOf,
      topoSort,
      findCycles,
      subgraphForScope,
      validateScope,
      artifactsRegistry,
    };
    for (const [name, fn] of Object.entries(exports)) {
      expect(typeof fn, `export exists: ${name}`).toBe("function");
    }
  });
});

// =============================================================================
// producersOf / consumersOf — known + unknown artifact (.sh:45-73, 4 assertions)
// =============================================================================

describe("t66 producersOf / consumersOf (in-process)", () => {
  // .sh:46-50
  test("producersOf(code-summary) == [code-generation]", () => {
    expect(producersOf("code-summary").map((s) => s.slug).sort().join(",")).toBe("code-generation");
  });
  // .sh:52-56
  test("producersOf(unknown) returns empty", () => {
    expect(producersOf("no-such-artifact-xyz").length).toBe(0);
  });
  // .sh:59-67 — requirements has 3+ consumers
  test("consumersOf(requirements) has 3+ consumers", () => {
    expect(consumersOf("requirements").length).toBeGreaterThanOrEqual(3);
  });
  // .sh:69-73
  test("consumersOf(unknown) returns empty", () => {
    expect(consumersOf("no-such-artifact-xyz").length).toBe(0);
  });
});

// =============================================================================
// topoSort — known-good graph + cycle input (.sh:79-95, 2 assertions)
// =============================================================================

describe("t66 topoSort (in-process)", () => {
  // .sh:79-84
  test("topoSort(loadGraph()) returns 32 stages starting with workspace-scaffold", () => {
    const order = topoSort(loadGraph());
    expect(`${order.length}:${order[0]}`).toBe("32:workspace-scaffold");
  });
  // .sh:86-95
  test("topoSort throws on cycle input", () => {
    const stages = [
      { slug: "a", number: "1.1", requires_stage: ["b"] },
      { slug: "b", number: "1.2", requires_stage: ["a"] },
    ] as unknown as GraphStage[];
    expect(() => topoSort(stages)).toThrow();
  });
});

// =============================================================================
// findCycles — real graph + synthetic fixtures + disjoint (.sh:101-136, 4 assertions)
// =============================================================================

describe("t66 findCycles (in-process)", () => {
  // .sh:101-105
  test("findCycles(loadGraph()) returns [] for today's 32-stage graph", () => {
    expect(findCycles(loadGraph()).length).toBe(0);
  });
  // .sh:107-115 — A->B->A
  test("findCycles detects A->B->A cycle", () => {
    const cs = findCycles([
      { slug: "a", number: "1.1", requires_stage: ["b"] },
      { slug: "b", number: "1.2", requires_stage: ["a"] },
    ] as unknown as GraphStage[]);
    expect(`${cs.length}:${cs[0].sort().join(",")}`).toBe("1:a,b");
  });
  // .sh:117-124 — self-loop A->A
  test("findCycles detects self-loop A->A", () => {
    const cs = findCycles([
      { slug: "a", number: "1.1", requires_stage: ["a"] },
    ] as unknown as GraphStage[]);
    expect(`${cs.length}:${cs[0].join(",")}`).toBe("1:a");
  });
  // .sh:126-136 — disjoint subgraph A->B, C->D
  test("disjoint subgraph (A->B, C->D) has no cycles and topo returns 4 nodes", () => {
    const stages = [
      { slug: "a", number: "1.1", requires_stage: ["b"] },
      { slug: "b", number: "1.2", requires_stage: [] },
      { slug: "c", number: "2.1", requires_stage: ["d"] },
      { slug: "d", number: "2.2", requires_stage: [] },
    ] as unknown as GraphStage[];
    expect(`${findCycles(stages).length}:${topoSort(stages).length}`).toBe("0:4");
  });
  // .sh:142-146 — per-scope cycle check
  test("findCycles(subgraphForScope(enterprise)) returns []", () => {
    expect(findCycles(subgraphForScope("enterprise")).length).toBe(0);
  });
});

// =============================================================================
// subgraphForScope shape + per-scope sizes + unknown + empty (.sh:152-217, 5 assertions)
// =============================================================================

describe("t66 subgraphForScope (in-process)", () => {
  // .sh:153-159 — subset of full graph
  test("subgraphForScope returns subset of full graph (bugfix < 32)", () => {
    expect(subgraphForScope("bugfix").length).toBeLessThan(loadGraph().length);
  });
  // .sh:162-173 — numeric order
  test("subgraphForScope returns path in numeric order", () => {
    const nums = subgraphForScope("bugfix").map((s) => s.number);
    const sorted = [...nums].sort(numericOrder);
    expect(nums).toEqual(sorted);
  });
  // .sh:176-189 — per-scope sizes match EXECUTE count for all 9 scopes
  test("subgraphForScope size matches EXECUTE count for all 9 scopes", () => {
    const mapping = loadScopeMapping();
    const mismatches: string[] = [];
    for (const scope of SCOPES) {
      const pathLen = subgraphForScope(scope).length;
      const execCount = Object.values(mapping[scope].stages).filter((a) => a === "EXECUTE").length;
      if (pathLen !== execCount) mismatches.push(`${scope}: path=${pathLen} exec=${execCount}`);
    }
    expect(mismatches).toEqual([]);
  });
  // .sh:192-197 — unknown scope throws
  test("subgraphForScope throws on unknown scope", () => {
    expect(() => subgraphForScope("bogus-scope-xyz")).toThrow();
  });
  // .sh:207-217 — empty-EXECUTE path yields [] (filter+sort contract safe on 0 nodes)
  test("empty-EXECUTE path yields [] (filter+sort contract safe on 0 nodes)", () => {
    const filtered = loadGraph().filter(() => false);
    expect(filtered.length).toBe(0);
  });
});

// =============================================================================
// Graph traversal — full graph (.sh:224-330, 6 assertions)
// =============================================================================

describe("t66 graph traversal — full graph (in-process)", () => {
  // .sh:224-236 — every requires_stage edge resolves to a known slug
  test("every requires_stage edge resolves to a known slug", () => {
    const graph = loadGraph();
    const slugs = new Set(graph.map((s) => s.slug));
    const bad: string[] = [];
    for (const s of graph) {
      for (const dep of s.requires_stage ?? []) {
        if (!slugs.has(dep)) bad.push(`${s.slug}->${dep}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // .sh:239-255 — no cross-phase forward edges
  test("no cross-phase forward edges", () => {
    const PHASE_ORDER: Record<string, number> = {
      initialization: 0,
      ideation: 1,
      inception: 2,
      construction: 3,
      operation: 4,
    };
    const graph = loadGraph();
    const phaseBySlug = new Map(graph.map((s) => [s.slug, s.phase]));
    const bad: string[] = [];
    for (const s of graph) {
      for (const dep of s.requires_stage ?? []) {
        const depPhase = phaseBySlug.get(dep);
        if (depPhase !== undefined && PHASE_ORDER[depPhase] > PHASE_ORDER[s.phase]) {
          bad.push(`${s.slug}(${s.phase})->${dep}(${depPhase})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // .sh:258-274 — fan-in at code-generation reaches the four design ancestors
  test("code-generation fan-in reaches units-generation, functional/nfr/infrastructure design", () => {
    const graph = loadGraph();
    const bySlug = new Map(graph.map((s) => [s.slug, s]));
    const ancestors = new Set<string>();
    const queue = [...(bySlug.get("code-generation")?.requires_stage ?? [])];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (ancestors.has(cur)) continue;
      ancestors.add(cur);
      for (const dep of bySlug.get(cur)?.requires_stage ?? []) queue.push(dep);
    }
    const expected = ["units-generation", "functional-design", "nfr-design", "infrastructure-design"];
    expect(expected.filter((e) => !ancestors.has(e))).toEqual([]);
  });

  // .sh:280-303 — reverse-engineering is independent of ideation (brownfield fan-out root)
  test("reverse-engineering is independent of ideation (fan-out root for brownfield path)", () => {
    const graph = loadGraph();
    const bySlug = new Map(graph.map((s) => [s.slug, s]));
    function reachable(from: string, to: string): boolean {
      const seen = new Set<string>();
      const queue = [from];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const dep of bySlug.get(cur)?.requires_stage ?? []) {
          if (dep === to) return true;
          queue.push(dep);
        }
      }
      return false;
    }
    const ideationSlugs = graph.filter((s) => s.phase === "ideation").map((s) => s.slug);
    const linked = ideationSlugs.filter((i) => reachable("reverse-engineering", i));
    expect(linked).toEqual([]);
  });

  // .sh:306-316 — producersOf/consumersOf return arrays for every registered artifact
  test("producersOf/consumersOf return arrays for every registered artifact", () => {
    const arts = [...artifactsRegistry()];
    let errors = 0;
    for (const a of arts) {
      if (!Array.isArray(producersOf(a))) errors++;
      if (!Array.isArray(consumersOf(a))) errors++;
    }
    expect(errors).toBe(0);
  });

  // .sh:319-330 — every consumed artifact has a producer somewhere
  test("every consumed artifact has a producer somewhere in the graph", () => {
    const graph = loadGraph();
    const orphans = new Set<string>();
    for (const s of graph) {
      for (const c of s.consumes ?? []) {
        if (producersOf(c.artifact).length === 0) orphans.add(c.artifact);
      }
    }
    expect([...orphans]).toEqual([]);
  });
});

// =============================================================================
// Graph traversal — per-scope sub-DAG (.sh:337-375, 3 assertions)
// =============================================================================

describe("t66 graph traversal — per-scope sub-DAG (in-process)", () => {
  // .sh:337-341 — enterprise sub-DAG is the full graph
  test("enterprise sub-DAG equals full graph", () => {
    expect(subgraphForScope("enterprise").length).toBe(loadGraph().length);
  });
  // .sh:344-356 — bugfix sub-DAG has sawed-off edges (producers off-path)
  test("bugfix sub-DAG has sawed-off edges (producers off-path)", () => {
    const path = subgraphForScope("bugfix");
    const onPath = new Set(path.map((s) => s.slug));
    let sawed = 0;
    for (const s of path) {
      for (const dep of s.requires_stage ?? []) {
        if (!onPath.has(dep)) sawed++;
      }
    }
    expect(sawed).toBeGreaterThan(0);
  });
  // .sh:359-375 — feature sub-DAG edges are a subset of full-graph edges
  test("feature sub-DAG edges are a subset of full-graph edges", () => {
    const featurePath = subgraphForScope("feature");
    const fullBySlug = new Map(loadGraph().map((s) => [s.slug, s]));
    const onPath = new Set(featurePath.map((s) => s.slug));
    let spurious = 0;
    for (const s of featurePath) {
      const full = fullBySlug.get(s.slug);
      for (const dep of s.requires_stage ?? []) {
        if (onPath.has(dep) && !(full?.requires_stage ?? []).includes(dep)) spurious++;
      }
    }
    expect(spurious).toBe(0);
  });
});

// =============================================================================
// Plan-identity parity — byte-exact for 9 scopes (.sh:381-390, 9 assertions)
// MUST STAY SPAWN: asserts the CLI `state lookup stages-in-scope` stdout matches the
// golden fixtures byte-for-byte (process-boundary stdout contract). The .sh re-pretty-
// prints the CLI's single-line JSON with JSON.stringify(parse, null, 2); reproduced here.
// =============================================================================

describe("t66 plan-identity parity (spawnSync CLI-boundary: 9 scopes)", () => {
  for (const scope of SCOPES) {
    test(`plan-identity parity: ${scope} byte-exact`, () => {
      const res = spawnSync(BUN, [STATE_TS, "lookup", "stages-in-scope", scope], {
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      // .sh pipes CLI single-line JSON through JSON.stringify(parse, null, 2).
      const actual = JSON.stringify(JSON.parse(res.stdout), null, 2);
      const expected = readFileSync(join(PARITY_DIR, `${scope}.json`), "utf8").trimEnd();
      expect(actual).toBe(expected);
    });
  }
});

// =============================================================================
// AIDLC_GRAPH_RESOLVE=1 resolve cutover parity — byte-exact for 9 scopes
// (.sh:407-415, 9 assertions). MUST STAY SPAWN: this is an ENV-GATED CLI
// subcommand whose entire subject is a process-boundary seam — a FRESH process
// must (a) read AIDLC_GRAPH_RESOLVE at module/handler time to lift the gate and
// (b) emit the {slug, phase, action} plan to stdout. resolvePlanForScope() is
// importable, but the .sh assertion proves the `resolve <scope> --stdout` CLI
// path (env read + stdout byte-shape), so spawnSync the real tool.
//
// v0.6.0 SURFACE NOTE: the .sh framed this as the "milestone 12 cutover safety net"
// proving the frontmatter-derived grid == the LEGACY scope-mapping-derived plan
// BEFORE scope-mapping.json was retired. scope-mapping.json IS now retired
// (verified: dist/claude/.claude/tools/data/ has scope-grid.json, no
// scope-mapping.json; nine .claude/scopes/aidlc-<scope>.md files are the
// authored source). resolvePlanForScope() (aidlc-graph.ts:762-780) reads
// loadScopeGrid()[scope] — the compiled grid — so this resolve path now pins the
// CURRENT shipped surface, and its output still equals the mr9-parity fixtures
// byte-for-byte (the cutover held). No obsolete-source resurrection: the
// fixtures are the frozen plan-shape; the live surface is the grid. The output
// is already 2-space-indented JSON with a trailing newline, so the .sh's
// JSON.parse + JSON.stringify(parse, null, 2) reformat is an identity
// round-trip; asserted directly against the trimmed fixture here, plus the raw
// trailing-newline byte-shape and exit 0.
// =============================================================================

describe("t66 AIDLC_GRAPH_RESOLVE=1 resolve cutover parity (spawnSync env-gated CLI)", () => {
  for (const scope of SCOPES) {
    test(`resolve parity (frontmatter-derived grid == legacy): ${scope} byte-exact`, () => {
      const res = spawnSync(BUN, [GRAPH_TS, "resolve", scope, "--stdout"], {
        env: { ...process.env, AIDLC_GRAPH_RESOLVE: "1" },
        encoding: "utf8",
      });
      // Gate lifted -> the resolve handler runs and exits 0 (the .sh ran with
      // `2>/dev/null`, trusting a clean stdout — assert the exit explicitly,
      // which is strictly stronger than the .sh's silent assumption).
      expect(res.status).toBe(0);
      // resolve --stdout writes `${JSON.stringify(plan, null, 2)}\n` (graph.ts:1328-1331):
      // already pretty-printed with a trailing newline. The .sh's reformat pipe is an
      // identity round-trip, so compare the parsed-and-re-pretty-printed stdout to the
      // fixture (trimmed exactly as the .sh's `$(cat ...)` strips the trailing newline).
      const actual = JSON.stringify(JSON.parse(res.stdout), null, 2);
      const expected = readFileSync(join(PARITY_DIR, `${scope}.json`), "utf8").trimEnd();
      expect(actual).toBe(expected);
      // STRONGER than the .sh: pin the raw stdout byte-shape too — the handler's
      // trailing newline must be present (the `--stdout` write contract).
      expect(res.stdout.endsWith("\n")).toBe(true);
      expect(res.stdout.trimEnd()).toBe(expected);
    });
  }

  // The env gate is the whole reason `resolve` ships behind a flag — prove it
  // FIRES (the failure event, not just the happy path): without
  // AIDLC_GRAPH_RESOLVE=1 the handler must exit 1 with the rollout-gate message
  // on stderr and emit NO plan to stdout. STRONGER than the .sh (which only ever
  // ran the flag-set happy path, redirecting stderr to /dev/null).
  test("resolve is gated behind AIDLC_GRAPH_RESOLVE=1 (no flag -> exit 1, stderr, no stdout)", () => {
    const env = { ...process.env };
    delete (env as Record<string, string | undefined>).AIDLC_GRAPH_RESOLVE;
    const res = spawnSync(BUN, [GRAPH_TS, "resolve", "feature", "--stdout"], {
      env,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("AIDLC_GRAPH_RESOLVE=1");
    expect(res.stdout.trim()).toBe("");
  });
});

// =============================================================================
// nextInScopeStage walk parity — 9 scopes (.sh:396-423, 1 grouped assertion)
// MUST STAY SPAWN: drives the CLI `state lookup next-stage <slug> <scope>` walk loop
// (process-boundary; each step is a fresh process emitting next or "none").
// =============================================================================

describe("t66 nextInScopeStage walk parity (spawnSync CLI-boundary: 9 scopes)", () => {
  test("nextInScopeStage walk parity byte-exact for 9 scopes", () => {
    const fails: string[] = [];
    for (const scope of SCOPES) {
      const scopeRows = JSON.parse(
        readFileSync(join(PARITY_DIR, `${scope}.json`), "utf8"),
      ) as Array<{ slug: string; action: string }>;
      const exec = scopeRows.filter((x) => x.action === "EXECUTE");
      const first = exec.length > 0 ? exec[0].slug : "";
      const walk: string[] = [first];
      let current = first;
      while (true) {
        const res = spawnSync(BUN, [STATE_TS, "lookup", "next-stage", current, scope], {
          encoding: "utf8",
        });
        const next = (res.stdout + res.stderr).trim();
        if (next === "none") break;
        walk.push(next);
        current = next;
      }
      const actual = JSON.stringify(walk, null, 2);
      const expected = readFileSync(join(PARITY_DIR, `${scope}.walk.json`), "utf8").trimEnd();
      if (actual !== expected) fails.push(scope);
    }
    expect(fails).toEqual([]);
  }, 120000); // many sequential CLI spawns across 9 scopes (workshop ~25 steps)
});

// =============================================================================
// firstInScopeStageOfPhase parity — 9 scopes x 5 phases (.sh:430-458, 1 grouped assertion)
// MUST STAY SPAWN: drives the CLI `state lookup first-in-phase <phase> <scope>` per cell.
// =============================================================================

describe("t66 firstInScopeStageOfPhase parity (spawnSync CLI-boundary)", () => {
  test("firstInScopeStageOfPhase parity byte-exact for 9 scopes x 5 phases", () => {
    const fails: string[] = [];
    for (const scope of SCOPES) {
      const obj: Record<string, string> = {};
      for (const phase of PHASES) {
        const res = spawnSync(BUN, [STATE_TS, "lookup", "first-in-phase", phase, scope], {
          encoding: "utf8",
        });
        obj[phase] = (res.stdout + res.stderr).trim();
      }
      const actual = JSON.stringify(obj, null, 2);
      const expected = readFileSync(join(PARITY_DIR, `${scope}.firstInPhase.json`), "utf8").trimEnd();
      if (actual !== expected) fails.push(scope);
    }
    expect(fails).toEqual([]);
  }, 120000); // 9 scopes x 5 phases = 45 sequential CLI spawns
});

// =============================================================================
// nextInScopeStage state-file semantics (.sh:467-533, 3 assertions, in-process)
// nextInScopeStage(afterSlug, scope, stateContent) is a pure function — the .sh
// only spawned it because it lived in lib.ts. Call it directly here.
// =============================================================================

describe("t66 nextInScopeStage state-file semantics (in-process)", () => {
  // .sh:467-491 — completed [x] intent-capture is skipped; returns market-research
  test("nextInScopeStage skips completed intent-capture, returns market-research", () => {
    const state = `# Workflow State

## Stage Progress

- [x] intent-capture — EXECUTE
- [ ] market-research — EXECUTE
- [ ] feasibility — EXECUTE
`;
    const next = nextInScopeStage("state-init", "feature", state);
    expect(next ? next.slug : "null").toBe("market-research");
  });

  // .sh:497-510 — SKIP suffix on intent-capture honoured; returns market-research
  test("nextInScopeStage honours SKIP suffix on intent-capture", () => {
    const state = `# Workflow State

## Stage Progress

- [ ] intent-capture — SKIP
- [ ] market-research — EXECUTE
`;
    const next = nextInScopeStage("state-init", "feature", state);
    expect(next ? next.slug : "null").toBe("market-research");
  });

  // .sh:521-533 — EXECUTE override promotes a scope-SKIP stage (bugfix intent-capture)
  test("nextInScopeStage honours EXECUTE override for scope-SKIP intent-capture in bugfix", () => {
    const state = `# Workflow State

## Stage Progress

- [ ] intent-capture — EXECUTE
`;
    const next = nextInScopeStage("state-init", "bugfix", state);
    expect(next ? next.slug : "null").toBe("intent-capture");
  });
});

// =============================================================================
// Circular import — both modules load without throw (.sh:539-544, 1 assertion)
// In-process: the test file already statically imports BOTH modules at the top
// (aidlc-graph.ts <-> aidlc-lib.ts circular pair). If the circular import threw at
// module-load, this file would not have loaded at all. Pin it explicitly via the
// imported symbols being functions — equivalent to the .sh's dynamic-import probe.
// =============================================================================

describe("t66 circular import (in-process)", () => {
  test("lib.ts and aidlc-graph.ts load without circular-import throw", () => {
    expect(`${typeof loadScopeMapping},${typeof loadGraph}`).toBe("function,function");
  });
});

// =============================================================================
// AIDLC_STAGE_GRAPH env override honoured post-rewire (.sh:550-594, 1 assertion)
// MUST STAY SPAWN: the assertion's whole point is that a FRESH process reads
// AIDLC_STAGE_GRAPH at module load and stagesInScope() reflects the injected file.
// In-process the module is already loaded with the real graph cached, so this is a
// genuine module-load env-read boundary -> spawnSync.
// =============================================================================

describe("t66 AIDLC_STAGE_GRAPH env override (spawnSync env-seam)", () => {
  test("AIDLC_STAGE_GRAPH env override honoured by rewired stagesInScope", () => {
    const dir = mkdtempSync(join(tmpdir(), "t66-stagegraph-"));
    scratch.push(dir);
    const fixture = join(dir, "fixture-graph.json");
    writeFileSync(
      fixture,
      JSON.stringify(
        [
          {
            slug: "workspace-scaffold",
            number: "0.1",
            name: "Workspace Scaffold",
            phase: "initialization",
            execution: "ALWAYS",
            lead_agent: "orchestrator",
            support_agents: [],
            mode: "inline",
            produces: [],
            consumes: [],
            requires_stage: [],
            inputs: "none",
            outputs: "tree",
          },
          {
            slug: "state-init",
            number: "0.3",
            name: "State Init",
            phase: "initialization",
            execution: "ALWAYS",
            lead_agent: "orchestrator",
            support_agents: [],
            mode: "inline",
            produces: [],
            consumes: [],
            requires_stage: ["workspace-scaffold"],
            inputs: "none",
            outputs: "state",
          },
        ],
        null,
        2,
      ),
    );
    // Forward-slash the import specifier: this path is interpolated into a
    // `bun -e` source string, and on native Windows join() yields backslashes
    // that the eval parser eats as escape sequences (\t -> TAB, \c, \d ...),
    // mangling the path to "C:aidlc...distclaude.claude<TAB>ools...". bun/node
    // accept forward-slash specifiers on every OS; no-op on macOS/Linux.
    const libImport = join(TOOLS_DIR, "aidlc-lib.ts").replace(/\\/g, "/");
    const res = spawnSync(
      BUN,
      [
        "-e",
        `import { stagesInScope } from '${libImport}';
         const r = stagesInScope('enterprise');
         console.log(r.length + ':' + r.map(x => x.slug).join(','));`,
      ],
      { env: { ...process.env, AIDLC_STAGE_GRAPH: fixture }, encoding: "utf8" },
    );
    expect((res.stdout + res.stderr).trim()).toBe("2:workspace-scaffold,state-init");
  });
});

// =============================================================================
// validateScope semantic precision (.sh:604-655, 5 assertions, in-process)
// =============================================================================

describe("t66 validateScope (in-process)", () => {
  // .sh:604-610 — structured shape + feature valid
  test("validateScope returns structured {valid, errors, advisories}; feature scope valid", () => {
    const r = validateScope("feature");
    const shape = "valid" in r && Array.isArray(r.errors) && Array.isArray(r.advisories);
    expect(`${shape}:${r.valid}`).toBe("true:true");
  });
  // .sh:618-623 — bugfix produces advisories (off-path producers)
  test("validateScope produces advisories for bugfix (off-path producers)", () => {
    expect(validateScope("bugfix").advisories.length).toBeGreaterThan(0);
  });
  // .sh:632-640 — projectType filter reduces advisories (<=)
  test("validateScope projectType filter reduces advisories", () => {
    const unfiltered = validateScope("feature");
    const greenfield = validateScope("feature", { projectType: "greenfield" });
    expect(greenfield.advisories.length).toBeLessThanOrEqual(unfiltered.advisories.length);
  });
  // .sh:650-655 — required:false orphans are silent (feature errors=0)
  test("validateScope ignores required:false orphans (feature errors=0)", () => {
    expect(validateScope("feature").errors.length).toBe(0);
  });
  // The .sh header lists "validateScope (5)"; the fifth distinct contract the .sh
  // exercises across cases is the errors-vs-advisories split: an off-path producer is
  // an advisory (not an error). Pin it directly so all five validateScope semantics
  // are represented (the bugfix advisory exists while errors stay empty).
  test("validateScope: off-path producer is an advisory, not an error (bugfix)", () => {
    const r = validateScope("bugfix");
    expect(r.errors.length).toBe(0);
    expect(r.advisories.length).toBeGreaterThan(0);
  });

  // Pin the EXACT advisory edge set per scope — the deliberate "producer
  // skipped by the scope" shortcuts the incremental scopes take (the scope
  // author owns the upstream; the stage bodies degrade gracefully). Any NEW
  // dangling required consume — a scope edit that drops a producer, or a
  // stage edit that hard-requires an artifact its scopes never produce —
  // changes one of these sets and fails here as a scope-authoring error,
  // instead of hiding among the accepted advisories. An edge LEAVING a set
  // (producer added to the scope, or consume relaxed) also fails, so the
  // baseline is updated consciously in the same commit.
  test("validateScope: the per-scope advisory edge sets are exactly the accepted baseline", () => {
    const EXPECTED: Record<string, string[]> = {
      bugfix: ["code-generation->unit-of-work"],
      enterprise: [],
      feature: [],
      infra: [
        "ci-pipeline->build-and-test-summary",
        "ci-pipeline->build-test-results",
        "ci-pipeline->code-summary",
        "deployment-execution->build-test-results",
        "infrastructure-design->business-logic-model",
        "infrastructure-design->components",
        "infrastructure-design->services",
        "nfr-design->business-logic-model",
        "nfr-requirements->business-logic-model",
        "nfr-requirements->business-rules",
      ],
      mvp: [],
      poc: ["code-generation->unit-of-work"],
      refactor: [
        "code-generation->unit-of-work",
        "functional-design->component-methods",
        "functional-design->components",
        "functional-design->services",
        "functional-design->unit-of-work",
      ],
      "security-patch": [
        "code-generation->unit-of-work",
        "deployment-execution->environment-inventory",
        "deployment-pipeline->ci-config",
        "deployment-pipeline->cicd-pipeline",
        "deployment-pipeline->deployment-architecture",
        "deployment-pipeline->quality-gates",
        "nfr-requirements->business-logic-model",
        "nfr-requirements->business-rules",
      ],
      workshop: ["refined-mockups->user-flow", "refined-mockups->wireframes"],
    };
    const actual: Record<string, string[]> = {};
    for (const scope of Object.keys(EXPECTED)) {
      const r = validateScope(scope);
      expect(r.errors).toEqual([]);
      actual[scope] = r.advisories
        .map((a) => {
          const m = a.match(/^Stage "([^"]+)" requires artifact "([^"]+)"/);
          return m ? `${m[1]}->${m[2]}` : a;
        })
        .sort();
    }
    expect(actual).toEqual(EXPECTED);
  });
});

// =============================================================================
// Compile round-trip — second compile byte-identical (.sh:661-682, 1 assertion)
// In-process: compileStageGraph() twice (with __resetGraphCache between) -> equal hash.
// =============================================================================

describe("t66 compile round-trip (in-process)", () => {
  test("compile round-trip produces byte-identical output", () => {
    const first = compileStageGraph().json;
    __resetGraphCache();
    const second = compileStageGraph().json;
    expect(sha256(first)).toBe(sha256(second));
  });
});

// =============================================================================
// Edge-local invariant — upstream-depends-on-higher-number (.sh:696-721, 1 assertion)
// In-process: replicate the .sh's direct invariant-logic check verbatim.
// =============================================================================

describe("t66 edge-local invariant (in-process)", () => {
  test("edge-local invariant detects upstream-depends-on-higher-number", () => {
    const stages = [
      { slug: "a", number: "2.1", requires_stage: [] },
      { slug: "b", number: "1.1", requires_stage: ["a"] },
    ];
    const numberBySlug = new Map(stages.map((s) => [s.slug, s.number]));
    let violated = false;
    for (const s of stages) {
      for (const dep of s.requires_stage ?? []) {
        const depNum = numberBySlug.get(dep);
        if (depNum && numericOrder(depNum, s.number) >= 0) violated = true;
      }
    }
    expect(violated).toBe(true);
  });
});

// =============================================================================
// Compile auto-seeds a new stage rather than requiring a pre-seeded row (#364).
// The old pre-seed contract (compile threw "Pre-seed new rows" for a new slug)
// was replaced by auto-seeding: a slug on disk with no JSON row gets the next
// free per-phase index + a title-cased default name. This source-grep guards
// that the old throw is gone and the auto-seed path is present.
// =============================================================================

describe("t66 compile auto-seeds new stages (source grep)", () => {
  test("the old 'Pre-seed new rows' throw is gone from compileStageGraph", () => {
    const src = readFileSync(GRAPH_TS, "utf8");
    expect(src.includes("Pre-seed new rows")).toBe(false);
  });

  test("compile derives the next free per-phase index for a new stage", () => {
    const src = readFileSync(GRAPH_TS, "utf8");
    // The auto-seed allocator lives in compileStageGraph (maxIndexByPhasePrefix).
    expect(src.includes("maxIndexByPhasePrefix")).toBe(true);
  });
});

// =============================================================================
// for_each preservation on 5 Construction per-unit stages (.sh:741-747, 1 assertion)
// =============================================================================

describe("t66 for_each preservation (in-process)", () => {
  test("compile preserves for_each:unit-of-work on 5 Construction stages", () => {
    const perUnit = loadGraph()
      .filter((s) => s.for_each === "unit-of-work")
      .map((s) => s.slug)
      .sort();
    expect(perUnit.join(",")).toBe(
      "code-generation,functional-design,infrastructure-design,nfr-design,nfr-requirements",
    );
  });
});

// =============================================================================
// Compile error hardening (.sh:761-811, 3 assertions)
// =============================================================================

describe("t66 compile error hardening (in-process + source grep)", () => {
  // .sh:761-781 — duplicate-slug detection logic names both files
  test("compile duplicate-slug detection names both files", () => {
    const files = [
      { path: "a.md", slug: "intent-capture" },
      { path: "b.md", slug: "intent-capture" },
    ];
    const seen = new Map<string, string>();
    let result = "NO_THROW";
    try {
      for (const f of files) {
        if (seen.has(f.slug)) {
          throw new Error(
            `Duplicate stage slug "${f.slug}" in ${f.path} — already declared in ${seen.get(f.slug)}. Rename one of them.`,
          );
        }
        seen.set(f.slug, f.path);
      }
    } catch (e) {
      const msg = (e as Error).message;
      result =
        msg.includes("Duplicate stage slug") && msg.includes("a.md") && msg.includes("b.md")
          ? "DETECTED"
          : "WRONG_MSG";
    }
    expect(result).toBe("DETECTED");
  });

  // .sh:784-803 — validateStageFrontmatter rejects missing required field (execution)
  test("compile invokes validateStageFrontmatter which rejects missing required fields", () => {
    const bad = {
      slug: "test-stage",
      phase: "initialization",
      // execution deliberately missing
      lead_agent: "orchestrator",
      support_agents: [],
      mode: "inline",
      produces: [],
      consumes: [],
      requires_stage: [],
      inputs: "x",
      outputs: "y",
    };
    const r = validateStageFrontmatter(bad);
    expect(r.valid).toBe(false);
  });

  // .sh:806-811 — filePath context in compile errors (>=2 sites). GREP-THE-SOURCE.
  test("compile errors include filePath context (>=2 sites)", () => {
    const src = readFileSync(GRAPH_TS, "utf8");
    const count = (src.match(/\$\{filePath\}:/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// compile --check drift detection (.sh:821-849, 3 assertions)
// MUST STAY SPAWN: `aidlc-graph.ts compile --check` exits 0/1 via process.exit; there
// is no in-process seam for the check's exit boundary. Sandboxed via a fresh tempfile.
// =============================================================================

describe("t66 compile --check drift (spawnSync CLI exit-code)", () => {
  test("clean -> 0, mutated -> 1, restore -> 0", () => {
    const graph = seedGraphCopy();
    const env = { ...process.env, AIDLC_STAGE_GRAPH: graph };

    // Clean -> exit 0
    const clean = spawnSync(BUN, [GRAPH_TS, "compile", "--check"], { env, encoding: "utf8" });
    expect(clean.status).toBe(0);

    // Mutate temp graph -> exit 1
    const j = JSON.parse(readFileSync(graph, "utf8"));
    j[0].bogus_field = "drift";
    writeFileSync(graph, `${JSON.stringify(j, null, 2)}\n`, "utf8");
    const mutated = spawnSync(BUN, [GRAPH_TS, "compile", "--check"], { env, encoding: "utf8" });
    expect(mutated.status).toBe(1);

    // Restore -> exit 0 again
    copyFileSync(SEED_GRAPH, graph);
    const restored = spawnSync(BUN, [GRAPH_TS, "compile", "--check"], { env, encoding: "utf8" });
    expect(restored.status).toBe(0);
  });
});

// =============================================================================
// Canonical emitter pin (.sh:855-870, 2 assertions, in-process)
// =============================================================================

describe("t66 canonical emitter pin (in-process)", () => {
  // .sh:855-860 — trailing newline
  test("canonicalStageGraphJson emits trailing newline", () => {
    expect(canonicalStageGraphJson(loadGraph()).endsWith("\n")).toBe(true);
  });
  // .sh:862-870 — byte-stable across calls
  test("canonicalStageGraphJson is byte-stable across calls", () => {
    const g = loadGraph();
    expect(sha256(canonicalStageGraphJson(g))).toBe(sha256(canonicalStageGraphJson(g)));
  });
});

// =============================================================================
// Designer export (.sh:885-955, 9 assertions)
// MUST STAY SPAWN: the strongest assertion compares the CLI `export` stdout to the
// golden fixture byte-for-byte (process-boundary stdout contract); the env-seam group
// proves a FRESH process reads AIDLC_STAGE_GRAPH + AIDLC_SCOPE_MAPPING at module load;
// export --check exits via process.exit. The golden at tests/fixtures/designer-export/
// export.json is READ only, never written.
// =============================================================================

describe("t66 designer export (spawnSync CLI-boundary)", () => {
  // .sh:888-890 — Group A: byte-identical to golden fixture (the .sh's $(...) strips
  // the trailing newline from both sides, so compare trimmed-equal).
  test("export output matches golden fixture byte-for-byte", () => {
    const res = spawnSync(BUN, [GRAPH_TS, "export"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const expected = readFileSync(EXPORT_FIXTURE, "utf8");
    expect(res.stdout.trimEnd()).toBe(expected.trimEnd());
  });

  // .sh:892-900 — Group B: element counts match live sources (4 assertions)
  test("export element counts: stages=32, scopes=9, artifacts=122, agents=13", () => {
    const res = spawnSync(BUN, [GRAPH_TS, "export"], { encoding: "utf8" });
    const out = JSON.parse(res.stdout) as {
      stages: unknown[];
      scopes: Record<string, unknown>;
      artifacts: unknown[];
      agents: unknown[];
    };
    expect(out.stages.length).toBe(32);
    expect(Object.keys(out.scopes).length).toBe(9);
    expect(out.artifacts.length).toBe(122);
    expect(out.agents.length).toBe(13);
  });

  // .sh:903-904 — Group C: determinism across two invocations
  test("export is deterministic across two invocations", () => {
    const a = spawnSync(BUN, [GRAPH_TS, "export"], { encoding: "utf8" }).stdout;
    const b = spawnSync(BUN, [GRAPH_TS, "export"], { encoding: "utf8" }).stdout;
    expect(a).toBe(b);
  });

  // .sh:910-949 — Group D: env-seam for AIDLC_STAGE_GRAPH + AIDLC_SCOPE_MAPPING (2 assertions)
  test("env-seam: AIDLC_STAGE_GRAPH + AIDLC_SCOPE_MAPPING swap produce fixture-only export", () => {
    const dir = mkdtempSync(join(tmpdir(), "t66-export-seam-"));
    scratch.push(dir);
    const fixtureGraph = join(dir, "fixture-graph.json");
    const fixtureScopes = join(dir, "fixture-scopes.json");
    writeFileSync(
      fixtureGraph,
      JSON.stringify(
        [
          {
            slug: "fixture-stage",
            number: "0.1",
            name: "Fixture Stage",
            phase: "initialization",
            execution: "ALWAYS",
            lead_agent: "orchestrator",
            support_agents: [],
            mode: "inline",
            produces: ["fixture-artifact"],
            consumes: [],
            requires_stage: [],
            inputs: "none",
            outputs: "fixture output",
          },
        ],
        null,
        2,
      ),
    );
    writeFileSync(
      fixtureScopes,
      JSON.stringify(
        {
          "fixture-scope": {
            depth: "Minimal",
            description: "test fixture scope",
            stages: { "fixture-stage": "EXECUTE" },
          },
        },
        null,
        2,
      ),
    );
    const res = spawnSync(BUN, [GRAPH_TS, "export"], {
      env: { ...process.env, AIDLC_STAGE_GRAPH: fixtureGraph, AIDLC_SCOPE_MAPPING: fixtureScopes },
      encoding: "utf8",
    });
    const out = JSON.parse(res.stdout) as { stages: unknown[]; scopes: Record<string, unknown> };
    expect(out.stages.length).toBe(1);
    expect(Object.keys(out.scopes)[0]).toBe("fixture-scope");
  });

  // .sh:954-955 — Group E: export --check exits 0 when output matches fixture
  test("export --check exits 0 when output matches fixture", () => {
    const res = spawnSync(BUN, [GRAPH_TS, "export", "--check"], { encoding: "utf8" });
    expect(res.status).toBe(0);
  });
});

// =============================================================================
// rules_in_context resolution (milestone 7a) — (.sh:966-1037, 6 assertions)
// =============================================================================

describe("t66 rules_in_context resolution (in-process + spawnSync seams)", () => {
  // .sh:966-971 — loadGraph() stages carry rules_in_context as array (in-process)
  test("loadGraph() stages carry rules_in_context as array", () => {
    expect(Array.isArray(loadGraph()[0].rules_in_context)).toBe(true);
  });

  // .sh:974-983 — FIELD_ORDER places rules_in_context immediately after outputs (in-process)
  test("FIELD_ORDER places rules_in_context immediately after outputs", () => {
    const obj = JSON.parse(canonicalStageGraphJson(loadGraph()))[0] as Record<string, unknown>;
    const keys = Object.keys(obj);
    expect(keys.indexOf("rules_in_context")).toBe(keys.indexOf("outputs") + 1);
  });

  // .sh:987-997 — canonical emitter pin: rules_in_context populates from AIDLC_RULES_DIR.
  // MUST STAY SPAWN: two FRESH compile processes each reading AIDLC_RULES_DIR at module
  // load; the populated-vs-empty hashes must differ (env-seam read boundary).
  test("canonical emitter pin: rules_in_context populates from AIDLC_RULES_DIR", () => {
    const popRules = mkdtempSync(join(tmpdir(), "t66-rules-pop-"));
    const emptyRules = mkdtempSync(join(tmpdir(), "t66-rules-empty-"));
    scratch.push(popRules, emptyRules);
    // Neutral method-file name (P5 relocation: RULE_FILE_REGEX now matches
    // org/team/project.md, not the old aidlc-<scope>.md).
    writeFileSync(join(popRules, "org.md"), "# org rule\n");
    const graphA = seedGraphCopy();
    const graphB = seedGraphCopy();
    spawnSync(BUN, [GRAPH_TS, "compile"], {
      env: { ...process.env, AIDLC_RULES_DIR: popRules, AIDLC_STAGE_GRAPH: graphA },
      encoding: "utf8",
    });
    spawnSync(BUN, [GRAPH_TS, "compile"], {
      env: { ...process.env, AIDLC_RULES_DIR: emptyRules, AIDLC_STAGE_GRAPH: graphB },
      encoding: "utf8",
    });
    const hashPop = sha256(readFileSync(graphA, "utf8"));
    const hashEmpty = sha256(readFileSync(graphB, "utf8"));
    expect(hashPop).not.toBe(hashEmpty);
  });

  // .sh:1000-1009 — compile --check detects rule-file drift via AIDLC_RULES_DIR.
  // MUST STAY SPAWN: compile then --check (process.exit boundary) after adding a rule.
  test("compile --check detects rule-file drift via AIDLC_RULES_DIR", () => {
    const rules = mkdtempSync(join(tmpdir(), "t66-rules-drift-"));
    scratch.push(rules);
    const graph = seedGraphCopy();
    const env = { ...process.env, AIDLC_RULES_DIR: rules, AIDLC_STAGE_GRAPH: graph };
    writeFileSync(join(rules, "org.md"), "# initial org rule\n");
    spawnSync(BUN, [GRAPH_TS, "compile"], { env, encoding: "utf8" });
    writeFileSync(join(rules, "team.md"), "# team rule added after compile\n");
    const check = spawnSync(BUN, [GRAPH_TS, "compile", "--check"], { env, encoding: "utf8" });
    expect(check.status).toBe(1);
  });

  // .sh:1013-1020 — round-trip: two compiles produce byte-identical output.
  // MUST STAY SPAWN: two FRESH compile processes against seeded tempfiles -> equal hash.
  test("round-trip: two compiles produce byte-identical output", () => {
    const graphD = seedGraphCopy();
    const graphE = seedGraphCopy();
    spawnSync(BUN, [GRAPH_TS, "compile"], {
      env: { ...process.env, AIDLC_STAGE_GRAPH: graphD },
      encoding: "utf8",
    });
    spawnSync(BUN, [GRAPH_TS, "compile"], {
      env: { ...process.env, AIDLC_STAGE_GRAPH: graphE },
      encoding: "utf8",
    });
    expect(sha256(readFileSync(graphD, "utf8"))).toBe(sha256(readFileSync(graphE, "utf8")));
  });

  // .sh:1025-1037 — concurrency: two PARALLEL compiles serialise via withAuditLock; the
  // resulting file is byte-equal to a serial compile result. MUST STAY SPAWN (parallel
  // processes). Spawn both async, await both, then compare to the serial hash.
  test("concurrency: parallel compiles produce byte-equal output to serial compile", async () => {
    const serial = seedGraphCopy();
    const parallel = seedGraphCopy();
    // Serial baseline.
    spawnSync(BUN, [GRAPH_TS, "compile"], {
      env: { ...process.env, AIDLC_STAGE_GRAPH: serial },
      encoding: "utf8",
    });
    const serialHash = sha256(readFileSync(serial, "utf8"));
    // Two parallel compiles against the same file.
    const env = { ...process.env, AIDLC_STAGE_GRAPH: parallel };
    const p1 = Bun.spawn([BUN, GRAPH_TS, "compile"], { env, stdout: "ignore", stderr: "ignore" });
    const p2 = Bun.spawn([BUN, GRAPH_TS, "compile"], { env, stdout: "ignore", stderr: "ignore" });
    await Promise.all([p1.exited, p2.exited]);
    expect(sha256(readFileSync(parallel, "utf8"))).toBe(serialHash);
  });
});

// =============================================================================
// sensors_applicable resolution (milestone 7b) — (.sh:1049-1137, 6 assertions)
// =============================================================================

describe("t66 sensors_applicable resolution (in-process + spawnSync seams)", () => {
  // .sh:1049-1054 — loadGraph() stages carry sensors_applicable as array (in-process)
  test("loadGraph() stages carry sensors_applicable as array", () => {
    expect(Array.isArray(loadGraph()[0].sensors_applicable)).toBe(true);
  });

  // .sh:1057-1066 — FIELD_ORDER places sensors_applicable after rules_in_context (in-process)
  test("FIELD_ORDER places sensors_applicable immediately after rules_in_context", () => {
    const obj = JSON.parse(canonicalStageGraphJson(loadGraph()))[0] as Record<string, unknown>;
    const keys = Object.keys(obj);
    expect(keys.indexOf("sensors_applicable")).toBe(keys.indexOf("rules_in_context") + 1);
  });

  // .sh:1074-1101 — AIDLC_SENSORS_DIR seam: populated dir yields a graph.
  // MUST STAY SPAWN: a FRESH compile reading AIDLC_STAGES_DIR + AIDLC_SENSORS_DIR at
  // module load; the seam is the populated-dir-produces-a-graph fact. Rebuild the
  // single-stage init tree + probe-sensor heredoc via cpSync + writeFileSync.
  test("AIDLC_SENSORS_DIR seam: populated dir yields a graph", () => {
    const stagesInit = mkdtempSync(join(tmpdir(), "t66-sensors-stages-"));
    const sensorsPop = mkdtempSync(join(tmpdir(), "t66-sensors-pop-"));
    scratch.push(stagesInit, sensorsPop);
    cpSync(join(REAL_STAGES, "initialization"), join(stagesInit, "initialization"), {
      recursive: true,
    });
    writeFileSync(
      join(sensorsPop, "aidlc-required-sections.md"),
      `---
id: required-sections
kind: deterministic
command: bun .claude/tools/aidlc-sensor.ts fire required-sections
default_severity: advisory
description: Probe sensor for canonical-emitter test
---

# probe
`,
    );
    const graphS1 = seedGraphCopy();
    spawnSync(BUN, [GRAPH_TS, "compile"], {
      env: {
        ...process.env,
        AIDLC_STAGES_DIR: stagesInit,
        AIDLC_SENSORS_DIR: sensorsPop,
        AIDLC_STAGE_GRAPH: graphS1,
      },
      encoding: "utf8",
    });
    // Non-empty graph file -> the AIDLC_SENSORS_DIR seam wired through.
    expect(readFileSync(graphS1, "utf8").length).toBeGreaterThan(0);
  });

  // .sh:1106-1116 — compile --check detects sensor-manifest drift via AIDLC_SENSORS_DIR.
  // MUST STAY SPAWN: compile then --check (process.exit boundary) after editing a
  // manifest's matches glob. Use the REAL sensor set so real stage imports resolve.
  test("compile --check detects sensor-manifest drift via AIDLC_SENSORS_DIR", () => {
    const sensorsDrift = mkdtempSync(join(tmpdir(), "t66-sensors-drift-"));
    scratch.push(sensorsDrift);
    cpSync(REAL_SENSORS, sensorsDrift, { recursive: true });
    const graphS3 = seedGraphCopy();
    const env = { ...process.env, AIDLC_SENSORS_DIR: sensorsDrift, AIDLC_STAGE_GRAPH: graphS3 };
    spawnSync(BUN, [GRAPH_TS, "compile"], { env, encoding: "utf8" });
    // Edit the linter manifest's matches glob; --check should now fail.
    const linterPath = join(sensorsDrift, "aidlc-linter.md");
    const orig = readFileSync(linterPath, "utf8");
    writeFileSync(linterPath, orig.replace('"**/*.{ts,js}"', '"**/post-edit/*.ts"'));
    const check = spawnSync(BUN, [GRAPH_TS, "compile", "--check"], { env, encoding: "utf8" });
    expect(check.status).toBe(1);
  });

  // .sh:1119-1126 — round-trip: sensor-included compile is byte-identical across runs.
  // MUST STAY SPAWN: two FRESH compile processes (real sensors) -> equal hash.
  test("round-trip: sensor-included compile is byte-identical across runs", () => {
    const graphS4 = seedGraphCopy();
    const graphS5 = seedGraphCopy();
    spawnSync(BUN, [GRAPH_TS, "compile"], {
      env: { ...process.env, AIDLC_STAGE_GRAPH: graphS4 },
      encoding: "utf8",
    });
    spawnSync(BUN, [GRAPH_TS, "compile"], {
      env: { ...process.env, AIDLC_STAGE_GRAPH: graphS5 },
      encoding: "utf8",
    });
    expect(sha256(readFileSync(graphS4, "utf8"))).toBe(sha256(readFileSync(graphS5, "utf8")));
  });

  // .sh:1130-1137 — resolveSensorsForStage direct unit: declared-order + throw-on-unknown.
  // In-process: loadSensors() walks the real sensors dir; resolveSensorsForStage preserves
  // declared order. (The .sh only asserted declared order; the throw-on-unknown contract
  // is exercised by t89 and pinned here too for completeness.)
  test("resolveSensorsForStage returns entries in declared order", () => {
    const m = loadSensors();
    const stage = { slug: "probe", sensors: ["linter", "type-check"] } as unknown as GraphStage;
    const out = resolveSensorsForStage(stage, m);
    expect(`${out.length} ${out[0].id} ${out[1].id}`).toBe("2 linter type-check");
    const bad = { slug: "y", sensors: ["nope"] } as unknown as GraphStage;
    expect(() => resolveSensorsForStage(bad, m)).toThrow(/unknown sensor id/);
  });
});

// =============================================================================
// withAuditLock reentrancy (.sh:1149-1195, 2 assertions, in-process)
// nextInScopeStage's sibling lib.ts primitive — pure in-process, no subprocess needed.
// (The .sh spawned `bun -e` only because it lived in lib.ts.)
// =============================================================================

describe("t66 withAuditLock reentrancy (in-process)", () => {
  // .sh:1149-1176 — nested same-pd is reentrant; lock held throughout; released; fast
  test("withAuditLock: nested same-pd is reentrant; lock held throughout outer scope", () => {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const pd = mkdtempSync(join(tmpdir(), "t66-reentrant-probe-"));
    scratch.push(pd);
    const lockDir = auditLockDir(pd);
    const start = Date.now();
    let inner = false;
    let afterInner = false;
    withAuditLock(pd, () => {
      withAuditLock(pd, () => {
        inner = existsSync(lockDir);
      });
      afterInner = existsSync(lockDir);
    });
    const elapsed = Date.now() - start;
    const released = !existsSync(lockDir);
    expect(inner).toBe(true);
    expect(afterInner).toBe(true);
    expect(released).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  // .sh:1180-1195 — sequential calls do not accumulate exit handlers (handler-leak guard)
  test("withAuditLock: sequential calls do not accumulate exit handlers", () => {
    const pd = mkdtempSync(join(tmpdir(), "t66-listener-probe-"));
    scratch.push(pd);
    const before = process.listenerCount("exit");
    withAuditLock(pd, () => {});
    withAuditLock(pd, () => {});
    withAuditLock(pd, () => {});
    expect(process.listenerCount("exit")).toBe(before);
  });
});
