// covers: function:shippedInlineContextEntries
// covers: function:inlineContextRoster
// covers: file:knowledge/aidlc-shared/audit-format.md
// covers: file:knowledge/aidlc-shared/worktree-info-schema.md
// covers: file:knowledge/aidlc-shared/state-template.md
// covers: file:knowledge/aidlc-shared/memory-template.md
// covers: file:knowledge/aidlc-shared/knowledge-readme-template.md
//
// The inline roster a run-stage hands the agent carries the shared methodology,
// not the reference docs for formats the engine itself writes (the audit
// taxonomy, the worktree info schema, the state, memory and knowledge README
// templates). Those docs still ship, and each place that needs one names it by
// path, so the agent reads it there and only there.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shippedInlineContextEntries } from "../../core/tools/aidlc-inline-context.ts";
import type { GraphStage } from "../../core/tools/aidlc-graph.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  runOrchestrateNext,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const FORMAT_DOCS = [
  "audit-format.md",
  "worktree-info-schema.md",
  "state-template.md",
  "memory-template.md",
  "knowledge-readme-template.md",
] as const;

const METHODOLOGY = [
  "ai-dlc-principles.md",
  "brownfield.md",
  "rules-reading.md",
  "verification.md",
] as const;

const TREES: ReadonlyArray<readonly [string, string]> = [
  ["claude", ".claude"],
  ["kiro", ".kiro"],
  ["kiro-ide", ".kiro"],
  ["codex", ".codex"],
  ["cursor", ".cursor"],
  ["opencode", ".aidlc"],
  ["copilot", ".aidlc"],
];

const SHARED = "knowledge/aidlc-shared";

function authored(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

function graphStages(): GraphStage[] {
  return JSON.parse(
    readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8"),
  ) as GraphStage[];
}

function formatDocsIn(paths: string[]): string[] {
  return paths.filter((path) =>
    FORMAT_DOCS.some((doc) => path.endsWith(`/${SHARED}/${doc}`)),
  );
}

const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop());
});

describe("t-inline-roster-format-docs", () => {
  test("no stage's inline roster carries a format doc, at any depth", () => {
    const stages = graphStages();
    const carrying: string[] = [];
    let rosters = 0;
    for (const stage of stages) {
      for (const depth of [null, "Minimal", "Standard", "Comprehensive"]) {
        const supportsOn = shippedInlineContextEntries(stage, AIDLC_SRC, ".claude", [], depth);
        if (supportsOn.length === 0) continue;
        rosters++;
        for (const path of formatDocsIn(supportsOn.map((entry) => entry.rel))) {
          carrying.push(`${stage.slug} (${depth ?? "no depth"}): ${path}`);
        }
      }
    }
    // The graph has inline and mob stages, so the loop checked real rosters.
    expect(rosters).toBeGreaterThan(20);
    expect(carrying).toEqual([]);
  });

  test("a Standard roster keeps the shared methodology files", () => {
    const stage = graphStages().find((node) => node.slug === "functional-design");
    expect(stage).toBeDefined();
    const paths = shippedInlineContextEntries(stage!, AIDLC_SRC, ".claude", [], "Standard")
      .map((entry) => entry.rel);
    for (const doc of METHODOLOGY) {
      expect(paths).toContain(`.claude/${SHARED}/${doc}`);
    }
    expect(paths).toContain(".claude/agents/aidlc-architect-agent.md");
  });

  test("a run-stage directive names no format doc in inline_context_paths", () => {
    const proj = setupIntegrationProject({});
    projects.push(proj);
    const result = runOrchestrateNext(
      join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"),
      proj,
      ["--scope", "feature", "--stage", "requirements-analysis"],
      { env: { ...process.env } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.directive?.kind).toBe("run-stage");
    const paths = result.directive?.inline_context_paths as string[];
    expect(paths.length).toBeGreaterThan(0);
    expect(formatDocsIn(paths)).toEqual([]);
    for (const doc of METHODOLOGY) {
      expect(paths).toContain(`.claude/${SHARED}/${doc}`);
    }
  });

  test("every format doc still ships in every tree", () => {
    const missing: string[] = [];
    for (const [tree, dir] of TREES) {
      for (const doc of FORMAT_DOCS) {
        const path = join("dist", tree, dir, SHARED, doc);
        if (!existsSync(join(REPO_ROOT, path))) missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });

  test("each place that uses a format doc names it by path", () => {
    const token = `{{HARNESS_DIR}}/${SHARED}`;
    const link = `../../${SHARED}`;
    const uses: ReadonlyArray<readonly [string, string]> = [
      ...TREES.map(([tree]) =>
        [`harness/${tree}/skills/aidlc/SKILL.md`, `${token}/audit-format.md`] as const
      ),
      ["harness/claude/skills/aidlc/question-rendering.md", `${token}/worktree-info-schema.md`],
      ["core/aidlc-common/protocols/stage-protocol-construction.md", `${link}/worktree-info-schema.md`],
      ["core/aidlc-common/protocols/stage-protocol-swarm.md", `${link}/worktree-info-schema.md`],
      ["core/aidlc-common/protocols/stage-protocol.md", `${link}/worktree-info-schema.md`],
      ["core/aidlc-common/stages/initialization/state-init.md", `${token}/state-template.md`],
      ["core/aidlc-common/conductor.md", `${token}/memory-template.md`],
      // A team copies the README template by hand; the knowledge reference says where it is.
      ["docs/reference/10-knowledge-system.md", `.claude/${SHARED}/knowledge-readme-template.md`],
    ];
    const unnamed = uses
      .filter(([file, path]) => !authored(file).includes(path))
      .map(([file, path]) => `${file} does not name ${path}`);
    expect(unnamed).toEqual([]);
    // The engine seeds a stage diary from the memory template by its own path.
    expect(authored("core/tools/aidlc-orchestrate.ts")).toContain('"memory-template.md"');
  });
});
