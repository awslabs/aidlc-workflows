#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTarGz } from "./aidlc-archive.ts";
import {
  EXIT,
  emitResult,
  failure,
  globalOptions,
  success,
  usage,
  valueAfter,
  valuesAfter,
} from "./aidlc-command.ts";
import {
  cmd,
  dim,
  errorLabel,
  heading,
  success as successText,
  tipLabel,
  warnVerdict,
} from "./aidlc-color.ts";
import {
  assertProjectionPathHasNoSymlinks,
  type ProjectionDescriptor,
  projectionFiles,
  sha256Bytes,
  sha256File,
  validateProjectionDescriptor,
  walkFiles,
} from "./aidlc-distribution.ts";
import {
  activeVersion,
  binRoot,
  machineTransactionRoot,
  projectDirFrom,
  runtimeRoot,
} from "./aidlc-install-paths.ts";
import { defaultHarnessPath } from "./aidlc-machine-config.ts";
import { configureProjectPin } from "./aidlc-lifecycle.ts";
import {
  type TransactionOperation,
  type TransactionPlan,
  executePlan,
  transactionSourceHash,
  transactionState,
  validateTransactionPlan,
  writeOperation,
} from "./aidlc-transaction.ts";
import { compileStageGraph, __resetGraphCache } from "./aidlc-graph.ts";
import {
  _resetHarnessDataForTests,
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
  getField,
  listIntents,
  listSpaces,
  normalizeProjectFlagsRecord,
  RECORDABLE_PROJECT_BYPASSES,
  stateFilePath,
  type ProjectFlagsRecord,
  withAuditLock,
} from "./aidlc-lib.ts";
import { regenerateRunnerSurfaces } from "./aidlc-runner-gen.ts";
import {
  canonicalScopeTableRegion,
  canonicalStageTableRegion,
  renderScopeTable,
  renderStageTable,
} from "./aidlc-utility.ts";
import {
  aidlcInvocation,
  discoverProjectHarnesses,
  isCompiledExecutable,
} from "./aidlc-runtime-paths.ts";
import {
  activeModelGroups,
  applyModelPolicyToProjection,
  harnessHonestyNotes,
  isModelEffort,
  isModelPreset,
  MODEL_EFFORTS,
  MODEL_GROUPS,
  MODEL_PRESETS,
  modelPolicyIsEmpty,
  modelPolicySurfaceDrift,
  normalizeModelPolicy,
  profileGroups,
  readAgentTiers,
  resolveModelPolicy,
  type AgentTiers,
  type ModelEffort,
  type ModelGroup,
  type ModelHarness,
  type ModelPolicyRecord,
  type ModelProfile,
} from "./aidlc-model-policy.ts";
import { resolveTierCap } from "./aidlc-tiers.ts";
import {
  applyConfigDiagnosticRecords,
  applyProjectFlagsToProjection,
  availableScopeNames,
  completionInstruction,
  detectAwsCredentials,
  discoverInstalledPluginNames,
  effectiveProjectFlagValues,
  flagFiles,
  flagIssues,
  managedBlockMarkers,
  normalizeProvidersRecord,
  normalizeProjectChoicesRecord,
  normalizeRuntimeRecord,
  normalizeTrustRecord,
  pendingProviderIssues,
  postApplyOutstandingActions,
  probeHarnessCli,
  probeRuntime,
  providerFiles,
  providerIssues,
  projectChoiceFiles,
  projectChoiceIssues,
  projectMcpNote,
  readPluginSelection,
  readConfigDiagnosticRecords,
  reconcileProviderActions,
  runtimeIssues,
  trustStatus,
  type ConfigDiagnosticOverrides,
  type ConfigDiagnosticRecords,
  type CompletionShell,
  type ConfigOutstandingAction,
  type ProjectChoicesRecord,
  type ProvidersRecord,
  type RuntimeRecord,
  type TrustRecord,
} from "./aidlc-config-diagnostics.ts";
import {
  LOCAL_SETTINGS_FILE,
  invalidateSettingsCache,
  modelPolicyForHarness,
  readSettingsTarget,
  resolveAidlcSettings,
  resolveAidlcSettingsWithOverride,
  serializeAidlcSettings,
  settingsModelsFromHarnessPolicy,
  settingsPathForTarget,
  settingsSource,
  updateSettingsSection,
  type AidlcSettingsFile,
  type ResolvedAidlcSettings,
  type SettingsTarget,
} from "./aidlc-settings.ts";

type RootContribution =
  | { policy: "managed-block"; hash: string; marker?: string }
  | { policy: "json-map"; entries: Record<string, string>; key?: string }
  | { policy: "json-array"; entries: Record<string, string>; key: string }
  | { policy: "whole-file"; hash: string };

type Baseline = {
  schemaVersion: 1;
  frameworkVersion: string;
  distribution: string;
  harnessDir: string;
  mcpMode: "defaults" | "none";
  files: Record<string, string>;
  rootContributions: Record<string, RootContribution>;
};

type PlannedAction = {
  path: string;
  action: "create" | "update" | "merge" | "preserve" | "remove" | "conflict";
  detail?: string;
};

type ModelsMutationContext = {
  harness: ModelHarness;
  harnessDir: string;
  previous: ModelPolicyRecord | null;
  next: ModelPolicyRecord | null;
  tiers: AgentTiers;
  summaryLines: string[];
  notes: string[];
  settings: SettingsMutation;
};

type DiagnosticSection = "runtime" | "providers" | "trust";
type ChoiceSection = "flags" | "project";
type SetupWalkSection = "runtime" | "providers" | "trust";

type ConfigMainInternal = {
  setupWalkChild?: boolean;
  sourceRoot?: string;
};

type DiagnosticsMutationContext = {
  section: DiagnosticSection;
  harness: ModelHarness;
  harnessDir: string;
  previous: RuntimeRecord | ProvidersRecord | TrustRecord | null;
  next: RuntimeRecord | ProvidersRecord | TrustRecord | null;
  overrides: ConfigDiagnosticOverrides;
  summaryLines: string[];
  notes: string[];
};

type ChoicesMutationContext = {
  section: ChoiceSection;
  harness: ModelHarness;
  harnessDir: string;
  previous: ProjectFlagsRecord | ProjectChoicesRecord | null;
  next: ProjectFlagsRecord | ProjectChoicesRecord | null;
  previousPlugins: string[] | null;
  nextPlugins: string[] | null;
  overrides?: ConfigDiagnosticOverrides;
  mcpMode?: "defaults" | "none";
  summaryLines: string[];
  notes: string[];
  settings?: SettingsMutation;
};

type SettingsMutation = {
  target: SettingsTarget;
  path: string;
  previous: AidlcSettingsFile | null;
  next: AidlcSettingsFile | null;
};

const CONFIG_VALUE_FLAGS = new Set([
  "--agent",
  "--ca-bundle",
  "--deciding-effort",
  "--default-scope",
  "--effort",
  "--from",
  "--harness",
  "--mcp",
  "--model",
  "--output",
  "--opencode-default",
  "--pin",
  "--plan-token",
  "--profile",
  "--provider",
  "--preset",
  "--project-dir",
  "--region",
  "--release-base-url",
  "--mark-done",
  "--plugins",
  "--completions",
  "--reviewing-effort",
  "--save-as",
  "--sensor-timeout-ms",
  "--swarm",
  "--hook-debug",
  "--bypass",
  "--clear-bypass",
  "--writing-up-effort",
]);

const CHOICE_VALUE_FLAGS = new Set([
  "--bypass",
  "--clear-bypass",
  "--completions",
  "--default-scope",
  "--harness",
  "--hook-debug",
  "--mcp",
  "--plan-token",
  "--plugins",
  "--project-dir",
  "--sensor-timeout-ms",
  "--swarm",
]);

const CHOICE_BARE_FLAGS = new Set([
  "--check",
  "--dry-run",
  "--help",
  "--global",
  "--json",
  "--local",
  "--no-color",
  "--project",
  "--quiet",
  "--reset",
  "--show",
  "--verbose",
  "--yes",
]);

const DIAGNOSTIC_VALUE_FLAGS = new Set([
  "--harness",
  "--mark-done",
  "--opencode-default",
  "--plan-token",
  "--profile",
  "--project-dir",
  "--provider",
  "--region",
]);

const DIAGNOSTIC_BARE_FLAGS = new Set([
  "--check",
  "--dry-run",
  "--help",
  "--json",
  "--no-color",
  "--quiet",
  "--reset",
  "--show",
  "--verbose",
  "--yes",
]);

const MODELS_VALUE_FLAGS = new Set([
  "--agent",
  "--deciding-effort",
  "--effort",
  "--from",
  "--harness",
  "--model",
  "--plan-token",
  "--preset",
  "--project-dir",
  "--reviewing-effort",
  "--save-as",
  "--writing-up-effort",
]);

const MODELS_BARE_FLAGS = new Set([
  "--check",
  "--dry-run",
  "--help",
  "--global",
  "--json",
  "--local",
  "--no-color",
  "--project",
  "--quiet",
  "--reset",
  "--show",
  "--verbose",
  "--yes",
]);

const VALID_CONFIG_SECTIONS = new Set([
  "models",
  "runtime",
  "providers",
  "trust",
  "flags",
  "project",
]);

const ROOT_CONFIG_FLAGS = new Set([
  "--ca-bundle",
  "--dry-run",
  "--force",
  "--from",
  "--harness",
  "--help",
  "--json",
  "--mcp",
  "--no-color",
  "--offline",
  "--pin",
  "--plan-token",
  "--project-dir",
  "--quiet",
  "--release-base-url",
  "--unpin",
  "--verbose",
  "--yes",
]);

type ConfigOptionGrammar = {
  values: ReadonlySet<string>;
  bare: ReadonlySet<string>;
  repeatable?: ReadonlySet<string>;
  invalidKnownFlags?: ReadonlySet<string>;
  invalidKnownMessage?: (flag: string) => string;
};

function duplicateConfigOptionMessage(flag: string): string {
  if (flag === "--harness") {
    return "multi-harness config is not supported yet; pass one --harness <name>";
  }
  if (flag === "--agent") {
    return "one models mutation may target only one --agent";
  }
  return `${flag} may be specified only once`;
}

function validateConfigOptionGrammar(
  argv: readonly string[],
  label: string,
  grammar: ConfigOptionGrammar,
): string | null {
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      return `unexpected ${label} positional ${JSON.stringify(token)}`;
    }
    if (grammar.values.has(token)) {
      if (seen.has(token) && !grammar.repeatable?.has(token)) {
        return duplicateConfigOptionMessage(token);
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return `${token} requires a value`;
      seen.add(token);
      index++;
      continue;
    }
    if (!grammar.bare.has(token)) {
      if (
        (CONFIG_VALUE_FLAGS.has(token) || grammar.invalidKnownFlags?.has(token)) &&
        grammar.invalidKnownMessage
      ) {
        return grammar.invalidKnownMessage(token);
      }
      return `unknown ${label} option ${token}`;
    }
    if (seen.has(token)) return duplicateConfigOptionMessage(token);
    seen.add(token);
  }
  return null;
}

function validateConfigOutputMode(argv: readonly string[]): string | null {
  return argv.includes("--json") && argv.includes("--quiet")
    ? "--json and --quiet are mutually exclusive"
    : null;
}

function validateSettingsTargets(argv: readonly string[]): string | null {
  const selected = ["--local", "--project", "--global"].filter((flag) =>
    argv.includes(flag)
  );
  return selected.length > 1
    ? "pass exactly one settings target: --local, --project, or --global"
    : null;
}

function validateConfigMutationModes(
  argv: readonly string[],
  section: string,
  mutationFlags: readonly string[],
): string | null {
  const hasMutation = mutationFlags.some((flag) => argv.includes(flag));
  if (
    (argv.includes("--show") || argv.includes("--check")) &&
    (hasMutation || argv.includes("--dry-run") || argv.includes("--yes"))
  ) {
    return section === "models"
      ? "--show and --check cannot be combined with models mutations"
      : `--show and --check cannot be combined with ${section} mutations`;
  }
  if (argv.includes("--show") && argv.includes("--check")) {
    return "--show and --check are mutually exclusive";
  }
  if (argv.includes("--reset")) {
    const conflict = mutationFlags.find((flag) =>
      flag !== "--reset" && argv.includes(flag)
    );
    if (conflict) return `--reset cannot be combined with ${conflict}`;
  }
  return validateConfigOutputMode(argv);
}

function configPositionals(argv: readonly string[]): Array<{ value: string; index: number }> {
  const positionals: Array<{ value: string; index: number }> = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (CONFIG_VALUE_FLAGS.has(token)) {
      index++;
      continue;
    }
    if (!token.startsWith("--")) positionals.push({ value: token, index });
  }
  return positionals;
}

function modelHarness(value: string): ModelHarness {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "copilot" ||
    value === "cursor" ||
    value === "kiro" ||
    value === "kiro-ide" ||
    value === "opencode"
  ) {
    return value;
  }
  throw new Error(`models policy is not supported for harness ${JSON.stringify(value)}`);
}

function cloneModelPolicy(policy: ModelPolicyRecord | null): ModelPolicyRecord {
  return policy
    ? JSON.parse(JSON.stringify(policy)) as ModelPolicyRecord
    : { schemaVersion: 1 };
}

const SETTINGS_TARGET_FLAGS = [
  ["--local", "local"],
  ["--project", "project"],
  ["--global", "global"],
] as const;

function settingsProjectAvailable(projectDir: string): boolean {
  return discoverProjectHarnesses(projectDir).length > 0 ||
    [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"]
      .some((entry) => existsSync(join(projectDir, entry)));
}

function settingsTargetForMutation(
  argv: readonly string[],
  projectDir: string,
): SettingsTarget {
  const selected = SETTINGS_TARGET_FLAGS.filter(([flag]) => argv.includes(flag));
  if (selected.length > 1) {
    throw new Error("pass exactly one settings target: --local, --project, or --global");
  }
  const inProject = settingsProjectAvailable(projectDir);
  if (selected.length === 1) {
    const target = selected[0][1];
    if (!inProject && target !== "global") {
      throw new Error(
        `outside an installed project only --global is valid; machine settings live at ${
          settingsPathForTarget(projectDir, "global")
        }`,
      );
    }
    return target;
  }
  if (!inProject) return "global";
  if (!configInputIsTty()) {
    throw new Error(
      "settings mutation requires exactly one of --local, --project, or --global; use --project for team-shared repository policy",
    );
  }
  const answer = configPrompt(
    "Record settings in [project recommended/local/global]:",
  )?.trim().toLowerCase();
  if (!answer || answer === "project") return "project";
  if (answer === "local") return "local";
  if (answer === "global" || answer === "machine") return "global";
  throw new Error("settings layer selection cancelled");
}

function validateModelsArgs(argv: readonly string[]): string | null {
  const grammar = validateConfigOptionGrammar(argv, "models", {
    values: MODELS_VALUE_FLAGS,
    bare: MODELS_BARE_FLAGS,
  });
  if (grammar) return grammar;
  const mutationFlags = [
    "--agent",
    "--deciding-effort",
    "--effort",
    "--from",
    "--model",
    "--preset",
    "--reset",
    "--reviewing-effort",
    "--save-as",
    "--writing-up-effort",
  ];
  const modes = validateConfigMutationModes(argv, "models", mutationFlags) ??
    validateSettingsTargets(argv);
  if (modes) return modes;
  if (argv.includes("--preset") && argv.includes("--from")) {
    return "--preset and --from are mutually exclusive";
  }
  if (argv.includes("--save-as") && !argv.includes("--from")) {
    return "--save-as requires --from <preset|profile>";
  }
  if (argv.includes("--agent") && !argv.includes("--effort")) {
    return "--agent requires --effort <value>";
  }
  if (
    !argv.includes("--agent") &&
    (argv.includes("--effort") || argv.includes("--model"))
  ) {
    return "--effort and --model require --agent <name>";
  }
  return null;
}

function validateRootConfigArgs(argv: readonly string[]): string | null {
  const hasPin = argv.includes("--pin");
  const hasUnpin = argv.includes("--unpin");
  if (hasPin && hasUnpin) return "--pin and --unpin are mutually exclusive";

  const commonValues = ["--project-dir"];
  const commonBare = [
    "--dry-run",
    "--help",
    "--json",
    "--no-color",
    "--quiet",
    "--verbose",
    "--yes",
  ];
  const mode = hasPin ? "config --pin" : hasUnpin ? "config --unpin" : "config";
  const values = new Set(
    hasPin
      ? [
          ...commonValues,
          "--ca-bundle",
          "--from",
          "--pin",
          "--release-base-url",
        ]
      : hasUnpin
      ? commonValues
      : [
          ...commonValues,
          "--from",
          "--harness",
          "--mcp",
          "--plan-token",
        ],
  );
  const bare = new Set(
    hasPin
      ? [...commonBare, "--offline"]
      : hasUnpin
      ? [...commonBare, "--unpin"]
      : [...commonBare, "--force"],
  );
  const grammar = validateConfigOptionGrammar(argv, mode, {
    values,
    bare,
    invalidKnownFlags: ROOT_CONFIG_FLAGS,
    invalidKnownMessage: (flag) => `${flag} is not valid with ${mode}`,
  });
  if (grammar) return grammar;
  return validateConfigOutputMode(argv);
}

export function validatePublicConfigArgs(input: readonly string[]): string | null {
  const argv = stripVerb([...input]);
  const positionals = configPositionals(argv);
  const section = positionals[0];
  if (!section) return validateRootConfigArgs(argv);
  if (!VALID_CONFIG_SECTIONS.has(section.value)) {
    return `unknown config section ${JSON.stringify(section.value)}; valid sections: models, runtime, providers, trust, flags, project`;
  }
  const sectionArgv = [
    ...argv.slice(0, section.index),
    ...argv.slice(section.index + 1),
  ];
  if (section.value === "models") return validateModelsArgs(sectionArgv);
  if (
    section.value === "runtime" ||
    section.value === "providers" ||
    section.value === "trust"
  ) {
    return validateDiagnosticArgs(section.value, sectionArgv);
  }
  return validateChoiceArgs(section.value as ChoiceSection, sectionArgv);
}

function modelPolicyHelp(): string {
  const invoke = aidlcInvocation();
  const out = process.stdout;
  return [
    "Choose model and effort policy for each agent",
    "",
    heading("USAGE", out),
    `  ${cmd(`${invoke} config models [flags]`, out)}`,
    "",
    "Pins bind in both directions: a pinned agent stays pinned if the session later moves to a larger model.",
    "Judgment and Writing up inherit by default; the balanced reviewer baseline is the disclosed shipped step-down.",
    "",
    heading("POLICY", out),
    "  --preset <thorough|balanced|minimal>",
    "    balanced explicitly matches the shipped reviewing default",
    "  --from <preset|profile> [--save-as <name>]",
    "  --deciding-effort <low|medium|high|xhigh|max>",
    "  --reviewing-effort <low|medium|high|xhigh|max>",
    "  --writing-up-effort <low|medium|high|xhigh|max>",
    "  --agent <name> --effort <value> [--model <raw-id>]",
    "  --reset",
    "",
    heading("WRITE TARGET", out),
    "  --project  committed team policy (recommended in a repository)",
    "  --local    personal project policy in aidlc.settings.local.json",
    "  --global   machine policy in the install-root aidlc.settings.json",
    "Outside an installed project, --global is the only valid target and is inferred.",
    "",
    heading("INSPECTION", out),
    "  --show [--json]",
    "  --check",
    "",
    heading("MUTATION CONTROL", out),
    "  --dry-run",
    "  --yes",
    "",
    heading("EXAMPLE", out),
    `  ${cmd(`${invoke} config models --preset thorough --project --yes`, out)}`,
    "",
    dim(`Run '${invoke} config models --show' to inspect the effective result.`, out),
  ].join("\n");
}

function modelStateData(
  policy: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  projectDir: string,
  resolved: ResolvedAidlcSettings,
): {
  harness: ModelHarness;
  policy: ModelPolicyRecord | null;
  effective: Array<
    ReturnType<typeof resolveModelPolicy> & {
      modelSource: ReturnType<typeof settingsSource>;
      effortSource: ReturnType<typeof settingsSource>;
    }
  >;
  notes: string[];
} {
  const cap = resolveTierCap(join(projectDir, "aidlc", "spaces", "default", "memory"));
  const effective = Object.entries(tiers).sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([name, tier]) => {
    const item = resolveModelPolicy(policy, name, tier, harness, cap);
    const agent = resolved.models?.agents?.[name];
    const group = resolved.models?.groups?.[item.group];
    const presetGroups = resolved.models?.preset
      ? MODEL_PRESETS[resolved.models.preset as keyof typeof MODEL_PRESETS]?.groups as
        Partial<Record<ModelGroup, { effort: ModelEffort }>>
      : undefined;
    const presetGroup = presetGroups?.[item.group];
    const fallbackSource = process.env.AIDLC_TIER_CAP ? "env" : "shipped default";
    return {
      ...item,
      modelSource: agent?.model?.[harness] !== undefined
        ? settingsSource(resolved, `models.agents.${name}.model.${harness}`)
        : fallbackSource,
      effortSource: agent?.effort !== undefined
        ? settingsSource(resolved, `models.agents.${name}.effort`)
        : group?.effort !== undefined
        ? settingsSource(resolved, `models.groups.${item.group}.effort`)
        : presetGroup?.effort !== undefined
        ? settingsSource(resolved, "models.preset")
        : fallbackSource,
    };
  });
  return {
    harness,
    policy,
    effective,
    notes: harnessHonestyNotes(policy, tiers, harness, cap),
  };
}

function showModels(
  policy: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  projectDir: string,
  resolved: ResolvedAidlcSettings,
  options: ReturnType<typeof globalOptions>,
): void {
  const data = modelStateData(policy, tiers, harness, projectDir, resolved);
  if (options.mode === "json") {
    emitResult(success(`model policy for ${harness}`, data), options);
    return;
  }
  const out = process.stdout;
  let output = `${heading(`Model policy for ${harness}`, out)}\n\n`;
  output += `Preset: ${policy?.preset ?? "none (shipped defaults)"}\n\n`;
  output += `All ${data.effective.length} agents inherit your session model and effort, except:\n`;
  const grouped = new Map<string, typeof data.effective>();
  for (const item of data.effective) {
    const differs = (item.model !== undefined && item.model !== "inherit") ||
      item.effort !== undefined ||
      item.requestedModel !== undefined ||
      item.requestedEffort !== undefined;
    if (!differs) continue;
    const key = [
      item.group,
      item.model ?? "inherit",
      item.effort ?? "inherit",
      item.layer,
      item.modelSource,
      item.effortSource,
    ].join("|");
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  if (grouped.size === 0) output += "  none\n";
  for (const items of grouped.values()) {
    const item = items[0];
    const label = item.layer === "agent-exception" && items.length === 1
      ? item.agent
      : `${MODEL_GROUPS[item.group].label} (${items.length} agents)`;
    output += `  ${label}: ${item.model ?? "inherit"} / ${item.effort ?? "inherit"}\n`;
    if (item.group === "reviewing") {
      output +=
        "    Review-only agents use the measured medium baseline; raising effort trades review time and cost for deeper correctness checking.\n";
    }
    if (item.layer === "agent-exception" || item.layer === "group-dial") {
      output += `    Recorded override: ${dim(item.layer, out)}; model ${
        dim(item.modelSource, out)
      }, effort ${dim(item.effortSource, out)}.\n`;
    }
    if (item.unexpressed.length > 0) {
      output += `    Not expressible on ${harness}: ${item.unexpressed.join(", ")}.\n`;
    }
  }
  for (const note of data.notes) output += `  Note: ${note}\n`;
  const recorded = ([
    ["global", resolved.files.machine],
    ["project", resolved.files.project],
    ["local", resolved.files.local],
  ] as const).filter(([target, file]) =>
    file.present &&
    readSettingsTarget(projectDir, target)?.models !== undefined
  ).map(([, file]) => file.path);
  const displayedRecorded = recorded.map((path) => {
    const rel = relative(projectDir, path).replaceAll("\\", "/");
    return rel && !rel.startsWith("../") ? rel : path;
  });
  output += `\nRecorded in: ${
    displayedRecorded.length > 0
      ? displayedRecorded.join(", ")
      : `nothing yet - run '${aidlcInvocation()} config models --preset balanced --project --yes'`
  }\n`;
  output += `${dim(
    `Full per-agent list: ${aidlcInvocation()} config models --show --json`,
    out,
  )}\n`;
  process.stdout.write(output);
  process.exitCode = EXIT.ok;
}

function modelsPipelineArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  const keptValues = new Set(["--harness", "--plan-token", "--project-dir"]);
  const keptBare = new Set([
    "--dry-run",
    "--json",
    "--no-color",
    "--quiet",
    "--verbose",
    "--yes",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (keptValues.has(token)) {
      out.push(token, argv[++index]);
    } else if (keptBare.has(token)) {
      out.push(token);
    } else if (MODELS_VALUE_FLAGS.has(token)) {
      index++;
    }
  }
  return out;
}

function modelEffortFlag(
  argv: readonly string[],
  group: ModelGroup,
): ModelEffort | undefined {
  const flag = `--${group}-effort`;
  const value = valueAfter(argv, flag);
  if (value === undefined) return undefined;
  if (!isModelEffort(value)) {
    throw new Error(`${flag} must be one of ${MODEL_EFFORTS.join(", ")}`);
  }
  return value;
}

function applyModelsFlags(
  current: ModelPolicyRecord | null,
  argv: readonly string[],
  tiers: AgentTiers,
  profileSource: ModelPolicyRecord | null = current,
): ModelPolicyRecord | null {
  if (argv.includes("--reset")) {
    const conflicting = [
      "--agent",
      "--deciding-effort",
      "--effort",
      "--from",
      "--model",
      "--preset",
      "--reviewing-effort",
      "--save-as",
      "--writing-up-effort",
    ].find((flag) => argv.includes(flag));
    if (conflicting) throw new Error(`--reset cannot be combined with ${conflicting}`);
    return null;
  }
  const next = cloneModelPolicy(current);
  const preset = valueAfter(argv, "--preset");
  const from = valueAfter(argv, "--from");
  const saveAs = valueAfter(argv, "--save-as");
  if (preset && from) throw new Error("--preset and --from are mutually exclusive");
  if (preset) {
    if (!isModelPreset(preset)) {
      throw new Error(`--preset must be one of ${Object.keys(MODEL_PRESETS).join(", ")}`);
    }
    next.preset = preset;
    delete next.groups;
  }
  if (saveAs && !from) throw new Error("--save-as requires --from <preset|profile>");
  if (saveAs && !/^[a-z0-9][a-z0-9-]*$/.test(saveAs)) {
    throw new Error("--save-as must use lowercase letters, digits, and hyphens");
  }
  if (from) {
    const groups = profileGroups(profileSource, from);
    next.groups = groups;
    if (isModelPreset(from) && !saveAs) next.preset = from;
    else delete next.preset;
  }
  for (const group of Object.keys(MODEL_GROUPS) as ModelGroup[]) {
    const effort = modelEffortFlag(argv, group);
    if (!effort) continue;
    next.groups ??= {};
    next.groups[group] = { effort };
  }
  if (saveAs) {
    next.profiles ??= {};
    next.profiles[saveAs] = {
      groups: JSON.parse(JSON.stringify(next.groups ?? {})) as ModelProfile["groups"],
    };
  }
  const agent = valueAfter(argv, "--agent");
  const effort = valueAfter(argv, "--effort");
  const model = valueAfter(argv, "--model");
  if (agent && !(agent in tiers)) {
    throw new Error(
      `unknown agent ${JSON.stringify(agent)}; use one of ${Object.keys(tiers).sort().join(", ")}`,
    );
  }
  if (agent && !effort) throw new Error("--agent requires --effort <value>");
  if (!agent && (effort || model)) throw new Error("--effort and --model require --agent <name>");
  if (effort && !isModelEffort(effort)) {
    throw new Error(`--effort must be one of ${MODEL_EFFORTS.join(", ")}`);
  }
  if (agent && effort) {
    next.agents ??= {};
    next.agents[agent] = {
      ...(next.agents[agent] ?? {}),
      effort: effort as ModelEffort,
      ...(model ? { model } : {}),
    };
  }
  return modelPolicyIsEmpty(next) ? null : normalizeModelPolicy(next);
}

function groupPolicyEffort(
  policy: ModelPolicyRecord | null,
  group: ModelGroup,
): ModelEffort | undefined {
  return activeModelGroups(policy)[group]?.effort;
}

function effortTradeoff(group: ModelGroup, effort: ModelEffort): string {
  if (group === "reviewing" && effort === "xhigh") {
    return "Deepest review passes - built for correctness-critical work; reviews run slower and cost more.";
  }
  if (effort === "low" || effort === "medium") {
    return group === "deciding"
      ? "Faster decisions with less deliberation."
      : group === "reviewing"
      ? "Faster review passes with less deliberation."
      : "Faster plans, pipelines, and runbooks with less polish.";
  }
  return MODEL_GROUPS[group].tradeoff;
}

function modelSummaryLines(
  previous: ModelPolicyRecord | null,
  next: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  projectDir: string,
): { lines: string[]; notes: string[] } {
  const cap = resolveTierCap(join(projectDir, "aidlc", "spaces", "default", "memory"));
  const lines: string[] = [];
  for (const group of Object.keys(MODEL_GROUPS) as ModelGroup[]) {
    const beforeDial = groupPolicyEffort(previous, group);
    const afterDial = groupPolicyEffort(next, group);
    if (beforeDial === afterDial) continue;
    const names = Object.entries(tiers)
      .filter(([, tier]) => MODEL_GROUPS[group].tier === tier)
      .map(([name]) => name)
      .sort();
    const name = names[0];
    if (!name) continue;
    const tier = tiers[name];
    const before = resolveModelPolicy(previous, name, tier, harness, cap);
    const after = resolveModelPolicy(next, name, tier, harness, cap);
    if (after.unexpressed.includes("effort")) {
      lines.push(
        `  ${MODEL_GROUPS[group].label.padEnd(11)} ${names.length} agents   ` +
          `${afterDial ?? "inherit"} requested; ${harnessHonestyNotes(next, tiers, harness, cap)[0]}`,
      );
      continue;
    }
    const beforeModel = before.model ?? "inherit";
    const afterModel = after.model ?? "inherit";
    const suffix = beforeModel === afterModel ? " (model unchanged)" : "";
    lines.push(
      `  ${MODEL_GROUPS[group].label.padEnd(11)} ${names.length} agents   ` +
        `${beforeModel}/${before.effort ?? "inherit"} -> ` +
        `${afterModel}/${after.effort ?? "inherit"}${suffix}`,
    );
    if (afterDial) lines.push(`  ${effortTradeoff(group, afterDial)}`);
  }
  const notes = harnessHonestyNotes(next, tiers, harness, cap);
  return { lines, notes };
}

function modelsWizard(
  current: ModelPolicyRecord | null,
  targetCurrent: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  projectDir: string,
  resolved: ResolvedAidlcSettings,
): ModelPolicyRecord | null {
  showModels(current, tiers, harness, projectDir, resolved, {
    mode: "human",
    color: false,
    yes: false,
    offline: true,
    verbose: false,
  });
  process.stdout.write(
    "Pins bind in both directions, and shipped tiers never raise an agent above the session.\n",
  );
  const choice = configPrompt(
    "Models [Enter keep everything, 1 preset, 2 group efforts, 3 set each one myself]:",
  )?.trim();
  if (!choice) return current;
  if (choice === "1") {
    process.stdout.write(
      "Presets: thorough raises reviewing to xhigh; balanced matches the shipped reviewing default; minimal also lowers Writing up to low.\n",
    );
    const selected = configPrompt("Preset [thorough/balanced/minimal]:")?.trim() ?? "";
    if (!isModelPreset(selected)) throw new Error("preset selection cancelled");
    return applyModelsFlags(targetCurrent, ["--preset", selected], tiers, current);
  }
  if (choice === "2") {
    const args: string[] = [];
    for (const group of Object.keys(MODEL_GROUPS) as ModelGroup[]) {
      const currentValue = groupPolicyEffort(current, group) ?? "shipped";
      process.stdout.write(
        `${MODEL_GROUPS[group].label}: current ${currentValue}. ${MODEL_GROUPS[group].tradeoff}\n`,
      );
      const answer = configPrompt(
        `${MODEL_GROUPS[group].label} effort [low/medium/high/xhigh/max, Enter keep]:`,
      )?.trim();
      if (!answer) continue;
      if (!isModelEffort(answer)) throw new Error(`invalid effort ${JSON.stringify(answer)}`);
      args.push(`--${group}-effort`, answer);
    }
    return args.length > 0
      ? applyModelsFlags(targetCurrent, args, tiers, current)
      : targetCurrent;
  }
  if (choice === "3") {
    let next = targetCurrent;
    for (const name of Object.keys(tiers).sort()) {
      const currentValue = resolveModelPolicy(current, name, tiers[name], harness);
      process.stdout.write(
        `${name}: current ${currentValue.model ?? "inherit"}/${currentValue.effort ?? "inherit"}.\n`,
      );
      const effort = configPrompt(
        `${name} effort [low/medium/high/xhigh/max, Enter keep]:`,
      )?.trim();
      if (!effort) continue;
      if (!isModelEffort(effort)) throw new Error(`invalid effort ${JSON.stringify(effort)}`);
      const model = configPrompt(`${name} raw model id [Enter inherit]:`)?.trim();
      next = applyModelsFlags(
        next,
        ["--agent", name, "--effort", effort, ...(model ? ["--model", model] : [])],
        tiers,
        current,
      );
    }
    return next;
  }
  throw new Error("models selection cancelled");
}

function validateDiagnosticArgs(
  section: DiagnosticSection,
  argv: readonly string[],
): string | null {
  const sectionValues = section === "providers"
    ? new Set([
        "--harness",
        "--mark-done",
        "--opencode-default",
        "--plan-token",
        "--profile",
        "--project-dir",
        "--provider",
        "--region",
      ])
    : new Set(["--harness", "--plan-token", "--project-dir"]);
  const sectionBare = section === "runtime"
    ? new Set([...DIAGNOSTIC_BARE_FLAGS, "--record-paths"])
    : section === "providers"
    ? new Set([...DIAGNOSTIC_BARE_FLAGS, "--acknowledge"])
    : new Set([...DIAGNOSTIC_BARE_FLAGS, "--acknowledge"]);
  const grammar = validateConfigOptionGrammar(argv, section, {
    values: sectionValues,
    bare: sectionBare,
    repeatable: section === "providers"
      ? new Set(["--mark-done"])
      : undefined,
    invalidKnownMessage: (flag) => `${flag} is not valid for config ${section}`,
  });
  if (grammar) return grammar;
  const mutationFlags = section === "runtime"
    ? ["--record-paths", "--reset"]
    : section === "providers"
    ? [
        "--acknowledge",
        "--mark-done",
        "--opencode-default",
        "--profile",
        "--provider",
        "--region",
        "--reset",
      ]
    : ["--acknowledge", "--reset"];
  return validateConfigMutationModes(argv, section, mutationFlags);
}

function diagnosticHelp(section: DiagnosticSection): string {
  const invoke = aidlcInvocation();
  const out = process.stdout;
  const common = [
    heading("Inspection:", out),
    "  --show [--json]",
    "  --check",
    "",
    heading("Mutation control:", out),
    "  --reset",
    "  --dry-run",
    "  --yes",
  ];
  const specific = section === "runtime"
    ? [
        heading("Runtime answers:", out),
        "  --record-paths",
        "",
        "The probe uses the non-interactive hook PATH, not interactive shell rc files.",
        "Recorded paths are diagnostic answers only. Hook commands are not rewritten because host trust rules bind the bare command prefix.",
      ]
    : section === "providers"
    ? [
        heading("Provider answers:", out),
        "  --provider <amazon-bedrock|other>",
        "  --region <aws-region>",
        "  --profile <aws-profile>",
        "  --opencode-default <yes|no>",
        "  --acknowledge",
        "  --mark-done <pending-action-id>",
        "",
        "Credential detection is offline only. No provider or model endpoint is contacted.",
      ]
    : [
        heading("Trust answers:", out),
        "  --acknowledge",
        "",
        "Trust is read, verified, and instructed. This section never regenerates trust seeds or permission rules.",
      ];
  return [
    section === "runtime"
      ? "Check and record the non-interactive hook runtime"
      : section === "providers"
      ? "Record model-provider choices and pending manual actions"
      : "Review host trust and command allowlists",
    "",
    heading("USAGE", out),
    `  ${cmd(`${invoke} config ${section} [flags]`, out)}`,
    "",
    ...specific,
    "",
    ...common,
    "",
    heading("EXAMPLE", out),
    `  ${cmd(`${invoke} config ${section} --show`, out)}`,
    "",
    dim(
      `Run '${invoke} config ${section} --check' for a non-writing verification.`,
      out,
    ),
  ].join("\n");
}

function selectedDiagnosticHarness(
  projectDir: string,
  requested: string | undefined,
  section: DiagnosticSection | ChoiceSection,
): {
  distribution: string;
  harnessDir: string;
  root: string;
  harness: ModelHarness;
} {
  const harnesses = discoverProjectHarnesses(projectDir);
  const selected = requested
    ? harnesses.find((candidate) => candidate.distribution === requested)
    : harnesses[0];
  if (!selected) {
    throw new Error(
      requested && harnesses.length > 0
        ? `project uses ${harnesses.map((item) => item.distribution).join(", ")}; refusing ${requested}`
        : `${configCommand(section)} requires an installed project harness; run ${configCommand()} first`,
    );
  }
  if (!requested && harnesses.length > 1) {
    throw new Error("multiple project harnesses are present; pass one --harness <name>");
  }
  return {
    ...selected,
    harness: modelHarness(selected.distribution),
  };
}

function diagnosticPipelineArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  const keptValues = new Set(["--harness", "--plan-token", "--project-dir"]);
  const keptBare = new Set([
    "--dry-run",
    "--json",
    "--no-color",
    "--quiet",
    "--verbose",
    "--yes",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (keptValues.has(token)) {
      out.push(token, argv[++index]);
    } else if (keptBare.has(token)) {
      out.push(token);
    } else if (DIAGNOSTIC_VALUE_FLAGS.has(token)) {
      index++;
    }
  }
  return out;
}

function currentDiagnosticRecord(
  records: ConfigDiagnosticRecords,
  section: DiagnosticSection,
): RuntimeRecord | ProvidersRecord | TrustRecord | null {
  return records[section];
}

function diagnosticOverrides(
  section: DiagnosticSection,
  next: RuntimeRecord | ProvidersRecord | TrustRecord | null,
): ConfigDiagnosticOverrides {
  return { [section]: next };
}

function compactHumanFileList<T>(
  items: readonly T[],
  section: DiagnosticSection,
  render: (item: T) => string,
): string {
  const visible = items.length > 8 ? items.slice(0, 5) : items;
  let output = visible.map((item) => `    ${render(item)}\n`).join("");
  if (items.length > 8) {
    output +=
      `    ... and ${items.length - visible.length} more ` +
      `(aidlc config ${section} --show --json lists all)\n`;
  }
  return output;
}

function showDiagnosticSection(
  section: DiagnosticSection,
  projectDir: string,
  selected: ReturnType<typeof selectedDiagnosticHarness>,
  records: ConfigDiagnosticRecords,
  options: ReturnType<typeof globalOptions>,
): void {
  const current = currentDiagnosticRecord(records, section);
  let data: Record<string, unknown>;
  if (section === "runtime") {
    const diagnostics = probeRuntime(
      projectDir,
      selected.harnessDir,
      selected.harness,
    );
    data = {
      section,
      harness: selected.harness,
      record: current,
      diagnostics,
      issues: runtimeIssues(diagnostics),
      files: [
        join(selected.root, "tools", "data", "harness.json"),
        ...diagnostics.commandFiles,
      ],
    };
  } else if (section === "providers") {
    const record = current as ProvidersRecord | null;
    const credentials = detectAwsCredentials();
    data = {
      section,
      harness: selected.harness,
      record,
      credentials,
      pendingActions: record ? pendingProviderIssues(record) : [],
      issues: providerIssues(
        projectDir,
        selected.harnessDir,
        selected.harness,
        record,
        credentials,
      ),
      files: providerFiles(
        projectDir,
        selected.harnessDir,
        selected.harness,
        record,
      ),
    };
  } else {
    const status = trustStatus(
      projectDir,
      selected.harnessDir,
      selected.harness,
    );
    data = {
      section,
      harness: selected.harness,
      record: current,
      ...status,
    };
  }
  if (options.mode === "json") {
    emitResult(success(`${section} configuration for ${selected.harness}`, data), options);
    return;
  }
  let output = `${section[0].toUpperCase()}${section.slice(1)} configuration for ${selected.harness}\n`;
  if (section === "runtime") {
    const diagnostics = data.diagnostics as ReturnType<typeof probeRuntime>;
    output += `  Hook baseline PATH: ${diagnostics.baselinePath}\n`;
    for (const binary of diagnostics.binaries) {
      output += `  ${binary.name}: ${binary.status}`;
      if (binary.baselinePath) output += ` -> ${binary.baselinePath}`;
      if (binary.interactivePath && !binary.baselinePath) {
        output += ` -> interactive only at ${binary.interactivePath}`;
      }
      output += "\n";
    }
    output += `  Harness CLI: ${diagnostics.cli.status}`;
    if (diagnostics.cli.path) output += ` -> ${diagnostics.cli.path}`;
    output += "\n";
    output += "  Files carrying hook commands:\n";
    output += compactHumanFileList(
      diagnostics.commandFiles,
      "runtime",
      (file) => file,
    );
  } else if (section === "providers") {
    const record = data.record as ProvidersRecord | null;
    const credentials = data.credentials as ReturnType<typeof detectAwsCredentials>;
    output += `  Provider: ${record?.provider ?? "shipped fallback"}\n`;
    output += `  Region: ${record?.region ?? "shipped fallback"}\n`;
    output += `  Profile: ${record?.profile ?? "default credential chain"}\n`;
    output += `  Offline credentials: ${credentials.hasCredentials ? "found" : "not found"}\n`;
    for (const source of credentials.sources) output += `    source: ${source}\n`;
    const pending = data.pendingActions as ReturnType<typeof pendingProviderIssues>;
    for (const issue of pending) output += `  Pending: ${issue.id} - ${issue.message}\n`;
    output += "  Files carrying provider settings:\n";
    for (const entry of data.files as ReturnType<typeof providerFiles>) {
      output += `    ${entry.setting}: ${entry.file}\n`;
    }
  } else {
    const status = data as unknown as ReturnType<typeof trustStatus> & {
      record: TrustRecord | null;
    };
    output += `  Allowlist reviewed: ${status.record?.reviewed === true ? "yes" : "not recorded"}\n`;
    output += "  Trust and allowlist files:\n";
    output += compactHumanFileList(status.files, "trust", (file) => file);
    for (const issue of status.issues) output += `  Unmet: ${issue.id} - ${issue.message}\n`;
  }
  process.stdout.write(output);
  process.exitCode = EXIT.ok;
}

function checkDiagnosticSection(
  section: DiagnosticSection,
  projectDir: string,
  selected: ReturnType<typeof selectedDiagnosticHarness>,
  records: ConfigDiagnosticRecords,
  options: ReturnType<typeof globalOptions>,
): void {
  let issues: Array<{ id: string; message: string }>;
  if (section === "runtime") {
    issues = runtimeIssues(
      probeRuntime(projectDir, selected.harnessDir, selected.harness),
    );
  } else if (section === "providers") {
    issues = providerIssues(
      projectDir,
      selected.harnessDir,
      selected.harness,
      records.providers,
    );
  } else {
    issues = trustStatus(
      projectDir,
      selected.harnessDir,
      selected.harness,
    ).issues;
  }
  emitResult(
    issues.length === 0
      ? success(`${section} configuration is clean for ${selected.harness}`, {
          section,
          harness: selected.harness,
          issues: [],
        })
      : failure(
          `${section} configuration has ${issues.length} unmet item(s): ${
            issues.map((issue) => `${issue.id} (${issue.message})`).join("; ")
          }`,
          EXIT.failure,
          configCommand(`${section} --show`),
        ),
    options,
  );
}

function cloneDiagnosticRecord<T>(value: T | null): T | null {
  return value === null ? null : JSON.parse(JSON.stringify(value)) as T;
}

function runtimeRecordFromProbe(
  projectDir: string,
  selected: ReturnType<typeof selectedDiagnosticHarness>,
): RuntimeRecord {
  const diagnostics = probeRuntime(
    projectDir,
    selected.harnessDir,
    selected.harness,
  );
  const issues = runtimeIssues(diagnostics);
  if (issues.length > 0) {
    throw new Error(
      `runtime paths cannot be recorded until the non-interactive probe is clean: ${
        issues.map((issue) => issue.message).join("; ")
      }`,
    );
  }
  const bun = diagnostics.binaries.find((binary) => binary.name === "bun");
  const aidlc = diagnostics.binaries.find((binary) => binary.name === "aidlc");
  return {
    schemaVersion: 1,
    baselinePath: diagnostics.baselinePath,
    ...(bun?.baselinePath ? { bunPath: bun.baselinePath } : {}),
    ...(aidlc?.baselinePath ? { aidlcPath: aidlc.baselinePath } : {}),
    ...(diagnostics.cli.path ? { cliPath: diagnostics.cli.path } : {}),
  };
}

function providerRecordFromArgs(
  current: ProvidersRecord | null,
  argv: readonly string[],
  selected: ReturnType<typeof selectedDiagnosticHarness>,
): ProvidersRecord {
  const next = cloneDiagnosticRecord(current) ?? { schemaVersion: 1 };
  const provider = valueAfter(argv, "--provider");
  if (provider !== undefined && provider !== "amazon-bedrock" && provider !== "other") {
    throw new Error("--provider must be amazon-bedrock or other");
  }
  if (provider) next.provider = provider;
  const region = valueAfter(argv, "--region");
  const profile = valueAfter(argv, "--profile");
  if (region) next.region = region;
  if (profile) next.profile = profile;
  const opencodeDefault = valueAfter(argv, "--opencode-default");
  if (opencodeDefault !== undefined) {
    if (selected.harness !== "opencode") {
      throw new Error("--opencode-default is only valid for the opencode harness");
    }
    if (opencodeDefault !== "yes" && opencodeDefault !== "no") {
      throw new Error("--opencode-default must be yes or no");
    }
    next.opencodeDefault = opencodeDefault === "yes";
  }
  if (argv.includes("--acknowledge")) next.acknowledged = true;
  if (!next.provider) throw new Error("provider configuration requires --provider <amazon-bedrock|other>");
  if (next.provider === "amazon-bedrock" && !next.region) {
    throw new Error("Amazon Bedrock configuration requires --region <aws-region>");
  }
  if (
    next.provider === "amazon-bedrock" &&
    selected.harness === "opencode" &&
    next.opencodeDefault === undefined
  ) {
    throw new Error("OpenCode Bedrock configuration requires --opencode-default <yes|no>");
  }
  if (
    next.provider === "other" &&
    next.acknowledged !== true
  ) {
    throw new Error(
      `${selected.harness} provider setup is instruct-only; pass --acknowledge after completing the manual provider step`,
    );
  }
  let reconciled = reconcileProviderActions(
    normalizeProvidersRecord(next) as ProvidersRecord,
    selected.harness,
  );
  const done = new Set(valuesAfter(argv, "--mark-done"));
  if (done.size > 0) {
    const known = new Set((reconciled.pendingActions ?? []).map((action) => action.id));
    const unknown = [...done].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`unknown pending action(s): ${unknown.join(", ")}`);
    }
    reconciled = normalizeProvidersRecord({
      ...reconciled,
      pendingActions: (reconciled.pendingActions ?? []).map((action) =>
        done.has(action.id) ? { ...action, status: "done" } : action
      ),
    }) as ProvidersRecord;
  }
  return reconciled;
}

function diagnosticWizard(
  section: DiagnosticSection,
  projectDir: string,
  selected: ReturnType<typeof selectedDiagnosticHarness>,
  records: ConfigDiagnosticRecords,
  _options: ReturnType<typeof globalOptions>,
): RuntimeRecord | ProvidersRecord | TrustRecord | null {
  if (section === "runtime") {
    const diagnostics = probeRuntime(projectDir, selected.harnessDir, selected.harness);
    const issues = runtimeIssues(diagnostics);
    if (issues.length > 0) {
      process.stdout.write("\n  Runtime needs one manual action:\n\n");
      for (const issue of issues) {
        process.stdout.write(`    ${issue.remediation}\n`);
      }
      process.stdout.write(
        `\n  Full diagnostics: ${
          configCommandForHarness(selected.harnessDir, "runtime --show")
        }\n\n`,
      );
      return records.runtime;
    }
    const answer = promptYesDefault(
      "  Record the detected non-interactive runtime paths?",
      false,
    );
    process.stdout.write(
      answer
        ? "  Using the detected runtime paths.\n\n"
        : "  Leaving runtime paths unchanged.\n\n",
    );
    return answer ? runtimeRecordFromProbe(projectDir, selected) : records.runtime;
  }
  if (section === "providers") {
    const credentials = detectAwsCredentials();
    const detected = awsSummary(credentials);
    process.stdout.write("\n  Model provider\n");
    process.stdout.write(
      credentials.hasCredentials
        ? `  Found AWS credentials (${detected.source}); ${
            detected.regionSource === "detected" ? "detected" : "fallback"
          } region ${detected.region}.\n`
        : "  No AWS credentials were detected.\n",
    );
    process.stdout.write(`    1. amazon-bedrock   ${
      credentials.hasCredentials ? "(detected, default)" : ""
    }\n`);
    process.stdout.write("    2. other\n");
    const providerAnswer = promptChoice(
      "  Provider",
      2,
      credentials.hasCredentials ? 1 : 2,
    ) === 1
      ? "amazon-bedrock"
      : "other";
    const args = ["--provider", providerAnswer];
    const skipMarkDone = new Set<string>();
    if (providerAnswer === "amazon-bedrock") {
      const region = promptTextDefault("  AWS region", detected.region);
      const profileAnswer = promptTextDefault(
        "  AWS profile",
        "default credential chain",
      );
      const profile = profileAnswer === "default credential chain"
        ? ""
        : profileAnswer;
      args.push("--region", region);
      if (profile) args.push("--profile", profile);
      process.stdout.write(
        `  Using amazon-bedrock in ${region} with ${
          profile || "the default credential chain"
        }.\n\n`,
      );
      if (selected.harness === "opencode") {
        const offer = promptYesDefault(
          "  Write amazon-bedrock provider options to opencode.json?",
          false,
        );
        args.push("--opencode-default", offer ? "yes" : "no");
      }
      if (selected.harness === "copilot" || selected.harness === "cursor") {
        process.stdout.write(
          selected.harness === "copilot"
            ? "Configure Copilot BYOK provider variables before acknowledging this step.\n"
            : "Configure the provider and select the model in Cursor before acknowledging this step.\n",
        );
        const acknowledged = promptYesDefault(
          "  Manual provider setup complete?",
          false,
        );
        if (acknowledged) {
          args.push("--acknowledge");
        } else {
          const action = selected.harness === "copilot"
            ? "copilot-byok-configuration"
            : "cursor-provider-configuration";
          skipMarkDone.add(action);
          process.stdout.write(
            `  ${action} remains pending. Complete it with --acknowledge or --mark-done ${action}.\n`,
          );
        }
      }
    } else {
      process.stdout.write("  Using other provider setup.\n");
      const acknowledged = promptYesDefault(
        "  Manual provider setup complete?",
        false,
      );
      if (acknowledged) {
        args.push("--acknowledge");
      } else {
        process.stdout.write(
          "  Provider setup remains pending; no provider answer was recorded.\n\n",
        );
        return records.providers;
      }
    }
    let next = providerRecordFromArgs(records.providers, args, selected);
    for (const action of next.pendingActions ?? []) {
      if (action.status === "done") continue;
      if (skipMarkDone.has(action.id)) continue;
      const answer = promptYesDefault(
        `  Mark ${action.id} done now?`,
        false,
      );
      if (answer) {
        next = providerRecordFromArgs(
          next,
          ["--mark-done", action.id],
          selected,
        );
      }
    }
    return next;
  }
  const answer = promptYesDefault(
    "  Record that you reviewed the trust and allowlist files?",
    false,
  );
  process.stdout.write(
    answer
      ? "  Trust review acknowledged.\n\n"
      : "  Leaving trust acknowledgement unchanged.\n\n",
  );
  return answer
    ? { schemaVersion: 1, reviewed: true }
    : records.trust;
}

function diagnosticSummary(
  section: DiagnosticSection,
  next: RuntimeRecord | ProvidersRecord | TrustRecord | null,
): { lines: string[]; notes: string[] } {
  if (section === "runtime") {
    return {
      lines: [
        next
          ? "  Runtime      recorded non-interactive executable paths in harness.json"
          : "  Runtime      reset to live detection",
      ],
      notes: [
        "Hook command strings were not rewritten because host allowlists and Codex trust hashes bind the bare command prefix.",
      ],
    };
  }
  if (section === "providers") {
    const record = next as ProvidersRecord | null;
    return {
      lines: [
        record
          ? `  Providers    ${record.provider} region=${record.region ?? "manual"} profile=${
              record.profile ?? "default-chain"
            }`
          : "  Providers    reset to shipped fallback bytes",
      ],
      notes: record
        ? pendingProviderIssues(record).map((issue) => `${issue.id}: ${issue.message}`)
        : [],
    };
  }
  return {
    lines: [
      next
        ? "  Trust        recorded allowlist review acknowledgement"
        : "  Trust        reset recorded acknowledgement",
    ],
    notes: ["Trust seeds and permission rules were not regenerated or modified."],
  };
}

function configCompletionMessage(
  base: string,
  actions: readonly ConfigOutstandingAction[],
  mode: "human" | "quiet" | "json",
): string {
  if (actions.length === 0 || mode === "json") return base;
  if (mode === "quiet") {
    const commands = [...new Set(actions.map((action) => action.command))];
    return `${base}\nOutstanding actions: ${commands.join("; ")}`;
  }
  return [
    base,
    "Outstanding actions:",
    ...actions.map((action) =>
      `  ${action.section}/${action.id}: ${action.message} - run \`${action.command}\``
    ),
  ].join("\n");
}

// Test-only interactivity seam. It is read at call time so one test process can
// exercise TTY and non-TTY branches with piped answers. Production behavior is
// unchanged unless the explicitly test-named variable is set.
function configInputIsTty(): boolean {
  return Boolean(
    process.stdin.isTTY ||
    process.env.AIDLC_TEST_CONFIG_TTY === "1",
  );
}

function configCommand(args = ""): string {
  return `${aidlcInvocation()} config${args ? ` ${args}` : ""}`;
}

function commandToken(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

function configMutationRerun(
  section: "models" | "runtime" | "providers" | "trust" | "flags" | "project",
  argv: readonly string[],
): string {
  const args = argv.filter((arg) => arg !== "--yes").map(commandToken);
  return configCommand([section, ...args, "--yes"].join(" "));
}

function configCommandForHarness(harnessDir: string, args = ""): string {
  const invoke = aidlcInvocation() === "aidlc"
    ? "aidlc"
    : `bun ${harnessDir}/tools/aidlc.ts`;
  return `${invoke} config${args ? ` ${args}` : ""}`;
}

let scriptedPromptAnswers: string[] | null = null;

function configPrompt(label: string): string | null {
  if (
    process.env.AIDLC_TEST_CONFIG_TTY === "1" &&
    !process.stdin.isTTY
  ) {
    if (scriptedPromptAnswers === null) {
      const scripted = process.env.AIDLC_TEST_CONFIG_INPUT ??
        readFileSync(0, "utf-8");
      scriptedPromptAnswers = scripted.split(/\r?\n/);
      if (scriptedPromptAnswers.at(-1) === "") scriptedPromptAnswers.pop();
    }
    process.stdout.write(`${label} `);
    return scriptedPromptAnswers.shift() ?? null;
  }
  return prompt(label);
}

type SetupMapRow = {
  label: string;
  detail: string;
  section?: SetupWalkSection;
  needs: boolean;
};

function setupMapRows(
  projectDir: string,
  harnessDir: string,
  distribution: string,
  outstanding: readonly ConfigOutstandingAction[],
): SetupMapRow[] {
  const root = join(projectDir, harnessDir);
  const records = readConfigDiagnosticRecords(root);
  const resolved = resolveAidlcSettings(projectDir);
  const policy = modelPolicyForHarness(
    resolved.models,
    modelHarness(distribution),
  );
  const runtime = outstanding.filter((action) => action.section === "runtime");
  const trust = outstanding.filter((action) => action.section === "trust");
  const providers = outstanding.filter((action) => action.section === "providers");
  const providerNeeds = records.providers === null || providers.length > 0;
  const modelDetail = !policy || modelPolicyIsEmpty(policy)
    ? "shipped defaults"
    : policy.preset
    ? `preset ${policy.preset}`
    : "recorded project policy";
  const flagDetail = resolved.flags
    ? `scope ${resolved.flags.defaultScope ?? "inherit"}, swarm ${
        resolved.flags.swarm === undefined ? "inherit" : resolved.flags.swarm ? "on" : "off"
      }`
    : "defaults";
  const plugins = readPluginSelection(root);
  const pluginDetail = plugins === null
    ? "all installed"
    : plugins.length > 0
    ? plugins.join(",")
    : "none";
  const projectDetail =
    `plugins: ${pluginDetail}, MCP: ${records.project?.mcp ?? "none"}, ` +
    `completions: ${records.project?.completions ?? "none"}`;
  const trustDetail = trust.length > 0
    ? `${trust.length} host trust issue${trust.length === 1 ? "" : "s"}`
    :
    (records.trust?.reviewed ? "review acknowledged" : "no unmet host trust");
  const providerDetail = records.providers === null
    ? "no recorded answers; provider access unverified"
    : providers.length > 0
    ? `${providers.length} pending provider action${providers.length === 1 ? "" : "s"}`
    :
      `${records.providers.provider ?? "shipped fallback"}; no pending actions`;
  return [
    {
      label: "Harnesses",
      detail: `${distribution} recorded`,
      needs: false,
    },
    {
      label: "Models",
      detail: modelDetail,
      needs: false,
    },
    {
      label: "Runtime",
      detail: runtime.length > 0
        ? runtime[0].message
        : "hook PATH ready",
      section: "runtime",
      needs: runtime.length > 0,
    },
    {
      label: "Flags",
      detail: flagDetail,
      needs: false,
    },
    {
      label: "Project",
      detail: projectDetail,
      needs: false,
    },
    {
      label: "Providers",
      detail: providerDetail,
      section: "providers",
      needs: providerNeeds,
    },
    {
      label: "Trust",
      detail: trustDetail,
      section: "trust",
      needs: trust.length > 0,
    },
  ];
}

function renderSetupMap(rows: readonly SetupMapRow[]): SetupWalkSection[] {
  const needed = rows.filter((row) => row.needs);
  process.stdout.write(
    `\n  Setup check - ${needed.length} of ${rows.length} sections need you.\n\n`,
  );
  for (const row of rows) {
    const state = row.needs ? "[needs]" : "[ok]";
    const renderedState = row.needs
      ? warnVerdict(state.padEnd(7), process.stdout)
      : state.padEnd(7);
    process.stdout.write(
      `    ${renderedState}  ${row.label.padEnd(11)} ${row.detail}\n`,
    );
  }
  const order: SetupWalkSection[] = ["runtime", "providers", "trust"];
  const flagged = new Set(
    needed.map((row) => row.section).filter(
      (section): section is SetupWalkSection => section !== undefined,
    ),
  );
  return order.filter((section) => flagged.has(section));
}

function renderSetupLedger(
  actions: readonly ConfigOutstandingAction[],
): void {
  process.stdout.write(
    `\n  Setup complete. ${actions.length} action${
      actions.length === 1 ? "" : "s"
    } still need${actions.length === 1 ? "s" : ""} you\n`,
  );
  for (const action of actions) {
    process.stdout.write(
      `    ${action.section.padEnd(12)} ${action.command}\n`,
    );
  }
}

function setupLedgerActions(
  projectDir: string,
  harnessDir: string,
  actions: readonly ConfigOutstandingAction[],
): ConfigOutstandingAction[] {
  const next = [...actions];
  if (next.some((action) => action.section === "providers")) return next;
  try {
    const record = readConfigDiagnosticRecords(
      join(projectDir, harnessDir),
    ).providers;
    if (record === null) {
      next.push({
        section: "providers",
        id: "provider-record-missing",
        message: "Choose and configure a model provider, then record the completed setup.",
        command: configCommandForHarness(harnessDir, "providers"),
      });
    }
  } catch {
    // The shared outstanding-action collector already reports unreadable data.
  }
  return next;
}

async function runSetupWalk(
  projectDir: string,
  harnessDir: string,
  distribution: string,
  initialOutstanding: readonly ConfigOutstandingAction[],
): Promise<void> {
  const initialLedger = setupLedgerActions(
    projectDir,
    harnessDir,
    initialOutstanding,
  );
  const flagged = renderSetupMap(
    setupMapRows(
      projectDir,
      harnessDir,
      distribution,
      initialOutstanding,
    ),
  );
  if (flagged.length === 0) {
    if (initialLedger.length > 0) {
      renderSetupLedger(initialLedger);
    }
    return;
  }
  const answer = promptYesDefault(
    `\n  Fix the ${flagged.length} sections that need you now?`,
    true,
  );
  if (!answer) {
    renderSetupLedger(initialLedger);
    return;
  }
  for (const section of flagged) {
    await main(
      [
        "config",
        section,
        "--project-dir",
        projectDir,
        "--harness",
        distribution,
        "--yes",
      ],
      {
        setupWalkChild: true,
      },
    );
    if ((process.exitCode ?? EXIT.ok) !== EXIT.ok) {
      process.stdout.write(
        `\n  Setup stopped while configuring ${section}. Completed answers remain recorded; rerun ${
          configCommandForHarness(harnessDir)
        } to continue.\n`,
      );
      return;
    }
  }
  const remaining = setupLedgerActions(
    projectDir,
    harnessDir,
    postApplyOutstandingActions(
      projectDir,
      harnessDir,
      modelHarness(distribution),
    ),
  );
  renderSetupLedger(remaining);
}

function prepareDiagnosticSection(
  section: DiagnosticSection,
  argv: string[],
  options: ReturnType<typeof globalOptions>,
): { argv: string[]; context: DiagnosticsMutationContext } | null {
  const validation = validateDiagnosticArgs(section, argv);
  if (validation) {
    emitResult(usage(validation, configCommand(`${section} --help`)), options);
    return null;
  }
  if (argv.includes("--help")) {
    process.stdout.write(`${diagnosticHelp(section)}\n`);
    process.exitCode = EXIT.ok;
    return null;
  }
  const mutationFlags = section === "runtime"
    ? ["--record-paths", "--reset"]
    : section === "providers"
    ? [
        "--acknowledge",
        "--mark-done",
        "--opencode-default",
        "--profile",
        "--provider",
        "--region",
        "--reset",
      ]
    : ["--acknowledge", "--reset"];
  const hasMutationFlags = mutationFlags.some((flag) => argv.includes(flag));
  if (
    (argv.includes("--show") || argv.includes("--check")) &&
    (hasMutationFlags || argv.includes("--dry-run") || argv.includes("--yes"))
  ) {
    emitResult(
      usage(`--show and --check cannot be combined with ${section} mutations`),
      options,
    );
    return null;
  }
  if (argv.includes("--show") && argv.includes("--check")) {
    emitResult(usage("--show and --check are mutually exclusive"), options);
    return null;
  }
  const projectDir = projectDirFrom(argv);
  const selected = selectedDiagnosticHarness(
    projectDir,
    valueAfter(argv, "--harness"),
    section,
  );
  const records = readConfigDiagnosticRecords(selected.root);
  if (argv.includes("--show")) {
    showDiagnosticSection(section, projectDir, selected, records, options);
    return null;
  }
  if (argv.includes("--check")) {
    checkDiagnosticSection(section, projectDir, selected, records, options);
    return null;
  }
  let next: RuntimeRecord | ProvidersRecord | TrustRecord | null;
  if (argv.includes("--reset")) {
    const conflicting = mutationFlags.find((flag) => flag !== "--reset" && argv.includes(flag));
    if (conflicting) throw new Error(`--reset cannot be combined with ${conflicting}`);
    next = null;
  } else if (hasMutationFlags) {
    if (section === "runtime") {
      next = runtimeRecordFromProbe(projectDir, selected);
    } else if (section === "providers") {
      next = providerRecordFromArgs(records.providers, argv, selected);
    } else {
      next = { schemaVersion: 1, reviewed: true };
    }
  } else {
    if (!configInputIsTty()) {
      const flags = section === "runtime"
        ? "--show, --check, --record-paths, or --reset"
        : section === "providers"
        ? "--show, --check, --provider with its required answers, --mark-done, or --reset"
        : "--show, --check, --acknowledge, or --reset";
      emitResult(
        usage(
          `non-interactive ${section} configuration requires ${flags}; --yes confirms but never chooses`,
          configCommand(`${section} --help`),
        ),
        options,
      );
      return null;
    }
    next = diagnosticWizard(section, projectDir, selected, records, options);
  }
  const previous = currentDiagnosticRecord(records, section);
  if (canonical(previous) === canonical(next)) {
    emitResult(success(`${section} configuration unchanged`), options);
    return null;
  }
  if (!argv.includes("--dry-run") && !options.yes) {
    if (!configInputIsTty()) {
      emitResult(
        usage(
          `non-interactive ${section} mutation requires --yes; --yes confirms but never chooses`,
          configMutationRerun(section, argv),
        ),
        options,
      );
      return null;
    }
    const answer = configPrompt(`Apply ${section} configuration changes? [y/N]:`);
    if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
      emitResult(usage(`${section} configuration change cancelled`), options);
      return null;
    }
  }
  const summary = diagnosticSummary(section, next);
  return {
    argv: diagnosticPipelineArgv(argv),
    context: {
      section,
      harness: selected.harness,
      harnessDir: selected.harnessDir,
      previous,
      next,
      overrides: diagnosticOverrides(section, next),
      summaryLines: summary.lines,
      notes: summary.notes,
    },
  };
}

function validateChoiceArgs(
  section: ChoiceSection,
  argv: readonly string[],
): string | null {
  const values = section === "flags"
    ? new Set([
        "--bypass",
        "--clear-bypass",
        "--default-scope",
        "--harness",
        "--hook-debug",
        "--plan-token",
        "--project-dir",
        "--sensor-timeout-ms",
        "--swarm",
      ])
    : new Set([
        "--completions",
        "--harness",
        "--mcp",
        "--plan-token",
        "--plugins",
        "--project-dir",
      ]);
  const bare = section === "flags"
    ? CHOICE_BARE_FLAGS
    : new Set(
        [...CHOICE_BARE_FLAGS].filter((flag) =>
          flag !== "--local" && flag !== "--project" && flag !== "--global"
        ),
      );
  const grammar = validateConfigOptionGrammar(argv, section, {
    values,
    bare,
    repeatable: section === "flags"
      ? new Set(["--bypass", "--clear-bypass"])
      : undefined,
    invalidKnownMessage: (flag) => `${flag} is not valid for config ${section}`,
  });
  if (grammar) return grammar;
  const mutationFlags = section === "flags"
    ? [
        "--bypass",
        "--clear-bypass",
        "--default-scope",
        "--hook-debug",
        "--reset",
        "--sensor-timeout-ms",
        "--swarm",
      ]
    : ["--completions", "--mcp", "--plugins", "--reset"];
  return validateConfigMutationModes(argv, section, mutationFlags) ??
    (section === "flags" ? validateSettingsTargets(argv) : null);
}

function choiceHelp(section: ChoiceSection): string {
  const invoke = aidlcInvocation();
  const out = process.stdout;
  const specific = section === "flags"
    ? [
        heading("Recorded flags:", out),
        "  --default-scope <installed-scope>",
        "  --swarm <on|off>",
        "  --hook-debug <on|off>",
        "  --sensor-timeout-ms <positive-integer>",
        "  --bypass <AIDLC_SKIP_*|AIDLC_DISABLE_*>",
        "  --clear-bypass <AIDLC_SKIP_*|AIDLC_DISABLE_*>",
        "",
        "Environment variables always override recorded answers.",
        "Bypasses weaken deterministic guards and are accepted only through explicit --bypass flags.",
        "",
        heading("Write target (required for mutations):", out),
        "  --project  committed team policy (recommended in a repository)",
        "  --local    personal project policy in aidlc.settings.local.json",
        "  --global   machine policy in the install-root aidlc.settings.json",
        "Outside an installed project, --global is the only valid target and is inferred.",
      ]
    : [
        heading("Project choices:", out),
        "  --plugins <comma-separated-installed-names|all>",
        "  --mcp <defaults|none>",
        "  --completions <bash|zsh|fish|powershell|none>",
        "",
        "--yes confirms but never implies MCP consent. Without an explicit answer, MCP consent records none.",
      ];
  return [
    section === "flags"
      ? "Record project defaults and explicit guard bypasses"
      : "Choose plugins, MCP servers, and shell completions",
    "",
    heading("USAGE", out),
    `  ${cmd(`${invoke} config ${section} [flags]`, out)}`,
    "",
    ...specific,
    "",
    heading("INSPECTION", out),
    "  --show [--json]",
    "  --check",
    "",
    heading("MUTATION CONTROL", out),
    "  --reset",
    "  --dry-run",
    "  --yes",
    "",
    heading("EXAMPLE", out),
    `  ${cmd(`${invoke} config ${section} --show`, out)}`,
    "",
    dim(
      `Run '${invoke} config ${section} --check' for a non-writing verification.`,
      out,
    ),
  ].join("\n");
}

function choicePipelineArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  const keptValues = new Set(["--harness", "--plan-token", "--project-dir"]);
  const keptBare = new Set([
    "--dry-run",
    "--json",
    "--no-color",
    "--quiet",
    "--verbose",
    "--yes",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (keptValues.has(token)) {
      out.push(token, argv[++index]);
    } else if (keptBare.has(token)) {
      out.push(token);
    } else if (CHOICE_VALUE_FLAGS.has(token)) {
      index++;
    }
  }
  return out;
}

function parseOnOff(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== "on" && value !== "off") {
    throw new Error(`${flag} must be on or off`);
  }
  return value === "on";
}

function buildFlagsRecord(
  current: ProjectFlagsRecord | null,
  argv: readonly string[],
  harnessRoot: string,
): ProjectFlagsRecord {
  const next: ProjectFlagsRecord = cloneDiagnosticRecord(current) ?? {
    schemaVersion: 1,
  };
  const defaultScope = valueAfter(argv, "--default-scope");
  if (defaultScope) {
    const scopes = availableScopeNames(harnessRoot);
    if (!scopes.includes(defaultScope)) {
      throw new Error(
        `--default-scope must be one of the installed scopes: ${scopes.join(", ")}`,
      );
    }
    next.defaultScope = defaultScope;
  }
  const swarm = parseOnOff(valueAfter(argv, "--swarm"), "--swarm");
  if (swarm !== undefined) next.swarm = swarm;
  const hookDebug = parseOnOff(valueAfter(argv, "--hook-debug"), "--hook-debug");
  if (hookDebug !== undefined) next.hookDebug = hookDebug;
  const timeout = valueAfter(argv, "--sensor-timeout-ms");
  if (timeout !== undefined) {
    const parsed = Number(timeout);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("--sensor-timeout-ms must be a positive integer");
    }
    next.sensorTimeoutMs = parsed;
  }
  const bypasses = new Set(next.bypasses ?? []);
  for (const name of valuesAfter(argv, "--bypass")) {
    if (!(RECORDABLE_PROJECT_BYPASSES as readonly string[]).includes(name)) {
      throw new Error(
        `--bypass must be one of ${RECORDABLE_PROJECT_BYPASSES.join(", ")}`,
      );
    }
    bypasses.add(name as (typeof RECORDABLE_PROJECT_BYPASSES)[number]);
  }
  for (const name of valuesAfter(argv, "--clear-bypass")) {
    if (!(RECORDABLE_PROJECT_BYPASSES as readonly string[]).includes(name)) {
      throw new Error(
        `--clear-bypass must be one of ${RECORDABLE_PROJECT_BYPASSES.join(", ")}`,
      );
    }
    bypasses.delete(name as (typeof RECORDABLE_PROJECT_BYPASSES)[number]);
  }
  if (bypasses.size > 0) next.bypasses = [...bypasses].sort();
  else delete next.bypasses;
  return normalizeProjectFlagsRecord(next) as ProjectFlagsRecord;
}

function parsePluginAnswer(
  value: string | undefined,
  known: readonly string[],
  current: string[] | null,
): string[] | null {
  if (value === undefined) return current;
  if (value === "all") return null;
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))]
    .sort();
  if (names.length === 0) throw new Error("--plugins requires at least one name or all");
  const knownSet = new Set(known);
  const unknown = names.filter((name) => !knownSet.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `unknown plugin name(s): ${unknown.join(", ")}; installed plugins: ${known.join(", ")}`,
    );
  }
  return names;
}

function buildProjectRecord(
  current: ProjectChoicesRecord | null,
  currentPlugins: string[] | null,
  argv: readonly string[],
  selected: ReturnType<typeof selectedDiagnosticHarness>,
): {
  record: ProjectChoicesRecord;
  plugins: string[] | null;
} {
  const next: ProjectChoicesRecord = cloneDiagnosticRecord(current) ?? {
    schemaVersion: 1,
  };
  const mcp = valueAfter(argv, "--mcp");
  if (mcp !== undefined && mcp !== "defaults" && mcp !== "none") {
    throw new Error("--mcp must be defaults or none");
  }
  next.mcp = (mcp as "defaults" | "none" | undefined) ?? next.mcp ?? "none";
  const completions = valueAfter(argv, "--completions");
  if (
    completions !== undefined &&
    !["bash", "zsh", "fish", "powershell", "none"].includes(completions)
  ) {
    throw new Error(
      "--completions must be bash, zsh, fish, powershell, or none",
    );
  }
  if (completions) next.completions = completions as CompletionShell;
  const known = discoverInstalledPluginNames(
    dirname(selected.root),
    selected.harnessDir,
  );
  const plugins = parsePluginAnswer(
    valueAfter(argv, "--plugins"),
    known,
    currentPlugins,
  );
  return {
    record: normalizeProjectChoicesRecord(next) as ProjectChoicesRecord,
    plugins,
  };
}

function showChoiceSection(
  section: ChoiceSection,
  projectDir: string,
  selected: ReturnType<typeof selectedDiagnosticHarness>,
  records: ConfigDiagnosticRecords,
  resolved: ResolvedAidlcSettings,
  options: ReturnType<typeof globalOptions>,
): void {
  const plugins = readPluginSelection(selected.root);
  let data: Record<string, unknown>;
  if (section === "flags") {
    const effective = effectiveProjectFlagValues(resolved.flags);
    const sources = Object.fromEntries([
      ["AWS_AIDLC_DEFAULT_SCOPE", "defaultScope"],
      ["AIDLC_USE_SWARM", "swarm"],
      ["AIDLC_HOOK_DEBUG", "hookDebug"],
      ["AIDLC_SENSOR_TIMEOUT_MS", "sensorTimeoutMs"],
    ].map(([envName, field]) => [
      envName,
      Object.hasOwn(process.env, envName)
        ? "env"
        : settingsSource(resolved, `flags.${field}`),
    ]));
    for (const bypass of RECORDABLE_PROJECT_BYPASSES) {
      sources[bypass] = Object.hasOwn(process.env, bypass)
        ? "env"
        : settingsSource(resolved, "flags.bypasses");
    }
    data = {
      section,
      harness: selected.harness,
      record: resolved.flags,
      effective,
      sources,
      issues: flagIssues(
        projectDir,
        selected.harnessDir,
        selected.harness,
        resolved.flags,
      ),
      files: flagFiles(
        projectDir,
        selected.harnessDir,
        selected.harness,
        resolved.flags,
        resolved,
      ),
    };
  } else {
    const completion = records.project?.completions;
    data = {
      section,
      harness: selected.harness,
      record: records.project,
      plugins,
      installedPlugins: discoverInstalledPluginNames(
        projectDir,
        selected.harnessDir,
      ),
      completionInstruction:
        completion && completion !== "none"
          ? completionInstruction(projectDir, selected.harnessDir, completion)
          : null,
      issues: projectChoiceIssues(
        projectDir,
        selected.harnessDir,
        selected.harness,
        records.project,
        plugins,
      ),
      files: projectChoiceFiles(
        projectDir,
        selected.harnessDir,
        selected.harness,
      ),
      mcpNote: projectMcpNote(
        projectDir,
        selected.harnessDir,
        selected.harness,
        records.project,
      ),
    };
  }
  if (options.mode === "json") {
    emitResult(success(`${section} configuration for ${selected.harness}`, data), options);
    return;
  }
  const out = process.stdout;
  let output = `${heading(
    `${section[0].toUpperCase()}${section.slice(1)} configuration for ${selected.harness}`,
    out,
  )}\n`;
  if (section === "flags") {
    const sources = data.sources as Record<string, string>;
    const effective = data.effective as Record<string, string | undefined>;
    const sourceLabel = (name: string): string =>
      dim(`[${sources[name]}]`, out);
    const effectiveBoolean = (
      envName: string,
      recorded: boolean | undefined,
    ): string => {
      if (sources[envName] !== "env") {
        return recorded === undefined ? "inherit" : recorded ? "on" : "off";
      }
      const value = effective[envName]?.trim().toLowerCase();
      return value === undefined
        ? "inherit"
        : ["", "0", "false", "no", "off"].includes(value)
        ? "off"
        : "on";
    };
    output += `  Default scope: ${
      sources.AWS_AIDLC_DEFAULT_SCOPE === "env"
        ? effective.AWS_AIDLC_DEFAULT_SCOPE ?? "inherit"
        : resolved.flags?.defaultScope ?? "inherit"
    } ${sourceLabel("AWS_AIDLC_DEFAULT_SCOPE")}\n`;
    output += `  Swarm: ${
      effectiveBoolean("AIDLC_USE_SWARM", resolved.flags?.swarm)
    } ${sourceLabel("AIDLC_USE_SWARM")}\n`;
    output += `  Hook debug: ${
      effectiveBoolean("AIDLC_HOOK_DEBUG", resolved.flags?.hookDebug)
    } ${sourceLabel("AIDLC_HOOK_DEBUG")}\n`;
    output += `  Sensor timeout: ${
      sources.AIDLC_SENSOR_TIMEOUT_MS === "env"
        ? effective.AIDLC_SENSOR_TIMEOUT_MS ?? "inherit"
        : resolved.flags?.sensorTimeoutMs ?? "inherit"
    } ${sourceLabel("AIDLC_SENSOR_TIMEOUT_MS")}\n`;
    for (const bypass of resolved.flags?.bypasses ?? []) {
      output += `  Bypass enabled: ${bypass} ${sourceLabel(bypass)}\n`;
    }
    const files = data.files as ReturnType<typeof flagFiles>;
    if (files.length === 0) {
      output += "  Files carrying flags: none\n";
    } else {
      output += "  Files carrying flags:\n";
      for (const entry of files) {
        output += `    ${dim(entry.setting, out)}: ${entry.file}\n`;
      }
    }
    for (const issue of data.issues as ReturnType<typeof flagIssues>) {
      output += `  Override: ${issue.message}\n`;
    }
  } else {
    output += `  Plugins: ${plugins === null ? "all installed" : plugins.join(", ")}\n`;
    output += `  MCP consent: ${records.project?.mcp ?? "inherit"}\n`;
    if (data.mcpNote) output += `  MCP note: ${data.mcpNote}\n`;
    output += `  Completions: ${records.project?.completions ?? "not offered"}\n`;
    if (data.completionInstruction) {
      output += `  Install completions with: ${data.completionInstruction}\n`;
    }
    output += "  Files carrying project choices:\n";
    for (const entry of data.files as ReturnType<typeof projectChoiceFiles>) {
      output += `    ${dim(entry.setting, out)}: ${entry.file}\n`;
    }
  }
  process.stdout.write(output);
  process.exitCode = EXIT.ok;
}

function checkChoiceSection(
  section: ChoiceSection,
  projectDir: string,
  selected: ReturnType<typeof selectedDiagnosticHarness>,
  records: ConfigDiagnosticRecords,
  resolved: ResolvedAidlcSettings,
  options: ReturnType<typeof globalOptions>,
): void {
  const plugins = readPluginSelection(selected.root);
  const issues = section === "flags"
    ? flagIssues(
        projectDir,
        selected.harnessDir,
        selected.harness,
        resolved.flags,
      )
    : projectChoiceIssues(
        projectDir,
        selected.harnessDir,
        selected.harness,
        records.project,
        plugins,
      );
  emitResult(
    issues.length === 0
      ? success(`${section} configuration is clean for ${selected.harness}`, {
          section,
          harness: selected.harness,
          issues: [],
        })
      : failure(
          `${section} configuration has ${issues.length} unmet item(s): ${
            issues.map((issue) => `${issue.id} (${issue.message})`).join("; ")
          }`,
          EXIT.failure,
          configCommand(`${section} --show`),
        ),
    options,
  );
}

function choiceWizard(
  section: ChoiceSection,
  projectDir: string,
  selected: ReturnType<typeof selectedDiagnosticHarness>,
  records: ConfigDiagnosticRecords,
  resolved: ResolvedAidlcSettings,
  targetCurrentFlags: ProjectFlagsRecord | null,
  options: ReturnType<typeof globalOptions>,
): {
  next: ProjectFlagsRecord | ProjectChoicesRecord;
  plugins: string[] | null;
} {
  showChoiceSection(section, projectDir, selected, records, resolved, {
    ...options,
    mode: "human",
  });
  if (section === "flags") {
    const args: string[] = [];
    const scopes = availableScopeNames(selected.root);
    const scope = configPrompt(
      `Default scope [${scopes.join("/")}, Enter keep]:`,
    )?.trim();
    if (scope) args.push("--default-scope", scope);
    for (const [flag, label] of [
      ["--swarm", "Swarm"],
      ["--hook-debug", "Hook debug"],
    ] as const) {
      const answer = configPrompt(`${label} [on/off, Enter keep]:`)?.trim();
      if (answer) args.push(flag, answer);
    }
    const timeout = configPrompt("Sensor timeout ms [Enter keep]:")?.trim();
    if (timeout) args.push("--sensor-timeout-ms", timeout);
    return {
      next: buildFlagsRecord(targetCurrentFlags, args, selected.root),
      plugins: readPluginSelection(selected.root),
    };
  }
  const known = discoverInstalledPluginNames(projectDir, selected.harnessDir);
  const currentPlugins = readPluginSelection(selected.root);
  const args: string[] = [];
  const pluginAnswer = configPrompt(
    `Enabled plugins [${known.join(",")}; all; Enter keep]:`,
  )?.trim();
  if (pluginAnswer) args.push("--plugins", pluginAnswer);
  const currentMcp = records.project?.mcp ?? "none";
  const mcp = configPrompt(`MCP consent [defaults/none, Enter ${currentMcp}]:`)?.trim();
  if (mcp) args.push("--mcp", mcp);
  const completions = configPrompt(
    "Completions [bash/zsh/fish/powershell/none, Enter keep]:",
  )?.trim();
  if (completions) args.push("--completions", completions);
  const built = buildProjectRecord(records.project, currentPlugins, args, selected);
  return { next: built.record, plugins: built.plugins };
}

function choiceSummary(
  section: ChoiceSection,
  next: ProjectFlagsRecord | ProjectChoicesRecord | null,
  plugins: string[] | null,
  projectDir: string,
  harnessDir: string,
): { lines: string[]; notes: string[] } {
  if (section === "flags") {
    const record = next as ProjectFlagsRecord | null;
    return {
      lines: [
        record
          ? `  Flags        default-scope=${record.defaultScope ?? "inherit"} swarm=${
              record.swarm === undefined ? "inherit" : record.swarm ? "on" : "off"
            }`
          : "  Flags        reset to environment and shipped defaults",
      ],
      notes: (record?.bypasses ?? []).map((name) =>
        `${name} weakens a deterministic guard and is enabled only by explicit opt-in.`
      ),
    };
  }
  const record = next as ProjectChoicesRecord | null;
  const notes: string[] = [];
  if (record?.completions && record.completions !== "none") {
    notes.push(
      `Install completions with: ${
        completionInstruction(projectDir, harnessDir, record.completions)
      }`,
    );
  }
  return {
    lines: [
      record
        ? `  Project      plugins=${plugins === null ? "all" : plugins.join(",")} mcp=${
            record.mcp ?? "none"
          } completions=${record.completions ?? "none"}`
        : "  Project      reset to all plugins, no MCP consent, and no completion answer",
    ],
    notes,
  };
}

function prepareChoiceSection(
  section: ChoiceSection,
  argv: string[],
  options: ReturnType<typeof globalOptions>,
): { argv: string[]; context: ChoicesMutationContext } | null {
  const validation = validateChoiceArgs(section, argv);
  if (validation) {
    emitResult(usage(validation, configCommand(`${section} --help`)), options);
    return null;
  }
  if (argv.includes("--help")) {
    process.stdout.write(`${choiceHelp(section)}\n`);
    process.exitCode = EXIT.ok;
    return null;
  }
  const mutationFlags = section === "flags"
    ? [
        "--bypass",
        "--clear-bypass",
        "--default-scope",
        "--hook-debug",
        "--reset",
        "--sensor-timeout-ms",
        "--swarm",
      ]
    : ["--completions", "--mcp", "--plugins", "--reset"];
  const hasMutationFlags = mutationFlags.some((flag) => argv.includes(flag));
  if (
    (argv.includes("--show") || argv.includes("--check")) &&
    (hasMutationFlags || argv.includes("--dry-run") || argv.includes("--yes"))
  ) {
    emitResult(
      usage(`--show and --check cannot be combined with ${section} mutations`),
      options,
    );
    return null;
  }
  if (argv.includes("--show") && argv.includes("--check")) {
    emitResult(usage("--show and --check are mutually exclusive"), options);
    return null;
  }
  const projectDir = projectDirFrom(argv);
  const selected = selectedDiagnosticHarness(
    projectDir,
    valueAfter(argv, "--harness"),
    section,
  );
  const records = readConfigDiagnosticRecords(selected.root);
  const resolved = resolveAidlcSettings(projectDir);
  if (argv.includes("--show")) {
    showChoiceSection(section, projectDir, selected, records, resolved, options);
    return null;
  }
  if (argv.includes("--check")) {
    checkChoiceSection(section, projectDir, selected, records, resolved, options);
    return null;
  }
  const previous = section === "flags" ? resolved.flags : records.project;
  const previousPlugins = readPluginSelection(selected.root);
  let next: ProjectFlagsRecord | ProjectChoicesRecord | null;
  let nextPlugins = previousPlugins;
  let mcpMode: "defaults" | "none" | undefined;
  let settings: SettingsMutation | undefined;
  const target = section === "flags" && (hasMutationFlags || configInputIsTty())
    ? settingsTargetForMutation(argv, projectDir)
    : undefined;
  const targetCurrentSettings = target
    ? readSettingsTarget(projectDir, target)
    : null;
  const targetCurrentFlags = targetCurrentSettings?.flags ?? null;
  if (argv.includes("--reset")) {
    const conflict = mutationFlags.find((flag) => flag !== "--reset" && argv.includes(flag));
    if (conflict) throw new Error(`--reset cannot be combined with ${conflict}`);
    next = null;
    if (section === "project") {
      nextPlugins = null;
      mcpMode = "none";
    }
  } else if (hasMutationFlags) {
    if (section === "flags") {
      next = buildFlagsRecord(targetCurrentFlags, argv, selected.root);
    } else {
      const built = buildProjectRecord(
        records.project,
        previousPlugins,
        argv,
        selected,
      );
      next = built.record;
      nextPlugins = built.plugins;
      mcpMode = built.record.mcp;
    }
  } else {
    if (!configInputIsTty()) {
      const flags = section === "flags"
        ? "--default-scope, --swarm, --hook-debug, --sensor-timeout-ms, --bypass, or --reset"
        : "--plugins, --mcp, --completions, or --reset";
      emitResult(
        usage(
          `non-interactive ${section} configuration requires ${flags}; --yes confirms but never chooses`,
          configCommand(`${section} --help`),
        ),
        options,
      );
      return null;
    }
    const built = choiceWizard(
      section,
      projectDir,
      selected,
      records,
      resolved,
      targetCurrentFlags,
      options,
    );
    next = built.next;
    nextPlugins = built.plugins;
    if (section === "project") {
      mcpMode = (built.next as ProjectChoicesRecord).mcp;
    }
  }
  if (section === "flags" && target) {
    const nextSettings = updateSettingsSection(
      targetCurrentSettings,
      "flags",
      next as ProjectFlagsRecord | null,
    );
    if (canonical(targetCurrentSettings) === canonical(nextSettings)) {
      emitResult(success("flags configuration unchanged"), options);
      return null;
    }
    const nextResolved = resolveAidlcSettingsWithOverride(
      projectDir,
      target,
      nextSettings,
    );
    next = nextResolved.flags;
    settings = {
      target,
      path: settingsPathForTarget(projectDir, target),
      previous: targetCurrentSettings,
      next: nextSettings,
    };
  }
  if (
    section !== "flags" &&
    canonical(previous) === canonical(next) &&
    canonical(previousPlugins) === canonical(nextPlugins)
  ) {
    emitResult(success(`${section} configuration unchanged`), options);
    return null;
  }
  if (!argv.includes("--dry-run") && !options.yes) {
    if (!configInputIsTty()) {
      emitResult(
        usage(
          `non-interactive ${section} mutation requires --yes; --yes confirms but never chooses`,
          configMutationRerun(section, argv),
        ),
        options,
      );
      return null;
    }
    const answer = configPrompt(`Apply ${section} configuration changes? [y/N]:`);
    if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
      emitResult(usage(`${section} configuration change cancelled`), options);
      return null;
    }
  }
  const summary = choiceSummary(
    section,
    next,
    nextPlugins,
    projectDir,
    selected.harnessDir,
  );
  return {
    argv: choicePipelineArgv(argv),
    context: {
      section,
      harness: selected.harness,
      harnessDir: selected.harnessDir,
      previous,
      next,
      previousPlugins,
      nextPlugins,
      ...(section === "project"
        ? { overrides: { project: next, plugins: nextPlugins } }
        : {}),
      ...(mcpMode ? { mcpMode } : {}),
      summaryLines: summary.lines,
      notes: summary.notes,
      ...(settings ? { settings } : {}),
    },
  };
}

function stripVerb(argv: string[]): string[] {
  return argv[0] === "config" || argv[0] === "init" ? argv.slice(1) : argv;
}

function readBaseline(path: string): Baseline | null {
  if (!pathPresent(path)) return null;
  if (!regularFile(path)) throw new Error(`cannot refresh from ${path}: baseline is not a regular file`);
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Baseline;
    if (value.schemaVersion !== 1) throw new Error(`unsupported schema ${value.schemaVersion}`);
    return value;
  } catch (error) {
    throw new Error(`cannot refresh from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expected(path: string): string | "absent" {
  return transactionState(path);
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function regularFile(path: string): boolean {
  return pathPresent(path) && lstatSync(path).isFile();
}

function planProjectSettingsMutation(
  projectDir: string,
  mutation: SettingsMutation | undefined,
  operations: TransactionOperation[],
  actions: PlannedAction[],
): void {
  if (!mutation || mutation.target === "global") return;
  const rel = relative(projectDir, mutation.path);
  if (mutation.next === null) {
    if (!pathPresent(mutation.path)) return;
    operations.push({ kind: "remove", path: rel, expected: expected(mutation.path) });
    actions.push({ path: rel, action: "remove" });
    return;
  }
  const creating = !pathPresent(mutation.path);
  operations.push(writeOperation(
    rel,
    serializeAidlcSettings(mutation.next),
    expected(mutation.path),
  ));
  actions.push({ path: rel, action: creating ? "create" : "update" });
  if (mutation.target !== "local" || !creating) return;
  const gitignorePath = join(projectDir, ".gitignore");
  const current = regularFile(gitignorePath)
    ? readFileSync(gitignorePath, "utf-8")
    : "";
  const lines = current.split(/\r?\n/);
  if (lines.includes(LOCAL_SETTINGS_FILE)) return;
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const next = `${current}${separator}${LOCAL_SETTINGS_FILE}\n`;
  operations.push(writeOperation(
    ".gitignore",
    next,
    expected(gitignorePath),
  ));
  actions.push({
    path: ".gitignore",
    action: regularFile(gitignorePath) ? "update" : "create",
    detail: `ignore ${LOCAL_SETTINGS_FILE}`,
  });
}

function globalSettingsOperation(
  mutation: SettingsMutation | undefined,
): TransactionOperation | null {
  if (mutation?.target !== "global") return null;
  const root = machineTransactionRoot();
  const rel = relative(root, mutation.path);
  if (mutation.next === null) {
    return pathPresent(mutation.path)
      ? { kind: "remove", path: rel, expected: expected(mutation.path) }
      : null;
  }
  return writeOperation(
    rel,
    serializeAidlcSettings(mutation.next),
    expected(mutation.path),
    0o600,
  );
}

function executeGlobalSettingsMutation(
  mutation: SettingsMutation | undefined,
): void {
  const operation = globalSettingsOperation(mutation);
  if (!operation || !mutation) return;
  executePlan({
    schemaVersion: 1,
    root: machineTransactionRoot(),
    operations: [operation],
  });
  invalidateSettingsCache(mutation.path);
}

function executeSettingsAndProjectMutation(
  mutation: SettingsMutation | undefined,
  projectPlan: TransactionPlan,
): void {
  const operation = globalSettingsOperation(mutation);
  if (!operation || !mutation) {
    executePlan(projectPlan);
    return;
  }
  const machinePlan: TransactionPlan = {
    schemaVersion: 1,
    root: machineTransactionRoot(),
    operations: [operation],
  };
  validateTransactionPlan(machinePlan);
  validateTransactionPlan(projectPlan);
  const priorPresent = pathPresent(mutation.path);
  const priorBytes = priorPresent ? readFileSync(mutation.path) : null;
  const priorMode = priorPresent ? lstatSync(mutation.path).mode & 0o777 : undefined;
  const committed = operation.kind === "remove"
    ? "absent"
    : operation.kind === "write"
    ? sha256Bytes(Buffer.from(operation.data, "base64"))
    : transactionState(mutation.path);
  executePlan(machinePlan, {
    validateLocked: () => {
      const baseline =
        process.env.AIDLC_FIRST_RUN_GLOBAL_BASELINE_STATE;
      if (
        baseline !== undefined &&
        transactionState(mutation.path) !== baseline
      ) {
        throw new Error(
          "global settings changed while first-run setup was preparing the mutation",
        );
      }
    },
  });
  invalidateSettingsCache(mutation.path);
  const rollbackInterference =
    process.env.AIDLC_TEST_SETTINGS_ROLLBACK_INTERFERENCE;
  if (rollbackInterference !== undefined) {
    writeFileSync(mutation.path, rollbackInterference);
    invalidateSettingsCache(mutation.path);
  }
  try {
    executePlan(projectPlan);
  } catch (error) {
    const restoreOperations: TransactionOperation[] = priorBytes === null
      ? committed === "absent"
        ? []
        : [{
            kind: "remove",
            path: relative(machinePlan.root, mutation.path),
            expected: committed,
          }]
      : [writeOperation(
          relative(machinePlan.root, mutation.path),
          priorBytes.toString("utf-8"),
          committed,
          priorMode,
        )];
    try {
      executePlan({
        schemaVersion: 1,
        root: machinePlan.root,
        operations: restoreOperations,
      });
      invalidateSettingsCache(mutation.path);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "project configuration failed and global settings rollback was incomplete",
      );
    }
    throw error;
  }
}

function regularFilesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path));
    }
  };
  visit(root);
  return files;
}

function runtimeGenerated(
  rel: string,
  harnessDir: string,
  regenerated: ReadonlySet<string>,
): boolean {
  const normalized = rel.replaceAll("\\", "/");
  return regenerated.has(normalized) || [
    `${harnessDir}/tools/data/harness.json`,
    `${harnessDir}/tools/data/stage-graph.json`,
    `${harnessDir}/tools/data/scope-grid.json`,
  ].includes(normalized);
}

type StageContribRecord = {
  produces?: string[];
  sensors?: string[];
  consumes?: string[];
  required_sections?: string[];
  required_sections_created?: boolean;
};

function resetProjectionCaches(): void {
  __resetGraphCache();
  _resetHarnessDataForTests();
  _resetScopeMappingForTests();
  _resetStageGraphForTests();
}

function mergeListField(content: string, field: string, items: readonly string[]): string {
  if (items.length === 0) return content;
  const empty = new RegExp(`^${field}:\\s*\\[\\s*\\]\\s*$`, "m");
  if (empty.test(content)) {
    return content.replace(empty, `${field}:\n${items.map((item) => `  - ${item}`).join("\n")}`);
  }
  const block = new RegExp(`^(${field}:\\n(?:  - .+\\n)*)`, "m");
  const match = content.match(block);
  if (!match) return content;
  const existing = new Set(
    [...match[1].matchAll(/^ {2}- (.+)$/gm)].map((item) =>
      item[1].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
    ),
  );
  const additions = items.filter((item) => !existing.has(item));
  if (additions.length === 0) return content;
  const quoted = field === "required_sections";
  return content.replace(
    block,
    `${match[1]}${additions.map((item) => `  - ${quoted ? JSON.stringify(item) : item}`).join("\n")}\n`,
  );
}

function mergeRequiredSections(content: string, record: StageContribRecord): string {
  const items = record.required_sections ?? [];
  if (items.length === 0) return content;
  if (/^required_sections:/m.test(content)) {
    return mergeListField(content, "required_sections", items);
  }
  const close = /^---\r?\n[\s\S]*?\n(---)(?:\r?\n|$)/.exec(content);
  if (!close) return content;
  const at = (close.index ?? 0) + close[0].lastIndexOf("---");
  return `${content.slice(0, at)}required_sections:\n${
    items.map((item) => `  - ${JSON.stringify(item)}`).join("\n")
  }\n${content.slice(at)}`;
}

function consumeBlocks(content: string, names: ReadonlySet<string>): string[] {
  const block = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(content);
  if (!block) return [];
  return [...block[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
    .filter((entry) => names.has(entry[1]))
    .map((entry) => entry[0].trimEnd());
}

function mergeConsumes(content: string, blocks: readonly string[]): string {
  if (blocks.length === 0) return content;
  if (/^consumes:\s*\[\s*\]\s*$/m.test(content)) {
    return content.replace(/^consumes:\s*\[\s*\]\s*$/m, `consumes:\n${blocks.join("\n")}`);
  }
  const match = /^(consumes:\n(?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(content);
  if (!match) return content;
  const existing = new Set([...match[1].matchAll(/- artifact:\s*([\w-]+)/g)].map((item) => item[1]));
  const additions = blocks.filter((block) => {
    const name = /- artifact:\s*([\w-]+)/.exec(block)?.[1];
    return name && !existing.has(name);
  });
  return additions.length === 0
    ? content
    : content.replace(match[0], `${match[1]}${additions.join("\n")}\n`);
}

function stripRecordedContributions(content: string, record: StageContribRecord): string {
  let value = content;
  for (const [field, items] of [
    ["produces", record.produces],
    ["sensors", record.sensors],
    ["required_sections", record.required_sections],
  ] as const) {
    if (!items?.length) continue;
    const values = new Set(items);
    const block = new RegExp(`^${field}:\\n((?: {2}- .+\\n)*)`, "m");
    const match = value.match(block);
    if (!match) continue;
    const kept = [...match[1].matchAll(/^ {2}- (.+)$/gm)]
      .map((item) => item[1])
      .filter((item) => !values.has(item.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")));
    const replacement = kept.length > 0
      ? `${field}:\n${kept.map((item) => `  - ${item}`).join("\n")}\n`
      : field === "required_sections" && record.required_sections_created
      ? ""
      : `${field}: []\n`;
    value = value.replace(block, replacement);
  }
  if (record.consumes?.length) {
    const names = new Set(record.consumes);
    const block = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m.exec(value);
    if (block) {
      const kept = [...block[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
        .filter((entry) => !names.has(entry[1]))
        .map((entry) => entry[0]);
      value = value.replace(block[0], kept.length > 0 ? `consumes:\n${kept.join("")}` : "consumes: []\n");
    }
  }
  return stripPluginFragments(value);
}

function stripPluginFragments(content: string): string {
  return content.replace(
    /<!-- plugin:([^:\n]+):([^\n]+?):(\d+):([0-9a-f]+) -->\n[\s\S]*?<!-- \/plugin:\1:\2:\3:\4 -->\n?/g,
    "",
  ).replace(/\n{3,}/g, "\n\n");
}

function pluginFragments(content: string): Array<{ marker: string; anchor: string; block: string }> {
  const fragments: Array<{ marker: string; anchor: string; block: string }> = [];
  const open = /<!-- plugin:([^:\n]+):([^\n]+?):(\d+):([0-9a-f]+) -->/g;
  for (const match of content.matchAll(open)) {
    const marker = match[0];
    const close = `<!-- /plugin:${match[1]}:${match[2]}:${match[3]}:${match[4]} -->`;
    const end = content.indexOf(close, match.index);
    if (end < 0) continue;
    fragments.push({
      marker,
      anchor: match[2],
      block: content.slice(match.index, end + close.length),
    });
  }
  return fragments;
}

function anchorOffset(content: string, anchor: string): number {
  const step = /^(after|before)-step:(\d+)$/.exec(anchor);
  if (step) {
    const wanted = Number(step[2]);
    for (const match of content.matchAll(/^### Step (\d+)(?:-(\d+))?\b.*$/gm)) {
      const low = Number(match[1]);
      const high = match[2] ? Number(match[2]) : low;
      if (wanted < low || wanted > high) continue;
      if (step[1] === "before") return match.index ?? -1;
      const from = (match.index ?? 0) + match[0].length;
      const next = content.slice(from).search(/^#{2,3} /m);
      return next < 0 ? content.length : from + next;
    }
    return -1;
  }
  if (anchor === "end-of-steps") {
    const section = /^## Steps\b.*$/m.exec(content);
    if (!section) return -1;
    const from = (section.index ?? 0) + section[0].length;
    const next = content.slice(from).search(/^## /m);
    return next < 0 ? content.length : from + next;
  }
  if (anchor.startsWith("in:")) {
    const section = new RegExp(`^## ${anchor.slice(3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b.*$`, "m")
      .exec(content);
    if (!section) return -1;
    const from = (section.index ?? 0) + section[0].length;
    const next = content.slice(from).search(/^## /m);
    return next < 0 ? content.length : from + next;
  }
  return -1;
}

function mergePluginFragments(
  fresh: string,
  fragments: readonly { marker: string; anchor: string; block: string }[],
): string {
  let value = fresh;
  for (const fragment of fragments) {
    if (value.includes(fragment.marker)) continue;
    const offset = anchorOffset(value, fragment.anchor);
    if (offset < 0) {
      throw new Error(`cannot reapply plugin fragment at missing anchor ${fragment.anchor}`);
    }
    value = `${value.slice(0, offset)}\n${fragment.block}\n${value.slice(offset)}`;
  }
  return value;
}

function replaceGeneratedRegion(
  current: string,
  generated: string,
  kind: "stage" | "scope",
): string {
  const noun = kind === "stage" ? "stage graph" : "scope grid";
  const beginPrefix = `<!-- BEGIN: compiled ${noun} via `;
  const end = `<!-- END: compiled ${noun} -->`;
  const locate = (content: string): {
    begin: number;
    beginLineEnd: number;
    endStart: number;
    end: number;
  } => {
    const begin = content.indexOf(beginPrefix);
    const beginLineEnd = content.indexOf("-->", begin);
    const endAt = content.indexOf(end, beginLineEnd);
    if (begin < 0 || beginLineEnd < 0 || endAt < 0) {
      throw new Error(`SKILL.md is missing the compiled ${noun} region`);
    }
    return {
      begin,
      beginLineEnd: beginLineEnd + 3,
      endStart: endAt,
      end: endAt + end.length,
    };
  };
  const target = locate(current);
  const source = locate(generated);
  return `${current.slice(0, target.begin)}${
    current.slice(target.begin, target.beginLineEnd)
  }${generated.slice(source.beginLineEnd, source.endStart)}${
    current.slice(target.endStart, target.end)
  }${current.slice(target.end)}`;
}

function generatedOverlayCandidate(rel: string, harnessDir: string): boolean {
  return rel.startsWith(`${harnessDir}/aidlc-common/stages/`) ||
    rel.startsWith(`${harnessDir}/scopes/`) ||
    rel.startsWith(`${harnessDir}/agents/`) ||
    rel.startsWith(`${harnessDir}/knowledge/`) ||
    rel.startsWith(`${harnessDir}/sensors/`) ||
    rel.startsWith(`${harnessDir}/tools/`) ||
    rel.startsWith(`${harnessDir}/skills/`) ||
    rel.startsWith(".agents/skills/");
}

const HARNESS_IDENTITY_KEYS = new Set([
  "schemaVersion",
  "distribution",
  "productName",
  "configNextStep",
  "harnessDir",
  "rulesSubdir",
]);

function prepareRefreshSource(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  modelPolicy: ModelPolicyRecord | null,
  projectFlags: ProjectFlagsRecord | null,
  diagnosticsOverride?: ConfigDiagnosticOverrides,
): { root: string; cleanup?: string; regenerated: Set<string> } {
  const currentHarness = join(projectDir, descriptor.harnessDir);
  const currentHarnessData = join(currentHarness, "tools", "data", "harness.json");
  if (
    !prior &&
    !regularFile(currentHarnessData) &&
    modelPolicy === null &&
    projectFlags === null &&
    diagnosticsOverride === undefined
  ) {
    return { root: sourceRoot, regenerated: new Set() };
  }
  const cleanup = mkdtempSync(join(tmpdir(), "aidlc-init-refresh-"));
  try {
  const root = join(cleanup, "projection");
  cpSync(sourceRoot, root, { recursive: true, preserveTimestamps: true });
  const regenerated = new Set<string>();
  const stagedHarness = join(root, descriptor.harnessDir);
  const beforeGeneratedWrites = new Map<string, string>();
  for (const directory of descriptor.managedDirectories) {
    const stagedDirectory = join(root, directory);
    if (!existsSync(stagedDirectory) || !lstatSync(stagedDirectory).isDirectory()) continue;
    for (const nested of walkFiles(stagedDirectory)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      beforeGeneratedWrites.set(rel, sha256File(join(root, rel)));
    }
  }
  for (const integration of descriptor.rootIntegrations) {
    const path = join(root, integration.path);
    if (regularFile(path)) {
      beforeGeneratedWrites.set(integration.path, sha256File(path));
    }
  }

  const stagedHarnessData = join(stagedHarness, "tools", "data", "harness.json");
  const staged = JSON.parse(readFileSync(stagedHarnessData, "utf-8")) as Record<string, unknown>;
  if (regularFile(currentHarnessData)) {
    const current = JSON.parse(readFileSync(currentHarnessData, "utf-8")) as Record<string, unknown>;
    const policyKeys = ["models", "flags"].filter((key) => Object.hasOwn(current, key));
    if (policyKeys.length > 0) {
      throw new Error(
        `${currentHarnessData}: harness.json contains legacy policy key(s) ${policyKeys.join(", ")}. ` +
          `Remove ${policyKeys.join(", ")} from ${currentHarnessData}, then run ` +
          `'${aidlcInvocation()} config' to record policy in aidlc.settings.json.`,
      );
    }
    for (const [key, value] of Object.entries(current)) {
      if (!HARNESS_IDENTITY_KEYS.has(key)) staged[key] = value;
    }
  }
  delete staged.models;
  delete staged.flags;
  for (const key of ["runtime", "providers", "trust", "project"] as const) {
    if (!diagnosticsOverride || !Object.hasOwn(diagnosticsOverride, key)) continue;
    const value = diagnosticsOverride[key];
    if (value === null) delete staged[key];
    else staged[key] = value;
  }
  if (diagnosticsOverride && Object.hasOwn(diagnosticsOverride, "plugins")) {
    if (diagnosticsOverride.plugins === null) delete staged.plugins;
    else staged.plugins = diagnosticsOverride.plugins;
  }
  if (
    regularFile(currentHarnessData) ||
    diagnosticsOverride !== undefined
  ) {
    writeFileSync(stagedHarnessData, `${JSON.stringify(staged, null, 2)}\n`);
    regenerated.add(`${descriptor.harnessDir}/tools/data/harness.json`);
  }
  const distribution = staged.distribution;
  if (typeof distribution !== "string") {
    throw new Error(`${stagedHarnessData}: distribution must be a string`);
  }
  applyModelPolicyToProjection(
    root,
    descriptor.harnessDir,
    modelHarness(distribution),
    modelPolicy,
  );
  applyProjectFlagsToProjection(
    root,
    descriptor.harnessDir,
    modelHarness(distribution),
    projectFlags,
  );
  applyConfigDiagnosticRecords(
    root,
    descriptor.harnessDir,
    modelHarness(distribution),
    {
      runtime: normalizeRuntimeRecord(staged.runtime),
      providers: normalizeProvidersRecord(staged.providers),
      trust: normalizeTrustRecord(staged.trust),
      project: normalizeProjectChoicesRecord(staged.project),
    },
  );
  for (const directory of descriptor.managedDirectories) {
    const stagedDirectory = join(root, directory);
    if (!existsSync(stagedDirectory) || !lstatSync(stagedDirectory).isDirectory()) continue;
    for (const nested of walkFiles(stagedDirectory)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      if (beforeGeneratedWrites.get(rel) !== sha256File(join(root, rel))) {
        regenerated.add(rel);
      }
    }
  }
  for (const integration of descriptor.rootIntegrations) {
    const path = join(root, integration.path);
    if (
      regularFile(path) &&
      beforeGeneratedWrites.get(integration.path) !== sha256File(path)
    ) {
      regenerated.add(integration.path);
    }
  }

  const currentGrid = join(currentHarness, "tools", "data", "scope-grid.json");
  const stagedGrid = join(stagedHarness, "tools", "data", "scope-grid.json");
  if (regularFile(currentGrid)) {
    cpSync(currentGrid, stagedGrid);
    regenerated.add(`${descriptor.harnessDir}/tools/data/scope-grid.json`);
  }

  for (const directory of descriptor.managedDirectories) {
    if (directory !== descriptor.harnessDir && directory !== ".agents") continue;
    const currentDir = join(projectDir, directory);
    if (!pathPresent(currentDir) || !lstatSync(currentDir).isDirectory()) continue;
    for (const nested of regularFilesBelow(currentDir)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      const staged = join(root, rel);
      if (
        existsSync(staged) ||
        prior?.files[rel] ||
        !generatedOverlayCandidate(rel, descriptor.harnessDir)
      ) continue;
      mkdirSync(dirname(staged), { recursive: true });
      cpSync(join(projectDir, rel), staged, { preserveTimestamps: true });
      regenerated.add(rel);
    }
  }

  const records = new Map<string, StageContribRecord>();
  const dataDir = join(currentHarness, "tools", "data");
  if (pathPresent(dataDir) && lstatSync(dataDir).isDirectory()) {
    for (const file of readdirSync(dataDir).filter((name) => /^plugin-contrib-.+\.json$/.test(name))) {
      if (!regularFile(join(dataDir, file))) continue;
      const parsed = JSON.parse(readFileSync(join(dataDir, file), "utf-8")) as Record<string, StageContribRecord>;
      for (const [slug, record] of Object.entries(parsed)) {
        const priorRecord = records.get(slug) ?? {};
        records.set(slug, {
          produces: [...new Set([...(priorRecord.produces ?? []), ...(record.produces ?? [])])],
          sensors: [...new Set([...(priorRecord.sensors ?? []), ...(record.sensors ?? [])])],
          consumes: [...new Set([...(priorRecord.consumes ?? []), ...(record.consumes ?? [])])],
          required_sections: [
            ...new Set([...(priorRecord.required_sections ?? []), ...(record.required_sections ?? [])]),
          ],
          required_sections_created:
            priorRecord.required_sections_created || record.required_sections_created,
        });
      }
    }
  }

  const stageRoot = join(currentHarness, "aidlc-common", "stages");
  if (pathPresent(stageRoot) && lstatSync(stageRoot).isDirectory()) {
    for (const phase of readdirSync(stageRoot)) {
      const currentPhase = join(stageRoot, phase);
      if (!lstatSync(currentPhase).isDirectory()) continue;
      for (const file of readdirSync(currentPhase).filter((name) => name.endsWith(".md"))) {
        const rel = `${descriptor.harnessDir}/aidlc-common/stages/${phase}/${file}`;
        const priorHash = prior?.files[rel];
        const currentPath = join(projectDir, rel);
        const stagedPath = join(root, rel);
        if (!regularFile(currentPath) || !existsSync(stagedPath)) continue;
        const current = readFileSync(currentPath, "utf-8");
        const record = records.get(file.slice(0, -3)) ?? {};
        const fragments = pluginFragments(current);
        const hasRecordedContribution = Object.entries(record).some(([key, value]) =>
          key === "required_sections_created" ? value === true : Array.isArray(value) && value.length > 0
        );
        if (fragments.length === 0 && !hasRecordedContribution) {
          continue;
        }
        const currentHash = sha256Bytes(current);
        const strippedHash = sha256Bytes(stripRecordedContributions(current, record));
        if (priorHash && currentHash !== priorHash && strippedHash !== priorHash) continue;
        let fresh = readFileSync(stagedPath, "utf-8");
        fresh = mergeListField(fresh, "produces", record.produces ?? []);
        fresh = mergeListField(fresh, "sensors", record.sensors ?? []);
        fresh = mergeConsumes(fresh, consumeBlocks(current, new Set(record.consumes ?? [])));
        fresh = mergeRequiredSections(fresh, record);
        fresh = mergePluginFragments(fresh, fragments);
        writeFileSync(stagedPath, fresh);
        if (prior) regenerated.add(rel);
      }
    }
  }

  const envKeys = [
    "AIDLC_RUNTIME_PROJECT_DIR",
    "AIDLC_PROJECT_DIR",
    "AIDLC_HARNESS_DIR",
    "AIDLC_RUNTIME_HARNESS_ROOT",
    "AIDLC_RULES_DIR",
    "AIDLC_STAGE_GRAPH",
    "AIDLC_SCOPE_GRID",
    "AIDLC_SCOPES_DIR",
    "AIDLC_SENSORS_DIR",
    "AIDLC_AGENTS_DIR",
  ] as const;
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.AIDLC_RUNTIME_PROJECT_DIR = root;
    process.env.AIDLC_PROJECT_DIR = root;
    process.env.AIDLC_HARNESS_DIR = descriptor.harnessDir;
    process.env.AIDLC_RUNTIME_HARNESS_ROOT = stagedHarness;
    process.env.AIDLC_RULES_DIR = join(root, "aidlc", "spaces", "default", "memory");
    process.env.AIDLC_STAGE_GRAPH = join(stagedHarness, "tools", "data", "stage-graph.json");
    process.env.AIDLC_SCOPE_GRID = stagedGrid;
    process.env.AIDLC_SCOPES_DIR = join(stagedHarness, "scopes");
    process.env.AIDLC_SENSORS_DIR = join(stagedHarness, "sensors");
    process.env.AIDLC_AGENTS_DIR = join(stagedHarness, "agents");
    resetProjectionCaches();
    const compiled = compileStageGraph();
    writeFileSync(process.env.AIDLC_STAGE_GRAPH, compiled.json);
    writeFileSync(stagedGrid, compiled.gridJson);
    resetProjectionCaches();
    regenerateRunnerSurfaces();
    resetProjectionCaches();

    const skillPath = existsSync(join(stagedHarness, "skills", "aidlc", "SKILL.md"))
      ? join(stagedHarness, "skills", "aidlc", "SKILL.md")
      : join(root, ".agents", "skills", "aidlc", "SKILL.md");
    if (existsSync(skillPath)) {
      let generated = readFileSync(skillPath, "utf-8");
      generated = replaceGeneratedRegion(
        generated,
        canonicalStageTableRegion(renderStageTable()),
        "stage",
      );
      generated = replaceGeneratedRegion(
        generated,
        canonicalScopeTableRegion(renderScopeTable()),
        "scope",
      );
      writeFileSync(skillPath, generated);
    }
    regenerated.add(`${descriptor.harnessDir}/tools/data/stage-graph.json`);
    for (const directory of [join(stagedHarness, "skills"), join(root, ".agents", "skills")]) {
      if (!existsSync(directory)) continue;
      for (const nested of walkFiles(directory)) {
        const path = join(directory, nested);
        if (readFileSync(path, "utf-8").includes("generated-by: aidlc-runner-gen")) {
          regenerated.add(relative(root, path).replaceAll("\\", "/"));
        }
      }
    }
  } finally {
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProjectionCaches();
  }
  return { root, cleanup, regenerated };
  } catch (error) {
    rmSync(cleanup, { recursive: true, force: true });
    throw error;
  }
}

function activeWorkflowDescriptions(projectDir: string): string[] {
  const active: string[] = [];
  for (const space of listSpaces(projectDir)) {
    for (const intent of listIntents(projectDir, space.name)) {
      if (intent.status === "complete" || !intent.dirName) continue;
      const path = stateFilePath(projectDir, intent.dirName, space.name);
      if (regularFile(path)) {
        const status = getField(readFileSync(path, "utf-8"), "Status");
        if (status === "Completed") continue;
      }
      active.push(`${space.name}/${intent.dirName}`);
    }
  }
  return active;
}

function assertRefreshSafe(projectDir: string): void {
  const activeWorkflows = activeWorkflowDescriptions(projectDir);
  if (activeWorkflows.length === 0) return;
  throw new Error(
    `refusing to refresh while ${activeWorkflows.length} workflow(s) are active: ${
      activeWorkflows.join(", ")
    }. Complete the workflow before rerunning aidlc config; update and use do not modify project files.`,
  );
}

function mergeBlock(
  path: string,
  current: string,
  shipped: string,
  identity: string,
  legacyWholeFileHashes: readonly string[] = [],
): {
  value?: string;
  currentHash?: string;
  nextHash?: string;
  adoptedLegacy?: boolean;
  error?: string;
} {
  const { begin, end } = managedBlockMarkers(path, identity);
  const begins = current.split(begin).length - 1;
  const ends = current.split(end).length - 1;
  if (begins > 1 || ends > 1 || (begins === 1) !== (ends === 1)) {
    return { error: "managed markers are missing, duplicated, or malformed" };
  }
  const beginAt = current.indexOf(begin);
  const endAt = current.indexOf(end);
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const body = shipped.trim().replace(/\r?\n/g, newline);
  const block = `${begin}${newline}${body}${newline}${end}`;
  if (beginAt >= 0) {
    if (endAt < beginAt) return { error: "managed end marker precedes its begin marker" };
    const currentBlock = current.slice(beginAt, endAt + end.length);
    return {
      value: `${current.slice(0, beginAt)}${block}${current.slice(endAt + end.length)}`,
      currentHash: sha256Bytes(currentBlock),
      nextHash: sha256Bytes(block),
    };
  }
  if (current.length > 0 && legacyWholeFileHashes.includes(sha256Bytes(current))) {
    return {
      value: `${block}${newline}`,
      nextHash: sha256Bytes(block),
      adoptedLegacy: true,
    };
  }
  if (/\baidlc\b|AI-DLC/i.test(current)) {
    return { error: "legacy root integration ambiguous; move or delete the unmarked AI-DLC content" };
  }
  const prefix = current.length === 0 || current.endsWith(newline) ? current : `${current}${newline}`;
  return {
    value: `${prefix}${prefix ? newline : ""}${block}${newline}`,
    nextHash: sha256Bytes(block),
  };
}

function addRuntimeDistributions(roots: string[], root: string): boolean {
  if (!existsSync(root)) return false;
  let added = false;
  for (const entry of readdirSync(root).sort()) {
    const candidate = join(root, entry);
    if (!statSync(candidate).isDirectory()) continue;
    roots.push(candidate);
    added = true;
  }
  return added;
}

function dedupeSourceRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    let identity: string;
    try {
      identity = realpathSync(root);
    } catch {
      identity = resolve(root);
    }
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function installedSources(
  requiredVersion?: string,
  executablePath = process.execPath,
): string[] {
  const roots: string[] = [];
  const explicit = process.env.AIDLC_RUNTIME_ROOT;
  if (explicit && existsSync(explicit)) {
    addRuntimeDistributions(roots, explicit);
    try {
      projectionFiles(explicit);
      roots.push(explicit);
    } catch {
      // The explicit root may be a parent of distributions.
    }
  }
  let selectedVersionRuntimeFound = false;
  const active = activeVersion();
  if (active) {
    const activeFound = addRuntimeDistributions(roots, runtimeRoot(active));
    if (!requiredVersion || requiredVersion === active) {
      selectedVersionRuntimeFound = activeFound;
    }
  }
  if (requiredVersion && requiredVersion !== active) {
    selectedVersionRuntimeFound = addRuntimeDistributions(
      roots,
      runtimeRoot(requiredVersion),
    );
  }
  if (!selectedVersionRuntimeFound) {
    let executable = executablePath;
    try {
      executable = realpathSync(executable);
    } catch {
      executable = resolve(executable);
    }
    addRuntimeDistributions(roots, join(dirname(executable), "runtime"));
  }
  return dedupeSourceRoots(roots);
}

export function _installedSourcesForTests(
  requiredVersion?: string,
  executablePath?: string,
): string[] {
  return installedSources(requiredVersion, executablePath);
}

function materializeSource(path: string): { root: string; cleanup?: string } {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(absolute)) throw new Error(`init source does not exist: ${absolute}`);
  if (statSync(absolute).isDirectory()) return { root: absolute };
  const temporary = mkdtempSync(join(tmpdir(), "aidlc-init-source-"));
  extractTarGz(absolute, temporary);
  return { root: temporary, cleanup: temporary };
}

function configuredDefaultHarness(): string | undefined {
  const path = defaultHarnessPath();
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf-8").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(
      `${path} contains an invalid harness name; pass --harness <name>`,
    );
  }
  return value;
}

type InstalledSourceCandidate = {
  root: string;
  stamp: ReturnType<typeof projectionFiles>["stamp"];
  descriptor: ReturnType<typeof projectionFiles>["descriptor"];
};

type ConfigSource = {
  root: string;
  cleanup?: string;
  stamp: ReturnType<typeof projectionFiles>["stamp"];
  descriptor: ReturnType<typeof projectionFiles>["descriptor"];
  projectProjection?: boolean;
};

function installedSourceCandidates(
  requiredVersion?: string,
): InstalledSourceCandidate[] {
  const candidates = installedSources(requiredVersion).flatMap((root) => {
    try {
      const projection = projectionFiles(root);
      return [{ root, stamp: projection.stamp, descriptor: projection.descriptor }];
    } catch {
      return [];
    }
  });
  return requiredVersion
    ? candidates.filter((candidate) =>
        candidate.stamp.frameworkVersion === requiredVersion
      )
    : candidates;
}

function selectSource(
  requested: string | undefined,
  from: string | undefined,
  existingDistribution: string | undefined,
  requiredVersion?: string,
): ConfigSource {
  if (from) {
    const source = materializeSource(from);
    const { stamp, descriptor } = projectionFiles(source.root);
    if (requested && stamp.distribution !== requested) {
      if (source.cleanup) rmSync(source.cleanup, { recursive: true, force: true });
      throw new Error(`source is ${stamp.distribution}, not requested harness ${requested}`);
    }
    if (existingDistribution && stamp.distribution !== existingDistribution) {
      if (source.cleanup) rmSync(source.cleanup, { recursive: true, force: true });
      throw new Error(`existing project uses ${existingDistribution}; refusing ${stamp.distribution}`);
    }
    return { ...source, stamp, descriptor };
  }
  const candidates = installedSourceCandidates(requiredVersion);
  const selectedName = existingDistribution || requested;
  const versionFiltered = candidates;
  if (selectedName) {
    const selected = versionFiltered.filter((candidate) =>
      candidate.stamp.distribution === selectedName
    );
    if (selected.length === 1) return selected[0];
    throw new Error(
      requiredVersion && versionFiltered.length === 0
        ? `project requires ${requiredVersion}, which is not installed; run aidlc config --pin ${requiredVersion}`
        : requiredVersion
        ? `harness ${selectedName} is not installed in ${requiredVersion}; run aidlc config --pin ${requiredVersion}`
        : `harness ${selectedName} is not installed`,
    );
  }
  const configuredDefault = configuredDefaultHarness();
  if (configuredDefault) {
    const selected = versionFiltered.filter((candidate) =>
      candidate.stamp.distribution === configuredDefault
    );
    if (selected.length === 1) return selected[0];
    if (versionFiltered.length > 0) {
      throw new Error(
        requiredVersion
          ? `configured default harness ${configuredDefault} is not installed in ${requiredVersion}; run aidlc config --pin ${requiredVersion}`
          : `configured default harness ${configuredDefault} is unavailable; pass --harness <name>`,
      );
    }
  }
  if (versionFiltered.length === 1) return versionFiltered[0];
  if (versionFiltered.length === 0) {
    throw new Error(
      requiredVersion
        ? `project requires ${requiredVersion}, which is not installed; run aidlc config --pin ${requiredVersion}`
        : "no installed harness runtime is available",
    );
  }
  if (configInputIsTty()) {
    process.stdout.write("Select a harness for this project:\n\n");
    for (const [index, candidate] of versionFiltered.entries()) {
      process.stdout.write(
        `  ${index + 1}. ${candidate.descriptor.productName}\n`,
      );
    }
    const selected = versionFiltered[
      promptChoice("Harness", versionFiltered.length) - 1
    ];
    process.stdout.write(`Using ${selected.descriptor.productName}.\n`);
    return selected;
  }
  throw new Error(
    `multiple harnesses are installed; pass --harness <${
      versionFiltered.map((item) => item.stamp.distribution).join("|")
    }>`,
  );
}

function copiedProjectSource(
  projectDir: string,
  requested?: string,
): ConfigSource {
  const harnesses = discoverProjectHarnesses(projectDir);
  const selected = requested
    ? harnesses.find((candidate) => candidate.distribution === requested)
    : harnesses[0];
  if (!selected) {
    throw new Error("the project does not contain a copied AI-DLC projection");
  }
  if (!requested && harnesses.length > 1) {
    throw new Error("multiple project harnesses are present; pass one --harness <name>");
  }
  const dataDir = join(selected.root, "tools", "data");
  const stampPath = join(dataDir, "aidlc-stamp.json");
  const descriptorPath = join(dataDir, "aidlc-projection.json");
  assertProjectionPathHasNoSymlinks(
    projectDir,
    relative(projectDir, stampPath).replaceAll("\\", "/"),
  );
  assertProjectionPathHasNoSymlinks(
    projectDir,
    relative(projectDir, descriptorPath).replaceAll("\\", "/"),
  );
  if (
    !existsSync(stampPath) ||
    !lstatSync(stampPath).isFile() ||
    !existsSync(descriptorPath) ||
    !lstatSync(descriptorPath).isFile()
  ) {
    throw new Error(`${dataDir}: copied projection metadata must be regular files`);
  }
  const stamp = JSON.parse(
    readFileSync(stampPath, "utf-8"),
  ) as ReturnType<typeof projectionFiles>["stamp"];
  const descriptor = JSON.parse(
    readFileSync(descriptorPath, "utf-8"),
  ) as ReturnType<typeof projectionFiles>["descriptor"];
  if (
    stamp.schemaVersion !== 1 ||
    descriptor.schemaVersion !== 1 ||
    stamp.distribution !== selected.distribution ||
    descriptor.distribution !== selected.distribution ||
    stamp.harnessDir !== selected.harnessDir ||
    descriptor.harnessDir !== selected.harnessDir
  ) {
    throw new Error(`${dataDir}: copied projection identity is inconsistent`);
  }
  validateProjectionDescriptor(projectDir, stamp, descriptor, {
    allowMissingRootIntegrations: true,
  });
  const cleanup = mkdtempSync(join(tmpdir(), "aidlc-config-copy-source-"));
  const root = join(cleanup, "projection");
  mkdirSync(root, { recursive: true });
  for (const directory of descriptor.managedDirectories) {
    assertProjectionPathHasNoSymlinks(projectDir, directory);
    const source = join(projectDir, directory);
    if (!existsSync(source) || !lstatSync(source).isDirectory()) {
      rmSync(cleanup, { recursive: true, force: true });
      throw new Error(`copied projection is missing managed directory ${directory}`);
    }
    cpSync(source, join(root, directory), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  for (const integration of descriptor.rootIntegrations) {
    assertProjectionPathHasNoSymlinks(projectDir, integration.path);
    const source = join(projectDir, integration.path);
    if (!existsSync(source) || !lstatSync(source).isFile()) continue;
    const target = join(root, integration.path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { preserveTimestamps: true });
  }
  walkFiles(root);
  rmSync(
    join(root, selected.harnessDir, "tools", "data", "aidlc-manifest.json"),
    { force: true },
  );
  return {
    root,
    cleanup,
    stamp,
    descriptor,
    projectProjection: true,
  };
}

type FirstRunDetection = {
  harnesses: Record<string, {
    found: boolean;
    probed?: boolean;
    version?: string;
    path?: string;
  }>;
  aws: ReturnType<typeof detectAwsCredentials>;
  runtimeIssues: ReturnType<typeof runtimeIssues>;
  bedrockReachable?: boolean;
};

type FirstRunChoices = {
  candidate: InstalledSourceCandidate;
  provider: "amazon-bedrock" | "other";
  region: string;
  profile: string;
  preset: "balanced" | "thorough" | "minimal";
  plugins: string;
  pluginLabel: string;
  mcp: "defaults" | "none";
  target: SettingsTarget;
  providerVerified: boolean;
  opencodeDefault: boolean;
};

class FirstRunCancelled extends Error {}

function firstRunPromptValue(value: string | null): string {
  if (value === null) throw new FirstRunCancelled();
  const normalized = value.trim();
  if (normalized.includes("\u0003")) throw new FirstRunCancelled();
  return normalized;
}

function promptChoice(
  label: string,
  count: number,
  defaultIndex?: number,
): number {
  while (true) {
    const suffix = defaultIndex === undefined
      ? ` [1-${count}]`
      : ` [${defaultIndex}]`;
    const value = firstRunPromptValue(configPrompt(`${label}${suffix}:`));
    if (!value && defaultIndex !== undefined) return defaultIndex;
    if (/^\d+$/.test(value)) {
      const selected = Number(value);
      if (selected >= 1 && selected <= count) return selected;
    }
    process.stdout.write(
      `\n  That's not one of the choices - enter ${
        count === 2 ? "1 or 2" : `1, 2${count > 3 ? `, ... or ${count}` : ", or 3"}`
      }.\n`,
    );
  }
}

function promptTextDefault(label: string, fallback: string): string {
  return firstRunPromptValue(configPrompt(`${label} [${fallback}]:`)) || fallback;
}

function promptYesDefault(label: string, defaultYes = true): boolean {
  while (true) {
    const value = firstRunPromptValue(
      configPrompt(`${label} [${defaultYes ? "Y/n" : "y/N"}]:`),
    ).toLowerCase();
    if (!value) return defaultYes;
    if (value === "y" || value === "yes") return true;
    if (value === "n" || value === "no") return false;
    process.stdout.write("\n  Enter y or n.\n");
  }
}

function injectedFirstRunDetection(): Partial<FirstRunDetection> | null {
  const raw = process.env.AIDLC_TEST_CONFIG_DETECTION_JSON;
  if (!raw) return null;
  return JSON.parse(raw) as Partial<FirstRunDetection>;
}

function detectFirstRun(
  _projectDir: string,
  candidates: readonly InstalledSourceCandidate[],
): FirstRunDetection {
  const injected = injectedFirstRunDetection();
  const harnesses: FirstRunDetection["harnesses"] = {};
  for (const candidate of candidates) {
    const override = injected?.harnesses?.[candidate.stamp.distribution];
    if (override) {
      harnesses[candidate.stamp.distribution] = override;
      continue;
    }
    const probe = probeHarnessCli(modelHarness(candidate.stamp.distribution));
    harnesses[candidate.stamp.distribution] = {
      found: probe.status === "found",
      probed: probe.status !== "not-applicable",
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.path ? { path: probe.path } : {}),
    };
  }
  const first = candidates[0];
  const runtime = first
    ? runtimeIssues(probeRuntime(
        first.root,
        first.descriptor.harnessDir,
        modelHarness(first.stamp.distribution),
        { includeHarnessCli: false },
      ))
    : [];
  return {
    harnesses,
    aws: injected?.aws ?? detectAwsCredentials(),
    runtimeIssues: injected?.runtimeIssues ?? runtime,
    ...(injected?.bedrockReachable !== undefined
      ? { bedrockReachable: injected.bedrockReachable }
      : {}),
  };
}

function detectedCandidateChoices(
  candidates: readonly InstalledSourceCandidate[],
  detection: FirstRunDetection,
): InstalledSourceCandidate[] {
  return candidates.filter((candidate) =>
    detection.harnesses[candidate.stamp.distribution]?.found
  );
}

function renderHarnessChoices(
  candidates: readonly InstalledSourceCandidate[],
  detection: FirstRunDetection,
  defaultDistribution?: string,
): void {
  for (const [index, candidate] of candidates.entries()) {
    const detected = detection.harnesses[candidate.stamp.distribution];
    const tags = [
      ...(detected?.found ? ["detected"] : []),
      ...(!detected?.found && detected?.probed === false ? ["not probed"] : []),
      ...(candidate.stamp.distribution === defaultDistribution ? ["default"] : []),
    ];
    process.stdout.write(
      `    ${index + 1}. ${candidate.descriptor.productName.padEnd(16)}${
        tags.length > 0 ? `(${tags.join(", ")})` : ""
      }\n`,
    );
  }
}

function chooseHarness(
  candidates: readonly InstalledSourceCandidate[],
  detection: FirstRunDetection,
  defaultDistribution?: string,
): InstalledSourceCandidate {
  renderHarnessChoices(candidates, detection, defaultDistribution);
  const defaultIndex = defaultDistribution
    ? candidates.findIndex((candidate) =>
        candidate.stamp.distribution === defaultDistribution
      ) + 1
    : undefined;
  const selected = promptChoice(
    "  Harness",
    candidates.length,
    defaultIndex && defaultIndex > 0 ? defaultIndex : undefined,
  );
  const candidate = candidates[selected - 1];
  process.stdout.write(`  Using ${candidate.descriptor.productName}.\n\n`);
  return candidate;
}

function awsSummary(credentials: ReturnType<typeof detectAwsCredentials>): {
  source: string;
  region: string;
  regionSource: "detected" | "fallback";
} {
  return {
    source: credentials.sources[0] ?? "default credential chain",
    region: credentials.regions[0] ?? "us-east-1",
    regionSource: credentials.regions.length > 0 ? "detected" : "fallback",
  };
}

let firstRunChildCount = 0;

type FirstRunMutationSnapshot = {
  recoveryPath: string;
  prepareChild: (args: readonly string[]) => NodeJS.ProcessEnv;
  recordCommitted: (result: Record<string, unknown>) => void;
  restore: () => void;
  cleanup: () => void;
};

function runConfigChild(
  args: string[],
  cwd: string,
  snapshot: FirstRunMutationSnapshot,
): Record<string, unknown> {
  const env = { ...process.env, ...snapshot.prepareChild(args) };
  delete env.AIDLC_TEST_CONFIG_TTY;
  delete env.AIDLC_TEST_CONFIG_DETECTION_JSON;
  const commandArgs = isCompiledExecutable()
    ? ["config", ...args]
    : [fileURLToPath(import.meta.url), "config", ...args];
  const result = spawnSync(process.execPath, commandArgs, {
    cwd,
    env,
    encoding: "utf-8",
    input: "",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error((result.stdout || result.stderr || "configuration failed").trim());
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  snapshot.recordCommitted(parsed);
  firstRunChildCount++;
  if (
    Number(process.env.AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD ?? "0") ===
      firstRunChildCount
  ) {
    const interference =
      process.env.AIDLC_TEST_FIRST_RUN_ROLLBACK_INTERFERENCE;
    if (interference !== undefined) {
      writeFileSync(
        process.env.AIDLC_TEST_FIRST_RUN_ROLLBACK_INTERFERENCE_PATH ??
          join(cwd, "aidlc.settings.json"),
        interference,
      );
    }
    throw new Error(`injected first-run failure after child ${firstRunChildCount}`);
  }
  return parsed;
}

function firstRunNextCommands(distribution: string): [string, string] {
  if (distribution === "codex") {
    return ["codex                         open Codex CLI in this repo", '$aidlc "what you want built"  describe your first intent'];
  }
  if (distribution === "kiro") {
    return ["kiro-cli chat                  open Kiro CLI in this repo", '/aidlc "what you want built"  describe your first intent'];
  }
  if (distribution === "opencode") {
    return ["opencode                       open opencode in this repo", '/aidlc "what you want built"  describe your first intent'];
  }
  if (distribution === "cursor") {
    return ["cursor                         open Cursor in this repo", '/aidlc "what you want built"  describe your first intent'];
  }
  if (distribution === "kiro-ide") {
    return ["kiro                          open Kiro IDE in this repo", '/aidlc "what you want built"  describe your first intent'];
  }
  if (distribution === "copilot") {
    return ["copilot                        open Copilot CLI in this repo", '/aidlc "what you want built"  describe your first intent'];
  }
  return ["claude                         open Claude Code in this repo", '/aidlc "what you want built"  describe your first intent'];
}

function firstRunSettingsTargetLabel(target: SettingsTarget): string {
  return target === "project"
    ? "this project, committed"
    : target === "local"
    ? "this project, just for you"
    : "this machine";
}

export function firstRunPathRemediation(
  platform: NodeJS.Platform,
  directory: string,
): string[] {
  return platform === "win32"
    ? [
        `Add ${directory} to your User PATH in Windows Settings, then open a new terminal.`,
      ]
    : [
        "Add this line to ~/.profile, then open a new shell:",
        '    export PATH="$HOME/.local/bin:$PATH"',
      ];
}

function applyFirstRunChoices(
  projectDir: string,
  choices: FirstRunChoices,
  snapshot: FirstRunMutationSnapshot,
): void {
  firstRunChildCount = 0;
  const common = [
    "--project-dir",
    projectDir,
    "--from",
    choices.candidate.root,
    "--harness",
    choices.candidate.stamp.distribution,
    "--mcp",
    choices.mcp,
    "--yes",
    "--json",
  ];
  runConfigChild(common, projectDir, snapshot);
  runConfigChild([
    "models",
    "--project-dir",
    projectDir,
    `--${choices.target}`,
    "--preset",
    choices.preset,
    "--yes",
    "--json",
  ], projectDir, snapshot);
  runConfigChild([
    "project",
    "--project-dir",
    projectDir,
    "--plugins",
    choices.plugins,
    "--mcp",
    choices.mcp,
    "--completions",
    "none",
    "--yes",
    "--json",
  ], projectDir, snapshot);
  const providerArgs = [
    "providers",
    "--project-dir",
    projectDir,
    "--provider",
    choices.provider,
  ];
  if (choices.provider === "amazon-bedrock") {
    providerArgs.push("--region", choices.region);
    if (choices.profile) providerArgs.push("--profile", choices.profile);
    if (choices.candidate.stamp.distribution === "opencode") {
      providerArgs.push(
        "--opencode-default",
        choices.opencodeDefault ? "yes" : "no",
      );
    }
    if (choices.providerVerified) {
      providerArgs.push("--mark-done", "bedrock-model-access");
    }
    providerArgs.push("--yes", "--json");
    runConfigChild(providerArgs, projectDir, snapshot);
  }
}

function firstRunMutationPaths(
  projectDir: string,
  choices: FirstRunChoices,
): string[] {
  return [...new Set([
    ...choices.candidate.descriptor.managedDirectories.map((path) =>
      join(projectDir, path)
    ),
    ...choices.candidate.descriptor.rootIntegrations.map((integration) =>
      join(projectDir, integration.path)
    ),
    join(projectDir, ".gitignore"),
    settingsPathForTarget(projectDir, choices.target),
  ].map((path) => resolve(path)))];
}

function snapshotFirstRunMutationPaths(
  projectDir: string,
  choices: FirstRunChoices,
): FirstRunMutationSnapshot {
  const root = mkdtempSync(join(tmpdir(), "aidlc-first-run-rollback-"));
  const snapshots = firstRunMutationPaths(projectDir, choices).map((path, index) => {
    const backup = join(root, String(index));
    return {
      path,
      backup,
      existed: false,
      committed: "absent" as string | "absent",
      owned: false,
    };
  });
  const capture = (snapshot: (typeof snapshots)[number]): void => {
    rmSync(snapshot.backup, { recursive: true, force: true });
    snapshot.existed = pathPresent(snapshot.path);
    if (snapshot.existed) {
      cpSync(snapshot.path, snapshot.backup, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
    }
    snapshot.committed = transactionState(snapshot.path);
  };
  for (const snapshot of snapshots) capture(snapshot);
  return {
    recoveryPath: root,
    prepareChild: (args) => {
      if (!args.includes("--global")) return {};
      const globalPath = resolve(settingsPathForTarget(projectDir, "global"));
      const snapshot = snapshots.find((candidate) =>
        candidate.path === globalPath
      );
      if (!snapshot || snapshot.owned) return {};
      capture(snapshot);
      return {
        AIDLC_FIRST_RUN_GLOBAL_BASELINE_STATE: snapshot.committed,
      };
    },
    recordCommitted: (result) => {
      const data = result.data;
      if (!data || typeof data !== "object" || !("actions" in data)) return;
      const actions = (data as { actions?: unknown }).actions;
      if (!Array.isArray(actions)) return;
      const changed = new Set(
        actions.flatMap((action) => {
          if (
            !action ||
            typeof action !== "object" ||
            !("path" in action) ||
            typeof action.path !== "string"
          ) {
            return [];
          }
          return [resolve(projectDir, action.path)];
        }),
      );
      for (const snapshot of snapshots) {
        if (
          [...changed].some((path) =>
            path === snapshot.path || path.startsWith(`${snapshot.path}${sep}`)
          )
        ) {
          snapshot.committed = transactionState(snapshot.path);
          snapshot.owned = true;
        }
      }
    },
    restore: () => {
      const errors: unknown[] = [];
      for (const snapshot of [...snapshots].reverse()) {
        try {
          const projectRelative = relative(projectDir, snapshot.path);
          const projectOwned = projectRelative !== "" &&
            !isAbsolute(projectRelative) &&
            projectRelative !== ".." &&
            !projectRelative.startsWith(`..${sep}`);
          const transactionRoot = projectOwned
            ? projectDir
            : machineTransactionRoot();
          const path = relative(transactionRoot, snapshot.path);
          const operations: TransactionOperation[] = snapshot.existed
            ? [{
                kind: lstatSync(snapshot.backup).isDirectory() ? "tree" : "copy",
                path,
                source: snapshot.backup,
                sourceHash: transactionSourceHash(snapshot.backup),
                expected: snapshot.committed,
              }]
            : snapshot.committed === "absent"
            ? []
            : [{
                kind: "remove",
                path,
                expected: snapshot.committed,
              }];
          executePlan({
            schemaVersion: 1,
            root: transactionRoot,
            operations,
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "first-run rollback was incomplete");
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function renderFirstRunEnding(
  projectDir: string,
  choices: FirstRunChoices,
): void {
  const manifest = JSON.parse(readFileSync(
    join(
      projectDir,
      choices.candidate.descriptor.harnessDir,
      "tools",
      "data",
      "aidlc-manifest.json",
    ),
    "utf-8",
  )) as { files?: Record<string, string> };
  const count = Object.keys(manifest.files ?? {}).length;
  process.stdout.write(
    `\n  Writing project files ... ${successText("done", process.stdout)}  (${choices.candidate.descriptor.harnessDir}/ and aidlc/, ${count} files)\n`,
  );
  process.stdout.write(
    `  Recording your choices ... ${successText("done", process.stdout)}  (${
      choices.target === "project"
        ? "aidlc.settings.json in this project"
        : choices.target === "local"
        ? "aidlc.settings.local.json in this project"
        : settingsPathForTarget(projectDir, choices.target)
    })\n`,
  );
  const remaining = postApplyOutstandingActions(
    projectDir,
    choices.candidate.descriptor.harnessDir,
    modelHarness(choices.candidate.stamp.distribution),
  );
  if (
    choices.provider === "other" &&
    !remaining.some((action) => action.section === "providers")
  ) {
    remaining.push({
      section: "providers",
      id: "provider-manual-setup",
      message: "Choose and configure a model provider, then acknowledge the completed setup.",
      command: configCommandForHarness(
        choices.candidate.descriptor.harnessDir,
        "providers",
      ),
    });
  }
  if (remaining.length > 0) {
    process.stdout.write(
      `\n  ${remaining.length === 1 ? "One thing needs you" : `${remaining.length} things need you`} - ${
        remaining.length === 1 ? "it can't" : "they can't"
      } be done automatically:\n\n`,
    );
    for (const action of remaining) {
      if (action.id === "runtime-aidlc-missing") {
        process.stdout.write(
          "    Hooks run outside your interactive shell PATH, and aidlc is not available there.\n",
        );
        for (const line of firstRunPathRemediation(process.platform, binRoot())) {
          process.stdout.write(`    ${line}\n`);
        }
        process.stdout.write("\n");
        process.stdout.write(
          `    Full diagnostics: ${
            configCommandForHarness(
              choices.candidate.descriptor.harnessDir,
              "runtime --show",
            )
          }\n\n`,
        );
        continue;
      }
      process.stdout.write(`    ${action.message}\n`);
      process.stdout.write(`    fix: ${action.command}\n\n`);
    }
  }
  const [open, invoke] = firstRunNextCommands(
    choices.candidate.stamp.distribution,
  );
  process.stdout.write("  Setup complete. Start your first workflow:\n\n");
  process.stdout.write(`    ${open}\n`);
  process.stdout.write(`    ${invoke}\n`);
}

function customizeFirstRun(
  initial: InstalledSourceCandidate,
  candidates: readonly InstalledSourceCandidate[],
  detection: FirstRunDetection,
): FirstRunChoices | null {
  const aws = awsSummary(detection.aws);
  const choices: FirstRunChoices = {
    candidate: initial,
    provider: detection.aws.hasCredentials ? "amazon-bedrock" : "other",
    region: aws.region,
    profile: "",
    preset: "balanced",
    plugins: "all",
    pluginLabel: "all installed",
    mcp: initial.stamp.distribution === "claude" ? "defaults" : "none",
    target: "project",
    providerVerified: detection.bedrockReachable === true,
    opencodeDefault: true,
  };
  const editStep = (step: number): void => {
    if (step === 1) {
      process.stdout.write("  Step 1 of 6 - Harness\n");
      const detected = detectedCandidateChoices(candidates, detection);
      process.stdout.write(
        `  Detected on this machine: ${
          detected.length > 0
            ? detected.map((item) => item.descriptor.productName).join(", ")
            : "none"
        }.\n\n`,
      );
      choices.candidate = chooseHarness(
        candidates,
        detection,
        choices.candidate.stamp.distribution,
      );
      choices.mcp = choices.candidate.stamp.distribution === "claude"
        ? "defaults"
        : "none";
      return;
    }
    if (step === 2) {
      process.stdout.write("  Step 2 of 6 - Model provider\n");
      process.stdout.write(
        detection.aws.hasCredentials
          ? `  Found AWS credentials (${aws.source}); ${
              aws.regionSource === "detected" ? "detected" : "fallback"
            } region ${aws.region}.\n`
          : "  No AWS credentials were detected.\n",
      );
      process.stdout.write(`    1. amazon-bedrock   ${
        detection.aws.hasCredentials ? "(detected, default)" : ""
      }\n`);
      process.stdout.write("    2. other            record your own provider setup\n");
      const selected = promptChoice(
        "  Provider",
        2,
        detection.aws.hasCredentials ? 1 : 2,
      );
      choices.provider = selected === 1 ? "amazon-bedrock" : "other";
      if (choices.provider === "amazon-bedrock") {
        choices.region = promptTextDefault("  AWS region", choices.region);
        const profile = promptTextDefault(
          "  AWS profile",
          choices.profile || "default credential chain",
        );
        choices.profile = profile === "default credential chain" ? "" : profile;
        if (choices.candidate.stamp.distribution === "opencode") {
          choices.opencodeDefault = promptYesDefault(
            "  Make Bedrock OpenCode's default provider",
            choices.opencodeDefault,
          );
        }
        process.stdout.write(
          `  Using amazon-bedrock in ${choices.region} with ${
            choices.profile || "the default credential chain"
          }.\n\n`,
        );
      } else {
        process.stdout.write("  Using other provider setup.\n\n");
      }
      return;
    }
    if (step === 3) {
      process.stdout.write("  Step 3 of 6 - Model effort preset\n");
      process.stdout.write("    1. balanced    reviewing at medium effort - the shipped default\n");
      process.stdout.write("    2. thorough    reviewing at xhigh effort - deepest correctness checking; slower, costlier reviews\n");
      process.stdout.write("    3. minimal     lightest touch - review medium, write-ups at low effort\n");
      const selected = promptChoice(
        "  Preset",
        3,
        choices.preset === "balanced" ? 1 : choices.preset === "thorough" ? 2 : 3,
      );
      choices.preset = selected === 1 ? "balanced" : selected === 2 ? "thorough" : "minimal";
      process.stdout.write(`  Using the ${choices.preset} preset.\n\n`);
      return;
    }
    if (step === 4) {
      process.stdout.write("  Step 4 of 6 - Plugins\n");
      process.stdout.write("    1. all installed   (default)\n");
      process.stdout.write("    2. none optional   core AI-DLC only\n");
      process.stdout.write("    3. choose          comma-separated installed names\n");
      const selected = promptChoice("  Plugins", 3, 1);
      if (selected === 1) {
        choices.plugins = "all";
        choices.pluginLabel = "all installed";
      } else if (selected === 2) {
        choices.plugins = "aidlc";
        choices.pluginLabel = "none optional";
      } else {
        choices.plugins = promptTextDefault("  Plugin names", "aidlc");
        choices.pluginLabel = choices.plugins;
      }
      process.stdout.write(`  Using ${choices.pluginLabel} plugins.\n\n`);
      return;
    }
    if (step === 5) {
      process.stdout.write("  Step 5 of 6 - MCP servers\n");
      process.stdout.write("    1. on\n    2. off\n");
      const selected = promptChoice(
        "  MCP",
        2,
        choices.mcp === "defaults" ? 1 : 2,
      );
      choices.mcp = selected === 1 ? "defaults" : "none";
      process.stdout.write(`  MCP servers ${selected === 1 ? "on" : "off"}.\n\n`);
      return;
    }
    process.stdout.write("  Step 6 of 6 - Where to record these choices\n");
    process.stdout.write("    1. this project, committed     aidlc.settings.json - shared with your team  (default)\n");
    process.stdout.write("    2. this project, just for you  aidlc.settings.local.json - gitignored\n");
    process.stdout.write("    3. this machine                every project you set up here\n");
    const selected = promptChoice(
      "  Record in",
      3,
      choices.target === "project" ? 1 : choices.target === "local" ? 2 : 3,
    );
    choices.target = selected === 1 ? "project" : selected === 2 ? "local" : "global";
    process.stdout.write(`  Recording choices in ${firstRunSettingsTargetLabel(choices.target)}.\n\n`);
  };

  process.stdout.write("\n  Customize setup - 6 steps, Enter accepts the [default].\n\n");
  for (let step = 1; step <= 6; step++) editStep(step);
  while (true) {
    process.stdout.write("  Your choices - Enter to apply, or a number to change:\n");
    process.stdout.write(`    1. Harness      ${choices.candidate.descriptor.productName}\n`);
    process.stdout.write(`    2. Provider     ${
      choices.provider === "amazon-bedrock"
        ? `amazon-bedrock, ${choices.region}, ${choices.profile || "default credential chain"}`
        : "other"
    }\n`);
    process.stdout.write(`    3. Preset       ${choices.preset}\n`);
    process.stdout.write(`    4. Plugins      ${choices.pluginLabel}\n`);
    process.stdout.write(`    5. MCP          ${choices.mcp === "defaults" ? "on" : "off"}\n`);
    process.stdout.write(`    6. Record in    ${firstRunSettingsTargetLabel(choices.target)}\n`);
    const value = firstRunPromptValue(configPrompt("  Apply? [Y/n]:")).toLowerCase();
    if (!value || value === "y" || value === "yes") return choices;
    if (value === "n" || value === "no") {
      process.stdout.write("\n  Nothing written.\n");
      return null;
    }
    if (/^[1-6]$/.test(value)) {
      process.stdout.write("\n");
      editStep(Number(value));
      continue;
    }
    process.stdout.write("\n  Enter y, n, or a step number from 1 to 6.\n\n");
  }
}

async function runFirstRunWizard(projectDir: string): Promise<boolean> {
  try {
  const candidates = installedSourceCandidates();
  if (candidates.length === 0) return false;
  const detection = detectFirstRun(projectDir, candidates);
  const detected = detectedCandidateChoices(candidates, detection);
  let candidate: InstalledSourceCandidate;
  if (detected.length === 1) {
    candidate = detected[0];
  } else if (detected.length > 1) {
    process.stdout.write("\n  Choose the harness for this project first.\n\n");
    candidate = chooseHarness(candidates, detection, detected[0].stamp.distribution);
  } else {
    process.stdout.write("\n  No supported harness CLI was detected. Choose one to configure:\n\n");
    candidate = chooseHarness(candidates, detection);
  }
  const aws = awsSummary(detection.aws);
  const runtimeCount = detection.runtimeIssues.length;
  process.stdout.write("\n  AI-DLC setup - first run in this project.\n\n");
  process.stdout.write("  Checked your machine and this repo:\n\n");
  const harnessDetection = detection.harnesses[candidate.stamp.distribution];
  const displayedVersion = harnessDetection?.version
    ? /\d+\.\d+\.\d+(?:[-+][^\s)]+)?/.exec(harnessDetection.version)?.[0] ??
      harnessDetection.version
    : undefined;
  process.stdout.write(
    `    Harness    ${candidate.descriptor.productName} ${
      harnessDetection?.found ? "detected" : "selected"
    }${
      displayedVersion
        ? `  (${displayedVersion} on your PATH)`
        : harnessDetection?.probed === false
        ? "  (CLI not probed)"
        : ""
    }\n`,
  );
  process.stdout.write(
    `    Project    ${
      existsSync(join(projectDir, ".git")) ? "git repo" : "project directory"
    }, no AI-DLC files yet\n`,
  );
  process.stdout.write(
    `    AWS        ${
      detection.aws.hasCredentials
        ? `credentials found  (${aws.source}, ${
            aws.regionSource === "detected" ? "detected" : "fallback"
          } region ${aws.region})`
        : "credentials not found"
    }\n`,
  );
  process.stdout.write(
    `    Runtime    ${
      runtimeCount === 0
        ? "ready"
        : `${runtimeCount === 1 ? "one" : runtimeCount} PATH fix${
            runtimeCount === 1 ? "" : "es"
          } needed - shown at the end`
    }\n\n`,
  );
  process.stdout.write(
    `  Set up AI-DLC for ${candidate.descriptor.productName} with recommended defaults?\n\n`,
  );
  process.stdout.write(
    `    1. Yes, use recommended defaults   ${
      candidate.stamp.distribution === "claude" ? "MCP servers on, " : ""
    }all plugins, ${
      detection.aws.hasCredentials
        ? "Bedrock via your AWS credentials"
        : "provider recorded as other; manual provider setup remains"
    }\n`,
  );
  process.stdout.write(
    "    2. No, customize step by step      harness, provider, preset, plugins, MCP, record layer\n",
  );
  process.stdout.write("    3. Exit, nothing written\n\n");
  const selected = promptChoice("  Choice", 3, 1);
  if (selected === 3) {
    process.stdout.write("\n  Nothing written.\n");
    return true;
  }
  let choices: FirstRunChoices | null;
  if (selected === 1) {
    choices = {
      candidate,
      provider: detection.aws.hasCredentials ? "amazon-bedrock" : "other",
      region: aws.region,
      profile: "",
      preset: "balanced",
      plugins: "all",
      pluginLabel: "all installed",
      mcp: candidate.stamp.distribution === "claude" ? "defaults" : "none",
      target: "project",
      providerVerified: detection.bedrockReachable === true,
      opencodeDefault: true,
    };
  } else {
    choices = customizeFirstRun(candidate, candidates, detection);
  }
  if (!choices) return true;
  const snapshot = snapshotFirstRunMutationPaths(projectDir, choices);
  let preserveSnapshot = false;
  try {
    applyFirstRunChoices(projectDir, choices, snapshot);
    renderFirstRunEnding(projectDir, choices);
  } catch (error) {
    try {
      snapshot.restore();
    } catch (rollbackError) {
      preserveSnapshot = true;
      throw new AggregateError(
        [error, rollbackError],
        `setup failed and rollback was incomplete; recovery snapshot preserved at ${snapshot.recoveryPath}`,
      );
    }
    process.stdout.write(
      `\n  Setup stopped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stdout.write("  No setup changes were kept.\n");
    process.exitCode = EXIT.failure;
  } finally {
    if (!preserveSnapshot) snapshot.cleanup();
  }
  return true;
  } catch (error) {
    if (error instanceof FirstRunCancelled) {
      process.stdout.write("\n  Nothing written.\n");
      process.exitCode = EXIT.usage;
      return true;
    }
    throw error;
  }
}

function existingProject(projectDir: string, requested?: string): {
  distribution?: string;
  baseline?: Baseline;
} {
  const harnesses = discoverProjectHarnesses(projectDir);
  const harness = requested
    ? harnesses.find((candidate) => candidate.distribution === requested)
    : harnesses[0];
  if (!harness && requested && harnesses.length > 0) {
    throw new Error(
      `project uses ${harnesses.map((candidate) => candidate.distribution).join(", ")}; refusing ${requested}`,
    );
  }
  if (!harness) return {};
  const baselinePath = join(harness.root, "tools", "data", "aidlc-manifest.json");
  const baseline = readBaseline(baselinePath);
  if (
    baseline &&
    (
      baseline.distribution !== harness.distribution ||
      baseline.harnessDir !== harness.harnessDir
    )
  ) {
    throw new Error(`${baselinePath}: baseline identity does not match the installed harness`);
  }
  return {
    distribution: harness.distribution,
    ...(baseline ? { baseline } : {}),
  };
}

function planManagedFiles(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
  nextHashes: Record<string, string>,
  regenerated: ReadonlySet<string>,
): void {
  const shipped = new Set<string>();
  for (const directory of descriptor.managedDirectories) {
    const sourceDir = join(sourceRoot, directory);
    if (!existsSync(sourceDir)) throw new Error(`projection is missing managed directory ${directory}`);
    for (const nested of walkFiles(sourceDir)) {
      const rel = join(directory, nested).replaceAll("\\", "/");
      shipped.add(rel);
      const source = join(sourceRoot, rel);
      const target = join(projectDir, rel);
      const targetExists = pathPresent(target);
      const targetRegular = targetExists && lstatSync(target).isFile();
      const hash = sha256File(source);
      const adoptedManagedFile = prior === null &&
        targetRegular &&
        (
          descriptor.legacyManagedFileHashes?.[rel]?.includes(
            sha256File(target),
          ) ?? false
        );
      const seedOnly = rel === "aidlc/active-space" ||
        (rel.startsWith("aidlc/spaces/") && rel.includes("/memory/"));
      if (seedOnly) {
        if (targetExists) {
          actions.push({ path: rel, action: "preserve", detail: "project-owned seed" });
        } else {
          operations.push({
            kind: "copy",
            path: rel,
            source,
            sourceHash: hash,
            expected: "absent",
            mode: statSync(source).mode & 0o777,
          });
          actions.push({ path: rel, action: "create" });
        }
        continue;
      }
      if (runtimeGenerated(rel, descriptor.harnessDir, regenerated)) {
        if (
          ![
            `${descriptor.harnessDir}/tools/data/harness.json`,
            `${descriptor.harnessDir}/tools/data/stage-graph.json`,
            `${descriptor.harnessDir}/tools/data/scope-grid.json`,
          ].includes(rel)
        ) {
          nextHashes[rel] = hash;
        }
        if (targetRegular && sha256File(target) === hash) {
          actions.push({ path: rel, action: "preserve", detail: "runtime-generated" });
          continue;
        }
        if (targetExists && !targetRegular && !force) {
          actions.push({ path: rel, action: "conflict", detail: "managed path is not a regular file" });
          continue;
        }
        operations.push({
          kind: "copy",
          path: rel,
          source,
          sourceHash: hash,
          expected: expected(target),
          mode: statSync(source).mode & 0o777,
        });
        actions.push({
          path: rel,
          action: targetExists ? "update" : "create",
          detail: "runtime-generated",
        });
        continue;
      }
      nextHashes[rel] = hash;
      if (targetRegular && sha256File(target) === hash) {
        actions.push({ path: rel, action: "preserve" });
        continue;
      }
      const priorHash = prior?.files[rel];
      if (
        targetExists &&
        (
          !targetRegular ||
          (!adoptedManagedFile && (!priorHash || sha256File(target) !== priorHash))
        ) &&
        !force
      ) {
        actions.push({ path: rel, action: "conflict", detail: "locally modified or unowned" });
        continue;
      }
      operations.push({
        kind: "copy",
        path: rel,
        source,
        sourceHash: hash,
        expected: expected(target),
        mode: statSync(source).mode & 0o777,
      });
      actions.push({
        path: rel,
        action: targetExists ? "update" : "create",
        detail: adoptedManagedFile ? "adopted exact copy-channel signature" : undefined,
      });
    }
  }
  for (const [rel, priorHash] of Object.entries(prior?.files ?? {})) {
    if (shipped.has(rel) || rel.endsWith("/tools/data/aidlc-manifest.json")) continue;
    const target = join(projectDir, rel);
    if (!pathPresent(target)) continue;
    if ((!regularFile(target) || sha256File(target) !== priorHash) && !force) {
      actions.push({ path: rel, action: "conflict", detail: "removed upstream but locally modified" });
      continue;
    }
    operations.push({ kind: "remove", path: rel, expected: expected(target) });
    actions.push({ path: rel, action: "remove" });
  }
}

function planRootIntegrations(
  projectDir: string,
  sourceRoot: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  mcpMode: "defaults" | "none",
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
  contributions: Record<string, RootContribution>,
): void {
  for (const integration of descriptor.rootIntegrations) {
    const sourcePath = join(sourceRoot, integration.path);
    const targetPath = join(projectDir, integration.path);
    const targetExists = pathPresent(targetPath);
    const targetRegular = targetExists && lstatSync(targetPath).isFile();
    if (targetExists && !targetRegular && !force) {
      actions.push({
        path: integration.path,
        action: "conflict",
        detail: "root integration is not a regular file",
      });
      continue;
    }
    const current = targetRegular ? readFileSync(targetPath, "utf-8") : "";
    const priorContribution = prior?.rootContributions[integration.path];
    if (integration.policy === "managed-block") {
      const merged = mergeBlock(
        integration.path,
        current,
        readFileSync(sourcePath, "utf-8"),
        integration.marker || basename(integration.path),
        integration.legacySignatures?.wholeFileHashes,
      );
      if (merged.error) {
        actions.push({ path: integration.path, action: "conflict", detail: merged.error });
        continue;
      }
      const value = merged.value as string;
      const priorHash = priorContribution?.policy === "managed-block"
        ? priorContribution.hash
        : undefined;
      if (
        merged.currentHash &&
        merged.currentHash !== merged.nextHash &&
        merged.currentHash !== priorHash &&
        !force
      ) {
        actions.push({
          path: integration.path,
          action: "conflict",
          detail: priorHash ? "managed block was locally modified" : "managed block has no ownership baseline",
        });
        continue;
      }
      contributions[integration.path] = {
        policy: "managed-block",
        hash: merged.nextHash as string,
        marker: integration.marker,
      };
      if (value === current) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(integration.path, value, expected(targetPath)));
        actions.push({
          path: integration.path,
          action: targetExists ? "merge" : "create",
          detail: merged.adoptedLegacy ? "adopted exact legacy signature" : undefined,
        });
      }
      continue;
    }
    if (integration.policy === "json-map") {
      let targetValue: unknown;
      let sourceValue: unknown;
      try {
        targetValue = current ? JSON.parse(current) : {};
        sourceValue = JSON.parse(readFileSync(sourcePath, "utf-8"));
      } catch {
        actions.push({ path: integration.path, action: "conflict", detail: "malformed JSON" });
        continue;
      }
      if (!isRecord(targetValue) || !isRecord(sourceValue)) {
        actions.push({ path: integration.path, action: "conflict", detail: "JSON root must be an object" });
        continue;
      }
      const target = targetValue;
      const source = sourceValue;
      const key = integration.jsonKey as string;
      const rawTargetMap = target[key] ?? {};
      const rawSourceMap = source[key] ?? {};
      if (!isRecord(rawTargetMap) || !isRecord(rawSourceMap)) {
        actions.push({
          path: integration.path,
          action: "conflict",
          detail: `${key} must be a JSON object`,
        });
        continue;
      }
      const targetMap = { ...rawTargetMap };
      const sourceMap = rawSourceMap;
      const priorEntries = priorContribution?.policy === "json-map"
        ? priorContribution.entries
        : {};
      const nextEntries: Record<string, string> = {};
      if (!current && integration.optional && mcpMode === "none") {
        contributions[integration.path] = {
          policy: "json-map",
          entries: {},
          key: integration.jsonKey,
        };
        actions.push({ path: integration.path, action: "preserve", detail: "optional integration disabled" });
        continue;
      }
      if (mcpMode === "defaults") {
        for (const [entry, value] of Object.entries(sourceMap)) {
          const desiredHash = sha256Bytes(canonical(value));
          if (!(entry in targetMap)) {
            targetMap[entry] = value;
            nextEntries[entry] = desiredHash;
            continue;
          }
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          const priorHash = priorEntries[entry];
          if (priorHash && (currentHash === priorHash || force)) {
            targetMap[entry] = value;
            nextEntries[entry] = desiredHash;
          } else if (priorHash && currentHash === desiredHash) {
            nextEntries[entry] = desiredHash;
          } else if (
            !priorHash &&
            (integration.legacySignatures?.jsonEntryHashes?.[entry] ?? []).includes(currentHash)
          ) {
            targetMap[entry] = value;
            nextEntries[entry] = desiredHash;
          }
        }
        for (const [entry, priorHash] of Object.entries(priorEntries)) {
          if (entry in sourceMap || !(entry in targetMap)) continue;
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          if (currentHash === priorHash || force) delete targetMap[entry];
        }
      } else {
        for (const [entry, priorHash] of Object.entries(priorEntries)) {
          if (!(entry in targetMap)) continue;
          const currentHash = sha256Bytes(canonical(targetMap[entry]));
          if (currentHash === priorHash || force) {
            delete targetMap[entry];
          }
        }
      }
      if (Object.keys(targetMap).length > 0) target[key] = targetMap;
      else delete target[key];
      contributions[integration.path] = {
        policy: "json-map",
        entries: nextEntries,
        key: integration.jsonKey,
      };
      const semanticChanged = canonical(targetValue) !== canonical(current ? JSON.parse(current) : {});
      if (!semanticChanged) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        const value = `${JSON.stringify(target, null, 2)}\n`;
        operations.push(writeOperation(integration.path, value, expected(targetPath)));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    if (integration.policy === "json-array") {
      let targetValue: unknown;
      let sourceValue: unknown;
      try {
        targetValue = current ? JSON.parse(current) : {};
        sourceValue = JSON.parse(readFileSync(sourcePath, "utf-8"));
      } catch {
        actions.push({ path: integration.path, action: "conflict", detail: "malformed JSON" });
        continue;
      }
      if (!isRecord(targetValue) || !isRecord(sourceValue)) {
        actions.push({ path: integration.path, action: "conflict", detail: "JSON root must be an object" });
        continue;
      }
      const key = integration.jsonKey as string;
      const targetArray = targetValue[key] ?? [];
      const sourceArray = sourceValue[key] ?? [];
      if (
        !Array.isArray(targetArray) ||
        !Array.isArray(sourceArray) ||
        !targetArray.every((item) => typeof item === "string") ||
        !sourceArray.every((item) => typeof item === "string")
      ) {
        actions.push({ path: integration.path, action: "conflict", detail: `${key} must be a string array` });
        continue;
      }
      const priorEntries = priorContribution?.policy === "json-array"
        ? priorContribution.entries
        : {};
      const desired = new Map(
        sourceArray.map((item) => [item, sha256Bytes(canonical(item))]),
      );
      const nextEntries: Record<string, string> = {};
      const retained = targetArray.filter((item) => {
        const priorHash = priorEntries[item];
        if (priorHash && desired.has(item)) nextEntries[item] = desired.get(item) as string;
        return !priorHash || desired.has(item) || sha256Bytes(canonical(item)) !== priorHash;
      });
      for (const item of sourceArray) {
        if (!retained.includes(item)) {
          retained.push(item);
          nextEntries[item] = desired.get(item) as string;
        }
      }
      if (retained.length > 0) targetValue[key] = retained;
      else delete targetValue[key];
      contributions[integration.path] = {
        policy: "json-array",
        entries: nextEntries,
        key,
      };
      const semanticChanged = canonical(targetValue) !== canonical(current ? JSON.parse(current) : {});
      if (!semanticChanged) {
        actions.push({ path: integration.path, action: "preserve" });
      } else {
        operations.push(writeOperation(
          integration.path,
          `${JSON.stringify(targetValue, null, 2)}\n`,
          expected(targetPath),
        ));
        actions.push({ path: integration.path, action: targetExists ? "merge" : "create" });
      }
      continue;
    }
    const shipped = readFileSync(sourcePath);
    const shippedHash = sha256Bytes(shipped);
    const priorHash = priorContribution?.policy === "whole-file"
      ? priorContribution.hash
      : undefined;
    const currentHash = sha256Bytes(current);
    const adoptedLegacy = integration.legacySignatures?.wholeFileHashes?.includes(currentHash) ?? false;
    contributions[integration.path] = { policy: "whole-file", hash: shippedHash };
    if (
      targetExists &&
      currentHash !== priorHash &&
      currentHash !== shippedHash &&
      !adoptedLegacy
    ) {
      actions.push({ path: integration.path, action: "conflict", detail: "unowned whole file" });
    } else if (currentHash === shippedHash) {
      actions.push({ path: integration.path, action: "preserve" });
    } else {
      operations.push(writeOperation(integration.path, shipped, expected(targetPath)));
      actions.push({
        path: integration.path,
        action: targetExists ? "update" : "create",
        detail: adoptedLegacy ? "adopted exact legacy signature" : undefined,
      });
    }
  }
}

function planRemovedRootIntegrations(
  projectDir: string,
  descriptor: ProjectionDescriptor,
  prior: Baseline | null,
  force: boolean,
  operations: TransactionOperation[],
  actions: PlannedAction[],
): void {
  const current = new Set(descriptor.rootIntegrations.map((item) => item.path));
  for (const [path, contribution] of Object.entries(prior?.rootContributions ?? {})) {
    if (current.has(path)) continue;
    const targetPath = join(projectDir, path);
    if (!pathPresent(targetPath)) continue;
    if (!regularFile(targetPath)) {
      if (!force) {
        actions.push({ path, action: "conflict", detail: "retired root integration is not a regular file" });
        continue;
      }
      operations.push({ kind: "remove", path, expected: expected(targetPath) });
      actions.push({ path, action: "remove" });
      continue;
    }
    const text = readFileSync(targetPath, "utf-8");
    if (contribution.policy === "managed-block") {
      const fallback = basename(path).replace(/\.[^.]+$/, "").toLowerCase();
      const { begin, end } = managedBlockMarkers(
        path,
        contribution.marker ?? fallback,
      );
      const beginAt = text.indexOf(begin);
      const endAt = text.indexOf(end, beginAt + begin.length);
      if (beginAt < 0 || endAt < beginAt) {
        actions.push({ path, action: "conflict", detail: "retired managed block markers are missing" });
        continue;
      }
      const blockEnd = endAt + end.length;
      if (sha256Bytes(text.slice(beginAt, blockEnd)) !== contribution.hash && !force) {
        actions.push({ path, action: "conflict", detail: "retired managed block was locally modified" });
        continue;
      }
      let value = `${text.slice(0, beginAt)}${text.slice(blockEnd)}`;
      value = value.replace(/^\r?\n/, "").replace(/\r?\n\r?\n$/, "\n");
      if (!value) {
        operations.push({ kind: "remove", path, expected: expected(targetPath) });
        actions.push({ path, action: "remove" });
      } else {
        operations.push(writeOperation(path, value, expected(targetPath)));
        actions.push({ path, action: "merge", detail: "removed retired managed block" });
      }
      continue;
    }
    if (contribution.policy === "json-map") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        actions.push({ path, action: "conflict", detail: "retired JSON integration is malformed" });
        continue;
      }
      if (!isRecord(parsed)) {
        actions.push({ path, action: "conflict", detail: "retired JSON integration root is not an object" });
        continue;
      }
      const maps = contribution.key && isRecord(parsed[contribution.key])
        ? [parsed[contribution.key] as Record<string, unknown>]
        : Object.values(parsed).filter(isRecord);
      let conflict = false;
      for (const [entry, priorHash] of Object.entries(contribution.entries)) {
        for (const map of maps) {
          if (!(entry in map)) continue;
          if (sha256Bytes(canonical(map[entry])) !== priorHash && !force) conflict = true;
          else delete map[entry];
        }
      }
      if (conflict) {
        actions.push({ path, action: "conflict", detail: "retired JSON entry was locally modified" });
        continue;
      }
      operations.push(writeOperation(path, `${JSON.stringify(parsed, null, 2)}\n`, expected(targetPath)));
      actions.push({ path, action: "merge", detail: "removed retired JSON entries" });
      continue;
    }
    if (contribution.policy === "json-array") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        actions.push({ path, action: "conflict", detail: "retired JSON integration is malformed" });
        continue;
      }
      if (!isRecord(parsed) || !Array.isArray(parsed[contribution.key])) {
        actions.push({ path, action: "conflict", detail: "retired JSON array integration is malformed" });
        continue;
      }
      const values = parsed[contribution.key] as unknown[];
      const retired = new Set(Object.keys(contribution.entries));
      parsed[contribution.key] = values.filter((value) =>
        typeof value !== "string" || !retired.has(value) ||
        sha256Bytes(canonical(value)) !== contribution.entries[value]
      );
      if ((parsed[contribution.key] as unknown[]).length === 0) delete parsed[contribution.key];
      operations.push(writeOperation(path, `${JSON.stringify(parsed, null, 2)}\n`, expected(targetPath)));
      actions.push({ path, action: "merge", detail: "removed retired JSON array entries" });
      continue;
    }
    if (sha256File(targetPath) !== contribution.hash && !force) {
      actions.push({ path, action: "conflict", detail: "retired whole-file integration was locally modified" });
      continue;
    }
    operations.push({ kind: "remove", path, expected: expected(targetPath) });
    actions.push({ path, action: "remove" });
  }
}

function prepareModelsSection(
  argv: string[],
  options: ReturnType<typeof globalOptions>,
): { argv: string[]; context: ModelsMutationContext } | null {
  const validation = validateModelsArgs(argv);
  if (validation) {
    emitResult(usage(validation, configCommand("models --help")), options);
    return null;
  }
  if (argv.includes("--help")) {
    process.stdout.write(`${modelPolicyHelp()}\n`);
    process.exitCode = EXIT.ok;
    return null;
  }
  const mutationFlags = [
    "--agent",
    "--deciding-effort",
    "--effort",
    "--from",
    "--model",
    "--preset",
    "--reset",
    "--reviewing-effort",
    "--save-as",
    "--writing-up-effort",
  ];
  const hasMutationFlags = mutationFlags.some((flag) => argv.includes(flag));
  if (
    (argv.includes("--show") || argv.includes("--check")) &&
    (hasMutationFlags || argv.includes("--dry-run") || argv.includes("--yes"))
  ) {
    emitResult(
      usage("--show and --check cannot be combined with model policy mutations"),
      options,
    );
    return null;
  }
  if (argv.includes("--show") && argv.includes("--check")) {
    emitResult(usage("--show and --check are mutually exclusive"), options);
    return null;
  }
  const projectDir = projectDirFrom(argv);
  const requested = valueAfter(argv, "--harness");
  const harnesses = discoverProjectHarnesses(projectDir);
  const selected = requested
    ? harnesses.find((candidate) => candidate.distribution === requested)
    : harnesses[0];
  if (!selected) {
    emitResult(
      usage(
        requested && harnesses.length > 0
          ? `project uses ${harnesses.map((item) => item.distribution).join(", ")}; refusing ${requested}`
          : `${configCommand("models")} requires an installed project harness; run ${configCommand()} first`,
      ),
      options,
    );
    return null;
  }
  if (!requested && harnesses.length > 1) {
    emitResult(
      usage("multiple project harnesses are present; pass one --harness <name>"),
      options,
    );
    return null;
  }
  const harness = modelHarness(selected.distribution);
  const resolved = resolveAidlcSettings(projectDir);
  const current = modelPolicyForHarness(resolved.models, harness);
  const tiers = readAgentTiers(selected.root);
  if (argv.includes("--show")) {
    showModels(current, tiers, harness, projectDir, resolved, options);
    return null;
  }
  if (argv.includes("--check")) {
    const drift = modelPolicySurfaceDrift(
      projectDir,
      selected.harnessDir,
      harness,
      current,
    );
    emitResult(
      drift.length === 0
        ? success(`model policy is reflected on ${harness}`, {
            harness,
            drift: [],
          })
        : failure(
            `model policy drift: ${drift.join("; ")}`,
            EXIT.failure,
            configCommand("models --show"),
          ),
      options,
    );
    return null;
  }

  if (!hasMutationFlags && !configInputIsTty()) {
    emitResult(
      usage(
        "non-interactive model configuration requires a policy flag: --preset, --from, a group effort flag, --agent, or --reset; --yes confirms but never chooses a policy",
        configCommand("models --help"),
      ),
      options,
    );
    return null;
  }
  const target = settingsTargetForMutation(argv, projectDir);
  const targetPath = settingsPathForTarget(projectDir, target);
  const targetCurrentSettings = readSettingsTarget(projectDir, target);
  const targetCurrent = modelPolicyForHarness(
    targetCurrentSettings?.models ?? null,
    harness,
  );
  let targetNext: ModelPolicyRecord | null;
  if (hasMutationFlags) {
    targetNext = applyModelsFlags(targetCurrent, argv, tiers, current);
  } else {
    targetNext = modelsWizard(
      current,
      targetCurrent,
      tiers,
      harness,
      projectDir,
      resolved,
    );
  }
  const targetModels = settingsModelsFromHarnessPolicy(
    targetCurrentSettings?.models ?? null,
    harness,
    targetNext,
  );
  const targetNextSettings = updateSettingsSection(
    targetCurrentSettings,
    "models",
    targetModels,
  );
  if (canonical(targetCurrentSettings) === canonical(targetNextSettings)) {
    emitResult(success("model policy unchanged"), options);
    return null;
  }
  const nextResolved = resolveAidlcSettingsWithOverride(
    projectDir,
    target,
    targetNextSettings,
  );
  const next = modelPolicyForHarness(nextResolved.models, harness);
  if (!argv.includes("--dry-run") && !options.yes) {
    if (!configInputIsTty()) {
      emitResult(
        usage(
          "non-interactive model policy mutation requires --yes; --yes confirms the selected policy but never chooses one",
          configMutationRerun("models", argv),
        ),
        options,
      );
      return null;
    }
    const answer = configPrompt("Apply model policy changes? [y/N]:");
    if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
      emitResult(usage("model policy change cancelled"), options);
      return null;
    }
  }
  const summary = modelSummaryLines(current, next, tiers, harness, projectDir);
  return {
    argv: modelsPipelineArgv(argv),
    context: {
      harness,
      harnessDir: selected.harnessDir,
      previous: current,
      next,
      tiers,
      summaryLines: summary.lines,
      notes: summary.notes,
      settings: {
        target,
        path: targetPath,
        previous: targetCurrentSettings,
        next: targetNextSettings,
      },
    },
  };
}

function handleSettingsOnlySection(
  section: "models" | "flags",
  argv: string[],
  options: ReturnType<typeof globalOptions>,
): boolean {
  const projectDir = projectDirFrom(argv);
  if (discoverProjectHarnesses(projectDir).length > 0 || argv.includes("--help")) {
    return false;
  }
  const validation = section === "models"
    ? validateModelsArgs(argv)
    : validateChoiceArgs("flags", argv);
  if (validation) {
    emitResult(usage(validation, configCommand(`${section} --help`)), options);
    return true;
  }
  const modelMutationFlags = [
    "--agent",
    "--deciding-effort",
    "--effort",
    "--from",
    "--model",
    "--preset",
    "--reset",
    "--reviewing-effort",
    "--save-as",
    "--writing-up-effort",
  ];
  const flagMutationFlags = [
    "--bypass",
    "--clear-bypass",
    "--default-scope",
    "--hook-debug",
    "--reset",
    "--sensor-timeout-ms",
    "--swarm",
  ];
  const mutationFlags = section === "models" ? modelMutationFlags : flagMutationFlags;
  const inspecting = argv.includes("--show") || argv.includes("--check");
  if (
    inspecting &&
    (
      mutationFlags.some((flag) => argv.includes(flag)) ||
      argv.includes("--dry-run") ||
      argv.includes("--yes")
    )
  ) {
    emitResult(
      usage(`--show and --check cannot be combined with ${section} mutations`),
      options,
    );
    return true;
  }
  if (argv.includes("--show") && argv.includes("--check")) {
    emitResult(usage("--show and --check are mutually exclusive"), options);
    return true;
  }
  let resolved: ResolvedAidlcSettings;
  try {
    resolved = resolveAidlcSettings(projectDir);
  } catch (error) {
    emitResult(failure(
      error instanceof Error ? error.message : String(error),
      EXIT.usage,
    ), options);
    return true;
  }
  if (argv.includes("--show")) {
    emitResult(success(
      `${section} settings without an installed harness`,
      section === "models"
        ? {
            policy: resolved.models,
            sources: resolved.sources,
            effective: [],
          }
        : {
            record: resolved.flags,
            effective: effectiveProjectFlagValues(resolved.flags),
            sources: resolved.sources,
          },
    ), options);
    return true;
  }
  if (argv.includes("--check")) {
    emitResult(success(`${section} settings files are valid`, {
      files: resolved.files,
    }), options);
    return true;
  }
  if (!mutationFlags.some((flag) => argv.includes(flag))) {
    emitResult(usage(
      `non-interactive ${section} configuration requires an explicit policy flag`,
      configCommand(`${section} --help`),
    ), options);
    return true;
  }
  try {
    const target = settingsTargetForMutation(argv, projectDir);
    const path = settingsPathForTarget(projectDir, target);
    const currentFile = readSettingsTarget(projectDir, target);
    let nextFile: AidlcSettingsFile | null;
    if (section === "models") {
      const requestedHarness = valueAfter(argv, "--harness");
      const harness = requestedHarness ? modelHarness(requestedHarness) : "claude";
      if (argv.includes("--model") && !requestedHarness) {
        throw new Error(
          "outside an installed harness, --agent ... --model requires --harness so the model ID is stored under one harness key",
        );
      }
      const currentEffective = modelPolicyForHarness(resolved.models, harness);
      const currentTarget = modelPolicyForHarness(
        currentFile?.models ?? null,
        harness,
      );
      const agent = valueAfter(argv, "--agent");
      const tiers: AgentTiers = agent ? { [agent]: "judgment" } : {};
      const nextPolicy = applyModelsFlags(
        currentTarget,
        argv,
        tiers,
        currentEffective,
      );
      nextFile = updateSettingsSection(
        currentFile,
        "models",
        settingsModelsFromHarnessPolicy(
          currentFile?.models ?? null,
          harness,
          nextPolicy,
        ),
      );
    } else {
      if (argv.includes("--default-scope")) {
        throw new Error(
          "--default-scope requires an installed project harness so the scope name can be validated",
        );
      }
      const nextFlags = argv.includes("--reset")
        ? null
        : buildFlagsRecord(currentFile?.flags ?? null, argv, projectDir);
      nextFile = updateSettingsSection(currentFile, "flags", nextFlags);
    }
    if (canonical(currentFile) === canonical(nextFile)) {
      emitResult(success(`${section} configuration unchanged`), options);
      return true;
    }
    const mutation: SettingsMutation = {
      target,
      path,
      previous: currentFile,
      next: nextFile,
    };
    if (argv.includes("--dry-run")) {
      emitResult(success(`${section} settings plan`, {
        target,
        path,
        previous: currentFile,
        next: nextFile,
      }), options);
      return true;
    }
    if (!options.yes) {
      emitResult(usage(
        `non-interactive ${section} mutation requires --yes; --yes confirms but never chooses`,
        configMutationRerun(section, argv),
      ), options);
      return true;
    }
    if (target === "global") {
      executeGlobalSettingsMutation(mutation);
    } else {
      const operations: TransactionOperation[] = [];
      const actions: PlannedAction[] = [];
      planProjectSettingsMutation(projectDir, mutation, operations, actions);
      executePlan({ schemaVersion: 1, root: projectDir, operations });
      invalidateSettingsCache(path);
    }
    emitResult(success(
      `configured ${section} settings in ${path}`,
      { target, path },
    ), options);
  } catch (error) {
    emitResult(usage(
      error instanceof Error ? error.message : String(error),
      configCommand(`${section} --help`),
    ), options);
  }
  return true;
}

export async function main(
  input: string[],
  internal: ConfigMainInternal = {},
): Promise<void> {
  let argv = stripVerb(input);
  const options = globalOptions(argv);
  const positionals = configPositionals(argv);
  const section = positionals[0];
  if (section && !VALID_CONFIG_SECTIONS.has(section.value)) {
    if (configInputIsTty() && options.mode === "human") {
      const distance = (left: string, right: string): number => {
        const row = Array.from({ length: right.length + 1 }, (_, index) => index);
        for (let i = 1; i <= left.length; i++) {
          let diagonal = row[0];
          row[0] = i;
          for (let j = 1; j <= right.length; j++) {
            const prior = row[j];
            row[j] = Math.min(
              row[j] + 1,
              row[j - 1] + 1,
              diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
            );
            diagonal = prior;
          }
        }
        return row[right.length];
      };
      const nearest = [...VALID_CONFIG_SECTIONS]
        .map((candidate) => ({
          candidate,
          distance: distance(section.value, candidate),
        }))
        .sort((left, right) =>
          left.distance - right.distance ||
          left.candidate.localeCompare(right.candidate)
        )[0];
      process.stderr.write(
        `${errorLabel("error:", process.stderr)} unknown config section '${section.value}'\n`,
      );
      if (nearest && nearest.distance <= 2) {
        process.stderr.write(
          `\n  ${tipLabel("tip:", process.stderr)} did you mean '${nearest.candidate}'?\n`,
        );
      }
      process.stderr.write(
        `\n${heading("usage:", process.stderr)} ${configCommand("<section> [flags]")}\n`,
      );
      process.stderr.write(
        `For the full list, run '${configCommand("--help")}'.\n`,
      );
      process.exitCode = EXIT.usage;
      return;
    }
    emitResult(
      usage(
        `unknown config section ${JSON.stringify(section.value)}; valid sections: models, runtime, providers, trust, flags, project`,
        configCommand("<models|runtime|providers|trust|flags|project> --help"),
      ),
      options,
    );
    return;
  }
  if (!section) {
    const validation = validateRootConfigArgs(argv);
    if (validation) {
      emitResult(usage(validation, configCommand("--help")), options);
      return;
    }
  }
  if (
    (section?.value === "models" || section?.value === "flags") &&
    handleSettingsOnlySection(section.value, [
      ...argv.slice(0, section.index),
      ...argv.slice(section.index + 1),
    ], options)
  ) {
    return;
  }
  let modelsContext: ModelsMutationContext | null = null;
  let diagnosticsContext: DiagnosticsMutationContext | null = null;
  let choicesContext: ChoicesMutationContext | null = null;
  if (section?.value === "models") {
    argv = [...argv.slice(0, section.index), ...argv.slice(section.index + 1)];
    try {
      const preparedModels = prepareModelsSection(argv, options);
      if (!preparedModels) return;
      argv = preparedModels.argv;
      modelsContext = preparedModels.context;
    } catch (error) {
      emitResult(
        usage(
          error instanceof Error ? error.message : String(error),
          configCommand("models --help"),
        ),
        options,
      );
      return;
    }
  } else if (
    section?.value === "runtime" ||
    section?.value === "providers" ||
    section?.value === "trust"
  ) {
    const diagnosticSection = section.value;
    argv = [...argv.slice(0, section.index), ...argv.slice(section.index + 1)];
    try {
      const preparedDiagnostics = prepareDiagnosticSection(
        diagnosticSection,
        argv,
        options,
      );
      if (!preparedDiagnostics) return;
      argv = preparedDiagnostics.argv;
      diagnosticsContext = preparedDiagnostics.context;
    } catch (error) {
      emitResult(
        usage(
          error instanceof Error ? error.message : String(error),
          configCommand(`${diagnosticSection} --help`),
        ),
        options,
      );
      return;
    }
  } else if (section?.value === "flags" || section?.value === "project") {
    const choiceSection = section.value;
    argv = [...argv.slice(0, section.index), ...argv.slice(section.index + 1)];
    try {
      const preparedChoices = prepareChoiceSection(
        choiceSection,
        argv,
        options,
      );
      if (!preparedChoices) return;
      argv = preparedChoices.argv;
      choicesContext = preparedChoices.context;
    } catch (error) {
      emitResult(
        usage(
          error instanceof Error ? error.message : String(error),
          configCommand(`${choiceSection} --help`),
        ),
        options,
      );
      return;
    }
  }
  if (argv.includes("--pin") || argv.includes("--unpin")) {
    emitResult(await configureProjectPin(argv), options);
    return;
  }
  const requestedHarnesses = valuesAfter(argv, "--harness");
  const requestedHarness = requestedHarnesses[0];
  const from = internal.sourceRoot ?? valueAfter(argv, "--from");
  const mcpValue = valueAfter(argv, "--mcp");
  if (argv.includes("--harness") && !requestedHarness) {
    emitResult(usage("--harness requires a distribution name"), options);
    return;
  }
  if (requestedHarnesses.length > 1) {
    emitResult(
      usage("multi-harness config is not supported yet; pass one --harness <name>"),
      options,
    );
    return;
  }
  if (mcpValue && mcpValue !== "defaults" && mcpValue !== "none") {
    emitResult(usage("--mcp must be defaults or none"), options);
    return;
  }
  const projectDir = projectDirFrom(argv);
  const projectHarnesses = discoverProjectHarnesses(projectDir);
  const explicitProject = argv.includes("--project-dir") ||
    Boolean(process.env.AIDLC_PROJECT_DIR) ||
    Boolean(process.env.CLAUDE_PROJECT_DIR) ||
    Boolean(process.env.KIRO_PROJECT_DIR);
  const recognized = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"]
    .some((entry) => existsSync(join(projectDir, entry)));
  const firstRunWizard = !section &&
    configInputIsTty() &&
    options.mode === "human" &&
    projectHarnesses.length === 0 &&
    !argv.some((token) =>
      [
        "--dry-run",
        "--force",
        "--from",
        "--harness",
        "--json",
        "--mcp",
        "--pin",
        "--plan-token",
        "--quiet",
        "--unpin",
        "--yes",
      ].includes(token)
    );
  if (firstRunWizard && await runFirstRunWizard(projectDir)) return;
  const existingWalk = !section &&
    configInputIsTty() &&
    options.mode === "human" &&
    projectHarnesses.length > 0 &&
    !argv.some((token) =>
      [
        "--dry-run",
        "--force",
        "--from",
        "--harness",
        "--json",
        "--mcp",
        "--pin",
        "--plan-token",
        "--quiet",
        "--unpin",
        "--yes",
      ].includes(token)
    );
  if (existingWalk) {
    if (projectHarnesses.length > 1) {
      emitResult(
        usage("multiple project harnesses are present; pass one --harness <name>"),
        options,
      );
      return;
    }
    const installed = projectHarnesses[0];
    process.stdout.write(
      `\n  Found ${installed.distribution} in ${installed.harnessDir}/; using the existing copied projection.\n`,
    );
    const outstanding = postApplyOutstandingActions(
      projectDir,
      installed.harnessDir,
      modelHarness(installed.distribution),
    );
    await runSetupWalk(
      projectDir,
      installed.harnessDir,
      installed.distribution,
      outstanding,
    );
    return;
  }
  if (!recognized && !explicitProject && !options.yes) {
    if (!configInputIsTty()) {
      emitResult(usage("non-interactive config outside a recognized project requires --project-dir"), options);
      return;
    }
    const answer = configPrompt(`Initialize AI-DLC in ${projectDir}? [y/N]:`);
    if (!answer || !/^y(?:es)?$/i.test(answer.trim())) {
      emitResult(usage("configuration cancelled; pass --project-dir to select the target explicitly"), options);
      return;
    }
  }
  let selected: ConfigSource | null = null;
  let prepared: { root: string; cleanup?: string; regenerated: Set<string> } | null = null;
  try {
    const existing = existingProject(projectDir, requestedHarness);
    const pinPath = join(projectDir, ".aidlc-version");
    if (pathPresent(pinPath) && !regularFile(pinPath)) {
      throw new Error("project pin .aidlc-version is not a regular file");
    }
    const requiredVersion = regularFile(pinPath) ? readFileSync(pinPath, "utf-8").trim() : undefined;
    const recordOnly = Boolean(
      modelsContext ||
      diagnosticsContext ||
      choicesContext?.section === "flags",
    );
    if (
      recordOnly &&
      existing.distribution &&
      !from &&
      !process.env.AIDLC_RUNTIME_ROOT &&
      !isCompiledExecutable()
    ) {
      selected = copiedProjectSource(projectDir, requestedHarness);
    } else {
      try {
        selected = selectSource(
          requestedHarness,
          from,
          existing.distribution,
          requiredVersion,
        );
      } catch (error) {
        if (!recordOnly || !existing.distribution || from) throw error;
        selected = copiedProjectSource(projectDir, requestedHarness);
      }
    }
    const { stamp, descriptor } = selected;
    if (existing.distribution && existing.distribution !== stamp.distribution) {
      throw new Error(`project uses ${existing.distribution}; refusing ${stamp.distribution}`);
    }
    if (existing.distribution) assertRefreshSafe(projectDir);
    if (regularFile(pinPath) && readFileSync(pinPath, "utf-8").trim() !== stamp.frameworkVersion) {
      throw new Error(
        `project pin requires ${readFileSync(pinPath, "utf-8").trim()}, but source is ${stamp.frameworkVersion}; run aidlc config --pin ${readFileSync(pinPath, "utf-8").trim()}`,
      );
    }
    const baselinePath = join(projectDir, descriptor.harnessDir, "tools", "data", "aidlc-manifest.json");
    const prior = readBaseline(baselinePath);
    const settingsMutation = modelsContext?.settings ?? choicesContext?.settings;
    const projectedSettings = settingsMutation
      ? resolveAidlcSettingsWithOverride(
          projectDir,
          settingsMutation.target,
          settingsMutation.next,
        )
      : resolveAidlcSettings(projectDir);
    const projectedPolicy = modelPolicyForHarness(
      projectedSettings.models,
      modelHarness(stamp.distribution),
    );
    prepared = prepareRefreshSource(
      projectDir,
      selected.root,
      descriptor,
      prior,
      projectedPolicy,
      projectedSettings.flags,
      diagnosticsContext?.overrides ?? choicesContext?.overrides,
    );
    const preparedRoot = prepared.root;
    const preparedRegenerated = prepared.regenerated;
    let recordedProjectMcp: "defaults" | "none" | undefined;
    try {
      const stagedHarnessData = JSON.parse(
        readFileSync(
          join(
            prepared.root,
            descriptor.harnessDir,
            "tools",
            "data",
            "harness.json",
          ),
          "utf-8",
        ),
      ) as Record<string, unknown>;
      recordedProjectMcp =
        normalizeProjectChoicesRecord(stagedHarnessData.project)?.mcp;
    } catch {
      recordedProjectMcp = undefined;
    }
    let mcpMode = (
      mcpValue ??
      choicesContext?.mcpMode ??
      recordedProjectMcp ??
      prior?.mcpMode
    ) as "defaults" | "none" | undefined;
    if (
      !mcpMode &&
      configInputIsTty() &&
      descriptor.rootIntegrations.some((integration) =>
        integration.policy === "json-map" && integration.optional
      )
    ) {
      process.stdout.write("\n  MCP servers\n    1. on\n    2. off\n");
      const answer = promptChoice("  MCP", 2, 2);
      mcpMode = answer === 1 ? "defaults" : "none";
      process.stdout.write(`  MCP servers ${answer === 1 ? "on" : "off"}.\n\n`);
    }
    mcpMode ??= "none";
    const operations: TransactionOperation[] = [];
    const actions: PlannedAction[] = [];
    const files: Record<string, string> = {};
    const rootContributions: Record<string, RootContribution> = {};
    planManagedFiles(
      projectDir,
      prepared.root,
      descriptor,
      prior,
      argv.includes("--force"),
      operations,
      actions,
      files,
      prepared.regenerated,
    );
    if (!selected.projectProjection) {
      planRootIntegrations(
        projectDir,
        prepared.root,
        descriptor,
        prior,
        mcpMode,
        argv.includes("--force"),
        operations,
        actions,
        rootContributions,
      );
      planRemovedRootIntegrations(
        projectDir,
        descriptor,
        prior,
        argv.includes("--force"),
        operations,
        actions,
      );
    } else {
      if (prior) Object.assign(rootContributions, prior.rootContributions);
      const presentRootIntegrations = descriptor.rootIntegrations.filter(
        (integration) =>
          preparedRegenerated.has(integration.path) &&
          regularFile(join(preparedRoot, integration.path)),
      );
      if (presentRootIntegrations.length > 0) {
        planRootIntegrations(
          projectDir,
          preparedRoot,
          { ...descriptor, rootIntegrations: presentRootIntegrations },
          prior,
          mcpMode,
          argv.includes("--force"),
          operations,
          actions,
          rootContributions,
        );
      }
    }
    planProjectSettingsMutation(
      projectDir,
      settingsMutation,
      operations,
      actions,
    );
    const externalSettingsOperation = globalSettingsOperation(settingsMutation);
    if (settingsMutation?.target === "global" && externalSettingsOperation) {
      actions.push({
        path: settingsMutation.path,
        action: settingsMutation.next === null
          ? "remove"
          : pathPresent(settingsMutation.path)
          ? "update"
          : "create",
      });
    }
    const conflicts = actions.filter((action) => action.action === "conflict");
    if (conflicts.length > 0) {
      actions.sort((left, right) =>
        left.path.localeCompare(right.path) || left.action.localeCompare(right.action)
      );
      const counts = Object.fromEntries(
        ["create", "update", "merge", "preserve", "remove", "conflict"].map((name) => [
          name,
          actions.filter((item) => item.action === name).length,
        ]),
      );
      emitResult({
        ...failure(
          `${conflicts.length} config conflict(s): ${conflicts.map((item) => `${item.path} (${item.detail})`).join(", ")}`,
          EXIT.integrity,
          configCommand("--dry-run --verbose"),
        ),
        data: { projectDir, distribution: stamp.distribution, counts, actions },
      }, options);
      return;
    }
    const baseline: Baseline = {
      schemaVersion: 1,
      frameworkVersion: stamp.frameworkVersion,
      distribution: stamp.distribution,
      harnessDir: stamp.harnessDir,
      mcpMode,
      files,
      rootContributions,
    };
    const baselineRel = join(descriptor.harnessDir, "tools", "data", "aidlc-manifest.json");
    operations.push(writeOperation(
      baselineRel,
      `${JSON.stringify(baseline, null, 2)}\n`,
      expected(baselinePath),
    ));
    actions.push({ path: baselineRel, action: pathPresent(baselinePath) ? "update" : "create" });
    actions.sort((left, right) =>
      left.path.localeCompare(right.path) || left.action.localeCompare(right.action)
    );
    const counts = Object.fromEntries(
      ["create", "update", "merge", "preserve", "remove", "conflict"].map((name) => [
        name,
        actions.filter((item) => item.action === name).length,
      ]),
    );
    const plan: TransactionPlan = { schemaVersion: 1, root: projectDir, operations };
    const approvalPlan = {
      ...plan,
      operations: plan.operations.map((operation) =>
        operation.kind === "copy"
          ? {
              ...operation,
              source: {
                sha256: sha256File(operation.source),
                mode: statSync(operation.source).mode & 0o777,
              },
            }
          : operation
      ),
      ...(externalSettingsOperation
        ? {
            externalSettings: {
              root: machineTransactionRoot(),
              operation: externalSettingsOperation,
            },
          }
        : {}),
    };
    const planToken = sha256Bytes(canonical(approvalPlan));
    if (argv.includes("--dry-run")) {
      if (modelsContext && options.mode === "human") {
        for (const line of modelsContext.summaryLines) process.stdout.write(`${line}\n`);
        for (const note of modelsContext.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      if (diagnosticsContext && options.mode === "human") {
        for (const line of diagnosticsContext.summaryLines) process.stdout.write(`${line}\n`);
        for (const note of diagnosticsContext.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      if (choicesContext && options.mode === "human") {
        for (const line of choicesContext.summaryLines) process.stdout.write(`${line}\n`);
        for (const note of choicesContext.notes) process.stdout.write(`  Note: ${note}\n`);
      }
      const configuredSection = diagnosticsContext?.section ??
        choicesContext?.section ??
        (modelsContext ? "models" : null);
      emitResult(success(
        `${configuredSection ? `${configuredSection} configuration` : "config"} plan for ${projectDir}: ${
          Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")
        }`,
        {
          projectDir,
          distribution: stamp.distribution,
          counts,
          actions,
          planToken,
          ...(modelsContext
            ? {
                models: {
                  previous: modelsContext.previous,
                  next: modelsContext.next,
                  summaries: modelsContext.summaryLines,
                  notes: modelsContext.notes,
                },
              }
            : {}),
          ...(diagnosticsContext
            ? {
                diagnostics: {
                  section: diagnosticsContext.section,
                  previous: diagnosticsContext.previous,
                  next: diagnosticsContext.next,
                  summaries: diagnosticsContext.summaryLines,
                  notes: diagnosticsContext.notes,
                },
              }
            : {}),
          ...(choicesContext
            ? {
                choices: {
                  section: choicesContext.section,
                  previous: choicesContext.previous,
                  next: choicesContext.next,
                  previousPlugins: choicesContext.previousPlugins,
                  nextPlugins: choicesContext.nextPlugins,
                  summaries: choicesContext.summaryLines,
                  notes: choicesContext.notes,
                },
              }
            : {}),
        },
      ), options);
      return;
    }
    const approvedToken = valueAfter(argv, "--plan-token");
    if (argv.includes("--plan-token") && !approvedToken) {
      emitResult(usage("--plan-token requires the token emitted by init --dry-run"), options);
      return;
    }
    if (approvedToken && approvedToken !== planToken) {
      emitResult(failure(
        "config plan changed after approval; run aidlc config --dry-run again",
        EXIT.integrity,
        configCommand("--dry-run --json"),
      ), options);
      return;
    }
    if (existing.distribution) {
      withAuditLock(
        projectDir,
        () => {
          assertRefreshSafe(projectDir);
          executeSettingsAndProjectMutation(settingsMutation, plan);
        },
        undefined,
        undefined,
        600,
      );
    } else {
      executeSettingsAndProjectMutation(settingsMutation, plan);
    }
    if (settingsMutation && settingsMutation.target !== "global") {
      invalidateSettingsCache(settingsMutation.path);
    }
    if (modelsContext && options.mode === "human") {
      for (const line of modelsContext.summaryLines) process.stdout.write(`${line}\n`);
      for (const note of modelsContext.notes) process.stdout.write(`  Note: ${note}\n`);
    }
    if (diagnosticsContext && options.mode === "human") {
      for (const line of diagnosticsContext.summaryLines) process.stdout.write(`${line}\n`);
      for (const note of diagnosticsContext.notes) process.stdout.write(`  Note: ${note}\n`);
    }
    if (choicesContext && options.mode === "human") {
      for (const line of choicesContext.summaryLines) process.stdout.write(`${line}\n`);
      for (const note of choicesContext.notes) process.stdout.write(`  Note: ${note}\n`);
    }
    const outstandingActions = internal.setupWalkChild
      ? []
      : postApplyOutstandingActions(
          projectDir,
          descriptor.harnessDir,
          modelHarness(stamp.distribution),
          {
            skipSections: diagnosticsContext
              ? [diagnosticsContext.section]
              : [],
          },
        );
    const baseMessage = choicesContext
      ? `configured ${choicesContext.section} settings for ${projectDir}`
      : diagnosticsContext
      ? `configured ${diagnosticsContext.section} settings for ${projectDir}`
      : modelsContext
      ? `configured model policy for ${projectDir}`
      : `configured ${projectDir} for ${descriptor.productName} ${stamp.frameworkVersion}; next: ${descriptor.configNextStep}`;
    const setupMapWillRender =
      !internal.setupWalkChild &&
      !section &&
      options.mode === "human" &&
      configInputIsTty();
    emitResult(success(
      configCompletionMessage(
        baseMessage,
        setupMapWillRender ? [] : outstandingActions,
        options.mode,
      ),
      {
        projectDir,
        distribution: stamp.distribution,
        version: stamp.frameworkVersion,
        counts,
        actions,
        planToken,
        outstandingActions,
        ...(modelsContext
          ? {
              models: {
                previous: modelsContext.previous,
                next: modelsContext.next,
                summaries: modelsContext.summaryLines,
                notes: modelsContext.notes,
              },
            }
          : {}),
        ...(diagnosticsContext
          ? {
              diagnostics: {
                section: diagnosticsContext.section,
                previous: diagnosticsContext.previous,
                next: diagnosticsContext.next,
                summaries: diagnosticsContext.summaryLines,
                notes: diagnosticsContext.notes,
              },
            }
          : {}),
        ...(choicesContext
          ? {
              choices: {
                section: choicesContext.section,
                previous: choicesContext.previous,
                next: choicesContext.next,
                previousPlugins: choicesContext.previousPlugins,
                nextPlugins: choicesContext.nextPlugins,
                summaries: choicesContext.summaryLines,
                notes: choicesContext.notes,
              },
            }
          : {}),
      },
    ), options);
    if (
      setupMapWillRender
    ) {
      await runSetupWalk(
        projectDir,
        descriptor.harnessDir,
        stamp.distribution,
        outstandingActions,
      );
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const copiedHarness = discoverProjectHarnesses(projectDir)[0];
    const copiedRefreshWithoutSource = Boolean(
      copiedHarness &&
      !from &&
      /(harness .+ is not installed|no installed harness runtime is available)/.test(rawMessage),
    );
    const message = copiedRefreshWithoutSource
      ? `This copy-channel project already contains ${copiedHarness?.harnessDir}, but refreshing project files needs release source bytes. ` +
        "Install the native aidlc command when a release is available, or re-copy the matching dist/<harness>/ tree from the aidlc-workflows checkout."
      : rawMessage;
    emitResult(failure(
      message,
      /pass (?:one )?--harness|--harness requires|multi-harness config/.test(message)
        ? EXIT.usage
        : EXIT.integrity,
      copiedRefreshWithoutSource
        ? "re-copy the matching dist/<harness>/ tree, then rerun this command"
        : from
        ? configCommand("--from <valid-release-data>")
        : selected?.projectProjection
        ? "install a native release when available, or re-copy the projection from the aidlc-workflows checkout"
        : configCommand("--harness <name>"),
    ), options);
  } finally {
    if (prepared?.cleanup) rmSync(prepared.cleanup, { recursive: true, force: true });
    if (selected?.cleanup) rmSync(selected.cleanup, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`aidlc config: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.failure;
  });
}
