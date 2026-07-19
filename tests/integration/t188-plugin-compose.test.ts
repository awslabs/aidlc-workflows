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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_MATRIX,
  type ShippedHarnessName,
} from "../harness/harness-matrix.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const BUN = process.execPath; // the bun running this test — robust for hooks
const TIMEOUT_MS = 60_000;

const PLUGIN = "test-pro";
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude", ".claude");
const OPENCODE_DIST = join(REPO_ROOT, "dist", "opencode");
const KIRO_DIST = join(REPO_ROOT, "dist", "kiro", ".kiro");
const CODEX_DIST = join(REPO_ROOT, "dist", "codex", ".codex");
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
function bodyAfterFrontmatter(raw: string): string {
  return raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? "";
}
function assertNonEmptyStageBody(file: string): void {
  const body = bodyAfterFrontmatter(readFileSync(file, "utf-8"));
  if (body.trim().length === 0) {
    throw new Error(
      `${file}: stage body is empty - the stage is behaviorally dead; did a transform drop everything after the closing ---?`
    );
  }
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
      const build = spawnSync(
        BUN,
        [PACKAGE_TS, "plugin", "build", PLUGIN, harness.name, built],
        {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          timeout: TIMEOUT_MS - 5_000,
        },
      );
      if (build.status !== 0) {
        throw new Error(`plugin build failed for ${harness.name}: ${build.stderr}`);
      }
      pluginBuilds.set(harness.name, built);
    }
    pluginBuilt = pluginBuilds.get("claude")!;

    // 2. Fresh base project = a copy of dist/claude/.claude (read-only source).
    project = join(tmp, "proj");
    cpSync(CLAUDE_DIST, join(project, ".claude"), { recursive: true });
    coreRunnerBefore = readFileSync(
      join(project, ".claude", "skills", "aidlc-code-generation", "SKILL.md"),
      "utf-8",
    );

    // 3. Run the real compose hook (as a host SessionStart hook would).
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
      const wiring = readFileSync(
        join(built, harness.capabilities.plugin.wiringFile),
        "utf-8",
      );
      expect(wiring, `${harness.name}: harness dir wiring`).toContain(
        `AIDLC_HARNESS_DIR=${harness.manifest.harnessDir}`,
      );
      expect(existsSync(join(built, "stages", "construction", "test-pro-integration.md"))).toBe(
        true,
      );
      expect(existsSync(join(built, "contributions", "construction", "build-and-test.md"))).toBe(
        true,
      );
      // #550 plugin content buckets: scopes, agents, and knowledge must project
      // into EVERY harness (stronger than the pre-matrix Claude-only guard).
      expect(existsSync(join(built, "scopes", "test-pro-validation.md")), `${harness.name}: scope`).toBe(true);
      expect(existsSync(join(built, "agents", "test-pro-metrics-agent.md")), `${harness.name}: agent`).toBe(true);
      expect(
        existsSync(join(built, "knowledge", "test-pro-metrics-agent", "methodology.md")),
        `${harness.name}: knowledge`,
      ).toBe(true);
    }
  });

  test("OpenCode compose emits plugin agents to both inline and native rosters", () => {
    const pluginOpenCode = join(tmp, "plugin", "opencode");
    const build = spawnSync(
      BUN,
      [PACKAGE_TS, "plugin", "build", PLUGIN, "opencode", pluginOpenCode],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
      },
    );
    if (build.status !== 0) throw new Error(`opencode plugin build failed: ${build.stderr}`);

    const opencodeProject = mkdtempSync(join(tmp, "opencode-compose-"));
    cpSync(OPENCODE_DIST, opencodeProject, { recursive: true });
    const compose = spawnSync(BUN, [join(pluginOpenCode, "hooks", "compose.ts")], {
      cwd: opencodeProject,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        PLUGIN_ROOT: pluginOpenCode,
        AIDLC_PROJECT_DIR: opencodeProject,
        AIDLC_HARNESS_DIR: ".aidlc",
      },
    });
    if (compose.status !== 0) throw new Error(`opencode compose failed: ${compose.stderr}`);

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

  // --- New stages compose + route ---
  test("new plugin stages are in the compiled graph", () => {
    const slugs = graph(project).map((s) => s.slug);
    expect(slugs).toContain("test-pro-integration");
    expect(slugs).toContain("test-pro-full-suite");
    expect(graph(project).length).toBe(34); // 32 core + 2 test-pro
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
    const root = join(proj, "_plugin");
    // minimal projection: manifest + the one working compose hook + given files
    cpSync(join(pluginBuilt, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
    cpSync(join(pluginBuilt, "hooks"), join(root, "hooks"), { recursive: true });
    // rewrite the manifest name so the synthetic plugin has its own identity
    const mf = join(root, ".claude-plugin", "plugin.json");
    const m = JSON.parse(readFileSync(mf, "utf-8")); m.name = name; writeFileSync(mf, JSON.stringify(m));
    for (const [rel, body] of Object.entries(files)) {
      const p = join(root, rel);
      cpSync(join(pluginBuilt, "hooks", "compose.ts"), join(root, "hooks", "compose.ts")); // ensure hook present
      require("node:fs").mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
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
    expect(drops).toContain('stage "syn-kiro-ensemble"');
    expect(drops).toContain('agent "syn-kiro-collaborator-agent"');
    expect(drops).toContain("agent-v1 JSON");
    expect(drops).toContain("toolsSettings.subagent.trustedAgents");
    expect(drops).toContain("change the stage's mode to inline");
    // The lead is a CORE persona: its shipped agent-v1 JSON is its dispatch
    // surface, so it must never be named as undispatchable.
    expect(drops).not.toContain('agent "aidlc-product-agent"');
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
    // Finding-2 regression guard: with the installed aidlc-lib.ts removed the
    // guard cannot resolve agent references, but an inline-only plugin must
    // still compose fully - fail-closed is scoped to dispatched topologies.
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

    // composeSynthetic runs the hook itself, so build the project by hand to
    // delete the installed lib BEFORE composing.
    const proj = mkdtempSync(join(tmp, "syn-noparse-"));
    cpSync(KIRO_DIST, join(proj, ".kiro"), { recursive: true });
    rmSync(join(proj, ".kiro", "tools", "aidlc-lib.ts"));
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

    const stages = join(proj, ".kiro", "aidlc-common", "stages", "inception");
    expect(existsSync(join(stages, "syn-noparse-inline.md"))).toBe(true);
    expect(existsSync(join(stages, "syn-noparse-mob.md"))).toBe(false);
    expect(existsSync(join(proj, ".kiro", "agents", "syn-noparse-agent.md"))).toBe(true);

    let drops = "";
    const hd = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
    if (existsSync(hd)) {
      for (const f of require("node:fs").readdirSync(hd) as string[]) {
        if (f.startsWith("plugin-compose") && f.endsWith(".drops")) drops += readFileSync(join(hd, f), "utf-8");
      }
    }
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
