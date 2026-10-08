// covers: function:compileStageGraph, function:loadScopeMetadata, function:loadAgents, function:aidlcAgentClaim, function:isAidlcAgentFile, function:foreignAgentFiles, function:augmentDispatchRules, subcommand:aidlc-utility:doctor

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileStageGraph } from "../../core/tools/aidlc-graph.ts";
import {
  agentsDir,
  foreignAgentFiles,
  loadAgents,
  loadScopeMetadata,
} from "../../core/tools/aidlc-lib.ts";
import { augmentDispatchRules } from "../../core/hooks/aidlc-deliver-stage-rules.ts";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  setupIntegrationProject,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const UTIL = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
const DIST_DATA = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data");

const tempDirs: string[] = [];
const projects: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  for (const p of projects.splice(0)) cleanupTestProject(p);
  delete process.env.AIDLC_STAGES_DIR;
  delete process.env.AIDLC_STAGE_GRAPH;
  delete process.env.AIDLC_SCOPE_GRID;
  delete process.env.AIDLC_RULES_DIR;
  delete process.env.AIDLC_SENSORS_DIR;
  delete process.env.AIDLC_SCOPES_DIR;
  delete process.env.AIDLC_AGENTS_DIR;
  delete process.env.AIDLC_HARNESS_DIR;
  withEnvAndFreshCaches({}, () => undefined);
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function stageFrontmatter(slug: string): string {
  return [
    "---",
    `slug: ${slug}`,
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
  ].join("\n");
}

function compileStageFixture(filenameStem: string, slug: string): void {
  const root = tempDir("aidlc-t223-compile-");
  const stagesDir = join(root, "stages");
  const construction = join(stagesDir, "construction");
  const rulesDir = join(root, "rules");
  const sensorsDir = join(root, "sensors");
  const graphPath = join(root, "stage-graph.json");
  const gridPath = join(root, "scope-grid.json");
  mkdirSync(construction, { recursive: true });
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(sensorsDir, { recursive: true });
  writeFileSync(join(construction, `${filenameStem}.md`), stageFrontmatter(slug), "utf-8");
  writeFileSync(graphPath, "[]\n", "utf-8");
  writeFileSync(gridPath, "{}\n", "utf-8");

  withEnvAndFreshCaches(
    {
      AIDLC_STAGES_DIR: stagesDir,
      AIDLC_STAGE_GRAPH: graphPath,
      AIDLC_SCOPE_GRID: gridPath,
      AIDLC_RULES_DIR: rulesDir,
      AIDLC_SENSORS_DIR: sensorsDir,
      AIDLC_AGENTS_DIR: undefined,
      AIDLC_HARNESS_DIR: ".claude",
    },
    () => compileStageGraph(),
  );
}

function writeScope(dir: string, file: string, name: string): void {
  writeFileSync(
    join(dir, file),
    [
      "---",
      `name: ${name}`,
      "depth: Minimal",
      "keywords: []",
      "description: Fixture scope",
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeAgent(dir: string, file: string, name: string): void {
  writeFileSync(
    join(dir, file),
    [
      "---",
      `name: ${name}`,
      `display_name: ${name}`,
      "examples: []",
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("t223 naming enforcement", () => {
  test("stage filename stem must match frontmatter slug at compile", () => {
    expect(() => compileStageFixture("file-stem", "declared-slug")).toThrow(
      /file-stem\.md.*file-stem.*declared-slug.*Rename the file or fix the slug/,
    );
  });

  test("duplicate scope names throw and name both files", () => {
    const dir = tempDir("aidlc-t223-scopes-");
    const first = join(dir, "alpha.md");
    const second = join(dir, "beta.md");
    writeScope(dir, "alpha.md", "shared-scope");
    writeScope(dir, "beta.md", "shared-scope");

    expect(() =>
      withEnvAndFreshCaches({ AIDLC_SCOPES_DIR: dir }, () => loadScopeMetadata()),
    ).toThrow(
      new RegExp(
        `Duplicate scope name "shared-scope".*${second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Rename one of them`,
      ),
    );
  });

  test("duplicate agent slugs throw and name both files", () => {
    const dir = tempDir("aidlc-t223-agents-");
    const first = join(dir, "alpha-agent.md");
    const second = join(dir, "beta-agent.md");
    writeAgent(dir, "alpha-agent.md", "shared-agent");
    writeAgent(dir, "beta-agent.md", "shared-agent");

    expect(() =>
      withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => loadAgents()),
    ).toThrow(
      new RegExp(
        `Duplicate agent slug "shared-agent".*${second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Rename one of them`,
      ),
    );
  });

  test("AIDLC_AGENTS_DIR points loadAgents at a temp fixture dir", () => {
    const dir = tempDir("aidlc-t223-agent-seam-");
    writeAgent(dir, "fixture-agent.md", "fixture-agent");

    withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
      expect(agentsDir()).toBe(dir);
      expect(loadAgents()).toEqual([
        { slug: "fixture-agent", display_name: "fixture-agent", examples: [] },
      ]);
    });
  });

  test("loadAgents skips the IDE conductor aidlc.md", () => {
    const dir = tempDir("aidlc-t223-agent-conductor-");
    writeAgent(dir, "fixture-agent.md", "fixture-agent");
    writeFileSync(
      join(dir, "aidlc.md"),
      [
        "---",
        "name: aidlc",
        "description: IDE conductor without persona metadata",
        'tools: ["read", "write", "shell", "subagent"]',
        "---",
        "",
        "Conductor body.",
        "",
      ].join("\n"),
    );

    withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
      expect(loadAgents()).toEqual([
        { slug: "fixture-agent", display_name: "fixture-agent", examples: [] },
      ]);
    });
  });

  test("doctor reports a scope filename/name stem mismatch as advisory", () => {
    const project = createTestProject();
    projects.push(project);
    const scopes = tempDir("aidlc-t223-doctor-scopes-");
    writeScope(scopes, "wrong-scope.md", "right-scope");

    const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", project], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_SCOPES_DIR: scopes,
        AIDLC_STAGE_GRAPH: join(DIST_DATA, "stage-graph.json"),
        AIDLC_SCOPE_GRID: join(DIST_DATA, "scope-grid.json"),
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    expect(out).toContain("ok    Scope filename/name consistency");
    expect(out).toContain("Scope filename/name consistency: 1 mismatch(es) (advisory)");
    expect(out).toContain(join(scopes, "wrong-scope.md"));
    expect(out).toContain('stem "wrong-scope"');
    expect(out).toContain('declares name "right-scope"');
    expect(out).toContain("Rename the file or fix the name.");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("doctor fails active selection coverage when stage frontmatter cannot be parsed", () => {
    const project = setupIntegrationProject();
    projects.push(project);

    const harnessJsonPath = join(project, ".claude", "tools", "data", "harness.json");
    const harnessJson = JSON.parse(readFileSync(harnessJsonPath, "utf-8")) as Record<string, unknown>;
    harnessJson.plugins = ["aidlc"];
    writeFileSync(harnessJsonPath, `${JSON.stringify(harnessJson, null, 2)}\n`, "utf-8");

    const brokenPath = join(project, ".claude", "aidlc-common", "stages", "construction", "bad-frontmatter.md");
    writeFileSync(brokenPath, "not frontmatter\n", "utf-8");

    const res = spawnSync(BUN, [join(project, ".claude", "tools", "aidlc-utility.ts"), "doctor"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });

    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("Enabled stage compile coverage: 1 enabled stage file(s) missing from the full graph");
    expect(res.stdout).toContain("bad-frontmatter");
    expect(res.stdout).toContain(brokenPath);
    expect(res.stdout).toContain("frontmatter parse failed");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  describe("the host's own agents in the agents dir (#1406)", () => {
    const HOST_AGENT = [
      "---",
      "name: foo-agent",
      "description: Reviews pull requests. Installed by another tool.",
      "tools: Read, Grep",
      "model: sonnet",
      "---",
      "",
      "You review pull requests.",
      "",
    ].join("\n");

    function agentsWith(files: Record<string, string>, base: "none" | "shipped" = "none"): string {
      const dir = tempDir("aidlc-t223-host-agents-");
      if (base === "shipped") cpSync(join(REPO_ROOT, "core", "agents"), dir, { recursive: true });
      for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body, "utf-8");
      return dir;
    }

    test("loadAgents leaves a host agent and a plain note out, and lists them as foreign", () => {
      const dir = agentsWith({ "foo-agent.md": HOST_AGENT, "README.md": "# Agents\n" });
      writeAgent(dir, "fixture-agent.md", "fixture-agent");

      withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
        expect(loadAgents()).toEqual([
          { slug: "fixture-agent", display_name: "fixture-agent", examples: [] },
        ]);
        expect(foreignAgentFiles()).toEqual([join(dir, "README.md"), join(dir, "foo-agent.md")]);
      });
    });

    const claims: Array<[string, string, string]> = [
      ["an aidlc- filename", "aidlc-broken-agent.md", "---\nname: aidlc-broken-agent\ndescription: x\n---\n"],
      ["an examples list", "team-agent.md", "---\nname: team-agent\nexamples:\n  - a.md\n---\n"],
      ["a tier", "team-agent.md", "---\nname: team-agent\ntier: judgment\n---\n"],
      ["a plugin owner", "team-agent.md", "---\nname: team-agent\nplugin: team\n---\n"],
    ];
    for (const [claim, file, body] of claims) {
      test(`a file with ${claim} but no display_name still fails the loader`, () => {
        const dir = agentsWith({ [file]: body });
        withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
          expect(() => loadAgents()).toThrow(
            new RegExp(`${file.replace(".", "\\.")} missing required frontmatter: display_name`),
          );
          expect(foreignAgentFiles()).toEqual([]);
        });
      });
    }

    test("an aidlc- file with no frontmatter still fails the loader", () => {
      const dir = agentsWith({ "aidlc-broken-agent.md": "# no frontmatter\n" });
      withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
        expect(() => loadAgents()).toThrow(/Agent file missing frontmatter/);
      });
    });

    test("the graph compiles beside a host agent, and a stage cannot lead with one", () => {
      const dir = agentsWith({ "foo-agent.md": HOST_AGENT }, "shipped");
      const compileWith = (lead: string): void => {
        const root = tempDir("aidlc-t223-host-compile-");
        const construction = join(root, "stages", "construction");
        mkdirSync(construction, { recursive: true });
        mkdirSync(join(root, "rules"), { recursive: true });
        mkdirSync(join(root, "sensors"), { recursive: true });
        writeFileSync(
          join(construction, "probe-stage.md"),
          stageFrontmatter("probe-stage").replace("lead_agent: aidlc-quality-agent", `lead_agent: ${lead}`),
          "utf-8",
        );
        writeFileSync(join(root, "stage-graph.json"), "[]\n", "utf-8");
        writeFileSync(join(root, "scope-grid.json"), "{}\n", "utf-8");
        withEnvAndFreshCaches(
          {
            AIDLC_STAGES_DIR: join(root, "stages"),
            AIDLC_STAGE_GRAPH: join(root, "stage-graph.json"),
            AIDLC_SCOPE_GRID: join(root, "scope-grid.json"),
            AIDLC_RULES_DIR: join(root, "rules"),
            AIDLC_SENSORS_DIR: join(root, "sensors"),
            AIDLC_AGENTS_DIR: dir,
            AIDLC_HARNESS_DIR: ".claude",
          },
          () => compileStageGraph(),
        );
      };
      expect(() => compileWith("aidlc-quality-agent")).not.toThrow();
      expect(() => compileWith("foo-agent")).toThrow(/lead_agent "foo-agent" has no matching/);
    });

    test("a loader error on a non-aidlc- file names the key that made it a persona", () => {
      const dir = agentsWith({ "planner.md": "---\nname: planner\ndescription: Plans.\ntier: premium\n---\n" });
      withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
        expect(() => loadAgents()).toThrow(
          /planner\.md missing required frontmatter: display_name \(treated as an AI-DLC persona because it declares `tier:`\)/,
        );
      });
    });

    test("a host agent that cannot be read is left out; an aidlc- one still fails", () => {
      const dir = agentsWith({ "foo-agent.md": HOST_AGENT }, "shipped");
      symlinkSync(join(dir, "..", "missing-shared", "reviewer.md"), join(dir, "reviewer.md"));
      withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
        expect(loadAgents().map((agent) => agent.slug)).not.toContain("reviewer");
        expect(foreignAgentFiles()).toEqual([join(dir, "foo-agent.md"), join(dir, "reviewer.md")]);
      });
      symlinkSync(join(dir, "..", "missing-shared", "aidlc-x-agent.md"), join(dir, "aidlc-x-agent.md"));
      withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
        expect(() => loadAgents()).toThrow(/aidlc-x-agent\.md/);
      });
    });

    test("a persona saved with a byte-order mark is not mistaken for a host agent", () => {
      const dir = agentsWith({
        "team-reviewer-agent.md": "\uFEFF---\nname: team-reviewer-agent\ndisplay_name: Reviewer\nplugin: team\n---\n",
      });
      withEnvAndFreshCaches({ AIDLC_AGENTS_DIR: dir }, () => {
        expect(foreignAgentFiles()).toEqual([]);
        expect(() => loadAgents()).toThrow(/Agent file missing frontmatter: .*team-reviewer-agent\.md/);
      });
    });

    test("doctor passes schema and naming checks beside a host agent and names it", () => {
      const project = createTestProject();
      projects.push(project);
      const dir = agentsWith(
        { "foo-agent.md": HOST_AGENT, "bar.md": HOST_AGENT.replace("name: foo-agent", "name: bar-helper") },
        "shipped",
      );

      const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", project], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_AGENTS_DIR: dir,
          AIDLC_STAGE_GRAPH: join(DIST_DATA, "stage-graph.json"),
          AIDLC_SCOPE_GRID: join(DIST_DATA, "scope-grid.json"),
          AIDLC_HARNESS_DIR: ".claude",
        },
      });
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

      expect(out).not.toContain("Schema validation: check failed");
      expect(out).not.toContain("Agent filename/name consistency: check failed");
      expect(out).toContain("ok    Agent filename/name consistency: all agent files match declared names");
      expect(out).toContain(
        "ok    Other agents in .claude/agents (advisory): bar.md, foo-agent.md - not AI-DLC personas",
      );
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test("doctor still checks the conductor aidlc.md name beside host agents", () => {
      const project = createTestProject();
      projects.push(project);
      const dir = agentsWith(
        { "foo-agent.md": HOST_AGENT, "aidlc.md": "---\nname: aidlc-conductor\ndescription: IDE conductor\n---\n" },
        "shipped",
      );
      const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", project], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_AGENTS_DIR: dir,
          AIDLC_STAGE_GRAPH: join(DIST_DATA, "stage-graph.json"),
          AIDLC_SCOPE_GRID: join(DIST_DATA, "scope-grid.json"),
          AIDLC_HARNESS_DIR: ".claude",
        },
      });
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      expect(out).toContain("Agent filename/name consistency: 1 mismatch(es) (advisory)");
      expect(out).toContain('stem "aidlc"');
      expect(out).not.toContain('stem "foo-agent"');
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test("a dispatch to a host agent keeps its own brief while a persona's is rewritten", () => {
      const project = setupIntegrationProject({ noAidlcDocs: true });
      projects.push(project);
      const dataEnv = {
        AIDLC_STAGE_GRAPH: join(DIST_DATA, "stage-graph.json"),
        AIDLC_SCOPE_GRID: join(DIST_DATA, "scope-grid.json"),
        AIDLC_HARNESS_DIR: ".claude",
      };
      const created = spawnSync(
        BUN,
        [UTIL, "intent-create", "--scope", "poc", "--arguments", "probe", "--project-dir", project],
        {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          encoding: "utf-8",
          env: { ...process.env, ...dataEnv },
        },
      );
      expect(created.status, `${created.stdout}\n${created.stderr}`).toBe(0);
      const dir = agentsWith({ "foo-agent.md": HOST_AGENT }, "shipped");

      withEnvAndFreshCaches({ ...dataEnv, AIDLC_AGENTS_DIR: dir }, () => {
        const persona = augmentDispatchRules(
          "task",
          { subagent_type: "aidlc-product-agent", prompt: "Execute the current stage." },
          project,
        );
        expect(persona.error ?? null).toBeNull();
        expect(persona.changed).toBe(true);

        const host = augmentDispatchRules(
          "task",
          { subagent_type: "foo-agent", prompt: "Review this pull request." },
          project,
        );
        expect(host).toEqual({ changed: false });
      });
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  });
});
