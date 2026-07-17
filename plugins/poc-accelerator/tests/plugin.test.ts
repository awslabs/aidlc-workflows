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
const AGENTS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "agents");
const PLUGIN_NAME = "poc-accelerator";
const SCOPE_NAME = "poc-accelerator-cde";

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

function agentRoster(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => basename(file, ".md"));
}

const stageFiles = walk(join(PLUGIN_ROOT, "stages"));
const scopeFiles = walk(join(PLUGIN_ROOT, "scopes"));

describe(`${PLUGIN_NAME} plugin — content validation`, () => {
  test("has exactly the eight customer-facing delivery stages", () => {
    expect(stageFiles).toHaveLength(8);
  });

  describe("stage front matter", () => {
    const context: ValidationContext = { agents: agentRoster() };
    for (const file of stageFiles) {
      const filename = basename(file);
      test(`${filename} validates against the framework schema`, () => {
        const frontmatter = parseStageFrontmatter(readFileSync(file, "utf-8"));
        const result = validateStageFrontmatter(frontmatter, context);
        if (!result.valid) throw new Error(`${filename}: ${result.errors.join("; ")}`);
        expect(result.valid).toBe(true);
      });

      test(`${filename} keeps its identity and artifacts namespaced`, () => {
        const frontmatter = parseStageFrontmatter(readFileSync(file, "utf-8"));
        expect(frontmatter.slug).toBe(basename(file, ".md"));
        expect(frontmatter.plugin).toBe(PLUGIN_NAME);
        for (const artifact of (frontmatter.produces as string[]) ?? []) {
          expect(artifact.startsWith(`${PLUGIN_NAME}-`)).toBe(true);
        }
      });

      test(`${filename} belongs only to the delivery scope`, () => {
        const frontmatter = parseStageFrontmatter(readFileSync(file, "utf-8"));
        expect(frontmatter.scopes).toEqual([SCOPE_NAME]);
      });
    }
  });

  test("every required plugin input has a producer in the delivery flow", () => {
    const frontmatters = stageFiles.map((file) =>
      parseStageFrontmatter(readFileSync(file, "utf-8")),
    );
    const produced = new Set(
      frontmatters.flatMap((frontmatter) => (frontmatter.produces as string[]) ?? []),
    );

    for (const frontmatter of frontmatters) {
      for (const consume of (frontmatter.consumes as Array<{ artifact: string; required: boolean }>) ?? []) {
        if (consume.required) expect(produced.has(consume.artifact)).toBe(true);
      }
    }
  });

  test("scope identity remains stable", () => {
    expect(scopeFiles).toHaveLength(1);
    const raw = readFileSync(scopeFiles[0]!, "utf-8");
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    expect(scalarField(frontmatter, "name")).toBe(SCOPE_NAME);
    expect(scalarField(frontmatter, "plugin")).toBe(PLUGIN_NAME);
  });

  test("manifest identifies the source and supported content", () => {
    const manifestPath = join(PLUGIN_ROOT, ".aidlc-plugin", "plugin.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.version).toBeTruthy();
    expect(manifest.aidlc?.contributes).toEqual({
      stages: "stages/",
      scopes: "scopes/",
      knowledge: "knowledge/",
    });
  });
});
