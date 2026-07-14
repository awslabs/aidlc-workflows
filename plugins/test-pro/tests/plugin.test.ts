// plugins/test-pro/tests/plugin.test.ts — the test-pro plugin's OWN test harness.
//
// Distinct from the framework's t188 (which proves the compose MECHANISM works):
// this validates the PLUGIN'S OWN CONTENT with the same rigor the framework
// applies to core — every stage's frontmatter passes the real
// validateStageFrontmatter, agents resolve against the real roster, produced
// artifacts are correctly `test-pro-` namespaced, and every contribution targets
// a real core stage. A plugin author (first- or third-party) runs this before
// shipping. Copy this shape for your own plugin.
//
// Run:  bun test plugins/test-pro/tests/plugin.test.ts

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStageFrontmatter,
  scalarField,
} from "../../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  type ValidationContext,
  validateStageFrontmatter,
} from "../../../dist/claude/.claude/tools/aidlc-stage-schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const REPO_ROOT = join(PLUGIN_ROOT, "..", "..");
const CORE_STAGES = join(REPO_ROOT, "dist", "claude", ".claude", "aidlc-common", "stages");
const AGENTS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "agents");

const PLUGIN_NAME = "test-pro";

// --- helpers ---

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// The real core agent roster (dist), plus this plugin's own agents/ bucket and
// the reserved orchestrator pseudo-agent. A plugin-shipped stage may name a
// plugin-shipped persona as lead_agent/support_agents at author-validation time.
function agentRoster(): string[] {
  const coreSlugs = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  const pluginSlugs = walk(join(PLUGIN_ROOT, "agents"))
    .map((f) => basename(f, ".md"));
  return [...new Set([...coreSlugs, ...pluginSlugs, "orchestrator"])].sort();
}

// Core stage slugs (contribution targets must resolve to one of these).
function coreStageSlugs(): Set<string> {
  return new Set(walk(CORE_STAGES).map((p) => basename(p, ".md")));
}

const pluginStageFiles = walk(join(PLUGIN_ROOT, "stages"));
const contributionFiles = walk(join(PLUGIN_ROOT, "contributions"));
const pluginScopeFiles = walk(join(PLUGIN_ROOT, "scopes"));
const pluginAgentFiles = walk(join(PLUGIN_ROOT, "agents"));

function stageBodyAfterFrontmatter(raw: string): string {
  return raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? "";
}

describe(`${PLUGIN_NAME} plugin — own content validation`, () => {
  test("has stages and contributions to validate", () => {
    expect(pluginStageFiles.length).toBeGreaterThan(0);
    expect(contributionFiles.length).toBeGreaterThan(0);
  });

  // --- Every plugin stage passes the framework's stage schema ---
  describe("stage frontmatter (same validator as core)", () => {
    const ctx: ValidationContext = { agents: agentRoster() };
    for (const file of pluginStageFiles) {
      const name = basename(file);
      test(`${name} validates`, () => {
        const fm = parseStageFrontmatter(readFileSync(file, "utf-8"));
        const r = validateStageFrontmatter(fm, ctx);
        if (!r.valid) throw new Error(`${name}: ${r.errors.join("; ")}`);
        expect(r.valid).toBe(true);
      });

      test(`${name} slug matches filename stem`, () => {
        const fm = parseStageFrontmatter(readFileSync(file, "utf-8"));
        expect(fm.slug).toBe(name.replace(/\.md$/, ""));
      });

      test(`${name} declares plugin: ${PLUGIN_NAME}`, () => {
        const fm = parseStageFrontmatter(readFileSync(file, "utf-8"));
        expect(fm.plugin).toBe(PLUGIN_NAME);
      });

      test(`${name} has a non-empty body`, () => {
        const body = stageBodyAfterFrontmatter(readFileSync(file, "utf-8"));
        if (body.trim().length === 0) {
          throw new Error(
            `${name}: stage body is empty - the stage is behaviorally dead; did a transform drop everything after the closing ---?`
          );
        }
        expect(body.trim().length).toBeGreaterThan(0);
      });

      test(`${name} produces only ${PLUGIN_NAME}- namespaced artifacts`, () => {
        const fm = parseStageFrontmatter(readFileSync(file, "utf-8"));
        for (const artifact of (fm.produces as string[]) ?? []) {
          expect(artifact.startsWith(`${PLUGIN_NAME}-`)).toBe(true);
        }
      });
    }
  });

  // --- Every contribution targets a real core stage + namespaces its additions ---
  describe("contributions (target resolution + namespacing)", () => {
    const cores = coreStageSlugs();
    for (const file of contributionFiles) {
      const name = basename(file);
      const content = readFileSync(file, "utf-8");
      const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

      test(`${name} targets a real core stage`, () => {
        const target = fm.match(/^target:\s*(.+)$/m)?.[1].trim();
        expect(target).toBeTruthy();
        expect(cores.has(target ?? "")).toBe(true);
      });

      test(`${name} declares plugin: ${PLUGIN_NAME}`, () => {
        expect(fm.match(/^plugin:\s*(.+)$/m)?.[1].trim()).toBe(PLUGIN_NAME);
      });

      test(`${name} adds.produces are ${PLUGIN_NAME}- namespaced`, () => {
        const addsBlock = fm.match(/^adds:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? "";
        const producesSection = addsBlock.match(/produces:\n((?:\s+- [\w-]+\n?)*)/);
        const items = producesSection
          ? [...producesSection[1].matchAll(/^\s+- ([\w-]+)/gm)].map((m) => m[1])
          : [];
        for (const artifact of items) {
          expect(artifact.startsWith(`${PLUGIN_NAME}-`)).toBe(true);
        }
      });
    }
  });

  // --- Plugin-shipped scopes and agents keep filename identity stable ---
  describe("scope and agent naming", () => {
    for (const file of pluginScopeFiles) {
      const name = basename(file);
      test(`${name} scope name matches filename stem`, () => {
        const raw = readFileSync(file, "utf-8");
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
        expect(scalarField(fm, "name")).toBe(basename(file, ".md"));
      });
    }

    for (const file of pluginAgentFiles) {
      const name = basename(file);
      test(`${name} agent name matches filename stem`, () => {
        const raw = readFileSync(file, "utf-8");
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
        expect(scalarField(fm, "name")).toBe(basename(file, ".md"));
      });
    }
  });

  // --- The manifest is well-formed ---
  describe("manifest", () => {
    const manifestPath = join(PLUGIN_ROOT, ".aidlc-plugin", "plugin.json");
    test("plugin.json exists + parses", () => {
      expect(existsSync(manifestPath)).toBe(true);
      const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(m.name).toBe(PLUGIN_NAME);
      expect(m.version).toBeTruthy();
      expect(m.aidlc?.contributes).toBeTruthy();
    });
  });
});
