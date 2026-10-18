// covers: file:core/tools/aidlc-plugin-validate.ts, function:validatePluginRoot

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundledPluginComposeTemplatePath,
  validatePluginRoot,
} from "../../dist/claude/.claude/tools/aidlc-plugin-validate.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

// fixture-plugin built on a base plugin named `base`, whose own checkout sits
// beside it with one agent, <base>-reviewer-agent; the stage leads with `lead`.
function layered(
  lead: string,
  base = "zeta",
): { root: string; baseRoot: string } {
  const root = fixture();
  const manifestPath = join(root, ".aidlc-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.dependencies = ["core", `${base}@^1.0.0`];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  const stage = join(root, "stages", "construction", "fixture-plugin-stage.md");
  writeFileSync(
    stage,
    readFileSync(stage, "utf-8").replace("lead_agent: aidlc-quality-agent", `lead_agent: ${lead}`),
    "utf-8",
  );
  const baseRoot = join(dirname(root), base);
  write(
    join(baseRoot, ".aidlc-plugin", "plugin.json"),
    `${JSON.stringify({ name: base, version: "1.0.0", aidlc: { contributes: { agents: "agents/" } } }, null, 2)}\n`,
  );
  write(
    join(baseRoot, "agents", `${base}-reviewer-agent.md`),
    `---\nname: ${base}-reviewer-agent\nplugin: ${base}\n---\n\n# Reviewer\n`,
  );
  return { root, baseRoot };
}

function runTool(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

  test("manifest contribution paths must be canonical and memory remains unsupported", () => {
    const root = fixture();
    renameSync(join(root, "stages"), join(root, "custom-stages"));
    const manifestPath = join(root, ".aidlc-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      aidlc: { contributes: Record<string, string> };
    };
    manifest.aidlc.contributes.stages = "custom-stages/";
    manifest.aidlc.contributes.memory = "memory/";
    writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );

    const result = validatePluginRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        file: ".aidlc-plugin/plugin.json",
        rule: "manifest-shape",
        message:
          'aidlc.contributes.stages must be "stages/" until configurable contribution paths are supported',
      }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        file: ".aidlc-plugin/plugin.json",
        rule: "manifest-shape",
        message:
          "aidlc.contributes.memory is not supported by the current plugin projection",
      }),
    );
  });

  test("dependencies name core and at most one base plugin, with a range npm can read", () => {
    const withDependencies = (dependencies: string[]): string[] => {
      const root = fixture();
      const manifestPath = join(root, ".aidlc-plugin", "plugin.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      manifest.dependencies = dependencies;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
      return validatePluginRoot(root).errors
        .filter((finding) => finding.message.startsWith("manifest dependencies"))
        .map((finding) => finding.message);
    };
    expect(withDependencies(["core", "zeta@^1.2.0"])).toEqual([]);
    expect(withDependencies(["zeta@1.x || >=2.1.0 <3"])).toEqual([]);
    expect(withDependencies(["core", "zeta"])).toEqual([]);
    expect(withDependencies(["core", "zeta", "mid@^1.0.0"])).toEqual([
      "manifest dependencies name more than one base plugin (zeta, mid)",
    ]);
    expect(withDependencies(["core", "zeta@>=1, <2"])).toEqual([
      'manifest dependencies: "zeta@>=1, <2" has a version range npm cannot read, such as "^1.2.0" or ">=1.2.0 <2.0.0"',
    ]);
    expect(withDependencies(["core", "aidlc-zeta"])).toEqual([
      'manifest dependencies: "aidlc-zeta" does not name a plugin: use "core", "<plugin>", or "<plugin>@<range>"',
    ]);
    expect(withDependencies(["core", "fixture-plugin@^1.0.0"])).toEqual([
      'manifest dependencies: "fixture-plugin@^1.0.0" names this plugin itself',
    ]);
  });

  test("a marketplace takes any name its author chooses outside AI-DLC's own aidlc namespace", () => {
    const withMarketplace = (marketplace: unknown): Array<{ rule: string; message: string }> => {
      const root = fixture();
      const manifestPath = join(root, ".aidlc-plugin", "plugin.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { aidlc: Record<string, unknown> };
      manifest.aidlc.marketplace = marketplace;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
      return validatePluginRoot(root).errors
        .filter((finding) => finding.rule === "manifest-marketplace")
        .map(({ rule, message }) => ({ rule, message }));
    };
    for (const name of ["acme-aidlc-plugins", "Acme.Plugins_2", "backend"]) {
      expect(withMarketplace(name), name).toEqual([]);
    }
    // Claude Code keeps catalogues apart only up to letter case.
    for (const name of ["aidlc", "aidlc-plugins", "aidlc-acme", "AIDLC-tools", "Aidlc"]) {
      expect(withMarketplace(name), name).toEqual([{
        rule: "manifest-marketplace",
        message: `marketplace name "${name}" is AI-DLC's own: "aidlc" and names starting "aidlc-" are kept for the plugins AI-DLC ships`,
      }]);
    }
    for (const name of ["", "acme plugins", "../acme", ".acme", "acme/plugins", 7]) {
      expect(withMarketplace(name).map((finding) => finding.rule), String(name)).toEqual(["manifest-marketplace"]);
    }
  });

  test("a stage can use its base plugin's agent: unchecked without --with, checked with it", () => {
    const { root, baseRoot } = layered("zeta-reviewer-agent");
    const unchecked = validatePluginRoot(root);
    expect(unchecked.errors).toEqual([]);
    expect(unchecked.warnings.filter((finding) => finding.rule === "base-reference")).toEqual([
      {
        file: "stages/construction/fixture-plugin-stage.md",
        rule: "base-reference",
        message: 'agent "zeta-reviewer-agent" is not checked: it would come from zeta, the base this plugin builds on',
        fix: "Run validate again with --with <path to your zeta checkout> to check it.",
      },
    ]);

    const checked = validatePluginRoot(root, { baseRoot });
    expect(checked.errors).toEqual([]);
    expect(checked.warnings.map((finding) => finding.rule)).not.toContain("base-reference");

    const missing = layered("zeta-missing-agent");
    expect(validatePluginRoot(missing.root, { baseRoot: missing.baseRoot }).errors.map((finding) => finding.message))
      .toEqual(['lead_agent "zeta-missing-agent" has no matching .claude/agents/*.md']);

    // Neither the base nor this plugin can supply it: an error, as before.
    expect(validatePluginRoot(layered("other-reviewer-agent").root).errors.map((finding) => finding.rule))
      .toEqual(["stage-schema"]);
  });

  test("when one name prefixes the other, the longer prefix owns the agent", () => {
    // fixture-plugin builds on a base named fixture: its own typo stays an error.
    const own = layered("fixture-plugin-typo-agent", "fixture");
    expect(validatePluginRoot(own.root).errors.map((finding) => finding.message))
      .toEqual(['lead_agent "fixture-plugin-typo-agent" has no matching .claude/agents/*.md']);
    const fromBase = layered("fixture-reviewer-agent", "fixture");
    expect(validatePluginRoot(fromBase.root).errors).toEqual([]);
    expect(validatePluginRoot(fromBase.root).warnings.map((finding) => finding.rule)).toContain("base-reference");

    // fixture-plugin builds on fixture-plugin-platform: the base's agent is the base's.
    const longerBase = layered("fixture-plugin-platform-reviewer-agent", "fixture-plugin-platform");
    expect(validatePluginRoot(longerBase.root).errors).toEqual([]);
    expect(validatePluginRoot(longerBase.root).warnings.map((finding) => finding.rule)).toContain("base-reference");
    const ownTypo = layered("fixture-plugin-typo-agent", "fixture-plugin-platform");
    expect(validatePluginRoot(ownTypo.root).errors.map((finding) => finding.message))
      .toEqual(['lead_agent "fixture-plugin-typo-agent" has no matching .claude/agents/*.md']);
  });

  test("a plugin that declares no base and names another plugin's stage or agent stops with the one step", () => {
    const fix =
      'If another plugin ships it, add that plugin to dependencies next to "core", as "<base>@^1.2.0", then check it with --with <path to your checkout of it>; otherwise correct the name.';
    // --with checks a base's agents, not its stages, so the stage line does not offer it.
    const stageFix =
      'If another plugin ships it, add that plugin to dependencies next to "core", as "<base>@^1.2.0"; otherwise correct the name.';
    const file = "stages/construction/fixture-plugin-stage.md";
    const withStage = (edit: (stage: string) => string): string => {
      const root = fixture();
      const stage = join(root, file);
      writeFileSync(stage, edit(readFileSync(stage, "utf-8")), "utf-8");
      return root;
    };
    const finding = (message: string, lineFix = fix) => ({ file, rule: "base-reference" as const, message, fix: lineFix });

    expect(validatePluginRoot(withStage((s) => s.replace("requires_stage: []", "requires_stage:\n  - acme-intent-stage"))).errors)
      .toEqual([finding('requires_stage "acme-intent-stage" is not a core stage or one of fixture-plugin\'s own', stageFix)]);
    expect(validatePluginRoot(withStage((s) => s.replace("lead_agent: aidlc-quality-agent", "lead_agent: acme-lead-agent"))).errors)
      .toEqual([finding('lead_agent "acme-lead-agent" is not a core agent or one of fixture-plugin\'s own')]);
    expect(validatePluginRoot(withStage((s) => s.replace("support_agents: []", "support_agents:\n  - acme-helper-agent"))).errors)
      .toEqual([finding('support_agents "acme-helper-agent" is not a core agent or one of fixture-plugin\'s own')]);
    expect(validatePluginRoot(withStage((s) => s.replace(
      "inputs: none",
      "reviewer: acme-review-agent\nreview_artifact: fixture-plugin-shared-output\ninputs: none",
    ))).errors).toEqual([finding('reviewer "acme-review-agent" is not a core agent or one of fixture-plugin\'s own')]);
    // A typo in its own stage gets the same line; the fix ends with correcting the name.
    expect(validatePluginRoot(withStage((s) => s.replace("requires_stage: []", "requires_stage:\n  - fixture-plugin-typo-stage"))).errors)
      .toEqual([finding('requires_stage "fixture-plugin-typo-stage" is not a core stage or one of fixture-plugin\'s own', stageFix)]);

    // A core stage and the plugin's own stage are fine.
    const own = withStage((s) => s.replace("requires_stage: []", "requires_stage:\n  - build-and-test\n  - fixture-plugin-other-stage"));
    write(
      join(own, "stages", "construction", "fixture-plugin-other-stage.md"),
      stageBody("fixture-plugin-other-stage", { produces: ["fixture-plugin-other-output"] }),
    );
    expect(validatePluginRoot(own).errors).toEqual([]);
  });

  test("with a base declared, the base's stage in requires_stage is not checked and nothing is said", () => {
    const { root, baseRoot } = layered("zeta-reviewer-agent");
    const stage = join(root, "stages", "construction", "fixture-plugin-stage.md");
    writeFileSync(
      stage,
      readFileSync(stage, "utf-8").replace("requires_stage: []", "requires_stage:\n  - zeta-example-stage"),
      "utf-8",
    );
    expect(validatePluginRoot(root).errors).toEqual([]);
    expect(validatePluginRoot(root).warnings.map((finding) => finding.message))
      .not.toContain('requires_stage "zeta-example-stage" is not a core stage or one of fixture-plugin\'s own');
    expect(validatePluginRoot(root, { baseRoot }).errors).toEqual([]);
  });

  test("--with names the declared base only", () => {
    const { root } = layered("zeta-reviewer-agent");
    const other = layered("zeta-reviewer-agent", "mid");
    const notBase = validatePluginRoot(root, { baseRoot: other.baseRoot });
    expect(notBase.errors).toEqual([
      {
        file: ".aidlc-plugin/plugin.json",
        rule: "base-root",
        message: `--with names ${resolve(other.baseRoot)}, which is not zeta, the base this plugin builds on`,
        fix: "Pass the root of your zeta checkout.",
      },
    ]);
    const noManifest = join(dirname(root), "empty");
    mkdirSync(noManifest, { recursive: true });
    expect(validatePluginRoot(root, { baseRoot: noManifest }).errors.map((finding) => finding.message))
      .toEqual([`--with names ${resolve(noManifest)}, which is not zeta, the base this plugin builds on`]);

    const coreOnly = fixture();
    expect(validatePluginRoot(coreOnly, { baseRoot: other.baseRoot }).errors).toEqual([
      {
        file: ".aidlc-plugin/plugin.json",
        rule: "base-root",
        message: `--with names ${resolve(other.baseRoot)}, but this plugin builds on core alone`,
        fix: 'Add its base to dependencies, such as "mid@^1.2.0", or leave out --with.',
      },
    ]);

    expect(runTool([root, "--with", layered("zeta-reviewer-agent").baseRoot]).status).toBe(0);
    const bare = runTool([root, "--with"]);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("--with <base-root>");
  });

  test("a scope can include its base's stages: unchecked without --with, checked with it", () => {
    // Sets include_stages on the fixture scope; the base checkout has zeta-intake.
    const includes = (root: string, value: string): void => {
      const scope = join(root, "scopes", "fixture-plugin-validation.md");
      writeFileSync(
        scope,
        readFileSync(scope, "utf-8").replace("description: Fixture scope", `description: Fixture scope\ninclude_stages: ${value}`),
        "utf-8",
      );
    };
    const file = "scopes/fixture-plugin-validation.md";
    const { root, baseRoot } = layered("aidlc-quality-agent");
    write(join(baseRoot, "stages", "inception", "zeta-intake.md"), "---\nslug: zeta-intake\nplugin: zeta\n---\n\n# Intake\n");
    includes(root, "[zeta-intake, zeta-renamed]");
    const unchecked = validatePluginRoot(root);
    expect(unchecked.errors).toEqual([]);
    expect(unchecked.warnings.filter((finding) => finding.rule === "base-reference")).toEqual([
      {
        file,
        rule: "base-reference",
        message: 'stage "zeta-intake" is not checked: it would come from zeta, the base this plugin builds on',
        fix: "Run validate again with --with <path to your zeta checkout> to check it.",
      },
      {
        file,
        rule: "base-reference",
        message: 'stage "zeta-renamed" is not checked: it would come from zeta, the base this plugin builds on',
        fix: "Run validate again with --with <path to your zeta checkout> to check it.",
      },
    ]);

    const checked = validatePluginRoot(root, { baseRoot });
    expect(checked.warnings.map((finding) => finding.rule)).not.toContain("base-reference");
    expect(checked.errors).toEqual([
      {
        file,
        rule: "scope-include",
        message: 'include_stages names "zeta-renamed", which your zeta checkout has no stage for',
        fix: "Name a stage of zeta, or pass a checkout of the zeta version this plugin is for.",
      },
    ]);

    // Its own stage and a core stage join a scope the ways they always have.
    const own = layered("aidlc-quality-agent");
    includes(own.root, "[fixture-plugin-stage, code-generation]");
    expect(validatePluginRoot(own.root).errors).toEqual([
      {
        file,
        rule: "scope-include",
        message: 'include_stages names "code-generation", a core stage',
        fix: "Put a core stage in this scope with a contribution's adds.scopes.",
      },
      {
        file,
        rule: "scope-include",
        message: 'include_stages names "fixture-plugin-stage", this plugin\'s own stage',
        fix: "List fixture-plugin-validation in that stage's scopes: instead.",
      },
    ]);

    const coreOnly = fixture();
    includes(coreOnly, "[zeta-intake]");
    expect(validatePluginRoot(coreOnly).errors).toEqual([
      {
        file,
        rule: "scope-include",
        message: 'include_stages names "zeta-intake", but this plugin builds on core alone',
        fix: 'include_stages takes the stages of the base plugin you build on: name it in dependencies, such as "<base>@^1.2.0".',
      },
    ]);

    const empty = layered("aidlc-quality-agent");
    includes(empty.root, "[]");
    expect(validatePluginRoot(empty.root).errors.map((finding) => finding.message)).toEqual([
      "declared include_stages must parse to a non-empty block or flow list",
    ]);
  });

  test("include_stages reads names as stage fields do: a stage that is not the base's by name is refused", () => {
    const includes = (root: string, value: string): void => {
      const scope = join(root, "scopes", "fixture-plugin-validation.md");
      writeFileSync(
        scope,
        readFileSync(scope, "utf-8").replace("description: Fixture scope", `description: Fixture scope\ninclude_stages: ${value}`),
        "utf-8",
      );
    };
    const other = layered("aidlc-quality-agent");
    includes(other.root, "[mid-intake]");
    expect(validatePluginRoot(other.root).errors).toEqual([
      {
        file: "scopes/fixture-plugin-validation.md",
        rule: "scope-include",
        message: 'include_stages names "mid-intake", which cannot be a stage of zeta: zeta\'s stage slugs start with "zeta-"',
        fix: "Name a stage of zeta.",
      },
    ]);
    expect(validatePluginRoot(other.root).warnings.map((finding) => finding.rule)).not.toContain("base-reference");

    // fixture-plugin on base fixture-plugin-platform: the longer prefix owns the name.
    const longerBase = layered("aidlc-quality-agent", "fixture-plugin-platform");
    includes(longerBase.root, "[fixture-plugin-platform-intake]");
    expect(validatePluginRoot(longerBase.root).errors).toEqual([]);
    expect(validatePluginRoot(longerBase.root).warnings.map((finding) => finding.message)).toContain(
      'stage "fixture-plugin-platform-intake" is not checked: it would come from fixture-plugin-platform, the base this plugin builds on',
    );

    // fixture-plugin on base fixture: fixture can ship fixture-plugin-intake (compose
    // needs only "fixture-"), so the base's checkout decides, not the longer prefix.
    const longerPlugin = layered("aidlc-quality-agent", "fixture");
    includes(longerPlugin.root, "[fixture-plugin-intake]");
    expect(validatePluginRoot(longerPlugin.root).errors).toEqual([]);
    expect(validatePluginRoot(longerPlugin.root).warnings.map((finding) => finding.message)).toContain(
      'stage "fixture-plugin-intake" is not checked: it would come from fixture, the base this plugin builds on',
    );
    expect(validatePluginRoot(longerPlugin.root, { baseRoot: longerPlugin.baseRoot }).errors.map((finding) => finding.message))
      .toEqual(['include_stages names "fixture-plugin-intake", which your fixture checkout has no stage for']);
    write(
      join(longerPlugin.baseRoot, "stages", "inception", "fixture-plugin-intake.md"),
      "---\nslug: fixture-plugin-intake\nplugin: fixture\n---\n\n# Intake\n",
    );
    const checked = validatePluginRoot(longerPlugin.root, { baseRoot: longerPlugin.baseRoot });
    expect(checked.errors).toEqual([]);
    expect(checked.warnings.map((finding) => finding.rule)).not.toContain("base-reference");
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

  test("b: a malformed ars: block is a stage-schema finding naming the field", () => {
    const root = fixture();
    const stage = join(root, "stages", "construction", "fixture-plugin-stage.md");
    writeFileSync(
      stage,
      readFileSync(stage, "utf-8").replace(
        "inputs: none\n",
        "ars:\n  targets: [ve, mars]\n  cost: 9\ninputs: none\n",
      ),
    );
    const findings = validatePluginRoot(root).errors.filter(
      (finding) => finding.rule === "stage-schema",
    );
    expect(findings.length).toBeGreaterThan(0);
    const messages = findings.map((finding) => finding.message).join("\n");
    expect(messages).toContain("ars.targets[1] must be one of iae | csu | ve | r | ua");
    expect(messages).toContain("ars.cost must be null or an integer 1..5, got number");
    writeFileSync(
      stage,
      readFileSync(stage, "utf-8").replace(
        "ars:\n  targets: [ve, mars]\n  cost: 9\n",
        "ars:\n  targets: [ve]\n  cost: 4\n",
      ),
    );
    expect(
      validatePluginRoot(root).errors.filter((finding) => finding.rule === "stage-schema"),
    ).toHaveLength(0);
  });

  test("stages enforce agent references, artifact namespaces, and non-empty bodies", () => {
    const root = fixture();
    const stage = join(
      root,
      "stages",
      "construction",
      "fixture-plugin-stage.md",
    );
    writeFileSync(
      stage,
      readFileSync(stage, "utf-8")
        .replace("lead_agent: aidlc-quality-agent", "lead_agent: missing-agent")
        .replace(
          "  - fixture-plugin-shared-output",
          "  - unnamespaced-output",
        )
        .replace(/\n# fixture-plugin-stage\n$/, "\n"),
      "utf-8",
    );
    const rules = validatePluginRoot(root).errors.map((finding) => finding.rule);
    // No core or own agent of that name, and no base declared.
    expect(rules).toContain("base-reference");
    expect(rules).toContain("artifact-namespace");
    expect(rules).toContain("stage-body");
  });

  test("contributions enforce core targets and artifact namespaces", () => {
    const root = fixture();
    write(
      join(root, "contributions", "construction", "bad-target.md"),
      `---
target: no-such-core-stage
plugin: fixture-plugin
adds:
  produces:
    - unnamespaced-output
---
`,
    );
    const rules = validatePluginRoot(root).errors.map((finding) => finding.rule);
    expect(rules).toContain("contribution-target");
    expect(rules).toContain("artifact-namespace");
  });

  test("agent contributions require a core persona target and carry fragments only", () => {
    const root = fixture();
    write(
      join(root, "contributions", "agents", "aidlc-quality-agent.md"),
      `---
target: aidlc-quality-agent
plugin: fixture-plugin
fragments:
  - anchor: in:Collaboration
    order: 100
---

## fragment: in:Collaboration

- **Works with**: fixture-plugin-metrics-agent
`,
    );
    write(
      join(root, "contributions", "agents", "no-such-agent.md"),
      `---
target: no-such-agent
plugin: fixture-plugin
adds:
  produces:
    - fixture-plugin-output
fragments:
  - anchor: end-of-body
    order: 100
---

## fragment: end-of-body

never lands
`,
    );
    const findings = validatePluginRoot(root).errors;
    const byFile = (name: string) => findings.filter((f) => f.file === `contributions/agents/${name}`).map((f) => f.rule);
    expect(byFile("aidlc-quality-agent.md")).toHaveLength(0);
    expect(byFile("no-such-agent.md")).toContain("contribution-target");
    expect(byFile("no-such-agent.md")).toContain("contribution-adds");
  });

  test("contribution files outside contributions/<dir>/<file>.md are reported, not accepted", () => {
    // Compose reads one level deep, so a nested or top-level file would be
    // valid-looking prose that never lands.
    const root = fixture();
    const body = `---
target: aidlc-quality-agent
plugin: fixture-plugin
fragments:
  - anchor: end-of-body
    order: 100
---

## fragment: end-of-body

never read
`;
    write(join(root, "contributions", "agents", "nested", "aidlc-quality-agent.md"), body);
    write(join(root, "contributions", "stray.md"), body);
    const findings = validatePluginRoot(root).errors;
    const rulesFor = (file: string) => findings.filter((f) => f.file === file).map((f) => f.rule);
    expect(rulesFor("contributions/agents/nested/aidlc-quality-agent.md")).toEqual(["contribution-path"]);
    expect(rulesFor("contributions/stray.md")).toEqual(["contribution-path"]);
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
