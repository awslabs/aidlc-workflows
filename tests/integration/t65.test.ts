// covers: function:parseStageFrontmatter, function:emitStageFrontmatter, function:loadAgents
//
// t65 - end-to-end stage-file integrity across all 33 shipped stage .md files.
// Mechanism: none (pure functions over read-only on-disk stage files + the
// generated stage-graph.json; zero CLI spawns, zero LLM, zero tokens).
// Technique: aggregation-then-assert (one beforeAll walk, 22 example-based
// assertions read off the aggregate).
//
// MECHANISM SPLIT: ALL in-process. (No spawn cases.)
//
// COVERS NOTE: validateStageFrontmatter is exercised too (non-init validate
// WITH ctx.agents, init validate WITHOUT ctx), but it is NOT a tracked
// coverage-registry unit (aidlc-stage-schema.ts is not among the enumerated
// function sources; the generated tests/.coverage-registry.json
// returns no `function:validateStageFrontmatter` entry), so it is
// deliberately omitted from the covers: header. parseStageFrontmatter,
// emitStageFrontmatter, and loadAgents all carry minMechanism: none in the
// registry and are creditable from this file.
//
// Sources under test:
//   dist/claude/.claude/tools/aidlc-lib.ts
//     loadAgents(): AgentMetadata[] - sorted-by-slug; each has .slug.
//     parseStageFrontmatter(raw): Record<string, unknown>.
//     emitStageFrontmatter(obj): string - FIELD_ORDER-pinned YAML.
//   dist/claude/.claude/tools/aidlc-stage-schema.ts
//     validateStageFrontmatter(obj, ctx?) => {valid,data}|{valid,errors};
//          ValidationContext.agents - when present, lead_agent +
//          support_agents[] must be in the list. This test passes
//          ctx={agents:agentSlugs} for non-init phases and ctx=undefined for
//          initialization (lead_agent: orchestrator is not an agent slug).
//
// FIXTURE DISCIPLINE: this test reads the REAL shipped stage tree and the REAL
// generated stage-graph.json, read-only. Nothing is written; no tempdir needed;
// no file under tests/fixtures/** is touched.

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  emitStageFrontmatter,
  loadAgents,
  parseStageFrontmatter,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-stage-schema.ts";

const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");
const GRAPH_JSON = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

const ARTIFACT_RE = /^[a-z][a-z0-9-]*$/;

type StageObj = Record<string, unknown>;
type Parsed = { slug: string; phase: string; obj: StageObj };
type GraphNode = { slug: string; number: string; phase: string };

// --- Aggregate computed once in beforeAll. ---
interface Aggregate {
  totalParsed: number;
  parseErrors: Array<{ slug: string; phase: string; error: string }>;
  validateErrors: Array<{ slug: string; phase: string; errors: string[] }>;
  roundTripMismatches: Array<{ slug: string; phase: string; error?: string }>;
  phaseCounts: Record<string, number>;
  forEachCount: number;
  forEachNonConstruction: string[];
  forEachValue: string[];
  usesSubagent: boolean;
  subagentStages: string[];
  usesAgentTeam: boolean;
  mobStages: string[];
  pipelineStages: string[];
  ensembleWithoutSupport: string[];
  producesCount: number;
  badSlugs: Array<{ slug: string; artifact: unknown }>;
  missingProducers: Array<{ slug: string; artifact: string }>;
  badRequires: Array<{ slug: string; missing: string }>;
  crossPhaseGaps: Array<{ slug: string; artifact: string; missing: string }>;
  topoMatches: boolean;
  jsonOrder: string[];
  topoOrder: string[];
  reservedHits: Array<{ slug: string; key: string }>;
  initNonEmpty: string[];
  emptyProse: string[];
  extraYaml: string[];
  extraJson: string[];
  phaseMismatches: string[];
}

let agg: Aggregate;

beforeAll(() => {
  const agentSlugs = loadAgents().map((a) => a.slug);

  const parsed: Parsed[] = [];
  const parseErrors: Aggregate["parseErrors"] = [];
  const validateErrors: Aggregate["validateErrors"] = [];
  const roundTripMismatches: Aggregate["roundTripMismatches"] = [];

  for (const phase of readdirSync(STAGES_DIR)) {
    const pdir = join(STAGES_DIR, phase);
    if (!statSync(pdir).isDirectory()) continue;
    for (const f of readdirSync(pdir)) {
      if (!f.endsWith(".md")) continue;
      const path = join(pdir, f);
      const slug = f.replace(/\.md$/, "");
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (e) {
        parseErrors.push({ slug, phase, error: `read: ${(e as Error).message}` });
        continue;
      }
      let obj: StageObj;
      try {
        obj = parseStageFrontmatter(raw) as StageObj;
      } catch (e) {
        parseErrors.push({ slug, phase, error: `parse: ${(e as Error).message}` });
        continue;
      }
      parsed.push({ slug, phase, obj });

      // Pass ctx.agents for every non-initialization phase and
      // ctx=undefined for initialization (lead_agent: orchestrator is not an
      // agent slug, so agent-slug lookup must be skipped there).
      const ctx = phase === "initialization" ? undefined : { agents: agentSlugs };
      const r = validateStageFrontmatter(obj, ctx);
      if (!r.valid) validateErrors.push({ slug, phase, errors: r.errors });

      try {
        const yaml2 = emitStageFrontmatter(obj);
        const obj2 = parseStageFrontmatter(yaml2);
        if (JSON.stringify(obj) !== JSON.stringify(obj2)) {
          roundTripMismatches.push({ slug, phase });
        }
      } catch (e) {
        roundTripMismatches.push({ slug, phase, error: (e as Error).message });
      }
    }
  }

  // Aggregate checks.
  const phaseCounts = parsed.reduce<Record<string, number>>((m, p) => {
    m[p.phase] = (m[p.phase] || 0) + 1;
    return m;
  }, {});

  const forEach = parsed.filter((p) => typeof p.obj.for_each === "string");
  const usesSubagent = parsed.some((p) => p.obj.mode === "subagent");
  const subagentStages = parsed
    .filter((p) => p.obj.mode === "subagent")
    .map((p) => p.slug)
    .sort();
  const usesAgentTeam = parsed.some((p) => p.obj.mode === "agent-team");
  // Ensemble census: the mob showcase is exactly user-stories; every
  // pipeline/mob stage must carry support agents (schema coupling, asserted
  // here against the real tree as well).
  const mobStages = parsed.filter((p) => p.obj.mode === "mob").map((p) => p.slug);
  const pipelineStages = parsed.filter((p) => p.obj.mode === "pipeline").map((p) => p.slug);
  const ensembleWithoutSupport = parsed
    .filter((p) => p.obj.mode === "mob" || p.obj.mode === "pipeline")
    .filter((p) => !Array.isArray(p.obj.support_agents) || p.obj.support_agents.length === 0)
    .map((p) => p.slug);

  const produces = new Set<string>();
  const badSlugs: Aggregate["badSlugs"] = [];
  for (const p of parsed) {
    if (Array.isArray(p.obj.produces)) {
      for (const name of p.obj.produces as unknown[]) {
        produces.add(name as string);
        if (typeof name !== "string" || !ARTIFACT_RE.test(name)) {
          badSlugs.push({ slug: p.slug, artifact: name });
        }
      }
    }
  }

  // Consumer coverage: every consumes[].artifact has a producer.
  const missingProducers: Aggregate["missingProducers"] = [];
  for (const p of parsed) {
    if (Array.isArray(p.obj.consumes)) {
      for (const c of p.obj.consumes as Array<Record<string, unknown>>) {
        if (c && typeof c.artifact === "string" && !produces.has(c.artifact)) {
          missingProducers.push({ slug: p.slug, artifact: c.artifact });
        }
      }
    }
  }

  // requires_stage validity.
  const allSlugs = new Set(parsed.map((p) => p.slug));
  const badRequires: Aggregate["badRequires"] = [];
  for (const p of parsed) {
    if (Array.isArray(p.obj.requires_stage)) {
      for (const s of p.obj.requires_stage as string[]) {
        if (!allSlugs.has(s)) badRequires.push({ slug: p.slug, missing: s });
      }
    }
  }

  // Cross-phase edge check: a consumes[].artifact produced in a DIFFERENT
  // phase must have its producer reachable via the requires_stage BFS.
  const artifactToProducer = new Map<string, { slug: string; phase: string }>();
  for (const p of parsed) {
    if (Array.isArray(p.obj.produces)) {
      for (const a of p.obj.produces as string[]) {
        artifactToProducer.set(a, { slug: p.slug, phase: p.phase });
      }
    }
  }
  const crossPhaseGaps: Aggregate["crossPhaseGaps"] = [];
  for (const p of parsed) {
    if (!Array.isArray(p.obj.consumes)) continue;
    const rs = new Set<string>(
      Array.isArray(p.obj.requires_stage) ? (p.obj.requires_stage as string[]) : [],
    );
    for (const c of p.obj.consumes as Array<Record<string, unknown>>) {
      if (!c || typeof c.artifact !== "string") continue;
      const prod = artifactToProducer.get(c.artifact);
      if (!prod) continue;
      if (prod.phase !== p.phase && !rs.has(prod.slug)) {
        const visited = new Set<string>();
        const queue = [...rs];
        let found = false;
        while (queue.length) {
          const s = queue.shift()!;
          if (visited.has(s)) continue;
          visited.add(s);
          if (s === prod.slug) {
            found = true;
            break;
          }
          const node = parsed.find((x) => x.slug === s);
          if (node && Array.isArray(node.obj.requires_stage)) {
            for (const r of node.obj.requires_stage as string[]) queue.push(r);
          }
        }
        if (!found) {
          crossPhaseGaps.push({ slug: p.slug, artifact: c.artifact, missing: prod.slug });
        }
      }
    }
  }

  // Topo-sort preserves stage-graph.json numbering.
  const graph = JSON.parse(readFileSync(GRAPH_JSON, "utf8")) as GraphNode[];
  const jsonOrder = graph
    .slice()
    .sort((a, b) => {
      const ap = a.number.split(".").map(Number);
      const bp = b.number.split(".").map(Number);
      if (ap[0] !== bp[0]) return ap[0] - bp[0];
      return ap[1] - bp[1];
    })
    .map((s) => s.slug);

  const topoOrder = (() => {
    const nodes = parsed.map((p) => ({
      slug: p.slug,
      phase: p.phase,
      requires: Array.isArray(p.obj.requires_stage) ? (p.obj.requires_stage as string[]) : [],
    }));
    const phasePrefix: Record<string, number> = {
      initialization: 0,
      ideation: 1,
      inception: 2,
      construction: 3,
      operation: 4,
    };
    const byPhase: Record<string, typeof nodes> = {};
    for (const n of nodes) {
      byPhase[n.phase] = byPhase[n.phase] || [];
      byPhase[n.phase].push(n);
    }
    const result: string[] = [];
    for (const phase of Object.keys(phasePrefix).sort((a, b) => phasePrefix[a] - phasePrefix[b])) {
      const group = byPhase[phase] || [];
      const inDeg: Record<string, number> = {};
      const edges: Record<string, string[]> = {};
      for (const n of group) {
        inDeg[n.slug] = 0;
        edges[n.slug] = [];
      }
      for (const n of group) {
        for (const dep of n.requires) {
          if (inDeg[dep] !== undefined) {
            edges[dep].push(n.slug);
            inDeg[n.slug]++;
          }
        }
      }
      const ready = group
        .filter((n) => inDeg[n.slug] === 0)
        .map((n) => n.slug)
        .sort();
      while (ready.length) {
        const s = ready.shift()!;
        result.push(s);
        for (const next of edges[s]) {
          inDeg[next]--;
          if (inDeg[next] === 0) {
            let i = 0;
            while (i < ready.length && ready[i] < next) i++;
            ready.splice(i, 0, next);
          }
        }
      }
    }
    return result;
  })();

  const topoMatches = JSON.stringify(jsonOrder) === JSON.stringify(topoOrder);

  // Reserved-keys check.
  const RESERVED = ["when", "on_failure", "blocks_on", "timeout", "retry"];
  const reservedHits: Aggregate["reservedHits"] = [];
  for (const p of parsed) {
    for (const k of RESERVED) {
      if (k in p.obj) reservedHits.push({ slug: p.slug, key: k });
    }
  }

  // Init stages produces: [].
  const initNonEmpty = parsed
    .filter(
      (p) =>
        p.phase === "initialization" &&
        Array.isArray(p.obj.produces) &&
        (p.obj.produces as unknown[]).length > 0,
    )
    .map((p) => p.slug);

  // Non-empty prose for inputs / outputs / condition.
  const emptyProse = parsed
    .filter(
      (p) =>
        !(typeof p.obj.inputs === "string" && (p.obj.inputs as string).length > 0) ||
        !(typeof p.obj.outputs === "string" && (p.obj.outputs as string).length > 0) ||
        !(typeof p.obj.condition === "string" && (p.obj.condition as string).length > 0),
    )
    .map((p) => p.slug);

  // YAML <-> JSON slug + phase consistency.
  const graphSlugs = new Set(graph.map((s) => s.slug));
  const yamlSlugs = new Set(parsed.map((p) => p.slug));
  const extraYaml = [...yamlSlugs].filter((s) => !graphSlugs.has(s));
  const extraJson = [...graphSlugs].filter((s) => !yamlSlugs.has(s));
  const phaseMismatches = parsed
    .filter((p) => {
      const g = graph.find((s) => s.slug === p.slug);
      return g && g.phase !== p.obj.phase;
    })
    .map((p) => p.slug);

  agg = {
    totalParsed: parsed.length,
    parseErrors,
    validateErrors,
    roundTripMismatches,
    phaseCounts,
    forEachCount: forEach.length,
    forEachNonConstruction: forEach.filter((p) => p.phase !== "construction").map((p) => p.slug),
    forEachValue: [...new Set(forEach.map((p) => p.obj.for_each as string))],
    usesSubagent,
    subagentStages,
    usesAgentTeam,
    mobStages,
    pipelineStages,
    ensembleWithoutSupport,
    producesCount: produces.size,
    badSlugs,
    missingProducers,
    badRequires,
    crossPhaseGaps,
    topoMatches,
    jsonOrder,
    topoOrder,
    reservedHits,
    initNonEmpty,
    emptyProse,
    extraYaml,
    extraJson,
    phaseMismatches,
  };
});

// ============================================================
// Parse + schema validation
// ============================================================
describe("t65 parse + schema validation (in-process)", () => {
  test("all 33 stage files parse via parseStageFrontmatter (total=33, no errors)", () => {
    expect(agg.parseErrors).toEqual([]);
    expect(agg.totalParsed).toBe(33);
  });

  test("non-init stages validate against schema with ctx.agents (no validate errors)", () => {
    expect(agg.validateErrors).toEqual([]);
  });

  // Init stages validate without ctx.agents (lead_agent=orchestrator allowed).
  // Init stages are validated with ctx=undefined inside the same loop as the
  // non-init stages; since validateErrors is the union across ALL phases (init
  // validated ctx-free, non-init with ctx), an empty validateErrors proves BOTH.
  // Pin the init-specific fact directly.
  test("init stages validate without ctx.agents (orchestrator lead_agent allowed)", () => {
    const initErrs = agg.validateErrors.filter((e) => e.phase === "initialization");
    expect(initErrs).toEqual([]);
  });
});

// ============================================================
// Per-phase stage counts
// ============================================================
describe("t65 per-phase stage counts (in-process)", () => {
  const expected: Array<[string, number]> = [
    ["initialization", 3],
    ["ideation", 7],
    ["inception", 9],
    ["construction", 7],
    ["operation", 7],
  ];
  for (const [phase, count] of expected) {
    test(`${phase} has ${count} stages`, () => {
      expect(agg.phaseCounts[phase]).toBe(count);
    });
  }
});

// ============================================================
// for_each + mode
// ============================================================
describe("t65 for_each + mode (in-process)", () => {
  test("exactly 5 stages have for_each: unit-of-work, all in construction", () => {
    expect(agg.forEachCount).toBe(5);
    expect(agg.forEachNonConstruction).toEqual([]);
    expect(agg.forEachValue).toEqual(["unit-of-work"]);
  });

  test("mode 'subagent' used at least once", () => {
    expect(agg.usesSubagent).toBe(true);
  });

  test("mode 'subagent' used by exactly code-generation and practices-discovery", () => {
    expect(agg.subagentStages).toEqual([
      "code-generation",
      "practices-discovery",
    ]);
  });

  test("mode 'agent-team' reserved — used zero times", () => {
    expect(agg.usesAgentTeam).toBe(false);
  });

  // The mob showcase ships on exactly user-stories; every ensemble
  // stage (pipeline/mob) carries support agents.
  test("mode 'mob' used by exactly user-stories (the 2.5.0 showcase)", () => {
    expect(agg.mobStages).toEqual(["user-stories"]);
  });

  // reverse-engineering's two-link body (developer scans, architect
  // synthesizes and writes) IS the chain topology.
  test("mode 'pipeline' used by exactly reverse-engineering", () => {
    expect(agg.pipelineStages).toEqual(["reverse-engineering"]);
  });

  test("no pipeline/mob stage without support agents", () => {
    expect(agg.ensembleWithoutSupport).toEqual([]);
  });
});

// ============================================================
// produces[] union + slug shape
// ============================================================
describe("t65 produces[] union + slug shape (in-process)", () => {
  test("produces[] union has a positive distinct slug count", () => {
    expect(agg.producesCount).toBeGreaterThan(0);
  });

  test("all produces[] entries match ARTIFACT_SLUG_RE", () => {
    expect(agg.badSlugs).toEqual([]);
  });
});

// ============================================================
// Cross-stage integrity
// ============================================================
describe("t65 cross-stage integrity (in-process)", () => {
  test("every consumes[].artifact appears in some stage's produces[]", () => {
    expect(agg.missingProducers).toEqual([]);
  });

  test("every requires_stage entry resolves to a known stage slug", () => {
    expect(agg.badRequires).toEqual([]);
  });

  test("cross-phase consumes[] artifacts have upstream producers in requires_stage", () => {
    expect(agg.crossPhaseGaps).toEqual([]);
  });

  // Pin the boolean AND the orders so a failure surfaces the divergence.
  test("topo-sort over requires_stage preserves stage-graph.json numbering", () => {
    expect(agg.topoMatches).toBe(true);
    expect(agg.topoOrder).toEqual(agg.jsonOrder);
  });
});

// ============================================================
// Shape guards
// ============================================================
describe("t65 shape guards (in-process)", () => {
  test("all 3 init stages have empty produces[]", () => {
    expect(agg.initNonEmpty).toEqual([]);
  });

  test("no stage contains reserved keys (when, on_failure, blocks_on, timeout, retry)", () => {
    expect(agg.reservedHits).toEqual([]);
  });

  test("round-trip (parse -> emit -> parse) deep-equals original for all 33 stages", () => {
    expect(agg.roundTripMismatches).toEqual([]);
  });

  test("every stage has non-empty inputs, outputs, condition", () => {
    expect(agg.emptyProse).toEqual([]);
  });
});

// ============================================================
// YAML <-> JSON consistency
// ============================================================
describe("t65 YAML <-> stage-graph.json consistency (in-process)", () => {
  test("YAML slugs <-> stage-graph.json slugs match 1:1 with matching phases", () => {
    expect(agg.extraYaml).toEqual([]);
    expect(agg.extraJson).toEqual([]);
    expect(agg.phaseMismatches).toEqual([]);
  });
});
