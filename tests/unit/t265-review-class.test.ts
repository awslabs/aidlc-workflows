// t265 — reviewer class (adversarial | advisory | none): the review-cost dial.
//
// Pins the four seams the feature spans:
//   1. Schema: review_class accepts adversarial/advisory, rejects other values,
//      and requires a reviewer (same coupling as reviewer_max_iterations).
//   2. Graph compile: review_class rides into stage-graph.json — the 7
//      human-gated ideation/inception prose stages ship advisory, the 5
//      construction stages default adversarial; absent without a reviewer.
//   3. Resolution: resolveReviewClass is low-wins across stage declaration,
//      scope review_cap, and the per-run Review Override state field — an
//      override can lower but never raise, and no input conjures a reviewer.
//   4. Prose: the §12a class branch and each harness SKILL.md carry the
//      advisory single-pass contract (terminal receipt, findings quoted at
//      the gate, no lead re-invoke), in core AND in every dist projection.
//
// The engine-enforced iteration ceiling (aidlc-log review refusing an
// over-budget REVIEW_REQUESTED) is pinned in t266 — it spawns the real CLI.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateStageFrontmatter } from "../../core/tools/aidlc-stage-schema.ts";
import { resolveReviewClass } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// Minimal valid frontmatter the schema accepts; review fields layered per case.
const BASE = {
  slug: "fixture-stage",
  phase: "inception",
  execution: "ALWAYS",
  condition: "Always executes",
  lead_agent: "aidlc-product-agent",
  support_agents: [],
  mode: "inline",
  produces: ["fixture-artifact"],
  consumes: [],
  requires_stage: [],
  inputs: "none",
  outputs: "none",
};

describe("t265 review class", () => {
  // --- 1. schema -----------------------------------------------------------
  test("schema accepts adversarial and advisory with a reviewer", () => {
    for (const cls of ["adversarial", "advisory"]) {
      const res = validateStageFrontmatter({
        ...BASE,
        reviewer: "aidlc-product-lead-agent",
        review_class: cls,
      });
      expect(res.valid).toBe(true);
    }
  });

  test("schema rejects unknown class values", () => {
    const res = validateStageFrontmatter({
      ...BASE,
      reviewer: "aidlc-product-lead-agent",
      review_class: "none", // scope-cap/override vocabulary, not a stage value
    });
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.errors.join("\n")).toContain("review_class");
    }
  });

  test("schema rejects review_class without a reviewer", () => {
    const res = validateStageFrontmatter({
      ...BASE,
      review_class: "advisory",
    });
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.errors.join("\n")).toContain("review_class requires a reviewer");
    }
  });

  // --- 2. compiled graph ----------------------------------------------------
  const ADVISORY_STAGES = [
    "intent-capture",
    "rough-mockups",
    "requirements-analysis",
    "user-stories",
    "refined-mockups",
    "application-design",
    "units-generation",
  ];
  const ADVERSARIAL_STAGES = [
    "functional-design",
    "nfr-requirements",
    "nfr-design",
    "infrastructure-design",
    "code-generation",
  ];

  test("compiled graph carries the class split (every harness tree)", () => {
    const graphs = [
      "dist/claude/.claude/tools/data/stage-graph.json",
      "dist/kiro/.kiro/tools/data/stage-graph.json",
      "dist/kiro-ide/.kiro/tools/data/stage-graph.json",
      "dist/codex/.codex/tools/data/stage-graph.json",
      "dist/opencode/.aidlc/tools/data/stage-graph.json",
    ];
    for (const rel of graphs) {
      const graph = JSON.parse(read(rel)) as Array<{
        slug: string;
        reviewer?: string;
        review_class?: string;
      }>;
      const bySlug = new Map(graph.map((s) => [s.slug, s]));
      for (const slug of ADVISORY_STAGES) {
        expect(bySlug.get(slug)?.review_class).toBe("advisory");
      }
      for (const slug of ADVERSARIAL_STAGES) {
        expect(bySlug.get(slug)?.review_class).toBe("adversarial");
      }
      // No reviewer -> no class key at all.
      const noReviewer = graph.filter((s) => !s.reviewer);
      expect(noReviewer.length).toBeGreaterThan(0);
      for (const s of noReviewer) {
        expect(s.review_class).toBeUndefined();
      }
    }
  });

  test("scope caps: bugfix, poc, workshop declare review_cap advisory", () => {
    for (const scope of ["bugfix", "poc", "workshop"]) {
      expect(read(`core/scopes/aidlc-${scope}.md`)).toContain(
        "review_cap: advisory"
      );
    }
  });

  // --- 3. resolution --------------------------------------------------------
  test("resolveReviewClass is low-wins and cannot conjure a reviewer", () => {
    // No stage reviewer -> none, regardless of scope/override.
    expect(resolveReviewClass(undefined, "feature")).toBe("none");
    expect(
      resolveReviewClass(undefined, "feature", "- **Review Override**: adversarial\n")
    ).toBe("none");
    // Uncapped scope keeps the declaration.
    expect(resolveReviewClass("adversarial", "feature")).toBe("adversarial");
    expect(resolveReviewClass("advisory", "feature")).toBe("advisory");
    // Capped scope lowers adversarial to advisory (bugfix/poc/workshop).
    expect(resolveReviewClass("adversarial", "bugfix")).toBe("advisory");
    // Override lowers further...
    expect(
      resolveReviewClass("adversarial", "feature", "- **Review Override**: none\n")
    ).toBe("none");
    expect(
      resolveReviewClass("adversarial", "feature", "- **Review Override**: advisory\n")
    ).toBe("advisory");
    // ...but never raises: adversarial override on a capped scope stays advisory.
    expect(
      resolveReviewClass("adversarial", "bugfix", "- **Review Override**: adversarial\n")
    ).toBe("advisory");
    // Empty/absent override field = no override.
    expect(
      resolveReviewClass("adversarial", "feature", "- **Review Override**: \n")
    ).toBe("adversarial");
  });

  // --- 4. prose (core + every dist skill) -----------------------------------
  const ADVISORY_TERMINAL =
    "On `advisory` both verdicts are terminal";

  test("stage-protocol §12a carries the class branch (core + dist)", () => {
    for (const rel of [
      "core/aidlc-common/protocols/stage-protocol.md",
      "dist/claude/.claude/aidlc-common/protocols/stage-protocol.md",
    ]) {
      const src = read(rel);
      expect(src).toContain("`review_class` field");
      expect(src).toContain("On an `advisory` review, both verdicts are terminal here.");
      // The adversarial contract prose t234 pins must survive the class split.
      expect(src).toContain("refute the artifact, not to confirm it");
    }
  });

  test("every harness SKILL.md carries the advisory single-pass contract", () => {
    const skills = [
      "harness/claude/skills/aidlc/SKILL.md",
      "harness/kiro/skills/aidlc/SKILL.md",
      "harness/kiro-ide/skills/aidlc/SKILL.md",
      "harness/codex/skills/aidlc/SKILL.md",
      "harness/opencode/skills/aidlc/SKILL.md",
      "dist/claude/.claude/skills/aidlc/SKILL.md",
    ];
    for (const rel of skills) {
      const src = read(rel);
      expect(src).toContain("directive.review_class");
      expect(src).toContain(ADVISORY_TERMINAL);
    }
  });

  test("reviewer personas carry the advisory-dispatch stance (core + dist)", () => {
    for (const rel of [
      "core/agents/aidlc-product-lead-agent.md",
      "core/agents/aidlc-architecture-reviewer-agent.md",
      "dist/claude/.claude/agents/aidlc-product-lead-agent.md",
      "dist/claude/.claude/agents/aidlc-architecture-reviewer-agent.md",
    ]) {
      const src = read(rel);
      expect(src).toContain("## Advisory Dispatch");
      expect(src).toContain("decision support, not a repair loop");
    }
  });

  test("balanced tier pins medium effort (the reviewer tier)", () => {
    const dist = read("dist/claude/.claude/agents/aidlc-product-lead-agent.md");
    expect(dist).toContain("effort: medium");
    const codex = read("dist/codex/.codex/agents/aidlc-product-lead-agent.toml");
    expect(codex).toContain('model_reasoning_effort = "medium"');
  });
});
