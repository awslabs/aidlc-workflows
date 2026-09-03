import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetGraphCache, compileStageGraph } from "../../core/tools/aidlc-graph.ts";
import { _resetStageGraphForTests } from "../../core/tools/aidlc-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DIST = join(ROOT, "dist", "claude", ".claude");
const ENV = {
  AIDLC_STAGE_GRAPH: join(DIST, "tools", "data", "stage-graph.json"),
  AIDLC_SCOPE_GRID: join(DIST, "tools", "data", "scope-grid.json"),
  AIDLC_SCOPES_DIR: join(ROOT, "core", "scopes"),
  AIDLC_AGENTS_DIR: join(ROOT, "core", "agents"),
  AIDLC_STAGES_DIR: join(ROOT, "core", "aidlc-common", "stages"),
  AIDLC_RULES_DIR: join(ROOT, "core", "memory-seed"),
  AIDLC_SENSORS_DIR: join(ROOT, "core", "sensors"),
};
const prior = new Map<string, string | undefined>();
const tempDirs: string[] = [];

function reset(): void {
  _resetStageGraphForTests();
  __resetGraphCache();
}

for (const [key, value] of Object.entries(ENV)) {
  prior.set(key, process.env[key]);
  process.env[key] = value;
}
reset();

afterEach(() => {
  process.env.AIDLC_STAGES_DIR = ENV.AIDLC_STAGES_DIR;
  process.env.AIDLC_STAGE_GRAPH = ENV.AIDLC_STAGE_GRAPH;
  reset();
});

process.on("exit", () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of prior) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixtureStage(slug: string, produces: string, extra = ""): string {
  return `---\nslug: ${slug}\nphase: ideation\nexecution: ALWAYS\ncondition: Always.\nlead_agent: aidlc-product-agent\nsupport_agents: []\nmode: inline\nproduces: [${produces}]\nconsumes: []\nrequires_stage: []\nscopes: []\n${extra}inputs: none\noutputs: output\n---\n# Fixture\n`;
}

function fixtureCompile(stage: string) {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t341-"));
  tempDirs.push(dir);
  const stages = join(dir, "stages");
  mkdirSync(join(stages, "ideation"), { recursive: true });
  writeFileSync(join(stages, "ideation", "fixture.md"), stage);
  const graphPath = join(dir, "stage-graph.json");
  writeFileSync(graphPath, "[]\n");
  process.env.AIDLC_STAGES_DIR = stages;
  process.env.AIDLC_STAGE_GRAPH = graphPath;
  reset();
  return compileStageGraph();
}

describe("compiled HTML capabilities", () => {
  test("real graph marks eligible prose and excludes construction and questions", () => {
    const stages = compileStageGraph().stages;
    expect(stages.every((stage) => Array.isArray(stage.html_capable))).toBe(true);
    expect(stages.find((stage) => stage.slug === "intent-capture")?.html_capable).toEqual([
      "intent-statement",
      "stakeholder-map",
    ]);
    expect(stages.find((stage) => stage.slug === "requirements-analysis")?.html_capable).toEqual([
      "requirements",
    ]);
    expect(stages.filter((stage) => stage.phase === "construction").every((stage) => stage.html_capable.length === 0)).toBe(true);
    expect(stages.flatMap((stage) => stage.html_capable).some((name) => name.endsWith("-questions"))).toBe(false);
  });

  test("eligible core artifact without a classification fails closed", () => {
    expect(() => fixtureCompile(fixtureStage("fixture", "unclassified-output"))).toThrow(
      'unclassified artifact "unclassified-output" produced by fixture: add it to ARTIFACT_KIND in core/tools/aidlc-artifact-vocabulary.ts',
    );
  });

  test("html_exclude removes an otherwise capable artifact", () => {
    const result = fixtureCompile(
      fixtureStage("fixture", "intent-statement, stakeholder-map", "html_exclude: [stakeholder-map]\n"),
    );
    expect(result.stages[0].html_capable).toEqual(["intent-statement"]);
  });
});
