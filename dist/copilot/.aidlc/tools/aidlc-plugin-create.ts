#!/usr/bin/env bun
// Deterministic offline scaffold for a new AIDLC plugin repository.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  type PluginValidationFinding,
  validatePluginName,
} from "./aidlc-plugin-validate.ts";

const USAGE =
  "Usage: bun <tools-dir>/aidlc-plugin-create.ts <name> [targetDir] [--json]";

export interface PluginCreateResult {
  valid: boolean;
  errors: PluginValidationFinding[];
  warnings: PluginValidationFinding[];
  targetDir: string;
  files: string[];
}

type ScaffoldFile = {
  path: string;
  content: string;
};

function displayPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/") || ".";
}

function titleCase(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function manifest(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      description: "TODO: Describe what this plugin adds to AI-DLC.",
      author: { name: "TODO: Your name or organization" },
      dependencies: ["core"],
      aidlc: {
        contributes: {
          stages: "stages/",
          agents: "agents/",
          scopes: "scopes/",
        },
      },
    },
    null,
    2,
  )}\n`;
}

function stage(name: string): string {
  const slug = `${name}-example-stage`;
  const scopeName = `${name}-example`;
  const agent = `${name}-example-agent`;
  const artifact = `${name}-example-output`;
  return `---
slug: ${slug}
name: ${titleCase(name)} Example
plugin: ${name}
phase: construction
execution: CONDITIONAL
condition: Execute when the ${name} plugin example is selected for the current workflow.
lead_agent: ${agent}
support_agents: []
mode: inline
produces:
  - ${artifact}
consumes: []
requires_stage: []
sensors: []
scopes:
  - ${scopeName}
inputs: Existing project context relevant to this plugin
outputs: ${artifact}.md (under this stage's record dir, engine-resolved)
---

# ${titleCase(name)} Example

<!--
\`produces\` declares artifact slugs this stage writes. The engine resolves each
artifact to this stage's intent record directory; do not hard-code that path.

\`consumes\` declares upstream artifacts this stage reads. Use entries shaped as:
  - artifact: upstream-artifact-slug
    required: true
-->

## Steps

1. Read the current project context and any declared consumed artifacts.
2. Produce \`${artifact}.md\` in the engine-resolved record directory.
3. Report completion through the normal stage protocol.
`;
}

function scope(name: string): string {
  const scopeName = `${name}-example`;
  return `---
name: ${scopeName}
plugin: ${name}
depth: Standard
# Flow form is also legal: keywords: [${name}, ${name} example]
keywords:
  - ${name}
  - ${name} example
description: Run the ${name} example stage
skeleton: off
runner: true
---

# ${scopeName} scope

Use this scope while developing the plugin's example stage. Add or remove stage
membership through each stage file's \`scopes:\` list.
`;
}

function agent(name: string): string {
  const agentName = `${name}-example-agent`;
  return `---
name: ${agentName}
display_name: ${titleCase(name)} Example Agent
plugin: ${name}
description: >
  Example specialist for the ${name} plugin scaffold.
disallowedTools: Task
model: sonnet
---

**IMPORTANT: Do NOT use the Task tool. You operate as a delegated agent and
must not spawn sub-agents.**

# ${titleCase(name)} Example Agent

Guide the \`${name}-example\` stage, keep outputs concise, and preserve
traceability to the stage's declared inputs and artifacts.
`;
}

function testsReadme(): string {
  return `# Plugin tests

Keep plugin tests and fixtures under this directory. Do not place them under
\`tools/\`: composition copies \`tools/\` recursively into every install, so
test payloads there become shipped runtime files (issue #876).

Inside the AIDLC repository, use \`tests/harness/plugin-kit.ts\` for reusable
validation, build, compose, and optional live-harness helpers. External plugin
repositories can invoke the shipped validate/build/test tools directly from CI.
`;
}

function readme(name: string): string {
  return `# ${name}

An AIDLC plugin scaffold. Replace the placeholders and example content with
your plugin's stages, scopes, agents, contributions, sensors, knowledge, and
runtime tools.

## Authoring flow

1. **Create:** \`bun <tools-dir>/aidlc-plugin-create.ts ${name}\`
2. **Author:** edit \`stages/\`, \`scopes/\`, \`agents/\`, and the manifest.
3. **Validate:** \`bun <tools-dir>/aidlc-plugin-validate.ts .\`
4. **Build:** \`bun <tools-dir>/aidlc-plugin-build.ts . claude\`
5. **Test:** \`bun <tools-dir>/aidlc-plugin-test.ts . --install <project-root> --harness claude\`
6. **Publish:** build every supported harness projection, tag releases with
   SemVer, and publish the generated host plugin directories.

The build output defaults to \`dist/<harness>/\`. Publish those outputs from a
git repository with a \`marketplace.json\` so host-native plugin stores can
discover them. See the AIDLC plugin authoring guide for marketplace metadata
and host installation examples.

\`hooks/compose.ts\` is intentionally absent from this authored root. Plugin
build injects the current bundled compose hook into each host projection.
`;
}

export function scaffoldFiles(name: string): ScaffoldFile[] {
  const stageName = `${name}-example-stage`;
  const scopeName = `${name}-example`;
  return [
    {
      path: join(".aidlc-plugin", "plugin.json"),
      content: manifest(name),
    },
    {
      path: join("stages", "construction", `${stageName}.md`),
      content: stage(name),
    },
    {
      path: join("scopes", `${scopeName}.md`),
      content: scope(name),
    },
    {
      path: join("agents", `${name}-example-agent.md`),
      content: agent(name),
    },
    { path: join("tests", "README.md"), content: testsReadme() },
    { path: "README.md", content: readme(name) },
  ].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function targetFindings(
  name: string,
  targetDir: string,
): PluginValidationFinding[] {
  const findings = validatePluginName(name, basename(targetDir));
  let targetLstat: ReturnType<typeof lstatSync> | null = null;
  try {
    targetLstat = lstatSync(targetDir);
  } catch {
    return findings;
  }
  if (targetLstat.isSymbolicLink()) {
    return [
      ...findings,
      {
        file: basename(targetDir),
        rule: "create-target",
        message: `target path is a symlink: ${targetDir}`,
        fix: "Choose a real missing or empty directory path.",
      },
    ];
  }
  let entries: string[];
  try {
    if (!targetLstat.isDirectory()) {
      return [
        ...findings,
        {
          file: basename(targetDir),
          rule: "create-target",
          message: `target path is not a directory: ${targetDir}`,
          fix: "Choose a missing or empty directory for the plugin scaffold.",
        },
      ];
    }
    entries = readdirSync(targetDir).sort();
  } catch (error) {
    return [
      ...findings,
      {
        file: ".",
        rule: "create-target",
        message: `target directory could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        fix: "Choose a readable missing or empty directory.",
      },
    ];
  }
  if (entries.length > 0) {
    findings.push({
      file: ".",
      rule: "create-target",
      message: `target directory is not empty: ${entries.join(", ")}`,
      fix: "Choose a missing or empty directory; CREATE never overwrites existing files.",
    });
  }
  return findings;
}

export function createPluginScaffold(
  name: string,
  targetDir: string,
): PluginCreateResult {
  const target = resolve(targetDir);
  const errors = targetFindings(name, target);
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      warnings: [],
      targetDir: target,
      files: [],
    };
  }

  const files = scaffoldFiles(name);
  const parent = dirname(target);
  let staging = "";
  let removedEmptyTarget = false;
  try {
    mkdirSync(parent, { recursive: true });
    staging = mkdtempSync(
      join(parent, `.${basename(target)}.aidlc-create-`),
    );
    for (const file of files) {
      const destination = join(staging, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.content, {
        encoding: "utf-8",
        flag: "wx",
      });
    }
    if (existsSync(target)) {
      const current = lstatSync(target);
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        readdirSync(target).length > 0
      ) {
        throw new Error(
          "target changed after validation; CREATE will not overwrite it",
        );
      }
      rmSync(target, { recursive: true });
      removedEmptyTarget = true;
    }
    renameSync(staging, target);
    staging = "";
  } catch (error) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (removedEmptyTarget && !existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }
    return {
      valid: false,
      errors: [
        {
          file: ".",
          rule: "create-write",
          message: `plugin scaffold could not be written: ${error instanceof Error ? error.message : String(error)}`,
          fix: "Correct the target permissions or race and retry; no partial scaffold was kept.",
        },
      ],
      warnings: [],
      targetDir: target,
      files: [],
    };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
    targetDir: target,
    files: files.map((file) => displayPath(target, join(target, file.path))),
  };
}

function formatResult(name: string, result: PluginCreateResult): string {
  if (!result.valid) {
    const lines = [
      "Plugin create: FAILED",
      `Name: ${name}`,
      `Target: ${result.targetDir}`,
    ];
    for (const finding of result.errors) {
      lines.push(
        `ERROR ${finding.file} [${finding.rule}]: ${finding.message}`,
        `  Fix: ${finding.fix}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
  return `${[
    "Plugin create: COMPLETE",
    `Name: ${name}`,
    `Target: ${result.targetDir}`,
    `Files (${result.files.length}): ${result.files.join(", ")}`,
  ].join("\n")}\n`;
}

export function pluginCreateJson(result: PluginCreateResult): object {
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    targetDir: result.targetDir,
    files: result.files,
  };
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const jsonArgs = argv.filter((arg) => arg === "--json");
  const positional = argv.filter((arg) => arg !== "--json");
  if (
    (positional.length !== 1 && positional.length !== 2) ||
    jsonArgs.length > 1 ||
    argv.some((arg) => arg.startsWith("-") && arg !== "--json")
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const [name, targetArg] = positional;
  const targetDir = targetArg
    ? resolve(targetArg)
    : resolve(process.cwd(), name);
  const result = createPluginScaffold(name, targetDir);
  if (jsonArgs.length === 1) {
    process.stdout.write(`${JSON.stringify(pluginCreateJson(result))}\n`);
  } else {
    const output = formatResult(name, result);
    (result.valid ? process.stdout : process.stderr).write(output);
  }
  return result.valid ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
