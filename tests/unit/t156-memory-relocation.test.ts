// covers: function:loadRules
//
// t156 — the method ("memory") relocation + per-harness native include (P5).
//
// WHAT. The AIDLC method (the layered practice files org/team/project + the
// per-phase phases/<phase>.md) relocated OUT of the per-harness rule dir
// (.claude/rules / .kiro/steering / .codex/aidlc-rules, all carrying aidlc-*.md
// names) to ONE hand-editable source of truth at the workspace root —
// aidlc/spaces/default/memory/ — with neutral filenames. Each harness reads it
// by its OWN native include (no copy, no drift):
//   - Claude  → .claude/rules/aidlc.md @-import stub → @../../aidlc/spaces/
//               default/memory/<file> (explicit @-lines; Claude @-imports do
//               NOT glob — verified against code.claude.com/docs memory.md).
//   - Kiro    → agent JSON resources glob file://aidlc/spaces/default/memory/**/*.md
//   - Codex   → AGENTS.md auto-merge + AIDLC_RULES_DIR seam + orchestrator
//               @-mention (the static seam is asserted here; the LIVE @-mention
//               probe lives in the gated e2e tests/e2e/
//               t-exec-codex-memory-include.serial.test.ts — green 2026-06-24).
//
// Three contracts land here:
//   (1) RESOLVER reads the renamed source + tolerates empty team/project stubs
//       (in-process loadRules via the AIDLC_RULES_DIR seam against a fixture
//       laid out as the relocated tree: org/team/project.md + phases/<p>.md).
//   (2) 3-WAY native-include resolution in the shipped dist trees: the Claude
//       @-stub resolves the relocated path (packaging/parity); the Kiro globs
//       point at the active space; the Codex static seam is wired
//       (AIDLC_RULES_DIR + AGENTS.md). The Codex LIVE @-mention probe is the
//       gated e2e t-exec-codex-memory-include.serial.test.ts (no token probe
//       here — unit tier stays zero-LLM).
//   (3) THE ONE-COPY INVARIANT: exactly one HAND-EDITABLE rule copy exists
//       (core/memory/), and no second hand-editable copy lives under a harness
//       rule dir. The dist copies are GENERATED (drift-guarded by package.ts
//       --check), not hand-editable, so they are excluded.
//
// Mechanism: none for (1) (in-process pure-function call via the documented
// env seam); file-inspection over the committed dist trees for (2)/(3). No LLM,
// no subprocess (the grep in (3) is a git ls over the repo). Zero tokens.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetGraphCache,
  loadRules,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const tempDirs: string[] = [];
function mkTemp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `aidlc-t156-${tag}-`));
  tempDirs.push(d);
  return d;
}

let savedRulesDir: string | undefined;
beforeEach(() => {
  savedRulesDir = process.env.AIDLC_RULES_DIR;
});
afterEach(() => {
  if (savedRulesDir === undefined) delete process.env.AIDLC_RULES_DIR;
  else process.env.AIDLC_RULES_DIR = savedRulesDir;
  __resetGraphCache();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a relocated method tree (the new layout) under a temp dir and point
 *  the resolver at it via AIDLC_RULES_DIR. Returns the dir. */
function seedMemoryTree(files: Record<string, string>): string {
  const dir = mkTemp("mem");
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body, "utf-8");
  }
  process.env.AIDLC_RULES_DIR = dir;
  __resetGraphCache();
  return dir;
}

describe("t156 method relocation to aidlc/spaces/default/memory/ + per-harness include (P5)", () => {
  // === (1) resolver reads the RENAMED + NESTED source ======================
  test("1: loadRules reads neutral org/team/project + nested phases/<p>.md", () => {
    seedMemoryTree({
      "org.md": "# Org\n\n## Way of Working\n\nTrunk-based.\n",
      "team.md": "# Team\n\n## Code Style\n\nNamed exports.\n",
      "project.md": "# Project\n\n## Tech Stack\n\nBun.\n",
      "phases/construction.md": "# Construction phase rule\n\nBuild-and-test.\n",
    });
    const rules = loadRules();
    const byScope = rules.map((r) => r.scope).sort();
    expect(byScope).toEqual(["org", "phase", "project", "team"]);
    // The display paths are harness-neutral and point at the relocated tree.
    expect(rules.map((r) => r.path)).toContain("aidlc/spaces/default/memory/org.md");
    const phase = rules.find((r) => r.scope === "phase");
    expect(phase?.path).toBe("aidlc/spaces/default/memory/phases/construction.md");
    expect(phase?.phase).toBe("construction");
  });

  // === (1b) precedence order is preserved (org<team<project<phase) ========
  test("2: resolved order is org → team → project → phase", () => {
    seedMemoryTree({
      "org.md": "# Org\n",
      "team.md": "# Team\n",
      "project.md": "# Project\n",
      "phases/inception.md": "# Inception\n",
    });
    expect(loadRules().map((r) => r.scope)).toEqual([
      "org",
      "team",
      "project",
      "phase",
    ]);
  });

  // === (1c) empty/comment-only team + project stubs resolve cleanly =======
  test("3: empty team/project stubs are read as empty RuleFiles (no throw)", () => {
    seedMemoryTree({
      "org.md": "# Org\n\n## Way of Working\n\nTrunk-based.\n",
      // team/project are commented-stub only (the shipped baseline shape) — the
      // resolver must still admit them as zero-heading-body RuleFiles, not skip
      // or throw (the new-space + greenfield path depends on this).
      "team.md": "# Team\n\n## Way of Working\n\n<!-- affirmed at the gate -->\n",
      "project.md": "# Project\n\n## Decided\n\n<!-- nothing yet -->\n",
    });
    const rules = loadRules();
    expect(rules.map((r) => r.scope).sort()).toEqual(["org", "project", "team"]);
    const team = rules.find((r) => r.scope === "team");
    // The comment-only heading body parses to empty — a populated org heading
    // would carry text, this one does not.
    expect(team?.headings.get("Way of Working")?.trim() ?? "").toBe("");
  });

  // === (1d) tolerate an absent method dir (returns []) ====================
  test("4: an absent method dir resolves to [] (zero-rules edge case)", () => {
    process.env.AIDLC_RULES_DIR = join(mkTemp("gone"), "does-not-exist");
    __resetGraphCache();
    expect(loadRules()).toEqual([]);
  });

  // === (2) 3-WAY native-include resolution in the shipped dist trees ======
  const MEM = (harness: string) =>
    join(REPO_ROOT, "dist", harness, "aidlc", "spaces", "default", "memory");

  test("5: every harness ships the relocated method tree at the workspace root", () => {
    for (const harness of HARNESS_MATRIX) {
      const top = readdirSync(MEM(harness.name)).sort();
      // org/team/project + phases/ are P5's relocated method; templates/ is the
      // SEED-shipped TPL override floor (empty-but-present via a .gitkeep) — it
      // is part of the shipped shell, so the method top-level now includes it.
      expect(top, `${harness.name} method top-level`).toEqual([
        "org.md",
        "phases",
        "project.md",
        "team.md",
        "templates",
      ]);
      expect(readdirSync(join(MEM(harness.name), "phases")).sort()).toEqual([
        "construction.md",
        "ideation.md",
        "inception.md",
        "operation.md",
      ]);
    }
  });

  test("6: Claude @-stub resolves the relocated path (every method file has an @-line)", () => {
    const stub = readFileSync(
      join(REPO_ROOT, "dist", "claude", ".claude", "rules", "aidlc.md"),
      "utf-8",
    );
    // Claude @-imports name an explicit file each (no glob), resolve relative to
    // the stub's location, and the workspace root is ../../ from .claude/rules/.
    // Every shipped method file must have a matching @-line or the chain is
    // incomplete (a glob would silently skip files — verified unsupported).
    const memFiles = [
      "org.md",
      "team.md",
      "project.md",
      "phases/ideation.md",
      "phases/inception.md",
      "phases/construction.md",
      "phases/operation.md",
    ];
    for (const f of memFiles) {
      expect(stub, `stub @-line for ${f}`).toContain(`@../../aidlc/spaces/default/memory/${f}`);
    }
    // And CLAUDE.md imports the stub (top of the reference chain).
    const claudeMd = readFileSync(
      join(REPO_ROOT, "dist", "claude", ".claude", "CLAUDE.md"),
      "utf-8",
    );
    expect(claudeMd).toContain("@.claude/rules/aidlc.md");
    // The old per-harness rule layer no longer ships (only the stub remains).
    const rulesDirFiles = readdirSync(
      join(REPO_ROOT, "dist", "claude", ".claude", "rules"),
    );
    expect(rulesDirFiles).toEqual(["aidlc.md"]);
  });

  test("7: EVERY Kiro-family agent resources glob points at the active space's memory tree (not the now-empty steering dir)", () => {
    // Select Kiro agent-JSON distributions from explicit matrix capabilities,
    // then derive the agent list from each shipped tree.
    // A closed list let the kiro-ide harness + the two reviewer personas ship
    // pointing at the empty `.kiro/steering/*.md` glob (loading zero method files)
    // because they were absent from the enumerated set. Every dist tree that ships
    // `.kiro/agents/*.json` (kiro CLI + kiro IDE) and every agent in it that
    // declares a `resources` array must resolve the method via the relocated
    // memory glob, and none may still point at the retired steering glob.
    const kiroTrees = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.kiroAgentJson,
    );
    expect(kiroTrees.length).toBeGreaterThan(0);

    let checkedAgents = 0;
    let expectedAgents = 0;
    for (const harness of kiroTrees) {
      const agentsDir = join(harness.engineRoot, "agents");
      const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
      expect(agentFiles.length, `${harness.name} ships agent JSONs`).toBeGreaterThan(0);
      expectedAgents += agentFiles.length;
      let harnessChecked = 0;
      for (const f of agentFiles) {
        const json = JSON.parse(readFileSync(join(agentsDir, f), "utf-8")) as {
          resources?: string[];
        };
        expect(Array.isArray(json.resources), `${harness.name}/${f}: resources`).toBe(true);
        if (!json.resources) continue;
        checkedAgents++;
        harnessChecked++;
        expect(json.resources, `${harness.name}/${f} resources → relocated memory`).toContain(
          "file://aidlc/spaces/default/memory/**/*.md",
        );
        // The old steering glob is gone from `resources` (note: `.kiro/steering/**`
        // may legitimately remain in fs_write.allowedPaths — that is a write
        // permission, NOT a method-load glob, so we only inspect `resources`).
        expect(
          json.resources.some((r) => r.includes(".kiro/steering")),
          `${harness.name}/${f} resources must not point at the empty steering dir`,
        ).toBe(false);
      }
      expect(harnessChecked, `${harness.name}: agents with resources`).toBeGreaterThan(0);
    }
    expect(checkedAgents).toBe(expectedAgents);
  });

  test("8: Codex include is wired (AIDLC_RULES_DIR seam + AGENTS.md)", () => {
    // This asserts the STATIC seam here (unit tier, zero tokens): the resolver
    // env override re-points at the relocated tree, and the root AGENTS.md ships
    // for auto-merge. The LIVE empirical probe — that `codex exec` actually
    // resolves an @aidlc/spaces/default/memory/<file> mention and pulls its
    // content into context — now lives in the gated e2e test
    // tests/e2e/t-exec-codex-memory-include.serial.test.ts (verified green
    // 2026-06-24, codex-cli 0.139.0 on Bedrock; the earlier spike's exit-124
    // hang is resolved). So the seam is no longer doc-verified-only.
    const config = readFileSync(
      join(REPO_ROOT, "dist", "codex", ".codex", "config.toml"),
      "utf-8",
    );
    expect(config).toContain('AIDLC_RULES_DIR = "aidlc/spaces/default/memory"');
    // .codex/aidlc-rules/ (the old per-harness copy) is gone.
    expect(existsSync(join(REPO_ROOT, "dist", "codex", ".codex", "aidlc-rules"))).toBe(false);
    // The root AGENTS.md (Codex's directory-merge surface) ships.
    expect(existsSync(join(REPO_ROOT, "dist", "codex", "AGENTS.md"))).toBe(true);
  });

  // === (3) THE ONE-COPY INVARIANT =========================================
  test("9: exactly ONE hand-editable rule copy exists — core/memory/", () => {
    // Walk the authored surfaces (core/ + harness/), NOT dist/ (generated,
    // drift-guarded) and NOT tests/ (fixtures). The only org/team/project +
    // phases/ method files that may exist are under core/memory/.
    const offenders: string[] = [];
    const roots = [join(REPO_ROOT, "core"), join(REPO_ROOT, "harness")];
    const METHOD_BASENAMES = new Set(["org.md", "team.md", "project.md"]);
    function walk(dir: string): void {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
          continue;
        }
        const rel = full.slice(REPO_ROOT.length + 1);
        // A method file (org/team/project.md) or a flat aidlc-phase-*.md / a
        // phases/<p>.md that is NOT under core/memory/ is a second copy.
        const isMethodTop = METHOD_BASENAMES.has(e.name);
        const isLegacyPhase = /^aidlc-phase-[a-z][a-z0-9-]*\.md$/.test(e.name);
        const isLegacyLayer = /^aidlc-(org|team|project)\.md$/.test(e.name);
        const underCoreMemory = rel.startsWith("core/memory/");
        if ((isMethodTop && !underCoreMemory) || isLegacyPhase || isLegacyLayer) {
          offenders.push(rel);
        }
      }
    }
    for (const r of roots) if (existsSync(r)) walk(r);
    expect(offenders, `second hand-editable rule copy found: ${offenders.join(", ")}`).toEqual([]);

    // Positive control: the one source of truth IS present.
    expect(existsSync(join(REPO_ROOT, "core", "memory", "org.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "core", "memory", "phases", "construction.md"))).toBe(true);
    // And core/rules/ (the old authored location) is gone entirely.
    expect(existsSync(join(REPO_ROOT, "core", "rules"))).toBe(false);
  });
});
