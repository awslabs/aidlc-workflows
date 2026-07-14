// covers: function:compileStageGraph, cli:aidlc-runner-gen(write,scopes)

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileStageGraph } from "../../core/tools/aidlc-graph.ts";
import {
  REPO_ROOT,
  setupIntegrationProject,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const CORE_RUNNER_GEN = join(REPO_ROOT, "core", "tools", "aidlc-runner-gen.ts");
const CORE_SCOPES = join(REPO_ROOT, "core", "scopes");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function stageFrontmatter(slug: string, extra = ""): string {
  return [
    "---",
    `slug: ${slug}`,
    extra.trim(),
    "phase: construction",
    "execution: ALWAYS",
    "condition: always",
    "lead_agent: aidlc-quality-agent",
    "support_agents: []",
    "mode: inline",
    "produces: []",
    "consumes: []",
    "requires_stage: []",
    "inputs: test input",
    "outputs: test output",
    "---",
    "",
    `# ${slug}`,
    "",
  ].filter((line) => line !== "").join("\n");
}

function compileFixture(stages: Record<string, string>) {
  const root = tempDir("aidlc-t222-compile-");
  const stagesDir = join(root, "stages");
  const construction = join(stagesDir, "construction");
  mkdirSync(construction, { recursive: true });
  for (const [slug, body] of Object.entries(stages)) {
    writeFileSync(join(construction, `${slug}.md`), body, "utf-8");
  }
  const graphPath = join(root, "stage-graph.json");
  const gridPath = join(root, "scope-grid.json");
  const rulesDir = join(root, "rules");
  const sensorsDir = join(root, "sensors");
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(sensorsDir, { recursive: true });
  writeFileSync(graphPath, "[]\n", "utf-8");
  writeFileSync(gridPath, "{}\n", "utf-8");

  return withEnvAndFreshCaches(
    {
      AIDLC_STAGES_DIR: stagesDir,
      AIDLC_STAGE_GRAPH: graphPath,
      AIDLC_SCOPE_GRID: gridPath,
      AIDLC_RULES_DIR: rulesDir,
      AIDLC_SENSORS_DIR: sensorsDir,
      AIDLC_HARNESS_DIR: ".claude",
    },
    () => compileStageGraph(),
  );
}

function runRunnerGen(gen: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(BUN, [gen, ...args], {
    encoding: "utf-8",
    env: { ...process.env, AIDLC_HARNESS_DIR: ".claude", ...env },
  });
}

function projectRunnerGen(project: string): string {
  const gen = join(project, ".claude", "tools", "aidlc-runner-gen.ts");
  cpSync(CORE_RUNNER_GEN, gen);
  return gen;
}

function writeSkill(skillsDir: string, dirName: string, body: string): string {
  const dir = join(skillsDir, dirName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, body, "utf-8");
  return path;
}

function writeScope(scopesDir: string, name: string, runner: boolean | null = null, plugin?: string): void {
  mkdirSync(scopesDir, { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    ...(plugin ? [`plugin: ${plugin}`] : []),
    "depth: Minimal",
    "keywords: []",
    `description: ${name} test scope`,
    ...(runner === null ? [] : [`runner: ${runner ? "true" : "false"}`]),
    "---",
    "",
    `# ${name}`,
    "",
  ];
  writeFileSync(join(scopesDir, `aidlc-${name}.md`), lines.join("\n"), "utf-8");
}

function setPluginSelection(project: string, plugins: string[]): void {
  writeFileSync(
    join(project, ".claude", "tools", "data", "harness.json"),
    `${JSON.stringify({ harnessDir: ".claude", rulesSubdir: "rules", plugins }, null, 2)}\n`,
    "utf-8",
  );
}

function hasGeneratedByMarker(body: string): boolean {
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return /^generated-by:\s*aidlc-runner-gen\s*$/m.test(m?.[1] ?? "");
}

function unmanagedPlaybookBody(): string {
  return [
    "---",
    "name: team-playbook",
    "description: Team playbook that documents AI-DLC commands.",
    "user-invocable: true",
    "---",
    "",
    "# Team playbook",
    "",
    "Documented stage command:",
    "",
    "```bash",
    "bun .claude/tools/aidlc-orchestrate.ts next --stage retired-stage --single",
    "```",
    "",
    "Documented scope command:",
    "",
    "```bash",
    "bun .claude/tools/aidlc-orchestrate.ts next --scope retired-scope",
    "```",
    "",
  ].join("\n");
}

function legacyStageRunnerBody(slug: string): string {
  return [
    "---",
    `name: aidlc-${slug}`,
    "description: Legacy generated runner without provenance.",
    "user-invocable: true",
    "---",
    "",
    "# Legacy runner",
    "",
    "```bash",
    `bun .claude/tools/aidlc-orchestrate.ts next --stage ${slug} --single`,
    "```",
    "",
  ].join("\n");
}

describe("t222 plugin ownership and runner naming", () => {
  test("compile carries plugin only for plugin-owned stages", () => {
    const compiled = compileFixture({
      "code-generation": stageFrontmatter("code-generation"),
      "test-pro-integration": stageFrontmatter(
        "test-pro-integration",
        "plugin: test-pro",
      ),
    });
    const core = compiled.stages.find((s) => s.slug === "code-generation");
    const plugin = compiled.stages.find((s) => s.slug === "test-pro-integration");
    expect(plugin?.plugin).toBe("test-pro");
    expect(Object.hasOwn(core ?? {}, "plugin")).toBe(false);
    expect(compiled.json).toContain('"plugin": "test-pro"');
  });

  test("compile rejects plugin stages whose slug does not start with the plugin prefix", () => {
    expect(() =>
      compileFixture({
        "plain-integration": stageFrontmatter(
          "plain-integration",
          "plugin: test-pro",
        ),
      }),
    ).toThrow(/plain-integration.*plugin "test-pro".*must start with "test-pro-"/);
  });

  test("compile rejects plugin: aidlc; core stages omit plugin instead", () => {
    expect(() =>
      compileFixture({
        "aidlc-custom": stageFrontmatter("aidlc-custom", "plugin: aidlc"),
      }),
    ).toThrow(/plugin "aidlc"; omit plugin for core stages/);
  });

  test("compile rejects an aidlc--prefixed plugin name (core runner-path collision)", () => {
    // runnerDirName returns the bare slug for plugin stages and aidlc-<slug>
    // for core, so a plugin named aidlc-<x> lands its runners on core paths.
    expect(() =>
      compileFixture({
        "aidlc-pro-check": stageFrontmatter("aidlc-pro-check", "plugin: aidlc-pro"),
      }),
    ).toThrow(/plugin "aidlc-pro".*"aidlc-" prefix is reserved for core.*Rename the plugin/);
  });

  test("stage runner names are core-prefixed for core stages and bare for plugin stages", () => {
    const project = setupIntegrationProject({ noAidlcDocs: true });
    tempDirs.push(project);
    const graphPath = join(project, ".claude", "tools", "data", "stage-graph.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    graph.push({
      slug: "test-pro-integration",
      number: "3.85",
      name: "Cross-Unit Integration Testing",
      plugin: "test-pro",
      phase: "construction",
      execution: "ALWAYS",
      lead_agent: "aidlc-quality-agent",
      support_agents: [],
      mode: "inline",
      produces: [],
      consumes: [],
      requires_stage: [],
      inputs: "test input",
      outputs: "test output",
      rules_in_context: [],
      sensors_applicable: [],
    });
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf-8");

    const gen = join(project, ".claude", "tools", "aidlc-runner-gen.ts");
    cpSync(CORE_RUNNER_GEN, gen);
    const r = runRunnerGen(gen, ["write"]);
    expect(r.status).toBe(0);

    expect(existsSync(join(project, ".claude", "skills", "aidlc-code-generation", "SKILL.md"))).toBe(true);
    const pluginSkill = join(project, ".claude", "skills", "test-pro-integration", "SKILL.md");
    expect(existsSync(pluginSkill)).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "aidlc-test-pro-integration", "SKILL.md"))).toBe(false);
    const body = readFileSync(pluginSkill, "utf-8");
    expect(body).toContain("name: test-pro-integration");
    expect(body).toContain("from the test-pro plugin");
  });

  test("scope runner default batch is selected by runner: true; --all includes unflagged scopes", () => {
    const scopesDir = tempDir("aidlc-t222-scopes-");
    for (const file of readdirSync(CORE_SCOPES).filter((f) => f.endsWith(".md"))) {
      cpSync(join(CORE_SCOPES, file), join(scopesDir, file));
    }
    writeFileSync(
      join(scopesDir, "aidlc-fixture-scope.md"),
      [
        "---",
        "name: fixture-scope",
        "depth: Minimal",
        "keywords: []",
        "description: Fixture scope with no runner flag",
        "---",
        "",
        "# fixture-scope",
        "",
      ].join("\n"),
      "utf-8",
    );

    const defaultOut = tempDir("aidlc-t222-scope-out-");
    const defaultRun = runRunnerGen(
      CORE_RUNNER_GEN,
      ["scopes", "--out", defaultOut],
      { AIDLC_SCOPES_DIR: scopesDir },
    );
    expect(defaultRun.status).toBe(0);

    const defaultRunners = readdirSync(defaultOut).sort();
    expect(defaultRunners).toEqual([
      "aidlc-bugfix",
      "aidlc-feature",
      "aidlc-mvp",
      "aidlc-security-patch",
    ]);
    expect(existsSync(join(defaultOut, "aidlc-fixture-scope", "SKILL.md"))).toBe(false);

    const allOut = tempDir("aidlc-t222-scope-all-");
    const allRun = runRunnerGen(
      CORE_RUNNER_GEN,
      ["scopes", "--all", "--out", allOut],
      { AIDLC_SCOPES_DIR: scopesDir },
    );
    expect(allRun.status).toBe(0);
    expect(existsSync(join(allOut, "aidlc-fixture-scope", "SKILL.md"))).toBe(true);
  });

  test("generated stage and scope runners carry generated-by provenance marker", () => {
    const project = setupIntegrationProject({ noAidlcDocs: true });
    tempDirs.push(project);
    const gen = projectRunnerGen(project);

    const writeRun = runRunnerGen(gen, ["write"]);
    expect(writeRun.status).toBe(0);
    const scopesRun = runRunnerGen(gen, ["scopes"]);
    expect(scopesRun.status).toBe(0);

    const stageBody = readFileSync(
      join(project, ".claude", "skills", "aidlc-code-generation", "SKILL.md"),
      "utf-8",
    );
    const scopeBody = readFileSync(
      join(project, ".claude", "skills", "aidlc-bugfix", "SKILL.md"),
      "utf-8",
    );
    expect(hasGeneratedByMarker(stageBody)).toBe(true);
    expect(hasGeneratedByMarker(scopeBody)).toBe(true);
  });

  test("unmanaged signature-matching skill survives write and scopes prunes", () => {
    const project = setupIntegrationProject({ noAidlcDocs: true });
    tempDirs.push(project);
    const gen = projectRunnerGen(project);
    const skillsDir = join(project, ".claude", "skills");
    const playbook = writeSkill(skillsDir, "team-playbook", unmanagedPlaybookBody());

    const writeRun = runRunnerGen(gen, ["write"]);
    expect(writeRun.status).toBe(0);
    expect(existsSync(playbook)).toBe(true);
    expect(writeRun.stderr).toContain("unmanaged skill, not pruned: team-playbook");

    const scopesDir = tempDir("aidlc-t222-no-runner-scopes-");
    writeScope(scopesDir, "doc-only", false);
    setPluginSelection(project, []);
    const scopesRun = runRunnerGen(gen, ["scopes"], { AIDLC_SCOPES_DIR: scopesDir });
    expect(scopesRun.status).toBe(0);
    expect(existsSync(playbook)).toBe(true);
    expect(scopesRun.stderr).toContain("unmanaged skill, not pruned: team-playbook");
  });

  test("legacy markerless generated stage runner is pruned by generated name", () => {
    const project = setupIntegrationProject({ noAidlcDocs: true });
    tempDirs.push(project);
    const gen = projectRunnerGen(project);
    const skillsDir = join(project, ".claude", "skills");
    const legacy = writeSkill(
      skillsDir,
      "aidlc-retired-stage",
      legacyStageRunnerBody("retired-stage"),
    );

    const writeRun = runRunnerGen(gen, ["write"]);
    expect(writeRun.status).toBe(0);
    expect(existsSync(legacy)).toBe(false);
  });

  test("empty scope batch without plugin selection does not prune existing scope runners", () => {
    const project = setupIntegrationProject({ noAidlcDocs: true });
    tempDirs.push(project);
    const gen = projectRunnerGen(project);
    const scopesDir = tempDir("aidlc-t222-empty-scopes-");
    writeScope(scopesDir, "doc-only", false);
    const existing = join(project, ".claude", "skills", "aidlc-bugfix", "SKILL.md");

    const run = runRunnerGen(gen, ["scopes"], { AIDLC_SCOPES_DIR: scopesDir });
    expect(run.status).toBe(0);
    expect(existsSync(existing)).toBe(true);
    expect(run.stderr).toContain(`no scope-runner batch resolved from ${scopesDir}`);
    expect(run.stderr).toContain("no scope files with runner:true found");
    expect(run.stderr).toContain("scope directory is missing or mispointed");
  });

  test("empty scope batch with plugin selection prunes existing scope runners", () => {
    const project = setupIntegrationProject({ noAidlcDocs: true });
    tempDirs.push(project);
    const gen = projectRunnerGen(project);
    const scopesDir = tempDir("aidlc-t222-selected-empty-scopes-");
    writeScope(scopesDir, "doc-only", false);
    setPluginSelection(project, []);
    const existing = join(project, ".claude", "skills", "aidlc-bugfix", "SKILL.md");

    const run = runRunnerGen(gen, ["scopes"], { AIDLC_SCOPES_DIR: scopesDir });
    expect(run.status).toBe(0);
    expect(existsSync(existing)).toBe(false);
    expect(run.stdout).toContain("pruned stale scope-runners");
  });

  test("malformed scope file does not prevent stage runner write", () => {
    const project = setupIntegrationProject({ noAidlcDocs: true });
    tempDirs.push(project);
    const gen = projectRunnerGen(project);
    const stageRunner = join(project, ".claude", "skills", "aidlc-code-generation", "SKILL.md");
    writeFileSync(stageRunner, "stale\n", "utf-8");
    writeFileSync(
      join(project, ".claude", "scopes", "aidlc-broken.md"),
      "---\nname: broken\n",
      "utf-8",
    );

    const run = runRunnerGen(gen, ["write"]);
    expect(run.status).toBe(0);
    const body = readFileSync(stageRunner, "utf-8");
    expect(hasGeneratedByMarker(body)).toBe(true);
    expect(body).toContain("--stage code-generation --single");
  });
});
