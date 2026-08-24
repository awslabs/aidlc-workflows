#!/usr/bin/env bun
// Offline validator for an authored AIDLC plugin repository.
//
// This tool deliberately resolves everything from <plugin-root> plus assets
// bundled beside the running tool. It does not require an AIDLC project,
// framework checkout, network access, or installed harness.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  frontmatterBlock,
  listField,
  parseStageFrontmatter,
  scalarField,
} from "./aidlc-lib.ts";
import {
  type StageFrontmatter,
  type ValidationContext,
  validateStageFrontmatter,
} from "./aidlc-stage-schema.ts";

export type PluginValidationRule =
  | "plugin-root"
  | "manifest-missing"
  | "manifest-json"
  | "manifest-shape"
  | "manifest-name"
  | "stage-frontmatter"
  | "stage-schema"
  | "stage-filename"
  | "stage-owner"
  | "scope-frontmatter"
  | "scope-filename"
  | "scope-name"
  | "scope-owner"
  | "scope-depth"
  | "scope-keywords"
  | "agent-frontmatter"
  | "agent-filename"
  | "agent-name"
  | "agent-owner"
  | "duplicate-artifact-producer"
  | "tools-payload"
  | "compose-template-missing"
  | "compose-hook-stale"
  | "compose-hook-absent"
  | "build-output"
  | "build-emission"
  | "test-install"
  | "test-compose"
  | "test-compose-drop"
  | "test-graph"
  | "test-idempotency"
  | "test-live-mutation";

export interface PluginValidationFinding {
  file: string;
  rule: PluginValidationRule;
  message: string;
  fix: string;
}

export type ComposeHookStatus = "match" | "stale" | "absent" | "unavailable";

export interface PluginComposeHookResult {
  status: ComposeHookStatus;
  pluginPath: string;
  referencePath: string;
}

export interface PluginValidationResult {
  valid: boolean;
  errors: PluginValidationFinding[];
  warnings: PluginValidationFinding[];
  composeHook: PluginComposeHookResult;
}

export interface PluginValidationOptions {
  stageContext?: ValidationContext;
  composeTemplatePath?: string;
}

type MutableFindings = {
  errors: PluginValidationFinding[];
  warnings: PluginValidationFinding[];
};

type ManifestResult = {
  pluginName: string;
};

const MANIFEST_REL = join(".aidlc-plugin", "plugin.json");
const COMPOSE_REL = join("hooks", "compose.ts");
const VALID_DEPTHS = new Set(["Minimal", "Standard", "Comprehensive"]);
const SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const CONTRIBUTION_KEYS = new Set([
  "stages",
  "overlays",
  "agents",
  "scopes",
  "memory",
  "sensors",
  "knowledge",
  "tools",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function posixRelative(root: string, file: string): string {
  const rel = relative(root, file).split(sep).join("/");
  return rel || ".";
}

function findingSort(
  left: PluginValidationFinding,
  right: PluginValidationFinding,
): number {
  return (
    left.file.localeCompare(right.file) ||
    left.rule.localeCompare(right.rule) ||
    left.message.localeCompare(right.message)
  );
}

function addError(
  findings: MutableFindings,
  file: string,
  rule: PluginValidationRule,
  message: string,
  fix: string,
): void {
  findings.errors.push({ file, rule, message, fix });
}

function addWarning(
  findings: MutableFindings,
  file: string,
  rule: PluginValidationRule,
  message: string,
  fix: string,
): void {
  findings.warnings.push({ file, rule, message, fix });
}

export function walkPluginFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkPluginFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export function bundledPluginComposeTemplatePath(): string {
  const candidates = [
    join(
      import.meta.dir,
      "data",
      "plugin-hooks-template",
      "compose.ts",
    ),
    join(
      import.meta.dir,
      "..",
      "..",
      "scripts",
      "plugin-hooks-template",
      "compose.ts",
    ),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function validateManifest(
  root: string,
  findings: MutableFindings,
): ManifestResult {
  const rootName = basename(root);
  const manifestFile = join(root, MANIFEST_REL);
  const displayFile = posixRelative(root, manifestFile);
  if (!existsSync(manifestFile)) {
    addError(
      findings,
      displayFile,
      "manifest-missing",
      "plugin manifest is missing",
      `Create ${MANIFEST_REL} with the plugin name, semantic version, and aidlc.contributes object.`,
    );
    return { pluginName: rootName };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
  } catch (error) {
    addError(
      findings,
      displayFile,
      "manifest-json",
      `plugin manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the JSON syntax; comments are not valid in plugin.json.",
    );
    return { pluginName: rootName };
  }

  if (!isPlainRecord(manifest)) {
    addError(
      findings,
      displayFile,
      "manifest-shape",
      "plugin manifest must be a JSON object",
      "Replace the manifest root with an object containing name, version, and aidlc.contributes.",
    );
    return { pluginName: rootName };
  }

  const declaredName =
    typeof manifest.name === "string" && manifest.name.trim()
      ? manifest.name.trim()
      : rootName;
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    addError(
      findings,
      displayFile,
      "manifest-shape",
      "manifest name must be a non-empty string",
      `Set "name" to the plugin repository directory name "${rootName}".`,
    );
  } else {
    if (!PLUGIN_NAME_RE.test(declaredName)) {
      addError(
        findings,
        displayFile,
        "manifest-name",
        `manifest name "${declaredName}" must be lowercase kebab-case`,
        "Use a name matching /^[a-z][a-z0-9-]*$/.",
      );
    }
    if (
      declaredName === "core" ||
      declaredName === "aidlc" ||
      declaredName.startsWith("aidlc-")
    ) {
      addError(
        findings,
        displayFile,
        "manifest-name",
        `manifest name "${declaredName}" is reserved`,
        'Choose a name other than "core", "aidlc", or the "aidlc-" namespace.',
      );
    }
    if (declaredName !== rootName) {
      addError(
        findings,
        displayFile,
        "manifest-name",
        `manifest name "${declaredName}" does not equal plugin root directory "${rootName}"`,
        `Rename the directory to "${declaredName}" or set "name" to "${rootName}".`,
      );
    }
  }

  if (
    typeof manifest.version !== "string" ||
    !SEMVER_RE.test(manifest.version)
  ) {
    addError(
      findings,
      displayFile,
      "manifest-shape",
      "manifest version must be a semantic version such as 1.2.3",
      'Set "version" to a SemVer value in MAJOR.MINOR.PATCH form.',
    );
  }
  if (
    manifest.description !== undefined &&
    typeof manifest.description !== "string"
  ) {
    addError(
      findings,
      displayFile,
      "manifest-shape",
      "manifest description must be a string when present",
      "Use a string description or remove the field.",
    );
  }
  if (manifest.author !== undefined) {
    const validAuthor =
      (typeof manifest.author === "string" &&
        manifest.author.trim().length > 0) ||
      (isPlainRecord(manifest.author) &&
        typeof manifest.author.name === "string" &&
        manifest.author.name.trim().length > 0);
    if (!validAuthor) {
      addError(
        findings,
        displayFile,
        "manifest-shape",
        "manifest author must be a non-empty string or an object with a non-empty name",
        'Use "author": {"name": "Your organization"} or remove the field.',
      );
    }
  }
  if (
    manifest.dependencies !== undefined &&
    (!Array.isArray(manifest.dependencies) ||
      manifest.dependencies.some(
        (entry) => typeof entry !== "string" || entry.trim() === "",
      ))
  ) {
    addError(
      findings,
      displayFile,
      "manifest-shape",
      "manifest dependencies must be an array of non-empty strings",
      'Use entries such as "core" or "other-plugin@^1.2.0".',
    );
  }

  if (!isPlainRecord(manifest.aidlc)) {
    addError(
      findings,
      displayFile,
      "manifest-shape",
      "manifest aidlc must be an object",
      'Add "aidlc": {"contributes": {...}}.',
    );
    return { pluginName: declaredName };
  }
  if (!isPlainRecord(manifest.aidlc.contributes)) {
    addError(
      findings,
      displayFile,
      "manifest-shape",
      "manifest aidlc.contributes must be an object",
      "Map each shipped subtree to its plugin-relative directory.",
    );
    return { pluginName: declaredName };
  }

  for (const [key, value] of Object.entries(manifest.aidlc.contributes)) {
    if (!CONTRIBUTION_KEYS.has(key)) {
      addError(
        findings,
        displayFile,
        "manifest-shape",
        `unknown aidlc.contributes key "${key}"`,
        `Use one of: ${[...CONTRIBUTION_KEYS].sort().join(", ")}.`,
      );
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      addError(
        findings,
        displayFile,
        "manifest-shape",
        `aidlc.contributes.${key} must be a non-empty relative path`,
        `Point "${key}" at the corresponding plugin subtree, for example "${key}/".`,
      );
      continue;
    }
    if (
      isAbsolute(value) ||
      value.split(/[\\/]/).includes("..")
    ) {
      addError(
        findings,
        displayFile,
        "manifest-shape",
        `aidlc.contributes.${key} must stay within the plugin root`,
        "Use a plugin-relative path without .. segments.",
      );
    }
  }

  return { pluginName: declaredName };
}

function validateStages(
  root: string,
  pluginName: string,
  findings: MutableFindings,
  context?: ValidationContext,
): void {
  const artifactProducers = new Map<
    string,
    Array<{ file: string; slug: string }>
  >();
  for (const file of walkPluginFiles(join(root, "stages")).filter((path) =>
    path.endsWith(".md"),
  )) {
    const displayFile = posixRelative(root, file);
    let parsed: Record<string, unknown>;
    try {
      parsed = parseStageFrontmatter(readFileSync(file, "utf-8"));
    } catch (error) {
      addError(
        findings,
        displayFile,
        "stage-frontmatter",
        `stage frontmatter could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        "Add a closed YAML frontmatter block and valid stage fields.",
      );
      continue;
    }

    const validation = validateStageFrontmatter(parsed, context);
    if (!validation.valid) {
      for (const error of validation.errors) {
        addError(
          findings,
          displayFile,
          "stage-schema",
          error,
          "Correct the stage frontmatter to satisfy the shipped stage schema.",
        );
      }
    }

    const stem = basename(file, ".md");
    if (parsed.slug !== stem) {
      addError(
        findings,
        displayFile,
        "stage-filename",
        `stage slug "${String(parsed.slug ?? "")}" must equal filename stem "${stem}"`,
        `Rename the file to ${String(parsed.slug ?? "<slug>")}.md or update slug.`,
      );
    }
    if (parsed.plugin !== pluginName) {
      addError(
        findings,
        displayFile,
        "stage-owner",
        `stage plugin "${String(parsed.plugin ?? "")}" must equal manifest name "${pluginName}"`,
        `Set plugin: ${pluginName}.`,
      );
    }

    const stage = validation.valid
      ? validation.data
      : (parsed as Partial<StageFrontmatter>);
    const slug = typeof stage.slug === "string" ? stage.slug : stem;
    const produced = new Set<string>([
      ...(Array.isArray(stage.produces)
        ? stage.produces.filter(
            (value): value is string => typeof value === "string",
          )
        : []),
      ...(Array.isArray(stage.optional_produces)
        ? stage.optional_produces.filter(
            (value): value is string => typeof value === "string",
          )
        : []),
    ]);
    for (const artifact of produced) {
      const producers = artifactProducers.get(artifact) ?? [];
      producers.push({ file: displayFile, slug });
      artifactProducers.set(artifact, producers);
    }
  }

  for (const [artifact, producers] of artifactProducers) {
    if (producers.length < 2) continue;
    const producerList = producers
      .map(({ file, slug }) => `${file} (stage "${slug}")`)
      .join(", ");
    addError(
      findings,
      producers[0].file,
      "duplicate-artifact-producer",
      `artifact "${artifact}" has multiple producers within this plugin: ${producerList}`,
      "Rename the artifact in all but one producing stage; produces and optional_produces share one namespace.",
    );
  }
}

function validateScopes(
  root: string,
  pluginName: string,
  findings: MutableFindings,
): void {
  const prefix = `${pluginName}-`;
  for (const file of walkPluginFiles(join(root, "scopes")).filter((path) =>
    path.endsWith(".md"),
  )) {
    const displayFile = posixRelative(root, file);
    const raw = readFileSync(file, "utf-8");
    const frontmatter = frontmatterBlock(raw);
    if (frontmatter === null) {
      addError(
        findings,
        displayFile,
        "scope-frontmatter",
        "scope file is missing YAML frontmatter",
        "Add a closed --- frontmatter block with name, plugin, depth, and optional keywords.",
      );
      continue;
    }
    const stem = basename(file, ".md");
    if (
      !stem.startsWith(prefix) ||
      !PLUGIN_NAME_RE.test(stem.slice(prefix.length))
    ) {
      addError(
        findings,
        displayFile,
        "scope-filename",
        `scope filename must match ${pluginName}-<name>.md`,
        `Rename the file with the "${pluginName}-" prefix and a lowercase kebab-case suffix.`,
      );
    }
    const name = scalarField(frontmatter, "name");
    if (name !== stem) {
      addError(
        findings,
        displayFile,
        "scope-name",
        `scope name "${name}" must equal filename stem "${stem}"`,
        `Set name: ${stem}.`,
      );
    }
    const owner = scalarField(frontmatter, "plugin");
    if (owner !== pluginName) {
      addError(
        findings,
        displayFile,
        "scope-owner",
        `scope plugin "${owner}" must equal manifest name "${pluginName}"`,
        `Set plugin: ${pluginName}.`,
      );
    }
    const depth = scalarField(frontmatter, "depth");
    if (!VALID_DEPTHS.has(depth)) {
      addError(
        findings,
        displayFile,
        "scope-depth",
        `scope depth "${depth}" must be Minimal, Standard, or Comprehensive`,
        "Choose one of the three supported depth values.",
      );
    }
    if (
      /^keywords\s*:/m.test(frontmatter) &&
      listField(frontmatter, "keywords").length === 0
    ) {
      addError(
        findings,
        displayFile,
        "scope-keywords",
        "declared keywords must parse to a non-empty block or flow list",
        "Add at least one keyword using `keywords: [value]` or indented `- value` entries.",
      );
    }
  }
}

function validateAgents(
  root: string,
  pluginName: string,
  findings: MutableFindings,
): void {
  const escaped = pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filenameRe = new RegExp(
    `^${escaped}-[a-z][a-z0-9-]*-agent$`,
  );
  for (const file of walkPluginFiles(join(root, "agents")).filter((path) =>
    path.endsWith(".md"),
  )) {
    const displayFile = posixRelative(root, file);
    const frontmatter = frontmatterBlock(readFileSync(file, "utf-8"));
    if (frontmatter === null) {
      addError(
        findings,
        displayFile,
        "agent-frontmatter",
        "agent file is missing YAML frontmatter",
        "Add a closed --- frontmatter block with name and plugin.",
      );
      continue;
    }
    const stem = basename(file, ".md");
    if (!filenameRe.test(stem)) {
      addError(
        findings,
        displayFile,
        "agent-filename",
        `agent filename must match ${pluginName}-<role>-agent.md`,
        `Rename the file with the "${pluginName}-" prefix and "-agent.md" suffix.`,
      );
    }
    const name = scalarField(frontmatter, "name");
    if (name !== stem) {
      addError(
        findings,
        displayFile,
        "agent-name",
        `agent name "${name}" must equal filename stem "${stem}"`,
        `Set name: ${stem}.`,
      );
    }
    const owner = scalarField(frontmatter, "plugin");
    if (owner !== pluginName) {
      addError(
        findings,
        displayFile,
        "agent-owner",
        `agent plugin "${owner}" must equal manifest name "${pluginName}"`,
        `Set plugin: ${pluginName}.`,
      );
    }
  }
}

function validateTools(
  root: string,
  findings: MutableFindings,
): void {
  const toolsRoot = join(root, "tools");
  for (const file of walkPluginFiles(toolsRoot)) {
    const rel = posixRelative(toolsRoot, file);
    const segments = rel.split("/");
    const filename = segments.at(-1) ?? "";
    const hasPayloadDir = segments
      .slice(0, -1)
      .some((segment) => segment === "tests" || segment === "fixtures");
    if (!hasPayloadDir && !filename.endsWith(".test.ts")) continue;
    addError(
      findings,
      posixRelative(root, file),
      "tools-payload",
      "non-tool test or fixture payload under tools/ would be copied into every install",
      "Move tests and fixtures to the plugin-root tests/ directory.",
    );
  }
}

function validateComposeHook(
  root: string,
  findings: MutableFindings,
  override?: string,
): PluginComposeHookResult {
  const pluginPath = join(root, COMPOSE_REL);
  const referencePath = override ?? bundledPluginComposeTemplatePath();
  if (!existsSync(referencePath)) {
    addError(
      findings,
      COMPOSE_REL.split(sep).join("/"),
      "compose-template-missing",
      `bundled compose-hook template is unavailable at ${referencePath}`,
      "Reinstall the AIDLC tools bundle so tools/data/plugin-hooks-template/compose.ts is present.",
    );
    return {
      status: "unavailable",
      pluginPath,
      referencePath,
    };
  }
  if (!existsSync(pluginPath)) {
    addWarning(
      findings,
      COMPOSE_REL.split(sep).join("/"),
      "compose-hook-absent",
      "vendored compose hook is absent; plugin build will inject the bundled hook",
      "No action is required unless this repository intentionally vendors hooks/compose.ts.",
    );
    return { status: "absent", pluginPath, referencePath };
  }
  const matches = readFileSync(pluginPath).equals(readFileSync(referencePath));
  if (!matches) {
    addError(
      findings,
      COMPOSE_REL.split(sep).join("/"),
      "compose-hook-stale",
      `vendored compose hook ${pluginPath} differs from bundled template ${referencePath}`,
      `Replace ${pluginPath} with the exact bytes from ${referencePath}.`,
    );
    return { status: "stale", pluginPath, referencePath };
  }
  return { status: "match", pluginPath, referencePath };
}

export function validatePluginRoot(
  pluginRoot: string,
  options: PluginValidationOptions = {},
): PluginValidationResult {
  const root = resolve(pluginRoot);
  const findings: MutableFindings = { errors: [], warnings: [] };
  try {
    if (!statSync(root).isDirectory()) {
      addError(
        findings,
        ".",
        "plugin-root",
        `${root} is not a directory`,
        "Pass the plugin repository root containing .aidlc-plugin/plugin.json.",
      );
    }
  } catch {
    addError(
      findings,
      ".",
      "plugin-root",
      `${root} does not exist`,
      "Pass an existing plugin repository root.",
    );
  }
  if (findings.errors.length > 0) {
    const referencePath =
      options.composeTemplatePath ?? bundledPluginComposeTemplatePath();
    return {
      valid: false,
      errors: findings.errors,
      warnings: [],
      composeHook: {
        status: "unavailable",
        pluginPath: join(root, COMPOSE_REL),
        referencePath,
      },
    };
  }

  const { pluginName } = validateManifest(root, findings);
  validateStages(
    root,
    pluginName,
    findings,
    options.stageContext,
  );
  validateScopes(root, pluginName, findings);
  validateAgents(root, pluginName, findings);
  validateTools(root, findings);
  const composeHook = validateComposeHook(
    root,
    findings,
    options.composeTemplatePath,
  );
  findings.errors.sort(findingSort);
  findings.warnings.sort(findingSort);
  return {
    valid: findings.errors.length === 0,
    errors: findings.errors,
    warnings: findings.warnings,
    composeHook,
  };
}

export function pluginValidationJson(
  result: PluginValidationResult,
): {
  valid: boolean;
  errors: PluginValidationFinding[];
  warnings: PluginValidationFinding[];
} {
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
  };
}

export function formatPluginValidation(
  pluginRoot: string,
  result: PluginValidationResult,
): string {
  const lines = [
    `Plugin validation: ${result.valid ? "VALID" : "INVALID"}`,
    `Root: ${resolve(pluginRoot)}`,
    `Compose hook: ${result.composeHook.status} (${result.composeHook.pluginPath} vs ${result.composeHook.referencePath})`,
  ];
  for (const [level, entries] of [
    ["ERROR", result.errors],
    ["WARNING", result.warnings],
  ] as const) {
    for (const finding of entries) {
      lines.push(
        `${level} ${finding.file} [${finding.rule}]: ${finding.message}`,
        `  Fix: ${finding.fix}`,
      );
    }
  }
  lines.push(
    `Errors: ${result.errors.length}; warnings: ${result.warnings.length}`,
  );
  return `${lines.join("\n")}\n`;
}

const USAGE =
  "Usage: bun <tools-dir>/aidlc-plugin-validate.ts <plugin-root> [--json]";

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const jsonArgs = argv.filter((arg) => arg === "--json");
  const positional = argv.filter((arg) => arg !== "--json");
  if (
    positional.length !== 1 ||
    jsonArgs.length > 1 ||
    argv.some((arg) => arg.startsWith("-") && arg !== "--json")
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const pluginRoot = positional[0];
  const result = validatePluginRoot(pluginRoot);
  if (jsonArgs.length === 1) {
    process.stdout.write(`${JSON.stringify(pluginValidationJson(result))}\n`);
  } else {
    const output = formatPluginValidation(pluginRoot, result);
    (result.valid ? process.stdout : process.stderr).write(output);
  }
  return result.valid ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
