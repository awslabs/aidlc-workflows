// covers: subcommand:aidlc-utility:select-plugins, audit:PLUGIN_SELECTION_CHANGED, function:pluginsEnabled,
// function:compileStageGraph, function:mergeComposedScopes

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_MEMORY_SRC, AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const BUN = process.execPath;
const TIMEOUT_MS = 60_000;
const PLUGIN = "test-pro";
const STAGE_TABLE_BEGIN =
  "<!-- BEGIN: compiled stage graph via `bun aidlc-utility.ts stage-table` - do NOT hand-edit -->";
const STAGE_TABLE_END = "<!-- END: compiled stage graph -->";

function graphPath(project: string): string {
  return join(project, ".claude", "tools", "data", "stage-graph.json");
}

function gridPath(project: string): string {
  return join(project, ".claude", "tools", "data", "scope-grid.json");
}

function harnessPath(project: string): string {
  return join(project, ".claude", "tools", "data", "harness.json");
}

interface GraphStage {
  slug?: string;
  enabled?: false;
  produces?: string[];
  sensors?: string[];
}
function graph(project: string): GraphStage[] {
  return JSON.parse(readFileSync(graphPath(project), "utf-8"));
}

function grid(project: string): Record<string, { stages: Record<string, string> }> {
  return JSON.parse(readFileSync(gridPath(project), "utf-8"));
}

function runUtility(project: string, args: string[]) {
  return spawnSync(BUN, [join(project, ".claude", "tools", "aidlc-utility.ts"), ...args], {
    cwd: project,
    encoding: "utf-8",
    timeout: TIMEOUT_MS - 5_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".claude" },
  });
}

function runOrchestrate(project: string, args: string[]) {
  return spawnSync(BUN, [".claude/tools/aidlc-orchestrate.ts", ...args], {
    cwd: project,
    encoding: "utf-8",
    timeout: TIMEOUT_MS - 5_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".claude" },
  });
}

function stageTableRegion(project: string): string {
  const skill = readFileSync(join(project, ".claude", "skills", "aidlc", "SKILL.md"), "utf-8");
  const begin = skill.indexOf(STAGE_TABLE_BEGIN);
  const end = skill.indexOf(STAGE_TABLE_END, begin);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return skill.slice(begin, end + STAGE_TABLE_END.length);
}

function composeTestPro(project: string, pluginBuilt: string): void {
  const compose = spawnSync(BUN, [join(pluginBuilt, "hooks", "compose.ts")], {
    cwd: project,
    encoding: "utf-8",
    timeout: TIMEOUT_MS - 5_000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginBuilt,
      CLAUDE_PROJECT_DIR: project,
      AIDLC_HARNESS_DIR: ".claude",
    },
  });
  if (compose.status !== 0) throw new Error(`compose.ts failed: ${compose.stderr}`);
}

function copyClaudeInstall(project: string): void {
  mkdirSync(project, { recursive: true });
  cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
  if (existsSync(AIDLC_MEMORY_SRC)) {
    cpSync(AIDLC_MEMORY_SRC, join(project, "aidlc"), { recursive: true });
  }
}

function auditField(body: string, ev: string, key: string): string {
  let matched = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ") || line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

function writeSortedGrid(project: string, scopeGrid: Record<string, { stages: Record<string, string> }>): void {
  const sorted: Record<string, { stages: Record<string, string> }> = {};
  for (const key of Object.keys(scopeGrid).sort()) sorted[key] = scopeGrid[key];
  writeFileSync(gridPath(project), `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}

describe("t224 plugin selection - install chooses visible plugin surfaces", () => {
  let tmp: string;
  let pluginBuilt: string;
  let project: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t224-"));
    pluginBuilt = join(tmp, "plugin", "claude");
    const build = spawnSync(BUN, [PACKAGE_TS, "plugin", "build", PLUGIN, "claude", pluginBuilt], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
    });
    if (build.status !== 0) throw new Error(`plugin build failed: ${build.stderr}`);

    project = join(tmp, "proj");
    copyClaudeInstall(project);
    composeTestPro(project, pluginBuilt);
  });

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("selecting test-pro disables core surfaces but keeps bootstrap and full graph", () => {
    const fullGraphBefore = readFileSync(graphPath(project), "utf-8");

    const selected = runUtility(project, ["select-plugins", "test-pro"]);
    expect(selected.status).toBe(0);
    const audit = readAllAuditShards(project);
    expect(auditField(audit, "PLUGIN_SELECTION_CHANGED", "Previous Selection")).toBe("all enabled (no selection)");
    expect(auditField(audit, "PLUGIN_SELECTION_CHANGED", "New Selection")).toBe("test-pro");

    const harness = JSON.parse(readFileSync(harnessPath(project), "utf-8"));
    expect(harness.plugins).toEqual(["test-pro"]);

    const nodes = graph(project);
    expect(nodes.find((s) => s.slug === "code-generation")?.enabled).toBe(false);
    expect(nodes.find((s) => s.slug === "test-pro-integration")?.enabled).toBeUndefined();
    expect(nodes.find((s) => s.slug === "workspace-scaffold")?.enabled).toBeUndefined();

    const runners = join(project, ".claude", "skills");
    expect(existsSync(join(runners, "test-pro-integration", "SKILL.md"))).toBe(true);
    expect(existsSync(join(runners, "test-pro-validation", "SKILL.md"))).toBe(true);
    expect(existsSync(join(runners, "aidlc-code-generation", "SKILL.md"))).toBe(false);
    expect(existsSync(join(runners, "aidlc-feature", "SKILL.md"))).toBe(false);

    const scopeGrid = grid(project);
    expect(Object.keys(scopeGrid)).toEqual(["test-pro-validation"]);
    expect(scopeGrid["test-pro-validation"].stages["workspace-scaffold"]).toBe("EXECUTE");
    expect(scopeGrid["test-pro-validation"].stages["test-pro-integration"]).toBe("EXECUTE");
    expect(scopeGrid["test-pro-validation"].stages["code-generation"]).toBeUndefined();

    const table = stageTableRegion(project);
    expect(table).toContain("| workspace-scaffold |");
    expect(table).toContain("| test-pro-integration |");
    expect(table).not.toContain("| code-generation |");

    const doctor = runUtility(project, ["doctor"]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("Enabled plugins: test-pro");

    const both = runUtility(project, ["select-plugins", "aidlc,test-pro"]);
    expect(both.status).toBe(0);
    expect(readFileSync(graphPath(project), "utf-8")).toBe(fullGraphBefore);
  });

  test("selecting aidlc prunes test-pro runners while plugin files remain installed", () => {
    const selected = runUtility(project, ["select-plugins", "aidlc"]);
    expect(selected.status).toBe(0);

    expect(existsSync(join(project, ".claude", "skills", "test-pro-integration", "SKILL.md"))).toBe(false);
    expect(existsSync(join(project, ".claude", "skills", "test-pro-validation", "SKILL.md"))).toBe(false);
    expect(existsSync(join(project, ".claude", "aidlc-common", "stages", "construction", "test-pro-integration.md"))).toBe(true);
    expect(graph(project).find((s) => s.slug === "test-pro-integration")?.enabled).toBe(false);
  });

  // The orphan-contribution case: disabling a plugin must also remove what
  // compose merged into CORE stage source (structural adds via the sidecar,
  // prose fragments via their sentinel markers) - otherwise the disabled
  // plugin keeps steering enabled stages. Re-composing after re-enable
  // restores everything.
  test("disabling a plugin strips its merged contributions; recompose restores them", () => {
    const proj = join(tmp, "strip");
    copyClaudeInstall(proj);
    composeTestPro(proj, pluginBuilt);

    const stagePath = join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md");
    const sidecar = join(proj, ".claude", "tools", "data", "plugin-contrib-test-pro.json");
    const composed = readFileSync(stagePath, "utf-8");
    expect(composed).toContain("test-pro-regression-suite");
    expect(composed).toContain("Step 9a (test-pro)");
    expect(existsSync(sidecar)).toBe(true);

    const disable = runUtility(proj, ["select-plugins", "aidlc"]);
    expect(disable.status).toBe(0);
    expect(disable.stdout).toContain("Stripped merged contributions of disabled plugin(s): test-pro");
    const stripped = readFileSync(stagePath, "utf-8");
    expect(stripped).not.toContain("test-pro-regression-suite");
    expect(stripped).not.toContain("Step 9a (test-pro)");
    expect(stripped).not.toContain("<!-- plugin:test-pro:");
    expect(existsSync(sidecar)).toBe(false);
    // The compiled core node no longer carries the plugin's merged entries.
    const bat = graph(proj).find((s) => s.slug === "build-and-test");
    expect(bat?.produces).not.toContain("test-pro-regression-suite");
    expect((bat?.sensors ?? []).includes("coverage-threshold")).toBe(false);

    // Re-enable + re-compose = byte-identical restoration of the merges.
    const enable = runUtility(proj, ["select-plugins", "aidlc,test-pro"]);
    expect(enable.status).toBe(0);
    composeTestPro(proj, pluginBuilt);
    const restored = readFileSync(stagePath, "utf-8");
    expect(restored).toBe(composed);
    expect(existsSync(sidecar)).toBe(true);
  });

  test("compose does not merge contributions for a plugin the selection disables", () => {
    const proj = join(tmp, "no-merge-disabled");
    copyClaudeInstall(proj);
    // Pre-select core only, THEN compose: the plugin's stages copy (filtered
    // at runtime) but its contributions must NOT weld into core stage source.
    const harness = JSON.parse(readFileSync(harnessPath(proj), "utf-8"));
    harness.plugins = ["aidlc"];
    writeFileSync(harnessPath(proj), `${JSON.stringify(harness, null, 2)}\n`);
    composeTestPro(proj, pluginBuilt);
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).not.toContain("test-pro-regression-suite");
    expect(body).not.toContain("Step 9a (test-pro)");
  });

  test("unknown plugin names hard-fail and list valid names", () => {
    const result = runUtility(project, ["select-plugins", "aidlc,nope"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown plugin name");
    expect(result.stderr).toContain("aidlc");
    expect(result.stderr).toContain("test-pro");
  });

  // Disabling a plugin an ACTIVE workflow depends on would strand it: the
  // state file's scope out-ranks --scope, so every later /aidlc hard-errors
  // with no in-band recovery. select-plugins must refuse, and doctor must
  // flag a selection (written before this guard, or hand-edited) that
  // already strands one.
  function seedActiveWorkflow(proj: string, scope: string, extraStageRow = ""): string {
    const dirName = "strand-probe-deadbeef";
    const intentDir = join(proj, "aidlc", "spaces", "default", "intents", dirName);
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(
      join(proj, "aidlc", "spaces", "default", "intents", "intents.json"),
      `${JSON.stringify([{ uuid: "deadbeef-0000-4000-8000-000000000000", slug: "strand-probe", dirName, scope, status: "in-flight" }], null, 2)}\n`,
    );
    // The Stage Progress row delimiter is the em dash (parseCheckboxes'
    // format), written as an escape so the byte is deliberate, not cosmetic.
    const dash = "\u2014";
    writeFileSync(
      join(intentDir, "aidlc-state.md"),
      [
        "# AI-DLC State Tracking",
        "",
        "## Project Information",
        "- **Project**: strand probe",
        `- **Scope**: ${scope}`,
        "",
        "## Stage Progress",
        "",
        "### CONSTRUCTION PHASE",
        `- [ ] code-generation ${dash} EXECUTE`,
        ...(extraStageRow ? [extraStageRow] : []),
        "",
        "## Current Status",
        "- **Status**: Running",
        "",
      ].join("\n"),
    );
    return intentDir;
  }

  test("select-plugins refuses to strand an active workflow's scope", () => {
    const proj = join(tmp, "strand-scope");
    copyClaudeInstall(proj);
    composeTestPro(proj, pluginBuilt);
    const intentDir = seedActiveWorkflow(proj, "test-pro-validation");

    const result = runUtility(proj, ["select-plugins", "aidlc"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("select-plugins refused");
    // die() JSON-encodes the message, so quotes arrive escaped - assert on
    // quote-free substrings.
    expect(result.stderr).toContain("test-pro-validation");
    expect(result.stderr).toContain("owned by plugin");
    expect(result.stderr).toContain("Complete or park the workflow(s) first");

    // A completed workflow no longer blocks the same change.
    const state = join(intentDir, "aidlc-state.md");
    writeFileSync(state, readFileSync(state, "utf-8").replace("- **Status**: Running", "- **Status**: Completed"));
    const after = runUtility(proj, ["select-plugins", "aidlc"]);
    expect(after.status).toBe(0);
  });

  test("select-plugins refuses to strand a pending plugin-owned EXECUTE stage under a core scope", () => {
    const proj = join(tmp, "strand-stage");
    copyClaudeInstall(proj);
    composeTestPro(proj, pluginBuilt);
    seedActiveWorkflow(proj, "feature", `- [ ] test-pro-integration ${"\u2014"} EXECUTE`);

    const result = runUtility(proj, ["select-plugins", "aidlc"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pending stage");
    expect(result.stderr).toContain("test-pro-integration");
  });

  test("doctor flags a selection that already strands an active workflow", () => {
    const proj = join(tmp, "strand-doctor");
    copyClaudeInstall(proj);
    composeTestPro(proj, pluginBuilt);
    seedActiveWorkflow(proj, "test-pro-validation");
    // Simulate a pre-guard selection: write it directly, then recompile the
    // surfaces the way select-plugins would have.
    const harness = JSON.parse(readFileSync(harnessPath(proj), "utf-8"));
    harness.plugins = ["aidlc"];
    writeFileSync(harnessPath(proj), `${JSON.stringify(harness, null, 2)}\n`);
    const doctor = runUtility(proj, ["doctor"]);
    const out = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
    expect(out).toContain("Plugin selection vs active workflows: 1 stranded dependency(ies)");
    expect(out).toContain('scope "test-pro-validation" owned by plugin "test-pro"');
  });

  test("select-plugins skips runner regeneration when the harness skills dir is absent", () => {
    const noSkillsProj = join(tmp, "no-skills");
    copyClaudeInstall(noSkillsProj);
    composeTestPro(noSkillsProj, pluginBuilt);

    const agentsSkill = join(noSkillsProj, ".agents", "skills", "aidlc", "SKILL.md");
    mkdirSync(dirname(agentsSkill), { recursive: true });
    cpSync(join(noSkillsProj, ".claude", "skills", "aidlc", "SKILL.md"), agentsSkill);
    rmSync(join(noSkillsProj, ".claude", "skills"), { recursive: true, force: true });

    const result = runUtility(noSkillsProj, ["select-plugins", "test-pro"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("note: runner regeneration skipped:");
    expect(result.stdout).toContain(join(noSkillsProj, ".claude", "skills"));
    expect(result.stdout).toContain("Enabled plugins: test-pro");
    expect(existsSync(join(noSkillsProj, ".claude", "skills"))).toBe(false);
  });

  test("late-step failure rolls back harness, graph, and grid then regenerates restored selection", () => {
    const beforeHarness = readFileSync(harnessPath(project), "utf-8");
    const beforeGraph = readFileSync(graphPath(project), "utf-8");
    const beforeGrid = readFileSync(gridPath(project), "utf-8");

    const blocker = join(project, ".claude", "skills", "test-pro-integration");
    writeFileSync(blocker, "not a directory\n", "utf-8");

    const result = runUtility(project, ["select-plugins", "aidlc,test-pro"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Restored harness.json, stage-graph.json, scope-grid.json");
    expect(readFileSync(harnessPath(project), "utf-8")).toBe(beforeHarness);
    expect(readFileSync(graphPath(project), "utf-8")).toBe(beforeGraph);
    expect(readFileSync(gridPath(project), "utf-8")).toBe(beforeGrid);
  });

  test("closure guard names the disabled producer plugin, producer, artifact, and consumer", () => {
    const closureProj = join(tmp, "closure");
    copyClaudeInstall(closureProj);
    const stageDir = join(closureProj, ".claude", "aidlc-common", "stages", "construction");
    const scopeDir = join(closureProj, ".claude", "scopes");
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(
      join(stageDir, "guard-core-consumer.md"),
      [
        "---",
        "slug: guard-core-consumer",
        "plugin: guard",
        "phase: construction",
        "execution: ALWAYS",
        "condition: always",
        "lead_agent: aidlc-developer-agent",
        "support_agents: []",
        "mode: inline",
        "produces:",
        "  - guard-output",
        "consumes:",
        "  - artifact: intent-statement",
        "    required: true",
        "requires_stage: []",
        "scopes:",
        "  - guard-validation",
        "inputs: x",
        "outputs: y",
        "---",
        "",
        "# Guard core consumer",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(scopeDir, "guard-validation.md"),
      [
        "---",
        "name: guard-validation",
        "plugin: guard",
        "depth: Minimal",
        "keywords: []",
        "description: Guard validation",
        "runner: true",
        "---",
        "",
        "# guard-validation",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = runUtility(closureProj, ["select-plugins", "guard"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Plugin selection closure failed");
    expect(result.stderr).toContain("guard-core-consumer");
    expect(result.stderr).toContain("intent-statement");
    expect(result.stderr).toContain("intent-capture");
    expect(result.stderr).toContain("aidlc");
  });

  test("composed scopes survive plugin selection with intact grid and runner", () => {
    const composedProj = join(tmp, "composed");
    copyClaudeInstall(composedProj);
    composeTestPro(composedProj, pluginBuilt);

    const scopeName = "custom-composed";
    const scopeDir = join(composedProj, ".claude", "scopes");
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(
      join(scopeDir, "aidlc-custom-composed.md"),
      [
        "---",
        `name: ${scopeName}`,
        "depth: Composed",
        "keywords: []",
        "runner: true",
        "---",
        "",
        "# custom-composed",
        "",
      ].join("\n"),
      "utf-8",
    );

    const seededGrid = grid(composedProj);
    const seededStages = { ...seededGrid.feature.stages };
    const seededEntry = { stages: seededStages };
    const seededEntryJson = JSON.stringify(seededEntry);
    seededGrid[scopeName] = seededEntry;
    writeSortedGrid(composedProj, seededGrid);

    const firstExecute = Object.entries(seededStages).find(
      ([slug, value]) =>
        value === "EXECUTE" &&
        !["workspace-scaffold", "workspace-detection", "state-init"].includes(slug),
    )?.[0];
    expect(firstExecute).toBe("intent-capture");

    const selectedPluginOnly = runUtility(composedProj, ["select-plugins", "test-pro"]);
    expect(selectedPluginOnly.status).toBe(0);
    expect(grid(composedProj)[scopeName].stages).toEqual(seededStages);
    expect(JSON.stringify(grid(composedProj)[scopeName])).toBe(seededEntryJson);
    expect(existsSync(join(composedProj, ".claude", "skills", "aidlc-custom-composed", "SKILL.md"))).toBe(true);

    const selectedBoth = runUtility(composedProj, ["select-plugins", "aidlc,test-pro"]);
    expect(selectedBoth.status).toBe(0);
    expect(JSON.stringify(grid(composedProj)[scopeName])).toBe(seededEntryJson);

    const init = runUtility(composedProj, ["intent-birth", "--scope", scopeName, "--project-dir", composedProj]);
    expect(init.status).toBe(0);

    const next = runOrchestrate(composedProj, ["next", "--scope", scopeName]);
    expect(next.status).toBe(0);
    expect(next.stdout).not.toContain("Unknown scope");
    const directive = JSON.parse(next.stdout.trim());
    expect(directive.kind).toBe("run-stage");
    expect(directive.stage).toBe(firstExecute);
  });
});
