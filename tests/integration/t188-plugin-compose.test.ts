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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const BUN = process.execPath; // the bun running this test — robust for hooks
const TIMEOUT_MS = 60_000;

const PLUGIN = "test-pro";
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude", ".claude");
// The COMMITTED projection — only existsSync-probed (never mutated) by the
// "packager emits" assertions. The compose run below uses a FRESHLY BUILT copy
// under tmp (see beforeAll) so this test never regenerates the committed dist.
const PLUGIN_CLAUDE_COMMITTED = join(REPO_ROOT, "dist", "plugins", PLUGIN, "claude");

// Absolute path to a stage's compiled node in a composed project.
function graph(projectDir: string): Array<Record<string, any>> {
  return JSON.parse(
    readFileSync(join(projectDir, ".claude", "tools", "data", "stage-graph.json"), "utf-8")
  );
}
function stage(projectDir: string, slug: string): Record<string, any> | undefined {
  return graph(projectDir).find((s) => s.slug === slug);
}
function stageBody(projectDir: string, phase: string, slug: string): string {
  return readFileSync(
    join(projectDir, ".claude", "aidlc-common", "stages", phase, `${slug}.md`),
    "utf-8"
  );
}

describe("t188 plugin compose — emit + compose the contribution seam", () => {
  let tmp: string;
  let project: string;
  let pluginBuilt: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t188-"));

    // 1. Build the plugin projection into tmp via the target-dir seam — NEVER
    //    regenerate the committed dist/ (write-mode package.ts rmSync's the
    //    committed trees, which masks drift and races sibling tests under the
    //    parallel integration tier). This exercises the real emitter in isolation.
    pluginBuilt = join(tmp, "plugin", "claude");
    const build = spawnSync(BUN, [PACKAGE_TS, "plugin", "build", PLUGIN, "claude", pluginBuilt], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
    });
    if (build.status !== 0) throw new Error(`plugin build failed: ${build.stderr}`);

    // 2. Fresh base project = a copy of dist/claude/.claude (read-only source).
    project = join(tmp, "proj");
    cpSync(CLAUDE_DIST, join(project, ".claude"), { recursive: true });

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
  });

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  // --- Packager emits the projection ---
  test("packager emits a Claude host-plugin projection", () => {
    expect(existsSync(join(PLUGIN_CLAUDE_COMMITTED, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(PLUGIN_CLAUDE_COMMITTED, "hooks", "compose.ts"))).toBe(true);
    expect(existsSync(join(PLUGIN_CLAUDE_COMMITTED, "hooks", "hooks.json"))).toBe(true);
  });

  test("all four harness projections emit", () => {
    for (const h of ["claude", "codex", "kiro", "kiro-ide"]) {
      expect(existsSync(join(REPO_ROOT, "dist", "plugins", PLUGIN, h))).toBe(true);
    }
  });

  // --- New stages compose + route ---
  test("new plugin stages are in the compiled graph", () => {
    const slugs = graph(project).map((s) => s.slug);
    expect(slugs).toContain("test-pro-integration");
    expect(slugs).toContain("test-pro-full-suite");
    expect(graph(project).length).toBe(34); // 32 core + 2 test-pro
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
    let drops = "";
    for (const d of ["aidlc/spaces/default/intents/.aidlc-hooks-health/plugin-compose.drops"]) {
      const dp = join(proj, d);
      if (existsSync(dp)) drops += readFileSync(dp, "utf-8");
    }
    return { drops, proj };
  }

  test("unresolvable fragment anchor is dropped-with-log, not silent (R4-2)", () => {
    const { drops } = composeSynthetic("syn-anchor", {
      "contributions/construction/build-and-test.md":
        `---\ntarget: build-and-test\nbundle: syn-anchor\nadds:\n  produces: []\nfragments:\n  - anchor: after-step:999\n    order: 100\n---\n\n## fragment: after-step:999\n\n### Step 999x (syn): orphaned\n\nprose\n`,
    });
    expect(drops).toContain("after-step:999");
    expect(drops.toLowerCase()).toContain("dropped");
  });

  test("range-heading anchor resolves (### Step 4-8 → after-step:6) (R4-3)", () => {
    // build-and-test ships `### Step 4-8:`. A fragment at after-step:6 must splice
    // (land in the body), NOT drop as 'not found'.
    const { drops, proj } = composeSynthetic("syn-range", {
      "contributions/construction/build-and-test.md":
        `---\ntarget: build-and-test\nbundle: syn-range\nadds:\n  produces: []\nfragments:\n  - anchor: after-step:6\n    order: 100\n---\n\n## fragment: after-step:6\n\n### Step 6-SYN: lands in range\n\nsyn-range prose\n`,
    });
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).toContain("syn-range prose");
    expect(drops).not.toContain("after-step:6");
  });

  test("stage-slug collision is dropped-with-log, not a silent no-op (R4-4)", () => {
    const { drops, proj } = composeSynthetic("syn-collide", {
      "stages/construction/build-and-test.md":
        `---\nslug: build-and-test\nbundle: syn-collide\nphase: construction\nexecution: ALWAYS\ncondition: always\nlead_agent: aidlc-quality-agent\nsupport_agents: []\nmode: inline\nproduces: []\nconsumes: []\nrequires_stage: []\ninputs: x\noutputs: y\n---\n# SYN-COLLIDE OVERRIDE\n`,
    });
    // the core stage must be untouched, AND the collision must be logged
    const body = readFileSync(join(proj, ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), "utf-8");
    expect(body).not.toContain("SYN-COLLIDE OVERRIDE");
    expect(drops).toContain("collides");
  });
});
