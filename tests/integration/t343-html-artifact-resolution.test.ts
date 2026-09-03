import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactFilename,
  readStateFile,
} from "../../core/tools/aidlc-lib.ts";
import { setHtmlArtifactNames } from "../../core/tools/aidlc-artifact-vocabulary.ts";
import { resolveArtifactInstances } from "../../core/tools/aidlc-artifact-resolution.ts";
import {
  cleanupTestProject,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const priorGraph = process.env.AIDLC_STAGE_GRAPH;
const graphDir = mkdtempSync(join(tmpdir(), "aidlc-t343-"));
const graphPath = join(graphDir, "stage-graph.json");
const shippedGraph = JSON.parse(readFileSync(join(
  import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "data", "stage-graph.json",
), "utf-8")) as Array<Record<string, unknown>>;
for (const stage of shippedGraph) {
  stage.html_capable = stage.slug === "intent-capture"
    ? ["intent-statement", "stakeholder-map"]
    : [];
}
writeFileSync(graphPath, `${JSON.stringify(shippedGraph, null, 2)}\n`);
process.env.AIDLC_STAGE_GRAPH = graphPath;
const projects: string[] = [];
afterAll(() => {
  setHtmlArtifactNames(new Set());
  for (const project of projects) cleanupTestProject(project);
  rmSync(graphDir, { recursive: true, force: true });
  if (priorGraph === undefined) delete process.env.AIDLC_STAGE_GRAPH;
  else process.env.AIDLC_STAGE_GRAPH = priorGraph;
});

function projectWithSetting(setting: "on" | "off"): string {
  const project = setupIntegrationProject({ withState: "state-mid-ideation.md" });
  projects.push(project);
  const path = seededStateFile(project);
  const content = readFileSync(path, "utf-8").replace(
    /^(- \*\*Test Strategy\*\*:[^\n]*)$/m,
    `$1\n- **HTML Artifacts**: ${setting}`,
  );
  writeFileSync(path, content);
  return project;
}

const owner = {
  slug: "intent-capture",
  phase: "ideation",
  produces: ["intent-statement", "intent-capture-questions"],
};

describe("state-locked artifact format resolution", () => {
  test("on resolves capable document to HTML and machine question form to Markdown", () => {
    const project = projectWithSetting("on");
    readStateFile(project);
    expect(artifactFilename("intent-statement")).toBe("intent-statement.html");
    expect(artifactFilename("intent-capture-questions")).toBe("intent-capture-questions.md");
    expect(resolveArtifactInstances(project, "intent-statement", owner)[0].relativePath)
      .toEndWith("/ideation/intent-capture/intent-statement.html");
  });

  test("off resolves both artifacts to Markdown", () => {
    const project = projectWithSetting("off");
    readStateFile(project);
    expect(artifactFilename("intent-statement")).toBe("intent-statement.md");
    expect(artifactFilename("intent-capture-questions")).toBe("intent-capture-questions.md");
  });

  test("stale Markdown beside expected HTML is never selected", () => {
    const project = projectWithSetting("on");
    const dir = join(seededRecordDir(project), "ideation", "intent-capture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intent-statement.md"), "stale\n");
    readStateFile(project);
    const instance = resolveArtifactInstances(project, "intent-statement", owner)[0];
    expect(instance.absolutePath).toBe(join(dir, "intent-statement.html"));
  });
});
