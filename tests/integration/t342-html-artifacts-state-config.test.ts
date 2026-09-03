import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, seededRecordDir, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";

const ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(ROOT, "core", "tools", "aidlc-utility.ts");
const DIST = join(ROOT, "dist", "claude", ".claude");
const projects: string[] = [];
const graphDir = mkdtempSync(join(tmpdir(), "aidlc-t342-"));
const graphPath = join(graphDir, "stage-graph.json");
const graph = JSON.parse(readFileSync(join(DIST, "tools", "data", "stage-graph.json"), "utf-8")) as Array<Record<string, unknown>>;
for (const stage of graph) {
  stage.html_capable = stage.slug === "intent-capture"
    ? ["intent-statement", "stakeholder-map"]
    : stage.slug === "requirements-analysis"
      ? ["requirements"]
      : [];
}
writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);

const baseEnv = {
  ...process.env,
  AIDLC_STAGE_GRAPH: graphPath,
  AIDLC_SCOPE_GRID: join(DIST, "tools", "data", "scope-grid.json"),
  AIDLC_SCOPES_DIR: join(ROOT, "core", "scopes"),
  AIDLC_AGENTS_DIR: join(ROOT, "core", "agents"),
  AIDLC_HARNESS_DIR: ".claude",
};

interface Result { status: number; stdout: string; stderr: string }
function utility(args: string[], project: string, env: Record<string, string | undefined> = {}): Result {
  const result = Bun.spawnSync({
    cmd: [process.execPath, TOOL, ...args, "--project-dir", project],
    cwd: project,
    env: { ...baseEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function stateProject(): string {
  const project = setupIntegrationProject({ withState: "state-mid-ideation.md" });
  projects.push(project);
  const path = seededStateFile(project);
  writeFileSync(path, readFileSync(path, "utf-8").replace(
    /^(- \*\*Test Strategy\*\*:[^\n]*)$/m,
    "$1\n- **HTML Artifacts**: off",
  ));
  return project;
}

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  rmSync(graphDir, { recursive: true, force: true });
});

describe("HTML artifact state and config", () => {
  for (const [envValue, expected] of [["1", "on"], [undefined, "off"]] as const) {
    test(`intent creation seeds ${expected}`, () => {
      const project = setupIntegrationProject({ noAidlcDocs: true });
      projects.push(project);
      const result = utility(
        ["intent-create", "--scope", "feature", "--arguments", `html ${expected}`, "--label", `html-${expected}`],
        project,
        { AIDLC_HTML_ARTIFACTS: envValue },
      );
      expect(result.status).toBe(0);
      const state = readFileSync(join(project, "aidlc", "spaces", "default", "intents", readFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), "utf-8").trim(), "aidlc-state.md"), "utf-8");
      expect(state).toContain(`- **HTML Artifacts**: ${expected}`);
    });
  }

  test("config-change flips before artifacts exist and status reports it", () => {
    const project = stateProject();
    const changed = utility(["config-change", "--html-artifacts", "on"], project);
    expect(changed.status).toBe(0);
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain("- **HTML Artifacts**: on");
    const status = utility(["status"], project);
    expect(status.stdout).toContain("HTML Artifacts: on");
  });

  test("config-change refuses after an HTML-capable artifact exists", () => {
    const project = stateProject();
    const dir = join(seededRecordDir(project), "ideation", "intent-capture");
    const file = join(dir, "intent-statement.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "started\n");
    const result = utility(["config-change", "--html-artifacts", "on"], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot change HTML Artifacts after authoring or review has started.");
    expect(result.stderr).toContain("intent-statement.md");
  });

  test("config-change refuses while any review gate is open", () => {
    const project = stateProject();
    const path = seededStateFile(project);
    writeFileSync(path, readFileSync(path, "utf-8").replace("- [-] feasibility", "- [?] feasibility"));
    const result = utility(["config-change", "--html-artifacts", "on"], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage feasibility is awaiting review");
  });
});
