// covers: file:skills/aidlc/SKILL.md, file:aidlc-common/protocols/stage-protocol.md, file:aidlc-common/protocols/stage-protocol-recovery.md, file:aidlc-common/protocols/stage-protocol-governance.md, file:hooks/aidlc-audit-logger.ts, file:hooks/aidlc-sensor-fire.ts, file:hooks/aidlc-runtime-compile.ts, file:hooks/aidlc-sync-statusline.ts, file:hooks/aidlc-validate-state.ts, file:hooks/aidlc-log-subagent.ts, file:hooks/aidlc-mint-presence.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-session-end.ts, file:hooks/aidlc-statusline.ts, file:hooks/aidlc-stop.ts, file:agents/aidlc-product-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-architect-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-quality-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-operations-agent.md, file:aidlc-common/stages/initialization/workspace-scaffold.md, file:aidlc-common/stages/initialization/workspace-detection.md, file:aidlc-common/stages/initialization/state-init.md, file:aidlc-common/stages/ideation/intent-capture.md, file:aidlc-common/stages/ideation/market-research.md, file:aidlc-common/stages/ideation/feasibility.md, file:aidlc-common/stages/ideation/scope-definition.md, file:aidlc-common/stages/ideation/team-formation.md, file:aidlc-common/stages/ideation/rough-mockups.md, file:aidlc-common/stages/ideation/approval-handoff.md, file:aidlc-common/stages/inception/reverse-engineering.md, file:aidlc-common/stages/inception/practices-discovery.md, file:aidlc-common/stages/inception/requirements-analysis.md, file:aidlc-common/stages/inception/user-stories.md, file:aidlc-common/stages/inception/refined-mockups.md, file:aidlc-common/stages/inception/application-design.md, file:aidlc-common/stages/inception/units-generation.md, file:aidlc-common/stages/inception/delivery-planning.md, file:aidlc-common/stages/construction/functional-design.md, file:aidlc-common/stages/construction/nfr-requirements.md, file:aidlc-common/stages/construction/nfr-design.md, file:aidlc-common/stages/construction/infrastructure-design.md, file:aidlc-common/stages/construction/code-generation.md, file:aidlc-common/stages/construction/build-and-test.md, file:aidlc-common/stages/construction/ci-pipeline.md, file:aidlc-common/stages/operation/deployment-pipeline.md, file:aidlc-common/stages/operation/environment-provisioning.md, file:aidlc-common/stages/operation/deployment-execution.md, file:aidlc-common/stages/operation/observability-setup.md, file:aidlc-common/stages/operation/incident-response.md, file:aidlc-common/stages/operation/performance-validation.md, file:aidlc-common/stages/operation/feedback-optimization.md, file:settings.json, file:settings.local.json.example, file:knowledge/aidlc-shared/state-template.md, file:rules/aidlc-org.md, file:rules/aidlc-project.md, file:CLAUDE.md
//
// t01 — shipped-tree file-structure invariant. Migrated from
// tests/smoke/t01-file-structure.sh (TAP plan 63, 63 distinct file-existence
// assertions). The .sh resolved CLAUDE_DIR = dist/claude/.claude and ran
// assert_file_exists on each of the 63 paths the framework ships.
//
// Mechanism: none. This is a pure structural check — does each shipped path
// exist on disk under the distributable .claude/ tree? No process boundary, no
// argv/exit/stdout seam, no LLM, zero tokens. We resolve the same tree the .sh
// resolved via the harness's AIDLC_SRC (= <repo>/dist/claude/.claude,
// fixtures.ts:42) and assert existsSync() in-process. AIDLC_SRC is the TS
// canonical for the .sh's `cd .../dist/claude/.claude && pwd` CLAUDE_DIR.
//
// Subject under test: the shipped layout of dist/claude/.claude/ — the bytes a
// user copies into their project's .claude/. Verified present on disk this
// session (every path below `ls`-confirmed against the worktree's dist tree).
//
// Old TAP -> new test parity (1:1, every .sh assertion preserved; counts are
// STRONGER than the .sh, which only existence-checked each path individually):
//   .sh L12  SKILL.md exists                          -> "ships skills/aidlc/SKILL.md"
//   .sh L15-17  3 stage-protocol files                -> "ships the 3 stage-protocol spine files" (each asserted)
//   .sh L20-29  11 hooks (each)                        -> "ships each of the 13 framework hooks" + exact-set strengthening
//   .sh L32-34  11 agents (loop)                       -> "ships each of the 14 agent personas" + "ships EXACTLY 14 aidlc-*-agent.md files" (count strengthening; roster grew to 13 with the two reviewer personas, then 14 with the composer)
//   .sh L38-40  3 initialization stages (loop)         -> "ships the 3 initialization stages"
//   .sh L43-45  7 ideation stages (loop)               -> "ships the 7 ideation stages"
//   .sh L48-50  8 inception stages (loop)              -> "ships the 8 inception stages"
//   .sh L53-55  7 construction stages (loop)           -> "ships the 7 construction stages"
//   .sh L58-60  7 operation stages (loop)              -> "ships the 7 operation stages"
//   .sh (all stages)                                   -> "ships EXACTLY 32 stage files across the 5 phases" (count strengthening)
//   .sh L63-64  settings.json + settings.local.json.example -> "ships settings.json and settings.local.json.example"
//   .sh L67  state-template.md                          -> "ships knowledge/aidlc-shared/state-template.md"
//   .sh L70-71  org + project rules                     -> "ships the org and project rule layers"
//   .sh L74  CLAUDE.md                                  -> "ships the user-facing CLAUDE.md"
//   .sh L9   plan 63                                    -> "asserts EXACTLY 63 shipped paths (TAP plan parity)" (re-counts the path list and pins 63)

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same tree the .sh resolved as
// CLAUDE_DIR. Resolve every shipped path relative to it.
const at = (...parts: string[]): string => join(AIDLC_SRC, ...parts);

// The method ("memory") relocated OUT of the harness dir to the workspace root
// under aidlc/spaces/default/memory/ (one hand-editable source of truth, read
// by Claude via the .claude/rules/aidlc.md @-stub). It sits beside .claude/, so
// resolve it from AIDLC_SRC's parent (the dist/claude/ root).
const mem = (...parts: string[]): string =>
  join(AIDLC_SRC, "..", "aidlc", "spaces", "default", "memory", ...parts);

// The 14 agents (11 original domain-expert personas + the two reviewer
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

// The 10 framework hooks, exactly as the .sh listed them.
const HOOKS = [
  "aidlc-audit-logger.ts",
  "aidlc-sensor-fire.ts",
  "aidlc-runtime-compile.ts",
  "aidlc-sync-statusline.ts",
  "aidlc-validate-state.ts",
  "aidlc-log-subagent.ts",
  "aidlc-mint-presence.ts",
  "aidlc-state-transition-guard.ts",
  "aidlc-reviewer-scope.ts",
  "aidlc-session-start.ts",
  "aidlc-session-end.ts",
  "aidlc-statusline.ts",
  "aidlc-stop.ts",
] as const;

// The 32 stage files, partitioned by phase exactly as the .sh's per-phase loops
// did (3 + 7 + 8 + 7 + 7 = 32).
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
    "application-design",
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
  test("ships skills/aidlc/SKILL.md [.sh L12]", () => {
    expect(existsSync(at("skills", "aidlc", "SKILL.md"))).toBe(true);
  });

  test("ships the 3 stage-protocol spine files [.sh L15-17]", () => {
    for (const f of [
      "stage-protocol.md",
      "stage-protocol-recovery.md",
      "stage-protocol-governance.md",
    ]) {
      expect(existsSync(at("aidlc-common", "protocols", f))).toBe(true);
    }
  });

  test("ships each of the 13 framework hooks [.sh L20-29]", () => {
    for (const h of HOOKS) {
      expect(existsSync(at("hooks", h))).toBe(true);
    }
  });

  // STRONGER than the .sh: not just "each of these 13 exists" but "the hooks
  // dir contains EXACTLY 13 aidlc-*.ts hooks" — catches a 14th hook sneaking
  // in or a rename that drops one while another covers the count.
  test("ships EXACTLY the 13 expected aidlc-*.ts hooks [.sh L20-29 — count strengthening]", () => {
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

  // STRONGER than the .sh: the agents dir holds EXACTLY 14 aidlc-*-agent.md
  // files — pins the roster size, not only the named members.
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

  // STRONGER: the 5 phase dirs together hold EXACTLY 32 .md stage files, and
  // each phase dir holds exactly its expected count. The .sh's per-phase loops
  // asserted membership; this also pins that no extra stage file ships.
  test("ships EXACTLY 32 stage files across the 5 phases [.sh all stages — count strengthening]", () => {
    let total = 0;
    for (const [phase, stages] of Object.entries(STAGES)) {
      const dir = at("aidlc-common", "stages", phase);
      const shipped = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      expect(shipped).toEqual([...stages].map((s) => `${s}.md`).sort());
      total += shipped.length;
    }
    expect(total).toBe(32);
  });

  test("ships settings.json and settings.local.json.example [.sh L63-64]", () => {
    expect(existsSync(at("settings.json"))).toBe(true);
    expect(existsSync(at("settings.local.json.example"))).toBe(true);
  });

  test("ships knowledge/aidlc-shared/state-template.md [.sh L67]", () => {
    expect(existsSync(at("knowledge", "aidlc-shared", "state-template.md"))).toBe(true);
  });

  test("ships the org and project method layers at aidlc/spaces/default/memory/ [.sh L70-71]", () => {
    // The method relocated from .claude/rules/aidlc-{org,project}.md to the
    // workspace-root aidlc/spaces/default/memory/{org,project}.md (neutral names,
    // one hand-editable copy). The harness reads it via the .claude/rules/aidlc.md
    // @-stub, which ships in its place.
    expect(existsSync(mem("org.md"))).toBe(true);
    expect(existsSync(mem("project.md"))).toBe(true);
    expect(existsSync(at("rules", "aidlc.md"))).toBe(true);
  });

  test("ships the user-facing CLAUDE.md [.sh L74]", () => {
    expect(existsSync(at("CLAUDE.md"))).toBe(true);
  });

  // TAP-plan parity guard: the .sh declared `plan 63` and made 63
  // assert_file_exists calls. The roster later grew by two reviewer agent
  // personas (product-lead, architecture-reviewer) to 65, then by the
  // human-turn mint hook to 66, then by the composer persona to 67, then by
  // the reviewer-scope hook to 68, then the state-transition guard to 69.
  // data the loops drove and pin its length, so the migrated suite cannot
  // silently shrink the structural surface the .sh enforced.
  test("asserts EXACTLY 69 shipped paths (TAP plan 63 + 2 reviewer agents + 3 hooks + the composer) [.sh L9]", () => {
    const paths: string[] = [
      at("skills", "aidlc", "SKILL.md"), // 1
      at("aidlc-common", "protocols", "stage-protocol.md"), // 2
      at("aidlc-common", "protocols", "stage-protocol-recovery.md"), // 3
      at("aidlc-common", "protocols", "stage-protocol-governance.md"), // 4
      ...HOOKS.map((h) => at("hooks", h)), // 5-17 (13)
      ...AGENTS.map((a) => at("agents", `aidlc-${a}-agent.md`)), // 16-29 (14)
      ...Object.entries(STAGES).flatMap(([phase, stages]) =>
        stages.map((s) => at("aidlc-common", "stages", phase, `${s}.md`)),
      ), // 30-61 (32)
      at("settings.json"), // 62
      at("settings.local.json.example"), // 63
      at("knowledge", "aidlc-shared", "state-template.md"), // 64
      mem("org.md"), // 65 — method relocated to aidlc/spaces/default/memory/
      mem("project.md"), // 66
      at("CLAUDE.md"), // 67
    ];
    expect(paths.length).toBe(69);
    // Every one of the 69 must exist — the .sh's full TAP plan, re-proven as a
    // single set so the count and the existence checks cannot drift apart.
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
    }
  });
});
