// covers: file:skills/aidlc/SKILL.md, file:aidlc-common/protocols/stage-protocol.md, file:aidlc-common/protocols/stage-protocol-recovery.md, file:aidlc-common/protocols/stage-protocol-governance.md, file:hooks/aidlc-write-audit-log.ts, file:hooks/aidlc-run-sensors.ts, file:hooks/aidlc-rebuild-stage-graph.ts, file:hooks/aidlc-sync-workflow-state.ts, file:hooks/aidlc-validate-state.ts, file:hooks/aidlc-log-subagent.ts, file:hooks/aidlc-record-human-turn.ts, file:hooks/aidlc-review-freeze.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-session-end.ts, file:hooks/aidlc-statusline.ts, file:hooks/aidlc-continue-workflow.ts, file:agents/aidlc-product-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-architect-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-quality-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-operations-agent.md, file:aidlc-common/stages/initialization/workspace-scaffold.md, file:aidlc-common/stages/initialization/workspace-detection.md, file:aidlc-common/stages/initialization/state-init.md, file:aidlc-common/stages/ideation/intent-capture.md, file:aidlc-common/stages/ideation/market-research.md, file:aidlc-common/stages/ideation/feasibility.md, file:aidlc-common/stages/ideation/scope-definition.md, file:aidlc-common/stages/ideation/team-formation.md, file:aidlc-common/stages/ideation/rough-mockups.md, file:aidlc-common/stages/ideation/approval-handoff.md, file:aidlc-common/stages/inception/reverse-engineering.md, file:aidlc-common/stages/inception/practices-discovery.md, file:aidlc-common/stages/inception/requirements-analysis.md, file:aidlc-common/stages/inception/user-stories.md, file:aidlc-common/stages/inception/refined-mockups.md, file:aidlc-common/stages/inception/domain-design.md, file:aidlc-common/stages/inception/contract-design.md, file:aidlc-common/stages/inception/units-generation.md, file:aidlc-common/stages/inception/delivery-planning.md, file:aidlc-common/stages/construction/functional-design.md, file:aidlc-common/stages/construction/nfr-requirements.md, file:aidlc-common/stages/construction/nfr-design.md, file:aidlc-common/stages/construction/infrastructure-design.md, file:aidlc-common/stages/construction/code-generation.md, file:aidlc-common/stages/construction/build-and-test.md, file:aidlc-common/stages/construction/ci-pipeline.md, file:aidlc-common/stages/operation/deployment-pipeline.md, file:aidlc-common/stages/operation/environment-provisioning.md, file:aidlc-common/stages/operation/deployment-execution.md, file:aidlc-common/stages/operation/observability-setup.md, file:aidlc-common/stages/operation/incident-response.md, file:aidlc-common/stages/operation/performance-validation.md, file:aidlc-common/stages/operation/feedback-optimization.md, file:settings.json, file:settings.local.json.example, file:knowledge/aidlc-shared/state-template.md, file:rules/aidlc-org.md, file:rules/aidlc-project.md, file:CLAUDE.md
//
// t01 - shipped-tree file-structure invariant.
//
// Mechanism: none. This is a pure structural check — does each shipped path
// exist on disk under the distributable .claude/ tree? No process boundary, no
// argv/exit/stdout seam, no LLM, zero tokens. We resolve the same tree the .sh
// resolved via the harness's AIDLC_SRC (= <repo>/dist/claude/.claude,
// fixtures.ts:42) and assert existsSync() in-process. AIDLC_SRC is the TS
// canonical for the .sh's `cd .../dist/claude/.claude && pwd` CLAUDE_DIR.
//
// Subject under test: the shipped layout of dist/claude/.claude/ — the bytes a
// user copies into their project's .claude/.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const at = (...parts: string[]): string => join(AIDLC_SRC, ...parts);

// The method ("memory") lives at the workspace root
// under aidlc/spaces/default/memory/ (one hand-editable source of truth, read
// by Claude via the .claude/rules/aidlc.md @-stub). It sits beside .claude/, so
// resolve it from AIDLC_SRC's parent (the dist/claude/ root).
const mem = (...parts: string[]): string =>
  join(AIDLC_SRC, "..", "aidlc", "spaces", "default", "memory", ...parts);

// The 14 agents (11 domain-expert personas + the two reviewer
// personas product-lead and architecture-reviewer + the adaptive-workflows
// composer), in roster order (SKILL.md / CLAUDE.md agent roster order).
const AGENTS = [
  "product",
  "design",
  "delivery",
  "architect",
  "aws-platform",
  "compliance",
  "devsecops",
  "developer",
  "quality",
  "pipeline-deploy",
  "operations",
  "product-lead",
  "architecture-reviewer",
  "composer",
] as const;

const HOOKS = [
  "aidlc-write-audit-log.ts",
  "aidlc-run-sensors.ts",
  "aidlc-rebuild-stage-graph.ts",
  "aidlc-sync-workflow-state.ts",
  "aidlc-validate-state.ts",
  "aidlc-log-subagent.ts",
  "aidlc-record-human-turn.ts",
  "aidlc-deliver-stage-rules.ts",
  "aidlc-plan-approval-guard.ts",
  "aidlc-state-transition-guard.ts",
  "aidlc-reviewer-scope.ts",
  "aidlc-review-freeze.ts",
  "aidlc-session-start.ts",
  "aidlc-session-end.ts",
  "aidlc-statusline.ts",
  "aidlc-continue-workflow.ts",
  "aidlc-fold-usage.ts",
] as const;

const STAGES: Record<string, readonly string[]> = {
  initialization: ["workspace-scaffold", "workspace-detection", "state-init"],
  ideation: [
    "intent-capture",
    "market-research",
    "feasibility",
    "scope-definition",
    "team-formation",
    "rough-mockups",
    "approval-handoff",
  ],
  inception: [
    "reverse-engineering",
    "practices-discovery",
    "requirements-analysis",
    "user-stories",
    "refined-mockups",
    "domain-design",
    "contract-design",
    "units-generation",
    "delivery-planning",
  ],
  construction: [
    "functional-design",
    "nfr-requirements",
    "nfr-design",
    "infrastructure-design",
    "code-generation",
    "build-and-test",
    "ci-pipeline",
  ],
  operation: [
    "deployment-pipeline",
    "environment-provisioning",
    "deployment-execution",
    "observability-setup",
    "incident-response",
    "performance-validation",
    "feedback-optimization",
  ],
};

describe("t01 — shipped-tree file-structure invariant (mechanism: none)", () => {
  test("ships the onboarding destination for every harness", () => {
    for (const harness of HARNESS_MATRIX) {
      expect(existsSync(harness.harnessOnboardingDist), harness.name).toBe(true);
    }
  });

  test("ships skills/aidlc/SKILL.md [.sh L12]", () => {
    expect(existsSync(at("skills", "aidlc", "SKILL.md"))).toBe(true);
  });

  test("ships the 7 stage-protocol files [.sh L15-17 + conditional modules]", () => {
    for (const f of [
      "stage-protocol.md",
      "stage-protocol-recovery.md",
      "stage-protocol-governance.md",
      "stage-protocol-reviewer.md",
      "stage-protocol-swarm.md",
      "stage-protocol-ensemble.md",
      "stage-protocol-construction.md",
    ]) {
      expect(existsSync(at("aidlc-common", "protocols", f))).toBe(true);
    }
  });

  test("ships each of the 17 framework hooks [.sh L20-29]", () => {
    for (const h of HOOKS) {
      expect(existsSync(at("hooks", h))).toBe(true);
    }
  });

  // Not just "each of these 17 exists" but "the hooks dir contains EXACTLY 17
  // aidlc-*.ts hooks" - catches an 18th hook sneaking in or a rename that drops
  // one while another covers the count.
  test("ships EXACTLY the 17 expected aidlc-*.ts hooks [.sh L20-29 — count strengthening]", () => {
    const shipped = readdirSync(at("hooks"))
      .filter((f) => f.startsWith("aidlc-") && f.endsWith(".ts"))
      .sort();
    expect(shipped).toEqual([...HOOKS].sort());
  });

  test("ships each of the 14 agent personas [.sh L32-34]", () => {
    for (const a of AGENTS) {
      expect(existsSync(at("agents", `aidlc-${a}-agent.md`))).toBe(true);
    }
  });

  // The agents dir holds EXACTLY 14 aidlc-*-agent.md files - pins the roster
  // size, not only the named members.
  test("ships EXACTLY 14 aidlc-*-agent.md files [.sh L32-34 — count strengthening]", () => {
    const shipped = readdirSync(at("agents")).filter(
      (f) => f.startsWith("aidlc-") && f.endsWith("-agent.md"),
    );
    expect(shipped.length).toBe(14);
    const expected = AGENTS.map((a) => `aidlc-${a}-agent.md`).sort();
    expect(shipped.sort()).toEqual(expected);
  });

  test("ships the 3 initialization stages [.sh L38-40]", () => {
    for (const s of STAGES.initialization) {
      expect(existsSync(at("aidlc-common", "stages", "initialization", `${s}.md`))).toBe(
        true,
      );
    }
  });

  test("ships the 7 ideation stages [.sh L43-45]", () => {
    for (const s of STAGES.ideation) {
      expect(existsSync(at("aidlc-common", "stages", "ideation", `${s}.md`))).toBe(true);
    }
  });

  test("ships the 8 inception stages [.sh L48-50]", () => {
    for (const s of STAGES.inception) {
      expect(existsSync(at("aidlc-common", "stages", "inception", `${s}.md`))).toBe(true);
    }
  });

  test("ships the 7 construction stages [.sh L53-55]", () => {
    for (const s of STAGES.construction) {
      expect(existsSync(at("aidlc-common", "stages", "construction", `${s}.md`))).toBe(
        true,
      );
    }
  });

  test("ships the 7 operation stages [.sh L58-60]", () => {
    for (const s of STAGES.operation) {
      expect(existsSync(at("aidlc-common", "stages", "operation", `${s}.md`))).toBe(true);
    }
  });

  // The 5 phase dirs together hold EXACTLY 33 .md stage files, and each phase dir
  // holds exactly its expected count. This also pins that no extra stage file
  // ships.
  test("ships EXACTLY 33 stage files across the 5 phases [.sh all stages — count strengthening]", () => {
    let total = 0;
    for (const [phase, stages] of Object.entries(STAGES)) {
      const dir = at("aidlc-common", "stages", phase);
      const shipped = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      expect(shipped).toEqual([...stages].map((s) => `${s}.md`).sort());
      total += shipped.length;
    }
    expect(total).toBe(33);
  });

  test("ships settings.json and settings.local.json.example [.sh L63-64]", () => {
    expect(existsSync(at("settings.json"))).toBe(true);
    expect(existsSync(at("settings.local.json.example"))).toBe(true);
  });

  test("ships knowledge/aidlc-shared/state-template.md [.sh L67]", () => {
    expect(existsSync(at("knowledge", "aidlc-shared", "state-template.md"))).toBe(true);
  });

  test("ships the org and project method layers at aidlc/spaces/default/memory/ [.sh L70-71]", () => {
    // The method lives at the workspace-root
    // aidlc/spaces/default/memory/{org,project}.md (neutral names, one hand-editable
    // copy). The harness reads it via the .claude/rules/aidlc.md @-stub.
    expect(existsSync(mem("org.md"))).toBe(true);
    expect(existsSync(mem("project.md"))).toBe(true);
    expect(existsSync(at("rules", "aidlc.md"))).toBe(true);
  });

  test("ships the user-facing CLAUDE.md [.sh L74]", () => {
    expect(existsSync(at("CLAUDE.md"))).toBe(true);
  });

  // Re-drive the HOOKS / AGENTS / STAGES data the tests above drive and pin its
  // length, so the suite cannot silently shrink the structural surface.
  test("asserts EXACTLY 78 shipped paths (prior 74 + 4 conditional protocol modules) [.sh L9]", () => {
    const paths: string[] = [
      at("skills", "aidlc", "SKILL.md"),
      at("aidlc-common", "protocols", "stage-protocol.md"),
      at("aidlc-common", "protocols", "stage-protocol-recovery.md"),
      at("aidlc-common", "protocols", "stage-protocol-governance.md"),
      at("aidlc-common", "protocols", "stage-protocol-reviewer.md"),
      at("aidlc-common", "protocols", "stage-protocol-swarm.md"),
      at("aidlc-common", "protocols", "stage-protocol-ensemble.md"),
      at("aidlc-common", "protocols", "stage-protocol-construction.md"),
      ...HOOKS.map((h) => at("hooks", h)),
      ...AGENTS.map((a) => at("agents", `aidlc-${a}-agent.md`)),
      ...Object.entries(STAGES).flatMap(([phase, stages]) =>
        stages.map((s) => at("aidlc-common", "stages", phase, `${s}.md`)),
      ),
      at("settings.json"),
      at("settings.local.json.example"),
      at("knowledge", "aidlc-shared", "state-template.md"),
      mem("org.md"),
      mem("project.md"),
      at("CLAUDE.md"),
    ];
    expect(paths.length).toBe(78);
    // Every one of the 78 must exist - checked as a single set so the count and
    // the existence checks cannot drift apart.
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
    }
  });
});
