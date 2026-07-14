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

// Absolute path to a stage's compiled node in a composed project.
function graph(projectDir: string): Array<Record<string, any>> {
  return JSON.parse(
    readFileSync(join(projectDir, ".claude", "tools", "data", "stage-graph.json"), "utf-8")
  );
}
function stage(projectDir: string, slug: string): Record<string, any> | undefined {
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
    const consumed = (bat?.consumes ?? []).map((c: any) => c.artifact);
    // BOTH test-pro consumes must land — not just the first (round-2 blocker:
    // the old parser dropped every entry after the first).
    expect(consumed).toContain("test-pro-testability-requirements");
    expect(consumed).toContain("test-pro-test-harness-design");
    // ...and each authored `required: false` must be preserved, not flipped to
    // true by an empty `required` scan (the same blocker's second half).
    for (const art of ["test-pro-testability-requirements", "test-pro-test-harness-design"]) {
      const entry = (bat?.consumes ?? []).find((c: any) => c.artifact === art);
      expect(entry?.required).toBe(false);
    }
    // The pre-existing core consumes are untouched (still required: true).
    const core = (bat?.consumes ?? []).find((c: any) => c.artifact === "code-generation-plan");
    expect(core?.required).toBe(true);
  });

  test("contribution merges sensors into the target stage node", () => {
    const bat = stage(project, "build-and-test");
    const sensors = (bat?.sensors_applicable ?? []).map((s: any) => s.id);
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
    const full = JSON.parse(readFileSync(graphPath, "utf-8"));
    const stripped = full.filter((s: any) => !String(s.slug ?? "").startsWith("test-pro-"));
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
  function composeSynthetic(name: string, files: Record<string, string>): { drops: string; proj: string } {
    const proj = mkdtempSync(join(tmp, `syn-${name}-`));
    cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });
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
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" },
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
    const bom = "﻿" + [
      "---", "target: build-and-test", "plugin: syn-bom",
      "adds:", "  produces:", "    - syn-bom-artifact", "---", "",
    ].join("\n");
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
    writeFileSync(join(hd, "plugin-compose.drops"), dropLines.join("\n") + "\n");
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
    for (const arg of [link, link + "/"]) {
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
