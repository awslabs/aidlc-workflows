#!/usr/bin/env bun
// Offline validator for an authored AIDLC plugin repository.
//
// This tool deliberately resolves everything from <plugin-root> plus assets
// bundled beside the running tool. It does not require an AIDLC project,
// framework checkout, network access, or installed harness.

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  basename,
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
  | "content-symlink"
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
  | "artifact-namespace"
  | "contribution-target"
  | "stage-body"
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
  | "test-live-mutation"
  | "create-target"
  | "create-write";

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
  coreStageSlugs?: Iterable<string>;
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
const CANONICAL_CONTRIBUTION_PATHS: Record<string, string> = {
  stages: "stages/",
  overlays: "contributions/",
  agents: "agents/",
  scopes: "scopes/",
  sensors: "sensors/",
  knowledge: "knowledge/",
  tools: "tools/",
};
const PLUGIN_SYMLINK_SCAN_DIRS = [
  ".aidlc-plugin",
  "stages",
  "sensors",
  "tools",
  "contributions",
  "scopes",
  "agents",
  "knowledge",
  "hooks",
] as const;

type PluginAuthoringContext = {
  agents: string[];
  stages: string[];
};

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

type ContributionPathIssue = {
  key: string;
  message: string;
  fix: string;
};

function contributionPathIssues(
  contributes: Record<string, unknown>,
): ContributionPathIssue[] {
  const issues: ContributionPathIssue[] = [];
  for (const [key, value] of Object.entries(contributes)) {
    if (!CONTRIBUTION_KEYS.has(key)) {
      issues.push({
        key,
        message: `unknown aidlc.contributes key "${key}"`,
        fix: `Use one of: ${[...CONTRIBUTION_KEYS].sort().join(", ")}.`,
      });
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({
        key,
        message: `aidlc.contributes.${key} must be a non-empty relative path`,
        fix: `Point "${key}" at the corresponding canonical plugin subtree.`,
      });
      continue;
    }
    if (key === "memory") {
      issues.push({
        key,
        message:
          "aidlc.contributes.memory is not supported by the current plugin projection",
        fix: "Remove the memory contribution until memory projection ships.",
      });
      continue;
    }
    const canonical = CANONICAL_CONTRIBUTION_PATHS[key];
    if (canonical && value !== canonical) {
      issues.push({
        key,
        message:
          `aidlc.contributes.${key} must be "${canonical}" until configurable contribution paths are supported`,
        fix: `Move the content to "${canonical}" and set aidlc.contributes.${key} to that exact path.`,
      });
    }
  }
  return issues;
}

export function assertSupportedPluginContributionPaths(
  manifest: Record<string, unknown>,
  manifestFile = MANIFEST_REL.split(sep).join("/"),
): void {
  if (!isPlainRecord(manifest.aidlc)) {
    throw new Error(`${manifestFile}: manifest aidlc must be an object`);
  }
  if (!isPlainRecord(manifest.aidlc.contributes)) {
    throw new Error(
      `${manifestFile}: manifest aidlc.contributes must be an object`,
    );
  }
  const issues = contributionPathIssues(manifest.aidlc.contributes);
  if (issues.length === 0) return;
  throw new Error(
    `${manifestFile}: ${issues.map((issue) => issue.message).join("; ")}`,
  );
}

export function validatePluginName(
  declaredName: string,
  rootName = declaredName,
  file = MANIFEST_REL.split(sep).join("/"),
): PluginValidationFinding[] {
  const findings: PluginValidationFinding[] = [];
  if (!PLUGIN_NAME_RE.test(declaredName)) {
    findings.push({
      file,
      rule: "manifest-name",
      message: `manifest name "${declaredName}" must be lowercase kebab-case`,
      fix: "Use a name matching /^[a-z][a-z0-9-]*$/.",
    });
  }
  if (
    declaredName === "core" ||
    declaredName === "aidlc" ||
    declaredName.startsWith("aidlc-")
  ) {
    findings.push({
      file,
      rule: "manifest-name",
      message: `manifest name "${declaredName}" is reserved`,
      fix: 'Choose a name other than "core", "aidlc", or the "aidlc-" namespace.',
    });
  }
  if (declaredName !== rootName) {
    findings.push({
      file,
      rule: "manifest-name",
      message: `manifest name "${declaredName}" does not equal plugin root directory "${rootName}"`,
      fix: `Rename the directory to "${declaredName}" or set "name" to "${rootName}".`,
    });
  }
  return findings;
}

export interface PluginFileScan {
  files: string[];
  symlinks: string[];
}

export function scanPluginFiles(dir: string): PluginFileScan {
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(dir);
  } catch {
    return { files: [], symlinks: [] };
  }
  if (rootStat.isSymbolicLink()) {
    return { files: [], symlinks: [dir] };
  }
  if (!rootStat.isDirectory()) {
    return { files: rootStat.isFile() ? [dir] : [], symlinks: [] };
  }

  const files: string[] = [];
  const symlinks: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) symlinks.push(path);
    else if (entry.isDirectory()) {
      const nested = scanPluginFiles(path);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
    } else if (entry.isFile()) files.push(path);
  }
  return { files, symlinks };
}

export function pluginContentSymlinks(pluginRoot: string): string[] {
  const root = resolve(pluginRoot);
  return PLUGIN_SYMLINK_SCAN_DIRS.flatMap((dir) =>
    scanPluginFiles(join(root, dir)).symlinks
  ).sort((left, right) => left.localeCompare(right));
}

export function assertPluginContentHasNoSymlinks(
  pluginRoot: string,
): void {
  const root = resolve(pluginRoot);
  const symlinks = pluginContentSymlinks(root);
  if (symlinks.length === 0) return;
  const linked = posixRelative(root, symlinks[0]);
  throw new Error(
    `${linked}: plugin content symlinks are unsupported; replace the link with a regular file or directory`,
  );
}

export function walkPluginFiles(dir: string): string[] {
  const scan = scanPluginFiles(dir);
  if (scan.symlinks.length > 0) {
    throw new Error(
      `${scan.symlinks[0]}: plugin content symlinks are unsupported; replace the link with a regular file or directory`,
    );
  }
  return scan.files;
}

function validatePluginContentSymlinks(
  root: string,
  findings: MutableFindings,
): void {
  for (const linked of pluginContentSymlinks(root)) {
    addError(
      findings,
      posixRelative(root, linked),
      "content-symlink",
      "plugin content symlinks are unsupported",
      "Replace the link with a regular file or directory inside the plugin root.",
    );
  }
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

function pluginAuthoringContext(): PluginAuthoringContext {
  const bundled = join(
    import.meta.dir,
    "data",
    "plugin-authoring-context.json",
  );
  try {
    const parsed = JSON.parse(readFileSync(bundled, "utf-8")) as unknown;
    if (
      isPlainRecord(parsed) &&
      Array.isArray(parsed.agents) &&
      parsed.agents.every((value) => typeof value === "string") &&
      Array.isArray(parsed.stages) &&
      parsed.stages.every((value) => typeof value === "string")
    ) {
      return {
        agents: [...parsed.agents],
        stages: [...parsed.stages],
      };
    }
  } catch {
    // Source-tree fallback below.
  }
  return {
    agents: walkPluginFiles(join(import.meta.dir, "..", "agents"))
      .filter((file) => file.endsWith("-agent.md"))
      .map((file) => basename(file, ".md"))
      .sort(),
    stages: walkPluginFiles(
      join(import.meta.dir, "..", "aidlc-common", "stages"),
    )
      .filter((file) => file.endsWith(".md"))
      .map((file) => basename(file, ".md"))
      .sort(),
  };
}

function pluginAgentRoster(root: string): string[] {
  const pluginAgents = scanPluginFiles(join(root, "agents")).files
    .filter((file) => file.endsWith("-agent.md"))
    .map((file) => basename(file, ".md"));
  return [
    ...new Set([
      ...pluginAuthoringContext().agents,
      ...pluginAgents,
      "orchestrator",
    ]),
  ].sort();
}

function stageBodyAfterFrontmatter(raw: string): string {
  return raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? "";
}

function nestedListField(
  frontmatter: string,
  parent: string,
  key: string,
): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const parentIndex = lines.indexOf(`${parent}:`);
  if (parentIndex < 0) return [];
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    if (line !== `  ${key}:`) continue;
    const values: string[] = [];
    for (let item = index + 1; item < lines.length; item += 1) {
      const match = lines[item].match(/^\s{4}-\s+(.+?)\s*$/);
      if (match) {
        values.push(match[1].replace(/^["']|["']$/g, ""));
        continue;
      }
      if (lines[item].trim() !== "") break;
    }
    return values;
  }
  return [];
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
    findings.errors.push(
      ...validatePluginName(declaredName, rootName, displayFile),
    );
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

  for (const issue of contributionPathIssues(manifest.aidlc.contributes)) {
    addError(
      findings,
      displayFile,
      "manifest-shape",
      issue.message,
      issue.fix,
    );
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
  for (const file of scanPluginFiles(join(root, "stages")).files.filter((path) =>
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

    if (stageBodyAfterFrontmatter(readFileSync(file, "utf-8")).trim() === "") {
      addError(
        findings,
        displayFile,
        "stage-body",
        "stage body is empty",
        "Add substantive stage instructions after the closing frontmatter delimiter.",
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
      if (!artifact.startsWith(`${pluginName}-`)) {
        addError(
          findings,
          displayFile,
          "artifact-namespace",
          `produced artifact "${artifact}" must start with "${pluginName}-"`,
          `Rename the artifact with the "${pluginName}-" prefix.`,
        );
      }
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

function validateContributions(
  root: string,
  pluginName: string,
  findings: MutableFindings,
  coreStageSlugs?: Iterable<string>,
): void {
  const coreStages = new Set(
    coreStageSlugs ?? pluginAuthoringContext().stages,
  );
  for (const file of scanPluginFiles(join(root, "contributions")).files.filter(
    (path) => path.endsWith(".md"),
  )) {
    const displayFile = posixRelative(root, file);
    const frontmatter = frontmatterBlock(readFileSync(file, "utf-8")) ?? "";
    const target = scalarField(frontmatter, "target");
    if (!target || !coreStages.has(target)) {
      addError(
        findings,
        displayFile,
        "contribution-target",
        `target "${target}" does not resolve to a core stage slug`,
        "Name an existing core stage slug in target:.",
      );
    }
    if (scalarField(frontmatter, "plugin") !== pluginName) {
      addError(
        findings,
        displayFile,
        "stage-owner",
        `contribution plugin must equal manifest name "${pluginName}"`,
        `Set plugin: ${pluginName}.`,
      );
    }
    for (const artifact of nestedListField(frontmatter, "adds", "produces")) {
      if (artifact.startsWith(`${pluginName}-`)) continue;
      addError(
        findings,
        displayFile,
        "artifact-namespace",
        `produced artifact "${artifact}" must start with "${pluginName}-"`,
        `Rename the artifact with the "${pluginName}-" prefix.`,
      );
    }
  }
}

function validateScopes(
  root: string,
  pluginName: string,
  findings: MutableFindings,
): void {
  const prefix = `${pluginName}-`;
  for (const file of scanPluginFiles(join(root, "scopes")).files.filter((path) =>
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
  for (const file of scanPluginFiles(join(root, "agents")).files.filter((path) =>
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
  for (const file of scanPluginFiles(toolsRoot).files) {
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
  validatePluginContentSymlinks(root, findings);
  validateStages(
    root,
    pluginName,
    findings,
    options.stageContext ?? { agents: pluginAgentRoster(root) },
  );
  validateContributions(root, pluginName, findings, options.coreStageSlugs);
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
