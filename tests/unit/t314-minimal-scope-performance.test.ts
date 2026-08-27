// covers: function:selectShippedInlineKnowledge
// covers: function:inlineContextRoster
// covers: function:buildRunStageDirective
// covers: file:aidlc-common/stages/inception/reverse-engineering.md
//
// Deterministic regression for the minimal-scope performance contract. The
// optimized path keeps the same agents, receipts, artifacts, and gates; it
// removes unrelated shipped context, duplicate conductor scans, and
// in-context scan-body transport.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  runOrchestrateNext,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

function authored(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop());
});

function directive(
  scope: string,
  stage: string,
  withState?: string,
): Record<string, unknown> {
  const proj = setupIntegrationProject(
    withState ? { withState } : {},
  );
  projects.push(proj);
  const result = runOrchestrateNext(
    ORCH,
    proj,
    withState ? [] : ["--scope", scope, "--stage", stage],
    { env: { ...process.env } },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.directive?.kind).toBe("run-stage");
  return { ...result.directive, projectDir: proj };
}

function contextBytes(
  projectDir: string,
  paths: string[],
): number {
  return paths.reduce(
    (total, path) =>
      total + statSync(join(projectDir, ...path.split("/"))).size,
    0,
  );
}

describe("t314 minimal-scope dispatch and handoff budget", () => {
  test("Minimal context rosters are exact and byte-bounded", () => {
    const intent = directive("poc", "intent-capture");
    const intentPaths = intent.inline_context_paths as string[];
    expect(intentPaths).toEqual([
      ".claude/agents/aidlc-product-agent.md",
      ".claude/agents/aidlc-architect-agent.md",
      ".claude/knowledge/aidlc-shared/ai-dlc-principles.md",
      ".claude/knowledge/aidlc-shared/rules-reading.md",
      ".claude/knowledge/aidlc-shared/verification.md",
      ".claude/knowledge/aidlc-product-agent/requirements-elicitation.md",
      ".claude/knowledge/aidlc-product-agent/requirements-guide.md",
      ".claude/knowledge/aidlc-architect-agent/architecture-guide.md",
    ]);
    expect(
      contextBytes(intent.projectDir as string, intentPaths),
    ).toBeLessThanOrEqual(50_000);

    const requirements = directive("bugfix", "requirements-analysis");
    const requirementPaths = requirements.inline_context_paths as string[];
    expect(requirementPaths).toEqual([
      ".claude/agents/aidlc-product-agent.md",
      ".claude/knowledge/aidlc-shared/ai-dlc-principles.md",
      ".claude/knowledge/aidlc-shared/brownfield.md",
      ".claude/knowledge/aidlc-shared/rules-reading.md",
      ".claude/knowledge/aidlc-shared/verification.md",
      ".claude/knowledge/aidlc-product-agent/requirements-elicitation.md",
      ".claude/knowledge/aidlc-product-agent/requirements-guide.md",
    ]);
    expect(
      contextBytes(requirements.projectDir as string, requirementPaths),
    ).toBeLessThanOrEqual(40_000);
  });

  test("Standard context remains full and pipeline dispatch count stays two", () => {
    const standard = directive("mvp", "intent-capture");
    const standardPaths = standard.inline_context_paths as string[];
    expect(standardPaths.length).toBeGreaterThan(20);
    expect(
      contextBytes(standard.projectDir as string, standardPaths),
    ).toBeGreaterThan(100_000);

    const pipeline = directive(
      "bugfix",
      "reverse-engineering",
      "state-brownfield-init-done.md",
    );
    expect(pipeline.mode).toBe("pipeline");
    expect(pipeline.pipeline).toEqual({
      links: ["aidlc-developer-agent", "aidlc-architect-agent"],
      completed: [],
    });
  });

  test("Reverse Engineering preserves two-link authority with a file-backed handoff", () => {
    const stage = authored(
      "core/aidlc-common/stages/inception/reverse-engineering.md",
    );
    const template = authored(
      "core/knowledge/aidlc-developer-agent/re-artifacts.md",
    );

    expect(stage).toContain("mode: pipeline");
    expect(stage).toContain("aidlc-developer-agent");
    expect(stage).toContain("aidlc-architect-agent");
    expect(stage).toContain("developer-scan.md");
    expect(stage).toContain("developer-scan-<repo>.md");
    expect(stage).toContain("## Handoff Summary");
    expect(stage).toContain("does NOT inspect application");
    expect(stage).toContain("does not repeat the scan body");
    expect(stage).toContain("all nine artifacts");
    expect(stage).toContain("not an output-length cap");
    expect(template).toContain("## Handoff Summary");
    expect(template.match(/^## /gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("subagent summaries carry decisions and paths, not duplicate artifact bodies", () => {
    const ensemble = authored(
      "core/aidlc-common/protocols/stage-protocol-ensemble.md",
    );

    expect(ensemble).toContain("The files are the substantive handoff");
    expect(ensemble).toContain("does not repeat artifact");
    expect(ensemble).toContain("Issues / Concerns");
    expect(ensemble).toContain("Produced");
  });

  test("recorded Windows benchmark improves while preserving quality counts", () => {
    const benchmark = JSON.parse(
      authored(
        "tests/fixtures/minimal-scope-performance/windows-reverse-engineering.json",
      ),
    ) as {
      after: {
        elapsed_seconds: number;
        output_tokens: number;
        agent_dispatches: number;
        bash_calls: number;
        read_calls: number;
        conductor_source_discovery_calls: number;
        cost_usd: number;
      };
      before: {
        elapsed_seconds: number;
        output_tokens: number;
        agent_dispatches: number;
        bash_calls: number;
        read_calls: number;
        conductor_source_discovery_calls: number;
        cost_usd: number;
      };
      invariants: {
        pipeline_links_before: number;
        pipeline_links_after: number;
        codekb_artifacts_before: number;
        codekb_artifacts_after: number;
        codekb_bytes_before: number;
        codekb_bytes_after: number;
        handoff_h2_sections_after: number;
        handoff_sensor_pass_after: boolean;
        digest_bound_receipt_after: boolean;
        approval_gate_pass_after: boolean;
        stage_validation_artifacts_after: number;
        cost_regression_acknowledged: boolean;
      };
    };
    expect(benchmark.after.elapsed_seconds).toBeLessThan(
      benchmark.before.elapsed_seconds,
    );
    expect(benchmark.after.output_tokens).toBeLessThan(
      benchmark.before.output_tokens,
    );
    expect(benchmark.after.agent_dispatches).toBe(
      benchmark.before.agent_dispatches,
    );
    expect(benchmark.after.agent_dispatches).toBe(2);
    expect(benchmark.after.bash_calls).toBeLessThan(
      benchmark.before.bash_calls,
    );
    expect(benchmark.after.read_calls).toBeLessThan(
      benchmark.before.read_calls,
    );
    expect(benchmark.after.conductor_source_discovery_calls).toBe(0);
    expect(benchmark.before.conductor_source_discovery_calls).toBe(1);
    expect(benchmark.invariants.pipeline_links_after).toBe(
      benchmark.invariants.pipeline_links_before,
    );
    expect(benchmark.invariants.codekb_artifacts_after).toBe(
      benchmark.invariants.codekb_artifacts_before,
    );
    expect(benchmark.invariants.codekb_bytes_after).toBeGreaterThan(0);
    expect(benchmark.invariants.handoff_h2_sections_after).toBeGreaterThanOrEqual(
      2,
    );
    expect(benchmark.invariants.handoff_sensor_pass_after).toBe(true);
    expect(benchmark.invariants.digest_bound_receipt_after).toBe(true);
    expect(benchmark.invariants.approval_gate_pass_after).toBe(true);
    expect(benchmark.invariants.stage_validation_artifacts_after).toBe(9);
    expect(benchmark.after.cost_usd).toBeGreaterThan(
      benchmark.before.cost_usd,
    );
    expect(benchmark.invariants.cost_regression_acknowledged).toBe(true);
  });
});
