// covers: file:core/tools/aidlc-plugin-validate.ts, function:validatePluginRoot

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundledPluginComposeTemplatePath,
  validatePluginRoot,
} from "../../dist/claude/.claude/tools/aidlc-plugin-validate.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-plugin-validate.ts",
);
const TEST_PRO_ROOT = join(REPO_ROOT, "plugins", "test-pro");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
}

function stageBody(
  slug: string,
  options: {
    phase?: string;
    produces?: string[];
    optionalProduces?: string[];
  } = {},
): string {
  const produces = options.produces ?? [`fixture-plugin-${slug}-output`];
  const optional = options.optionalProduces ?? [];
  return `---
slug: ${slug}
name: ${slug}
plugin: fixture-plugin
phase: ${options.phase ?? "construction"}
execution: ALWAYS
condition: always
lead_agent: aidlc-quality-agent
support_agents: []
mode: inline
produces:
${produces.map((value) => `  - ${value}`).join("\n")}
optional_produces:
${optional.map((value) => `  - ${value}`).join("\n")}
consumes: []
requires_stage: []
sensors: []
scopes:
  - fixture-plugin-validation
inputs: none
outputs: none
---

# ${slug}
`;
}

function fixture(): string {
  const parent = mkdtempSync(join(tmpdir(), "aidlc-t314-"));
  roots.push(parent);
  const root = join(parent, "fixture-plugin");
  write(
    join(root, ".aidlc-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: "fixture-plugin",
        version: "1.2.3",
        description: "Fixture plugin",
        author: { name: "Fixture" },
        dependencies: ["core"],
        aidlc: {
          contributes: {
            stages: "stages/",
            scopes: "scopes/",
            agents: "agents/",
            tools: "tools/",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    join(
      root,
      "stages",
      "construction",
      "fixture-plugin-stage.md",
    ),
    stageBody("fixture-plugin-stage", {
      produces: ["fixture-plugin-shared-output"],
    }),
  );
  write(
    join(root, "scopes", "fixture-plugin-validation.md"),
    `---
name: fixture-plugin-validation
plugin: fixture-plugin
depth: Standard
keywords: [validation, "plugin review"]
description: Fixture scope
---

# fixture-plugin-validation
`,
  );
  write(
    join(root, "agents", "fixture-plugin-helper-agent.md"),
    `---
name: fixture-plugin-helper-agent
display_name: Fixture Plugin Helper
plugin: fixture-plugin
examples: []
description: Fixture helper
disallowedTools: Task
tier: balanced
---

# Fixture Plugin Helper
`,
  );
  write(
    join(root, "tools", "fixture-plugin-tool.ts"),
    'console.log("fixture");\n',
  );
  return root;
}

function runTool(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: tmpdir(),
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

describe("t314 standalone plugin validator", () => {
  test("plugins/test-pro validates green as-is and reports an absent vendored hook", () => {
    const result = validatePluginRoot(TEST_PRO_ROOT);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.composeHook.status).toBe("absent");
    expect(result.warnings.map((finding) => finding.rule)).toContain(
      "compose-hook-absent",
    );
  });

  test("a: missing and malformed manifests fail", () => {
    const missing = fixture();
    rmSync(join(missing, ".aidlc-plugin", "plugin.json"));
    expect(
      validatePluginRoot(missing).errors.map((finding) => finding.rule),
    ).toContain("manifest-missing");

    const malformed = fixture();
    write(
      join(malformed, ".aidlc-plugin", "plugin.json"),
      JSON.stringify({
        name: "fixture-plugin",
        version: "not-semver",
        aidlc: { contributes: [] },
      }),
    );
    const rules = validatePluginRoot(malformed).errors.map(
      (finding) => finding.rule,
    );
    expect(rules).toContain("manifest-shape");
  });

  test("b: stage frontmatter parse and schema failures are reported", () => {
    const root = fixture();
    const stage = join(
      root,
      "stages",
      "construction",
      "fixture-plugin-stage.md",
    );
    writeFileSync(
      stage,
      readFileSync(stage, "utf-8").replace(
        "phase: construction",
        "phase: invalid",
      ),
    );
    write(
      join(root, "stages", "construction", "fixture-plugin-broken.md"),
      "# no frontmatter\n",
    );
    const rules = validatePluginRoot(root).errors.map(
      (finding) => finding.rule,
    );
    expect(rules).toContain("stage-schema");
    expect(rules).toContain("stage-frontmatter");
  });

  test("c: scope naming, depth, and empty declared keywords fail", () => {
    const root = fixture();
    const scope = join(root, "scopes", "fixture-plugin-validation.md");
    const bad = join(root, "scopes", "wrong.md");
    renameSync(scope, bad);
    writeFileSync(
      bad,
      readFileSync(bad, "utf-8")
        .replace("name: fixture-plugin-validation", "name: another-name")
        .replace("depth: Standard", "depth: Huge")
        .replace(
          'keywords: [validation, "plugin review"]',
          "keywords: []",
        ),
    );
    const rules = validatePluginRoot(root).errors.map(
      (finding) => finding.rule,
    );
    expect(rules).toContain("scope-filename");
    expect(rules).toContain("scope-name");
    expect(rules).toContain("scope-depth");
    expect(rules).toContain("scope-keywords");
  });

  test("c: flow-form scope keywords parse as a non-empty list", () => {
    const result = validatePluginRoot(fixture());
    expect(result.errors.map((finding) => finding.rule)).not.toContain(
      "scope-keywords",
    );
  });

  test("d: agent filename and frontmatter name conventions fail loud", () => {
    const root = fixture();
    const agent = join(
      root,
      "agents",
      "fixture-plugin-helper-agent.md",
    );
    const bad = join(root, "agents", "helper.md");
    renameSync(agent, bad);
    writeFileSync(
      bad,
      readFileSync(bad, "utf-8").replace(
        "name: fixture-plugin-helper-agent",
        "name: another-agent",
      ),
    );
    const rules = validatePluginRoot(root).errors.map(
      (finding) => finding.rule,
    );
    expect(rules).toContain("agent-filename");
    expect(rules).toContain("agent-name");
  });

  test("e: produces and optional_produces share the local duplicate namespace", () => {
    const root = fixture();
    write(
      join(
        root,
        "stages",
        "construction",
        "fixture-plugin-optional-stage.md",
      ),
      stageBody("fixture-plugin-optional-stage", {
        produces: [],
        optionalProduces: ["fixture-plugin-shared-output"],
      }),
    );
    const duplicate = validatePluginRoot(root).errors.find(
      (finding) => finding.rule === "duplicate-artifact-producer",
    );
    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain("fixture-plugin-stage.md");
    expect(duplicate?.message).toContain(
      "fixture-plugin-optional-stage.md",
    );
  });

  test("f: tests, fixtures, and *.test.ts payloads under tools fail", () => {
    const root = fixture();
    write(join(root, "tools", "tests", "case.json"), "{}\n");
    write(join(root, "tools", "fixtures", "input.txt"), "fixture\n");
    write(join(root, "tools", "helper.test.ts"), "test\n");
    const payloads = validatePluginRoot(root).errors.filter(
      (finding) => finding.rule === "tools-payload",
    );
    expect(payloads).toHaveLength(3);
  });

  test("linked plugin files and directories fail with path-specific findings", () => {
    const root = fixture();
    const parent = dirname(root);
    const linkedStageSource = join(parent, "linked-stage-source.md");
    writeFileSync(
      linkedStageSource,
      stageBody("fixture-plugin-linked-stage"),
      "utf-8",
    );
    const linkedStage = join(
      root,
      "stages",
      "construction",
      "fixture-plugin-linked-stage.md",
    );
    symlinkSync(linkedStageSource, linkedStage, "file");

    const linkedDirSource = join(parent, "linked-tools-source");
    mkdirSync(linkedDirSource, { recursive: true });
    writeFileSync(
      join(linkedDirSource, "helper.ts"),
      'console.log("linked");\n',
      "utf-8",
    );
    const linkedDir = join(root, "tools", "linked-dir");
    symlinkSync(
      linkedDirSource,
      linkedDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = validatePluginRoot(root);
    const linked = result.errors.filter(
      (finding) => finding.rule === "content-symlink",
    );
    expect(result.valid).toBe(false);
    expect(linked.map((finding) => finding.file)).toEqual([
      "stages/construction/fixture-plugin-linked-stage.md",
      "tools/linked-dir",
    ]);
    expect(
      linked.every((finding) =>
        finding.message.includes("symlinks are unsupported")
      ),
    ).toBe(true);

    const cli = runTool([root, "--json"]);
    expect(cli.status).toBe(1);
    expect(
      JSON.parse(cli.stdout).errors.map(
        (finding: { rule: string }) => finding.rule,
      ),
    ).toContain("content-symlink");
  });

  test("a linked .aidlc-plugin metadata directory is rejected explicitly", () => {
    const root = fixture();
    const metadata = join(root, ".aidlc-plugin");
    const linkedMetadata = join(dirname(root), "linked-metadata");
    renameSync(metadata, linkedMetadata);
    symlinkSync(
      linkedMetadata,
      metadata,
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = validatePluginRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        file: ".aidlc-plugin",
        rule: "content-symlink",
        message: "plugin content symlinks are unsupported",
      }),
    );

    const cli = runTool([root, "--json"]);
    expect(cli.status).toBe(1);
    expect(
      JSON.parse(cli.stdout).errors,
    ).toContainEqual(
      expect.objectContaining({
        file: ".aidlc-plugin",
        rule: "content-symlink",
      }),
    );
  });

  test("g: a matching vendored hook passes and a stale hook fails naming both paths", () => {
    const matching = fixture();
    const reference = bundledPluginComposeTemplatePath();
    write(
      join(matching, "hooks", "compose.ts"),
      readFileSync(reference, "utf-8"),
    );
    expect(validatePluginRoot(matching).composeHook.status).toBe("match");

    const stale = fixture();
    const vendored = join(stale, "hooks", "compose.ts");
    write(vendored, `${readFileSync(reference, "utf-8")}\n// stale\n`);
    const result = validatePluginRoot(stale);
    const finding = result.errors.find(
      (entry) => entry.rule === "compose-hook-stale",
    );
    expect(result.composeHook.status).toBe("stale");
    expect(finding?.message).toContain(vendored);
    expect(finding?.message).toContain(reference);
  });

  test("--json has a stable shape and exit codes are 0 valid, 1 findings, 2 usage", () => {
    const validRoot = fixture();
    const valid = runTool([validRoot, "--json"]);
    expect(valid.status).toBe(0);
    const parsed = JSON.parse(valid.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["valid", "errors", "warnings"]);
    expect(parsed.valid).toBe(true);

    const invalidRoot = fixture();
    rmSync(join(invalidRoot, ".aidlc-plugin", "plugin.json"));
    const invalid = runTool([invalidRoot, "--json"]);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout).valid).toBe(false);

    const usage = runTool([]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("Usage:");
  });

  test("human findings name file, rule, and fix", () => {
    const root = fixture();
    rmSync(join(root, ".aidlc-plugin", "plugin.json"));
    const result = runTool([root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".aidlc-plugin/plugin.json");
    expect(result.stderr).toContain("[manifest-missing]");
    expect(result.stderr).toContain("Fix:");
  });
});
