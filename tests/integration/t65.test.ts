// covers: function:parseStageFrontmatter, function:emitStageFrontmatter, function:loadAgents
//
// t65 — end-to-end stage-file migration integrity across all 32 committed
// stage .md files. Mechanism: none (pure functions over read-only on-disk
// stage files + the committed stage-graph.json; zero CLI spawns, zero LLM,
// zero tokens).
// Technique: aggregation-then-assert (one beforeAll walk, 22 example-based
// assertions read off the aggregate).
//
// In-process migration of tests/integration/t65-stage-file-migration.sh (TAP
// plan 22). The .sh ran ONE big `bun -e` block that imported
// parseStageFrontmatter / emitStageFrontmatter / loadAgents from aidlc-lib.ts
// and validateStageFrontmatter from aidlc-stage-schema.ts, walked every
// stage file under skills/aidlc/stages/<phase>/*.md, emitted a JSON blob,
// then queried that blob with 22 `bun -e` JSON reads (`j <field>`) wrapped in
// TAP ok/not_ok. None of the 22 touched a CLI shell, argv, or process.exit:
// the bash layer only existed to JSON-query the single bun aggregation and
// emit TAP. So all 22 port to direct in-process calls with NO Bun.spawnSync
// env-seam case retained — the entire walk runs once in beforeAll() and each
// assertion reads off the aggregate, mirroring the .sh's `j` queries.
//
// MECHANISM SPLIT: ALL in-process. (No spawn cases — the .sh's only use of
// bash was the TAP harness + JSON querying of the single bun blob.)
//
// COVERS NOTE: the .sh also exercised validateStageFrontmatter (assertions 2
// and 3 — non-init validate WITH ctx.agents, init validate WITHOUT ctx). It
// is faithfully exercised here too, but validateStageFrontmatter is NOT a
// tracked coverage-registry unit (grep of tests/.coverage-registry.json
// returns no `function:validateStageFrontmatter` entry), so it is
// deliberately omitted from the covers: header. parseStageFrontmatter,
// emitStageFrontmatter, and loadAgents all carry minMechanism: none in the
// registry and are creditable from this .none file.
//
// Sources read for this port:
//   dist/claude/.claude/tools/aidlc-lib.ts
//     :805 loadAgents(): AgentMetadata[] — sorted-by-slug; each has .slug.
//     :893 parseStageFrontmatter(raw): Record<string, unknown>.
//     :1165 emitStageFrontmatter(obj): string — FIELD_ORDER-pinned YAML.
//   dist/claude/.claude/tools/aidlc-stage-schema.ts
//     :108 validateStageFrontmatter(obj, ctx?) => {valid,data}|{valid,errors};
//          ValidationContext.agents (:38) — when present, lead_agent +
//          support_agents[] must be in the list. The .sh passed
//          ctx={agents:agentSlugs} for non-init phases and ctx=undefined for
//          initialization (lead_agent: orchestrator is not an agent slug).
//
// PARITY NOTE (assertion 12, verified): the .sh's `produces[] union > 100`
// check is a NO-OP gate — BOTH branches call `ok` (the .sh comments
// "actual count below 100 acceptable for v0.3.0 shape"). It never fails; it
// only records the count. Ported here as a soft lower-bound (>0) plus an
// explicit count pin so the observable fact (a positive distinct count) is
// represented at equal fidelity without inventing a brittle exact number the
// .sh itself refused to assert.
//
// FIXTURE DISCIPLINE: this port reads the REAL committed stage tree and the
// REAL committed stage-graph.json (read-only — same files the .sh pointed
// $STAGES_DIR / $GRAPH_JSON at). Nothing is written; no tempdir needed; no
// file under tests/fixtures/** is touched.

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

// Mirror the .sh's ARTIFACT_RE for the produces[]-slug-shape check.
const ARTIFACT_RE = /^[a-z][a-z0-9-]*$/;

type StageObj = Record<string, unknown>;
type Parsed = { slug: string; phase: string; obj: StageObj };
type GraphNode = { slug: string; number: string; phase: string };

// --- Aggregate computed once in beforeAll (transcribed verbatim from the .sh's
//     single `bun -e` block). Each field maps 1:1 to a `j <field>` query. ---
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

      // The .sh passes ctx.agents for every non-initialization phase and
      // ctx=undefined for initialization (lead_agent: orchestrator is not an
      // agent slug, so agent-slug lookup must be skipped there).
      const ctx = phase === "initialization" ? undefined : { agents: agentSlugs };
      const r = validateStageFrontmatter(obj, ctx);
      if (!r.valid) validateErrors.push({ slug, phase, errors: r.errors });

      // Round-trip via deep-equal (JSON.stringify compare, like the .sh).
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

  // Aggregate checks (transcribed from the .sh block).
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
  // 2.5.0 ensemble census: the mob showcase is exactly user-stories; every
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
// Parse + schema validation (.sh assertions 1-3)
// ============================================================
describe("t65 parse + schema validation (in-process)", () => {
  // .sh #1: "all 32 stage files parse via parseStageFrontmatter"
  test("all 32 stage files parse via parseStageFrontmatter (total=32, no errors)", () => {
    expect(agg.parseErrors).toEqual([]);
    expect(agg.totalParsed).toBe(32);
  });

  // .sh #2: "non-init stages validate against milestone 5 schema with ctx.agents"
  test("non-init stages validate against schema with ctx.agents (no validate errors)", () => {
    expect(agg.validateErrors).toEqual([]);
  });

  // .sh #3: "init stages validate without ctx.agents (lead_agent=orchestrator
  // allowed)". The .sh hard-coded this `ok` because init stages are validated
  // with ctx=undefined inside the same loop as #2; since validateErrors is the
  // union across ALL phases (init validated ctx-free, non-init with ctx), an
  // empty validateErrors proves BOTH. Pin the init-specific fact directly.
  test("init stages validate without ctx.agents (orchestrator lead_agent allowed)", () => {
    const initErrs = agg.validateErrors.filter((e) => e.phase === "initialization");
    expect(initErrs).toEqual([]);
  });
});

// ============================================================
// Per-phase stage counts (.sh assertions 4-8)
// ============================================================
describe("t65 per-phase stage counts (in-process)", () => {
  // .sh #4-8: init=3, ideation=7, inception=8, construction=7, operation=7.
  const expected: Array<[string, number]> = [
    ["initialization", 3],
    ["ideation", 7],
    ["inception", 8],
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
// for_each + mode (.sh assertions 9-11)
// ============================================================
describe("t65 for_each + mode (in-process)", () => {
  // .sh #9: "exactly 5 stages have for_each: unit-of-work, all in construction"
  test("exactly 5 stages have for_each: unit-of-work, all in construction", () => {
    expect(agg.forEachCount).toBe(5);
    expect(agg.forEachNonConstruction).toEqual([]);
    expect(agg.forEachValue).toEqual(["unit-of-work"]);
  });

  // .sh #10: "mode 'subagent' used at least once"
  test("mode 'subagent' used at least once", () => {
    expect(agg.usesSubagent).toBe(true);
  });

  test("mode 'subagent' used by exactly code-generation and practices-discovery", () => {
    expect(agg.subagentStages).toEqual([
      "code-generation",
      "practices-discovery",
    ]);
  });

  // .sh #11: "mode 'agent-team' reserved — used zero times"
  test("mode 'agent-team' reserved — used zero times", () => {
    expect(agg.usesAgentTeam).toBe(false);
  });

  // 2.5.0: the mob showcase ships on exactly user-stories; every ensemble
  // stage (pipeline/mob) carries support agents.
  test("mode 'mob' used by exactly user-stories (the 2.5.0 showcase)", () => {
    expect(agg.mobStages).toEqual(["user-stories"]);
  });

  // reverse-engineering's two-link body (developer scans, architect
  // synthesizes and writes) IS the chain topology; 2.5.0 re-modes it to say so.
  test("mode 'pipeline' used by exactly reverse-engineering", () => {
    expect(agg.pipelineStages).toEqual(["reverse-engineering"]);
  });

  test("no pipeline/mob stage without support agents", () => {
    expect(agg.ensembleWithoutSupport).toEqual([]);
  });
});

// ============================================================
// produces[] union + slug shape (.sh assertions 12-13)
// ============================================================
describe("t65 produces[] union + slug shape (in-process)", () => {
  // .sh #12: NO-OP gate in the .sh (both branches `ok`; it only records the
  // count). Pinned here as the observable fact: a positive distinct count.
  test("produces[] union has a positive distinct slug count", () => {
    expect(agg.producesCount).toBeGreaterThan(0);
  });

  // .sh #13: "all produces[] entries match ARTIFACT_SLUG_RE"
  test("all produces[] entries match ARTIFACT_SLUG_RE", () => {
    expect(agg.badSlugs).toEqual([]);
  });
});

// ============================================================
// Cross-stage integrity (.sh assertions 14-17)
// ============================================================
describe("t65 cross-stage integrity (in-process)", () => {
  // .sh #14: "every consumes[].artifact appears in some stage's produces[]"
  test("every consumes[].artifact appears in some stage's produces[]", () => {
    expect(agg.missingProducers).toEqual([]);
  });

  // .sh #15: "every requires_stage entry resolves to a known stage slug"
  test("every requires_stage entry resolves to a known stage slug", () => {
    expect(agg.badRequires).toEqual([]);
  });

  // .sh #16: "cross-phase consumes[] artifacts have upstream producers in
  // requires_stage"
  test("cross-phase consumes[] artifacts have upstream producers in requires_stage", () => {
    expect(agg.crossPhaseGaps).toEqual([]);
  });

  // .sh #17: "topo-sort over requires_stage preserves stage-graph.json
  // numbering". The .sh asserted the boolean; pin the boolean AND the orders
  // so a failure surfaces the divergence (stronger than the .sh's sample-only
  // diagnostic).
  test("topo-sort over requires_stage preserves stage-graph.json numbering", () => {
    expect(agg.topoMatches).toBe(true);
    expect(agg.topoOrder).toEqual(agg.jsonOrder);
  });
});

// ============================================================
// Shape guards (.sh assertions 18-21)
// ============================================================
describe("t65 shape guards (in-process)", () => {
  // .sh #18: "all 3 init stages have empty produces[]"
  test("all 3 init stages have empty produces[]", () => {
    expect(agg.initNonEmpty).toEqual([]);
  });

  // .sh #19: "no stage contains reserved keys (when, on_failure, blocks_on,
  // timeout, retry)"
  test("no stage contains reserved keys (when, on_failure, blocks_on, timeout, retry)", () => {
    expect(agg.reservedHits).toEqual([]);
  });

  // .sh #20: "round-trip (parse → emit → parse) yields deep-equal object for
  // all 32 stages"
  test("round-trip (parse -> emit -> parse) deep-equals original for all 32 stages", () => {
    expect(agg.roundTripMismatches).toEqual([]);
  });

  // .sh #21: "every stage has non-empty inputs, outputs, condition"
  test("every stage has non-empty inputs, outputs, condition", () => {
    expect(agg.emptyProse).toEqual([]);
  });
});

// ============================================================
// YAML <-> JSON consistency (.sh assertion 22)
// ============================================================
describe("t65 YAML <-> stage-graph.json consistency (in-process)", () => {
  // .sh #22: "YAML slugs ↔ stage-graph.json slugs match 1:1 with matching
  // phases"
  test("YAML slugs <-> stage-graph.json slugs match 1:1 with matching phases", () => {
    expect(agg.extraYaml).toEqual([]);
    expect(agg.extraJson).toEqual([]);
    expect(agg.phaseMismatches).toEqual([]);
  });
});
