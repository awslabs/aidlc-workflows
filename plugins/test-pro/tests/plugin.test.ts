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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStageFrontmatter,
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

// The real agent roster (dist), plus the reserved orchestrator pseudo-agent.
function agentRoster(): string[] {
  const slugs = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  return [...slugs, "orchestrator"];
}

// Core stage slugs (contribution targets must resolve to one of these).
function coreStageSlugs(): Set<string> {
  return new Set(walk(CORE_STAGES).map((p) => p.replace(/\.md$/, "").split("/").pop()!));
}

const pluginStageFiles = walk(join(PLUGIN_ROOT, "stages"));
const contributionFiles = walk(join(PLUGIN_ROOT, "contributions"));

describe(`${PLUGIN_NAME} plugin — own content validation`, () => {
  test("has stages and contributions to validate", () => {
    expect(pluginStageFiles.length).toBeGreaterThan(0);
    expect(contributionFiles.length).toBeGreaterThan(0);
  });

  // --- Every plugin stage passes the framework's stage schema ---
  describe("stage frontmatter (same validator as core)", () => {
    const ctx: ValidationContext = { agents: agentRoster() };
    for (const file of pluginStageFiles) {
      const name = file.split("/").pop()!;
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

      test(`${name} declares bundle: ${PLUGIN_NAME}`, () => {
        const fm = parseStageFrontmatter(readFileSync(file, "utf-8"));
        expect(fm.bundle).toBe(PLUGIN_NAME);
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
      const name = file.split("/").pop()!;
      const content = readFileSync(file, "utf-8");
      const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

      test(`${name} targets a real core stage`, () => {
        const target = fm.match(/^target:\s*(.+)$/m)?.[1].trim();
        expect(target).toBeTruthy();
        expect(cores.has(target!)).toBe(true);
      });

      test(`${name} declares bundle: ${PLUGIN_NAME}`, () => {
        expect(fm.match(/^bundle:\s*(.+)$/m)?.[1].trim()).toBe(PLUGIN_NAME);
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
