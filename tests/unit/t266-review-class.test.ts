// t266 — reviewer class (adversarial | advisory | none): the review-cost dial.
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
// over-budget REVIEW_REQUESTED) is pinned in t271 — it spawns the real CLI.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStageFrontmatter } from "../../core/tools/aidlc-stage-schema.ts";
import {
  readAllAuditShards,
  resolveReviewClass,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  removeWorkspaceRecord,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const ORCHESTRATE = join(ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");
const UTILITY = join(ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const tempDirs: string[] = [];

resetAidlcEnv();
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function projectWithState(): string {
  const project = createTestProject();
  tempDirs.push(project);
  seedAidlcMemory(project);
  seedStateFile(project, "state-mid-inception.md");
  return project;
}

function runUtility(project: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [UTILITY, ...args, "--project-dir", project],
    { encoding: "utf-8" },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

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

describe("t266 review class", () => {
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

  test("birth and scope/config routes preserve --review", () => {
    const fresh = createTestProject();
    tempDirs.push(fresh);
    removeWorkspaceRecord(fresh);
    const birth = runOrchestrateNext(
      ORCHESTRATE,
      fresh,
      ["--scope", "feature", "--review", "none"],
    );
    expect(birth.status).toBe(0);
    expect(String(birth.directive?.message)).toContain(
      "intent-create --scope feature --review none",
    );

    const active = projectWithState();
    const changedScope = runOrchestrateNext(
      ORCHESTRATE,
      active,
      ["--scope", "feature", "--review", "none"],
    );
    expect(changedScope.status).toBe(0);
    expect(String(changedScope.directive?.message)).toContain(
      "scope-change --scope feature --review none",
    );

    const sameScope = runOrchestrateNext(
      ORCHESTRATE,
      active,
      ["--scope", "bugfix", "--review", "none"],
    );
    expect(sameScope.status).toBe(0);
    expect(String(sameScope.directive?.message)).toContain(
      "config-change --review none",
    );

    const parked = projectWithState();
    const parkedState = stateFilePath(parked);
    writeFileSync(
      parkedState,
      `${readFileSync(parkedState, "utf-8")}\n- **Parked**: true\n- **Parked At Stage**: requirements-analysis\n`,
      "utf-8",
    );
    const parkedConfig = runOrchestrateNext(
      ORCHESTRATE,
      parked,
      ["--review", "none"],
    );
    expect(parkedConfig.status).toBe(0);
    expect(String(parkedConfig.directive?.message)).toContain(
      "config-change --review none",
    );
  });

  test("routes that cannot apply --review reject it instead of discarding it", () => {
    const active = projectWithState();
    for (const args of [
      ["--stage", "requirements-analysis", "--review", "none"],
      ["--stage", "requirements-analysis", "--single", "--review", "none"],
      ["compose", "--review", "none"],
      ["--resume", "--review", "none"],
    ]) {
      const result = runOrchestrateNext(ORCHESTRATE, active, args);
      expect(result.status, args.join(" ")).toBe(0);
      expect(result.directive?.kind, args.join(" ")).toBe("error");
      expect(String(result.directive?.message), args.join(" ")).toContain(
        "Cannot combine --review",
      );
    }
  });

  test("bare --review rejects a missing value instead of retaining the prior policy", () => {
    const active = projectWithState();
    for (const args of [
      ["--review"],
      ["--review", "--resume"],
    ]) {
      const result = runOrchestrateNext(ORCHESTRATE, active, args);
      expect(result.status, args.join(" ")).toBe(0);
      expect(result.directive?.kind, args.join(" ")).toBe("error");
      expect(String(result.directive?.message), args.join(" ")).toContain(
        "--review requires <adversarial|advisory|none>",
      );
    }
  });

  test("intent-create and scope-change persist and audit --review", () => {
    const fresh = createTestProject();
    tempDirs.push(fresh);
    seedAidlcMemory(fresh);
    const born = runUtility(fresh, [
      "intent-create",
      "--scope",
      "feature",
      "--review",
      "none",
    ]);
    expect(born.status).toBe(0);
    expect(readFileSync(stateFilePath(fresh), "utf-8")).toContain(
      "- **Review Override**: none",
    );
    expect(readAllAuditShards(fresh)).toContain("**Review Override**: none");

    const active = projectWithState();
    const changed = runUtility(active, [
      "scope-change",
      "--scope",
      "feature",
      "--review",
      "none",
    ]);
    expect(changed.status).toBe(0);
    expect(readFileSync(stateFilePath(active), "utf-8")).toContain(
      "- **Review Override**: none",
    );
    expect(readAllAuditShards(active)).toContain(
      "**Event**: REVIEW_CLASS_CHANGED",
    );
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
