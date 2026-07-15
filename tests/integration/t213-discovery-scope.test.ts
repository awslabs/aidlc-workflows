// covers: scope:discovery, stage:ideation/intent-capture, stage:ideation/discovery-current-state, stage:ideation/discovery-future-state, stage:ideation/discovery-experimentation, stage:ideation/discovery-decision
//
// t213 — discovery scope: compiled-artifact contract. Deterministic
// integration twin of tests/e2e/t138-scope-exclusion-counts.test.ts's
// data-driven style: every expectation below is DERIVED from (or checked
// against) the shipped compiled artifacts — scope-grid.json, stage-graph.json,
// and tools/data/templates/ — plus the real inferScopeFromText imported from
// the dist tree. No workflow is driven, no process is spawned, zero LLM,
// zero tokens (mechanism: none).
//
// Subject under test (all under dist/claude/.claude/):
//   - tools/data/scope-grid.json — the transpose of each stage's `scopes:`
//     frontmatter. "discovery".stages maps each of the 36 stages to
//     EXECUTE | SKIP; exactly 8 are EXECUTE (the 3 initialization stages the
//     scope grid marks EXECUTE for every scope + the shared intent-capture
//     stage 1.1 + the 4 ideation discovery stages 1.8-1.11).
//   - tools/data/stage-graph.json — pinned numbers, requires_stage edges, and
//     per-stage `scopes` lists. The 4 discovery stages chain linearly via
//     requires_stage behind intent-capture and declare scopes: [discovery]
//     ONLY, so no other scope's plan grows. intent-capture keeps its four
//     stock-scope tags and gains ONLY discovery — the non-breaking contract
//     for the one existing stage this scope extends.
//   - tools/aidlc-utility.ts inferScopeFromText (:3372) — discovery ships
//     `keywords: []` (the composed-scope convention), so keyword routing can
//     NEVER resolve it; only an explicit `/aidlc discovery` / `--scope
//     discovery` selects it.
//   - tools/data/templates/*.md — the 9 framework-default templates the
//     discovery stages resolve at tier 2 of the template-override order
//     (stage-protocol.md §10). The required-sections sensor uses each
//     template's `##` headings as the expected set, so each must carry at
//     least 2 H2 headings (the generic sensor floor). intent-statement
//     deliberately ships NO template: its conditional sections (Where This
//     Came From, Already Decided, Decide-By Date) must never become required
//     headings for the stock scopes that run intent-capture today.
//
// THE INVARIANTS (stated as data, all derived at test time):
//   1. EXECUTE(discovery) == exactly the 8 expected slugs, in the graph's
//      numeric order (0.1 0.2 0.3 1.1 1.8 1.9 1.10 1.11).
//   2. The 4 discovery stages chain linearly via requires_stage behind
//      intent-capture (intent-capture <- current-state <- future-state
//      <- experimentation <- decision).
//   3. Each of the 4 declares scopes: ["discovery"] and nothing else;
//      intent-capture declares exactly its four stock scopes + discovery,
//      and produces source-inventory + open-questions-record.
//   4. mapping.discovery.keywords == [] AND inferScopeFromText on discovery-ish
//      prose does NOT resolve discovery (no keyword can match an empty set).
//   5. All 9 template files exist with >= 2 H2 headings each, and no
//      template exists for intent-statement or the reserved discovery-brief
//      name (an artifact name this PR deliberately does not introduce).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadScopeMapping } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { inferScopeFromText } from "../../dist/claude/.claude/tools/aidlc-utility.ts";

const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const SCOPE_GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");
const STAGE_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const TEMPLATES_DIR = join(AIDLC_SRC, "tools", "data", "templates");

type ScopeGrid = Record<string, { stages: Record<string, string> }>;
interface StageNode {
  slug: string;
  number: string;
  phase: string;
  requires_stage?: string[];
  scopes?: string[];
  produces?: string[];
}

const readGrid = (): ScopeGrid =>
  JSON.parse(readFileSync(SCOPE_GRID, "utf-8")) as ScopeGrid;
const readGraph = (): StageNode[] =>
  JSON.parse(readFileSync(STAGE_GRAPH, "utf-8")) as StageNode[];

/** major.minor numeric compare of the graph's pinned "P.N" stage numbers. */
function byNumber(a: StageNode, b: StageNode): number {
  const [am, an] = a.number.split(".").map(Number);
  const [bm, bn] = b.number.split(".").map(Number);
  return am !== bm ? am - bm : an - bn;
}

// The 4 discovery-only stages, in their pinned 1.8-1.11 numeric order.
const DISCOVERY_STAGES = [
  "discovery-current-state",
  "discovery-future-state",
  "discovery-experimentation",
  "discovery-decision",
] as const;

// The discovery ideation chain including its shared head, intent-capture.
const DISCOVERY_CHAIN = ["intent-capture", ...DISCOVERY_STAGES] as const;

// The full EXECUTE plan for discovery, in numeric order (0.1-0.3, 1.1, 1.8-1.11).
const EXPECTED_PLAN = [
  "workspace-scaffold",
  "workspace-detection",
  "state-init",
  ...DISCOVERY_CHAIN,
] as const;

// The 9 framework-default templates the discovery stages instantiate
// (template tier 2, keyed by the output artifact's filename stem).
const TEMPLATES = [
  "assumptions-record.md",
  "current-state.md",
  "decision-pack.md",
  "design-language-record.md",
  "evidence-record.md",
  "future-state.md",
  "open-questions-record.md",
  "source-inventory.md",
  "test-plans.md",
] as const;

// Deliberately template-less artifact stems: a template for intent-statement
// would impose its H2 set on the required-sections sensor for a stage the
// stock scopes already run, and discovery-brief is a name this PR considered
// and rejected (its content lives in intent-statement) — a template for it
// must never appear.
const FORBIDDEN_TEMPLATES = ["intent-statement.md", "discovery-brief.md"] as const;

describe("t213 discovery scope — compiled EXECUTE plan (scope-grid.json + stage-graph.json)", () => {
  test("discovery resolves exactly 8 EXECUTE stages in numeric order (0.1-0.3, 1.1, 1.8-1.11)", () => {
    const grid = readGrid();
    const graph = readGraph();
    expect(grid.discovery).toBeDefined();

    // EXECUTE set derived from the grid, then ordered by the graph's pinned
    // numbers — the SAME linearization the serial runtime uses (numeric
    // order, no runtime topo sort).
    const executeSet = new Set(
      Object.entries(grid.discovery.stages)
        .filter(([, v]) => v === "EXECUTE")
        .map(([slug]) => slug),
    );
    const plan = graph
      .filter((s) => executeSet.has(s.slug))
      .sort(byNumber)
      .map((s) => s.slug);
    expect(plan).toEqual([...EXPECTED_PLAN]);
    expect(plan.length).toBe(8);

    // Every OTHER cell in the discovery column is SKIP (36-stage universe;
    // vacuous-pass guard: the column covers the whole graph).
    expect(Object.keys(grid.discovery.stages).length).toBe(graph.length);
    const skips = Object.values(grid.discovery.stages).filter(
      (v) => v === "SKIP",
    ).length;
    expect(skips).toBe(graph.length - 8);
  });

  test("the discovery chain runs linearly via requires_stage behind intent-capture", () => {
    const graph = readGraph();
    const bySlug = new Map(graph.map((s) => [s.slug, s]));
    // intent-capture is the chain head: no requires_stage (it is the first
    // stage of every workflow, discovery included).
    expect(bySlug.get("intent-capture")?.requires_stage).toEqual([]);
    // Each subsequent stage requires EXACTLY its predecessor in the chain.
    for (let i = 1; i < DISCOVERY_CHAIN.length; i++) {
      expect(bySlug.get(DISCOVERY_CHAIN[i])?.requires_stage).toEqual([
        DISCOVERY_CHAIN[i - 1],
      ]);
    }
    // And the numbers ARE 1.1 + 1.8-1.11 in chain order (edge-local
    // invariant: every dependency is lower-numbered).
    const numbers = DISCOVERY_CHAIN.map((s) => bySlug.get(s)?.number);
    expect(numbers).toEqual(["1.1", "1.8", "1.9", "1.10", "1.11"]);
  });

  test("each discovery-only stage declares scopes: [discovery] only", () => {
    const graph = readGraph();
    for (const slug of DISCOVERY_STAGES) {
      const node = graph.find((s) => s.slug === slug);
      expect(node, `stage-graph.json has no node for ${slug}`).toBeDefined();
      // Exactly one scope tag — discovery — so no other scope's plan grows.
      expect(node?.scopes).toEqual(["discovery"]);
      expect(node?.phase).toBe("ideation");
    }
  });

  test("intent-capture keeps its stock scopes and gains only discovery (the non-breaking pin)", () => {
    const graph = readGraph();
    const node = graph.find((s) => s.slug === "intent-capture");
    expect(node).toBeDefined();
    // The four stock scopes that ran intent-capture before this scope landed
    // still run it, discovery is the ONLY addition, and no stock scope lost
    // or gained the stage.
    expect(node?.scopes).toEqual(["enterprise", "feature", "mvp", "poc", "discovery"]);
    // The exact ordered produces pin — the authored frontmatter order in
    // core/aidlc-common/stages/ideation/intent-capture.md. This guards the
    // append-only contract fully: a sixth produce (or a dropped or reordered
    // one) cannot pass silently.
    expect(node?.produces).toEqual([
      "intent-statement",
      "stakeholder-map",
      "intent-capture-questions",
      "source-inventory",
      "open-questions-record",
    ]);
  });
});

describe("t213 discovery scope — keyword routing can never resolve it", () => {
  test("mapping.discovery.keywords is empty ([] — the composed-scope convention)", () => {
    const mapping = loadScopeMapping();
    expect(mapping.discovery).toBeDefined();
    expect(mapping.discovery.keywords).toEqual([]);
  });

  test("inferScopeFromText on discovery-ish prose does NOT return discovery", () => {
    const r = inferScopeFromText(
      "we need to explore whether this product idea is worth building",
    );
    // An empty keyword set can never match, so discovery is unreachable via
    // inference — regardless of the >5-word feature fallback.
    expect(r.scope).not.toBe("discovery");
    expect(r.matches.map((m) => m.scope)).not.toContain("discovery");
    // Pin the actual resolution: rich prose falls back to feature/freeform.
    expect(r.scope).toBe("feature");
    expect(r.source).toBe("freeform");
  });
});

describe("t213 discovery scope — framework-default templates ship with sensor-checkable shape", () => {
  for (const t of TEMPLATES) {
    test(`templates/${t} exists with at least 2 H2 headings`, () => {
      const p = join(TEMPLATES_DIR, t);
      expect(existsSync(p), `${p} missing`).toBe(true);
      const h2s = readFileSync(p, "utf-8")
        .split("\n")
        .filter((l) => l.startsWith("## "));
      // The required-sections sensor's generic floor is >= 2 H2 headings; a
      // resolving template's H2 set becomes the expected section set, so a
      // template with fewer than 2 would weaken the gate below the floor.
      expect(h2s.length).toBeGreaterThanOrEqual(2);
    });
  }

  test("no template ships for intent-statement or the rejected discovery-brief name", () => {
    for (const t of FORBIDDEN_TEMPLATES) {
      expect(existsSync(join(TEMPLATES_DIR, t)), `${t} must not exist`).toBe(false);
    }
  });
});

describe("t213 discovery scope — the extended intent-capture and the commit continuation keep their contracts (stage prose pins)", () => {
  const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages", "ideation");

  test("intent-capture's intake ask flows through the questions file (Stop-hook contract)", () => {
    const s = readFileSync(join(STAGES_DIR, "intent-capture.md"), "utf-8");
    // The intake question is written into the stage's own questions file with
    // a blank [Answer]: tag BEFORE any wait, so the forwarding-loop Stop hook
    // can tell a human-wait from an abandoned stage. A conversational ask
    // outside the file was the round-3 adversarial finding; pin its fix.
    expect(s).toContain("intent-capture-questions.md");
    expect(s).toContain("(select all that apply)");
    expect(s).toContain("None of these — the description is the whole input");
    expect(s).toMatch(/blank\s*\n?\s*tag|blank \[Answer\]: tag/);
    // The non-breaking pledge in prose: nothing supplied means the classic path.
    expect(s.replace(/\s+/g, " ")).toContain("every question is appended, exactly as before");
    // Material-derived answers are never typed into the questions file (the
    // protocol's leave-all-blank rule): they live in the open questions
    // record, unconfirmed, and the gate is the named confirmation point.
    expect(s).toContain("do NOT ask it");
    expect(s).toContain("status `unconfirmed`");
  });

  test("discovery-decision's commit continuation relays real engine verbs and keeps the hand-off path", () => {
    const s = readFileSync(join(STAGES_DIR, "discovery-decision.md"), "utf-8");
    // The continuation sequence, live-verified when designed: scope-change,
    // then set-status at the stage the engine names, then honest skips.
    expect(s).toContain("aidlc-utility.ts scope-change --scope");
    expect(s).toContain("aidlc-utility.ts set-status --stage");
    expect(s).toContain("aidlc-state.ts skip");
    expect(s).toContain("covered by the discovery run");
    // Both destinations stay: continue here, or hand off via the pack.
    expect(s).toContain("Continue here");
    expect(s).toContain("Hand off");
    // The three options carry plain-language meaning at the point of use.
    expect(s).toContain("**Commit** means");
    expect(s).toContain("**Pivot** means");
    expect(s).toContain("**Park** means");
  });
});
