#!/usr/bin/env bun
// Offline builder for one authored AIDLC plugin and one target harness.

import { existsSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  buildPluginProjection,
  readPluginTargets,
} from "./aidlc-plugin-emit.ts";
import {
  formatPluginValidation,
  type PluginValidationFinding,
  type PluginValidationResult,
  pluginValidationJson,
  validatePluginRoot,
} from "./aidlc-plugin-validate.ts";

const USAGE =
  "Usage: bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> <harness> [outDir] [--json]";

export function bundledPluginTargetsPath(): string {
  const candidates = [
    join(import.meta.dir, "data", "plugin-targets.json"),
    join(
      import.meta.dir,
      "..",
      "..",
      "dist",
      "claude",
      ".claude",
      "tools",
      "data",
      "plugin-targets.json",
    ),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

export function bundledPluginHookTemplatesDir(): string {
  const candidates = [
    join(import.meta.dir, "data", "plugin-hooks-template"),
    join(import.meta.dir, "..", "..", "scripts", "plugin-hooks-template"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function withBuildError(
  result: PluginValidationResult,
  file: string,
  rule: "build-output" | "build-emission",
  message: string,
  fix: string,
): PluginValidationResult {
  const finding: PluginValidationFinding = {
    file,
    rule,
    message,
    fix,
  };
  return {
    ...result,
    valid: false,
    errors: [...result.errors, finding],
  };
}

function formatBuildResult(
  pluginRoot: string,
  harness: string,
  outDir: string,
  result: PluginValidationResult,
): string {
  if (!result.valid) {
    return formatPluginValidation(pluginRoot, result).replace(
      "Plugin validation: INVALID",
      "Plugin build: FAILED",
    );
  }
  const lines = [
    "Plugin build: COMPLETE",
    `Plugin root: ${resolve(pluginRoot)}`,
    `Harness: ${harness}`,
    `Output: ${resolve(outDir)}`,
  ];
  for (const finding of result.warnings) {
    lines.push(
      `WARNING ${finding.file} [${finding.rule}]: ${finding.message}`,
      `  Fix: ${finding.fix}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeResult(
  json: boolean,
  pluginRoot: string,
  harness: string,
  outDir: string,
  result: PluginValidationResult,
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(pluginValidationJson(result))}\n`,
    );
    return;
  }
  const output = formatBuildResult(
    pluginRoot,
    harness,
    outDir,
    result,
  );
  (result.valid ? process.stdout : process.stderr).write(output);
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const jsonArgs = argv.filter((arg) => arg === "--json");
  const positional = argv.filter((arg) => arg !== "--json");
  if (
    (positional.length !== 2 && positional.length !== 3) ||
    jsonArgs.length > 1 ||
    argv.some((arg) => arg.startsWith("-") && arg !== "--json")
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const [pluginRootArg, harness, outArg] = positional;
  const pluginRoot = resolve(pluginRootArg);
  const outDir = outArg
    ? resolve(outArg)
    : join(pluginRoot, "dist", harness);
  const relativeToPlugin = relative(pluginRoot, outDir);
  const outputInsidePlugin =
    !isAbsolute(relativeToPlugin) &&
    relativeToPlugin !== ".." &&
    !relativeToPlugin.startsWith(`..${sep}`);
  const outputBoundary =
    !outArg || outputInsidePlugin ? pluginRoot : outDir;
  let validation = validatePluginRoot(pluginRoot);
  if (!validation.valid) {
    writeResult(
      jsonArgs.length === 1,
      pluginRoot,
      harness,
      outDir,
      validation,
    );
    return 1;
  }

  const targetsPath = bundledPluginTargetsPath();
  if (!existsSync(targetsPath)) {
    validation = withBuildError(
      validation,
      "tools/data/plugin-targets.json",
      "build-emission",
      `bundled plugin target table is missing at ${targetsPath}`,
      "Reinstall the AIDLC tools bundle.",
    );
    writeResult(
      jsonArgs.length === 1,
      pluginRoot,
      harness,
      outDir,
      validation,
    );
    return 1;
  }
  const targets = readPluginTargets(targetsPath);
  const target = targets[harness];
  if (!target) {
    process.stderr.write(
      `${USAGE}\nUnknown harness "${harness}" (available: ${Object.keys(targets).sort().join(", ")})\n`,
    );
    return 2;
  }

  try {
    buildPluginProjection({
      pluginRoot,
      target,
      outDir,
      outputBoundary,
      templateHooksDir: dirname(
        join(
          bundledPluginHookTemplatesDir(),
          "compose.ts",
        ),
      ),
    });
  } catch (error) {
    validation = withBuildError(
      validation,
      outDir,
      "build-output",
      error instanceof Error ? error.message : String(error),
      "Choose a fresh output directory or correct the plugin source and retry.",
    );
  }

  writeResult(
    jsonArgs.length === 1,
    pluginRoot,
    harness,
    outDir,
    validation,
  );
  return validation.valid ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
