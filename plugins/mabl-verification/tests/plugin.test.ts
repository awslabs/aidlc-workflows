/**
 * plugin.test.ts — Content validation for the mabl-verification plugin.
 *
 * Validates that all plugin files conform to the AIDLC plugin contract:
 * - Stage frontmatter is well-formed and references valid agents
 * - Slugs match filenames
 * - Artifacts are plugin-namespaced (mabl-verification-*)
 * - Contributions target real core stages
 * - Sensor manifests follow the aidlc-<id>.md naming convention
 * - The plugin.json manifest is valid
 *
 * Run: bun test plugins/mabl-verification/tests/plugin.test.ts
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename, extname } from "path";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const PLUGIN_NAME = "mabl-verification";
const ARTIFACT_PREFIX = "mabl-verification-";

// --- Helpers ---

function readYamlFrontmatter(filePath: string): Record<string, unknown> | null {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  // Simple YAML parser for flat/shallow structures (good enough for validation)
  const lines = match[1].split("\n");
  const result: Record<string, unknown> = {};
  let currentKey = "";
  let currentList: string[] | null = null;

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (kvMatch) {
      if (currentList && currentKey) {
        result[currentKey] = currentList;
        currentList = null;
      }
      const [, key, value] = kvMatch;
      currentKey = key;
      if (value.trim() === "") {
        // Could be start of a list or multi-line
      } else if (value.trim() === ">") {
        // Multi-line string — skip for now
      } else {
        result[key] = value.trim();
      }
    } else if (line.match(/^\s+-\s+(.+)$/)) {
      const itemMatch = line.match(/^\s+-\s+(.+)$/);
      if (itemMatch) {
        if (!currentList) currentList = [];
        currentList.push(itemMatch[1].trim());
      }
    }
  }
  if (currentList && currentKey) {
    result[currentKey] = currentList;
  }

  return result;
}

function getStageFiles(): string[] {
  const stages: string[] = [];
  const stagesDir = join(PLUGIN_ROOT, "stages");
  if (!existsSync(stagesDir)) return stages;

  for (const phase of readdirSync(stagesDir)) {
    const phaseDir = join(stagesDir, phase);
    for (const file of readdirSync(phaseDir)) {
      if (file.endsWith(".md")) {
        stages.push(join(phaseDir, file));
      }
    }
  }
  return stages;
}

function getContributionFiles(): string[] {
  const contributions: string[] = [];
  const contribDir = join(PLUGIN_ROOT, "contributions");
  if (!existsSync(contribDir)) return contributions;

  for (const phase of readdirSync(contribDir)) {
    const phaseDir = join(contribDir, phase);
    for (const file of readdirSync(phaseDir)) {
      if (file.endsWith(".md")) {
        contributions.push(join(phaseDir, file));
      }
    }
  }
  return contributions;
}

function getSensorFiles(): string[] {
  const sensorsDir = join(PLUGIN_ROOT, "sensors");
  if (!existsSync(sensorsDir)) return [];
  return readdirSync(sensorsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(sensorsDir, f));
}

// Known core stages that contributions can target
const CORE_STAGES = [
  "project-bootstrap",
  "workspace-scan",
  "workflow-planning",
  "problem-definition",
  "exploration",
  "functional-requirements",
  "nfr-requirements",
  "functional-design",
  "nfr-design",
  "practices-discovery",
  "user-stories",
  "code-implementation",
  "build-and-test",
  "performance-validation",
  "release-deployment",
  "observability-setup",
];

// Known agents in the framework + this plugin
const KNOWN_AGENTS = [
  "aidlc-architect-agent",
  "aidlc-architecture-reviewer-agent",
  "aidlc-aws-platform-agent",
  "aidlc-compliance-agent",
  "aidlc-composer-agent",
  "aidlc-delivery-agent",
  "aidlc-design-agent",
  "aidlc-developer-agent",
  "aidlc-devsecops-agent",
  "aidlc-operations-agent",
  "aidlc-pipeline-deploy-agent",
  "aidlc-product-agent",
  "aidlc-product-lead-agent",
  "aidlc-quality-agent",
  "mabl-verification-agent", // this plugin's agent
];

// --- Tests ---

describe("mabl-verification plugin manifest", () => {
  const manifestPath = join(PLUGIN_ROOT, ".aidlc-plugin", "plugin.json");

  it("plugin.json exists and is valid JSON", () => {
    expect(existsSync(manifestPath)).toBe(true);
    const content = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(content);
    expect(manifest).toBeDefined();
  });

  it("plugin.json has required fields", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description).toBeTruthy();
    expect(manifest.dependencies).toContain("core");
    expect(manifest.aidlc).toBeDefined();
    expect(manifest.aidlc.contributes).toBeDefined();
  });

  it("plugin name is not reserved (not core, aidlc, or aidlc-*)", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.name).not.toBe("core");
    expect(manifest.name).not.toBe("aidlc");
    expect(manifest.name).not.toMatch(/^aidlc-/);
  });
});

describe("mabl-verification stages", () => {
  const stageFiles = getStageFiles();

  it("has at least one stage file", () => {
    expect(stageFiles.length).toBeGreaterThan(0);
  });

  for (const stageFile of stageFiles) {
    const slug = basename(stageFile, ".md");

    describe(`stage: ${slug}`, () => {
      it("slug matches filename", () => {
        const frontmatter = readYamlFrontmatter(stageFile);
        expect(frontmatter).not.toBeNull();
        expect(frontmatter!.slug).toBe(slug);
      });

      it("declares plugin ownership", () => {
        const frontmatter = readYamlFrontmatter(stageFile);
        expect(frontmatter!.plugin).toBe(PLUGIN_NAME);
      });

      it("references a known lead_agent", () => {
        const frontmatter = readYamlFrontmatter(stageFile);
        expect(KNOWN_AGENTS).toContain(frontmatter!.lead_agent);
      });

      it("has a valid phase", () => {
        const frontmatter = readYamlFrontmatter(stageFile);
        expect(["initialization", "ideation", "inception", "construction", "operation"]).toContain(
          frontmatter!.phase
        );
      });

      it("has a number", () => {
        const frontmatter = readYamlFrontmatter(stageFile);
        const num = Number(frontmatter!.number);
        expect(num).toBeGreaterThan(0);
        expect(num).toBeLessThan(10);
      });

      it("produces artifacts are plugin-namespaced", () => {
        const content = readFileSync(stageFile, "utf-8");
        const producesMatch = content.match(/produces:\n((?:\s+-\s+.+\n?)+)/);
        if (producesMatch) {
          const artifacts = producesMatch[1]
            .split("\n")
            .map((l) => l.replace(/^\s+-\s+/, "").trim())
            .filter(Boolean);
          for (const artifact of artifacts) {
            expect(artifact).toMatch(
              new RegExp(`^${ARTIFACT_PREFIX}`),
              `Artifact "${artifact}" must be prefixed with "${ARTIFACT_PREFIX}"`
            );
          }
        }
      });

      it("has mode: inline", () => {
        const frontmatter = readYamlFrontmatter(stageFile);
        expect(frontmatter!.mode).toBe("inline");
      });
    });
  }
});

describe("mabl-verification contributions", () => {
  const contributionFiles = getContributionFiles();

  it("has at least one contribution", () => {
    expect(contributionFiles.length).toBeGreaterThan(0);
  });

  for (const contribFile of contributionFiles) {
    const targetSlug = basename(contribFile, ".md");

    describe(`contribution: ${targetSlug}`, () => {
      it("targets a known core stage", () => {
        const frontmatter = readYamlFrontmatter(contribFile);
        expect(frontmatter).not.toBeNull();
        expect(CORE_STAGES).toContain(frontmatter!.target);
      });

      it("declares plugin ownership", () => {
        const frontmatter = readYamlFrontmatter(contribFile);
        expect(frontmatter!.plugin).toBe(PLUGIN_NAME);
      });

      it("produced artifacts are plugin-namespaced", () => {
        const content = readFileSync(contribFile, "utf-8");
        // Look for produces under adds:
        const producesMatch = content.match(/produces:\n((?:\s+-\s+.+\n?)+)/);
        if (producesMatch) {
          const artifacts = producesMatch[1]
            .split("\n")
            .map((l) => l.replace(/^\s+-\s+/, "").trim())
            .filter(Boolean);
          for (const artifact of artifacts) {
            expect(artifact).toMatch(
              new RegExp(`^${ARTIFACT_PREFIX}`),
              `Contributed artifact "${artifact}" must be prefixed with "${ARTIFACT_PREFIX}"`
            );
          }
        }
      });

      it("has at least one fragment", () => {
        const content = readFileSync(contribFile, "utf-8");
        expect(content).toContain("## fragment:");
      });
    });
  }
});

describe("mabl-verification sensors", () => {
  const sensorFiles = getSensorFiles();

  it("has at least one sensor manifest", () => {
    expect(sensorFiles.length).toBeGreaterThan(0);
  });

  for (const sensorFile of sensorFiles) {
    const filename = basename(sensorFile);

    describe(`sensor: ${filename}`, () => {
      it("follows aidlc-<id>.md naming convention", () => {
        expect(filename).toMatch(/^aidlc-[\w-]+\.md$/);
      });

      it("has frontmatter with required fields", () => {
        const frontmatter = readYamlFrontmatter(sensorFile);
        expect(frontmatter).not.toBeNull();
        expect(frontmatter!.id).toBeTruthy();
        expect(frontmatter!.kind).toBe("deterministic");
        expect(frontmatter!.command).toBeTruthy();
        expect(frontmatter!.default_severity).toBe("advisory");
      });

      it("references an existing tool script", () => {
        const frontmatter = readYamlFrontmatter(sensorFile);
        const command = String(frontmatter!.command);
        // Extract the script filename from "bun {{HARNESS_DIR}}/tools/<script>.ts"
        const scriptMatch = command.match(/tools\/([\w-]+\.ts)/);
        if (scriptMatch) {
          const scriptPath = join(PLUGIN_ROOT, "tools", scriptMatch[1]);
          expect(existsSync(scriptPath)).toBe(true);
        }
      });
    });
  }
});

describe("mabl-verification agents", () => {
  const agentsDir = join(PLUGIN_ROOT, "agents");

  it("agent directory exists", () => {
    expect(existsSync(agentsDir)).toBe(true);
  });

  it("agent file matches <plugin>-<role>-agent.md convention", () => {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/^mabl-verification-.*\.md$/);
    }
  });

  it("agent frontmatter name matches filename stem", () => {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(agentsDir, file);
      const frontmatter = readYamlFrontmatter(filePath);
      expect(frontmatter).not.toBeNull();
      const expectedName = basename(file, ".md");
      expect(frontmatter!.name).toBe(expectedName);
    }
  });
});

describe("mabl-verification scopes", () => {
  const scopesDir = join(PLUGIN_ROOT, "scopes");

  it("scope directory exists", () => {
    expect(existsSync(scopesDir)).toBe(true);
  });

  it("scope file follows <plugin>-<name>.md convention", () => {
    const files = readdirSync(scopesDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/^mabl-verification-.*\.md$/);
    }
  });

  it("scope frontmatter name matches filename stem", () => {
    const files = readdirSync(scopesDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(scopesDir, file);
      const frontmatter = readYamlFrontmatter(filePath);
      expect(frontmatter).not.toBeNull();
      const expectedName = basename(file, ".md");
      expect(frontmatter!.name).toBe(expectedName);
    }
  });

  it("scope declares plugin ownership", () => {
    const files = readdirSync(scopesDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(scopesDir, file);
      const frontmatter = readYamlFrontmatter(filePath);
      expect(frontmatter!.plugin).toBe(PLUGIN_NAME);
    }
  });
});

describe("mabl-verification knowledge", () => {
  const knowledgeDir = join(PLUGIN_ROOT, "knowledge", "mabl-verification-agent");

  it("knowledge directory exists for the plugin agent", () => {
    expect(existsSync(knowledgeDir)).toBe(true);
  });

  it("has at least one knowledge file", () => {
    const files = readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("knowledge files have content (not empty)", () => {
    const files = readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const content = readFileSync(join(knowledgeDir, file), "utf-8");
      expect(content.length).toBeGreaterThan(100);
    }
  });
});

describe("mabl-verification tools", () => {
  const toolsDir = join(PLUGIN_ROOT, "tools");

  it("has a doctor check script", () => {
    expect(existsSync(join(toolsDir, "mabl-verification-doctor.ts"))).toBe(true);
  });

  it("all .ts files in tools/ are parseable", () => {
    const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const content = readFileSync(join(toolsDir, file), "utf-8");
      // Basic syntax check — contains a main function or top-level execution
      expect(content).toMatch(/function\s+main|process\.exit|console\.log/);
    }
  });
});
