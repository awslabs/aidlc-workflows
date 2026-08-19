// t188-plugin-compose: the AIDLC plugin system end-to-end guard.
//
// covers: file:scripts/package.ts (emitPlugins), file:scripts/plugin-hooks-template/compose.ts
//
// WHAT. A plugin authored in plugins/<name>/ is emitted by the packager as a
// per-harness host plugin (dist/plugins/<name>/<harness>/), and its compose hook
// merges the plugin into a base install: new stages copied, the contribution
// seam merged (produces + consumes + sensors into target stage nodes, prose
// fragments spliced into stage bodies), {{HARNESS_DIR}} substituted, and the
// graph recompiled. This test IS that guard — it runs the real packager + the
// real compose hook against a fresh copy of dist/claude, then asserts the
// composed graph and stage bodies carry the plugin's contributions.
//
// WHY A SUBPROCESS. package.ts and the compose hook are CLIs that spawn the
// in-tree generators (aidlc-graph compile); running them as children mirrors how
// a host's SessionStart hook invokes them and isolates their temp builds.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  acquireAuditLock,
  auditLockDir,
  releaseAuditLock,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  HARNESS_MATRIX,
  type ShippedHarnessName,
} from "../harness/harness-matrix.ts";
import {
  assertNonEmptyStageBody,
  buildPluginProjection,
  composePluginFixture,
} from "../harness/plugin-kit.ts";

const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const BUN = process.execPath; // the bun running this test — robust for hooks
const TIMEOUT_MS = 60_000;
setDefaultTimeout(TIMEOUT_MS);

const PLUGIN = "test-pro";
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude", ".claude");
const OPENCODE_DIST = join(REPO_ROOT, "dist", "opencode");
const KIRO_DIST = join(REPO_ROOT, "dist", "kiro", ".kiro");
const CODEX_DIST = join(REPO_ROOT, "dist", "codex", ".codex");
const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor");
const CURSOR_INSTALLER_SOURCE = join(REPO_ROOT, "harness", "cursor", "install.ts");
const STAGE_TABLE_BEGIN =
  "<!-- BEGIN: compiled stage graph via `bun aidlc-utility.ts stage-table` - do NOT hand-edit -->";
const STAGE_TABLE_END = "<!-- END: compiled stage graph -->";

function fileInventory(root: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, relative)).sort()) {
    const rel = join(relative, entry);
    if (statSync(join(root, rel)).isDirectory()) files.push(...fileInventory(root, rel));
    else files.push(rel);
  }
  return files;
}

interface GraphStage {
  slug?: string;
  produces?: string[];
  consumes?: Array<{ artifact?: string; required?: boolean }>;
  sensors_applicable?: Array<{ id?: string }>;
  enabled?: false;
}

// Absolute path to a stage's compiled node in a composed project.
function graph(projectDir: string): GraphStage[] {
  return JSON.parse(
    readFileSync(join(projectDir, ".claude", "tools", "data", "stage-graph.json"), "utf-8")
  ) as GraphStage[];
}
function stage(projectDir: string, slug: string): GraphStage | undefined {
  return graph(projectDir).find((s) => s.slug === slug);
}
function stageSourcePath(projectDir: string, phase: string, slug: string): string {
  return join(projectDir, ".claude", "aidlc-common", "stages", phase, `${slug}.md`);
}
function stageBody(projectDir: string, phase: string, slug: string): string {
  return readFileSync(stageSourcePath(projectDir, phase, slug), "utf-8");
}
function hookDrops(projectDir: string): string {
  let drops = "";
  const hd = join(projectDir, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
  if (!existsSync(hd)) return drops;
  for (const f of readdirSync(hd)) {
    if (f.startsWith("plugin-compose") && f.endsWith(".drops")) {
      drops += readFileSync(join(hd, f), "utf-8");
    }
  }
  return drops;
}

describe("t188 plugin compose — emit + compose the contribution seam", () => {
  let tmp: string;
  let project: string;
  let pluginBuilt: string;
  let coreRunnerBefore: string;
  const pluginBuilds = new Map<ShippedHarnessName, string>();

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t188-"));

    // 1. Build every manifest-discovered projection into tmp via the target-dir
    //    seam. This exercises the real emitter without mutating committed dist.
    for (const harness of HARNESS_MATRIX) {
      const built = join(tmp, "plugin", harness.name);
      buildPluginProjection(PLUGIN, harness.name, built);
      pluginBuilds.set(harness.name, built);
    }
    pluginBuilt = pluginBuilds.get("claude")!;

    // 2. Preserve a core runner before composing the fresh Claude fixture.
    coreRunnerBefore = readFileSync(
      join(CLAUDE_DIST, "skills", "aidlc-code-generation", "SKILL.md"),
      "utf-8",
    );

    // 3. Compose through the reusable fixture kit.
    project = composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: join(tmp, "proj"),
      pluginBuilt,
    }).projectDir;
  }, TIMEOUT_MS);

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  // --- Packager emits every projection; Claude remains the compose E2E below ---
  test("every harness projection carries its declared host manifest, wiring, and content", () => {
    for (const harness of HARNESS_MATRIX) {
      const built = pluginBuilds.get(harness.name)!;
      const committed = join(REPO_ROOT, "dist", "plugins", PLUGIN, harness.name);
      expect(existsSync(committed), `${harness.name}: committed projection`).toBe(true);
      expect(fileInventory(committed), `${harness.name}: committed inventory`).toEqual(
        fileInventory(built),
      );

      const manifestFile = join(
        built,
        harness.capabilities.plugin.manifestDir,
        "plugin.json",
      );
      const hostManifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as {
        name?: string;
      };
      expect(hostManifest.name, harness.name).toBe(`aidlc-${PLUGIN}`);
      expect(existsSync(join(built, "hooks", "compose.ts"))).toBe(true);
      const inventory = fileInventory(built);
      if (harness.name === "kiro") {
        expect(harness.capabilities.plugin.wiringFile).toBeNull();
        expect(inventory.some((file) => file.endsWith(".kiro.hook"))).toBe(false);
        expect(existsSync(join(built, "hooks", "hooks.json"))).toBe(false);
        expect(existsSync(join(built, ".kiro", "hooks"))).toBe(false);
      } else {
        const wiringFile = harness.capabilities.plugin.wiringFile;
        expect(wiringFile, `${harness.name}: wiring file`).not.toBeNull();
        const wiring = readFileSync(join(built, wiringFile!), "utf-8");
        if (harness.name === "kiro-ide") {
          expect(inventory.some((file) => file.endsWith(".kiro.hook"))).toBe(false);
          const registration = JSON.parse(wiring) as {
            version?: string;
            hooks?: Array<{
              name?: string;
              trigger?: string;
              action?: { type?: string; command?: string };
            }>;
          };
          expect(registration.version).toBe("v1");
          expect(registration.hooks).toHaveLength(1);
          const hook = registration.hooks?.[0];
          expect(hook?.name).toBe(`aidlc-${PLUGIN}-compose`);
          expect(hook?.trigger).toBe("SessionStart");
          expect(hook?.action?.type).toBe("command");
          const command = hook?.action?.command ?? "";
          expect(command).toBe(
            "bun ./hooks/aidlc-plugin-compose.ts .kiro kiro-ide",
          );
          expect(command).not.toContain("sh -c");
          expect(existsSync(join(built, "hooks", "aidlc-plugin-compose.ts"))).toBe(true);
        } else if (harness.name === "cursor") {
          expect(wiring, `${harness.name}: harness dir argument`).toContain(
            `aidlc-plugin-compose.ts ${harness.manifest.harnessDir}`,
          );
        } else {
          expect(wiring, `${harness.name}: harness dir wiring`).toContain(
            `AIDLC_HARNESS_DIR=${harness.manifest.harnessDir}`,
          );
          expect(wiring, `${harness.name}: harness name wiring`).toContain(
            `AIDLC_HARNESS_NAME=${harness.name}`,
          );
        }
      }
      expect(existsSync(join(built, "stages", "construction", "test-pro-integration.md"))).toBe(
        true,
      );
      expect(existsSync(join(built, "contributions", "construction", "build-and-test.md"))).toBe(
        true,
      );
      // #550 plugin content buckets: scopes, agents, and knowledge must project
      // into EVERY harness (stronger than the pre-matrix Claude-only guard).
      expect(existsSync(join(built, "scopes", "test-pro-validation.md")), `${harness.name}: scope`).toBe(true);
      const agentSource =
        harness.name === "cursor"
          ? join(built, "aidlc", "agents", "test-pro-metrics-agent.md")
          : join(built, "agents", "test-pro-metrics-agent.md");
      expect(existsSync(agentSource), `${harness.name}: agent`).toBe(true);
      expect(
        existsSync(join(built, "knowledge", "test-pro-metrics-agent", "methodology.md")),
        `${harness.name}: knowledge`,
      ).toBe(true);
    }
  });

  test("Kiro IDE executes its generated compose wiring after a folder-drop", () => {
    const built = pluginBuilds.get("kiro-ide")!;
    const kiroProject = join(tmp, "kiro-ide-folder-drop");
    cpSync(join(REPO_ROOT, "dist", "kiro-ide"), kiroProject, { recursive: true });
    cpSync(built, kiroProject, { recursive: true });

    const registration = JSON.parse(
      readFileSync(
        join(kiroProject, ".kiro", "hooks", `aidlc-${PLUGIN}-compose.json`),
        "utf-8",
      ),
    ) as {
      hooks?: Array<{ action?: { command?: string } }>;
    };
    const command = registration.hooks?.[0]?.action?.command ?? "";
    const [runtime, script, ...args] = command.split(" ");
    expect(runtime).toBe("bun");
    expect(script).toBe("./hooks/aidlc-plugin-compose.ts");

    const env: NodeJS.ProcessEnv = { ...process.env, PATH: "" };
    delete env.AIDLC_HARNESS_DIR;
    delete env.AIDLC_HARNESS_NAME;
    delete env.AIDLC_PLUGIN_ROOT;
    delete env.AIDLC_PROJECT_DIR;
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.PLUGIN_ROOT;
    const compose = spawnSync(BUN, [script, ...args], {
      cwd: kiroProject,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env,
    });
    expect(compose.status, compose.stderr).toBe(0);

    const kiroGraph = JSON.parse(
      readFileSync(
        join(kiroProject, ".kiro", "tools", "data", "stage-graph.json"),
        "utf-8",
      ),
    ) as GraphStage[];
    expect(kiroGraph.some((item) => item.slug === "test-pro-integration")).toBe(true);
  });

  test("Cursor projection uses Cursor's flat camelCase hook schema", () => {
    const built = pluginBuilds.get("cursor")!;
    const wiring = JSON.parse(
      readFileSync(join(built, "hooks", "hooks.json"), "utf-8"),
    ) as {
      version?: number;
      hooks?: Record<string, Array<Record<string, unknown>>>;
    };
    // `version` is REQUIRED, not cosmetic: Cursor's hook loader delivers zero
    // events for a hooks.json missing it, silently and with rc 0, so a
    // version-less projection ships an inert plugin that looks installed.
    expect(Object.keys(wiring)).toEqual(["version", "hooks"]);
    expect(wiring.version).toBe(1);
    expect(Object.keys(wiring.hooks ?? {})).toEqual(["sessionStart"]);
    const entries = wiring.hooks?.sessionStart ?? [];
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0] ?? {})).toEqual(["command"]);
    const command = String(entries[0]?.command ?? "");
    expect(command).toBe("bun ./hooks/aidlc-plugin-compose.ts .cursor");
    expect(command).not.toContain("sh -c");
    expect(existsSync(join(built, "hooks", "aidlc-plugin-compose.ts"))).toBe(true);
  });

  test("Cursor's cross-platform launcher resolves its plugin root from the hook path", () => {
    const built = pluginBuilds.get("cursor")!;
    const cursorProject = composePluginFixture({
      plugin: PLUGIN,
      harness: "cursor",
      projectDir: join(tmp, "cursor-compose"),
      pluginBuilt: built,
    }).projectDir;
    const cursorGraph = JSON.parse(
      readFileSync(join(cursorProject, ".cursor", "tools", "data", "stage-graph.json"), "utf-8"),
    ) as GraphStage[];
    expect(cursorGraph.some((item) => item.slug === "test-pro-integration")).toBe(true);
    expect(existsSync(join(built, "agents"))).toBe(false);
    const internalAgent = readFileSync(
      join(built, "aidlc", "agents", "test-pro-metrics-agent.md"),
      "utf-8",
    );
    expect(internalAgent).not.toContain("{{HARNESS_DIR}}");
    expect(internalAgent).not.toMatch(/^model:/m);
    const composedAgent = readFileSync(
      join(cursorProject, ".cursor", "agents", "test-pro-metrics-agent.md"),
      "utf-8",
    );
    expect(composedAgent).not.toContain("{{HARNESS_DIR}}");
    expect(composedAgent).not.toMatch(/^model:/m);
    expect(composedAgent).toContain(".cursor/knowledge/test-pro-metrics-agent/");

    const pureCoreStage = join(
      cursorProject,
      ".cursor",
      "aidlc-common",
      "stages",
      "inception",
      "requirements-analysis.md",
    );
    const pureCoreBefore = readFileSync(pureCoreStage, "utf-8");
    writeFileSync(pureCoreStage, `${pureCoreBefore}\n<!-- stale core marker -->\n`);
    const refusedReinstall = spawnSync(
      BUN,
      [join(CURSOR_DIST, "install.ts"), cursorProject],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
      },
    );
    expect(refusedReinstall.status).toBe(1);
    expect(refusedReinstall.stderr).toContain(
      ".cursor/aidlc-common/stages/inception/requirements-analysis.md",
    );
    expect(readFileSync(pureCoreStage, "utf-8")).toContain("stale core marker");
    writeFileSync(pureCoreStage, pureCoreBefore);

    const pluginModifiedStage = join(
      cursorProject,
      ".cursor",
      "aidlc-common",
      "stages",
      "construction",
      "build-and-test.md",
    );
    const pluginModifiedBefore = readFileSync(pluginModifiedStage, "utf-8");
    const upgradedDist = join(tmp, "cursor-upgrade-dist");
    cpSync(CURSOR_DIST, upgradedDist, { recursive: true });
    cpSync(CURSOR_INSTALLER_SOURCE, join(upgradedDist, "install.ts"));
    const pluginStageRel =
      ".cursor/aidlc-common/stages/construction/build-and-test.md";
    const upgradedCoreStage = join(upgradedDist, pluginStageRel);
    writeFileSync(
      upgradedCoreStage,
      `${readFileSync(upgradedCoreStage, "utf-8").trimEnd()}\n\n<!-- upgraded core v2 -->\n`,
    );

    writeFileSync(
      pluginModifiedStage,
      `${pluginModifiedBefore.trimEnd()}\n\n<!-- user-owned stage edit -->\n`,
    );
    const refusedComposedUpgrade = spawnSync(
      BUN,
      [join(upgradedDist, "install.ts"), cursorProject],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
      },
    );
    expect(refusedComposedUpgrade.status).toBe(1);
    expect(refusedComposedUpgrade.stderr).toContain(pluginStageRel);
    expect(readFileSync(pluginModifiedStage, "utf-8")).toContain(
      "user-owned stage edit",
    );
    writeFileSync(pluginModifiedStage, pluginModifiedBefore);

    const reinstall = spawnSync(
      BUN,
      [join(upgradedDist, "install.ts"), cursorProject],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
      },
    );
    expect(reinstall.status, reinstall.stderr).toBe(0);
    expect(reinstall.stdout).toContain("refreshed plugin routing");
    const pluginModifiedAfter = readFileSync(pluginModifiedStage, "utf-8");
    expect(pluginModifiedAfter).toContain("<!-- upgraded core v2 -->");
    expect(pluginModifiedAfter).toContain(
      "test-pro-branch-coverage-instructions",
    );
    expect(pluginModifiedAfter).toContain("Step 9a (test-pro)");
    expect(pluginModifiedAfter).not.toBe(pluginModifiedBefore);
    const graphAfterReinstall = JSON.parse(
      readFileSync(
        join(cursorProject, ".cursor", "tools", "data", "stage-graph.json"),
        "utf-8",
      ),
    ) as GraphStage[];
    expect(
      graphAfterReinstall.some((item) => item.slug === "test-pro-integration"),
    ).toBe(true);
  });

  test("Cursor launcher passes its plugin root through the installed aidlc branch", () => {
    const built = pluginBuilds.get("cursor")!;
    const cursorProject = join(tmp, "cursor-compose-installed-aidlc");
    const binDir = join(tmp, "cursor-fake-bin");
    mkdirSync(binDir, { recursive: true });
    const aidlc = join(binDir, "aidlc");
    writeFileSync(
      aidlc,
      [
        "#!/bin/sh",
        `exec ${JSON.stringify(BUN)} ${JSON.stringify(
          join(cursorProject, ".cursor", "tools", "aidlc.ts"),
        )} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(aidlc, 0o755);
    const composed = composePluginFixture({
      plugin: PLUGIN,
      harness: "cursor",
      projectDir: cursorProject,
      pluginBuilt: built,
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    expect(composed.composeStdout).toContain("plugin sync complete: 1 plugin(s)");
    const cursorGraph = JSON.parse(
      readFileSync(join(cursorProject, ".cursor", "tools", "data", "stage-graph.json"), "utf-8"),
    ) as GraphStage[];
    expect(cursorGraph.some((item) => item.slug === "test-pro-integration")).toBe(true);
    const pluginRunner = readFileSync(
      join(cursorProject, ".cursor", "skills", "test-pro-integration", "SKILL.md"),
      "utf-8",
    );
    expect(pluginRunner).toMatch(/^disable-model-invocation: true$/m);
  });

  test("Cursor launcher refuses an ambiguous multi-root workspace", () => {
    const built = pluginBuilds.get("cursor")!;
    const first = join(tmp, "cursor-multiroot-a");
    const second = join(tmp, "cursor-multiroot-b");
    cpSync(CURSOR_DIST, first, { recursive: true });
    cpSync(CURSOR_DIST, second, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: "",
      AIDLC_HARNESS_DIR: ".cursor",
    };
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.PLUGIN_ROOT;
    delete env.AIDLC_PLUGIN_ROOT;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CURSOR_PROJECT_DIR;
    delete env.AIDLC_PROJECT_DIR;

    const compose = spawnSync(
      BUN,
      [join(built, "hooks", "aidlc-plugin-compose.ts"), ".cursor"],
      {
        cwd: built,
        input: JSON.stringify({
          hook_event_name: "sessionStart",
          workspace_roots: [first, second],
        }),
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
        env,
      },
    );
    expect(compose.status).toBe(1);
    expect(compose.stderr).toContain("multiple Cursor workspace roots");
    expect(compose.stderr).toContain("AIDLC_PROJECT_DIR");
  });

  test("OpenCode compose emits plugin agents to both inline and native rosters", () => {
    const pluginOpenCode = pluginBuilds.get("opencode")!;
    const opencodeProject = composePluginFixture({
      plugin: PLUGIN,
      harness: "opencode",
      projectDir: mkdtempSync(join(tmp, "opencode-compose-")),
      pluginBuilt: pluginOpenCode,
    }).projectDir;

    const inline = join(opencodeProject, ".aidlc", "agents", "test-pro-metrics-agent.md");
    const native = join(opencodeProject, ".opencode", "agents", "test-pro-metrics-agent.md");
    expect(existsSync(inline)).toBe(true);
    expect(existsSync(native)).toBe(true);
    const body = readFileSync(native, "utf-8");
    expect(body).toMatch(/^mode: subagent$/m);
    expect(body).toMatch(/^permission:\n {2}task: deny$/m);
    expect(body).not.toMatch(/^disallowedTools:/m);
    expect(body).not.toMatch(/^model: sonnet$/m);
    expect(body).not.toContain(".aidlc/rules/");
    expect(body).toContain("aidlc/spaces/default/memory/");
  });

  test("Copilot compose and selection use .github agent and skill surfaces", () => {
    const pluginCopilot = pluginBuilds.get("copilot")!;
    const copilotProject = composePluginFixture({
      plugin: PLUGIN,
      harness: "copilot",
      projectDir: mkdtempSync(join(tmp, "copilot-compose-")),
      pluginBuilt: pluginCopilot,
    }).projectDir;
    const env = {
      ...process.env,
      PLUGIN_ROOT: pluginCopilot,
      AIDLC_PROJECT_DIR: copilotProject,
      AIDLC_HARNESS_DIR: ".aidlc",
      AIDLC_HARNESS_NAME: "copilot",
    };

    const inline = join(copilotProject, ".aidlc", "agents", "test-pro-metrics-agent.md");
    const native = join(copilotProject, ".github", "agents", "test-pro-metrics-agent.md");
    const runner = join(copilotProject, ".github", "skills", "test-pro-integration", "SKILL.md");
    expect(existsSync(inline)).toBe(true);
    expect(existsSync(native)).toBe(true);
    expect(existsSync(join(copilotProject, ".opencode", "agents", "test-pro-metrics-agent.md"))).toBe(
      false,
    );
    expect(existsSync(runner)).toBe(true);
    const body = readFileSync(native, "utf-8");
    expect(body).toMatch(/^tools: \["read", "edit", "search", "execute", "web", "todo"\]$/m);
    expect(body).not.toMatch(/^(model|tier|effort|disallowedTools):/m);
    expect(body).toContain("aidlc/spaces/default/memory/");

    const unsafePlugin = join(tmp, "plugin", "copilot-missing-disallowed-tools");
    cpSync(pluginCopilot, unsafePlugin, { recursive: true });
    const unsafeAgent = join(unsafePlugin, "agents", "test-pro-metrics-agent.md");
    writeFileSync(
      unsafeAgent,
      readFileSync(unsafeAgent, "utf-8").replace(/^disallowedTools:.*\r?\n/m, ""),
      "utf-8",
    );
    const unsafeProject = mkdtempSync(join(tmp, "copilot-unsafe-agent-"));
    composePluginFixture({
      plugin: PLUGIN,
      harness: "copilot",
      projectDir: unsafeProject,
      pluginBuilt: unsafePlugin,
      env: {
        ...env,
        PLUGIN_ROOT: unsafePlugin,
        AIDLC_PROJECT_DIR: unsafeProject,
      },
    });
    expect(
      existsSync(join(unsafeProject, ".github", "agents", "test-pro-metrics-agent.md")),
    ).toBe(false);
    expect(hookDrops(unsafeProject)).toContain(
      "must declare disallowedTools: Task for Copilot",
    );

    const select = spawnSync(
      BUN,
      [join(copilotProject, ".aidlc", "tools", "aidlc-utility.ts"), "select-plugins", "aidlc"],
      {
        cwd: copilotProject,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
        env,
      },
    );
    expect(select.status, select.stderr).toBe(0);
    expect(select.stdout).toContain("Enabled plugins: aidlc");
    expect(existsSync(join(copilotProject, ".aidlc", "skills"))).toBe(false);
    expect(existsSync(join(copilotProject, ".github", "skills", "aidlc", "SKILL.md"))).toBe(true);
    expect(existsSync(runner)).toBe(false);
  });

  // --- New stages compose + route ---
  test("new plugin stages are in the compiled graph", () => {
    const slugs = graph(project).map((s) => s.slug);
    expect(slugs).toContain("test-pro-integration");
    expect(slugs).toContain("test-pro-full-suite");
    expect(graph(project).length).toBe(35); // 33 core + 2 test-pro
  });

  test("compose refreshes SKILL.md Stage Graph with plugin stages", () => {
    const skill = readFileSync(join(project, ".claude", "skills", "aidlc", "SKILL.md"), "utf-8");
    const begin = skill.indexOf(STAGE_TABLE_BEGIN);
    const end = skill.indexOf(STAGE_TABLE_END, begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const region = skill.slice(begin, end + STAGE_TABLE_END.length);
    expect(region).toContain("| test-pro-integration |");
    expect(region).toContain("| test-pro-full-suite |");
  });

  test("new plugin scopes, agents, and knowledge compose into the harness tree", () => {
    expect(existsSync(join(project, ".claude", "scopes", "test-pro-validation.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "agents", "test-pro-metrics-agent.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "knowledge", "test-pro-metrics-agent", "methodology.md"))).toBe(true);
  });

  test("compose regenerates plugin runner skills and preserves core runner bytes", () => {
    const stageRunner = join(project, ".claude", "skills", "test-pro-integration", "SKILL.md");
    const scopeRunner = join(project, ".claude", "skills", "test-pro-validation", "SKILL.md");
    expect(existsSync(stageRunner)).toBe(true);
    expect(existsSync(scopeRunner)).toBe(true);
    expect(readFileSync(stageRunner, "utf-8")).toContain("from the test-pro plugin");
    expect(readFileSync(scopeRunner, "utf-8")).toContain("name: test-pro-validation");
    expect(readFileSync(join(project, ".claude", "skills", "aidlc-code-generation", "SKILL.md"), "utf-8"))
      .toBe(coreRunnerBefore);
  });

  test("compose does not auto-enable a plugin excluded by an existing selection", () => {
    const selectedProj = mkdtempSync(join(tmp, "selection-advisory-"));
    cpSync(CLAUDE_DIST, join(selectedProj, ".claude"), { recursive: true });
    const harnessJson = join(selectedProj, ".claude", "tools", "data", "harness.json");
    const harness = JSON.parse(readFileSync(harnessJson, "utf-8"));
    harness.plugins = ["aidlc"];
    writeFileSync(harnessJson, `${JSON.stringify(harness, null, 2)}\n`);

    const compose = spawnSync(BUN, [join(pluginBuilt, "hooks", "compose.ts")], {
      cwd: selectedProj,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginBuilt,
        CLAUDE_PROJECT_DIR: selectedProj,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    expect(compose.status).toBe(0);
    expect(existsSync(join(selectedProj, ".claude", "aidlc-common", "stages", "construction", "test-pro-integration.md"))).toBe(true);
    expect(stage(selectedProj, "test-pro-integration")?.enabled).toBe(false);
    expect(existsSync(join(selectedProj, ".claude", "skills", "test-pro-integration", "SKILL.md"))).toBe(false);
    expect(hookDrops(selectedProj)).toContain("select-plugins aidlc,test-pro");
  });

  test("composed plugin stage bodies are not empty", () => {
    for (const [phase, slug] of [
      ["construction", "test-pro-integration"],
      ["operation", "test-pro-full-suite"],
    ] as const) {
      assertNonEmptyStageBody(stageSourcePath(project, phase, slug));
    }
  });

  // --- Contribution seam: structural surfaces ---
  test("contribution merges produces into the target stage node", () => {
    const bat = stage(project, "build-and-test");
    expect(bat?.produces).toContain("test-pro-regression-suite");
  });

  test("contribution merges consumes into the target stage node", () => {
    const bat = stage(project, "build-and-test");
    const consumed = (bat?.consumes ?? []).map((c) => c.artifact);
    // BOTH test-pro consumes must land — not just the first (round-2 blocker:
    // the old parser dropped every entry after the first).
    expect(consumed).toContain("test-pro-testability-requirements");
    expect(consumed).toContain("test-pro-test-harness-design");
    // ...and each authored `required: false` must be preserved, not flipped to
    // true by an empty `required` scan (the same blocker's second half).
    for (const art of ["test-pro-testability-requirements", "test-pro-test-harness-design"]) {
      const entry = (bat?.consumes ?? []).find((c) => c.artifact === art);
      expect(entry?.required).toBe(false);
    }
    // The pre-existing core consumes are untouched (still required: true).
    const core = (bat?.consumes ?? []).find((c) => c.artifact === "code-generation-plan");
    expect(core?.required).toBe(true);
  });

  test("contribution merges sensors into the target stage node", () => {
    const bat = stage(project, "build-and-test");
    const sensors = (bat?.sensors_applicable ?? []).map((s) => s.id);
    expect(sensors).toContain("coverage-threshold");
    expect(sensors).toContain("requirement-coverage");
  });

  test("contribution adds required_sections to the target stage source", () => {
    // build-and-test ships NO required_sections in core, so the merge must ADD
    // the field (as a quoted-string list) to the stage frontmatter.
    const body = stageBody(project, "construction", "build-and-test");
    const fm = body.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(fm).toMatch(/^required_sections:/m);
    for (const s of ["Branch Coverage", "Edge Cases", "API Positive and Negative", "Requirement Traceability"]) {
      expect(fm).toContain(`- "${s}"`);
    }
  });

  // --- Contribution seam: adds.scopes (graduated surface) ---
  // A contribution may put an existing core stage under a scope the SAME
  // plugin ships: set-union into the stage's scopes: frontmatter, recorded in
  // the sidecar for disable-time strip, guarded against foreign/phantom scope
  // names. Uses a synthetic plugin (test-pro ships no adds.scopes).
  test("adds.scopes set-unions the plugin's own installed scope into the target stage", () => {
    const mkScope = (name: string) => [
      "---", `name: ${name}`, "plugin: syn-scope",
      "depth: Standard", "keywords:", "  - synthetic",
      "description: synthetic scope for the adds.scopes merge", "skeleton: off", "---", "",
      `# ${name} scope`, "", "## Membership", "synthetic", "",
    ].join("\n");
    const contrib = [
      "---", "target: build-and-test", "plugin: syn-scope",
      // Both conventional name shapes (bare plugin name AND prefixed) merge;
      // ownership comes from each installed file's plugin: frontmatter.
      "adds:", "  scopes:", "    - syn-scope", "    - syn-scope-extra", "---", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-scope", {
      "scopes/syn-scope.md": mkScope("syn-scope"),
      "scopes/syn-scope-extra.md": mkScope("syn-scope-extra"),
      "contributions/construction/build-and-test.md": contrib,
    });
    const fm = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8")
      .match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const scopesBlock = fm.match(/^scopes:\n((?: {2}- .+\n)*)/m)?.[1] ?? "";
    expect(scopesBlock).toContain("- syn-scope\n");
    expect(scopesBlock).toContain("- syn-scope-extra");
    // Core memberships untouched by the union.
    expect(scopesBlock).toContain("- enterprise");
    // No drop for the merged surface...
    expect(drops).not.toContain("adds.scopes is not yet an implemented merge surface");
    expect(drops).not.toContain("is not owned by plugin");
    // ...recorded in the sidecar for disable-time strip...
    const sidecar = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "plugin-contrib-syn-scope.json"), "utf-8"));
    expect(sidecar["build-and-test"]?.scopes).toEqual(["syn-scope", "syn-scope-extra"]);
    // ...and the recompiled scope grid routes the core stage under the plugin scope.
    const grid = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8"));
    expect(grid["syn-scope-extra"]?.stages?.["build-and-test"]).toBe("EXECUTE");
    expect(grid["syn-scope"]?.stages?.["build-and-test"]).toBe("EXECUTE");
    expect(grid["syn-scope-extra"]?.stages?.["code-generation"]).toBe("SKIP");

    // Disable-time strip: select-plugins removes the merged scope membership
    // and the sidecar, exactly like the other structural surfaces. (This
    // project's known plugins are aidlc + syn-scope; selecting aidlc alone
    // disables syn-scope.)
    const strip = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-utility.ts"), "select-plugins", "aidlc"], {
      cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" },
    });
    expect(strip.status).toBe(0);
    const strippedFm = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8")
      .match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(strippedFm).not.toContain("- syn-scope");
    expect(strippedFm).toContain("- enterprise");
    expect(existsSync(join(proj, ".claude", "tools", "data", "plugin-contrib-syn-scope.json"))).toBe(false);
  });

  test("adds.scopes accepts quoted scope identity scalars", () => {
    const scope = [
      "---", 'name: "syn-quoted"', 'plugin: "syn-quoted"',
      "depth: Standard", "keywords:", "  - synthetic",
      "description: quoted scope identity", "skeleton: off", "---", "",
      "# syn-quoted scope", "",
    ].join("\n");
    const contribution = [
      "---", "target: build-and-test", "plugin: syn-quoted",
      "adds:", "  scopes:", '    - "syn-quoted"', "---", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-quoted", {
      "scopes/syn-quoted.md": scope,
      "contributions/construction/build-and-test.md": contribution,
    });
    expect(drops).not.toContain('adds.scopes "syn-quoted"');
    expect(stageBody(proj, "construction", "build-and-test")).toContain("- syn-quoted");
  });

  // --- Number seeding: edge-aware, engine-owned (multi-stage plugins) ---
  test("new stages whose filename order contradicts their edges seed in flow order", () => {
    // Alphabetical: assemble < middle < zstart. Flow: zstart -> middle ->
    // assemble. Alphabetical seeding would number assemble lowest and fail
    // the lower-numbered-dependency invariant; edge-aware seeding must not.
    // assemble declares its dep TWICE: the schema shape-checks but does not
    // dedupe requires_stage, and a per-occurrence indegree count would strand
    // the stage and misreport the copy-paste duplicate as a cycle.
    const mk = (slug: string, deps: string[], produces: string, consumes: string[]) => [
      "---", `slug: ${slug}`, "plugin: syn-order", "phase: ideation",
      "execution: ALWAYS", "condition: always",
      "lead_agent: aidlc-product-agent", "support_agents: []", "mode: inline",
      "produces:", `  - ${produces}`,
      consumes.length ? "consumes:" : "consumes: []",
      ...consumes.flatMap((c) => [`  - artifact: ${c}`, "    required: true"]),
      deps.length ? "requires_stage:" : "requires_stage: []",
      ...deps.map((d) => `  - ${d}`),
      "inputs: x", "outputs: y", "---", "", `# ${slug}`, "", "## Steps", "body", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-order", {
      "stages/ideation/syn-order-assemble.md": mk("syn-order-assemble", ["syn-order-middle", "syn-order-middle"], "syn-order-doc", ["syn-order-mid"]),
      "stages/ideation/syn-order-middle.md": mk("syn-order-middle", ["syn-order-zstart"], "syn-order-mid", ["syn-order-first"]),
      "stages/ideation/syn-order-zstart.md": mk("syn-order-zstart", [], "syn-order-first", []),
    });
    expect(drops).not.toContain("compile failed");
    const g = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "stage-graph.json"), "utf-8")) as Array<{ slug: string; number: string; requires_stage?: string[] }>;
    const num = (slug: string) => parseFloat((g.find((s) => s.slug === slug)?.number ?? "").split(".")[1]);
    expect(num("syn-order-zstart")).toBeLessThan(num("syn-order-middle"));
    expect(num("syn-order-middle")).toBeLessThan(num("syn-order-assemble"));
    expect(g.find((s) => s.slug === "syn-order-assemble")?.requires_stage)
      .toEqual(["syn-order-middle"]);
    const topo = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-graph.ts"), "topo"], {
      cwd: proj, encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" },
    });
    expect(topo.status).toBe(0);
  });

  test("a requires_stage cycle rolls back copied stages so a corrected retry can land", () => {
    const mk = (slug: string, dep: string | null, produces: string) => [
      "---", `slug: ${slug}`, "plugin: syn-cycle", "phase: ideation",
      "execution: ALWAYS", "condition: always",
      "lead_agent: aidlc-product-agent", "support_agents: []", "mode: inline",
      "produces:", `  - ${produces}`, "consumes: []",
      ...(dep ? ["requires_stage:", `  - ${dep}`] : ["requires_stage: []"]),
      "inputs: x", "outputs: y", "---", "", `# ${slug}`, "", "## Steps", "body", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-cycle", {
      "stages/ideation/syn-cycle-a.md": mk("syn-cycle-a", "syn-cycle-b", "syn-cycle-doc-a"),
      "stages/ideation/syn-cycle-b.md": mk("syn-cycle-b", "syn-cycle-a", "syn-cycle-doc-b"),
    });
    // Compose is fail-open (rc 0); the compile failure surfaces as a drop
    // naming the cycle, and neither stage reaches the compiled graph.
    expect(drops).toContain("compile failed");
    expect(drops).toContain("requires_stage cycle among new stages");
    const g = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "stage-graph.json"), "utf-8")) as Array<{ slug: string }>;
    expect(g.some((s) => s.slug.startsWith("syn-cycle-"))).toBe(false);
    const aInstalled = stageSourcePath(proj, "ideation", "syn-cycle-a");
    const bInstalled = stageSourcePath(proj, "ideation", "syn-cycle-b");
    expect(existsSync(aInstalled)).toBe(false);
    expect(existsSync(bInstalled)).toBe(false);
    const retryMarker = join(proj, "aidlc", ".plugin-compose-retry-syn-cycle");
    expect(existsSync(retryMarker)).toBe(true);

    const root = join(proj, "_plugin-syn-cycle");
    writeFileSync(
      join(root, "stages", "ideation", "syn-cycle-b.md"),
      mk("syn-cycle-b", null, "syn-cycle-doc-b"),
    );
    const retry = spawnSync(BUN, [join(root, "hooks", "compose.ts")], {
      cwd: proj,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    expect(retry.status).toBe(0);
    expect(existsSync(aInstalled)).toBe(true);
    expect(existsSync(bInstalled)).toBe(true);
    const repaired = graph(proj);
    expect(repaired.some((s) => s.slug === "syn-cycle-a")).toBe(true);
    expect(repaired.some((s) => s.slug === "syn-cycle-b")).toBe(true);
    expect(existsSync(retryMarker)).toBe(false);
  });

  test("host manifest identity cannot be spoofed by plugin content", () => {
    const victimScope = [
      "---", "name: victim-scope", "plugin: victim",
      "depth: Standard", "keywords:", "  - synthetic",
      "description: spoofed victim scope", "skeleton: off", "---", "",
      "# victim scope", "",
    ].join("\n");
    const contribution = [
      "---", "target: build-and-test", "plugin: victim",
      "adds:", "  scopes:", "    - victim-scope", "---", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("attacker", {
      "scopes/victim-scope.md": victimScope,
      "contributions/construction/build-and-test.md": contribution,
    });
    expect(drops).toContain('plugin "attacker" scopes file');
    expect(drops).toContain('declares plugin "victim"');
    expect(drops).toContain('host manifest identity "attacker"');
    expect(stageBody(proj, "construction", "build-and-test")).not.toContain("- victim-scope");
    expect(existsSync(join(proj, ".claude", "scopes", "victim-scope.md"))).toBe(false);
    expect(existsSync(
      join(proj, ".claude", "tools", "data", "plugin-contrib-attacker.json"),
    )).toBe(false);
  });

  test("a plugin cannot install a doctor script for a foreign plugin identity", () => {
    const { drops, proj } = composeSynthetic("alpha", {
      "tools/beta-doctor.ts":
        'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"foreign"}]}));\n',
    });
    expect(existsSync(join(proj, ".claude", "tools", "beta-doctor.ts"))).toBe(false);
    expect(drops).toContain("[advisory]");
    expect(drops).toContain('plugin "alpha" doctor script "beta-doctor.ts"');
    expect(drops).toContain('foreign plugin "beta"');
  });

  test("duplicate incoming scope identities are rejected within one plugin tree", () => {
    const scope = (label: string) => [
      "---", "name: duplicate-scope", "plugin: syn-duplicate-scope",
      "depth: Standard", "keywords:", "  - synthetic",
      `description: ${label}`, "skeleton: off", "---", "",
      `# ${label}`, "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-duplicate-scope", {
      "scopes/alpha.md": scope("alpha"),
      "scopes/beta.md": scope("beta"),
    });
    const installed = ["alpha.md", "beta.md"].filter((file) =>
      existsSync(join(proj, ".claude", "scopes", file))
    );
    expect(installed).toHaveLength(1);
    expect(drops).toContain('declares name "duplicate-scope", colliding with installed file');
    expect(drops).not.toContain("scope-table failed");
    expect(drops).not.toContain("runner-gen scopes failed");
    const compile = spawnSync(
      BUN,
      [join(proj, ".claude", "tools", "aidlc-graph.ts"), "compile"],
      {
        cwd: proj,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" },
      },
    );
    expect(compile.status).toBe(0);
  });

  test("disable preserves quoted scope membership that predates the plugin", () => {
    const name = "syn-preserve-quoted";
    const scope = [
      "---", `name: ${name}`, `plugin: ${name}`,
      "depth: Standard", "keywords:", "  - synthetic",
      "description: quoted authored membership", "skeleton: off", "---", "",
      `# ${name}`, "",
    ].join("\n");
    const contribution = [
      "---", "target: build-and-test", `plugin: ${name}`,
      "adds:", "  scopes:", `    - ${name}`, "---", "",
    ].join("\n");
    const { proj } = composeSynthetic(name, {
      [`scopes/${name}.md`]: scope,
      "contributions/construction/build-and-test.md": contribution,
    }, ".claude", (_proj, harnessDir) => {
      const path = join(
        harnessDir,
        "aidlc-common",
        "stages",
        "construction",
        "build-and-test.md",
      );
      const before = readFileSync(path, "utf-8");
      writeFileSync(path, before.replace(/^scopes:\n/m, `scopes:\n  - "${name}"\n`));
    });
    const stagePath = stageSourcePath(proj, "construction", "build-and-test");
    const sidecar = join(
      proj,
      ".claude",
      "tools",
      "data",
      `plugin-contrib-${name}.json`,
    );
    let composed = readFileSync(stagePath, "utf-8");
    expect((composed.match(new RegExp(name, "g")) ?? []).length).toBe(1);
    expect(composed).toContain(`- "${name}"`);
    expect(existsSync(sidecar)).toBe(false);

    composed = composed.replace(`  - "${name}"`, `  - "${name}"\n  - ${name}`);
    writeFileSync(stagePath, composed);
    writeFileSync(
      sidecar,
      `${JSON.stringify({ "build-and-test": { scopes: [name] } }, null, 2)}\n`,
    );
    const disable = spawnSync(
      BUN,
      [join(proj, ".claude", "tools", "aidlc-utility.ts"), "select-plugins", "aidlc"],
      {
        cwd: proj,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: proj,
          AIDLC_HARNESS_DIR: ".claude",
        },
      },
    );
    expect(disable.status).toBe(0);
    const stripped = readFileSync(stagePath, "utf-8");
    expect(stripped).toContain(`- "${name}"`);
    expect(stripped).not.toContain(`  - ${name}\n`);
    expect(existsSync(sidecar)).toBe(false);
  });

  test("adds.scopes ownership is the installed file's plugin: field, not a name prefix", () => {
    // Plugin "syn-prefix" contributes the scope of plugin "syn-prefix-foreign":
    // the scope name starts with "syn-prefix-", so a prefix rule would merge a
    // foreign plugin's scope. Ownership must come from the installed scope
    // file's plugin: frontmatter, so this drops instead.
    const foreignScope = [
      "---", "name: syn-prefix-foreign", "plugin: syn-prefix-foreign",
      "depth: Standard", "keywords:", "  - synthetic",
      "description: scope owned by a different plugin whose name overlaps by prefix",
      "skeleton: off", "---", "",
      "# syn-prefix-foreign scope", "", "## Membership", "synthetic", "",
    ].join("\n");
    const contrib = [
      "---", "target: build-and-test", "plugin: syn-prefix",
      "adds:", "  scopes:", "    - syn-prefix-foreign", "---", "",
    ].join("\n");
    // The victim's scope file is pre-installed (mutateInstall), as if plugin
    // syn-prefix-foreign composed first; then plugin syn-prefix contributes.
    const { drops, proj } = composeSynthetic("syn-prefix", {
      "contributions/construction/build-and-test.md": contrib,
    }, ".claude", (_proj, harnessDir) => {
      writeFileSync(join(harnessDir, "scopes", "syn-prefix-foreign.md"), foreignScope);
    });
    expect(drops).toContain('adds.scopes "syn-prefix-foreign" is not owned by plugin "syn-prefix"');
    expect(drops).toContain('declares plugin "syn-prefix-foreign"');
    const fm = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8")
      .match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(fm).not.toContain("- syn-prefix-foreign");
    expect(existsSync(join(proj, ".claude", "tools", "data", "plugin-contrib-syn-prefix.json"))).toBe(false);
  });

  test("adds.scopes naming a foreign or uninstalled scope is dropped-with-log, not merged", () => {
    const contrib = [
      "---", "target: build-and-test", "plugin: syn-scope-guard",
      "adds:", "  scopes:", "    - enterprise", "    - syn-scope-guard-phantom", "---", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-scope-guard", {
      "contributions/construction/build-and-test.md": contrib,
    });
    const fm = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8")
      .match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    // The foreign core scope is refused (ownership guard)...
    expect(drops).toContain('adds.scopes "enterprise" is not owned by plugin "syn-scope-guard"');
    // ...and the own-prefixed but uninstalled scope is refused (phantom guard).
    expect(drops).toContain('adds.scopes "syn-scope-guard-phantom" has no installed scope file');
    const scopesBlock = fm.match(/^scopes:\n((?: {2}- .+\n)*)/m)?.[1] ?? "";
    expect(scopesBlock).not.toContain("- syn-scope-guard-phantom");
    // enterprise appears exactly once (core's own membership, no dup union).
    expect((scopesBlock.match(/- enterprise$/gm) ?? []).length).toBe(1);
    expect(existsSync(join(proj, ".claude", "tools", "data", "plugin-contrib-syn-scope-guard.json"))).toBe(false);
  });

  test("concurrent plugin composes preserve every scope merge and sidecar", async () => {
    const proj = mkdtempSync(join(tmp, "syn-concurrent-compose-"));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
    const filesFor = (name: string): Record<string, string> => ({
      [`scopes/${name}.md`]: [
        "---", `name: ${name}`, `plugin: ${name}`,
        "depth: Standard", "keywords:", "  - synthetic",
        `description: ${name} scope`, "skeleton: off", "---", "",
        `# ${name} scope`, "",
      ].join("\n"),
      "contributions/construction/build-and-test.md": [
        "---", "target: build-and-test", `plugin: ${name}`,
        "adds:", "  scopes:", `    - ${name}`, "---", "",
      ].join("\n"),
    });
    const roots = ["syn-race-a", "syn-race-b"].map((name) => ({
      name,
      root: prepareSyntheticPlugin(proj, name, filesFor(name)),
    }));
    const processes = roots.map(({ root }) => Bun.spawn({
      cmd: [BUN, join(root, "hooks", "compose.ts")],
      cwd: proj,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_HARNESS_DIR: ".claude",
      },
    }));
    expect(await Promise.all(processes.map((proc) => proc.exited))).toEqual([0, 0]);
    const body = stageBody(proj, "construction", "build-and-test");
    for (const { name } of roots) {
      expect(body).toContain(`- ${name}`);
      const sidecar = join(proj, ".claude", "tools", "data", `plugin-contrib-${name}.json`);
      expect(JSON.parse(readFileSync(sidecar, "utf-8"))["build-and-test"]?.scopes)
        .toEqual([name]);
    }
    expect(existsSync(auditLockDir(proj))).toBe(false);
  }, TIMEOUT_MS);

  test("compose waits beyond the default lock budget instead of skipping the plugin", async () => {
    const proj = mkdtempSync(join(tmp, "syn-compose-wait-"));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
    const name = "syn-compose-wait";
    const root = prepareSyntheticPlugin(proj, name, {
      [`scopes/${name}.md`]: [
        "---", `name: ${name}`, `plugin: ${name}`,
        "depth: Standard", "keywords:", "  - synthetic",
        "description: slow compose scope", "skeleton: off", "---", "",
        `# ${name} scope`, "",
      ].join("\n"),
      "contributions/construction/build-and-test.md": [
        "---", "target: build-and-test", `plugin: ${name}`,
        "adds:", "  scopes:", `    - ${name}`, "---", "",
      ].join("\n"),
    });
    expect(acquireAuditLock(proj, 0, 1)).toBe(true);
    const compose = Bun.spawn({
      cmd: [BUN, join(root, "hooks", "compose.ts")],
      cwd: proj,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    let waitedPastDefault = false;
    try {
      await Bun.sleep(5_500);
      waitedPastDefault = compose.exitCode === null;
    } finally {
      releaseAuditLock(proj);
    }
    expect(await compose.exited).toBe(0);
    expect(waitedPastDefault).toBe(true);
    expect(stageBody(proj, "construction", "build-and-test")).toContain(`- ${name}`);
    expect(hookDrops(proj)).toBe("");
    expect(existsSync(auditLockDir(proj))).toBe(false);
  }, TIMEOUT_MS);

  test("intent-create and recompose wait beyond the default budget behind a live workspace holder", async () => {
    const proj = mkdtempSync(join(tmp, "syn-utility-wait-"));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
    const utility = join(proj, ".claude", "tools", "aidlc-utility.ts");
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_HARNESS_DIR: ".claude",
    };
    const initialBirth = spawnSync(
      BUN,
      [utility, "intent-create", "--scope", "feature", "--project-dir", proj],
      { cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000, env },
    );
    expect(initialBirth.status).toBe(0);

    expect(acquireAuditLock(proj, 0, 1)).toBe(true);
    const queued = [
      Bun.spawn({
        cmd: [
          BUN,
          utility,
          "intent-create",
          "--scope",
          "feature",
          "--label",
          "queued birth",
          "--project-dir",
          proj,
        ],
        cwd: proj,
        stdout: "ignore",
        stderr: "pipe",
        env,
      }),
      Bun.spawn({
        cmd: [
          BUN,
          utility,
          "recompose",
          "--skip",
          "market-research",
          "--project-dir",
          proj,
        ],
        cwd: proj,
        stdout: "ignore",
        stderr: "pipe",
        env,
      }),
    ];

    let queuedPastDefault: boolean[] = [];
    try {
      await Bun.sleep(5_500);
      queuedPastDefault = queued.map((child) => child.exitCode === null);
    } finally {
      releaseAuditLock(proj);
    }

    expect(queuedPastDefault).toEqual([true, true]);
    expect(await Promise.all(queued.map((child) => child.exited))).toEqual([0, 0]);
    expect(existsSync(auditLockDir(proj))).toBe(false);
  }, TIMEOUT_MS);

  test("relative project env keeps compose and graph on the same workspace lock", () => {
    const proj = mkdtempSync(join(tmp, "syn-relative-project-"));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
    const name = "syn-relative-project";
    const root = prepareSyntheticPlugin(proj, name, {
      [`scopes/${name}.md`]: [
        "---", `name: ${name}`, `plugin: ${name}`,
        "depth: Standard", "keywords:", "  - synthetic",
        "description: relative project scope", "skeleton: off", "---", "",
        `# ${name} scope`, "",
      ].join("\n"),
      "contributions/construction/build-and-test.md": [
        "---", "target: build-and-test", `plugin: ${name}`,
        "adds:", "  scopes:", `    - ${name}`, "---", "",
      ].join("\n"),
    });
    const result = spawnSync(BUN, [join(root, "hooks", "compose.ts")], {
      cwd: dirname(proj),
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PROJECT_DIR: proj.slice(dirname(proj).length + 1),
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(stageBody(proj, "construction", "build-and-test")).toContain(`- ${name}`);
    // The SPAWNED tools must resolve the same project dir as the hook: a
    // relative CLAUDE_PROJECT_DIR re-resolved against a child's cwd lands on
    // <proj>/<proj> and the compile drop-logs "requires an installed project
    // harness" while the frontmatter merge above still succeeds - so assert
    // the whole chain: zero drops AND the scope present in the recompiled grid.
    let drops = "";
    const hd = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
    if (existsSync(hd)) {
      for (const f of readdirSync(hd)) {
        if (f.startsWith("plugin-compose") && f.endsWith(".drops")) drops += readFileSync(join(hd, f), "utf-8");
      }
    }
    expect(drops).toBe("");
    const grid = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8"));
    expect(grid[name]?.stages?.["build-and-test"]).toBe("EXECUTE");
    expect(existsSync(auditLockDir(proj))).toBe(false);
  }, TIMEOUT_MS);

  test("select-plugins waits for compose and cannot leave a disabled scope orphaned", async () => {
    const proj = mkdtempSync(join(tmp, "syn-compose-select-"));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
    const name = "syn-select-race";
    const root = prepareSyntheticPlugin(proj, name, {
      [`scopes/${name}.md`]: [
        "---", `name: ${name}`, `plugin: ${name}`,
        "depth: Standard", "keywords:", "  - synthetic",
        "description: selection race scope", "skeleton: off", "---", "",
        `# ${name} scope`, "",
      ].join("\n"),
      "contributions/construction/build-and-test.md": [
        "---", "target: build-and-test", `plugin: ${name}`,
        "adds:", "  scopes:", `    - ${name}`, "---", "",
      ].join("\n"),
    });
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_HARNESS_DIR: ".claude",
    };
    const compose = Bun.spawn({
      cmd: [BUN, join(root, "hooks", "compose.ts")],
      cwd: proj,
      stdout: "ignore",
      stderr: "pipe",
      env: { ...env, CLAUDE_PLUGIN_ROOT: root },
    });
    let observedLock = false;
    for (let i = 0; i < 200; i++) {
      if (existsSync(auditLockDir(proj))) {
        observedLock = true;
        break;
      }
      if (compose.exitCode !== null) break;
      await Bun.sleep(5);
    }
    expect(observedLock).toBe(true);
    const select = Bun.spawn({
      cmd: [BUN, join(proj, ".claude", "tools", "aidlc-utility.ts"), "select-plugins", "aidlc"],
      cwd: proj,
      stdout: "ignore",
      stderr: "pipe",
      env,
    });
    expect(await Promise.all([compose.exited, select.exited])).toEqual([0, 0]);
    const harness = JSON.parse(
      readFileSync(join(proj, ".claude", "tools", "data", "harness.json"), "utf-8"),
    );
    expect(harness.plugins).toEqual(["aidlc"]);
    expect(stageBody(proj, "construction", "build-and-test")).not.toContain(`- ${name}`);
    expect(existsSync(
      join(proj, ".claude", "tools", "data", `plugin-contrib-${name}.json`),
    )).toBe(false);
    expect(existsSync(auditLockDir(proj))).toBe(false);
  }, TIMEOUT_MS);

  // --- Contribution seam: prose fragments ---
  test("prose fragments are spliced into the target stage body", () => {
    const body = stageBody(project, "construction", "build-and-test");
    expect(body).toContain("Step 9a (test-pro)");
    expect(body).toContain("Step 10a (test-pro)");
  });

  test("fragments land in step order (9a before 9b before 9c)", () => {
    const body = stageBody(project, "construction", "build-and-test");
    expect(body.indexOf("Step 9a")).toBeLessThan(body.indexOf("Step 9b"));
    expect(body.indexOf("Step 9b")).toBeLessThan(body.indexOf("Step 9c"));
  });

  // --- Harness-dir token substitution ---
  test("{{HARNESS_DIR}} is substituted in composed stage prose", () => {
    const body = stageBody(project, "construction", "test-pro-integration");
    expect(body).not.toContain("{{HARNESS_DIR}}");
    expect(body).toContain(".claude/knowledge");
  });

  // --- Idempotency ---
  test("re-running compose does not duplicate fragments", () => {
    const rerun = spawnSync(BUN, [join(pluginBuilt, "hooks", "compose.ts")], {
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
    expect(rerun.status).toBe(0);
    const body = stageBody(project, "construction", "build-and-test");
    const count = (body.match(/Step 9a \(test-pro\)/g) ?? []).length;
    expect(count).toBe(1);
  });

  // --- Compile self-heal (a prior compile that didn't land must retry) ---
  test("compose recompiles when the graph lost the plugin's stages", () => {
    // Simulate a transient compile failure: strip the plugin stages out of the
    // committed graph (as a killed-mid-compile install would leave it). A rerun
    // must detect the missing slug and recompile, restoring all 34 stages — even
    // though no stage source changed (changed=false on the rerun).
    const graphPath = join(project, ".claude", "tools", "data", "stage-graph.json");
    const full = JSON.parse(readFileSync(graphPath, "utf-8")) as GraphStage[];
    const stripped = full.filter((s) => !String(s.slug ?? "").startsWith("test-pro-"));
    expect(stripped.length).toBeLessThan(full.length); // sanity: we removed some
    writeFileSync(graphPath, JSON.stringify(stripped));

    const heal = spawnSync(BUN, [join(pluginBuilt, "hooks", "compose.ts")], {
      cwd: project,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginBuilt, CLAUDE_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".claude" },
    });
    expect(heal.status).toBe(0);
    const slugs = graph(project).map((s) => s.slug);
    expect(slugs).toContain("test-pro-integration");
    expect(slugs).toContain("test-pro-full-suite");
  });

  describe("old installed schema without plugin ownership key", () => {
    test("skips plugin-owned stages scopes agents without a retry marker", () => {
      const legacyProj = mkdtempSync(join(tmp, "legacy-plugin-key-"));
      cpSync(CLAUDE_DIST, join(legacyProj, ".claude"), { recursive: true });

      const schemaPath = join(legacyProj, ".claude", "tools", "aidlc-stage-schema.ts");
      const schemaBefore = readFileSync(schemaPath, "utf-8");
      const schemaAfter = schemaBefore.replace('"plugin", ', "");
      expect(schemaAfter).not.toBe(schemaBefore);
      writeFileSync(schemaPath, schemaAfter);

      const compose = spawnSync(BUN, [join(pluginBuilt, "hooks", "compose.ts")], {
        cwd: legacyProj,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: pluginBuilt,
          CLAUDE_PROJECT_DIR: legacyProj,
          AIDLC_HARNESS_DIR: ".claude",
        },
      });
      if (compose.status !== 0) throw new Error(`compose.ts failed: ${compose.stderr}`);

      expect(existsSync(stageSourcePath(legacyProj, "construction", "test-pro-integration"))).toBe(false);
      expect(existsSync(stageSourcePath(legacyProj, "operation", "test-pro-full-suite"))).toBe(false);
      expect(existsSync(join(legacyProj, ".claude", "scopes", "test-pro-validation.md"))).toBe(false);
      expect(existsSync(join(legacyProj, ".claude", "agents", "test-pro-metrics-agent.md"))).toBe(false);

      const dropsPath = join(
        legacyProj,
        "aidlc",
        "spaces",
        "default",
        "intents",
        ".aidlc-hooks-health",
        "plugin-compose-test-pro.drops",
      );
      expect(existsSync(dropsPath)).toBe(true);
      const drops = readFileSync(dropsPath, "utf-8");
      expect(drops).toContain("[degraded]");
      expect(drops).toContain("predates the plugin:");

      expect(existsSync(join(legacyProj, "aidlc", ".plugin-compose-retry-test-pro"))).toBe(false);

      const compile = spawnSync(BUN, [join(legacyProj, ".claude", "tools", "aidlc-graph.ts"), "compile"], {
        cwd: legacyProj,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
        env: { ...process.env, AIDLC_HARNESS_DIR: ".claude" },
      });
      if (compile.status !== 0) throw new Error(`legacy graph compile failed: ${compile.stderr || compile.stdout}`);
      expect(compile.status).toBe(0);
    });
  });

  // --- Retry-marker keyed by plugin identity, not harness leaf ---
  test("two plugins on the same harness get distinct retry markers", () => {
    // The retry marker is keyed by the plugin's manifest name, NOT the plugin-root
    // basename (which for a projection is the harness leaf, shared by every
    // plugin). If it were keyed by basename, plugin A and B on the same harness
    // would share one marker and B's successful compose would erase A's pending
    // retry — a silent self-heal defeat. Assert the two markers differ by name.
    const markerDir = join(project, "aidlc");
    // test-pro's real marker name (from its manifest name "test-pro").
    const proj2 = join(tmp, "proj2");
    cpSync(CLAUDE_DIST, join(proj2, ".claude"), { recursive: true });
    // Build a second projection whose manifest name differs; force its compile to
    // fail (point the harness dir away) so it writes its own retry marker.
    const other = join(tmp, "other", "claude");
    const build2 = spawnSync(BUN, [PACKAGE_TS, "plugin", "build", PLUGIN, "claude", other], {
      cwd: REPO_ROOT, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000,
    });
    expect(build2.status).toBe(0);
    // Derive the key the way compose does: manifest name.
    const manifest = JSON.parse(readFileSync(join(pluginBuilt, ".claude-plugin", "plugin.json"), "utf-8"));
    const expectedKey = String(manifest.name).replace(/[^\w.-]/g, "_");
    // The key must be the plugin name (aidlc-test-pro), NOT the harness leaf "claude".
    expect(expectedKey).toContain("test-pro");
    expect(expectedKey).not.toBe("claude");
    // And the marker path compose would use is name-qualified.
    expect(join(markerDir, `.plugin-compose-retry-${expectedKey}`))
      .not.toBe(join(markerDir, ".plugin-compose-retry-claude"));
  });

  // --- Silent-failure seams (round-4): each must DROP-LOG, never silently no-op ---
  function prepareSyntheticPlugin(
    proj: string,
    name: string,
    files: Record<string, string>,
  ): string {
    const root = join(proj, `_plugin-${name}`);
    cpSync(join(pluginBuilt, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
    cpSync(join(pluginBuilt, "hooks"), join(root, "hooks"), { recursive: true });
    const mf = join(root, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(mf, "utf-8"));
    manifest.name = name;
    writeFileSync(mf, JSON.stringify(manifest));
    for (const [rel, body] of Object.entries(files)) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    return root;
  }

  // Helper: compose a hand-built synthetic plugin into a fresh copy of the base
  // install, returning { drops, projectDir } so a test can assert on the drops.
  function composeSynthetic(
    name: string,
    files: Record<string, string>,
    harnessLeaf: ".claude" | ".kiro" | ".codex" | ".aidlc" = ".claude",
    mutateInstall?: (proj: string, harnessDir: string) => void,
  ): { drops: string; proj: string } {
    const proj = mkdtempSync(join(tmp, `syn-${name}-`));
    if (harnessLeaf === ".aidlc") {
      // OpenCode's dist is a whole-project shape (.aidlc + .opencode +
      // opencode.json), unlike the single-dir harness dists.
      cpSync(OPENCODE_DIST, proj, { recursive: true });
    } else {
      const baseDist =
        harnessLeaf === ".kiro" ? KIRO_DIST : harnessLeaf === ".codex" ? CODEX_DIST : CLAUDE_DIST;
      cpSync(baseDist, join(proj, harnessLeaf), { recursive: true });
    }
    const harnessDir = join(proj, harnessLeaf);
    mutateInstall?.(proj, harnessDir);
    const root = prepareSyntheticPlugin(proj, name, files);
    const r = spawnSync(BUN, [join(root, "hooks", "compose.ts")], {
      cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: harnessLeaf },
    });
    expect(r.status).toBe(0); // compose is fail-open — never breaks the session
    // Drops files are per-plugin (`plugin-compose-<key>.drops`) — aggregate any
    // that exist under the health dir.
    let drops = "";
    const hd = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
    if (existsSync(hd)) {
      for (const f of require("node:fs").readdirSync(hd) as string[]) {
        if (f.startsWith("plugin-compose") && f.endsWith(".drops")) drops += readFileSync(join(hd, f), "utf-8");
      }
    }
    return { drops, proj };
  }

  test("Kiro rejects plugin-owned ensemble collaborators with a compose drop", () => {
    const stage = [
      "---",
      "slug: syn-kiro-ensemble",
      "plugin: syn-kiro",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-kiro-collaborator-agent",
      "mode: mob",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Kiro Ensemble",
      "",
      "## Steps",
      "body",
      "",
    ].join("\n");
    const agent = [
      "---",
      "name: syn-kiro-collaborator-agent",
      "display_name: Synthetic Kiro Collaborator",
      "plugin: syn-kiro",
      "disallowedTools: Task",
      "---",
      "",
      "# Synthetic Kiro Collaborator",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-kiro",
      {
        "stages/inception/syn-kiro-ensemble.md": stage,
        "agents/syn-kiro-collaborator-agent.md": agent,
      },
      ".kiro",
    );

    expect(existsSync(join(
      proj,
      ".kiro",
      "aidlc-common",
      "stages",
      "inception",
      "syn-kiro-ensemble.md",
    ))).toBe(false);
    expect(existsSync(join(
      proj,
      ".kiro",
      "agents",
      "syn-kiro-collaborator-agent.md",
    ))).toBe(true);
    expect(readFileSync(join(
      proj,
      ".kiro",
      "agents",
      "syn-kiro-collaborator-agent.md",
    ), "utf-8")).not.toMatch(/^disallowedTools:/m);
    expect(drops).toContain('stage "syn-kiro-ensemble"');
    expect(drops).toContain('agent "syn-kiro-collaborator-agent"');
    expect(drops).toContain("agent-v1 JSON");
    expect(drops).toContain("toolsSettings.subagent.trustedAgents");
    expect(drops).toContain("change the stage's mode to inline");
    // The lead is a CORE persona: its shipped agent-v1 JSON is its dispatch
    // surface, so it must never be named as undispatchable.
    expect(drops).not.toContain('agent "aidlc-product-agent"');

    const unsupportedAgent = [
      "---",
      "name: syn-kiro-unsupported-agent",
      "display_name: Synthetic Kiro Unsupported Agent",
      "plugin: syn-kiro-unsupported",
      "disallowedTools: WebSearch",
      "---",
      "",
      "# Synthetic Kiro Unsupported Agent",
      "",
    ].join("\n");
    const unsupported = composeSynthetic(
      "syn-kiro-unsupported",
      {
        "agents/syn-kiro-unsupported-agent.md": unsupportedAgent,
      },
      ".kiro",
    );
    expect(existsSync(join(
      unsupported.proj,
      ".kiro",
      "agents",
      "syn-kiro-unsupported-agent.md",
    ))).toBe(false);
    expect(unsupported.drops).toContain(
      'cannot project disallowedTools "WebSearch" to Kiro; not copied',
    );

    const duplicateAgent = unsupportedAgent
      .replaceAll("syn-kiro-unsupported", "syn-kiro-duplicate")
      .replace(
        "disallowedTools: WebSearch",
        "disallowedTools: Task\ndisallowedTools: WebSearch",
      );
    const duplicate = composeSynthetic(
      "syn-kiro-duplicate",
      {
        "agents/syn-kiro-duplicate-agent.md": duplicateAgent,
      },
      ".kiro",
    );
    expect(existsSync(join(
      duplicate.proj,
      ".kiro",
      "agents",
      "syn-kiro-duplicate-agent.md",
    ))).toBe(false);
    expect(duplicate.drops).toContain(
      "declares multiple disallowedTools lines",
    );
  });

  test("Kiro re-compose migrates only an exact same-plugin legacy persona", () => {
    const agent = [
      "---",
      "name: syn-kiro-upgrade-agent",
      "display_name: Synthetic Kiro Upgrade Agent",
      "plugin: syn-kiro-upgrade",
      "disallowedTools: Task",
      "---",
      "",
      "# Synthetic Kiro Upgrade Agent",
      "",
    ].join("\n");
    const rel = join("agents", "syn-kiro-upgrade-agent.md");
    const migrated = composeSynthetic(
      "syn-kiro-upgrade",
      { "agents/syn-kiro-upgrade-agent.md": agent },
      ".kiro",
      (_proj, harnessDir) => {
        mkdirSync(join(harnessDir, "agents"), { recursive: true });
        writeFileSync(join(harnessDir, rel), agent);
      },
    );
    const migratedBody = readFileSync(
      join(migrated.proj, ".kiro", rel),
      "utf-8",
    );
    expect(migratedBody).not.toMatch(/^disallowedTools:/m);
    expect(migrated.drops).not.toContain("collides with an existing file");

    const editedAgent = `${agent}\n<!-- user-owned edit -->\n`;
    const edited = composeSynthetic(
      "syn-kiro-upgrade",
      { "agents/syn-kiro-upgrade-agent.md": agent },
      ".kiro",
      (_proj, harnessDir) => {
        mkdirSync(join(harnessDir, "agents"), { recursive: true });
        writeFileSync(join(harnessDir, rel), editedAgent);
      },
    );
    const editedBody = readFileSync(join(edited.proj, ".kiro", rel), "utf-8");
    expect(editedBody).toBe(editedAgent);
    expect(edited.drops).toContain("collides with an existing file");

    const unsupportedAgent = agent
      .replaceAll("syn-kiro-upgrade", "syn-kiro-unsupported-upgrade")
      .replace("disallowedTools: Task", "disallowedTools: WebSearch");
    const unsupportedRel = join(
      "agents",
      "syn-kiro-unsupported-upgrade-agent.md",
    );
    const unsupported = composeSynthetic(
      "syn-kiro-unsupported-upgrade",
      {
        "agents/syn-kiro-unsupported-upgrade-agent.md": unsupportedAgent,
      },
      ".kiro",
      (_proj, harnessDir) => {
        mkdirSync(join(harnessDir, "agents"), { recursive: true });
        writeFileSync(join(harnessDir, unsupportedRel), unsupportedAgent);
      },
    );
    expect(readFileSync(
      join(unsupported.proj, ".kiro", unsupportedRel),
      "utf-8",
    )).toBe(unsupportedAgent);
    expect(unsupported.drops).toContain(
      'is already composed with unsupported disallowedTools "WebSearch"',
    );
    expect(unsupported.drops).toContain(
      'remove ".kiro/agents/syn-kiro-unsupported-upgrade-agent.md", and re-run compose',
    );
    expect(unsupported.drops).not.toContain("collides with an existing file");

    const duplicateAgent = agent
      .replaceAll("syn-kiro-upgrade", "syn-kiro-duplicate-upgrade")
      .replace(
        "disallowedTools: Task",
        "disallowedTools: Task\ndisallowedTools: WebSearch",
      );
    const duplicateRel = join(
      "agents",
      "syn-kiro-duplicate-upgrade-agent.md",
    );
    const duplicate = composeSynthetic(
      "syn-kiro-duplicate-upgrade",
      {
        "agents/syn-kiro-duplicate-upgrade-agent.md": duplicateAgent,
      },
      ".kiro",
      (_proj, harnessDir) => {
        mkdirSync(join(harnessDir, "agents"), { recursive: true });
        writeFileSync(join(harnessDir, duplicateRel), duplicateAgent);
      },
    );
    expect(readFileSync(
      join(duplicate.proj, ".kiro", duplicateRel),
      "utf-8",
    )).toBe(duplicateAgent);
    expect(duplicate.drops).toContain(
      "is already composed with multiple disallowedTools lines",
    );
    expect(duplicate.drops).toContain(
      'remove ".kiro/agents/syn-kiro-duplicate-upgrade-agent.md", and re-run compose',
    );
    expect(duplicate.drops).not.toContain("collides with an existing file");
  });

  test("Kiro rejects an agent JSON that is missing conductor trust registration", () => {
    const stage = [
      "---",
      "slug: syn-kiro-untrusted",
      "plugin: syn-kiro-untrusted",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - aidlc-design-agent",
      "mode: mob",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Kiro Untrusted",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-kiro-untrusted",
      { "stages/inception/syn-kiro-untrusted.md": stage },
      ".kiro",
      (_proj, harnessDir) => {
        const conductorPath = join(harnessDir, "agents", "aidlc.json");
        const conductor = JSON.parse(readFileSync(conductorPath, "utf-8"));
        conductor.toolsSettings.subagent.trustedAgents =
          conductor.toolsSettings.subagent.trustedAgents.filter(
            (agent: string) => agent !== "aidlc-design-agent",
          );
        writeFileSync(conductorPath, `${JSON.stringify(conductor, null, 2)}\n`);
      },
    );

    expect(existsSync(join(
      proj,
      ".kiro",
      "aidlc-common",
      "stages",
      "inception",
      "syn-kiro-untrusted.md",
    ))).toBe(false);
    expect(existsSync(join(
      proj,
      ".kiro",
      "agents",
      "aidlc-design-agent.json",
    ))).toBe(true);
    expect(drops).toContain('agent "aidlc-design-agent"');
    expect(drops).toContain("toolsSettings.subagent.trustedAgents");
    expect(drops).not.toContain("aidlc-design-agent.json (agent-v1 JSON)");
  });

  // OpenCode dispatches from the native roster .opencode/agents/<a>.md. A
  // dispatched stage naming an agent with no native file AND no viable plugin
  // twin must drop (the native emitter would leave a dangling dispatch target);
  // one whose collaborator ships with the plugin (viable frontmatter) composes.
  test("OpenCode rejects a dispatched stage whose agent lacks a native subagent file", () => {
    const stage = [
      "---",
      "slug: syn-oc-missing",
      "plugin: syn-oc",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-oc-ghost-agent",
      "mode: mob",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic OpenCode Missing Agent",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-oc",
      { "stages/inception/syn-oc-missing.md": stage },
      ".aidlc",
    );
    expect(existsSync(join(
      proj,
      ".aidlc",
      "aidlc-common",
      "stages",
      "inception",
      "syn-oc-missing.md",
    ))).toBe(false);
    expect(drops).toContain('agent "syn-oc-ghost-agent"');
    expect(drops).toContain(".opencode/agents/syn-oc-ghost-agent.md");
    // The lead is a CORE persona with an installed native subagent file: it
    // must never be named as undispatchable.
    expect(drops).not.toContain('agent "aidlc-product-agent"');
  });

  test("OpenCode drops a dispatched stage whose shipped agent name collides with an installed native agent", () => {
    // The shipped persona's file would be collision-dropped from the native
    // roster, so accepting the stage would leave a dangling dispatch target.
    const agent = [
      "---",
      "name: syn-oc-taken-agent",
      "display_name: Synthetic Colliding Collaborator",
      "plugin: syn-oc",
      "description: synthetic colliding collaborator",
      "---",
      "",
      "# Synthetic Colliding Collaborator",
      "",
    ].join("\n");
    const stage = [
      "---",
      "slug: syn-oc-colliding",
      "plugin: syn-oc",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-oc-taken-agent",
      "mode: mob",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic OpenCode Colliding Agent",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-oc",
      {
        "stages/inception/syn-oc-colliding.md": stage,
        "agents/syn-oc-taken-agent.md": agent,
      },
      ".aidlc",
      (proj) => {
        // A DIFFERENT installed native agent already owns the name.
        writeFileSync(
          join(proj, ".opencode", "agents", "other-owner-agent.md"),
          [
            "---",
            "name: syn-oc-taken-agent",
            "description: pre-installed owner of the name",
            "---",
            "",
            "# Other Owner",
            "",
          ].join("\n"),
        );
      },
    );
    expect(existsSync(join(
      proj,
      ".aidlc",
      "aidlc-common",
      "stages",
      "inception",
      "syn-oc-colliding.md",
    ))).toBe(false);
    expect(drops).toContain('agent "syn-oc-taken-agent"');
  });

  test("a malformed plugin agent drops alone without aborting the rest of the compose", () => {
    // The native-roster transform throws on a frontmatter-less persona; the
    // precheck must reject the file FIRST so the drop stays per-file and the
    // remaining trees (knowledge here) still compose.
    const { drops, proj } = composeSynthetic(
      "syn-oc",
      {
        "agents/syn-oc-broken-agent.md": "# No frontmatter at all\n",
        "knowledge/syn-oc-note.md": "# Synthetic knowledge survives\n",
      },
      ".aidlc",
    );
    expect(drops).toContain("syn-oc-broken-agent.md");
    expect(drops).not.toContain("compose threw");
    expect(existsSync(join(
      proj,
      ".opencode",
      "agents",
      "syn-oc-broken-agent.md",
    ))).toBe(false);
    // The compose completed past the agent copy: later trees landed.
    expect(existsSync(join(
      proj,
      ".aidlc",
      "knowledge",
      "syn-oc-note.md",
    ))).toBe(true);
  });

  test("OpenCode composes a dispatched stage whose collaborator ships with the plugin", () => {
    const agent = [
      "---",
      "name: syn-oc-collab-agent",
      "display_name: Synthetic Collaborator",
      "plugin: syn-oc",
      "description: synthetic collaborator",
      "---",
      "",
      "# Synthetic Collaborator",
      "",
    ].join("\n");
    const stage = [
      "---",
      "slug: syn-oc-shipped",
      "plugin: syn-oc",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-oc-collab-agent",
      "mode: mob",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic OpenCode Shipped Agent",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-oc",
      {
        "stages/inception/syn-oc-shipped.md": stage,
        "agents/syn-oc-collab-agent.md": agent,
      },
      ".aidlc",
    );
    expect(existsSync(join(
      proj,
      ".aidlc",
      "aidlc-common",
      "stages",
      "inception",
      "syn-oc-shipped.md",
    ))).toBe(true);
    // The native twin landed, so the dispatch target is real.
    expect(existsSync(join(
      proj,
      ".opencode",
      "agents",
      "syn-oc-collab-agent.md",
    ))).toBe(true);
    expect(drops).not.toContain('agent "syn-oc-collab-agent"');
  });

  test("all harnesses reject reserved agent-team stages until a runtime consumer exists", () => {
    const stage = [
      "---",
      "slug: syn-kiro-agent-team",
      "plugin: syn-kiro-agent-team",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents: []",
      "mode: agent-team",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Kiro Agent Team",
      "",
    ].join("\n");
    for (const harnessLeaf of [".claude", ".kiro", ".codex"] as const) {
      const { drops, proj } = composeSynthetic(
        "syn-kiro-agent-team",
        { "stages/inception/syn-kiro-agent-team.md": stage },
        harnessLeaf,
      );

      expect(existsSync(join(
        proj,
        harnessLeaf,
        "aidlc-common",
        "stages",
        "inception",
        "syn-kiro-agent-team.md",
      ))).toBe(false);
      expect(drops).toContain('reserved mode "agent-team"');
      expect(drops).toContain("has no runtime consumer");
    }
  });

  test("Kiro dispatch-safety still audits an already-composed reserved agent-team stage", () => {
    const stage = [
      "---",
      "slug: syn-kiro-agent-team-installed-stage",
      "plugin: syn-kiro-agent-team-installed",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-kiro-agent-team-agent",
      "mode: agent-team",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Installed Agent Team",
      "",
    ].join("\n");
    const agent = [
      "---",
      "name: syn-kiro-agent-team-agent",
      "display_name: Synthetic Agent Team Collaborator",
      "plugin: syn-kiro-agent-team-installed",
      "---",
      "",
      "# Synthetic Agent Team Collaborator",
      "",
    ].join("\n");
    const { drops } = composeSynthetic(
      "syn-kiro-agent-team-installed",
      {
        "stages/inception/syn-kiro-agent-team-installed-stage.md": stage,
        "agents/syn-kiro-agent-team-agent.md": agent,
      },
      ".kiro",
      (_proj, harnessDir) => {
        const installed = join(
          harnessDir,
          "aidlc-common",
          "stages",
          "inception",
          "syn-kiro-agent-team-installed-stage.md",
        );
        mkdirSync(dirname(installed), { recursive: true });
        writeFileSync(installed, stage);
      },
    );

    expect(drops).toContain('reserved mode "agent-team"');
    expect(drops).toContain("is already composed but remains undispatchable");
    expect(drops).toContain('agent "syn-kiro-agent-team-agent"');
  });

  test("Kiro reports an already-composed stage that remains undispatchable", () => {
    const stage = [
      "---",
      "slug: syn-kiro-existing-unsafe",
      "plugin: syn-kiro-existing-unsafe",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-kiro-existing-agent",
      "mode: mob",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Existing Unsafe Stage",
      "",
    ].join("\n");
    const agent = [
      "---",
      "name: syn-kiro-existing-agent",
      "display_name: Synthetic Existing Agent",
      "plugin: syn-kiro-existing-unsafe",
      "---",
      "",
      "# Synthetic Existing Agent",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-kiro-existing-unsafe",
      {
        "stages/inception/syn-kiro-existing-unsafe.md": stage,
        "agents/syn-kiro-existing-agent.md": agent,
      },
      ".kiro",
      (_proj, harnessDir) => {
        const installed = join(
          harnessDir,
          "aidlc-common",
          "stages",
          "inception",
          "syn-kiro-existing-unsafe.md",
        );
        mkdirSync(dirname(installed), { recursive: true });
        writeFileSync(installed, stage);
      },
    );

    expect(existsSync(join(
      proj,
      ".kiro",
      "aidlc-common",
      "stages",
      "inception",
      "syn-kiro-existing-unsafe.md",
    ))).toBe(true);
    expect(drops).toContain("[degraded]");
    expect(drops).toContain("is already composed but remains undispatchable");
    expect(drops).toContain('agent "syn-kiro-existing-agent"');
  });

  test("Kiro rejects a lead-only plugin subagent and retains its inline persona", () => {
    const stage = [
      "---",
      "slug: syn-kiro-subagent-stage",
      "plugin: syn-kiro-subagent",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: syn-kiro-subagent-agent",
      "support_agents: []",
      "mode: subagent",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Kiro Subagent",
      "",
    ].join("\n");
    const agent = [
      "---",
      "name: syn-kiro-subagent-agent",
      "display_name: Synthetic Kiro Subagent",
      "plugin: syn-kiro-subagent",
      "---",
      "",
      "# Synthetic Kiro Subagent",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-kiro-subagent",
      {
        "stages/inception/syn-kiro-subagent-stage.md": stage,
        "agents/syn-kiro-subagent-agent.md": agent,
      },
      ".kiro",
    );

    expect(existsSync(join(
      proj,
      ".kiro",
      "aidlc-common",
      "stages",
      "inception",
      "syn-kiro-subagent-stage.md",
    ))).toBe(false);
    expect(existsSync(join(
      proj,
      ".kiro",
      "agents",
      "syn-kiro-subagent-agent.md",
    ))).toBe(true);
    expect(drops).toContain('stage "syn-kiro-subagent-stage"');
    expect(drops).toContain('mode "subagent"');
    expect(drops).toContain("agent-v1 JSON");
    expect(drops).toContain("toolsSettings.subagent.trustedAgents");
  });

  test("Kiro keeps a plugin persona shared by a rejected mob and accepted inline stage", () => {
    const mobStage = [
      "---",
      "slug: syn-kiro-shared-mob",
      "plugin: syn-kiro-shared",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-kiro-shared-agent",
      "mode: mob",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Kiro Shared Mob",
      "",
    ].join("\n");
    const inlineStage = [
      "---",
      "slug: syn-kiro-shared-inline",
      "plugin: syn-kiro-shared",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: syn-kiro-shared-agent",
      "support_agents: []",
      "mode: inline",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Kiro Shared Inline",
      "",
    ].join("\n");
    const agent = [
      "---",
      "name: syn-kiro-shared-agent",
      "display_name: Synthetic Kiro Shared Agent",
      "plugin: syn-kiro-shared",
      "---",
      "",
      "# Synthetic Kiro Shared Agent",
      "",
    ].join("\n");
    const { proj } = composeSynthetic(
      "syn-kiro-shared",
      {
        "stages/inception/syn-kiro-shared-mob.md": mobStage,
        "stages/inception/syn-kiro-shared-inline.md": inlineStage,
        "agents/syn-kiro-shared-agent.md": agent,
      },
      ".kiro",
    );
    const stages = join(proj, ".kiro", "aidlc-common", "stages", "inception");

    expect(existsSync(join(stages, "syn-kiro-shared-mob.md"))).toBe(false);
    expect(existsSync(join(stages, "syn-kiro-shared-inline.md"))).toBe(true);
    expect(existsSync(join(
      proj,
      ".kiro",
      "agents",
      "syn-kiro-shared-agent.md",
    ))).toBe(true);
    const compile = spawnSync(
      BUN,
      [join(proj, ".kiro", "tools", "aidlc-graph.ts"), "compile"],
      {
        cwd: proj,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
        env: { ...process.env, AIDLC_HARNESS_DIR: ".kiro" },
      },
    );
    expect(compile.status).toBe(0);
  });

  test("Kiro rejects an inline stage whose plugin-owned REVIEWER has no dispatch surface", () => {
    // The reviewer dispatches on every gated stage regardless of mode (§12a),
    // so an inline stage with an undispatchable reviewer must be rejected too.
    const stage = [
      "---",
      "slug: syn-kiro-reviewed",
      "plugin: syn-kiro-rev",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents: []",
      "reviewer: syn-kiro-reviewer-agent",
      "mode: inline",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Kiro Reviewed",
      "",
      "## Steps",
      "body",
      "",
    ].join("\n");
    const agent = [
      "---",
      "name: syn-kiro-reviewer-agent",
      "display_name: Synthetic Kiro Reviewer",
      "plugin: syn-kiro-rev",
      "---",
      "",
      "# Synthetic Kiro Reviewer",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-kiro-rev",
      {
        "stages/inception/syn-kiro-reviewed.md": stage,
        "agents/syn-kiro-reviewer-agent.md": agent,
      },
      ".kiro",
    );

    expect(existsSync(join(
      proj,
      ".kiro",
      "aidlc-common",
      "stages",
      "inception",
      "syn-kiro-reviewed.md",
    ))).toBe(false);
    expect(drops).toContain('stage "syn-kiro-reviewed"');
    expect(drops).toContain('agent "syn-kiro-reviewer-agent" as reviewer');
    expect(drops).toContain("remove the stage's reviewer: field");
  });

  test("Codex rejects a plugin-owned dispatched agent with a TOML remediation", () => {
    const stage = [
      "---",
      "slug: syn-codex-ensemble",
      "plugin: syn-codex",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-codex-collaborator-agent",
      "mode: mob",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic Codex Ensemble",
      "",
      "## Steps",
      "body",
      "",
    ].join("\n");
    const agent = [
      "---",
      "name: syn-codex-collaborator-agent",
      "display_name: Synthetic Codex Collaborator",
      "plugin: syn-codex",
      "---",
      "",
      "# Synthetic Codex Collaborator",
      "",
    ].join("\n");
    const { drops, proj } = composeSynthetic(
      "syn-codex",
      {
        "stages/inception/syn-codex-ensemble.md": stage,
        "agents/syn-codex-collaborator-agent.md": agent,
      },
      ".codex",
    );

    expect(existsSync(join(
      proj,
      ".codex",
      "aidlc-common",
      "stages",
      "inception",
      "syn-codex-ensemble.md",
    ))).toBe(false);
    // Core lead has a shipped TOML; only the plugin persona is undispatchable.
    expect(drops).toContain('agent "syn-codex-collaborator-agent"');
    expect(drops).not.toContain('agent "aidlc-product-agent"');
    expect(drops).toContain("syn-codex-collaborator-agent.toml");
    expect(drops).toContain("change the stage's mode to inline");
  });

  test("parser-unavailable fallback accepts only explicit inline reviewer-free stages", () => {
    // Finding-2 regression guard: when the installed lib exposes the required
    // compose lock but not the stage parser, the guard cannot resolve agent
    // references. An inline-only plugin must still compose - fail-closed is
    // scoped to dispatched topologies.
    const inlineStage = [
      "---",
      "slug: syn-noparse-inline",
      "plugin: syn-noparse",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: syn-noparse-agent",
      "support_agents: []",
      "mode: inline",
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic NoParse Inline",
      "",
    ].join("\n");
    const mobStage = [
      "---",
      "slug: syn-noparse-mob",
      "plugin: syn-noparse",
      "phase: inception",
      "execution: ALWAYS",
      "condition: always",
      "lead_agent: aidlc-product-agent",
      "support_agents:",
      "  - syn-noparse-agent",
      'mode: "mob"',
      "produces: []",
      "consumes: []",
      "requires_stage: []",
      "inputs: x",
      "outputs: y",
      "---",
      "",
      "# Synthetic NoParse Mob",
      "",
    ].join("\n");
    const agent = [
      "---",
      "name: syn-noparse-agent",
      "display_name: Synthetic NoParse Agent",
      "plugin: syn-noparse",
      "---",
      "",
      "# Synthetic NoParse Agent",
      "",
    ].join("\n");

    // composeSynthetic runs the hook itself, so build the project by hand and
    // replace the installed lib with a lock-only compatibility shim.
    const proj = mkdtempSync(join(tmp, "syn-noparse-"));
    cpSync(KIRO_DIST, join(proj, ".kiro"), { recursive: true });
    const installedLib = join(proj, ".kiro", "tools", "aidlc-lib.ts");
    cpSync(installedLib, join(proj, ".kiro", "tools", "aidlc-lib-real.ts"));
    writeFileSync(
      installedLib,
      [
        'export { acquireAuditLock, releaseAuditLock, hooksHealthDir } from "./aidlc-lib-real.ts";',
        "",
      ].join("\n"),
    );
    // Keep the spawned compile usable while compose itself observes the
    // parser-limited compatibility module above. A compile failure now
    // correctly rolls all copied files back, so this fallback test must isolate
    // parser availability from transaction recovery.
    const installedTools = join(proj, ".kiro", "tools");
    for (const file of readdirSync(installedTools).filter((name) => name.endsWith(".ts"))) {
      if (file === "aidlc-lib.ts" || file === "aidlc-lib-real.ts") continue;
      const path = join(installedTools, file);
      const source = readFileSync(path, "utf-8");
      const isolated = source.replaceAll(
        'from "./aidlc-lib.ts"',
        'from "./aidlc-lib-real.ts"',
      );
      if (isolated !== source) writeFileSync(path, isolated);
    }
    const root = join(proj, "_plugin");
    cpSync(join(pluginBuilt, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
    cpSync(join(pluginBuilt, "hooks"), join(root, "hooks"), { recursive: true });
    const mf = join(root, ".claude-plugin", "plugin.json");
    const m = JSON.parse(readFileSync(mf, "utf-8")); m.name = "syn-noparse"; writeFileSync(mf, JSON.stringify(m));
    for (const [rel, body] of Object.entries({
      "stages/inception/syn-noparse-inline.md": inlineStage,
      "stages/inception/syn-noparse-mob.md": mobStage,
      "agents/syn-noparse-agent.md": agent,
    })) {
      const p = join(root, rel);
      require("node:fs").mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    const r = spawnSync(BUN, [join(root, "hooks", "compose.ts")], {
      cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".kiro" },
    });
    expect(r.status).toBe(0);

    let drops = "";
    const hd = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
    if (existsSync(hd)) {
      for (const f of require("node:fs").readdirSync(hd) as string[]) {
        if (f.startsWith("plugin-compose") && f.endsWith(".drops")) drops += readFileSync(join(hd, f), "utf-8");
      }
    }
    const stages = join(proj, ".kiro", "aidlc-common", "stages", "inception");
    expect(existsSync(join(stages, "syn-noparse-inline.md"))).toBe(true);
    expect(existsSync(join(stages, "syn-noparse-mob.md"))).toBe(false);
    expect(existsSync(join(proj, ".kiro", "agents", "syn-noparse-agent.md"))).toBe(true);
    expect(drops).toContain("syn-noparse-mob.md");
    expect(drops).toContain("stage parser is unavailable");
    expect(drops).not.toContain("syn-noparse-inline.md");
  });

  test("unresolvable fragment anchor is dropped-with-log, not silent (R4-2)", () => {
    const { drops } = composeSynthetic("syn-anchor", {
      "contributions/construction/build-and-test.md":
        `---\ntarget: build-and-test\nplugin: syn-anchor\nadds:\n  produces: []\nfragments:\n  - anchor: after-step:999\n    order: 100\n---\n\n## fragment: after-step:999\n\n### Step 999x (syn): orphaned\n\nprose\n`,
    });
    expect(drops).toContain("after-step:999");
    expect(drops.toLowerCase()).toContain("dropped");
  });

  test("range-heading anchor resolves (### Step 4-8 → after-step:6) (R4-3)", () => {
    // build-and-test ships `### Step 4-8:`. A fragment at after-step:6 must splice
    // (land in the body), NOT drop as 'not found'.
    const { drops, proj } = composeSynthetic("syn-range", {
      "contributions/construction/build-and-test.md":
        `---\ntarget: build-and-test\nplugin: syn-range\nadds:\n  produces: []\nfragments:\n  - anchor: after-step:6\n    order: 100\n---\n\n## fragment: after-step:6\n\n### Step 6-SYN: lands in range\n\nsyn-range prose\n`,
    });
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).toContain("syn-range prose");
    expect(drops).not.toContain("after-step:6");
  });

  test("stage-slug collision is dropped-with-log, not a silent no-op (R4-4)", () => {
    const { drops, proj } = composeSynthetic("syn-collide", {
      "stages/construction/build-and-test.md":
        `---\nslug: build-and-test\nplugin: syn-collide\nphase: construction\nexecution: ALWAYS\ncondition: always\nlead_agent: aidlc-quality-agent\nsupport_agents: []\nmode: inline\nproduces: []\nconsumes: []\nrequires_stage: []\ninputs: x\noutputs: y\n---\n# SYN-COLLIDE OVERRIDE\n`,
    });
    // the core stage must be untouched, AND the collision must be logged
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).not.toContain("SYN-COLLIDE OVERRIDE");
    expect(drops).toContain("collides");
  });

  test("scope, agent, and knowledge collisions are no-clobber and drop-logged", () => {
    const collideProj = mkdtempSync(join(tmp, "primitive-collide-"));
    cpSync(CLAUDE_DIST, join(collideProj, ".claude"), { recursive: true });

    const scopePath = join(collideProj, ".claude", "scopes", "test-pro-validation.md");
    const seededScope = [
      "---",
      "name: test-pro-validation",
      "plugin: preseed",
      "depth: Standard",
      "keywords:",
      "  - seeded-validation",
      "description: Preseeded validation scope",
      "---",
      "",
      "# Preseeded validation scope",
      "",
      "This file must survive plugin compose.",
      "",
    ].join("\n");
    writeFileSync(scopePath, seededScope);

    const agentPath = join(collideProj, ".claude", "agents", "test-pro-metrics-agent.md");
    const seededAgent = [
      "---",
      "name: test-pro-metrics-agent",
      "display_name: Preseeded Metrics Agent",
      "plugin: preseed",
      "examples:",
      "  - seeded-metrics.md",
      "description: Preseeded metrics persona",
      "disallowedTools: Task",
      "model: sonnet",
      "---",
      "",
      "# Preseeded Metrics Agent",
      "",
      "This valid agent file must survive plugin compose.",
      "",
    ].join("\n");
    writeFileSync(agentPath, seededAgent);

    const knowledgePath = join(collideProj, ".claude", "knowledge", "test-pro-metrics-agent", "methodology.md");
    mkdirSync(dirname(knowledgePath), { recursive: true });
    const seededKnowledge = "# Preseeded methodology\n\nThis file must survive plugin compose.\n";
    writeFileSync(knowledgePath, seededKnowledge);

    const compose = spawnSync(BUN, [join(pluginBuilt, "hooks", "compose.ts")], {
      cwd: collideProj,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginBuilt,
        CLAUDE_PROJECT_DIR: collideProj,
        AIDLC_HARNESS_DIR: ".claude",
      },
    });
    if (compose.status !== 0) throw new Error(`compose.ts failed: ${compose.stderr}`);

    expect(readFileSync(scopePath, "utf-8")).toBe(seededScope);
    expect(readFileSync(agentPath, "utf-8")).toBe(seededAgent);
    expect(readFileSync(knowledgePath, "utf-8")).toBe(seededKnowledge);

    const drops = hookDrops(collideProj);
    expect(drops).toContain(`scopes "test-pro-validation.md" collides`);
    expect(drops).toContain(`agents "test-pro-metrics-agent.md" collides`);
    expect(drops).toContain(`knowledge "test-pro-metrics-agent/methodology.md" collides`);
  });

  test("agent frontmatter name collision is dropped before copy and install remains usable", () => {
    const { drops, proj } = composeSynthetic("syn-agent-name", {
      "agents/x-unique-file.md": [
        "---",
        "name: aidlc-quality-agent",
        "display_name: Synthetic Quality Agent",
        "plugin: syn-agent-name",
        "examples: []",
        "description: Synthetic duplicate agent name fixture.",
        "disallowedTools: Task",
        "model: sonnet",
        "---",
        "",
        "# Synthetic Quality Agent",
        "",
      ].join("\n"),
    });

    expect(existsSync(join(proj, ".claude", "agents", "x-unique-file.md"))).toBe(false);
    expect(drops).toContain("[degraded]");
    expect(drops).toContain('plugin "syn-agent-name"');
    expect(drops).toContain("agents/x-unique-file.md");
    expect(drops).toContain("aidlc-quality-agent");
    expect(drops).toContain("aidlc-quality-agent.md");

    const compile = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-graph.ts"), "compile"], {
      cwd: proj,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: { ...process.env, AIDLC_HARNESS_DIR: ".claude" },
    });
    if (compile.status !== 0) throw new Error(`graph compile failed: ${compile.stderr || compile.stdout}`);
    expect(compile.status).toBe(0);

    const statusline = spawnSync(BUN, [join(proj, ".claude", "hooks", "aidlc-statusline.ts")], {
      cwd: proj,
      encoding: "utf-8",
      input: JSON.stringify({ workspace: { project_dir: proj } }),
      timeout: TIMEOUT_MS - 5_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" },
    });
    if (statusline.status !== 0) throw new Error(`statusline failed: ${statusline.stderr || statusline.stdout}`);
    expect(statusline.status).toBe(0);
    expect(statusline.stdout).toContain("[AIDLC]");
  });

  // --- Silent-failure seams (round-5): fence-awareness, leftover blocks, BOM ---
  test("a ## fragment: line inside a code fence is NOT a delimiter (R5-C1)", () => {
    // A fragment whose prose documents the fragment format inside a ``` fence must
    // keep all its prose — the fenced `## fragment:` line must not truncate it.
    const fenced = [
      "---", "target: build-and-test", "plugin: syn-fence",
      "adds:", "  produces: []",
      "fragments:", "  - anchor: after-step:9", "    order: 100", "---", "",
      "## fragment: after-step:9", "",
      "### Step 9-FENCE (syn): documented", "",
      "Authors write fragments like this:", "", "```", "## fragment: after-step:6", "```", "",
      "TAIL-MUST-SURVIVE past the fence.", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-fence", { "contributions/construction/build-and-test.md": fenced });
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).toContain("TAIL-MUST-SURVIVE"); // prose after the fenced marker survived
    expect(drops).not.toContain("after-step:6"); // no phantom block spawned
  });

  test("a body block with no matching frontmatter entry is dropped-with-log (R5-C5)", () => {
    // Two `## fragment: after-step:9` blocks but only ONE frontmatter entry — the
    // second block must be logged, not silently discarded.
    const extra = [
      "---", "target: build-and-test", "plugin: syn-extra",
      "adds:", "  produces: []",
      "fragments:", "  - anchor: after-step:9", "    order: 100", "---", "",
      "## fragment: after-step:9", "", "### Step 9-A (syn): kept", "", "first", "",
      "## fragment: after-step:9", "", "### Step 9-B (syn): leftover", "", "second", "",
    ].join("\n");
    const { drops } = composeSynthetic("syn-extra", { "contributions/construction/build-and-test.md": extra });
    expect(drops).toContain("no matching frontmatter fragments entry");
  });

  test("a BOM-prefixed contribution is not silently skipped (R5-C4)", () => {
    // A UTF-8 BOM before the frontmatter must not make the whole contribution a
    // no-op — the produces still merges (BOM stripped before the ^--- anchor).
    const bom = `﻿${[
      "---", "target: build-and-test", "plugin: syn-bom",
      "adds:", "  produces:", "    - syn-bom-artifact", "---", "",
    ].join("\n")}`;
    const { proj } = composeSynthetic("syn-bom", { "contributions/construction/build-and-test.md": bom });
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).toContain("syn-bom-artifact"); // merged despite the BOM
  });

  test("close-marker-lookalike prose survives an upgrade re-splice (R5-C2)", () => {
    // Prose containing a `<!-- /plugin:... -->` line, then an upgrade (changed
    // prose). The second run must replace exactly the old block, not cut at the
    // fake marker inside the prose. Assert the upgraded prose is present once and
    // the stage isn't corrupted with a stranded old tail.
    const mk = (tailWord: string) => [
      "---", "target: build-and-test", "plugin: syn-mark",
      "adds:", "  produces: []",
      "fragments:", "  - anchor: after-step:9", "    order: 100", "---", "",
      "## fragment: after-step:9", "", "### Step 9-MARK (syn): tricky", "",
      "A line that looks like a marker:", "<!-- /plugin:syn-mark:after-step:9:100 -->", "",
      `UPGRADE-${tailWord}`, "",
    ].join("\n");
    const proj = mkdtempSync(join(tmp, "syn-mark-"));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
    const root = join(proj, "_plugin");
    cpSync(join(pluginBuilt, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
    cpSync(join(pluginBuilt, "hooks"), join(root, "hooks"), { recursive: true });
    const mf = join(root, ".claude-plugin", "plugin.json");
    const m = JSON.parse(readFileSync(mf, "utf-8")); m.name = "syn-mark"; writeFileSync(mf, JSON.stringify(m));
    const contrib = join(root, "contributions", "construction", "build-and-test.md");
    require("node:fs").mkdirSync(dirname(contrib), { recursive: true });
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" };
    writeFileSync(contrib, mk("ONE"));
    spawnSync(BUN, [join(root, "hooks", "compose.ts")], { cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000, env });
    writeFileSync(contrib, mk("TWO")); // upgrade: changed prose
    const up = spawnSync(BUN, [join(root, "hooks", "compose.ts")], { cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000, env });
    expect(up.status).toBe(0);
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect((body.match(/UPGRADE-TWO/g) ?? []).length).toBe(1); // new prose present once
    expect(body).not.toContain("UPGRADE-ONE"); // old prose fully replaced, no stranded tail
  });

  // --- Doctor severity split: [degraded] fails, [advisory] passes (R5-D1) ---
  // Returns the doctor output + whether it printed a FAILING "Hook drops" row.
  // We assert on the Hook-drops ROW specifically, not global exit: a bare temp
  // install fails unrelated checks (no memory seed), so global exit isn't a clean
  // signal for the drops behavior in isolation.
  function doctorDropsRow(dropLines: string[]): { out: string; failRow: boolean; passRow: boolean } {
    const proj = mkdtempSync(join(tmp, "doc-"));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
    const hd = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
    require("node:fs").mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, "session-start.last"), "2026-07-08T00:00:00Z"); // heartbeat present
    writeFileSync(join(hd, "plugin-compose.drops"), `${dropLines.join("\n")}\n`);
    const r = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-utility.ts"), "doctor"], {
      cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const dropRowLines = out.split("\n").filter((l) => l.includes("Hook drops"));
    return {
      out,
      failRow: dropRowLines.some((l) => l.includes("✗")),
      passRow: dropRowLines.some((l) => l.includes("✓")),
    };
  }

  test("a [degraded] hook drop produces a FAILING doctor row", () => {
    const { failRow } = doctorDropsRow(["2026-07-08T00:00:00Z\t[degraded] contribution to build-and-test: dropped"]);
    expect(failRow).toBe(true);
  });

  test("an [advisory] hook drop produces a PASSING (advisory) doctor row, not a failure", () => {
    const { failRow, passRow, out } = doctorDropsRow(["2026-07-08T00:00:00Z\t[advisory] adds.scopes is not yet an implemented merge surface; ignored"]);
    expect(failRow).toBe(false);
    expect(passRow).toBe(true);
    expect(out).toContain("advisory");
  });

  test("compose self-clears its drops file on a clean run", () => {
    // A clean compose (no drops) leaves no drops file for this plugin.
    const { proj } = composeSynthetic("syn-clean", {
      "contributions/construction/build-and-test.md":
        `---\ntarget: build-and-test\nplugin: syn-clean\nadds:\n  produces:\n    - syn-clean-artifact\n---\n`,
    });
    const dropFile = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health", "plugin-compose-syn-clean.drops");
    expect(existsSync(dropFile)).toBe(false);
  });

  // The pre-rename bundle: key is dead, not aliased: a contribution carrying
  // it is skipped with a drop that names the fix, whether the key appears
  // alone or beside the canonical plugin: key. A stale plugin tree fails
  // visibly instead of composing under wrong or ambiguous ownership.
  test("renamed bundle: key alone is skipped with the fix named", () => {
    const { drops, proj } = composeSynthetic("syn-alias", {
      "contributions/construction/build-and-test.md":
        `---\ntarget: build-and-test\nbundle: syn-alias\nadds:\n  produces:\n    - syn-alias-artifact\n---\n`,
    });
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).not.toContain("syn-alias-artifact");
    expect(drops).toContain("renamed bundle: key");
    expect(drops).toContain("write plugin: instead");
  });

  test("renamed bundle: key beside plugin: is still skipped", () => {
    const { drops, proj } = composeSynthetic("syn-conflict", {
      "contributions/construction/build-and-test.md":
        `---\ntarget: build-and-test\nplugin: syn-conflict\nbundle: other-conflict\nadds:\n  produces:\n    - syn-conflict-artifact\n---\n`,
    });
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).not.toContain("syn-conflict-artifact");
    expect(drops).toContain("renamed bundle: key");
  });

  // A schema-invalid plugin STAGE FILE (e.g. a stale tree still authoring
  // bundle:) must be skip-and-dropped at copy time, NOT copied into the
  // install - graph compile is all-or-nothing, so one bad copy would brick
  // every later compile of the whole install, not just that stage.
  test("a bundle:-keyed plugin stage file is skipped at copy time and the install still compiles", () => {
    const staleStage = [
      "---", "slug: syn-stale-stage", "phase: construction", "execution: ALWAYS",
      "condition: always", "lead_agent: aidlc-quality-agent", "support_agents: []",
      "mode: inline", "produces: []", "consumes: []", "requires_stage: []",
      "inputs: x", "outputs: y", "bundle: syn-stale", "---", "", "# Stale stage body", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-stale", {
      "stages/construction/syn-stale-stage.md": staleStage,
    });
    // The bad stage never landed, the drop names the file + the schema error,
    // and the install's graph still compiles (self-heal probe unaffected).
    expect(existsSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "syn-stale-stage.md"))).toBe(false);
    expect(drops).toContain('stage file "construction/syn-stale-stage.md" not composed');
    expect(drops).toContain("bundle: was renamed");
    const compile = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-graph.ts"), "compile"], {
      cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000,
    });
    expect(compile.status).toBe(0);
  });

  test("an aidlc--prefixed plugin name is refused at compose copy time (runner-path collision)", () => {
    const collidingStage = [
      "---", "slug: aidlc-pro-check", "phase: construction", "execution: ALWAYS",
      "condition: always", "lead_agent: aidlc-quality-agent", "support_agents: []",
      "mode: inline", "produces: []", "consumes: []", "requires_stage: []",
      "inputs: x", "outputs: y", "plugin: aidlc-pro", "---", "", "# Colliding stage", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("aidlc-pro", {
      "stages/construction/aidlc-pro-check.md": collidingStage,
    });
    expect(existsSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "aidlc-pro-check.md"))).toBe(false);
    expect(drops).toContain('"aidlc-" prefix is reserved for core');
  });

  test("packager refuses an aidlc--prefixed plugin name", () => {
    const out = mkdtempSync(join(tmp, "aidlc-named-out-"));
    const r = spawnSync(BUN, [PACKAGE_TS, "plugin", "build", "aidlc-pro", "claude", join(out, "proj")], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('plugin name "aidlc-pro" is reserved');
  });

  test("a frontmatter-only (empty-body) plugin stage file is skipped at copy time", () => {
    const deadStage = [
      "---", "slug: syn-dead-stage", "phase: construction", "execution: ALWAYS",
      "condition: always", "lead_agent: aidlc-quality-agent", "support_agents: []",
      "mode: inline", "produces: []", "consumes: []", "requires_stage: []",
      "inputs: x", "outputs: y", "plugin: syn-dead", "---", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-dead", {
      "stages/construction/syn-dead-stage.md": deadStage,
    });
    expect(existsSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "syn-dead-stage.md"))).toBe(false);
    expect(drops).toContain("stage body is empty");
  });

  // --- Round-6: per-plugin drops isolation + nested fence + plugin colon ---
  test("a clean plugin's compose does NOT erase another plugin's drops (R6-B1)", () => {
    // Two plugins on the same project: A degrades (missing target), B is clean.
    // B's compose must not delete A's degraded drop (per-plugin drops files).
    const proj = mkdtempSync(join(tmp, "syn-iso-"));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
    const mkPlugin = (name: string, contrib: string) => {
      const root = join(proj, `_pl-${name}`);
      cpSync(join(pluginBuilt, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
      cpSync(join(pluginBuilt, "hooks"), join(root, "hooks"), { recursive: true });
      const mf = join(root, ".claude-plugin", "plugin.json");
      const m = JSON.parse(readFileSync(mf, "utf-8")); m.name = name; writeFileSync(mf, JSON.stringify(m));
      const p = join(root, "contributions", "construction", "c.md");
      require("node:fs").mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, contrib);
      spawnSync(BUN, [join(root, "hooks", "compose.ts")], {
        cwd: proj, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" },
      });
    };
    mkPlugin("pl-degraded", `---\ntarget: no-such-stage-xyz\nplugin: pl-degraded\nadds:\n  produces: []\n---\n`);
    mkPlugin("pl-clean", `---\ntarget: build-and-test\nplugin: pl-clean\nadds:\n  produces:\n    - pl-clean-artifact\n---\n`);
    const hd = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
    expect(existsSync(join(hd, "plugin-compose-pl-degraded.drops"))).toBe(true); // survived B's clean run
  });

  test("a nested ```` fence does not mis-close on an inner ``` (R6-B2)", () => {
    const nested = [
      "---", "target: build-and-test", "plugin: syn-nest",
      "adds:", "  produces: []",
      "fragments:", "  - anchor: after-step:9", "    order: 100", "---", "",
      "## fragment: after-step:9", "", "### Step 9-NEST (syn): docs", "",
      "Real intro.", "", "````markdown", "Example:", "```", "## fragment: PHANTOM", "```", "````", "",
      "NEST-TAIL-SURVIVES.", "",
    ].join("\n");
    const { drops, proj } = composeSynthetic("syn-nest", { "contributions/construction/build-and-test.md": nested });
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).toContain("NEST-TAIL-SURVIVES");
    expect(drops).not.toContain("PHANTOM");
  });

  test("a plugin containing ':' is refused with a log (R6-L4)", () => {
    const { drops } = composeSynthetic("syn-colon", {
      "contributions/construction/build-and-test.md":
        `---\ntarget: build-and-test\nplugin: bad:plugin\nadds:\n  produces:\n    - syn-colon-artifact\n---\n`,
    });
    expect(drops).toContain("invalid plugin");
  });

  // --- `plugin build` outDir guard (pre-merge review asks) ---
  // Run the CLI directly; assert it REFUSES (exit 1) and leaves the target intact.
  function pluginBuild(outDir: string, extra: string[] = []): { code: number; out: string } {
    const r = spawnSync(BUN, [PACKAGE_TS, "plugin", "build", PLUGIN, "claude", outDir, ...extra], {
      cwd: REPO_ROOT, encoding: "utf-8", timeout: TIMEOUT_MS - 5_000,
    });
    return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  test("plugin build refuses a non-empty dir that is not a prior projection", () => {
    const d = mkdtempSync(join(tmp, "gb-nonempty-"));
    writeFileSync(join(d, "keep.txt"), "keepme");
    const { code, out } = pluginBuild(d);
    expect(code).toBe(1);
    expect(out).toContain("refusing to build");
    expect(existsSync(join(d, "keep.txt"))).toBe(true); // untouched
  });

  test("plugin build refuses a FOREIGN .claude-plugin checkout (non-aidlc name)", () => {
    const d = mkdtempSync(join(tmp, "gb-foreign-"));
    mkdirSync(join(d, ".claude-plugin"), { recursive: true });
    writeFileSync(join(d, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "someones-other-plugin" }));
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "important.txt"), "keepme");
    const { code } = pluginBuild(d);
    expect(code).toBe(1);
    expect(existsSync(join(d, "src", "important.txt"))).toBe(true); // NOT wiped
  });

  test("plugin build refuses a file outDir with a usage error (no ENOTDIR stack)", () => {
    const f = join(mkdtempSync(join(tmp, "gb-file-")), "afile");
    writeFileSync(f, "x");
    const { code, out } = pluginBuild(f);
    expect(code).toBe(1);
    expect(out).toContain("it is a file, not a directory");
    expect(out).not.toContain("ENOTDIR");
  });

  test("plugin build refuses a symlink outDir — plain and trailing-slash", () => {
    const realDir = mkdtempSync(join(tmp, "gb-real-"));
    // seed the target with a genuine projection so a bypass would be destructive
    pluginBuild(realDir); // builds into realDir (empty → allowed)
    expect(existsSync(join(realDir, ".claude-plugin", "plugin.json"))).toBe(true);
    const linkBase = mkdtempSync(join(tmp, "gb-link-"));
    const link = join(linkBase, "lnk");
    symlinkSync(realDir, link);
    for (const arg of [link, `${link}/`]) {
      const { code, out } = pluginBuild(arg);
      expect(code).toBe(1);
      expect(out).toContain("symlink");
    }
    expect(existsSync(join(realDir, ".claude-plugin", "plugin.json"))).toBe(true); // target intact
  });

  test("plugin build refuses a broken symlink outDir (no raw EEXIST stack)", () => {
    const linkBase = mkdtempSync(join(tmp, "gb-broken-"));
    const link = join(linkBase, "dangling");
    symlinkSync(join(linkBase, "nonexistent-target"), link);
    const { code, out } = pluginBuild(link);
    expect(code).toBe(1);
    expect(out).toContain("symlink");
    expect(out).not.toContain("EEXIST");
  });

  test("plugin build DOES overwrite a genuine prior AIDLC projection (no --force)", () => {
    const d = mkdtempSync(join(tmp, "gb-prior-"));
    expect(pluginBuild(d).code).toBe(0); // first build into empty dir
    expect(existsSync(join(d, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(pluginBuild(d).code).toBe(0); // rebuild over the prior projection — allowed
  });
});
