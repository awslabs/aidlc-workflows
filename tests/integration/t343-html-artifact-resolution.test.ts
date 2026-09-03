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

  test("two intents in one process resolve independently when each call carries its own state", () => {
    const on = projectWithSetting("on");
    const off = projectWithSetting("off");
    const onState = readFileSync(seededStateFile(on), "utf-8");
    const offState = readFileSync(seededStateFile(off), "utf-8");
    // Prime with the `on` intent, then resolve the `off` intent with ITS state:
    // the per-call priming must win over whatever was primed last.
    readStateFile(on);
    expect(resolveArtifactInstances(off, "intent-statement", owner, { stateContent: offState })[0].relativePath)
      .toEndWith("/ideation/intent-capture/intent-statement.md");
    expect(resolveArtifactInstances(on, "intent-statement", owner, { stateContent: onState })[0].relativePath)
      .toEndWith("/ideation/intent-capture/intent-statement.html");
    // And the reverse order.
    readStateFile(off);
    expect(resolveArtifactInstances(on, "intent-statement", owner, { stateContent: onState })[0].relativePath)
      .toEndWith("/ideation/intent-capture/intent-statement.html");
  });

  test("the gate refuses an HTML artifact that exists only as a Markdown twin", () => {
    const project = projectWithSetting("on");
    const dir = join(seededRecordDir(project), "ideation", "intent-capture");
    mkdirSync(dir, { recursive: true });
    // The agent followed the prose (`intent-statement.md`) instead of the directive.
    writeFileSync(join(dir, "intent-statement.md"), "# Intent\n\n## Problem\n\nx\n");
    writeFileSync(join(dir, "stakeholder-map.html"), "<!doctype html><html lang=\"en\"><body></body></html>\n");
    writeFileSync(join(dir, "intent-capture-questions.md"), "## Q1: x\n\nA. a\nX. Other\n\n[Answer]: A\n");
    const env = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const state = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "aidlc-state.ts");
    Bun.spawnSync({ cmd: [process.execPath, state, "checkbox", "intent-capture=in-progress", "--project-dir", project], env, stdout: "pipe", stderr: "pipe" });
    const gate = Bun.spawnSync({ cmd: [process.execPath, state, "gate-start", "intent-capture", "--project-dir", project], env, stdout: "pipe", stderr: "pipe" });
    const output = new TextDecoder().decode(gate.stdout) + new TextDecoder().decode(gate.stderr);
    expect(gate.exitCode, output).toBe(1);
    expect(output).toContain("exist only as Markdown");
    expect(output).toContain("intent-statement.md");
  });
});
